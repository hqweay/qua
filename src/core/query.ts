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
import { isJournalBlock, isPropDefBlock, primaryAliasOf, type Block } from './model.ts'
import { plainText, refRunsOf } from './runs.ts'
import { walkForest } from './walk.ts'
import { findPath } from './tree.ts'
import { findTagByName, tagIdsOf, tagMemberIds } from './tags.ts'
import { findJournalDay, journalDate, journalDays } from './journal.ts'
import { displayTextOf } from './alias.ts'
import { fieldTableOf, readField, type FieldTable } from './props.ts'
import type { KbClient } from './kb/types.ts'

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
export type QueryNode =
  /** 直接指向 `targetId` 的块（反链的最小形态：只认 id，不认 label） */
  | { ref: string }
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
  /** 某天（`YYYY-MM-DD`）的日记块**下面的块** */
  | { journal: string }
  /**
   * **是某种东西**的块本身（成员条件）。
   *
   * ⚠️ 与 `journal` 的分工写死：**范围条件把 journal 块当容器**（钻进那天下面找），
   *    **成员条件把它当结果**（天自己入选）。所以「journal 块不当结果」的排除规则
   *    只挂在范围条件上（见 `evaluateQuery` 的 `env.journalDate`），`role` 不触发它。
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
}

/**
 * 整个查询：条件 ＋ 范围 ＋ 顺序。
 *
 * ⚠️ **没有顶层 `todo`**，也**没有 `{todo}` 原子**：三态由属性条件表达
 *    （见 `QueryNode` 那一段）。曾经两种写法并存，于是同一条语义有两份表示，
 *    能同时写上并静默 AND —— 用户看到的是「条件就写了这一条，结果却像两条」。
 */
