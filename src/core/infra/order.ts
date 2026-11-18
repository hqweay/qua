/**
 * **先序 rank**：派生索引里「这块在它兄弟之间排第几」的那一格。
 *
 * 为什么不是物化全路径（`0001.0003.0002`）：路径把祖先信息复制到每个块上，移动一棵子树
 * 就要重写**所有子孙**的键；而 rank 只属于「层」——移动只改被移那一块自己的一格，
 * 子孙的 rank 仍是它们在自己父块里的位置。完整先序键 = 从根到自己逐层 rank 的数组，
 * 只在需要比较时沿 `parentOf` 现拼（查询本来就要走同一条链拿 `path`）。
 *
 * ⚠️ rank 是**派生**的，不是模型的第二套序：`children` 数组仍是唯一真相；这里只在
 *    `rebuild`／位置 op 之后重新记一遍。因此「全量 == 增量」的判据是**先序 id 序列**，
 *    不是原始数值——中点插入出来的数值本来就不该与全量重编号逐字节相同。
 * ⚠️ **每一层都含软删块**：模型的 `children` 数组里有它们，rank 也跟着有；删除不清 rank
 *    （位置没变），恢复就免费，purge 才摘。查询只见可见块，不受影响。
 */
import type { Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'

/** 相邻 rank 的初始步长；同层中点用尽（挤到浮点精度）时整层重编号。 */
export const ORDER_STEP = 1024

/** 块 id → 它在父级 `children` 里的 rank（只有 rank，没有路径） */
export type RankMap = Map<string, number>

/**
 * 夹在 `prev` 与 `next` 之间的 rank；**没有位置可插**时返回 `undefined`
 * （调用方整层重编号，而不是悄悄夹取——静默落到别处比慢更难查）。
 *
 * 两端都缺 = 只有一个孩子；只有一端 = 追加/前插（允许负数，连续前插不会退化）。
 */
export function rankBetween(prev: number | undefined, next: number | undefined): number | undefined {
  if (prev === undefined) return next === undefined ? ORDER_STEP : next - ORDER_STEP
  if (next === undefined) return prev + ORDER_STEP
  if (next > prev) {
    const mid = (prev + next) / 2
    // 浮点精度耗尽时 mid 会等于某一端 ⇒ 交给整层重编号
    if (mid > prev && mid < next) return mid
  }
  return undefined
}

/** 把一层（raw `children`，**含软删**）按当前顺序重编号 */
export function renumberLevel(order: RankMap, children: readonly Block[]): void {
  for (let i = 0; i < children.length; i++) order.set(children[i]!.id, (i + 1) * ORDER_STEP)
}

/**
 * 给一棵子树的**子孙**记 rank（根除外）：根的 rank 取决于它父级的邻居，
 * 由 `applyOps` 的批量 flush 统一放。每一层按 `ctx.index` 记（含软删兄弟）。
 */
export function assignSubtreeRanks(order: RankMap, root: Block): void {
  if (root.children.length === 0) return
  walkForest(
    root.children,
    (b, ctx) => {
      order.set(b.id, (ctx.index + 1) * ORDER_STEP)
    },
    { includeDeleted: true },
  )
}

/**
 * 逐层 rank 的字典序比较：**前缀在前**（父先于子），同层按数值 ⇒ 整片森林的先序。
 * 两个不同块的 rank 链不会相等；相等只可能来自缺 rank 的坏数据，按 0 处理（上层会回退）。
 */
export function compareRanks(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!
    if (d !== 0) return d
  }
  return a.length - b.length
}
