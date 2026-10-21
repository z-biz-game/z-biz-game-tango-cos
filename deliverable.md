# 破码 - 交付报告

| 字段 | 值 |
| --- | --- |
| 英文名 / 仓名 | 破码 TANGO · `z-biz-game-tango-cos` |
| 基线 → 本次 | 并线后 `43481a5` → 修复 + 本文件这一笔 |
| 玩法一句话 | 4 位 × 6 色（1296 枚码）里猜出那一枚密码；每关印着的"N 次必破"不是人觉得像几分难，而是 `js/core/minimax.js` 在 `p(n)` 个局面上的极小极大搜索量出来的最坏情况保证值 |
| 依赖数 | 0（`dependencies` 与 `devDependencies` 都是 `{}`，无打包器、无 npm install） |
| node 层断言 | 105 条（7 个套件），fail 0 |
| 浏览器层断言 | 66 条（`@boot @play @routes @save @pointer` 五档），fail 0，console 干净 |
| 部署集闸 | 64 条引用（含 4 张位图尺寸核对）/ 86 条断言，fail 0；台架 `DS_SELFTEST rc=0` |
| 测试钩子 | `window.tango`（含 `frames()` / `pegPoint()` / `palettePoint()` / `setReducedMotion()`） |
| 路由 | `#/c/<n>` · `#/daily` · `#/random/<band>/<token>` |

## 0. 一句话

并线（`43481a5`）把两侧内容按"重叠块取较新权威"合到一起，在这仓留下七处互相打架的接线，
其中第一处是**整局级**的：`js/view.js` 里 `step(now)` 的参数名与函数体里的 `const now = nowMs();`
撞名，ES module 里同名声明是 SyntaxError ⇒ 模块根本不加载 ⇒ `js/main.js` 的 import 一起炸
⇒ 页面上一行都不跑（`npm test` 在语法那一步就退 1，连套件都进不去）。
这次逐处归因并修掉，**没有删任何功能**：删的全是并线拼出来的重复实现
（两套全屏、两套减弱动效、重复的 service worker 注册、重复的一份图标集），
并线弄丢的那几块（本地那侧的整套 head 与图标集、本地那侧的时钟实现、本地那侧的清单与 SW）都补回来了。

## 1. `js/view.js`：`step(now)` 与 `const now` 撞名 ⇒ SyntaxError ⇒ 整局不可玩

**旧代码错在哪**

并线后的 `js/view.js` 是两套时间实现拼起来的：

* 本地侧那套：`step(now)` 接 rAF 的时间戳，用 `last` 算 dt，`advance(dt)` 是**唯一**让时间往前走的地方
  （`paused` 在动任何累加器之前就 return，所以暂停是冻住而不是变慢）；
* 远端侧那套：`tick()` 自己调 `nowMs()` 取时间，用 `animT0` 算 dt。

并线把本地侧的**签名**与远端侧的**函数体**接到了一起：

```js
  function step(now) {
    raf = 0;
    const now = nowMs();        // ← 参数名与函数体里的 const 同名
```

ES module 的顶层与函数体都是严格模式，同名声明是 **SyntaxError**（不是运行期错误），
解析阶段就失败 ⇒ `js/view.js` 永远不会被求值 ⇒ `js/main.js` 里的
`import { createView } from './view.js'` 一起失败 ⇒ 整局不可玩。

而且这不止一处：并线还把本地侧那段声明（`live` / `clock` / `frames` / `last`）换成了远端侧那段
（`animT0` / `ANIM_MS` / `nowMs`），于是本地侧的 `advance(dt)` 里那句 `clock += dt`、
`live = Math.max(0, live - dt)` 引用的是**根本没声明**的变量；`setGame` 里还调着一个
并线过程中被改名的 `tick()`（那个函数已经不存在了）。
就算把语法那处改掉，严格模式下的 ReferenceError 也会接着炸。

**新代码为什么对**

