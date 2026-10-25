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
import { isJournalBlock, type Block } from './model.ts'
import { plainText, refRunsOf } from './runs.ts'
import { walkForest } from './walk.ts'
import { findPath } from './tree.ts'
import { findTagByName, tagMemberIds } from './tags.ts'
import { findJournalDay, journalDays } from './journal.ts'
import { todoOf } from './props.ts'

/* ------------------------------------------------------------ 条件形状 */

/**
 * 条件**原子**。够表达「反链」「某标签下的块」「某天之后改过的待办」这类常见诉求，
 * 且每一种都能用一次线性扫描算出来（不用索引）。
 *
 * ⚠️ **能用通用属性条件表达的，就别造专用键**：专用键每多一个，`canonicalSpec` 就要多一支，
 *    漏一处 = 条件存进 `_query` 时被静默丢掉（而丢掉的后果是「条件没变、结果却对不上」）。
 *    唯一的例外是 `{todo}`：它表达的是**三态**（做完／是任务但没填／不是任务），
 *    而属性条件只能问「有没有值」和「值等于什么」—— `eq:false` 不含「有槽未填」，
 *    `exists:false` 也不含。三种状态要靠两个条件的组合去拼，反而更难读（见那一条的注释）。
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
   * 待办状态（三态：未做完／做完／不是任务）。
   *
   * ⚠️ 值本身已经是**真实属性**（`core/props.ts` 的「任务状态」），这里保留专用条件键
   *    是因为它表达的「三态」不是 `{ prop: { id, eq } }` 能直接写出来的：
   *    `false`（是任务、没做完）与「没有这一槽」必须分开，而后者在所有属性条件里
   *    都统一表示「不匹配」。要让用户说清「没有这个字段」，得给属性条件加一个
   *    「不存在」的形态——没做之前，这一支留着更诚实。
   */
  /**
   * 待办状态（三态：做完／是任务但没填／不是任务）。
   *
   * ⚠️ 为什么不用 `{prop}` 表达（两个条件组合也拼不出来，实测过）：
   *    · 屏幕上画着空心方框的块**是待办**：它的槽位在、值还没填。
   *    · `{prop:{id,eq:false}}` 只命中「点了但没做完」的那种，**漏掉**有槽未填的；
   *    · `{prop:{id,exists:false}}` 会把「不是任务」和「有槽未填」混成一个。
   *    ⇒ 三态写在 `core/props.ts` 的 `todoOf` 里，这里是它唯一的查询入口。
   */
  | { todo: TodoFilter }
  /**
   * 某属性**等于某值**，或**有没有这一槽**。
   *
   * 属性条件是**通用路径**：键是定义块的 id（不是名字），所以改显示名不影响查询语义；
   * 类型、日期这类身份位也是 `props` 里的槽，所以同一个条件能把它们都问到。
   * `Object.is` 让 `false` 与 `undefined`（未填）严格区分开。
   *
   * `eq` 与 `exists` **互斥**；同时给时按 `exists` 判（不猜）。
   * 「有没有这一槽」是 `eq` 表达不出来的一个真问题：`未完成的任务` 是 `eq: false`，
   * `不是任务` 是 `exists: false` —— 拿 `eq: undefined` 冒充会把两者混成一个。
   */
  | { prop: { id: string } & ({ eq: unknown } | { exists: boolean }) }
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
export interface SortKey {
  by: string
  dir: 'asc' | 'desc'
}

export type TodoFilter = 'todo' | 'done' | 'none'

/** 整个查询：条件 ＋ 范围 ＋ 顺序。没有 `view: table | board` —— 首版只有大纲列表 */
export interface QuerySpec {
  where: QueryNode
  /**
   * 从哪个容器往下找。缺省 `subtree`：
   * 根 Enter 建的子块只有渲染子树才看得见，否则就是「建了但看不见」（D8）。
   */
  scope?: 'subtree' | 'all'
  todo?: TodoFilter
  /**
   * 结果顺序：按键**依次**比较（写在前面的优先）。缺省＝森林先序。
   *
   * 排序是**稳定**的：同值的行保持森林先序；**缺槽的排最后**（与方向无关）——
   * 「没有这一槽」不是一个小值，放进有序区会把缺槽的混进中间。
   */
  sort?: SortKey[]
  /** 取多少条；缺省不限 */
  limit?: number
}

/* ------------------------------------------------------------ 求值 */

export interface QueryRunInput {
  blocks: readonly Block[]
  /** 求值范围锚点：`scope: 'subtree'` 时只在这个块（含）之下找 */
  anchorId?: string
}

/** 一条结果：块 id ＋ 它在森林里的路径（D8：可编辑列表必须给上下文，否则不知道这条住哪） */
export interface QueryHit {
  blockId: string
  /** 从根到**父块**的祖先链（不含自己）；`[]` ＝ 顶层 */
  path: string[]
}

