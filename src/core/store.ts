/**
 * **共享 block store**：块（含行内内容与 annos）、undo 只有一份，
 * 多个 `BlockEditor` 视图读同一份数据；编辑任一实例，其他实例收到 `touch` 后重渲染。
 *
 * 为什么需要它：反链/查询视图和正文会渲染**同一个源块**。如果编辑器各持一份拷贝，
 * 两份可编辑拷贝会分叉。store 让「块」只有一份，视图只是它的投影。
 *
 * 边界：
 *   · store 在 `core/`，**零 DOM**；视图通过 `subscribe` 得到通知。
 *   · 快照是**整片森林**（blocks ＋ 一个视图的 sel）；undo 是全局的。
 *     行内内容与 annos 住块上 ⇒ 快照天然带全它们，没有第二份要拼装。
 *   · `touch(source)` 不通知发起者（它自己的 DOM 已经更新），只通知其他视图。
 *   · 当前是整片森林 JSON 快照；接内核后换成 Tx/Changes ＋ 增量索引。
 */
import { UndoStack, type Snap, type UndoKind } from './undo.ts'
import type { Block } from './model.ts'
import type { Op } from './kb/types.ts'
import type { Sel } from './selection.ts'
import { applyOps as patchIndex, lookupBlock, rebuild, type Index } from './index-port.ts'

/**
 * 订阅者收到的信号。
 *
 * `ids`（可选）＝**这次动过哪些块**。查询视图靠它判断「结果里的块是不是变了」，
 * 而不是靠「store 被碰过几次」——后者会把「刷新顺带引起的重渲染」也算成过期（实测假阳性）。
 * ⚠️ 拿不到精确 id 的调用方（续用旧的 `touch(this)`）就不传，订阅者必须容忍 `ids === undefined`。
 */
/**
 * `forestReplaced` ＝ **整片森林被换掉了**（undo/redo：`restore` 里 `blocks` 数组原地换内容
 * ⇒ 各视图手里那批块对象**当场过期**，只有按 id 重取才能看到新值）。
 *
 * 为什么订阅者需要知道它：编辑器有一条「焦点在里层编辑岛时不搬 DOM」的推迟策略
 * （防打断里层输入），但那条是为**打字**准备的。森林整体被换掉时推迟是错的——
 * 用户按了 ⌘Z，正文却停在旧内容上、直到焦点离开挂载区才补（实测：1.2 秒都不刷）。
 */
export type StoreSubscriber = (source?: unknown, ids?: readonly string[], forestReplaced?: boolean) => void

export class BlockStore {
  blocks: Block[]
  undoStack = new UndoStack()
  private subs = new Set<StoreSubscriber>()
  /**
   * **派生索引**（懒重建）：`null` ＝ 已失效，下次访问时从当前 `blocks` 重算一遍。
   *
   * 为什么挂在 store 上：它是**共享数据**的唯一持有者，多个视图读同一份；
   * 索引挂在别处就会出现「两个视图拿着不同代的索引」。
   * 为什么是懒的：一次渲染里会问很多次「这个 id 是哪块」，重建一次摊到所有查询上；
   * 每次改动都立刻重建则把成本提前到了**输入路径**上（打字时卡）。
   */
  private idx: Index | null = null

  constructor(blocks: Block[]) {
    this.blocks = blocks
  }

  subscribe(fn: StoreSubscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * 通知其他视图：源视图自己已经渲染过；`source` 不参与重渲染。
   * `ids` ＝ 这次动过的块（可选；见 `StoreSubscriber` 的说明）。
   *
   * ⚠️ touch 会**作废索引**（保守：调用方没说索引还准不准）；
   *    写入方已经按 op 修补过索引时（`kb.tx` 的唯一出口）用 `notify` ——
   *    作废会让那次修补白做，每次写入都退化成全量重建。
   */
  notify(source?: unknown, ids?: readonly string[], forestReplaced = false): void {
    for (const fn of this.subs) fn(source, ids, forestReplaced)
  }

  touch(source?: unknown, ids?: readonly string[], forestReplaced = false): void {
    // 一切模型变化都会走到这里（编辑器的 `emitChange` 是唯一出口）⇒ 索引在这里失效最省事，
    // 也最不容易漏：让「改数据」与「索引可能过期」这一对事实**绑在同一个调用上**。
    this.invalidateIndex()
    this.notify(source, ids, forestReplaced)
  }

  /**
   * 索引（**懒重建**）。任何改动之后第一次访问会重算一次，之后所有查询共用。
   *
   * ⚠️ 索引存的是块的**活引用**：`find` 拿到的就是 store 里那一块，改名/改字立刻可见；
   *    但**名字表**（标签名→id、日期→id）是快照 ⇒ 改名后必须让索引失效（见 `invalidate`）。
   */
  get index(): Index {
    this.idx ??= rebuild(this.blocks)
    return this.idx
  }

  /**
   * 让索引失效（下次访问时重建）。
   *
   * ⚠️ **改了 `blocks` 就必须调它**。`touch()` 已经带了（那是编辑器的写入出口），
   *    但还有一条旁路：**命令直接把森林改了**（新建页 / 删页 / 往森林根 push 标签块），
   *    然后调 `loadPage` 换视图 —— 那条路不发 `touch`，索引就会停在旧库上。
   *    实测代价：删掉一页后，引用它的 chip 仍然显示 resolved（真踩到过）。
   *    接 Tx/Changes 之后，「所有写入经一个入口」会让这条规则自动成立。
   */
  invalidateIndex(): void {
    this.idx = null
  }

  /**
   * 一批 op 之后**增量修补**索引（`kb.tx` 成功后的唯一调用方）。
   *
   * 索引若已失效（先被旁路写入作废过），`index` getter 会先全量重建一遍再修补 ——
   * 一次性成本，结果不变。等式「修补 == 重建」由 `tests/index-port.test.ts` 钉住。
   */
  applyOps(ops: readonly Op[]): void {
    patchIndex(this.index, ops, this.blocks)
  }

  /** 按 id 找块（整片森林；zoom 后当前对象可能在任意深度）—— 走索引，O(1) */
  find(id: string): Block | undefined {
    return lookupBlock(this.index, id)
  }

  /** 整片森林 ＋ 发起者的选区；这是 undo 的快照单位（行内内容住块上，随块走） */
  snap(sel: Sel | null): Snap {
    return {
      blocks: JSON.stringify(this.blocks),
      sel: JSON.stringify(sel),
    }
  }

  /**
   * 恢复快照：**原地替换** blocks 的数组内容，保持数组身份
   * （编辑器手里的引用不会失效）；然后通知其他视图。
   * 返回快照里的 sel，让发起者自己恢复选区。
   */
  restore(s: Snap, source?: unknown): Sel | null {
    const blocks = JSON.parse(s.blocks) as Block[]
    this.blocks.splice(0, this.blocks.length, ...blocks)
    // ⚠️ 数组身份保住、但**块对象是新的** ⇒ 订阅者必须按 id 重取，见 `StoreSubscriber`
    this.touch(source, undefined, true)
    return JSON.parse(s.sel) as Sel | null
  }

  /** 演示状态整体换库：换数组引用，清 undo，通知所有视图（source 不传） */
  reset(blocks: Block[]): void {
    this.blocks = blocks
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
}