`js/view.js` 整体还原成本地侧那版——它是完整的一套：**一个时间源**（rAF 给的时间戳）、
**一处让时间往前走**（`js/view.js:370` 的 `advance(dt)`）、**一个暂停语义**
（`paused` 在动累加器之前就 return）。`js/view.js:383` 的 `step(now)` 用 rAF 的时间戳算 dt，
夹在 50 ms 以内（后台标签页的 rAF 会停，回来时不能一口吃成整段动画）。

远端侧那套并没有白来：它有一个本地侧没有的**只读探针** `isReducedMotion()`。
这一行留在还原后的视图上（`js/view.js:439` 的 `isReducedMotion`），
让量具与手工测试能问"这枚开关现在开着吗"，不必去改系统设置再回读画面。

## 2. `js/main.js`：并线在文件尾巴上又拼了一整块

**旧代码错在哪**

并线后的 `js/main.js` 是本地那版**加上**远端那版的一整块（695 行之后）：

* 一个 `bindFullscreen` IIFE，绑的是 `#btn-fullscreen`——而本地那版的 `toggleFullscreen`
  已经绑着 `#fullscreen` 了；于是页面上有两颗全屏按钮、两条全屏接线，
  而且远端那套自己还注册了一个 `keydown` 监听，按 F 键会**连着切两次**（进全屏再退出）；
* 一套**第二份**减弱动效路径：`motionQuery` / `applyReduceMotion` / 自己的 change 监听，
  改的是另一个名字的 setter（`view.setReduceMotion`），与本地那套 `view.setReducedMotion` 各改各的。

**新代码为什么对**

接线只留一条，能力取两边并集：

* `js/main.js:333`（`fullscreenApi`）一次问清 `requestFullscreen` / `webkitRequestFullscreen` /
  `msRequestFullscreen` 与三个 `exit*`、三个 `fullscreenElement`（远端那套的 ms 前缀补进本地那套）；
* `js/main.js:347`（`markFullscreenUnsupported`）查不出能力就把按钮灰掉并把原因写进 `title`
  （不解释的禁用等于这功能没做完）；被拒绝时也走这一条；
* `requestFullscreen` 返回 Promise，iOS Safari 对多数非 video 元素直接拒绝，
  这个 rejection 必须吃掉，否则冒泡成未捕获错误、整局游戏跟着挂；
* 退出走 `fullscreenchange` / `webkitfullscreenchange` / `MSFullscreenChange` 三个事件回写按钮状态
  （`js/main.js:481` 的 `MSFullscreenChange`）；
* F 键补 `ev.repeat` 守卫（`js/main.js:526` 的 `low === 'f'`）：按住不放不该连着切进切出；
* 减弱动效：系统设置与运行时钩子**走同一条路**（`app.reducedMotion` + `view.setReducedMotion`），
  钩子挂在 `js/main.js:723`（`window.tango.setReducedMotion`），探针挂在下一行。

## 3. `index.html`：head 被换成远端那版，页面因此少了一半

**旧代码错在哪**

并线把 `index.html` 的 head 换成了远端那版，丢掉了本地那版的：

* 五档 PNG favicon（16/32/48/96/192）+ `apple-touch-icon`（`assets/img/` 那套，
  由 `assets/gen/gen_art.py` 逐字节生成）；
* `theme-color` / `apple-mobile-web-app-capable` / `mobile-web-app-capable` /
  `apple-mobile-web-app-title` / `apple-mobile-web-app-status-bar-style`；
* 远端那版自己带来的是一枚 `<link rel="icon" href="data:,">`——**空的 data URI**，
  以及指向另一套图标目录（`icons/`）的三行 link。

同时页面上多了：第二份 `<link rel="manifest">`、第二块 `<details class="about">`（玩法说明）、
第二颗全屏按钮 `#btn-fullscreen`、以及一条 `<script src="js/sw-register.js">`。

**新代码为什么对**

