/**
 * **快速筛选**：chips 状态、判定、候选，以及它与条件语言的双向投影。
 *
 * ## 不造新机制：chips 是「条件」的另一个编辑档
 *
 * chips 的状态按**条件语言的形状**存——页是 `{up:{is:页 id}}`、标签是 `{tag:标签块 id}`、
 * 排除列包一层「非」。它就是「这一屏按什么选」的另一种画法，不是第二套过滤：
 * 摘一颗 chip ＝ 删一个条件节点；`quickFilterNode` 是这份状态的**全路径投影**，
 * `chipsOfFilter` 是它的**逆**（认得出的形状原样读回来，认不出返回 `null`）。
 * 两个方向都只有一个落点，所以「chips 改的」与「条件树改的」永远是同一份答案。
 *
 * ## 三条语义（三个面共用一条）
 *
 *   · **包含列之间是「且」**：再点一颗是**收窄**，不是并集。用户的动作是「再筛一刀」，
 *     所以候选上的计数会随选择变小——那是「再筛一刀还剩几行」，正是这次手势要回答的。
 *   · **排除列之间也是「且」**（都不许命中）；
 *   · **排除藏的是「这一块 ＋ 它的子树」**：块级大纲里，一条被排除的块带着它的孩子
 *     一起消失（孩子属于它）。判定 = 「自己或任一祖先命中」，在记录面上就是
 *     `path` 命中——同一个判据，两处行形状不同但答案一致。
 *   · **两列同时有值时先藏后留**：排除优先。
 *
 * ## 判定读**位置事实**，不读库
 *
 * 一行要回答的只有两件：祖先链上有没有这个页、自己带没带这个标签。
 * `ViewRecord` 与编辑器的一行都能立刻给出（`QuickFilterRow`），所以同一份判定
 * 喂给两张面——查询结果/派生栏（记录）与正文大纲（可见行）。
 *
 * ⚠️ **标签 chip 存的是标签块 id**：条件语言的 `{tag}` 按 id 解析（与 `{prop}` 同一条
 *    「键是 id」纪律）⇒ 投影出去的节点可以直接求值；显示名一律现解析。
 *    标签**改名**不再影响任何存下来的条件或 chip。
 */
import { primaryAliasOf } from '../identity/alias.ts'
import { hasList, type Block } from '../model/model.ts'
import type { RowVerdict } from '../model/tree.ts'
import { plainText } from '../model/runs.ts'
import type { QueryNode } from '../query/query.ts'

/** 一颗 chip：条件语言里的一个原子。页＝祖先链上有它；标签＝行块带着这条归属边 */
export type QuickFilterAtom = { up: { is: string } } | { tag: string }

/** 快速筛选的状态：两列 chips（包含／排除），按条件语言的原子存 */
export interface QuickFilterState {
  include: QuickFilterAtom[]
  remove: QuickFilterAtom[]
}

/** 空 chips＝无筛选：判定原样放行（当初始值用） */
export const EMPTY_QUICK_FILTER: QuickFilterState = { include: [], remove: [] }

/**
 * 判定一行要读的两件**位置事实**。
 *
 * `ViewRecord` 结构满足它（记录面直接用）；编辑器的一行现造（见 `ui/chrome/center-filter`）。
 * 两处都只给「祖先链」与「自己的标签」，没有第三样东西。
 */
export interface QuickFilterRow {
  path: readonly Block[]
  tags: readonly Block[]
}

/* ------------------------------------------------------------ 状态操作 */

/** 两个原子是不是同一颗 chip（结构相等；两态键不同，逐键比就够） */
export function sameQuickFilterAtom(a: QuickFilterAtom, b: QuickFilterAtom): boolean {
  if ('up' in a && 'up' in b) return a.up.is === b.up.is
  if ('tag' in a && 'tag' in b) return a.tag === b.tag
  return false
}

/**
 * 加一颗 chip（**纯函数**：不改入参，真变了才返回新状态）。
 *
 * 已在目标列 ⇒ `null`（没有变化，调用方不必重画）；在另一列 ⇒ **挪列**——
 * 「Shift+点」是改手势，不是同时加两颗：同一个原子同时出现在「且」与「非」里
 * 会互相抵消，条件语言的读法里就不该有这个状态。
 */
