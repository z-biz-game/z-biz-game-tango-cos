# 破码 - 交付报告

## 任务摘要

| 属性 | 内容 |
|------|------|
| **项目名称** | TANGO |
| **App 名称** | 破码 |
| **形态** | 浏览器原生（ES modules，零依赖）+ Electron 壳 + GitHub Pages |
| **仓库** | `z-biz-game/z-biz-game-tango-cos` |
| **分组** | E（益智解谜），无成就 / 无排行榜 / 无云存档 |
| **玩法概述** | Mastermind：4 位 × 6 色码本里，用黑/白 peg 反馈猜出被列为密码的那枚码 |
| **核心差异点** | 每关印着的"精确值 N 次必破"是极小极大搜索量出来的最坏情况保证值，可从序列化的 `book` 复解；难度不是标签 |
| **代码量** | 不含文档约 4,832 行：引擎 1,340 · 画面/外壳 753 · 关卡数据 43 · 测试与 fixture 1,370 · 工具（bake/bench/harness/playtest 909 + verify.sh 139）· 服务与 Electron 103 · HTML/CSS 175 |

> 关于命名的说明：规格文档 `tango.md` 的中文名是「破码」（Mastermind 破译码本），本仓即按此实现。
> 交接材料里出现过的"双星/双豆"另有所指，与本作模型不符；本文档统一以规格为准记「破码」。

## 真实文件清单

只列磁盘上确实存在、且被某条命令真实执行过的文件。

| 文件 | 行数 | 由谁验证 |
|------|------|----------|
| `js/core/codes.js` | 162 | `test/codes.test.mjs`（15 条）· `@play` 页面内独立复算反馈 |
| `js/core/book.js` | 95 | `test/book.test.mjs`（11 条）· `@play` 的 `consistent()` 收缩复算 |
| `js/core/minimax.js` | 279 | `test/minimax.test.mjs`（21 条，含 budget/floor/policyClosed） |
| `js/core/decide.js` | 99 | `test/minimax.test.mjs` + `test/library.test.mjs` 的 `canBreakIn(par±1)` 两侧 |
| `js/core/game.js` | 218 | `test/game.test.mjs`（14 条）· `@play` 通关/评星 |
| `js/core/library.js` | 114 | `test/library.test.mjs`（18 条，全池逐关复解） |
| `js/core/storage.js` | 155 | `test/storage.test.mjs`（9 条，node 内存退化）· `@save`（真实 localStorage） |
| `js/core/make.js` | 112 | `tools/bake.mjs` 的接受率门 + `tools/bench.mjs`（无独立 node 套件，经产物复证） |
| `js/core/rng.js` | 49 | 被 `library.test` 的 hashSeed/mulberry32 确定性断言覆盖 |
| `js/core/budget.js` · `table.js` | 30 · 27 | 被 `minimax.test`（BudgetError 红线）与 `codes.test`（反馈表）间接钉死 |
| `js/view.js` | 297 | `tools/playtest.mjs` 的 `@pointer`（18 条，真实鼠标键盘） |
| `js/main.js` | 456 | `@boot`(12) `@play`(10) `@routes`(15) `@save`(11) 与 `@pointer` |
| `js/data/lots.js` | 43 | `test/library.test.mjs` 逐关复解（32 关全复） |
| `index.html` · `css/game.css` | 73 · 102 | 截图 + `@pointer` 控件存在性断言 |
| `server.cjs` | 69 | `tools/verify.sh` 用它起静态服务 |
| `electron/main.cjs` | 34 | `node --check`（Electron 未安装，**未做启动验证**） |
| `tools/bake.mjs` | 229 | 产出 `js/data/lots.js`，产物被 `library.test` 复证 |
| `tools/bench.mjs` | 106 | 手跑 `node tools/bench.mjs`（`|S|`-成本/死区，DESIGN 第 2 节引用） |
| `tools/playtest.mjs` | 540 | `tools/verify.sh` |
| `tools/verify.sh` | 139 | 本地与 CI browser job |
| `tools/harness.mjs` | 34 | node 套件的输出格式 |
| `test/*.test.mjs` | — | `npm run unit`（88 条断言） |
| `test/naive.mjs` · `fixture.mjs` | 63 · 63 | 小空间穷举树 + 手算 fixture，被 `minimax`/`codes` 套件 import |
| `.github/workflows/ci.yml` · `pages.yml` | 41 · 41 | 推上 GitHub 后由 Actions 执行（本地未跑） |

