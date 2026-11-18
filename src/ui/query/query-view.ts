/**
 * **视图宿主**：一个**拥有者**的「怎么看」这一层（center／mount 两种表面共用）。
 *
 * 三种源、一套壳（与 `core/view.ts` 的判据同一处）：
 *
 * | 源 | 抬头 | 正文 |
 * |---|---|---|
 * | **query**（查询块／local tab） | 名字 ＋ 条数 ＋ 「可能已过期」＋ 刷新 ＋ 视图切换 | 大纲＝一列命中；表格＝同一批命中 |
 * | **children**（普通块，激活了视图） | 条数 ＋ 视图切换 ＋ 新建一行 | 表格（直接子块＝行）；切回大纲就没有这一层 |
 * | **items**（收藏块） | 条数 ＋ 视图切换 ＋ 加一条 | 表格／卡片；没有大纲（它不是树） |
 *
 * 四条口径（为什么长这样）：
 *   · **配置在拥有者上**：这一层只经 `ViewOwnerStore` 读写，不知道配置住在
 *     `props._views` 还是 `_mounts` 还是 prefs —— 那正是本次重构要收口的东西。
 *   · **冻结只属于查询源，且冻结在**这一个实例**上**：成员与顺序只在「首次显示／条件变／
 *     上下文变／点刷新」时重算；内容按 id 现读（改字立即看得见）。**不写块、不进撤销。**
 *   · **它只出现在「被打开的那一段」**：查询块的命中、普通块的子块，都不在正文里再画一遍
 *     （正文那边由 `Doc.viewRootId` 让位）。
 *   · **同一个拥有者在两个表面各有一份冻结**：一个刷新，另一个仍是旧的 —— 那是表面状态，
 *     不是内容版本。
 *
 * ⚠️ 大纲分支的 DOM 类名（`.queryview-editor` 里一列 `.blk`）是既有断言的契约，不要改。
 */
import {
  childrenRecords,
  evaluateQuerySpec,
  blockLabel,
  displayNameOf,
  expandContexts,
  hasLiveChildren,
  isEmptyWhere,
  isOwnEdit,
  isQueryBlock,
  listTableOf,
  propKindOf,
  propValueText,
  resolveRows,
  resolveFrozen,
  resolveBoundView,
  sourceOf,
  unfoldForContext,
  usesSelf,
  usesToday,
  resolveTodayBase,
  journalDate,
  journalDateLabel,
  isJournal,
  defaultDisplayPropsFor,
  TAGS_COLUMN,
  PAGE_COLUMN,
  pageGroupsOf,
  mergeContextPlans,
  viewsBroken,
  viewNameOf,
  droppedFrom,
  freezeResult,
  frozenStale,
  readViewSet,
  mkBlock,
  setValue,
  todayISO,
  slicedSpec,
  maskIdsOf,
  structureGroupsOf,
  type StructureGroup,
  type Block,
  type ClickMods,
  type FoldState,
  type OpenAction,
  type BlockStore,
  type FrozenResult,
  type QueryContext,
  type QueryNode,
  type QuerySpec,
  type QuickFilterAtom,
  type Source,
  type ViewBindingRef,
  type DerivedViewKind,
  type SortKey,
  type ViewConfig,
  type ContextPlan,
  type GroupHead,
  type ViewOwnerData,
  type ViewOwnerRef,
  type ViewOwnerStore,
  type ViewRecord,
  type ViewSurface,
  type PropKind,
} from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import { BlockEditor, type Run } from '../../view/editor/editor.ts'
import { inForeignIsland } from '../../view/editor/block-dom.ts'
import { DeferredFlush } from '../../view/editor/deferred-flush.ts'
import { renderIcon } from '../../view/icons.ts'
import { SurfaceEditor } from '../block-ui/surface-editor.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { mountTitleEditor, type TitleEditor } from '../block-ui/title-editor.ts'
import { queryChips } from './query-builder.ts'
import { QueryTree, treeSummary } from './query-tree.ts'
import { ViewOptionsPanel } from '../views/view-options.ts'
import { ViewCards } from '../views/view-cards.ts'
import { ViewTabs } from '../views/view-tabs.ts'
import { ViewCalendar } from '../views/view-calendar.ts'
import { ViewMindmap } from '../views/view-mindmap.ts'
import { ViewListTable } from '../views/view-list-table.ts'
import { ViewTable } from '../views/view-table.ts'
import { ViewGrouped } from '../views/view-grouped.ts'

/**
 * 分组下拉里「按一级子块」的那一项（**UI-only 哨兵**）。
 *
 * 落盘的是 `ViewConfig.groupByStructure: true`，不是这个字符串——
 * 它是 `<option>` 的 value，只活在 DOM 里；不要写进 `_views`。
 */

/**
 * 条件树开没开：**设备状态，不落盘、不进 KB**。
 *
 * 它回答「我此刻在看哪」，不是「这个查询是什么」——所以不进 `_query`/`_views`，
 * 也不为它造一格持久化。键按拥有者＋表面分：同一份查询在正文与侧窗可以各开各的。
 *
 * 默认只在**整屏打开一个查询**时展开：内联体／挂载栏／侧窗都是别人的身体，
 * 一进来就摊开条件会把正文或窄窗撑爆（结果区的「内容高、封顶一档」也会被条件树吃掉）。
 * 那些落点收起成一条 chip，点一下照样就地展开。
 */
const treeOpen = new Map<string, boolean>()

function surfaceDefaultsOpen(surface: ViewSurface, topLevel: boolean): boolean {
  // 整屏打开的查询（顶层、没有容器）⇒ 展开；内联体／挂载栏／侧窗都是别人的身体 ⇒ 收起
  return surface === 'center' || (surface === 'inline' && topLevel)
}

function treeKeyOf(owner: ViewOwnerRef, surface: ViewSurface): string {
  if (owner.kind === 'block') return `block:${owner.blockId}|${surface}`
  const host = owner.host.kind === 'block' ? owner.host.blockId : 'journal'
  return `tab:${host}:${owner.tabId}|${surface}`
}

function isTreeOpen(owner: ViewOwnerRef, surface: ViewSurface, topLevel: boolean): boolean {
  return treeOpen.get(treeKeyOf(owner, surface)) ?? surfaceDefaultsOpen(surface, topLevel)
}

/**
 * **外部把某一栏的条件树摊开**（挂载区「复制为查询栏」的手势：物化出新栏后
 * 直接进条件树，从「看条件」一步到「改条件」）。键与 ViewHost 同一份 store，
 * 所以新栏第一次画抬头时读到的就是摊开态。
 */
export function openQueryTreeFor(owner: ViewOwnerRef, surface: ViewSurface): void {
  treeOpen.set(treeKeyOf(owner, surface), true)
}

export interface ViewHostDeps {
  store: BlockStore
  /** 读门面：求值走 `kb.query`（索引），现读按 id（`kb.get`／`kb.pathOf`） */
  kb: KbClient
  /** 写入事务入口：执行者在装配层（见 `Run`） */
  write: Run
  /**
   * **视图配置的唯一接缝**。这一层不摸 `props._views`／`_mounts`／prefs，
   * 全部经它 —— 「配置住哪」只有一个答案。
   */
  owners: ViewOwnerStore
  /**
   * 拥有者：视图配置住在谁身上。
   *
   * ⚠️ 给了 `binding` 时**以绑定为准**（拥有者由绑定解析出来）——
   *    露面只存「指向谁 ＋ 选了哪张视图」，自己不拥有配置。
   */
  owner: ViewOwnerRef
  /** 绑定：这一次「在别处看一眼」的指针（露面／槽卡） */
  binding?: ViewBindingRef
  /**
   * 显示的宿主块（活引用）。
   *
   * 三处用到它，都不是配置：抬头上的名字、children/items 源的容器、
   * 以及「这一块是不是叶子块」（叶子没有可摊开的东西 ⇒ 不给视图切换器）。
   */
  host: () => Block
  /** 求值的上下文：`$self` 指谁、结果剔除谁 */
  context: QueryContext
  /**
   * **按条件装载候选**（工作集装载；装配层注入）。
   *
   * 候选 id 从 SQL 来、按 id 连祖先链装进工作集；装完返回 true ⇒ 视图重算冻结结果。
   * 省略 ＝ 整库模式（所有块都在内存里，求值天然完整）。
   */
  ensureQueryLoaded?: (spec: QuerySpec, ctx: QueryContext, host: Block | undefined) => Promise<boolean>
  surface: ViewSurface
  /**
   * **名字画到哪**（只有投影给）。
   *
   * 投影跟正文里那个查询块**同一形状**：名字占一行（块标旁），结果面板折在下一行。
   * 给了它 ⇒ 名字画进这一格（那一行），`els.title` 藏起来（面板里不再重复一遍）。
   * 不给 ⇒ 名字仍画在面板抬头里（整屏／内联／侧窗的既有画法）。
   */
  titleInto?: HTMLElement
  /** 发生写入之后要落盘 / 重画别的视图 */
  onChange: () => void
  /** 焦点进来 ⇒ 装配层把「活动编辑器」切过来（键位走命令层） */
  onFocus: (editor: BlockEditor) => void
  /** 接上与正文同一套事件（引用跳转、右键菜单、`#` 补全） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 提示（刷新失败、丢了几条、配置坏了） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 命令面（切视图、排序、增删行、写一格的属性都走它：撤销/落盘只有一条路） */
  invoke: (name: string, args: Record<string, unknown>) => void
  /**
   * **打开「视图…」菜单**（下拉的落点）。
   *
   * `anchor` 只是浮层的落点：下拉要贴着那颗按钮，而不是居中。菜单的行仍由
   * 装配层现画（大纲／已有视图／新建…），这一层不复制一份视图清单。
   */
  openViewMenu?: (owner: ViewOwnerRef, anchor: DOMRect, trigger?: HTMLElement) => void
  /**
   * **打开切片构建器**（抬头切片 chip 的落点）。
   *
   * 与「视图… → 编辑切片…」是同一台浮层：切片存在时任何视图都能就地改，
   * 不必先绕进菜单。`anchor` 取 chip 的矩形，浮层贴着它弹。
   */
  openSlice?: (owner: ViewOwnerRef, viewId: string, anchor: DOMRect | null) => void
  /**
   * **镜头面板的浮层外壳**（四轴一个面）。面板内容仍由这一层造，
   * 装配层只决定「画进哪、贴在哪」：宽面从图标下方开；窄面（右槽）向主内容一侧开，
   * 不盖住被调的那一列。关闭由 Layers 统一处理，`onClose` 只负责清这一层的引用。
   */
  openLens?: (opts: {
    render: (host: HTMLElement) => void
    anchor: DOMRect
    trigger: HTMLElement
    placement?: 'below' | 'left' | 'right'
    onClose?: () => void
  }) => void
  /** 关掉镜头浮层（宿主 dispose 时收自己的尾；不去关别人的层） */
  closeLens?: () => void
  /** 复杂条件交给条件构建器（选项面板的筛选节认不出 chips 时给） */
  openBuilder?: () => void
  /** 声明层选择器（选项面板显示节的「编辑默认」；`_childProps` 写口不变） */
  openChildProps?: (blockId: string) => void
  /** 标题列的投影（run/marks/引用/图片）——由装配层注入，`ui` 不拿整片森林 */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick: (hit: { to: string; runId?: string }, el: HTMLElement, mods: ClickMods) => void
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: ClickMods) => void
  /** 打开一块（行首块标 / 紧凑列表） */
  openBlock: (blockId: string, place?: OpenAction) => void
  /**
   * **右键一块**（记录面的块菜单入口）。
   *
   * 记录视图的行/卡片不是编辑器，所以菜单不能借外层编辑器的事件；这一层只报
   * 「右键了谁、在什么矩形上」，菜单本身由装配层按 target 现开。
   */
  blockMenu?: (blockId: string, anchor: DOMRect, trigger?: HTMLElement) => void
  /** `ref` 值的选择器（与属性区同一份；`rootBlock` 让条件树多一枚「根块」候选） */
  pickRef?: (owner: Block | undefined, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect, trigger?: HTMLElement, opts?: { rootBlock?: boolean }) => void
  /** 标签值选择器：只列已有标签、可搜；查询是读操作，不给新建 */
  pickTag?: (current: string, onPick: (name: string) => void, anchor?: DOMRect, trigger?: HTMLElement) => void
  /** 标签名还解析得到吗：按名存的条件改名后要显示悬空态，而不是静默空集 */
  tagLabel?: (tagId: string) => string
  /** 多值 select 的选值浮层（与属性卡共用；省略 ⇒ 多值格只读） */
  pickChoice?: (
    owner: Block,
    propId: string,
    current: readonly string[],
    onPick: (next: string[]) => void,
    anchor?: DOMRect,
    trigger?: HTMLElement,
  ) => void
  /** `asset` 值选本地文件（与属性卡共用；省略 ⇒ 表格里的 asset 格只渲染、不给选文件按钮） */
  pickAsset?: (onPick: (hash: string) => void) => void
  refLabel: (targetId: string) => string
  /** 把外态地址交给系统浏览器（卡上的块下属性行里，链接与外态资产要能开） */
  openUrl: (url: string) => void
  /** 标签名解析（`select` 选项显示名里的 `#名`） */
  tagName?: (id: string) => string
  /**
   * 可选的属性定义（条件树的字段下拉；按显示名排好，`ui` 不扫森林）。
   * `batch` ＝ 字段覆盖率的分母（草稿里已圈出的那批块，条件树自己算好递过来）；
   * `undefined` ＝ 没有可数的结果 ⇒ 下拉回落全量。chip 与基数只认 label，给谁都一样。
   */
  fields: (batch: QuerySpec | undefined) => readonly { id: string; label: string; kind?: PropKind; cardinality?: 'one' | 'many'; count?: number; total?: number }[]
  /** 某一列的**选项**（`select` 的看板分组列；其余属性给空表） */
  choices?: (propId: string) => readonly { id: string; label: string }[]
  /** 今天（本地日）：日历的「今天描边」要钉得住 */
  today?: () => string
  /**
   * **派生栏模式**（引用／同类／提及）：没有拥有者，只借用这一层的渲染器。
   *
   * 三件事因此不同：
   *   · 看法来自设备状态（由装配层现读现传），不是 `_views`；
   *   · 数据是**现算**的（只读关系视图）：不冻结、不显示刷新、不标 stale；
   *   · 抬头由挂载区画（它要给出「这一栏是什么」的只读说明），这一层不画自己的抬头。
   */
  derived?: DerivedMode
}

