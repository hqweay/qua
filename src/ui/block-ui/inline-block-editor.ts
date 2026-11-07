/**
 * **就地单块编辑器**：把「一张卡片的正文」直接画成一张卡里可编辑的那一行。
 *
 * 与表格的 `BlockCell` 的分工只有一条：**装在格子里，不是浮在格子上面**。
 *   · 卡片在流里、可以换行变高 ⇒ 编辑器就长在卡片里，没有「飘着的框」，
 *     点文字 → caret 落在点到的字上 → 直接打字，中途没有一次「模式切换」；
 *   · 表格行高固定、按固定行高虚拟化 ⇒ 那里仍然是贴上去的一层（见 `view-table.ts`）。
 *
 * 为什么不是「每张卡常驻一台编辑器」（外部产品的同形做法）：卡片**没有虚拟化**，
 * 500 张卡就是 500 台编辑器（每台一份 store 订阅、事件表、重载策略）——那是量级错误。
 * 这里一次只发生一张卡的编辑：点开才建、关掉就 dispose，与表格标题格同一条成本线。
 *
 * 三条会静默出错的地方，与 `BlockCell` 同源：
 *   · **↵ 是敲完了，不是拆一块**：capture 拦下，否则会在卡片里拆出一块看不见的块；
 *   · **Esc 要把打开那一刻的内容写回去**：编辑器是边打边写模型的，取消只能显式写回；
 *   · **组合期不提交**：输入法的 ↵ 是选词。
 */
import type { Block, BlockStore } from '../../core/index.ts'
import { plainLen } from '../../core/model/runs.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { offsetIn } from '../../view/editor/dom-text.ts'
import { EditableBlock } from './editable-block.ts'

export interface InlineBlockEditorDeps {
  store: BlockStore
  /** 写入事务入口（撤销条目与落盘归装配层） */
  write: Run
  /** 与正文**同一份**事件表（引用跳转、右键菜单、`#` 补全都在里面） */
  wire: (ed: BlockEditor, change: (kind: string) => void) => void
  onFocus: (ed: BlockEditor) => void
  onChange: (kind: string) => void
  /**
   * 冻结范围：正在编辑时，这一片里的外部变化**不重排**。
   * 与 `EditableBlock` 的 `area` 是同一个东西（换 DOM 会打断正在发生的事）。
   */
  area: HTMLElement
  /** 这一次编辑结束（提交或取消）之后：调用方把那一格还原成投影 */
  onClose: (blockId: string) => void
}

export class InlineBlockEditor {
  private readonly deps: InlineBlockEditorDeps
  private cur: {
    island: EditableBlock
    blockId: string
    slot: HTMLElement
    /** 打开那一刻的样子：Esc 取消要写回它 */
    content: readonly unknown[]
    modified: number
  } | null = null

  constructor(deps: InlineBlockEditorDeps) {
    this.deps = deps
  }

  /** 现在编辑的是哪一块（`null` ＝ 没在编辑） */
  get editingId(): string | null {
    return this.cur?.blockId ?? null
  }

  /**
   * 在**这一格**里打开这一块的编辑器。
   *
   * `slot` 是卡片里画正文的那一格：打开＝把投影换成编辑器（同一个盒子、同一个位置），
   * 关掉＝把编辑器摘掉、由调用方重画投影。编辑器会自己 `focus`。
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
      // 一格 ＝ 一块：它的 children 不归这里画（它们本来就不在卡里）
      initialRoots: [block],
      viewRootId: blockId,
      structuralScope: 'roots',
      // 卡片里再出现露面块也只画占位（深度 1）
      embedBodies: false,
      // 编辑器自己跟随 store 时会把正在打的字换掉；这里只由本组件决定「何时重装」，
      // 而这次编辑的生命周期只有一次编辑，根本不需要重装
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
   *    不拦的话 Enter 会命中「拆块」命令——在卡片里拆出一块**看不见**的块。
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
    cur.island.dispose()
    cur.island.root.remove()
    this.deps.onClose(cur.blockId)
  }
}

/**
 * 把屏幕坐标翻成块内偏移（落在原子/引用上就退回末尾）。
 *
 * 与表格标题格那份是同一个判据：两处各写一遍，「点到的那个字」在两边会不一样，
 * 而这种差异只在手快时看出来。图省事复用它才会把两处耦在一起——那一格是浮层、
 * 这一格在流里，位置算法相同但生命周期不同。
 */
function caretOffsetAt(
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
