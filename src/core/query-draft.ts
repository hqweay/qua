/**
 * **条件的「表单草稿」⇄ `QuerySpec`**（纯函数，零 DOM）。
 *
 * 为什么单独一层：构建器（`ui/query-builder.ts`）要能**左右互搏**——
 * 条件行改一处、JSON 跟着变，JSON 改一处、条件行跟着变。两边各写一份转换，
 * 就一定会在某个算子上分叉（`contains` 被丢掉、`empty` 被当成 `exists`），
 * 而分叉的表现是「界面上一行改完、结果没变」。
 *
 * 判据：`specOfDraft(draftOfSpec(s))` 与 `canonicalSpec(s)` **逐字节相等**（有单测）。
 *
 * ⚠️ 草稿只表达**能编辑的那部分**形状：一层 `all`／`any` ＋ 若干叶子条件。
 *    更深的嵌套（`not` 里面套 `any`）保留原样、不拆成行 —— 拆了再拼回来就不再是它自己，
 *    而用户看到的是「我什么都没改，条件却变了」。那种情况在界面上整块显示为 JSON。
 */
import { canonicalSpec } from './query-view.ts'
import type { QueryNode, QuerySpec } from './query.ts'

/** 一行条件能表达的四种事情（其余形态走 JSON） */
export type DraftKind = 'todo' | 'tag' | 'text' | 'prop'

/** 属性条件的算子（与 `PropOp` 一一对应；`empty` 与 `exists` 是两件事） */
export type DraftOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists' | 'empty'

export const DRAFT_OPS: readonly DraftOp[] = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty']

/** 一行条件（表单里的那一行） */
export interface DraftRow {
  kind: DraftKind
  /** `prop` 才有：属性定义块的 id */
  field?: string
  /** `prop` 才有；缺省 `eq` */
  op?: DraftOp
  /** `todo` 用 `todo`／`done`／`none`；其余是字符串或数字字面量 */
  value?: string
}

/** 整份草稿：一层组合 ＋ 范围/上限/顺序 */
export interface QueryDraft {
  /** `all` ＝ 全部满足；`any` ＝ 任一满足 */
  mode: 'all' | 'any'
  rows: DraftRow[]
  scope: 'subtree' | 'all'
  limit?: number
  sort?: { by: string; dir: 'asc' | 'desc' }
  /**
   * 原样的 JSON 文本（**只在拆不成行时**有意义）。
   *
   * 判据：草稿能完整表达这份条件 ⇒ `verbatim` 为空，界面用条件行；
   * 否则整块用 JSON 编辑，`rows` 只作展示。
   */
  verbatim?: string
}

/* ------------------------------------------------------------ spec → 草稿 */

/** 一个叶子节点能不能变成一行 */
function rowOf(node: QueryNode): DraftRow | null {
  if ('todo' in node) return { kind: 'todo', value: node.todo }
  if ('tag' in node) return { kind: 'tag', value: node.tag }
  if ('text' in node) return { kind: 'text', value: node.text }
  if ('prop' in node) {
    const op = node.prop
    const id = node.prop.id
    if ('eq' in op) return { kind: 'prop', field: id, op: 'eq', value: literalText(op.eq) }
    if ('neq' in op) return { kind: 'prop', field: id, op: 'neq', value: literalText(op.neq) }
    if ('contains' in op) return { kind: 'prop', field: id, op: 'contains', value: op.contains }
    if ('gt' in op) return { kind: 'prop', field: id, op: 'gt', value: literalText(op.gt) }
    if ('gte' in op) return { kind: 'prop', field: id, op: 'gte', value: literalText(op.gte) }
    if ('lt' in op) return { kind: 'prop', field: id, op: 'lt', value: literalText(op.lt) }
    if ('lte' in op) return { kind: 'prop', field: id, op: 'lte', value: literalText(op.lte) }
    if ('exists' in op) return { kind: 'prop', field: id, op: 'exists', value: op.exists ? 'true' : 'false' }
    return { kind: 'prop', field: id, op: 'empty', value: op.empty ? 'true' : 'false' }
  }
  return null
}

/** 字面量 → 输入框里的文本（字符串原样，其余按 JSON 写，读回来才不会变形） */
function literalText(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v) ?? ''
}

