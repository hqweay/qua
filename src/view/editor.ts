/**
 * 视图层 —— **单一 contenteditable 容器 ＋ 块级 DOM** 的形状：单一 contenteditable 容器 ＋ **块级 DOM**（扁平 ＋ `data-depth`），
 * 行内原子用 `contenteditable=false`；没有被编辑的块不额外套 contenteditable。
 *
 * 两条实测逼出来的结论在此继续成立（不许破坏）：
 *  1. **缩进不用 DOM 层级，用扁平 ＋ data-depth ＋ padding**（DOM 层级与窗口化虚拟化互相打架）；
 *  2. **组合期（IME composing）不重渲染该块**，只改模型，`compositionend` 后再补渲染。
 *
 * 行内内容＝**run 序列**（`core/runs.ts`）：文本段带自己的格式，原子是序列里不可分的一枚。
 * ⇒ 正文没有「长度 1 的区间锚点」这回事：原子的位置由邻居携带，删原子一定是显式动作。
 * 折叠（收起的子树不挂 DOM；折叠态是**文档级视图状态**）、待办复选框、悬停左侧 gutter
 * （折叠箭头／圆点／拖拽把手）、拖拽重排（HTML5 DnD，before/after/inside 三区）。
 * 键盘**一个都不在这里处理**——全部交给绑定表。
 */
import {
  BlockStore,
  CommandLog,
  UndoStack,
  ancestorsByBlockId,
  cloneSubtree,
  depthOf,
  DIVIDER_TYPE,
  ensurePageDirect,
  ensurePageInTx,
  flatten,
  hasIdentity,
  hasList,
  isJournal,
  isPropDefBlock,
  isQueryBlock,
  indentMove,
  insertFirstChild,
  insertSiblingAfter,
  enterKind,
  locate,
  deleteBlockSpan,
  detectTrigger,
  mergeIntoPrev,
  mergeIntoPrevPlan,
  prevPlaceholder,
  removePrevPlaceholder,
  addTagId,
  ensureTag,
  hasTag,
  removeTagId,
  mkBlock,
  createObjRecordDirect,
  createObjRecordInTx,
  findInForest,
  applyMove,
  dropMove,
  normSel,
  outdentMove,
  tagIdsOf,
  selToTextRanges,
  setBlockType,
  siblingMove,
  splitBlockBefore,
  splitBlockIntoFirstChild,
  isFolded,
  removeBlock,
  toggleChildrenCollapsed,
  toggleCollapsed,
  unfoldBlock,
  uuidv7Hex,
  visibleRows,
  writeBlockContent,
  walkForest,
  gutterFieldsOf,
  gutterFieldsFor,
  setValue,
  todoOf,
  TASK_STATUS_PROP_ID,
  typeDeclOf,
  canWriteText,
  type Block,
  type CtxKeys,
  type Doc,
  type GutterField,
  type Located,
  type MovePlan,
  type Sel,
  type Snap,
  type TodoState,
  type TriggerChar,
  type TriggerHit,
  type UndoKind,
  type VisibleRow,
} from '../core/index.ts'
import {
  clearMarks as clearRunsMarks,
  fromProjection,
  insertRunAt,
  isEmptyContent,
  joinRuns,
  marksInRange,
  mkAnno,
  plainLen,
  plainText,
  projectOff,
  removeRunById,
  refRunsOf,
  runById,
  sameRuns,
  spliceRuns,
  splitRuns,
  textRuns,
  toggleMark as toggleRunMark,
  type ImageRun,
  type MarkType,
  type RefRun,
  type Run as InlineRun,
  type RunWithId,
} from '../core/runs.ts'
import { journalDateLabel, type SecLayout, type ShellCol } from '../core/index.ts'
export type { SecLayout }
// 只取**类型**：`view` 拿不到实现，写入的落地方式归装配层（见 `Run`）
import type { Tx } from '../core/kb/types.ts'
// 标签块的「找到或创建」有两种落地（直写 / 事务），判据只有一份
import { ensureTagInTx, tagLookupOf } from '../core/kb/ensure-tag.ts'
// 用户可见文案一律走 t
import { t } from '../core/msg.ts'
import { ALLOWED_ROW_CHILDREN, LINE_H, fillBlockText, isReadonlyBlock, makeBlockEl, visibleRowHeight } from './block-dom.ts'
import { blockIdOf, isTagChip, offsetIn, readRuns, textEndOff } from './dom-text.ts'
import { bindEditorEvents, type RefClickHit, type RefClickMods, type TriggerQuery } from './editor-events.ts'

export interface Probe {
  isComposing: boolean
  compositionSeq: string[]
  lastKey: { key: string; isComposing: boolean; trusted: boolean } | null
  lastCommand: { name: string; at: number; via: string } | null
  /** 按键命中追踪（诊断）：这个键命中了哪条规则 / 为什么没命中 */
  keyTrace: { key: string; hit: string; when: string; ok: boolean }[]
  traced: boolean
}

/**
 * **开一个事务**：`view` 只知道「有这么个函数」，不知道它是 `kb.tx`。
 *
 * 为什么是函数形状而不是一个 `kb` 句柄：写入必须是**同步**的（模型改完就返回结果，
 * 方法内要拿新块的 id 去放光标），而「怎么开事务、失败怎么回滚、op 交给谁攒」
 * 都是装配层的决定。`view` 只 import **类型**，不 import 实现 —— 层向内，`core ← view` 成立。
 *
 * 省略 ⇒ 编辑器照旧直改活块（迁移期的兜底，不是终点）。
 */
export type Run = <R>(fn: (tx: Tx) => R) => R

export interface ViewOpts {
  container: HTMLElement
  /** 写入事务入口，见 `Run`。装配层注入；省略时编辑器直改（迁移期） */
  write?: Run
  /**
   * **「点空白建块」的监听面**——通常比 `container` 大一圈
   * （编辑器 ＋ 它下方那段「还能往下写」的气口）。
   *
   * ⚠️ 省略时退化成 `container` 自己：那样点气口不建块（2026-10-20 探针实测，
   *    事件目标落在 `#scroll` 上，监听器根本不触发）。装配层**应当显式传**。
   */
  blankArea?: HTMLElement
  doc: Doc
  /**
   * **共享 block store**（下一层）：多个视图读同一份块/marks/atoms/undo。
   * 省略时编辑器自建一个（单视图兼容；测试/独立实例用）。
   */
  store?: BlockStore
  /** 是否允许「点空白建块」；反链/查询记录视图设为 false（视图序不是真实兄弟序） */
  allowBlankCreate?: boolean
  /** 是否允许删除 section 根；反链视图设为 false（删源块走命令面） */
  allowRootRemove?: boolean
  /**
   * 是否跟随共享 store **自动重载**（默认 true）。
   *
   * 槽里的钉住块要自己控制节奏：外部每次 store 变化都重画会让侧槽跟着正文每个按键抖动，
   * 所以那一类实例关掉自动重载，改由承载它的组件防抖后显式 `reloadFromStore()`。
   */
  autoReload?: boolean
  /**
   * **段的排列**（视图配置轴，不是导航）：`column`（单列流，缺省）｜`row`（段横排）｜`grid`（折行网格）。
   * 只改「段怎么摆」，不改「段是什么」——DOM 形状对所有 layout 一致（见 `renderRows` 的 `.sec`）。
   */
  layout?: SecLayout
}

export interface ViewEvents {
  /** 任何模型变化（持久化 + 角标刷新）。格式/原子改动也是内容改动 ⇒ 归 `text` */
  change?: (kind: 'text' | 'struct' | 'load') => void
  /** 光标前是不是在敲一个触发词（`/`／`#`／`@`）；`null` ＝ 这一段已经结束 */
  triggerQuery?: (hit: TriggerQuery | null, rect: DOMRect) => void
  /**
   * **点了一个「指向某块的露面」**：行内引用、行尾标签 chip 走同一条。
   *
   * 装配层据此决定去哪（左键开中心／Shift 开右槽／⌥ 看详情）。
   * `el` 只是详情浮层的锚点。
   * ⚠️ 未接的实例什么都不做——不静默退化成某一种（那会让「缺入口」看起来像成功）。
   */
  refClick?: (ref: RefClickHit, mods: RefClickMods, el?: HTMLElement) => void
  /** 悬停把手/圆点或右键 → 块菜单 */
  blockMenu?: (blockId: string, rect: DOMRect) => void
  /**
   * **左键点块标**：聚焦/zoom 到这个块。
   * 装配层把它接到 `core.block/focus-block`（面包屑那一格是同一个命令）。
   */
  focusBlock?: (blockId: string) => void
  /**
   * **Shift+左键点块标**：在右槽打开这个块（已打开则定位；不在则移过去）。
   *
   * 单独一个回调而不是在事件层看 `shiftKey` 调 `focusBlock`：事件层不该知道
   * 「右槽」与「窗口」这层语义，它只负责把修饰键翻译成另一个动作。
   *
   * ⚠️ 未接的独立/测试实例**什么都不做**，不再退化为中心 zoom——
   *    那是上一版的 bug：反链 footer／查询／标签面板的 Shift+点看起来有反应，
   *    其实只是把中心换成了同一个块。生产装配的每个编辑器都必须接它（冒烟逐入口钉住）。
   */
  openInDock?: (blockId: string) => void
  /**
   * 模型选区变了（**划选气泡的驱动**，2026-10-19）。
   * 只有这里知道「选区到底变了没有」——气泡不能靠猜，否则每次按键都会重建 DOM。
   */
  selChange?: () => void
  /** 重新挂载窗口后（虚拟化） */
  mounted?: () => void
  /**
   * **在空天格子里落笔**（复盘兜底）：装配层物化那一天并重装载。
   * 编辑器只报日期——「造块进库」是命令层的事，视图不写库。
   */
  shellWrite?: (date: string) => void
  /**
   * **一次改名被拒**（编辑边界上撞到已有地址，正文已回滚）。
   *
   * 为什么从编辑器里报、而不是让每个调用方看返回值：三个边界入口都可能撞名，
   * 各处自己弹提示就会漏一处或重复弹一次；提交是同一个函数，拒绝也就只有一个出口。
   * `name` 是**用户敲的那个名字**（回滚前取），`conflict` 是已经占用它的块。
   */
  editRejected?: (name: string, conflict: Block) => void
}

/**
 * 一次编辑期开始前的快照（**只记正文**）。
 *
 * 地址不在这里：正文是描述，写它不改地址；地址只有「显式改名」一条写路径。
 * 旧实现连 `_alias` 一起记、在提交时改地址，于是每敲一次字都可能重命名一次。
 */
interface EditBase {
  id: string
}

/**
 * 浮层选中之后的**落点**（由触发字符那一栏决定，不由行决定）。
 *
 * · `ref`：正文里插一枚指向它的引用（`flavor:'#'` 就是行内标签的露面）；
 * · `newObj`：同一笔里建出标签块（缺则建）＋ 建一条落在今天的记录，再插指向记录的露面；
 * · `tag`：**只归类**——抹掉触发词、把标签写进本块的 `_tags`（行尾出 chip）。
 */
export type AcceptPick =
  | { kind: 'ref'; to: string; label: string; flavor?: '#' }
  | { kind: 'newObj'; name: string }
  | { kind: 'newPage'; name: string }
  /** 新标签是**目标**；三种键各给一个落点（`inline` 行内 / `assign` 块标签 / `instance` 新实例） */
  | { kind: 'newTag'; name: string; action: 'inline' | 'assign' | 'instance' }
  | { kind: 'tag'; name: string }

export class BlockEditor {
  container: HTMLElement
  doc: Doc
  /** 共享数据 store；`marks`/`atoms`/`undo` 都是它的投影（getter 转发） */
  store: BlockStore
  /** 本视图装载的 root id（reload 时按 id 从 store 重新取；不持有拷贝） */
  viewRootIds: string[] = []
  log = new CommandLog()
  probe: Probe = {
    isComposing: false,
    compositionSeq: [],
    lastKey: null,
    lastCommand: null,
    keyTrace: [],
    traced: true,
  }
  sel: Sel | null = null
  virtualize = false
  radius = 12
  mounted = new Set<string>()
  events: ViewEvents = {}

  /** 共享 undo 栈；depth/clear 与所有视图一致 */
  get undo(): UndoStack {
    return this.store.undoStack
  }

  /**
   * **可点导轨的祖先表**：`blockId → [祖先 id…]`（index = 层级 k）。
   *
   * ⚠️ 它对**全量可见行**算，不对 `applyWindow` 的 slice 算——否则窗口从中间开始时，
   *    第一行的祖先全丢（调研 点名的唯一易错处）。所以只在
   *    `renderAll` / `applyWindow` / `renderBlock` 入口重建，渲染单行时查表。
   */
  private ancestors = new Map<string, string[]>()

  private dragId: string | null = null
  private dropEl: HTMLElement | null = null
  /**
   * **块选区**（2026-10-20）：跨块拖拽/Shift 选择的是**整块**，不是文本。
   * `ids` 是当前视图的可见行；
   * `anchor` 是起点块（后续 Shift 范围用）。**视图状态，不入 KB。**
   */
  private blockSel: { ids: string[]; anchor: string } | null = null
  /** 鼠标拖选的临时状态：pending 时还没跨块，仍是原生文本选择 */
  private mouseSel: { startId: string; active: boolean } | null = null
  /**
   * **进入这次编辑时**那一行是什么（正文 ＋ 地址）。
   *
   * 为什么要有它：校验放在编辑边界，而离开那一刻正文已经被敲进去了 —— 要回滚就得知道
   * 「改名前」是什么。记在**第一次把 DOM 同步进模型之前**（`syncFromDom` 的第一笔），
   * 而不是聚焦那一刻：聚焦之后、第一次敲键之前，别处命令也可能合法地改过这一块，
   * 那不属于「这次编辑」，不该被回滚带走。
   */
  private editBase: EditBase | null = null
  /**
   * 这个编辑期里**有没有内容落进过模型**（见 `stampEdited`）。
   *
   * 为什么不在边界上「比内容」：编辑期的起点在**第一次落字之前**，落字那一刻
   * `syncFromDom` 会 `beginEdit` 重开一个编辑期 —— 等边界到来时「起点」早就等于
   * 此刻了，比较永远相等。真正要记的是「这段时间里写没写过」这一位。
   */
  /**
   * 这个编辑期里**被写过**的块：到边界时给它们记一次修改时间。
   *
   * ⚠️ 为什么是「按块 id 的集合」而不是一个布尔：编辑期会在**每一笔输入**上重开
   *    （`syncFromDom` → `beginEdit` → `rebase`），一个布尔标记会被那次重开清掉，
   *    于是边界永远看不到「写过」。块的粒度不受编辑期怎么切的影响。
   */
  private edited = new Set<string>()
  /** 「点空白建块」的监听面：比 container 大一圈，见 `ViewOpts.blankArea` */
  blankArea: HTMLElement
  private allowBlankCreate: boolean
  private allowRootRemove: boolean
  /** 段的排列（视图配置；`data-layout` 供 CSS 选择，见 `setLayout`）；装配层按它挡住只属单列的行为 */
  private _layout: SecLayout = 'column'
  /** 复盘的空天格子（纯视图兜底，不进库）；换页／换形态即清空 */
  private shells: readonly ShellCol[] = []
  get layout(): SecLayout {
    return this._layout
  }
  /**
   * 写入事务入口（装配层注入，见 `Run`）。
   *
   * 目前由 `setText`／`editBlock`／`syncFromDom` 的主路径使用；还有一批写方法在直改活块，
   * 逐个接过来、接一个有断言一个，免得「一次改全线」把行为变化的来源和管道本身混在一起。
   */
  write: Run | undefined
  /** store 订阅与事件绑定的卸载函数（`dispose` 用；视图被移除后不该继续收通知） */
  private readonly offStore: () => void
  private readonly unbind: () => void

