/**
 * **条件树草稿**：把 `QuerySpec.where` 拆成可编辑的「组 ＋ 叶子行」树，再拼回去。
 *
 * 为什么单独一层（零 DOM）：树 UI 要能**左右互搏** —— 点一下改一处，拼回来的 spec 必须与
 * `canonicalSpec` 逐字节相等。UI 自己拼节点就一定会漏掉某个算子，而漏掉的后果是
 * 「看起来没改、结果却对不上」。转换住在这里，单测能直接钉住往返。
 *
 * 与 `query-draft.ts`（平铺的一层行）的分工：
 *   · **平铺草稿**是旧构建器的模型，只表达一层 `all`／`any` ＋ 叶子；
 *   · **条件树**支持任意嵌套组、每层一个「非」，叶子多出 `ref`／`is`／`role`／`path`。
 *
 * ⚠️ **拆不动就返回 `null`**，调用方显示只读 JSON，**不许猜着拆一半**：
 *    把 `{near:…}` 或带 kind 收窄的 `ref` 显示成一行「差不多的条件」，用户改完一应用就丢了原意。
 * ⚠️ 这里的「能不能表达」是**形状判据**，不是语义判据：空组 `all:[]`／`any:[]` 可表达，
 *    它们分别是恒真／恒假，拼回来不能换。
 */
import { TASK_STATUS_PROP_ID } from '../props/props.ts'
import type { DraftOp, TodoPreset } from './query-draft.ts'
import type { QueryNode, QuerySpec, SortKey } from './query.ts'
import { canonicalSpec } from './query-view.ts'

/** 叶子行能表达的几种条件（`todo` 是属性条件的预设，不是另一个原子） */
export type TreeRow =
  | { kind: 'todo'; value: TodoPreset }
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'prop'; field: string; op: DraftOp; value: string }
  | { kind: 'ref'; target: string }
  | { kind: 'is'; target: string }
  | { kind: 'role'; role: 'journal' }
  /**
   * 路径（方向）行：`{up|down|near:{is:id}}` 或某一天（只有 `up` 有天的形状）。
   * `dir` 缺省 `up`（旧草稿兼容读法：`dir in row === false` 视作 `'up'`）。
   */
  | { kind: 'path'; by: 'journal' | 'block'; dir?: 'up' | 'down' | 'near'; date: string; blockId: string }

export type TreeRowKind = TreeRow['kind']

/** 行种类下拉的顺序（与「加一条条件」的选择器分开：`todo` 只从已有条件认回来） */
export const TREE_ROW_KINDS: readonly TreeRowKind[] = ['tag', 'prop', 'text', 'ref', 'path', 'role', 'is', 'todo']

export interface TreeLeaf {
  kind: 'leaf'
  not: boolean
  row: TreeRow
}

export interface TreeGroup {
  kind: 'group'
  mode: 'all' | 'any'
  not: boolean
  /** 条件子项（**不是块树的 children**：这里装的是条件节点） */
  items: TreeNode[]
}

export type TreeNode = TreeGroup | TreeLeaf

/** 整份草稿：树 ＋ 上限/顺序（这两格不在条件里，但同一次应用一起写） */
export interface TreeDraft {
  /** 根永远是组：它承载根层的「且／或」与「非」 */
  root: TreeGroup
  /**
   * 根组是**从单个条件合成出来的包装**（原 spec 的 `where` 不是组）。
   * 只有一个孩子且没有「非」时，拼回去直接给那个孩子 —— 否则 `{tag:'a'}` 会变成
   * `{all:[{tag:'a'}]}`，同一语义两种字节，`specKey` 会误判「条件变了」。
   */
  synthesizedRoot: boolean
  limit?: number
  sort?: SortKey
}

const PROP_OP_KEYS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty'] as const