## 改动表：一开始错在哪 → 现在为什么对

| # | 错误的做法 | 为什么错 | 现在的做法 | 证据 |
|---|------------|----------|------------|------|
| 1 | `js/data/lots.js` 缺失（builder 从没跑过 bake） | `library.js`/`main.js` import 它，缺则运行时炸 | 跑 `tools/bake.mjs` 生成 32 关；产物被 `library.test` 逐关复解 | 结构 diff 复现确定性，仅 `BAKED_AT`/`ms` 随运行变 |
| 2 | `test/codes.test.mjs` fixture `1223 vs 2233` 期望 `(1,2)` | 手推漏了：猜法第 4 位的 `3` 压在密码第 4 位的 `3` 上是**第二个黑 peg**，不是白 | 期望改 `(2,1)`：黑=位 2、位 4；剩余 {1,2}/{2,3} 共用一色→白=1。**改的是测试，实现本就对** | `test/fixture.mjs` 的手推注释 + `test/codes.test.mjs` 绿 |
| 3 | `library.test` 想证"删一枚码 `value` 必降" | 难度带是粗颗粒，删单码常仍在带内，该断言不可能普遍成立 | 换成"删码单调不升" + 把一本 probe 削到只剩 2 码、逼 `value` 落到 2 < 印着的 3 | `test/library.test.mjs`（pare-down 链断言） |
| 4 | `game.test` 断言第 2 手 `hint.exact===true` | 只剩 1 候选的子集**按构造无 policy 条目**（`value` 只对 ≥2 定义），兜底必是 `split/exact:false` | 改为断言"被迫收尾一手"诚实标 `exact:false, left:null` | `js/core/game.js:172`；`test/game.test.mjs` + `@pointer` 收尾断言 |
| 5 | `js/main.js` 顶栏 `#modes` 三个模式按钮无监听 | aria-current 显示在哪个模式，点了不切换——幽灵 UI | 接 `click` → 路由（含随机模式现造 token） | `@routes` "the header 每日 button routes (it was dead wiring once)" |
| 6 | 裸 `#/random` 内部造 key 但不写回地址栏 | 分享出去的链接是 `.../null`，收的人不可复现 | resolve 造 token 后 `go()` 写回 URL | `js/main.js:95-99`；`@routes` `/^#\/random\/[a-z]+\/\d+$/` |
| 7 | `clearDraft`/`bakedAt`/`persistent` 三个导出无人 import | "文件存在但功能不存在"的幽灵导出 | 全部接线：`persistent()`→启动 `CAN_PERSIST`+内存模式横幅；`bakedAt`→crumbs 烘焙时间戳；`clearDraft`→真实 Escape 清草稿 | `@boot`（persist/crumbs 断言）、`@pointer`（真实 Escape） |
| 8 | `@pointer` 起手 `load` 后同 tick 读 `state.id` | `go()` 经 `hashchange` **异步**生效，读到的是上一套件遗留的每日关（glance-03） | 加载后有界轮询状态 id 直到 `glance-01`（≤40×80ms） | `tools/playtest.mjs` fresh 段 |
| 9 | `@pointer` 断言"通关后点 submit 会说已经结束" | 通关后 `el.submit.disabled` + 幕布盖住 + 键盘 Enter 早退——**无真实事件**能打印那句 | 断言改成可证伪真值：submit 已 `disabled` 且点击不计费；`reason:'over'` 核心守卫在 node 层证明 | `js/main.js:154,325`；`test/game.test.mjs` |
| 10 | bake 只打印 `worst ms`，缺接受率/中位 | 任务要求打印每档 n、接受率、计数器中位/最大耗时 | 每档补 `accept=…% · counter ms med/max · nodes med/max · reject tally` | `tools/bake.mjs` 报告段；本文件"生成"结论 |

