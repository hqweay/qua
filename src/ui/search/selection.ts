/**
 * 搜索面的**纯判据**（零依赖）：选中回落、公共祖先提取。
 *
 * 为什么单独成一份：这几条规则各有不止一个入口——
 *   · 选中回落有两个（结果集变化、预览里删掉一块后回落），它们必须给出同一个答案；
 *   · 「住哪」提取有两个（整批渲染、按 id 局部更新），局部更新若用了另一条判据，
 *     一改那一行它就把刚提走的「住哪」吐回来，行宽当场变窄。
 * 抄两遍的话，一处改了另一处不会红，只表现为「刷新之后选中跳了」「改一个字行宽变了」。
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

/**
 * 这批命中的「住哪」要不要**提进分组标题**（返回公共值；空串 ＝ 每行各说各的）。
 *
 * 判据是「是不是同一个」：全一样 ⇒ 提走，行里不再重复。逐行重复同一句话既不带
 * 任何信息，又会把片段挤成一截——而片段才是这一行要读的东西。
 * 只有一条时不提取：没有「公共」可言，标题里再说一遍是纯噪音。
 */
export function sharedHintOf(hints: readonly string[]): string {
  if (hints.length < 2) return ''
  const first = hints[0]!
  if (first === '') return ''
  return hints.every((h) => h === first) ? first : ''
}
