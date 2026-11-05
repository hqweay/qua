/**
 * 空态「最近更新」的取数：**修改时间倒序的前 N 块**。
 *
 * 为什么不是 `flatten` 全量 → `sort` → `slice`：搜索面一打开（词为空）就会取一次，
 * 库大时那是一次全森林的排序，而真正要显示的只有 20 条（`search-face` 的 `recents(20)`）。
 * 这里只维护一个**有界的有序缓冲**，代价 O(n log N)，N 是显示条数。
 *
 * 语义必须与「全量投影后排序再 slice」**逐条相等**：
 *  - 顺序＝`modified` 倒序；
 *  - `modified` 相同时保持**文档序**（`flatten` 的先序），也就是稳定排序的口径——
 *    新遇到的块排在已收集的同值块之后。
 *  - 软删块跳过（与旧实现的 `filter(!isDeleted)` 同一判据）。
 */
import { flatten, isDeleted, type Block, type Doc } from '../../core/index.ts'

export function recentBlocks(doc: Doc, limit: number): Block[] {
  if (limit <= 0) return []
  const out: Block[] = []
  for (const b of flatten(doc)) {
    if (isDeleted(b)) continue
    /**
     * 缓冲已满且这一条不比第 N 名更新 ⇒ 挤不进来。
     * 「相等」也要跳过：平局按文档序，而这一条在文档序里排在所有已收集的同值块之后，
     * 于是它只会落在第 N 名之外。
     */
    if (out.length === limit && b.modified <= out[limit - 1]!.modified) continue
    // 二分找插入位：跳过所有 `modified >= b.modified` 的（相等的不抢在前面 ⇒ 稳定序）
    let lo = 0
    let hi = out.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (out[mid]!.modified >= b.modified) lo = mid + 1
      else hi = mid
    }
    out.splice(lo, 0, b)
    if (out.length > limit) out.pop()
  }
  return out
}
