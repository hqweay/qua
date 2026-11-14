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
import { literalOf, type DraftOp } from './query-draft.ts'
import { normMarks, type Marks } from '../model/runs.ts'
import { SELF, type QueryNode, type QuerySpec, type SortKey } from './query.ts'
import type { RefKind } from '../relations/relations.ts'
import { canonicalSpec } from './query-view.ts'
import { ENGINE_CREATED, ENGINE_MODIFIED } from '../props/props.ts'
import { dateOfMs, dayStartMs, isJournalDate, shiftISO } from '../identity/journal.ts'

/** 方向：一格值位（缺省「自身」＝不包方向）。`up`／`down` 不含自己，`near` 含自己 */
export type TreeDir = 'up' | 'down' | 'near'

/** 叶子行能表达的几种条件 */
export type TreeRow =
  | { kind: 'tag'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'prop'; field: string; op: DraftOp; value: string }
  /**
   * 引用行。`target: ''` ＝ **不限目标**（「有引用即可」，`{ref:{}}`，一条完整条件）；
   * 填了目标 ＝ 指名（字符串形态拼回，既有写法不变）。`kinds` 收窄引用种类
   * （缺省 `undefined` ＝ 三类全算）——它出现在条件里时拼回对象形态（canonical 的样子）。
   */
  | { kind: 'ref'; target: string; kinds?: readonly RefKind[] }
  | { kind: 'is'; target: string }
  | { kind: 'role'; role: 'journal' | 'page' }
  /**
   * **正文里有一段带这组 marks 的内容**（`{mark}` 原子，子集匹配）。
   *
   * 值是归一化前的自由态，拼回时过 `normMarks`（与 run 上的 marks 同一份口径）；
   * **空（归一化后无键）＝ 还没选**，行未完成（空 marks 恒真，不许拼出去）。
   */
  | { kind: 'mark'; value: Marks }
  /** **正文里有外链**；`url: ''` ＝「有外链即可」（一条完整条件），填了比 contains */
  | { kind: 'link'; url: string }
  /**
   * **某一天**（日记身份）：三种值形态，拼回去各是一种既有原子。
   *
   * · `date` 是日期串 ⇒ `{all:[{role:'journal'},{prop:{_date,eq:日期}}]}`；
   * · `date === '$self'` ⇒ 同一条但 `eq:'$self'`（宿主那一天）；
   * · `rel` 有值 ⇒ `{today:{offset}}`（**存表达式**，隔天求值自然换一天）。
   *
   * ⚠️ 它不是「方向行」：方向是节点上的独立一格（`TreeLeaf.dir`／`TreeGroup.dir`），
   *    「某一天之下」＝ 这一行挂上「上级」。
   */
  | { kind: 'day'; date: string; rel?: number }
  /**
   * **时间范围**（引擎属性 `core/created`／`core/modified`）。
   *
   * 值存**绝对毫秒**：`on` ＝ `[当天零点, 次日零点)` 两条条件，`after` ＝ `gte 当天零点`，
   * `before` ＝ `lt 当天零点`。日期只是值控件的投影——把「某一天」写成日期串再比毫秒
   * 是比不了的（类型不同），而把毫秒固定成日期串又会在时区/边界上撒谎。
   */
  | { kind: 'stamp'; field: 'core/created' | 'core/modified'; op: 'on' | 'after' | 'before' | 'recent'; date: string; days?: number }

export type TreeRowKind = TreeRow['kind']

/** 行种类下拉的顺序（与「加一条条件」的选择器分开） */
export const TREE_ROW_KINDS: readonly TreeRowKind[] = ['tag', 'prop', 'text', 'ref', 'is', 'role', 'day', 'stamp', 'mark', 'link']

export interface TreeLeaf {
  kind: 'leaf'
  not: boolean
  /** 方向（缺省＝自身）。**与「非」同构的一格**：叶子与组都能挂 */
  dir?: TreeDir
  row: TreeRow
}

