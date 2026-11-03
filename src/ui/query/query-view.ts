/**
 * **视图宿主**：一个**拥有者**的「怎么看」这一层（center／mount 两种表面共用）。
 *
 * 三种源、一套壳（与 `core/view.ts` 的判据同一处）：
 *
 * | 源 | 抬头 | 正文 |
 * |---|---|---|
 * | **query**（查询块／local tab） | 名字 ＋ 条数 ＋ 「可能已过期」＋ 刷新 ＋ 视图切换 | 大纲＝一列命中；表格＝同一批命中 |
 * | **children**（普通块，激活了视图） | 条数 ＋ 视图切换 ＋ 新建一行 | 表格（直接子块＝行）；切回大纲就没有这一层 |
 * | **items**（收藏块） | 条数 ＋ 视图切换 ＋ 加一条 | 列表（默认）／表格…；没有大纲（它不是树） |
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
  defaultColumnsForSource,
  fieldTextOf,
  displayNameOf,
  expandContexts,
  hasLiveChildren,
  isQueryBlock,
  listTableOf,
  resolveRows,
  resolveFrozen,
  resolveBoundView,
  sourceOf,
  unfoldForContext,
  usesSelf,
  viewsBroken,
  viewNameOf,
  droppedFrom,
  freezeResult,
  frozenStale,
  readViewSet,
  defaultKindFor,
  todayISO,
  slicedSpec,
  type Block,
  type FoldState,
  type OpenPlace,
  type BlockStore,
  type FrozenResult,
  type QueryContext,
  type QuerySpec,
  type Source,
  type ViewBindingRef,
  type ViewColumn,
  type DerivedViewKind,
  type SortKey,
  type ViewConfig,
  type ViewOwnerData,
  type ViewOwnerRef,
  type ViewOwnerStore,
  type ViewRecord,
  type ViewSurface,
  type PropKind,
} from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import { BlockEditor, type Run } from '../../view/editor/editor.ts'
import { renderIcon } from '../../view/icons.ts'
import { BlockCell } from '../block-ui/block-cell.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { queryChips } from './query-builder.ts'
import { QueryTree, treeSummary } from './query-tree.ts'
import { ViewBoard } from '../views/view-board.ts'
import { ViewCalendar } from '../views/view-calendar.ts'
import { ViewGallery } from '../views/view-gallery.ts'
import { ViewList } from '../views/view-list.ts'
import { ViewMindmap } from '../views/view-mindmap.ts'
import { ViewListTable } from '../views/view-list-table.ts'
import { ViewTable } from '../views/view-table.ts'

/** 默认看法的临时 id（不落盘：它代表「这一份源没有激活视图」这件事本身） */
const DEFAULT_VIEW_ID = 'view-default'

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