export interface DerivedMode {
  /**
   * 这一次实例渲染的非大纲看法（大纲根本不会建 ViewHost，挂载区自己画）。
   * 配置不落盘：`derivedView()` 按它现造一份渲染要用的临时配置。
   */
  kind: DerivedViewKind
  /** 现算的一批记录（已带派生列） */
  records: () => ViewRecord[]
  /** 表格的显示白名单：**临时构造**，不落盘（不含标题列） */
  displayProps: string[]
  /** 这一栏的分组键（设备状态；'' ＝ 没分组）。与看法同层：派生栏没有可写的视图配置 */
  groupBy: string
  /** 这一栏的排序（条目上的镜头；与查询的 `sort` 同一形状） */
  sort?: SortKey[]
  /** 切看法写哪（设备状态；由装配层落地） */
  setKind: (kind: DerivedViewKind) => void
  /** 改排序（写这一栏条目的镜头；表头点击也走这里，不另立屏内瞬态） */
  setSort?: (sort: SortKey[]) => void
  /** 表头的只读说明（「指向这一块」这类） */
  explain: string
}

export interface ViewHostEls {
  root: HTMLElement
  /** 抬头整条（派生栏由挂载区画抬头，这一条要藏起来） */
  head: HTMLElement
  title: HTMLElement
  count: HTMLElement
  /** 大纲折叠时会少画几行：主数字仍是命中数，这里补一句「M 个顶层」 */
  topCount: HTMLElement
  /** 视图切换器（默认看法 ＋ 已有视图 ＋ 加一张） */
  views: HTMLElement
  /** **镜头**按钮：四轴一个面（筛选/排序/分组/显示；可用性读 `axesFor`） */
  optionsBtn: HTMLButtonElement
  /** 条件 chip 条（查询源才有；收起时只剩一条摘要） */
  filters: HTMLElement
  /** 条件树（就地展开；与抬头同属这一段，不是浮层） */
  tree: HTMLElement
  /** 「已隐藏 N 项」（children 记录视图的掩码语义）：筛掉 ≠ 删除，点击清除 */
  hiddenNote: HTMLButtonElement
  refresh: HTMLButtonElement
  /**
   * 「全部展开／全部收起」：**一个**按钮，文案随状态变。
   * 非大纲视图下隐藏 —— 那里没有「行折叠」这回事，显示了就是骗人。
   */
  foldAll: HTMLButtonElement
  newRow: HTMLButtonElement
  /** 「结果可能已过期」标记：只提示、不改列表（自动移除会让人正在读的那行凭空消失） */
  stale: HTMLElement
  /** 大纲分支（查询源的命中列表；类名是既有断言的契约） */
  editor: HTMLElement
  /** 表格分支 */
  table: HTMLElement
  /**
   * 空态的主动作（「还没有条件」才有）：点击就地展开条件树。
   * 不进装配序、由空态渲染按需挂进大纲分支的槽——挂早了会排在岛根上面。
   */
  emptyAdd: HTMLButtonElement
}

/**
 * 自建 DOM：视图宿主只出现在**某一段**里（被打开的那个块自己那一段），
 * 一个静态模板节点没法同时属于多段 —— 组件自己造自己那几格。
 */
export function createViewHostEls(): ViewHostEls {
  const root = document.createElement('section')
  root.className = 'queryview'
  root.hidden = true

  const head = document.createElement('div')
  head.className = 'queryview-head'
  /**
   * 抬头那一格是 `div` 而不是 `span`：投影的抬头里装的是**一台块编辑器**
   * （块级盒子）。块级盒子放进 inline 元素里，布局会按 inline 基线算，
   * 名字换行时与相邻的条数对不齐。
   */
  const title = document.createElement('div')
  title.className = 'queryview-title'
  const count = document.createElement('span')
  count.className = 'queryview-count'
  const topCount = document.createElement('span')
  topCount.className = 'queryview-topcount'
  topCount.hidden = true
  const stale = document.createElement('span')
  stale.className = 'queryview-stale'
  stale.hidden = true
  const filters = document.createElement('div')
  filters.className = 'queryview-filters'
  const views = document.createElement('div')
  views.className = 'queryview-views'
  const optionsBtn = document.createElement('button')
  optionsBtn.type = 'button'
  optionsBtn.className = 'queryview-options'
  optionsBtn.hidden = true
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'queryview-refresh'
  const foldAll = document.createElement('button')
  foldAll.type = 'button'
  foldAll.className = 'queryview-foldall'
  foldAll.hidden = true
  const newRow = document.createElement('button')
  newRow.type = 'button'
  newRow.className = 'queryview-newrow'
  newRow.hidden = true
  const hiddenNote = document.createElement('button')
  hiddenNote.type = 'button'
  hiddenNote.className = 'queryview-hidden'
  hiddenNote.hidden = true
  head.append(title, count, topCount, stale, filters, views, optionsBtn, hiddenNote, refresh, foldAll, newRow)

  const tree = document.createElement('div')
  tree.className = 'queryview-tree'
  tree.hidden = true

  const body = document.createElement('div')
  body.className = 'queryview-body'
  /**
   * 大纲分支的**槽**（不是编辑宿主本身）。
   *
   * 为什么要多一层：`EditableBlock` 会把宿主节点**搬进**自己的岛根里
   * （`contenteditable=false` 的断链节点）。若把 `.queryview-editor` 直接当宿主，
   * 它就会被搬离这个槽 —— 再想把岛根放回槽里就是「把父节点塞进自己的孩子」
   * （浏览器直接抛 `appendChild … contains the parent`）。
   */
  const editor = document.createElement('div')
  editor.className = 'queryview-outline'
  editor.hidden = true
  const table = document.createElement('div')
  table.className = 'queryview-table'
  table.hidden = true
  body.append(editor, table)

  const emptyAdd = document.createElement('button')
  emptyAdd.type = 'button'
  emptyAdd.className = 'queryview-empty-add'
  emptyAdd.hidden = true

  root.append(head, tree, body)
  return {
    root,
    head,
    tree,
    title,
    count,
    topCount,
    filters,
    views,
    optionsBtn,
    refresh,
    foldAll,
    newRow,
    stale,
    hiddenNote,
    editor,
    table,
    emptyAdd,
  }
}

/** 一个「表面实例」的冻结结果（内存；不进 KB、不进撤销） */
export class ViewHost {
  private readonly els: ViewHostEls
  private readonly deps: ViewHostDeps
  /** 大纲分支（懒建：切到表格时 dispose，切回来重建 —— 不藏一台还在订阅的编辑器） */
  private outline: EditableBlock | null = null
  /** 表格分支 */
  private table: ViewTable | null = null
  /** 结构映射表分支（表头＝直接子块、一列＝那个子块的孩子） */
  private listTable: ViewListTable | null = null
  /** 卡片分支（看板／画廊是同一张看法的两副面孔，`cardLayoutOf` 决定画成列还是网格） */
  private cards: ViewCards | null = null
  /** 页签分支（一次只看一个子块；激活页是渲染器自己的实例状态） */
  private tabs: ViewTabs | null = null
  /** children 记录视图当前的显示掩码（命中 id 集；`null` ＝ 无掩码）。`paintChrome` 每次重画现算 */
  private maskIds: Set<string> | null = null
  /** 镜头面板（四轴一个面；懒建一台，切视图只换它读到的活配置） */
  private optionsUi: ViewOptionsPanel | null = null
  /** 面板现在挂在哪个浮层宿主里（`null` ＝ 没开；关层时由 `onClose` 清） */
  private optionsHost: HTMLElement | null = null
  private calendar: ViewCalendar | null = null
  private mindmap: ViewMindmap | null = null
  /** 分组包装（表格带 `groupBy` 时）：段头归它、段身仍是表格 */
  private grouped: ViewGrouped | null = null
  /** 这一次 body 实际按哪个分组键画（'' ＝ 未分组）：键变了 body 要重摆 */
  private renderedGroupKey = ''
  /** 这一屏现在画的是谁：`outline` 或激活视图的 id（变了才换分支） */
  private mode = ''
  /** **一台就地编辑器**（卡片标题格、表格标题格、大纲表格的格共用） */
  private readonly cell: SurfaceEditor
  /**
   * **投影抬头的常驻编辑器**（只有 `surface === 'embed'` 才有）。
   *
   * 它与 `cell` 是两种「改名字」的画法，各有各的落点：表格/卡片按需开、装进那一格；
   * 抬头只有一处、直接可写。抬头**不用** `cell` —— 同一台 `SurfaceEditor` 一次只编辑
   * 一处，而表格与抬头可能同屏。
   */
  private title: TitleEditor | null = null
  /** 查询视图自己的 stale 订阅（只点亮提示、不重排——冻结成员是 D4） */
  private readonly offStale: () => void
  /** 记录面的块菜单委托（右键一行/一张卡；拆台时摘掉） */
  private readonly offContextMenu: () => void
  /** 条件树（查询源；懒建，收起只隐藏不清空草稿） */
  private treeUi: QueryTree | null = null
  /** chips 面板开着没有（就地展开；与排序面板同一种寿命） */
  private staleIds = new Set<string>()
  /** 上下文展开栈（祖先 id）；刷新时清空，外部编辑重画时保留 */
  private expanded = new Set<string>()
  /** 上次渲染的「上下文根 → 覆盖的命中行」：收起一层时滚回那一行 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 配置坏了只提示一次（每次装载都弹一遍会盖住用户正在做的事） */
  private warned = false
  /** **这一个表面实例**的冻结结果；条件／视图／上下文变了才重算 */
  private frozen: FrozenResult | null = null
  /**
   * 大纲里的**结构编辑**改过树：冻结结果与上下文展开栈都可能过期。
   *
   * 为什么不在每次按键上重算：查询结果是**冻结**的（不自动重算，否则打一个字
   * 结果集就跳一下）。但「新建/删除/移动一个块」改变了树，下一次装载（失焦或
   * 外部重画）必须按**刷新同一条口径**收口，否则屏幕会按旧结果解释新树
   * （例如新块被并进上一棵命中子树里显示成子块）。刷新一次按钮就恢复正常，
   * 说明差的正是这一步「按当前树重算」。
   */
  private structureDirty = false
  /** 派生栏的「整片重算」防抖（成员可能新增，局部修补不够） */
  private readonly derivedFlush = new DeferredFlush(() => this.sync(true), 120)
  /** 这一屏的**顶层行**（`render` 时存下来：「全部收起」要有东西可收才有意义） */
  private rows: readonly Block[] = []