function walk(blocks: readonly Block[], fn: (b: Block, ancestors: Block[]) => void): void {
  walkForest(blocks, (b, ctx) => {
    fn(b, ctx.path.slice(0, -1))
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
  /** 条件里第一个 `journal` 日期；没有 ⇒ `null`（此时它是普通组合，不当范围用） */
  journalDate: string | null
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
    if (env.journalDate && isJournalBlock(b)) return
    if (!matches(spec.where, b, env.refs, env.tags)) return
    if (spec.todo && (todoOf(b) ?? 'none') !== spec.todo) return
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
function matches(node: QueryNode, b: Block, refs: ReadonlySet<string>, tags: ReadonlySet<string>): boolean {
  // ⚠️ `journal` **优先判**：它是「范围」不是「谓词」。若别的键也在同一个对象上（形状写歪了），
  //    先看 `all` 会让范围条件被当成空组合（恒真）——那种退化是静默的，测试也未必抓得住。
  if ('journal' in node) return true
  if ('all' in node) return node.all.every((n) => matches(n, b, refs, tags))
  if ('any' in node) return node.any.some((n) => matches(n, b, refs, tags))
  if ('not' in node) return !matches(node.not, b, refs, tags)
  if ('role' in node) return roleMatches(node.role, b)
  if ('ref' in node) return refs.has(b.id)
  if ('tag' in node) return tags.has(b.id)
  if ('text' in node) return plainText(b.content).includes(node.text)
  if ('prop' in node) {
    /**
     * 先问「有没有这一槽」，再决定比值还是比存在性。
     * 这样 `eq: false` 与「没填」是两件事，`eq: undefined` 也不会误命中所有块。
     */
    const props = b.props
    const has = props !== undefined && node.prop.id in props
    if ('exists' in node.prop) return has === node.prop.exists
    if (!has) return false
    return Object.is(props[node.prop.id], node.prop.eq)
  }
  // 剩下的只有 `{todo}`：三态判据在 `core/props.ts`，这里不另写一份
  return (todoOf(b) ?? 'none') === node.todo
}

/** role 逐值分发到**既有唯一判据**，不另设第二份答案；进新值域时在此续支 */
function roleMatches(role: 'journal', b: Block): boolean {
  return role === 'journal' ? isJournalBlock(b) : false
}

/**
 * where 的**顶层**就是 `{ role: 'journal' }` 本身（日记流形态）。
 * 只有这个形态允许把候选集收窄成「天」——嵌进组合里的 role 是普通谓词，
 * 收窄会把其它分支的候选丢掉（比如 `{ not: { role: 'journal' } }` 恰恰要非天的块）。
 */
export function isExactRoleJournal(node: QueryNode): boolean {
  return 'role' in node && node.role === 'journal'
}

/**
 * 求值一次。**纯函数**：同样的输入永远同样的输出顺序（按森林的先序），
 * 这样「冻结」只要保存输出的 `blockId[]` 就够了（D4：冻结成员与顺序）。
 *
 * ⚠️ `journal` 条件的「这一天是哪一块」不在本文件定义 —— 走 `journal.ts` 的 `findJournalDay`。
 * ⚠️ 索引路径（`index-port.ts` 的 `queryByIndex`）与环境收集方式不同、判定与顺序共用本函数。
 */
export function runQuery(spec: QuerySpec, input: QueryRunInput): QueryHit[] {
  const env: QueryEnv = {
    refs: collectRefs(spec.where, input.blocks),
    tags: collectTags(spec.where, input.blocks),
    journalDate: firstJournal(spec.where),
  }
  /** 范围：`subtree` ⇒ 只收 anchor 之下（含 anchor 自己）；`all` ⇒ 整片森林 */
  let roots: readonly Block[] = input.blocks
  const anchor = spec.scope !== 'all' && input.anchorId ? findById(input.blocks, input.anchorId) : undefined
  if (anchor) roots = [anchor]

  /**
   * 成员条件的候选收窄：「库里有哪些天」的唯一口径（一天一个、先序第一个）就是候选集，
   * 不用全库逐块判定。仅限顶层就是这个原子本身、且没有范围条件与锚点时。
   */
  if (isExactRoleJournal(spec.where) && !env.journalDate && !anchor) roots = journalDays(input.blocks)

  /** `journal` 条件把范围再收一层：只取那天块里的**子块**（日期行是只读标题，不该出现在结果里） */
  if (env.journalDate) {
    const day = findJournalDay(input.blocks, env.journalDate)
    roots = day ? day.children : []
  }
  return evaluateQuery(spec, roots, env)
}

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
