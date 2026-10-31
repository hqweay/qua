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
  isQueryBlock,
  itemsRecords,
  listTableOf,
  readSpec,
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
  type Block,
  type BlockStore,
  type FrozenResult,
  type QueryContext,
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
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t, type MsgId } from '../core/msg.ts'
import { BlockEditor, type Run } from '../view/editor.ts'
import { BlockCell } from './block-cell.ts'
import { EditableBlock } from './editable-block.ts'
import { queryChips } from './query-builder.ts'
import { ViewBoard } from './view-board.ts'
import { ViewCalendar } from './view-calendar.ts'
import { ViewGallery } from './view-gallery.ts'
import { ViewList } from './view-list.ts'
import { ViewMindmap } from './view-mindmap.ts'
import { ViewListTable } from './view-list-table.ts'
import { ViewTable } from './view-table.ts'

/** 默认看法的临时 id（不落盘：它代表「这一份源没有激活视图」这件事本身） */
const DEFAULT_VIEW_ID = 'view-default'

/** 保留列在列表里的字段名（属性列走 `deps.fields()`） */
const RESERVED_FIELD_LABEL: Record<string, MsgId> = {
  tags: 'ui.props.tagsTitle',
  children: 'ui.view.childrenCount',
  created: 'ui.props.createdAt',
  modified: 'ui.props.modifiedAt',
  path: 'ui.view.col.path',
  refCount: 'ui.view.col.refCount',
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
   *    linked tab／露面只存「指向谁 ＋ 选了哪张视图」，自己不拥有配置。
   */
  owner: ViewOwnerRef
  /** 绑定：这一次「在别处看一眼」的指针（linked tab／露面） */
  binding?: ViewBindingRef
  /**
   * 显示的宿主块（活引用）。
   *
   * 三处用到它，都不是配置：抬头上的名字、children/items 源的容器、
   * 以及「这一块是不是叶子块」（叶子没有可摊开的东西 ⇒ 不给视图切换器）。
   */
  host: () => Block
  /** 求值的上下文：`$self` 指谁、`subtree` 锚在哪、结果剔除谁 */
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
  /** 标题列的投影（run/marks/引用/图片）——由装配层注入，`ui` 不拿整片森林 */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick: (hit: { to: string; runId?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  /** 打开一块（行首块标 / 紧凑列表） */
  openBlock: (blockId: string) => void
  /** `ref` 值的选择器（与属性区同一份） */
  pickRef?: (owner: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  refLabel?: (targetId: string) => string
  /** 标签名解析（`select` 选项显示名里的 `#名`） */
  tagName?: (id: string) => string
  /** 可选的属性定义（构建器的字段下拉；按显示名排好，`ui` 不扫森林） */
  fields: () => readonly { id: string; label: string }[]
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
  /** 条件 chip 条（查询源才有；点击＝打开构建器） */
  filters: HTMLElement
  refresh: HTMLButtonElement
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
  const newRow = document.createElement('button')
  newRow.type = 'button'
  newRow.className = 'queryview-newrow'
  newRow.hidden = true
  head.append(title, count, topCount, stale, filters, views, refresh, newRow)

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

  root.append(head, body)
  return { root, head, title, count, topCount, filters, views, refresh, newRow, stale, editor, table }
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
  private staleIds = new Set<string>()
  /** 上下文展开栈（祖先 id）；刷新时清空，外部编辑重画时保留 */
  private expanded = new Set<string>()
  /** 上次渲染的「上下文根 → 覆盖的命中行」：收起一层时滚回那一行 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 配置坏了只提示一次（每次装载都弹一遍会盖住用户正在做的事） */
  private warned = false
  /** **这一个表面实例**的冻结结果；条件/上下文变了才重算 */
  private frozen: FrozenResult | null = null
  /** 派生栏在这一屏内的显示排序（表面状态：不进库、不同步） */
  private derivedSort: SortKey[] = []
  /** 派生栏的「整片重算」防抖计时器（成员可能新增，局部修补不够） */
  private derivedTimer: number | null = null

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
    this.cell = new BlockCell({
      store: deps.store,
      write: deps.write,
      wire: (ed, change) => deps.wire(ed, change),
      onFocus: (ed) => deps.onFocus(ed),
      onChange: () => deps.onChange(),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, el, mods),
      ...(deps.onAtomClick ? { onAtomClick: deps.onAtomClick } : {}),
      openBlock: (id) => deps.openBlock(id),
    })

    // ⚠️ 只点亮 stale，不重排列表（「不自动重算」）。
    // 拿不到「动过哪些块」就先不点亮：宁可少提示，也不要因为刷新顺带的重渲染误报。
    this.offStale = deps.store.subscribe((source, ids) => {
      if (source === this.outline?.ed) return
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
         * 没有那条路径 —— 订阅是它们唯一的回声。`sync()` 只在 spec/context 真变时
         * 重查，改视图不会重冻成员。
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

  /** 视图宿主的根（装配层把它放进那一段的段尾槽） */
  get root(): HTMLElement {
    return this.els.root
  }

  /**
   * **折起这个视图体**：只藏不卸载（冻结结果与滚动位置还在）。
   *
   * 折叠的判据（`Doc.folded`）在编辑器那一侧；这里只负责把结果落到 DOM，
   * 与正文内联体用同一个 `data-folded` 契约（CSS 只认这一格）。
   */
  setFolded(folded: boolean): void {
    if (folded) this.els.root.dataset.folded = '1'
    else delete this.els.root.dataset.folded
  }

  /** 大纲分支的编辑器（没有就在；表格分支下是 `null`） */
  get editor(): BlockEditor | null {
    return this.outline?.ed ?? null
  }

  dispose(): void {
    this.offStale()
    if (this.derivedTimer !== null) clearTimeout(this.derivedTimer)
    this.derivedTimer = null
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

  /** 拥有者的当前配置（每次现读：它可能被命令改过） */
  private get data(): ViewOwnerData {
    return this.bound.data
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

  /** 拥有者那一块（露面／linked tab 指的目标；local tab 没有块 ⇒ `undefined`） */
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
   * 冻结结果：**只在四种情况下重算**。
   *
   * 条件变了（编辑/撤销 ⇒ `specKey` 变）会自动重算 ⇒ 不会出现「旧条件 ＋ 新结果」。
   * ⚠️ 这里**不写块**：结果与 `modified` 无关，也不进撤销栈。
   */
  private ensureFrozen(): void {
    const src = this.source
    if (src.kind !== 'query') return
    if (!frozenStale(this.frozen, src.spec, this.deps.context)) return
    const before = this.frozen?.hits ?? []
    this.frozen = freezeResult(src.spec, this.deps.kb, this.deps.context)
    const dropped = droppedFrom(before, this.frozen.hits)
    if (dropped.length > 0 && before.length > 0) {
      this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
    }
  }

  /** 刷新按钮：**只重算这一个实例**（别的表面各自持有自己的那份，不受影响） */
  refresh(): void {
    this.els.refresh.disabled = true
    try {
      const src = this.source
      if (src.kind !== 'query') return
      const before = this.frozen?.hits ?? []
      this.frozen = freezeResult(src.spec, this.deps.kb, this.deps.context)
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
    if (src.kind === 'items') return this.records().length
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
    this.els.title.hidden = !query || this.deps.surface === 'inline' || this.deps.surface === 'dock'
    this.els.title.textContent = query ? (name === '' ? t('ui.query.untitled') : name) : ''
    const n = this.rowCount()
    this.els.count.textContent = query ? t('ui.query.count', { count: n }) : t('ui.view.count', { count: n })
    // 大纲折叠的次要文案由 `render()` 现算（它才知道这一屏画了几行）；其余分支没有折叠
    if (!query || view !== null) this.els.topCount.hidden = true
    this.els.refresh.hidden = !query
    // items 源的行是「引用」，不是这里能长出来的子块 ⇒ 不给「新建一行」（列表自己有「加一条」）
    // 派生栏是只读关系视图 ⇒ 也不给新建/改名/刷新
    this.els.newRow.hidden = Boolean(derived) || query || src.kind === 'items'
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
    this.paintViews(b, view)
  }

  /**
   * **条件 chip 条**：把当前条件说成人话，点击打开构建器。
   *
   * 为什么要有它：一个查询块的抬头只写「3 条结果」时，用户不知道这 3 条是**按什么选的**。
   * 条件是这个视图最要紧的一句话，它得在屏幕上，而不是藏在某个菜单里。
   * 非查询源没有这一条（children／items 的「条件」就是树本身）。
   */
  private paintFilters(b: Block): void {
    const box = this.els.filters
    box.replaceChildren()
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
    box.hidden = false
    // 上下文：scope 决定「相对于谁」（这一块之下 / 全库）—— 它不在条件里，但影响结果
    const ctx = document.createElement('button')
    ctx.type = 'button'
    ctx.className = 'queryview-chip queryview-chip--ctx'
    ctx.textContent = spec.scope === 'all' ? t('ui.query.contextAll') : t('ui.query.context')
    ctx.title = t('ui.query.edit')
    ctx.addEventListener('click', () => this.deps.invoke('core.query/open-builder', { owner: this.writeOwner }))
    box.appendChild(ctx)

    for (const label of queryChips(spec, this.deps.fields())) {
      const chip = document.createElement('span')
      // 单行省略是**原语**（`primitives.css`），组件里不再抄一份几何
      chip.className = 'queryview-chip ui-ellipsis'
      chip.textContent = label
      box.appendChild(chip)
    }
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
   * 视图切换：**默认看法 ＋ 已保存的视图 ＋ 「＋」**。
   *
   * 为什么不是「每种 kind 一个按钮」：一个拥有者可以有**多个**同 kind 的视图（各自列/序不同），
   * 按 kind 放按钮就表达不了「第 2 张表」。这里列的是这个拥有者自己的视图实例。
   */
  private paintViews(b: Block, view: ViewConfig | null): void {
    const box = this.els.views
    box.replaceChildren()
    // 派生栏的看法切换器在挂载区抬头（这一层没有拥有者，不该画「＋新建视图」）
    if (this.deps.derived) {
      box.hidden = true
      return
    }
    const src = this.source
    if (src.kind !== 'query' && b.children.length === 0 && !view) {
      // 叶子块没有可摊开的东西：不给入口（点了只会看到空表）
      box.hidden = true
      return
    }
    box.hidden = false
    const btn = (label: string, active: boolean, onClick: () => void): HTMLButtonElement => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'qv-view-btn'
      if (active) el.dataset.active = '1'
      el.textContent = label
      el.addEventListener('click', onClick)
      return el
    }
    // 默认看法的名字按源给：items 源没有大纲（它不是树），它叫「列表」
    const defaultLabel = src.kind === 'items' ? t('ui.view.kind.list') : t('ui.view.outline')
    box.appendChild(
      btn(defaultLabel, view === null, () =>
        this.deps.invoke('core.view/set-active', { owner: this.writeOwner, viewId: '' }),
      ),
    )
    for (const v of this.data.views) {
      box.appendChild(
        btn(viewNameOf(v, (k) => t(`ui.view.kind.${k}`)), view?.id === v.id, () =>
          this.deps.invoke('core.view/set-active', { owner: this.writeOwner, viewId: v.id }),
        ),
      )
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'qv-view-btn qv-view-add'
    add.title = t('ui.view.addView')
    add.textContent = '＋'
    /**
     * 不再是「一键加平表」：切换器旁边那颗 `＋` 现在是**新建视图的入口**，
     * 与块菜单里的「视图…」同一个菜单（两种表都从那里建，入口只有一份）。
     */
    add.addEventListener('click', () => this.deps.invoke('core.view/menu', { owner: this.writeOwner }))
    box.appendChild(add)
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
    // items 源才有行操作：`_items` 是「一批引用」，加/摘/拖都只写它
    const itemsId = this.source.kind === 'items' ? this.source.blockId : ''
    this.outline?.dispose()
    this.outline = null
    this.els.editor.hidden = true
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
          openBlock: (id) => this.deps.openBlock(id),
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
          openBlock: (id) => this.deps.openBlock(id),
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
          openBlock: (id) => this.deps.openBlock(id),
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
          openBlock: (id) => this.deps.openBlock(id),
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
          openBlock: (id) => this.deps.openBlock(id),
          // items 源的三件事：加一条／摘一条／拖一下，都只写 `_items`
          ...(itemsId !== ''
            ? {
                addItem: () => this.deps.invoke('core.collection/pick', { collectionId: itemsId }),
                removeItem: (id: string) =>
                  this.deps.invoke('core.collection/remove', { collectionId: itemsId, blockId: id }),
                moveItem: (id: string, to: number) =>
                  this.deps.invoke('core.collection/move', { collectionId: itemsId, blockId: id, to }),
              }
            : {}),
          toast: (text, kind) => this.deps.toast?.(text, kind),
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
          // 段尾宿主：容器就是这一屏的根，页面标题已经在上面写着它 ⇒ 不再重复一句表标题
          showCaption: false,
          openBlock: (id) => this.deps.openBlock(id),
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
        openBlock: (id) => this.deps.openBlock(id),
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
    if (src.kind === 'items') return itemsRecords(src.blockId, this.deps.kb)
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
      // 空结果是**状态**不是错误：保留抬头（含刷新按钮），正文给一句实话。
      const spec = readSpec(b)
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
    const folded = unfoldForContext(this.outline?.ed?.doc.folded ?? {}, plan.covers, (id) => this.deps.kb.pathOf(id))
    this.outline?.ed?.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) this.outline?.ed?.reveal(plan.focusId)
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

  private renderEmpty(text: string): void {
    this.expanded = new Set()
    this.covers = new Map()
    this.els.root.hidden = false
    this.els.title.hidden = false
    this.els.title.textContent = text
    this.els.count.textContent = ''
    this.els.editor.hidden = false
    const host = this.outlineHost
    if (host) {
      host.dataset.empty = '1'
      host.dataset.emptyText = text
    }
  }
}