  constructor(o: ViewOpts) {
    this.container = o.container
    this.blankArea = o.blankArea ?? o.container
    this.allowBlankCreate = o.allowBlankCreate !== false
    this.allowRootRemove = o.allowRootRemove !== false
    this.write = o.write
    this.doc = o.doc
    this.setLayout(o.layout ?? 'column')
    /**
     * **冷启动也必须有 root id**。
     *
     * 冷启动走的是构造参数（`doc: { roots: bootRoots }`），不经过 `loadPage()`；
     * 空 id 列表会让第一次 `reloadFromStore()`（undo 或别的视图 `touch`）把
     * `doc.roots` 重载成空 ——正文看起来被清空了，而块其实还在 store 里。
     */
    this.viewRootIds = o.doc.roots.map((b) => b.id)
    this.store = o.store ?? new BlockStore(o.doc.roots)
    this.offStore =
      o.autoReload === false
        ? () => {}
        : this.store.subscribe((source?: unknown) => {
            // 发起编辑的视图自己已经渲染过；其他视图按 root id 从 store 重取（共享对象，不拷贝块数据）
            if (source !== this) this.reloadFromStore()
          })
    this.container.setAttribute('contenteditable', 'true')
    this.container.setAttribute('spellcheck', 'false')
    this.unbind = this.bind()
    this.renderAll()
  }

  /** 从文档里摘掉这个视图：退订 store、卸掉事件（否则游离容器还会继续被重画） */
  dispose(): void {
    this.offStore()
    this.unbind()
  }

  /* ------------------------------------------------------------ 快照 */

  snap(): Snap {
    // 快照是**整片森林**（store 的 blocks + marks + atoms），不是当前视图的拷贝
    return this.store.snap(this.sel)
  }

  restore(s: Snap): void {
    // 整片森林被换掉 ⇒ 「改名前」已经无处可指，这个编辑期作废
    this.editBase = null
    // store 原地恢复并通知其他视图；发起者自己重取 roots/选区
    const sel = this.store.restore(s, this)
    this.sel = sel
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  /**
   * 从 store 重取本视图的 roots（按 id），并重渲染。
   * 不拷贝块数据：`doc.roots` 里就是 store 里的活块。
   *
   * ⚠️ 其他视图收到 `touch` 时调用；不触发 `events.change`（否则会回写成“编辑”）。
   */
  reloadFromStore(restoreSelection = true): void {
    const roots = this.viewRootIds
      .map((id) => this.store.find(id))
      .filter((b): b is Block => Boolean(b))
    // 折叠表属于**这一份文档**（视图各带各的），换 roots 时原样保留
    this.doc = { roots, folded: this.doc.folded }
    const focused = this.container.contains(document.activeElement)
    this.renderAll()
    if (restoreSelection && focused) this.restoreSel()
  }

  /* ------------------------------------------------------------ 渲染 */

  blockEl(id: string): HTMLElement | null {
    return this.container.querySelector<HTMLElement>(`.blk[data-block-id="${id}"]`)
  }

  txEl(id: string): HTMLElement | null {
    return this.blockEl(id)?.querySelector<HTMLElement>('.tx') ?? null
  }

  /** 可见行（**折叠的子树在这里被排除**） */
  rows(): VisibleRow[] {
    return visibleRows(this.doc).filter((r) => !r.hidden)
  }

  /**
   * 重建祖先表（**全量可见行**）。
   * 每个改结构的入口都要调它——导轨画的是「此刻的树」，不是「上次渲染的树」。
   */
  private rebuildAncestors(): void {
    this.ancestors = ancestorsByBlockId(this.rows())
  }

  /**
   * 切换段的排列。只动一个属性 ＋ 一个 DOM 属性：DOM 形状（`.sec` 包裹）对所有 layout
   * 一致，布局差异全部由 CSS（`#editor[data-layout]`）承担，不需要重渲染。
   */
  setLayout(mode: SecLayout): void {
    this._layout = mode
    this.container.dataset.layout = mode
    this.applySecCols()
  }

  /** grid 的列数由段数推导（`--sec-cols` 供 CSS 的 `repeat()`）；其余 layout 无意义，清掉 */
  private applySecCols(): void {
    if (this.layout === 'grid') this.container.style.setProperty('--sec-cols', String(Math.max(1, this.doc.roots.length)))
    else this.container.style.removeProperty('--sec-cols')
  }

  /**
   * 空天格子（复盘兜底）：窗口里没写过的天渲染成空壳列——**只在 row/grid 下有意义**，
   * column 不渲染（单列流维持「不造空天」）。格子是纯 DOM（没有块），点进去 ⇒ `shellWrite(date)`。
   */
  setShells(cols: readonly ShellCol[]): void {
    this.shells = cols
    this.renderAll()
  }

  /** 造一列空壳：只读日期头 ＋ 一行「点一下开始写」的落笔位（与真实日期行同一个视觉形状） */
  private makeShellSec(col: ShellCol): HTMLElement {
    const sec = document.createElement('div')
    sec.className = 'sec'
    sec.dataset.shell = col.date
    const head = document.createElement('div')
    head.className = 'blk'
    head.dataset.depth = '0'
    head.dataset.role = 'journal'
    const headTx = document.createElement('span')
    headTx.className = 'tx'
    headTx.contentEditable = 'false'
    headTx.dataset.readonly = '1'
    headTx.dataset.ph = journalDateLabel(col.date)
    headTx.dataset.phReadonly = '1'
    head.appendChild(headTx)
    const write = document.createElement('div')
    write.className = 'blk shell-row'
    write.dataset.depth = '1'
    write.contentEditable = 'false'
    const writeTx = document.createElement('span')
    writeTx.className = 'tx'
    writeTx.dataset.ph = t('ui.feed.shellHint')
    write.appendChild(writeTx)
    sec.append(head, write)
    return sec
  }

  renderAll(): void {
    this.container.textContent = ''
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    // 虚拟化只属单列流：row/grid 的段要完整的盒子才能当列用，窗口切片会把列切残
    if (this.virtualize && this._layout === 'column') {
      this.applyWindow()
      return
    }
    this.renderRows(this.rows())
    this.markCaret()
    this.paintBlockSel()
    this.events.mounted?.()
  }

  /**
   * 挂一列可见行。
   *
   * gutter 字段在**循环外**按整批算一次：每行各自扫库会让整屏渲染退化成 O(n²)，
   * 而这种退化不报错、只是越用越慢。
   *
   * **段物质化**：连续的行按段包进 `.sec[data-sec]`——depth 0 的行开新段。
   * `.sec` 只表达段边界，不表达层级（行在段内仍是扁平的 ＋ `data-depth`）；
   * 缺省布局下它是 `display: contents`（零几何影响），`row`/`grid` 才由 CSS 给它盒子。
   * ⚠️ 虚拟化的窗口切片可能从段中间开始：那一段的 `.sec` 没有段根行，
   *    `data-sec` 落空串——分割线与「点空白归段」的判据都依赖段根在场。
   */
  private renderRows(rows: readonly VisibleRow[]): void {
    const gutters = gutterFieldsFor(
      rows.map((r) => r.block),
      this.store.blocks,
    )
    let sec: HTMLElement | null = null
    for (const r of rows) {
      if (r.depth === 0 || sec === null) {
        // 新的一段之前，先摆按列序应出现在这里的空天格子（复盘兜底；column 下 shells 恒空）
        if (r.depth === 0) {
          for (const col of this.shells) if (col.beforeRootId === r.block.id) this.container.appendChild(this.makeShellSec(col))
        }
        sec = document.createElement('div')
        sec.className = 'sec'
        sec.dataset.sec = r.depth === 0 ? r.block.id : ''
        this.container.appendChild(sec)
      }
      sec.appendChild(this.makeBlockEl(r, gutters.get(r.block.id)))
    }
    // 比所有已装段都更早的空天格子：追加在最后
    if (this.layout !== 'column') {
      for (const col of this.shells) if (col.beforeRootId === null) this.container.appendChild(this.makeShellSec(col))
    }
  }

  /** 所有模型变化统一出口：通知其他视图（共享 store），再通知装配层持久化/刷新 */
  /**
   * @param ids 这次**动过哪些块**（可选）。查询视图靠它判断「结果里的块变没变」，
   *            而不是靠「store 被碰过几次」——后者会把刷新顺带的重渲染也算成过期。
   *            ⚠️ 只给拿得到精确 id 的路径传（文本编辑、todo、删除）；结构操作先不传，
   *            订阅方必须容忍 `ids === undefined`（那就是「不知道，按整体处理」）。
   */
  private emitChange(kind: 'text' | 'struct' | 'load', ids?: readonly string[]): void {
    if (kind !== 'load') this.store.touch(this, ids)
    this.events.change?.(kind)
  }

  renderBlock(id: string): void {
    const loc = locate(this.doc, id)
    const el = this.blockEl(id)
    if (!loc || !el) return
    const row = this.rows().find((r) => r.block.id === id) ?? {
      block: loc.block,
      depth: depthOf(this.doc, id),
      hidden: false,
      hasChildren: loc.block.children.length > 0,
    }
    // 单行重画只有一行，直接按这一个块算 —— 不必为了一行去扫整批
    el.replaceWith(this.makeBlockEl(row, gutterFieldsOf(row.block, this.store.blocks)))
    // 被换掉的那个元素带着 `data-caret` ⇒ 缓存与标记都要重来
    this.caretMarks = ''
    this.markCaret()
    this.paintBlockSel()
  }

  /**
   * @param gutter 这一行的 gutter 字段，**由调用方算好**：`block-dom` 是渲染层，没有森林；
   *               让它自己去扫一遍全库就等于「每画一行扫一次」。批量路径只扫一次库。
   */
  private makeBlockEl(r: VisibleRow, gutter: readonly GutterField[] | undefined): HTMLElement {
    // 引用解析走**共享 store** 的森林：引用目标可能在当前视图之外（另一页／另一天），
    // 只有整片森林能回答「它还在不在、现在叫什么」。
    const el = makeBlockEl(
      r,
      (tx) => fillBlockText(tx, r.block, (id) => this.store.find(id)),
      {
        single: flatten(this.doc).length === 1,
        ancestors: this.ancestors.get(r.block.id) ?? [],
        folded: this.doc.folded,
        gutter,
        find: (id) => this.store.find(id),
      },
    )
    this.mounted.add(r.block.id)
    return el
  }

  /* ------------------------------------------------------- DOM → 文本 */

  offsetIn(root: HTMLElement, node: Node, off: number): number {
    return offsetIn(root, node, off)
  }

  /** 读回块内容（DOM → run 序列；原子按 `data-atom-id` 原样带回）。委托 `view/dom-text` */
  readRunsOf(id: string): InlineRun[] {
    const tx = this.txEl(id)
    const b = locate(this.doc, id)?.block
    if (!tx || !b) return b ? b.content : []
    return readRuns(tx, b.content)
  }

  blockOf(node: Node | null): string | null {
    return blockIdOf(node, this.container)
  }

  /** 当前 DOM 选区 → 模型选区 */
  readSel(): Sel | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return null
    const r = s.getRangeAt(0)
    const a = this.blockOf(r.startContainer)
    const b = this.blockOf(r.endContainer)
    if (!a || !b) return null
    const aTx = this.txEl(a)
    const bTx = this.txEl(b)
    if (!aTx || !bTx) return null
    return {
      aBlock: a,
      aOff: this.offsetIn(aTx, r.startContainer, r.startOffset),
      hBlock: b,
      hOff: this.offsetIn(bTx, r.endContainer, r.endOffset),
    }
  }

  /** 让模型选区跟上 DOM（**选区由模型持有**，DOM Range 只是它在视窗内的表现） */
  syncSel(): void {
    // 插入点跑到正文槽之外时先收回来（否则下面的读数会把一处「不存在的位置」当成偏移）
    if (this.reclaimCaret()) return
    const s = this.readSel()
    if (!s) return
    /**
     * **光标换到另一块 ＝ 上一次编辑的结束。**
     *
     * 为什么不能只靠 `focusout`：整片编辑区是**一个** contenteditable 容器，
     * 在同一个容器里从父块点到子块（或反过来）**不会派发 `focusout`**，
     * 那个边界就永远不来了 —— 表现为「改完点进子块，修改时间不动」，
     * 而且不报错。光标换块这件事在这里能看见，它就是唯一可靠的落点。
     *
     * ⚠️ 判据是 `editBase` 那一块 vs 新光标块，不是 `this.sel`：`this.sel` 已经被
     *    各种路径改写过，拿它比会漏掉。`commitEdit` 幂等，重复调用无害。
     */
    if (this.editBase && this.editBase.id !== s.aBlock) this.commitEdit(this.editBase.id)
    // 不在这里清块选区：mouseup 前后浏览器会短暂恢复文本 Range，会误杀刚建好的块选区。
    // 块选区的退出来自显式动作（在 .tx 里 mousedown / Shift+拖 / Esc / Enter / 点空白 / 菜单）。
    // 只有**真的变了**才上报：否则气泡会在每次 selectionchange 上重建（打字时每帧一次）
    const same =
      this.sel !== null &&
      this.sel.aBlock === s.aBlock &&
      this.sel.aOff === s.aOff &&
      this.sel.hBlock === s.hBlock &&
      this.sel.hOff === s.hOff
    this.sel = s
    this.markCaret()
    if (!same) this.events.selChange?.()
  }

  /**
   * **插入点现在落在可写正文槽（`.tx`）里吗** —— 这是唯一允许输入的地方。
   *
   * 为什么需要一个独立判据：整片编辑区是**一个** contenteditable 容器，行容器 `.blk`
   * 于是也可编辑。插入点一旦跑到 `.tx` 之外（行容器自己、gutter 与正文之间的缝、
   * 只读的日期行），打出来的字会变成**裸节点挂在 `.blk` 里**：`readRuns` 只读 `.tx`
   * ⇒ 模型里什么都没有，重渲染一过就消失（用户当场看到「字在块前面」，事后找不着）。
   */
  caretInWritableTx(): boolean {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return false
    const n = s.anchorNode
    const el = n?.nodeType === Node.ELEMENT_NODE ? (n as HTMLElement) : n?.parentElement
    const tx = el?.closest<HTMLElement>('.tx')
    return Boolean(tx && !tx.closest('[data-readonly]'))
  }

  /**
   * **把跑到正文槽之外的插入点收回来**。
   *
   * 收法刻意**不重建这一行**：重建会把角色元素（块标／把手）整个换掉，
   * 而这条路径可能正发生在「按在把手上、还没开始拖」的那一瞬（`mousedown` 之后、
   * `dragstart` 之前）——换了元素，这一次拖拽就断了。
   * 所以只做两件事：清掉浏览器塞进 `.blk` 的游离节点，再把光标按模型选区放回去
   * （模型没有选区就干脆不留光标：一个不属于任何块的光标本来就是错的状态）。
   *
   * @returns 是否真的收回了一次（正常编辑一次都不会走到这里）
   */
  reclaimCaret(): boolean {
    // 拖拽 / 块拖选进行中：此刻的 DOM 选区不是「插入点」，别去动它
    if (this.dragId !== null || this.mouseSel?.active) return false
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return false
    const node = s.anchorNode
    if (!node || !this.container.contains(node)) return false
    if (this.caretInWritableTx()) return false
    // ① 清掉游离内容：`.blk` 的直接子节点只允许这几类（其余是浏览器顺手塞进来的）
    const host = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement
    const blk = host?.closest<HTMLElement>('.blk')
    if (blk) {
      for (const c of Array.from(blk.childNodes)) {
        if (c.nodeType === Node.TEXT_NODE) {
          if ((c.textContent ?? '').trim() !== '') blk.removeChild(c)
          continue
        }
        if (c.nodeType !== Node.ELEMENT_NODE) continue
        const cls = (c as HTMLElement).className
        if (typeof cls === 'string' && ALLOWED_ROW_CHILDREN.has(cls)) continue
        blk.removeChild(c)
      }
    }
    // ② 光标按模型选区放回去
    if (this.sel) this.restoreSel()
    else s.removeAllRanges()
    return true
  }