  constructor(els: ViewHostEls, deps: ViewHostDeps) {
    this.els = els
    this.deps = deps
    /**
     * 表面进 DOM：`inline` 与 `center` 的差别只在几何/抬头去重（行上已经有块名），
     * 渲染器、配置、冻结全是同一份。CSS 按这一格选「贴在这一行下面」。
     */
    this.els.root.dataset.surface = deps.surface
    /**
     * 记录面的块菜单入口：一条委托装在宿主根上，五个渲染器零改动
     * （行/卡片本来就带 `data-block-id`）。拆台时摘掉。
     */
    const onContextMenu = (e: MouseEvent): void => this.openRecordMenu(e)
    this.els.root.addEventListener('contextmenu', onContextMenu)
    this.offContextMenu = () => this.els.root.removeEventListener('contextmenu', onContextMenu)
    /**
     * 这一台宿主画的是**哪个拥有者**的身体。
     *
     * 用途只有一处：切视图之后，装配层要回答「此刻有没有表面在画它」——
     * 有就**就地重画**（每个 ViewHost 都订阅拥有者的配置），没有才把这一块打开。
     * 认 DOM 里这一格、不另建一张「哪些块正被画着」的登记表：登记表漏一次 dispose
     * 就会永远说「画着」，而它不报错，只表现为「切了视图，点了没反应」。
     */
    if (deps.owner.kind === 'block') this.els.root.dataset.viewOwner = deps.owner.blockId
    /**
     * 派生栏的抬头由挂载区画（栏名／条数／说明／快速筛选都在那边），这一层只借渲染器
     * ——但**分组选择**留在这条抬头里：与自定义查询同一颗 select、同一份候选口径，
     * 单独抄一份到挂载区就是第二份会漂的候选逻辑。条数挂载区已有 ⇒ 藏掉。
     */
    if (deps.derived) this.els.count.hidden = true
    /**
     * 抬头右侧的动作键一律**图标 ＋ 悬停/读屏文案**（与漏斗同一套画法）：
     * 窄抬头里文字按钮会被挤成竖条，而刷新/排序/列这三个动作认图形就够了，
     * 结构含义交给间距与分组去传达，不靠每个按钮自带一句名词。
     */
    renderIcon(this.els.refresh, 'lucide:rotate-ccw', 'rotate-ccw')
    this.els.refresh.dataset.tip = t('ui.query.refresh')
    this.els.refresh.setAttribute('aria-label', t('ui.query.refresh'))
    this.els.refresh.addEventListener('click', () => this.refresh())
    renderIcon(this.els.optionsBtn, 'lucide:list-filter', 'list-filter')
    this.els.optionsBtn.dataset.tip = t('ui.view.optionsTitle')
    this.els.optionsBtn.setAttribute('aria-label', t('ui.view.options'))
    this.els.optionsBtn.addEventListener('click', () => this.openLens())
    this.els.newRow.textContent = t('ui.view.newRow')
    this.els.newRow.dataset.tip = t('ui.view.newRowTitle')
    this.els.newRow.addEventListener('click', () => this.deps.invoke('core.view/new-row', { owner: this.writeOwner }))
    // 「已隐藏 N 项」点击＝清掉这张视图的显示掩码（筛掉 ≠ 删除，退路要一眼可及）
    this.els.hiddenNote.addEventListener('click', () => {
      this.deps.invoke('core.view/set-filter', { owner: this.writeOwner, viewId: this.view?.id ?? '', filter: null })
    })
    this.els.foldAll.addEventListener('click', () => this.toggleFoldAll())
    // 空态的主动作与条件树末尾的「＋」是同一条动作：就地展开条件树（不另开命令）
    this.els.emptyAdd.textContent = `＋ ${t('ui.query.tree.add')}`
    this.els.emptyAdd.addEventListener('click', () => this.openTree())
    /**
     * **一台就地编辑器**：一次只编辑一处，装进被点的那一格（不是浮层）。
     *
     * 卡片与表格共用它 —— 差别只在「那一格长什么样」，不在编辑器。
     * 冻结范围＝这一屏：正在打字的格不该因为别处的变化被重排。
     */
    this.cell = new SurfaceEditor({
      store: deps.store,
      write: deps.write,
      wire: (ed, change) => deps.wire(ed, change),
      onFocus: (ed) => deps.onFocus(ed),
      onChange: () => deps.onChange(),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, el, mods),
      ...(deps.onAtomClick ? { onAtomClick: deps.onAtomClick } : {}),
      area: this.els.root,
      // 编辑结束：让正在画那一格的渲染器把投影放回去（只有它在场时才做）
      onClose: (blockId) => {
        this.table?.afterEdit(blockId)
        this.listTable?.afterEdit(blockId)
        this.cards?.afterEdit(blockId)
      },
    })
    /**
     * **投影抬头是常驻可编辑的一行名字**（只有 `embed` 表面显示抬头名字）。
     *
     * 它不是「点一下开浮层」：露面行的正文槽是空的，抬头是名字**唯一**的落点，
     * 改个名不该先点一下。装载只有源块、子块不画（`viewRootId`）、↵ 是敲完
     * —— 那三条判据都在 `mountTitleEditor` 里。
     */
    if (deps.surface === 'embed' && deps.titleInto) {
      this.title = mountTitleEditor({
        into: deps.titleInto,
        store: deps.store,
        write: deps.write,
        wire: (ed, change) => deps.wire(ed, change),
        onFocus: (ed) => deps.onFocus(ed),
        onChange: () => deps.onChange(),
        // 抬头画的是**源块**（拥有者）：露面块自己没有名字
        block: () => this.ownerBlock(),
        placeholder: t('ui.query.untitled'),
      })
    }

