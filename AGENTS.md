# AGENTS.md —— 动手前必须知道的工程纪律

> **本文件只放「不知道就会做错」的东西。**
> 产品定位、快速开始、交互一览在 [`README.md`](README.md)；
> 分支与 PR 流程在 [`CONTRIBUTING.md`](CONTRIBUTING.md)；
> 模型层的地基（三条判据）在 [`docs/模型-一切皆块.md`](docs/模型-一切皆块.md)；
> Electron 壳的坑在 [`docs/ELECTRON-备忘.md`](docs/ELECTRON-备忘.md)。

---

## 0 这是什么

**「相 / Qua」的桌面应用**——块级大纲笔记，Electron 壳，主进程不含业务逻辑。

- 显示名「相」，英文名 Qua，`bundleId = net.leay.qua`。
- 仍是**原型**：不接 SQLite／内核进程、允许硬编码假数据。
  唯一不许退化的两样：**输入面形状**（块树 ＋ 带 `blockId` 的区间锚点）与**命令/绑定/上下文键三张表**。
- 数据落 `localStorage`（键 `qua.workspace`），**不做旧数据迁移**（`WORKSPACE_VERSION` 加一即作废旧库）。

---

## 1 铁律（违反就做错，不是风格问题）

### 1.1 模型：库里只有一个东西——块

| 不是实体 | 它是什么 |
|---|---|
| 页 | 带 `page` **角色**的块；页名 = 该块的正文 `text`，图标 = `props._icon` |
| 日记 | 带 `_date` 的块（身份由数据推出，不存角色值）；**只读**，全局一天一个 |
| 标签 | 一条**指向边** ＋ 一次 schema 引用 |
| 视图 | 对真实树的一次**渲染** |
| 侧栏/面板 | 一个槽，里面是**一列块** |

- **`workspace.blocks` 是一片森林**；没有 `Page` 实体，没有 `pages` 数组。**不要造回来。**

### 1.2 「是不是某种东西」用**角色**，「有什么数据」用**属性**

- 角色只有两个：`page`／`tag`，载体是属性袋里的 **`props._roles`**
- 其余身份**由数据推出**：有 `_date` 是日记、有 `_kind` 是字段定义、`_query` 是合法条件是查询视图。
  别再为它们加角色值——那是同一件事的第二份答案，而两份能不一致
- **可兼位**（一个块可同时是标签、又是页）；**顺序无语义**；判定与读写只走
  `hasRole`／`rolesOf`／`identityTags`／`addRole`／`removeRole`，问「这一行有没有身份」用 `hasIdentity`
  （裸读 `.role`／`.roles` 会被 `arch-check [21]` 拦）
- 属性（`props`）：系统属性 **`_` 开头**（`_type`／`_icon`／`_date`／`_roles`…）
- ⇒ **块上没有 `role`／`roles` 字段。`props.role` 也是错的。**
- 角色住属性袋不是「角色是普通属性」：它没有定义块、由模型代码解释、不进属性面板；
  放在那里的收益是**整块拷贝只需浅拷 `props`**，复制页/标签不会再漏搬身份。

### 1.3 数据层只回答「是什么」；「怎么显示」归**查询**或**视图配置**

- 不要给块加「要不要进搜索／要不要给 AI 看」这类字段——**用查询条件表达**
- 视图状态（滚动／折叠／宽度）外挂，**不入库**

### 1.4 交付层：槽里只有块

- ❌ 页面列表组件、页面容器、"我的库"导航、入口条
- ✅ `renderBlock(block, ctx)` **外观按类型、chrome 按角色**，槽只负责排一列
- **堆叠归槽，tab 归块**——不要在槽层再加 tab

### 1.5 分层（`arch-check [13]` 硬约束，按目录判层）

```
core ← view ← ui ← app ← host
```

- `core` 零 DOM；**`view` 不得 import `ui`**（`block-dom.ts` 是编辑器 DOM 契约的产地）
- `main.ts`（host 装配）只做 wiring，不塞业务逻辑
- 新增文件自动落入所在层，**没有需要手工登记的第二张表**

### 1.6 命令 handler 不得碰 DOM（`arch-check [18]`）

命令实现（`src/core/commands/*`、`src/app/commands-impl.ts`）**不得操作 `document`／`window`**——
要焦点、滚动、剪贴板，走 `App` 门面（`src/app/`），由 host 落地。
判据：命令最终落到内存文档的 `tx()`，不知道 UI 长什么样。

### 1.7 用户可见文案一律走字典（`arch-check [11]`）

- 所有用户能看到的字符串用 `t('id')`（`src/core/msg.ts`），**不写裸中文字面量**。
- 开发者日志（`console.*`、`throw new Error`）用英文，不受此限。
- `src/core/seed.ts` 的假数据、`checks/**`、`scripts/**` 在白名单内。

### 1.8 颜色/间距只用语义 token（`arch-check [19]`）

- 组件（非 token 定义段）只引语义槽 `--ui-*`（`src/styles/tokens.css`）。
- **不得**直接 `var(--c-*)`：主题机制靠「主题只填 `--ui-*`」生效，直连基础色会让它改不动。
- 唯一合法例外是 `tokens.css` 里 `/* @token:begin */ … /* @token:end */` 段。
- 运行时确实要写长度值（拖拽宽度、动态 inline style）时用 `CSS.px(n).toString()`；
  TS 字符串里拼 `'px'` 会被 `arch-check [12]` 拦下。

### 1.9 组件自持 DOM