export interface QuerySpec {
  where: QueryNode
  /**
   * 从哪个容器往下找。缺省 `subtree`：
   * 根 Enter 建的子块只有渲染子树才看得见，否则就是「建了但看不见」（D8）。
   */
  scope?: 'subtree' | 'all'
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
 * | `scopeId` | `scope:'subtree'` 的锚点 |
 * | `excludeIds` | 结果里剔除谁 |
 *
 * ⚠️ 为什么 `selfId` 不再顺带排除：那是两件事被塞进同一个字段的后果 ——
 *    想解析 `$self`，就不得不把它从结果里去掉；而「查询块自己不该出现在自己的结果里」
 *    与「宿主不该出现在挂载区里」是**各自独立**的两条规则，合并之后只能成对表达。
 */
export interface QueryContext {
  selfId?: string
  scopeId?: string
  excludeIds?: readonly string[]
}

/** 上下文的**稳定串**（冻结结果的判据之一；顺序无关 ⇒ 排序后再拼） */
export function contextKey(ctx: QueryContext): string {
  const ex = [...new Set((ctx.excludeIds ?? []).filter((x) => typeof x === 'string' && x !== ''))].sort()
  return JSON.stringify({ selfId: ctx.selfId ?? null, scopeId: ctx.scopeId ?? null, excludeIds: ex })
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
  return kb.query(spec, { scopeId: ctx.scopeId, selfId: ctx.selfId, excludeIds: ctx.excludeIds })
}

export interface QueryRunInput {
  blocks: readonly Block[]
  /** 求值范围锚点：`scope: 'subtree'` 时只在这个块（含）之下找 */
  anchorId?: string
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
 * 谓词环境：`ref`／`tag` 条件已经**按条件收好**的块 id 集合（外加 `journal` 范围条件）。
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
  /** 条件里第一个 `journal` 日期；没有 ⇒ `null`（此时它是普通组合，不当范围用） */
  journalDate: string | null
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
 */
export function evaluateQuery(spec: QuerySpec, roots: readonly Block[], env: QueryEnv): QueryHit[] {
  const hits: { blockId: string; path: string[]; block: Block }[] = []
  /** 收窄过的候选集（如 role:'journal' 走天表）里，同一块可能既当「后代」又当「候选根」被走到——一条结果只许出现一次 */
  const seen = new Set<string>()
  walk(roots, (b, ancestors) => {
    if (env.excludeIds?.has(b.id)) return
    if (env.journalDate && isJournalBlock(b)) return
    if (!matches(spec.where, b, env)) return
    if (seen.has(b.id)) return
    seen.add(b.id)
    hits.push({ blockId: b.id, path: ancestors.map((a) => a.id), block: b })
  })
  applySort(hits, spec.sort)
  const size = typeof spec.limit === 'number' ? Math.max(0, spec.limit) : hits.length
  return hits.slice(0, size).map(({ blockId, path }) => ({ blockId, path }))
}

/** 排序键可能不止一个：从最后一个键往前排，稳定排序让写在前面的键成为主键 */
function applySort(hits: { block: Block }[], sort: readonly SortKey[] | undefined): void {
  if (!sort || sort.length === 0) return
  for (let i = sort.length - 1; i >= 0; i--) {
    const { by, dir } = sort[i]!
    const sign = dir === 'desc' ? -1 : 1
    hits.sort((x, y) => {
      const xv = x.block.props?.[by]
      const yv = y.block.props?.[by]
      if (xv === undefined || yv === undefined) {
        if (xv === undefined && yv === undefined) return 0
        return xv === undefined ? 1 : -1
      }
      return sign * cmpValues(xv, yv)
    })
  }
}

/** 值的原生比较：数值按大小、其余按字符串序（`_date` 这类 ISO 串字典序即时间序）。异型值不做承诺 */
function cmpValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

/** 指向 `targetId` 的引用 run 所在的块 id 集合（**一条指向边的另一端**，与渲染无关） */
export function refSourceIds(forest: readonly Block[], targetId: string): Set<string> {
  const out = new Set<string>()
  walkForest(forest, (b) => {
    for (const r of refRunsOf(b.content)) {
      // 行内标签（flavor '#'）是归属的露面，不是指向边——与索引的 `incoming` 同一口径
      if (r.flavor === undefined && r.to === targetId) out.add(b.id)
    }
  })
  return out
}

/**
 * 标签条件：**按边判定**，不扫文本。
 *
 * ⚠️ 标签＝指向标签块的边，**判定只在 `core/tags.ts` 里发生**（`tagMemberIds`）。
 *    不要在正文上再扫一遍 `#tag`：那会得到「看起来是标签的文本」与「真的是一条边」
 *    两套答案 —— 两条路径对同一个块说法不一，改名也不同步。
 *
 * ⚠️ 名字→标签块只解析一次（`collectTags`），不在 `matches` 里逐个块查，
 *    否则一次查询会退化成 O(块数 × 条件数) 次森林遍历。
 */
function matches(node: QueryNode, b: Block, env: QueryEnv): boolean {
  // ⚠️ `journal` **优先判**：它是「范围」不是「谓词」。若别的键也在同一个对象上（形状写歪了），
  //    先看 `all` 会让范围条件被当成空组合（恒真）——那种退化是静默的，测试也未必抓得住。
  if ('journal' in node) return true
  if ('all' in node) return node.all.every((n) => matches(n, b, env))
  if ('any' in node) return node.any.some((n) => matches(n, b, env))
  if ('not' in node) return !matches(node.not, b, env)
  if ('role' in node) return roleMatches(node.role, b)
  if ('ref' in node) return env.refs.has(b.id)
  if ('tag' in node) return env.tags.has(b.id)
  if ('text' in node) return plainText(b.content).includes(node.text)
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
    const { declared, value: v } = readField(b, node.prop.id, env.fields)
    if ('exists' in op) return declared === op.exists
    if ('empty' in op) return isEmptyValue(v) === op.empty
    if (!declared) return false
    if ('eq' in op) return Object.is(v, op.eq)
    if ('neq' in op) return !Object.is(v, op.neq)
    if ('contains' in op) return valueContains(v, op.contains)
    return compareOp(v, op)
  }
  // 形状不认识（例如旧库里存过的已删原子）⇒ 不命中，不抛。
  // 库里存的那份由 `readSpec` 先验形；能走到这里说明是调用方直接构造的 spec。
  return false
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

/** 两个值比大小：两边都是数字按数值、都是字符串按本地化序；**其余返回 `null`（比不了）** */
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
 * 只有这个形态允许把候选集收窄成「天」——嵌进组合里的 role 是普通谓词，
 * 收窄会把其它分支的候选丢掉（比如 `{ not: { role: 'journal' } }` 恰恰要非天的块）。
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
  if ('ref' in n) return typeof n.ref === 'string'
  if ('tag' in n) return typeof n.tag === 'string'
  if ('text' in n) return typeof n.text === 'string'
  if ('journal' in n) return typeof n.journal === 'string'
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

/** 一整份条件读不读得出来（`where` 是必填；`scope`／`sort`／`limit` 只判形状） */
export function isQuerySpec(raw: unknown): raw is QuerySpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const s = raw as Record<string, unknown>
  if (!isQueryNode(s.where)) return false
  if (s.scope !== undefined && s.scope !== 'subtree' && s.scope !== 'all') return false
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
 * 求值一次。**纯函数**：同样的输入永远同样的输出顺序（按森林的先序），
 * 这样「冻结」只要保存输出的 `blockId[]` 就够了（D4：冻结成员与顺序）。
 *
 * ⚠️ `journal` 条件的「这一天是哪一块」不在本文件定义 —— 走 `journal.ts` 的 `findJournalDay`。
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
    journalDate: firstJournal(q.where),
    ...(input.excludeIds && input.excludeIds.length > 0 ? { excludeIds: new Set(input.excludeIds) } : {}),
  }
  /** 范围：`subtree` ⇒ 只收 anchor 之下（含 anchor 自己）；`all` ⇒ 整片森林 */
  let roots: readonly Block[] = input.blocks
  const anchor = q.scope !== 'all' && input.anchorId ? findById(input.blocks, input.anchorId) : undefined
  if (anchor) roots = [anchor]

