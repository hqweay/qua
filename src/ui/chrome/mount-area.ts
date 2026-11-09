/**
 * **块的挂载区**：块底那一栏「引用／同类／提及 ＋ 用户挂的查询」，一条 tab 条 ＋ 一个 body。
 *
 * 三条口径落在这一层：
 *   · **一个编辑器，N 个 loader**：切 tab 只换 `loadPage` 的 roots。编辑器不重建，
 *     所以撤销栈与选区都不丢（重建一次，用户按 ⌘Z 就只能撤到「刚切过 tab」）。
 *   · **tab 不是块**：`local` 栏自己拥有条件与视图（不建块、也不指向块），
 *     `derived` 栏每次现算。增删交给装配层的命令
 *     （「写到哪一格」是模型层的事：块宿主写 `_mounts`、日记宿主写设备状态）。
 *   · **空栏仍在**：栏在、body 里一行说明。空是**状态**不是错误，把栏藏掉
 *     会让用户以为「这块没有引用」，而真相是「还没有人引用它」。
 *
 * ## 稳定 id
 *
 * 每栏有一个稳定 `id`（内置栏 `d-<source>`、用户栏 `t-<hex>`）；数组位只表示顺序。
 * 激活项／展开栈／视图体都按 `id` 记 —— 用**数组下标**当下标的后果是
 * 摘掉第一栏之后 active 与展开栈全体漂到别一栏上，而不报错。
 *
 * 编辑器装配（建实例、订阅、防抖重载、聚焦冻结、离焦补做、事件表）全部在
 * `EditableBlock` 里；这一层只决定**装哪些根**（哪一栏、展开到哪层、面包屑怎么给）。
 *
 * ⚠️ 与右槽的分工：右槽的 `backrefsCard` 是**页级派生卡**（读当前对象、跟着它走），
 *    判据与这里的「引用」栏**同源**（都走 `derivedRecordsOf`），差别只在落点：
 *    槽里是「另一处的摘要」，这里是「在这一块下面就地展开」。
 *    硬统一会得到两份各自记激活项的 tab 条。
 * ⚠️ 这里不碰命令、不认识浮层：`＋`／`×` 只回调装配层。
 */
import {
  applyQuickFilter,
  canEditMounts,
  cardinalityOf,
  derivedRecordsOf,
  derivedSpecOf,
  displayNameOf,
  groupChoicesOf,
  displayTextOf,
  expandContexts,
  hasLiveChildren,
  isJournal,
  mentionSpotsOf,
  mountEntriesOf,
  outermostHits,
  passThroughRefTarget,
  propDisplayLabels,
  readViewSet,
  unfoldForContext,
  EMPTY_QUICK_FILTER,
  quickFilterAdd,
  quickFilterDrop,
  type Block,
  type BlockStore,
  type DerivedSource,
  type DerivedViewKind,
  type MountEntry,
  type MountHost,
  type QuickFilterAtom,
  type QuickFilterState,
  type ViewOwnerStore,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import type { FoldState } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t, type MsgId } from '../../core/infra/msg.ts'
import { type BlockEditor, type Run } from '../../view/editor/editor.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { clearHits, offsetAtPoint, paintHits, rangeAtSpan, spanAt, type PlainSpan } from '../../view/editor/hit-paint.ts'
import { claimHighlightKey, releaseHighlightKey } from '../search/highlight-key.ts'
import { bindDropTarget, setDragTab } from '../../view/dnd.ts'
import { renderIcon } from '../../view/icons.ts'
import { placeNear } from '../overlay/place.ts'
import { renderQuickFilter } from './quick-filter.ts'

/** 一处浮层锚点（只读的矩形形状；`DOMRect` 与普通对象都能喂） */
type AnchorRect = { left: number; top: number; right: number; bottom: number }

/** 非大纲那一栏的**视图体**（由装配层造：只有那里有完整依赖） */
export interface ViewBodyHost {
  root: HTMLElement
  mount(): void
  sync(): void
  dispose(): void
}

export interface MountAreaDeps {
  store: BlockStore
  /** 写入事务入口：执行者在装配层，这里只原样转给编辑器（见 `Run`） */
  write: Run
  /** 读门面：三栏的数据都按 id 取（反链查表、查询走索引、祖先链按 id 现读） */
  kb: KbClient
  /** 视图配置的唯一接缝（读拥有者/绑定） */
  owners: ViewOwnerStore
  /** 日记宿主的那一组（设备状态；由装配层从 prefs 取） */
  journalMounts: () => readonly MountEntry[]
  /** 宿主块（＝这一段段根）。段被换掉/收掉时由装配层丢弃实例 */
  host: () => Block | undefined
  /** 编辑器里的编辑：落盘 */
  onChange: (kind: string) => void
  /** 获得焦点（编辑器已建好才可能发生）：装配层把「活动编辑器」切过来 */
  onFocus: (editor: BlockEditor) => void
  /**
   * **接上与正文同一套编辑器事件**（点引用/点块标/右键块菜单/`#`·`@` 补全…）。
   *
   * 为什么是「接一份」而不是在这里一项一项写：这些编辑器是同一种东西，
   * 差别只在装载谁。分散着接就会漏（漏了也不报错：面板里点引用不跳、右键没菜单）。
   * 事件表本身在装配层只有一份（`viewEvents`）。
   */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 「＋」：由装配层弹一个选择器（本层不知道浮层长什么样） */
  onAddTab?: (hostId: string) => void
  /**
   * **「复制为查询栏」**：把一栏内置项的条件物化成 local 栏（可改条件、可加视图）。
   *
   * 模板（条件＋默认视图）在 core 的 `derivedTemplateOf`；这一层只报
   * 「哪个宿主的哪个来源、锚点在哪」，写与激活都在装配层。
   * `openTree`：物化完直接摊开新栏的条件树（手势承诺「改条件」就一步够到）。
   */
  onMaterializeTab?: (hostId: string, source: DerivedSource, anchor: DOMRect, opts?: { openTree?: boolean }) => void
  /** 「×」：摘掉一栏（`tabId` 是**稳定 id**，不是数组下标） */
  onRemoveTab?: (host: MountHost, tabId: string) => void
  /**
   * **双击改名**（只有 local 栏有名字；派生栏的名字由来源字典给）。
   *
   * 输入框在装配层弹：这一层不认识浮层、也不碰命令。`anchor` 是那一栏的矩形
   * —— 浮层贴着用户点的那个 tab，而不是屏幕中央（「改的是哪一个」由位置回答）。
   */
  onRenameTab?: (host: MountHost, tabId: string, anchor: DOMRect) => void
  /**
   * **拖拽换序**：把 `tabId` 挪到 `targetId` 的前／后。
   *
   * 顺序＝那一格数组的位次（`_mounts` / `Prefs.journalMounts`），写内容、可撤销。
   * 派生栏与用户栏可以互相越位（派生栏落进去的只是一条位置标记）。
   * 与改名同一个形状：这一层只报「谁挪到了谁旁边」，写哪一格与命令都在装配层。
   */
  onMoveTab?: (host: MountHost, tabId: string, targetId: string, place: 'before' | 'after') => void
  /**
   * 派生栏现在选了什么看法（**设备状态**：没有拥有者）。
   *
   * 由装配层现读 `Prefs`；这一层不碰偏好，也不写它 —— 写走 `setDerivedKind`。
   */
  derivedKind?: (host: Block, source: DerivedSource) => DerivedViewKind
  /** 切派生栏的看法（装配层写设备状态并重画这一栏） */
  setDerivedKind?: (host: Block, source: DerivedSource, kind: DerivedViewKind) => void
  /** 这一栏现在的分组键（设备状态，与看法同层；'' ＝ 没分组） */
  derivedGroup?: (host: Block, source: DerivedSource) => string
  /** 换分组键（同上：装配层落设备状态并重画） */
  setDerivedGroup?: (host: Block, source: DerivedSource, key: string) => void
  /**
   * 派生栏的看法下拉（与自定义查询的「视图…」同壳：同一台浮层）。
   * 这一栏只有三档可切——大纲／列表／表格，没有可新建的东西。
   */
  openDerivedViewMenu?: (anchor: DOMRect | null, current: DerivedViewKind, onPick: (kind: DerivedViewKind) => void) => void
  /**
   * 浮层外壳（快速筛选的 chips 弹层住在这里面）。装配层持有浮层实例，这一层
   * 不认识它的落位与生命周期——窄接口只收「画进哪、锚在哪」，够用。
   */
  openPopover?: (
    render: (host: HTMLElement) => void,
    anchor: DOMRect | null | (() => DOMRect | null),
    /** 这次打开的触发者；给了它，同一触发者再点一次＝收起（toggle，见 `layers.openPopover`） */
    trigger?: { el?: HTMLElement; key?: string },
  ) => void
  /**
   * 这一栏非大纲时用的视图体（local 栏可以有表格等看法）。
   *
   * 返回 `null` ⇒ 这一栏画大纲。由装配层造，因为「求值的上下文」与「写事务的 source」
   * 只有那一层答得出来。
   */
  createView?: (host: Block, entry: MountEntry) => ViewBodyHost | null
  /**
   * **命令面**：⌥ 单击命中字要「转为引用」，走的仍是 `core.block/convert-mention`
   * （一次内容写、可撤销）。这一层不认识命令表，只报「谁、哪一段、指向谁」。
   */
  invoke: (name: string, args: Record<string, unknown>) => void
  /**
   * 初始是否展开。日记流里只有今天展开，更早的天是一行摘要（一行 DOM ＋ 不建编辑器）。
   */
  expanded?: boolean
}

