/**
 * **属性条件的算子清单**（纯函数，零 DOM）：哪些算子这一行能问、按字段 kind 怎么收窄，
 * 以及「输入框里的一段文本」怎么读成字面量。
 *
 * 条件本身的模型是 `core/query-tree.ts` 的「组 ＋ 叶子行」树；这里只放**算子**这一点，
 * 因为它是编辑面与验形共用的一张表（树的值控件、`query-tree` 的拼装都读它）。
 *
 * ⚠️ 曾经这里还有一套「平铺草稿」（`draftOfSpec`／`specOfDraft`）：一层 `all`／`any` ＋ 叶子行。
 *    条件树接管编辑之后它只剩 chip 一个消费者，而它表达不了方向、`ref`／`is`／`role`／某一天 ——
 *    那些形状的 chip 一律退化成「复合条件」。chip 改读条件树之后（同一份模型），
 *    平铺草稿退役：两套投影必然分叉，留一份就够。
 */
import { type PropKind } from '../props/props.ts'

/** 属性条件的算子（与 `PropOp` 一一对应；`empty` 与 `exists` 是两件事） */
export type DraftOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'empty'

export const DRAFT_OPS: readonly DraftOp[] = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty']

/**
 * `select` 只认这四个算子：值是选项块 id，大小比较与「包含」对它没有意义
 * （`contains` 等 **multi-select** 来了再开，那时它判「数组任一元素」）。
 */
export const SELECT_OPS: readonly DraftOp[] = ['eq', 'neq', 'exists', 'empty']

/**
 * 这一行**能问**哪些算子（按字段 kind 收窄）。
 *
 * - **布尔**：没有未填态，`empty` 与 `exists:false` 是同一个答案 ⇒ 不给 `empty`；
 * - **`select`**：只有「等于／不等于某一项」「有没有这一栏」「填了没填」这四个问法。
 *
 * ⚠️ 已经存下来的算子**永远留在下拉里**：收窄只决定「新加时不给什么」，
 *    不许打开一次就悄悄把用户的条件改掉。
 */
export function opsFor(kind: PropKind | undefined, current: DraftOp | undefined): readonly DraftOp[] {
  const cur = current ?? 'eq'
  const allow: readonly DraftOp[] =
    kind === 'checkbox' ? DRAFT_OPS.filter((o) => o !== 'empty') : kind === 'select' ? SELECT_OPS : DRAFT_OPS
  return allow.includes(cur) ? allow : [...allow, cur]
}

/**
 * 输入框里的文本 → 字面量。
 *
 * `true`／`false`／数字／带引号的 JSON 都按字面读，其余当字符串。
 * `""`（空输入框）表示「还没填」；要表达「等于空串」得写成 `""` 带引号。
 */
export function literalOf(text: string): unknown {
  const raw = text.trim()
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && !Number.isNaN(Number(raw)) && /^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (raw.startsWith('"') || raw.startsWith('[') || raw.startsWith('{')) {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return text
    }
  }
  return text
}