export function quickFilterAdd(
  state: QuickFilterState,
  atom: QuickFilterAtom,
  to: 'include' | 'remove',
): QuickFilterState | null {
  const target = state[to]
  if (target.some((a) => sameQuickFilterAtom(a, atom))) return null
  const drop = (list: readonly QuickFilterAtom[]): QuickFilterAtom[] =>
    list.filter((a) => !sameQuickFilterAtom(a, atom))
  if (to === 'include') return { include: [...target, atom], remove: drop(state.remove) }
  return { include: drop(state.include), remove: [...target, atom] }
}

/** 摘一颗 chip（＝删掉那个条件节点）；本来就不在 ⇒ `null`（没有变化） */
export function quickFilterDrop(state: QuickFilterState, atom: QuickFilterAtom): QuickFilterState | null {
  const include = state.include.filter((a) => !sameQuickFilterAtom(a, atom))
  const remove = state.remove.filter((a) => !sameQuickFilterAtom(a, atom))
  if (include.length === state.include.length && remove.length === state.remove.length) return null
  return { include, remove }
}

/** 这份状态有没有在筛（两列都空＝没有） */
export function quickFilterActive(state: QuickFilterState): boolean {
  return state.include.length > 0 || state.remove.length > 0
}

/* ------------------------------------------------------------ 判定 */

/**
 * 一颗 chip 对一行的**自身**命中不命中（不含「祖先被排除」那条——那是 `quickFilterVerdict`）。
 *
 * 祖先链读记录里已带着的那条（与求值器的可见树是同一条父链，不含自己）；
 * 标签读行块自己的归属边（`_tags`），**不含**经由下级标签的「算作」——
 * 那是成员栏的口径，不是「这块带着什么标签」的口径。
 */
export function quickFilterAtomMatches(atom: QuickFilterAtom, row: QuickFilterRow): boolean {
  if ('up' in atom) return row.path.some((p) => p.id === atom.up.is)
  return row.tags.some((t) => t.id === atom.tag)
}

/** 一行在这一份状态下的三态：与行遍历的三态是同一份（`RowVerdict`） */
export type QuickFilterVerdict = RowVerdict

/**
 * 一行该不该留下。
 *
 * 判定顺序是语义，不是实现细节：**先看排除**（自己命中即去掉，连同子树），
 * 再要求包含列**全部**命中（且）。包含列为空 ⇒ 不因包含去掉任何行。
 */
export function quickFilterVerdict(state: QuickFilterState, row: QuickFilterRow): QuickFilterVerdict {
  // 排除：命中自身即去掉。祖先被排除的那条由行遍历负责（子树连带），不在这里追加——
  // 记录面本身没有嵌套，编辑器面由 `filterVisibleRows` 一次走完。
  if (state.remove.some((a) => quickFilterAtomMatches(a, row))) return 'drop'
  /**
   * **只有排除时其余全留**：`neutral` 在行遍历里是「靠命中后代才留下」，
   * 只排除的那一份没有任何「命中」行 —— 返回 neutral 会把整屏筛成空白。
   */
  if (state.include.length === 0) return 'keep'
  return state.include.every((a) => quickFilterAtomMatches(a, row)) ? 'keep' : 'neutral'
}

/**
 * 把 chips 状态用到一串记录上（派生面／查询结果的记录面）。
 *
 * 返回**新数组**，不改造入参的行；空 chips 时原样返回同一引用——
 * 「没筛」是调用方能一眼确认的事实，不是「筛了一遍恰好全过」。
 */
export function applyQuickFilter<R extends QuickFilterRow>(records: readonly R[], state: QuickFilterState): R[] {
  if (!quickFilterActive(state)) return records as R[]
  /**
   * 记录面**没有嵌套**：没有「留作上下文的祖先」这回事。
   * `neutral`（不命中包含列）在这一面就是不留——`keep` 才是答案。
   */
  return records.filter((r) => quickFilterVerdict(state, r) === 'keep')
}

/* ------------------------------------------------------------ 与条件语言互转 */

/**
 * chips 状态的**条件语言投影**（同一份条件的全路径读法；空 ⇒ `null`＝没有条件）。
 *
 * 包含列之间是「且」；排除是「自己或任一祖先命中 ⇒ 去掉」——这正是
 * 「藏掉这一块连同子树」，与 `quickFilterVerdict` ＋ 行遍历逐字对应。
 */
export function quickFilterNode(state: QuickFilterState): QueryNode | null {
  const parts: QueryNode[] = []
  for (const atom of state.include) parts.push(atom)
  for (const atom of state.remove) parts.push({ not: atom })
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return { all: parts }
}