组件在构造时取自己的元素并收起来；`main.ts` 里不该出现 `getElementById` 式全局查找。

### 1.10 换主题不改 DOM 形状

样式只改 token 与少量结构规则，**不改 DOM 形状**。冒烟里有一条断言专门钉：
换肤前后 `data-depth` / `data-block-id` / 角色属性序列必须一模一样。

### 1.11 不做数据迁移

`qua/` 是原型，**没有兼容负担**。改模型或落盘口径就直接改：`WORKSPACE_VERSION` 加一，
旧库显式作废、重新 seed。**不写映射/兼容分支**（例：`_icon` 从 emoji 改成 `lucide:<name>` 就是这么办的）。

---

## 2 命令

> **node 必须是 26.x**（`.node-version` 钉住；旧版会让 rollup 原生模块 dlopen 失败）。

```bash
pnpm gate           # ★ 唯一门禁：typecheck + test:core + build + build:electron + arch + check + dock + electron
pnpm dev            # vite + electron 一起起（src/** 热更新；electron/*.ts 改动要重跑）
pnpm dev:web        # 只起 vite → http://127.0.0.1:5180/
pnpm arch:check     # 只跑架构静态断言（秒级）
pnpm test:core      # 只跑纯 core 单测
pnpm check          # 浏览器级冒烟（真 Chrome、真按键、真鼠标）
pnpm check:dock     # 槽与排版形状的布局断言（真量尺寸）
pnpm check:electron # 真 Electron 冒烟
pnpm shots          # 截图 ⇒ shots/
pnpm build:mac      # 打包 .app
pnpm gate:bundle    # gate ＋ 打包产物冒烟（慢，单列）
```

**改完必须 `pnpm gate` 全绿才能算收工。**

- `build:electron` 是门禁必需的一环——少它 `check:electron` 会拿旧 `main.cjs` **假绿**（真踩过）。
- `pnpm check` 覆盖：敲字 / Enter 拆块 / Backspace 合并 / Tab 缩进 / 区间格式 /
  锚点粘性映射 / 行内原子 / 折叠 / 拖拽重排 / 命令面板无绑定执行 / 块菜单与斜杠菜单 /
  落盘重开 / 主题只换 token / 三个降级形态不溢出 / 虚拟化 / IME 组合守卫 / 块选区。
- `pnpm check:electron` 的证据原文落在 `.cache/etest/electron-smoke.log`（每次跑覆盖）。

### 已知的偶发失败

冒烟里少数用例依赖时序（IME 组合、窗口焦点）。**判据：挂了先原样重跑一次**，第二次还挂才当回归查。
不要静默重跑、也不要把结论写成「全绿」。

---

## 3 代码纪律速查

| 想做 | 要 | 不要 |
|---|---|---|
| 加用户可见字符串 | `t('新id')` ＋ 在 `src/core/msg.ts` 加字典项 | 裸中文写在 `.ts` 里 |
| 加颜色/间距 | 用 `--ui-*` token | `var(--c-*)`、写死 `#xxx`/`rgb()`（token 段外） |
| 加键位 | 加到 `src/core/bindings.ts`（**数据**） | 写 `if (e.key === …)` 硬分支 |
| 加命令 | `commands/decls.ts` 声明 ＋ `capability`/`undoable` | handler 里直接改 UI 状态 |
| 命令要碰 DOM | 走 `App` 门面 | handler 里 `document.xxx` |
| `view` 想用 UI 组件 | 从 `ui` 层拿，不反向 import | `view` import `ui` |
| 全局状态/选区 | 进 `core`（模型持有选区） | 散在 `view` 的局部变量 |
| 改落盘口径 | `WORKSPACE_VERSION` 加一、旧库作废 | 写迁移/兼容分支 |
| 想走一遍块树 | 用 `src/core/walk.ts` 的 `walkForest`（先序，带 `path`／`hidden`，返回 `false` 即停） | 自己写递归走 `children`（`arch-check [22]` 会拦） |
| 注释 | 写**为什么** | 写「改了什么」或挂一个本仓没有的编号 |
| 提交信息 | 同注释边界（也是公开历史） | 写「为什么」、不挂读者打不开的引用 |

---

## 4 文档纪律

- **设计判据**在 `docs/模型-一切皆块.md`；**架构断言的逐条账**在 `docs/ARCH-断言.md`；
  **壳的坑**在 `docs/ELECTRON-备忘.md`。代码注释只解释**为什么**，不复述这三份。
- **被推翻的想法要留痕**（当时想怎么做、被什么推翻），删除代码不等于没发生过。
- **宁可标「未验证」，不要含糊。** 结论区分「实测」「看源码得出」「还没验证」。
- 断言写在**测试名**里：失败时那句话应该就是读者需要的全部上下文。

---

## 5 更深的东西

- [`README.md`](README.md) —— 定位、快速开始、交互一览、能做什么/还不做什么。
- [`CONTRIBUTING.md`](CONTRIBUTING.md) —— 分支、提交、PR、门禁逐项说明。
- [`docs/模型-一切皆块.md`](docs/模型-一切皆块.md) —— 三条判据、交付层形状、已否决清单。
- [`docs/ARCH-断言.md`](docs/ARCH-断言.md) —— 哪些规则真在跑、哪些只能靠约定、哪些等内核。
- [`docs/ELECTRON-备忘.md`](docs/ELECTRON-备忘.md) —— 桌面壳的坑、与 Chrome 的行为差异、真机实测。
