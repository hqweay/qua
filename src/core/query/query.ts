/**
 * **查询**：一个块要「显示哪些块」的声明。
 *
 * 三层分工，别混：
 *   · **条件**（本文件的 `QuerySpec`）——「选谁、按什么序」，写成 `canonical JSON` 存进块属性 `_query`；
 *   · **结果集**（`runQuery` 的输出）——一次**求值**，**冻结**的是「成员与顺序」；
 *   · **内容**——永远按 `block id` 现读现渲染（D5：集合冻、内容不冻）。
 *
 * ⚠️ 这里零 DOM、零持久化：求值只吃森林（指向边住在块内容里），所以能直接单测。
 * ⚠️ 接索引后本文件的签名不变：`evaluateQuery`（判定与顺序）由两条路径共用，
 *    索引路径见 `index-port.ts` 的 `queryByIndex`；`QuerySpec` 仍是那个 canonical JSON。
 */
import { isJournalBlock, isPropDefBlock, primaryAliasOf, type Block } from '../model/model.ts'
import { plainText } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { findPath } from '../model/tree.ts'
import { findTagByName, tagIdsOf, tagMemberIds } from '../identity/tags.ts'
import { journalDays } from '../identity/journal.ts'
import { displayTextOf } from '../identity/alias.ts'
import { fieldTableOf, readField, type FieldTable } from '../props/props.ts'
import { isRefKind, relationEdgesOfForest, REFERENCE_KINDS, type RefKind, type RelationKind } from '../relations/relations.ts'
import type { KbClient } from '../kb/types.ts'

/* ------------------------------------------------------------ 条件形状 */

/**
 * 条件**原子**。够表达「反链」「某标签下的块」「某天之后改过的待办」这类常见诉求，
 * 且每一种都能用一次线性扫描算出来（不用索引）。
 *
 * ⚠️ **能用通用属性条件表达的，就别造专用键**：专用键每多一个，`canonicalSpec` 就要多一支，
 *    漏一处 = 条件存进 `_query` 时被静默丢掉（而丢掉的后果是「条件没变、结果却对不上」）。
 *
 * ⚠️ **待办没有专用键**：三态用属性条件就能写全 ——
 *    「不是任务」＝ `{prop:{id, exists:false}}`、「未完成」＝ `{prop:{id, eq:false}}`、
 *    「已完成」＝ `{prop:{id, eq:true}}`。曾经有一个 `{todo}` 原子，理由是「有槽未填」
 *    （屏幕上画着空心方框的块）用属性条件问不出来；那条理由的病根在**读通道**：
 *    判「有没有这一栏」只看了值，漏了 `_ownProps` 与**标签声明**。
 *    读侧归一之后（`core/props.ts` 的 `readField`）三态只剩一种写法，专用键就是第二份答案。
 *
 * 组合：`{ all: [...] }` / `{ any: [...] }` / `{ not: ... }`，可嵌套。
 * ⚠️ **不加 `mentions`**：未链接提及＝`text` 里出现某个词，那是全文检索的事，
 *    塞进这里会让「引用」与「文本匹配」变成同一个东西，反链语义当场糊掉。
 */
/**
 * `ref` 的值位：字符串＝默认的全部引用 kind；对象＝可收窄到某几类。
 *
 * `inline` 是正文里的 `[[ ]]`，`property` 是 `kind:'ref'` 的属性值，`embed` 是露面。
 * 标签归属**不在**这里：它是分类（`tag`），不是引用。
 */
export interface RefTarget {
  to: string
  kind?: RefKind | readonly RefKind[]
}

/** 条件里的 ref 目标 id（字符串与对象两态只有一个读法） */
export function refTargetOf(ref: string | RefTarget): string {
  return typeof ref === 'string' ? ref : ref.to
}

/** 条件里的 ref kind（缺省＝全部引用 kind） */
export function refKindsOf(ref: string | RefTarget): readonly RefKind[] {
  if (typeof ref === 'string') return REFERENCE_KINDS
  if (ref.kind === undefined) return REFERENCE_KINDS
  if (typeof ref.kind === 'string') return [ref.kind]
  return ref.kind
}

export type QueryNode =
  /** 直接指向 `targetId` 的块（反链的最小形态：只认 id，不认 label） */
  | { ref: string | RefTarget }
  /** 带某个标签的块：按**归属边**判定（见 `matches`），名字解析不到就是空集 */
  | { tag: string }
  /** 正文包含某串 */
  | { text: string }
  /**
   * 某属性**等于某值**，或**有没有这一栏**。
   *
   * 属性条件是**通用路径**：键是定义块的 id（不是名字），所以改显示名不影响查询语义；
   * 类型、日期这类身份位也是 `props` 里的槽，所以同一个条件能把它们都问到。
   * `Object.is` 让 `false` 与 `undefined`（未填）严格区分开。
   *
   * `eq` 与 `exists` **互斥**；同时给时按 `exists` 判（不猜）。
   * 「有没有这一栏」问的是 `core/props.ts` 的 `fieldDeclared`（值 ∪ 自有槽 ∪ 标签声明），
   * 不是「值键在不在」—— 后者会让标签声明的字段、面板刚加的空槽从查询里消失。
   *
   * ⚠️ **布尔属性声明了就等于 `false`**（勾选框没有「未填」这一态）。所以
   *    `{prop:{id, eq:false}}` 命中「点了但没做完」，也命中「一次都没点过、靠标签声明的」。
   */
  | { prop: { id: string } & PropOp }
  /**
   * **就是这一块**（身份判定，不是成员判定）。
   *
   * 与 `ref` 的分工：`ref` 问「谁引用了它」，这一条问「它自己」。
   */
  | { is: string }
  /**
   * **存在一个祖先**满足这个条件（祖先链**不含自己**）。
   *
   * 方向是独立的一轴，不是另一种组：任意条件都能套进任意方向，
   * 所以「上级匹配所有／任一」「链条里匹配」不必各造一个组。
   * 「在某一天下面」＝ `{up:{all:[{role:'journal'},{prop:{id:'_date',eq:'2026-10-20'}}]}}`；
   * 天自己不会入选——它的祖先链里没有自己。
   */
  | { up: QueryNode }
  /** **存在一个子孙**满足这个条件（子树不含自己） */
  | { down: QueryNode }
  /** 自己／祖先／子孙 **任一处**满足这个条件 */
  | { near: QueryNode }
  /**
   * **是某种东西**的块本身（成员条件）。
   *
   * ⚠️ 与方向原子的分工写死：`{up}`／`{down}` 问的是**位置**（谁在谁下面），
   *    `{role:'journal'}` 问的是**身份**（这块是不是日记）。所以「某一天下面」
   *    不再是 `{journal:日期}`，而是 `{up:{all:[{role:'journal'},{prop:{_date,eq}}]}}`：
   *    方向与条件正交之后，它可进 `any`／`not`，也不偷换候选集。
   * ⚠️ 逐值分发到**既有唯一判据**，不另设第二份答案：journal 的判据只有「`_date` 在不在」。
   *    值域首版只实现 `journal`（有日期表可查）；`page`／`tag` 留轴，进值域时在此续支。
   */
  | { role: 'journal' }
  | { all: QueryNode[] }
  | { any: QueryNode[] }
  | { not: QueryNode }

