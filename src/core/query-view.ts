/**
 * **查询视图实例**：把「条件」变成「**这一个表面实例**的冻结结果」。
 *
 * 一个查询块上只有一份内容：**条件**。
 *
 * | 存哪 | 是什么 | 何时变 |
 * |---|---|---|
 * | `props._query` | **条件**（`QuerySpec` 的 canonical JSON）——内容，入 KB、进撤销 | 用户改条件时 |
 * | `FrozenResult`（**内存**） | 这一处表面的冻结结果 | 首次显示／条件变／上下文变／用户点刷新 |
 * | 行里的正文 | 不存——**永远按 block id 现读**（改文字立即生效，不刷新也看得见） |
 *
 * ## 为什么结果不入库（这次改掉的那条）
 *
 * 曾经结果冻结进 `props._queryResult`。它是派生值，而派生值当内容有三处说不清：
 *   · **撤销**：刷新会写块 ⇒ 按一次 ⌘Z 撤的是「上一次刷新」而不是上一次编辑；
 *   · **跨端**：桌面端不落、web 落一半，同一份条件在两端结果不同；
 *   · **刷新**：外部改了数据，库里那份一直是旧的，而界面看不出它在说谎。
 *
 * 判据：条件相同、数据相同 ⇒ 结果相同。结果不是用户写下的东西，是数据的一个投影；
 * 投影存进内容层，就必然说谎。现在它回到**表面实例**上：重开应用重新求值。
 *
 * ⚠️ 这层零 DOM：`freezeResult` 是纯读（走读门面），好让「冻结」这件事能被单测。
 */
import { mkBlock, type Block } from './model.ts'
import { textRuns } from './runs.ts'
import { contextKey, isQuerySpec, type QueryHit, type QueryContext, type QuerySpec } from './query.ts'
import { canonicalViews, type ViewConfig } from './view.ts'
import { withBlockOwnerData } from './view-owner.ts'
import type { KbClient } from './kb/types.ts'

// 「是不是查询块」的判据只在 `model.ts` 一处（`isQueryBlock`），这里不重定义：
// 两套判据会冒出「读不出条件的查询块」。桶出口已把那个定义转出去。

/**
 * 读出条件；`_query` 不是合法形状时返回 `null`（不猜、不修，交给调用方提示）。
 *
 * ⚠️ 验形走 `isQuerySpec`（`core/query.ts`）：旧库里留着**已删的条件原子**时，
 *    求值器只会「不命中」——那看起来和「确实没有结果」一模一样。返回 `null`
 *    让表面显示「这条条件读不出来」，一句话指到条件上。
 */
export function readSpec(b: Block): QuerySpec | null {
  const raw = b.props?._query
  return isQuerySpec(raw) ? raw : null
}

/* ------------------------------------------------------------ 冻结 */

/**
 * **一个表面实例的冻结结果**。
 *
 * 它住在内存里（`ViewHost`／`MountArea` 的每一栏／`EmbedBody`／dock 卡），
 * 不进 KB、不进撤销、不改 `modified`。
 *
 * 两个键回答「什么时候该重算」：
 *   · `specKey` —— 条件被编辑／撤销了 ⇒ 自动重算（不会出现「旧条件 ＋ 新结果」）；
 *   · `contextKey` —— 换宿主／换表面了 ⇒ 同一份条件天然得到另一套结果（`$self` 的定义）。
 */
export interface FrozenResult {
  specKey: string
  contextKey: string
  hits: QueryHit[]
}

/** 条件的稳定串（**canonical 之后**再串：键序不该影响判等） */
export function specKeyOf(spec: QuerySpec): string {
  return JSON.stringify(canonicalSpec(spec))
}

/**
 * 求值一次并冻结。**只读**：不写块、不改 `_query`、不进撤销。
 *
 * 与条件编辑分开：条件由 builder／`core.query/set-spec` 写进 `_query`（那是内容、可撤销）；
 * 这里只是「按当前条件算一遍」。
 */
export function freezeResult(spec: QuerySpec, kb: Pick<KbClient, 'query'>, ctx: QueryContext): FrozenResult {
  return {
    specKey: specKeyOf(spec),
    contextKey: contextKey(ctx),
    hits: kb.query(spec, { scopeId: ctx.scopeId, selfId: ctx.selfId, excludeIds: ctx.excludeIds }),
  }
}

/** 条件或上下文变了吗（变了就该重算，不用等用户点刷新） */
export function frozenStale(frozen: FrozenResult | null, spec: QuerySpec, ctx: QueryContext): boolean {
  if (!frozen) return true
  return frozen.specKey !== specKeyOf(spec) || frozen.contextKey !== contextKey(ctx)
}

