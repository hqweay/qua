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
 *  - 折叠（收起的子树不挂 DOM；折叠态是**文档级视图状态**）、待办复选框、悬停左侧 gutter（折叠箭头／圆点／拖拽把手）；
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
  DIVIDER_TYPE,
  flatten,
  hasIdentity,
  indentMove,
  insertFirstChild,
  insertSiblingAfter,
  enterKind,
  locate,
  deleteBlockSpan,
  mapAtoms,
  mapMarks,
  mergeIntoPrev,
  mergeIntoPrevPlan,
  prevPlaceholder,
  removePrevPlaceholder,
  addTagId,
  ensureTag,
  hasTag,
  removeTagId,
  trailingHashTag,
  mkBlock,
  applyMove,
  dropMove,
  normSel,
  normalizeMarks,
  outdentMove,
  pruneToText,
  edgeSourceIds,
  tagIdsOf,
  remapAnchors,
  removeMarkRange,
  selToTextRanges,
  setBlockType,
  siblingMove,
  splitBlockBefore,
  splitBlockIntoFirstChild,
  isFolded,
  toggleChildrenCollapsed,
  toggleCollapsed,
  unfoldBlock,
  toggleMark as coreToggleMark,
  visibleRows,
  mkAtom,
  writeBlockText,
  walkForest,
  gutterFieldsOf,
  gutterFieldsFor,
  setValue,
  todoOf,
  TASK_STATUS_PROP_ID,
  typeDeclOf,
  canWriteText,
  type Atom,
  type AtomKind,
  type Block,
  type CtxKeys,
  type Doc,
  type GutterField,
  type Located,
  type Mark,
  type MarkType,
  type MovePlan,
  type Sel,
  type Snap,
  type TextChange,
  type TodoState,
  type UndoKind,
  type VisibleRow,
} from '../core/index.ts'
// 只取**类型**：`view` 拿不到实现，写入的落地方式归装配层（见 `Run`）
import type { Tx } from '../core/kb/types.ts'
// 标签块的「找到或创建」有两种落地（直写 / 事务），判据只有一份
import { ensureTagInTx, tagLookupOf } from '../core/kb/ensure-tag.ts'
// 用户可见文案一律走 t
import { t } from '../core/msg.ts'
import { LINE_H, fillBlockText, isReadonlyBlock, makeBlockEl, visibleRowHeight } from './block-dom.ts'
import { blockIdOf, isTagChip, offsetIn, readBlockText, textEndOff } from './dom-text.ts'
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
  text: string
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
  /**
   * **进入这次编辑时**那一行是什么（正文 ＋ 地址）。
   *
   * 为什么要有它：校验放在编辑边界，而离开那一刻正文已经被敲进去了 —— 要回滚就得知道
   * 「改名前」是什么。记在**第一次把 DOM 同步进模型之前**（`syncFromDom` 的第一笔），
   * 而不是聚焦那一刻：聚焦之后、第一次敲键之前，别处命令也可能合法地改过这一块，
   * 那不属于「这次编辑」，不该被回滚带走。
   */
  private editBase: EditBase | null = null
  /** 「点空白建块」的监听面：比 container 大一圈，见 `ViewOpts.blankArea` */
  blankArea: HTMLElement
  private allowBlankCreate: boolean
  private allowRootRemove: boolean
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

  renderAll(): void {
    this.container.textContent = ''
    this.mounted.clear()
    this.rebuildAncestors()
    // DOM 重建 ⇒ `data-caret` 全丢，缓存也失效（否则 `markCaret` 会因为「id 没变」而跳过）
    this.caretMarks = ''
    if (this.virtualize) {
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
   */
  private renderRows(rows: readonly VisibleRow[]): void {
    const gutters = gutterFieldsFor(
      rows.map((r) => r.block),
      this.store.blocks,
    )
    for (const r of rows) this.container.appendChild(this.makeBlockEl(r, gutters.get(r.block.id)))
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

  /**
   * 被吃掉的原子要不要报「失效」。
   *
   * ⚠️ **`tag` 原子不报**：删掉正文里那个 `#名` 只是不再露面，归属还在
   *    （下一次渲染它会落回 chip），它不是一条失效的引用。
   */
  private reportLost(atoms: readonly Atom[]): void {
    const lost = atoms.filter((a) => a.kind !== 'tag')
    if (lost.length) this.events.atomsLost?.(lost)
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
      (tx) => fillBlockText(tx, r.block, this.marks, this.atoms, (id) => this.store.find(id)),
      {
        single: flatten(this.doc).length === 1,
        ancestors: this.ancestors.get(r.block.id) ?? [],
        folded: this.doc.folded,
        gutter,
      },
    )
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
      if (done || isTagChip(n)) return
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
      target.off = textEndOff(tx)
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
    walkForest(roots, (b, ctx) => {
      lines.push(`${'  '.repeat(ctx.path.length - 1)}${b.text}`)
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

  /** 块内替换：模型 → 区间粘性映射 → 重渲染 */
  editBlock(id: string, from: number, to: number, insert: string, kind: 'insert' | 'delete' = 'insert'): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const old = loc.block.text
    const change: TextChange = { from, to, insert }
    const mm = mapMarks(this.marks, id, change)
    const r = mapAtoms(this.atoms, id, change)
    if (this.write) {
      // 与 `setText` 同一笔：正文 ＋ 锚点要么一起落，要么一起回滚
      // （锚点只喂这一块的，理由见 `setText`）
      this.write((tx) => {
        tx.patch(id, (b) => writeBlockText(b, old.slice(0, from) + insert + old.slice(to)))
        tx.setAnnotations(
          id,
          mm.filter((m) => m.blockId === id),
          r.kept.filter((a) => a.blockId === id),
        )
      })
    } else {
      writeBlockText(loc.block, old.slice(0, from) + insert + old.slice(to))
      this.marks = mm
      this.atoms = r.kept
    }
    this.undo.record(before, kind, Date.now())
    this.renderBlock(id)
    this.reportLost(r.lost)
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
   */
  commitEdit(id: string): { ok: true } | { ok: false; conflict: Block } {
    const base = this.editBase
    if (!base || base.id !== id) return { ok: true }
    const b = this.store.find(id)
    if (!b) {
      this.editBase = null
      return { ok: true }
    }
    // 组合期不提交：IME 的预编辑还不是这次编辑的结束
    if (this.probe.isComposing) return { ok: true }
    this.rebase(b)
    return { ok: true }
  }

  /** 换一个编辑期：先把上一块交出去（换块就是上一次编辑的结束），再记下这一块此刻的样子 */
  private beginEdit(b: Block): void {
    const prev = this.editBase
    if (prev && prev.id !== b.id) this.commitEdit(prev.id)
    this.rebase(b)
  }

  private rebase(b: Block): void {
    this.editBase = { id: b.id, text: b.text }
  }

  /**
   * **把刚敲完的 `#名字` 换成行内标签**：正文里留 1 格原子，归属写进 `_tags`。
   *
   * 三件事必须一起发生（否则各留一个半截状态，都难修）：
   *   ① 名字那几个字从正文里删掉；② 原位插一枚 `tag` 原子；③ `addTagId` 写归属。
   * 调用方负责把它们包进**同一笔撤销**（`snap()` 在调用前取）。
   *
   * ⚠️ 归属写的是**标签块 id**：标签改名后正文里那枚原子照样显示新名字（解析走 id）。
   * ⚠️ `allowEnd`：只在**编辑边界**（回车/离开这一行）为真 —— 那时「还在敲」的可能已归零，
   *    行尾也算敲完。输入过程中必须等分隔符，否则 `#自` 会在半路变成标签「自」。
   */
  private convertHashTag(
    id: string,
    opts: { allowEnd?: boolean } = {},
    tx?: Tx,
  ): { name: string; from: number; to: number; tagId: string } | null {
    const loc = locate(this.doc, id)
    if (!loc) return null
    if (!canWriteText(loc.block)) return null
    const hit = trailingHashTag(loc.block.text, opts)
    if (!hit) return null
    const ch = { from: hit.from, to: hit.to, insert: ATOM_PLACEHOLDER }
    /**
     * **有事务**：建标签块、改正文、换原子、写归属是**同一笔**。
     * 拆开落盘会留下半批（「字改了、标签没建」「原子有了、归属没写」），
     * 而半批比慢更贵 —— 一次用户动作 = 一次 `run` = 一个 tx。
     *
     * 新建块也走 `tx.insert` ⇒ 索引随事务按 op 增量修补，不再需要手工失效。
     */
    if (tx) {
      const tagBlock = ensureTagInTx(tagLookupOf(this.store.blocks), hit.name, tx)
      if (!tagBlock) return null
      const tagId = tagBlock.id
      tx.patch(id, (b) => writeBlockText(b, b.text.slice(0, hit.from) + ATOM_PLACEHOLDER + b.text.slice(hit.to)))
      /**
       * ⚠️ 只喂**这一块**：`setAnnotations` 会按块拼接（别的块的 + 这次的），
       *    整组喂进去会让这一块的锚点翻倍。
       */
      tx.setAnnotations(
        id,
        mapMarks(this.marks, id, ch).filter((m) => m.blockId === id),
        [
          ...mapAtoms(this.atoms, id, ch).kept.filter((a) => a.blockId === id),
          mkAtom('tag', id, hit.from, hit.name, { target: { kind: 'block', id: tagId } }),
        ],
      )
      tx.setTags(id, [...tagIdsOf(loc.block), tagId])
      return { ...hit, tagId }
    }
    /**
     * 建标签块要动整片森林 —— `store.blocks` 就是它（所有视图共享同一个数组），
     * 所以这里不需要再注入一个「谁来建」的回调：森林只有一份，读者也是这一份。
     *
     * ⚠️ 这条**直写**分支只服务没有 `write` 注入的实例（迁移期兜底）；
     *    有事务入口时，编辑边界的转换与结构拆分共用同一笔（见 `splitTx`）。
     */
    const tagId = ensureTag(this.store.blocks, hit.name).block?.id ?? null
    if (!tagId) return null
    /**
     * ⚠️ 新建的标签块**还没进派生索引**（索引是快照，下一次 `touch` 才失效重建）。
     *    紧接着的这次重画要用 `find(tagId)` 去找它 ⇒ 先把索引失效掉，
     *    否则正文里那枚原子会画不出来（表现为「敲完标签什么都没出现」，真踩过）。
     */
    this.store.invalidateIndex()
    writeBlockText(loc.block, loc.block.text.slice(0, hit.from) + ATOM_PLACEHOLDER + loc.block.text.slice(hit.to))
    this.marks = mapMarks(this.marks, id, ch)
    this.atoms = [
      ...mapAtoms(this.atoms, id, ch).kept,
      mkAtom('tag', id, hit.from, hit.name, { target: { kind: 'block', id: tagId } }),
    ]
    addTagId(loc.block, tagId)
    return { ...hit, tagId }
  }

  /**
   * **给一个块挂标签**（块级露面：正文之后出 chip）。
   *
   * 与行内标签共用 `_tags`：这里只写归属、不碰正文 —— 面板/命令路径的入口。
   * @returns 真的加上了才 `true`（已经有、名字为空 ⇒ `false`）
   */
  addTag(blockId: string, name: string): boolean {
    const b = this.store.find(blockId)
    if (!b) return false
    // 快照取在**建标签**之前：撤销这次挂标签时，顺手建出的标签块也该一起回滚
    const before = this.snap()
    if (this.write) {
      // 建标签块（可能）＋写归属是同一笔：拆开就会留下「只有标签、没有归属」的半批。
      // 与 `convertHashTag` 的事务支同形；名字为空／已挂 ⇒ 事务里什么都不写（零 op）
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
      // 同 `convertHashTag` 直写支：刚建的块不在索引里，紧接着的重画要靠它
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
   * ⚠️ 为什么连原子一起收：不知道「归属没了、正文里还留着一枚 `#名`」该怎么显示 ——
   *    画成标签是撒谎（查询已经找不到它），画成文字又要多一条渲染分支。
   *    收掉最干净；同一笔撤销能把它恢复回来。
   */
  removeTag(blockId: string, tagId: string): boolean {
    const loc = locate(this.doc, blockId)
    const b = loc?.block ?? this.store.find(blockId)
    if (!b) return false
    const hits = this.atoms
      .filter((a) => a.blockId === blockId && a.kind === 'tag' && a.target?.id === tagId)
      .sort((x, y) => y.start - x.start)
    if (hits.length === 0 && !hasTag(b, tagId)) return false
    const before = this.snap()
    /**
     * ⚠️ 原子是**库级**的（`store.atoms`），正文写的是块自己 —— 与「这一块此刻画没画在屏上」
     *    无关。所以不按 `locate` 决定收不收：目标块不在本视图里时也要把正文那几格收掉，
     *    否则换个视图打开它，会看到一枚「属于标签、但归属里已经没有它」的僵尸原子。
     */
    const apply = () => {
      let text = b.text
      let marks = this.marks
      let atoms = this.atoms
      for (const a of hits) {
        const ch = { from: a.start, to: a.end, insert: '' }
        text = text.slice(0, a.start) + text.slice(a.end)
        marks = mapMarks(marks, blockId, ch)
        atoms = mapAtoms(atoms, blockId, ch).kept.filter((x) => x.id !== a.id)
      }
      return { text, marks, atoms }
    }
    if (this.write) {
      // 收原子（正文＋锚点）与摘归属是同一件事 ⇒ 同一笔；正文没变的块 patch 不发 op
      this.write((tx) => {
        const { text, marks, atoms } = apply()
        tx.patch(blockId, (bb) => writeBlockText(bb, text))
        tx.setAnnotations(
          blockId,
          marks.filter((m) => m.blockId === blockId),
          atoms.filter((x) => x.blockId === blockId),
        )
        tx.setTags(blockId, tagIdsOf(b).filter((t) => t !== tagId))
      })
    } else {
      const { text, marks, atoms } = apply()
      writeBlockText(b, text)
      this.marks = marks
      this.atoms = atoms
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
   * 顺序：**先把文本同步进模型，再认 `#名字`**。
   * 反过来的话，占位符会被当成普通文本参与 diff，粘性映射就乱了。
   */
  syncFromDom(id: string, reRender: boolean): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    // 这一块的第一笔输入 ＝ 一次编辑期的开始（此刻模型里还是改名前那个值）
    if (this.editBase?.id !== id) this.beginEdit(loc.block)
    const next = this.readText(id)
    if (next === loc.block.text) return
    const change = diffText(loc.block.text, next)
    const mm = mapMarks(this.marks, id, change)
    const r = mapAtoms(this.atoms, id, change)
    /**
     * **这一笔会不会顺手成标签**：`convertHashTag` 的判据是「**模型里**的正文刚敲完一个
     * `#名字`」，所以它必须在正文落进模型之前算出来 —— 落进去之后就再也问不出「刚才那一下
     * 是不是敲了分隔符」（`trailingHashTag` 是纯函数，问的就是 `next` 这段字）。
     *
     * 成标签那一笔**不再退回直写**：建标签块、写归属都能进 `tx`，所以它们与正文、锚点
     * 属于同一笔（见 `convertHashTag` 的 tx 分支）。组合期不做（输入法中间态里的 `#`
     * 不是标签语法）。
     */
    const willConvert = !this.probe.isComposing
    const before = this.snap()
    let conv: { name: string; from: number; to: number; tagId: string } | null = null
    if (this.write) {
      // 与 `setText` 同一笔：正文对不上敲进来的字，锚点也不可能对得上，所以两者同事务
      // （锚点只喂这一块的，理由见 `setText`）
      const write = this.write
      conv = write((tx) => {
        tx.patch(id, (b) => writeBlockText(b, next))
        tx.setAnnotations(
          id,
          mm.filter((m) => m.blockId === id),
          r.kept.filter((a) => a.blockId === id),
        )
        return willConvert ? this.convertHashTag(id, {}, tx) : null
      })
    } else {
      writeBlockText(loc.block, next)
      this.marks = mm
      this.atoms = r.kept
      if (willConvert) conv = this.convertHashTag(id)
    }
    /**
     * **行内标签**：敲下分隔符那一刻，`#名字` 换成「1 格原子 ＋ 一条归属」。
     * 上面已把它放进**同一笔事务**（没有 `write` 时仍在直写），
     * 所以下面的 `undo.record(before)` 一记，删字、插原子、写归属、新建标签块
     * 都在**同一笔撤销**里 —— 事务里不再单独记 undo。
     */
    let caret = this.sel ? this.sel.aOff : null
    // 正文短了「`#名字` 的字数 − 1 格原子」⇒ 光标跟着左移；敲完分隔符时光标在 `to` 之后
    if (conv && caret !== null && caret >= conv.to) caret = caret - (conv.to - conv.from) + 1
    const kind = change.to === change.from ? 'insert' : 'delete'
    this.undo.record(before, kind, Date.now())
    /**
     * 带标签的块每次改字都重画一次（组合期除外）。
     *
     * 为什么：标签 chip 在正文**之后**、但不占正文位置 ⇒ 光标可以落在 chip 之后，
     * 那时新敲的字会在 DOM 里排在 chip 后面，而模型里它是正文的末尾。
     * 重画一次就把「显示顺序」与「正文顺序」重新对齐（光标按模型偏移贴回，落在 chip 之前）。
     */
    const tagged = tagIdsOf(loc.block).length > 0 && !this.probe.isComposing
    if (reRender || tagged || conv) {
      this.renderBlock(id)
      if (caret !== null) this.placeCaret(id, Math.min(caret, loc.block.text.length))
      // **改名传播**：这一块可能是别处引用的目标 ⇒ 引用它的那些块也要重画（显示名现算）。
      // 改动只影响「指向它的原子所在的块」，不是全视图重渲染。
      this.renderRefSources(id)
    }
    this.reportLost(r.lost)
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
    const mine = new Set(flatten(this.doc).map((b) => b.id))
    for (const srcId of edgeSourceIds(this.atoms, id)) {
      if (!mine.has(srcId) || srcId === id) continue
      if (this.blockEl(srcId)) this.renderBlock(srcId)
    }
    for (const b of flatten(this.doc)) {
      if (b.id === id || !tagIdsOf(b).includes(id)) continue
      if (this.blockEl(b.id)) this.renderBlock(b.id)
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
      if (out.lost.length > 0) this.reportLost(out.lost)
      this.undo.record(before, 'structural', Date.now())
      this.renderAll()
      if (out.caret) this.placeCaret(out.caret.id, out.caret.off)
      this.emitChange('struct')
      return
    }

    this.splitDirect(id, offset, cut, before)
  }

  /**
   * **一次回车 ＝ 一笔事务**：行尾 `#标签` 的转换、同块选区删除、结构拆分共用这一笔。
   *
   * 为什么必须同笔：拆开落盘会得到「正文与归属直写、结构进 op」两份来源 ——
   * 半批比慢更贵。转换放在最前，是因为它会让正文变短、`offset` 随之前移；
   * 后面一律读**转换之后**的正文与锚点（`tx` 是同步改内存的）。
   *
   * ⚠️ 事务里不再 `splice`：落点全部交给 `tx.insert`／`tx.move`（按整片森林取兄弟列表）。
   * ⚠️ `setAnnotations` 只喂**这一块**的锚点：整组喂会让别的块的锚点重写一遍。
   */
  private splitTx(
    tx: Tx,
    id: string,
    offset: number,
    cut: { from: number; to: number } | null,
  ): { caret: { id: string; off: number } | null; lost: Atom[] } | null {
    const conv = this.convertHashTag(id, { allowEnd: true }, tx)
    if (conv && offset >= conv.to) offset = offset - (conv.to - conv.from) + 1

    const blk = this.store.find(id)
    if (!blk) return null
    let text = blk.text
    let marks = this.store.marks.filter((m) => m.blockId === id)
    let atoms = this.store.atoms.filter((a) => a.blockId === id)
    let lost: Atom[] = []
    if (cut) {
      const from = Math.max(0, Math.min(cut.from, text.length))
      const to = Math.max(from, Math.min(cut.to, text.length))
      const ch = { from, to, insert: '' }
      text = text.slice(0, from) + text.slice(to)
      offset = from
      marks = mapMarks(marks, id, ch)
      const r = mapAtoms(atoms, id, ch)
      atoms = r.kept
      lost = r.lost
    }
    offset = Math.min(offset, text.length)

    const loc = locate(this.doc, id)
    if (!loc) return null

    // 段根没有兄弟位（写回按 root id 走）⇒ 右半成首个子块；有身份的根只插空子块
    if (loc.parent === null) {
      if (!hasIdentity(loc.block) && offset > 0 && offset < text.length) {
        const right = mkBlock(text.slice(offset))
        tx.patch(id, (b) => writeBlockText(b, text.slice(0, offset)))
        tx.insert(right, id, 0)
        tx.setAnnotations(
          id,
          normalizeMarks(marks.filter((m) => m.start < offset)),
          atoms.filter((a) => a.start < offset),
        )
        tx.setAnnotations(
          right.id,
          normalizeMarks(
            marks
              .filter((m) => m.start >= offset)
              .map((m) => ({ ...m, blockId: right.id, start: m.start - offset, end: m.end - offset })),
          ),
          atoms
            .filter((a) => a.start >= offset)
            .map((a) => ({ ...a, blockId: right.id, start: a.start - offset, end: a.end - offset })),
        )
        unfoldBlock(this.doc, id)
        return { caret: { id: right.id, off: 0 }, lost }
      }
      const child = mkBlock('')
      unfoldBlock(this.doc, id)
      tx.insert(child, id, 0)
      return { caret: { id: child.id, off: 0 }, lost }
    }

    // 段根已在上面 return ⇒ 这里一定在某个父块下面
    const parent = loc.parent
    const kind = cut ? 'split' : enterKind(this.doc, id, offset)

    if (kind === 'outdent') {
      // 空块 Enter ⇒ 反缩进：不建新块（与这笔里的转换同一笔）
      const plan = outdentMove(this.doc, id)
      if (!plan) return { caret: null, lost }
      tx.move(id, plan.parentId, plan.index)
      return { caret: { id, off: 0 }, lost }
    }

    if (kind === 'child') {
      const b = mkBlock('')
      unfoldBlock(this.doc, id)
      tx.insert(b, id, 0)
      return { caret: { id: b.id, off: 0 }, lost }
    }

    if (kind === 'sibling') {
      const b = mkBlock('')
      tx.insert(b, parent.id, loc.index + 1)
      return { caret: { id: b.id, off: 0 }, lost }
    }

    // 块中 ⇒ 同级拆：左半进**上方新块**；原块保 id、右半、子树
    const left = mkBlock(text.slice(0, offset))
    tx.insert(left, parent.id, loc.index)
    tx.patch(id, (b) => writeBlockText(b, text.slice(offset)))
    tx.setAnnotations(
      left.id,
      normalizeMarks(marks.filter((m) => m.start < offset).map((m) => ({ ...m, blockId: left.id }))),
      atoms.filter((a) => a.start < offset).map((a) => ({ ...a, blockId: left.id })),
    )
    tx.setAnnotations(
      id,
      normalizeMarks(
        marks
          .filter((m) => m.start >= offset)
          .map((m) => ({ ...m, start: m.start - offset, end: m.end - offset })),
      ),
      atoms
        .filter((a) => a.start >= offset)
        .map((a) => ({ ...a, start: a.start - offset, end: a.end - offset })),
    )
    return { caret: { id: !cut && offset === 0 ? left.id : id, off: 0 }, lost }
  }

  /** 没有事务入口时的直写落地（迁移期兜底；判定与 `splitTx` 同源，只是逐条改活块） */
  private splitDirect(id: string, offset: number, cut: { from: number; to: number } | null, before: Snap): void {
    /**
     * **回车是编辑边界**：行尾那个 `#名字` 到这一刻算敲完（输入中必须等分隔符）。
     */
    const conv = this.convertHashTag(id, { allowEnd: true })
    if (conv && offset >= conv.to) offset = offset - (conv.to - conv.from) + 1
    const loc = locate(this.doc, id)
    if (!loc) return
    offset = Math.min(offset, loc.block.text.length)

    let forcedSplit = false
    if (cut) {
      const old = loc.block.text
      writeBlockText(loc.block, old.slice(0, cut.from) + old.slice(cut.to))
      const change = { from: cut.from, to: cut.to, insert: '' }
      this.marks = mapMarks(this.marks, id, change)
      const r = mapAtoms(this.atoms, id, change)
      this.atoms = r.kept
      this.reportLost(r.lost)
      offset = cut.from
      forcedSplit = true
    }

    if (loc.parent === null) {
      /**
       * **段根没有兄弟位**（写回按 root id 走）⇒ 退化成「右半成首个子块」：
       *   · **无角色的内容根**（focus/zoom 进来的普通块）＋ 文本**中间**
       *     ⇒ 左半留在根里、右半成**首个子块**，光标到子块；
       *   · **有角色的根**（页/日记）或块首 / 空块 / 块尾
       *     ⇒ 插一个**空的首个子块**（根文本是名字/投影，不拆，避免静默改名）。
       */
      const canSplitRoot = !hasIdentity(loc.block)
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
     * 锚点归属：被并块的字现在排在前一块正文的**末尾** ⇒ 整体后移 `plan.at`；
     * 前一块自己的锚点原地不动。两块都要交：`setAnnotations` 只换这一块的。
     */
    const movedCur = <T extends { blockId: string; start: number; end: number }>(arr: readonly T[]): T[] =>
      arr
        .filter((a) => a.blockId === id)
        .map((a) => ({ ...a, blockId: plan.kept, start: a.start + plan.at, end: a.end + plan.at }))
    if (this.write) {
      const write = this.write
      const keptMarks = this.marks.filter((m) => m.blockId === plan.kept)
      const keptAtoms = this.atoms.filter((a) => a.blockId === plan.kept)
      const marks = movedCur(this.marks)
      const atoms = movedCur(this.atoms)
      write((tx) => {
        tx.patch(plan.kept, (b) => writeBlockText(b, plan.text))
        // 子块跟着并进前一块：每块一条 move（各自报自己的 parent/index）
        plan.children.forEach((kid, n) => tx.move(kid, plan.kept, plan.kidsAt + n))
        tx.setAnnotations(plan.kept, normalizeMarks([...keptMarks, ...marks]), [...keptAtoms, ...atoms])
        tx.setAnnotations(plan.removed, [], [])
        /**
         * 被并块**不进回收站**：它的正文与子块都已经搬进前一块，留一个空壳只是噪声。
         * op 仍是 `block.delete` —— 回收站是阶段 1 的内存表示，不是持久化事实。
         */
        tx.remove(plan.removed, { trash: false })
      })
    } else {
      if (!mergeIntoPrev(this.doc, id)) return
      const moved = <T extends { blockId: string; start: number; end: number }>(arr: readonly T[]): T[] =>
        arr.map((a) =>
          a.blockId === id ? { ...a, blockId: plan.kept, start: a.start + plan.at, end: a.end + plan.at } : a,
        )
      this.marks = normalizeMarks(moved(this.marks))
      this.atoms = moved(this.atoms)
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
    if (all.findIndex((x) => x.id === s.aBlock) <= 0) return false
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
      write((tx) => tx.move(id, plan.parentId, plan.index))
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
    const { block, idMap } = cloneSubtree(loc.block)
    const list = loc.parent ? loc.parent.children : this.doc.roots
    /**
     * 克隆块的锚点是**新增**：内容复制 ⇒ 覆盖它的区间标签/原子跟着复制一份。
     * ⚠️ 不能把整组锚点替换成 remap 的结果——`remapAnchors` 只吐**克隆块**的锚点，
     *    直接赋值会把克隆子树之外的（连同源块自己的）全部丢掉。
     */
    const clonedMarks = normalizeMarks(remapAnchors(this.marks, idMap))
    const clonedAtoms = remapAnchors(this.atoms, idMap)
    if (this.write) {
      const write = this.write
      write((tx) => {
        tx.insert(block, loc.parent?.id ?? null, loc.index + 1)
        // 只喂新块：`setAnnotations` 按 id diff，没动过的块不发 op
        for (const newId of idMap.values()) {
          tx.setAnnotations(
            newId,
            clonedMarks.filter((m) => m.blockId === newId),
            clonedAtoms.filter((a) => a.blockId === newId),
          )
        }
      })
    } else {
      list.splice(loc.index + 1, 0, block)
      this.marks = [...this.marks, ...clonedMarks]
      this.atoms = [...this.atoms, ...clonedAtoms]
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
    const prevIds = this.ownerIds()
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
      const list = loc.parent ? loc.parent.children : this.doc.roots
      list.splice(loc.index, 1)
      if (wasRoot) this.viewRootIds = this.viewRootIds.filter((x) => x !== id)
      if (this.doc.roots.length === 0) {
        const empty = mkBlock('')
        this.doc.roots.push(empty)
        this.viewRootIds = [empty.id]
      }
    }
    const after = flatten(this.doc)
    const caret = after[Math.min(idx, after.length - 1)]!
    // ⚠️ 同上：只回收**本容器内**的死锚点（并上变更前的块集合），容器外的原样保留
    this.syncAnchors(prevIds)
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

  setText(id: string, text: string): void {
    const loc = locate(this.doc, id)
    if (!loc) return
    const before = this.snap()
    const change = diffText(loc.block.text, text)
    const mm = mapMarks(this.marks, id, change)
    const kept = mapAtoms(this.atoms, id, change).kept
    if (this.write) {
      /**
       * 正文 ＋ 锚点同一笔事务（拆开落盘会留下「字在、粗体没了」的窗口）。
       *
       * ⚠️ 交给 `tx` 的锚点必须**只含这一块**：`setAnnotations` 按块拼接
       *    （别的块的 + 这次的），把整组喂进去会让这一块的锚点翻倍。
       *    而 `mapMarks`/`mapAtoms` 吃的是整组、吐的也是整组 —— 过滤这一步不能省。
       */
      this.write((tx) => {
        tx.patch(id, (b) => writeBlockText(b, text))
        tx.setAnnotations(
          id,
          mm.filter((m) => m.blockId === id),
          kept.filter((a) => a.blockId === id),
        )
      })
    } else {
      writeBlockText(loc.block, text)
      this.marks = mm
      this.atoms = kept
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
    const blank = loc.block.text === '' && loc.block.children.length === 0 && canWriteText(loc.block)
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
    if (loc.block.text === '' && loc.block.children.length === 0 && canWriteText(loc.block)) {
      if (this.write) {
        // 原地改类型是一个属性写入：`_type` 一条 op，撤销一次回到「那行还是空白」
        this.write((tx) => {
          tx.patch(loc.block.id, (b) => setBlockType(b, DIVIDER_TYPE))
        })
      } else {
        setBlockType(loc.block, DIVIDER_TYPE)
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

  toggleMark(type: MarkType): void {
    const s = this.sel
    if (!s) return
    const ranges = selToTextRanges(this.doc, s)
    if (ranges.length === 0) return
    const before = this.snap()
    const apply = (marks: readonly Mark[]): Mark[] => {
      let next = marks
      for (const r of ranges) {
        if (r.start >= r.end) continue
        next = coreToggleMark(next, type, r.blockId, r.start, r.end)
      }
      return normalizeMarks(next)
    }
    if (this.write) {
      // 只换锚点：正文一个字都不动 ⇒ 零 block op。按块喂（整组进整组出，别的块原样）
      const touched = [...new Set(ranges.map((r) => r.blockId))]
      this.write((tx) => {
        const next = apply(this.marks)
        for (const bid of touched) {
          tx.setAnnotations(bid, next.filter((m) => m.blockId === bid), this.atoms.filter((a) => a.blockId === bid))
        }
      })
    } else {
      this.marks = apply(this.marks)
    }
    this.undo.record(before, 'mark', Date.now())
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
    const apply = (marks: Mark[]): Mark[] => {
      let next = marks
      for (const r of ranges) {
        for (const t of ['bold', 'italic', 'highlight', 'code'] as MarkType[]) {
          next = removeMarkRange(next, t, r.blockId, r.start, r.end)
        }
      }
      return next
    }
    if (this.write) {
      // 与 `toggleMark` 同一形状：只换锚点，零 block op
      const touched = [...new Set(ranges.map((r) => r.blockId))]
      this.write((tx) => {
        const next = apply(this.marks)
        for (const bid of touched) {
          tx.setAnnotations(bid, next.filter((m) => m.blockId === bid), this.atoms.filter((a) => a.blockId === bid))
        }
      })
    } else {
      this.marks = apply(this.marks)
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
    const shift = { from: off, to: off, insert: ATOM_PLACEHOLDER }
    const a = mkAtom(kind, id, off, opts.label, {
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.asset ? { asset: opts.asset } : {}),
      ...(opts.quote ? { quote: opts.quote } : {}),
    })
    if (this.write) {
      // 占位格进正文与原子登记是同一件事的两半，拆开落盘会留下「格子在了、原子没登记」的半批
      this.write((tx) => {
        tx.patch(id, (b) => writeBlockText(b, old.slice(0, off) + ATOM_PLACEHOLDER + old.slice(off)))
        tx.setAnnotations(
          id,
          mapMarks(this.marks, id, shift).filter((m) => m.blockId === id),
          [...mapAtoms(this.atoms, id, shift).kept.filter((x) => x.blockId === id), a],
        )
      })
    } else {
      writeBlockText(loc.block, old.slice(0, off) + ATOM_PLACEHOLDER + old.slice(off))
      this.marks = mapMarks(this.marks, id, shift)
      this.atoms = [...mapAtoms(this.atoms, id, shift).kept, a]
    }
    this.undo.record(before, 'other', Date.now())
    this.renderBlock(id)
    this.placeCaret(id, off + 1)
    this.emitChange('atom')
    return a.id
  }

  /** 删掉一个行内原子（连同它占的那一格） */
  removeAtom(atomId: string): void {
    const a = this.atoms.find((x) => x.id === atomId)
    if (!a) return
    const loc = locate(this.doc, a.blockId)
    const before = this.snap()
    if (loc) {
      const ch = { from: a.start, to: a.end, insert: '' }
      const old = loc.block.text
      if (this.write) {
        // 占位格从正文消失与原子注销必须同笔（见下）：留中间态就是「框没了、边还在」
        this.write((tx) => {
          tx.patch(a.blockId, (b) => writeBlockText(b, old.slice(0, a.start) + old.slice(a.end)))
          tx.setAnnotations(
            a.blockId,
            mapMarks(this.marks, a.blockId, ch).filter((m) => m.blockId === a.blockId),
            mapAtoms(this.atoms, a.blockId, ch)
              .kept.filter((x) => x.blockId === a.blockId && x.id !== atomId),
          )
        })
      } else {
        writeBlockText(loc.block, old.slice(0, a.start) + old.slice(a.end))
        this.marks = mapMarks(this.marks, a.blockId, ch)
        /**
         * ⚠️ 必须**显式丢掉这个原子**，不能只交给 `mapAtoms(...).kept`。
         *
         * 原因：原子恒占 1 格，删掉它占的那一格后，通用粘性映射（两端各有 bias）
         * 会把它的区间压到一个长度仍为 1 的位置上 ⇒ **文本里已经没有占位符了，
         * 原子记录却还活着**。表现是「引用框没了，但那条边还在」。
         * ⇒ 「占位符没了」与「原子没了」必须一起发生，不能有中间态。
         */
        this.atoms = mapAtoms(this.atoms, a.blockId, ch).kept.filter((x) => x.id !== atomId)
      }
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
    unfoldBlock(this.doc, root.id)
    /**
     * **复用末尾空块，不无中生有**：点底部若最后一段末尾已有一个空块（既无文字也无子块），
     * 直接聚焦它，避免「点一次多一个空块」越点越多。只有末尾没有空块时才新建。
     * 判据收紧到「空文本且空子树」——空标题但带子块的块不当作可复用空块。
     * ⚠️ 复用支**模型不动、撤销不记**（与 `insertBlockAfter` 的空块支同一条口径）：
     *    记了就会吃掉一次 ⌘Z——按一次「什么都不变」的动作，退一步却退到上一次改动之前。
     */
    const lastChild = root.children[root.children.length - 1]
    const emptyTail = lastChild && lastChild.text === '' && lastChild.children.length === 0 ? lastChild : null
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
      commitEdit: (id) => {
        this.commitEdit(id)
      },
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
      onAtomClick: (atomId, el, mods) => {
        const a = this.atoms.find((x) => x.id === atomId)
        if (a) this.events.atomClick?.(a, el, mods)
        return a
      },
      onBlockMenu: (id, rect) => this.events.blockMenu?.(id, rect),
      // 左键点块标 ＝ 聚焦/zoom。这也是**离开这一行**：先把当前行的编辑交出去
      // （判据是「上一个块 ≠ 这个块」；点自己那一行的块标不算离开）
      focusBlock: (id) => {
        const from = this.caretBlock() ?? this.editBase?.id ?? null
        if (from && from !== id) this.commitEdit(from)
        this.events.focusBlock?.(id)
      },
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
      const next = old.slice(0, offset) + lines[0]! + old.slice(offset)
      const shift = { from: offset, to: offset, insert: lines[0]! }
      if (this.write) {
        // 正文与锚点同一笔（与 `setText` 同形）；锚点只喂这一块的
        this.write((tx) => {
          tx.patch(id, (b) => writeBlockText(b, next))
          tx.setAnnotations(
            id,
            mapMarks(this.marks, id, shift).filter((m) => m.blockId === id),
            mapAtoms(this.atoms, id, shift).kept.filter((x) => x.blockId === id),
          )
        })
      } else {
        writeBlockText(loc.block, next)
        this.marks = mapMarks(this.marks, id, shift)
        this.atoms = mapAtoms(this.atoms, id, shift).kept
      }
    } else {
      const old = loc.block.text
      const tail = old.slice(offset)
      const first = old.slice(0, offset) + lines[0]!
      const created: Block[] = []
      for (let i = 1; i < lines.length; i++) created.push(mkBlock(lines[i]!))
      const last = created[created.length - 1]!
      // 这是**刚造出来、还没进树**的新块（上面 `mkBlock` 那批）⇒ 不走正文写入入口，
      // 它的正文随构造一次给定；那里管的是「改写一个已经存在的地址」
      last.text = last.text + tail
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
          tx.patch(id, (b) => writeBlockText(b, first))
          created.forEach((c, i) => tx.insert(c, parentId, baseIndex + i))
        })
      } else {
        writeBlockText(loc.block, first)
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
    // 换视图 ＝ 换了一份装载单位：上一行那个编辑期在这里结束，不能带到新页上
    this.editBase = null
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
      blockType: b && todoOf(b) ? 'todo' : 'paragraph',
      blockHasChildren: Boolean(b?.children.length),
      blockCollapsed: Boolean(b && isFolded(this.doc, b.id)),
      blockDone: b ? todoOf(b) === 'done' : false,
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
