/**
 * **渲染管线**（画层 ＋ 备注画层）：全量重排、单行重画、虚拟化窗口、空天格子、
 * 备注标记的两层画笔。字段与方法都在这里，宿主（`BlockEditor`）保同名转发，
 * 装配层与协作对象的调用点不用动。
 *
 * 与重载路径（`reload-policy.ts`）的分工：policy 管**何时**可以换 DOM（冻结、欠账、
 * 补做），这里管**怎么画**——每个换 DOM 的入口先过 `ed.deferWhileComposing()`，
 * 这条接缝必须保持单向。
 *
 * 自有字段只有渲染自己的（祖先表／光标标记缓存／挂载集合／备注画笔）；
 * 森林、选区、事件表、折叠态全部经宿主。
 */
import {
  ancestorsByBlockId,
  belowFieldsFor,
  closureMarkOf,
  constrainBelowFields,
  depthOf,
  displayRowPropIds,
  foldStateOf,
  gutterFieldsFor,
  hasAnyFieldOf,
  hasLiveChildren,
  hasSingleLiveBlock,
  isFolded,
  journalDateLabel,
  locate,
  noteSourceCellsOf,
  refSourcesOf,
  rowDeriveOf,
  walkForest,
  type Block,
  type BelowFields,
  type GutterField,
  type NoteSourceCell,
  type RefView,
  type RowDerive,
  type ShellCol,
  type VisibleRow,
} from '../../core/index.ts'
import { type GroupHead } from '../../core/model/model.ts'
import { plainText } from '../../core/model/runs.ts'
import { renderIcon } from '../icons.ts'
import { HeightCache } from './height-cache.ts'
import { RowHeightIndex } from './height-index.ts'
import { t } from '../../core/infra/msg.ts'
import { assetViewOf, markAssetMissing } from '../asset-views.ts'
import { LINE_H, fillBlockText, makeBlockEl, makeRefBadgeEl, rowHasEmbedViewBody, rowHasInlineViewBody, visibleRowHeight } from './block-dom.ts'
import { spanAt, offsetAtPoint, rangeAtSpan, paintHits, clearHits } from './hit-paint.ts'
import type { AnnoHitSpan } from './anno-hover.ts'
import { inputSession } from './input-session.ts'
import type { BlockEditor } from './editor.ts'

export class RenderOps {
  constructor(private readonly ed: BlockEditor) {}

  /**
   * **可点导轨的祖先表**：`blockId → [祖先 id…]`（index = 层级 k）。
   *
   * ⚠️ 它对**全量可见行**算，不对 `applyWindow` 的 slice 算——否则窗口从中间开始时，
   *    第一行的祖先全丢（调研 点名的唯一易错处）。所以只在
   *    `renderAll` / `applyWindow` / `renderBlock` 入口重建，渲染单行时查表。
   */
  private ancestors = new Map<string, string[]>()

  /** 这一屏已挂载的块 id（宿主 getter 转发给装配层的诊断与徽标） */
  mounted = new Set<string>()

  /**
   * 渲染探针（诊断用，不是产品状态）。
   *
   * `rows` 是**这一笔处理了多少行**（不是挂了多少 DOM）：虚拟化之后 DOM 只有窗口那几十个，
   * 但 `applyWindow` 仍要对全量行算占位高度——这两个数分开记，才能看出「虚拟化只省了
   * DOM、没省行投影」。只有测试面读它（`window.__qua.perf`）。
   */
  /**
   * **行派生的缓存**（定义块/标签块/父声明/选项表）。
   *
   * 这几张表只在「树形/存在」或「属性」变化时才变，**文本输入不碰它们**——
   * 逐键重扫整库（`allPropDefs` ＋ `tagsById`）是单行重画里最后两遍全库遍历。
   * 失效键＝store 的两个修订号（结构／属性）＋ **当前索引对象**（索引被丢弃重建时
   * 连带作废：缓存里握着的 byId 表已经不代表这一代了）。
   */
  private deriveCache: {
    structureRev: number
    propsRev: number
    index: unknown
    derive: RowDerive
  } | null = null

  private deriveOf(): RowDerive {
    const store = this.ed.store
    const index = store.index
    const c = this.deriveCache
    if (
      c !== null &&
      c.structureRev === store.structureRevision &&
      c.propsRev === store.propsRevision &&
      c.index === index
    ) {
      return c.derive
    }
    const derive = rowDeriveOf(store.blocks, index.blocks)
    this.deriveCache = { structureRev: store.structureRevision, propsRev: store.propsRevision, index, derive }
    return derive
  }

  readonly probe = {
    renderAllCalls: 0,
    renderAllRows: 0,
    renderBlockCalls: 0,
    renderRowsCalls: 0,
    renderRowsRendered: 0,
    applyWindowCalls: 0,
    applyWindowMs: 0,
    applyWindowRows: 0,
    topRowCalls: 0,
    topRowRows: 0,
    /** 离屏实测的批次数/行数（后台一次性成本，诊断用） */
    offscreenBatches: 0,
    offscreenRows: 0,
    /** 行高前缀索引重建次数 / `topRowId` 落进占位区的次数 */
    heightIndexBuilds: 0,
    topRowFallbacks: 0,
  }

  /**
   * **实测行高**：`blockId → 量到的高度`（只给「挂载过」的行记账）。
   *
   * 为什么必须有这一格：`visibleRowHeight` 是**纯估**（`LINE_H` ＋ 头 ＋ 属性行数），
   * 而正文 `.tx` 是 `pre-wrap` 且无 clamp ⇒ 长正文折行会把这一行撑高，估高对不上。
   * 实测（`checks/probe-row-height.mjs`）：一条折行块真高 107px、估 30px；文档总高
   * 虚拟化开 1709 vs 全挂载 1993。**短块估高偏 2px 恰好抵掉长块亏空**，所以总量上
   * 看不出来，只在「少数长块」时局部塌陷——滚到那一段落点才偏。
   *
   * 判据：**量到过就用实测**，没量过才退回估算。窗口外的行挂不到 DOM（量不到），
   * 所以估仍然是主路径；这张表只负责「滚过一次之后，回去的那一段高度是对的」。
   * 与既有登记（查询体／露面体估高偏小）同一条方向：按「已量过的实例」回填占位。
   *
   * ⚠️ **宽度变了必须作废**：折行数随可用宽度变，同一块在 1440 与 800 宽下高度不同。
   *    `invalidateHeights(width)` 由内容区宽度变化调（见 `editor.ts` 的 `bindWidthChange`）。
   *
   * ⚠️ **行被重画时也要作废那一格**：`renderBlock` 换掉整行 DOM 之后，表里那个数是
   *    「换之前」的。不删的话，改了正文（比如打长了一行）再滚走，占位用的还是旧高。
   */
  /**
   * **实测行高表**（判据与理由见 `./height-cache.ts` 的模块注释）。
   *
   * 这里只负责「什么时候量、量完怎么用」，表本身的存/查/作废判据在那个模块里——
   * 它是纯的，单测直接钉它（`tests/height-cache.test.ts`），不用起浏览器。
   */
  readonly heights = new HeightCache()

  /**
   * **行高前缀索引**：与可见行同一代。换窗时头/尾占位与落点都查它，
   * 不再把全量行 `slice().reduce()` 一遍（见 `./height-index.ts`）。
   *
   * 失效：`rows` 数组换代（结构/折叠/筛选）或 `propsRevision` 变（块下行行数是估算
   * 的输入）。内容改动不改估算口径——窗口内那一行的实测回填走点更新。
   */
  private heightIndex: {
    rows: readonly VisibleRow[]
    /** 行 id → 行下标（Fenwick 点更新与锚点定位用） */
    pos: Map<string, number>
    propsRev: number
    index: RowHeightIndex
  } | null = null

  private ensureHeightIndex(): NonNullable<RenderOps['heightIndex']> {
    const rows = this.ed.rows()
    const propsRev = this.ed.store.propsRevision
    const c = this.heightIndex
    if (c !== null && c.rows === rows && c.propsRev === propsRev) return c
    /**
     * ⚠️ 建表是 **O(N) 一次性**（估算需要每行的块下行行数 ⇒ 整批 `belowOf`），
     *    但从此**不在换窗路径上**：滚动只做前缀和查询与窗口内实测的点更新。
     */
    const below = this.belowOf(rows.map((r) => r.block))
    const values = rows.map((r) => this.rowHeight(r, below))
    this.probe.heightIndexBuilds++
    const entry = {
      rows,
      pos: new Map(rows.map((r, i) => [r.block.id, i])),
      propsRev,
      index: new RowHeightIndex(values),
    }
    this.heightIndex = entry
    return entry
  }