/** 一栏装载什么：根块 ＋ 每个根行的面包屑（祖先链，不含自己） */
interface MountRoots {
  roots: Block[]
  contexts: Map<string, readonly Block[]>
}

export const BUILTIN_LABEL: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.refs',
  members: 'ui.mount.members',
  same: 'ui.mount.same',
  mentions: 'ui.mount.mentions',
}

const EMPTY_TEXT: Record<MountEntry['kind'], MsgId> = {
  derived: 'ui.mount.empty.user',
  local: 'ui.mount.empty.user',
}

/** 派生栏空态：三种来源各自说一句实话（「还没有人引用它」≠「条件没匹配」） */
const DERIVED_EMPTY: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.empty.refs',
  members: 'ui.mount.empty.members',
  same: 'ui.mount.empty.same',
  mentions: 'ui.mount.empty.mentions',
}

/** 派生栏的**只读**条件说明（它没有条件可编辑，也没有构建器落点） */
const DERIVED_WHY: Record<DerivedSource, MsgId> = {
  refs: 'ui.mount.why.refs',
  members: 'ui.mount.why.members',
  same: 'ui.mount.why.same',
  mentions: 'ui.mount.why.mentions',
}

/**
 * 提及栏的命中区间：从**派生记录**里原样搬出来。
 *
 * 为什么不再按词重搜：`derivedRecordsOf` 已经为每条记录算过 `mentionSpots`
 * （纯文本段、可切引用的那几处）。按词重搜会得到「看起来一样、但不是能转的那一处」的一批区间——
 * 高亮与「转引用」必须认同一处。
 */
function mentionSpansOf(records: readonly ViewRecord[]): ReadonlyMap<string, readonly PlainSpan[]> {
  const out = new Map<string, readonly PlainSpan[]>()
  for (const r of records) {
    const spots = r.derived?.['mentionSpots'] as readonly PlainSpan[] | undefined
    if (spots && spots.length > 0) out.set(r.block.id, spots)
  }
  return out
}

export class MountArea {
  readonly root: HTMLElement
  private readonly deps: MountAreaDeps
  /** tab 条（展开时可见） */
  private readonly tabsEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly editorEl: HTMLElement
  /** 非大纲那一栏的视图体槽 */
  private readonly viewEl: HTMLElement
  private readonly emptyEl: HTMLElement
  /**
   * 派生栏的抬头：`引用 · 12 条  [大纲] [列表] [表格]  ⋯`。
   *
   * 为什么要它（而不是复用视图宿主那条抬头）：派生栏没有拥有者 —— 抬头里的
   * 「这一栏是什么」是它唯一能说清自己的地方，而「切看法」写的是设备状态。
   */
  private readonly derivedHeadEl: HTMLElement
  /** 折叠时那一行摘要（只有「引用 N」——同类／提及的计数要现算，折叠时不值得算） */
  private readonly summaryEl: HTMLButtonElement
  /**
   * 那**一个**编辑器装配。懒建由它自己管：折叠的天、空的栏不建实例（30 天 feed
   * 只该有一个编辑器），建了就一直复用（切 tab 不重建 ⇒ 撤销栈与选区都不丢）。
   */
  private readonly block: EditableBlock
  private entries: MountEntry[] = []
  /** 当前激活那一栏的 **id**；找不到（栏被摘掉了）就回落到第一栏 */
  private active = ''
  private open: boolean
  /**
   * 每栏的**上下文展开栈**（祖先 id），按 `id` 记。视图状态，不落盘。
   * 每栏各记各的：在「引用」里展开的上下文不会突然出现在「同类」。
   */
  private readonly expandedByTab = new Map<string, Set<string>>()
  /** 上次装载的「上下文根 → 覆盖的命中行」；收起一层时用它算滚回哪 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /**
   * 哪些派生栏已经播过「关联型默认折叠」（**按栏记**：一个编辑器 N 个 loader，
   * 切 tab 只换 roots、编辑器不重建，所以 `doc.folded` 是几栏共用的）。
   */
  private readonly foldSeeded = new Set<string>()
  /** 这一段是谁；段落换人时清空展开状态 */
  private hostId = ''
  /** 现挂在视图槽里的那一个（local 栏按栏缓存；派生栏现造现弃） */
  private view: ViewBodyHost | null = null
  /** 现造现弃的那一个（派生栏）：detach 时要 dispose；local 的在缓存里，只摘不弃 */
  private ownedView: ViewBodyHost | null = null
  /**
   * **local 栏的视图宿主，按栏缓存**（含大纲）。
   *
   * 大纲归了视图宿主之后，一栏一个实例：切 tab 不重建 ⇒ 面包屑展开栈、冻结结果、
   * 条件树草稿各栏各持，来回切不丢；同一栏里切看法也不换实例
   * （`mount()` ⇒ `sync()` 自会按激活视图换分支）。段落换人／栏被摘掉时成批弃。
   */
  private readonly tabViews = new Map<string, ViewBodyHost>()
  /** 引用栏的 kind 过滤（大纲专用设备状态；切到表格时由「类型」列承担同一件事） */
  private refKind: 'all' | 'inline' | 'property' | 'embed' = 'all'
  /**
   * **提及栏的高亮**：块 id → plain 区间（`derived.mentionSpots` 原样搬来）。
   * 派生值，不落盘；切栏时清空。
   *
   * ⚠️ 装载时算出来的那一份只是起点：用户可能在「提及」这一栏里**直接编辑**那一行
   *    （与竞品一致——点进命中字里打字时，高亮应随正文走，而不是钉在旧偏移上）。
   *    区间因此按**此刻的正文**重算，见 `liveMentionSpans`。
   */
  private hitSpans: ReadonlyMap<string, readonly PlainSpan[]> = new Map()
  /** 命中点到的是谁（这一栏的来源块：页/标签）；换栏清空 */
  private mentionTo: string | null = null
  /** 这一栏冻结下来的成员（块 id，装载时的派生记录顺序）：高亮随内容重算，成员不重算 */
  private mentionRecordIds: readonly string[] = []
  /** 装载时目标的名字：高亮认的还是这串字（名字改了要等这一栏重载，不追改名） */
  private mentionWord = ''
  /** 高亮 key：第一次真的画时才领（没人看提及栏就不占一条 key），拆掉时归还 */
  private hitKey: string | null = null
  /**
   * 重画会让 Range 失效（块行是整行替换的，见 `hit-paint` 的注释），所以不在装载时
   * 缓存 Range，而是在 DOM 变化后重找。观测器兜住两条本地重画路径：编辑器自己打字后的
   * 行内重排，以及 `EditableBlock` 欠账后的重载。
   */
  private readonly hitObserver: MutationObserver
  private hitFrame = 0
  /**
   * **命中字上的 hover 提示**：`::highlight` 只是画笔、没有可命中的元素，
   * 所以「光标现在压着哪一处命中」只能靠指针坐标反算。
   * 提示挂在 `body`（不挂在编辑器里）：挂进去会被行重画一起摘掉，还会被滚动容器裁掉。
   *
   * ⚠️ 提示**本身是转换按钮**（与竞品同形）：点它才转换；点命中字是「把光标放进去编辑」。
   *    两者必须是两个落点——同一枪只能有一个意思。提示锚在**高亮文本的上方**（放不下翻到下方），
   *    不跟指针跑：跟着鼠标跑的目标永远追不上；
   *    从正文移到提示上要留一点宽限（`tipHideTimer`），否则 `mouseleave` 会先把提示收掉。
   */
  private tipEl: HTMLButtonElement | null = null
  /** 提示此刻指向哪一处命中：它被按下时转的就是这一处（不是「光标现在在哪」） */
  private tipAt: { blockId: string; span: PlainSpan } | null = null
  /** 悬停**停留**一小会儿才浮出：路过命中不算（否则每次划过都闪一下，还可能挡下一次点击） */
  private tipShowTimer = 0
  /** 离开正文到指针挪上提示之间的宽限；进入提示就取消 */
  private tipHideTimer = 0
  private tipWant: { blockId: string; span: PlainSpan; at: AnchorRect } | null = null
  private hoverFrame = 0
  private hoverPoint: { x: number; y: number } | null = null
  /**
   * 派生栏的快速筛选 chips（**会话瞬态**，按来源一格）：加/摘只改这份内存状态——
   * 不写偏好、不入库、不产生 op、不进撤销栈。段落换人时清空：
   * 换了宿主，chips 说的就不是同一批材料了。
   */
  private readonly quickFilters = new Map<DerivedSource, QuickFilterState>()
  /** 上一次读到的那组条目的串（`refreshEntries` 用它判「要不要重排」） */
  private entrySig = ''