function literalText(v: unknown): string {
  if (typeof v !== 'string') return JSON.stringify(v) ?? ''
  /**
   * 字符串里有一部分**长得像字面量**（`42`／`true`／`""`／`[1]`）：直接放进输入框，
   * 拼回来会变成数字／布尔／数组 ⇒ 条件变了。用 JSON 引号把它钉成字符串。
   * 这也是 `eq:''`（空串）唯一的可编辑写法：空输入框表示「还没填」，不是「等于空串」。
   */
  const raw = v.trim()
  const looksLiteral =
    raw === '' ||
    raw === 'true' ||
    raw === 'false' ||
    /^-?\d+(\.\d+)?$/.test(raw) ||
    raw.startsWith('"') ||
    raw.startsWith('[') ||
    raw.startsWith('{')
  return looksLiteral ? JSON.stringify(v) : v
}

/**
 * 一个条件节点 → 树节点；**形状不在可编辑范围内就返回 `null`**（调用方走只读 JSON）。
 *
 * 可编辑范围是**刻意收窄**的：方向的嵌套形状、带 kind 的 `ref` 都还表达不了。
 * 语言层不限制它们；限制只在这里（UI），所以把 spec 存进库、从别处改它们仍然合法。
 */
export function treeNodeOf(node: QueryNode): TreeNode | null {
  if ('all' in node || 'any' in node) {
    const items: TreeNode[] = []
    for (const child of 'all' in node ? node.all : node.any) {
      const mapped = treeNodeOf(child)
      if (!mapped) return null
      items.push(mapped)
    }
    return { kind: 'group', mode: 'all' in node ? 'all' : 'any', not: false, items }
  }
  if ('not' in node) {
    const inner = node.not
    if ('not' in inner) return null
    if ('all' in inner || 'any' in inner) {
      const mapped = treeNodeOf(inner)
      if (!mapped || mapped.kind !== 'group') return null
      return { ...mapped, not: true }
    }
    const row = treeRowOf(inner)
    return row ? { kind: 'leaf', not: true, row } : null
  }
  const row = treeRowOf(node)
  return row ? { kind: 'leaf', not: false, row } : null
}

/**
 * 一个**叶子**条件 → 一行。
 *
 * `todo` 是属性条件的预设（与旧构建器同一口径）：`任务状态 = true/false/exists:false`
 * 仍然显示成「已完成／未完成／不是任务」，落回 `_query` 的只有 `{prop}` 一种形状。
 */
export function treeRowOf(node: QueryNode): TreeRow | null {
  if ('tag' in node) return { kind: 'tag', value: node.tag }
  if ('text' in node) return { kind: 'text', value: node.text }
  if ('ref' in node) {
    if (typeof node.ref === 'string') return { kind: 'ref', target: node.ref }
    /**
     * 对象形态的 `ref`（哪怕没有 kind）整份走 JSON：树上的引用行只有一个值位（目标 id），
     * 拼回去会变成 `{ref:'id'}` —— 语义相同、字节不同，`specKey` 会误判「条件变了」。
     */
    return null
  }
  if ('is' in node) return { kind: 'is', target: node.is }
  if ('role' in node) return node.role === 'journal' ? { kind: 'role', role: 'journal' } : null
  if ('up' in node) return pathRowOf('up', node.up)
  if ('down' in node) return pathRowOf('down', node.down)
  if ('near' in node) return pathRowOf('near', node.near)
  if (!('prop' in node)) return null

  const op = node.prop
  const id = node.prop.id
  const keys = PROP_OP_KEYS.filter((k) => k in op)
  // 多个算子写在同一条上是「写歪但读得懂」；树只能表达一个 ⇒ 交给 JSON，别挑一个显示
  if (keys.length !== 1) return null
  if (id === TASK_STATUS_PROP_ID) {
    if ('eq' in op && op.eq === true) return { kind: 'todo', value: 'done' }
    if ('eq' in op && op.eq === false) return { kind: 'todo', value: 'todo' }
    if ('exists' in op && op.exists === false) return { kind: 'todo', value: 'none' }
  }
  const key = keys[0]!
  switch (key) {
    case 'eq':
      return 'eq' in op ? { kind: 'prop', field: id, op: 'eq', value: literalText(op.eq) } : null
    case 'neq':
      return 'neq' in op ? { kind: 'prop', field: id, op: 'neq', value: literalText(op.neq) } : null
    case 'gt':
      return 'gt' in op ? { kind: 'prop', field: id, op: 'gt', value: literalText(op.gt) } : null
    case 'gte':
      return 'gte' in op ? { kind: 'prop', field: id, op: 'gte', value: literalText(op.gte) } : null
    case 'lt':
      return 'lt' in op ? { kind: 'prop', field: id, op: 'lt', value: literalText(op.lt) } : null
    case 'lte':
      return 'lte' in op ? { kind: 'prop', field: id, op: 'lte', value: literalText(op.lte) } : null
    case 'contains':
      return 'contains' in op ? { kind: 'prop', field: id, op: 'contains', value: op.contains } : null
    case 'exists':
      return 'exists' in op ? { kind: 'prop', field: id, op: 'exists', value: op.exists ? 'true' : 'false' } : null
    case 'empty':
      return 'empty' in op ? { kind: 'prop', field: id, op: 'empty', value: op.empty ? 'true' : 'false' } : null
  }
  return null
}

