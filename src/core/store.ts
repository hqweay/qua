/**
 * **共享 block store**：块（含行内内容与 annos）、undo 只有一份，
 * 多个 `BlockEditor` 视图读同一份数据；编辑任一实例，其他实例经 `apply` 的通知重渲染。
 *
 * 为什么需要它：反链/查询视图和正文会渲染**同一个源块**。如果编辑器各持一份拷贝，
 * 两份可编辑拷贝会分叉。store 让「块」只有一份，视图只是它的投影。
 *
 * 边界：
 *   · store 在 `core/`，**零 DOM**；视图通过 `subscribe` 得到通知。
 *   · 快照是**整片森林**（blocks ＋ 一个视图的 sel）；undo 是全局的。
 *     行内内容与 annos 住块上 ⇒ 快照天然带全它们，没有第二份要拼装。
 *   · **宣布只有一个入口**：`apply(ops)`（事务的出口）。调用方不许自己发通知 ——
 *     否则索引会被无谓作废、订阅者会被通知两次（两者都不报错，只是变慢/抖动）。
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
  /**
   * **整片森林被换掉的次数**（`restore`／`reset`）。
   *
   * 为什么需要它：增量落盘按 op 走，而撤销/重做与换库**不产生 op** ——
   * 它们把森林整个换成另一份。落盘层据此判「这批必须整份写」，
   * 而不是靠「这批 op 是空的」去猜（那会把「只是换了个落点」也当成整库重写）。
   */
  private replaced = 0
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
  /**
   * **诊断计数**（只增、不清零；给「成本不随体量增长」这类断言一个可判定的读数）。
   *
   * 为什么要它：这类退化（索引被作废后整库重建、订阅者被通知两次）**不报错**，
   * 界面只是慢一点；没有读数就只能靠推理，而推理验不出「修复是否真的生效」。
   */
  readonly probe = { rebuildCount: 0, notifyCount: 0 }

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
   * ⚠️ **不是公开的宣布入口**：调用方不许自己宣布模型变了。
   * 唯一的宣布者是一次事务的出口（`Kb.apply`），因为只有它知道「变了哪几格」。
   * 自己宣布 ⇒ 索引会被无谓作废、订阅者会被通知两次（真踩过：打字每键两次全视图重载）。
   */
  private notify(source?: unknown, ids?: readonly string[], forestReplaced = false): void {
    this.probe.notifyCount++
    for (const fn of this.subs) fn(source, ids, forestReplaced)
  }

  /**
   * **状态转移的唯一入口**：把一批 op 应用到当前森林，并**同时**做三件事 ——
   * 按 op 增量修补索引、通知订阅者、记诊断计数。
   *
   * 为什么收成一个：这三件事是同一个事实（「模型变成了这样」）的三个投影。
   * 分成两个入口（`applyOps` ＋ `touch`）时，第二个会把第一个的成果当场作废
   * （`touch` 无条件 `invalidateIndex`）—— 而那正是打字路径上每次按键都在发生的事。
   *
   * ⚠️ 索引是**增量修补**，不是整库作废：一批 op 之后与全量重建逐字节一致
   * （`tests/index-port.test.ts` 的等式断言钉住）。
   */
  apply(ops: readonly Op[], source?: unknown, ids?: readonly string[]): void {
    patchIndex(this.index, ops, this.blocks)
    this.notify(source, ids)
  }

  /** 索引（**懒重建**）。任何改动之后第一次访问会重算一次，之后所有查询共用。 */
  get index(): Index {
    this.idx ??= (this.probe.rebuildCount++, rebuild(this.blocks))
    return this.idx
  }

  /** 按 id 找块（整片森林；zoom 后当前对象可能在任意深度）—— 走索引，O(1) */
  find(id: string): Block | undefined {
    return lookupBlock(this.index, id)
  }

  /**
   * **整片森林被换掉**之后丢掉索引（下次访问整库重建）。
   *
   * 与 `apply` 的区别：`apply` 有一批 op 可依，所以只做增量修补；
   * 这里对象全换了，没有 op 可依 ⇒ 只能整库重建。
   * 只有两条路会走到这里：`restore`（撤销/重做）与事务失败回滚。
   * **摘掉它 = `diff` 落地那天**（撤销改走 op 之后，就再没有「整片换掉」了）。
   */
  discardIndex(): void {
    this.idx = null
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
    this.replaced++
    this.blocks.splice(0, this.blocks.length, ...blocks)
    /**
     * 整片森林被换掉 ⇒ 索引必须整库重建（不是修补：对象全换了，增量无从谈起）。
     * 这是**唯一**还允许作废索引的地方 —— 它已经不是「一批 op」，没有 op 可修补。
     * 摘掉它的那一天 = `diff` 落地那天（撤销改走 op）。
     */
    this.discardIndex()
    // ⚠️ 数组身份保住、但**块对象是新的** ⇒ 订阅者必须按 id 重取，见 `StoreSubscriber`
    this.notify(source, undefined, true)
    return JSON.parse(s.sel) as Sel | null
  }

  /** 演示状态整体换库：换数组引用，清 undo，通知所有视图（source 不传） */
  reset(blocks: Block[]): void {
    this.replaced++
    this.blocks = blocks
    this.discardIndex()
    this.undoStack.clear()
    this.notify()
  }

  /**
   * 森林被整份换掉的次数。**只增**，落盘层拿它判断「这一批要不要整份写」。
   *
   * 为什么不看「这批 op 是空的」：换落点（`setActiveId`）也是零 op，
   * 而它只需要写 `meta` 两格。把两者混成一件事，每次翻页都要整库重写一遍。
   */
  get replacementCount(): number {
    return this.replaced
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