`index.html` 整体还原成本地那版（`index.html:21-25` 是那五档 favicon，
`index.html:27` 是那一条 manifest link，`index.html:41` 是那颗全屏按钮），
并按部署集闸的 R7 把 `og:image` / `twitter:image` 改成**绝对 URL**
（`index.html:11` 的 `og:image`）：抓取器读的是别人页面上的字符串，不会替 Pages 补 `/<slug>/` 前缀，
相对写法在别人眼里就是一张 404 的卡片。README 里那份部署前缀声明（第七节之前那一段）就是闸的 PAGES 来源。

## 4. 清单、SW、图标：两套并存

**旧代码错在哪**

* `manifest.webmanifest` 取了远端那版：三个图标全部指向 `icons/`，元信息只剩
  name/short_name/start_url/display/主题色——本地那版的 `id` / `lang` / `dir` / `scope` /
  `display_override` / `orientation` / `categories` / `description` 与两条 `shortcuts` 都没了，
  1024 母本与 192 档也没了；
* `sw.js` 取了远端那版（`VERSION='tango-cos-v1'`，只预缓存两件），
  而本地那版是 `VERSION='tango-cos-v3'`（`sw.js:13` 的 `VERSION`）并预缓存整份外壳；
* `js/sw-register.js` 是远端那侧的经典脚本，自己注册一次 service worker——
  而本地那侧的 `js/main.js:619`（`serviceWorker.register`）**已经注册了**；
* `icons/` 那 5 张 PNG 与本地那侧的 `assets/img/` 12 张是**同一批图的两种落法**
  （本仓的图由 `assets/gen/gen_art.py` 生成，`icons/` 那套在本仓里没有生成器）。

**新代码为什么对**

* 清单还原成本地那版（`manifest.webmanifest:14` 的 `icons` 指向 `assets/img/`，
  `manifest.webmanifest:20` 的 `shortcuts` 也回来了）；
* `sw.js` 还原成本地那版（与本地那侧的注册、预缓存、离线兜底同一套）；
* 删掉 `js/sw-register.js` 与它在 `index.html` 里的那条 script 标签——注册只留 `js/main.js` 那一路
  （带 `navigator.serviceWorker` 存在性守卫、失败不抛、scope 按页面算）；
* 删掉 `icons/` 那 5 张重复的 PNG：清单与页面都指向 `assets/img/`，而那份是有生成器的。

## 5. 文档行号：3 处引用漂了

**旧代码错在哪**

并线把 `js/core/storage.js` 换成了本地那版（234 行），而 `DESIGN.md` 里那三处引用指着的是
**远端**那版（155 行）的行号：

```
FAIL D3 每一条 `path:NN` 都指回实处 …
     解析 32 条 · 指不回实处 1 条：js/core/storage.js:78 那几行整段是空行
FAIL D4 锚点腿：贴着引用那个名字必须作为**完整标识符**出现在被指的那几行里
     带指认 7 条 · 对不上 2 条：js/core/storage.js:147 那几行里没有 persistent | js/core/storage.js:103 那几行里没有 solve
```

**新代码为什么对**

逐条重钉到当前树上真的那几行（改的是**钉**，不是闸的断言强度）：

| 旧引用 | 新引用 | 指认 |
| --- | --- | --- |
| `js/core/storage.js` 147 行 | `js/core/storage.js:226` | persistent |
| `js/core/storage.js` 103 行 | `js/core/storage.js:173` | solve |
| `js/core/storage.js` 78 行 | `js/core/storage.js:150` | unlock |

`test/docs.test.mjs`（并线从远端侧带进来的那条腿）随即回到 `rows: 15 fail: 0`。

## 6. 真实文件清单（本次动过的 13 个文件）

