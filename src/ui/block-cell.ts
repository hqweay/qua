/**
 * **表格的标题格**：把一块画成「块的样子」，并让它在被点的时候就地变成编辑器。
 *
 * 三条口径（为什么不是 `<input>`、也不是每行一台编辑器）：
 *   · **标题列显示的是正文**（run 序列）：marks、行内引用、图片原子都在。
 *     用纯文本投影就等于在表里丢掉一半内容，而用户会以为「这些格式没了」。
 *   · **一台编辑器，按需开**：点普通文字才开、贴在格子上、失焦/Enter 提交、Esc 取消。
 *     每行常驻一台的代价是 DOM 与订阅按行数增长（5k 行 = 5k 台编辑器），
 *     而且每台都要维护自己的重载节奏 —— 那是量级错误，不是实现细节。
 *   · **格子里的引用/原子仍走 `data-ref-to`**：点它们先导航（左键/Shift/⌥），
 *     不和「点文字进编辑」抢同一个点击。
 *
 * ⚠️ 浮层是 `position: fixed` 贴在格子的屏幕矩形上：不参与表格布局 ⇒ 行高不变、
 *    窗口化不会被它打断。代价是滚动/改窗口尺寸时锚点会跑 —— 所以那两种事件直接提交并关掉。
 */
import { plainLen } from '../core/runs.ts'
import type { Block, BlockStore } from '../core/index.ts'
import { t } from '../core/msg.ts'
import { EditableBlock } from './editable-block.ts'
import type { Run, BlockEditor } from '../view/editor.ts'
import { offsetIn } from '../view/dom-text.ts'

export interface RefHit {
  to: string
  runId?: string
}

export interface AtomHit {
  runId: string
  kind: string
  hash?: string
}

export interface CellClickMods {
  altKey: boolean
  shiftKey: boolean
}

export interface BlockCellDeps {
  store: BlockStore
  /** 写入事务入口（装配层注入） */
  write: Run
  /** 与正文**同一份**事件表（引用跳转、右键菜单、`#` 补全都在里面） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  /** 焦点进里层编辑器 ⇒ 装配层把「活动编辑器」切过来（键位走命令层） */
  onFocus: (ed: BlockEditor) => void
  /** 编辑发生（落盘、别的视图重画） */
  onChange: (kind: string) => void
  /**
   * **投影**：把这一块的正文画进一个容器。
   * 由装配层注入 —— `ui` 不拿整片森林，而投影需要「引用目标当前叫什么、图在哪」。
   */
  project: (block: Block, into: HTMLElement) => void
  refClick: (hit: RefHit, el: HTMLElement, mods: CellClickMods) => void
  onAtomClick?: (atom: AtomHit, el: HTMLElement, mods: CellClickMods) => void
  /** 行首块标 / 紧凑列表里的一行：打开这一块（换中心） */
  openBlock: (blockId: string) => void
}

/** 标题格的类名（表格与紧凑列表共用；CSS 只需认这一个） */
const CELL_CLASS = 'tv-title-inner'

export class BlockCell {
  private readonly deps: BlockCellDeps
  /** 浮层（同时只有一台；`null` ＝ 没在编辑） */
  private overlay: {
    root: HTMLElement
    island: EditableBlock
    blockId: string
    /** 打开那一刻的样子：Esc 取消要写回它 */
    content: readonly unknown[]
    modified: number
  } | null = null
  /** 浮层贴着的那一格（滚动/改尺寸之后按它**现取**矩形，不记快照） */
  private anchorEl: HTMLElement | null = null
  /** 重贴排过队（rAF 只排一次：滚动事件一秒几十次，每次重排是白烧） */
  private refixQueued = false
  private readonly offScroll: () => void

  constructor(deps: BlockCellDeps) {
    this.deps = deps
    /**
     * **锚点是「取矩形的函数」而不是快照**：滚动、改窗口尺寸之后格子的屏幕位置会变，
     * 记下来的矩形会让浮层飘到别处。这里在每次滚动/改尺寸之后**重新贴一次**；
     * 格子已经从 DOM 里摘掉（换视图 / 换页）才提交并关掉。
     */
    const refix = (): void => {
      if (!this.overlay) return
      if (this.refixQueued) return
      this.refixQueued = true
      requestAnimationFrame(() => {
        this.refixQueued = false
        const cur = this.overlay
        const el = this.anchorEl
        if (!cur) return
        if (!el || !el.isConnected) {
          this.commit()
          return
        }
        this.place(el, cur.root)
      })
    }
    window.addEventListener('scroll', refix, true)
    window.addEventListener('resize', refix)
    this.offScroll = () => {
      window.removeEventListener('scroll', refix, true)
      window.removeEventListener('resize', refix)
    }
  }