  /** 记下这一行的实测高（`applyWindow` 挂完整窗之后量一次） */
  measureRows(ids: Iterable<string>): void {
    const hi = this.heightIndex
    // 索引必须对得上**此刻**的行数组：换过代就先不动它（下一次 ensure 会重建并读到实测表）
    const live = hi !== null && hi.rows === this.ed.rows() ? hi : null
    for (const id of ids) {
      const el = this.ed.blockEl(id)
      if (!el) continue
      /**
       * ⚠️ 只认**已挂载且未折叠**的行：`display:none` 的子树量出来是 0，
       *    记进去会把那一段的占位直接压成零高（`HeightCache.set` 自己也挡了这一条，
       *    这里再挡一次是因为「挂载了但量不到」的路径不止折叠一种）。
       */
      const h = el.getBoundingClientRect().height
      this.heights.set(id, h)
      const i = live?.pos.get(id)
      if (live && i !== undefined) live.index.set(i, h)
    }
  }

  /** 宽度变了（或前提变了）⇒ 作废实测高与前缀索引；理由见 `HeightCache.invalidate` */
  invalidateHeights(width?: number): void {
    this.heights.invalidate(width)
    this.heightIndex = null
    this.measureQueueFor = null
  }

  /**
   * **窗口外的行**：空闲时离屏量一遍，让「第一次打开」的总高就是对的。
   *
   * 为什么必须有这一步：`applyWindow` 只能量窗口内那几行，窗口外 33 行的占位仍按估算
   * ——一条折行块就亏 77px，几十条就是几百 px 的总高偏差（实测 284px）。用户不动手
   * 就永远看不到准的滚动条，而「滚动条长度可信」正是虚拟化档要买的东西之一。
   *
   * 做法：把行按 `LINE_H` 高的盒子挂进一个**离屏容器**（同一套 CSS、同一宽度），
   * 量完立刻拆掉。不碰真容器，所以不闪、不动滚动位、不影响焦点。
   * 分批（每批 `idleBatch` 行）＋ `requestIdleCallback`：万行文档不该在首帧后卡住。
   */
  private scheduleOffscreenMeasure(): void {
    if (typeof requestIdleCallback === 'undefined') return
    if (this.offscreenQueued) return
    this.offscreenQueued = true
    requestIdleCallback(() => {
      this.offscreenQueued = false
      this.measureOffscreenBatch()
    })
  }

  private offscreenQueued = false

  /**
   * 离屏测量的**待量队列**：行集合换代时建一次（O(N)），之后每批只取游标处的一段。
   * 旧写法每批都 `rows.filter(!measured)`——100k 行 × 1563 批就是 O(N²) 的空闲开销。
   */
  private measureQueue: VisibleRow[] = []
  private measureCursor = 0
  private measureQueueFor: readonly VisibleRow[] | null = null

  /** 一次空闲批次：把「还没量过」的行挂到离屏容器里量一遍，直到量完 */
  private measureOffscreenBatch(): void {
    if (!this.ed.virtualize || this.ed.layout !== 'column') return
    const rows = this.ed.rows()
    if (this.measureQueueFor !== rows) {
      /**
       * ⚠️ **预量有上限**：全量预量要替每一行建一次离屏 DOM，十万行量级实测
       * ~16ms/64 行（总共 25s 量级），与「滚动成本只跟窗口有关」直接冲突。
       * 超过上限的文档按「滚到哪量到哪」：窗口内的实测照常回填，前缀索引里的
       * 总高是估算——这是保留的已知误差，不再用后台 CPU 换。
       */
      this.measureQueue = rows.filter((r) => !this.heights.has(r.block.id)).slice(0, this.offscreenMaxRows)
      this.measureCursor = 0
      this.measureQueueFor = rows
    }
    if (this.measureCursor >= this.measureQueue.length) return
    const width = this.ed.blankArea.clientWidth
    if (width <= 0) return
    const host = document.createElement('div')
    /**
     * ⚠️ **必须同时带上 id 与类名**：行高的来源不只是 `.blk` 自己的 CSS——
     *    `#editor[data-layout='column'] .sec:has(> .blk[...journal])` 这类规则按
     *    **父链**选，缺了 `#editor` 与 `.sec`，日记段就量少了段间留白
     *    （实测：46 行累加 1296 vs 真 1376，差 80px 全是段间距）。
     */
    host.id = this.ed.container.id
    host.className = this.ed.container.className
    for (const attr of this.ed.container.attributes) {
      if (attr.name.startsWith('data-') && attr.name !== 'data-caret') host.setAttribute(attr.name, attr.value)
    }
    /**
     * ⚠️ 必须是**同一宽度**：折行数由可用宽度决定，换个宽度量出来的高就是错的。
     *    同时要 `position:absolute` ＋ 不可见，否则它会挤动真文档。
     */
    host.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;visibility:hidden;pointer-events:none;`
    /**
     * 行必须包进 `.sec`：段是**几何的一层**（段间留白住在它上面），
     * 直接挂成 `#editor` 的子节点会丢掉那部分高度。
     */
    const sec = document.createElement('div')
    sec.className = 'sec'
    sec.dataset.sec = ''
    host.appendChild(sec)
    const batch = this.measureQueue.slice(this.measureCursor, this.measureCursor + this.idleBatch)
    this.measureCursor += batch.length
    this.probe.offscreenBatches++
    this.probe.offscreenRows += batch.length
    // 与在线渲染同一条批级路径：扫库一次、单块判据一次
    const batchBlocks = batch.map((r) => r.block)
    const derive = this.deriveOf()
    const gutters = gutterFieldsFor(batchBlocks, this.ed.store.blocks, derive)
    const below = this.belowOf(batchBlocks, derive)
    const single = hasSingleLiveBlock(this.ed.doc)
    const made: { id: string; el: HTMLElement }[] = []
    /**
     * ⚠️ **必须绕开 `makePlaceholderFor`**：那是同构重装给 `rebuildWith` 用的钩子，
     *    一旦有值，`makeBlockEl` 会返回一个**空占位节点**而不是真行——量出来是 0。
     *    离屏测量要的是真行。
     */
    const savedHook = this.makePlaceholderFor
    this.makePlaceholderFor = null
    try {
      for (const r of batch) {
        const el = this.makeBlockEl(r, gutters.get(r.block.id), below.get(r.block.id), single, false)
        sec.appendChild(el)
        made.push({ id: r.block.id, el })
      }
    } finally {
      this.makePlaceholderFor = savedHook
    }
    document.body.appendChild(host)
    const hi = this.heightIndex
    const live = hi !== null && hi.rows === rows ? hi : null
    for (const { id, el } of made) {
      const h = el.getBoundingClientRect().height
      this.heights.set(id, h)
      // 实测值点更新进前缀索引（O(log N)），占位随即可用前缀和重写
      const i = live?.pos.get(id)
      if (live && i !== undefined) live.index.set(i, h)
    }
    host.remove()
    /**
     * 量完要**回写占位**：头尾那两个 `.ph` 的高度是按旧表算的，不回写就还是旧数。
     * 只改样式高度，不重挂 DOM（不闪、不动滚动位）。
     */
    this.refreshPlaceholderHeights()
    if (this.measureCursor < this.measureQueue.length) this.scheduleOffscreenMeasure()
  }

  /** 按当前（可能刚更新过的）前缀索引重写头尾占位的高度 */
  private refreshPlaceholderHeights(): void {
    const rows = this.ed.rows()
    if (rows.length === 0) return
    const heights = this.ensureHeightIndex()
    const head = this.ed.container.querySelector<HTMLElement>('.ph[data-ph="head"]')
    const tail = this.ed.container.querySelector<HTMLElement>('.ph[data-ph="tail"]')
    if (head && this.winFrom > 0) head.style.height = `${heights.index.prefix(this.winFrom)}px`
    if (tail && this.winTo < rows.length) {
      tail.style.height = `${heights.index.total - heights.index.prefix(this.winTo)}px`
    }
  }

  /** 一次空闲批次量多少行（`requestIdleCallback` 的单次预算内量得完的量级） */
  private idleBatch = 64
  /** 每份文档最多预量多少行（超过就按「滚到哪量到哪」，见 `measureOffscreenBatch`） */
  private readonly offscreenMaxRows = 2000

