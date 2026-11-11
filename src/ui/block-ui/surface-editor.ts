/**
 * **就地单块编辑器**：把「一格的正文」画成**那一格自身**可编辑的样子。
 *
 * 一台实例、一处编辑、零模式。三条判据：
 *   · **编辑器不是浮层**：它装进被点的那一格，格子就是编辑器的盒子（位置、宽度、字体、
 *     内边距全部继承），所以「点下去」和「能打字」之间没有一次可看见的模式切换。
 *   · **成本与结果条数无关**：一台实例跟着焦点走；N 行/N 张卡常驻一台是量级错误。
 *     换一格＝把岛根挪过去并装另一块（一次 `loadPage`），与大纲换页同一条路径。
 *   · **布局承诺归槽位**：卡片随内容长高（它本来就该），表格行在**编辑期**长高、
 *     提交后回到密度档（密度是阅读期的约束，不是书写期的）。
 *
 * 三条会静默出错的地方：
 *   · **↵ 是敲完了，不是拆一块**：capture 拦下，否则会在格子里拆出一块看不见的块；
 *   · **Esc 要把打开那一刻的内容写回去**：编辑器是边打边写模型的，取消只能显式写回；
 *   · **组合期不提交**：输入法的 ↵ 是选词。
 */
import type { Block, BlockStore, ClickMods } from '../../core/index.ts'
import { plainLen } from '../../core/model/runs.ts'
import { t } from '../../core/infra/msg.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { offsetIn } from '../../view/editor/dom-text.ts'
import { EditableBlock } from './editable-block.ts'

export interface RefHit {
  to: string
  runId?: string
}

export interface AtomHit {
  runId: string
  kind: string
  hash?: string
}

/** 点格子里的东西：与正文用**同一份**修饰键结构 */
export type CellClickMods = ClickMods

export interface SurfaceEditorDeps {
  store: BlockStore
  /** 写入事务入口（撤销条目与落盘归装配层） */
  write: Run
  /** 与正文**同一份**事件表（引用跳转、右键菜单、`#` 补全都在里面） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  /** 投影：把一块的正文画进一个容器（装配层注入，`ui` 不拿整片森林） */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick: (hit: RefHit, el: HTMLElement, mods: CellClickMods) => void
  onAtomClick?: (atom: AtomHit, el: HTMLElement, mods: CellClickMods) => void
  /**
   * 冻结范围：正在编辑时，这一片里的外部变化**不重排**。
   * 与 `EditableBlock` 的 `area` 是同一个东西（换 DOM 会打断正在发生的事）。
   */
  area: HTMLElement
  /** 这一次编辑结束（提交或取消）之后：调用方把那一格还原成投影 */
  onClose: (blockId: string) => void
}

export class SurfaceEditor {
  private readonly deps: SurfaceEditorDeps
  private cur: {
    island: EditableBlock
    blockId: string
    slot: HTMLElement
    /** 打开那一刻的样子：Esc 取消要写回它 */
    content: readonly unknown[]
    modified: number
  } | null = null

  constructor(deps: SurfaceEditorDeps) {
    this.deps = deps
  }

  /** 现在编辑的是哪一块（`null` ＝ 没在编辑） */
  get editingId(): string | null {
    return this.cur?.blockId ?? null
  }

  /**
   * 画一个**投影格**（不是输入框）：点它才换成编辑器。
   *
   * 投影与编辑器的文字都走同一份 `project`（run/marks/引用/图片都在），
   * 所以「点下去」时看到的内容就是刚才读到的内容。
   */
  render(block: Block, into: HTMLElement): void {
    into.replaceChildren()
    into.dataset.titleFor = block.id
    into.dataset.tip = t('ui.view.editTitle')
    const inner = document.createElement('span')
    // `tv-title-text` 是表格既有断言与样式的契约名；`surface-text` 是新的一层语义名
    inner.className = 'surface-text ui-ellipsis tv-title-text'
    this.deps.project(block, inner)
    into.appendChild(inner)
    // 空块也要有可见的落点（否则那一格看起来是「没有内容」，而不是「可以写」）
    if (inner.childNodes.length === 0) inner.appendChild(document.createElement('br'))
  }