/**
 * 刷新之后**不再命中**的块（给一句「移除了 N 条」）。
 *
 * 为什么由调用方比对而不是这里算：旧结果住在**那个表面实例**上，
 * 这一层不该知道「上一轮是谁在看」。
 */
export function droppedFrom(before: readonly QueryHit[], after: readonly QueryHit[]): string[] {
  const now = new Set(after.map((h) => h.blockId))
  return [...new Set(before.map((h) => h.blockId))].filter((id) => !now.has(id))
}

/**
 * **现读**：把冻结的 id 列表翻译成当前活块（内容不冻）。
 *
 * 查找经**读门面的 `pathOf`**（根→自己的祖先链）：调用方不必持有整片森林；
 * 空数组 ＝ 这个 id 现在解析不到。
 *
 * 三条规则：
 *   1. 块被删了 ⇒ 这一行**不出**（冻结集合里的人没了，没有可显示的内容）；
 *   2. 顺序**严格按冻结列表**，不看当前森林顺序；
 *   3. 父块也在结果里 ⇒ 只保留父块（否则同一块既是 root 又是子块，渲染两遍）。
 */
export function resolveFrozen(
  frozen: readonly QueryHit[],
  pathOf: (id: string) => readonly Block[],
): { block: Block; path: Block[] }[] {
  const keep = new Set<string>()
  const paths = new Map<string, readonly Block[]>()
  for (const f of frozen) {
    const path = pathOf(f.blockId)
    if (path.length === 0) continue
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

/* ------------------------------------------------------------ canonical */

/**
 * 条件的 canonical 形状：**键序固定**。
 *
 * 为什么要它：`_query` 要进 KB、要能比较「条件变没变」（冻结的 `specKey` 就是它）。
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
    /**
     * 属性条件**逐算子原样带走**，不补默认值（补了两种写法就不再等价）。
     *
     * ⚠️ 每加一个算子，这里必须加一支：漏掉的那一支会被静默丢掉，
     *    表现是「条件看起来没变、结果却对不上」。
     */
    if ('prop' in n) {
      const { id } = n.prop
      const op = n.prop
      if ('exists' in op) return { prop: { id, exists: op.exists } }
      if ('empty' in op) return { prop: { id, empty: op.empty } }
      if ('eq' in op) return { prop: { id, eq: op.eq } }
      if ('neq' in op) return { prop: { id, neq: op.neq } }
      if ('contains' in op) return { prop: { id, contains: op.contains } }
      if ('gt' in op) return { prop: { id, gt: op.gt } }
      if ('gte' in op) return { prop: { id, gte: op.gte } }
      if ('lt' in op) return { prop: { id, lt: op.lt } }
      return { prop: { id, lte: op.lte } }
    }
    if ('journal' in n) return { journal: n.journal }
    return { role: n.role }
  }
  const out: QuerySpec = { where: node(spec.where) }
  if (spec.scope) out.scope = spec.scope
  if (spec.sort && spec.sort.length > 0) out.sort = spec.sort.map((k) => ({ by: k.by, dir: k.dir }))
  if (typeof spec.limit === 'number') out.limit = spec.limit
  return out
}

/** 条件是否变了（变了就该重算，不用等用户点刷新） */
export function specChanged(block: Block, next: QuerySpec): boolean {
  const cur = readSpec(block)
  if (!cur) return true
  return JSON.stringify(canonicalSpec(cur)) !== JSON.stringify(canonicalSpec(next))
}

/* ------------------------------------------------------------ 造块 */

/**
 * 造一个**查询块**（内容对象：有名字、能被 `[[ ]]` 引用、能进回收站）。
 *
 * 与 local tab 的分工写在这里：`_query` 是这个块的**身份**（有合法条件 ＝ 查询源），
 * 所以它不能被复制成两个（`tree.ts` 的 `IDENTITY_PROPS` 会把它剥掉）。
 *
 * ⚠️ 视图配置只在 `views.length > 0` 时才写那一格：空数组会让「有没有配过视图」
 *    有两份答案（空 vs 没有），而读路径对两者本该给同一个结果。
 */
export function mkQueryBlock(opts: {
  name: string
  spec: QuerySpec
  views?: readonly ViewConfig[]
  activeView?: string
  icon?: string
}): Block {
  // 属性袋由 `withBlockOwnerData` 拼：'配置住哪'只有一份写法（空集合一律删掉那一格）
  const props = withBlockOwnerData(
    opts.icon !== undefined && opts.icon !== '' ? { _icon: opts.icon } : undefined,
    {
      query: canonicalSpec(opts.spec),
      views: canonicalViews(opts.views ?? [], { kind: 'query', spec: opts.spec }),
      ...(opts.activeView !== undefined && opts.activeView !== '' ? { activeView: opts.activeView } : {}),
    },
  )
  return mkBlock(textRuns(opts.name), props ? { props } : {})
}

export type { QueryHit, QuerySpec }
