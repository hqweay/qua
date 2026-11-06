/**
 * 块拖拽：从编辑器里拖一块、落在另一块的前/后/里。
 *
 * 从 BlockEditor 拆出的协作对象：自有状态只有 `dragId`／`dropEl`（正在拖谁、
 * 高亮落点在哪个元素），落点判定与搬移都经 `ed`——`dropMove`／`dropMoveExternal`
 * 是 core 的纯函数，落手统一走 `structuralMove` 一条路，这里不发明第二条。
 */
import { locate, dropMove, dropMoveExternal } from '../../core/index.ts'
import type { BlockEditor } from './editor.ts'

/** 落点三态（与事件层 `showDropTarget`／`dropDrag` 的同一份形状） */
type DropZone = 'before' | 'after' | 'inside'

export class Drag {
  private dragId: string | null = null
  /** 这一次拖的**整组**（多选时是一组最上层根；单选时只有一个） */
  private dragIds: readonly string[] = []
  private dropEl: HTMLElement | null = null

  constructor(private readonly ed: BlockEditor) {}

  /** 有没有正在进行的拖拽（此刻的 DOM 选区不是插入点，reclaimCaret 据此让路） */
  get active(): boolean {
    return this.dragId !== null
  }

  begin(id: string): void {
    /**
     * **拖动多选里的一块＝拖动整组**：选区是一次显式的「这组东西」；
     * 从其中任一行的块标起拖，都不该只搬走按下的那一块。
     * 按下的块不在选区里 ⇒ 这是一次新的单块拖拽，先把旧选区清掉（否则屏幕上还亮着一组，
     * 实际上只搬走一块）。
     */
    const grouped = this.ed.bsel.hasBlockSelection() && this.ed.bsel.inBlockSelection(id)
    const roots = grouped ? this.ed.bsel.selectedRootIds() : []
    if (!grouped && this.ed.bsel.hasBlockSelection()) this.ed.bsel.clearBlockSelection()
    this.dragId = id
    this.dragIds = roots.length > 0 ? roots : [id]
    this.ed.container.classList.add('dragging')
    for (const x of this.dragIds) this.ed.blockEl(x)?.classList.add('drag-src')
  }

  showDropTarget(el: HTMLElement | null, zone: DropZone | null): void {
    this.setDropEl(el)
    if (!el) {
      this.ed.container.classList.add('drop-end')
      return
    }
    this.ed.container.classList.remove('drop-end')
    if (zone) el.dataset.drop = zone
  }

  drop(draggedId: string | null, targetId: string | null, zone: DropZone): void {
    const id = draggedId
    if (!id) return
    /**
     * **整组拖拽**：多选时 `dragIds` 是那一组最上层根，落手走编辑器的批量落点。
     * 组里的块全在本 doc 里（选区只收可见行），所以不走跨容器那一支。
     */
    if (this.dragIds.length > 1) {
      const group = [...this.dragIds]
      this.end()
      this.ed.moveBlocksTo(group, targetId, zone)
      return
    }
    const loc = locate(this.ed.doc, id)
    if (!loc) {
      // 别的露面拖来的块：store 现取本体，落点走跨容器口径（守卫在那边各归各位）
      const dragged = this.ed.store.find(id)
      if (!dragged) return
      const plan = dropMoveExternal(this.ed.doc, dragged, targetId, zone)
      this.end()
      this.ed.structuralMove(id, plan, {
        unfoldId: zone === 'inside' ? (plan?.parentId ?? null) : null,
        caretAt: { id, off: 0 },
      })
      return
    }
    // 段根（页／天／查询记录）不是内容块：不参与拖拽。
    // 日记流的分段顺序是真实日期序，查询列表是视图序——都不是「可拖的兄弟序」。
    if (loc.parent === null) return
    /**
     * 落点只由 `dropMove` 算（空白处算「最后一个根的最后一位」）。
     * 目标若也是段根，只接受 inside —— before/after 会给它造出一个没有家的兄弟。
     */
    if (targetId) {
      const targetLoc = locate(this.ed.doc, targetId)
      if (!targetLoc || (targetLoc.parent === null && zone !== 'inside')) {
        this.end()
        return
      }
    }
    const plan = dropMove(this.ed.doc, id, targetId, zone)
    this.end()
    this.ed.structuralMove(id, plan, {
      unfoldId: zone === 'inside' ? (plan?.parentId ?? null) : null,
      caretAt: { id, off: this.ed.sel?.aOff ?? 0 },
    })
  }

  end(): void {
    const ids = this.dragIds
    this.dragId = null
    this.dragIds = []
    this.ed.container.classList.remove('dragging', 'drop-end')
    if (this.dropEl) delete this.dropEl.dataset.drop
    this.dropEl = null
    for (const el of Array.from(this.ed.container.querySelectorAll<HTMLElement>('.blk[data-drop]'))) delete el.dataset.drop
    for (const x of ids) this.ed.blockEl(x)?.classList.remove('drag-src')
  }

  private setDropEl(el: HTMLElement | null): void {
    if (this.dropEl && this.dropEl !== el) delete this.dropEl.dataset.drop
    this.dropEl = el
  }
}