  /**
   * 给**光标所在行**打 `data-caret="1"`。
   *
   * 为什么需要它：空块的占位符是 `::before` 生成内容（`data-ph`），浏览器把光标放在
   * 它**之后** ⇒ 用户看到「空块|」——像是「空块」两字是正文（2026-10-20 用户实机指出）。
   * 有了这个标记，CSS 就能在**这一行有光标时**把占位符藏掉（`.blk[data-caret] .tx[data-ph]::before`），
   * 而不是去猜「编辑器有没有焦点」（整片容器共用一个焦点，猜不出来）。
   *
   * ⚠️ 只在**块 id 变了**时才动 DOM：`selectionchange` 在打字时很密，逐个块删属性会掉帧。
   */
  private caretMarks = ''

  private markCaret(): void {
    const id = this.sel?.aBlock ?? ''
    if (id === this.caretMarks) return
    this.caretMarks = id
    for (const el of Array.from(this.container.querySelectorAll<HTMLElement>('.blk'))) {
      if (el.dataset.blockId === id) el.dataset.caret = '1'
      else delete el.dataset.caret
    }
  }

  /** 当前选区在屏幕上的矩形（划选气泡要锚在它上方；空选区给 null） */
  selectionRect(): DOMRect | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0 || s.isCollapsed) return null
    const r = s.getRangeAt(0).getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return r
  }

  caretBlock(): string | null {
    return this.sel?.aBlock ?? null
  }

  caretOffset(): number {
    return this.sel?.aOff ?? 0
  }

  caretRect(): DOMRect | null {
    const s = document.getSelection()
    if (!s || s.rangeCount === 0) return null
    const r = s.getRangeAt(0).cloneRange()
    r.collapse(true)
    let rect = r.getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      const host = this.txEl(this.blockOf(r.startContainer) ?? '')
      rect = (host ?? this.container).getBoundingClientRect()
    }
    return rect
  }

  /**
   * (块 id, 块内偏移) → DOM 位置。`placeCaret` 与 `selectAll` 共用。
   * ⚠️ 空块没有文本节点（只有 `<br>`）⇒ 落到元素位置（`tx.childNodes.length`），
   *    这是空行唯一能放光标的地方（与 `fillBlockText` 的 trailing `<br>` 是同一招）。
   */
  private posAt(id: string, offset: number): { node: Node; off: number } | null {
    const tx = this.txEl(id)
    if (!tx) return null
    const target = { node: tx as Node, off: 0 }
    let acc = 0
    let done = false
    /** walk 有没有摸到过正文内容：空块与「offset 越过正文末尾」的落点不同 */
    let sawContent = false
    const walk = (n: Node): void => {
      if (done || isTagChip(n)) return
      if (n.nodeType === Node.TEXT_NODE) {
        sawContent = true
        const len = (n.textContent ?? '').length
        if (acc + len >= offset) {
          target.node = n
          target.off = Math.max(0, offset - acc)
          done = true
          return
        }
        acc += len
        return
      }
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.atomId) {
        sawContent = true
        if (acc + 1 > offset) {
          target.node = n.parentNode ?? tx
          target.off = Array.from((n.parentNode ?? tx).childNodes).indexOf(n as ChildNode)
          done = true
          return
        }
        acc += 1
        return
      }
      for (const c of Array.from(n.childNodes)) walk(c)
    }
    walk(tx)
    if (!done) {
      target.node = tx
      /**
       * 有正文的落到「正文末尾、chip 之前」（textEndOff 的职责）。
       * **空块**（只有 `<br>`，可能再跟一枚 chip）必须落到元素 0 位：
       * 「br 与 chip 之间」不是 Chrome 认的稳定光标位——下一次按键前它会把光标
       * 自己挪到别处（contenteditable=false 的邻居它不认），随后的删除键就按
       * 挪错的位置走原生删除，把整行的内联元素整段摘掉，那一行从此没有
       * 可落光标的地方（⌥Enter 归类后的空行真踩过）。(tx, 0) 是 Chrome 对
       * `<br>` 占位空段的标准光标位，稳定。
       */
      const end = textEndOff(tx)
      target.off = sawContent || end === tx.childNodes.length ? end : 0
    }
    return target
  }

  placeCaret(id: string, offset: number, extend = false): void {
    const pos = this.posAt(id, offset)
    if (!pos) return
    const r = document.createRange()
    r.setStart(pos.node, pos.off)
    r.collapse(true)
    const s = document.getSelection()
    if (!s) return
    if (!extend) s.removeAllRanges()
    s.addRange(r)
    this.sel = { aBlock: id, aOff: offset, hBlock: id, hOff: offset }
    this.markCaret()
  }

  /**
   * **⌘A：全选这一屏的块**（要求的「必须接管」之一，2026-10-20 落地）。
   *
   * 为什么必须自己接管、而不是留给浏览器：
   *   Chrome 在「编辑区里含 `contenteditable=false` 子树」时，**原生全选会退化成空选区**
   *   ——实测：journal 行标成只读后，⌘A 从「231 字／4 块」变成「0 字／1 块」；
   *   把那一行改回可编辑立刻恢复（115 字／4 块）。这不是我们的 bug，但**后果落在用户身上**。
   * ⇒ 自己拼一个跨块 Range（首块块首 → 末块块尾），并同步模型选区（`aBlock`≠`hBlock`）。
   *
   * ⚠️ 跨块选区在模型里是合法的（`Sel` 有 `aBlock`/`hBlock`），但**跨块编辑**（删除/替换）
   * 第 1 期仍不支持块集合选区（属后续内核工作）；这里只负责「选得上」。
   */
  selectAll(): boolean {
    this.clearBlockSelection()
    /**
     * ⚠️ **起选点必须避开只读行**：Chrome 会把「起点在 `contenteditable=false`
     *    子树里」的选区**钳成空选区**（实测：起点在容器／只读行 ⇒ 0 字 1 块；
     *    起点在第一行普通文本 ⇒ 88 字 3 块）。所以从**第一个可编辑行**起选。
     */
    const rows = this.rows().filter((r) => !isReadonlyBlock(r.block))
    if (rows.length === 0) return false
    const first = rows[0]!.block
    const last = rows[rows.length - 1]!.block
    /**
     * **⌘A 两次升级**：第一次文本全选；当整屏可编辑文本已经全选时，
     * 再按一次 ⌘A ⇒ 升级成**块选区**。
     */
    const endOff = plainLen(last.content)
    if (
      this.sel &&
      this.sel.aBlock === first.id &&
      this.sel.aOff === 0 &&
      this.sel.hBlock === last.id &&
      this.sel.hOff === endOff &&
      this.blockSel === null
    ) {
      return this.selectAllBlocks()
    }
    const a = this.posAt(first.id, 0)
    const b = this.posAt(last.id, endOff)
    if (!a || !b) return false
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(b.node, b.off)
    const s = document.getSelection()
    if (!s) return false
    s.removeAllRanges()
    s.addRange(r)
    this.sel = { aBlock: first.id, aOff: 0, hBlock: last.id, hOff: endOff }
    this.markCaret()
    this.events.selChange?.()
    return true
  }

  /* --------------------------------------------------------- 块选区 */

  hasBlockSelection(): boolean {
    return this.blockSel !== null && this.blockSel.ids.length > 0
  }

  blockSelectionCount(): number {
    return this.blockSel?.ids.length ?? 0
  }

  blockSelectionIds(): string[] {
    return this.blockSel ? [...this.blockSel.ids] : []
  }

  inBlockSelection(id: string): boolean {
    return Boolean(this.blockSel?.ids.includes(id))
  }

  /** 当前视图的**可见内容行**（排除 section 根；折叠子树不出现） */
  private visibleIds(): string[] {
    return this.rows()
      .filter((r) => r.depth > 0)
      .map((r) => r.block.id)
  }

  /** 从 a 到 b 的可见块区间（文档序，含两端） */
  private blockRange(a: string, b: string): string[] {
    const ids = this.visibleIds()
    const i = ids.indexOf(a)
    const j = ids.indexOf(b)
    if (i < 0 || j < 0) return []
    const [lo, hi] = i <= j ? [i, j] : [j, i]
    return ids.slice(lo, hi + 1)
  }

  /** 全选块：只选**非根、可编辑**的可见块（section 根/日记日期不选） */
  selectAllBlocks(): boolean {
    const ids = this.rows()
      .filter((r) => r.depth > 0 && !isReadonlyBlock(r.block))
      .map((r) => r.block.id)
    if (ids.length === 0) return false
    this.blockSel = { ids, anchor: ids[0]! }
    this.sel = null
    document.getSelection()?.removeAllRanges()
    this.markCaret()
    this.paintBlockSel()
    this.events.selChange?.()
    return true
  }

  clearBlockSelection(): void {
    if (!this.blockSel) return
    this.blockSel = null
    this.paintBlockSel()
    this.events.selChange?.()
  }

  /** Enter：清块选区，光标落到**首个选中块**的 0 位，不建块 */
  focusFirstSelected(): boolean {
    const first = this.blockSel?.ids[0]
    if (!first) return false
    this.blockSel = null
    this.paintBlockSel()
    this.placeCaret(first, 0)
    this.events.selChange?.()
    return true
  }

  /**
   * `Shift+↑/↓` 的边界规则：
   * - 已有块选区 ⇒ 扩展一块；
   * - 否则只有 caret 在**块文本首/尾**时才起块选区；文本内部返回 false（让原生文本选区接手）。
   */
  extendBlockSelection(dir: -1 | 1): boolean {
    const ids = this.visibleIds()
    if (this.blockSel) {
      const anchor = this.blockSel.anchor
      const endId = dir > 0 ? this.blockSel.ids[this.blockSel.ids.length - 1] : this.blockSel.ids[0]
      const ei = endId ? ids.indexOf(endId) : -1
      if (ei < 0) return false
      const ni = ei + dir
      if (ni < 0 || ni >= ids.length) return false
      const next = this.blockRange(anchor, ids[ni]!)
      if (next.length === 0) return false
      this.blockSel = { ids: next, anchor }
      this.sel = null
      document.getSelection()?.removeAllRanges()
      this.paintBlockSel()
      this.events.selChange?.()
      return true
    }
    const s = this.sel
    if (!s || s.aBlock !== s.hBlock || s.aOff !== s.hOff) return false
    const loc = locate(this.doc, s.aBlock)
    if (!loc || loc.parent === null) return false
    const len = plainLen(loc.block.content)
    const off = Math.max(0, Math.min(s.aOff, len))
    if (dir > 0 ? off !== len : off !== 0) return false
    this.blockSel = { ids: [s.aBlock], anchor: s.aBlock }
    this.sel = null
    document.getSelection()?.removeAllRanges()
    this.paintBlockSel()
    this.events.selChange?.()
    return true
  }

  /**
   * 鼠标拖选的起点：**在 `.tx` 内按下**时调用。
   * - Shift：清块选区，交给原生文本选择（**我们的增量**：纯文本编辑器的选区跨不了块）；
   * - 否则进入 pending：**只有拖过块边界**才切成块选区（单块内拖仍是文本）。
   */
  beginMouseSelect(id: string, _x: number, _y: number, shiftKey: boolean): void {
    const loc = locate(this.doc, id)
    // section 根不参与块拖选（页名/天日期/zoom 根）：留给原生文本选择
    if (!loc || loc.parent === null) return
    this.clearBlockSelection()
    // 旧的原生文本选区必须先清掉：否则从选区里按下会触发浏览器的“拖拽选中文本”，
    // 后续 mousemove 变成 DnD、块选区永远起不来（本机探针复现）。
    if (!shiftKey) {
      document.getSelection()?.removeAllRanges()
      this.sel = null
      this.markCaret()
    }
    this.mouseSel = shiftKey ? null : { startId: id, active: false }
  }

  /** 返回 true 表示已进入块选区（事件层据此 preventDefault） */
  updateMouseSelect(x: number, y: number): boolean {
    const d = this.mouseSel
    if (!d) return false
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-block-id]')
    const id = el?.dataset.blockId
    if (!d.active) {
      if (!id || id === d.startId) return false
      d.active = true
      this.container.classList.add('blocksel-drag')
      this.sel = null
      document.getSelection()?.removeAllRanges()
    }
    if (id) {
      const ids = this.blockRange(d.startId, id)
      if (ids.length) {
        this.blockSel = { ids, anchor: d.startId }
        this.paintBlockSel()
      }
    }
    return true
  }

  endMouseSelect(): void {
    const d = this.mouseSel
    this.mouseSel = null
    this.container.classList.remove('blocksel-drag')
    if (d?.active) {
      this.paintBlockSel()
      this.events.selChange?.()
    }
  }

  /** 选中块的**最上层根**（祖先也在选区内 ⇒ 只留祖先，避免删父又删子） */
  private blockSelRoots(): Block[] {
    const set = new Set(this.blockSel?.ids ?? [])
    return flatten(this.doc).filter((b) => {
      if (!set.has(b.id)) return false
      let p = locate(this.doc, b.id)?.parent ?? null
      while (p) {
        if (set.has(p.id)) return false
        p = locate(this.doc, p.id)?.parent ?? null
      }
      return true
    })
  }

  /** 删除选中的块（一次撤销；子树随块走；section 根不删） */
  deleteSelectedBlocks(): boolean {
    const roots = this.blockSelRoots().filter((b) => locate(this.doc, b.id)?.parent !== null)
    if (roots.length === 0) return false
    const before = this.snap()
    const flat = flatten(this.doc)
    const firstIdx = Math.min(...roots.map((b) => flat.findIndex((x) => x.id === b.id)))
    // 落点先算好再动手：删除进行中再 locate，读的是一棵已经少了几块的树
    const targets = [...roots]
      .reverse()
      .map((b) => locate(this.doc, b.id))
      .filter((l): l is Located & { parent: Block } => Boolean(l && l.parent !== null))
    if (this.write) {
      const write = this.write
      // 每棵子树逐块 `block.delete`（级联是落库实现的事，op 序列要说得清删了哪些块）
      write((tx) => {
        for (const loc of targets) tx.remove(loc.block.id)
      })
    } else {
      for (const loc of targets) loc.parent.children.splice(loc.index, 1)
    }
    this.undo.record(before, 'structural', Date.now())
    this.blockSel = null
    this.mouseSel = null
    this.container.classList.remove('blocksel-drag')
    this.paintBlockSel()
    this.renderAll()
    const after = flatten(this.doc)
    const caret = after[Math.min(Math.max(0, firstIdx), after.length - 1)]
    if (caret) this.placeCaret(caret.id, 0)
    this.emitChange('struct')
    return true
  }

  /** 选中的块 → 大纲文本（缩进 2 空格；子树随块走） */
  selectedBlocksText(): string {
    const roots = this.blockSelRoots()
    if (roots.length === 0) return ''
    const lines: string[] = []
    walkForest(roots, (b, ctx) => {
      lines.push(`${'  '.repeat(ctx.path.length - 1)}${plainText(b.content)}`)
    })
    return lines.join('\n')
  }

  /** 选中的块 → 块引用（每行一个最上层根） */
  selectedBlockRefs(): string {
    return this.blockSelRoots()
      .map((b) => `((${b.id}))`)
      .join('\n')
  }

  /** 把 `data-blocksel` 刷到当前挂载的 `.blk` 上（虚拟化下只染已挂载行） */
  private paintBlockSel(): void {
    const sel = new Set(this.blockSel?.ids ?? [])
    for (const el of this.container.querySelectorAll<HTMLElement>('.blk')) {
      const id = el.dataset.blockId
      if (id && sel.has(id)) el.dataset.blocksel = '1'
      else delete el.dataset.blocksel
    }
  }

  private restoreSel(): void {
    if (!this.sel) return
    const r = this.sel
    const all = flatten(this.doc)
    if (!all.some((b) => b.id === r.aBlock)) return
    this.placeCaret(r.aBlock, r.aOff)
  }

  /**
   * 把**整段选区**（不只是光标）还原回 DOM。
   *
   * 为什么需要它：改格式要重渲染那一行，重渲染会丢掉原生 Range；
   * 原来只 `placeCaret` 还原**一个点** ⇒ 加粗后选区塌成光标，
   * 「再点一次取消加粗」就做不到了，划选气泡也会立刻消失（它靠选区存在才在）。
   * ⚠️ 只支持同一块内（跨块的 Range 要跨 `.tx` 节点，第 1 期不做）。
   */
  /**
   * **设置模型选区**（并尽量同步到 DOM）。
   *
   * 为什么要有公开入口：`⌘A` 是从 DOM 反推模型的，而**跨块删除**要从模型发起
   * （用户在块选区上按删除键时，DOM 选区已经被浏览器动过了）。
   * 给一个显式的设置点，测试与命令面都不用去手搓 Range。
   *
   * ⚠️ 跨块时 DOM 只画到**末块的光标**（原生跨块 Range 会跨 `.tx` 节点，
   *    与「块内 Range」的假设冲突）；模型里的 `sel` 才是权威。
   */
  setSel(s: Sel | null): void {
    this.clearBlockSelection()
    if (!s) {
      this.sel = null
      return
    }
    if (s.aBlock === s.hBlock) {
      // 同上：`placeRange` 也会改写 `this.sel` ⇒ 先摆 DOM，再写回模型
      this.placeRange({ ...s, aBlock: s.hBlock, aOff: s.hOff })
      this.sel = s
      return
    }
    // 跨块：先把 DOM 光标放到末块（`placeCaret` 会改写 `this.sel`），再写回模型选区
    this.placeCaret(s.hBlock, s.hOff)
    this.sel = s
  }

  private placeRange(s: Sel): void {
    if (s.aBlock !== s.hBlock) {
      this.placeCaret(s.hBlock, s.hOff)
      return
    }
    const tx = this.txEl(s.aBlock)
    if (!tx) return
    const at = (offset: number): { node: Node; off: number } => {
      let acc = 0
      const target = { node: tx as Node, off: 0 }
      const walk = (n: Node): void => {
        if (target.node !== tx || isTagChip(n)) return
        if (n.nodeType === Node.TEXT_NODE) {
          const len = (n.textContent ?? '').length
          if (acc + len >= offset) {
            target.node = n
            target.off = Math.max(0, offset - acc)
            return
          }
          acc += len
          return
        }
        for (const c of Array.from(n.childNodes)) walk(c)
      }
      walk(tx)
      if (target.node === tx) target.off = textEndOff(tx)
      return target
    }
    const a = at(s.aOff)
    const h = at(s.hOff)
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(h.node, h.off)
    const sel = document.getSelection()
    if (!sel) return
    sel.removeAllRanges()
    sel.addRange(r)
    this.sel = s
  }

  /* --------------------------------------------------------- 事务入口 */

  /**
   * 事务：**一次快照 ＋ 一次渲染**（16 「事务＝观察者的共同原子单位」的最小形态）。
   * 所有命令都经此改模型，没有第二条写入路径。
   */
  tx(kind: UndoKind, fn: () => void, rerender: 'all' | 'block' | 'none' = 'all'): void {
    const before = this.snap()
    const caret = this.sel
    fn()
    this.undo.record(before, kind, Date.now())
    if (rerender === 'all') this.renderAll()
    else if (rerender === 'block' && caret) this.renderBlock(caret.aBlock)
    if (caret) this.placeCaret(caret.aBlock, caret.aOff)
    this.emitChange(kind === 'structural' ? 'struct' : 'text')
  }

  undoStep(): void {
    this.editBase = null
    const s = this.store.undo(this, this.sel)
    if (!s) return
    this.sel = JSON.parse(s.sel) as Sel | null
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  redoStep(): void {
    this.editBase = null
    const s = this.store.redo(this, this.sel)
    if (!s) return
    this.sel = JSON.parse(s.sel) as Sel | null
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  /**
   * 块内替换（程序化编辑入口）：按 plain 偏移切内容，一次 content 写入。
   * 格式与原子随切片自然分家（相邻同段合并、区间盖住的原子整枚消失——都是序列语义）。
   */
  editBlock(id: string, from: number, to: number, insert: string, kind: 'insert' | 'delete' = 'insert'): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const next = spliceRuns(loc.block.content, from, to, insert)
    if (this.write) {
      this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
    } else {
      writeBlockContent(loc.block, next)
    }
    this.undo.record(before, kind, Date.now())
    this.renderBlock(id)
    this.emitChange('text')
  }

  /**
   * **收掉一个跨块选区**：把首块前半 ＋ 末块后半拼成一块。
   *
   * 为什么要单独一步：`syncFromDom` 只同步「光标所在的那一块」。
   * 跨块选区上按删除/打字时，浏览器会把整段内容一起删掉，
   * 但模型里那些块**一个都没少** ⇒ 重渲染后它们又全回来了（看着像删除没生效）。
   *
   * @returns 收拢之后光标应落到的块 id；`null` ＝ 这不是一个该在模型里收的选区
   */
  collapseSelection(): string | null {
    const s = this.sel
    if (!s) return null
    const r = normSel(this.doc, s)
    if (r.startBlock === r.endBlock) return null
    const before = this.snap()
    const caretId = deleteBlockSpan(this.doc, r.startBlock, r.startOff, r.endBlock, r.endOff)
    if (!caretId) return null
    this.undo.record(before, 'delete', Date.now())
    const loc = locate(this.doc, caretId)
    this.sel = loc ? { aBlock: caretId, aOff: r.startOff, hBlock: caretId, hOff: r.startOff } : null
    this.renderAll()
    this.placeCaret(caretId, Math.min(r.startOff, loc ? plainLen(loc.block.content) : 0))
    this.emitChange('struct')
    return caretId
  }

  /* --------------------------------------------------------- 编辑边界 */

  /**
   * **编辑边界**：这次编辑结束（失焦 / Enter 拆块 / 聚焦换块），把快照挪到当前正文。
   *
   * ⚠️ **只认正文，不碰地址**：正文是描述。名字住在 `_aliases`，改名只有
   *    `renameAlias`／`setPrimaryAlias` 一条路；在这里「按正文改地址」会让
   *    写回正文的每一次边界都顺手重命名一次（旧实现就是这样，撞名时还会
   *    把地址钉回旧值，表现为「显示名先走、引用名滞后」）。
   *
   * 幂等：同一块可以在一串边界上各调一次（失焦之后紧接着 Enter、再点块标），
   * 重复提交必须无害。
   *
   * **这里也是「修改时间」唯一该更新的位置之一**：敲字过程中不动它，否则每敲一字都要
   * 多一条 op，而那个时间也只说明「最后一次按键」。边界才是一次「改动」的粒度。
   * 整块内容比较（不是「这一笔改了没有」）保证这件事**幂等**：没有边界外改动时，
   * 内容与时间都不动，一笔事务都不产生。
   */
  commitEdit(id: string): { ok: true } | { ok: false; conflict: Block } {
    const base = this.editBase
    if (!base || base.id !== id) return { ok: true }
    /**
     * ⚠️ **以 `doc` 里的那一块为准，`store.find` 只作旁证**。
     *
     * 装载进来的 roots 未必在 store 的索引里（索引按库建，而视图拿到的可能是
     * 只属于这个视图的那一份）——早先这里只认 `store.find`，于是那些块上的边界
     * **一次都没执行过**：`#tag` 的「编辑边界才算敲完」与「修改时间」都静默失效，
     * 而且不报错（看起来像「边界逻辑没写」）。
     */
    const b = locate(this.doc, id)?.block ?? this.store.find(id)
    if (!b) {
      this.editBase = null
      return { ok: true }
    }
    // 组合期不提交：IME 的预编辑还不是这次编辑的结束
    if (this.probe.isComposing) return { ok: true }
    this.rebase(b)
    this.stampEdited(b)
    return { ok: true }
  }

  /**
   * 记下「这一块刚被显式改过」：内容没变就什么都不做。
   *
   * 判据是**整块内容**：`syncFromDom` 已经逐笔把字写进模型，边界的职责只剩「宣布到这里
   * 算一次改动」；拿「这次有没有写」当判据会把「只移动了光标」也算成改动。
   */
  private stampEdited(b: Block): void {
    // 判据是「这次编辑期里**真的写进过模型**」：`syncFromDom` 把新内容落进模型、
    // 又确实变了时才在这里记下这一块。
    if (!this.edited.has(b.id)) return
    this.edited.delete(b.id)
    const at = Date.now()
    if (this.write) this.write((tx) => tx.patch(b.id, (x) => (x.modified = at)))
    else b.modified = at
  }

  /** 换一个编辑期：先把上一块交出去（换块就是上一次编辑的结束），再记下这一块此刻的样子 */
  private beginEdit(b: Block): void {
    const prev = this.editBase
    if (prev && prev.id !== b.id) this.commitEdit(prev.id)
    this.rebase(b)
  }

  private rebase(b: Block): void {
    this.editBase = { id: b.id }
  }

  /**
   * **给一个块挂标签**（块级露面：正文之后出 chip）。
   *
   * 只写归属、不碰正文 —— 正文里那枚 `#名` 是**另一个动作**（`↵` 的提及），
   * 它不写 `_tags`；所以这里也不替用户删字、不替他造 run。
   * @returns 真的加上了才 `true`（已经有、名字为空 ⇒ `false`）
   */
  addTag(blockId: string, name: string): boolean {
    const b = this.store.find(blockId)
    if (!b) return false
    // 快照取在**建标签**之前：撤销这次挂标签时，顺手建出的标签块也该一起回滚
    const before = this.snap()
    if (this.write) {
      // 建标签块（可能）＋写归属是同一笔：拆开就会留下「只有标签、没有归属」的半批。
      // 名字为空／已挂 ⇒ 事务里什么都不写（零 op）
      const ok = this.write((tx) => {
        const tag = ensureTagInTx(tagLookupOf(this.store.blocks), name, tx)
        if (!tag || hasTag(b, tag.id)) return false
        tx.setTags(blockId, [...tagIdsOf(b), tag.id])
        return true
      })
      if (!ok) return false
    } else {
      const tagId = ensureTag(this.store.blocks, name).block?.id
      if (!tagId || hasTag(b, tagId)) return false
      // 刚建的块不在索引里，紧接着的重画要靠它
      this.store.invalidateIndex()
      addTagId(b, tagId)
    }
    this.undo.record(before, 'other', Date.now())
    if (locate(this.doc, blockId)) this.renderBlock(blockId)
    this.emitChange('text', [blockId])
    return true
  }

  /**
   * **摘掉一个标签的归属**（连带收掉它在正文里的露面）。
   *
   * ⚠️ 为什么连露面一起收：不知道「归属没了、正文里还留着一枚 `#名`」该怎么显示 ——
   *    画成标签是撒谎（查询已经找不到它），画成文字又要多一条渲染分支。
   *    收掉最干净；同一笔撤销能把它恢复回来。
   */
  removeTag(blockId: string, tagId: string): boolean {
    const loc = locate(this.doc, blockId)
    const b = loc?.block ?? this.store.find(blockId)
    if (!b) return false
    // 正文里的露面 ＝ 带 `#` 风味、指向这个标签的引用 run（整枚收，顺序无关）
    const hits = refRunsOf(b.content).filter((r) => r.flavor === '#' && r.to === tagId)
    if (hits.length === 0 && !hasTag(b, tagId)) return false
    const before = this.snap()
    /**
     * ⚠️ 露面住在**块自己的内容**里 —— 与「这一块此刻画没画在屏上」无关。
     *    所以不按 `locate` 决定收不收：目标块不在本视图里时也要收，
     *    否则换个视图打开它，会看到一枚「属于标签、但归属里已经没有它」的僵尸露面。
     */
    const strip = (content: readonly InlineRun[]): InlineRun[] => hits.reduce((acc: InlineRun[], h) => removeRunById(acc, h.id), [...content])
    if (this.write) {
      // 收露面与摘归属是同一件事 ⇒ 同一笔；内容没变的块 patch 不发 op
      this.write((tx) => {
        tx.patch(blockId, (bb) => writeBlockContent(bb, strip(bb.content)))
        tx.setTags(blockId, tagIdsOf(b).filter((t) => t !== tagId))
      })
    } else {
      writeBlockContent(b, strip(b.content))
      removeTagId(b, tagId)
    }
    this.undo.record(before, 'delete', Date.now())
    if (loc) this.renderAll()
    this.emitChange('text', [blockId])
    return true
  }

  /**
   * 从 DOM 输入事件同步模型（真实键入路径）。
   *
   * **DOM 重建 runs**：读回的是整段内容（文本段带格式、原子按 `data-atom-id`
   * 原样带回），模型侧整组替换。没有偏移映射——原子的存亡由「元素还在不在」决定，
   * 用户删掉那一格就是一次显式删除。
   *
   * ⚠️ **这里不认任何语法**：`#名字` 不再在敲到分隔符时静默变成标签。
   *    触发浮层与落点都在别的层（`emitTrigger` 报「在敲什么」，装配层按触发表弹浮层，
   *    选中之后才由 `acceptTrigger` 一次落账）。输入路径只做「把字同步进模型」这件事，
   *    否则同一串字会出现两套行为，而用户不知道刚才发生了哪一套。
   */
  syncFromDom(id: string, reRender: boolean): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    // 这一块的第一笔输入 ＝ 一次编辑期的开始（此刻模型里还是改名前那个值）
    if (this.editBase?.id !== id) this.beginEdit(loc.block)
    const next = this.readRunsOf(id)
    if (sameRuns(next, loc.block.content)) return
    // 这一块真的落过字 ⇒ 到边界时记一次「块被改过」（时刻只在边界写，见 `stampEdited`）
    this.edited.add(id)
    const before = this.snap()
    const prevLen = plainLen(loc.block.content)
    if (this.write) {
      this.write((tx) => {
        tx.patch(id, (b) => writeBlockContent(b, next))
      })
    } else {
      writeBlockContent(loc.block, next)
    }
    const caret = this.sel ? this.sel.aOff : null
    const kind = plainLen(next) < prevLen ? 'delete' : 'insert'
    this.undo.record(before, kind, Date.now())
    if (reRender) {
      this.renderBlock(id)
      if (caret !== null) this.placeCaret(id, Math.min(caret, plainLen(loc.block.content)))
      // **改名传播**：这一块可能是别处引用的目标 ⇒ 引用它的那些块也要重画（显示名现算）。
      // 改动只影响「指向它的 run 所在的块」，不是全视图重渲染。
      this.renderRefSources(id)
    }
    // 文本改了哪一块是已知的：带上 id，查询视图据此判断「结果里的内容变没变」
    this.emitChange('text', [id])
  }

  /**
   * **重画「引用了 `id` 这一块」的那些块**。
   *
   * 装配层在「改名 / 换显示模式 / 改露面」这类**属性写入**后也调它：
   * 那些写入不走 `syncFromDom`，没有别的「名字变了」信号能触发传播。
   *
   * 为什么需要显式做：引用显示的是**目标当前的名字**（`core/ref.ts`），是派生的；
   * 目标改名后，`atom`/`block` 本身一个字节都没变 ⇒ 没有任何「数据变了」的信号能触发重渲染。
   *
   * 两条来源，因为两种归属的存法不同：
   *   · 引用 —— 在原子表里（`edgeSourceIds`）；
   *   · 标签 —— 在**块自己的 `_tags`** 里：改名后 chip 上显示的 `#旧名` 同样是过期的字，
   *     所以带这个标签的块也要重画（这是一次本视图内的扫描，不是全库索引）。
   *
   * ⚠️ 只重画**本视图内**的块：别的页里也有指向它的引用，但那些 DOM 不在 `doc` 里，
   *    由它们自己所在的视图在装载/刷新时解析（共享 store 只保证数据一致，不替别人画 DOM）。
   */
  renderRefSources(id: string): void {
    for (const b of flatten(this.doc)) {
      if (b.id === id) continue
      // 引用它的 run（含行内标签露面）⇒ 显示名现算；带着这个标签 ⇒ chip 上的字过期
      if (refRunsOf(b.content).some((r) => r.to === id) || tagIdsOf(b).includes(id)) {
        if (this.blockEl(b.id)) this.renderBlock(b.id)
      }
    }
  }

  /* --------------------------------------------------------- 结构操作 */

  /**
   * Enter 的入口（2026-10-20 第五次修订； 推广到 N 个 section）。
   *
   * 分支判定集中在 `core/tree.ts` 的 `enterKind()`（纯函数、有单测），这里只执行：
   *   · `outdent` —— 空块且缩进 ≥ 2 层：**反缩进**（Enter 不建块）；
   *   · `split`   —— 块中：**同级拆**（左半插成**上方新块**，原块保 id/右半/子树）；
   *   · `child`   —— 块尾 ＋ 有子块且展开：插**首个子块**；
   *   · `sibling` —— 块尾 ＋ 无子块 / 折叠：建**同级**空块。
   *
   * ⚠️ **任意 section 根**（页／天／查询记录）没有兄弟位（写回按 root id 走）⇒ 不走上面四支：
   *    · **无角色的内容根**（focus/zoom 的普通块）＋ 文本**中间**
   *      ⇒ 左半留根、右半成**首个子块**，光标到子块；
   *    · **有角色的根**（页/日记）或块首 / 空块 / 块尾 ⇒ 插一个**空的首个子块**
   *      （根文本是名字/投影，不拆，避免静默改名）。
   */
  split(id: string, offset: number): void {
    /**
     * **编辑边界**：Enter 就是离开这一行 ⇒ 先把这次正文改动当改名交出去。
     * 拒绝时正文已回滚，拆点要收回到新正文长度之内（否则会按旧长度切开一行短文本）。
     */
    this.commitEdit(id)
    const before = this.snap()
    const loc = locate(this.doc, id)
    if (!loc) return
    /**
     * **同块选区 + Enter = 先删选区，再在选区起点拆**（只做无角色的普通内容块；
     * 跨块选区与页名等身份块仍走原行为）。删除与拆分在**同一笔**里落。
     */
    const sel = this.sel
    const cut =
      loc.parent !== null && !hasIdentity(loc.block) && sel && sel.aBlock === id && sel.hBlock === id && sel.aOff !== sel.hOff
        ? { from: Math.min(sel.aOff, sel.hOff), to: Math.max(sel.aOff, sel.hOff) }
        : null

    if (this.write) {
      const write = this.write
      const out = write((tx) => this.splitTx(tx, id, offset, cut))
      if (!out) return
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      if (out.caret) this.placeCaret(out.caret.id, out.caret.off)
      this.emitChange('struct')
      return
    }

    this.splitDirect(id, offset, cut, before)
  }

  /**
   * **一次回车 ＝ 一笔事务**：同块选区删除、结构拆分共用这一笔。
   *
   * 为什么必须同笔：拆开落盘会得到「内容直写、结构进 op」两份来源 —— 半批比慢更贵。
   *
   * 拆分＝内容按 plain 偏移切两半：格式随切片走、原子的归属按切点自然分家，
   * 没有「锚点搬家」这一步——它们本来就在内容里。
   *
   * ⚠️ 事务里不再 `splice`：落点全部交给 `tx.insert`／`tx.move`（按整片森林取兄弟列表）。
   */
  private splitTx(
    tx: Tx,
    id: string,
    offset: number,
    cut: { from: number; to: number } | null,
  ): { caret: { id: string; off: number } | null } | null {
    const blk = this.store.find(id)
    if (!blk) return null
    // 同块选区先删：只在**内存**里切掉，切点收回到选区起点——
    // 删与拆最终只落**一次**内容写入（两次 patch 会把同一件事记成两段碎账）
    let content = blk.content
    if (cut) {
      const from = Math.max(0, Math.min(cut.from, plainLen(content)))
      const to = Math.max(from, Math.min(cut.to, plainLen(content)))
      content = spliceRuns(content, from, to, '')
      offset = from
    }
    offset = Math.min(offset, plainLen(content))

    const loc = locate(this.doc, id)
    if (!loc) return null

    // 段根没有兄弟位（写回按 root id 走）⇒ 右半成首个子块；有身份的根只插空子块
    if (loc.parent === null) {
      if (!hasIdentity(loc.block) && offset > 0 && offset < plainLen(content)) {
        const [left, right] = splitRuns(content, offset)
        tx.patch(id, (b) => writeBlockContent(b, left))
        const rightBlock = mkBlock(right)
        tx.insert(rightBlock, id, 0)
        unfoldBlock(this.doc, id)
        return { caret: { id: rightBlock.id, off: 0 } }
      }
      const child = mkBlock('')
      unfoldBlock(this.doc, id)
      tx.insert(child, id, 0)
      return { caret: { id: child.id, off: 0 } }
    }

    // 段根已在上面 return ⇒ 这里一定在某个父块下面
    const parent = loc.parent
    const kind = cut ? 'split' : enterKind(this.doc, id, offset)

    if (kind === 'outdent') {
      // 空块 Enter ⇒ 反缩进：不建新块（与这笔里的转换同一笔）
      const plan = outdentMove(this.doc, id)
      if (!plan) return { caret: null }
      tx.move(id, plan.parentId, plan.index)
      return { caret: { id, off: 0 } }
    }

    if (kind === 'child') {
      const b = mkBlock('')
      unfoldBlock(this.doc, id)
      tx.insert(b, id, 0)
      return { caret: { id: b.id, off: 0 } }
    }

    if (kind === 'sibling') {
      const b = mkBlock('')
      tx.insert(b, parent.id, loc.index + 1)
      return { caret: { id: b.id, off: 0 } }
    }

    // 块中 ⇒ 同级拆：左半进**上方新块**；原块保 id、右半、子树
    const [left, right] = splitRuns(content, offset)
    const leftBlock = mkBlock(left)
    tx.insert(leftBlock, parent.id, loc.index)
    tx.patch(id, (b) => writeBlockContent(b, right))
    return { caret: { id: !cut && offset === 0 ? leftBlock.id : id, off: 0 } }
  }

  /** 没有事务入口时的直写落地（迁移期兜底；判定与 `splitTx` 同源，只是逐条改活块） */
  private splitDirect(id: string, offset: number, cut: { from: number; to: number } | null, before: Snap): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    offset = Math.min(offset, plainLen(loc.block.content))

    let forcedSplit = false
    if (cut) {
      const from = Math.max(0, Math.min(cut.from, plainLen(loc.block.content)))
      const to = Math.max(from, Math.min(cut.to, plainLen(loc.block.content)))
      writeBlockContent(loc.block, spliceRuns(loc.block.content, from, to, ''))
      offset = from
      forcedSplit = true
    }

    if (loc.parent === null) {
      /**
       * **段根没有兄弟位**（写回按 root id 走）⇒ 退化成「右半成首个子块」：
       *   · **无角色的内容根**（focus/zoom 进来的普通块）＋ 文本**中间**
       *     ⇒ 左半留在根里、右半成**首个子块**，光标到子块；
       *   · **有身份的根**（页/日记）或块首 / 空块 / 块尾
       *     ⇒ 插一个**空的首个子块**（根内容是名字/投影，不拆，避免静默改名）。
       * 内容的左右分家由 `splitBlockIntoFirstChild` 按 runs 切，锚点本来就在内容里。
       */
      const canSplitRoot = !hasIdentity(loc.block)
      if (canSplitRoot && offset > 0 && offset < plainLen(loc.block.content)) {
        const r = splitBlockIntoFirstChild(this.doc, id, offset)
        if (r) {
          this.undo.record(before, 'structural', Date.now())
          this.renderAll()
          this.placeCaret(r.inserted, 0)
          this.emitChange('struct')
          return
        }
      }
      const child = insertFirstChild(this.doc, id)
      if (!child) return
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(child.id, 0)
      this.emitChange('struct')
      return
    }

    const kind = forcedSplit ? 'split' : enterKind(this.doc, id, offset)

    if (kind === 'outdent') {
      this.structuralMove(id, outdentMove(this.doc, id), { caretAt: { id, off: 0 } })
      return
    }

    if (kind === 'child') {
      const child = insertFirstChild(this.doc, id)
      if (!child) return
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(child.id, 0)
      this.emitChange('struct')
      return
    }

    if (kind === 'sibling') {
      const b = insertSiblingAfter(this.doc, id)
      if (!b) return
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(b.id, 0)
      this.emitChange('struct')
      return
    }

    // 块中 ⇒ 同级拆：左半进**上方新块**；原块保 id、右半、子树（内容分家在 core 层完成）
    const r = splitBlockBefore(this.doc, id, offset)
    if (!r) return
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    // 块首 Enter（offset=0 且无选区）：新块是上方那个空块（左半为空）⇒ 光标去新块；
    // 否则光标留在原块（右半）0 位。
    // ⚠️ 选区删除后即使起点是 0，也应落**原块**（右半）——选区被“块断开”替换，光标在断开之后。
    this.placeCaret(!forcedSplit && offset === 0 ? r.inserted : r.kept, 0)
    this.emitChange('struct')
  }

  mergeBack(id: string): void {
    const all = flatten(this.doc)
    const i = all.findIndex((b) => b.id === id)
    if (i <= 0) return
    const before = this.snap()
    /**
     * 先问「前一块是不是一条没有正文的占位线」：那种情况下这次退格的含义是
     * **删掉它**，而不是「把字并进去」（它没有字可并）。
     * 两支互斥，所以顺序不影响别的块：合并路径只在两边都有正文时成立。
     */
    const placeholder = prevPlaceholder(this.doc, id)
    if (placeholder) {
      if (this.write) {
        const write = this.write
        write((tx) => tx.remove(placeholder.removed))
      } else {
        removePrevPlaceholder(this.doc, id)
      }
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(id, 0)
      this.emitChange('struct')
      return
    }
    const plan = mergeIntoPrevPlan(this.doc, id)
    if (!plan) return
    /**
     * 内容拼接在 core 层完成（`joinRuns`：边界两侧同形段合并、原子原样排队）。
     * 被并块的字现在排在前一块内容的**末尾** ⇒ 光标落在粘接点 `plan.at`。
     */
    if (this.write) {
      const write = this.write
      write((tx) => {
        tx.patch(plan.kept, (b) => writeBlockContent(b, plan.content))
        // 子块跟着并进前一块：每块一条 move（各自报自己的 parent/index）
        plan.children.forEach((kid, n) => tx.move(kid, plan.kept, plan.kidsAt + n))
        // 被并块的内容已搬进前一块 ⇒ 空壳**清空**：删除是原位标记，壳还留在树上，
        // 留着内容就是库里有两份同一句话（恢复出来就是重复块）
        tx.patch(plan.removed, (b) => writeBlockContent(b, []))
        tx.remove(plan.removed)
      })
    } else {
      if (!mergeIntoPrev(this.doc, id)) return
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(plan.kept, plan.at)
    this.emitChange('struct')
  }

  /** Backspace：块首合并到上一块；否则交给原生删除 */
  backspaceAtCaret(): boolean {
    const s = this.sel
    if (!s) return false
    const r = normSel(this.doc, s)
    if (r.startBlock !== r.endBlock) return false
    if (s.aOff !== 0 || s.hOff !== 0) return false
    const all = flatten(this.doc)
    const i = all.findIndex((x) => x.id === s.aBlock)
    /**
     * **块首但没有上一块可并（首块）⇒ 这次退格没有语义，必须吃掉它。**
     *
     * 放给浏览器会出真事故：原生删除看不见「块」这个单位，它只看见一串内联元素，
     * 于是会把 gutter（`.left`）和正文（`.tx`）当成两个可删的节点整段摘掉——
     * 那一行从此**没有可落光标的地方**，用户看到的是「把这块删空之后再也打不进字」
     * （光标还在编辑器里、选区也还在，就是字进不去）。
     * ⇒ 判据是「这一下有没有事可做」：有事就自己做，没事就吞掉，绝不交给浏览器。
     */
    if (i <= 0) return true
    this.mergeBack(s.aBlock)
    return true
  }

  indent(id: string): void {
    const plan = indentMove(this.doc, id)
    this.structuralMove(id, plan, { unfoldId: plan?.parentId ?? null })
  }

  outdent(id: string): void {
    this.structuralMove(id, outdentMove(this.doc, id))
  }

  move(id: string, delta: -1 | 1): void {
    this.structuralMove(id, siblingMove(this.doc, id, delta))
  }

  /**
   * 结构移动的**统一落点管道**（缩进 / 反缩进 / 上下换位 / 拖拽）。
   *
   * 落点由 `core/tree.ts` 的 `*Move` 算（一个真相），这里只决定**谁来写**：
   * 注入事务入口时走 `tx.move` —— 一次移动就是一条 `block.upsert{parent,index}`；
   * 没有事务入口时才直改活块（迁移期兜底）。
   *
   * ⚠️ 折叠态不跟着进事务：那是「这一行此刻收着」，不是内容（与 `unfoldBlock` 同源）。
   *    缩进进去 / 拖进去之后必须展开，否则块被折在一个看不见的层里。
   * ⚠️ 事务里**只**开移动那一笔：`applyMove` 与 `tx.move` 是同一件事实的两种落地，
   *    都写一次就等于同一件事记两遍。
   */
  private structuralMove(
    id: string,
    plan: MovePlan | null,
    o: { unfoldId?: string | null; caretAt?: { id: string; off: number } } = {},
  ): void {
    if (!plan) return
    const before = this.snap()
    if (this.write) {
      const write = this.write
      write((tx) => {
        tx.move(id, plan.parentId, plan.index)
        // 结构换位置也是一次改动：时刻若只跟着正文走，块会被搬到别处、时间停在原处
        tx.patch(id, (x) => (x.modified = Date.now()))
      })
    } else if (!applyMove(this.doc, id, plan)) {
      return
    }
    if (o.unfoldId) unfoldBlock(this.doc, o.unfoldId)
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    if (o.caretAt) this.placeCaret(o.caretAt.id, o.caretAt.off)
    else if (this.sel) this.placeCaret(this.sel.aBlock, this.sel.aOff)
    this.emitChange('struct')
  }

  duplicate(id: string): string | null {
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    // 克隆自带内容（原子已换新 id——复制的是内容不是身份），没有第二份锚点要搬
    const { block } = cloneSubtree(loc.block)
    const list = loc.parent ? loc.parent.children : this.doc.roots
    if (this.write) {
      const write = this.write
      write((tx) => tx.insert(block, loc.parent?.id ?? null, loc.index + 1))
    } else {
      list.splice(loc.index + 1, 0, block)
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(block.id, 0)
    this.emitChange('struct')
    return block.id
  }

  remove(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    /**
     * **有角色的根块不许从编辑器删**（QB-001）。
     *
     * 为什么按角色而不是按「是不是根」判：正文的根既可能是
     *   · 一个**有角色的容器**（页／日记／反链／查询记录）—— 它是视图的装载单位，
     *     `doc.roots[0]` 就是森林里那块本身；splice 掉它只是让这个视图看不见，
     *     库里那块还在 ⇒ 刷新就回来（用户看到「删了又复活」，比报错更糟）。删它要走命令面
     *     （`core.page/delete` 那一路，带确认与落盘）。
     *   · 也可能是一个**普通内容块**（zoom 进来的某一块）—— 它没有身份语义，
     *     删掉它就是删掉这块内容，应当放行。
     *
     * ⚠️ `allowRootRemove: false` 是另一条更严的线：反链／查询列表的根是**别的页的块**，
     *    在这里删源块不合适（那类删除走命令面），所以那一类实例整体关掉。
     */
    if (loc.parent === null && hasIdentity(loc.block)) return
    if (loc.parent === null && !this.allowRootRemove) return
    const before = this.snap()
    const idx = flatten(this.doc).findIndex((b) => b.id === id)
    const wasRoot = loc.parent === null
    /**
     * **窗口里只剩这一块**时，删掉之后必须补一块可编辑的空块，否则编辑器没有落点。
     *
     * 补的那块要**真的落进森林**（插在原来那块的位置），不能只塞进 `doc.roots`：
     * 窗口 roots 不是森林的根，塞进去会得到一个刷新就消失的块。所以它与删除同一笔事务。
     *
     * ⚠️ UI 的三个删除入口都带 `!blockIsRoot` ⇒ 正常操作删不到装载根，这一支只服务 API/测试。
     */
    const fill = wasRoot && this.doc.roots.length === 1 ? mkBlock('') : null
    const forestLoc = fill ? locate({ roots: this.store.blocks }, id) : null
    if (this.write) {
      const write = this.write
      write((tx) => {
        tx.remove(id)
        if (fill && forestLoc) tx.insert(fill, forestLoc.parent?.id ?? null, forestLoc.index)
      })
      // 森林那边已由事务改完；窗口 roots 是**装载单位**，要跟着换掉（它不在事务里）
      if (wasRoot && fill && forestLoc) {
        this.doc.roots.splice(0, this.doc.roots.length, fill)
        this.viewRootIds = [fill.id]
      } else if (wasRoot) {
        this.doc.roots.splice(this.doc.roots.indexOf(loc.block), 1)
        this.viewRootIds = this.viewRootIds.filter((x) => x !== id)
      }
    } else {
      // 与事务支同一条口径：森林里**原位标记**（遍历从此看不见它），不摘树；
      // 装载根被删 ⇒ 窗口 roots 摘掉这一根（roots 是装载单位，不是森林的根）
      removeBlock(this.doc, id)
      if (wasRoot) {
        this.doc.roots.splice(this.doc.roots.indexOf(loc.block), 1)
        this.viewRootIds = this.viewRootIds.filter((x) => x !== id)
      }
      if (flatten(this.doc).length === 0) {
        const empty = mkBlock('')
        this.doc.roots.push(empty)
        this.viewRootIds = [empty.id]
      }
    }
    const after = flatten(this.doc)
    const caret = after[Math.min(idx, after.length - 1)]!
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(caret.id, 0)
    this.emitChange('struct')
  }

  /**
   * 折 / 展一块（点三角、`mod+.`）。
   *
   * ⚠️ **不进撤销栈**：折叠是「这一行此刻怎么显示」，不是内容改动。
   *    记快照会让 `⌘Z` 把折叠撤回去 —— 用户想撤销的是刚才那几个字，不是「我折了一行」。
   *    代价明写：展开/收起之后按 `⌘Z` 撤的是**上一次内容改动**（与折叠无关）。
   */
  toggleCollapse(id: string): void {
    if (!toggleCollapsed(this.doc, id)) return
    this.renderAll()
    this.emitChange('struct')
  }

  /**
   * **点导轨段 ⇒ 折 / 展该祖先的直接子块**（对 的修订）。
   *
   * 与 `toggleCollapse`（点三角）分开：这条命令**不折那个祖先自己**。
   * 理由见 `core/tree.ts` 的 `toggleChildrenCollapsed`。
   *
   * ⚠️ 必须 `renderAll()`（不是 `renderBlock`）：折子块会改变**可见行集合**
   *    ⇒ 祖先表与整棵 DOM 都要重建（与 `toggleCollapse` 同形）。
   * ⚠️ 无子块 ⇒ 核心函数返回 `null` ⇒ 这里直接返回。
   * ⚠️ **不进撤销栈**：与 `toggleCollapse` 同一条理由 —— 折叠不是内容。
   */
  toggleChildrenCollapse(id: string): void {
    if (toggleChildrenCollapsed(this.doc, id) === null) return
    this.renderAll()
    this.emitChange('struct')
  }

  /**
   * **勾 / 取消勾选**这一行 gutter 上的那个二元开关。
   *
   * 写的是**属性值**，不是块字段：任务状态是一个真实字段（有定义块、能进查询、能导出），
   * 所以这里走 `setValue`。`gutterFieldsOf` 是唯一的「这一行有哪些 gutter 字段」来源，
   * 点方框与菜单命令共用它 ⇒ 两条入口不会对同一行给出不同答案。
   *
   * 「未填」与「`false`」在这里都算**没勾**：一次点击就是打上勾，再点一次取消
   * （`!current`，所以从「没有这一槽」点一下直接变已勾，不需要先填一个中间态）。
   *
   * ⚠️ 这一行**一个 gutter 字段都没有**时（例如从菜单对普通块按「切换待办」）：
   *    落 `false` 而不是 `true`。落下去之后它就成了这一块的**自有字段**，
   *    gutter 上随即出现方框 —— 于是「先成为一个没做完的任务，再点才勾上」，
   *    与原来「第一次切换 ＝ 变成待办」的手感一致。
   */
  toggleTodo(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const fields = gutterFieldsOf(loc.block, this.store.blocks)
    const field =
      fields.find((f) => f.kind === 'checkbox' && f.propId === TASK_STATUS_PROP_ID) ??
      fields.find((f) => f.kind === 'checkbox')
    const propId = field?.propId ?? TASK_STATUS_PROP_ID
    const next = field ? field.value !== true : false
    const before = this.snap()
    if (this.write) {
      // 切的是一个属性值：一笔 patch 正好 1 条 `prop.set`（与「插入待办」同一形状）
      this.write((tx) => {
        tx.patch(id, (b) => setValue(b, propId, next))
      })
    } else {
      setValue(loc.block, propId, next)
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.emitChange('struct', [id])
  }

  /** 整块换成一段纯文本（清除所有格式与原子；命令/测试用） */
  setText(id: string, text: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const next = textRuns(text)
    if (this.write) {
      this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
    } else {
      writeBlockContent(loc.block, next)
    }
    this.undo.record(before, 'insert', Date.now())
    this.renderBlock(id)
    this.emitChange('text')
  }

  /**
   * 在 id 之后插一个块（`/` 命令与测试用）。
   *
   * ⚠️ **任意 section 根**（页／天／查询记录）要插成它的子块，不能插成 `roots[n]`：
   * 视图层没有「根级同级」这个真实位置，插进去的块没有家。
   *    视觉上二者也等价：根行是这一段的第一个可编辑/标题行，它「之后」就是第一个子块。
   */
  /**
   * 在当前块后面插入一个块（`/` 菜单的「正文块」「待办」）。
   *
   * **插入点本身是空块时，改它，而不是在它下面再造一个**：
   * 用户在一行空白里打 `/` 选「待办」，想要的是「这一行变成待办」，
   * 而不是「多出一个待办、原来那个空行还留在上面」。
   *
   * ⚠️ 「空块」的判据是**正文为空且没有子块**：有子块的块不能被改掉类型/值 ——
   *    那会让子树挂在一个用户没打算改的块下面。
   * ⚠️ 待办这一支还要看**已经有值没有**：已经有任务状态的空块（`false` ＝
   *    是任务但没做完）不该被「/待办」翻回未完成 —— 那是改值，不是插入。
   *    这一条与 `toggleTodo` 分工：那个是**切换**，这个是**插入**。
   */
  insertBlockAfter(id: string, text: string, todo?: TodoState): string | null {
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const blank = isEmptyContent(loc.block.content) && loc.block.children.length === 0 && canWriteText(loc.block)
    if (blank && text === '') {
      /**
       * 空块 ＋ 无正文：
       *   · 「正文块」⇒ 这一行**本来就是**一个正文块，意图已经满足：不动模型、
       *     不记撤销，把光标落回它自己（返回它的 id，而不是 `null` ——
       *     `null` 的意思是「这里放不下一个块」，与「已经就是这样」是两件事）。
       *   · 「待办」⇒ 原地变成任务（但已有任务状态值时不覆盖，见上）。
       */
      if (!todo) {
        this.placeCaret(loc.block.id, 0)
        return loc.block.id
      }
      if (todoOf(loc.block) !== undefined) return null
      // 只落一个属性值、不动结构 ⇒ 一笔事务里正好 1 条 `prop.set`
      if (this.write) {
        this.write((tx) => {
          tx.patch(loc.block.id, (b) => setValue(b, TASK_STATUS_PROP_ID, todo === 'done'))
        })
      } else {
        setValue(loc.block, TASK_STATUS_PROP_ID, todo === 'done')
      }
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(loc.block.id, 0)
      this.emitChange('struct', [loc.block.id])
      return loc.block.id
    }
    const b = mkBlock(text)
    // 待办不是块的字段，是**任务状态属性**的一个值：这里落值，不落「块的种类」
    if (todo) b.props = { ...(b.props ?? {}), [TASK_STATUS_PROP_ID]: todo === 'done' }
    /**
     * **落点只由 `tx.insert` 算**（它按整片森林取兄弟列表）。
     * 这里不能再顺手 `splice`/`unshift` 一下：那样同一件事就有两个计算者，
     * 而树的身份只有一份 —— 谁先算、谁后算，读者无从判断。
     *
     * section 根（页／天／查询记录）没有兄弟位，插成它的**首个子块**：
     * 视觉上「根行之后」就是第一个子块，写回也按 root id 走。
     *
     * 事务里**只**开结构那一笔：`b` 自带的待办值不另发属性 op ——
     * `insert` 已经为每个新块报了 `{parent,index}`，属性会随整块落库，
     * 再补一条 `prop.set` 就是同一件事记两遍。
     *
     * 声明「不许有子块」的根在这里容纳不下一个新块：直接返回 `false`，
     * 事务里什么都没写 ⇒ 没有任何 op。
     */
    if (this.write) {
      const ok = this.write((tx) => {
        if (loc.parent === null) {
          if (typeDeclOf(loc.block).children === 'none') return false
          tx.insert(b, loc.block.id, 0)
          return true
        }
        tx.insert(b, loc.parent.id, loc.index + 1)
        return true
      })
      if (!ok) return null
    } else if (!this.insertNear(loc, b)) {
      return null
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(b.id, 0)
    this.emitChange('struct')
    return b.id
  }

  /**
   * 插入一个**分割线**块，并在它下面留一个空块给光标。
   *
   * 为什么不能只插线：分割线没有正文，光标没有地方可落 —— 用户看到的是
   * 「插了一条线，然后光标消失了」。下面那个空块是落点，不是内容。
   *
   * 两个块共用**一**个撤销快照：用户按的是一次「插入分割线」，
   * 撤销一次就该回到按下之前，而不是先撤掉光标再撤掉线。
   */
  /**
   * 插入一个**分割线**块。
   *
   * 分两支，判据是**插入点本身是不是一个空块**：
   *   · 空块 ⇒ 它**变成**分割线（原地改类型，不新建）—— 用户在一行空白里
   *     要一条线，得到的就是那一行变成线，而不是线 + 多出来的空行；
   *   · 有内容 ⇒ 在它下面**新建**分割线，再留一个空块给光标 ——
   *     否则那条线会盖住用户已经写好的字。
   *
   * ⚠️ 改类型那一支**不新建块**，所以撤销一次就回到「那行还是空白」。
   * ⚠️ 新建那一支**两个块共用一个撤销快照**：用户按的是一次「插入分割线」，
   *    撤销一次该回到按下之前，而不是先撤光标再撤线。
   */
  insertDividerAfter(id: string): boolean {
    const loc = locate(this.doc, id)
    if (!loc) return false
    const before = this.snap()

    /**
     * 空块 ⇒ 原地变成分割线。
     * 判据要**两块都空**：正文为空、且没有子块。有子块的块不能变线 ——
     * 那会把子树藏进一条线后面（线没有正文，子块看不见）。
     */
    if (isEmptyContent(loc.block.content) && loc.block.children.length === 0 && canWriteText(loc.block)) {
      if (this.write) {
        // 原地改类型是一次属性写入：`_type` 一条 op，撤销一次回到「那行还是空白」。
        // 改类型也算一次改动 ⇒ 时刻并进同一笔（第二条 op）。
        this.write((tx) => {
          tx.patch(loc.block.id, (b) => {
            setBlockType(b, DIVIDER_TYPE)
            b.modified = Date.now()
          })
        })
      } else {
        setBlockType(loc.block, DIVIDER_TYPE)
        loc.block.modified = Date.now()
      }
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.emitChange('struct', [loc.block.id])
      return true
    }

    const divider = mkBlock('')
    setBlockType(divider, DIVIDER_TYPE)
    const empty = mkBlock('')
    if (this.write) {
      // 两个块共用一笔（用户按的是一次「插入分割线」）；落点与 `insertNear` 同一条规则：
      // section 根没有兄弟位，插成它的首两个子块
      const ok = this.write((tx) => {
        if (loc.parent === null) {
          if (typeDeclOf(loc.block).children === 'none') return false
          tx.insert(divider, loc.block.id, 0)
          tx.insert(empty, loc.block.id, 1)
          return true
        }
        tx.insert(divider, loc.parent.id, loc.index + 1)
        tx.insert(empty, loc.parent.id, loc.index + 2)
        return true
      })
      if (!ok) return false
    } else {
      if (!this.insertNear(loc, divider)) return false
      const at = locate(this.doc, divider.id)
      if (at) this.insertNear(at, empty)
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(empty.id, 0)
    this.emitChange('struct')
    return true
  }

  /**
   * 把 `b` 插到 `loc` 的位置上：section 根**没有兄弟位**（写回按 root id 走），
   * 只能成为它的首个子块；其余块插在它后面的同级位。
   *
   * 返回 `false` ＝ 这个位置容纳不了一个块（根的类型声明不许有子块）。
   */
  private insertNear(loc: Located, b: Block): boolean {
    if (loc.parent === null) {
      if (typeDeclOf(loc.block).children === 'none') return false
      unfoldBlock(this.doc, loc.block.id)
      loc.block.children.unshift(b)
      return true
    }
    loc.parent.children.splice(loc.index + 1, 0, b)
    return true
  }

  /* ------------------------------------------------------- 区间格式 */

  /**
   * ⌘B/⌘I…：格式是 run 属性 ⇒ 改格式＝改内容。每个被选中的块一条 content 写入
   * （格式/原子改动＝一条 upsert{content}，落库与同步看到的都是整组替换）。
   */
  toggleMark(type: MarkType): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    const before = this.snap()
    const apply = (blockId: string, content: readonly InlineRun[]): InlineRun[] => {
      let next: InlineRun[] = [...content]
      for (const r of ranges) {
        if (r.blockId !== blockId || r.start >= r.end) continue
        next = toggleRunMark(next, type, r.start, r.end)
      }
      return next
    }
    const touched = [...new Set(ranges.map((r) => r.blockId))]
    if (this.write) {
      this.write((tx) => {
        for (const bid of touched) {
          const b = this.store.find(bid)
          if (b) tx.patch(bid, (bb) => writeBlockContent(bb, apply(bid, bb.content)))
        }
      })
    } else {
      for (const bid of touched) {
        const b = locate(this.doc, bid)?.block ?? this.store.find(bid)
        if (b) writeBlockContent(b, apply(bid, b.content))
      }
    }
    this.undo.record(before, 'mark', Date.now())
    if (ranges.length === 1) this.renderBlock(ranges[0]!.blockId)
    else this.renderAll()
    // ⚠️ 还原**整段选区**（不是光标）：否则加完粗选区就塌了，
    //    「再点一次取消」做不到，划选气泡也会立刻消失。
    this.placeRange(s)
    this.emitChange('text')
  }

  /** 当前选区上**出现过**的格式（诊断/划选气泡的按压态） */
  marksAtSel(): MarkType[] {
    const s = this.sel
    if (!s) return []
    const ranges = selToTextRanges(this.doc, s)
    const out = new Set<MarkType>()
    for (const r of ranges) {
      const b = locate(this.doc, r.blockId)?.block
      if (!b) continue
      for (const m of marksInRange(b.content, r.start, r.end)) out.add(m)
    }
    return [...out]
  }

  clearMarksAtSel(): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    const before = this.snap()
    const apply = (blockId: string, content: readonly InlineRun[]): InlineRun[] => {
      let next: InlineRun[] = [...content]
      for (const r of ranges) {
        if (r.blockId !== blockId) continue
        next = clearRunsMarks(next, r.start, r.end)
      }
      return next
    }
    const touched = [...new Set(ranges.map((r) => r.blockId))]
    if (this.write) {
      this.write((tx) => {
        for (const bid of touched) {
          const b = this.store.find(bid)
          if (b) tx.patch(bid, (bb) => writeBlockContent(bb, apply(bid, bb.content)))
        }
      })
    } else {
      for (const bid of touched) {
        const b = locate(this.doc, bid)?.block ?? this.store.find(bid)
        if (b) writeBlockContent(b, apply(bid, b.content))
      }
    }
    this.undo.record(before, 'mark', Date.now())
    this.renderAll()
    // 同上：清格式也要保住选区（清完还能接着改别的格式）
    this.placeRange(s)
    this.emitChange('text')
  }

  /* --------------------------------------------------------- 行内原子 */

  /**
   * 在光标处插一枚引用 run（页引用／行内标签共用；标签带 `flavor:'#'`）。
   * 返回 run id。
   */
  insertRef(opts: { to: string; label: string; flavor?: '#' }): string | null {
    const id = this.sel?.aBlock ?? this.rows()[0]?.block.id
    if (!id) return null
    const off = this.sel?.aOff ?? 0
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const run: RefRun = { id: uuidv7Hex(), t: 'ref', to: opts.to, ...(opts.flavor ? { flavor: opts.flavor } : {}), label: opts.label }
    const next = insertRunAt(loc.block.content, off, run)
    if (this.write) {
      this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
    } else {
      writeBlockContent(loc.block, next)
    }
    this.undo.record(before, 'other', Date.now())
    this.renderBlock(id)
    this.placeCaret(id, off + 1)
    this.emitChange('text')
    return run.id
  }

  /** 在光标处插一枚图片 run（asset 只存定位信息，载荷住资产侧） */
  insertImage(asset: ImageRun['asset'], dims?: { w?: number; h?: number }): string | null {
    const id = this.sel?.aBlock ?? this.rows()[0]?.block.id
    if (!id) return null
    const off = this.sel?.aOff ?? 0
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const run: ImageRun = { id: uuidv7Hex(), t: 'image', asset, ...(dims?.w ? { w: dims.w } : {}), ...(dims?.h ? { h: dims.h } : {}) }
    const next = insertRunAt(loc.block.content, off, run)
    if (this.write) {
      this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
    } else {
      writeBlockContent(loc.block, next)
    }
    this.undo.record(before, 'other', Date.now())
    this.renderBlock(id)
    this.placeCaret(id, off + 1)
    this.emitChange('text')
    return run.id
  }

  /** 按 run id 找到它（诊断/popover 用；全库找，popover 的目标块不一定在本视图） */
  findRun(runId: string): { block: Block; run: RunWithId } | null {
    let hit: { block: Block; run: RunWithId } | null = null
    walkForest(this.store.blocks, (b) => {
      if (hit) return false
      const run = runById(b.content, runId)
      if (run) hit = { block: b, run }
      return hit === null
    })
    return hit
  }

  /** 删掉一枚行内原子（显式动作；只动那一格，文本不受影响） */
  removeRun(runId: string): void {
    const hit = this.findRun(runId)
    if (!hit) return
    const before = this.snap()
    const next = removeRunById(hit.block.content, runId)
    if (this.write) {
      this.write((tx) => tx.patch(hit.block.id, (b) => writeBlockContent(b, next)))
    } else {
      writeBlockContent(hit.block, next)
    }
    this.undo.record(before, 'delete', Date.now())
    this.renderAll()
    this.emitChange('text')
  }

  /**
   * 引用某段的引文快照：用当前选区物化一条 anno，`quote.exact` 恒为
   * `plainText` 投影的子串（选区 plain 坐标 → 投影坐标的换算在 core 层）。
   * 没有文本 ⇒ `undefined`（引用纯原子没有可定位的东西，走整块引用）。
   */
  quoteAtSel(): { exact: string; prefix: string; suffix: string } | undefined {
    const s = this.sel
    if (!s) return undefined
    const r = normSel(this.doc, s)
    if (r.startBlock !== r.endBlock) return undefined
    const b = locate(this.doc, r.startBlock)
    if (!b) return undefined
    return mkAnno(b.block.content, r.startOff, r.endOff)?.quote
  }

  /* ------------------------------------------------------- 虚拟化 */

  setVirtualize(on: boolean, radius = this.radius): void {
    this.virtualize = on
    this.radius = radius
    this.renderAll()
    this.events.change?.('load')
  }

  /** 窗口化挂载：只挂「光标所在行 ± radius」（**以可见行计**，折叠的子树本来就不在窗口里） */
  applyWindow(centerId?: string): void {
    const rows = this.rows()
    const cid = centerId ?? this.sel?.aBlock ?? rows[0]?.block.id
    let ci = rows.findIndex((r) => r.block.id === cid)
    if (ci < 0) ci = 0
    const from = Math.max(0, ci - this.radius)
    const to = Math.min(rows.length, ci + this.radius + 1)
    this.container.textContent = ''
    this.mounted.clear()
    // ⚠️ 祖先表对**全量** rows 算（上面已经拿到的就是全量可见行），
    //    不对下面 slice 重建 —— 否则窗口第一行的祖先全丢。
    this.rebuildAncestors()
    // 占位高度按**实际行高**累加：带别名头的行是两行，按 LINE_H 算会让长文档的
    // 滚动条与落点系统性偏小（越靠后偏得越多）。
    if (from > 0) {
      const headH = rows.slice(0, from).reduce((n, r) => n + visibleRowHeight(r.block), 0)
      this.container.appendChild(this.placeholder(from, 'head', headH))
    }
    this.renderRows(rows.slice(from, to))
    if (to < rows.length) {
      const tailH = rows.slice(to).reduce((n, r) => n + visibleRowHeight(r.block), 0)
      this.container.appendChild(this.placeholder(rows.length - to, 'tail', tailH))
    }
    this.caretMarks = ''
    this.markCaret()
    this.paintBlockSel()
    this.events.mounted?.()
  }

  private placeholder(count: number, which: string, height = count * LINE_H): HTMLElement {
    const d = document.createElement('div')
    d.className = 'ph'
    d.dataset.ph = which
    d.dataset.count = String(count)
    d.contentEditable = 'false'
    d.style.height = `${height}px`
    d.textContent = t('ui.virt.placeholder', { count })
    return d
  }

  /* ------------------------------------------------------- 空白处建块 */

  /**
   * **点空白处 ⇒ 在当前 section 下面建一个子块**（推广到 N 段）。
   *
   * ⚠️ **修订历史**：v1 建「最后一行之后的同级块」⇒ 在**空 journal** 上就是建到了
   *    `roots[1]`（死区），一下次保存即丢。之后改成「当前对象的子块」。
   *    现在有 N 段（日记流）：点击点在**整个文档最后一行之下**，视觉上属于**最后一段**
   *    （日记流里是最早的一天）⇒ 建它的最后一个子块。N=1 时与旧行为完全一致。
   *    `row`/`grid` 排列下段是**列**：先按点击的横向位置找列（`.sec` 的盒子），
   *    再对**那一段**做「最后一行之下」判据——点哪列的空白就落到哪天。
   *
   * 落点判据（`clientY`）：只在**目标段最后一行可见块的底边之下**才算空白 —— 否则
   * `#scroll` 里与正文同高的左右留白也会误触。
   *
   * ⚠️ 虚拟化下最后一行可能没挂 DOM ⇒ 取不到 rect 时**放行**（宁可建块，也别「点了没反应」）。
   * ⚠️ 段与段之间的「缝」暂不单独建块（见 `待定-日记流.md`）；首版只认全局底部（column）
   *    与列内底部（row/grid）。
   */
  clickEmptyArea(clientY: number, clientX = 0): boolean {
    if (!this.allowBlankCreate) return false
    this.clearBlockSelection()
    const rows = this.rows()
    /** `row`/`grid`：先找列。列不存在（点在列缝／边距上）⇒ 不建块 */
    let secId = ''
    if (this.layout !== 'column') {
      const sec = [...this.container.querySelectorAll<HTMLElement>('.sec')].find((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && clientX >= r.left && clientX <= r.right
      })
      // 点中的是空天格子：落笔物化那一天（与点格子本体同一条出口）
      if (sec?.dataset.shell) {
        this.events.shellWrite?.(sec.dataset.shell)
        return true
      }
      secId = sec?.dataset.sec ?? ''
      if (secId === '') return false
    }
    const root = secId ? this.doc.roots.find((r) => r.id === secId) : this.doc.roots[this.doc.roots.length - 1]
    if (!root) return false
    // 目标段的最后一行（column ＝ 全文档最后一行；row/grid ＝ 该列最后一行）
    let last: VisibleRow | undefined
    let cur = ''
    for (const r of rows) {
      if (r.depth === 0) cur = r.block.id
      if (secId === '' || cur === secId) last = r
    }
    const lastEl = last ? this.blockEl(last.block.id) : null
    if (lastEl && clientY < lastEl.getBoundingClientRect().bottom) return false

    const before = this.snap()
    unfoldBlock(this.doc, root.id)
    /**
     * **复用末尾空块，不无中生有**：点底部若最后一段末尾已有一个空块（既无文字也无子块），
     * 直接聚焦它，避免「点一次多一个空块」越点越多。只有末尾没有空块时才新建。
     * 判据收紧到「空文本且空子树」——空标题但带子块的块不当作可复用空块。
     * ⚠️ 复用支**模型不动、撤销不记**（与 `insertBlockAfter` 的空块支同一条口径）：
     *    记了就会吃掉一次 ⌘Z——按一次「什么都不变」的动作，退一步却退到上一次改动之前。
     */
    const lastChild = root.children[root.children.length - 1]
    const emptyTail = lastChild && isEmptyContent(lastChild.content) && lastChild.children.length === 0 ? lastChild : null
    const child = emptyTail ?? mkBlock('')
    if (!emptyTail) {
      if (this.write) this.write((tx) => tx.insert(child, root.id, root.children.length))
      else root.children.push(child)
      this.undo.record(before, 'structural', Date.now())
    }
    this.renderAll()
    this.placeCaret(child.id, 0)
    this.emitChange('struct')
    return true
  }

  /* ------------------------------------------------------------ 绑定 */

  /**
   * 事件接线：**全部委托给 `view/editor-events`**。
   * 这里只把编辑器的能力面递过去——事件逻辑不需要认识 `doc`／`undo`／`marks`。
   */
  private bind(): () => void {
    return bindEditorEvents({
      container: this.container,
      blockOf: (n) => this.blockOf(n),
      syncSel: () => this.syncSel(),
      caretBlock: () => this.caretBlock(),
      reclaimCaret: () => this.reclaimCaret(),
      commitEdit: (id) => {
        this.commitEdit(id)
      },
      collapseSelection: () => this.collapseSelection(),
      syncFromDom: (id, re) => this.syncFromDom(id, re),
      beginMouseSelect: (id, x, y, shift) => this.beginMouseSelect(id, x, y, shift),
      updateMouseSelect: (x, y) => this.updateMouseSelect(x, y),
      endMouseSelect: () => this.endMouseSelect(),
      hasBlockSelection: () => this.hasBlockSelection(),
      onShellActivate: (date) => this.events.shellWrite?.(date),
      emitTrigger: (id) => this.emitTrigger(id),
      dropTrigger: (id) => this.dropTrigger(id),
      insertPlainText: (id, _off, text) => this.pasteAt(id, _off, text),
      hasChildren: (id) => Boolean(locate(this.doc, id)?.block.children.length),

      acceptDrag: (id) => {
        const loc = locate(this.doc, id)
        return loc !== null && loc.parent !== null
      },
      beginDrag: (id) => {
        this.dragId = id
        this.container.classList.add('dragging')
        this.blockEl(id)?.classList.add('drag-src')
      },
      showDropTarget: (el, zone) => {
        this.setDropEl(el)
        if (!el) {
          this.container.classList.add('drop-end')
          return
        }
        this.container.classList.remove('drop-end')
        if (zone) el.dataset.drop = zone
      },
      /**
       * 落点报上来的块 id 是**载荷里那一个**（不是「我认得刚才那次拖拽」）——
       * 这样从侧槽／面板／任何组件拖过来的块都能落进正文。
       */
      dropDrag: (draggedId, targetId, zone) => {
        const id = draggedId
        if (!id) return
        const loc = locate(this.doc, id)
        if (!loc) return
        // 段根（页／天／查询记录）不是内容块：不参与拖拽。
        // 日记流的分段顺序是真实日期序，查询列表是视图序——都不是「可拖的兄弟序」。
        if (loc.parent === null) return
        /**
         * 落点只由 `dropMove` 算（空白处算「最后一个根的最后一位」）。
         * 目标若也是段根，只接受 inside —— before/after 会给它造出一个没有家的兄弟。
         */
        if (targetId) {
          const targetLoc = locate(this.doc, targetId)
          if (!targetLoc || (targetLoc.parent === null && zone !== 'inside')) {
            this.endDrag()
            return
          }
        }
        const plan = dropMove(this.doc, id, targetId, zone)
        this.endDrag()
        this.structuralMove(id, plan, {
          unfoldId: zone === 'inside' ? (plan?.parentId ?? null) : null,
          caretAt: { id, off: this.sel?.aOff ?? 0 },
        })
      },
      endDrag: () => this.endDrag(),

      composing: () => this.probe.isComposing,
      noteComposition: (step) => {
        if (step === 'start') this.probe.isComposing = true
        if (step === 'end') this.probe.isComposing = false
        this.probe.compositionSeq.push(step)
      },
      /**
       * 点了一个「指向某块的露面」。**先交出当前行的编辑期**，理由与 `focusBlock` 完全相同：
       * 点击 `contenteditable=false` 的元素不会派发 `focusout`（浏览器不认为焦点离开），
       * 所以不在这里显式 `commitEdit`，「敲完字直接点标签」这条路上修改时间与撞名校验
       * 就会停在上一处 —— 而那正是编辑边界该发生的地方。
       *
       * ⚠️ `runId` → 真的 run 在这一层换（它持有 store），事件层只认 DOM 上的字符串。
       */
      onRefClick: (ref, el, mods) => {
        const from = this.caretBlock() ?? this.editBase?.id ?? null
        if (from) this.commitEdit(from)
        const run = ref.runId ? this.findRun(ref.runId)?.run : undefined
        this.events.refClick?.({ to: ref.to, ...(run ? { run } : {}) }, mods, el)
      },
      onBlockMenu: (id, rect) => this.events.blockMenu?.(id, rect),
      // 左键点块标 ＝ 聚焦/zoom。这也是**离开这一行**：先把当前行的编辑交出去
      // （判据是「上一个块 ≠ 这个块」；点自己那一行的块标不算离开）
      focusBlock: (id) => {
        const from = this.caretBlock() ?? this.editBase?.id ?? null
        if (from && from !== id) this.commitEdit(from)
        this.events.focusBlock?.(id)
      },
      // Shift+左键点块标 ＝ 在右槽打开；事件层只报「打开谁」，落点由装配层决定
      // ⚠️ 没接就不做事（不再退化成中心 zoom：那会让缺入口看起来像成功）
      openInDock: (id) => this.events.openInDock?.(id),
      toggleCollapse: (id) => this.toggleCollapse(id),
      toggleChildrenCollapse: (id) => this.toggleChildrenCollapse(id),
      toggleTodo: (id) => this.toggleTodo(id),
      blankArea: this.blankArea,
      clickEmptyArea: (y, x) => this.clickEmptyArea(y, x),
      onChange: () => this.emitChange('text'),
      onMounted: () => this.events.mounted?.(),
    })
  }

  private setDropEl(el: HTMLElement | null): void {
    if (this.dropEl && this.dropEl !== el) delete this.dropEl.dataset.drop
    this.dropEl = el
  }

  private endDrag(): void {
    const id = this.dragId
    this.dragId = null
    this.container.classList.remove('dragging', 'drop-end')
    if (this.dropEl) delete this.dropEl.dataset.drop
    this.dropEl = null
    for (const el of Array.from(this.container.querySelectorAll<HTMLElement>('.blk[data-drop]'))) delete el.dataset.drop
    if (id) this.blockEl(id)?.classList.remove('drag-src')
  }

  /**
   * 此刻光标前有没有一个**正在输入的触发词**（`/`／`#`／`@`）。
   *
   * 判定落在**投影**（`plainText`）上：触发字符是正文里的字，与格式无关；
   * 判定本身在 `core/trigger.ts`（纯函数、被单测逐条钉），这里只负责把
   * 「光标 plain 偏移」换算成那段投影文本，并把结果换算回 **plain 偏移**。
   *
   * `from`／`to` 是 plain 偏移：抹字与插原子都在这套坐标里做，
   * 于是「删掉触发词、插入一枚原子」不需要第二套偏移换算。
   */
  triggerAt(id?: string): (Omit<TriggerHit, 'from'> & { from: number; to: number }) | null {
    const bid = id ?? this.sel?.aBlock
    if (!bid) return null
    const loc = locate(this.doc, bid)
    // 只读行（日记日期）与不写正文的块上不该弹：那里连字都敲不进去
    if (!loc || !canWriteText(loc.block)) return null
    const off = this.sel?.aBlock === bid ? (this.sel?.aOff ?? 0) : 0
    const text = plainText(loc.block.content).slice(0, projectOff(loc.block.content, off))
    const hit = detectTrigger(text, { composing: this.probe.isComposing })
    if (!hit) return null
    return { ch: hit.ch, query: hit.query, from: fromProjection(loc.block.content, hit.from), to: off }
  }

  /** 上报「在敲什么」（`null` ＝ 这一段已经结束，浮层该关） */
  private emitTrigger(id: string): void {
    if (!this.events.triggerQuery) return
    const hit = this.triggerAt(id)
    if (!hit) {
      this.events.triggerQuery(null, new DOMRect())
      return
    }
    this.events.triggerQuery({ ch: hit.ch, query: hit.query }, this.caretRect() ?? new DOMRect())
  }

  /**
   * 把触发词从模型里抹掉（选中命令后调用）。
   *
   * 只在**命令行**上有这一步：命令要落在「触发词原来那一格」，所以得先把它让出来。
   * `#`／`@` 的落点不走这里——它们与插入本身是**同一笔事务**（见 `acceptTrigger`）。
   */
  dropTrigger(id: string): boolean {
    const hit = this.triggerAt(id)
    if (!hit) return false
    this.editBlock(id, hit.from, hit.to, '', 'delete')
    this.placeCaret(id, hit.from)
    return true
  }

  /**
   * **选中浮层一行之后的落点**：删掉触发词，并把结果落到它原来的位置。
   *
   * 三件事在同一笔事务里（一次撤销就是一次动作）：
   *   ① 抹掉 `#查询词`／`@查询词`；② 需要时建出标签块／记录；③ 插入露面 run 或写归属。
   * 拆开落盘会留下「字删了、标签没建」这种半批，而半批比慢更贵。
   *
   * `ch` 是**打开浮层时那个触发字符**：落点前再检测一次（文本此刻才是事实），
   * 若最近敲下的已经不是它（用户改了主意／挪了光标），就什么都不做而不是猜一个落点。
   *
   * 为什么只有 `tag`／`newObj` 才建标签块：`ref` 指向的目标已经存在（浮层刚列出它），
   * 再 `ensureTag` 一遍等于用名字重新解析一次，反而会把别名/同名页的口径再走一道。
   */
  acceptTrigger(opts: { ch: TriggerChar; pick: AcceptPick }): boolean {
    const hit = this.triggerAt()
    if (!hit || hit.ch !== opts.ch) return false
    const id = this.sel?.aBlock
    const loc = id ? locate(this.doc, id) : null
    if (!id || !loc) return false
    const pick = opts.pick
    const before = this.snap()
    /** 这次是否往树上插了新块（记录）——真插了就整片重画（记录落在当天，可能就在当前视图里） */
    let createdBlock = false

    const apply = (tx: Tx | null, block: Block): boolean => {
      let tagId: string | null = null
      let recordId: string | null = null
      let pageId: string | null = null

      const needTag = pick.kind === 'tag' || pick.kind === 'newObj' || pick.kind === 'newTag'
      if (needTag) {
        const tag = tx
          ? ensureTagInTx(tagLookupOf(this.store.blocks), pick.name, tx)
          : ensureTag(this.store.blocks, pick.name).block
        if (!tag) return false
        tagId = tag.id
      }

      if (pick.kind === 'newPage') {
        const page = tx
          ? ensurePageInTx(tagLookupOf(this.store.blocks), pick.name, tx)
          : ensurePageDirect(this.store.blocks, pick.name)
        if (!page) return false
        pageId = page.id
        // 页落在森林顶层，可能不在当前视图里；整片重画一次，让索引/页数跟上
        createdBlock = true
      }

      /**
       * 记录是**内容块**，落在当天。它没有地址：正文就是键入的名字（作描述），
       * 身份由「哪条引用指向它」给出。
       */
      if (pick.kind === 'newObj' || (pick.kind === 'newTag' && pick.action === 'instance')) {
        const record = tx
          ? createObjRecordInTx(tx, (bid) => findInForest(this.store.blocks, bid), pick.name, tagId!)
          : createObjRecordDirect(this.store.blocks, pick.name, tagId!)
        recordId = record.id
        createdBlock = true
      }

      const assign = pick.kind === 'tag' || (pick.kind === 'newTag' && pick.action === 'assign')

      /** 一次落点只插**一枚** run；块标签是归类，不插 run。 */
      let inserted: RefRun[] = []
      if (pick.kind === 'ref') {
        inserted = [
          {
            id: uuidv7Hex(),
            t: 'ref',
            to: pick.to,
            ...(pick.flavor ? { flavor: pick.flavor } : {}),
            label: pick.label,
          },
        ]
      } else if (pick.kind === 'newPage') {
        // 页引用不加 `#` 风味：它是页面，不是标签
        inserted = [{ id: uuidv7Hex(), t: 'ref', to: pageId!, label: pick.name }]
      } else if (pick.kind === 'newObj') {
        inserted = [{ id: uuidv7Hex(), t: 'ref', to: recordId!, flavor: '#', label: pick.name }]
      } else if (pick.kind === 'newTag' && pick.action !== 'assign') {
        const to = pick.action === 'instance' ? recordId! : tagId!
        inserted = [{ id: uuidv7Hex(), t: 'ref', to, flavor: '#', label: pick.name }]
      }

      const next = spliceRuns(block.content, hit.from, hit.to, inserted)
      if (tx) {
        tx.patch(id, (b) => writeBlockContent(b, next))
        if (assign) tx.setTags(id, [...tagIdsOf(block), tagId!])
      } else {
        writeBlockContent(block, next)
        if (assign) addTagId(block, tagId!)
      }
      return true
    }

    let ok: boolean
    if (this.write) {
      const write = this.write
      ok = write((tx) => apply(tx, loc.block))
    } else {
      ok = apply(null, loc.block)
      // 新建的标签块还没进派生索引（同 `addTag` 的直写支）：紧接着的重画要靠它
      this.store.invalidateIndex()
    }
    if (!ok) return false
    /**
     * 撤销合并窗口的陷阱：打字那笔（`insert`）与这一笔若同 kind 且落在 1200ms 内，
     * 会被并成一步 —— 一次撤销就回到「输入前」，跳过落点那一格。所以这里一律记
     * `other`（不可合并）：落点动作是**显式的一次选择**，不是打字的延续。
     */
    this.undo.record(before, 'other', Date.now())
    // 插了新块 ⇒ 整片重画（记录落在当天，可能就在这个视图里）；只改这一行时仍走单行
    if (createdBlock) this.renderAll()
    else this.renderBlock(id)
    // 光标：插了露面的落在它之后（1 格）；只归类的那一格已经没了，落在原处
    this.placeCaret(id, hit.from + (pick.kind === 'tag' ? 0 : 1))
    this.emitChange(createdBlock ? 'struct' : 'text', [id])
    return true
  }

  /** 粘贴：多行 → 拆块（id 规则：首块保留原 id，其余新发）。纯文本插入，继承插入点的格式。 */
  pasteAt(id: string, offset: number, text: string): void {
    const lines = text.split('\n')
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    if (lines.length === 1) {
      const next = spliceRuns(loc.block.content, offset, offset, lines[0]!)
      if (this.write) {
        this.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
      } else {
        writeBlockContent(loc.block, next)
      }
    } else {
      // 光标处切两半：首行接在左半后面，余下各成新块，**原右半接到最后一块尾部**
      const [head, tail] = splitRuns(loc.block.content, offset)
      const first = joinRuns(head, textRuns(lines[0]!))
      const created: Block[] = []
      for (let i = 1; i < lines.length; i++) created.push(mkBlock(lines[i]!))
      const last = created[created.length - 1]!
      // 这是**刚造出来、还没进树**的新块（上面 `mkBlock` 那批）⇒ 不走内容写入入口，
      // 它的内容随构造一次给定；那里管的是「改写一个已经存在的地址」
      if (tail.length > 0) writeBlockContent(last, joinRuns(last.content, tail))
      const list = loc.parent ? loc.parent.children : this.doc.roots
      /**
       * 落点与 `insertBlockAfter` 同一条规则：section 根没有兄弟位，余下行成为它的**子块**
       * （往 `roots` 里插兄弟就是「看得见、写不回去」的死区）。其余块插在它后面的同级位。
       */
      const parentId = loc.parent ? loc.parent.id : loc.block.id
      const baseIndex = loc.parent ? list.indexOf(loc.block) + 1 : 0
      if (this.write) {
        const write = this.write
        write((tx) => {
          tx.patch(id, (b) => writeBlockContent(b, first))
          created.forEach((c, i) => tx.insert(c, parentId, baseIndex + i))
        })
      } else {
        writeBlockContent(loc.block, first)
        if (loc.parent) list.splice(baseIndex, 0, ...created)
        else {
          unfoldBlock(this.doc, loc.block.id)
          loc.block.children.splice(0, 0, ...created)
        }
      }
    }
    this.undo.record(before, 'insert', Date.now())
    this.renderAll()
    this.placeCaret(id, offset + (lines[0]?.length ?? 0))
    this.emitChange('text')
  }

  /* ------------------------------------------------------ 页面装载 */

  loadPage(doc: Doc, caret?: { blockId: string; off: number }): void {
    /**
     * ⚠️ **换视图前先让索引失效**。
     *
     * `loadPage` 是「命令改完森林之后」的收尾动作（新建页 / 删页 / 换当前对象），
     * 而那条路径**不发 `store.touch()`**（`kind === 'load'` 刻意跳过，避免把加载当成编辑）。
     * 索引缓存住的是「库长什么样」，所以这里必须显式作废 —— 否则删掉的一页还能被 `find` 到。
     */
    this.store.invalidateIndex()
    /**
     * **换视图也是一个编辑边界**：上一行的编辑期在这里结束。
     *
     * 必须先 `commitEdit` 再清 `editBase`：反过来的话，「敲完字直接点面包屑/引用/块标」
     * 这条路会**丢掉这次边界**——正文已经进模型，修改时间却停在上一处。
     * `commitEdit` 幂等，编辑期本来就是空的时候它什么都不做。
     */
    const ending = this.editBase?.id
    if (ending) this.commitEdit(ending)
    this.doc = doc
    // 换视图 ＝ 换了一份装载单位：上一行那个编辑期在这里结束，不能带到新页上
    this.editBase = null
    this.blockSel = null
    this.mouseSel = null
    this.container.classList.remove('blocksel-drag')
    this.viewRootIds = doc.roots.map((b) => b.id)
    // 换了装载单位：上一形态的空天格子不再成立（复盘入口装载后会重新 setShells）
    this.shells = []
    this.applySecCols()
    // 行内内容住块上：换视图只换 roots，没有第二份锚点数组要替换。
    // **不清 undo**——undo 是 store 全局的，加载反链/查询视图不能清掉正文的撤销栈。
    this.sel = caret ? { aBlock: caret.blockId, aOff: caret.off, hBlock: caret.blockId, hOff: caret.off } : null
    this.renderAll()
    this.events.change?.('load')
  }

  /**
   * **追加一列 root**（日记流的下滚加载， P2）。
   *
   * 与 `loadPage` 的区别：不清 undo、不换「当前对象」、只把新的一段接在后面。
   * 为了省掉一次「重装整页」的代价，这里复用 `renderAll`，但把滚动位置与选区还原回去
   * （用户是滚到底触发加载的，不能被拽回顶部）。
   *
   * ⚠️ 入参应是**浅拷贝**（`rootsForMany`）——编辑器写 root 的正文，不能直接改森林里的块。
   * ⚠️ 超过 `FEED_MAX` 的加载由调用方挡住；这里不做上限判断（视图策略不塞进编辑器）。
   */
  appendRoots(blocks: readonly Block[]): void {
    if (blocks.length === 0) return
    this.doc.roots.push(...blocks)
    this.viewRootIds.push(...blocks.map((b) => b.id))
    const scrollTop = this.blankArea.scrollTop
    const focused = this.container.contains(document.activeElement)
    const sel = this.sel
    this.renderAll()
    this.blankArea.scrollTop = scrollTop
    if (focused && sel) {
      this.sel = sel
      this.restoreSel()
      // `placeCaret` 可能把目标滚进视口；用户正在往下滚，保持他原来的位置
      this.blankArea.scrollTop = scrollTop
    }
    this.events.change?.('load')
  }

  ctxKeys(): CtxKeys {
    const s = this.sel
    const id = s?.aBlock ?? null
    const at = id ? locate(this.doc, id) : null
    const b = at?.block
    /**
     * **森林根**不是「装载根」：一个嵌在天下面的页被单独打开时，`blockIsRoot` 也是 true，
     * 但它并不是森林顶层。`store.blocks` 是森林根数组，O(根数) 就能判。
     */
    const forestRoot = Boolean(id) && this.store.blocks.some((x) => x.id === id)
    return {
      focus: 'editor',
      editorTextFocus: document.activeElement === this.container || this.container.contains(document.activeElement),
      selectionEmpty: s ? s.aBlock === s.hBlock && s.aOff === s.hOff : true,
      selectionCount: s && !(s.aBlock === s.hBlock && s.aOff === s.hOff) ? (s.aBlock === s.hBlock ? 1 : 2) : 0,
      blockFocused: Boolean(id),
      blockId: id ?? '',
      /**
       * 当前块是不是**视图的根**（`locate` 找不到父块）。
       *
       * 为什么需要它：根块不是一个「内容块」—— 删页／删天要走命令面
       * （`core.page/delete`），从编辑器里 splice 掉它只会让视图看不见，
       * 库里那块还在（刷新就回来，看起来像「删了又复活」）。
       * ⇒ 菜单靠这个键把自己藏起来，而不是点了再静默失败。
       */
      blockIsRoot: at !== null && at.parent === null,
      blockIsForestRoot: forestRoot,
      /**
       * 「提取为页」只对**内容块**有定义：身份块（journal／tag／schema／query）
       * 不靠位置表达信息，搬它们没有意义；森林根也没有可移动的落点。
       */
      blockCanExtractPage:
        b !== undefined &&
        !forestRoot &&
        !isJournal(b) &&
        !(hasList(b, 'tag') && !hasList(b, 'page')) &&
        !isPropDefBlock(b) &&
        !isQueryBlock(b),
      blockSelection: this.blockSel !== null,
      blockSelectionCount: this.blockSel?.ids.length ?? 0,
      blockType: b && todoOf(b) ? 'todo' : 'paragraph',
      blockHasChildren: Boolean(b?.children.length),
      blockCollapsed: Boolean(b && isFolded(this.doc, b.id)),
      blockDone: b ? todoOf(b) === 'done' : false,
      marking: b ? this.marksAtSel().join('+') : '',
      inTrash: false,
      composing: this.probe.isComposing,
      isMac: /Mac|iPhone|iPad/.test(navigator.platform),
      undoDepth: this.undo.depth(),
      redoDepth: this.undo.redoDepth(),
      blockCount: flatten(this.doc).length,
      mountedCount: this.mounted.size,
      virtualize: this.virtualize,
    }
  }

  /** 诊断：composing 为真时命令零触发 */
  guard(name: string, ctx: Record<string, unknown>): boolean {
    if (ctx.composing) return false
    this.log.run(name)
    return true
  }
}