  constructor(deps: MountAreaDeps) {
    this.deps = deps
    this.open = deps.expanded ?? true

    this.root = document.createElement('section')
    this.root.className = 'mount'

    this.summaryEl = document.createElement('button')
    this.summaryEl.type = 'button'
    this.summaryEl.className = 'mount-summary'
    this.summaryEl.addEventListener('click', () => this.setOpen(true))

    this.tabsEl = document.createElement('div')
    this.tabsEl.className = 'mount-tabs'
    this.tabsEl.setAttribute('role', 'tablist')

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'mount-body'

    this.editorEl = document.createElement('div')
    this.editorEl.className = 'mount-editor'
    this.editorEl.spellcheck = false

    this.viewEl = document.createElement('div')
    this.viewEl.className = 'mount-view'
    this.viewEl.hidden = true

    this.emptyEl = document.createElement('p')
    this.emptyEl.className = 'mount-empty'
    this.emptyEl.hidden = true

    this.derivedHeadEl = document.createElement('div')
    this.derivedHeadEl.className = 'mount-derived-head'
    this.derivedHeadEl.hidden = true

    this.block = new EditableBlock({
      host: this.editorEl,
      store: deps.store,
      write: deps.write,
      // 重查比窗口贵一档（要跑查询），防抖放长一点；焦点/按下/组合期的冻结在组件里
      debounceMs: 200,
      // 冻结范围＝整片挂载区：焦点落在 tab 按钮上时，重排 tab 条同样会把正被按的那颗换掉
      area: this.root,
      // 装载动作＝重画整片（栏出现条件读维度存在性，内容变了栏可能增减）
      load: () => this.render(),
      // 挂载区的一行是查询/派生结果：根是派生的，只能往下编辑，不能当兄弟序搬
      structuralScope: 'roots',
      wire: (editor, change) => deps.wire(editor, change),
      onChange: (kind) => deps.onChange(kind),
      onFocus: (editor) => deps.onFocus(editor),
      // 面包屑：普通点＝就地展开；展开根行首的「收起上下文」＝逐层退回
      onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
      onContextBack: (rootId) => this.collapse(rootId),
    })

    this.bodyEl.append(this.derivedHeadEl, this.emptyEl, this.block.root, this.viewEl)

    this.hitObserver = new MutationObserver(() => this.scheduleHitPaint())
    this.hitObserver.observe(this.editorEl, { subtree: true, childList: true, characterData: true })
    this.editorEl.addEventListener('click', this.onHitClick)
    this.editorEl.addEventListener('mousemove', this.onHitHover)
    this.editorEl.addEventListener('mouseleave', this.onHitLeave)
    this.editorEl.addEventListener('mousedown', this.onHitDown)
    // 捕获阶段听滚动：正文的滚动发生在祖先容器上，冒泡不会经过这一台编辑器
    window.addEventListener('scroll', this.onHitScroll, true)
    this.root.append(this.summaryEl, this.tabsEl, this.bodyEl)

    this.render()
  }

  /** 编辑器实例（折叠／空栏时可能还没有）。装配层用它判「活动编辑器」 */
  get blockEditor(): BlockEditor | null {
    return this.block.ed
  }

