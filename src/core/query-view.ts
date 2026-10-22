/**
 * **查询视图实例**：把「条件」变成「冻结的结果集」，并负责**内容不冻**。
 *
 * 一个查询块上挂着两份数据，分工必须分清：
 *
 * | 存哪 | 是什么 | 何时变 |
 * |---|---|---|
 * | `props._query` | **条件**（`QuerySpec` 的 canonical JSON） | 用户改条件时 |
 * | `props._queryResult` | **冻结的结果集**：`[{ blockId, path }]` | **只在刷新时**（成员与顺序冻到下一次刷新） |
 * | 行里的正文 | 不存——**永远按 block id 现读**（改文字立即生效，不刷新也看得见） |
 *
 * ⚠️ **结果集是入 KB 的**（不是视图状态）。判据：「这个查询选了哪些块」是**内容**，
 *    多设备打开必须一致；滚动位置、折叠、宽度才是外挂状态。
 * ⚠️ 这层零 DOM：`refreshSpec` 是「决定下一次结果集」的纯函数，好让「冻结」这件事能被单测。
 */
import type { Block } from './model.ts'
import { findPath } from './tree.ts'
import { runQuery, type QueryHit, type QuerySpec } from './query.ts'
import type { Atom } from './annotations.ts'

/** 冻结进 `_queryResult` 的一条 */
export interface FrozenHit {
  blockId: string
  /** 从根到父块（不含自己）；查不到时允许 `[]` */
  path: string[]
}

// 「是不是查询块」的判据只在 `model.ts` 一处（`isQueryBlock`），这里不重定义：
// 两套判据会冒出「读不出条件的查询块」。桶出口已把那个定义转出去。

/** 读出条件；`_query` 不是合法形状时返回 `null`（不猜、不修，交给调用方提示） */
export function readSpec(b: Block): QuerySpec | null {
  const raw = b.props?._query
  if (!raw || typeof raw !== 'object') return null
  const spec = raw as Partial<QuerySpec>
  if (!spec.where || typeof spec.where !== 'object') return null
  return spec as QuerySpec
}

export function readResult(b: Block): FrozenHit[] | null {
  const raw = b.props?._queryResult
  if (!Array.isArray(raw)) return null
  return raw.filter((x): x is FrozenHit => !!x && typeof x === 'object' && typeof (x as FrozenHit).blockId === 'string')
}

/**
 * **求值一次**并写回块上（原地改 `props`，调用方负责记 undo / 落盘）。
 *
 * 这是「刷新按钮」的全部逻辑，也是「新建查询」时的第一次求值 —— **同一个函数**，
 * 免得出现「新建时算一套、刷新时算另一套」的分叉。
 *
 * 返回值用于 UI：`{ hits, dropped }`。`dropped` ＝ 刷新后**不再匹配**的块（D8 的「已不匹配」提示要用它）。
 */
export function refreshSpec(
  block: Block,
  spec: QuerySpec,
  input: { blocks: readonly Block[]; atoms: readonly Atom[] },
): { hits: FrozenHit[]; dropped: string[] } {
  const before = new Set((readResult(block) ?? []).map((h) => h.blockId))
  /**
   * `subtree` 的锚点 ＝ **查询块所在的那个容器**，不是查询块自己。
   *
   * 为什么（2026-10-20 实测踩到）：查询块通常是个**叶子**（它只存条件，不吃结果，承 A），
   * 拿它当锚点 ⇒ `subtree` 范围里除了它自己什么都没有 ⇒ 永远 0 条。
   * 语义上「这页的待办」看的也是**这一页**，不是「这个查询块的子树」。
   * ⚠️ 顶层查询块（没有祖先）就没有容器可言 ⇒ 退回整片森林（`anchorId` 传空）。
   */
  const path = findPath(input.blocks, block.id) ?? []
  const container = path.length >= 2 ? path[path.length - 2]! : undefined
  const hits = runQuery(spec, { blocks: input.blocks, atoms: input.atoms, anchorId: container?.id })
  const after = new Set(hits.map((h) => h.blockId))

  block.props = { ...(block.props ?? {}), _query: canonicalSpec(spec), _queryResult: hits }
  return { hits, dropped: [...before].filter((id) => !after.has(id)) }
}

/**
 * **现读**：把冻结的 id 列表翻译成当前活块（D5：内容不冻）。
 *
 * 三条规则：
 *   1. 块被删了 ⇒ 这一行**不出**（冻结集合里的人没了，没有可显示的内容）；
 *   2. 顺序**严格按冻结列表**，不看当前森林顺序；
 *   3. 父块也在结果里 ⇒ 只保留父块（否则同一块既是 root 又是子块，渲染两遍）。
 */
export function resolveFrozen(
  frozen: readonly FrozenHit[],
  blocks: readonly Block[],
): { block: Block; path: Block[] }[] {
  const keep = new Set<string>()
  const paths = new Map<string, Block[]>()
  for (const f of frozen) {
    const path = findPath(blocks, f.blockId)
    if (!path) continue
    keep.add(f.blockId)
    paths.set(f.blockId, path)
  }
  const out: { block: Block; path: Block[] }[] = []
  for (const f of frozen) {
    const path = paths.get(f.blockId)
    if (!path) continue
    // 祖先也在结果里 ⇒ 这一条会被祖先的子树渲染出来，跳过
    if (path.slice(0, -1).some((p) => keep.has(p.id))) continue
    out.push({ block: path[path.length - 1]!, path: path.slice(0, -1) })
  }
  return out
}

/**
 * 条件的 canonical 形状：**键序固定**。
 *
 * 为什么要它：`_query` 要进 KB、要能比较「条件变没变」（D4 里「查询定义变化 ⇒ 重算」的判据就是它）。
 * `JSON.stringify` 的键序跟对象字面量写法绑定，改一次写的顺序就会假装「条件变了」。
 *
 * ⚠️ **每一种 `QueryNode` 都要在这里有一支**，否则存进 `_query` 时会被静默丢掉。
 *    丢掉的后果不是报错，而是「条件看起来没变、结果却对不上」——所以这一支必须与
 *    `query.ts` 的联合类型逐条对齐，加一个新原子时两边一起加。
 */
export function canonicalSpec(spec: QuerySpec): QuerySpec {
  const node = (n: QuerySpec['where']): QuerySpec['where'] => {
    if ('all' in n) return { all: n.all.map(node) }
    if ('any' in n) return { any: n.any.map(node) }
    if ('not' in n) return { not: node(n.not) }
    if ('ref' in n) return { ref: n.ref }
    if ('tag' in n) return { tag: n.tag }
    if ('text' in n) return { text: n.text }
    if ('prop' in n) return { prop: { id: n.prop.id, eq: n.prop.eq } }
    if ('todo' in n) return { todo: n.todo }
    return { journal: n.journal }
  }
  const out: QuerySpec = { where: node(spec.where) }
  if (spec.scope) out.scope = spec.scope
  if (spec.todo) out.todo = spec.todo
  if (typeof spec.limit === 'number') out.limit = spec.limit
  return out
}

/** 条件是否变了（D4：变了就该重算，不用等用户点刷新） */
export function specChanged(block: Block, next: QuerySpec): boolean {
  const cur = readSpec(block)
  if (!cur) return true
  return JSON.stringify(canonicalSpec(cur)) !== JSON.stringify(canonicalSpec(next))
}

export type { QueryHit, QuerySpec }