  /**
   * 成员条件的候选收窄：「库里有哪些天」的唯一口径（一天一个、先序第一个）就是候选集，
   * 不用全库逐块判定。仅限顶层就是这个原子本身、且没有范围条件与锚点时。
   */
  if (isExactRoleJournal(q.where) && !env.journalDate && !anchor) roots = journalDays(input.blocks)

  /** `journal` 条件把范围再收一层：只取那天块里的**子块**（日期行是只读标题，不该出现在结果里） */
  if (env.journalDate) {
    const day = findJournalDay(input.blocks, env.journalDate)
    roots = day ? day.children : []
  }
  return evaluateQuery(q, roots, env)
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
  if ('ref' in node) return node.ref === SELF
  if ('tag' in node) return node.tag === SELF
  if ('text' in node) return node.text === SELF
  if ('journal' in node) return node.journal === SELF
  return false
}

/** 哨兵字面量：条件里写它 ＝ 「这一块自己」的这一侧面 */
export const SELF = '$self'

/**
 * 把条件里的 `'$self'` 解析成**宿主的这一侧面**。纯函数，不改入参。
 *
 * | 条件 | 解析成 |
 * |---|---|
 * | `{ref:'$self'}` | 指向宿主 id |
 * | `{journal:'$self'}` | 宿主的 `_date` |
 * | `{tag:'$self'}` | 宿主带的那几个标签（`any` 并集） |
 * | `{text:'$self'}` | 宿主的可读文本（`displayTextOf`） |
 *
 * ⚠️ **解析只写这一处**：纯函数路径与索引路径在求值第一行调它。写第二份就会得到
 *    「同一个 tab 在两条路径下结果不同」，而那是不报错的。
 * ⚠️ 解析出**空值**（宿主的 `_date`／可读文本／标签都为空）⇒ 换成一条**永不命中**的条件，
 *    而不是把空串当成值去比 —— `{text:''}` 会命中所有块。
 * ⚠️ `{tag}` 要的是**名字**（`findTagByName` 的口径），而 `_tags` 存的是 id ⇒ 这里做一次
 *    「id → 主名」翻译；`resolveSelfSpec` 因此需要森林（标签块得先找得到）。
 */
export function resolveSelfSpec(spec: QuerySpec, host: Block, forest: readonly Block[]): QuerySpec {
  const tagNames = tagIdsOf(host)
    .map((id) => findById(forest, id))
    .map((tag) => (tag ? primaryAliasOf(tag) : ''))
    .filter((name) => name.trim() !== '')
  const node = (n: QueryNode): QueryNode => {
    if ('all' in n) return { all: n.all.map(node) }
    if ('any' in n) return { any: n.any.map(node) }
    if ('not' in n) return { not: node(n.not) }
    if ('ref' in n) return { ref: n.ref === SELF ? host.id : n.ref }
    if ('journal' in n) {
      if (n.journal !== SELF) return { journal: n.journal }
      const date = journalDate(host)
      return date === '' ? NEVER : { journal: date }
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
    else if ('ref' in n) for (const id of refSourceIds(forest, n.ref)) out.add(id)
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
    else if ('tag' in n) {
      const tag = findTagByName(forest, n.tag)
      if (tag) for (const id of tagMemberIds(tag.id, forest)) out.add(id)
    }
  }
  visit(node)
  return out
}

/** 条件里第一个 `journal` 日期（索引路径要按它查日期表，所以导出共用） */
export function firstJournal(node: QueryNode): string | null {
  if ('all' in node) {
    for (const n of node.all) {
      const d = firstJournal(n)
      if (d) return d
    }
    return null
  }
  if ('any' in node) {
    for (const n of node.any) {
      const d = firstJournal(n)
      if (d) return d
    }
    return null
  }
  if ('not' in node) return firstJournal(node.not)
  return 'journal' in node ? node.journal : null
}

/** 在森林里按 id 找块。复用 `tree.ts` 的 `findPath`（不另写一份遍历） */
export function findById(blocks: readonly Block[], id: string): Block | undefined {
  const path = findPath(blocks, id)
  return path ? path[path.length - 1] : undefined
}
