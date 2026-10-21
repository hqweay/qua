/**
 * 视图层 —— **单一 contenteditable 容器 ＋ 块级 DOM** 的形状：单一 contenteditable 容器 ＋ **块级 DOM**（扁平 ＋ `data-depth`），
 * 行内原子用 `contenteditable=false`；没有被编辑的块不额外套 contenteditable。
 *
 * 两条实测逼出来的结论在此继续成立（不许破坏）：
 *  1. **缩进不用 DOM 层级，用扁平 ＋ data-depth ＋ padding**（DOM 层级与窗口化虚拟化互相打架）；
 *  2. **组合期（IME composing）不重渲染该块**，只改模型，`compositionend` 后再补渲染。
 *
 * demo 新增（都建立在**同一套区间锚点**上，没有引入 run 属性）：
 *  - 行内原子（引用 chip／图片占位）＝ 长度 1 的区间锚点，随文本编辑走 `mapAtoms`；
 *  - 折叠（`collapsed` 子树不挂 DOM）、待办复选框、悬停左侧 gutter（折叠箭头／圆点／拖拽把手）；
 *  - 拖拽重排（HTML5 DnD，before/after/inside 三区）；
 *  - 键盘**一个都不在这里处理**——全部交给绑定表。
 */
import {
  ATOM_PLACEHOLDER,
  BlockStore,
  CommandLog,
  UndoStack,
  ancestorsByBlockId,
  cloneSubtree,
  depthOf,
  diffText,
  flatten,
  indentBlock,
  insertFirstChild,
  insertSiblingAfter,
  enterKind,
  locate,
  deleteBlockSpan,
  mapAtoms,
  mapMarks,
  mergeIntoPrev,
  mkBlock,
  moveBlockTo,
  moveSibling,
  normSel,
  normalizeMarks,
  outdentBlock,
  pruneToText,
  edgeSourceIds,
  remapAnchors,
  removeMarkRange,
  selToTextRanges,
  splitBlockBefore,
  splitBlockIntoFirstChild,
  toggleChildrenCollapsed,
  toggleCollapsed,
  toggleMark as coreToggleMark,
  visibleRows,
  mkAtom,
  type Atom,
  type AtomKind,
  type Block,
  type CtxKeys,
  type Doc,
  type Mark,
  type MarkType,
  type Sel,
  type Snap,
  type TodoState,
  type UndoKind,
  type VisibleRow,
  trailingHashTag,
} from '../core/index.ts'
// 用户可见文案一律走 t
import { t } from '../core/msg.ts'
import { LINE_H, fillBlockText, isReadonlyBlock, makeBlockEl } from './block-dom.ts'
import { blockIdOf, offsetIn, readBlockText } from './dom-text.ts'
import { bindEditorEvents, type AtomClickMods } from './editor-events.ts'

export interface Probe {
  isComposing: boolean
  compositionSeq: string[]
  lastKey: { key: string; isComposing: boolean; trusted: boolean } | null
  lastCommand: { name: string; at: number; via: string } | null
  /** 按键命中追踪（59 ）：这个键命中了哪条规则 / 为什么没命中 */
  keyTrace: { key: string; hit: string; when: string; ok: boolean }[]
  traced: boolean
}

export interface ViewOpts {
  container: HTMLElement
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
  marks?: Mark[]
  atoms?: Atom[]
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
   * **正文里敲出 `#名字`** 时的成边出口（装配层注入）。
   *
   * 为什么是注入而不是编辑器自己建标签块：`ensureTag` 会**写森林**，而森林由装配层持有
   *   —— 编辑器不该知道它存在（承「命令不碰模型持有者」那条纪律）。
   * 注入后与 `insert-tag` 命令共用同一个函数 ⇒ 不产生第二套 `#` 解析。
   */
  onHashTag?: (name: string, blockId: string, from: number, to: number) => void
}

