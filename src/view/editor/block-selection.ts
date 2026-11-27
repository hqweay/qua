/**
 * 块级选区：**跨块选中一段**（⌘A／Shift+↑↓／鼠标拖过块边界）。
 *
 * 从 BlockEditor 拆出的协作对象：自有状态只有 `blockSel`／`mouseSel` 两个，
 * 其余一律经 `ed`（doc／模型选区／渲染／事务）——它没有自己的不变量，
 * 「只选可见行」「删只删最上层根」都是编辑器口径的投影，不另立第二份。
 */
import { flatten, isJournalBlock, isPropDefBlock, locate, plainLen, walkForest, type Block, type Located } from '../../core/index.ts'
import type { BlockEditor } from './editor.ts'
import { copyTextOfBlock } from './copy-text.ts'

/**
 * 一行能不能成为整块操作的对象，与它能不能落光标是两件事。
 * 只读抬头、带身体的块、当前屏的根都可选；只有日期投影和字段定义的名字是不可操作的显示面。
 */
function selectable(b: Block): boolean {
  return !isJournalBlock(b) && !isPropDefBlock(b)
}

export interface BlockSel {
  ids: string[]
  anchor: string
}

export class BlockSelection {
  blockSel: BlockSel | null = null
  mouseSel: { startId: string; active: boolean } | null = null

  constructor(private readonly ed: BlockEditor) {}

  hasBlockSelection(): boolean {
    return this.blockSel !== null && this.blockSel.ids.length > 0
  }

  blockSelectionCount(): number {
    return this.blockSel?.ids.length ?? 0
  }

  blockSelectionIds(): string[] {
    return this.blockSel ? [...this.blockSel.ids] : []
  }

  /**
   * 拖拽用：选中块的**最上层根**（祖先也在选区里 ⇒ 只留祖先，避免父子被搬两次）。
   * 这是「一次搬一组」的唯一清单；派生面（查询结果/镜像）的根不在选区里，天然排除。
   */
  selectedRootIds(): string[] {
    return this.blockSelRoots().map((b) => b.id)
  }

  inBlockSelection(id: string): boolean {
    return Boolean(this.blockSel?.ids.includes(id))
  }