  /** 把浮层贴在某一格的当前矩形上（不改行高：fixed 不参与表格布局） */
  private place(cell: HTMLElement, root: HTMLElement): void {
    const rect = cell.getBoundingClientRect()
    root.style.left = `${rect.left}px`
    root.style.top = `${rect.top}px`
    root.style.width = `${Math.max(160, rect.width)}px`
  }

  /** 正在编辑的那一块（窗口化用它钉住 / 冻结窗口，见 `view-table.ts`） */
  get editingId(): string | null {
    return this.overlay?.blockId ?? null
  }

  /**
   * 画一个标题格（**投影，不是输入框**）。
   *
   * 点一次只做一件事：点在引用/原子上 ⇒ 交给装配层导航；点在文字上 ⇒ 开编辑器。
   */
  render(block: Block, into: HTMLElement): void {
    into.replaceChildren()
    into.classList.add(CELL_CLASS)
    into.dataset.titleFor = block.id
    into.title = t('ui.view.editTitle')
    const inner = document.createElement('span')
    inner.className = 'tv-title-text'
    this.deps.project(block, inner)
    into.appendChild(inner)
    // 空块也要有可见的落点（否则那一行看起来是「没有内容」，而不是「可以写」）
    if (inner.childNodes.length === 0) inner.appendChild(document.createElement('br'))
  }

  /** 行首块标：打开这一块（与正文里点块标同一条命令） */
  readonly openBlock = (blockId: string): void => {
    this.deps.openBlock(blockId)
  }

  /**
   * 点标题格：先看是不是引用/原子（导航），不是才进编辑。
   *
   * ⚠️ 判据用 `closest('[data-ref-to]')` 而不是「点在 `.tv-title-text` 里」：
   *    格子里除了文字还有原子与 chip，它们的职责是「指向别处」。
   */
  handleClick(blockId: string, target: HTMLElement, mods: CellClickMods, point?: { x: number; y: number }): void {
    const ref = target.closest<HTMLElement>('[data-ref-to]')
    if (ref?.dataset.refTo) {
      this.deps.refClick({ to: ref.dataset.refTo, ...(ref.dataset.atomId ? { runId: ref.dataset.atomId } : {}) }, ref, mods)
      return
    }
    const atom = target.closest<HTMLElement>('.atom')
    if (atom?.dataset.atomId) {
      this.deps.onAtomClick?.(
        {
          runId: atom.dataset.atomId,
          kind: atom.dataset.atomKind ?? '',
          ...(atom.dataset.assetHash ? { hash: atom.dataset.assetHash } : {}),
        },
        atom,
        mods,
      )
      return
    }
    const cell = target.closest<HTMLElement>(`.${CELL_CLASS}`)
    if (!cell) return
    this.edit(blockId, cell, point)
  }

  /**
   * 打开这一行的单块编辑器，贴在标题格上。
   *
   * `point` 是点击位置：有它就把光标落在**点到的那个字**上（用户点的哪里就从哪里写），
   * 没有就落在末尾（键盘/块标过来的路径）。
   */
  edit(blockId: string, cell: HTMLElement, point?: { x: number; y: number }): void {
    if (this.overlay?.blockId === blockId) return
    this.commit()
    const block = this.deps.store.find(blockId)
    if (!block) return
    const root = document.createElement('div')
    root.className = 'tv-edit'
    root.dataset.blockId = blockId
    root.contentEditable = 'false'
    const host = document.createElement('div')
    host.className = 'tv-edit-host'
    // 贴在格子上（fixed ⇒ 不参与布局、行高不变）
    this.place(cell, root)
    document.body.appendChild(root)

    const island = new EditableBlock({
      host,
      store: this.deps.store,
      write: this.deps.write,
      // 只装这一块：它的 children 不归这里画（它们本来就不在表里）
      initialRoots: [block],
      viewRootId: blockId,
      // 编辑器自己跟随 store 时会把正在打的字换掉；这里只由本组件决定「何时重装」——
      // 而浮层的寿命只有一次编辑，根本不需要重装
      load: () => {},
      wire: (ed, change) => this.deps.wire(ed, change),
      onChange: (kind) => this.deps.onChange(kind),
      onFocus: (ed) => this.deps.onFocus(ed),
      area: root,
    })
    const ed = island.ensureEditor()
    // ⚠️ 必须先挂进文档再聚焦：`EditableBlock` 把 host 挪进自己的岛根，
    //    岛根不接上 DOM 的话，`focus()` 是一个空操作 —— 键盘继续打在原来那个编辑器上
    root.appendChild(island.root)
    this.overlay = { root, island, blockId, content: block.content, modified: block.modified }
    this.anchorEl = cell
    this.bindKeys(root, ed, blockId)
    /**
     * **焦点必须落到里层的可编辑宿主上**（`host` 就是 BlockEditor 的 container）。
     * 只调 `placeCaret` 不会搬焦点：选区建好了，键盘事件却仍打在原来那个编辑器上
     * （实测：浮层开着，字母进了正文那一行）。
     */
    host.focus()
    const textEl = host.querySelector<HTMLElement>(`.blk[data-block-id="${blockId}"] > .tx`)
    const off = point && textEl ? this.offsetAt(textEl, point) : plainLen(block.content)
    ed.placeCaret(blockId, off)
    this.paintAnchor(true)
  }

