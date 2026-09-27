# 破码 · TANGO

在一个 4 位 × 6 色的码本里猜出那一枚密码。经典 Mastermind / 珠玑妙算 的浏览器实现，但和纸笔版
有一个关键区别：**每一关印着的"精确值 N 次必破"不是人觉得像几分难，而是极小极大搜索量出来的
最坏情况保证值——它是可从关卡数据本身重新推导出来的事实，不是一个标签。**

一列 peg 反馈黑（位置对）与白（颜色对、位置错）。这游戏真正的难点不是"猜中"，而是"无论密码
是哪一枚，我最多还要猜几次"——那个数就是 `value`，也是提示按钮敢对你说"还需 N 次"的底气。

## 跑起来

```bash
node server.cjs            # http://127.0.0.1:5180/（端口作参数：node server.cjs 5191）
npm run unit               # 六个 node 测试套件（88 条断言）
bash tools/verify.sh       # node 套件 + headless Chrome 真实鼠标键盘验收（66 条断言）
npm run bake               # 重新生成 js/data/lots.js（约 35 秒，成本几乎全在 siege 档，见下）
npm run bench              # 搜索体检：每个码本尺寸的精确值/耗时/状态数（约 20 秒）
npx electron .             # 桌面壳（需先自行 npm i -D electron）
```

`server.cjs` 是零依赖静态服务器，存在的唯一理由是 ES module 需要一个 origin，`file://` 下
`<script type="module">` 会被 CORS 挡掉，双击 `index.html` 玩不了。

## 这一关的数字从哪来

游戏里没有手写关卡，也没有"简单/中等/困难"这种字符串。链条是这样的：

1. `js/core/make.js` 从 1296 枚码里随机抽 `|S|` 枚组成一本**码本**（codebook，候选集合 S），
   唯一的过滤器是 `js/core/minimax.js` 量出来的 `value` 是否落在档位区间内——难度不由构造方式
   规定，只由测量结果决定，这才使数字诚实。
2. `tools/bake.mjs` 在构建期跑它，把每关的 `book` 序列化，然后**从序列化结果重新解一遍**；只有
   复现出同一个 `value` 的关卡才写进 `js/data/lots.js`，并附带搜索选出的**策略表**（`policy`）。
   数字对不上直接抛错，不降级。
3. `test/library.test.mjs` 在每次 CI 里把 `js/data/lots.js` 逐关、用全新求解器再解一遍，并双向
   证明这个 `value` 卡得死死的：`canBreakIn(book, value-1)` 必须失败、`canBreakIn(book, value)`
   必须成功。手改一个 `value` 字段，构建就红。

所以浏览器永远不分析码本，只从池子里挑一关、然后把候选列表越点越小。这不是洁癖：见下面的实测，
围城档一枚码本要 2 秒以上才能 certify，这个成本放在构建期是免费的，放在玩家点一下屏幕之后是灾难。

## 已烘焙的池子

32 关，四档，难度带互不重叠（每档对应一个**确切**的 `value`，按构造不可能重叠）：

| 档位 | `value`（精确值） | 关卡数 | 码本 `|S|` 范围 | `|S|` 中位 | 信息下界 `⌈log₁₅|S|⌉` 最大 | 复解状态数 最大 |
|---|---|---|---|---|---|---|
| 一瞥 glance | 2 | 8 | 4–7 | 6 | 1 | 1 |
| 试探 probe | 3 | 8 | 14–45 | 30 | 2 | 10 |
| 拉锯 grind | 4 | 8 | 92–160 | 122 | 2 | 55 |
| 围城 siege | 5 | 8 | 493–519 | 507 | 3 | 2795 |

表里的区间是从**实际入库的关卡**量出来再写进 `TIERS_META` 的，不是生成器想要的区间；两者不一致
时以入库为准，由 `test/library.test.mjs` 断言。整张表可用一条命令复现，别手改数字：

```bash
node -e "import('./js/core/library.js').then(m => console.log(m.stats().byTier))"
```

`下界` 一栏是纯信息论事实 `⌈log_R |S|⌉`（R=15 种反馈，每次猜测最多把候选集缩到 1/15），它与
`value` 之间有不可见的缝：搜索的剪枝正是靠把这个缝量化为 `1+下界` 与容量界 `R^(k-1)` 才跑得动
（见 [DESIGN.md](DESIGN.md) 第 2 节）。

## 验收

`bash tools/verify.sh` 一条命令跑完两层，全部断言可判定：

- **node 层**（88 条）：`test/codes.test.mjs` 码空间与两遍反馈、`test/book.test.mjs` 掩码/校验/
  `consistent` 收缩、`test/minimax.test.mjs` 精确值与剪枝预算、`test/game.test.mjs` 对局规则、
  `test/library.test.mjs` 全池复验、`test/storage.test.mjs` 存档退化。
- **浏览器层**（66 条）：`tools/playtest.mjs` 用零依赖 CDP 起一个真实 headless Chrome，`@boot`
  检查画布真的画出了像素、`@play` 走完通关与评星、`@routes` 覆盖四种路由与越界钳制、`@save`
  验证 localStorage 落盘与两次点击清档、`@pointer` **派发真实 `Input.dispatchMouseEvent`** 把整条
  认证解用点击打完，并断言原地点击不动、非法位置不计、终局判定正确。

`test/codes.test.mjs` 与 `test/game.test.mjs` 的期望值不是从被测代码里读回来的：反馈元组、
通关次数都是**手算**写死在 fixture 里（见 `test/fixture.mjs` 的手推注释）。求解器不能给自己出题
再给自己打分。

## 规则

- 4 个位置（`L`）、6 种颜色（`C`）→ 4^… 实为 6^4 = 1296 枚码（`N`）；反馈黑+白共 15 种（`R`）。
- 每关给定一本码本 S（若干枚候选码），**密码必是其中之一**；玩家每次提交一行 4 peg。
- 黑 peg = 颜色且位置都对；白 peg = 颜色对但位置错；用**两遍计数**（先黑、再在剩余位上按颜色取
  min）处理重复色，避免把同一枚码同时算进黑与白。
- 十行用完仍未破译即失败（`MAX_ROWS=10`）。评星按是否打平 `value` 决定。
- 提示读构建期烘好的策略表，报的是"这一步之后最坏还需几次"的精确值——不是启发式猜测。

## 已知边界

- 围城档单本码本的构建期复解实测**中位 2088 ms、最大 2378 ms**（见 `npm run bake` 输出）——
  远高于 300 ms。这是**构建期**成本、不影响点击手感，但如实记录：加大 `PER_TIER` 重烤会线性变慢。
- `|S|≈420` 附近有一个实测**死区**（bench 里中位约 6.5 秒），比 500 还贵；生成器的 `|S|` 窗口刻意
  绕开它，落在两侧可 certify 的区间上（493–519）。这不是随手划的线，是 `tools/bench.mjs` 量出来的。
- 每日关卡从整个池子里挑，所以某天可能一上来就是围城档。这是刻意的：无账号体系就不做"按进度调节
  每日难度"这种需要状态的东西。

## License

MIT © 2026 z-biz-game
