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
import type { SecLayout } from './feed.ts'

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
  createPropDef(blockId: string, label: string, kind: string, target: PropTarget): string
  /**
   * 把已有定义挂到块上：`own` ＝ 这一块自己的值槽，`declared` ＝ 声明给成员。
   *
   * ⚠️ 两个目标写的是两个不同的槽（`_ownProps` / `_fieldDefs`），不共用一条写路径。
   */
  addProp(blockId: string, propId: string, target: PropTarget): void
  /** 解除声明（**定义块与成员块上的值都不动**） */
  undeclareProp(blockId: string, propId: string): void
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
  /**
   * **给这一块的挂载区加一栏查询**（写宿主上的 `_mounts`，不建块）。
   *
   * `label` 是这一栏的名字（同一个宿主下必须唯一）。日记宿主写在**共享配置块**上，
   * 没有就当场物化——那是那个内部块唯一的诞生入口。
   * @returns 写进去了才 `true`（过去的日记天、重名、形状不合法都返回 `false`）
   */
  addMountTab(hostId: string, label: string, spec: QuerySpec): boolean
  /** 摘掉一栏用户 tab（`index` 是用户栏的序）。**不删任何块**——因为压根没有块 */
  removeMountTab(hostId: string, index: number): boolean
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
  /* 浮层 / 提示 */
  toast(text: string, kind?: 'ok' | 'warn' | 'info'): void
  showMenu(req: MenuRequest): void
  showPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null): void
  closeLayers(): void
  showPanel(kind: PanelKind): void
  copy(text: string, label?: string): void
  /* 演示与诊断 */
  loadState(state: FixtureName): void
  setVirtualize(on: boolean, radius?: number): void
  runImeProbe(): { fired: number; seq: string[] }
}

export type Handler = (args: Record<string, unknown>, app: App) => boolean | void
