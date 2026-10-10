# 设计文档 · TANGO

面向维护者的技术说明：为什么这样实现、哪些约束一破就出 bug、搜索的剪枝为什么必须存在、踩过的坑写在哪。
玩法规则与关卡清单见 [README.md](README.md)。

---

## 1. 核心决策：难度是量出来的，不是标出来的

绝大多数 Mastermind 实现把难度写成一个字符串（`difficulty: 'hard'`）靠人感觉。本作换成可证伪的：
**每一关的 `value` 是极小极大搜索在这本码本上跑出来的最坏情况保证猜测数**，定义为

```
value(S) = |S| ≤ 1 ? |S| : 1 + min_g  max_f  value(S_f(g))
```

即：选一步猜 `g`，对手（密码的真身）挑一个最不利于你的反馈 `f`，把候选集收缩成 `S_f(g)`；搜索
取"最好的 `g`"下"最坏的结果"。它同时买三件事：

1. 屏幕上的"N 次必破"是与信息论同口径的可比较数字，不是营销词；
2. 提示按钮可以给出无法反驳的答案（`js/core/game.js:171` `hint` 返回 `{kind:'policy', exact:true,
   left}`），因为它是搜索在当前子集真正选过的那一步、以及那一步之后**精确**的剩余次数；
3. 生成器有了唯一的停机判据——只按量出来的 `value` 落带与否决定收不收，难度不被构造方式偷偷左右。

### 1.1 为什么这个 value 能被"外部定理"交叉检查

`value(S) ≥ 1 + ⌈log_R |S|⌉`（`js/core/codes.js:156` `valueFloor`），而 `⌈log_R |S|⌉`
（`js/core/codes.js:127` 的 `infoBound`）是纯信息论：每次反馈有 R=15 种，最多把候选集缩到 1/15。这两层下界**不进
搜索**，是站在搜索外面验它的：`tools/bake.mjs` 断言每关 `again.value ≥ valueFloor ≥ infoBound`。
一个把 `value` 算小的 bug，会先被这条定理抓，而不是上线后安静地少一步。

### 1.2 反证唯一解的"非装饰性"

契约要求"计数器不是摆设"。本模型里没有"唯一解"，等价物是**两侧夹紧**：`canBreakIn(S,k)`
（`js/core/decide.js:28`）是第二个独立求解器（迭代加深、只有容量剪枝、无 memo）。每关断言
`canBreakIn(book, value-1) === false` 且 `canBreakIn(book, value) === true`（`test/library.test.mjs`）。
两个不共享代码的求解器给出同一个 `value`，且下界那一侧被反证失败钉死——搜索不能自己给自己出题打分。
`test/naive.mjs` 还对小空间（L=2,C=3/4）用穷举树复算 `value`，给三家族再垫一层独立证据。

---

## 2. 搜索为什么必须剪枝（这是本仓的心脏，也是上一个 builder 断线的地方）

1296 枚码、4 peg 反馈 15 种、深度到 5 的最坏情况，朴素"枚举每步猜法 × 每个反馈分支"会**指数爆**。
`tools/bench.mjs` 实测（每档 6 本码本取精确值，预算 20000ms/400000 节点）：