    // ⚠️ 只点亮 stale，不重排列表（「不自动重算」）。
    // 拿不到「动过哪些块」就先不点亮：宁可少提示，也不要因为刷新顺带的重渲染误报。
    this.offStale = deps.store.subscribe((source, ids) => {
      /**
       * **自己的编辑器发起的编辑**：正文行已经局部重画，这里不再整片重排。
       *
       * ⚠️ 例外是**撤销**：条件树的应用写在 `_query` 里，撤销时 `source` 正是
       *    这台大纲编辑器（`app.ed.undoStep()`）⇒ 若在这里直接 return，
       *    条件已经回滚、冻结结果却还是新的（「⌘Z 之后结果没变」）。
       *    判据不靠「是不是撤销」，而靠**条件真的变没变**：名字/正文的编辑不会让
       *    `frozenStale` 为真，所以正常打字仍然不重排。
       */
      if (isOwnEdit(source, this.outline?.ed)) {
        const spec = this.effective
        if (spec && frozenStale(this.frozen, spec, this.evalContext(spec), this.viewKey)) {
          this.sync()
        }
        return
      }
      /**
       * 派生栏是**只读关系视图**：新引用/新提及/新标签都可能让成员增减，
       * 只按 id 修补已有行不够 ⇒ 防抖整片重算（不冻结、不标 stale）。
       */
      if (this.deps.derived) {
        // 只换计时器：重算语义不动（整片重算，不冻结、不标 stale）
        this.derivedFlush.arm()
        return
      }
      /**
       * **抬头那台编辑器自己的编辑**：它改的就是抬头正在显示的那份正文
       * （源块的名字），屏幕上已经是对的 —— 再 `sync()` 一次只会把身体那份结果
       * 整片重装一遍（每个字一次）。条件/视图的改动走命令层，`source` 不是它。
       */
      if (this.title && isOwnEdit(source, this.title.editor())) return
      if (ids === undefined) {
        // **整库通知**（换库／诊断面的森林替换）：没有 id 集 ⇒ 全量重读。
        // 只认 id 的修补在这里收不到任何行——森林内容变了而身体还挂着旧的那份。
        this.sync()
        return
      }
      if (ids.length > 0) {
        /**
         * **拥有者自己的配置变了**（`_query`／`_views`／`_activeView`／名字）⇒ 重读重画。
         *
         * 段尾宿主原本靠装配层的 `renderMounts()` 补这一下；右槽窗口与正文内联体
         * 没有那条路径 —— 订阅是它们唯一的回声。`sync()` 只在条件／视图／上下文
         * 真变时重查：换视图（`viewKey` 变）与切片编辑都会重冻成员。
         */
        const owner = this.bound.owner
        if (owner.kind === 'block' && ids.includes(owner.blockId)) {
          this.sync()
          return
        }
        this.noteTouched(ids)
        // ⚠️ 每种视图种类在这里占一行：漏接不报错——配置写进去了、屏幕不动（「点了没生效」）。
        // 修补粒度按「重建会不会搬动编辑器 DOM」分：表格按行 patch；页签只认成员 id 签名
        // （切换条重建会搬身体编辑器，不能跟打字节奏走）。
        // children/items 源是活的：子块的正文/属性变了，那一行要跟着变（按 blockId 局部修补）
        if (this.table) this.table.sync(ids)
        if (this.listTable) this.listTable.render(ids)
        // 卡片按 blockId 局部修补：整片重画会把正在编辑的那张卡的锚点摘掉
        if (this.cards) this.cards.sync(ids)
        // 页签：成员数变了重建切换条；已有页签的正文变了就地改文案（重建会搬身体编辑器）
        if (this.tabs) this.tabs.sync(ids)
      }
    })
  }

  /** 视图宿主的根（装配层把它放进挂载点：行内体的容器／窗口的身体格） */
  get root(): HTMLElement {
    return this.els.root
  }

  /** 大纲分支的编辑器（没有就在；表格分支下是 `null`） */
  get editor(): BlockEditor | null {
    return this.outline?.ed ?? null
  }

  /**
   * 记录面的右键：只认「这一屏里的一个记录行」，其余手势原样让路。
   *
   * 三道让路：
   *   · 输入控件（表格格子的 `input` 等）→ 原生菜单；
   *   · 行内原子／tag chip／引用／属性图标 → 它们有自己的手势，v1 不在记录面接，
   *     但也不吞（保持「现在没有菜单」的原样，不制造错误行为）；
   *   · 里层编辑器（卡片/标题格正在编辑）→ 岛界规则：归里层。
   */
  private openRecordMenu(e: MouseEvent): void {
    if (!this.deps.blockMenu) return
    const target = e.target
    if (!(target instanceof HTMLElement)) return
    if (target.closest('input, textarea, select')) return
    if (target.closest('[data-atom-id], [data-tag-id], [data-ref-to], [data-prop-id]')) return
    if (inForeignIsland(e, this.els.root)) return
    const el = target.closest<HTMLElement>('[data-block-id]')
    if (!el?.dataset.blockId || !this.els.root.contains(el)) return
    e.preventDefault()
    this.deps.blockMenu(el.dataset.blockId, new DOMRect(e.clientX, e.clientY, 0, 0), el)
  }

  dispose(): void {
    this.offContextMenu()
    this.offStale()
    // 这一台宿主拆了，镜头浮层不能还挂着一份旧面板（关层会回调 onClose 清引用）
    if (this.optionsHost?.isConnected) this.deps.closeLens?.()
    this.optionsHost = null
    this.derivedFlush.dispose()
    this.treeUi = null
    this.outline?.dispose()
    this.outline = null
    this.table?.dispose()
    this.table = null
    this.listTable?.dispose()
    this.listTable = null
    this.cards?.dispose()
    this.cards = null
    this.calendar?.dispose()
    this.calendar = null
    this.mindmap?.dispose()
    this.mindmap = null
    this.title?.dispose()
    this.title = null
    this.cell.dispose()
  }

  /**
   * 这次渲染实际读的是**谁的**配置、以及**哪一张**视图。
   *
   * 两条路：
   *   · 没有绑定 ⇒ 拥有者就是 `deps.owner`，视图就是它的默认激活项；
   *   · 有绑定 ⇒ 拥有者是绑定指向的那一块，视图按 `''`／`'outline'`／id 解出。
   *
   * ⚠️ 每次现读：配置可能被命令改过，缓存一份就等于承认「界面可以是旧的」。
   */
  private get bound(): {
    owner: ViewOwnerRef
    data: ViewOwnerData
    view: ViewConfig | null
    /** 目标还在，但它那张视图没了（要给用户一句实话） */
    degraded: boolean
    /** 目标块本身没了（悬空） */
    dangling: boolean
  } {
    const binding = this.deps.binding
    if (binding) {
      const target = this.deps.owners.readBinding(binding)
      if (!target) return { owner: this.deps.owner, data: { views: [] }, view: null, degraded: false, dangling: true }
      const data = this.deps.owners.read(target.owner) ?? { views: [] }
      const r = resolveBoundView(target, data)
      return { owner: target.owner, data, view: r.view, degraded: r.degraded, dangling: false }
    }
    const data = this.deps.owners.read(this.deps.owner) ?? { views: [] }
    return {
      owner: this.deps.owner,
      data,
      view: readViewSet(data).active,
      degraded: false,
      dangling: false,
    }
  }

  /** 这一份源（**派生**：query／children／items；派生栏走现算记录，不建源） */
  private get source(): Source {
    if (this.deps.derived) return { kind: 'children', blockId: this.deps.host().id }
    const { owner, data } = this.bound
    if (data.query) return { kind: 'query', spec: data.query }
    if (owner.kind === 'block') {
      const b = this.deps.kb.get(owner.blockId)
      if (b) return sourceOf(b, (id) => this.deps.kb.get(id))
      return { kind: 'children', blockId: owner.blockId }
    }
    return { kind: 'children', blockId: '' }
  }

  /** 当前这张视图（`null` ＝ 这一份源的默认看法） */
  private get view(): ViewConfig | null {
    if (this.deps.derived) return this.derivedView()
    return this.bound.view
  }

  /**
   * 这一屏**生效的条件** ＝ 基础条件 ∩ 切片（AND 叠加，切片不替换基础条件）。
   *
   * 基础条件只有一份（`_query`，条件树编辑的就是它）；切片住在当前视图上。
   * 没有切片 ⇒ 原样返回，与只有基础条件时逐字相同。
   */
  private get effective(): QuerySpec | null {
    const src = this.source
    if (src.kind !== 'query') return null
    return slicedSpec(src.spec, this.activeFilter)
  }

  /**
   * **此刻生效的切片**：激活了命名视图 ⇒ 它自己的 `filter`；否则是**默认看法**的
   * （拥有者那一格 `_defaultFilter`）。判据只有一条——**现在激活的是哪张视图**。
   *
   * 派生面没有拥有者 ⇒ 永远没有切片（它连基础条件都是现算的）。
   */
  private get activeFilter(): QueryNode | null {
    if (this.deps.derived) return null
    if (this.view) return this.view.filter ?? null
    const data = this.deps.owners.read(this.writeOwner)
    return data?.defaultFilter ?? null
  }

  /**
   * **行首路径关没关**：与 `activeFilter` 同一条读路——激活视图没有大纲（记录视图
   * 的路径走「路径」列），所以只有**默认看法**有这一格（拥有者的 `_defaultShowPaths`）。
   * 派生面自己带镜头格（挂载区装载时传），不走这里。
   */
  private get pathsHidden(): boolean {
    if (this.deps.derived) return false
    const data = this.deps.owners.read(this.writeOwner)
    return data?.defaultShowPaths === false
  }

  /** 分段大纲的折叠组（会话态；刷新回全开——密度出口不是结构） */
  private readonly groupCollapsed = new Set<string>()

  /** 组头名：日记天用日期，页/根用显示名（解析不到兜「无标题」，不露裸 id） */
  private pageGroupLabel(page: Block | undefined): string {
    if (!page) return t('ui.query.group.topLevel')
    if (isJournal(page)) return journalDateLabel(journalDate(page))
    return blockLabel(page, (id) => this.deps.kb.get(id))
  }

  /**
   * 冻结键里的视图位：切片住在视图上 ⇒ 换一张视图必须重算，
   * 哪怕两份条件串看起来一样（两张都无切片的视图也该各自冻各自的那一份）。
   */
  private get viewKey(): string {
    return this.view?.id ?? ''
  }

  /**
   * 派生栏的临时视图配置：**只有渲染需要的几样**（列／字段、分组键、这一屏的排序）。
   *
   * 不落盘、不复制：派生栏没有 `_views`。排序也只在这一次露面里活着（切走就回原序）——
   * 承认「派生栏的排序是设备状态」会顺手给它造一份配置，而它本来什么都没有。
   *
   * 卡片缺省画廊（与命令层建卡片的兜底同一条：封面取正文首图）；日历的日期列
   * 用同一条兜底——第一个 `date` 定义，退到 `_date`。分组键是设备状态
   * （挂载区抬头画的那颗下拉），卡片带键＝列（看板），表格带键＝分节。
   */
  private derivedView(): ViewConfig {
    const d = this.deps.derived!
    const group = d.groupBy ? { groupBy: d.groupBy } : {}
    if (d.kind === 'cards') {
      return { id: 'derived:cards', kind: 'cards', cards: { cover: 'first-asset' }, ...group }
    }
    if (d.kind === 'calendar') {
      const dateBy = this.deps.kb.propDefs().find((def) => def.props?._kind === 'date')?.id ?? '_date'
      return { id: 'derived:calendar', kind: 'calendar', calendar: { dateBy } }
    }
    return {
      id: 'derived:table',
      kind: 'table',
      // 排序是这一栏条目上的镜头（不是这一屏的瞬态）；显示仍是临时构造
      ...(d.sort && d.sort.length > 0 ? { sort: d.sort } : {}),
      displayProps: [...d.displayProps],
      ...group,
    }
  }

  /**
   * **这一份源这一屏实际要画的那张视图**（`null` ＝ 大纲）。
   *
   * 派生栏没有拥有者 ⇒ 它那份临时表格配置由这里现造（不落盘）；
   * 其余情形就是拥有者激活的那一张，没有就是大纲。
   */
  private defaultView(): ViewConfig | null {
    if (this.deps.derived) return this.derivedView()
    return this.bound.view
  }

  /** 写配置时的拥有者（绑定 ⇒ 目标块；不是这一次的宿主） */
  private get writeOwner(): ViewOwnerRef {
    return this.bound.owner
  }

  /** 拥有者那一块（露面指的目标；local tab 没有块 ⇒ `undefined`） */
  private ownerBlock(): Block | undefined {
    const { owner } = this.bound
    return owner.kind === 'block' ? this.deps.kb.get(owner.blockId) : undefined
  }

  /* ---------------------------------------------------------- 装载 */

  /** 首次装载（或宿主换了） */
  mount(): void {
    this.staleIds.clear()
    this.warned = false
    this.frozen = null
    this.sync(true)
  }

  /**
   * 装配层在每次装载之后叫一次：**画法变了就换分支**（激活视图被命令改过），
   * 没变就只把数据对齐（不整表重排 —— 那是「滚动一下整表重建」的来源）。
   */
  sync(force = false): void {
    const b = this.deps.host()
    const view = this.defaultView()
    const mode = view ? `${view.kind}:${view.id}` : `outline:${this.source.kind}`
    if (this.warned === false && viewsBroken(this.ownerBlock())) {
      this.warned = true
      this.deps.toast?.(t('ui.view.broken'), 'warn')
    }
    /**
     * **这一次露面指的那张视图没了**：退回源的默认看法，但要说一句实话 ——
     * 静默退回等于「我选的表格怎么变成大纲了」，而用户没有任何线索能找回那次选择。
     */
    if (this.warned === false && this.bound.degraded) {
      this.warned = true
      this.deps.toast?.(t('ui.mount.viewGone'), 'warn')
    }
    // 查询源：条件/上下文变了就重算冻结结果（不写块、不进撤销）
    // 派生栏是**只读关系视图**：不冻结、不标 stale —— 它每次都是现算的
    if (!this.deps.derived && this.source.kind === 'query') this.ensureFrozen()
    if (force || mode !== this.mode) {
      this.mode = mode
      this.paintChrome(b, view)
      const kind = view?.kind ?? 'outline'
      if (kind === 'outline') {
        this.showOutline()
        this.render()
      } else {
        this.showBody(view!)
      }
      return
    }
    this.paintChrome(b, view)
    // 分组键变了不换 mode（同一张视图）：body 得重摆成新分组
    const groupKey = view?.kind === 'table' ? (view.groupBy ?? '') : ''
    if (view && groupKey !== this.renderedGroupKey) {
      this.showBody(view)
      return
    }
    if (view?.kind === 'list-table') this.listTable?.render()
    else if (view?.kind === 'cards') this.cards?.render()
    else if (view?.kind === 'tabs') this.tabs?.render()
    else if (view?.kind === 'calendar') this.calendar?.render()
    else if (view?.kind === 'mindmap') this.mindmap?.render()
    else if (view?.kind === 'table') {
      if (this.grouped) this.grouped.render()
      else this.table?.sync()
    } else if (view) this.paintBodyFallback()
    else this.render()
  }

  /**
   * 这一次求值的上下文：`$self`／剔除名单来自装配层；`{today}`（相对日期）的基准**现算**。
   *
   * 为什么不随装配层一次性给：基准跟墙钟走（跨天要变），装一次就冻死了；
   * 也没有 `{today}` 的查询不该带这一格——否则冻结键天天变，全库查询白白重算。
   */
  private evalContext(spec: QuerySpec): QueryContext {
    if (!usesToday(spec.where)) return this.deps.context
    const base = this.deps.today?.() ?? todayISO()
    return { ...this.deps.context, today: resolveTodayBase(spec, this.hostDate(), base) }
  }

  /** 宿主（`$self` 指的那一块）的日期；宿主不是日记块 ⇒ `undefined`（锚要藏起来） */
  private hostDate(): string | undefined {
    const selfId = this.deps.context.selfId
    if (selfId === undefined) return undefined
    const host = this.deps.kb.get(selfId)
    if (!host) return undefined
    const date = journalDate(host)
    return date === '' ? undefined : date
  }

  /**
   * 冻结结果：**只在五种情况下重算**。
   *
   *   · 还没有冻结（这一实例首次求值）；
   *   · 基础条件变了（编辑／撤销 ⇒ `specKey` 变）；
   *   · 切片变了（编辑这一张视图的 `filter` ⇒ `specKey` 也变，因为叠加在生效条件上）；
   *   · 换视图（`viewKey` 变 ⇒ 同一份条件不同看法，成员可能不同）；
   *   · 上下文变了（换宿主／换表面 ⇒ `contextKey` 变，`$self` 指向的根不同）。
   *
   * 于是不会出现「旧条件 ＋ 新结果」。⚠️ 这里**不写块**：结果与 `modified` 无关，
   * 也不进撤销栈。
   */
  private ensureFrozen(): void {
    const spec = this.effective
    if (!spec) return
    const ctx = this.evalContext(spec)
    if (!frozenStale(this.frozen, spec, ctx, this.viewKey)) return
    /**
     * **候选先装载**：候选 id 从 SQL 来（超集），未装载的按 id 连祖先链装进来；
     * 装完重算这一份。本帧先按已装载求值（可能少几行），装载完成重置冻结重画——
     * 这是「候选页」的装载节奏，不是静默少结果（重算之后的成员是完整的）。
     */
    if (this.deps.ensureQueryLoaded) {
      const host = this.deps.host()
      void this.deps
        .ensureQueryLoaded(spec, ctx, host)
        .then((loaded) => {
          // 真装进了新块才重算；整库模式/候选已齐 ⇒ 本次求值已经完整
          if (loaded) {
            this.frozen = null
            this.sync(true)
          }
        })
        .catch((e) => this.deps.toast?.(t('ui.query.refreshFailed', { message: e instanceof Error ? e.message : String(e) }), 'warn'))
    }
    const before = this.frozen?.hits ?? []
    this.frozen = freezeResult(spec, this.deps.kb, ctx, this.viewKey)
    const dropped = droppedFrom(before, this.frozen.hits)
    if (dropped.length > 0 && before.length > 0) {
      this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
    }
  }

  /**
   * 结构编辑的**编辑边界收口**：按当前树重算一次，并把上下文展开栈清掉。
   *
   * 与刷新按钮同一口径（少一句 toast）：树变了，旧的「哪些是命中、覆盖了哪几条」
   * 就不再描述这一屏。只在**自己**的结构编辑之后、下一次装载时做——打字途中不动，
   * 否则每敲一个字结果集都会重排。
   */
  private settleStructure(): void {
    if (!this.structureDirty) return
    this.structureDirty = false
    this.expanded = new Set()
    this.covers = new Map()
    this.staleIds.clear()
    // 与刷新同一条「按当前树重算」，但不报 toast：这是编辑边界的自动收口，
    // 不是用户按了刷新。被覆盖的命中仍会由祖先子树渲染出来，不该说「不再满足」。
    const spec = this.effective
    if (spec) this.frozen = freezeResult(spec, this.deps.kb, this.evalContext(spec), this.viewKey)
  }

  /** 刷新按钮：**只重算这一个实例**（别的表面各自持有自己的那份，不受影响） */
  refresh(): void {
    this.els.refresh.disabled = true
    try {
      const spec = this.effective
      if (!spec) return
      const before = this.frozen?.hits ?? []
      this.frozen = freezeResult(spec, this.deps.kb, this.evalContext(spec), this.viewKey)
      const dropped = droppedFrom(before, this.frozen.hits)
      // 刷新＝成员与顺序都换了：上一轮的上下文展开没有依据，从头来
      this.expanded = new Set()
      this.covers = new Map()
      this.staleIds.clear()
      this.structureDirty = false
      if (dropped.length > 0) this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
      this.deps.toast?.(t('ui.query.refreshed', { count: this.rowCount() }), 'ok')
      this.deps.onChange()
      this.sync(true)
    } catch (e) {
      // 保留旧结果 + 明确告知（不静默清空）
      this.deps.toast?.(t('ui.query.refreshFailed', { message: e instanceof Error ? e.message : String(e) }), 'warn')
    } finally {
      this.els.refresh.disabled = false
    }
  }

  private rowCount(): number {
    if (this.deps.derived) return this.deps.derived.records().length
    const src = this.source
    if (src.kind === 'query') return (this.frozen?.hits ?? []).length
    // 结构映射表的行＝各列的第 j 项（表头不占一行），与渲染器同一份派生
    // 结构映射表只接 children 源（要对齐「第 k 个孩子」，查询命中不是树）
    if (this.view?.kind === 'list-table' && src.kind === 'children') {
      return listTableOf(src.blockId, this.deps.kb).rows.length
    }
    return src.kind === 'children' ? this.deps.kb.children(src.blockId).length : 0
  }

  /* ---------------------------------------------------------- 抬头 */

  private paintChrome(b: Block, view: ViewConfig | null): void {
    this.els.root.hidden = false
    const derived = this.deps.derived
    const src = this.source
    const query = !derived && src.kind === 'query'
    const name = displayNameOf(b).trim()
    /**
     * 查询源保留名字（它自己就是这张视图的标题）；
     * children/items 源的根行就在上面，抬头再写一遍同一句就是重复。
     * **内联体也不写名字**：查询块那一行已经显示过它 —— 同一句话同屏两遍是噪声。
     */
    /**
     * **露面（投影）总是写名字**：那一行自己的正文槽是空的（露面块不写正文），
     * 名字没有第二处可显示 —— 不写的话这张表/这份结果就没有抬头。
     * 内联体与侧窗不写：那一行上已经有块名了（同一句话同屏两遍是噪声）。
     */
    const embed = this.deps.surface === 'embed'
    /**
     * 抬头写不写名字：
     *   · **挂载栏不写**：那一栏挂在块底下，栏的 tab 已经说明了它是谁；再写一遍块名
     *     只会让「块内容 ＋ 条数」读成两行标题（新查询尤其明显）。
     *   · **内联体／侧窗不写**：那一行上已经有块名了（同一句话同屏两遍是噪声）。
     *   · **投影写**：露面块自己的正文槽是空的，名字没有第二处可显示。
     */
    /**
     * **名字画在哪**：
     *   · 投影（`embed`）：画在**块标那一行**（`titleInto`，与正文里那个查询块同一形状）
     *     ⇒ 面板抬头不再写名字（同一句话同屏两遍是噪声）；
     *   · 内联体／侧窗／挂载栏：那一行上已经有块名 ⇒ 也不写；
     *   · 整屏：抬头就是这一屏的标题 ⇒ 写。
     */
    this.els.title.hidden =
      embed || !query || this.deps.surface === 'inline' || this.deps.surface === 'dock' || this.deps.surface === 'mount'
    /**
     * **投影的抬头不在这里写**：它是构造时挂上的常驻编辑器（`TitleEditor`）。
     * 这里再写一次 `textContent` 就会把那一台正在打字的岛整个清掉。
     * 名字为空时由那台编辑器的占位句说明，不另挂 `data-empty-text`。
     */
    if (!embed) this.els.title.textContent = query ? (name === '' ? t('ui.query.untitled') : name) : ''
    // children 记录视图的**显示掩码**：一次求值，记录／组内记录／页签三处共用（`null` ＝ 无掩码）
    this.maskIds = !derived && src.kind === 'children' && view !== null ? maskIdsOf(view.filter, this.deps.kb) : null
    const n = this.rowCount()
    this.els.count.textContent = query ? t('ui.query.count', { count: n }) : t('ui.view.count', { count: n })
    // 「已隐藏 N 项」：筛掉 ≠ 删除，给一句实话；点击＝清除掩码（退路一眼可及）
    if (this.maskIds && src.kind === 'children') {
      const raw = childrenRecords(src.blockId, this.deps.kb).length
      const hidden = raw - this.records().length
      this.els.hiddenNote.hidden = hidden <= 0
      this.els.hiddenNote.textContent = t('ui.view.hidden', { count: String(hidden) })
      this.els.hiddenNote.dataset.tip = t('ui.view.hiddenClear')
    } else {
      this.els.hiddenNote.hidden = true
    }
    // 大纲折叠的次要文案由 `render()` 现算（它才知道这一屏画了几行）；其余分支没有折叠
    if (!query || view !== null) this.els.topCount.hidden = true
    this.els.refresh.hidden = !query
    /**
     * **镜头一个入口**：筛选/排序/分组/显示都从这一颗进——工具栏默认隐藏是刻意的：
     * 派生栏没有可写配置（看法/分组由设备状态回答，挂载区自己画）⇒ 不给这一颗。
     */
    this.els.optionsBtn.hidden = Boolean(derived)
    this.repaintOptions()
    // 派生栏是只读关系视图 ⇒ 不给新建/改名/刷新
    this.els.newRow.hidden = Boolean(derived) || query
    /**
     * 这一颗 `＋` 在两种表里长的是**不同的东西**：平表加一行（＝一个直接子块），
     * 结构映射表加一列（顶部多一个直接子块，它的孩子成为这一列的各项）。
     * 文案跟着视图走，不另开按钮。
     */
    const list = view?.kind === 'list-table'
    this.els.newRow.textContent = list ? t('ui.view.newColumn') : t('ui.view.newRow')
    this.els.newRow.dataset.tip = list ? t('ui.view.newColumnTitle') : t('ui.view.newRowTitle')
    this.paintStale()
    this.paintFilters(b)
    this.paintTree()
    this.paintViews(b, view)
  }

  /** `_tags` 的组名解析：标签块的显示名（列头与选项都从这一份走；兜底只有「无标题」一种） */
  private tagChoices(): readonly { id: string; label: string }[] {
    return this.deps.kb.tags().map((b) => ({ id: b.id, label: blockLabel(b, (x) => this.deps.kb.get(x)) }))
  }

  /**
   * **条件条**：条件树展开时它让位；收起之后只剩**一条**摘要 chip。
   *
   * 为什么不是始终一排 chip：条件树已经把每一条都摊开了，抬头再抄一遍就是同屏两遍。
   * 收起态的一条 chip 回答「这一屏是按什么选的」，点它再把树展开。
   */
  private paintFilters(b: Block): void {
    const box = this.els.filters
    box.replaceChildren()
    /**
     * **投影不画条件条**：它是一扇 168px 高的窗，条件那一条要占掉一整行；而条件属于源块
     * （点开构建器改的是所有人的查询）—— 一扇窗里给出一个「改所有人」的入口太远。
     */
    if (this.deps.surface === 'embed') {
      box.hidden = true
      return
    }
    /**
     * 派生栏的「条件」是**只读说明**：它不是用户配的条件，也没有可编辑的落点
     * （点开构建器只会得到一份不属于它的条件）。所以要留下一句话，但不做成按钮。
     */
    if (this.deps.derived) {
      // 条件由挂载区的抬头说（栏名旁边那排 chip）；这里再放一枚就是同屏两遍
      box.hidden = true
      return
    }
    const spec = this.source.kind === 'query' ? this.source.spec : null
    if (!spec) {
      box.hidden = true
      return
    }
    const anchor = this.anchorEl(spec)
    if (anchor) box.appendChild(anchor)
    const slice = this.sliceChip()
    if (this.treeAllowed() && isTreeOpen(this.writeOwner, this.deps.surface, this.treeTopLevel())) {
      // 树摊开时抬头不再重复**基础条件**；锚是控制不是条件的重复，切片也不在树里，都要显式给出
      if (slice || anchor) {
        box.hidden = false
        if (slice) box.appendChild(slice)
      } else {
        box.hidden = true
      }
      return
    }
    box.hidden = false
    if (this.treeAllowed()) {
      const summary = document.createElement('button')
      summary.type = 'button'
      summary.className = 'queryview-chip ui-ellipsis'
      summary.dataset.queryChip = 'summary'
      // 收起态要读得出「这一屏按什么选的」：拆得动就只给条件本身——
      // 「条件 · N 条」是在数数，条数抬头已有，重复一遍只是辅助文字。
      // 拆不动的形状 queryChips 会整块给「复合条件」，那时才退回到条数摘要。
      const labels = queryChips(spec, this.deps.fields(this.source.kind === 'query' ? this.source.spec : undefined), this.deps.choices, this.deps.refLabel, this.deps.tagLabel)
      summary.textContent = labels.length > 0 ? labels.join(' · ') : treeSummary(spec)
      // 抬头窄时省略几何走 ui-ellipsis 原语；title 给全文，不让「读得出内容」变成「读不全」
      summary.dataset.tip = summary.textContent
      summary.addEventListener('click', () => this.openTree())
      box.appendChild(summary)
      if (slice) box.appendChild(slice)
      return
    }
    // 没有内联树的面（投影／窄窗）：只列条件 chip；编辑入口在行首的「＋」
    for (const label of queryChips(spec, this.deps.fields(this.source.kind === 'query' ? this.source.spec : undefined), this.deps.choices, this.deps.refLabel, this.deps.tagLabel)) {
      const chip = document.createElement('span')
      // 单行省略是**原语**（`primitives.css`），组件里不再抄一份几何
      chip.className = 'queryview-chip ui-ellipsis'
      chip.textContent = label
      box.appendChild(chip)
    }
    if (slice) box.appendChild(slice)
    const edit = document.createElement('button')
    edit.type = 'button'
    edit.className = 'queryview-chip queryview-chip--edit'
    edit.textContent = '＋'
    edit.dataset.tip = t('ui.query.edit')
    edit.addEventListener('click', () => this.deps.invoke('core.query/open-builder', { owner: this.writeOwner }))
    box.appendChild(edit)
    void b
  }

  /**
   * 抬头上的**锚**：「今天」相对哪一天。只有条件里真有 `{today}`、且宿主是日记块时才出现
   * （没有相对日期的查询给这颗开关是噪声；宿主没有日期时它也无处锚）。
   *
   * 它写的是**基础条件**的 `todayFrom`（与条件树同一个 `set-spec` 路径）：
   * 锚改变的是哪些块命中——查询语义，不是看法配置。
   */
  private anchorEl(spec: QuerySpec): HTMLElement | null {
    if (!usesToday(spec.where)) return null
    if (this.hostDate() === undefined) return null
    const label = document.createElement('label')
    label.className = 'queryview-chip queryview-chip--anchor'
    label.dataset.tip = t('ui.query.usePageDateHint')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.dataset.queryChip = 'anchor'
    input.checked = spec.todayFrom === 'host'
    input.addEventListener('change', () => {
      const next: QuerySpec = { ...spec }
      if (input.checked) next.todayFrom = 'host'
      else delete next.todayFrom
      this.deps.invoke('core.query/set-spec', { owner: this.writeOwner, spec: next })
    })
    const text = document.createElement('span')
    text.textContent = t('ui.query.usePageDate')
    label.append(input, text)
    return label
  }

  /**
   * 抬头上的**切片**一格：与基础条件分开画，前缀写死「切片」。
   *
   * 合成一条 chip 会让「基础条件 ∩ 切片」看起来像一份条件；而用户改切片时
   * 需要知道自己在改的是叠加层，不是那份人人共享的基础条件。
   */
  private sliceChip(): HTMLElement | null {
    const filter = this.activeFilter
    if (!filter) return null
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'queryview-chip queryview-chip--slice ui-ellipsis'
    chip.dataset.queryChip = 'slice'
    chip.textContent = t('ui.view.sliceChip', { text: treeSummary({ where: filter }) })
    chip.dataset.tip = t('ui.view.sliceHint')
    // 基础条件那颗是按钮，这一颗也必须是按钮：切片存在时任何激活视图都能就地改，
    // 不必先绕进「视图…」菜单（同一个落点，两条路）
    const viewId = this.view?.id ?? ''
    const owner = this.bound.owner
    if (this.deps.openSlice) {
      chip.addEventListener('click', () => this.deps.openSlice?.(owner, viewId, chip.getBoundingClientRect()))
    }
    return chip
  }

  /* ---------------------------------------------------------- 快速筛选 */

  /**
   * 镜头面板的锚点：宽面贴图标；**右槽贴这一栏的左缘**。
   *
   * 右槽只有 320px（窄档 180px），拿图标矩形向左开仍会横跨整栏——面板会盖住
   * 下面的行。把锚点推到栏的左缘，面板整体落在主内容一侧，右槽的行保持可见。
   */
  private lensAnchor(btn: HTMLElement): DOMRect {
    if (this.deps.surface !== 'dock') return btn.getBoundingClientRect()
    const shell = this.els.root.closest('.dock-card') ?? this.els.root
    const box = shell.getBoundingClientRect()
    const rect = btn.getBoundingClientRect()
    return new DOMRect(box.left, rect.top, 0, rect.height)
  }

  /**
   * 镜头面板：**一个入口、四个轴**。宽面从图标下方开；右槽（`dock`）向主内容
   * 一侧开——320px 的列里放不下四节面板，弹层盖住结果就看不见「点一颗 chip 行怎么变」。
   */
  private openLens(): void {
    if (!this.deps.openLens) return
    const btn = this.els.optionsBtn
    this.deps.openLens({
      render: (host) => {
        // 旧断言按 `.queryview-optionspanel` 找面板；这个类只是浮层宿主的定位钩子，
        // 不带 `.queryview-sortpanel` 的边框/内距，样式仍由 `.vopt` 自己负责。
        host.classList.add('queryview-optionspanel', 'lenspop')
        this.optionsHost = host
        this.repaintOptions()
      },
      anchor: this.lensAnchor(btn),
      trigger: btn,
      placement: this.deps.surface === 'dock' ? 'left' : 'below',
      onClose: () => {
        this.optionsHost = null
      },
    })
  }

  /** 面板内容重画（配置一律现读；切视图/写配置后由 paintChrome 顺带调） */
  private repaintOptions(): void {
    const panel = this.optionsHost
    if (!panel) return
    if (!this.optionsUi) {
      this.optionsUi = new ViewOptionsPanel({
        owner: this.writeOwner,
        viewId: () => this.view?.id ?? '',
        read: () => ({
          view: this.view,
          source: this.source,
          filter: this.activeFilter,
          display: this.view ? this.view.displayProps : this.deps.owners.read(this.writeOwner)?.defaultDisplayProps,
          // 行首路径／分段是缺省层的两个位：seg 现读；不接这两条就永远停在「显示／不分段」
          pathsHidden: this.pathsHidden,
          pathsGrouped: !this.view && this.deps.owners.read(this.writeOwner)?.defaultGroup === PAGE_COLUMN,
        }),
        fields: () => this.deps.fields(this.source.kind === 'query' ? this.source.spec : undefined),
        records: () => this.records(),
        filterCandidates: () => this.filterCandidates(),
        atomLabel: (atom) => this.atomLabel(atom),
        cardinalityOf: (id) => this.cardinalityOf(id),
        invoke: (name, args) => this.deps.invoke(name, args),
        ...(this.deps.openChildProps ? { openChildProps: this.deps.openChildProps } : {}),
        ...(this.deps.openBuilder ? { openBuilder: this.deps.openBuilder } : {}),
        // 自定义编辑态的预选基线：表格＝计算列；rich 看法＝这批记录里真有值的键
        displayDefaults: () => {
          if (this.view?.kind === 'table') {
            return defaultDisplayPropsFor(this.source, this.deps.kb, { hits: this.frozen?.hits ?? [] })
          }
          const keys = new Set<string>()
          for (const r of this.records()) {
            for (const [k, val] of Object.entries(r.values)) {
              if (val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0)) keys.add(k)
            }
            if (r.tags.length > 0) keys.add(TAGS_COLUMN)
          }
          return [...keys]
        },
        afterApply: () => this.refocusBody(),
      })
    }
    if (this.optionsUi.root.parentElement !== panel) panel.replaceChildren(this.optionsUi.root)
    this.optionsUi.render()
  }

  /**
   * 候选来自**未筛**的结果集（`this.effective` 是基础条件 ∩ 切片；这里只跑基础条件）。
   *
   * 为什么不用手里那份冻结结果：它是筛过的。用它当候选源，排除一颗 chip 会让它
   * 自己从候选里消失、计数也会随手指变化——「摘掉一颗一切回来」就没了参照。
   * 只在打开面板时算一次（一次查询，5 万块约 5ms），不进绘制路径。
   */
  private filterCandidates(): readonly ViewRecord[] {
    const src = this.source
    if (src.kind !== 'query') return []
    return resolveRows(evaluateQuerySpec(src.spec, this.deps.kb, this.evalContext(src.spec)), this.deps.kb)
  }

  /**
   * chip 的显示名：页与标签都按 **id 现解析**（条件语言里 `{tag}` 存标签块 id，
   * 不存名字——名字会随改名失配）。
   *
   * 旧库里可能还留着按名字写的 tag atom（238 早期形状）：`kb.get` 查不到就原样
   * 当名字显示，不把它丢掉，也不露裸 id。目标没了才说「无标题」。
   */
  private atomLabel(atom: QuickFilterAtom): string {
    const id = 'tag' in atom ? atom.tag : atom.up.is
    const b = this.deps.kb.get(id)
    if (b) return blockLabel(b, (x) => this.deps.kb.get(x))
    if ('tag' in atom) return atom.tag
    return t('ui.page.untitled')
  }

  /** 条件树能不能落在这里（投影／派生栏没有可编辑的落点） */
  private treeAllowed(): boolean {
    if (this.deps.derived) return false
    if (this.deps.surface === 'embed') return false
    return this.source.kind === 'query'
  }

  /**
   * 这块查询是不是**整屏的根**（没有容器）。
   *
   * 判据用求值上下文：`contextFor` 对顶层拥有者给 `selfId = undefined`，
   * 嵌在页面里的查询块给它的父页。与 `surface` 分开：内联体在两种落点用的是同一个
   * surface（几何相同），「默认展开」只属于前者。
   */
  private treeTopLevel(): boolean {
    return this.deps.context.selfId === undefined
  }

  private openTree(): void {
    treeOpen.set(treeKeyOf(this.writeOwner, this.deps.surface), true)
    this.repaintChrome()
  }

  private closeTree(): void {
    treeOpen.set(treeKeyOf(this.writeOwner, this.deps.surface), false)
    this.repaintChrome()
  }

  /** 只重画抬头与条件树，不重建正文（打开/收起条件不该重置滚动与表格） */
  private repaintChrome(): void {
    this.paintChrome(this.deps.host(), this.defaultView())
  }

  /**
   * 应用条件之后把焦点交回正文。
   *
   * 为什么必须做：撤销的键位挂在 `editorTextFocus` 上；焦点留在「应用」按钮上时，
   * 用户按 ⌘Z 想撤掉刚应用的条件，按键却进不了编辑器。树仍常驻，再点一下就能继续改。
   */
  private refocusBody(): void {
    this.outline?.ed?.container.focus()
  }

  /**
   * 条件树：**就地展开**在抬头下一格。收起只是隐藏 DOM，草稿还在组件里；
   * 与旧弹层的区别写在这里：不是「点一下看一下」，而是和正文共用同一条竖线与缩进。
   */
  private paintTree(): void {
    const box = this.els.tree
    if (!this.treeAllowed()) {
      box.hidden = true
      return
    }
    const spec = this.source.kind === 'query' ? this.source.spec : null
    if (!spec) {
      box.hidden = true
      return
    }
    if (!this.treeUi) {
      this.treeUi = new QueryTree(box, {
        spec: () => (this.source.kind === 'query' ? this.source.spec : { where: { any: [] } }),
        fields: (batch) => this.deps.fields(batch),
        choices: (propId) => this.deps.choices?.(propId) ?? [],
        ...(this.ownerBlock() ? { owner: this.ownerBlock() } : {}),
        ...(this.deps.pickRef ? { pickRef: this.deps.pickRef } : {}),
        ...(this.deps.pickTag ? { pickTag: this.deps.pickTag } : {}),
        ...(this.deps.tagLabel ? { tagLabel: this.deps.tagLabel } : {}),
        ...(this.deps.pickChoice ? { pickChoice: this.deps.pickChoice } : {}),
        refLabel: this.deps.refLabel,
        apply: (next) => this.deps.invoke('core.query/set-spec', { owner: this.writeOwner, spec: next }),
        afterApply: () => this.refocusBody(),
        close: () => this.closeTree(),
        inline: true,
      })
    }
    const open = isTreeOpen(this.writeOwner, this.deps.surface, this.treeTopLevel())
    box.hidden = !open
    if (open) this.treeUi.render()
  }

  /**
   * 视图切换：**一个下拉**（当前看法 ＋ 其它视图 ＋ 新建…）。
   *
   * 为什么不是「每种 kind 一个按钮」：一个拥有者可以有**多个**同 kind 的视图（各自列/序不同），
   * 按 kind 放按钮就表达不了「第 2 张表」。
   * 为什么不是「每个视图一颗按钮」：视图一多，抬头就变成一排等宽的 tab，抢走条数与刷新
   * 的位置；而切换看法是低频动作，收进下拉更合适（菜单里同时给出「新建表格／卡片…」）。
   */
  private paintViews(b: Block, view: ViewConfig | null): void {
    const box = this.els.views
    box.replaceChildren()
    // 派生栏的看法切换器在挂载区抬头（这一层没有拥有者，不该画「新建视图」）
    if (this.deps.derived) {
      box.hidden = true
      return
    }
    /**
     * **露面（投影）只有一颗「看法」**，不是一排 tab。三条理由都在「tab 在这里必然错一半」：
     *   · tab 写的是**拥有者**（源块）的 `_activeView`（见 `writeOwner`），而这一次露面
     *     可能正钉在另一张视图上 ⇒ 点了没生效；
     *   · 就算没钉住，点一下也会连带改掉源的默认看法与所有「跟随」的露面 ——
     *     一扇窗不该有这么大的杀伤半径；
     *   · `_embed.view` 是**三格**（跟随源／固定大纲／某张命名视图），tab 条只能表达「一组」。
     * 所以这里只给入口，三格由 `core.view/menu` 在露面块上翻成 `_embed` 的菜单。
     */
    if (this.deps.surface === 'embed') {
      const embedId = this.deps.binding?.kind === 'embed' ? this.deps.binding.blockId : ''
      if (embedId === '') {
        box.hidden = true
        return
      }
      box.hidden = false
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'qv-view-btn'
      btn.textContent = t('ui.embed.viewChoice')
      btn.dataset.tip = t('ui.embed.viewChoiceHint')
      btn.addEventListener('click', () =>
        this.deps.invoke('core.view/menu', { owner: { kind: 'block', blockId: embedId } }),
      )
      box.appendChild(btn)
      return
    }
    const src = this.source
    if (src.kind !== 'query' && !hasLiveChildren(b) && !view) {
      // 叶子块没有可摊开的东西：不给入口（点了只会看到空表）
      box.hidden = true
      return
    }
    box.hidden = false
    const current = view === null ? t('ui.view.outline') : viewNameOf(view, (k) => t(`ui.view.kind.${k}`))
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'qv-view-btn qv-view-current'
    btn.dataset.viewCurrent = view?.id ?? ''
    btn.dataset.tip = t('ui.view.switchHint')
    const label = document.createElement('span')
    label.className = 'qv-view-current-label'
    label.textContent = current
    const caret = document.createElement('span')
    caret.className = 'qv-view-caret'
    renderIcon(caret, 'lucide:chevron-down', 'chevron-down')
    btn.append(label, caret)
    btn.addEventListener('click', () => {
      /**
       * 下拉＝**锚在这颗按钮下面的同一份「视图…」菜单**：大纲／已有视图／新建…
       * 都只有一张表（`openViewMenu`），这里不另拼一份行。
       * 拿不到宿主菜单时退回命令面（没有锚点，居中弹出）——仍然是同一条动作。
       */
      if (this.deps.openViewMenu) this.deps.openViewMenu(this.writeOwner, btn.getBoundingClientRect(), btn)
      else this.deps.invoke('core.view/menu', { owner: this.writeOwner })
    })
    box.appendChild(btn)
  }

  /* ---------------------------------------------------------- 分支 */

  private showOutline(): void {
    this.table?.dispose()
    this.table = null
    this.listTable?.dispose()
    this.listTable = null
    this.els.table.hidden = true
    this.els.table.replaceChildren()
    this.els.editor.hidden = false
    this.syncFoldAll()
    if (!this.outline) {
      const host = document.createElement('div')
      host.className = 'queryview-editor'
      host.spellcheck = false
      this.outline = new EditableBlock({
        host,
        store: this.deps.store,
        write: this.deps.write,
        // 冻结范围＝整片视图：焦点落在刷新/视图按钮上时，重画抬头会把正被按的那颗换掉
        area: this.els.root,
        // 查询结果的行是命中，不是「这一栏能长出块」：根只能往下长，不能并/搬出结果集
        structuralScope: 'roots',
        load: () => this.render(),
        wire: (editor, change) => this.deps.wire(editor, change),
        onChange: (kind) => {
          if (kind === 'struct') this.structureDirty = true
          this.deps.onChange()
        },
        onFocus: (editor) => this.deps.onFocus(editor),
        onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
        onContextBack: (rootId) => this.collapse(rootId),
        // 分段大纲的组头翻折叠（扣行重装走 render）
        onGroupToggle: (key) => {
          if (this.groupCollapsed.has(key)) this.groupCollapsed.delete(key)
          else this.groupCollapsed.add(key)
          this.render()
        },
      })
      this.outline.ensureEditor()
      this.els.editor.appendChild(this.outline.root)
    }
  }

  /** 大纲分支的编辑宿主（空态文案挂在它身上：`.queryview-editor[data-empty]`） */
  private get outlineHost(): HTMLElement | null {
    return this.outline?.host ?? null
  }

  private showBody(view: ViewConfig): void {
    this.outline?.dispose()
    this.outline = null
    this.els.editor.hidden = true
    this.syncFoldAll()
    this.els.editor.replaceChildren()
    /**
     * **分组对记录视图全量生效**：表格带 `groupBy` 时整批交给分组包装——
     * 「一个值一段」，段头是组名、段身还是那一 kind 自己的渲染器（表格分组＝一个
     * 属性值一张表）。多值键 fan-out（一块进每个所属组）；「未设置」收没有值的。
     */
    const want = view.kind
    const groupKey = want === 'table' ? (view.groupBy ?? '') : ''
    this.renderedGroupKey = groupKey
    if (groupKey !== '') {
      if (want !== 'table') {
        this.table?.dispose()
        this.table = null
      }
      if (!this.grouped) {
        this.grouped = new ViewGrouped({
          view: () => this.view ?? view,
          records: () => this.records(),
          choices: (id) => (id === '_tags' ? this.tagChoices() : this.deps.choices?.(id) ?? []),
          cardinalityOf: (id) => this.cardinalityOf(id),
          valueLabel: (propId, raw) => this.groupValueLabel(propId, raw),
          makeBody: (records) => this.buildTable(records, view),
        })
        this.els.table.replaceChildren(this.grouped.root)
      }
      this.grouped.render()
      return
    }
    if (this.grouped) {
      this.grouped.dispose()
      this.grouped = null
    }
    /**
     * 三条渲染器：表格（行＝记录、列＝属性）、结构映射表（表头＝直接子块、一列＝它的孩子）、
     * 它们**不共用**布局：平表有固定行高与窗口化，结构映射表按内容排。
     * 所以按 kind 各建各的实例，切走就 dispose（不藏一台还在订阅的）。
     */
    /**
     * 四条渲染器各建各的实例（切走就 dispose，不藏一台还在订阅的）：
     * `table`／`list-table`／`list`／（其余 kind 还没做，给一句实话）。
     */
    if (want !== 'table') {
      this.table?.dispose()
      this.table = null
    }
    if (want !== 'list-table') {
      this.listTable?.dispose()
      this.listTable = null
    }
    if (want !== 'cards') {
      this.cards?.dispose()
      this.cards = null
    }
    if (want !== 'tabs') {
      this.tabs?.dispose()
      this.tabs = null
    }
    if (want !== 'calendar') {
      this.calendar?.dispose()
      this.calendar = null
    }
    if (want !== 'mindmap') {
      this.mindmap?.dispose()
      this.mindmap = null
    }
    this.els.table.hidden = false
    if (want === 'cards') {
      if (!this.cards) {
        this.cards = new ViewCards({
          store: this.deps.store,
          records: () => this.records(),
          view: () => this.view ?? view,
          inspect: (blockId, propId) =>
            this.deps.invoke('core.block/inspect', { blockId, ...(propId ? { propId } : {}) }),
          refLabel: (id: string) => this.deps.refLabel(id),
          openUrl: (u) => this.deps.openUrl(u),
          choices: (id) => (id === '_tags' ? this.tagChoices() : this.deps.choices?.(id) ?? []),
          cardinalityOf: (id) => this.cardinalityOf(id),
          valueLabel: (propId, raw) => this.groupValueLabel(propId, raw),
          setValue: (blockId, propId, value) => this.deps.invoke('core.props/set-value', { blockId, propId, value }),
          clearValue: (blockId, propId) => this.deps.invoke('core.props/clear-value', { blockId, propId }),
          // 列尾「新建」的**可用性判据**：children 源的家是真的，永远兑现；
          // 查询源用「出生形态」的假块（只有列值、无引用、无父块）试一遍生效条件——
          // 命中才给按钮，按钮出现即兑现；不命中就不给，而不是给了再道歉
          canCreateAt: (propId, raw) => {
            const src = this.source
            if (src.kind !== 'query') return true
            const spec = this.effective
            if (!spec) return false
            const probe = mkBlock('')
            if (raw !== undefined && raw !== null) setValue(probe, propId, raw)
            const ctx = this.evalContext(spec)
            return this.deps.kb.matchesSpec(spec, probe, {
              selfId: ctx.selfId,
              excludeIds: ctx.excludeIds,
              ...(ctx.today ? { today: ctx.today } : {}),
            })
          },
          // 列尾「新建」：children 源直接建；查询源建完按当前生效条件重算一次——
          // 新卡没进结果就直说（卡在库里，不在这一列），不让「点了没出现」变成悬案
          insertValueCard: (propId, raw) => {
            const args = { owner: this.writeOwner, propId, ...(raw !== undefined && raw !== null ? { value: raw } : {}) }
            if (this.source.kind !== 'query') {
              this.deps.invoke('core.view/new-card', args)
              return
            }
            const before = new Set(this.frozen?.hits.map((h) => h.blockId) ?? [])
            this.deps.invoke('core.view/new-card', args)
            const spec = this.effective
            if (spec) {
              const fresh = freezeResult(spec, this.deps.kb, this.evalContext(spec), this.viewKey)
              this.frozen = fresh
              if (!fresh.hits.some((h) => !before.has(h.blockId))) {
                this.deps.toast?.(t('ui.cards.createdOutsideQuery'), 'info')
              }
            }
          },
          // 结构分组只接 children 源：组＝直接子块、记录＝它的孩子（query 命中是平的，没有一级）
          structureGroups: () => this.maskedGroups(),
          // 拖卡＝换父（结构与撤销都归命令层），不是写某个字段的值
          moveInto: (blockId, groupBlockId) =>
            this.deps.invoke('core.block/move-to', { blockId, targetId: groupBlockId }),
          // 加一张卡＝在组块末尾插一个子块（与大纲里 ↵＋Tab 同一条写路径）
          insertCard: (groupBlockId) =>
            this.deps.invoke('core.view/new-row', { owner: this.writeOwner, blockId: groupBlockId }),
          openBlock: (id, place) => this.deps.openBlock(id, place),
          cell: this.cell,
        })
        this.els.table.replaceChildren(this.cards.root)
      }
      this.cards.render()
      return
    }
    if (want === 'tabs') {
      if (!this.tabs) {
        this.tabs = new ViewTabs({
          store: this.deps.store,
          write: this.deps.write,
          // 页签＝直接子块（复用结构派生的那一遍遍历；查询源命中是平的，建不了页签视图）
          tabs: () => this.maskedTabs(),
          view: () => this.view ?? view,
          wire: (editor, change) => this.deps.wire(editor, change),
          onChange: () => this.deps.onChange(),
          onFocus: (editor) => this.deps.onFocus(editor),
          openBlock: (id, place) => this.deps.openBlock(id, place),
        })
        this.els.table.replaceChildren(this.tabs.root)
      }
      this.tabs.render()
      return
    }
    if (want === 'calendar') {
      if (!this.calendar) {
        this.calendar = new ViewCalendar({
          store: this.deps.store,
          records: () => this.records(),
          view: () => this.view ?? view,
          projectTitle: (r, into) => this.deps.project(r.block, into),
          openBlock: (id, place) => this.deps.openBlock(id, place),
          today: () => this.deps.today?.() ?? todayISO(),
        })
        this.els.table.replaceChildren(this.calendar.root)
      }
      this.calendar.render()
      return
    }
    if (want === 'mindmap') {
      if (!this.mindmap) {
        this.mindmap = new ViewMindmap({
          store: this.deps.store,
          root: () => {
            const src = this.source
            return src.kind === 'children' ? this.deps.kb.get(src.blockId) : undefined
          },
          view: () => this.view ?? view,
          projectTitle: (b, into) => this.deps.project(b, into),
          openBlock: (id, place) => this.deps.openBlock(id, place),
        })
        this.els.table.replaceChildren(this.mindmap.root)
      }
      this.mindmap.render()
      return
    }
    if (want === 'list-table') {
      if (!this.listTable) {
        this.listTable = new ViewListTable({
          store: this.deps.store,
          host: () => this.deps.host(),
          view: () => this.view ?? view,
          kb: this.deps.kb,
          cell: this.cell,
          openBlock: (id, place) => this.deps.openBlock(id, place),
          // 「加一项」就是往那一列（表头块）末尾插一个子块：与大纲里 ↵＋Tab 同一条写路径
          insertItem: (columnId) => this.deps.invoke('core.view/new-row', { owner: this.writeOwner, blockId: columnId }),
          deleteBlock: (id) => this.deps.invoke('core.view/delete-row', { rowId: id }),
        })
        this.els.table.replaceChildren(this.listTable.root)
      }
      this.listTable.render()
      return
    }
    if (!this.table) {
      this.table = this.buildTable(() => this.records(), view)
      this.els.table.replaceChildren(this.table.root)
    }
    this.table.render()
  }

  /** 表格的装配（同上：records 可换成某一组的；其余依赖与直连完全一致） */
  private buildTable(records: () => ViewRecord[], view: ViewConfig): ViewTable {
    return new ViewTable({
      store: this.deps.store,
      host: () => this.deps.host(),
      view: () => this.view ?? view,
      records,
      defs: () => this.deps.kb.propDefs(),
      defaults: () =>
        this.deps.derived?.displayProps ??
        defaultDisplayPropsFor(this.source, this.deps.kb, {
          hits: this.frozen?.hits ?? [],
        }),
      setValue: (blockId, propId, value) => this.deps.invoke('core.props/set-value', { blockId, propId, value }),
      clearValue: (blockId, propId) => this.deps.invoke('core.props/clear-value', { blockId, propId }),
      // 列宽是布局元数据（`table.widths`）：拖完一次写、一条撤销；派生栏没有可写配置 ⇒ 不给拖
      setWidth: this.deps.derived
        ? undefined
        : (key, width) =>
            this.deps.invoke('core.view/set-width', { owner: this.writeOwner, viewId: this.view?.id ?? '', key, width }),
      // 表头排序写**视图的显示序**：不重查、不改 `_query.sort`（成员只由条件/上限决定）
      // 派生栏没有可写的配置：排序只在这一屏内生效（切走回原序，不留第二真相）
      sort: (by, dir) => {
        if (this.deps.derived) {
          // 表头点击写**这一栏的镜头**：与面板里的排序是同一份，不另立屏内瞬态
          this.deps.derived.setSort?.(dir === '' ? [] : [{ by, dir: dir === 'desc' ? 'desc' : 'asc' }])
          return
        }
        // 表头点击＝写**第一键**：整份多键在排序面板里编辑
        this.deps.invoke('core.view/set-sort', {
          owner: this.writeOwner,
          viewId: this.view?.id ?? '',
          sort: dir === '' ? [] : [{ by, dir: dir === 'desc' ? 'desc' : 'asc' }],
        })
      },
      insertRow: () => this.deps.invoke('core.view/new-row', { owner: this.writeOwner }),
      deleteRow: (rowId) => this.deps.invoke('core.view/delete-row', { rowId }),
      openBlock: (id, place) => this.deps.openBlock(id, place),
      convertMention: (blockId, spot) => this.convertMention(blockId, spot),
      cell: this.cell,
      ...(this.deps.pickRef ? { pickRef: this.deps.pickRef } : {}),
      ...(this.deps.pickAsset ? { pickAsset: this.deps.pickAsset } : {}),
      refLabel: this.deps.refLabel,
      ...(this.deps.tagName ? { tagName: this.deps.tagName } : {}),
    })
  }

  /** 类型与数据形状先就位，渲染器随后（卡片/日历/导图）；这里给一句实话而不是空屏 */
  private paintBodyFallback(): void {
    this.els.table.replaceChildren()
    const p = document.createElement('p')
    p.className = 'tv-unsupported'
    p.textContent = t('ui.view.unsupported')
    this.els.table.appendChild(p)
  }

  /** 行（派生）：query＝命中（不折叠祖先）；children＝直接子块；items＝`_items` 解析到的活块 */
  /** 字段基数（多值键的唯一口径：卡片列排除、表格 fan-out） */
  private cardinalityOf(propId: string): 'one' | 'many' {
    return this.deps.fields(this.source.kind === 'query' ? this.source.spec : undefined).find((f) => f.id === propId)?.cardinality ?? 'one'
  }

  /**
   * **分组头/列头的值名解析**：问 core 的唯一判据（`propValueText`）——`ref` 的值
   * 是块 id，走 `refLabel`（目标没了兜「已删除」，那条链与检视卡同源）；其它 kind
   * 的值是字面量，翻不动原样回落。kind 按 kb 现读判（不依赖 `fields()` 的覆盖面）。
   */
  private groupValueLabel(propId: string, raw: unknown): string | undefined {
    // 所在页的值是页块 id：走 `refLabel` 一族（目标没了兜「已删除」，不露裸 id）
    if (propId === PAGE_COLUMN) return this.deps.refLabel(String(raw))
    const def = this.deps.kb.get(propId)
    return propValueText({ id: propId, ...(def ? { kind: propKindOf(def) } : {}) }, raw, {
      ...(this.deps.choices ? { choices: this.deps.choices } : {}),
      ...(this.deps.refLabel ? { refLabel: this.deps.refLabel } : {}),
    })
  }

  private records(): ViewRecord[] {
    if (this.deps.derived) return this.deps.derived.records()
    const src = this.source
    if (src.kind === 'query') return resolveRows(this.frozen?.hits ?? [], this.deps.kb)
    // children 记录视图的**显示掩码**（`paintChrome` 现算的命中集）：不匹配的行消失，
    // `children` 顺序一个字节不动；没有掩码时零开销
    const rows = childrenRecords(src.blockId, this.deps.kb)
    return this.maskIds ? rows.filter((r) => this.maskIds!.has(r.block.id)) : rows
  }

  /** 结构分组的组内记录过掩码（组是真实块，保留——空组还能拖卡进去） */
  private maskedGroups(): StructureGroup[] {
    const src = this.source
    const groups = src.kind === 'children' ? structureGroupsOf(src.blockId, this.deps.kb) : []
    if (!this.maskIds) return groups
    return groups.map((g): StructureGroup => ({ block: g.block, records: g.records.filter((r) => this.maskIds!.has(r.block.id)) }))
  }

  /** 页签过掩码：筛的是 **tab 自己**（那一个直接子块匹不匹配） */
  private maskedTabs(): StructureGroup[] {
    const src = this.source
    const groups = src.kind === 'children' ? structureGroupsOf(src.blockId, this.deps.kb) : []
    if (!this.maskIds) return groups
    return groups.filter((g) => this.maskIds!.has(g.block.id))
  }

  /**
   * 提及栏片段行的「转成引用」（表格的命中列）。
   *
   * 只在派生模式下有意义：派生栏的 host 就是提及的目标。走命令面——
   * 一条内容写、一次撤销；区间复核与「没转成」的实话都在命令那一步。
   */
  private convertMention(blockId: string, spot: { start: number; end: number }): void {
    if (!this.deps.derived) return
    this.deps.invoke('core.block/convert-mention', {
      blockId,
      to: this.deps.host().id,
      start: spot.start,
      end: spot.end,
    })
  }

  /* ---------------------------------------------------------- 大纲分支：查询结果 */

  /** 抬头上的「结果可能已过期」：只是提示，不改列表 */
  private paintStale(): void {
    const dirty = this.staleIds.size > 0
    this.els.stale.hidden = !dirty
    if (dirty) this.els.stale.textContent = t('ui.query.stale')
  }

  /**
   * 外部告诉视图「这些块变了」⇒ 若其中有当前结果里的成员，点亮「结果可能已过期」。
   *
   * ⚠️ 只点亮、**不重排**；真正移除发生在刷新时，并会 toast 说清移除了几条。
   */
  noteTouched(ids: readonly string[]): void {
    if (this.source.kind !== 'query') return
    const inResult = new Set((this.frozen?.hits ?? []).map((h) => h.blockId))
    let hit = false
    for (const id of ids) {
      if (inResult.has(id)) {
        this.staleIds.add(id)
        hit = true
      }
    }
    if (hit) this.paintStale()
  }

  /** 按冻结结果渲染**当前活块**（内容不冻） */
  private render(focusHint?: string): void {
    this.settleStructure()
    const b = this.deps.host()
    const src = this.source
    // children/items 源没有大纲分支（它们的默认看法不是大纲）
    if (src.kind !== 'query' && !isQueryBlock(b)) return
    if (src.kind !== 'query') return
    this.paintStale()
    if (!this.frozen) {
      this.renderEmpty(t('ui.query.noSpec'), true)
      return
    }
    const rows = resolveFrozen(this.frozen.hits, (id) => this.deps.kb.pathOf(id))
    this.els.root.hidden = false
    /**
     * **主数字永远是冻结结果（hits）的条数**，不是这一屏画出来的行数。
     *
     * 大纲会把「祖先与子孙同时命中」折叠成祖先一行（那是对的：同一块不该出现两遍），
     * 但折叠是**画法**，不是成员变了。曾经这里用 `rows.length` 覆盖抬头 ⇒
     * 同一个查询在大纲里写 1、在表格里写 2 —— 同一件事两个答案。
     * 折叠程度另给一句次要文案，主数字不动。
     */
    const hits = this.frozen.hits.length
    this.els.count.textContent = t('ui.query.count', { count: hits })
    if (rows.length !== hits) {
      this.els.topCount.hidden = false
      this.els.topCount.textContent = t('ui.query.topCount', { count: rows.length })
    } else {
      this.els.topCount.hidden = true
    }
    if (rows.length === 0) {
      // 空结果里没有可展开的东西：收起栈也一起清掉
      this.expanded = new Set()
      this.covers = new Map()
      this.rows = []
      // 空结果是**状态**不是错误：保留抬头（含刷新按钮），正文给一句实话。
      // 判据用**生效条件**（基础 ∩ 切片）：切片里有 `$self` 时「离开宿主为空」同样成立
      const spec = this.effective
      /**
       * 三种空要说成三句话（用户下一步做的事不同）：
       *   · 还没有条件 ⇒ 去加一条（新建的查询块一开始正是这样，不默认查全库）；
       *   · 条件里有 `$self` 但这一处没有宿主 ⇒ 换个地方看；
       *   · 有条件、只是没命中 ⇒ 这就是结果。
       * 前两种对用户是同一个状态（都是「还没写条件」），共用一句话与同一颗主动作。
       */
      const incomplete = !spec || isEmptyWhere(spec.where)
      const why = incomplete
        ? t('ui.query.noSpec')
        : usesSelf(spec.where)
          ? t('ui.mount.needsHost')
          : t('ui.query.empty')
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.outline?.ed?.loadPage({ roots: [], folded: this.outline.ed.doc.folded })
      const host = this.outlineHost
      if (host) {
        host.dataset.empty = '1'
        host.dataset.emptyText = why
      }
      this.paintEmptyAction(incomplete)
      return
    }
    if (this.outlineHost) delete this.outlineHost.dataset.empty
    // 只装「最外层命中」：子树由编辑器自己展开，命中块的祖先链作为行首面包屑。
    const contexts = new Map<string, readonly Block[]>()
    for (const r of rows) if (r.path.length > 0) contexts.set(r.block.id, r.path)
    const base = { roots: rows.map((r) => r.block), contexts }
    // 分段大纲：缺省层的分组键是「所在页」⇒ 按住处分桶、组头随装载；
    // 命名视图没有大纲，不存在视图层的同名格。派生面走挂载区自己的分组（设备态），不走这里
    const grouped =
      !this.deps.derived && !this.view && this.deps.owners.read(this.writeOwner)?.defaultGroup === PAGE_COLUMN
    let plan: ContextPlan
    let heads: GroupHead[] | undefined
    if (grouped) {
      const groups = pageGroupsOf(base)
      const collapsed = this.groupCollapsed
      heads = []
      const deferred: { key: string; label: string; count: number; openId?: string }[] = []
      const plans: ContextPlan[] = []
      for (const g of groups) {
        const label = this.pageGroupLabel(g.page)
        const key = g.page?.id ?? ''
        // 折叠组扣行：头锚到下一组的头一行；排在最后 ⇒ 哨兵（文档末尾）。
        // 锚与组键分开带：折叠路由认键，锚只管插位（真机抓到的「有时能折」就是拿锚当了键）
        if (collapsed.has(key)) {
          deferred.push({ key, label, count: g.roots.length, ...(g.page ? { openId: g.page.id } : {}) })
          continue
        }
        const p = expandContexts(
          { roots: g.roots, contexts: g.contexts },
          this.expanded,
          (id) => this.deps.kb.pathOf(id),
          focusHint,
        )
        const anchor = p.roots[0]?.id ?? ''
        for (const d of deferred) heads.push({ beforeRootId: anchor, key: d.key, label: d.label, count: d.count, collapsed: true, ...(d.openId ? { openId: d.openId } : {}) })
        deferred.length = 0
        if (anchor !== '') heads.push({ beforeRootId: anchor, key, label, count: g.roots.length, ...(g.page ? { openId: g.page.id } : {}) })
        plans.push(p)
      }
      for (const d of deferred) heads.push({ beforeRootId: '', key: d.key, label: d.label, count: d.count, collapsed: true, ...(d.openId ? { openId: d.openId } : {}) })
      plan = mergeContextPlans(plans)
    } else {
      plan = expandContexts(base, this.expanded, (id) => this.deps.kb.pathOf(id), focusHint)
    }
    this.expanded = plan.expanded
    this.covers = plan.covers
    this.rows = plan.roots
    const folded = unfoldForContext(this.outline?.ed?.doc.folded ?? {}, plan.covers, (id) => this.deps.kb.pathOf(id))
    this.outline?.ed?.loadPage({
      roots: plan.roots,
      folded,
      contexts: plan.contexts,
      expandedRoots: plan.contextRoots,
      // 行首路径关掉的装载：只关显示——上下文照算，「收起上下文」照画，重开不丢
      ...(this.pathsHidden ? { paths: false as const } : {}),
      // 分段大纲的组头：chrome 随装载走；不分组时缺省（undefined）＝没有组头
      ...(heads !== undefined && heads.length > 0 ? { groupHeads: heads } : {}),
    })
    if (plan.focusId) this.outline?.ed?.reveal(plan.focusId)
    this.syncFoldAll()
  }

  /** 普通点面包屑：把祖先装成这一栏的根（中心／历史不动） */
  private expand(ancestorId: string, rowId: string): void {
    if (!ancestorId) return
    this.expanded.add(ancestorId)
    this.render(rowId || undefined)
  }

  /** 收起一层：内层还留在栈里，下一次渲染会浮出来 */
  private collapse(rootId: string): void {
    if (!this.expanded.delete(rootId)) return
    this.render(this.covers.get(rootId)?.[0])
  }

  /* ------------------------------------------------------ 全部展开／全部收起 */

  /** 顶层行里**有子块**的那些：只有它们折起来才有可见效果 */
  private topFoldable(): string[] {
    return this.rows.filter((b) => hasLiveChildren(b)).map((b) => b.id)
  }

  /** 顶层行里还有展开着的吗（决定按钮此刻该说「收起」还是「展开」） */
  private anyTopExpanded(): boolean {
    const folded = this.outline?.ed?.doc.folded ?? {}
    return this.topFoldable().some((id) => !folded[id])
  }

  /**
   * **只作用于顶层行**（用户定：不递归到所有层——连嵌套块一起收掉不是他要的）。
   *
   * 直接写 `doc.folded` 再 `render()`，而不是循环 `toggleCollapse`：后者每行一次 `renderAll()`，
   * 而 `doc.folded` 本来就是持久状态 —— 这么写之后用户手动展开某一行仍能叠加在上头。
   *
   * ⚠️ **不动上下文链**：`render()` 里的 `unfoldForContext` 会在这份基线上把覆盖到的祖先再展开一遍，
   *    所以「收起全部」不会顺手收掉面包屑那几层 —— 那几层归上下文管，不归这个按钮管。
   */
  private toggleFoldAll(): void {
    const ed = this.outline?.ed
    if (!ed) return
    const ids = this.topFoldable()
    if (ids.length === 0) return
    const next: FoldState = { ...ed.doc.folded }
    if (this.anyTopExpanded()) for (const id of ids) next[id] = true
    else for (const id of ids) delete next[id]
    ed.doc.folded = next
    this.render()
  }

  /**
   * 按钮的**可见与文案**。非大纲视图下隐藏 —— 那里没有行折叠，
   * 显示了就是一个点了没反应的按钮（比不显示更糟：用户会以为它坏了）。
   */
  private syncFoldAll(): void {
    const on = !this.els.editor.hidden && this.topFoldable().length > 0
    this.els.foldAll.hidden = !on
    if (!on) return
    this.els.foldAll.textContent = this.anyTopExpanded() ? t('ui.query.foldAll') : t('ui.query.unfoldAll')
  }

  private renderEmpty(text: string, canAdd = false): void {
    this.expanded = new Set()
    this.covers = new Map()
    // 空态没有行可折：顶层行清空，按钮随之隐藏
    this.rows = []
    this.els.root.hidden = false
    this.els.title.hidden = false
    /**
     * 投影的抬头是**常驻可编辑的源块名**（构造时挂的 `TitleEditor`）：空态文案放进
     * 条数那格说，不抢标题 —— 抢了它，源的名字就没地方显示、也没法写了。
     */
    if (this.deps.surface !== 'embed') this.els.title.textContent = text
    this.els.count.textContent = this.deps.surface === 'embed' ? text : ''
    this.els.editor.hidden = false
    this.syncFoldAll()
    const host = this.outlineHost
    if (host) {
      host.dataset.empty = '1'
      host.dataset.emptyText = text
    }
    this.paintEmptyAction(canAdd)
  }

  /**
   * 空态的主动作（「还没有条件」句下的那颗）：点击就地展开条件树。
   * 只有树开得了的面才显示——开不了树的面（投影／派生栏）挂一颗点了没反应的按钮，
   * 比不显示更糟。「没有匹配」「没有宿主」没有缺步可补，不显示；
   * 改条件的入口在抬头已有的条件 chip 上。
   */
  private paintEmptyAction(canAdd: boolean): void {
    const show = canAdd && this.treeAllowed()
    this.els.emptyAdd.hidden = !show
    if (show) this.els.editor.appendChild(this.els.emptyAdd)
  }
}