/** 一个排序键：按**属性 id** 取值升/降序（与属性条件同一个理由：键是 id，改名不影响语义） */
/**
 * 属性条件上的**一个算子**（`{prop:{id}}` 与它组合）。
 *
 * 为什么是「一个算子」而不是「一串算子」：多个算子写在同一条上时，
 * `canonicalSpec` 要判 `and` 还是 `or`，而那个问题在**条件树**那一层已经有了答案
 * （`all`／`any`）。在这里再造一个组合层，等于让同一件事有两种写法。
 *
 * 九个算子分三组，语义各不同：
 *
 * | 组 | 算子 | 判据 |
 * |---|---|---|
 * | 值比较 | `eq`／`neq`／`contains`／`gt`／`gte`／`lt`／`lte` | **有这一栏**才比（没有就是不匹配） |
 * | 栏存在 | `exists` | 值 ∪ 自有槽 ∪ 标签声明（`false` ＝ 这块没有这一栏） |
 * | 空/非空 | `empty` | 值算不算空（`undefined`／`null`／`''`／`[]`） |
 *
 * ⚠️ `empty` 与 `exists` **必须分开**：文本字段「有这一栏、还没填」是前者的典型问法，
 *    「这块没有这一栏」是后者。合成一个算子，就再也问不出前者。
 * ⚠️ **布尔属性没有「未填」**：声明了就按 `false` 读（见 `core/props.ts` 的 `readField`）
 *    ⇒ 对它而言 `empty:true` 只剩「这块没有这一栏」一种命中（与 `exists:false` 同义）。
 * ⚠️ `neq` 只对**有这一栏**的块成立（与 `eq` 同一条口径）。「没有这一栏」也算「不等于」
 *    的话，`neq` 会突然变成「绝大多数块」，而那不是用户想问的。
 */
export type PropOp =
  | { eq: unknown }
  | { neq: unknown }
  /** 正文/值里含这一串（数组按任一元素判，其余按字符串化判） */
  | { contains: string }
  | { gt: unknown }
  | { gte: unknown }
  | { lt: unknown }
  | { lte: unknown }
  | { exists: boolean }
  | { empty: boolean }

export interface SortKey {
  by: string
  dir: 'asc' | 'desc'
  /** 只给 `by:'random'` 用：同一份种子 ⇒ 同一个「随机」序（成员顺序是冻结契约的一部分，每次刷新换一批就没法回访） */
  seed?: number
}

/**
 * 整个查询：条件 ＋ 顺序。
 *
 * ⚠️ **没有「范围」**：原 `scope`（这一块之下／全库）已并进方向轴——
 *    「这一块之下」＝条件 `{up:{is:'$self'}}`，「全库」＝没有这条。
 *    两条轴答同一件事必漂移，且方向条件能表达范围表达不了的东西
 *    （`{up:{tag:X}}`、`{not:{up:{is:X}}}`）。语义收窄一处：不再含锚块自己。
 *
 * ⚠️ **没有顶层 `todo`**，也**没有 `{todo}` 原子**：三态由属性条件表达
 *    （见 `QueryNode` 那一段）。曾经两种写法并存，于是同一条语义有两份表示，
 *    能同时写上并静默 AND —— 用户看到的是「条件就写了这一条，结果却像两条」。
 */
export interface QuerySpec {
  where: QueryNode
  /**
   * **成员顺序**：取哪些、按什么序（在 `limit` 之前生效）。
   *
   * ⚠️ 与「显示排序」是两件事：显示排序住在视图配置上（`ViewConfig.table.sort`），
   *    点表头只改当前这批成员的显示序，**不重查**。写 `_query.sort` 会让
   *    「按这一列排一下」变成「换一批行」。
   */
  sort?: SortKey[]
  /** 取多少条（在排序之后截断，所以「取最新的 3 天」取得到）；缺省不限 */
  limit?: number
}

/* ------------------------------------------------------------ 求值 */