| `|S|` | value min/med/max | 复解 ms min/med/max | 状态数 med/max | 说明 |
|---|---|---|---|---|
| 8 | 2/2/3 | 0.2/0.3/39.8 | 1/4 | 免费 |
| 20 | 3/3/3 | 0.6/0.6/0.9 | 8/8 | 免费 |
| 60 | 3/4/4 | 1.4/**159.8**/188.8 | 821/905 | 中位跳变，个别码本要 900 节点 |
| 120 | 4/4/4 | 4.4/7.7/11.9 | 48/52 | grind 窗口下沿 |
| 160 | 4/4/4 | 5.2/6.8/8.5 | 56/63 | grind 上沿 |
| 300 | 4/4/4 | 9.4/15.7/20.1 | 89/102 | |
| 420 | 5/5/5 | 5868.9/**6489.1**/7948.7 | 29323/**36769** | **实测死区** |
| 500 | 5/5/5 | 1390.1/1414.7/1474.8 | 2362/2579 | siege 窗口 |

**420 附近的死区**是"朴素剪枝太弱"最直白的证据：同一套代码，`|S|=420` 比 `|S|=500` 还贵 4.6 倍，
因为某些码本的反馈分支极不均衡，纯信息下界 `1+⌈log₁₅ 420⌉=3` 与实际 `value=5` 之间那条缝，朴素
界填不住。上一个 builder 死前说的"naive pruning too weak，我要加 sharpened bound `|S|≤R^(k-1)`
容量界 + fail-high 有界递归"——**评估结论：这两样在磁盘上已经实现并被测绿**（见下），不是待办。

### 2.1 solver 1（`js/core/minimax.js`）用的三层剪枝，一破就退化成上面那堵墙

搜索签名 `search(list, depth, limit)`（`js/core/minimax.js:128`）。三条界：

- **FLOOR**（`js/core/minimax.js:131`）：`valueFloor(n) >= limit` 直接判死，一个分支都不展开——外部定理，几乎免费。
- **CAP / 容量界**（`js/core/minimax.js:166`）：一个猜法 `g` 要能"打平 `best`"，其每个反馈子集都要 `value ≤ best-2`，
  由容量论 `|子集| ≤ capacity(best-2) = R^(best-4)`；子集按最大分支尺寸升序访问，一旦超过容量就
  `break`。这就是 builder 说的 sharpened bound：`|S| ≤ R^(k-1)` 是把"还能不能小于 k"变成一次计数。
- **BOUNDS / fail-high 有界递归**（`js/core/minimax.js:121-135`）：问子节点的不是"你的值是多少"，而是"你能不能压在
  `limit` 以下"。压不住就返回 `limit`（fail-high）。**只有严格小于 limit 的确切值才写进 memo**——
  把不精确的上界缓下去会污染同一个子集在别处的查询。这正是让 500 档从"跑不完"变成 1.4 秒的东西。

三族共享 memo/位掩码之外，`value ≥ ⌈log_R|S|⌉` 恒成立这一条被 `test/minimax.test.mjs` 钉死
（"memo holds only exact subset values, and each is >= its own floor"）。

### 2.2 修复 witness 与"策略表闭合"

fail-high 只保证 `value` 数对，不自动保证**能报出那一步猜法**。若最优猜法是在剪枝边界上被"计数"
判出来的，`repairWitness`（`js/core/minimax.js:202`）回头把它真正展开一次，补出可选的 `gStar`。只有 `value < limit`
且拿到了 witness，才写 policy 条目。`policyClosed(space, book, policy)`（导出）检查烘出去的表
**闭合且严格下降**：对每个 ≥2 的子集，表里那一步猜法的每个反馈都指向另一条表项，且 `value` 单调
变小——这就是"提示报的 N 次"为真的证明。`tools/bake.mjs:119` 每关跑它，不闭合就不入库。

### 2.3 `BudgetError`：宁可说"没量出来"，绝不把"没量出来"当"量出来"

`js/core/budget.js` 的守卫在节点/时间耗尽时抛 `BudgetError`（不是返回一个可疑值）。bake 把它当作
"这本码本大到无法 certify"直接丢弃换下一本（`js/core/make.js:89`），绝不发布一个没证到的 `value`。
`test/minimax.test.mjs` 有专门一条断言这条红线。

---

## 3. 全局约定（破坏即出 bug）

### 3.1 反馈必须两遍数，重复色是最易踩的坑

`js/core/codes.js:66`：先数黑（位置对），再在**剩余位**上按颜色取 min 得"颜色对总数"，`white =
common − black`。一遍写（对每个位置既比颜色又比位置）会把重复色同时算进黑与白，`value` 与 `S_f`
全错，而且错得"看起来还行"。`test/codes.test.mjs` + `test/fixture.mjs` 的手算反馈元组（含
`1223 vs 2233 → (2,1)`）就是这条的守门人。

### 3.2 单击只做 O(|S|) 过滤，绝不重跑搜索（click-time vs build-time 的边界）

浏览器里的候选收缩是 `js/core/book.js` 的 `consistent()`：对幸存候选逐个比对反馈，实测每缩一次
`|S|=500` 才 **0.0064 ms**（bench 尾）。搜索（`minimax.js`/`decide.js`/`make.js`）**没有任何一行被
shipped 代码 import**；`js/main.js` 用的 `js/core/library.js` 只是查表 + 收缩。把搜索放进点击，就
是把手指按在 2 秒冻结上（DESIGN 第 2 节实测）。这不是洁癖，是产品可行性。

### 3.3 单候选子集在策略表里"没有条目"是构造事实，不是 bug

policy 只为 `|S| ≥ 2` 的子集而存在（`value` 的定义就是 ≥2 才要"再猜"）。玩家若走到只剩 1 个候选，
`hint` 落 `bestSplit` 兜底并诚实标 `exact:false, left:null`（`js/core/game.js:172`）。UI 不得把这种兜底
包装成"策略表说的精确 N 次"。`test/game.test.mjs` 与 `@pointer` 的收尾一猜都断言了这个 `exact`
字段的真伪。

### 3.4 三层不许互相串

| 层 | 文件 | 可以知道 | 不许知道 |
|---|---|---|---|
| 引擎 | `js/core/*` | 码空间、搜索、掩码、存档结构 | DOM、canvas、`window` |
| 画面 | `js/view.js` | 像素、指针、手势、peg 命中坐标 | 任何规则判定 |
| 外壳 | `js/main.js` | 路由、DOM、计时、`window.tango` | 游戏规则细节 |

`node --test test/*.test.mjs` 能直接 import 核心（无 `window`），`tools/playtest.mjs` 能从真实鼠标
事件驱动同一个 `commit()`。任何一处让 `js/core` 摸到 `window`，第一套立刻瘫。`js/core/storage.js`
用 `persistent()`（`js/core/storage.js:147`）检测无 `window` 时退化，正是为了这条边界可测。

---

## 4. 烤池子与序列化格式

`tools/bake.mjs` → `js/data/lots.js`（是 JS 模块不是 JSON：`export const LOTS` 在加载期即数据，
`library.js` 顶层就能把掩码解好、少一次 `fetch` 与一层错误处理）。每关序列化
`[book, secret, value, par, size, bound, floor, R, L, C, policy, nodes, ms]`，其中
`policy` 是 `[[maskHex, guess, value], …]`：子集位掩码（BigInt 压成 hex）→ 搜索选的猜法 → 那一步
之后精确剩余次数。

进池子的硬条件（`tools/bake.mjs:72-124`，每条是脚本里的 assert 不是愿望）：从 `book` 数组用**全新求解器**
复解得同一 `value`；`value ≥ floor ≥ bound`；`value` 恰等于档带；`secret ∈ book`；`validateBook`；
`policyClosed` 闭合。`test/library.test.mjs` 在 CI 里把入库文件**再**逐关复解，手改一个数字即红。

确定性用 `js/core/rng.js`（FNV-1a `hashSeed` + `mulberry32`）：每日关卡 = `dailyLot(todayKey)`，
`#/random/<tier>/<key>` 可分享且收的人同题；`test/library.test.mjs` 钉死 hashSeed/mulberry32 纯函数。

---

## 5. 存档：一个 localStorage key 的三条不变式

`tango.save.v1`（`js/core/storage.js`），版本化逐字段兜底，`window.localStorage` **会抛**（无痕、
被挡第三方存储、嵌入 webview）——所有访问 try/catch，失败退化为内存会话（`persistent()===false`）。

- **`best` 只会变小**（`js/core/storage.js:103` 的 `solve`）：重玩打出更差成绩不能擦掉更好的纪录。
- **`unlock` 只会变大**（`js/core/storage.js:78`）：回玩第 3 关不能把第 9 关重新藏起来。
- **达到精确值**的旗标一旦点亮不因更差的重玩熄灭（`par: won && guesses<=par || prev.par`）。
- 清档是全仓唯一破坏性操作 → 两次点击（`js/main.js:307`），`@save` 断言"第一次只上膛"。

`test/storage.test.mjs` 在 node 里跑（无 window → 内存退化路径），`@save` 在真实浏览器里跑
localStorage 落盘路径，同一批不变式两层各验一遍。

---

## 6. 台架：为什么 CDP 而不是 Playwright，@pointer 为什么必须存在

`package.json` 依赖为 `{}` 是刻意的：这是进 Pages CI 的仓库。Node 21+ 自带全局 `fetch`/`WebSocket`，
`tools/playtest.mjs` 直接讲 CDP（`open|nav|eval|shot|logs`）覆盖注入、读运行时对象、截图、抓 console。

`@pointer` 跑在 **Node 侧**：页面内注入 JS 能证明 `commit()` 正确，但证明不了一根手指点得着 peg。
它逐条 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`，坐标来自 `window.tango.palettePoint(c)` /
`pegPoint(row,col)` / `buttonPoint(id)`（`js/view.js` 把元素中心换算成 client 像素）。它断言：四下
palette 真落下四 peg、满行点击弹回（`/满了/`）、退一枚只抬最后一 peg、真实 Escape 清空草稿
（`clearDraft` 不再是幽灵导出）、三 peg 非法提交不计（`/还差 1 枚/`）、整条认证解用点击打完并正确判
终局（`当庭破码` + `★★★` + 落存档）、原地点击不动、死角落点击不动、终局后提交被禁用。

### 6.1 verify.sh 与 playtest.mjs 里被坑逼出来的处理

1. Chrome 用 `mktemp -d` 独立 profile；轮询 `/json/version` **和** web 根两个端点都活才开始
   （`tools/verify.sh:52-63`），否则首次 navigate 撞在半启动端口。
2. 导航之后**等 shell 不等秒表**：`waitShell()` 轮询 `window.tango.state.id`（`tools/playtest.mjs:97-103`），
   固定 sleep 在本地像没事、Pages 上把 canvas 留在未样式 300×150。
3. `trap cleanup EXIT` 里 `kill` 完必须 `wait` 两个后台 PID，外加看门狗 `( sleep WD_TIMEOUT; cleanup )`
   并把 fd 重定向走——否则看门狗子 shell 攥住 stdout 让流水线卡到超时。
4. 结果 JSON 用**花括号计数**截取，不 `JSON.parse(整行)`：headless 会在同一行后追加 console 文本。
5. `SKIP_UNIT=1` 让 CI browser job 不重跑 node 套件（unit job 已跑，同一份代码跑两遍只会掩盖真因）。
6. `<link rel="icon" href="data:,">`（`index.html:8`）免 favicon 404 污染"console 必须干净"的断言。

### 6.2 两个在真实事件下才暴露、随后修掉的坑（如实记录）

- `@pointer` 起手 `t.load('#/lot/glance-01')` 后**同一 tick 读 `state.id`** 拿到的是上一个套件（@save）
  留下的每日关。因为 `go()` 走 `hashchange` 异步生效。修法是加载后**有界轮询**状态 id 到 `glance-01`
  为止（`playtest.mjs` fresh 段），与 @routes 里的 `await sleep` 同一道理。
- 通关后 `el.submit.disabled = g.done`（`js/main.js:154`）且幕布 `inset:0` 盖住按钮、键盘 `Enter` 在
  `g.done` 时提前返回（`js/main.js:325`）——三重终局锁。**没有**一条真实事件能让终局后打印 `已经结束`。
  因此把该断言从"点击 submit 会说已经结束"改成可证伪的真值：submit 已 `disabled` 且点击不计费
  （`over.g === 2 && won === true`）。核心 `submit()` 的 `reason:'over'` 守卫仍在 `test/game.test.mjs`
  的 node 层证明——两层各司其职，而不是把浏览器断言写成假象去迎合。

---

## 7. 已知不做的东西

- **不做浏览器内生成/搜索**（第 2、3.2 节实测）：想要更大池子就提高 `PER_TIER` 重烤，别把搜索塞进点击。
- **不做成就 / 排行 / 云存档 / 战绩分享**：分享只有 `#/lot/<id>`（同关不含分数）。
- **不引入打包器与依赖**：ES modules + `server.cjs` + 零依赖 CDP harness，全仓 0 个二进制资产。
- **不做 Electron 启动验证**：`electron/main.cjs` 存在且过 `node --check`，但仓库不装 electron，没跑过真启动。
- **`|S|` 窗口不越 420 死区**：往更大码本推要先把搜索预算问题重新解，不是把 `maxMs` 调大就完事。
- **多语言**：UI 只有中文。
