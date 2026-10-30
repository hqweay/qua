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
- 仍是**原型**：没有内核进程、允许硬编码假数据。
  唯一不许退化的两样：**输入面形状**（块树 ＋ 带 `blockId` 的区间锚点）与**命令/绑定/上下文键三张表**。
- **桌面版内容真相是每个库目录里的 `qua.db`**：块拆成行（`Block`／`BlockProperty`／`BlockAlias`／
  `BlockList`），一次编辑只写动过的那几块。编码只有一份定义（`src/core/storage/db-rows.ts`），
  主进程只做通用 SQL（不认识块语义）。浏览器端仍是 `localStorage`（键 `qua.workspace`）。
- **不做旧数据迁移**：库的 `DB_SCHEMA_VERSION`／浏览器侧的 `WORKSPACE_VERSION` 加一即作废旧库。

---

## 1 铁律（违反就做错，不是风格问题）

### 1.1 模型：库里只有一个东西——块

| 不是实体 | 它是什么 |
|---|---|
| 页 | `_lists` 里有 `page` 的块；页名 = 主别名（`_aliases[0]`，显示叶子），正文（`content` 的文本投影）是描述，图标 = `props._icon` |
| 日记 | 带 `_date` 的块（身份由数据推出，不存标记）；**只读**，全局一天一个 |
| 标签 | 块上的一格**分类归属**（`props._tags`）；标签本身是 `_lists` 里有 `tag` 的块 |
| 视图 | 对真实树的一次**渲染** |
| 侧栏/面板 | 一个槽，里面是**一列块** |

- **`workspace.blocks` 是一片森林**；没有 `Page` 实体，没有 `pages` 数组。**不要造回来。**

### 1.2 地址与露面是两套语义；身份由数据推出

- **地址**住在 `props._aliases`（0..N，**首个是主名**，全局唯一，允许 `/` 分段、显示叶子）。
  **正文不在地址空间**：正文是描述，改正文不会改名。
- **露面**住在 `props._lists`（`page`／`tag`，可兼位、可空）：页列表与标签列表只按它过滤。
  ⇒「有名字」与「是页/标签」是两件独立的事。
- **这一行显示什么**住在 `props._display`（`alias`／`text`）：只影响这一行自己的头，
  引用／反链永远叫主名叶子。
- 其余身份**由数据推出**：有 `_date` 是日记、有 `_kind` 是属性定义、`_query` 是合法条件是查询视图。
  别再为它们加标记——那是同一件事的第二份答案，而两份能不一致
- **可兼位**（一个块可以既进页列表、又进标签列表）；**顺序无语义**；判定与读写只走
  `hasList`／`listsOf`／`identityTags`／`addList`／`removeList`，问「这一行有没有身份」用 `hasIdentity`
- 属性（`props`）：系统属性 **`_` 开头**（`_type`／`_icon`／`_date`／`_aliases`／`_lists`／`_display`…）
- ⇒ **块上没有 `role`／`roles` 字段；`props._roles` 是旧键，形状校验直接判 corrupt。**
- 地址与露面住属性袋不是「它们是普通属性」：它们没有定义块、由模型代码解释、不进属性面板；
  放在那里的收益是**整块拷贝只需浅拷 `props`**，复制页/标签不会再漏搬身份。

### 1.3 数据层只回答「是什么」；「怎么显示」归**查询**或**视图配置**

- 不要给块加「要不要进搜索／要不要给 AI 看」这类字段——**用查询条件表达**
- 视图状态（滚动／折叠／宽度）**不挂在块上**：折叠态在 `Doc.folded`／`DeviceState.folded`
  （`Record<块 id, true>`，只记收起的），块的字段里只有内容

### 1.4 交付层：槽里只有块

- ❌ 页面列表组件、页面容器、"我的库"导航、入口条
- ✅ `renderBlock(block, ctx)` **外观按类型、chrome 按身份标记（`identityTags`）**，槽只负责排一列
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
换肤前后 `data-depth` / `data-block-id` / `data-role`（`identityTags` 的输出）序列必须一模一样。

### 1.11 不做数据迁移

`qua/` 是原型，**没有兼容负担**。改模型或落盘口径就直接改版本号，旧库显式作废、重新 seed：

- **桌面版**：`DB_SCHEMA_VERSION`（`PRAGMA user_version`，库的唯一 schema 版本）加一，
  `MIGRATIONS` 里加一步**只丢旧形状、不搬数据**的迁移（例：v1 的整份 blob 表 → v2 的四张内容表）；
- **浏览器**：`WORKSPACE_VERSION` 加一。

**不写映射/兼容分支**（例：`_icon` 从 emoji 改成 `lucide:<name>` 就是这么办的）。

---

## 2 命令

> **node 必须是 26.x**（`.node-version` 钉住；旧版会让 rollup 原生模块 dlopen 失败）。

