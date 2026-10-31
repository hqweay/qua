/**
 * 端口声明（**只有类型，零运行时代码**）。
 *
 * 为什么单独一个文件：`App` 是「命令 ↔ 装配层」之间的**唯一契约**，但它原先住在 `commands.ts` 里，
 * 于是 `commands.ts` 必须 `import type { BlockEditor } from '../view/editor.ts'` —— 一条 **core → view** 的
 * 层级反向边，只能靠 `arch-check [13]` 的白名单放行。
 *
 * 把契约提到这里之后：
 *   · `commands.ts` 只依赖本文件（core 层）
 *   · `main.ts`（装配层）实现它
 *   · **那条白名单可以删掉**，层级断言回到「不设例外」
 *
 * 本体能用什么，命令就能用什么；命令**只经这里**改状态。
 * 命令不知道 UI ——这里不许出现任何 DOM 类型（`HTMLElement`／`KeyboardEvent` …）；
 * 唯一放行的是 `DOMRect`，因为「菜单挂在哪个矩形旁边」是**命令参数的形状**，不是 DOM 操作。
 */
import type { BlockEditor } from '../view/editor.ts'
import type { BindingKind } from './bindings.ts'
import type { CtxKeys } from './index.ts'
import type { QuerySpec } from './query.ts'
import type { ChoiceScope } from './props.ts'
import type { SecLayout } from './feed.ts'
import type { MountHost } from './mount.ts'
import type { ViewConfig, DerivedViewKind } from './view.ts'
import type { ViewOwnerRef } from './view-owner.ts'

export type Capability = 'read' | 'write' | 'admin' | 'plugin'
export type FixtureName = 'seed' | 'empty' | 'sparse' | 'degraded' | 'boot'
export type PanelKind = 'context' | 'bindings' | 'shortcuts' | 'model'

/**
 * **一条属性挂到块上的两种去处**（不是「按块类型推断」，是调用方声明）。
 *
 *   · `own`      —— 写进这一块自己的值槽（`props._ownProps`）：**我**有这条属性；
 *   · `declared` —— 写进这一块的成员声明清单（`props._fieldDefs`）：**我的成员**有这一格。
 *
 * ⚠️ 为什么必须显式：页/标签**两个都要**（它既可以是成员、又有成员），
 *    用「有没有 page/tag 露面」去猜会让标签块永远加不了自己的属性（真踩过）。
 */
export type PropTarget = 'own' | 'declared'

/**
 * 新建属性时对「已有同名同 kind 的定义」怎么办。
 *
 * · `reuse`（缺省）——复用那条定义（误复用可以无损改回，误分槽要迁数据）；
 * · `new`——跳过同名检查，新建**第二个 `propId`**（同名不同义是合法的：
 *   身份是 id，不是名字）。
 *
 * kind 不同时永远不复用：类型住在定义块上、全库一份，复用等于把别人的类型改掉。
 */
export type PropCreateMode = 'reuse' | 'new'

/** 命令声明（纯语义）：**没有 `key`／`context`／`host`**——落点归绑定表 */
export interface CommandDecl {
  /** 命名空间名（`core/*` 保留给系统命令） */
  name: string
  /** 人话标签（菜单 / 命令面板默认显示名） */
  title: string
  capability: Capability
  undoable: boolean
  version: string
  /** 命令面板里的分组（纯展示） */
  category: string
  /** 搜索别名（让「加粗 / bold」都能搜到） */
  keywords?: string[]
  /** `args` 的单一来源（最小 JSONSchema 形状） */
  args?: Record<string, unknown>
  /** 不进命令面板（编辑器内部键位） */
  hidden?: boolean
  /**
   * 这个命令可以作为一个「小卡」摆在槽里。
   *
   * 只有带它的命令才进「添加快捷」画廊——这是一份**策展过的**集合，
   * 不是「所有命令」。危险命令（删页/删块）和依赖光标的命令（加粗/缩进）
   * 不写它，就不会被摆成一个一键入口。
   *
   * 图标是宿主的词汇（`lucide:<name>`），插件不能自带 path：未知名字由
   * `view/icons.ts` 降级成占位，不会静默消失。
   */
  tile?: { icon: string }
  expose?: { http?: { description: string }; cli?: { aliases: string[] } }
}