**关于 builder 断线处（搜索剪枝）的评估**：其临终说"naive pruning too weak，我要加 sharpened
bound `|S|≤R^(k-1)` 容量界 + fail-high 有界递归"。**磁盘事实是这两样已完整实现并测绿**——
`codes.js:capacity`、`minimax.js` 的 FLOOR/CAP/BOUNDS（fail-high）与 `repairWitness` 均在，
`test/minimax.test.mjs` 绿。故未新增/回退任何核心搜索代码；本仓核心逻辑文件在收尾阶段**未被改动**，
改的是生成产物、测试套件、台架、外壳接线与文档。

## 构建验证结论

### 语法 + 单元（等价于 CI `unit` job）

```
$ npm run check
OK

$ node --test test/
✔ test/book.test.mjs      rows: 11 fail: 0
✔ test/codes.test.mjs     rows: 15 fail: 0
✔ test/game.test.mjs      rows: 14 fail: 0
✔ test/library.test.mjs   rows: 18 fail: 0
✔ test/minimax.test.mjs   rows: 21 fail: 0
✔ test/storage.test.mjs   rows:  9 fail: 0
ℹ tests 6  pass 6  fail 0  skipped 0
```

合计 **88 条断言，0 失败**（下限要求 45，达标）。

### 浏览器（等价于 CI `browser` job）

```
$ SKIP_UNIT=1 bash tools/verify.sh
boot lot: glance-01
=== @boot ===     rows: 12 fail: []
=== @play ===     rows: 10 fail: []
=== @routes ===   rows: 15 fail: []
=== @save ===     rows: 11 fail: []
=== @pointer ===  rows: 18 fail: []
=== win shot ===
{ "won": true, "guesses": 2, "stars": "★★★" }
=== console ===
(none)
=== ALL GREEN ===
```

合计 **66 条断言，0 失败，console 无错误，退出码 0**（下限要求 40，达标）。
`@pointer` 用真实 `Input.dispatchMouseEvent` 把 `glance-01` 的整条认证解点完并正确判终局。
截图两张（真实 Chrome 人眼核对非空，均 980×733 PNG）：

- `/tmp/tango-shots/boot.png`：开屏进入 `glance-01`（战役第 1 关），画布有像素、6 色 palette（琥/青/玫/苔/紫/霜）、右侧面板四数（下界 1 / 精确值 2 / 已用 0/10 / 剩余候选 4/4 / R 15）齐。
- `/tmp/tango-shots/win.png`：以 par=2 通关，幕布 ★★★「当庭破码」，"用了 2 次 · 这一关的精确值是 2 · 码本 4 码 · 下界 1"，提交按钮已置灰（终局锁）。

### 生成与搜索实测（`npm run bake` / `npm run bench`，接受率与耗时的诚实结论）

```
$ node tools/bake.mjs
glance: n=8 accept=100% · counter ms med 0.0 / max 1.0 · nodes med 1 / max 1 · policy 8 entries (0.1 kB) · reject {"kept":8,"drawRefused":1}
probe:  n=8 accept=100% · counter ms med 1.0 / max 2.0 · nodes med 9 / max 10 · policy 65 entries (1.0 kB) · reject {"drawRefused":8,"kept":8}
grind:  n=8 accept=100% · counter ms med 7.0 / max 8.0 · nodes med 50 / max 55 · policy 369 entries (11.9 kB) · reject {"kept":8}
siege:  n=8 accept=100% · counter ms med 2088.0 / max 2378.0 · nodes med 2621 / max 2795 · policy 1511 entries (152.4 kB) · reject {"kept":8}
file: 196.1 kB in 34.4s total
```

- **接受率**：四档均 100%（`kept` 计满 `PER_TIER`，无 `light/heavy/budget` 丢弃），**未触及 <20% 红线**。
- **计数器中位耗时**：glance/probe/grind 全部 ≤ 7 ms；**siege 中位 2088 ms、最大 2378 ms，远超 300 ms**
  ——按纪律如实写在这里与 README/DESIGN。这是**构建期**成本（整 bake 约 34 s，几乎全在 siege），
  不进点击路径，故不影响手感；但提高 `PER_TIER` 会线性放大它。