export interface TreeGroup {
  kind: 'group'
  mode: 'all' | 'any'
  not: boolean
  /** 方向（缺省＝自身）；挂组上＝「存在一个上级满足**整组**」 */
  dir?: TreeDir
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
  /** 成员顺序（多键，按数组序生效）；树不再编辑它（抬头排序编辑器是唯一入口），只随往返保全 */
  sort?: SortKey[]
  /** `{today}` 的基准锚（抬头那颗「按本页日期」）；树自己不编辑它，只随往返保全 */
  todayFrom?: 'host'
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
 * 可编辑范围是**刻意收窄**的：方向里再套方向、`{dir:{not:…}}`（只有「非在外」一种写法）、
 * 带 kind 的 `ref` 都还表达不了。语言层不限制它们；限制只在这里（UI），
 * 所以把 spec 存进库、从别处改它们仍然合法。
 *
 * ⚠️ **「非」在外、方向在内**：`{not:{up:C}}` ＝「没有这样的上级」，
 *    拼回去也按这个顺序；另一种 `{up:{not:C}}` 只读 JSON（一个语义不许两种形状）。
 */
export function treeNodeOf(node: QueryNode): TreeNode | null {
  if ('not' in node) {
    const inner = node.not
    if ('not' in inner) return null
    const mapped = treeNodeOf(inner)
    if (!mapped) return null
    return { ...mapped, not: true }
  }
  if ('up' in node) return withDirection('up', node.up)
  if ('down' in node) return withDirection('down', node.down)
  if ('near' in node) return withDirection('near', node.near)
  const day = dayRowOf(node)
  if (day) return { kind: 'leaf', not: false, row: day }
  const stamp = stampRowOf(node)
  if (stamp) return { kind: 'leaf', not: false, row: stamp }
  if ('all' in node || 'any' in node) {
    const items: TreeNode[] = []
    for (const child of 'all' in node ? node.all : node.any) {
      const mapped = treeNodeOf(child)
      if (!mapped) return null
      items.push(mapped)
    }
    return { kind: 'group', mode: 'all' in node ? 'all' : 'any', not: false, items }
  }
  const row = treeRowOf(node)
  return row ? { kind: 'leaf', not: false, row } : null
}

/** 把一个条件套进方向：内层再套方向、或内层是「非」都拆不动（只读 JSON） */
function withDirection(dir: TreeDir, inner: QueryNode): TreeNode | null {
  const nested = 'up' in inner || 'down' in inner || 'near' in inner
  if (nested || 'not' in inner) return null
  const mapped = treeNodeOf(inner)
  if (!mapped || mapped.not) return null
  return { ...mapped, dir }
}

/** 把一组 / 一条条件套进方向 */
function dirNode(dir: TreeDir, inner: QueryNode): QueryNode {
  return dir === 'up' ? { up: inner } : dir === 'down' ? { down: inner } : { near: inner }
}

/**
 * **某一天**这一行的形状：`{all:[{role:'journal'},{prop:{_date,eq}}]}`（顺序写死）与
 * `{today:{offset}}`。
 *
 * ⚠️ 顺序只认 `[role, _date]`：反过来的 `all` 语义相同但字节不同，重排会改 `specKey`
 * —— 那种形状走 JSON，不在树上假装能编辑。
 */
function dayRowOf(node: QueryNode): TreeRow | null {
  if ('today' in node) {
    return Number.isFinite(node.today.offset) ? { kind: 'day', date: '', rel: node.today.offset } : null
  }
  if (!('all' in node) || node.all.length !== 2) return null
  const [first, second] = node.all
  if (!first || !second) return null
  if (!('role' in first) || first.role !== 'journal') return null
  if (!('prop' in second) || second.prop.id !== '_date') return null
  if (!('eq' in second.prop) || typeof second.prop.eq !== 'string') return null
  return { kind: 'day', date: second.prop.eq }
}

/** 时间范围认哪两个引擎属性（其它 prop id 不归这一行） */
function isStampField(id: string): id is 'core/created' | 'core/modified' {
  return id === ENGINE_CREATED || id === ENGINE_MODIFIED
}

/** 毫秒 → 日期，但**只认本地日零点**（不是零点的时刻没有日期等价物 ⇒ 走 JSON） */
function msAsDay(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  const date = dateOfMs(ms)
  return dayStartMs(date) === ms ? date : null
}

/** `{prop:{id, op:key}}` 里「只有这一个算子」时返回它的值，否则 `undefined` */
function singleOpValue(prop: { id: string } & Record<string, unknown>, key: 'gte' | 'lt'): unknown {
  const keys = PROP_OP_KEYS.filter((k) => k in prop)
  return keys.length === 1 && keys[0] === key ? prop[key] : undefined
}

/**
 * **时间范围**的三种形状：`{prop:{id,gte}}`（从这天起）、`{prop:{id,lt}}`（早于这一天）、
 * `{all:[{prop:{id,gte:当天零点}},{prop:{id,lt:次日零点}}]}`（就在这一天）。
 *
 * ⚠️ 只认**本地日零点**上的毫秒：一个 `13:45` 的时刻在日期控件里没有等价物，
 *    拆成日期再拼回去就不再是它自己 —— 那种形状留给只读 JSON。
 * ⚠️ `all` 只认 `[gte, lt]` 这一种顺序（与生成顺序一致）；反过来字节不同，不假装能编辑。
 */
function stampRowOf(node: QueryNode): TreeRow | null {
  if ('prop' in node) {
    const id = node.prop.id
    if (!isStampField(id)) return null
    const after = singleOpValue(node.prop as { id: string } & Record<string, unknown>, 'gte')
    const before = singleOpValue(node.prop as { id: string } & Record<string, unknown>, 'lt')
    // 相对界（`{rel:{days}}`）＝「最近 N 天」：只认 gte 档（UI 只生成这一种）
    if (after !== null && typeof after === 'object' && after !== null && 'rel' in (after as object)) {
      const days = (after as { rel?: { days?: unknown } }).rel?.days
      if (typeof days !== 'number' || !Number.isFinite(days)) return null
      return { kind: 'stamp', field: id, op: 'recent', date: '', days: Math.trunc(-days) }
    }
    const day = msAsDay(after ?? before)
    if (day === null) return null
    return { kind: 'stamp', field: id, op: after !== undefined ? 'after' : 'before', date: day }
  }
  if (!('all' in node) || node.all.length !== 2) return null
  const [first, second] = node.all
  if (!first || !second || !('prop' in first) || !('prop' in second)) return null
  const id = first.prop.id
  if (!isStampField(id) || second.prop.id !== id) return null
  const start = singleOpValue(first.prop as { id: string } & Record<string, unknown>, 'gte')
  const end = singleOpValue(second.prop as { id: string } & Record<string, unknown>, 'lt')
  const day = msAsDay(start)
  if (day === null || typeof end !== 'number' || end !== dayStartMs(shiftISO(day, 1))) return null
  return { kind: 'stamp', field: id, op: 'on', date: day }
}

/** 一个**叶子**条件 → 一行。 */
export function treeRowOf(node: QueryNode): TreeRow | null {
  const day = dayRowOf(node)
  if (day) return day
  const stamp = stampRowOf(node)
  if (stamp) return stamp
  if ('tag' in node) return { kind: 'tag', value: node.tag }
  if ('text' in node) return { kind: 'text', value: node.text }
  if ('ref' in node) {
    if (typeof node.ref === 'string') return { kind: 'ref', target: node.ref }
    /**
     * 对象形态分两半：**缺 `to`**（不限目标）可编辑——值位「目标」就是空的，
     * 拼回去还是对象；**有 `kind` 收窄**的指名目标也可编辑（拼回带 kind 的对象，
     * 与 canonical 字节相等）。只有 `{ref:{to}}`（对象、无 kind）拼回去会变字符串形态
     * ——语义同、字节不同，`specKey` 会误判「条件变了」⇒ 走只读 JSON。
     */
    if (node.ref.to === undefined || node.ref.kind !== undefined) {
      const kinds =
        node.ref.kind === undefined
          ? undefined
          : typeof node.ref.kind === 'string'
            ? [node.ref.kind]
            : [...node.ref.kind]
      return { kind: 'ref', target: node.ref.to ?? '', ...(kinds ? { kinds } : {}) }
    }
    return null
  }
  if ('is' in node) return { kind: 'is', target: node.is }
  if ('mark' in node) {
    const m = normMarks(node.mark)
    return m ? { kind: 'mark', value: m } : null
  }
  if ('link' in node) return { kind: 'link', url: node.link.url ?? '' }
  if ('role' in node) {
    return node.role === 'journal' || node.role === 'page' ? { kind: 'role', role: node.role } : null
  }
  if (!('prop' in node)) return null

  const op = node.prop
  const id = node.prop.id
  const keys = PROP_OP_KEYS.filter((k) => k in op)
  // 多个算子写在同一条上是「写歪但读得懂」；树只能表达一个 ⇒ 交给 JSON，别挑一个显示
  if (keys.length !== 1) return null
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

/** 一份条件 → 树草稿；拆不动返回 `null` */
export function treeOfSpec(spec: QuerySpec): TreeDraft | null {
  const where = spec.where
  const common = {
    ...(typeof spec.limit === 'number' ? { limit: spec.limit } : {}),
    ...(spec.sort && spec.sort.length > 0 ? { sort: spec.sort.map((s) => ({ ...s })) } : {}),
    ...(spec.todayFrom === 'host' ? { todayFrom: 'host' as const } : {}),
  }

  const single = treeNodeOf(where)
  if (!single) return null
  /**
   * 顶层本来就是组（`all`／`any`／`not` 包着组）⇒ 它就是根；
   * 其余（单个条件、带方向的组）包一层合成根 —— 拼回去时合成根直接吐回那个孩子。
   *
   * ⚠️ 「某一天」的形状是 `{all:[role,_date]}`，但它在树上是**一行**（`day`）：
   *    所以这里不能按「where 是 all 就当根组」判，得看拆出来的节点是不是组。
   */
  if (single.kind === 'group') {
    const topLevelGroup =
      ('all' in where || 'any' in where) || ('not' in where && ('all' in where.not || 'any' in where.not))
    if (topLevelGroup) return { root: single, synthesizedRoot: false, ...common }
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
  if (row.kind === 'tag') return row.value.trim() === '' ? null : { tag: row.value }
  if (row.kind === 'text') return row.value.trim() === '' ? null : { text: row.value }
  if (row.kind === 'ref') {
    const target = row.target.trim()
    if (target !== '') return row.kinds ? { ref: { to: target, kind: row.kinds } } : { ref: target }
    return row.kinds ? { ref: { kind: row.kinds } } : { ref: {} }
  }
  if (row.kind === 'is') return row.target === '' ? null : { is: row.target }
  if (row.kind === 'mark') {
    const m = normMarks(row.value)
    return m ? { mark: m } : null
  }
  if (row.kind === 'link') {
    const url = row.url.trim()
    return url === '' ? { link: {} } : { link: { url } }
  }
  if (row.kind === 'role') return { role: row.role }
  if (row.kind === 'day') {
    if (row.date === SELF) return { all: [{ role: 'journal' }, { prop: { id: '_date', eq: SELF } }] }
    // 相对：存表达式（`{today:{offset}}`），不把任何一天的日期写进条件
    if (row.rel !== undefined) return { today: { offset: row.rel } }
    return row.date.trim() === ''
      ? null
      : { all: [{ role: 'journal' }, { prop: { id: '_date', eq: row.date } }] }
  }
  if (row.kind === 'stamp') {
    // 相对窗：存**表达式**（`{rel:{days}}`），求值对 env.today 现算——写死日期隔天就说谎
    if (row.op === 'recent') {
      if (row.days === undefined || !Number.isFinite(row.days) || row.days <= 0) return null
      return { prop: { id: row.field, gte: { rel: { days: -row.days } } } }
    }
    if (!isJournalDate(row.date)) return null
    const start = dayStartMs(row.date)
    if (row.op === 'after') return { prop: { id: row.field, gte: start } }
    if (row.op === 'before') return { prop: { id: row.field, lt: start } }
    return {
      all: [
        { prop: { id: row.field, gte: start } },
        { prop: { id: row.field, lt: dayStartMs(shiftISO(row.date, 1)) } },
      ],
    }
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

/** 树节点 → 条件；没填完的行返回 `null` */
export function queryNodeOfTree(node: TreeNode): QueryNode | null {
  let body: QueryNode
  if (node.kind === 'leaf') {
    const n = treeNodeOfRow(node.row)
    if (!n) return null
    body = n
  } else {
    /**
     * **空组＝没有条件**，返回 `null`（＝未完成）而不是 `{all:[]}`。
     *
     * `{all:[]}` 在判定里是**恒真**（`[].every`）——把「还没条件」拼成它，
     * 结果就是整个库。而用户此刻看到的是一个空组，心里想的是「还没开始筛」。
     * 空组与「有行但没填完」走同一条出路：`specOfTree` 把它收成 `{any:[]}`（永不命中）。
     */
    if (node.items.length === 0) return null
    const children: QueryNode[] = []
    for (const child of node.items) {
      const n = queryNodeOfTree(child)
      if (!n) return null
      children.push(n)
    }
    body = node.mode === 'all' ? { all: children } : { any: children }
  }
  /**
   * **方向在内、「非」在外**：`{not:{up:body}}`。
   *
   * 另一种 `{up:{not:body}}`（祖先里存在一块**不**满足）语义不同，
   * 语言层合法但树不生成它、也不拆它（只读 JSON）——一个语义不许两种形状。
   */
  if (node.dir) body = dirNode(node.dir, body)
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
  if (draft.synthesizedRoot && root.items.length === 1) {
    const child = queryNodeOfTree(root.items[0]!)
    let where: QueryNode = child ?? { any: [] }
    // 合成根上的方向也是真的（用户给这一条条件挂了方向）：`{up:C}`，不要再包一层 `all`
    if (root.dir && child) where = dirNode(root.dir, where)
    where = root.not ? { not: where } : where
    return finish(where)
  } else if (draft.synthesizedRoot && root.items.length === 0) {
    // 合成根被清空 ＝「还没有条件」；不沿用 all 的恒真（那会把全库倒出来）
    return finish({ any: [] })
  }
  return finish(queryNodeOfTree(root) ?? { any: [] })

  /** 把 sort／limit／锚带上（三条出口共用一份，免得某条路漏掉一格） */
  function finish(where: QueryNode): QuerySpec {
    const out: QuerySpec = { where }
    if (draft.sort && draft.sort.length > 0) out.sort = draft.sort.map((s) => ({ ...s }))
    if (typeof draft.limit === 'number' && draft.limit > 0) out.limit = Math.floor(draft.limit)
    if (draft.todayFrom === 'host') out.todayFrom = 'host'
    return canonicalSpec(out)
  }
}

/** 树上条件条数（叶子数，不含组）——抬头 chip 与面板标题用 */
export function treeLeafCount(node: TreeNode): number {
  if (node.kind === 'leaf') return 1
  return node.items.reduce((n, child) => n + treeLeafCount(child), 0)
}
