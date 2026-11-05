/**
 * 搜索面「现在选中哪一条」的判据：**纯函数、零依赖**。
 *
 * 为什么单独成一份：这条规则有两个入口（结果集到达时、预览里删掉一块后回落），
 * 而它们必须给出同一个答案——「旧选中还在就保留，不在就第一条，没有结果就没有选中」。
 * 抄两遍的话，一处改了另一处不会红，只会表现为「刷新之后选中跳了」。
 */

/** 结果集变化后该选中谁：`current` 还在就保留，否则第一条；空结果 ⇒ 空串 */
export function pickSelection(ids: readonly string[], current: string): string {
  if (ids.length === 0) return ''
  return ids.includes(current) ? current : ids[0]!
}

/**
 * 某一条被移除之后该选中谁：优先**同一位置**的下一条（列表在视觉上原地塌一行），
 * 没有下一条就上一条；一条都不剩 ⇒ 空串。
 */
export function pickAfterRemoval(ids: readonly string[], removedAt: number): string {
  if (ids.length === 0) return ''
  const at = Math.max(0, Math.min(removedAt, ids.length - 1))
  return ids[at]!
}