- **搜索最大状态数**：入库关卡复解最大 2795 节点（siege）；bench 扫出的 `|S|≈420` 死区单本要 36769 节点 / 约 6.5 s，
  是"朴素剪枝太弱"的最硬证据，`|S|` 窗口刻意绕开它落在 493–519。

## 唯一解 / 难度的证据在哪

- **难度可复推**：`test/library.test.mjs` 对每关用全新求解器从序列化 `book` 复解，断言等于印着的 `value`。
- **计数器不是装饰 / 两侧夹紧**：`test/library.test.mjs` 对每关断言 `canBreakIn(book, value-1)===false`
  且 `canBreakIn(book, value)===true`（第二求解器，无 memo）；`test/naive.mjs` 再对小空间穷举背书。
- **提示最优性**：`policyClosed` 的闭合 + 严格下降检查（bake 与 `minimax.test` 都跑），使
  `hint` 的 `exact:true` "还需 N 次"为定理级事实而非启发式。

## 未实现清单（写清楚，不留空头承诺）

- **浏览器内生成/搜索**：故意不做（DESIGN 第 2/3.2 节实测：siege 单本 >2 s）。"换一关"是从烤好的池子换种子取关。
- **Electron 打包产物**：`electron/main.cjs` 存在且过 `node --check`，但仓库不装 electron，**未跑真实启动**。
- **CI/Pages 已在真实 runner 绿**：`ci.yml`/`pages.yml` 按契约写好（Syntax 步与 `npm run check` 文件集逐字
  一致；Pages 只 `cp index.html css js`，绝不 `path: .`）。2026-09-27 主代理发布后 Actions 实跑
  `success`（trigger sha `9d8fb3b`），线上产物见下面的「线上验收」一节。
- **成就 / 排行 / 云存档 / 战绩分享**：组织规范 E 组禁止；分享只有 `#/lot/<id>`（同关不含分数）。
- **移动端真机手势验证**：`@pointer` 用 CDP 派发合成鼠标/键盘事件，未在真 touch 设备验证 `touch-action`。
- **大于 420 死区另一侧的更难关卡**：`|S|` 再往上需先重解搜索预算，非调大 `maxMs` 可及。
- **通关音效 / 彩带 / 美术资产**：全仓 0 个二进制资产文件。
- **多语言**：UI 只有中文。

## 线上验收（GitHub Pages，主代理 2026-09-27 实抓）

发布 sha `44b9e28`，CI trigger `9d8fb3b` → Actions `success`。

产物可达性（`curl`，只看 HTTP 状态与字节数）：

| 资源 | 结果 |
| --- | --- |
| `/`（index.html） | 200 / 3,474 B |
| `js/main.js` | 200 / 17,917 B |
| `css/game.css` | 200 / 6,545 B |
| `js/data/lots.js` | 200 / 200,780 B |
| `<title>` | 与 README 标题一致 |

真实浏览器渲染（`https://z-biz-game.github.io/z-biz-game-tango-cos/`，2026-09-27 09:35Z）：

- `document.title` = `破码 · TANGO`；
- canvas 后备缓冲 `1384x1142`，CSS 盒 `692x570.7`（devicePixelRatio 2 生效，不是 300x150 的未布局默认值）；
- `getImageData` 全量采样 1,580,528 个像素：其中 **1,233,850 个非近黑**，出现 **2,341 种不同 RGB**——
  画布确实在画棋盘与棋子，而不是留一张黑底；
- `window.tango` 存在并暴露 **18 个键**（应用钩子已挂上，路由可寻址）；
- 控制台 **0 条消息**（无 error、无 warning）。这也覆盖了 `/favicon.ico`：`index.html:8` 用的是
  `<link rel="icon" href="data:,">`（一个空 data URI，浏览器因此根本不发 favicon 请求），
  见 DESIGN.md 第 6 条；**不是**内联 SVG 图标——那是后续可选的视觉打磨，与本节的"console 干净"无关。

诚实边界：这一节是"结构 + 像素统计"级别的证据（在真实页面里跑 `evaluate_script` 取 `getImageData`），
**不是**逐帧视觉比对的截图；本次未产出 PNG 截图，仓库也保持 0 个二进制资产。