  /** 这一屏里可以整块操作的可见行（折叠子树不出现；根与只读抬头照常可选） */
  private visibleIds(): string[] {
    return this.ed
      .rows()
      .filter((r) => selectable(r.block))
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

  /** 全选块：与键盘、拖选共用同一份对象判据，只有不可操作投影不参与 */
  selectAllBlocks(): boolean {
    const ids = this.ed
      .rows()
      .filter((r) => selectable(r.block))
      .map((r) => r.block.id)
    if (ids.length === 0) return false
    this.blockSel = { ids, anchor: ids[0]! }
    this.ed.sel = null
    document.getSelection()?.removeAllRanges()
    this.ed.markCaret()
    this.paintBlockSel()
    this.ed.events.selChange?.()
    return true
  }

  /**
   * `Esc`：把光标所在块整块选中（块选区的键盘入口；已有块选区时由清空那条先接）。
   *
   * 与「全选块」同一份可选择性判据：只有不可操作投影排除，当前屏的根与只读抬头照常可选。
   * 不在可见行里的块也不选——块选区是「这一屏的可见行」的区间，选中看不见的行画不出来。
   */
  selectCurrentBlock(): boolean {
    if (this.blockSel) return false
    const id = this.ed.sel?.aBlock
    if (!id || !this.visibleIds().includes(id)) return false
    this.blockSel = { ids: [id], anchor: id }
    this.ed.sel = null
    document.getSelection()?.removeAllRanges()
    this.ed.markCaret()
    this.paintBlockSel()
    this.ed.events.selChange?.()
    return true
  }

  clearBlockSelection(): void {
    if (!this.blockSel) return
    this.blockSel = null
    this.paintBlockSel()
    this.ed.events.selChange?.()
  }

  /** 由显式 id 建块选区：岛界交回外层时用，判据与键盘/拖选同一份可见行集合 */
  selectIds(ids: readonly string[], anchor?: string): boolean {
    const visible = new Set(this.visibleIds())
    const valid = ids.filter((id) => visible.has(id))
    if (valid.length === 0) return false
    const a = anchor && valid.includes(anchor) ? anchor : valid[0]!
    this.blockSel = { ids: valid, anchor: a }
    this.ed.sel = null
    document.getSelection()?.removeAllRanges()
    this.ed.markCaret()
    this.paintBlockSel()
    this.ed.events.selChange?.()
    return true
  }

  /** Enter：清块选区，光标落到**首个选中块**的 0 位，不建块 */
  focusFirstSelected(): boolean {
    const first = this.blockSel?.ids[0]
    if (!first) return false
    this.blockSel = null
    this.paintBlockSel()
    this.ed.placeCaret(first, 0)
    this.ed.events.selChange?.()
    return true
  }

  /**
   * `Shift+↑/↓` 的边界规则：
   * - 已有块选区 ⇒ 在**移动端**扩展一块（锚块那一端不动）；
   * - 否则只有 caret 在**块文本首/尾**时才起块选区；文本内部返回 false（让原生文本选区接手）。
   */
  extendBlockSelection(dir: -1 | 1): boolean {
    const ids = this.visibleIds()
    if (this.blockSel) {
      const { ids: selIds, anchor } = this.blockSel
      /**
       * 移动端＝**锚块的另一端**：与文本选区同构——锚（起点）不动，⇧↑/⇧↓ 都在另一端生长与收缩。
       * 若按方向选端（过去那版），向下扩两格后再 ⇧↑ 会从锚块那端往上挪，退不回来
       * （锚块已在首位时更是一个键按下去毫无反应）；向上扩同理。
       * 锚块落在中间不是本类会产生形状，仍按方向兜底。
       */
      const movingEnd =
        selIds[0] === anchor
          ? selIds[selIds.length - 1]
          : selIds[selIds.length - 1] === anchor
            ? selIds[0]
            : dir > 0
              ? selIds[selIds.length - 1]
              : selIds[0]
      const ei = movingEnd ? ids.indexOf(movingEnd) : -1
      if (ei < 0) return false
      const ni = ei + dir
      if (ni < 0 || ni >= ids.length) return false
      const next = this.blockRange(anchor, ids[ni]!)
      if (next.length === 0) return false
      this.blockSel = { ids: next, anchor }
      this.ed.sel = null
      document.getSelection()?.removeAllRanges()
      this.paintBlockSel()
      this.ed.events.selChange?.()
      return true
    }
    const s = this.ed.sel
    if (!s || s.aBlock !== s.hBlock || s.aOff !== s.hOff) return false
    const loc = locate(this.ed.doc, s.aBlock)
    if (!loc || !selectable(loc.block)) return false
    const len = plainLen(loc.block.content)
    const off = Math.max(0, Math.min(s.aOff, len))
    if (dir > 0 ? off !== len : off !== 0) return false
    this.blockSel = { ids: [s.aBlock], anchor: s.aBlock }
    this.ed.sel = null
    document.getSelection()?.removeAllRanges()
    this.paintBlockSel()
    this.ed.events.selChange?.()
    return true
  }

  /** 相邻行自己有可写正文槽、且不是这一屏的装载根 ⇒ 浏览器能把光标落进去，方向键仍归原生 */
  private caretReachable(id: string): boolean {
    const loc = locate(this.ed.doc, id)
    if (!loc || loc.parent === null) return false
    const tx = this.ed.blockEl(id)?.querySelector<HTMLElement>(':scope > .tx')
    return Boolean(tx && tx.isContentEditable && getComputedStyle(tx).display !== 'none')
  }

  /**
   * 方向键越过文本边界：只有相邻块不可落光标时才选中相邻可见行。
   * 普通正文之间仍走原生光标移动，不打断「往下继续打字」；已有单块选区时 ↑/↓ 逐行移动。
   */
  moveAdjacentBlock(dir: -1 | 1): boolean {
    if (this.blockSel && this.blockSel.ids.length !== 1) return false
    if (!this.blockSel) {
      const s = this.ed.sel
      if (!s || s.aBlock !== s.hBlock || s.aOff !== s.hOff) return false
      const loc = locate(this.ed.doc, s.aBlock)
      if (!loc || !selectable(loc.block)) return false
      const len = plainLen(loc.block.content)
      const off = Math.max(0, Math.min(s.aOff, len))
      if (dir > 0 ? off !== len : off !== 0) return false
    }
    const ids = this.visibleIds()
    const currentId = this.blockSel?.ids[0] ?? this.ed.sel!.aBlock
    const next = ids[ids.indexOf(currentId) + dir]
    if (!next) return false
    if (!this.blockSel && this.caretReachable(next)) return false
    this.blockSel = { ids: [next], anchor: next }
    this.ed.sel = null
    document.getSelection()?.removeAllRanges()
    this.ed.markCaret()
    this.paintBlockSel()
    this.ed.events.selChange?.()
    return true
  }

  /**
   * 鼠标拖选的起点：**在 `.tx` 内按下**时调用。
   * - Shift：清块选区，交给原生文本选择（**我们的增量**：纯文本编辑器的选区跨不了块）；
   * - 否则进入 pending：**只有拖过块边界**才切成块选区（单块内拖仍是文本）。
   */
  beginMouseSelect(id: string, _x: number, _y: number, shiftKey: boolean): void {
    const loc = locate(this.ed.doc, id)
    if (!loc || !selectable(loc.block)) return
    this.clearBlockSelection()
    // 旧的原生文本选区必须先清掉：否则从选区里按下会触发浏览器的“拖拽选中文本”，
    // 后续 mousemove 变成 DnD、块选区永远起不来（本机探针复现）。
    if (!shiftKey) {
      document.getSelection()?.removeAllRanges()
      this.ed.sel = null
      this.ed.markCaret()
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
      this.ed.container.classList.add('blocksel-drag')
      this.ed.sel = null
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
    this.ed.container.classList.remove('blocksel-drag')
    if (d?.active) {
      this.paintBlockSel()
      this.ed.events.selChange?.()
    }
  }

  /** 选中块的**最上层根**（祖先也在选区内 ⇒ 只留祖先，避免删父又删子） */
  private blockSelRoots(): Block[] {
    const set = new Set(this.blockSel?.ids ?? [])
    return flatten(this.ed.doc).filter((b) => {
      if (!set.has(b.id)) return false
      let p = locate(this.ed.doc, b.id)?.parent ?? null
      while (p) {
        if (set.has(p.id)) return false
        p = locate(this.ed.doc, p.id)?.parent ?? null
      }
      return true
    })
  }

  /** 删除选中的块（一次撤销；子树随块走；section 根不删） */
  deleteSelectedBlocks(): boolean {
    const roots = this.blockSelRoots().filter((b) => locate(this.ed.doc, b.id)?.parent !== null)
    if (roots.length === 0) return false
    this.ed.beginUndoEntry()
    const flat = flatten(this.ed.doc)
    const firstIdx = Math.min(...roots.map((b) => flat.findIndex((x) => x.id === b.id)))
    // 落点先算好再动手：删除进行中再 locate，读的是一棵已经少了几块的树
    const targets = [...roots]
      .reverse()
      .map((b) => locate(this.ed.doc, b.id))
      .filter((l): l is Located & { parent: Block } => Boolean(l && l.parent !== null))
    // 每棵子树逐块 `block.delete`（级联是落库实现的事，op 序列要说得清删了哪些块）
    this.ed.write((tx) => {
      for (const loc of targets) tx.remove(loc.block.id)
    })
    this.ed.finishUndoEntry('structural')
    this.blockSel = null
    this.mouseSel = null
    this.ed.container.classList.remove('blocksel-drag')
    this.paintBlockSel()
    this.ed.renderAll()
    const after = flatten(this.ed.doc)
    const caret = after[Math.min(Math.max(0, firstIdx), after.length - 1)]
    if (caret) this.ed.placeCaret(caret.id, 0)
    this.ed.emitChange('struct')
    return true
  }

  /** 批量缩进（Tab）：只动最上层根，子树随块走；一笔撤销；选区保持 */
  indentSelectedBlocks(): boolean {
    const ok = this.ed.struct.indentMany(this.blockSelRoots().map((b) => b.id))
    if (ok) this.paintBlockSel()
    return ok
  }

  /** 批量反缩进（Shift+Tab）：同上，逆序处理保持原有次序 */
  outdentSelectedBlocks(): boolean {
    const ok = this.ed.struct.outdentMany(this.blockSelRoots().map((b) => b.id))
    if (ok) this.paintBlockSel()
    return ok
  }

  /** 批量切换待办：每块按自己的字段翻值，一笔撤销；选区保持 */
  toggleClosureSelectedBlocks(): boolean {
    const ok = this.ed.toggleClosureMany(this.blockSelRoots().map((b) => b.id))
    if (ok) this.paintBlockSel()
    return ok
  }

  /** 选中的块 → 大纲文本（缩进 2 空格；代码块带身体，露面只给引用；子树随块走） */
  selectedBlocksText(): string {
    const roots = this.blockSelRoots()
    if (roots.length === 0) return ''
    const lines: string[] = []
    walkForest(roots, (b, ctx) => {
      lines.push(`${'  '.repeat(ctx.path.length - 1)}${copyTextOfBlock(b, (id) => this.ed.store.find(id))}`)
    })
    return lines.join('\n')
  }

  /** 把 `data-blocksel` 刷到当前挂载的 `.blk` 上（虚拟化下只染已挂载行） */
  /** 编辑器在每次重排收尾都要重染（渲染归编辑器，漆层归这里） */
  paintBlockSel(): void {
    const sel = new Set(this.blockSel?.ids ?? [])
    for (const el of this.ed.container.querySelectorAll<HTMLElement>('.blk')) {
      const id = el.dataset.blockId
      if (id && sel.has(id)) el.dataset.blocksel = '1'
      else delete el.dataset.blocksel
    }
  }
}