  /** 摘掉实例（装配层在段根换人时调）：退订 store、卸事件，别让游离容器继续被重画 */
  dispose(): void {
    this.hitObserver.disconnect()
    this.editorEl.removeEventListener('click', this.onHitClick)
    this.editorEl.removeEventListener('mousemove', this.onHitHover)
    this.editorEl.removeEventListener('mouseleave', this.onHitLeave)
    this.editorEl.removeEventListener('mousedown', this.onHitDown)
    window.removeEventListener('scroll', this.onHitScroll, true)
    this.hideTip()
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame)
    this.block.ed?.setMentionHits(null)
    if (this.hitFrame) cancelAnimationFrame(this.hitFrame)
    if (this.hitKey) {
      clearHits(this.hitKey)
      releaseHighlightKey(this.hitKey)
      this.hitKey = null
    }
    this.detachView()
    for (const v of this.tabViews.values()) v.dispose()
    this.tabViews.clear()
    this.block.dispose()
  }

  /**
   * **栏集合可能变了**（加/摘/改名/换视图/设备状态里的日记栏）：变了才重排。
   *
   * 为什么不直接 `render()`：那是整条 tab 条重建，会把焦点从用户正按的那颗按钮上
   * 抽走（而这几件事多半正是点击触发的）。判据是**这一组条目本身**的串 ——
   * 它比「上一次是谁在读」更接近事实：内容没变就不该动 DOM。
   */
  refreshEntries(): void {
    const host = this.deps.host()
    if (!host) return
    const next = this.entriesFor(host)
    const sig = JSON.stringify(next)
    if (sig === this.entrySig) return
    this.entrySig = sig
    this.render()
  }

  /** 展开/收起（视图状态，不进库） */
  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    this.render()
  }

  /**
   * 从装配层点名激活某一栏（新建栏之后跳过去看它）。
   * 栏不在这份条目里就什么都不做 —— 那是「这一栏已经不在了」，不是静默失败。
   */
  activateTab(tabId: string): void {
    if (!this.entries.some((e) => e.id === tabId)) return
    this.activate(tabId)
  }

  /** 这一段的宿主（`MountHost` 是「这一栏写哪」的唯一判别器） */
  private mountHost(): MountHost {
    const host = this.deps.host()
    if (!host) return { kind: 'block', blockId: '' }
    return isJournal(host) ? { kind: 'journal' } : { kind: 'block', blockId: host.id }
  }

  /**
   * 这一屏该有哪些栏：内置（按宿主类型＋设备顺序）在前，存下来的用户栏在后。
   *
   * 两处读者（`render` 与重排比较）必须同一份判据，否则 `entrySig` 会和实际画的
   * 不是同一份东西——「顺序变了但签名没变」会静默不重画。
   */
  private entriesFor(host: Block): MountEntry[] {
    return mountEntriesOf(host, { journalMounts: this.deps.journalMounts() })
  }

  render(focusHint?: string): void {
    const host = this.deps.host()
    if (!host) {
      this.root.hidden = true
      return
    }
    // 段落换人：上一段的展开栈与各栏的视图宿主都没有意义
    if (this.hostId !== host.id) {
      this.hostId = host.id
      this.expandedByTab.clear()
      this.covers = new Map()
      this.refKind = 'all'
      this.quickFilters.clear()
      for (const v of this.tabViews.values()) v.dispose()
      this.tabViews.clear()
    }
    this.root.hidden = false
    this.entries = this.entriesFor(host)
    this.entrySig = JSON.stringify(this.entries)
    // 栏被摘掉：它的视图宿主一起退（订阅还挂着的话，游离容器会被白重画）
    if (this.tabViews.size > 0) {
      const alive = new Set(this.entries.map((e) => e.id))
      for (const [id, v] of this.tabViews) {
        if (alive.has(id)) continue
        v.dispose()
        this.tabViews.delete(id)
      }
    }

    // 栏可能被摘掉：激活项不在了就回落到第一栏，而不是留一个空 body
    if (!this.entries.some((e) => e.id === this.active)) this.active = this.entries[0]?.id ?? ''
    const activeAt = this.entries.findIndex((e) => e.id === this.active)

    this.root.dataset.open = this.open ? '1' : '0'
    this.summaryEl.hidden = this.open
    this.tabsEl.hidden = !this.open
    this.bodyEl.hidden = !this.open

    if (!this.open) {
      /**
       * 折叠摘要跟**第一栏**走：标签页的第一栏是「成员」，普通块是「引用」。
       * 不写死「引用 N」——那会让标签页折叠时显示一个通常为 0 的数字，
       * 而它真正的成员在另一栏。
       */
      const first = this.entries[0]
      if (first?.kind === 'derived') {
        const count = derivedRecordsOf(host, this.deps.kb, first.source).length
        this.summaryEl.textContent = `${t(BUILTIN_LABEL[first.source])} ${t('ui.mount.count', { count })}`
      } else {
        this.summaryEl.textContent = t('ui.mount.expand')
      }
      return
    }

    this.renderTabs(host, activeAt)
    if (activeAt < 0) {
      this.showEmpty(t('ui.mount.empty.user'))
      return
    }
    this.load(host, this.entries[activeAt]!, focusHint)
  }

  /* ------------------------------------------------------------ tab 条 */

  private renderTabs(host: Block, activeAt: number): void {
    this.tabsEl.textContent = ''
    const hostRef = this.mountHost()
    this.entries.forEach((entry, i) => {
      const wrap = document.createElement('div')
      wrap.className = 'mount-tabwrap'
      wrap.dataset.tab = entry.id
      wrap.dataset.kind = entry.kind

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mount-tab'
      btn.setAttribute('role', 'tab')
      btn.dataset.tab = entry.id
      btn.textContent = this.labelOf(entry)
      btn.addEventListener('click', () => this.activate(entry.id))
      /**
       * 改名只有 local 栏有：双击就地弹输入框（与浏览器标签页、其它编辑器同一套手势）。
       * `title` 是给「不知道能双击」的人的唯一提示 —— 不另立一颗铅笔图标：
       * 那一栏的 chrome 已经有两件（名字、×），再加一件会把 4 个字的宽度吃掉。
       */
      if (entry.kind === 'local' && this.deps.onRenameTab) {
        btn.title = t('ui.mount.renameHint')
        btn.addEventListener('dblclick', (e) => {
          e.preventDefault()
          this.deps.onRenameTab?.(hostRef, entry.id, btn.getBoundingClientRect())
        })
      }
      /**
       * **拖拽换序**：整条 tab 条一条顺序，所以派生栏与用户栏互为落点（可以互相越位）。
       * 写哪一格由命令层按宿主判；这一层只报「谁挪到了谁旁边」。
       * 过去的日记天不给拖：那一格是共享配置，改了会影响今天。
       */
      const canDrag = Boolean(this.deps.onMoveTab) && canEditMounts(host)
      if (canDrag) {
        btn.draggable = true
        btn.addEventListener('dragstart', (e) => {
          setDragTab(e.dataTransfer, entry.id)
          wrap.dataset.dragging = '1'
        })
        btn.addEventListener('dragend', () => {
          delete wrap.dataset.dragging
        })
        const placeOf = (e: DragEvent): 'before' | 'after' => {
          const r = wrap.getBoundingClientRect()
          return e.clientX < r.left + r.width / 2 ? 'before' : 'after'
        }
        bindDropTarget(wrap, {
          kind: 'tab',
          effect: 'move',
          targetId: () => entry.id,
          // 拖到自己那格没有意义（模型层也会拒），这里连高亮都不亮。
          accept: (id) => id !== entry.id,
          hint: () => t('ui.dnd.moveTab'),
          mark: (_id, e) => {
            wrap.dataset[placeOf(e) === 'before' ? 'dropBefore' : 'dropAfter'] = '1'
          },
          unmark: () => {
            delete wrap.dataset.dropBefore
            delete wrap.dataset.dropAfter
          },
          onDrop: (id, _target, e) => {
            if (id === entry.id) return
            this.deps.onMoveTab?.(hostRef, id, entry.id, placeOf(e))
          },
        })
      }
      wrap.appendChild(btn)

      // 内置派生栏不可摘：它们不落盘，摘了也没有「摘掉」的落点；local 才有 ×
      if (entry.kind === 'local' && this.deps.onRemoveTab) {
        const x = document.createElement('button')
        x.type = 'button'
        x.className = 'mount-x'
        x.textContent = '×'
        x.title = t('ui.mount.remove')
        x.dataset.tab = entry.id
        x.addEventListener('click', (e) => {
          e.stopPropagation()
          this.deps.onRemoveTab?.(hostRef, entry.id)
          /**
           * 当场重画：焦点在这颗 × 上，而 store 订阅在「焦点在本视图里」时会**跳过**
           * （那是「打字时别把行抽走」的保护）。不补这一次，用户会看到「点了 × 没反应」。
           *
           * ⚠️ 不再整批清展开栈：键是**稳定 id**，摘掉一栏之后其余栏的键一个都不漂。
           */
          this.render()
        })
        wrap.appendChild(x)
      }
      if (i === activeAt) wrap.dataset.active = '1'
      this.tabsEl.appendChild(wrap)
    })

    // 「＋」只给能配用户栏的宿主（过去的日记天不给：那一栏没有落点）
    if (this.deps.onAddTab && canEditMounts(host)) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'mount-add'
      add.textContent = '＋'
      add.title = t('ui.mount.addLocalHint')
      add.addEventListener('click', () => this.deps.onAddTab?.(host.id))
      this.tabsEl.appendChild(add)
    }

    // 收起：折叠态之后只剩一行摘要。日记流里「今天展开、更早的一行摘要」靠它切换
    const collapse = document.createElement('button')
    collapse.type = 'button'
    collapse.className = 'mount-collapse'
    collapse.textContent = t('ui.mount.collapse')
    collapse.title = t('ui.mount.collapse')
    collapse.addEventListener('click', () => this.setOpen(false))
    this.tabsEl.appendChild(collapse)
  }

  /** 一栏的 tab 文案：local 用它自己的 label，derived 由来源字典给 */
  private labelOf(entry: MountEntry): string {
    return entry.kind === 'derived' ? t(BUILTIN_LABEL[entry.source]) : entry.label
  }

  private activate(id: string): void {
    if (this.active === id) return
    this.active = id
    const host = this.deps.host()
    if (host) this.renderTabs(host, this.entries.findIndex((e) => e.id === this.active))
    const entry = this.entries.find((e) => e.id === this.active)
    if (host && entry) this.load(host, entry)
  }

  /* ------------------------------------------------------------ body */

  /**
   * 把这一栏的命中区间画成高亮。
   *
   * key 懒领：没人停在提及栏时不该占一条 `CSS.highlights` 的 key。
   * 没有命中 ⇒ 只摘旧的、不领新的。
   */
  private paintMentionHits(): void {
    // 重画会让行整体换掉 ⇒ 提示锚着的那一处矩形已经过期，收掉，等指针再停上来
    this.hideTip()
    /**
     * **区间随正文重算，成员不重算**：这一栏里点进命中字就能改（与竞品一致），
     * 改一个字就可能让「这一串名字」不再连续。装载时那份区间钉在旧偏移上，
     * 继续画只会盖住旁边的字（不是「高亮消失」）。所以每次重画都按此刻的正文再找一遍：
     * 改坏 ⇒ 没有区间（高亮消失）、改回来 ⇒ 区间又出现；这一行本身留到离开这片区域再重载。
     */
    if (this.mentionTo && this.mentionWord !== '') {
      this.hitSpans = this.liveMentionSpans()
      this.syncMentionHits(this.block.ed)
    }
    // 这一栏此刻画的不是大纲（列表/表格/空态）：老的行还留在 DOM 里但已经不可见，
    // 在上面画 Range 只会得到几条指向隐藏节点的区间
    if (this.hitSpans.size === 0 || this.editorEl.hidden) {
      if (this.hitKey) clearHits(this.hitKey)
      return
    }
    this.hitKey ??= claimHighlightKey('mention-hit')
    paintHits(this.editorEl, this.hitSpans, this.hitKey)
  }

  /**
   * 按**冻结的成员 ＋ 此刻的正文**重算命中区间。
   *
   * 成员是装载那一刻的派生记录（编辑途中不重查：行被抽走会让正在打字的 DOM 消失，
   * 那正是「编辑时块不见了」）；区间是纯函数、读当前内容，改字/改回来立刻反映。
   */
  private liveMentionSpans(): Map<string, readonly PlainSpan[]> {
    const out = new Map<string, readonly PlainSpan[]>()
    const word = this.mentionWord
    for (const id of this.mentionRecordIds) {
      const b = this.deps.kb.get(id)
      if (!b) continue
      const spots = mentionSpotsOf(b.content, word)
      if (spots.length > 0) out.set(id, spots.map((s) => ({ start: s.start, end: s.end })))
    }
    return out
  }

  /** DOM 变化合并到下一帧：一次重画（整行替换）会连发十几条 mutation，逐条重算纯属浪费 */
  private scheduleHitPaint(): void {
    if (this.hitFrame) return
    this.hitFrame = requestAnimationFrame(() => {
      this.hitFrame = 0
      this.paintMentionHits()
    })
  }

  /**
   * 把「这一栏的命中」交给编辑器：⌥ 单击与块菜单的 `when` 都读它，
   * 判据只有 `spanAt` 一处。没有命中（别的栏／别的视图）就交回 `null`。
   */
  private syncMentionHits(ed: BlockEditor | null | undefined): void {
    ed?.setMentionHits(
      this.mentionTo && this.hitSpans.size > 0 ? { to: this.mentionTo, spans: this.hitSpans } : null,
    )
  }

  /**
   * **⌥ + 单击命中字 = 转为引用。**
   *
   * 为什么只认 ⌥、而不是「悬停后单击」：点命中字最常见的意思是**把光标放进去编辑**。
   * 这一栏的行就是源块本身，编辑是它最主要的能力（改一个字，高亮随正文消失；
   * 改回来，高亮又出现——派生高亮的语义）。把单击让给「转换」就等于用户点不进去。
   *
   * 为什么是 ⌥：命中永远是**纯文本**（`mentionSpotsOf` 会把含原子的切片剔掉），
   * 而 ⌥ 单击在编辑器里只对原子/引用有意义（「看详情而不是默认动作」）——
   * 打在文本上它本来是空的，不会和 ⌘ 新 tab、Shift 进右槽撞。
   * 落点用 `caretRangeFromPoint` 换算回 plain 偏移：高亮只是画层，没有可点的元素。
   */
  private readonly onHitClick = (e: MouseEvent): void => {
    if (!this.mentionTo || !e.altKey) return
    /**
     * **拖选不是点击**：按住 ⌥ 拖过一段文本，释放在同一行时浏览器仍会派发一次 `click`。
     * 那时落点可能正好停在命中字上，于是「选了一段」变成「把一段转成引用」。
     * 拖选结束时选区非空且未折叠，据此把这一枪挡掉（单击落下的光标永远是折叠的）。
     */
    const sel = document.getSelection()
    if (sel && !sel.isCollapsed) return
    const target = e.target instanceof Element ? e.target : null
    const blk = target?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.editorEl.contains(blk)) return
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return
    const offset = offsetAtPoint(tx, e.clientX, e.clientY)
    // 没命中就**原样放行**：光标照常落下，一个字节都不写
    const span = offset === null ? null : spanAt(this.hitSpans.get(blockId) ?? [], offset)
    if (!span) return
    e.preventDefault()
    e.stopPropagation()
    this.hideTip()
    this.deps.invoke('core.block/convert-mention', {
      blockId,
      to: this.mentionTo,
      start: span.start,
      end: span.end,
    })
  }

  /**
   * **鼠标停在命中字上 ⇒ 浮出「转为引用」按钮。**
   *
   * 提示是一个独立的小按钮，**固定在高亮文本上方**（放不下翻到下方，不跟指针跑）：
   * 点它才转换；点命中字本身只是落光标编辑。从正文挪到提示上的那一小段留了宽限
   * （`scheduleHideTip`），否则 `mouseleave` 会先把提示收掉、按钮点不到。
   * 判定仍然复用 `offsetAtPoint` ＋ `spanAt`，与画高亮是同一份区间。
   */
  private readonly onHitHover = (e: MouseEvent): void => {
    this.hoverPoint = { x: e.clientX, y: e.clientY }
    if (this.hoverFrame) return
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0
      this.pickHover()
    })
  }

  /** 指针离开整片正文：先留一点宽限，让人能挪上提示按钮；没进去就收 */
  private readonly onHitLeave = (): void => {
    this.hoverPoint = null
    this.scheduleHideTip()
  }

  /** 按下就收掉提示：它锚着的那一处马上就会被光标/选区改变，留着只会说谎 */
  private readonly onHitDown = (): void => {
    this.hideTip()
  }

  private readonly onHitScroll = (): void => {
    this.hideTip()
  }

  private pickHover(): void {
    const p = this.hoverPoint
    if (!p) return
    if (this.hitSpans.size === 0 || !this.mentionTo || this.editorEl.hidden) {
      this.hideTip()
      return
    }
    const el = document.elementFromPoint(p.x, p.y)
    /**
     * **指针已经压在提示按钮上**：那正是用户要去点的目标，不是「离开了命中」。
     * 提示是 `position: fixed` 挂在 `body` 上的，但指针往上挪的那几步仍可能落在
     * 编辑器盒子里 ⇒ `mousemove` 会跑到这里；不先认它，就会在点中之前把按钮收掉。
     */
    if (el && this.tipEl && (el === this.tipEl || this.tipEl.contains(el))) {
      this.cancelHideTip()
      return
    }
    const blk = el?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.editorEl.contains(blk)) {
      this.scheduleHideTip()
      return
    }
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) {
      this.scheduleHideTip()
      return
    }
    const offset = offsetAtPoint(tx, p.x, p.y)
    const span = offset === null ? null : spanAt(this.hitSpans.get(blockId) ?? [], offset)
    if (!span) {
      this.scheduleHideTip()
      return
    }
    /**
     * `caretRangeFromPoint` 会把行的空白处「贴」到最近的字符上——只靠 clear offset
     * 判定的话，命中字右边那一大片空白都会弹出提示。所以再要求指针真的压在
     * 这一处的某个矩形里（±2px 容差：字的边缘本来就有半像素误差）。
     */
    const rects = rangeAtSpan(tx, span)?.getClientRects() ?? []
    const rect = Array.from(rects).find(
      (r) => p.x >= r.left - 2 && p.x <= r.right + 2 && p.y >= r.top - 2 && p.y <= r.bottom + 2,
    )
    if (!rect) {
      this.scheduleHideTip()
      return
    }
    this.scheduleTip(blockId, span, rect)
  }

  /** 同一处命中：已在显示就只挪位置；换了一处：已显示的直接换，没显示的等停留 */
  private scheduleTip(blockId: string, span: PlainSpan, at: AnchorRect): void {
    this.cancelHideTip()
    const shown = this.tipAt
    if (this.tipEl && shown && shown.blockId === blockId && shown.span.start === span.start && shown.span.end === span.end) {
      this.placeTip(at)
      return
    }
    this.tipWant = { blockId, span, at }
    if (this.tipEl) {
      this.showTip(blockId, span, at)
      return
    }
    if (this.tipShowTimer) return
    this.tipShowTimer = window.setTimeout(() => {
      this.tipShowTimer = 0
      const want = this.tipWant
      if (want) this.showTip(want.blockId, want.span, want.at)
    }, 150)
  }

  private showTip(blockId: string, span: PlainSpan, at: AnchorRect): void {
    this.tipWant = null
    let tip = this.tipEl
    if (!tip) {
      tip = document.createElement('button')
      tip.type = 'button'
      tip.className = 'mention-tip'
      tip.textContent = t('ui.mount.mention.hoverHint')
      // 进入提示就取消「离开正文」那条宽限；离开提示则收掉（回到正文会重新浮出）
      tip.addEventListener('mouseenter', () => this.cancelHideTip())
      tip.addEventListener('mouseleave', () => this.hideTip())
      tip.addEventListener('click', this.onTipClick)
      document.body.appendChild(tip)
      this.tipEl = tip
    }
    this.cancelHideTip()
    this.tipAt = { blockId, span }
    this.placeTip(at)
  }

  /** 点提示＝转它指着的那一处（与命中字本身分开：点字是编辑） */
  private readonly onTipClick = (e: MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const at = this.tipAt
    const to = this.mentionTo
    if (!at || !to) return
    this.hideTip()
    this.deps.invoke('core.block/convert-mention', {
      blockId: at.blockId,
      to,
      start: at.span.start,
      end: at.span.end,
    })
  }

  /** 指针离开正文到「挪上提示」之间的宽限；进入提示或重新命中都会取消 */
  private scheduleHideTip(): void {
    this.cancelHideTip()
    this.tipHideTimer = window.setTimeout(() => {
      this.tipHideTimer = 0
      this.hideTip()
    }, 240)
  }

  private cancelHideTip(): void {
    if (this.tipHideTimer) {
      window.clearTimeout(this.tipHideTimer)
      this.tipHideTimer = 0
    }
  }

  /**
   * 锚在**命中字的矩形**上（不是指针）：提示浮在那一处高亮的上方，不跟着鼠标跑——
   * 跟着跑的目标永远追不上。上方放不下时 `placeNear` 会翻到下方。
   */
  private placeTip(anchor: AnchorRect): void {
    const tip = this.tipEl
    if (!tip) return
    const at = placeNear({
      boxW: tip.offsetWidth,
      boxH: tip.offsetHeight,
      vw: window.innerWidth,
      vh: window.innerHeight,
      anchor,
      side: 'above',
      align: 'left',
      gap: 6,
      pad: 8,
    })
    tip.style.left = `${at.left}px`
    tip.style.top = `${at.top}px`
  }

  private hideTip(): void {
    if (this.tipShowTimer) {
      window.clearTimeout(this.tipShowTimer)
      this.tipShowTimer = 0
    }
    this.cancelHideTip()
    this.tipWant = null
    this.tipEl?.remove()
    this.tipEl = null
    this.tipAt = null
  }

  private load(host: Block, entry: MountEntry, focusHint?: string): void {
    // 换栏：上一栏的命中高亮先摘掉，再由这一栏自己决定要不要画
    this.hitSpans = new Map()
    this.mentionTo = null
    this.mentionRecordIds = []
    this.mentionWord = ''
    this.hideTip()
    this.block.ed?.setMentionHits(null)
    this.paintMentionHits()
    if (entry.kind === 'derived') {
      this.loadDerived(host, entry, focusHint)
      return
    }
    /**
     * local 栏**整台都归视图宿主**（大纲也不例外）：抬头（条数/条件/切换/刷新）
     * 由宿主统一画在右侧，条件 chip 与条件树处处可改。
     * 过去大纲走挂载区自己的编辑器，「大纲改不了条件」与「切换下拉忽左忽右」
     * 是同一个根因——两台身体各画各的。
     */
    this.derivedHeadEl.hidden = true
    this.showView(host, entry)
  }

  private loadDerived(host: Block, entry: Extract<MountEntry, { kind: 'derived' }>, focusHint?: string): void {
    const kind = this.deps.derivedKind?.(host, entry.source) ?? 'outline'
    /**
     * **维度不存在**（这一块没有标签 ⇒ 同类；没有可读文本 ⇒ 提及）：tab 常驻，
     * body 里说**原因**，而不是走「条件没匹配到」那套通用空态。
     * 也不建视图宿主：列表/表格在这个维度上同样没有东西可画。
     */
    if (derivedSpecOf(host, this.deps.kb.roots(), entry.source) === null) {
      this.detachView()
      this.renderDerivedHead(host, entry, kind, 0)
      this.showEmpty(
        t(
          entry.source === 'same'
            ? 'ui.mount.empty.sameNoTags'
            : entry.source === 'mentions'
              ? 'ui.mount.empty.mentionsNoText'
              : DERIVED_EMPTY[entry.source],
        ),
      )
      return
    }
    const { filtered, records } = this.displayedDerivedRecords(host, entry.source)
    this.renderDerivedHead(host, entry, kind, records.length, filtered)
    /**
     * 提及栏的命中区间：**同一份派生记录**里已经算好了（`derived.mentionSpots`），
     * 这里只搬过来，不再按词重搜一遍——画高亮与「之后切成引用」必须认同一处命中。
     */
    if (entry.source === 'mentions') {
      this.hitSpans = mentionSpansOf(records)
      // 命中属于**这一栏的来源块**（页/标签），转引用时目标就是它
      this.mentionTo = host.id
      // 成员与词都冻结在装载这一刻；区间由 paintMentionHits 按当前正文重算
      this.mentionRecordIds = records.map((r) => r.block.id)
      this.mentionWord = displayTextOf(host)
      this.syncMentionHits(this.block.ed)
    }
    const view = this.viewOf(entry)
    if (view) {
      this.showView(host, entry)
      return
    }
    this.detachView()
    // 大纲只画顶层：计数仍按记录条数（与列表/表格同一个数字）
    const { roots, contexts } = outermostHits(records)
    const empty =
      entry.source === 'refs' && this.refKind !== 'all'
        ? 'ui.mount.empty.refsKind'
        : DERIVED_EMPTY[entry.source]
    this.loadOutline(entry, { roots, contexts }, focusHint, empty)
  }

  /**
   * 派生栏此刻显示的记录：快速筛选先落，类型过滤再落（仅引用的大纲看法）。
   * 装载与一键折/展同源——批量动作动的是「此刻看得见的那些根」，不能另算一批。
   */
  private displayedDerivedRecords(
    host: Block,
    source: DerivedSource,
  ): { filtered: ViewRecord[]; records: ViewRecord[] } {
    const kind = this.deps.derivedKind?.(host, source) ?? 'outline'
    /**
     * 快速筛选先落，类型过滤再落：chips 答的是「这一栏看谁」，kind 答的是
     * 「引用里看哪几类」——两刀同一批材料，切法有先后。抬头的计数与
     * 类型计数都读**筛过之后**的那批（主数字＝现在看得见的条数）。
     */
    const filtered = applyQuickFilter(derivedRecordsOf(host, this.deps.kb, source), this.filterOf(source))
    /**
     * kind 过滤只作用于**大纲**：列表/表格走视图宿主的记录源，那里用「类型」列
     * 承担同一件事。否则会出现「抬头条数是过滤后的、表里是全部」的假数字。
     */
    const records =
      source === 'refs' && kind === 'outline' && this.refKind !== 'all'
        ? filtered.filter((r) => {
            const keys = r.derived?.relKindKeys
            return Array.isArray(keys) && keys.includes(this.refKind)
          })
        : filtered
    return { filtered, records }
  }

  /**
   * 一键折/展（引用栏）：只动**关联型**的根，方向随现状翻面——有关联型折着 ⇒ 全展开，
   * 否则全折。动作时现算（筛选与 kind 都可能刚变过），动的是「此刻看得见的根」。
   */
  private bulkToggleRefFolds(host: Block): void {
    const ed = this.block.ed
    if (!ed) return
    const assocIds = outermostHits(this.displayedDerivedRecords(host, 'refs').records)
      .roots.filter((b) => !passThroughRefTarget(b) && hasLiveChildren(b))
      .map((b) => b.id)
    if (assocIds.length === 0) return
    const folded: FoldState = { ...(ed.doc.folded ?? {}) }
    if (assocIds.some((id) => folded[id])) {
      for (const id of assocIds) delete folded[id]
    } else {
      for (const id of assocIds) folded[id] = true
    }
    ed.doc.folded = folded
    this.render()
  }

  /** 大纲装载（local／派生共用的那一支） */
  private loadOutline(entry: MountEntry, base: MountRoots, focusHint?: string, emptyText?: MsgId): void {
    const plan = expandContexts(base, this.expandedFor(entry.id), (id) => this.deps.kb.pathOf(id), focusHint)
    // 过期的展开 id 当场剪掉：下次再出现同 id 时不该「自己又展开」
    this.expandedByTab.set(entry.id, plan.expanded)
    this.covers = plan.covers
    if (plan.roots.length === 0) {
      this.showEmpty(t(emptyText ?? EMPTY_TEXT[entry.kind]))
      // 空结果也保留这份视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.block.ed?.loadPage({ roots: [], folded: this.block.ed.doc.folded })
      return
    }
    const ed = this.block.ensureEditor()
    this.emptyEl.hidden = true
    this.editorEl.hidden = false
    delete this.editorEl.dataset.empty
    /**
     * **关联型引用默认折叠**（派生栏专用）：引用／提及／同类这三栏的每一行都是
     * 「因为一条边而出现」—— `[[引用]]`、`#标签`，正文里有别的字，引用只是提及。
     * 一行关联单独看没有上下文，摊开是一屏噪声 ⇒ 默认折。
     * **传递型引用不折**（只限引用栏）：正文**只有一枚引用**的块自己没有内容
     * （`passThroughRefTarget` 命中），它挂着的子块才是这条引用真正指到的东西 ——
     * 折了就只剩一枚孤零零的引用，看不见「这条引用带来了什么」⇒ 子树直接摊开。
     *
     * ⚠️ **只播种一次**（按栏记）：用户手动展开某一行以后不许再覆盖 ——
     *    否则每次重画都把人刚展开的又折回去。
     * ⚠️ **必须写回 `doc.folded`**：挂载区会重画，只在返回值里播种会
     *    「闪一下折着、随即又展开」。
     */
    if (entry.kind === 'derived' && !this.foldSeeded.has(entry.id)) {
      this.foldSeeded.add(entry.id)
      const seeded: FoldState = { ...(ed.doc.folded ?? {}) }
      for (const b of plan.roots) {
        if (entry.source === 'refs' && passThroughRefTarget(b)) continue
        if (hasLiveChildren(b)) seeded[b.id] = true
      }
      ed.doc.folded = seeded
    }
    const folded = unfoldForContext(ed.doc.folded, plan.covers, (id) => this.deps.kb.pathOf(id))
    ed.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    // 装载刚换了整片 DOM：立刻画一次（不等观测器那一帧，避免「先无高亮再补上」的闪动）
    this.paintMentionHits()
    // 编辑器第一次建出来才可能设命中（旧的一台已经在 `load` 里清过了）
    this.syncMentionHits(ed)
    if (plan.focusId) ed.reveal(plan.focusId)
  }

  /**
   * 这一栏**现在选的是哪张视图**；`null` ＝ 大纲。
   *
   * `derived` 栏没有配置：它的看法是设备状态（`derivedKind`），缺省大纲。
   * 列表／表格这两个看法仍然走视图宿主的渲染器，只是那一台不画抬头、也没有「＋」。
   */
  private viewOf(entry: MountEntry): ViewConfig | null {
    if (entry.kind === 'derived') {
      const host = this.deps.host()
      if (!host) return null
      const kind = this.deps.derivedKind?.(host, entry.source) ?? 'outline'
      return kind === 'outline' ? null : { id: `derived:${kind}`, kind }
    }
    const hostRef = this.mountHost()
    const data = this.deps.owners.read({ kind: 'tab', host: hostRef, tabId: entry.id })
    return data ? readViewSet(data).active : null
  }

  /**
   * 派生栏抬头：`引用 · 12 条  [大纲][列表][表格]  ⋯`。
   *
   * 主数字＝**记录条数**（与列表/表格同一个数）：大纲折叠只影响画几行，不改成员。
   * 条件是一句**只读说明**（「指向这一块」）——它没有可编辑的条件，也没有构建器落点。
   */
  private renderDerivedHead(
    host: Block,
    entry: Extract<MountEntry, { kind: 'derived' }>,
    kind: DerivedViewKind,
    count: number,
    all: readonly ViewRecord[] = [],
  ): void {
    const head = this.derivedHeadEl
    head.hidden = false
    head.replaceChildren()

    const title = document.createElement('span')
    title.className = 'mount-derived-title'
    title.textContent = t(BUILTIN_LABEL[entry.source])
    const num = document.createElement('span')
    num.className = 'mount-derived-count'
    num.textContent = t('ui.mount.count', { count })
    /**
     * **条件句就是「改条件」的入口**：点它＝原地物化（local 栏占用这一栏的稳定 id，
     * 内置栏被替换而不是多出一份副本）＋ 直接打开条件树——条件树认 `{ref}` 行，
     * 从「看条件」到「改条件」没有中间步骤。维度不存在 ⇒ 没有可编辑的条件，保留死句。
     */
    if (derivedSpecOf(host, this.deps.kb.roots(), entry.source) !== null) {
      const why = document.createElement('button')
      why.type = 'button'
      why.className = 'mount-derived-why ui-ellipsis'
      why.title = t('ui.mount.materialize')
      why.textContent = t(DERIVED_WHY[entry.source])
      why.addEventListener('click', () => {
        this.deps.onMaterializeTab?.(host.id, entry.source, why.getBoundingClientRect(), { openTree: true })
      })
      head.append(title, num, why)
    } else {
      const why = document.createElement('span')
      why.className = 'mount-derived-why ui-ellipsis'
      why.textContent = t(DERIVED_WHY[entry.source])
      head.append(title, num, why)
    }

    /**
     * 引用栏的 kind 过滤：只用**这次已经取到的记录**统计（不再扫一遍库），
     * 且只在大纲显示——表格/列表用「类型」列承担同一件事，避免两处筛选各说各的。
     */
    if (entry.source === 'refs' && kind === 'outline' && all.length > 0) {
      const counts = new Map<'inline' | 'property' | 'embed', number>()
      for (const r of all) {
        const keys = r.derived?.relKindKeys
        if (!Array.isArray(keys)) continue
        for (const k of keys) {
          if (k !== 'inline' && k !== 'property' && k !== 'embed') continue
          counts.set(k, (counts.get(k) ?? 0) + 1)
        }
      }
      const kinds = document.createElement('div')
      kinds.className = 'mount-derived-kinds'
      const add = (key: 'all' | 'inline' | 'property' | 'embed', label: string, n: number): void => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'mount-derived-kind'
        b.dataset.kind = key
        if (this.refKind === key) b.dataset.active = '1'
        b.textContent = n > 0 ? `${label} ${n}` : label
        b.addEventListener('click', () => {
          if (this.refKind === key) return
          this.refKind = key
          this.render()
        })
        kinds.appendChild(b)
      }
      add('all', t('ui.mount.kind.all'), all.length)
      add('inline', t('ui.mount.kind.inline'), counts.get('inline') ?? 0)
      add('property', t('ui.mount.kind.property'), counts.get('property') ?? 0)
      add('embed', t('ui.mount.kind.embed'), counts.get('embed') ?? 0)
      head.appendChild(kinds)
    }

    /**
     * 快速筛选的入口（引用／提及两栏）：候选与计数都是面板层的 chrome，
     * 与行渲染器分层。结果为空且没筛时不给——空结果上没有可筛的东西，
     * 挂一颗点了只说「没有候选」的按钮是噪声。
     */
    if ((entry.source === 'refs' || entry.source === 'mentions') && (count > 0 || this.filterActive(entry.source))) {
      head.appendChild(this.quickFilterButton(entry.source))
    }

    /**
     * **一键折/展**（引用栏·大纲看法）：折/展全部**关联型**根。传递型不在名单里——
     * 它的子块就是这条引用真正指到的内容，折了只剩一枚孤零零的引用（与折叠播种
     * 同一份豁免判据）。方向随现状翻面：有关联型折着 ⇒ 全展开；全都开着 ⇒ 全折
     * （与 dock「收起所有卡 ⇄ 展开所有卡」同款）。没有可折的关联根时不给——
     * 挂一颗点了没反应的按钮是噪声。
     */
    if (entry.source === 'refs' && kind === 'outline') {
      const assocIds = outermostHits(all)
        .roots.filter((b) => !passThroughRefTarget(b) && hasLiveChildren(b))
        .map((b) => b.id)
      if (assocIds.length > 0) {
        const bulk = document.createElement('button')
        bulk.type = 'button'
        bulk.className = 'mount-derived-bulkfold'
        bulk.dataset.refsBulk = '1'
        const anyFolded = assocIds.some((id) => Boolean(this.block.ed?.doc.folded?.[id]))
        renderIcon(
          bulk,
          anyFolded ? 'lucide:chevrons-up-down' : 'lucide:chevrons-down-up',
          anyFolded ? 'chevrons-up-down' : 'chevrons-down-up',
        )
        bulk.title = t(anyFolded ? 'ui.refs.expandAll' : 'ui.refs.foldAll')
        bulk.addEventListener('click', () => this.bulkToggleRefFolds(host))
        head.appendChild(bulk)
      }
    }

    /**
     * 看法切换是**一颗下拉**（与自定义查询的「视图…」同壳、同台浮层），不是一排 tab：
     * 三档看法是同一件事的三种读法，排开只会抢走条数与筛选的位置。
     */
    const seg = document.createElement('div')
    seg.className = 'mount-derived-views'
    const labels: Record<DerivedViewKind, MsgId> = {
      outline: 'ui.view.outline',
      table: 'ui.view.kind.table',
    }
    const btn = document.createElement('button')
    btn.type = 'button'
    // ⚠️ 不带 `qv-view-current`：那是视图宿主抬头切换器的钩子（冒烟按它点），
    //    派生栏这一颗凑同名会把两台切换器搅在一起；样式借 `qv-view-btn`，身份用自己的。
    btn.className = 'qv-view-btn mount-derived-view-btn'
    btn.title = t('ui.view.switchHint')
    const label = document.createElement('span')
    label.className = 'mount-derived-view-label'
    label.textContent = t(labels[kind])
    const caret = document.createElement('span')
    caret.className = 'qv-view-caret'
    renderIcon(caret, 'lucide:chevron-down', 'chevron-down')
    btn.append(label, caret)
    btn.addEventListener('click', () => {
      this.deps.openDerivedViewMenu?.(btn.getBoundingClientRect(), kind, (k) => {
        if (k === kind) return
        this.deps.setDerivedKind?.(host, entry.source, k)
      })
    })
    seg.appendChild(btn)
    head.appendChild(seg)

    /**
     * **分组下拉**（列表／表格才有）：与看法切换同排、与查询视图同一个候选源
     * （core `groupChoicesOf`）。分组键住设备状态（`Prefs.mountGroups`，与看法同层）。
     */
    if (kind === 'table') {
      const fields = propDisplayLabels(this.deps.kb.roots())
      const group = document.createElement('select')
      group.className = 'queryview-group mount-derived-group'
      const none = document.createElement('option')
      none.value = ''
      none.textContent = t('ui.query.group.none')
      group.appendChild(none)
      for (const c of groupChoicesOf(all, {
        fields: [...fields].map(([id, label]) => ({ id, label })),
        cardinalityOf: (id) => {
          const def = this.deps.kb.propDefs().find((d) => d.id === id)
          return def ? cardinalityOf(def) : 'one'
        },
      })) {
        const o = document.createElement('option')
        o.value = c.key
        o.textContent = `${c.label}${c.multi ? t('ui.query.group.multi') : ''}（${c.count}／${c.total}）`
        group.appendChild(o)
      }
      const current = this.deps.derivedGroup?.(host, entry.source) ?? ''
      group.value = current
      if (group.value !== current) group.value = ''
      group.onchange = () => this.deps.setDerivedGroup?.(host, entry.source, group.value)
      head.appendChild(group)
    }
  }

  /* ---------------------------------------------------------- 快速筛选 */

  /**
   * 这一栏现在的 chips（**会话瞬态**；装配层的列表/表格记录源也读这一份，
   * 两处同一个答案——大纲与表格各算各的就会出现两批行）。
   */
  filterOf(source: DerivedSource): QuickFilterState {
    return this.quickFilters.get(source) ?? EMPTY_QUICK_FILTER
  }

  private filterActive(source: DerivedSource): boolean {
    const s = this.filterOf(source)
    return s.include.length > 0 || s.remove.length > 0
  }

  private quickFilterButton(source: DerivedSource): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'mount-derived-filter'
    btn.textContent = t('ui.filter.button')
    btn.title = t('ui.filter.buttonHint')
    if (this.filterActive(source)) btn.dataset.active = '1'
    btn.addEventListener('click', () => this.openQuickFilter(source, btn))
    return btn
  }

  /**
   * 弹出 chips 层。锚点每次**现查**（手势会重画抬头、重建按钮，矩形快照会指向
   * 一个已经不存在的元素）；锚点不在了 ⇒ 浮层自己关（装配层浮层的既有口径）。
   */
  private openQuickFilter(source: DerivedSource, trigger?: HTMLElement): void {
    if (!this.deps.openPopover) return
    this.deps.openPopover(
      (box) => {
        const paint = (): void =>
          renderQuickFilter(box, {
            records: () => {
              const h = this.deps.host()
              return h ? derivedRecordsOf(h, this.deps.kb, source) : []
            },
            state: () => this.filterOf(source),
            labelOf: (atom) => this.atomLabel(atom),
            onAdd: (atom, to) => {
              if (this.mutateFilter(source, (s) => quickFilterAdd(s, atom, to))) paint()
            },
            onDrop: (atom) => {
              if (this.mutateFilter(source, (s) => quickFilterDrop(s, atom))) paint()
            },
          })
        paint()
      },
      () => this.derivedHeadEl.querySelector('.mount-derived-filter')?.getBoundingClientRect() ?? null,
      trigger ? { el: trigger } : undefined,
    )
  }

  /** 改一份 chips：真变了才落、才重画这一屏（返回给弹层决定要不要跟着重画） */
  private mutateFilter(source: DerivedSource, fn: (s: QuickFilterState) => QuickFilterState | null): boolean {
    const next = fn(this.filterOf(source))
    if (!next) return false
    this.quickFilters.set(source, next)
    this.render()
    return true
  }

  /** chip 的显示名：按 id 经读门面现解析（名字是显示层的事，不进状态） */
  private atomLabel(atom: QuickFilterAtom): string {
    const id = 'up' in atom ? atom.up.is : atom.tag
    const block = this.deps.kb.get(id)
    return block ? displayNameOf(block) || id.slice(-4) : id.slice(-4)
  }

  private showView(host: Block, entry: MountEntry): void {
    /**
     * 大纲的岛根要**从文档里摘掉**，不能 dispose：
     * `EditableBlock.dispose()` 是终态（退订＋卸事件），而摘掉只是为了让同一块
     * 不在这一屏出现两份 `data-block-id`。切回大纲时再挂回去，撤销栈还在。
     */
    this.block.root.remove()
    this.editorEl.hidden = true
    this.emptyEl.hidden = true
    this.viewEl.hidden = false
    if (entry.kind === 'local') {
      // 按栏缓存：切 tab／切看法都不换实例（`mount()` ⇒ `sync()` 自会按激活视图换分支）
      let made = this.tabViews.get(entry.id) ?? null
      if (!made) {
        made = this.deps.createView?.(host, entry) ?? null
        if (made) this.tabViews.set(entry.id, made)
      }
      this.view = made
      this.ownedView = null
      if (made) {
        if (made.root.parentElement !== this.viewEl) this.viewEl.replaceChildren(made.root)
        made.mount()
        return
      }
    } else {
      // 派生栏：看法（kind）烤在实例里，现造现弃
      this.detachView()
      this.viewEl.hidden = false
      const made = this.deps.createView?.(host, entry) ?? null
      this.view = made
      this.ownedView = made
      if (made) {
        this.viewEl.replaceChildren(made.root)
        made.mount()
        return
      }
    }
    // 装配层没给视图体（这一档还没做渲染器）⇒ 给一句实话而不是空屏
    this.viewEl.replaceChildren()
    const p = document.createElement('p')
    p.className = 'tv-unsupported'
    p.textContent = t('ui.view.unsupported')
    this.viewEl.appendChild(p)
  }

  private detachView(): void {
    // 派生栏的实例是现造现弃的；local 栏的实例按栏缓存着，摘下来就行
    this.ownedView?.dispose()
    this.ownedView = null
    if (this.view) this.view.root.remove()
    this.view = null
    this.viewEl.hidden = true
    this.viewEl.replaceChildren()
    // 摘掉视图体之后把大纲的岛根挂回去（编辑器实例一直还在）
    if (this.block.root.parentElement !== this.bodyEl) this.bodyEl.insertBefore(this.block.root, this.viewEl)
  }

  /** 当前栏的展开栈（懒建；每栏一份，按稳定 id 记） */
  private expandedFor(id: string): Set<string> {
    let set = this.expandedByTab.get(id)
    if (!set) {
      set = new Set()
      this.expandedByTab.set(id, set)
    }
    return set
  }

  /**
   * 普通点面包屑：把那个祖先装成这一栏的根，**中心／历史不动**。
   * `rowId` 是点击那一格所在的行；`expandContexts` 用它算展开后滚到哪条命中。
   */
  private expand(ancestorId: string, rowId: string): void {
    if (!ancestorId) return
    this.expandedFor(this.active).add(ancestorId)
    this.render(rowId || undefined)
  }

  /** 「收起上下文」：只收这一层；内层还留在栈里，下一次渲染会浮出来 */
  private collapse(rootId: string): void {
    const set = this.expandedFor(this.active)
    if (!set.delete(rootId)) return
    this.render(this.covers.get(rootId)?.[0])
  }

  private showEmpty(text: string): void {
    this.detachView()
    this.emptyEl.textContent = text
    this.emptyEl.hidden = false
    this.editorEl.hidden = true
    this.editorEl.dataset.empty = '1'
  }

  /* ------------------------------------------------------------ 数据 */

}