```bash
pnpm gate           # ★ 唯一门禁（全量）：静态 + 单测 + 构建 + 冒烟 + 布局 + 真 Electron
pnpm gate:fast      # 按 git 改动跳到「碰得到的那几支」——日常小改动用它，收工仍要 gate
pnpm gate:web       # 同 gate，但不含 Electron（CI 的 Linux job 用这个）
pnpm gate:fast --plan   # 只打「这次会跑哪些 / 跳过哪些」，不真跑
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

**改完必须 `pnpm gate` 全绿才能算收工**（当前基线：arch **24/24** · test:core **652/652** ·
浏览器冒烟 **192/192** · dock **22/22** · electron **13/13**）。

- **`gate` 是编排出来的，不是一条 `&&` 链**（`scripts/gate.mjs`）：彼此独立的检查按产物依赖分三段、
  段内**并发**，冒烟那些用例**按序切片**成几片同时跑。快的来源是并发，不是少跑——断言一条没动。
- **`gate:fast` 不是收工门禁。** 它按 `git diff` 判面（core／web／electron／文档），跳过碰不到的，
  并且**逐条列出跳过了什么**。判不出的路径一律按全量，所以它只会少跑、不会猜。
  拿不准时看一眼 `pnpm gate:fast --plan`。
- `build:electron` 是门禁必需的一环——少它 `check:electron` 会拿旧 `main.cjs` **假绿**（真踩过）。
- 门禁里的浏览器步骤一律 `QUA_NO_DEV=1`：验的是**构建产物**，不去连 5180 上可能属于
  **另一棵树**的 dev server（并行车道里真踩过）。
- `pnpm check` 覆盖：敲字 / Enter 拆块 / Backspace 合并 / Tab 缩进 / 区间格式 /
  锚点粘性映射 / 行内原子 / 折叠 / 拖拽重排 / 命令面板无绑定执行 / 块菜单与斜杠菜单 /
  落盘重开 / 主题只换 token / 三个降级形态不溢出 / 虚拟化 / IME 组合守卫 / 块选区 /
  空块里敲拼音（T141）/ 挂载区里 ↵ 的落点（T142）。
- `pnpm check:electron` 的证据原文落在 `.cache/etest/electron-smoke.log`（每次跑覆盖）。
- 单跑冒烟时 `QUA_SMOKE_SHARD=i/N` 可只跑第 i 片（分片口径落在 `check()` 里，见 `checks/smoke.mjs`）。


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
| 改落盘口径 | `DB_SCHEMA_VERSION`／`WORKSPACE_VERSION` 加一、旧库作废 | 写搬数据的迁移/兼容分支 |
| 改「一个块长成哪几行」 | 只改 `src/core/storage/db-rows.ts`（编码唯一落点） | 在主进程里写块语义（`[2+]` 会拦，且会有两份定义） |
| 想走一遍块树 | 用 `src/core/walk.ts` 的 `walkForest`（先序，带 `path`／`hidden`，返回 `false` 即停） | 自己写递归走 `children`（`arch-check [22]` 会拦） |
| 想再渲染一列**可编辑**块 | 用 `ui/editable-block.ts` 的 `EditableBlock`：建实例＋订阅＋焦点＋事件表＋重载全在它里面（`load` 给装载动作、`wire` 给**整份** `viewEvents`、`area` 给冻结范围） | 再手抄一份 `new BlockEditor({…})`＋订阅＋防抖；只接一半事件表（漏了不报错：点引用不跳、右键没菜单）；自己再叠一份组件级防抖（两条重载路径会把 `click` 弄丢） |
| 里层编辑器里**打字对、但 ↵／⌘A／Tab 跑偏** | 先查**活动编辑器 `app.ed` 是谁**（验法：⌘A 看选区落在哪个宿主）。打字走**事件层**（各编辑器绑自己的 container），键位走**命令层**（`app.ed`）——两者能各错各的 | 去改事件层。挂载区的 DOM 嵌在 `#editor` 里，`focusin` **会冒泡** ⇒ 正文那条无条件 `ed = mainEd` 会把里层 `onFocus` 刚切好的活动编辑器覆盖回去（真踩过，见 T142） |
| 空块的光标落点 | 落 `.tx` 的**元素 0 位**（`<br>` 之前） | 落到 `<br>` 之后——那儿不是 Chrome 认的稳定组合位，预编辑串插进去时 `<br>` 被摘掉、组合区间失焦 ⇒ 拼音**第一个字母被冻成正文**（打 `nihao` 得 `n你好`，见 T141） |
| 优化一条 `O(整库)` 路径 | 测**「用户按一下」那条完整链路**（`snap` → `tx` → `record`），断言**序列化字节数**在 100 块与 10,000 块的库上**相同** | 只测你刚改的那个函数。实测：修完 `tx` 的整库快照后测出「打字 0.55ms」，而真实按键是 **10.7ms**（另一份快照占了 95%）——那 20 倍在你改的函数**外面**。判据用字节不用耗时：耗时在并发门禁下会抖 |
| 读门面加一个方法 / 发现某个读很慢 | 先问「**索引里有没有现成的表**」。有 ⇒ 走表；没有 ⇒ 补一张，并让**全量与增量两趟**都打它 | 「建了表」≠「用了表」。实测 `resolveAlias` 一直遍历整片森林，而名字表早就建着（只收标签块）：50,000 块时 **1112μs vs 0.6μs**。漏用不报错，只在库变大时显形 |
| 索引里加一张表 | 等式断言（`fingerprint` 含它）**逐条抓三处**：全量/增量两趟、改名时摘表、删块时摘表并按先序重扫接手者 | 漏第三处会让解析返回一个**不在树上**的块 id，而没有任何一层会报错 |
| 改种子内容（`fixtures/seed.ts`） | 先 grep `checks/` 对页名 / 原子 / 任务数的硬依赖；改完跑全量 `gate` | 只跑 `gate:fast`——演示内容也是验收形状（`atoms()` 是库级的；首屏有图会改变 DOM 落定时机） |
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
