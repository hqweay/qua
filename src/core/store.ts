/**
 * **共享 block store**的下一层）：块、marks、atoms、undo 都只有一份，
 * 多个 `BlockEditor` 视图读同一份数据；编辑任一实例，其他实例收到 `touch` 后重渲染。
 *
 * 为什么需要它：反链/查询视图和正文会渲染**同一个源块**。如果编辑器各持一份拷贝，
 * 两份可编辑拷贝会分叉。store 让「块」只有一份，视图只是它的投影。
 *
 * 边界：
 *   · store 在 `core/`，**零 DOM**；视图通过 `subscribe` 得到通知。
 *   · 快照是**整片森林**（blocks + marks + atoms + 一个视图的 sel）；undo 是全局的。
 *   · `touch(source)` 不通知发起者（它自己的 DOM 已经更新），只通知其他视图。
 *   · 当前是整片森林 JSON 快照；接内核后换成 Tx/Changes ＋ 增量索引。
 */
import { UndoStack, type Snap, type UndoKind } from './undo.ts'
import type { Atom, Mark } from './annotations.ts'
import type { Block } from './model.ts'
import type { Sel } from './selection.ts'

/**
 * 订阅者收到的信号。
 *
 * `ids`（可选）＝**这次动过哪些块**。查询视图靠它判断「结果里的块是不是变了」，
 * 而不是靠「store 被碰过几次」——后者会把「刷新顺带引起的重渲染」也算成过期（实测假阳性）。
 * ⚠️ 拿不到精确 id 的调用方（续用旧的 `touch(this)`）就不传，订阅者必须容忍 `ids === undefined`。
 */
export type StoreSubscriber = (source?: unknown, ids?: readonly string[]) => void

export class BlockStore {
  blocks: Block[]
  marks: Mark[]
  atoms: Atom[]
  undoStack = new UndoStack()
  private subs = new Set<StoreSubscriber>()

  constructor(blocks: Block[], marks: Mark[] = [], atoms: Atom[] = []) {
    this.blocks = blocks
    this.marks = marks
    this.atoms = atoms
  }

  subscribe(fn: StoreSubscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * 通知其他视图：源视图自己已经渲染过；`source` 不参与重渲染。
   * `ids` ＝ 这次动过的块（可选；见 `StoreSubscriber` 的说明）。
   */
  touch(source?: unknown, ids?: readonly string[]): void {
    for (const fn of this.subs) fn(source, ids)
  }

  /** 按 id 找块（整片森林；zoom 后当前对象可能在任意深度） */
  find(id: string): Block | undefined {
    const walk = (list: readonly Block[]): Block | undefined => {
      for (const b of list) {
        if (b.id === id) return b
        const inner = walk(b.children)
        if (inner) return inner
      }
      return undefined
    }
    return walk(this.blocks)
  }

  /** 整片森林 + 库级 anchors + 发起者的选区；这是 undo 的快照单位 */
  snap(sel: Sel | null): Snap {
    return {
      blocks: JSON.stringify(this.blocks),
      marks: JSON.stringify(this.marks),
      atoms: JSON.stringify(this.atoms),
      sel: JSON.stringify(sel),
    }
  }

  /**
   * 恢复快照：**原地替换** blocks/marks/atoms 的数组内容，保持数组身份
   * （编辑器持有的 `this.marks` 引用不会失效）；然后通知其他视图。
   * 返回快照里的 sel，让发起者自己恢复选区。
   */
  restore(s: Snap, source?: unknown): Sel | null {
    const blocks = JSON.parse(s.blocks) as Block[]
    this.blocks.splice(0, this.blocks.length, ...blocks)
    const marks = JSON.parse(s.marks) as Mark[]
    this.marks.splice(0, this.marks.length, ...marks)
    const atoms = JSON.parse(s.atoms) as Atom[]
    this.atoms.splice(0, this.atoms.length, ...atoms)
    this.touch(source)
    return JSON.parse(s.sel) as Sel | null
  }

  /** 演示状态整体换库：换数组引用，清 undo，通知所有视图（source 不传） */
  reset(blocks: Block[], marks: Mark[], atoms: Atom[]): void {
    this.blocks = blocks
    this.marks = marks
    this.atoms = atoms
    this.undoStack.clear()
    this.touch()
  }

  record(before: Snap, kind: UndoKind, at: number): boolean {
    return this.undoStack.record(before, kind, at)
  }

  undo(source: unknown, sel: Sel | null): Snap | null {
    const s = this.undoStack.undo(this.snap(sel))
    if (s) this.restore(s, source)
    return s
  }

  redo(source: unknown, sel: Sel | null): Snap | null {
    const s = this.undoStack.redo(this.snap(sel))
    if (s) this.restore(s, source)
    return s
  }

  /** 行内锚点整体替换（编辑器 setter 用）；原地替换保持共享数组身份 */
  replaceMarks(next: Mark[], source?: unknown): void {
    this.marks.splice(0, this.marks.length, ...next)
    this.touch(source)
  }

  replaceAtoms(next: Atom[], source?: unknown): void {
    this.atoms.splice(0, this.atoms.length, ...next)
    this.touch(source)
  }
}