  /**
   * 点一格：先看是不是引用/原子（导航），不是才进编辑。
   *
   * `slot` 由调用方给（它才知道自己那一格的元素）：卡片是卡片标题格，
   * 表格是标题格的内层。判据用 `closest('[data-ref-to]')` 而不是「点在文字里」——
   * 格子里除了文字还有原子与 chip，它们的职责是「指向别处」。
   */
  handleClick(
    blockId: string,
    target: HTMLElement,
    mods: CellClickMods,
    point?: { x: number; y: number },
    slot?: HTMLElement | null,
  ): void {
    const hit = routeCellClick(target)
    if (hit.kind === 'ref') {
      this.deps.refClick(hit.hit, hit.el, mods)
      return
    }
    if (hit.kind === 'atom') {
      this.deps.onAtomClick?.(hit.atom, hit.el, mods)
      return
    }
    if (!slot) return
    this.edit(blockId, slot, point)
  }

  /**
   * 在**这一格**里打开这一块的编辑器。
   *
   * 打开＝把投影换成编辑器（同一个盒子、同一个位置），关掉＝把编辑器摘掉、
   * 由调用方重画投影。编辑器会自己 `focus`。
   */
  edit(blockId: string, slot: HTMLElement, point?: { x: number; y: number }): void {
    if (this.cur?.blockId === blockId && this.cur.slot === slot && slot.isConnected) return
    this.commit()
    const block = this.deps.store.find(blockId)
    if (!block) return
    const host = document.createElement('div')
    host.className = 'inline-editor'
    const island = new EditableBlock({
      host,
      store: this.deps.store,
      write: this.deps.write,
      // 一格 ＝ 一块：它的 children 不归这里画（它们本来就不在格子里）
      initialRoots: [block],
      viewRootId: blockId,
      structuralScope: 'roots',
      // 岛与块 id 绑定（load 不跟随 store，提交路径假定块存在）：删根＝岛失去对象，
      // 删除显式关——格子的收尾由看板/卡片层决定
      allowRootRemove: false,
      // 卡片/格子里再出现露面块也只画占位（深度 1）
      embedBodies: false,
      // 编辑器自己跟随 store 时会把正在打的字换掉；这里只由本组件决定「何时重装」，
      // 而这次编辑只有一次，根本不需要重装
      load: () => {},
      wire: (ed, change) => this.deps.wire(ed, change),
      onChange: (kind) => this.deps.onChange(kind),
      onFocus: (ed) => this.deps.onFocus(ed),
      area: this.deps.area,
    })
    // 先把岛根接进文档再建编辑器：编辑器构造时会量 DOM
    slot.replaceChildren(island.root)
    const ed = island.ensureEditor()
    this.cur = { island, blockId, slot, content: block.content, modified: block.modified }
    // 槽位与它所在的行进入「编辑期」：行高让给内容（密度是阅读期的约束）
    slot.dataset.editing = '1'
    const row = slot.closest<HTMLElement>('.tv-row')
    if (row) row.dataset.editing = '1'
    this.bindKeys(island.root, ed, blockId)
    /**
     * **焦点必须落到里层的可编辑宿主上**：只调 `placeCaret` 不会搬焦点，
     * 键盘事件仍打在原来那个编辑器上（实测：浮层开着，字母进了正文那一行）。
     */
    host.focus()
    const textEl = host.querySelector<HTMLElement>(`.blk[data-block-id="${blockId}"] > .tx`)
    const off = point && textEl ? caretOffsetAt(this.deps.store, blockId, textEl, point) : plainLen(block.content)
    ed.placeCaret(blockId, off)
  }

  /**
   * 提交＝结束这次编辑。
   *
   * ⚠️ 顺序不能反：`close()` 会 dispose 里层编辑器（`island.ed` 变 null），
   *    先关再 `commitEdit` 就什么也不会发生——表现是「改完正文，修改时间停在上一处」。
   */
  commit(): void {
    const cur = this.cur
    if (!cur) return
    const ed = cur.island.ed
    this.close()
    ed?.commitEdit(cur.blockId)
    this.deps.onChange('text')
  }

