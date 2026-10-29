# ARCH-断言 · 工程底座自己的账

> 本仓有 19 条在跑的硬断言（覆盖禁裸中文、层级依赖、token 化、换肤不改 DOM 形状等）。这份文档只回答三个问题：
> **哪几条真的在跑**、**哪几条只能靠约定＋为什么**、**哪几条等内核**。
>
> 一条命令：`pnpm gate`。单跑静态那一层：`pnpm arch:check`（`scripts/arch-check.mjs`）。
> 本文所有「命中数」都是那次运行会打印出来的东西 —— 数字对不上就是文档过期了，以脚本输出为准。
>
> 想先看全貌：[架构与数据结构](https://qua.leay.net/arch.html) —— 一张图的分层、块字段、
> 写/读路径。它从 [`public/arch.html`](../public/arch.html) 发布，抬头上的版本号与门禁基线由
> `scripts/fill-arch-diagram.mjs` 在部署时现算（`{{占位符}}` 是源，不是成品）。

---

## 0. 门禁入口

```bash
pnpm gate         # 类型 + 单测 + 构建 + 静态断言 + 161 条浏览器冒烟 + 12 条布局断言 + 13 条真 Electron 冒烟
pnpm gate:fast    # 按这次改动的路径只跑碰得到的那几支（日常小改动用；不是收工门禁）
pnpm gate:bundle  # gate + 4 条打包产物冒烟（要 .app，慢，所以单列）
pnpm arch:check   # 只跑静态那一层（秒级）
```

`gate` 是**编排**出来的（`scripts/gate.mjs`），不是一条 `&&` 链 —— 按产物依赖分三段、段内并发：

```
① 静态与单测（并发）
    pnpm typecheck          # tsc（renderer + electron，两套 tsconfig）
    pnpm arch:check         # ← 本文的主角
    pnpm test:core          # tests/*.test.ts
② 构建（并发）
    pnpm build:test         # tsc + vite build（带测试面 → dist/）
    pnpm build:electron     # esbuild（electron/*.ts → dist-electron/*.cjs）
③ 冒烟（并发）
    pnpm check:smoke ×N     # node checks/smoke.mjs，98 条按序切片分给 N 个进程
    pnpm check:dock         # 真量尺寸的布局断言
    pnpm check:electron     # 真 Electron（跑 dist/ + dist-electron/）
```

切片数取 `min(4, 核数/2)`（③ 里还有 dock 与 electron 要抢核）；`--shards=N` 可覆盖。

两个**必须写下来的坑**：

1. **`check:electron` 测的是 `dist-electron/` 里的旧产物**（package.json 的 `main` 指向它）。
   所以 gate 里 **`build:electron` 必须在 `check:electron` 之前**；单独跑 `pnpm check:electron`
   前先 `pnpm build:electron`，否则你验的是上一次改动的壳（本轮就是这么踩到的：改了菜单文案，
   不重建 `main.cjs` 的话 E3 会拿旧菜单过）。
2. **`check:bundle` 测的是 `release/` 里的 `.app`**（`pnpm build:mac` 的产物），不是 `dist/`。
   它不跟着 gate 跑；`gate:bundle` 也不会自动重打包 `.app` —— 要验证新代码，先 `pnpm build:mac`。

---

## 0.5 架构背景（从 README 回流的工程说明）

### 三张表落在哪

| 表 | 文件 | 说明 |
|---|---|---|
| **命令表** | `src/core/commands/decls.ts` `COMMANDS` | 纯语义：`name/title/args/capability/undoable/version`。**没有 key、没有 context、没有 host** |
| **绑定表** | `src/core/bindings.ts` `BINDINGS` | `{command, kind: keymap\|menu\|slash\|toolbar\|palette, key?, when?, args?, group?, order?, layer}`，一个机制五处复用 |
| **上下文键** | `src/view/editor.ts` `ctxKeys()` ＋ `src/main.ts` `uiCtx()` | 开放键空间；`composing` 也是一个键（不是一个 if） |

- `resolveKey()`：**从下往上求值，第一条 `key` ＋ `when` 都匹配的胜出**；层次序 `user > plugin > core`。
- `resolveBindings(kind, ctx, {prefix, query})`：菜单/斜杠/工具栏/命令面板**都是它的渲染结果**（`src/ui/layers.ts` 一个渲染器）。
- 命令面板列的是**命令表的全部命令**（51 条，其中大部分没有任何键位）——这就是键盘可达性的兜底。

### 核心模块的来源（**不许退化的部分**）

`src/core/` 复用自一个独立的输入面原型（按职责分片，口径不变） ＋ 三处扩展，**没有改动任何一条已验证口径**：

复用：`uuidv7Hex` / `diffText` 前缀后缀 diff / `locate` / `flatten` / `splitBlockBefore` /
`mergeIntoPrev` / `replaceBlockRange` / `normSel` / `blockIdsOf` / `fromBlockSet` / `selToTextRanges` /
`UndoStack`（1200ms 合并窗口）/ `CommandLog`。

**行内内容**换过一次形（这一步不再复用原型的锚点机制）：正文＝**一串 run**（文本段带格式，
引用／外链／图片是不可分的一枚），可引用区间（`annos`）只在真被引用时才物化、住在块上。
于是「原子在字符串里占一格」的占位符、逐端粘性映射（`mapOffset`／`mapMarks`／`mapAtoms`）
与「锚点带 blockId 的库级扁平数组」**全部退场**——它们的活由序列语义与块上归属接管。
`arch-check` `[25]` 钉住这套旧零件不复活。

原型扩展（**加字段不改口径**）：

1. 格式（bold / italic / highlight / code）是 **text run 上的属性**：一段字自己带格式，
   打字时新字继承邻位格式是序列的自然结果，不需要任何映射；
2. 行内原子（引用／外链／图片）是 **序列里不可分的一枚**，`to` 指向**实体 id**、带名字快照，
   解析不到就是 `dangling`（不静默错指）。删掉它一定是显式动作——不会「删字顺手吃掉」；
3. 结构操作：缩进/取消缩进/兄弟交换/拖拽挂载（带循环守卫）/复制子树（全部发新 id）/折叠/待办。

**视图层**（`src/view/editor.ts`）沿用同一套输入面原型的形状：单一 `contenteditable` 容器 ＋ **扁平块级 DOM ＋ `data-depth` ＋ padding 缩进**
（DOM 层级会与窗口化虚拟化打架），组合期不重渲染该块、`compositionend` 后补渲染。
本层**一个键位都不处理**：document 上只有一个 dispatcher，它做的是
`resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`。

---

## 1. 断言总表（17 条基础 ＋ 11 条额外）

图例：**跑**＝每次 gate 真跑的断言（静态或真浏览器/真 Electron）；**约定**＝只能靠约定/评审；
**内核**＝等内核，本轮明确不查（理由见 §4）。

| # | 断言 | 落地 | 状态 |
|---|---|---|---|
| 1 | 不得绕过 `DbClient`；不得写 SQL | 无对象可查 | **内核** |
| 2 | 主进程不得 import 数据层 | `arch-check` `[2+]` | **跑** |
| 3 | 命令 decl 不得含 `context`／`host`／`key` | `arch-check` `[15]`（顺带查 `title` 必须走 `t()`） | **跑** |
| 4 | 同名命令不可二次注册 | `arch-check` `[4+]` | **跑** |
| 5 | 授权/审计不入 KB 表；绑定入 KB | 无表结构可查 | **内核** |
| 6 | ID 同型（32-hex UUIDv7） | 静态只能证明函数在 | **内核**（单测口径） |
| 7 | 三寄存器存在、无单一 `hlc` 列 | 无 migration 可查 | **内核** |
| 8 | 写事务必产 op-log 批 | 无事务层可查 | **内核** |
| 9 | 未 `expose` 的命令不出现在 HTTP／MCP／CLI 面 | 三个面都还没起 | **内核** |
| 10 | 派生索引可全量重建且与增量逐字节一致 | 那本质是集成测试 | **内核** |
| 11 | 不得有裸中文字符串（i18n） | `arch-check` `[11]` | **跑** |
| 12 | 不得有颜色/间距字面量（token 之外） | `arch-check` `[12]`（硬）＋ `[12b]`（欠账，不拦门） | **跑（部分）** |
| 13 | 层级依赖方向（`core←view←ui←host`；`view` 禁 React） | `arch-check` `[13]` | **跑** |
| 14 | 原生模块白名单（只 `better-sqlite3`） | `arch-check` `[14]` | **跑** |
| 15 | `userData` 不含非 ASCII 且以 `net.leay.qua` 结尾 | `checks/electron-smoke.mjs` E1＋`checks/bundle-smoke.mjs` B2 | **跑**（不在 arch-check：要真起 Electron） |
| 16 | 换外观不得改 DOM 类名/形状（亮/暗 `data-depth` 一致） | `arch-check` `[16]`（静态确认断言还在）＋ smoke T11 真跑 | **跑** |
| 17 | 组件不得直改 KB 状态（只经命令） | `arch-check` `[17]` | **跑（只能查一半，见下）** |

额外的十一条（不在 17 条基础清单里，但都是真在跑的硬约束）：

| # | 断言 | 落地 | 状态 |
|---|---|---|---|
| `[key]` | `localStorage` 键名固定 `qua.workspace`（换键＝静默丢数据） | `arch-check` `[key]` | **跑** |
| `[3+]` | 主题三档只用 CSS 变量＋`color-scheme` 双轨、不做 JS 切类、首屏有兜底 | `arch-check` `[3+]`＋ smoke T11 | **跑** |
| `[18]` | **命令 handler 不得碰 DOM**（`document`／`window`） | `arch-check` `[18]`（反证过：把违规行放回去会红） | **跑** |
| `[19]` | 组件不得直接引用基础色 `--c-*`（只能用语义槽 `--ui-*`） | `arch-check` `[19]` | **跑** |
| `[20]` | 持久化收口：`localStorage` 只出现在一个适配器文件里；上层不再 import 同步 save/load | `arch-check` `[20]` | **跑** |
| `[21]` | 列表判定只走 `hasList`（禁读单值 `.role` 与裸 `.roles`） | `arch-check` `[21]`（反证过：放一行 `b.role === 'page'` 会红；裸读 `.roles` 在换载体后会静默恒假，同样拦） | **跑** |
| `[22]` | **块树遍历只有一个入口**（禁自写递归走 `children`） | `arch-check` `[22]`（反证过：放两种自写递归的写法都会红）＋ `tests/traversal.test.ts` | **跑** |
| `[23]` | app／ui 不得 import 块存储（数据只经注入的依赖面与读门面） | `arch-check` `[23]` | **跑** |
| `[24]` | app／ui 的依赖接口不得注入「整片森林」 | `arch-check` `[24]` | **跑** |
| `[25]` | **行内内容只有 run 序列一套**（禁旧形状的零件复活；含 `ImageRun` / `thumbUri` / `t:'image'`） | `arch-check` `[25]`（反证过：把 `mapAtoms` 放回去会红） | **跑** |
| `[26]` | **资产库只有一个产地**：`indexedDB` 只在适配器里；`URL.createObjectURL` 只在唯一文件里 | `arch-check` `[26]` | **跑** |
| `[27]` | **块只有四个内容槽**：`Block` 不得长出 `parent`／`left`／`text` 这类的第二份真相 | `arch-check` `[27]`（反证过：加一个 `parent?: string` 会红） | **跑** |

**当前基线**：`pnpm arch:check` 硬断言 **21/21 过**（`[12b]` 是如实记账、不拦门的欠账；
另有 6 条「等内核」，见 §4）。

---

## 2. 每条「真在跑」的具体口径

`scripts/arch-check.mjs` 的输出格式是固定的：**检查方式／扫描范围／白名单／命中数**。
下面把每条的白名单**为什么**写清 —— 白名单是这套东西里最容易被滥用的地方。

### `[11]` 禁裸中文字面量

- **检查方式**：TypeScript 自带 parser 建 AST，遍历 `StringLiteral` / 模板片段（`TemplateHead/Middle/Tail`）。
  注释根本不在 AST 里 ⇒ 「注释里的中文保留不动」是结构性成立的，不是靠正则躲。
  `index.html` 与 CSS 去注释后逐行扫。
- **扫描范围**：`src/**/*.ts`、`src/**/*.css`、`electron/**/*.ts`、`index.html`。
- **白名单与理由**：
  - `src/core/msg.ts` —— 字典本身；`src/core/seed.ts` —— 假数据（笔记正文不是 UI 文案）；
  - **`console.*` 的实参**（本仓 7 处）—— 开发者日志，不是用户可见文案；把它们塞进 i18n 字典
    会让字典变成杂物间。判定是按 AST 找 `console.log/warn/...` 的实参位置，不是行级猜测。
  - `checks/**`、`scripts/**` —— 测试与脚本，本来就不该被「用户文案」的纪律约束（也不在扫描范围）。
  - **`index.html` 里已经没有中文**：静态 attribute / 文案全部空壳化，启动时由 `paintStaticCopy()`
    从字典灌进去。这样首屏之前没有中文可漏，也没必要给 HTML 开白名单。
- **本轮唯一的非逐字改动**：`electron/main.ts` 的兜底显示原因 `'2s 兜底'` → `'2s-fallback'`。
  它只进 `console.warn`，是开发者日志标签；其余 **329 个**中文片段**逐字保留**（HEAD 共 330 个，
  有一次性核对脚本，见 §6）。

### `[13]` 层级依赖方向

- **检查方式**：AST 遍历 `import` / `export … from`，按**显式映射表**判层；相对路径按目标文件判，
  目标层序高于来源层序＝违规。`view` 层里出现 `react` / `react-dom`＝违规。
- **为什么是映射表**：四层是**目录**（`core/ view/ ui/ host/`），本仓现在是平铺文件
  （`src/core/**`、`src/view/**`、`src/ui/**`、`src/main.ts`、`electron/*`）。
  目录没落地的阶段，**映射表就是那条约定**；将来拆目录时，这张表删掉、换成按目录判。
  `src/main.ts` 单列为 `app`（renderer 装配入口，四层里没有它）。
- **白名单：类型导入**（`import type`）。本仓只有一条：`src/core/ports.ts` → `src/view/editor.ts` 的
  `BlockEditor` 类型（`App.ed` 要它）。`import type` 在编译期就被擦掉，运行时零耦合；
  要连它也禁，得把 `App` 门面从 `ports.ts` 挪出去 —— 那是另一件事（记在 §5 第 1 条旁边）。
- **现状**：`view` 里没有 React（一条都没有），`core` 没有反向 import（除上面那条类型边），
  `host` 只 import 了 `src/msg`（纯字典）。

### `[14]` 原生模块白名单

- **检查方式**：①`package.json` 的 **dependencies**（生产依赖）逐个探 `binding.gyp` / `gypfile` /
  目录下 `*.node`；②源码里 import 的裸模块同上。
- **为什么只查 dependencies**：`devDependencies` 里的 esbuild / electron 本身就是原生二进制，
  它们是**工具链与壳**，不是「应用跑起来要加载的原生模块」；把它们算进来只会逼人写一堆例外。
- **白名单**：`better-sqlite3`（还没接）；`electron` 是壳本体（E1 的 `require('electron')` 都靠它）。
- **现状**：生产依赖 0 个 ⇒ **命中 0**，符合「现在应为 0」。

### `[15]` 命令 decl 不得含 `context`／`host`／`key`；`title` 必须走 `t()`

- **检查方式**：AST 定位 `src/core/commands/decls.ts` 的 `COMMANDS` 数组，逐条 `ObjectLiteral` 查属性名；
  `title` 必须是 `t(...)` 调用。
- **为什么把 `title` 也加进来**：命令表的 `title` 是命令的三个收敛点之一（命令表只存语义、不存 UI 文案）。
  只禁三个字段的话，`title: '拆分块'` 还是能混过去 —— 所以顺手把收敛点也钉了。
- 属性名精确匹配 ⇒ `keywords:` 里的 `key` 不会误伤。

### `[4+]` 同名命令不可二次注册

AST 取 `COMMANDS[].name` 查重。现状 51 条命令 / 51 个唯一名。

### `[2+]` 主进程不得 import 数据层

AST 遍历 `electron/**/*.ts`：禁止 `workspace` / `seed` / `core/` / `commands/`；
只放行 `../src/msg`（零依赖的纯字典，不是数据层）。

### `[12]` 颜色 / 间距字面量（**硬**）

拆成两半，口径不同（这是本轮最重要的一个取舍）：

1. **TS/组件代码**：颜色（`#hex` / `rgb()` / `hsl()` / `oklch()` / `color-mix()`）与
   长度（`px/rem/em/pt/vh/vw`）**一个都不许有**。原先把 `'8px'` 这种内联样式写在
   `main.ts` 里，现在是 `.popover-note` 类 + `--sp-3b`。
2. **`src/styles/tokens.css`**：按 `/* @token:begin */` … `/* @token:end */` 切段，**段外只硬卡颜色**；其余分片整份按段外扫。
   本轮把皮肤段里唯一的 `rgba(0,0,0,.02)` 收进了 `--card-shadow`，所以段外颜色 **0**。
3. **`[12b]`（欠账，不拦门）**：段外的**长度**字面量还有 **111 行**（`1px` 描边、`100vh`、
   `calc(6px + …)` 的缩进几何、字号/圆角……）。清零 = 重写整份 CSS 并逐个复核三种皮肤 × 亮暗的
   视觉，**不在本轮**（本轮的任务是「TS/组件里的字面量清零」；CSS 里先卡住颜色，长度如实记账）。
   这条欠账要消失，得单独排一轮「token 化全量 CSS」，不是顺手能干的。
- **白名单与理由**：
  - `src/core/msg.ts` / `src/core/seed.ts`（里面没有样式）；
  - （原 `thumbUri` 的 SVG 取色白名单已随资产层落地删除：那张程序生成的渐变图不再是「真图」的替身。）
  - `electron/main.ts` 的 `BrowserWindow.backgroundColor`：主进程**没有 CSS**，首帧前的窗口底色
    只能由 shell 给（现在是 `nativeTheme.shouldUseDarkColors ? 暗 : 亮`，避免暗色系统上先闪一帧白）。

### `[16]` 换外观不改 DOM 形状

这条**一半静态、一半动态**：

- 静态（`arch-check` `[16]`）：确认 `checks/smoke.mjs` 里那条断言还在（`domShape` 亮/暗两次取样 +
  `a.domShape === light.domShape === dark.domShape`，以及「body 无 `data-skin`」的否定式断言）。
  它防的是「有人把断言删了」。
  ⚠️ **2026-10-20 改口径**：三皮肤已删，「换肤」这个动作不存在了 ⇒ 断言改为
  「换**主题**不改 DOM 形状」。不变量本身没变（同一套 token 的两次取值，DOM 必须逐行一致），
  变的是采样次数：三 → 二。
- 动态（`pnpm check` 的 T11）：真 Chrome、真 `data-depth` 序列。**DOM 形状只有浏览器说了算**，
  静态检查永远只是它的影子。

### `[17]` 组件不得直改 KB 状态

**能查的**（静态）：`src/ui/**` 与 `src/view/**` 不得 import `workspace.ts` / `seed.ts`、
源码里不得出现 `localStorage` / `saveWorkspace` / `clearWorkspace` / `loadWorkspace`。现状 0 命中。

**查不了的**（写清理由）：「经命令 vs 直改」在当前实现里**分不开**——`view.ts` 就是内存文档的持有者，
命令最终也落到它的 `tx()` 上，两者在静态上都是「调一个方法改一个对象」。真正的判据是
「写路径只有 `DbClient` 事务」——**等内核**。`src/main.ts` 是**装配层**（不是组件），
它是唯一允许持有 workspace / seed 的地方。

### `[key]` localStorage 键名

把 `'qua.workspace'` 钉死在断言里。换键 ＝ 用户已存的库**静默消失**；真要换，
必须先改这条断言、再写迁移 —— 让「换键」变成一件**必须动手改门禁**的事。

### `[3+]` 主题双轨

静态查：`src/main.ts` 里有 `prefers-color-scheme` 的 `matchMedia` 监听；`index.html` 有首屏
`color-scheme` 兜底；JS 里没有「按主题切 class」。**「跟随系统真的变色」是渲染行为**，
静态查不了 ⇒ 由 smoke T11 用 Playwright 的 `emulateMedia({ colorScheme })` 真跑
（真 Chrome 里 `data-theme` 恒为 `system`、底色从亮变暗）。

### `[22]` 块树遍历只有一个入口

- **检查方式**：AST 扫 `src/**/*.ts` 的**函数**（`function f()` 与 `const f = () => …` 两种写法），
  命中条件是「这个函数自己递归走 `children`」：① 自调用且实参里出现 `.children`（`walk(b.children)`），
  或 ② `for (const x of ….children)` 且同一个函数里调用了自己（`for (const c of b.children) walk(c)`）。
  两种写法都覆盖：前者是「把子树传下去」，后者是「循环 children 再逐个子树递归」。
- **为什么必须机检**：多写一处递归**不报错、类型也过得去**，只是让「哪些块算活着、按什么顺序走」
  多一份答案；分歧那天没人知道，直到某处功能静默失效。实测过一次：日记流只看顶层、索引走整片森林
  ⇒ 同一天两个答案。
- **白名单与理由**：
  - **`src/core/walk.ts`** —— 唯一入口 `walkForest` 本身（它就是那处递归）。
  - **DOM 遍历不算**：它们走 `childNodes`（`for (const c of Array.from(n.childNodes))`），
    表达式里没有 `.children`，天然不命中。
  - **`cloneSubtree` 的 `cp` 不算**：它用 `x.children.map(cp)` —— 那是**造树**不是**走树**
    （自调用是作为回调传进 `map` 的，不是「自己调自己」），天然不命中。
  - **`seed.ts` 的 `buildTree` 是造树**：它 `b.children = buildTree(s.children, out)` —— 造**新**节点。
    判据落在 AST 上：自调用的结果若是 `children:` 属性或 `X.children =` 的右值，就不算「走树」。
- **反证**：把两种写法各放一处（临时文件）⇒ 立刻两条命中、门禁红；删掉即回绿。
- **行为那一半由单测钉**：`tests/traversal.test.ts` 断言派生出来的读路径**互相一致**
  （同一片森林、同一个先序）、早退真的立刻停、折叠只改 `hidden` 不改「走不走得到」。

### `[25]` 行内内容只有 run 序列一套

- **检查方式**：AST 扫 `src/**/*.ts` 的**标识符与属性名**，命中 `ATOM_PLACEHOLDER`／
  `writeBlockText`／`setAnnotations`／`normalizeMarks`／`mapAtoms`／`mapMarks`／`syncAnchors`
  即复活。注释不进 AST ⇒ 讲「为什么不再用它」不算命中。
- **为什么必须机检**：旧形状自带一套**自洽**的解释（原子在字符串里占一格、锚点靠逐端粘性映射跟随），
  所以把它写回来时类型检查与既有单测都不会喊；只有真编辑几轮之后才会显形
  （「删字顺手吃掉原子」「插在端点处多吞一个字」）。这条断言的作用是让「写回来」当场变红。
- **白名单：无**——那些名字对应的机制已被序列语义与块上归属取代，没有正当用途。
- **反证**：在 `src/core/runs.ts` 末尾加一行 `export const mapAtoms = 1` ⇒ 立刻红；
  删掉即回绿。
- **资产那一半**：`ImageRun` / `thumbUri` 也在同一张禁用名单里，另外单扫
  「`t:` 的值是 `'image'`」——那是**不需要标识符**的复活方式（写个字面量就成立），
  而它会让形状校验把整份库判成 corrupt（比静默错更糟：打不开）。

### `[26]` 资产库只有一个产地

- **检查方式**：AST 扫 `src/**/*.ts` 的 `indexedDB` 标识符（属性名不算）与
  `.createObjectURL` 属性访问；各自只允许出现在一个文件里
  （`core/storage/asset-idb.ts` / `view/asset-views.ts`）。
- **为什么是硬断言**：两条都不是风格问题 —— 一条是**数据静默消失**
  （IDB 库名 `qua.assets` 是不可逆契约，换名等于已有资产没了；散出去就守不住），
  一条是**慢性泄漏**（每次重渲染都建一个对象 URL，浏览器不回收，直到文档卸载）。
- **反证**：在 `src/main.ts` 里加一行 `URL.createObjectURL(new Blob([]))` ⇒ 立刻红。

### `[27]` 块形状只有四个内容槽

- **检查方式**：AST 读 `src/core/model.ts` 的 `interface Block`，成员名必须都在白名单里
  （`id`／`content`／`children`／`created`／`modified`／`annos`／`props`）。加字段就要改白名单，
  **那是一次显式动作**，不会顺手发生。
- **为什么是硬断言**：`parent`／`left` 一旦进块，就和 `children` 成了并列的两份父子关系。
  移动／复制／撤销／软删每处都要维护一次，漏一处就**静默分叉**（面包屑画出旧路径、子树在两处各有一个父亲），
  而它们本该是派生的：内存里只有 `children` 一份，取路径走派生索引 `Index.parentOf`（O(depth)），
  插件读路径走读门面（`kb.pathOf(id)`）。同一层存两份，等于让可丢弃的那份去追一个能算出来的东西。
- **反证**：给 `Block` 加一行 `parent?: string` ⇒ 立刻红（`命中 1 · Block.parent 不在白名单`）；删掉即回绿。

---

## 3. 只能靠约定的（为什么查不了）

| 项 | 为什么只能靠约定 |
|---|---|
| **皮肤只改 token、不改 DOM 形状** | 「结构规则」这四个字没有语法边界：`body[data-skin='c'] .blk { border: … }` 合法、`… { display: flex }` 也不违法，但后者会动版式。静态判不出「动了形状没有」；证据只能是 T11 的 `data-depth` 序列＋视觉复核。 |
| **命令不知道 UI**（命令表的字段里没有 UI 概念） | 字段名能查（`[15]`），但「命令把手伸进 DOM」查不出——**本仓现在真有一处**：`core.page/rename` 的 handler 里 `document.getElementById('page-title')`. 见 §5 第 1 条。 |
| **主题不做 JS 切类** | 能查 `classList.*('dark')`，查不出「用 `style.background` 手改色」。 |
| **注释里的中文保留不动** | 这条其实**是结构性成立的**：AST 里没有注释，所以 `[11]` 天然不碰注释（不是靠白名单放水）。 |
| **文案措辞不许改** | 静态只能查「有没有走 `t()`」，查不出「字典里的值有没有被偷偷改字」。本轮用一次性核对脚本对 `HEAD` 做了逐字比对（见 §6）。 |
| **`userData` 纯 ASCII** | 这是**运行时路径**，只能在 Electron 里真起一次（E1/B2）。 |
| **首屏不闪** | 「闪」是时序现象，静态查不出。能做的是：把 `color-scheme` 内联进 `<head>`、让窗口底色跟随系统 —— 然后靠人眼/录屏复核。 |

---

## 4. 等内核（本轮明确不查，不假装在跑）

| # | 断言 | 为什么本轮不做 |
|---|---|---|
| 1 | 不得绕过 `DbClient`；不得写 SQL | 仓里根本没有 DbClient / 驱动 / SQL。静态扫 SQL 关键词只能扫到 `core.editor/insert-block` 这类英文命令名 ⇒ 假阳性工厂。内核落地后改成「新增 import 只允许 `db/client.ts`」＋真正的 SQL 扫描。 |
| 5 | 授权/审计不入 KB 表；绑定入 KB | 这是**表结构**事实（哪张表放什么），现在没有表。 |
| 6 | ID 同型（32-hex UUIDv7） | 运行时/单测口径；静态只能证明 `uuidv7Hex()` 在，证明不了每个落库 id 同型。 |
| 7 | 三寄存器存在、无单一 `hlc` 列 | 寄存器是 migration 里的事实，现在没有库、没有 migration。 |
| 8 | 写事务必产 op-log 批 | 现在**正文改动已经产 op**（`tx.patch` 报 `block.upsert{content}`），但**整份替换不产**（撤销/重做、换库、冷启动物化今日）⇒ append-only 日志里那一段是空洞。接的判据是「所有让库变化的路径都产 op」；`tests/op-log-timing.test.ts` 把「还没接」钉成负向断言。 |
| 9 | 未 `expose` 的命令不出现在 HTTP／MCP／CLI 面 | 三个面都还没起，没有可断言的对象。 |
| 10 | 派生索引可全量重建且与增量逐字节一致 | 派生索引（FTS 等）还没建；这条本质是**集成测试**，不是静态检查。 |

---

## 5. 本轮发现的新问题（宁多勿少）

1. **命令越界碰 DOM（真违规，未修）**：~~`src/app/handlers.ts` 的 `core.page/rename` 处理器直接碰 DOM~~ —— 已修：处理器现在只调
   `app.focusTitle()`（装配层实现），并由 `[18]` 静态守住「handler 不得出现 `document`/`window`」。
2. **`view.ts` 的 `LINE_H = 30` 与 CSS 的 `--line-h`（28/30，随皮肤变）不是同一个数**：虚拟化占位
   高度是按 30px × 行数算的，乙皮肤真实行高 24px ⇒ 占位与真实滚动高度有偏差。既有近似，
   本轮没动（它参与布局计算，token 化会动行为）。记在这里。
3. ~~**缩略图配色不随主题/皮肤走**~~ —— 已消解：行内图现在是资产库里的**真实字节**
   （`blob:` URL），颜色由图片自己决定，与主题无关；程序生成的渐变图已删除。
4. **`check:electron` 与 `dist-electron/` 的时序坑**：本轮改了 Electron 菜单文案，如果不
   `pnpm build:electron`，E3 会拿**旧** `main.cjs` 过（假绿）。已在 `gate` 里补上
   `build:electron`，并在 §0 写死；但单独跑 `check:electron` 仍然有这个坑。
5. **Electron 里测不出「跟随系统」**：当前环境 `nativeTheme.themeSource='dark'` 后，连新建的
   `about:blank` 窗口的 `prefers-color-scheme` 都不变（E8 的证据）。所以真跟随的证据放在
   **真 Chrome** 的 smoke T11；Electron 侧要真机复核（这条限制 E8 自己也打印）。
6. **`body[data-theme]` 的语义变了**：它现在记的是**档位**（`system|light|dark`），不是解析后的
   亮暗。任何依赖 `data-theme='dark'` 的样式/脚本，在「跟随系统 + 系统是暗」时不会命中。
   本轮把唯一一处（`.atom:hover` 的增亮）改成 token `--atom-hover`；以后别再拿 `data-theme` 当
   「当前是暗色」用 —— 要解析值请用 `window.__qua.resolvedTheme()`。
7. **设备状态全部拆到 `qua.device`**（2026-10-24）：`prefs` 搬出 `Workspace`（库版本 15），
   随后 `folded` 也搬过去（库版本 16）。`qua.device` 与库是两个键、两个写队列；
   拆键不做迁移（原型期旧库作废、重新 seed）。换库时 `folded` 清空：块 id 是库内的局部身份。
8. **`sample()` 从 `core.ts` 搬到了 `seed.ts`**（零引用夹具，为了「中文只许出现在字典/种子」
   这条白名单不是假话）。`core.ts` 的导出面因此少了一个符号 —— 全仓零引用，已核对。
9. **`index.html` 空壳化的代价**：`<title>`、`#badge` 的静态 `title`、`#page-title` 的
   `placeholder` 都变成启动时灌入。JS 起来之前那一小段窗口里没有 tooltip/占位文案
   （视觉上只是空着，不影响使用）；将来若要做静态截图/SSR 需要重新考虑。
10. **字典里有 3 条「假数据」文案**（`ui.arg.*` / `ui.sample.asset*Name`）：严格说它们该进
    `seed.ts`，本轮为了不动 `commands.ts` 的 import 图先留在字典里。下次清理时一起挪。
11. **门禁的重复跑已经收掉了**：`gate:web` 以前先跑一遍 `build`、紧接着 `check` 里的 `build:test`
    又把它覆盖掉（白跑一次构建）；`typecheck:electron` 也跑两遍。现在 gate 是 `scripts/gate.mjs`
    编排出来的——构建只在 ② 跑一次，③ 直接用那份产物。
    `pnpm check` 仍然是自洽的（自己 `build:test` 再跑冒烟），所以**单独跑它**不受影响。
    想再省就 `pnpm gate:fast`；别再往编排脚本里塞第二条 `&&` 链。
12. **`checks/electron-smoke.mjs` E8 的叙述已改**（原来写「不跟随系统」，现在写「档位不变色、
    颜色交给 CSS」）；断言本身一个字没动。E8 的标题也改了 —— 断言集合与数量仍是 10 条。

---

## 6. 「逐字保留」是怎么核的（一次性脚本，不入库）

改了 12 个源文件之后，用 `git show HEAD:<file>` 取改动前版本，AST 抽出**所有含中文的字符串/模板片段**，
再要求每一个片段都能在「现仓库的合法文案池」（`msg.ts` 的值 + 现存的字面量 + `index.html`）里
**原样**找到：

```
HEAD 中文片段 330；原样在现仓库里找到 329；找不到 1
  MISSING electron/main.ts:260 "2s 兜底"     ← 故意改成 ASCII 的开发者日志标签
HEAD index.html 中文片段 9；找不到 1
  "点击查看上下文键与最近按键命中"            ← 它本来就会被 updateBadge() 覆盖，静态占位没有存在意义
```

也就是说：**用户可见文案 0 处措辞改动**；唯一的一处字符串变化是 console 日志标签（§2 `[11]`）。

---

## 7. 维护姿势

- 加一条断言：在 `scripts/arch-check.mjs` 里 `add({...})`，**必须**写清 `method / scope / whitelist`，
  并且 `hits` 是算出来的、不是常量 0。
- 想开白名单：先在本文对应小节写**为什么**（一句「不好查」不算），再动脚本。
- 断言红了的正确反应是**看命中列表**，不是把 `expect` 调大。
- 等内核的 6 条落地时，把 `KERNEL_TODO` 里对应项删掉、换成真断言，并在本文 §4 划掉。