/**
 * **查询上下文**：一次求值相对什么。三件事分开给，不许合并。
 *
 * | 字段 | 回答 |
 * |---|---|
 * | `selfId` | 条件里的 `'$self'` 指谁 |
 * | `excludeIds` | 结果里剔除谁 |
 *
 * ⚠️ 为什么 `selfId` 不再顺带排除：那是两件事被塞进同一个字段的后果 ——
 *    想解析 `$self`，就不得不把它从结果里去掉；而「查询块自己不该出现在自己的结果里」
 *    与「宿主不该出现在挂载区里」是**各自独立**的两条规则，合并之后只能成对表达。
 */
export interface QueryContext {
  selfId?: string
  excludeIds?: readonly string[]
}

/** 上下文的**稳定串**（冻结结果的判据之一；顺序无关 ⇒ 排序后再拼） */
export function contextKey(ctx: QueryContext): string {
  const ex = [...new Set((ctx.excludeIds ?? []).filter((x) => typeof x === 'string' && x !== ''))].sort()
  return JSON.stringify({ selfId: ctx.selfId ?? null, excludeIds: ex })
}

/**
 * 按上下文求值。**只读**：不写块、不改 `_query`。
 *
 * 走读门面（索引路径），调用方不必持有整片森林。
 */
export function evaluateQuerySpec(
  spec: QuerySpec,
  kb: Pick<KbClient, 'query'>,
  ctx: QueryContext,
): QueryHit[] {
  return kb.query(spec, { selfId: ctx.selfId, excludeIds: ctx.excludeIds })
}

export interface QueryRunInput {
  blocks: readonly Block[]
  /**
   * **宿主块**：条件里的 `'$self'` 按它解析。
   *
   * ⚠️ **它不再顺带把自己从结果里剔除** —— 那是 `excludeIds` 的事。
   *    曾经两件事都随这个字段而来，于是「想解析 `$self`，又不得不排除它」
   *    这种形状无法表达（挂载区的宿主不进结果是位置性质，查询块自己不进结果是
   *    另一条规则，两者曾经只能成对生效）。
   * 普通查询块不传它 ⇒ 条件里的 `$self` 解析不了 ⇒ 空结果（调用方给一行提示）。
   */
  selfId?: string
  /** 结果里剔除这些块（`selfId` 之外的独立一条） */
  excludeIds?: readonly string[]
}

/** 一条结果：块 id ＋ 它在森林里的路径（D8：可编辑列表必须给上下文，否则不知道这条住哪） */
export interface QueryHit {
  blockId: string
  /** 从根到**父块**的祖先链（不含自己）；`[]` ＝ 顶层 */
  path: string[]
}

function walk(blocks: readonly Block[], fn: (b: Block, ancestors: Block[]) => void): void {
  walkForest(blocks, (b, ctx) => {
    /**
     * **属性定义的子树不是内容行**：它的子块是选项、选项的子块是说明 ——
     * 把其中任何一层当查询结果，等于把「这条属性能选什么」当成「库里有这几条内容」。
     *
     * 判据用**祖先链**（不含自己）：`walkForest` 的 visitor 返回 `undefined` 不会剪枝，
     * 只看直接父块会漏掉选项的子块。定义块自己**仍然可查** —— 它是一块有属性的块，
     * `_kind`／`_type` 这类通用属性条件是「哪些定义是日期」的唯一问法。
     */
    const ancestors = ctx.path.slice(0, -1)
    if (ancestors.some(isPropDefBlock)) return
    fn(b, ancestors)
  })
}

/**
 * 谓词环境：`ref`／`tag` 条件已经**按条件收好**的块 id 集合。
 *
 * 为什么单独立一份：求值有两条路 —— 纯函数路径从森林收集，
 * 索引路径从 `IndexPort` 的表里查表；**判定与顺序只有一份**（`evaluateQuery`），
 * 两条路只许在「环境怎么来」上不同。
 */
export interface QueryEnv {
  refs: ReadonlySet<string>
  tags: ReadonlySet<string>
  /**
   * **字段读取表**：判「这块有没有这一栏」要看标签声明与定义 kind，
   * 两条求值路径都必须给同一份（`core/props.ts` 的 `fieldTableOf`）。
   */
  fields: FieldTable
  /**
   * 结果里剔除这些块。
   *
   * 它不进 spec，因为「看不见自己」是**位置**的性质（挂在这一块下面、或这就是
   * 查询块自己），不是条件的性质：写进条件就成了「同一份条件换个地方求值结果不同」。
   *
   * ⚠️ 与 `selfId` 分开：那条只负责解析 `'$self'`，不再顺带排除。
   */
  excludeIds?: ReadonlySet<string>
}

/**
 * 谓词判定与**顺序**的唯一一份实现：按森林先序走，命中即收，
 * 有 `sort` 时按 spec 排序，最后按 `limit` 截断（先排序后截断——「取最新的 3 天」才取得到）。
 *
 * ⚠️ 顺序是契约的一部分（「冻结」保存的是输出的 `blockId[]`）：缺省按森林先序，
 *    索引的插入顺序在挪位之后会漂移，不能拿来当序；`sort` 是 spec 的一部分，
 *    同值时稳定排序保留森林先序。
 * ⚠️ `forest` 是**位置事实的来源**：候选集可以被 `roots` 收窄（锚点／范围），
 *    但 `{up}` 要看得见锚点上面的祖先、`{down}` 要看得见整棵子树——两者不是一回事。
 */
export function evaluateQuery(
  spec: QuerySpec,
  roots: readonly Block[],
  env: QueryEnv,
  forest: readonly Block[] = roots,
): QueryHit[] {
  const matcher = createMatcher(forest, env)
  const hits: { blockId: string; path: string[]; block: Block }[] = []
  /** 收窄过的候选集里，同一块可能既当「后代」又当「候选根」被走到——一条结果只许出现一次 */
  const seen = new Set<string>()
  walk(roots, (b, ancestors) => {
    if (env.excludeIds?.has(b.id)) return
    if (!matcher.matches(spec.where, b)) return
    if (seen.has(b.id)) return
    seen.add(b.id)
    hits.push({ blockId: b.id, path: ancestors.map((a) => a.id), block: b })
  })
  applySort(hits, spec.sort, forest)
  const size = typeof spec.limit === 'number' ? Math.max(0, spec.limit) : hits.length
  return hits.slice(0, size).map(({ blockId, path }) => ({ blockId, path }))
}