| 文件 | 动了什么 | 为什么 |
| --- | --- | --- |
| `js/view.js` | 整体还原成本地那版（一个时间源 / 一处 advance / 一个暂停语义）+ 补 `isReducedMotion` 探针 | 重复声明是 SyntaxError，整局不可玩 |
| `js/main.js` | 删并线拼在尾巴上的第二套全屏与第二套动效；能力并入本地那套；F 键加 `repeat` 守卫；补运行时钩子 | 一次点击走两条路；按键连切 |
| `index.html` | 整体还原成本地那版（head、favicon 集、玩法说明、按钮）；`og:image` 改绝对 URL | head 少了一半；分享卡片 404 |
| `manifest.webmanifest` | 还原成本地那版（`assets/img/` 图标 + 全套元信息 + shortcuts） | 清单与页面不同源 |
| `sw.js` | 还原成本地那版（`tango-cos-v3` + 整份外壳预缓存） | 与本地那侧的注册不同源 |
| `js/sw-register.js` | 删除 | 与 `js/main.js` 的注册重复 |
| `icons/`（5 个 PNG） | 删除 | 与 `assets/img/` 里的同一批图重复，那份有生成器 |
| `DESIGN.md` | 3 处行号重钉 | 并线换了被引用的文件 |
| `README.md` | 部署集闸那三对数（25→64、43→86）、node 层套件与条数（6 套 88 条 → 7 套 105 条）、`icons/*` → `assets/img/*` | 文档要指得到真的东西 |
| `tools/deploy-set.mjs` | 两对常量重钉（64 / 86） | 页面换了，钉的是实数 |
| `deliverable.md` | 本文件 | 交付物 |

## 7. 删行审计

`git diff --stat 43481a5 HEAD`：13 files changed, …（见第 9 节实跑输出）。

删掉的行逐块点名（**没有一块是功能**）：

| 删掉的东西 | 为什么可以删 |
| --- | --- |
| `js/view.js` 里远端那套时钟实现（`animT0` / `ANIM_MS` / `nowMs` / `tick`） | 与本地那套重复；本地的那个时间源只有一处 |
| `js/view.js` 里并线拼出来的 `step(now)` + `const now` | 同名声明是 SyntaxError |
| `js/main.js` 里 `bindFullscreen` IIFE（整段） | 与本地那套重复；能力已并入 |
| `js/main.js` 里第二套 `motionQuery` / `applyReduceMotion` / 监听 | 两套路径各改一份状态 |
| `index.html` 里远端那版的 head（含 `href="data:,"`） | 换成有生成器的那套 favicon |
| `index.html` 里重复的 manifest link / 第二块玩法说明 / 第二颗全屏按钮 / `sw-register.js` 的 script 标签 | 同一件事写两遍 |
| `manifest.webmanifest` 远端那版整份 | 换成本地那版，不是删功能 |
| `sw.js` 远端那版整份 | 换成本地那版，不是删功能 |
| `js/sw-register.js` 整份 | 与 `js/main.js` 的注册重复 |
| `icons/` 5 张 PNG | 与 `assets/img/` 里的同一批图重复 |

## 8. 行为变化需知会

1. **减弱动效的对外钩子改名**：`window.tango.setReduceMotion` → `window.tango.setReducedMotion`。
   名字取本地那侧那个（视图上的 setter 也是这个名）；旧的 `setReduceMotion` 不再存在
   （并线后两个都在，是并线拼出来的）。`window.tango.isReducedMotion()` 保留。
2. **全屏按钮被禁用时会写明原因**：查不出元素全屏能力（iOS Safari 的普通页面）或请求被拒时，
   按钮变灰且 `title` 里写清楚，而不是只弹一句 toast。
3. **F 键不再连切**：按住不放只切一次。
4. **分享卡片现在指绝对 URL**：`og:image` 从 `assets/img/og.png` 改成
   `https://z-biz-game.github.io/z-biz-game-tango-cos/assets/img/og.png`。
5. **service worker 只注册一次**（走 `js/main.js` 那一路），缓存名回到 `tango-cos-v3`。

## 9. 验收命令与原样输出