  /** 取消＝把打开那一刻的内容写回去，然后关掉 */
  cancel(): void {
    const cur = this.cur
    if (!cur) return
    this.close()
    const block = this.deps.store.find(cur.blockId)
    if (!block) return
    const content = cur.content as Block['content']
    const modified = cur.modified
    this.deps.write((tx) =>
      tx.patch(cur.blockId, (b) => {
        b.content = content
        b.modified = modified
      }),
    )
    this.deps.onChange('text')
  }

  /** 从文档里摘掉（宿主销毁时）：不回调 `onClose`，那个格子已经跟着一起没了 */
  dispose(): void {
    const cur = this.cur
    if (!cur) return
    this.cur = null
    cur.island.dispose()
    cur.island.root.remove()
  }

  /**
   * Enter 提交、Esc 取消、其余放行。
   *
   * ⚠️ 必须 capture + stopPropagation：按键走的是 `document` 上的绑定表（bubble），
   *    不拦的话 Enter 会命中「拆块」命令——在格子里拆出一块**看不见**的块。
   */
  private bindKeys(root: HTMLElement, ed: BlockEditor, blockId: string): void {
    root.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          this.cancel()
          return
        }
        if (e.key === 'Enter') {
          if (e.isComposing || ed.probe.isComposing) return
          // ⇧↵ 换行（与正文一致）；其余 ↵ 是「敲完了」
          if (e.shiftKey) return
          e.preventDefault()
          e.stopPropagation()
          this.commit()
        }
      },
      true,
    )
    // 失焦提交：焦点挪到这一格之外（点别处 / 点另一张卡）就算编辑结束
    root.addEventListener('focusout', () => {
      window.setTimeout(() => {
        if (this.cur?.blockId !== blockId) return
        const active = document.activeElement
        if (active && root.contains(active)) return
        this.commit()
      }, 0)
    })
  }

  private close(): void {
    const cur = this.cur
    if (!cur) return
    this.cur = null
    delete cur.slot.dataset.editing
    const row = cur.slot.closest<HTMLElement>('.tv-row')
    if (row) delete row.dataset.editing
    cur.island.dispose()
    cur.island.root.remove()
    this.deps.onClose(cur.blockId)
  }
}

/**
 * 一次点击落在谁身上：引用／原子／其余。
 *
 * **其余**由调用方决定是编辑还是打开——表格是「点在标题格上就编辑」，
 * 卡片还要先看修饰键。
 */
export type CellClickHit =
  | { kind: 'ref'; hit: RefHit; el: HTMLElement }
  | { kind: 'atom'; atom: AtomHit; el: HTMLElement }
  | { kind: 'none' }

export function routeCellClick(target: HTMLElement): CellClickHit {
  const ref = target.closest<HTMLElement>('[data-ref-to]')
  if (ref?.dataset.refTo) {
    return {
      kind: 'ref',
      hit: { to: ref.dataset.refTo, ...(ref.dataset.atomId ? { runId: ref.dataset.atomId } : {}) },
      el: ref,
    }
  }
  const atom = target.closest<HTMLElement>('.atom')
  if (atom?.dataset.atomId) {
    return {
      kind: 'atom',
      atom: {
        runId: atom.dataset.atomId,
        kind: atom.dataset.atomKind ?? '',
        ...(atom.dataset.assetHash ? { hash: atom.dataset.assetHash } : {}),
      },
      el: atom,
    }
  }
  return { kind: 'none' }
}

/**
 * 把屏幕坐标翻成块内偏移（落在原子/引用上就退回末尾）。
 *
 * 表格格与卡片共用：两处各写一遍，「点到的那个字」在两边会不一样，
 * 而这种差异只在手快时看出来。
 */
export function caretOffsetAt(
  store: BlockStore,
  blockId: string,
  tx: HTMLElement,
  point: { x: number; y: number },
): number {
  const end = plainLen(store.find(blockId)?.content ?? [])
  const range = document.caretRangeFromPoint?.(point.x, point.y) ?? null
  if (!range || !tx.contains(range.startContainer)) return end
  const target = range.startContainer
  if (target.nodeType === Node.ELEMENT_NODE && (target as HTMLElement).dataset?.atomId) return end
  return offsetIn(tx, target, range.startOffset)
}