/**
 * 排序键可能不止一个：从最后一个键往前排，稳定排序让写在前面的键成为主键。
 *
 * 取值不只属性袋（保留键 H 批：能显示的列也要能排序）——`created`／`modified` 是块字段，
 * `refCount` 是关系事实（引用几处是这一刻的派生，不进属性袋）、一次扫描整林现算，
 * `random` 按 (块 id, 种子) 确定性散列——同一种子同一序，「随机抽 N 条」才回访得回来。
 * `path`／`matched`／`sharedTags` 仍未接：按什么比要先有语义（path 是深度还是链上名字？）。
 */
function applySort(hits: { block: Block }[], sort: readonly SortKey[] | undefined, forest: readonly Block[]): void {
  if (!sort || sort.length === 0) return
  const refCounts = sort.some((s) => s.by === 'refCount')
    ? (() => {
        const m = new Map<string, number>()
        for (const e of relationEdgesOfForest(forest).edges) m.set(e.to, (m.get(e.to) ?? 0) + 1)
        return m
      })()
    : undefined
  for (let i = sort.length - 1; i >= 0; i--) {
    const { by, dir, seed } = sort[i]!
    const sign = dir === 'desc' ? -1 : 1
    hits.sort((x, y) => {
      const xv = sortValueOf(x.block, by, seed, refCounts)
      const yv = sortValueOf(y.block, by, seed, refCounts)
      if (xv === undefined || yv === undefined) {
        if (xv === undefined && yv === undefined) return 0
        return xv === undefined ? 1 : -1
      }
      return sign * cmpValues(xv, yv)
    })
  }
}

/** 排序键的取值：属性键读属性袋，保留键读块字段与派生量（与保留列键同名同义） */
function sortValueOf(b: Block, by: string, seed: number | undefined, refCounts: ReadonlyMap<string, number> | undefined): unknown {
  if (by === 'created') return b.created
  if (by === 'modified') return b.modified
  if (by === 'refCount') return refCounts?.get(b.id) ?? 0
  if (by === 'random') return randomOf(b.id, seed)
  return b.props?.[by]
}