```
$ cd z-biz-game-tango-cos && bash tools/verify.sh
...
rows: 11 fail: 0     (test/book.test.mjs)
rows: 15 fail: 0     (test/codes.test.mjs)
rows: 15 fail: 0     (test/docs.test.mjs)
rows: 14 fail: 0     (test/game.test.mjs)
rows: 18 fail: 0     (test/library.test.mjs)
rows: 21 fail: 0     (test/minimax.test.mjs)
rows: 11 fail: 0     (test/storage.test.mjs)
=== @boot ===     rows: 12 fail: 0
=== @play ===     rows: 10 fail: 0
=== @routes ===   rows: 15 fail: 0
=== @save ===     rows: 11 fail: 0
=== @pointer ===  rows: 18 fail: 0
=== console ===
(none)
=== deploy-set ===
部署集：64 条引用（含 4 张位图尺寸核对），失败 0 项
rows: 86 fail: 0
DS_SELFTEST rc=0（0=每一刀都按预期发力、阴性对照按预期不发力）
DS_SELFTEST_BASELINE 部署集：64 条引用（含 4 张位图尺寸核对），失败 0 项 rows=86
=== ALL GREEN ===
```

`RC=0`。node 侧 7 个套件合计 105 条断言、浏览器侧 5 档合计 66 条断言，全部 `fail: 0`，
控制台 `(none)`，部署集双闸 64 条引用 / 86 条断言 0 失败、台架 rc=0。

## 10. 未实现 / 需人接手

1. **线上站点没验过**：本轮只跑了本地闸，没有对
   `https://z-biz-game.github.io/z-biz-game-tango-cos/` 做任何网络核对。
   README 里那份部署前缀声明是**写给闸读的**，不是"站点已上线"的读数。
2. **部署集闸的 X13 那一把在本仓是 SKIP**：它要清单里真有一段内联 base64 位图，
   而本仓的清单图标是 `assets/img/` 里的真文件 ⇒ 台架打印 SKIP。
   P 段改由 X7 证（把 `assets/img/icon-192.png` 的声明改成 256x256 必须被点名，实跑确实点了名）。
3. **构建期成本没重测**：`npm run bake` 与 `npm run bench` 本轮没跑（那是分钟级的构建期作业，
   与本轮的合线修复无关）；README 里"围城档单本码本中位 2088 ms"那个读数仍是上一轮的。
4. **`electron` 桌面形态没跑过**：`electron` 不是依赖（`package.json` 里两个 `{}`），
   `npx electron .` 要自己先装。

## 11. 基线归因（并线后基线 vs 并线前）

用 `git worktree add --detach /tmp/tango-merge 43481a5`（并线后）与
`/tmp/tango-ours 43481a5^1`（并线**前**那一侧）在**同一台机器**上跑同一批闸：

| 腿 | 并线前（`43481a5^1`） | 并线后（`43481a5`） | 归因 |
| --- | --- | --- | --- |
| `npm run check`（语法门） | 通过 | **SyntaxError: Identifier 'now' has already been declared**（`js/view.js`） | 并线引入（整局级） |
| `npm test` | 通过（6 套 90 条） | 语法那一步就退 1，套件一条都进不去 | 并线引入 |
| `test/docs.test.mjs` | 不存在（远端侧才有这条腿） | 红 2 项（3 处引用漂） | 并线引入 |
| `tools/deploy-set.mjs` | 不存在（远端侧才有这套闸） | 红 2 项（条数与断言数两对钉失配） | 并线引入 |
| `index.html` 的 head | 五档 favicon + 移动端元信息 + 本地那版 og:image | 换成远端那版：少一半、加一枚 `data:,`、加第二份 manifest link 与第二块玩法说明 | 并线引入 |
| `js/main.js` 的全屏 | 一套（`#fullscreen`） | 两套（多一条 IIFE、多一颗按钮） | 并线引入 |
| service worker 注册 | 一处（`js/main.js`） | 两处（多一份 `js/sw-register.js`） | 并线引入 |