  /** 把屏幕坐标翻成块内偏移（落在原子/引用上就退回末尾 —— 那些位置不是文本插入点） */
  private offsetAt(tx: HTMLElement, point: { x: number; y: number }): number {
    const end = plainLen(this.deps.store.find(tx.closest<HTMLElement>('.blk')?.dataset.blockId ?? '')?.content ?? [])
    const range = document.caretRangeFromPoint?.(point.x, point.y) ?? null
    if (!range || !tx.contains(range.startContainer)) return end
    const target = range.startContainer
    if (target.nodeType === Node.ELEMENT_NODE && (target as HTMLElement).dataset?.atomId) return end
    return offsetIn(tx, target, range.startOffset)
  }

  /**
   * Enter 提交、Esc 取消、其余放行。
   *
   * ⚠️ **必须 capture + stopPropagation**：按键走的是 `document` 上的绑定表（bubble），
   *    不拦的话 Enter 会命中「拆块」命令 —— 在浮层里拆出一块**看不见**的块。
   * ⚠️ 组合期的 Enter 是输入法的「选词」，不是提交。
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
          if (ed.probe.isComposing) return
          e.preventDefault()
          e.stopPropagation()
          this.commit()
        }
      },
      true,
    )
    // 失焦提交：焦点挪到浮层之外（点别处 / Tab 走）就算编辑结束
    root.addEventListener('focusout', () => {
      window.setTimeout(() => {
        const active = document.activeElement
        if (this.overlay?.root !== root) return
        if (active && root.contains(active)) return
        this.commit()
      }, 0)
    })
    void blockId
  }

  /**
   * 提交＝结束这次编辑。
   *
   * ⚠️ **顺序不能反**：`close()` 会 dispose 里层编辑器（`EditableBlock.ed` 变 null），
   *    先关再 `commitEdit` 就什么也不会发生 —— 表现是「改完正文，修改时间停在上一处」，
   *    而且不会有任何报错。提交也算一次「值变了」⇒ 通知装配层落盘与重画。
   */
  commit(): void {
    const cur = this.overlay
    if (!cur) return
    const ed = cur.island.ed
    this.close()
    ed?.commitEdit(cur.blockId)
    this.deps.onChange('text')
  }

  /**
   * 取消＝把打开那一刻的内容写回去，然后关掉。
   *
   * ⚠️ 为什么不是「不提交就没事」：编辑器是**边打边写**模型的（与正文同一条输入路径），
   *    所以在 Esc 这一刻模型里已经是新内容。取消只能显式写回 —— 一笔 op、可撤销，
   *    与「打字也是一笔」是同一套账。
   */
  cancel(): void {
    const cur = this.overlay
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

  dispose(): void {
    this.close()
    this.offScroll()
  }

  private close(): void {
    const cur = this.overlay
    this.overlay = null
    this.paintAnchor(false)
    this.anchorEl = null
    if (!cur) return
    cur.island.dispose()
    cur.root.remove()
  }

  private paintAnchor(on: boolean): void {
    const el = this.anchorEl
    if (!el) return
    if (on) el.dataset.editing = '1'
    else delete el.dataset.editing
  }
}