/** (块 id, 种子) → 确定性伪随机：fnv-1a 的 32 位折叠，不引第二份哈希实现 */
function randomOf(id: string, seed: number | undefined): number {
  let h = 2166136261 ^ (seed ?? 0)
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 值的原生比较：数值按大小、其余按字符串序（`_date` 这类 ISO 串字典序即时间序）。异型值不做承诺 */
function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/**
 * 指向 `targetId` 的引用来源块（**一条指向边的另一端**，与渲染无关）。
 *
 * 与索引路径共用 `relationEdgesOfForest` 的提取口径：正文引用／属性引用／嵌入
 * 都算「引用」，标签归属与 `#名` 提及不算。纯函数路径是索引路径的参照实现。
 */
export function refSourceIds(
  forest: readonly Block[],
  targetId: string,
  kinds: readonly RefKind[] = REFERENCE_KINDS,
): Set<string> {
  const out = new Set<string>()
  const allowed = new Set<RelationKind>(kinds)
  for (const e of relationEdgesOfForest(forest).edges) {
    if (e.to === targetId && allowed.has(e.kind)) out.add(e.from)
  }
  return out
}

/**
 * 方向原子的求值器。
 *
 * `{up}`／`{down}`／`{near}` 把「条件」与「方向」拆成两轴之后，判定不再只关于这一块，
 * 而是关于「它和它的位置」：
 *   · `up` 需要祖先链（O(深度)，沿父指针向上）；
 *   · `down` 需要「子树里有没有」——**不许对每个候选块各走一遍子树**（那是 O(n²)）。
 *     这里按 (条件节点, 块) 记忆化：一次求值里每对只算一次，总量仍是 O(条件数 × 块数)。
 *
 * 「可见树」与 `walk` 同一口径：属性定义的子树不是内容行，不进祖先／子孙判定。
 * ⚠️ 记忆化以**条件节点对象**为键：同一份条件里两个写法相同的条件各算一次。
 *    条件树很小，这不是问题；拿结构串当键反而会把 `canonicalSpec` 的口径拖进来。
 */
interface Matcher {
  matches(node: QueryNode, block: Block): boolean
}

function createMatcher(forest: readonly Block[], env: QueryEnv): Matcher {
  /** 位置事实（祖先／子孙）**按需**建：纯 `tag`／`text` 查询不该为方向原子付一次全树遍历 */
  interface VisibleTree {
    byId: Map<string, Block>
    parentOf: Map<string, string | null>
    childrenOf: Map<string, Block[]>
  }
  let tree: VisibleTree | undefined
  const visibleTree = (): VisibleTree => {
    if (tree) return tree
    const byId = new Map<string, Block>()
    const parentOf = new Map<string, string | null>()
    const childrenOf = new Map<string, Block[]>()
    walkForest(forest, (b, ctx) => {
      if (ctx.path.slice(0, -1).some(isPropDefBlock)) return
      byId.set(b.id, b)
      const parent = ctx.parent
      if (parent && byId.has(parent.id)) {
        parentOf.set(b.id, parent.id)
        const siblings = childrenOf.get(parent.id)
        if (siblings) siblings.push(b)
        else childrenOf.set(parent.id, [b])
      } else {
        parentOf.set(b.id, null)
      }
    })
    tree = { byId, parentOf, childrenOf }
    return tree
  }

  /** (节点 → 块 id → 判定)；`downMemo` 单列，理由同 `down` 的两趟：子树判定与自身判定不是一回事 */
  const hitMemo = new Map<QueryNode, Map<string, boolean>>()
  const downMemo = new Map<QueryNode, Map<string, boolean>>()
  /** 正在算的 (节点, 块)：挡条件树里的环（JSON 构造不出，代码直接构造可能） */
  const busy = new Set<string>()
  const nodeIds = new WeakMap<object, number>()
  let nextNodeId = 0
  const keyOf = (node: QueryNode, blockId: string): string => {
    let id = nodeIds.get(node)
    if (id === undefined) {
      id = nextNodeId
      nextNodeId += 1
      nodeIds.set(node, id)
    }
    return `${id}:${blockId}`
  }
  const readMemo = (
    memo: Map<QueryNode, Map<string, boolean>>,
    node: QueryNode,
    blockId: string,
  ): boolean | undefined => memo.get(node)?.get(blockId)
  const writeMemo = (
    memo: Map<QueryNode, Map<string, boolean>>,
    node: QueryNode,
    blockId: string,
    value: boolean,
  ): void => {
    const forNode = memo.get(node)
    if (forNode) forNode.set(blockId, value)
    else memo.set(node, new Map([[blockId, value]]))
  }

  /** 存在一个祖先满足条件（祖先链不含自己） */
  const hasAncestor = (node: QueryNode, blockId: string): boolean => {
    const { byId, parentOf } = visibleTree()
    let cur = parentOf.get(blockId) ?? null
    while (cur !== null) {
      const parent = byId.get(cur)
      if (parent && matches(node, parent)) return true
      cur = parentOf.get(cur) ?? null
    }
    return false
  }

  /** 存在一个子孙满足条件（子树不含自己） */
  const hasDescendant = (node: QueryNode, blockId: string): boolean => {
    const memoized = readMemo(downMemo, node, blockId)
    if (memoized !== undefined) return memoized
    const { childrenOf } = visibleTree()
    const key = `d${keyOf(node, blockId)}`
    if (busy.has(key)) return false
    busy.add(key)
    let hit = false
    for (const child of childrenOf.get(blockId) ?? []) {
      if (matches(node, child) || hasDescendant(node, child.id)) {
        hit = true
        break
      }
    }
    busy.delete(key)
    writeMemo(downMemo, node, blockId, hit)
    return hit
  }

  const matches = (node: QueryNode, block: Block): boolean => {
    const memoized = readMemo(hitMemo, node, block.id)
    if (memoized !== undefined) return memoized
    const key = `m${keyOf(node, block.id)}`
    if (busy.has(key)) return false
    busy.add(key)
    const result = compute(node, block)
    busy.delete(key)
    writeMemo(hitMemo, node, block.id, result)
    return result
  }

  const compute = (node: QueryNode, block: Block): boolean => {
    if ('all' in node) return node.all.every((n) => matches(n, block))
    if ('any' in node) return node.any.some((n) => matches(n, block))
    if ('not' in node) return !matches(node.not, block)
    if ('is' in node) return block.id === node.is
    if ('up' in node) return hasAncestor(node.up, block.id)
    if ('down' in node) return hasDescendant(node.down, block.id)
    if ('near' in node) {
      return matches(node.near, block) || hasAncestor(node.near, block.id) || hasDescendant(node.near, block.id)
    }
    if ('role' in node) return roleMatches(node.role, block)
    if ('ref' in node) return env.refs.has(block.id)
    /**
     * 标签条件：**按边判定**，不扫文本。
     *
     * 标签＝指向标签块的边，判定只在 `core/tags.ts` 里发生（`tagMemberIds`）。
     * 不要在正文上再扫一遍 `#tag`：那会得到「看起来是标签的文本」与「真的是一条边」
     * 两套答案 —— 两条路径对同一个块说法不一，改名也不同步。
     * 名字→标签块只解析一次（`collectTags`），不在逐块判定里查，
     * 否则一次查询会退化成 O(块数 × 条件数) 次森林遍历。
     */
    if ('tag' in node) return env.tags.has(block.id)
    if ('text' in node) return plainText(block.content).includes(node.text)
    if ('prop' in node) {
      /**
       * 先问「有没有这一栏」（值 ∪ 自有槽 ∪ 标签声明），再决定比值、比存在性、还是判空。
       *
       * 这样 `eq: false` 与「没有这一栏」是两件事，`eq: undefined` 也不会误命中所有块；
       * 而「面板刚加的槽」与「靠标签声明拿到的字段」都被算成有 —— 它们屏幕上有方框。
       * **值比较这一类（含 `neq`）只对「有这一栏」的块成立** —— 否则 `neq`
       * 会变成「绝大多数块」，而用户想问的是「这些值不是 A 的那几条」。
       */
      const op = node.prop
      const { declared, value: v } = readField(block, node.prop.id, env.fields)
      if ('exists' in op) return declared === op.exists
      if ('empty' in op) return isEmptyValue(v) === op.empty
      if (!declared) return false
      /**
       * 多值字段的 `eq`/`neq` 按**包含**判（数组里有没有这一项）：
       * 一个块可以选多个值，「等于」在用户眼里就是「其中一个是我要的」。
       * 这不是新算子——同一个 `eq` 在单值上是相等、在多值上是包含，
       * 由值形态决定，条件语言不需要为多值再分一套。
       */
      if ('eq' in op) return Array.isArray(v) ? v.some((x) => Object.is(x, op.eq)) : Object.is(v, op.eq)
      if ('neq' in op) return Array.isArray(v) ? !v.some((x) => Object.is(x, op.neq)) : !Object.is(v, op.neq)
      if ('contains' in op) return valueContains(v, op.contains)
      return compareOp(v, op)
    }
    // 形状不认识（例如旧库里存过的已删原子）⇒ 不命中，不抛。
    // 库里存的那份由 `readSpec` 先验形；能走到这里说明是调用方直接构造的 spec。
    return false
  }

  return { matches }
}

/** role 逐值分发到**既有唯一判据**，不另设第二份答案；进新值域时在此续支 */
function roleMatches(role: 'journal', b: Block): boolean {
  return role === 'journal' ? isJournalBlock(b) : false
}

/**
 * 值算不算「空」。
 *
 * 与 `exists` 分开：对**文本类**字段，`empty:true` 匹配「有这一栏但没有值」**和**
 * 「根本没有这一栏」，而 `exists:false` 只匹配后者 —— 这是两个真问题。
 * 对**布尔**属性不成立：声明了就按 `false` 读，所以 `empty:true` 只剩「没有这一栏」一种命中。
 */
function isEmptyValue(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true
  return Array.isArray(v) && v.length === 0
}

/** 含这一串：数组按**任一元素**判（多值字段的常见问法），其余按字符串化判 */
function valueContains(v: unknown, needle: string): boolean {
  const want = needle.toLowerCase()
  if (want === '') return false
  if (Array.isArray(v)) return v.some((x) => String(x).toLowerCase().includes(want))
  return String(v).toLowerCase().includes(want)
}

/**
 * `gt`／`gte`／`lt`／`lte`。
 *
 * 数值按数值比（**不退化成字典序**：那样 10 会排在 9 前面），其余按字符串比。
 * 一边是数字一边不是 ⇒ 按字符串比（属性值可能是 `"3"` 这种旧输入遗留）。
 */
function compareOp(v: unknown, op: { gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown }): boolean {
  const bound = 'gt' in op ? op.gt : 'gte' in op ? op.gte : 'lt' in op ? op.lt : op.lte
  const cmp = compareValues(v, bound)
  // 比不了（类型不在同一个量纲上）⇒ **不匹配**：`true > 5` 不是一个有意义的答案，
  // 而按字符串比会给它一个（`'true' > '5'`），于是勾选框会出现在「评分大于 5」的结果里。
  if (cmp === null) return false
  if ('gt' in op) return cmp > 0
  if ('gte' in op) return cmp >= 0
  if ('lt' in op) return cmp < 0
  return cmp <= 0
}

/**
 * 两个值比大小：两边都是数字按数值、都是字符串按本地化序；**其余返回 `null`（比不了）**。
 *
 * 与 `view.ts` 的 `compareAny` 同形不合并：那边「比不了」也得给个数（显示排序总要有个先后），
 * 这边 `null` 是**契约**——查询拿它判「不匹配」（`true > 5` 不是有意义的结果，不能给数）。
 */
function compareValues(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  // 属性值可能是 `"3"` 这种旧输入遗留：一边是数字串也按数值比
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, 'zh-Hans-CN', { numeric: true })
  }
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) {
    return a - Number(b)
  }
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) {
    return Number(a) - b
  }
  return null
}