/** 保留列在列表里的字段名（属性列走 `deps.fields()`） */
const RESERVED_FIELD_LABEL: Record<string, MsgId> = {
  tags: 'ui.props.tagsTitle',
  children: 'ui.view.childrenCount',
  created: 'ui.props.createdAt',
  modified: 'ui.props.modifiedAt',
  path: 'ui.view.col.path',
  refCount: 'ui.view.col.refCount',
  relKinds: 'ui.view.col.relKinds',
  via: 'ui.view.col.via',
  matched: 'ui.view.col.matched',
  sharedTags: 'ui.view.col.sharedTags',
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
  surface: ViewSurface
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
  openViewMenu?: (owner: ViewOwnerRef, anchor: DOMRect) => void
  /**
   * **打开切片构建器**（抬头切片 chip 的落点）。
   *
   * 与「视图… → 编辑切片…」是同一台浮层：切片存在时任何视图都能就地改，
   * 不必先绕进菜单。`anchor` 取 chip 的矩形，浮层贴着它弹。
   */
  openSlice?: (owner: ViewOwnerRef, viewId: string, anchor: DOMRect | null) => void
  /** 标题列的投影（run/marks/引用/图片）——由装配层注入，`ui` 不拿整片森林 */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick: (hit: { to: string; runId?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  /** 打开一块（行首块标 / 紧凑列表） */
  openBlock: (blockId: string, place?: OpenPlace) => void
  /** `ref` 值的选择器（与属性区同一份） */
  pickRef?: (owner: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  refLabel?: (targetId: string) => string
  /** 标签名解析（`select` 选项显示名里的 `#名`） */
  tagName?: (id: string) => string
  /** 可选的属性定义（条件树的字段下拉；按显示名排好，`ui` 不扫森林） */
  fields: () => readonly { id: string; label: string; kind?: PropKind }[]
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
  /** 本轮只开列表与表格（大纲走挂载区自己的那一支） */
  kind: 'list' | 'table'
  /** 现算的一批记录（已带派生列） */
  records: () => ViewRecord[]
  /** 表格列 / 列表字段：**临时构造**，不落盘 */
  columns: ViewColumn[]
  listFields: string[]
  /** 切看法写哪（设备状态；由装配层落地） */
  setKind: (kind: DerivedViewKind) => void
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
  /** 条件 chip 条（查询源才有；收起时只剩一条摘要） */
  filters: HTMLElement
  /** 条件树（就地展开；与抬头同属这一段，不是浮层） */
  tree: HTMLElement
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
  const title = document.createElement('span')
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
  head.append(title, count, topCount, stale, filters, views, refresh, foldAll, newRow)

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

  root.append(head, tree, body)
  return { root, head, tree, title, count, topCount, filters, views, refresh, foldAll, newRow, stale, editor, table }
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
  /** 记录列表分支（query／children／items 三种源都接） */
  private list: ViewList | null = null
  /** 看板／画廊／日历／导图：各建各的实例（切走就 dispose） */
  private board: ViewBoard | null = null
  private gallery: ViewGallery | null = null
  private calendar: ViewCalendar | null = null
  private mindmap: ViewMindmap | null = null
  /** 这一屏现在画的是谁：`outline` 或激活视图的 id（变了才换分支） */
  private mode = ''
  private readonly cell: BlockCell
  /** 查询视图自己的 stale 订阅（只点亮提示、不重排——冻结成员是 D4） */
  private readonly offStale: () => void
  /** 条件树（查询源；懒建，收起只隐藏不清空草稿） */
  private treeUi: QueryTree | null = null
  private staleIds = new Set<string>()
  /** 上下文展开栈（祖先 id）；刷新时清空，外部编辑重画时保留 */
  private expanded = new Set<string>()
  /** 上次渲染的「上下文根 → 覆盖的命中行」：收起一层时滚回那一行 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 配置坏了只提示一次（每次装载都弹一遍会盖住用户正在做的事） */
  private warned = false
  /** **这一个表面实例**的冻结结果；条件／视图／上下文变了才重算 */
  private frozen: FrozenResult | null = null
  /** 派生栏在这一屏内的显示排序（表面状态：不进库、不同步） */
  private derivedSort: SortKey[] = []
  /** 派生栏的「整片重算」防抖计时器（成员可能新增，局部修补不够） */
  private derivedTimer: number | null = null
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
     * 这一台宿主画的是**哪个拥有者**的身体。
     *
     * 用途只有一处：切视图之后，装配层要回答「此刻有没有表面在画它」——
     * 有就**就地重画**（每个 ViewHost 都订阅拥有者的配置），没有才把这一块打开。
     * 认 DOM 里这一格、不另建一张「哪些块正被画着」的登记表：登记表漏一次 dispose
     * 就会永远说「画着」，而它不报错，只表现为「切了视图，点了没反应」。
     */
    if (deps.owner.kind === 'block') this.els.root.dataset.viewOwner = deps.owner.blockId
    // 派生栏的抬头由挂载区画（它要说清这一栏是什么）；这一层只借渲染器
    if (deps.derived) this.els.head.hidden = true
    this.els.refresh.textContent = t('ui.query.refresh')
    this.els.refresh.addEventListener('click', () => this.refresh())
    this.els.newRow.textContent = t('ui.view.newRow')
    this.els.newRow.title = t('ui.view.newRowTitle')
    this.els.newRow.addEventListener('click', () => this.deps.invoke('core.view/new-row', { owner: this.writeOwner }))
    this.els.foldAll.addEventListener('click', () => this.toggleFoldAll())
    this.cell = new BlockCell({
      store: deps.store,
      write: deps.write,
      wire: (ed, change) => deps.wire(ed, change),
      onFocus: (ed) => deps.onFocus(ed),
      onChange: () => deps.onChange(),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, el, mods),
      ...(deps.onAtomClick ? { onAtomClick: deps.onAtomClick } : {}),
      openBlock: (id, place) => deps.openBlock(id, place),
    })

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
      if (source === this.outline?.ed) {
        const spec = this.effective
        if (spec && frozenStale(this.frozen, spec, this.deps.context, this.viewKey)) {
          this.sync()
        }
        return
      }
      /**
       * 派生栏是**只读关系视图**：新引用/新提及/新标签都可能让成员增减，
       * 只按 id 修补已有行不够 ⇒ 防抖整片重算（不冻结、不标 stale）。
       */
      if (this.deps.derived) {
        if (this.derivedTimer !== null) clearTimeout(this.derivedTimer)
        this.derivedTimer = window.setTimeout(() => {
          this.derivedTimer = null
          this.sync(true)
        }, 120)
        return
      }
      if (ids && ids.length > 0) {
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
        // children/items 源是活的：子块的正文/属性变了，那一行要跟着变（按 blockId 局部修补）
        if (this.table) this.table.sync(ids)
        if (this.listTable) this.listTable.render(ids)
        // 列表没有局部修补（它的行就是记录本身）：整表重画，反正只画看得见的那几行
        if (this.list) this.list.render()
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

  dispose(): void {
    this.offStale()
    if (this.derivedTimer !== null) clearTimeout(this.derivedTimer)
    this.derivedTimer = null
    this.treeUi = null
    this.outline?.dispose()
    this.outline = null
    this.table?.dispose()
    this.table = null
    this.listTable?.dispose()
    this.listTable = null
    this.list?.dispose()
    this.list = null
    this.board?.dispose()
    this.board = null
    this.gallery?.dispose()
    this.gallery = null
    this.calendar?.dispose()
    this.calendar = null
    this.mindmap?.dispose()
    this.mindmap = null
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
    return slicedSpec(src.spec, this.view?.filter)
  }

  /**
   * 冻结键里的视图位：切片住在视图上 ⇒ 换一张视图必须重算，
   * 哪怕两份条件串看起来一样（两张都无切片的视图也该各自冻各自的那一份）。
   */
  private get viewKey(): string {
    return this.view?.id ?? ''
  }

  /**
   * 派生栏的临时视图配置：**只有渲染需要的两样**（列／字段 ＋ 这一屏的排序）。
   *
   * 不落盘、不复制：派生栏没有 `_views`。排序也只在这一次露面里活着（切走就回原序）——
   * 承认「派生栏的排序是设备状态」会顺手给它造一份配置，而它本来什么都没有。
   */
  private derivedView(): ViewConfig {
    const d = this.deps.derived!
    if (d.kind === 'list') return { id: 'derived:list', kind: 'list', list: { fields: [...d.listFields] } }
    return {
      id: 'derived:table',
      kind: 'table',
      table: { columns: d.columns.map((c) => ({ ...c })), ...(this.derivedSort.length > 0 ? { sort: this.derivedSort } : {}) },
    }
  }

  /**
   * **这一份源的默认看法**（没有激活视图时用它画）。
   *
   * 它是一张**临时** `ViewConfig`（id 固定、不落盘）：`items` 源的默认是「列表」，
   * 而列表需要一个 `kind` 才知道画成什么。写回库里的只有用户在切换器里**真的新建**的那些。
   *
   * ⚠️ `children`／`query` 的默认是**大纲**，那条分支不走这里（大纲没有配置可言）。
   */
  private defaultView(): ViewConfig | null {
    if (this.deps.derived) return this.derivedView()
    if (this.bound.view) return this.bound.view
    const src = this.source
    if (defaultKindFor(src) !== 'list') return null
    return { id: DEFAULT_VIEW_ID, kind: 'list' }
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
    if (view?.kind === 'list-table') this.listTable?.render()
    else if (view?.kind === 'list') this.list?.render()
    else if (view?.kind === 'board') this.board?.render()
    else if (view?.kind === 'gallery') this.gallery?.render()
    else if (view?.kind === 'calendar') this.calendar?.render()
    else if (view?.kind === 'mindmap') this.mindmap?.render()
    else if (view?.kind === 'table') this.table?.sync()
    else if (view) this.paintBodyFallback()
    else this.render()
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
    if (!frozenStale(this.frozen, spec, this.deps.context, this.viewKey)) return
    const before = this.frozen?.hits ?? []
    this.frozen = freezeResult(spec, this.deps.kb, this.deps.context, this.viewKey)
    const dropped = droppedFrom(before, this.frozen.hits)
    if (dropped.length > 0 && before.length > 0) {
      this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
    }
  }

  /** 刷新按钮：**只重算这一个实例**（别的表面各自持有自己的那份，不受影响） */
  refresh(): void {
    this.els.refresh.disabled = true
    try {
      const spec = this.effective
      if (!spec) return
      const before = this.frozen?.hits ?? []
      this.frozen = freezeResult(spec, this.deps.kb, this.deps.context, this.viewKey)
      const dropped = droppedFrom(before, this.frozen.hits)
      // 刷新＝成员与顺序都换了：上一轮的上下文展开没有依据，从头来
      this.expanded = new Set()
      this.covers = new Map()
      this.staleIds.clear()
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
    this.els.title.hidden =
      embed ? false : !query || this.deps.surface === 'inline' || this.deps.surface === 'dock' || this.deps.surface === 'mount'
    this.els.title.textContent =
      embed || query ? (name === '' ? t('ui.query.untitled') : name) : ''
    const n = this.rowCount()
    this.els.count.textContent = query ? t('ui.query.count', { count: n }) : t('ui.view.count', { count: n })
    // 大纲折叠的次要文案由 `render()` 现算（它才知道这一屏画了几行）；其余分支没有折叠
    if (!query || view !== null) this.els.topCount.hidden = true
    this.els.refresh.hidden = !query
    // 派生栏是只读关系视图 ⇒ 不给新建/改名/刷新
    this.els.newRow.hidden = Boolean(derived) || query
    /**
     * 这一颗 `＋` 在两种表里长的是**不同的东西**：平表加一行（＝一个直接子块），
     * 结构映射表加一列（顶部多一个直接子块，它的孩子成为这一列的各项）。
     * 文案跟着视图走，不另开按钮。
     */
    const list = view?.kind === 'list-table'
    this.els.newRow.textContent = list ? t('ui.view.newColumn') : t('ui.view.newRow')
    this.els.newRow.title = list ? t('ui.view.newColumnTitle') : t('ui.view.newRowTitle')
    this.paintStale()
    this.paintFilters(b)
    this.paintTree()
    this.paintViews(b, view)
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
      box.hidden = false
      const chip = document.createElement('span')
      chip.className = 'queryview-chip ui-ellipsis'
      chip.textContent = this.deps.derived.explain
      box.appendChild(chip)
      return
    }
    const spec = this.source.kind === 'query' ? this.source.spec : null
    if (!spec) {
      box.hidden = true
      return
    }
    const slice = this.sliceChip()
    if (this.treeAllowed() && isTreeOpen(this.writeOwner, this.deps.surface, this.treeTopLevel())) {
      // 树摊开时抬头不再重复**基础条件**；切片不在树里，仍要显式标出
      if (slice) {
        box.hidden = false
        box.appendChild(slice)
      } else {
        box.hidden = true
      }
      return
    }
    box.hidden = false
    if (this.treeAllowed()) {
      const summary = document.createElement('button')
      summary.type = 'button'
      summary.className = 'queryview-chip'
      summary.dataset.queryChip = 'summary'
      summary.textContent = treeSummary(spec)
      summary.title = t('ui.query.edit')
      summary.addEventListener('click', () => this.openTree())
      box.appendChild(summary)
      if (slice) box.appendChild(slice)
      return
    }
    // 没有内联树的面（投影／窄窗）：只列条件 chip；编辑入口在行首的「＋」
    for (const label of queryChips(spec, this.deps.fields(), this.deps.choices, this.deps.refLabel)) {
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
    edit.title = t('ui.query.edit')
    edit.addEventListener('click', () => this.deps.invoke('core.query/open-builder', { owner: this.writeOwner }))
    box.appendChild(edit)
    void b
  }

  /**
   * 抬头上的**切片**一格：与基础条件分开画，前缀写死「切片」。
   *
   * 合成一条 chip 会让「基础条件 ∩ 切片」看起来像一份条件；而用户改切片时
   * 需要知道自己在改的是叠加层，不是那份人人共享的基础条件。
   */
  private sliceChip(): HTMLElement | null {
    const filter = this.view?.filter
    if (!filter) return null
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'queryview-chip queryview-chip--slice ui-ellipsis'
    chip.dataset.queryChip = 'slice'
    chip.textContent = t('ui.view.sliceChip', { text: treeSummary({ where: filter }) })
    chip.title = t('ui.view.sliceHint')
    // 基础条件那颗是按钮，这一颗也必须是按钮：切片存在时任何激活视图都能就地改，
    // 不必先绕进「视图…」菜单（同一个落点，两条路）
    const view = this.view
    const owner = this.bound.owner
    if (view && this.deps.openSlice) {
      chip.addEventListener('click', () => this.deps.openSlice?.(owner, view.id, chip.getBoundingClientRect()))
    }
    return chip
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
        fields: () => this.deps.fields(),
        choices: (propId) => this.deps.choices?.(propId) ?? [],
        ...(this.ownerBlock() ? { owner: this.ownerBlock() } : {}),
        ...(this.deps.pickRef ? { pickRef: this.deps.pickRef } : {}),
        ...(this.deps.refLabel ? { refLabel: this.deps.refLabel } : {}),
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
   * 的位置；而切换看法是低频动作，收进下拉更合适（菜单里同时给出「新建表格／列表…」）。
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
      btn.title = t('ui.embed.viewChoiceHint')
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
    btn.title = t('ui.view.switchHint')
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
      if (this.deps.openViewMenu) this.deps.openViewMenu(this.writeOwner, btn.getBoundingClientRect())
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
        load: () => this.render(),
        wire: (editor, change) => this.deps.wire(editor, change),
        onChange: () => this.deps.onChange(),
        onFocus: (editor) => this.deps.onFocus(editor),
        onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
        onContextBack: (rootId) => this.collapse(rootId),
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
     * 三条渲染器：表格（行＝记录、列＝属性）、结构映射表（表头＝直接子块、一列＝它的孩子）、
     * 记录列表（M3）。它们**不共用**布局：平表有固定行高与窗口化，结构映射表按内容排。
     * 所以按 kind 各建各的实例，切走就 dispose（不藏一台还在订阅的）。
     */
    /**
     * 四条渲染器各建各的实例（切走就 dispose，不藏一台还在订阅的）：
     * `table`／`list-table`／`list`／（其余 kind 还没做，给一句实话）。
     */
    const want = view.kind
    if (want !== 'table') {
      this.table?.dispose()
      this.table = null
    }
    if (want !== 'list-table') {
      this.listTable?.dispose()
      this.listTable = null
    }
    if (want !== 'list') {
      this.list?.dispose()
      this.list = null
    }
    if (want !== 'board') {
      this.board?.dispose()
      this.board = null
    }
    if (want !== 'gallery') {
      this.gallery?.dispose()
      this.gallery = null
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
    if (want === 'board') {
      if (!this.board) {
        this.board = new ViewBoard({
          store: this.deps.store,
          records: () => this.records(),
          view: () => this.view ?? view,
          fieldLabel: (id) => this.deps.fields().find((f) => f.id === id)?.label ?? id.slice(-6),
          choices: (id) => this.deps.choices?.(id) ?? [],
          setValue: (blockId, propId, value) => this.deps.invoke('core.props/set-value', { blockId, propId, value }),
          clearValue: (blockId, propId) => this.deps.invoke('core.props/clear-value', { blockId, propId }),
          projectTitle: (r, into) => this.deps.project(r.block, into),
          openBlock: (id, place) => this.deps.openBlock(id, place),
        })
        this.els.table.replaceChildren(this.board.root)
      }
      this.board.render()
      return
    }
    if (want === 'gallery') {
      if (!this.gallery) {
        this.gallery = new ViewGallery({
          store: this.deps.store,
          records: () => this.records(),
          view: () => this.view ?? view,
          projectTitle: (r, into) => this.deps.project(r.block, into),
          openBlock: (id, place) => this.deps.openBlock(id, place),
        })
        this.els.table.replaceChildren(this.gallery.root)
      }
      this.gallery.render()
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
    if (want === 'list') {
      if (!this.list) {
        this.list = new ViewList({
          store: this.deps.store,
          records: () => this.records(),
          view: () => this.view ?? view,
          fieldLabel: (id) => {
            const reserved = RESERVED_FIELD_LABEL[id]
            if (reserved) return t(reserved)
            return this.deps.fields().find((f) => f.id === id)?.label ?? id.slice(-6)
          },
          projectTitle: (r, into) => this.deps.project(r.block, into),
          project: (r, key, into) => {
            into.textContent = fieldTextOf(r, key, (v) =>
              typeof v === 'string' && this.deps.refLabel ? this.deps.refLabel(v) : null,
            )
          },
          openBlock: (id, place) => this.deps.openBlock(id, place),
        })
        this.els.table.replaceChildren(this.list.root)
      }
      this.list.render()
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
      this.table = new ViewTable({
        store: this.deps.store,
        host: () => this.deps.host(),
        view: () => this.view ?? view,
        records: () => this.records(),
        defs: () => this.deps.kb.propDefs(),
        defaults: () =>
          this.deps.derived?.columns.map((c) => ({ ...c })) ??
          defaultColumnsForSource(this.source, this.deps.kb, {
            hits: this.frozen?.hits ?? [],
          }),
        setValue: (blockId, propId, value) => this.deps.invoke('core.props/set-value', { blockId, propId, value }),
        clearValue: (blockId, propId) => this.deps.invoke('core.props/clear-value', { blockId, propId }),
        // 表头排序写**视图的显示序**：不重查、不改 `_query.sort`（成员只由条件/上限决定）
        // 派生栏没有可写的配置：排序只在这一屏内生效（切走回原序，不留第二真相）
        sort: (by, dir) => {
          if (this.deps.derived) {
            this.derivedSort = dir === '' ? [] : [{ by, dir: dir === 'desc' ? 'desc' : 'asc' }]
            this.sync(true)
            return
          }
          this.deps.invoke('core.view/set-sort', { owner: this.writeOwner, viewId: this.view?.id ?? '', by, dir })
        },
        insertRow: () => this.deps.invoke('core.view/new-row', { owner: this.writeOwner }),
        deleteRow: (rowId) => this.deps.invoke('core.view/delete-row', { rowId }),
        openBlock: (id, place) => this.deps.openBlock(id, place),
        cell: this.cell,
        ...(this.deps.pickRef ? { pickRef: this.deps.pickRef } : {}),
        ...(this.deps.refLabel ? { refLabel: this.deps.refLabel } : {}),
        ...(this.deps.tagName ? { tagName: this.deps.tagName } : {}),
      })
      this.els.table.replaceChildren(this.table.root)
    }
    this.table.render()
  }

  /** 类型与数据形状先就位，渲染器随后（列表/看板/画廊/日历/导图）；这里给一句实话而不是空屏 */
  private paintBodyFallback(): void {
    this.els.table.replaceChildren()
    const p = document.createElement('p')
    p.className = 'tv-unsupported'
    p.textContent = t('ui.view.unsupported')
    this.els.table.appendChild(p)
  }

  /** 行（派生）：query＝命中（不折叠祖先）；children＝直接子块；items＝`_items` 解析到的活块 */
  private records(): ViewRecord[] {
    if (this.deps.derived) return this.deps.derived.records()
    const src = this.source
    if (src.kind === 'query') return resolveRows(this.frozen?.hits ?? [], this.deps.kb)
    return childrenRecords(src.blockId, this.deps.kb)
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
    const b = this.deps.host()
    const src = this.source
    // children/items 源没有大纲分支（它们的默认看法不是大纲）
    if (src.kind !== 'query' && !isQueryBlock(b)) return
    if (src.kind !== 'query') return
    this.paintStale()
    if (!this.frozen) {
      this.renderEmpty(t('ui.query.noSpec'))
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
      const why = spec && usesSelf(spec.where) ? t('ui.mount.needsHost') : t('ui.query.empty')
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.outline?.ed?.loadPage({ roots: [], folded: this.outline.ed.doc.folded })
      const host = this.outlineHost
      if (host) {
        host.dataset.empty = '1'
        host.dataset.emptyText = why
      }
      return
    }
    if (this.outlineHost) delete this.outlineHost.dataset.empty
    // 只装「最外层命中」：子树由编辑器自己展开，命中块的祖先链作为行首面包屑。
    const contexts = new Map<string, readonly Block[]>()
    for (const r of rows) if (r.path.length > 0) contexts.set(r.block.id, r.path)
    const plan = expandContexts(
      { roots: rows.map((r) => r.block), contexts },
      this.expanded,
      (id) => this.deps.kb.pathOf(id),
      focusHint,
    )
    this.expanded = plan.expanded
    this.covers = plan.covers
    this.rows = plan.roots
    const folded = unfoldForContext(this.outline?.ed?.doc.folded ?? {}, plan.covers, (id) => this.deps.kb.pathOf(id))
    this.outline?.ed?.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
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

  private renderEmpty(text: string): void {
    this.expanded = new Set()
    this.covers = new Map()
    // 空态没有行可折：顶层行清空，按钮随之隐藏
    this.rows = []
    this.els.root.hidden = false
    this.els.title.hidden = false
    this.els.title.textContent = text
    this.els.count.textContent = ''
    this.els.editor.hidden = false
    this.syncFoldAll()
    const host = this.outlineHost
    if (host) {
      host.dataset.empty = '1'
      host.dataset.emptyText = text
    }
  }
}