/** 菜单行（结构上与 `ui/layers.ts` 的 `Row` 一致；这里只声明命令侧需要的字段） */
export interface MenuRow {
  id: string
  label: string
  hint?: string
  icon?: string
  group?: string
  command?: string
  args?: unknown
  keyHint?: string
  disabled?: boolean
}

export interface MenuRequest {
  kind: BindingKind
  anchor: DOMRect | null
  title?: string
  prefix?: string
  query?: string
  ctx?: CtxKeys
  /** 每一项点击前先跑（例如斜杠菜单要先抹掉 `/查询词`） */
  before?: () => void
  /** 覆盖默认行为（演示状态菜单等） */
  onPick?: (row: MenuRow, decl: CommandDecl | undefined) => void
  /** 关掉时回调（斜杠菜单用来复位内部状态） */
  onClose?: () => void
}

/** 命令处理器拿到的「受管门面」 */
export interface App {
  ed: BlockEditor
  /* 页面 */
  listPages(): { id: string; title: string; icon: string; blocks: number }[]
  activePageId(): string
  newPage(): void
  openPage(id: string): void
  deletePage(id: string): void
  renamePage(id: string, title: string): void
  /** 把焦点交给页名（**UI 归装配层**：命令只说「要改名」，不碰 `document` — 59 ） */
  focusTitle(): void
  showRefPicker(): void
  /** 选一个块作为露面的源（锚在 `at` 那一行上）；插入位置也在 `at` 后面 */
  showEmbedPicker(at: string): void
  /** 读剪贴板文本（粘贴为… 用；命令层不直接碰浏览器全局） */
  readText(): Promise<string>
  /**
   * **露面块的结构动作**：落在**中心编辑器**上，而不是「此刻焦点所在的那一台」。
   *
   * 为什么：焦点可能在一面镜像的岛里（它的装载只有源那一棵），而要被改的露面块
   * 在正文里。用活动编辑器会「找不到 ⇒ 什么都没发生」，且不报错。
   */
  insertEmbed(at: string, targetId: string, view: 'mirror' | 'table'): string | null
  expandAtomToEmbed(atomId: string, view: 'mirror' | 'table'): string | null
  removeEmbed(blockId: string): boolean
  /**
   * **用系统浏览器打开一个外链**（`core.link/open` 的落点）。
   *
   * 为什么「打开」要成为门面上的一个方法：命令 handler **不许碰 `window`**
   * （`arch-check [18]`：命令面也是机器接口，HTTP／CLI 会走到它），
   * 而打开外部地址这件事只有宿主做得到。
   *
   * 协议白名单（`http:`／`https:`）由 `core/link.ts` 的 `checkExternalUrl` 判——
   * 调用方可以先自己判一遍以便给用户一句人话，但**判据只有那一份**。
   *
   * @returns 真的把请求发出去了才 `true`（空串／写得不完整／协议不在白名单 ⇒ `false`）
   */
  openExternal(url: string): boolean
  /**
   * **打开插入外链的输入框**（`core.editor/insert-link` 不带 `url` 时的那条路）。
   *
   * 与「选图片」同一条理由：这一步要向用户**要一句话**（URL 与显示名），
   * 而命令 handler 不许碰 DOM ⇒ 浮层归装配层。
   */
  showLinkComposer(): void
  /**
   * **选一张图片并插到当前光标处**（`core.editor/insert-image` 的入口）。
   *
   * 为什么落点在门面而不是命令 handler：入库是**异步**的（算 hash、写字节、读尺寸），
   * 而命令 handler 是同步返回 `handled` 的。真正要做的是：
   * 捕获落点 → 等字节落库 → 按捕获点插 run。这段时序只有装配层管得了。
   *
   * 失败（拒绝的类型／超限／解码失败／块被删）都给用户一句明确文案，不静默。
   */
  pickImage(): void
  /**
   * 把一份字节入库并按**捕获到的落点**插一枚资产 run。
   *
   * `point` 是用户按下那一刻的光标位置：入库期间光标会动、块甚至会被删，
   * 所以不能「插到当前光标」——那会把图插到用户后来移到的地方。
   * 省略 `point` ⇒ 现取当前光标（粘贴路径在事件里已经先捕获，正常都会传）。
   *
   * @returns 真的插入了才 `true`；块没了／越界／字节不合法 ⇒ `false`（一个字节都不写）
   */
  insertAssetBlob(blob: Blob, label: string, point?: { blockId: string; offset: number }): Promise<boolean>
  /**
   * **打标签**＝给当前块加一格分类（`props._tags`；`ensureTag` 找不到标签块就先建）。
   *
   * ⚠️ 为什么整个动作要一门面方法、而不是 handler 里「建块 ＋ 写属性」两步：
   *    「找到或创建标签块」要**写森林**，而森林由装配层持有；handler 拿它不到。
   *    拆成两步又会让「建了标签但没写上归属」这种半截状态成为可能。
   */
  insertTag(tag: string): void
  /* 属性（属性是块第一公民；值在块上 `props[propId]`，一块一槽） */
  setPropValue(blockId: string, propId: string, value: unknown): void
  clearPropValue(blockId: string, propId: string): void
  /**
   * 新建字段定义，并按 `target` 挂到该块上；返回 `propId`（空串＝没建）。
   *
   * `target` 必填、不许猜：写自己的值槽与写「成员的声明清单」是**两件事**，
   * 用「这个块有没有 page/tag 露面」去推断会让页/标签永远走不到「给自己加一条」。
   */
  createPropDef(
    blockId: string,
    label: string,
    kind: string,
    target: PropTarget,
    mode?: PropCreateMode,
  ): string
  /**
   * 把已有定义挂到块上：`own` ＝ 这一块自己的值槽，`declared` ＝ 声明给成员。
   *
   * ⚠️ 两个目标写的是两个不同的槽（`_ownProps` / `_fieldDefs`），不共用一条写路径。
   */
  addProp(blockId: string, propId: string, target: PropTarget): void
  /** 解除声明（**定义块与成员块上的值都不动**） */
  undeclareProp(blockId: string, propId: string): void
  /* 选项（`select`）：选项＝定义块的直接子块，值＝选项块 id */
  /** 给定义加一个选项；返回新选项块的 id（空串＝没写）。`scope` 缺省全局 */
  addChoice(defId: string, label: string, scope?: ChoiceScope): string
  /** 改选项名（**零值迁移**：值存的是 id） */
  setChoiceLabel(choiceId: string, label: string): void
  /** 重排选项：把它移到 `beforeId` 之前（空串＝末尾） */
  moveChoice(defId: string, choiceId: string, beforeId: string): void
  /** 写选项的可见范围（三态；形状不认识则不写） */
  setChoiceScope(choiceId: string, scope: ChoiceScope): void
  /** 删一个选项（**普通软删**：值保留，恢复后自动解析回来） */
  deleteChoice(choiceId: string): void
  /* 归属边（属于／包含；一条边存在子块的 `_belongsTo`，任何块都能配） */
  addBelongsTo(childId: string, parentId: string): boolean
  removeBelongsTo(childId: string, parentId: string): void
  /** 清理失效归属（上级**真的没了**；在回收站里的不清——复活要自愈） */
  pruneBelongs(childId: string): void
  /** 打开标签选择器（显示层级；选中＝在当前块插一条 tag 边） */
  showTagPicker(): void
  /**
   * 「移动到…」：弹目标选择器（页 ＋ 标签块）。
   *
   * 与 `insert-page-ref` 共用同一个选择器组件，只是选中之后做的是**搬块**。
   * ⚠️ 目标集合按**身份**找（页/标签），不按位置——位置不是「可不可搬进去」的判据。
   */
  showMovePicker(blockId: string): void
  /**
   * 把一块（连子树）搬到目标容器末尾。自环/原地不动由命令层先判并给提示，
   * 这条只管「搬」——一条事务一条 op。
   */
  moveBlockTo(blockId: string, targetId: string): void
  /* 露面：加/减一格标记（非破坏性；页/标签各自独立、可兼位） */
  addBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  /**
   * **提取为页**：补 `page` 露面 ＋ 搬到森林顶层 ＋ 原位置留一枚引用。
   *
   * 与 `addBlockRole(...,'page')` 的区别只在位置：那条原地不动，这条显式搬家。
   * 一次事务一条撤销；原块 id 不变，引用不受影响。
   */
  extractToPage(blockId: string): boolean
  /** 打开别名编辑器（名字、露面、显示模式）——纯 UI，落在装配层 */
  openAliasEditor(blockId: string, autofocus?: boolean): void
  /** 打开字段声明（页/标签能声明哪些属性）——纯 UI，落在装配层 */
  openFieldsEditor(blockId: string): void
  /* 挂载区（块底面板）：写哪一格由 `MountHost` 判，命令层不自己判「是不是日记」 */
  /**
   * 加一栏 **local tab**：这一栏自己拥有条件与视图。**不建块**（块数一个都不变）。
   *
   * 默认路径就是它：随手加一栏不该在树里多一个对象，也没有「删块 tab 怎么办」。
   * @returns 新栏的稳定 id（写不进去 ⇒ `''`）
   */
  /**
   * 加一栏 **local tab**。
   *
   * `emptyView` 只在「没给任何视图」时决定是否补一张默认表格：
   * 新建栏补（否则条件/范围芯片没有落点），把一次现有看法固定下来时不补
   * （用户选的就是大纲，补一张表等于替他换了个看法）。
   */
  addLocalTab(
    host: MountHost,
    label: string,
    spec: QuerySpec,
    views?: ViewConfig[],
    activeView?: string,
    emptyView?: 'table' | 'none',
  ): string
  /** 加一栏 **linked tab**：只存「指向哪一块 ＋ 哪张视图」，配置仍住在目标块上 */
  addLinkedTab(host: MountHost, blockId: string, view?: string, label?: string): string
  /** 摘一栏（`tabId` 是稳定 id，不是数组下标）。**不删任何块** */
  removeMountTab(host: MountHost, tabId: string): boolean
  /** 改栏名（local 的名字；linked 的覆盖文案） */
  renameMountTab(host: MountHost, tabId: string, label: string): boolean
  /** 换这一栏选的视图（local 写自己的默认视图；linked 只改指针） */
  setMountTabView(host: MountHost, tabId: string, view: string): boolean
  /**
   * **提升**（local → 块）：复制条件与视图到一个新的查询页/查询块，
   * 默认把这一栏改成指向它的 linked。复制之后是两个独立对象。
   */
  promoteMountTab(host: MountHost, tabId: string, target: 'page' | 'block', parentId?: string, link?: boolean): string
  /**
   * **转本地副本**（linked → local）。只有目标源是 **query** 时才成立：
   * local tab 是「面板局部的一次查询」，children/items 的视图没有这个对应物。
   */
  detachMountTab(host: MountHost, tabId: string): boolean
  /** **固定派生栏**（引用/同类/提及 → local）：把现算的条件变成一栏可编辑的查询 */
  fixDerivedTab(host: MountHost, source: 'refs' | 'same' | 'mentions', view?: DerivedViewKind): string
  /**
   * 写块的类型（`_type`）。
   *
   * ⚠️ 类型 id **不由这里校验**：不认识的值照写，降级是读侧的事 ——
   *    否则插件或更新版本写的类型会在这一层被抹掉。
   */
  setBlockType(blockId: string, typeId: string): boolean
  /**
   * 删一个行内原子（引用 / 标签）。
   *
   * ⚠️ 摘标签可能触发「要不要清理它带来的值」的提示 —— 所以删除入口在门面，
   *    不是组件直接调编辑器（编辑器不知道属性与提示）。
   */
  removeAtom(atomId: string): void
  /* 日记（日期只读、一天一个、物化幂等） */
  /** 回到今日（`date` 省略＝本地今天）；没有就**幂等物化**一个 */
  journalToday(date?: string): void
  /** 相对当前日期前后翻（`days` 可正可负）；同样幂等物化 */
  journalShift(days: number): void
  /**
   * 复盘＝**带参的日记流**（同一个装载路径换 `days`／排列），不是并列的第二种视图。
   * 窗口里没写过的天渲染空壳格子，落笔才物化。
   */
  journalReview(days: number): void
  /** 在复盘的空天格子里落笔：物化那一天、按同一参数重开、光标落进那一天 */
  journalShellWrite(date: string): void
  /** 设定日记流的段排列（设备偏好；复盘的排列切换入口将来接这里） */
  journalFeedLayout(layout: SecLayout): void
  /* zoom（块可任意 zoom in；zoom 是视图配置，不是新对象） */
  /**
   * 聚焦到此块：中心槽以 `source=block-ref` ＋ `scope:"subtree"` 渲染它。
   *
   * `feed` 只由历史回放使用：还原「当时看的是日记流」这一形态；
   * 普通聚焦永远只装目标块自己。
   */
  zoomTo(id: string, feed?: boolean): void
  /** 退回该容器所在的顶层块（面包屑的「根」） */
  zoomOut(): void
  /**
   * **看这一块的属性**：把中心槽的当前对象换成它，并确保右槽开着。
   *
   * 它与 `zoomTo` 的区别只有一条，但正是要紧的那条：它是**显式视图命令**，
   * 所以**可以**动侧槽开关；而 zoom / 打开页 / 点链接是**导航**，永远不替用户
   * 改侧栏的开合（关掉右槽是一次明确表态，导航不该把它推翻）。
   */
  inspectBlock(id: string): void
  /**
   * **导航历史**：中心槽「当前对象」的先后（不是 undo/redo 的模型快照栈）。
   *
   * 链接点击、页/日记打开、zoom、面包屑都会记一条；左右槽显式钉住、不跟随导航。
   * 历史里指向的块可能已被删除 ⇒ 跳过继续找，不把用户卡在一个不存在的落点。
   */
  historyBack(): boolean
  historyForward(): boolean
  /* 视图 */
  /** 三档直选（菜单用；`toggleTheme` 是给键位/常驻按钮的循环） */
  setTheme(mode: string): void
  toggleTheme(): void
  /** 开/关一个槽（槽的开关归槽自己；`side` 只有左右，中心槽常驻） */
  toggleDock(side: 'left' | 'right'): void
  /**
   * **在侧槽打开一个块**（一张窗口）：确保槽开着、把块放进 `cards`、滚到它。
   *
   * 与 `inspectBlock` 的区别：那个换中心落点、这次**不换**中心也不入历史；
   * 与 `zoomTo` 的区别：zoom 是导航，这个是视图配置。
   * 同一个块全局最多一个窗口（已在另一侧则移过来）。
   */
  openInDock(id: string, side?: 'left' | 'right'): void
  /**
   * **把一个块已打开的窗口置顶**（移到它那一槽窗口组的最前，并滚到它）。
   *
   * 置顶是动作不是状态：位置住 `cards` 的序，常驻（pin）是另一位。目标没开着的窗口 ⇒ false。
   */
  topWindow(id: string): boolean
  /* 视图配置（`_views` / `_activeView`；视图不是实体，配置住在**拥有者**上） */
  /**
   * 新建一个视图并设为激活，返回它的 id（空串＝没建）。
   *
   * 表格的列在这里算**一次**并写进配置：算完就不随结果漂移（否则列宽/列序会自己动）。
   * `owner` 可以是块，也可以是 local tab —— 「配置住哪」由拥有者回答。
   */
  addView(owner: ViewOwnerRef, kind: string): string
  /** 切换激活视图（`''` ＝ 这一份源的默认看法，删掉 `_activeView` 而不是存一个 outline） */
  setActiveView(owner: ViewOwnerRef, viewId: string): boolean
  /** 删一个视图：只动配置，记录一个字节不碰；删的是激活那个就去相邻项 */
  removeView(owner: ViewOwnerRef, viewId: string): boolean
  /** 给当前激活的视图改名（空名 ⇒ 回到按类型的默认名） */
  renameActiveView(owner: ViewOwnerRef, name: string): boolean
  /** 新建一行＝在容器末尾插一个子块（查询源没有这一行：它的行是命中） */
  viewInsertRow(owner: ViewOwnerRef, blockId?: string): boolean
  /** 删除一行＝软删那个子块（可恢复） */
  viewDeleteRow(rowId: string): boolean
  /**
   * **表头排序＝显示排序**：只写 `view.table.sort`（或结构映射表的 `listTable.sort`）。
   *
   * ⚠️ 不再写查询的成员顺序（`QuerySpec.sort`）：那是「取哪些、按什么序」，
   *    由构建器编辑。点表头不该换一批行。`dir === ''` ＝ 清掉。
   */
  viewSetSort(owner: ViewOwnerRef, viewId: string, by: string, dir: string): boolean
  /** 「视图…」菜单：列出默认看法 ＋ 已有视图 ＋ 新建…（**纯 UI**，落在装配层） */
  openViewMenu(owner: ViewOwnerRef): void
  /** 打开**条件构建器**（一个浮层；草稿改在本地，点「应用」才写一次） */
  openQueryBuilder(owner: ViewOwnerRef): void
  /**
   * 写**条件**（构建器／JSON 的落点）。
   *
   * ⚠️ 只写条件，不写结果 —— 结果由每个表面实例自己冻结，
   *    条件变了（⇒ `specKey` 变）那一处会自动重算，不会出现「旧条件 ＋ 新结果」。
   */
  setQuerySpec(owner: ViewOwnerRef, spec: QuerySpec): boolean
  /** 新建查询页／页内查询块（内容对象：能被引用、能进回收站） */
  createQuery(kind: 'page' | 'block', name: string, spec: QuerySpec, parentId?: string): string
  /**
   * **在这一块里建一个查询块**（`core.query/insert` 的落点）。
   *
   * 查询块的求值锚点是**它的容器**，所以「查这一块」只能把它建成这一块的**子块**；
   * 这一块容不下子块（叶子／组件块）⇒ 插到它后面，锚点退化成它的父块。
   * 结构写与「留一个可编辑空块做落点」在同一笔事务里 ⇒ 一次撤销。
   */
  insertQueryBlock(blockId?: string): string
  /** 改一次露面选的视图（`core.embed/set-view` 的落点） */
  setEmbedView(blockId: string, view: string): boolean
  /* 集合组件 */
  /** 新建一个集合块（森林顶层），返回它的 id；放进哪个槽由调用方决定 */
  createCollection(name?: string): string
  /** 往集合里加一条引用：块必须存在，且不能是集合自己；重复加入是 no-op */
  addCollectionItem(collectionId: string, blockId: string): boolean
  /** 从集合里摘一条引用：只摘引用，不删块；摘不存在的项返回 false */
  removeCollectionItem(collectionId: string, blockId: string): boolean
  /** 把一条引用移到新位置；`to` 是当前列表里的插入下标（含被拖项） */
  moveCollectionItem(collectionId: string, blockId: string, to: number): boolean
  /**
   * 打开「选一块加进收藏」的选择器（**纯 UI**，落在装配层）。
   *
   * 与 `addCollectionItem` 分开：那个要 blockId，而用户手里还没有 id ——
   * 这一步是「从库里挑一块」，挑完再调 add。
   */
  showCollectionPicker(collectionId: string): void
  /* 浮层 / 提示 */
  toast(text: string, kind?: 'ok' | 'warn' | 'info'): void
  showMenu(req: MenuRequest): void
  showPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null): void
  closeLayers(): void
  showPanel(kind: PanelKind): void
  copy(text: string, label?: string): void
  /* 演示与诊断 */
  loadState(state: FixtureName): void
  /**
   * **备份当前字节并重建本地库**（演示数据）。
   *
   * 这是只读态的出路，不是常规清库入口：实现必须先备份，备份失败就放弃覆盖。
   * 异步在实现里收尾（按钮已经退场，不需要等它）。
   */
  resetWorkspace(): void
  setVirtualize(on: boolean, radius?: number): void
  runImeProbe(): { fired: number; seq: string[] }
}

export type Handler = (args: Record<string, unknown>, app: App) => boolean | void