/**
 * where 的**顶层**就是 `{ role: 'journal' }` 本身（日记流形态）。
 *
 * 只有这个形态允许把候选集换成「库里有哪些天」：**一天一个**是身份口径
 * （坏数据里同一天多块时只取先序第一个，与 `journalDays` 同源），不是范围。
 * 嵌进组合里的 role 是普通谓词，收窄会把其它分支的候选丢掉
 * （比如 `{ not: { role: 'journal' } }` 恰恰要非天的块）。
 */
export function isExactRoleJournal(node: QueryNode): boolean {
  return 'role' in node && node.role === 'journal'
}

/** 属性条件上认得的算子（验形与 `PropOp` 保持同一张表） */
const PROP_OP_KEYS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists', 'empty'] as const

/**
 * 落盘/外部送进来的条件**读不读得出来**。
 *
 * 为什么要验：条件语言的形状会变（例如 `{todo}` 原子退场）。旧字节里留着已删的原子时，
 * 求值器只能「不命中」——界面上看起来只是「没有结果」，没有任何线索指向条件。
 * 验形之后，调用方可以把这句话说出来（`readSpec` 返回 `null` ⇒ 那一栏走空态提示），
 * 而不是让一条读不懂的条件悄悄变成空集。
 *
 * ⚠️ 只判**形状**，不判语义：未知的实参值（如 `{role:'page'}`）先放行，由 `roleMatches`
 *    给「不命中」——将来扩值域时不至于把旧条件整条作废。
 * ⚠️ `{prop}` 里有多个算子时放行（求值按 `exists` 优先，见 `PropOp` 的注释）：
 *    那是一条写歪的条件，但它是**读得懂**的，不该被当成「坏了」。
 */
export function isQueryNode(raw: unknown): raw is QueryNode {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const n = raw as Record<string, unknown>
  if ('all' in n) return Array.isArray(n.all) && n.all.every(isQueryNode)
  if ('any' in n) return Array.isArray(n.any) && n.any.every(isQueryNode)
  if ('not' in n) return isQueryNode(n.not)
  if ('is' in n) return typeof n.is === 'string' && n.is !== ''
  if ('up' in n) return isQueryNode(n.up)
  if ('down' in n) return isQueryNode(n.down)
  if ('near' in n) return isQueryNode(n.near)
  if ('ref' in n) {
    if (typeof n.ref === 'string') return true
    const r = n.ref
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false
    const ref = r as Partial<RefTarget>
    if (typeof ref.to !== 'string' || ref.to === '') return false
    if (ref.kind === undefined) return true
    if (typeof ref.kind === 'string') return isRefKind(ref.kind)
    return Array.isArray(ref.kind) && ref.kind.every((k) => isRefKind(k))
  }
  if ('tag' in n) return typeof n.tag === 'string'
  if ('text' in n) return typeof n.text === 'string'
  if ('role' in n) return typeof n.role === 'string'
  if ('prop' in n) {
    const p = n.prop
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false
    const op = p as Record<string, unknown>
    if (typeof op.id !== 'string' || op.id === '') return false
    return PROP_OP_KEYS.some((k) => k in op)
  }
  return false
}