  /** 这一行的高度不再可信（DOM 被换掉）：只删这一格，不动其余 */
  forgetHeight(id: string): void {
    this.heights.forget(id)
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

  /** 本实例的备注标记画笔 key（每台编辑器一份，互不覆盖；dispose 时摘掉） */
  private readonly annoKey = `anno-mark-${Math.random().toString(36).slice(2)}`
  /** hover 命中那一段的加深画笔（AnnoHover 回报驱动；与常显层分 key 才能两档样式） */
  private readonly annoHotKey = `anno-mark-hot-${Math.random().toString(36).slice(2)}`
  private annoPaintQueued = false
  /**
   * 活跃备注区间（与画层**同源**：paintAnnoMarks 每次重画时顺手缓存）。
   * hover 命中判定读它——判定与画亮的是同一处，两份口径必然漂。
   */
  /** 宿主经 getter 读（AnnoHover 闭包与装配层） */
  annoSpans: ReadonlyMap<string, readonly AnnoHitSpan[]> = new Map()

  /**
   * 折叠态的签名。折叠标志（行的 `data-collapsed`、身体的 `data-folded`）是**构造期**
   * 写进行元素的——保留行原样换回时带的是旧标志，所以只在「折叠态与上次渲染一致」时
   * 才允许保留；变了的这次（折一下／展开一组）整体退回全量重建。
   */
  private renderedFoldSig = ''
  private foldSig(): string {
    const fs = foldStateOf(this.ed.doc)
    return Object.keys(fs)
      .filter((k) => fs[k] === true)
      .sort()
      .join(',')
  }

  /** 折叠标志被**就地**重画过（`paintFold`，不重建 DOM）⇒ DOM 与折叠态重新一致 */
  noteFoldPainted(): void {
    this.renderedFoldSig = this.foldSig()
  }

  /**
   * 上次渲染时**事件表接上了没有**。编辑器构造时就渲染首帧，而事件表是装配层
   * 之后才赋上的——「接上后再重画一次」是身体能画出来的唯一路径。那次重画
   * 模型没变，修订号看不见它；保留行把它变成空操作，身体就永远是破态壳。
   * 所以事件表的有无也参与保留判据：与上次渲染不一致 ⇒ 整体重建。
   */
  private renderedWithEvents = false
  private eventsPresent(): boolean {
    const ev = this.ed.events
    return Boolean(ev && (ev.viewBody || ev.automationBody || ev.embedBody || ev.propsLine || ev.assetView))
  }

  /**
   * 上次渲染用的**那份 doc**。装载形状（roots／paths／contexts／rootNotes／expandedRoots）
   * 都是行渲染的输入，却不是 store 变更——修订号看不见它们；`loadPage`／派生栏重配
   * 换的是新 doc 对象，同一性对账最便宜也最不会漏。
   */
  private renderedDoc: object | null = null

  /**
   * **把旧 DOM 里能对上 id 的行摘下来留用**；`null` ＝ 这一次不值得保留（退回全量重建）。
   *
   * 判据五条，任何一条不满足都整体放弃（不做「部分保留」——那要回答「哪几行深拷才对」，
   * 退化成逐行 diff，正是这条快路要躲开的复杂度）：
   *   · **新装载的行 id 全是旧 DOM 里有的**（刷新查询／对齐数据的典型形状：成员同、
   *     顺序同或近似）。新行一出现就说明成员变了，重建只多不少地覆盖它；
   *   · 行数对得上（防「同 id 不同位置」的树重构被误保留——depth/gutter 会全错）；
   *   · 没有虚拟化窗口（窗口切片行的 `data-depth` 属于窗口形状，不是全集形状）；
   *   · **id 无重复**（同一块在同一视图里出现两行——露面／镜像——时，保留表按 id 只
   *     认领得到一份元素，两个占位会抢同一个节点，重建把它们塌成一份；多实例只有
   *     全量重建的「逐行各建各的」天然支持）；
   *   · **折叠态与上次渲染一致**（签名见 `renderedFoldSig`）。
   *
   * 保留的行**连子树一起**（embed 身体、里层编辑岛、选中漆层都在行上）——这正是
   * 「不闪」的全部来源：那些行根本没被重建过。
   */
  private holdRows(): Map<string, { el: HTMLElement; depth: number }> | null {
    if (this.ed.virtualize && this.ed.layout === 'column') return null
    if (this.foldSig() !== this.renderedFoldSig) return null
    if (this.eventsPresent() !== this.renderedWithEvents) return null
    if (this.ed.doc !== this.renderedDoc) return null
    const rev = String(this.ed.store.revision)
    const rows = this.ed.rows()
    if (rows.length === 0) return null
    const kept = new Map<string, { el: HTMLElement; depth: number }>()
    for (const r of rows) {
      const el = this.ed.blockEl(r.block.id)
      if (!el) return null
      if (el.dataset.depth !== String(r.depth)) return null
      // 这行画下之后模型动过（内容／属性／结构——连打字也算）⇒ 行上的派生物
      // （块标、关闭态标记、chips、属性行）都可能是旧的。一票否决，整体重建。
      if (el.dataset.rev !== rev) return null
      kept.set(r.block.id, { el, depth: r.depth })
    }
    if (kept.size !== rows.length) return null
    return kept
  }

  /**
   * **带着保留行重建**：搭新的段结构（占位行先挂），再把旧行 `replaceWith` 归位。
   *
   * 归位是「整棵子树换入」：保留行从不需要重新渲染，`makeBlockEl` 只服务新出现的行。
   * 焦点与选区跟着 DOM 走（节点没换就不用抢）；`mounted`/祖先表/光标标记按重装后的
   * 形状重建（与全量重建同口径）。
   */
  private rebuildWith(kept: Map<string, { el: HTMLElement; depth: number }>): void {
    const detached = new Map<string, HTMLElement>()
    for (const [id, { el }] of kept) {
      el.remove()
      detached.set(id, el)
    }
    // 占位重建：保留行先以空节点占位（占位决定它在段里的位置），随后原样换入
    const rows = this.ed.rows()
    const placeholders = new Map<string, HTMLElement>()
    this.ed.container.textContent = ''
    this.ed.resetRowEls()
    this.mounted.clear()
    this.rebuildAncestors()
    this.caretMarks = ''
    const all = rows
    this.winFrom = 0
    this.winTo = all.length
    const savedMake = this.makePlaceholderFor
    this.makePlaceholderFor = (r) => {
      const old = detached.get(r.block.id)
      if (old) {
        placeholders.set(r.block.id, old)
        const ph = document.createElement('div')
        ph.dataset.keepId = r.block.id
        return ph
      }
      return null
    }
    try {
      this.renderRows(all)
    } finally {
      this.makePlaceholderFor = savedMake
    }
    for (const id of placeholders.keys()) {
      const el = detached.get(id)
      const fresh = this.ed.container.querySelector<HTMLElement>(`[data-keep-id="${CSS.escape(id)}"]`)
      if (!el || !fresh) {
        this.ed.dropRowEl(id)
        continue
      }
      fresh.replaceWith(el)
      this.ed.setRowEl(id, el)
    }
    /**
     * **把保留行的身体接回去**。`renderAll` 开头的 `disposeAll` 对身体是「延后一拍拆」：
     * 全量重建靠 `makeBlockEl` 的 `embedBody`／`viewBody` 回调**在同一任务里重新 open**
     * 取消拆卸；保留行走占位捷径、没人 open ⇒ 下一拍真拆——查询体／嵌入体整片消失，
     * 只剩空壳（折叠后查询面板不见、刷新后条件树空白都是它）。照同一套回调接回：
     * 缓存型的身体原样搬回（冻结结果与滚动位置还在），非缓存型的重挂一份新的。
     * 只碰归位成功的保留行（新画的行已经由 `renderRows` 挂过，再挂就是双份）。
     */
    for (const [id, { el }] of kept) {
      if (this.ed.blockEl(id) !== el) continue
      if (this.ed.embeds.isPinned(id)) continue
      const block = this.ed.store.find(id)
      if (!block) continue
      const viewShell = el.querySelector<HTMLElement>(':scope > .blk-view-body[data-view-body-for]')
      if (viewShell && this.ed.events.viewBody) this.ed.embeds.attachViewBody(block, viewShell)
      const embedShell = el.querySelector<HTMLElement>('.blk-embed-body[data-embed-body-for]')
      if (embedShell && this.ed.events.embedBody) this.ed.embeds.attach(block, embedShell)
    }
    this.mounted = new Set([...kept.keys()].filter((id) => Boolean(this.ed.blockEl(id))))
    this.markCaret()
    this.ed.bsel.paintBlockSel()
    this.ed.events.mounted?.()
    this.renderedFoldSig = this.foldSig()
    this.renderedWithEvents = this.eventsPresent()
    this.renderedDoc = this.ed.doc
  }

  /** `rebuildWith` 给 `renderRows` 的占位钩子：返回 `null` ＝ 按普通行画 */
  private makePlaceholderFor: ((r: VisibleRow) => HTMLElement | null) | null = null

  /**
   * **整页重画，但把输入锚点的那一行原样换回去。**
   *
   * 为什么不增量挂新行：结构变化是低频的，整页重画 + 换回一行足够便宜；增量挂载
   * 要重新回答「插在哪、兄弟位怎么挪」这整组问题——性能真不够时再换，入口不变。
   *
   * 三种「不保留」（旧行的样子已经过期，硬保留只会把界面和模型继续分叉）：
   *   · 锚点块不在新装载里（被删/移出结果集）⇒ 不保留；输入 owner 是本编辑器的话回源；
   *   · **锚点行自己被这次变化搬走了**⇒ 旧行的 `data-depth`/导轨还是旧位置的
   *     （判据见 `anchorRowUnmoved`：唯一带「旧位置」的是上次渲染的祖先链表）；
   *   · 旧行不在 DOM 里（窗口化把它收走了等）⇒ 没有可保留的东西。
   */
  renderAllPreservingAnchor(anchorId: string | null): void {
    if (!anchorId) {
      this.renderAll()
      return
    }
    const loc = locate(this.ed.doc, anchorId)
    if (!loc) {
      if (inputSession.editor === this.ed) this.ed.events.focusSource?.(anchorId)
      this.renderAll()
      return
    }
    if (!this.anchorRowUnmoved(anchorId)) {
      this.renderAll()
      return
    }
    const oldEl = this.ed.blockEl(anchorId)
    if (!oldEl) {
      this.renderAll()
      return
    }
    // 重画会把旧行从树上摘下来一瞬（`textContent = ''`）：焦点若在旧行里（里层编辑岛
    // 正在输入），那一刻就被Chrome交给 body，插回去也不会自己回来 —— 正在输入的表面
    // 不能因为别人的一次结构编辑丢焦点 ⇒ 记下来，插回后原样请回去。
    const active = document.activeElement
    const focusInside = active !== null && oldEl.contains(active)
    // 身体（里层编辑器/表格）挂在行上：重画期间既不能摘、也不能先挂一份新的
    this.ed.embeds.pin(anchorId)
    try {
      this.renderAll()
      const fresh = this.ed.blockEl(anchorId)
      if (fresh && fresh !== oldEl) {
        fresh.replaceWith(oldEl)
        this.ed.setRowEl(anchorId, oldEl)
        this.mounted.add(anchorId)
        if (focusInside) (active as HTMLElement).focus({ preventScroll: true })
      }
    } finally {
      this.ed.embeds.unpin()
    }
    // 旧行是原样换回的：光标标记与块选区漆层按换回后的 DOM 重打一遍
    this.repaintOverlays()
  }

  /**
   * 锚点行自上次渲染以来**位置没变**才可保留旧行。
   *
   * 两份链都取**同一条投影**（`ancestorsByBlockId(rows)`，扁平行的栈算链）：
   * 一份是上次渲染算好的表（`this.ancestors`），一份是现在的模型——
   * 不直接从 `locate` 往上走，是为了躲开上下文行（trail／展开根）那种
   * 「装载顺序 ≠ 树序」的表面在两份投影之间的口径差。
   *
   * ⚠️ 为什么不能比「锚点的 parent」：`reloadStructural` 在**写入之后**才解析锚点，
   *    两边都来自同一棵新树，比出来永远相等——那道门从没拦住过（真踩过：
   *    把聚焦着的行拖进侧槽窗口，旧行带着旧 depth 换回，正文停在旧层级）。
   *
   * 表里没这行（增量 renderBlock 只换单行、不重建表之后又没整页重画过——理论上
   * 不该发生）⇒ 保守不保留：新画的行是对的，焦点丢一拍，下一击自愈。
   */
  private anchorRowUnmoved(id: string): boolean {
    const rendered = this.ancestors.get(id)
    if (!rendered) return false
    const now = ancestorsByBlockId(this.ed.rows()).get(id)
    if (!now) return false
    return rendered.length === now.length && rendered.every((x, i) => x === now[i])
  }

  renderAll(): void {
    /**
     * ⚠️ **组合期不换 DOM**（见 `deferWhileComposing`）。这条是全量重排的唯一入口，
     *    守卫放在这里才覆盖得住 `loadPage`／`reloadFromStore`／各命令路径。
     */
    if (this.ed.deferWhileComposing()) return
    this.probe.renderAllCalls++
    // 整页重排是「不经事务的装载」的兜底失效：工作集补块不推修订号，
    // 只靠 structureRevision/propsRevision 会漏掉新装进来的标签/定义块
    this.ed.fieldTableCache = null
    this.ed.embeds.disposeAll()
    /**
     * **同构重装**：旧 DOM 里能对上 id 的行**原样保留**，只搭新容器再把它们归位——
     * 清空重建会让「刷新一次查询」读作「整屏白一帧再长出来」。焦点行不在保留集
     * （成员真的换了、虚拟化窗口外）⇒ 退回全量重建。
     */
    const kept = this.holdRows()
    if (kept !== null) {
      // rebuildWith 已经管完两头的行：没进新集合的在开头就摘下了，进了新集合的刚归位成活行。
      // 这里不能再拆一遍——会把它刚归位的整屏行连根拔掉（正文消失、只剩挂载区）。
      this.rebuildWith(kept)
      return
    }
    this.ed.container.textContent = ''
    this.ed.resetRowEls()
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    // 虚拟化只属单列流：row/grid 的段要完整的盒子才能当列用，窗口切片会把列切残
    if (this.ed.virtualize && this.ed.layout === 'column') {
      this.applyWindow()
      return
    }
    const all = this.ed.rows()
    this.probe.renderAllRows += all.length
    this.winFrom = 0
    this.winTo = all.length
    this.renderRows(all)
    this.markCaret()
    this.ed.bsel.paintBlockSel()
    this.ed.events.mounted?.()
    this.paintAnnoMarks()
    this.renderedFoldSig = this.foldSig()
    this.renderedWithEvents = this.eventsPresent()
    this.renderedDoc = this.ed.doc
  }

  /**
   * 把某一行滚进视口并闪一下。
   *
   * 用途：上下文展开后命中行可能在屏幕外（展开了一整页祖先）——不滚过去，
   * 用户只看到一堆无关兄弟块，会以为「点了跳到别处」。
   * ⚠️ 虚拟化时目标可能不在窗口里：先把窗口中心移到它，再取元素。
   */
  reveal(id: string): void {
    if (this.ed.virtualize && !this.ed.blockEl(id)) this.applyWindow(id)
    const el = this.ed.blockEl(id)
    if (!el) return
    // 跳块走平滑滚动：viewport 级瞬跳读作「换了一屏」，眼睛跟不上路；
    // 减动效偏好直接瞬移（flash 仍承担「到了哪里」的可达性反馈）。
    // ⚠️ 只在这一个跳转点选 smooth：打字时的滚动到光标必须瞬时，不走 CSS 全局 scroll-behavior。
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
    el.dataset.flash = '1'
    window.setTimeout(() => {
      if (el.isConnected) delete el.dataset.flash
    }, 900)
  }

  /**
   * 剪切确认：被抓进剪贴板的行**抖一下**。⌘X 不改文档（移动发生在粘贴那一刻），
   * 屏幕上什么都没变——没有这一下，用户不知道按没按上。
   * 与 `reveal` 的 flash 同一挂法：data 属性 ＋ CSS keyframes，reduced-motion 由 CSS 关
   * （那里的可达性反馈由门面退回提示，不在这层造静态替身）。
   * 只对画得上的一行抖：虚拟化时看不见的块没有「看见的确认」可给。
   */
  pulseBlocks(ids: readonly string[]): void {
    for (const id of ids) {
      const el = this.ed.blockEl(id)
      if (!el) continue
      el.dataset.pulse = '1'
      window.setTimeout(() => {
        if (el.isConnected) delete el.dataset.pulse
      }, 400)
    }
  }

  txEl(id: string): HTMLElement | null {
    return this.ed.blockEl(id)?.querySelector<HTMLElement>('.tx') ?? null
  }

  /**
   * 重建祖先表（**全量可见行**）。
   * 每个改结构的入口都要调它——导轨画的是「此刻的树」，不是「上次渲染的树」。
   */
  private rebuildAncestors(): void {
    const rows = this.ed.rows()
    /**
     * **同一份行数组不重算**：`rows()` 已经是缓存投影，数组身份就是「这一代可见行」
     * 的身份。虚拟化每换一次窗都会走到这里，而换窗不改变行集合——旧写法会把
     * O(全量行) 的祖先表重算一遍，等于把缓存省下的又花回去。
     */
    if (this.ancestorsRows === rows) return
    this.ancestors = ancestorsByBlockId(rows)
    this.ancestorsRows = rows
  }

  /** 上次算祖先表用的是哪一份行数组（缓存身份） */
  private ancestorsRows: readonly VisibleRow[] | null = null

  /**
   * **分段大纲的组头**（chrome 行）：折叠箭头 ＋ 页名 ＋ 条数。
   *
   * 它不是块也不进段模型：`contentEditable=false` 断开编辑链（与 `.sec-mount` 同一条
   * 教训——chrome 嵌在 contenteditable 容器里必须自断，否则焦点被外层宿主吃掉）。
   * 点击路由归**事件层**（`data-grp-head`）：组名（`data-grp-open`）去那一页——
   * 与块标/备注来源格同一条路由（普通＝聚焦，修饰键＝别处）；其余（箭头/空白）翻折叠，
   * 装载单位的知识不在编辑器，`onGroupActivate` 只报组键。箭头与块折叠同一族
   * （`chevron-down`，收起转 -90°，省一个图标名也留出过渡）。
   */
  private makeGroupHead(h: GroupHead): HTMLElement {
    const el = document.createElement('div')
    el.className = 'grp-head'
    // 组键（折叠路由的身份），不是锚——锚只管插位，见 GroupHead.key 的说明
    el.dataset.grpHead = h.key
    el.contentEditable = 'false'
    const caret = document.createElement('span')
    caret.className = 'grp-caret'
    if (h.collapsed) caret.dataset.collapsed = '1'
    renderIcon(caret, undefined, 'chevron-down', 'sm')
    const name = document.createElement('span')
    name.className = 'grp-name ui-ellipsis'
    name.textContent = h.label
    if (h.openId) name.dataset.grpOpen = h.openId
    const count = document.createElement('span')
    count.className = 'grp-count'
    count.textContent = String(h.count)
    el.append(caret, name, count)
    return el
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

  /**
   * 挂一列可见行。
   *
   * gutter 字段在**循环外**按整批算一次：每行各自扫库会让整屏渲染退化成 O(n²)，
   * 而这种退化不报错、只是越用越慢。
   *
   * **段物质化**：连续的行按段包进 `.sec[data-sec]`——depth 0 的行开新段。
   * `.sec` 只表达段边界，不表达层级（行在段内仍是扁平的 ＋ `data-depth`）；
   * 缺省布局下它是 `display: contents`（零几何影响），`row`/`grid` 才由 CSS 给它盒子。
   * 例外：单列流的日记段要一个盒子承载段间留白（样式层决定，装配层不区分）。
   * ⚠️ 虚拟化的窗口切片可能从段中间开始：那一段的 `.sec` 没有段根行，
   *    `data-sec` 落空串——分割线与「点空白归段」的判据都依赖段根在场。
   *
   * **段尾空槽**（`.sec-mount`）：每段末尾留一个**空的** div，装配层把「块底的挂载区」
   * 挂进去。为什么空着而不是由这里建实例：渲染是纯的，实例的生命周期要有人管
   * （哪一段展开、哪个 tab 激活），那是装配层的知识。`view/` 只交代「这儿有个位置」。
   * ⚠️ 只给 **`data-sec` 非空的段**发槽：窗口切片从段中间开始时那段没有段根行，
   *    给它发槽就等于把挂载区挂到一个装配层认不出的段上（`data-sec` 是空串）。
   * ⚠️ 最后一段只有在**它完整**时才发槽（`tailComplete`）：虚拟化窗口的下边界可能切在
   *    段中间，那时这一段还在往下长，槽会被后一行挤到中间去。

  /**
   * 行的**模型父块**（`_childProps` 显示声明的来源；父不在装载窗口 ⇒ null）。
   * 渲染是按树扁平成可见行的（`VisibleRow` 没有 parent 指针），但 doc 里有——
   * 「显示跟数据走」就靠这一步把模型父链接回来（嵌入岛装的是同一棵子树 ⇒ 自动跟随）。
   */
  private parentOfRow(id: string): Block | null {
    /**
     * 父链直接从**索引的树父表**取（O(1)）：`applyWindow` 会对全量行问这一格，
     * 逐块 `locate` 是 O(N²)，一次换窗就付一次。父块必须是活的（按 id 从
     * 可见表取）——渲染中的行不可能挂在软删父块下面。
     */
    const parentId = this.ed.store.index.parentOf.get(id)
    return parentId ? (this.ed.store.index.blocks.get(parentId) ?? null) : null
  }

  /**
   * 块下行的**唯一取值入口**：视图白名单在场时，行集由它覆写（空数组＝只标题）。
   *
   * 渲染与虚拟化估高都走这一份——两处各算一遍，滚动条会系统性地与内容不符，
   * 而那种偏差不报错，只在滚到底部时露出来。大纲有块标，归 gutter 的属性由
   * gutter 画，所以这里**不** `includeGutter`（并进块下行会画两遍）。
   */
  private belowOf(blocks: readonly Block[], derive?: RowDerive): Map<string, BelowFields> {
    const allowed = displayRowPropIds(this.ed.doc.displayProps)
    // 父块查询走索引表（O(1)/行），整批不再有额外遍历
    const parentOf = (id: string) => this.parentOfRow(id)
    const below = belowFieldsFor(
      blocks,
      this.ed.store.blocks,
      parentOf,
      this.ed.store.index.blocks,
      { ...(allowed !== undefined ? { wanted: allowed } : {}) },
      derive,
    )
    return constrainBelowFields(below, allowed)
  }

  /**
   * 行内原子的呈现元信息：目标有没有字段、有没有 closure 状态。
   *
   * 为什么住渲染层而不是 `resolveRef`：判 closure 要 `FieldTable`（标签声明那一半），
   * 而 `core/ref.ts` 只看块、不持有森林。这里用编辑器的缓存表，**不新扫库**。
   * 目标不在当前森林 ⇒ `undefined`，原子退回普通引用（不假装有 body/状态）。
   */
  private refMetaOf(id: string): Pick<RefView, 'fields' | 'closure'> | undefined {
    const find = (x: string) => this.ed.store.find(x)
    const target = find(id)
    if (!target) return undefined
    const fields = hasAnyFieldOf(target, find)
    if (!fields) return { fields: false }
    const closure = closureMarkOf(target, this.ed.fieldTable(), find)
    return { fields: true, ...(closure ? { closure } : {}) }
  }

  private renderRows(rows: readonly VisibleRow[], tailComplete = true): void {
    this.probe.renderRowsCalls++
    this.probe.renderRowsRendered += rows.length
    const blocks = rows.map((r) => r.block)
    // 一批只扫一次库：gutter 与块下行共用同一份定义/标签/选项表
    const derive = this.deriveOf()
    const gutters = gutterFieldsFor(blocks, this.ed.store.blocks, derive)
    const below = this.belowOf(blocks, derive)
    // 「这一屏只有一块」是整批的事实：在循环外算一次，别每行走一遍树
    const single = hasSingleLiveBlock(this.ed.doc)
    let sec: HTMLElement | null = null
    /** 给上一段收尾：追加那个空槽（只给有段根的行段） */
    const closeSec = (): void => {
      if (!sec || sec.dataset.sec === '' || sec.dataset.sec === undefined) return
      const slot = document.createElement('div')
      slot.className = 'sec-mount'
      // 它不是「可点空白建块」的地方：挂载区自己有点击语义，落到建块上就是静默多一个空块
      slot.dataset.noEmptyCreate = '1'
      /**
       * **编辑岛标记**（`.sec-mount` 与露面行的身体共用这一格）。
       *
       * 为什么需要一个标记而不是按类名判：本视图里有几处要回答「焦点现在是不是
       * **在别人的地盘**上」（`ownFocus`／`focusInMount`／`nestedEditorActive`）。
       * 按 `.sec-mount` 这个**类名**判，就等于「只有挂载区算别人的地盘」——
       * 露面行的身体（镜像／投影）同样嵌在本视图里、同样有自己的焦点，
       * 类名一换，那三处全部判错，而且是静默的：
       *   · `ownFocus` 判成「我在编辑」⇒ `restoreSel()` 把光标从里层抢回来；
       *   · `focusInMount` 判成「没有里层」⇒ 每次 store 变化都全量重排 ⇒
       *     里层正在打字的节点被换掉（`click` 不派发、光标跳走）。
       * ⇒ 判据是**标记**（「这一棵子树是另一个编辑宿主」），不是它属于哪一种容器。
       */
      slot.dataset.editIsland = '1'
      /**
       * ⚠️ **必须断开可编辑链**：`.sec-mount` 落在 `#editor`（一个 contenteditable 容器）里面，
       * 而挂载区里是**另一个编辑器实例**。可编辑元素嵌在可编辑元素里时，Chrome 把焦点交给
       * **外层的编辑宿主**（实测：对里层 `focus()` 之后 `activeElement` 仍是 `#editor`，
       * 打出来的字一个都不进模型）⇒ 里层编辑器根本收不到键盘。
       * ⇒ 槽本身不可编辑，里层那个 `contenteditable=true` 才成为独立的编辑岛。
       */
      slot.contentEditable = 'false'
      sec.appendChild(slot)
    }
    const groupHeads = this.ed.doc.groupHeads ?? []
    for (const r of rows) {
      if (r.depth === 0 || sec === null) {
        // 新的一段之前，先摆按列序应出现在这里的空天格子（复盘兜底；column 下 shells 恒空）
        if (r.depth === 0) {
          closeSec()
          for (const col of this.ed.shells) if (col.beforeRootId === r.block.id) this.ed.container.appendChild(this.makeShellSec(col))
          // 分段大纲的组头：插在这一组第一行之前（chrome，不是块——行的编辑语义一个字不变）。
          // 折叠的组没有自己的行可锚，锚到下一组的头一行 ⇒ 同一锚可以叠多颗头，按声明序插。
          for (const head of groupHeads) if (head.beforeRootId === r.block.id) this.ed.container.appendChild(this.makeGroupHead(head))
        }
        sec = document.createElement('div')
        sec.className = 'sec'
        sec.dataset.sec = r.depth === 0 ? r.block.id : ''
        this.ed.container.appendChild(sec)
      }
      const rowEl = this.makeBlockEl(r, gutters.get(r.block.id), below.get(r.block.id), single)
      sec.appendChild(rowEl)
      // 行表只收真行：占位节点没有 `data-block-id`（rebuildWith 随后会换回真行并登记）
      if (rowEl.dataset.blockId === r.block.id) this.ed.setRowEl(r.block.id, rowEl)
    }
    // 哨兵组头（`beforeRootId: ''`）：折叠组排在最后时，后面没有行可锚 ⇒ 落在文档末尾
    for (const head of groupHeads) if (head.beforeRootId === '') this.ed.container.appendChild(this.makeGroupHead(head))
    if (tailComplete) closeSec()
    // 比所有已装段都更早的空天格子：追加在最后
    if (this.ed.layout !== 'column') {
      for (const col of this.ed.shells) if (col.beforeRootId === null) this.ed.container.appendChild(this.makeShellSec(col))
    }
    // ⚠️ 实测高**不在这里记**：虚拟化路径必走 `applyWindow`（它在挂完头尾占位后量一次，
    //    那才是「整窗都在 DOM 里」的时刻）；非虚拟路径根本不用占位。在这里再量一遍
    //    等于每窗两次强制布局。
  }

  renderBlock(id: string): void {
    this.probe.renderBlockCalls++
    /**
     * 找块用 **store 的索引**（O(1)），不用 `locate(doc, id)`（全树 DFS）。
     * 行能不能写由 `blockEl` 守：没有 DOM 行就没有可换的东西。
     */
    const block = this.ed.store.find(id)
    const el = this.ed.blockEl(id)
    if (!block || !el) return
    /**
     * ⚠️ **组合期不重画这一行**（见 `deferWhileComposing`）。这一条比 `renderAll` 更容易踩到：
     *    属性写入（`writeProps` → `repaintBlock`）、改名传播（`renderRefSources`）、
     *    以及 `syncFromDom` 的收尾都会调到它，而它们**都不看组合期**。
     *    它换的是 `.tx` 所在的那一行 ⇒ 输入法正持有的文本节点被换掉，预编辑串当场落成正文。
     */
    if (this.ed.deferWhileComposing()) return
    // 先让行投影换代：rowOf 直接读上一代 rowIndex，属性写入让位后它仍报 hasChildren=true。
    this.ed.rows()
    const row = this.ed.rowOf(id) ?? {
      block,
      depth: depthOf(this.ed.doc, id),
      hidden: false,
      hasChildren: hasLiveChildren(block),
    }
    /**
     * 身体有无就是「这批子块归谁画」的开关：单行重画只能换这一行，翻开关时
     * 身体先挂上、旧子块行还在（反向则身体先没了、子块行还没回来）——两遍或缺一遍
     * 要等下一次整页重画才收口，肉眼就是闪一下。没有「只换一行」的答案，升级整页。
     */
    const hadBody = el.querySelector(':scope > .blk-view-body') !== null
    if (hasLiveChildren(block) && hadBody === row.hasChildren) {
      this.renderAll()
      return
    }
    // 单行重画也是「一批」：gutter 与块下行共用一份扫库结果
    const derive = this.deriveOf()
    this.ed.embeds.disposeRow(id)
    const nextEl = this.makeBlockEl(
      row,
      gutterFieldsFor([row.block], this.ed.store.blocks, derive).get(row.block.id),
      this.belowOf([row.block], derive).get(row.block.id),
      hasSingleLiveBlock(this.ed.doc),
    )
    el.replaceWith(nextEl)
    this.ed.setRowEl(id, nextEl)
    /**
     * 这一行的 DOM 刚被换掉：表里那个实测高是**换之前**的（改长／改短都算），
     * 现在量一次；量不到（不在窗口里）就删掉，退回估算。
     */
    this.forgetHeight(id)
    if (this.ed.virtualize) this.measureRows([id])
    this.repaintOverlays()
  }

  /**
   * @param gutter 这一行的 gutter 字段，**由调用方算好**：`block-dom` 是渲染层，没有森林；
   *               让它自己去扫一遍全库就等于「每画一行扫一次」。批量路径只扫一次库。
   */
  private makeBlockEl(
    r: VisibleRow,
    gutter: readonly GutterField[] | undefined,
    below: BelowFields | undefined,
    /** 「这一屏只有这一块」——**批级事实，由调用方算一次**（逐行 `flatten()` 会退化成 O(N²)） */
    single: boolean,
    /**
     * 这一行是不是**真挂进这一屏**：只有真挂载才记 `mounted`。
     * 离屏预量也用这个函数建行（同一套 CSS/父链），但它挂在文档外的临时容器里——
     * 记进来的话 `mounted` 会把窗口外的行报成已挂载（虚拟化断言与焦点还原都会读错）。
     */
    trackMounted = true,
  ): HTMLElement {
    // 同构重装：这一行有保留的旧行 ⇒ 直接用占位（rebuildWith 随后整棵换回）
    const placeholder = this.makePlaceholderFor?.(r)
    if (placeholder) return placeholder
    // 引用解析走**共享 store** 的森林：引用目标可能在当前视图之外（另一页／另一天），
    // 只有整片森林能回答「它还在不在、现在叫什么」。
    const find = (id: string) => this.ed.store.find(id)
    /**
     * 同一行里同一目标可能出现多次：元信息按目标 id 缓存一次，避免重复读 FieldTable。
     * 缓存只活在这一行的构造里——模型一变就整行重画，不存在跨帧过期。
     */
    const refMetaCache = new Map<string, Pick<RefView, 'fields' | 'closure'> | undefined>()
    const refMeta = (id: string): Pick<RefView, 'fields' | 'closure'> | undefined => {
      if (!refMetaCache.has(id)) refMetaCache.set(id, this.refMetaOf(id))
      return refMetaCache.get(id)
    }
    const el = makeBlockEl(
      r,
      /**
       * **资产此刻的样子**：默认直接问 `view/asset-views.ts`（它是进程级的一份缓存，
       * 不是某个视图的状态）。事件表只留一个**覆盖**入口 —— 测试/独立实例可以把
       * 它换成受控答案。
       *
       * ⚠️ 为什么不能只靠 `events.assetView`：编辑器**在构造时**就渲染首帧，
       *    而 `events` 是构造之后才赋上去的。只认事件表 ⇒ 首帧一律画成
       *    `unavailable`，之后没有任何人再重画（那一行已经"画完了"）——
       *    表现为「重开之后图全是库不可用」，而库里明明有字节。
       */
      (tx) =>
        fillBlockText(
          tx,
          r.block,
          find,
          this.ed.events.assetView ?? assetViewOf,
          this.ed.events.onAssetError ?? markAssetMissing,
          refMeta,
        ),
      {
        single,
        ancestors: this.ancestors.get(r.block.id) ?? [],
        folded: foldStateOf(this.ed.doc),
        gutter,
        find,
        /**
         * **行尾引用数徽标**：读共享 store 的入向边表（索引查表，不是全库扫描），
         * 与浮层列表、引用栏抬头共用 `core/views/ref-sources.ts` 那一份聚合。
         * 放在构造渲染参数里而不是 `ViewEvents`：编辑器**构造时就画首帧**，
         * 事件表那时还没赋上（同 `assetView` 那条实测过的坑）。
         */
        refBadge: makeRefBadgeEl(r.block.id, refSourcesOf(this.ed.badgeSourcesOf(r.block.id))),
        // 行尾标签 chips 拖拽重排：写回走同一份 reorderTags（只许换序，一笔撤销）
        onReorderTags: (blockId, orderedIds) => {
          void this.ed.reorderTags(blockId, orderedIds)
        },
        // 只有装载根会带上下文：子行的位置已经由缩进表达。装载声明 paths=false 时只关这一格的显示
        context: r.depth === 0 && this.ed.doc.paths !== false ? this.ed.doc.contexts?.get(r.block.id) : undefined,
        // 来源说明与面包屑同一格：都在说明「这一行为什么在这一屏里」
        note: r.depth === 0 ? this.ed.doc.rootNotes?.get(r.block.id) : undefined,
        // 备注根说明「在评论谁」；这一屏已经说明了宿主时（备注栏／浮窗）Doc 关掉它
        noteSource: this.noteSourceOf(r.block, r.depth),
        // 展开出来的根才有「收起上下文」；没接回调就不画一个点了没反应的按钮
        contextBack: Boolean(this.ed.onContextBack) && r.depth === 0 && (this.ed.doc.expandedRoots?.has(r.block.id) ?? false),
        // 露面块的身体：这一层只认「有没有展开」；画什么由装配层给（见 `ViewEvents.embedBody`）
        embedBody: (b, into) => this.ed.embeds.attach(b, into),
        ...(this.ed.emptyPlaceholder !== undefined ? { placeholder: this.ed.emptyPlaceholder } : {}),
        /**
         * **正文里的查询体**：只有装配层接了画法、且这一份装载允许展开时才给。
         * 「哪一行画」由 `block-dom` 的 `rowHasInlineViewBody` 判（按源分派，
         * 段根同此——聚焦后身体仍贴着自己那一行，不再让位段尾宿主）。
         */
        ...(this.ed.events.viewBody || this.ed.events.automationBody || this.ed.events.defBody
          ? {
              viewBody: (b: Block, into: HTMLElement) => this.ed.embeds.attachViewBody(b, into),
              automationBody: (b: Block, into: HTMLElement) => this.ed.embeds.attachAutomationBody(b, into),
              defBody: (b: Block, into: HTMLElement) => this.ed.embeds.attachDefBody(b, into),
            }
          : {}),
        // 块下属性行：值文本与点击都在装配层；`view` 只给位置与定高
        ...(below && this.ed.events.propsLine
          ? {
              below,
              propsLine: (b: Block, data: BelowFields, into: HTMLElement) => this.ed.events.propsLine!(b, data, into),
            }
          : {}),
      },
    )
    if (trackMounted) this.mounted.add(r.block.id)
    // 行的派生物都是构造期写死的：盖章记下「画这行时的模型修订号」，保留行快路
    // （`holdRows`）据此判断「这行画下之后模型动过没有」——动过就整体退回全量重建。
    el.dataset.rev = String(this.ed.store.revision)
    return el
  }

  /** 行元素被换过 ⇒ `data-caret` 跟着旧元素丢了：缓存作废，光标标记与块选区漆层重打 */
  private repaintOverlays(): void {
    this.caretMarks = ''
    this.markCaret()
    this.ed.bsel.paintBlockSel()
  }

  /** 供协作对象（块选区）在收掉模型选区时同步重打光标标记 */
  markCaret(): void {
    const id = this.ed.sel?.aBlock ?? ''
    if (id === this.caretMarks) return
    this.caretMarks = id
    for (const el of Array.from(this.ed.container.querySelectorAll<HTMLElement>('.blk'))) {
      if (el.dataset.blockId === id) el.dataset.caret = '1'
      else delete el.dataset.caret
    }
  }

  /* ----------------------------------------------- 备注区间的常显标记 */

  /**
   * 被备注的区间在宿主正文里常显一层淡底（「这里有备注」的背景事实）。
   * 画的是**有活备注指向**的 anno：孤儿锚（备注删了）不画——读侧判活，
   * 删除路径零钩子，撤销也干净（删备注只删块，锚原样留着等备注回来）。
   *
   * 画笔与命中高亮同一机制（Custom Highlight，纯渲染层——往 `.tx` 里插标记
   * 会被 `readRuns` 当成内容，还会挪光标），底色淡一档（`--ui-anno-bg`）。
   */
  private paintAnnoMarks(): void {
    const idx = this.ed.store.index
    /**
     * **全库没有区间锚 ⇒ 不扫 doc、不查 DOM**。备注是少数派功能，绝大多数文档
     * 一个 anno 都没有；从前每次写都走整棵树＋一次全容器 `querySelectorAll`，
     * 等于给「没用到备注」的用户每帧付两笔 O(n)。
     */
    if (idx.annos.size === 0) {
      if (this.annoSpans.size > 0) {
        this.annoSpans = new Map()
        clearHits(this.annoKey)
      }
      return
    }
    const blocks = new Map<string, AnnoHitSpan[]>()
    walkForest(this.ed.doc.roots, (b) => {
      if (!b.annos || b.annos.length === 0) return
      const live = new Set<string>()
      for (const e of idx.relations.get(b.id) ?? []) {
        if (e.kind === 'annotates' && e.propId) live.add(e.propId)
      }
      if (live.size === 0) return
      const spans = b.annos
        .filter((a) => live.has(a.id))
        .map((a) => ({ annoId: a.id, ...a.range }))
      if (spans.length > 0) blocks.set(b.id, spans)
    })
    // 画层与命中判定同一份区间（hover tip 读它）——同帧同源，不会漂
    this.annoSpans = blocks
    paintHits(this.ed.container, blocks, this.annoKey, '--ui-anno-bg')
  }

  /**
   * hover 命中那一段的加深画笔（「这段可以点」的确认反馈）。
   * 常显层与 hot 层分 key 分 token：两档样式靠两把 highlight 叠出来。
   */
  paintAnnoHot(hit: { blockId: string; annoId: string } | null): void {
    if (!hit) {
      clearHits(this.annoHotKey)
      return
    }
    const anno = this.ed.store.find(hit.blockId)?.annos?.find((a) => a.id === hit.annoId)
    const blk = this.ed.container.querySelector<HTMLElement>(`.blk[data-block-id="${hit.blockId}"]`)
    const tx = blk?.querySelector<HTMLElement>(':scope > .tx')
    if (!anno || !tx) {
      clearHits(this.annoHotKey)
      return
    }
    const r = rangeAtSpan(tx, anno.range)
    if (!r) {
      clearHits(this.annoHotKey)
      return
    }
    paintHits(this.ed.container, new Map([[hit.blockId, [anno.range]]]), this.annoHotKey, '--ui-anno-bg-hot')
  }

  /** 被备注区间的 tip 文本：备注块的正文投影（多条换行平铺） */
  annoNoteText(blockId: string, annoId: string): string {
    const notes: string[] = []
    for (const e of this.ed.store.index.relations.get(blockId) ?? []) {
      if (e.kind !== 'annotates' || e.propId !== annoId) continue
      const note = this.ed.store.find(e.from)
      if (note) notes.push(plainText(note.content))
    }
    return notes.join('\n')
  }

  /** 被备注区间的屏幕矩形（浮窗定锚用；区间不在这一屏 ⇒ null——浮层锚函数返回 null 即自动关） */
  annoRect(blockId: string, annoId: string): DOMRect | null {
    // 直接从块数据取区间：刚创建时画层缓存（rAF）还没建，不能依赖 annoSpans
    const anno = this.ed.store.find(blockId)?.annos?.find((a) => a.id === annoId)
    if (!anno) return null
    const blk = this.ed.container.querySelector<HTMLElement>(`.blk[data-block-id="${blockId}"]`)
    const tx = blk?.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return null
    return rangeAtSpan(tx, anno.range)?.getBoundingClientRect() ?? null
  }

  /** ⌥-click 命中判定：坐标 → 被备注的（块，锚）。与 hover 同一份缓存，与画层同源 */
  annoHitAt(x: number, y: number): { blockId: string; annoId: string } | null {
    if (this.annoSpans.size === 0) return null
    const el = document.elementFromPoint(x, y)
    const blk = el?.closest<HTMLElement>('.blk')
    const blockId = blk?.dataset?.['blockId']
    if (!blk || !blockId || !this.ed.container.contains(blk)) return null
    const tx = blk.querySelector<HTMLElement>(':scope > .tx')
    if (!tx) return null
    const offset = offsetAtPoint(tx, x, y)
    if (offset === null) return null
    const span = spanAt(this.annoSpans.get(blockId) ?? [], offset)
    return span ? { blockId, annoId: span.annoId } : null
  }

  /** 重画排进下一帧（合并同一帧里的多笔写）；组合期不画（DOM 还没落定） */
  scheduleAnnoPaint(): void {
    if (this.annoPaintQueued || typeof requestAnimationFrame === 'undefined') return
    this.annoPaintQueued = true
    requestAnimationFrame(() => {
      this.annoPaintQueued = false
      if (this.ed.deferWhileComposing()) return
      this.paintAnnoMarks()
    })
  }

  /** 当前窗口盖住的行区间（`renderAll` 的非虚拟路径是整段） */
  private winFrom = 0
  private winTo = 0

  /**
   * **一行占多高**（窗口占位与视口定位共用这一份）。
   *
   * 两处必须同源：占位高度用哪套估法，按滚动位置反查行号就得用同一套——否则
   * 「拖滚动条跨过一整窗」之后换窗会跳几行。所以把原先在 `applyWindow` 里的局部
   * 闭包提出来，两边都调它。
   */
  private rowHeight(r: VisibleRow, below: Map<string, BelowFields> | undefined): number {
    const propsRows = (id: string, data: BelowFields | undefined): number => {
      if (!this.ed.events.propsLine || !this.ed.events.propsRows || !data) return 0
      return this.ed.events.propsRows(id, data)
    }
    /**
     * **量到过就用实测**（见 `height-cache.ts`）：折行正文让估高系统性偏小，
     * 而这一行挂载过就说明它的真实高已知——没有理由再猜。
     * 实测值是**整行高**（头／属性行／折行都已包含），所以直接返回，不再叠加。
     */
    return this.heights.heightOf(r.block.id, () =>
      visibleRowHeight(
      r.block,
      this.extraHeads(r),
      (Boolean(this.ed.events.viewBody || this.ed.events.automationBody || this.ed.events.defBody) &&
        rowHasInlineViewBody(r) &&
        !isFolded(this.ed.doc, r.block.id)) ||
        (Boolean(this.ed.events.embedBody) &&
          rowHasEmbedViewBody(r.block, (id) => this.ed.store.find(id)) &&
          !isFolded(this.ed.doc, r.block.id)),
      // 行数由装配层给（密度档 ＋ 单块展开）；没有这一格 ⇒ 不画属性区
      propsRows(r.block.id, below?.get(r.block.id)),
      ),
    )
  }

  /** 这一行是不是已经贴着窗口边（虚拟化的滚动联动据此决定换不换窗） */
  needsRecenter(blockId: string, slack: number): boolean {
    // 行下标查表（O(1)）：滚动事件里每次都问，`rows().findIndex` 是 O(全量行)
    const i = this.ed.rowPosition(blockId)
    if (i === undefined) return false
    return i < this.winFrom + slack || i >= this.winTo - slack
  }

  /**
   * **视口顶部那一行**（换窗的锚）。
   *
   * 已挂载的行按**真实几何**找；视口落进占位区（拖滚动条一气跨过一整窗）时，按与占位
   * 高度**同一份** `rowHeight` 从上往下累加——两边同源，所以定位与占位不会打架。
   */
  topRowId(): string | null {
    const rows = this.ed.rows()
    this.probe.topRowCalls++
    if (rows.length === 0) return null
    const area = this.ed.blankArea
    const box = area.getBoundingClientRect()
    /**
     * 只扫**已挂载的窗口**：窗口外的行没有 DOM，`blockEl` 对每一行都是一次
     * 全容器选择器查询——旧写法在滚动事件里对全量行做这件事，是滚动路径上的 O(N)。
     * 非虚拟化时 `winFrom/winTo` 覆盖全量，行为与原来一致。
     */
    const from = Math.max(0, Math.min(this.winFrom, rows.length))
    const to = Math.max(from, Math.min(this.winTo, rows.length))
    this.probe.topRowRows += to - from
    for (let i = from; i < to; i++) {
      const r = rows[i]!
      const el = this.ed.blockEl(r.block.id)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      /**
       * 只认**与视口相交**的行：只判「底边在视口顶之下」会把一整段挂在视口外的行
       * 也算成顶部那一行（滚动一步跨过整窗时正中这一枪）。
       */
      if (rect.bottom > box.top && rect.top < box.bottom) return r.block.id
    }
    // 视口落进占位区：按同一份前缀索引反查行下标（O(log N)），不再从上往下累加
    this.probe.topRowFallbacks++
    const y = box.top - this.ed.container.getBoundingClientRect().top
    const heights = this.ensureHeightIndex()
    return rows[heights.index.find(y)]?.block.id ?? rows[rows.length - 1]?.block.id ?? null
  }

  /** 窗口化挂载：只挂「光标所在行 ± radius」（**以可见行计**，折叠的子树本来就不在窗口里） */
  applyWindow(centerId?: string): void {
    /**
     * ⚠️ **组合期不重算窗口**（见 `deferWhileComposing`）。
     *    这条不是可有可无的：`applyWindow` 会 `container.textContent = ''` 再按窗口重新挂，
     *    承载块因此换成**另一个元素**（即使 `virtualize=false`，判据 `before === after` 为假）——
     *    那一下就把输入法的组合锚点摘掉了。
     */
    if (this.ed.deferWhileComposing()) return
    const t0 = performance.now()
    const rows = this.ed.rows()
    this.probe.applyWindowCalls++
    const cid = centerId ?? this.ed.sel?.aBlock ?? rows[0]?.block.id
    // 行下标走行位置表（O(1)），不再每次换窗把可见行扫一遍找中心
    let ci = cid !== undefined ? (this.ed.rowPosition(cid) ?? 0) : 0
    if (ci < 0 || ci >= rows.length) ci = 0
    const from = Math.max(0, ci - this.ed.radius)
    const to = Math.min(rows.length, ci + this.ed.radius + 1)
    // 这一笔真正处理的行数：窗口切片（头/尾只是 O(log N) 前缀查询，不按行算）
    this.probe.applyWindowRows += to - from
    this.ed.embeds.disposeAll()
    this.ed.container.textContent = ''
    this.ed.resetRowEls()
    this.mounted.clear()
    // ⚠️ 祖先表对**全量** rows 算（上面已经拿到的就是全量可见行），
    //    不对下面 slice 重建 —— 否则窗口第一行的祖先全丢。
    this.rebuildAncestors()
    // 占位高度按**实际行高**累加：带别名头的行是两行，按 LINE_H 算会让长文档的
    // 滚动条与落点系统性偏小（越靠后偏得越多）。
    /**
     * 这一行在窗口外的占位高度。
     *
     * 「有没有视图体」有两种：正文里查询块的行内体（折叠时不算身体），
     * 与**露面块里的投影**（源的结果视图）。两者高度都来自 `VIEW_BODY_H` ——
     * 少算一处，带这种行的文档滚动条就系统性偏小。
     */
    /**
     * 头/尾占位的高度来自**前缀索引**：建表是一次性的（见 `ensureHeightIndex`），
     * 换窗本身只付 O(log N) 的前缀查询——不再对全量行 `slice().reduce()`。
     */
    const heights = this.ensureHeightIndex()
    const headH = heights.index.prefix(from)
    const tailH = heights.index.total - heights.index.prefix(to)
    /** 换窗判据要读「现在窗口盖住哪一段」 */
    this.winFrom = from
    this.winTo = to
    let headEl: HTMLElement | null = null
    let tailEl: HTMLElement | null = null
    if (from > 0) {
      headEl = this.placeholder(from, 'head', headH)
      this.ed.container.appendChild(headEl)
    }
    this.renderRows(rows.slice(from, to), to >= rows.length)
    if (to < rows.length) {
      tailEl = this.placeholder(rows.length - to, 'tail', tailH)
      this.ed.container.appendChild(tailEl)
    }
    /**
     * **挂完立刻记实测高**：这一窗的行现在都在 DOM 里，量得到真高。
     * 下一次换窗时它们落到占位区，`rowHeight` 就会读到实测值而不是估算
     * （见 `height-cache.ts`）。
     */
    this.measureRows(this.mounted)
    /**
     * ⚠️ **首窗的占位必须在这一步之后重算**：占位是在 `renderRows` 之前算的，
     *    那时这一窗的行还没量过 ⇒ 头尾占位用的是纯估算。不补这一步，
     *    「第一次打开长文档」看到的仍是偏小的总高，得滚一次才自愈
     *    （探针第一次复验就是这么被骗过去的：修了却读数不变）。
     *    重算很便宜——只是把已经算过的和重写一遍，不碰 DOM 结构。
     */
    if (headEl || tailEl) {
      // 窗口内的实测已经回填进索引（`measureRows` 的点更新），这里只重查前缀
      if (headEl) headEl.style.height = `${heights.index.prefix(from)}px`
      if (tailEl) tailEl.style.height = `${heights.index.total - heights.index.prefix(to)}px`
    }
    /**
     * **窗口外的行排队离屏量**：量完 `rowHeight` 就有真值，占位随之变准
     * （见 `scheduleOffscreenMeasure`）。这里只排队，不阻塞这一帧。
     */
    this.scheduleOffscreenMeasure()
    this.repaintOverlays()
    this.ed.events.mounted?.()
    this.probe.applyWindowMs += performance.now() - t0
  }

  /** 这一行除正文外还占几条「整行头」（面包屑／别名头／来源说明的高度由 block-dom 统一算） */
  private extraHeads(r: VisibleRow): number {
    if (r.depth !== 0) return 0
    // 与渲染同一份门：关掉路径的装载不再为它留一行（虚拟化占位高度跟着缩）
    const hasTrail = this.ed.doc.paths !== false && (this.ed.doc.contexts?.get(r.block.id)?.length ?? 0) > 0
    const hasBack = Boolean(this.ed.onContextBack) && (this.ed.doc.expandedRoots?.has(r.block.id) ?? false)
    // 来源说明与面包屑同住 `.blk-context` 那一行：都在时仍是**一条**头，不是两条
    const hasNote = (this.ed.doc.rootNotes?.get(r.block.id) ?? '') !== ''
    // 备注来源与它们同一个槽：有它也一样只多一条头
    const hasSource = this.noteSourceOf(r.block, r.depth) !== undefined
    return hasTrail || hasBack || hasNote || hasSource ? 1 : 0
  }

  /**
   * 备注根的来源格：`Doc.noteSource === false` 的屏（备注栏／浮窗）已经说明了宿主，
   * 不再重复；其余装载（中心／页签／侧栏／查询列）都带着来路。
   *
   * 每次渲染现算（与行尾引用徽标同一条口径）：它是块上的事实派生出来的，
   * 宿主或锚一删、下一次重画就该变样，没有第二份缓存要失效。
   */
  private noteSourceOf(b: Block, depth: number): NoteSourceCell[] | undefined {
    if (depth !== 0 || this.ed.doc.noteSource === false) return undefined
    const cells = noteSourceCellsOf(b, this.ed.store.index)
    return cells.length > 0 ? cells : undefined
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


  /** 宿主 dispose 时调：摘掉本实例的两把画笔、清命中缓存（游离容器不再被重画） */
  disposeAnnoPaint(): void {
    this.annoSpans = new Map()
    clearHits(this.annoKey)
    clearHits(this.annoHotKey)
  }
}