/**
 * 方向条件的可编辑形状：`{dir:{is:id}}`（某一块的上级/下级/邻近）与
 * `{up:{all:[{role:'journal'},{prop:{_date,eq:date}}]}}`（某一天之下；只有 `up` 有天的形状）。
 *
 * ⚠️ 顺序写死：只认 `[role, _date]` 这一种。反过来的 `all` 语义相同但字节不同，
 *    重排会改 `specKey`；那种形状走 JSON，不在树上假装能编辑。
 */
function pathRowOf(dir: 'up' | 'down' | 'near', node: QueryNode): TreeRow | null {
  if ('is' in node) return { kind: 'path', by: 'block', dir, date: '', blockId: node.is }
  if (dir !== 'up') return null
  if (!('all' in node) || node.all.length !== 2) return null
  const [first, second] = node.all
  if (!first || !second) return null
  if (!('role' in first) || first.role !== 'journal') return null
  if (!('prop' in second) || second.prop.id !== '_date') return null
  if (!('eq' in second.prop) || typeof second.prop.eq !== 'string') return null
  return { kind: 'path', by: 'journal', date: second.prop.eq, blockId: '' }
}

/** 一份条件 → 树草稿；拆不动返回 `null` */
export function treeOfSpec(spec: QuerySpec): TreeDraft | null {
  // 多键排序没有 UI 值位；保留形状只能走 JSON
  if (spec.sort && spec.sort.length > 1) return null

  const where = spec.where
  const common = {
    ...(typeof spec.limit === 'number' ? { limit: spec.limit } : {}),
    ...(spec.sort && spec.sort.length === 1 ? { sort: { ...spec.sort[0]! } } : {}),
  }

  if ('all' in where || 'any' in where) {
    const root = treeNodeOf(where)
    if (!root || root.kind !== 'group') return null
    return { root, synthesizedRoot: false, ...common }
  }
  if ('not' in where && ('all' in where.not || 'any' in where.not)) {
    const root = treeNodeOf(where)
    if (!root || root.kind !== 'group') return null
    return { root, synthesizedRoot: false, ...common }
  }

  const single = treeNodeOf(where)
  if (!single) return null
  if (single.kind === 'group') {
    // 兜底：单个组（不常见）也包进根组，拼回去时合成根会直接吐回那个组
    return {
      root: { kind: 'group', mode: 'all', not: false, items: [single] },
      synthesizedRoot: true,
      ...common,
    }
  }
  return {
    root: { kind: 'group', mode: 'all', not: single.not, items: [{ ...single, not: false }] },
    synthesizedRoot: true,
    ...common,
  }
}

/* ------------------------------------------------------------ 拼回去 */