/** 一整份条件读不读得出来（`where` 是必填；`sort`／`limit` 只判形状） */
export function isQuerySpec(raw: unknown): raw is QuerySpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const s = raw as Record<string, unknown>
  if (!isQueryNode(s.where)) return false
  if (s.limit !== undefined && typeof s.limit !== 'number') return false
  if (s.sort !== undefined) {
    if (!Array.isArray(s.sort)) return false
    for (const k of s.sort) {
      if (!k || typeof k !== 'object') return false
      const key = k as Record<string, unknown>
      if (typeof key.by !== 'string' || (key.dir !== 'asc' && key.dir !== 'desc')) return false
    }
  }
  return true
}

/**
 * 条件的**canonical 形状**：键序固定、同一语义只有一种写法。
 *
 * 为什么单一来源：`_query` 与视图切片（`_views[].filter`）都要进 KB、都要能比较
 * 「条件变没变」（冻结的 `specKey` 就是它）。两份 canonical 会让同一份条件的键序
 * 随对象字面量写法漂移，于是「改一次写的顺序」就被判成「条件变了」。
 *
 * ⚠️ **每一种 `QueryNode` 都要在这里有一支**，否则存进 `_query`／`_views` 时会被静默丢掉。
 *    丢掉的后果不是报错，而是「条件看起来没变、结果却对不上」——所以这一支必须与
 *    上面的联合类型逐条对齐，加一个新原子时两处一起加。
 */
export function canonicalNode(n: QueryNode): QueryNode {
  if ('all' in n) return { all: n.all.map(canonicalNode) }
  if ('any' in n) return { any: n.any.map(canonicalNode) }
  if ('not' in n) return { not: canonicalNode(n.not) }
  if ('ref' in n) {
    if (typeof n.ref === 'string') return { ref: n.ref }
    const kinds =
      n.ref.kind === undefined
        ? undefined
        : [...new Set(typeof n.ref.kind === 'string' ? [n.ref.kind] : n.ref.kind)].sort()
    return { ref: { to: n.ref.to, ...(kinds === undefined ? {} : { kind: kinds }) } }
  }
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
  if ('is' in n) return { is: n.is }
  if ('up' in n) return { up: canonicalNode(n.up) }
  if ('down' in n) return { down: canonicalNode(n.down) }
  if ('near' in n) return { near: canonicalNode(n.near) }
  return { role: n.role }
}

/**
 * 求值一次。**纯函数**：同样的输入永远同样的输出顺序（按森林的先序），
 * 这样「冻结」只要保存输出的 `blockId[]` 就够了（D4：冻结成员与顺序）。
 *
 * ⚠️ 索引路径（`index-port.ts` 的 `queryByIndex`）与环境收集方式不同、判定与顺序共用本函数。
 * ⚠️ `'$self'` 的解析只有一份（`resolveSelfSpec`），两条路径都在**求值第一行**调它。
 */
export function runQuery(spec: QuerySpec, input: QueryRunInput): QueryHit[] {
  const host = input.selfId !== undefined ? findById(input.blocks, input.selfId) : undefined
  // 含 `$self` 却没有宿主 ⇒ 空结果。**不退回全库**：那会把「看不懂的指代」变成一次大范围命中，
  // 而用户看到的只是「结果不对」，没有任何线索指向条件。
  if (!host && usesSelf(spec.where)) return []
  const q = host ? resolveSelfSpec(spec, host, input.blocks) : spec
  const env: QueryEnv = {
    refs: collectRefs(q.where, input.blocks),
    tags: collectTags(q.where, input.blocks),
    fields: fieldTableOf(input.blocks),
    ...(input.excludeIds && input.excludeIds.length > 0 ? { excludeIds: new Set(input.excludeIds) } : {}),
  }
  const roots: readonly Block[] = input.blocks

  /**
   * 成员条件的候选集：顶层就是 `{role:'journal'}` 时，「库里有哪些天」的**一天一个**
   * 口径就是候选集（同一天多块的坏数据只取先序第一个）。
   * 它不是范围条件：判定不做任何特殊处理，换掉的只是同一批块去掉重复后的集合。
   */
  const memberRoots = isExactRoleJournal(q.where) ? journalDays(input.blocks) : roots
  return evaluateQuery(q, memberRoots, env, input.blocks)
}

/* ------------------------------------------------------------ `$self`：相对条件 */

/**
 * 条件里有没有 `'$self'` 这个**字符串哨兵**。
 *
 * 为什么是字符串而不是新原子：`canonicalSpec` 逐条列了每一种条件、只存字面量——
 * 加一个 `{self:true}` 原子就要两边一起加，而它表达的东西本来就能用**已有的值位**说清
 * （「指向我」「我这天」「我的标签」「我的可读文本」）。哨兵只是这些值位的一个特殊取值。
 */
export function usesSelf(node: QueryNode): boolean {
  if ('all' in node) return node.all.some(usesSelf)
  if ('any' in node) return node.any.some(usesSelf)
  if ('not' in node) return usesSelf(node.not)
  if ('up' in node) return usesSelf(node.up)
  if ('down' in node) return usesSelf(node.down)
  if ('near' in node) return usesSelf(node.near)
  if ('is' in node) return node.is === SELF
  if ('ref' in node) return refTargetOf(node.ref) === SELF
  if ('tag' in node) return node.tag === SELF
  if ('text' in node) return node.text === SELF
  if ('prop' in node) return 'eq' in node.prop && node.prop.eq === SELF
  return false
}