/**
 * 一份条件 → 草稿。
 *
 * 拆不动（`not`、嵌套组合、`journal`／`ref`／`role`）⇒ `verbatim` 带上原样的 canonical JSON，
 * 界面改用 JSON 编辑。**不猜**：把「拆不动」显示成「拆了一半」，等于让用户在一次
 * 无关的编辑里丢掉剩下的条件。
 */
export function draftOfSpec(spec: QuerySpec): QueryDraft {
  const where = spec.where
  const base: QueryDraft = {
    mode: 'all',
    rows: [],
    scope: spec.scope === 'all' ? 'all' : 'subtree',
    ...(typeof spec.limit === 'number' ? { limit: spec.limit } : {}),
    ...(spec.sort && spec.sort.length === 1 ? { sort: { by: spec.sort[0]!.by, dir: spec.sort[0]!.dir } } : {}),
  }
  const leaves = 'all' in where ? where.all : 'any' in where ? where.any : [where]
  if (('all' in where || 'any' in where) && leaves.length === 0) {
    // 空组合（`all:[]` 恒真／`any:[]` 恒假）—— 它有意义，别拆成「零行 all」
    return { ...base, verbatim: JSON.stringify(canonicalSpec(spec), null, 2) }
  }
  if (spec.sort && spec.sort.length > 1) {
    return { ...base, verbatim: JSON.stringify(canonicalSpec(spec), null, 2) }
  }
  const rows: DraftRow[] = []
  for (const leaf of leaves) {
    const row = rowOf(leaf)
    if (!row) return { ...base, verbatim: JSON.stringify(canonicalSpec(spec), null, 2) }
    rows.push(row)
  }
  return {
    ...base,
    mode: 'any' in where ? 'any' : 'all',
    rows,
  }
}

/* ------------------------------------------------------------ 草稿 → spec */

/** 输入框里的文本 → 字面量：`true`／`false`／数字／带引号的 JSON 都按字面读，其余当字符串 */
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

/** 一行 → 叶子节点；`field` 缺失 ⇒ `null`（这一行还没填完，应用到条件里没有意义） */
export function nodeOfRow(row: DraftRow): QueryNode | null {
  if (row.kind === 'todo') {
    const v = row.value === 'done' || row.value === 'none' ? row.value : 'todo'
    return { todo: v }
  }
  if (row.kind === 'tag') return row.value && row.value !== '' ? { tag: row.value } : null
  if (row.kind === 'text') return row.value && row.value !== '' ? { text: row.value } : null
  const id = row.field ?? ''
  if (id === '') return null
  const op: DraftOp = row.op ?? 'eq'
  const v = row.value ?? ''
  if (op === 'exists') return { prop: { id, exists: v !== 'false' } }
  if (op === 'empty') return { prop: { id, empty: v !== 'false' } }
  if (op === 'contains') return { prop: { id, contains: v } }
  const lit = literalOf(v)
  if (op === 'eq') return { prop: { id, eq: lit } }
  if (op === 'neq') return { prop: { id, neq: lit } }
  if (op === 'gt') return { prop: { id, gt: lit } }
  if (op === 'gte') return { prop: { id, gte: lit } }
  if (op === 'lt') return { prop: { id, lt: lit } }
  return { prop: { id, lte: lit } }
}

/**
 * 草稿 → `QuerySpec`（**已 canonical**）。
 *
 * 零行 ⇒ `{ any: [] }`（永不命中）：空条件等于「没有结果」，而不是「整个库」——
 * 后者会让一个刚建出来、还没填条件的查询当场把全库倒出来。
 */
export function specOfDraft(draft: QueryDraft): QuerySpec {
  if (draft.verbatim !== undefined) {
    try {
      return canonicalSpec(JSON.parse(draft.verbatim) as QuerySpec)
    } catch {
      return { where: { any: [] }, scope: draft.scope === 'all' ? 'all' : 'subtree' }
    }
  }
  const nodes: QueryNode[] = []
  for (const row of draft.rows) {
    const n = nodeOfRow(row)
    if (n) nodes.push(n)
  }
  const where: QueryNode = nodes.length === 0 ? { any: [] } : nodes.length === 1 ? nodes[0]! : draft.mode === 'any' ? { any: nodes } : { all: nodes }
  const out: QuerySpec = { where }
  if (draft.scope === 'all') out.scope = 'all'
  if (draft.sort) out.sort = [{ by: draft.sort.by, dir: draft.sort.dir }]
  if (typeof draft.limit === 'number' && draft.limit > 0) out.limit = Math.floor(draft.limit)
  return canonicalSpec(out)
}