export interface ViewEvents {
  /** 任何模型变化（持久化 + 角标刷新） */
  change?: (kind: 'text' | 'struct' | 'mark' | 'atom' | 'load') => void
  /** 原子被吃掉（不静默） */
  atomsLost?: (atoms: Atom[]) => void
  /** 输入 `/` 且光标在查询词尾部 */
  slashQuery?: (q: string | null, rect: DOMRect) => void
  /** 点行内原子（`mods` 是修饰键：左键打开目标，⌥ 才看详情） */
  atomClick?: (atom: Atom, el: HTMLElement, mods: AtomClickMods) => void
  /** 悬停把手/圆点或右键 → 块菜单 */
  blockMenu?: (blockId: string, rect: DOMRect) => void
  /**
   * **左键点块标**：聚焦/zoom 到这个块。
   * 装配层把它接到 `core.block/focus-block`（面包屑那一格是同一个命令）。
   */
  focusBlock?: (blockId: string) => void
  /**
   * **Shift+左键点块标**：把这个块钉到右槽（已钉住则取消）。
   *
   * 单独一个回调而不是在事件层看 `shiftKey` 调 `focusBlock`：事件层不该知道
   * 「右槽」与「钉住」这层语义，它只负责把修饰键翻译成另一个动作。
   */
  openInDock?: (blockId: string) => void
  /**
   * 模型选区变了（**划选气泡的驱动**，2026-10-19）。
   * 只有这里知道「选区到底变了没有」——气泡不能靠猜，否则每次按键都会重建 DOM。
   */
  selChange?: () => void
  /** 重新挂载窗口后（虚拟化） */
  mounted?: () => void
}

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

  /** 共享数组：所有视图看到同一份 marks/atoms；赋值原地替换，由 `emitChange` 统一通知 */
  get marks(): Mark[] {
    return this.store.marks
  }
  set marks(next: Mark[]) {
    this.store.marks.splice(0, this.store.marks.length, ...next)
  }
  get atoms(): Atom[] {
    return this.store.atoms
  }
  set atoms(next: Atom[]) {
    this.store.atoms.splice(0, this.store.atoms.length, ...next)
  }
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
  /** 「点空白建块」的监听面：比 container 大一圈，见 `ViewOpts.blankArea` */
  blankArea: HTMLElement
  private allowBlankCreate: boolean
  private allowRootRemove: boolean
  /** 敲出 `#名字` 的成边出口（装配层注入 ⇒ 编辑器不碰森林） */
  private readonly onHashTag?: (name: string, blockId: string, from: number, to: number) => void
  /** store 订阅与事件绑定的卸载函数（`dispose` 用；视图被移除后不该继续收通知） */
  private readonly offStore: () => void
  private readonly unbind: () => void

  constructor(o: ViewOpts) {
    this.container = o.container
    this.blankArea = o.blankArea ?? o.container
    this.allowBlankCreate = o.allowBlankCreate !== false
    this.allowRootRemove = o.allowRootRemove !== false
    this.onHashTag = o.onHashTag
    this.doc = o.doc
    /**
     * **冷启动也必须有 root id**。
     *
     * 冷启动走的是构造参数（`doc: { roots: bootRoots }`），不经过 `loadPage()`；
     * 空 id 列表会让第一次 `reloadFromStore()`（undo 或别的视图 `touch`）把
     * `doc.roots` 重载成空 ——正文看起来被清空了，而块其实还在 store 里。
     */
    this.viewRootIds = o.doc.roots.map((b) => b.id)
    this.store = o.store ?? new BlockStore(o.doc.roots, o.marks ?? [], o.atoms ?? [])
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
    this.doc = { roots }
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

  renderAll(): void {
    this.container.textContent = ''
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    if (!this.virtualize) {
      for (const r of this.rows()) this.container.appendChild(this.makeBlockEl(r))
    } else {
      this.applyWindow()
      return
    }
    this.markCaret()
    this.paintBlockSel()
    this.events.mounted?.()
  }

  /** 所有模型变化统一出口：通知其他视图（共享 store），再通知装配层持久化/刷新 */
  /**
   * @param ids 这次**动过哪些块**（可选）。查询视图靠它判断「结果里的块变没变」，
   *            而不是靠「store 被碰过几次」——后者会把刷新顺带的重渲染也算成过期。
   *            ⚠️ 只给拿得到精确 id 的路径传（文本编辑、todo、删除）；结构操作先不传，
   *            订阅方必须容忍 `ids === undefined`（那就是「不知道，按整体处理」）。
   */
  private emitChange(kind: 'text' | 'struct' | 'mark' | 'atom' | 'load', ids?: readonly string[]): void {
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
    el.replaceWith(this.makeBlockEl(row))
    // 被换掉的那个元素带着 `data-caret` ⇒ 缓存与标记都要重来
    this.caretMarks = ''
    this.markCaret()
    this.paintBlockSel()
  }

  private makeBlockEl(r: VisibleRow): HTMLElement {
    // 引用解析走**共享 store** 的森林：引用目标可能在当前视图之外（另一页／另一天），
    // 只有整片森林能回答「它还在不在、现在叫什么」。
    const el = makeBlockEl(r, (tx) => fillBlockText(tx, r.block, this.marks, this.atoms, (id) => this.store.find(id)), {
      single: flatten(this.doc).length === 1,
      ancestors: this.ancestors.get(r.block.id) ?? [],
    })
    this.mounted.add(r.block.id)
    return el
  }

  /* ------------------------------------------------------- DOM → 文本 */

  offsetIn(root: HTMLElement, node: Node, off: number): number {
    return offsetIn(root, node, off)
  }

  /** 读回块文本（原子 → U+FFFC）；委托 `view/dom-text` */
  readText(id: string): string {
    const tx = this.txEl(id)
    if (!tx) return locate(this.doc, id)?.block.text ?? ''
    return readBlockText(tx)
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
    const s = this.readSel()
    if (!s) return
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
    const walk = (n: Node): void => {
      if (done) return
      if (n.nodeType === Node.TEXT_NODE) {
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
      target.off = tx.childNodes.length
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
   * 第 1 期仍不支持（承 63 的块集合选区，属后续内核工作）；这里只负责「选得上」。
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
    if (
      this.sel &&
      this.sel.aBlock === first.id &&
      this.sel.aOff === 0 &&
      this.sel.hBlock === last.id &&
      this.sel.hOff === last.text.length &&
      this.blockSel === null
    ) {
      return this.selectAllBlocks()
    }
    const a = this.posAt(first.id, 0)
    const b = this.posAt(last.id, last.text.length)
    if (!a || !b) return false
    const r = document.createRange()
    r.setStart(a.node, a.off)
    r.setEnd(b.node, b.off)
    const s = document.getSelection()
    if (!s) return false
    s.removeAllRanges()
    s.addRange(r)
    this.sel = { aBlock: first.id, aOff: 0, hBlock: last.id, hOff: last.text.length }
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
    const off = Math.max(0, Math.min(s.aOff, loc.block.text.length))
    if (dir > 0 ? off !== loc.block.text.length : off !== 0) return false
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
    const prevIds = this.ownerIds()
    const flat = flatten(this.doc)
    const firstIdx = Math.min(...roots.map((b) => flat.findIndex((x) => x.id === b.id)))
    // 反向删：前面的 index 不会因后面的删除而漂移
    for (const b of [...roots].reverse()) {
      const loc = locate(this.doc, b.id)
      if (!loc || loc.parent === null) continue
      loc.parent.children.splice(loc.index, 1)
    }
    this.syncAnchors(prevIds)
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
    const walk = (b: Block, depth: number): void => {
      lines.push(`${'  '.repeat(depth)}${b.text}`)
      for (const c of b.children) walk(c, depth + 1)
    }
    for (const r of roots) walk(r, 0)
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
        if (target.node !== tx) return
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
      if (target.node === tx) target.off = tx.childNodes.length
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
    const prevIds = this.ownerIds()
    fn()
    this.undo.record(before, kind, Date.now())
    this.syncAnchors(prevIds)
    if (rerender === 'all') this.renderAll()
    else if (rerender === 'block' && caret) this.renderBlock(caret.aBlock)
    if (caret) this.placeCaret(caret.aBlock, caret.aOff)
    this.emitChange(kind === 'mark' ? 'mark' : kind === 'structural' ? 'struct' : 'text')
  }

  /**
   * **本编辑器负责哪些块**（用于决定「谁的锚点该被回收」）。
   *
   * ⚠️ 这是 2026-10-20 修掉「跨页锚点丢失」的关键：`marks`/`atoms` 是**库级平铺**的，
   *    而 `doc` 只是**当前容器的子树**（页／journal／zoom 后的 subtree）。
   *    用 `doc` 去裁剪库级锚点 ⇒ 别的页的锚点会被静默删掉（实机复现：删一块 ⇒ marks 24→7）。
   *    ⇒ 只有**本编辑器装载的那个子树里的块**才是它能判死的；容器之外的锚点它无权处置。
   */
  private ownerIds(): Set<string> {
    return new Set(flatten(this.doc).map((b) => b.id))
  }

  /** 结构性变更后：丢死锚点、裁剪越界、丢掉不再占 1 格的原子 */
  private syncAnchors(prevIds?: Set<string>): void {
    // 「删除块」会让某些块**消失**，所以判死范围要并上**变更前**的块集合。
    // ⚠️ 但仍**只限于本容器内的块**：容器外的锚点（别的页 / zoom 之外的祖先）原样保留。
    const owned = new Set([...(prevIds ?? []), ...this.ownerIds()])
    // ① 容器内的锚点：裁剪越界、去零长
    const inside = pruneToText(
      this.marks.filter((m) => owned.has(m.blockId)),
      this.doc,
    )
    // ② 容器外的锚点：本编辑器无权处置，原样带回
    this.marks = [...inside, ...this.marks.filter((m) => !owned.has(m.blockId))]

    const atomsInside = this.atoms.filter((a) => {
      if (!owned.has(a.blockId)) return true
      const b = locate(this.doc, a.blockId)
      return !b || b.block.text[a.start] === ATOM_PLACEHOLDER
    })
    this.atoms = atomsInside
  }

  undoStep(): void {
    const s = this.store.undo(this, this.sel)
    if (!s) return
    this.sel = JSON.parse(s.sel) as Sel | null
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  redoStep(): void {
    const s = this.store.redo(this, this.sel)
    if (!s) return
    this.sel = JSON.parse(s.sel) as Sel | null
    this.reloadFromStore(false)
    this.restoreSel()
    this.emitChange('struct')
  }

  /** 块内替换：模型 → 区间粘性映射 → 重渲染 */
  editBlock(id: string, from: number, to: number, insert: string, kind: 'insert' | 'delete' = 'insert'): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const old = loc.block.text
    loc.block.text = old.slice(0, from) + insert + old.slice(to)
    this.marks = mapMarks(this.marks, id, { from, to, insert })
    const r = mapAtoms(this.atoms, id, { from, to, insert })
    this.atoms = r.kept
    this.undo.record(before, kind, Date.now())
    this.renderBlock(id)
    if (r.lost.length) this.events.atomsLost?.(r.lost)
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
    // 被删掉的块带着自己的子树一起走 ⇒ 它们的锚点要一起回收
    const prevIds = this.ownerIds()
    this.syncAnchors(prevIds)
    this.undo.record(before, 'delete', Date.now())
    const loc = locate(this.doc, caretId)
    this.sel = loc ? { aBlock: caretId, aOff: r.startOff, hBlock: caretId, hOff: r.startOff } : null
    this.renderAll()
    this.placeCaret(caretId, Math.min(r.startOff, loc?.block.text.length ?? 0))
    this.emitChange('struct')
    return caretId
  }

  /**
   * 从 DOM 输入事件同步模型（真实键入路径）。
   *
   * 顺序：**先把文本同步进模型，再把 `#名字` 转成边**。
   * 反过来的话，占位符会被当成普通文本参与 diff，粘性映射就乱了。
   */
  syncFromDom(id: string, reRender: boolean): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const next = this.readText(id)
    if (next === loc.block.text) return
    const before = this.snap()
    const change = diffText(loc.block.text, next)
    loc.block.text = next
    this.marks = mapMarks(this.marks, id, change)
    const r = mapAtoms(this.atoms, id, change)
    this.atoms = r.kept
    const kind = change.to === change.from ? 'insert' : 'delete'
    this.undo.record(before, kind, Date.now())
    // 刚敲完的 `#名字` 已经闭合 ⇒ 落成一条边（接缝见 `linkHashTags`）
    const linked = this.linkHashTags(id)
    if (reRender || linked) {
      const caret = this.sel ? this.sel.aOff : null
      this.renderBlock(id)
      if (caret !== null) this.placeCaret(id, Math.min(caret, loc.block.text.length))
      // **改名传播**：这一块可能是别处引用的目标 ⇒ 引用它的那些块也要重画（显示名现算）。
      // 改动只影响「指向它的原子所在的块」，不是全视图重渲染。
      this.renderRefSources(id)
    }
    if (r.lost.length) this.events.atomsLost?.(r.lost)
    // 文本改了哪一块是已知的：带上 id，查询视图据此判断「结果里的内容变没变」
    this.emitChange('text', [id])
  }

  /**
   * **把刚敲完的 `#名字` 落成一条指向标签块的边**。
   *
   * 触发时机：**标签闭合之后**（后面跟了分隔符，或已经到行尾）。
   * 一边敲一边成边的话，`#` 刚落下就弹出一个 chip，手感会被破坏。
   *
   * ⚠️ **组合期绝不动手**：IME 预编辑期间的文本是临时的，
   *    此刻成边会把半截拼音变成标签（且直接打断输入）。
   *
   * ⚠️ 与 `insert-tag` 命令共用 `ensureTag` ⇒ 只有一处认 `#名字`，不会分叉成两套解析。
   *
   * @returns 有没有成边（true ⇒ 调用方要重画这一块）
   */
  private linkHashTags(id: string): boolean {
    if (this.probe.isComposing || !this.onHashTag) return false
    const loc = locate(this.doc, id)
    if (!loc) return false
    /**
     * 只认**行尾**那个已闭合的 `#名字`。
     *
     * 为什么不扫全行、把 `#xxx` 一次性全转掉：那会把「用户想写字面量 `#1`」
 *    变成一次不可撤销的模型改动；退格回去再打一遍还会重复触发。
 *    ⇒ 只在**刚写完的那一个**上成边：行为可预测，撤销也干净。
     */
    const hit = trailingHashTag(loc.block.text)
    if (!hit) return false
    this.onHashTag(hit.name, id, hit.from, hit.to)
    return true
  }

  /**
   * **重画「引用了 `id` 这一块」的那些块**。
   *
   * 为什么需要显式做：引用显示的是**目标当前的名字**（`core/ref.ts`），是派生的；
   * 目标改名后，`atom`/`block` 本身一个字节都没变 ⇒ 没有任何「数据变了」的信号能触发重渲染。
   *
   * ⚠️ 只重画**本视图内**的块：别的页里也有指向它的引用，但那些 DOM 不在 `doc` 里，
   *    由它们自己所在的视图在装载/刷新时解析（共享 store 只保证数据一致，不替别人画 DOM）。
   */
  private renderRefSources(id: string): void {
    const mine = new Set(flatten(this.doc).map((b) => b.id))
    // ⚠️ 用 `edgeSourceIds` 而不是 `refSourceIds`：标签也是指向边，
    //    改标签块的名字 ⇒ 显示 `#旧名` 的那些块同样要重画。
    for (const srcId of edgeSourceIds(this.atoms, id)) {
      if (!mine.has(srcId) || srcId === id) continue
      if (this.blockEl(srcId)) this.renderBlock(srcId)
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
   *    · **有角色的根**（页/日记/收藏）或块首 / 空块 / 块尾 ⇒ 插一个**空的首个子块**
   *      （根文本是名字/投影，不拆，避免静默改名）。
   */
  split(id: string, offset: number): void {
    const before = this.snap()
    const loc = locate(this.doc, id)
    if (!loc) return

    // 段根 = `doc.roots` 里的一项（loc.parent 为 null）；不是「只有 roots[0]」。
    const isSectionRoot = loc.parent === null

    /**
     * **：同块选区 + Enter = 先删选区，再在选区起点拆**。
     *
     * 只做**无角色的普通内容块**；跨块选区、页/日记/收藏根仍留旧行为
     * （跨块属结构编辑，与 63 冲突；页名是身份）。
     * 删除 + 拆分共用同一个 `before` 快照 ⇒ 一次撤销复原。
     */
    let forcedSplit = false
    const sel = this.sel
    if (
      !isSectionRoot &&
      (loc.block.roles?.length ?? 0) === 0 &&
      sel &&
      sel.aBlock === id &&
      sel.hBlock === id &&
      sel.aOff !== sel.hOff
    ) {
      const from = Math.min(sel.aOff, sel.hOff)
      const to = Math.max(sel.aOff, sel.hOff)
      const old = loc.block.text
      loc.block.text = old.slice(0, from) + old.slice(to)
      const change = { from, to, insert: '' }
      this.marks = mapMarks(this.marks, id, change)
      const r = mapAtoms(this.atoms, id, change)
      this.atoms = r.kept
      if (r.lost.length) this.events.atomsLost?.(r.lost)
      offset = from
      forcedSplit = true
    }

    if (isSectionRoot) {
      /**
       * **段根没有兄弟位**（写回按 root id 走）⇒ 退化成「右半成首个子块」：
       *   · **无角色的内容根**（focus/zoom 进来的普通块）＋ 文本**中间**
       *     ⇒ 左半留在根里、右半成**首个子块**，光标到子块；
       *   · **有角色的根**（页/日记/收藏）或块首 / 空块 / 块尾
       *     ⇒ 插一个**空的首个子块**（根文本是名字/投影，不拆，避免静默改名）。
       */
      const canSplitRoot = (loc.block.roles?.length ?? 0) === 0
      if (canSplitRoot && offset > 0 && offset < loc.block.text.length) {
        const r = splitBlockIntoFirstChild(this.doc, id, offset)
        if (r) {
          // 右半的锚点跟子块走（块内偏移前移）；左半留在根上
          const moved = <T extends { blockId: string; start: number; end: number }>(arr: readonly T[]): T[] =>
            arr.map((a) =>
              a.blockId !== id || a.start < offset
                ? a
                : { ...a, blockId: r.inserted, start: a.start - offset, end: a.end - offset },
            )
          this.marks = normalizeMarks(moved(this.marks))
          this.atoms = moved(this.atoms)
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
      // 空块 Enter ⇒ 反缩进：不建新块
      if (!outdentBlock(this.doc, id)) return
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      this.placeCaret(id, 0)
      this.emitChange('struct')
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

    // 块中 ⇒ 同级拆：左半进**上方新块**；原块保 id、右半、子树
    const r = splitBlockBefore(this.doc, id, offset)
    if (!r) return
    // 锚点归属：切点之前 ⇒ 左半（新块，偏移不变）；切点之后 ⇒ 原块（右半，偏移前移）
    const moved = <T extends { blockId: string; start: number; end: number }>(arr: readonly T[]): T[] =>
      arr.map((a) =>
        a.blockId !== id
          ? a
          : a.start < offset
            ? { ...a, blockId: r.inserted }
            : { ...a, start: a.start - offset, end: a.end - offset },
      )
    this.marks = normalizeMarks(moved(this.marks))
    this.atoms = moved(this.atoms)
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
    const r = mergeIntoPrev(this.doc, id)
    if (!r) return
    const shift = r.at
    const moved = <T extends { blockId: string; start: number; end: number }>(arr: readonly T[]): T[] =>
      arr.map((a) => (a.blockId === id ? { ...a, blockId: r.kept, start: a.start + shift, end: a.end + shift } : a))
    this.marks = normalizeMarks(moved(this.marks))
    this.atoms = moved(this.atoms)
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(r.kept, shift)
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
    if (all.findIndex((x) => x.id === s.aBlock) <= 0) return false
    this.mergeBack(s.aBlock)
    return true
  }

  indent(id: string): void {
    this.atomsPreservingTx('structural', () => indentBlock(this.doc, id))
  }

  outdent(id: string): void {
    this.atomsPreservingTx('structural', () => outdentBlock(this.doc, id))
  }

  move(id: string, delta: -1 | 1): void {
    this.atomsPreservingTx('structural', () => moveSibling(this.doc, id, delta))
  }

  private atomsPreservingTx(kind: UndoKind, fn: () => boolean): void {
    const before = this.snap()
    if (!fn()) return
    this.undo.record(before, kind, Date.now())
    this.renderAll()
    if (this.sel) this.placeCaret(this.sel.aBlock, this.sel.aOff)
    this.emitChange('struct')
  }

  duplicate(id: string): string | null {
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const { block, idMap } = cloneSubtree(loc.block)
    const list = loc.parent ? loc.parent.children : this.doc.roots
    list.splice(loc.index + 1, 0, block)
    this.marks = normalizeMarks(remapAnchors(this.marks, idMap))
    this.atoms = remapAnchors(this.atoms, idMap)
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
     *   · 一个**有角色的容器**（页／日记／收藏／反链／查询记录）—— 它是视图的装载单位，
     *     `doc.roots[0]` 就是森林里那块本身；splice 掉它只是让这个视图看不见，
     *     库里那块还在 ⇒ 刷新就回来（用户看到「删了又复活」，比报错更糟）。删它要走命令面
     *     （`core.page/delete` 那一路，带确认与落盘）。
     *   · 也可能是一个**普通内容块**（zoom 进来的某一块）—— 它没有身份语义，
     *     删掉它就是删掉这块内容，应当放行。
     *
     * ⚠️ `allowRootRemove: false` 是另一条更严的线：反链／查询列表的根是**别的页的块**，
     *    在这里删源块不合适（那类删除走命令面），所以那一类实例整体关掉。
     */
    if (loc.parent === null && (loc.block.roles?.length ?? 0) > 0) return
    if (loc.parent === null && !this.allowRootRemove) return
    const before = this.snap()
    const prevIds = this.ownerIds()
    const idx = flatten(this.doc).findIndex((b) => b.id === id)
    const list = loc.parent ? loc.parent.children : this.doc.roots
    list.splice(loc.index, 1)
    if (this.doc.roots.length === 0) this.doc.roots.push(mkBlock(''))
    const after = flatten(this.doc)
    const caret = after[Math.min(idx, after.length - 1)]!
    // ⚠️ 同上：只回收**本容器内**的死锚点（并上变更前的块集合），容器外的原样保留
    this.syncAnchors(prevIds)
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(caret.id, 0)
    this.emitChange('struct')
  }

  toggleCollapse(id: string): void {
    const before = this.snap()
    if (!toggleCollapsed(this.doc, id)) return
    this.undo.record(before, 'structural', Date.now())
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
   * ⚠️ 无子块 ⇒ 核心函数返回 `null` ⇒ 这里直接返回，**不记 undo**（空操作不该占撤销栈）。
   */
  toggleChildrenCollapse(id: string): void {
    const before = this.snap()
    if (toggleChildrenCollapsed(this.doc, id) === null) return
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.emitChange('struct')
  }

  setTodo(id: string, state: TodoState | null): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    if (state) loc.block.todo = state
    else delete loc.block.todo
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.emitChange('struct')
  }

  toggleTodo(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    this.setTodo(id, !loc.block.todo ? 'todo' : loc.block.todo === 'todo' ? 'done' : 'todo')
  }

  setText(id: string, text: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const change = diffText(loc.block.text, text)
    loc.block.text = text
    this.marks = mapMarks(this.marks, id, change)
    this.atoms = mapAtoms(this.atoms, id, change).kept
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
  insertBlockAfter(id: string, text: string, todo?: TodoState): string | null {
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const b = mkBlock(text, todo ? { todo } : {})
    const isSectionRoot = loc.parent === null
    if (isSectionRoot) {
      loc.block.collapsed = false
      loc.block.children.unshift(b)
    } else {
      const list = loc.parent ? loc.parent.children : this.doc.roots
      list.splice(loc.index + 1, 0, b)
    }
    this.undo.record(before, 'structural', Date.now())
    this.renderAll()
    this.placeCaret(b.id, 0)
    this.emitChange('struct')
    return b.id
  }

  /* ------------------------------------------------------- 区间格式 */

  toggleMark(type: MarkType): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    const before = this.snap()
    for (const r of ranges) {
      if (r.start >= r.end) continue
      this.marks = coreToggleMark(this.marks, type, r.blockId, r.start, r.end)
    }
    this.undo.record(before, 'mark', Date.now())
    this.marks = normalizeMarks(this.marks)
    if (ranges.length === 1) this.renderBlock(ranges[0]!.blockId)
    else this.renderAll()
    // ⚠️ 还原**整段选区**（不是光标）：否则加完粗选区就塌了，
    //    「再点一次取消」做不到，划选气泡也会立刻消失。
    this.placeRange(s)
    this.emitChange('mark')
  }

  /** 当前选区命中的区间（诊断/菜单用） */
  marksAtSel(): Mark[] {
    const s = this.sel
    if (!s) return []
    const ranges = selToTextRanges(this.doc, s)
    return this.marks.filter((m) => ranges.some((r) => r.blockId === m.blockId && m.start < r.end && m.end > r.start))
  }

  clearMarksAtSel(): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    const before = this.snap()
    for (const r of ranges) {
      for (const t of ['bold', 'italic', 'highlight', 'code'] as MarkType[]) {
        this.marks = removeMarkRange(this.marks, t, r.blockId, r.start, r.end)
      }
    }
    this.undo.record(before, 'mark', Date.now())
    this.renderAll()
    // 同上：清格式也要保住选区（清完还能接着改别的格式）
    this.placeRange(s)
    this.emitChange('mark')
  }

  /* --------------------------------------------------------- 行内原子 */

  insertAtom(
    kind: AtomKind,
    opts: { label: string; target?: { kind: 'page' | 'block'; id: string }; asset?: Atom['asset']; quote?: Atom['quote'] },
  ): string | null {
    const id = this.sel?.aBlock ?? this.rows()[0]?.block.id
    if (!id) return null
    const off = this.sel?.aOff ?? 0
    const loc = locate(this.doc, id)
    if (!loc) return null
    const before = this.snap()
    const old = loc.block.text
    loc.block.text = old.slice(0, off) + ATOM_PLACEHOLDER + old.slice(off)
    const shift = { from: off, to: off, insert: ATOM_PLACEHOLDER }
    this.marks = mapMarks(this.marks, id, shift)
    const a = mkAtom(kind, id, off, opts.label, {
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.asset ? { asset: opts.asset } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
    })
    this.atoms = [...mapAtoms(this.atoms, id, shift).kept, a]
    this.undo.record(before, 'other', Date.now())
    this.renderBlock(id)
    this.placeCaret(id, off + 1)
    this.emitChange('atom')
    return a.id
  }

  /**
   * **把 `[from, to)` 这段正文替换成一条指向标签块的边**（占 1 格）。
   *
   * 与 `insertAtom` 的区别：那个是「在光标处**插入**一格」，
   * 这个是「把已经写好的几个字**换成**一格」——敲 `#名字` 走的是后者：
   * 用户先打出了 `#名字`，成边时那三个字要被吃掉，而不是在旁边再插一个。
   *
   * ⚠️ 文本与锚点必须用**同一次** `mapMarks` 映射：先换文本再算映射，
   *    区间长度信息就丢了（`#名字` 变 1 格，长度差要算准）。
   */
  linkTagRange(blockId: string, from: number, to: number, label: string, targetId: string): string | null {
    const loc = locate(this.doc, blockId)
    if (!loc) return null
    if (from < 0 || to > loc.block.text.length || from >= to) return null
    const before = this.snap()
    const old = loc.block.text
    // 一次替换：`#名字`（N 格）→ 占位符（1 格）
    loc.block.text = old.slice(0, from) + ATOM_PLACEHOLDER + old.slice(to)
    const change = { from, to, insert: ATOM_PLACEHOLDER }
    this.marks = mapMarks(this.marks, blockId, change)
    const a = mkAtom('tag', blockId, from, label, { target: { kind: 'page', id: targetId } })
    this.atoms = [...mapAtoms(this.atoms, blockId, change).kept, a]
    this.undo.record(before, 'other', Date.now())
    this.renderBlock(blockId)
    // 光标落到那一格**之后**（否则再打卡在原子后面）
    this.placeCaret(blockId, from + 1)
    this.emitChange('atom')
    return a.id
  }

  /** 删掉一个行内原子（连同它占的那一格） */
  removeAtom(atomId: string, beforeRemove?: () => void): void {
    const a = this.atoms.find((x) => x.id === atomId)
    if (!a) return
    const loc = locate(this.doc, a.blockId)
    const before = this.snap()
    /**
     * 摘标签时可能要顺带清理它带来的值（D20）。
     * 回调放在**快照之后、改模型之前** ⇒ 「删边 ＋ 清值」是**一次撤销**能一起复原的。
     */
    beforeRemove?.()
    if (loc) {
      const ch = { from: a.start, to: a.end, insert: '' }
      loc.block.text = loc.block.text.slice(0, a.start) + loc.block.text.slice(a.end)
      this.marks = mapMarks(this.marks, a.blockId, ch)
      /**
       * ⚠️ 必须**显式丢掉这个原子**，不能只交给 `mapAtoms(...).kept`。
       *
       * 原因：原子恒占 1 格，删掉它占的那一格后，通用粘性映射（两端各有 bias）
       * 会把它的区间压到一个长度仍为 1 的位置上 ⇒ **文本里已经没有占位符了，
       * 原子记录却还活着**。表现是「引用框没了，但那条边还在」—— 对标签来说就是
       * 「删了 `#标签`，成员列表里却还有它」（本轮 T40 实测抓到）。
       * ⇒ 「占位符没了」与「原子没了」必须一起发生，不能有中间态。
       */
      this.atoms = mapAtoms(this.atoms, a.blockId, ch).kept.filter((x) => x.id !== atomId)
    }
    this.undo.record(before, 'delete', Date.now())
    this.renderAll()
    this.emitChange('atom')
  }

  /** 引用某段的引文快照：用当前选区取 exact/prefix/suffix */
  quoteAtSel(): Atom['quote'] | undefined {
    const s = this.sel
    if (!s) return undefined
    const r = normSel(this.doc, s)
    if (r.startBlock !== r.endBlock) return undefined
    const b = locate(this.doc, r.startBlock)
    if (!b) return undefined
    const exact = b.block.text.slice(r.startOff, r.endOff)
    if (!exact) return undefined
    return {
      exact,
      prefix: b.block.text.slice(Math.max(0, r.startOff - 20), r.startOff),
      suffix: b.block.text.slice(r.endOff, r.endOff + 20),
    }
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
    if (from > 0) this.container.appendChild(this.placeholder(from, 'head'))
    for (const r of rows.slice(from, to)) this.container.appendChild(this.makeBlockEl(r))
    if (to < rows.length) this.container.appendChild(this.placeholder(rows.length - to, 'tail'))
    this.caretMarks = ''
    this.markCaret()
    this.paintBlockSel()
    this.events.mounted?.()
  }

  private placeholder(count: number, which: string): HTMLElement {
    const d = document.createElement('div')
    d.className = 'ph'
    d.dataset.ph = which
    d.dataset.count = String(count)
    d.contentEditable = 'false'
    d.style.height = `${count * LINE_H}px`
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
   *
   * 落点判据（`clientY`）：只在**最后一行可见块的底边之下**才算空白 —— 否则
   * `#scroll` 里与正文同高的左右留白也会误触。
   *
   * ⚠️ 虚拟化下最后一行可能没挂 DOM ⇒ 取不到 rect 时**放行**（宁可建块，也别「点了没反应」）。
   * ⚠️ 段与段之间的「缝」暂不单独建块（见 `待定-日记流.md`）；首版只认全局底部。
   */
  clickEmptyArea(clientY: number): boolean {
    if (!this.allowBlankCreate) return false
    this.clearBlockSelection()
    const rows = this.rows()
    const last = rows[rows.length - 1]
    const root = this.doc.roots[this.doc.roots.length - 1]
    if (!last || !root) return false
    const lastEl = this.blockEl(last.block.id)
    if (lastEl && clientY < lastEl.getBoundingClientRect().bottom) return false

    const before = this.snap()
    root.collapsed = false
    /**
     * **复用末尾空块，不无中生有**：点底部若最后一段末尾已有一个空块（既无文字也无子块），
     * 直接聚焦它，避免「点一次多一个空块」越点越多。只有末尾没有空块时才新建。
     * 判据收紧到「空文本且空子树」——空标题但带子块的块不当作可复用空块。
     */
    const lastChild = root.children[root.children.length - 1]
    const emptyTail = lastChild && lastChild.text === '' && lastChild.children.length === 0 ? lastChild : null
    const child = emptyTail ?? mkBlock('')
    if (!emptyTail) root.children.push(child)
    this.undo.record(before, 'structural', Date.now())
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
      collapseSelection: () => this.collapseSelection(),
      syncFromDom: (id, re) => this.syncFromDom(id, re),
      beginMouseSelect: (id, x, y, shift) => this.beginMouseSelect(id, x, y, shift),
      updateMouseSelect: (x, y) => this.updateMouseSelect(x, y),
      endMouseSelect: () => this.endMouseSelect(),
      hasBlockSelection: () => this.hasBlockSelection(),
      emitSlashQuery: (id) => this.emitSlashQuery(id),
      dropSlashQuery: (id) => this.dropSlashQuery(id),
      insertPlainText: (id, _off, text) => this.pasteAt(id, _off, text),
      hasChildren: (id) => Boolean(locate(this.doc, id)?.block.children.length),

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
      dropDrag: (targetId, zone) => {
        const id = this.dragId
        if (!id) return
        const loc = locate(this.doc, id)
        if (!loc) return
        // 段根（页／天／查询记录）不是内容块：不参与拖拽。
        // 日记流的分段顺序是真实日期序，查询列表是视图序——都不是「可拖的兄弟序」。
        if (loc.parent === null) return
        const before = this.snap()
        let ok = false
        if (targetId) {
          const targetLoc = locate(this.doc, targetId)
          // 段根只接受 inside（放进某一天/某个容器）；before/after 会造出没有家的根。
          if (!targetLoc || (targetLoc.parent === null && zone !== 'inside')) return
          ok = moveBlockTo(this.doc, id, targetId, zone)
        } else {
          // 落在空白处：放进**最后一段**（日记流里是最早的一天），不推到 doc.roots。
          // （旧实现 push 到 roots 会造出一个不属于任何 section 的根；N=1 时也是死区。）
          const root = this.doc.roots[this.doc.roots.length - 1]
          if (root) {
            const list = loc.parent ? loc.parent.children : this.doc.roots
            list.splice(loc.index, 1)
            root.children.push(loc.block)
            ok = true
          }
        }
        this.endDrag()
        if (!ok) return
        this.undo.record(before, 'structural', Date.now())
        const caret = this.sel?.aOff ?? 0
        this.renderAll()
        this.placeCaret(id, caret)
        this.emitChange('struct')
      },
      endDrag: () => this.endDrag(),

      composing: () => this.probe.isComposing,
      noteComposition: (step) => {
        if (step === 'start') this.probe.isComposing = true
        if (step === 'end') this.probe.isComposing = false
        this.probe.compositionSeq.push(step)
      },
      onAtomClick: (atomId, el, mods) => {
        const a = this.atoms.find((x) => x.id === atomId)
        if (a) this.events.atomClick?.(a, el, mods)
        return a
      },
      onBlockMenu: (id, rect) => this.events.blockMenu?.(id, rect),
      // 左键点块标 ＝ 聚焦/zoom
      focusBlock: (id) => this.events.focusBlock?.(id),
      // Shift+左键点块标 ＝ 在右槽钉住；没有接这个事件的视图（如反链 footer）退化成聚焦
      openInDock: (id) => (this.events.openInDock ? this.events.openInDock(id) : this.events.focusBlock?.(id)),
      toggleCollapse: (id) => this.toggleCollapse(id),
      toggleChildrenCollapse: (id) => this.toggleChildrenCollapse(id),
      toggleTodo: (id) => this.toggleTodo(id),
      blankArea: this.blankArea,
      clickEmptyArea: (y) => this.clickEmptyArea(y),
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

  /** `/` 触发：块文本在光标前是 `/` 或 `/查询词`（无空格）时上报 */
  private emitSlashQuery(id: string): void {
    if (!this.events.slashQuery) return
    const loc = locate(this.doc, id)
    if (!loc) return
    const off = this.sel?.aBlock === id ? (this.sel?.aOff ?? 0) : 0
    const m = /(^|\s)\/([^\s/]{0,20})$/.exec(loc.block.text.slice(0, off))
    if (!m) {
      this.events.slashQuery(null, new DOMRect())
      return
    }
    this.events.slashQuery(m[2] ?? '', this.caretRect() ?? new DOMRect())
  }

  /** 把 `/查询词` 从模型里抹掉（选中命令后调用） */
  dropSlashQuery(id: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const off = this.sel?.aBlock === id ? (this.sel?.aOff ?? 0) : 0
    const m = /(^|\s)\/([^\s/]{0,20})$/.exec(loc.block.text.slice(0, off))
    if (!m) return
    const qLen = (m[2] ?? '').length + 1
    this.editBlock(id, off - qLen, off, '', 'delete')
    this.placeCaret(id, off - qLen)
  }

  /** 粘贴：多行 → 拆块（id 规则：首块保留原 id，其余新发） */
  pasteAt(id: string, offset: number, text: string): void {
    const lines = text.split('\n')
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    if (lines.length === 1) {
      const old = loc.block.text
      loc.block.text = old.slice(0, offset) + lines[0]! + old.slice(offset)
      this.marks = mapMarks(this.marks, id, { from: offset, to: offset, insert: lines[0]! })
      this.atoms = mapAtoms(this.atoms, id, { from: offset, to: offset, insert: lines[0]! }).kept
    } else {
      const old = loc.block.text
      const tail = old.slice(offset)
      loc.block.text = old.slice(0, offset) + lines[0]!
      const list = loc.parent ? loc.parent.children : this.doc.roots
      const at = list.indexOf(loc.block)
      const created: Block[] = []
      for (let i = 1; i < lines.length; i++) created.push(mkBlock(lines[i]!))
      const last = created[created.length - 1]!
      last.text = last.text + tail
      list.splice(at + 1, 0, ...created)
    }
    this.undo.record(before, 'insert', Date.now())
    this.renderAll()
    this.placeCaret(id, offset + (lines[0]?.length ?? 0))
    this.emitChange('text')
  }

  /* ------------------------------------------------------ 页面装载 */

  loadPage(doc: Doc, marks: Mark[], atoms: Atom[], caret?: { blockId: string; off: number }): void {
    /**
     * ⚠️ **换视图前先让索引失效**。
     *
     * `loadPage` 是「命令改完森林之后」的收尾动作（新建页 / 删页 / 换当前对象），
     * 而那条路径**不发 `store.touch()`**（`kind === 'load'` 刻意跳过，避免把加载当成编辑）。
     * 索引缓存住的是「库长什么样」，所以这里必须显式作废 —— 否则删掉的一页还能被 `find` 到。
     */
    this.store.invalidateIndex()
    this.doc = doc
    this.blockSel = null
    this.mouseSel = null
    this.container.classList.remove('blocksel-drag')
    this.viewRootIds = doc.roots.map((b) => b.id)
    /**
     * 共享 store：marks/atoms 是库级共享数组。调用方通常传 `store.marks/atoms`（同一引用）；
     * 换库/独立实例时才需要替换 store 的内容。**不再 clear undo**——undo 是 store 全局的，
     * 加载反链/查询视图不能清掉正文的撤销栈。
     */
    if (marks !== this.store.marks) this.store.replaceMarks(marks, this)
    if (atoms !== this.store.atoms) this.store.replaceAtoms(atoms, this)
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
      blockSelection: this.blockSel !== null,
      blockSelectionCount: this.blockSel?.ids.length ?? 0,
      blockType: b?.todo ? 'todo' : 'paragraph',
      blockHasChildren: Boolean(b?.children.length),
      blockCollapsed: Boolean(b?.collapsed),
      blockDone: b?.todo === 'done',
      marking: b ? this.marksAtSel().map((m) => m.type).join('+') : '',
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

  /** 诊断：composing 为真时命令零触发（59 ） */
  guard(name: string, ctx: Record<string, unknown>): boolean {
    if (ctx.composing) return false
    this.log.run(name)
    return true
  }
}