/** 一行 → 叶子条件；没填完返回 `null`（UI 据此禁用「应用」） */
export function treeNodeOfRow(row: TreeRow): QueryNode | null {
  if (row.kind === 'todo') {
    const v = row.value === 'done' || row.value === 'none' ? row.value : 'todo'
    if (v === 'done') return { prop: { id: TASK_STATUS_PROP_ID, eq: true } }
    if (v === 'none') return { prop: { id: TASK_STATUS_PROP_ID, exists: false } }
    return { prop: { id: TASK_STATUS_PROP_ID, eq: false } }
  }
  if (row.kind === 'tag') return row.value.trim() === '' ? null : { tag: row.value }
  if (row.kind === 'text') return row.value.trim() === '' ? null : { text: row.value }
  if (row.kind === 'ref') return row.target === '' ? null : { ref: row.target }
  if (row.kind === 'is') return row.target === '' ? null : { is: row.target }
  if (row.kind === 'role') return { role: row.role }
  if (row.kind === 'path') {
    if (row.by === 'block') {
      if (row.blockId === '') return null
      const dir = row.dir ?? 'up'
      return dir === 'down' ? { down: { is: row.blockId } } : dir === 'near' ? { near: { is: row.blockId } } : { up: { is: row.blockId } }
    }
    return row.date.trim() === ''
      ? null
      : { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: row.date } }] } }
  }
  if (row.field === '') return null
  const op: DraftOp = row.op
  const v = row.value
  if (op === 'exists') return { prop: { id: row.field, exists: v !== 'false' } }
  if (op === 'empty') return { prop: { id: row.field, empty: v !== 'false' } }
  // 空输入框＝还没填；「等于空串」由 `literalText` 写成 `""`，不是空输入
  if (v.trim() === '') return null
  if (op === 'contains') return { prop: { id: row.field, contains: v } }
  const lit = literalOf(v)
  if (op === 'eq') return { prop: { id: row.field, eq: lit } }
  if (op === 'neq') return { prop: { id: row.field, neq: lit } }
  if (op === 'gt') return { prop: { id: row.field, gt: lit } }
  if (op === 'gte') return { prop: { id: row.field, gte: lit } }
  if (op === 'lt') return { prop: { id: row.field, lt: lit } }
  return { prop: { id: row.field, lte: lit } }
}

/**
 * 输入框里的文本 → 字面量。与 `query-draft.ts` 的 `literalOf` **同一口径**：
 * `true`／`false`／数字／带引号的 JSON 都按字面读，其余当字符串。
 * 这里不 import 它是因为它在草稿层、且不想让两层的依赖方向绕回来；两处都有单测钉住。
 */
function literalOf(text: string): unknown {
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

/** 树节点 → 条件；没填完的行返回 `null` */
export function queryNodeOfTree(node: TreeNode): QueryNode | null {
  if (node.kind === 'leaf') {
    const n = treeNodeOfRow(node.row)
    if (!n) return null
    return node.not ? { not: n } : n
  }
  const children: QueryNode[] = []
  for (const child of node.items) {
    const n = queryNodeOfTree(child)
    if (!n) return null
    children.push(n)
  }
  const body: QueryNode = node.mode === 'all' ? { all: children } : { any: children }
  return node.not ? { not: body } : body
}

/** 树上有没有没填完的行（有 ⇒「应用」禁用；不静默丢掉用户刚敲的那一行） */
export function treeIncomplete(node: TreeNode): boolean {
  if (node.kind === 'leaf') return treeNodeOfRow(node.row) === null
  return node.items.some(treeIncomplete)
}

/** 树草稿 → `QuerySpec`（已 canonical） */
export function specOfTree(draft: TreeDraft): QuerySpec {
  const root = draft.root
  let where: QueryNode
  if (draft.synthesizedRoot && root.items.length === 1) {
    const child = queryNodeOfTree(root.items[0]!)
    where = child ? (root.not ? { not: child } : child) : { any: [] }
  } else if (draft.synthesizedRoot && root.items.length === 0) {
    // 合成根被清空 ＝「还没有条件」；不沿用 all 的恒真（那会把全库倒出来）
    where = { any: [] }
  } else {
    where = queryNodeOfTree(root) ?? { any: [] }
  }
  const out: QuerySpec = { where }
  if (draft.sort) out.sort = [{ by: draft.sort.by, dir: draft.sort.dir }]
  if (typeof draft.limit === 'number' && draft.limit > 0) out.limit = Math.floor(draft.limit)
  return canonicalSpec(out)
}

/** 树上条件条数（叶子数，不含组）——抬头 chip 与面板标题用 */
export function treeLeafCount(node: TreeNode): number {
  if (node.kind === 'leaf') return 1
  return node.items.reduce((n, child) => n + treeLeafCount(child), 0)
}
