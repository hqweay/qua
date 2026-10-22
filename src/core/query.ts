/**
 * **查询**：一个块要「显示哪些块」的声明（/D4/D5/D10，承 29 /、33 A）。
 *
 * 三层分工，别混：
 *   · **条件**（本文件的 `QuerySpec`）——「选谁、按什么序」，写成 `canonical JSON` 存进块属性 `_query`；
 *   · **结果集**（`runQuery` 的输出）——一次**求值**，**冻结**的是「成员与顺序」；
 *   · **内容**——永远按 `block id` 现读现渲染（D5：集合冻、内容不冻）。
 *
 * ⚠️ 这里零 DOM、零持久化：求值只吃「森林 ＋ atoms」，所以能直接单测。
 * ⚠️ 接内核后本文件的签名不变：`runQuery` 以后由 `IndexPort.query()` 实现，`QuerySpec` 仍是那个 canonical JSON。
 */
import { isJournalBlock, type Block } from './model.ts'
import { walkForest } from './walk.ts'
import type { Atom } from './annotations.ts'
import { findPath } from './tree.ts'
import { findTagByName, tagMemberIds } from './tags.ts'
import { findJournalDay } from './journal.ts'
import { todoOf } from './props.ts'

/* ------------------------------------------------------------ 条件形状 */

/**
 * 条件**原子**。首版只做这五种——够表达「反链」「某标签下的块」「某天之后改过的待办」这类常见诉求，
 * 且每一种都能用一次线性扫描算出来（不用索引）。
 *
 * 组合：`{ all: [...] }` / `{ any: [...] }` / `{ not: ... }`，可嵌套。
 * ⚠️ **不加 `mentions`**：未链接提及＝`text` 里出现某个词，那是全文检索的事（承 69 BO），
 *    塞进这里会让「引用」与「文本匹配」变成同一个东西，反链语义当场糊掉。
 */
export type QueryNode =
  /** 直接指向 `targetId` 的块（反链的最小形态，承 71.3：只认 id，不认 label） */
  | { ref: string }
  /** 带某个标签的块：demo 里标签还是 `#tag` 文本（71.4 的 demo 债），所以按文本匹配 */
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
  | { todo: TodoFilter }
  /**
   * 某属性等于某值（`eq` 用 `Object.is` 比较；属性不存在 ⇒ 不匹配）。
   *
   * 属性条件是**通用路径**：键是定义块的 id（不是名字），所以改显示名不影响查询语义。
   * `Object.is` 让 `false` 与 `undefined`（未填）严格区分开 —— 按 `===` 也满足，
   * 但 `Object.is` 把 `NaN` 与 `-0` 也说清楚了，不必再讨论它们。
   */
  | { prop: { id: string; eq: unknown } }
  /** 某天（`YYYY-MM-DD`）的日记块**下面的块** */
  | { journal: string }
  | { all: QueryNode[] }
  | { any: QueryNode[] }
  | { not: QueryNode }

export type TodoFilter = 'todo' | 'done' | 'none'

/** 整个查询：条件 ＋ 范围 ＋ 顺序。没有 `view: table | board` —— 首版只有大纲列表 */
export interface QuerySpec {
  where: QueryNode
  /**
   * 从哪个容器往下找。缺省 `subtree`（承 75.4 #5）：
   * 根 Enter 建的子块只有渲染子树才看得见，否则就是「建了但看不见」（D8）。
   */
  scope?: 'subtree' | 'all'
  todo?: TodoFilter
  /** 取多少条；缺省不限 */
  limit?: number
}

/* ------------------------------------------------------------ 求值 */

export interface QueryRunInput {
  blocks: readonly Block[]
  /** 行内原子（demo 的指向边形状，承 71.3） */
  atoms: readonly Atom[]
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

/** 指向 `targetId` 的原子所在的块 id 集合（**一条指向边的另一端**，与渲染无关） */
export function refSourceIds(atoms: readonly Atom[], targetId: string): Set<string> {
  const out = new Set<string>()
  for (const a of atoms) {
    if (a.kind === 'page' && a.target?.id === targetId) out.add(a.blockId)
  }
  return out
}

/**
 * 标签条件：**按边判定**，不扫文本。
 *
 * ⚠️ 以前这里是正则扫 `b.text`（`#tag` 当作文本匹配）—— 那是 71.4 承认的「第二套解析」：
 *    「看起来是标签的文本」与「真的是一条标签边」成了两件事，改名也不同步。
 *    现在标签＝指向标签块的边，判定只在 `core/tags.ts` 里发生。
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
  if ('ref' in node) return refs.has(b.id)
  if ('tag' in node) return tags.has(b.id)
  if ('text' in node) return b.text.includes(node.text)
  if ('prop' in node) {
    // 属性不存在 ⇒ 不匹配（而不是「等于 undefined」）：先问「有没有这一槽」，再比值。
    // 这样 `eq: false` 与「没填」是两件事，`eq: undefined` 也不会误命中所有块。
    const props = b.props
    if (!props || !(node.prop.id in props)) return false
    return Object.is(props[node.prop.id], node.prop.eq)
  }
  const cur = todoOf(b) ?? 'none'
  return node.todo === cur
}

/**
 * 求值一次。**纯函数**：同样的输入永远同样的输出顺序（按森林的先序），
 * 这样「冻结」只要保存输出的 `blockId[]` 就够了（D4：冻结成员与顺序）。
 *
 * ⚠️ `journal` 条件的「这一天是哪一块」不在本文件定义 —— 走 `journal.ts` 的 `findJournalDay`。
 */
export function runQuery(spec: QuerySpec, input: QueryRunInput): QueryHit[] {
  const refs = collectRefs(spec.where, input.atoms)
  const tags = collectTags(spec.where, input.blocks)
  /** 范围：`subtree` ⇒ 只收 anchor 之下（含 anchor 自己）；`all` ⇒ 整片森林 */
  let roots: readonly Block[] = input.blocks
  const anchor = spec.scope !== 'all' && input.anchorId ? findById(input.blocks, input.anchorId) : undefined
  if (anchor) roots = [anchor]

  /** `journal` 条件把范围再收一层：只取那天块里的**子块**（日期行是只读标题，不该出现在结果里） */
  const journalDate = firstJournal(spec.where)
  if (journalDate) {
    const day = findJournalDay(input.blocks, journalDate)
    roots = day ? day.children : []
  }

  const hits: QueryHit[] = []
  walk(roots, (b, ancestors) => {
    if (journalDate && isJournalBlock(b)) return
    if (!matches(spec.where, b, refs, tags)) return
    if (spec.todo && (todoOf(b) ?? 'none') !== spec.todo) return
    hits.push({ blockId: b.id, path: ancestors.map((a) => a.id) })
  })
  return typeof spec.limit === 'number' ? hits.slice(0, Math.max(0, spec.limit)) : hits
}

/** 条件里所有 `ref` 的目标（用于一次性收集 refs，避免每个块都扫一遍 atoms） */
function collectRefs(node: QueryNode, atoms: readonly Atom[]): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('ref' in n) for (const id of refSourceIds(atoms, n.ref)) out.add(id)
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

function firstJournal(node: QueryNode): string | null {
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