/** 一颗 chip 的形状（认不出返回 null）——只认我们投影出去的那两种 */
function atomOfNode(node: QueryNode): QuickFilterAtom | null {
  if ('up' in node) {
    const inner = node.up
    return 'is' in inner && typeof inner.is === 'string' ? { up: { is: inner.is } } : null
  }
  if ('tag' in node && typeof node.tag === 'string') return { tag: node.tag }
  return null
}

/**
 * 一颗排除 chip 的形状：`{not: atom}`（我们唯一的写法）。
 *
 * 「连同子树」不是条件的一部分，而是**画法**：行遍历遇到 `drop` 之后
 * 更深的那几行一律不画（`filterVisibleRows`）。写进条件就需要「自己或祖先命中」，
 * 那在扁平的结果集里没有对应物——同一份条件在两张面上会给出两个答案。
 */
function removedAtomOfNode(node: QueryNode): QuickFilterAtom | null {
  if (!('not' in node)) return null
  return atomOfNode(node.not)
}

/**
 * **条件 → chips**（`quickFilterNode` 的逆）：认得出就原样读回来，认不出返回 `null`。
 *
 * 「认得出」的判据是形状**完全等于**我们投影出去的那几种——多一个键、少一层包装都算
 * 不认得。这样「chips 是这份 filter 的一个画法」才有意义：读者看到 chips，就知道
 * 编辑它落回的正是同一份条件；认不出的形状由摘要 chip 说实话（不静默画错）。
 */
export function chipsOfFilter(node: QueryNode | null | undefined): QuickFilterState | null {
  if (!node) return { include: [], remove: [] }
  const items: readonly QueryNode[] = 'all' in node ? node.all : [node]
  const include: QuickFilterAtom[] = []
  const remove: QuickFilterAtom[] = []
  for (const item of items) {
    const atom = atomOfNode(item)
    if (atom) {
      include.push(atom)
      continue
    }
    const removed = removedAtomOfNode(item)
    if (removed) {
      remove.push(removed)
      continue
    }
    return null
  }
  return { include, remove }
}

/* ------------------------------------------------------------ 候选 */

/** 一颗候选 chip：条件原子 ＋ 显示名 ＋ 这一批记录里的命中数 */
export interface QuickFilterCandidate {
  atom: QuickFilterAtom
  /** 显示名（页取主名叶子；标签同一条读法） */
  label: string
  /** 这一批记录里命中这个条件的行数 */
  count: number
}

/**
 * 候选 chips：这批记录里**出现过的**页与标签，各带计数。
 *
 * 页＝祖先链上有 `page` 露面的块（行住在哪一页）；标签＝行块自己的归属边。
 * 两族都按计数降序、同数按先出现序——最可能点的排前面。
 *
 * ⚠️ **计数是「这一批记录里有多少行带它」，不是「叠上其它 chip 之后还剩几行」**：
 *    后者随手势变，前者是这份材料的稳定事实，也是「摘掉一颗一切回来」的参照。
 *    有的实现把计数算成「叠上其它 chip 之后还剩几行」——那份数字会随手势跳；
 *    我们取稳定值：同一颗 chip 上的数字不该在它自己没动的时候变。
 */
export function quickFilterCandidates(records: readonly QuickFilterRow[]): {
  pages: QuickFilterCandidate[]
  tags: QuickFilterCandidate[]
} {
  const pages = new Map<string, { block: Block; count: number }>()
  const tags = new Map<string, { block: Block; count: number }>()
  for (const r of records) {
    for (const p of r.path) {
      if (!hasList(p, 'page')) continue
      const acc = pages.get(p.id)
      if (acc) acc.count += 1
      else pages.set(p.id, { block: p, count: 1 })
    }
    for (const t of r.tags) {
      const acc = tags.get(t.id)
      if (acc) acc.count += 1
      else tags.set(t.id, { block: t, count: 1 })
    }
  }
  const out = (
    m: Map<string, { block: Block; count: number }>,
    atomOf: (block: Block) => QuickFilterCandidate['atom'],
  ): QuickFilterCandidate[] =>
    [...m.values()]
      .map((acc) => ({
        atom: atomOf(acc.block),
        label: primaryAliasOf(acc.block) || plainText(acc.block.content).trim(),
        count: acc.count,
      }))
      .sort((a, b) => b.count - a.count)
  return {
    pages: out(pages, (b) => ({ up: { is: b.id } })),
    tags: out(tags, (b) => ({ tag: b.id })),
  }
}