/** 哨兵字面量：条件里写它 ＝ 「这一块自己」的这一侧面 */
export const SELF = '$self'

/**
 * 把条件里的 `'$self'` 解析成**宿主的这一侧面**。纯函数，不改入参。
 *
 * | 条件 | 解析成 |
 * |---|---|
 * | `{is:'$self'}` | 宿主自己 |
 * | `{ref:'$self'}` | 指向宿主 id |
 * | `{tag:'$self'}` | 宿主带的那几个标签（`any` 并集） |
 * | `{text:'$self'}` | 宿主的可读文本（`displayTextOf`） |
 * | `{prop:{id, eq:'$self'}}` | 宿主**同一属性**的值（没有这一栏／值为空 ⇒ 永不命中） |
 *
 * 「在某一天下面」不再有专用值位：它是 `{up:{all:[{role:'journal'},{prop:{id:'_date',eq:'$self'}}]}}`
 * —— 日期本身用通用属性条件问，`$self` 只回答「宿主那一格的值」。
 *
 * ⚠️ **解析只写这一处**：纯函数路径与索引路径在求值第一行调它。写第二份就会得到
 *    「同一个 tab 在两条路径下结果不同」，而那是不报错的。
 * ⚠️ 解析出**空值**（宿主没有这一栏／可读文本／标签为空）⇒ 换成一条**永不命中**的条件，
 *    而不是把空串当成值去比 —— `{text:''}` 会命中所有块，`{eq:''}` 同理。
 * ⚠️ `{tag}` 要的是**名字**（`findTagByName` 的口径），而 `_tags` 存的是 id ⇒ 这里做一次
 *    「id → 主名」翻译；`resolveSelfSpec` 因此需要森林（标签块得先找得到）。
 */
export function resolveSelfSpec(spec: QuerySpec, host: Block, forest: readonly Block[]): QuerySpec {
  const tagNames = tagIdsOf(host)
    .map((id) => findById(forest, id))
    .map((tag) => (tag ? primaryAliasOf(tag) : ''))
    .filter((name) => name.trim() !== '')
  /** 字段表按需建：只有 `eq:'$self'` 需要它，普通条件不该为它付一次全库扫描 */
  let fields: FieldTable | undefined
  const node = (n: QueryNode): QueryNode => {
    if ('all' in n) return { all: n.all.map(node) }
    if ('any' in n) return { any: n.any.map(node) }
    if ('not' in n) return { not: node(n.not) }
    if ('up' in n) return { up: node(n.up) }
    if ('down' in n) return { down: node(n.down) }
    if ('near' in n) return { near: node(n.near) }
    if ('is' in n) return { is: n.is === SELF ? host.id : n.is }
    if ('ref' in n) {
      const to = refTargetOf(n.ref) === SELF ? host.id : refTargetOf(n.ref)
      return typeof n.ref === 'string' ? { ref: to } : { ref: { ...n.ref, to } }
    }
    if ('prop' in n) {
      if (!('eq' in n.prop) || n.prop.eq !== SELF) return n
      fields ??= fieldTableOf(forest)
      const { declared, value } = readField(host, n.prop.id, fields)
      if (!declared || value === undefined || value === null || value === '') return NEVER
      return { prop: { id: n.prop.id, eq: value } }
    }
    if ('tag' in n) {
      if (n.tag !== SELF) return { tag: n.tag }
      if (tagNames.length === 0) return NEVER
      return { any: tagNames.map((tag) => ({ tag })) }
    }
    if ('text' in n) {
      if (n.text !== SELF) return { text: n.text }
      const text = displayTextOf(host)
      return text === '' ? NEVER : { text }
    }
    return n
  }
  return { ...spec, where: node(spec.where) }
}

/**
 * 「永不命中」的条件：`{any: []}` 的判定是 `[].some(...)` ＝ `false`。
 *
 * ⚠️ 不用 `{all: []}`：那是**恒真**（`[].every(...)`），正好相反。
 */
const NEVER: QueryNode = { any: [] }


/** 条件里所有 `ref` 的目标（用于一次性收集 refs，避免每个块都扫一遍内容） */
function collectRefs(node: QueryNode, forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('up' in n) visit(n.up)
    else if ('down' in n) visit(n.down)
    else if ('near' in n) visit(n.near)
    else if ('ref' in n) {
      for (const id of refSourceIds(forest, refTargetOf(n.ref), refKindsOf(n.ref))) out.add(id)
    }
  }
  visit(node)
  return out
}

/**
 * 满足 `tag` 条件的**块 id** 集合（一次性算出，理由同 `collectRefs`）。
 *
 * ⚠️ 标签名先解析成标签块 id，再按归属查：认 id 不认名字 ⇒ 标签改名不影响查询语义。
 *    名字解析不到 ⇒ **空集**（那个标签还不存在，自然没有块带它）—— 不是「当文本搜」。
 */
function collectTags(node: QueryNode, forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('up' in n) visit(n.up)
    else if ('down' in n) visit(n.down)
    else if ('near' in n) visit(n.near)
    else if ('tag' in n) {
      const tag = findTagByName(forest, n.tag)
      if (tag) for (const id of tagMemberIds(tag.id, forest)) out.add(id)
    }
  }
  visit(node)
  return out
}

/** 在森林里按 id 找块。复用 `tree.ts` 的 `findPath`（不另写一份遍历） */
export function findById(blocks: readonly Block[], id: string): Block | undefined {
  const path = findPath(blocks, id)
  return path ? path[path.length - 1] : undefined
}
