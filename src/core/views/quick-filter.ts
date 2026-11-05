/**
 * 派生面（反链卡／引用栏／提及栏）的**快速筛选**：chips 的状态、判定与候选。
 *
 * ## 不造新机制：chips 是「条件」的快路径
 *
 * chips 的状态按**条件语言的形状**存——页是 `{up:{is:页 id}}`、标签是 `{tag:标签 id}`、
 * 排除列包一层 `not`。它就是「这一屏按什么选」的另一种编辑面，不是第二套过滤：
 * 摘一颗 chip ＝ 删一个条件节点；`quickFilterNode` 是这份状态的**全路径投影**，
 * 条件语言将来直接认这些原子时，整份状态可以原样交给求值器，中间不必换形状。
 *
 * ## 判定走窄谓词，不走整套求值器
 *
 * 这里只问两件位置事实：行块的祖先链（记录里已经带着）与行块的标签边（`_tags` 直读）。
 * 整套求值器为任意条件建候选集、做记忆化，为这两问付那个钱不值得；
 * 窄谓词各几行，读的与求值器**同一份事实**（祖先链＝可见树的父链，标签＝归属边）。
 *
 * ## 两条口径
 *
 *   · **组合语义**：包含列之间是「或」（任一命中即保留），排除列之间也是「或」
 *     （任一命中即藏掉），两列同时有值时先并后藏。排除 v1 是**单层**的——
 *     只藏匹配行本身，不藏它们的子树：子树排除是方向原子的形状，chips 这条快路径
 *     给不出它可读的编辑面，先不写。
 *   · **候选与计数都来自结果集本身**：候选＝结果集的行里出现过的页／标签，
 *     计数＝结果集里命中这个条件的行数。chips 加上之后候选与计数不变——
 *     它们回答「结果集里有多少行带这个页／标签」，不是「叠上其它 chips 之后
 *     还剩几行」；后者随手势变，前者是这份材料的稳定事实，
 *     也是「摘掉一颗 chip 一切回来」的参照。
 */
import { displayNameOf } from '../identity/alias.ts'
import { hasList, type Block } from '../model/model.ts'
import { plainText } from '../model/runs.ts'
import type { QueryNode } from '../query/query.ts'
import type { ViewRecord } from './view.ts'

/** 一颗 chip：条件语言里的一个原子。页＝祖先链上有它；标签＝行块带着这条归属边 */
export type QuickFilterAtom = { up: { is: string } } | { tag: string }

/** 快速筛选的状态：两列 chips（包含／排除），按条件语言的原子存 */
export interface QuickFilterState {
  include: QuickFilterAtom[]
  remove: QuickFilterAtom[]
}

/** 空 chips＝无筛选：判定原样放行（当初始值用） */
export const EMPTY_QUICK_FILTER: QuickFilterState = { include: [], remove: [] }

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
 * 「Shift+点」是改手势，不是同时加两颗：同一个原子同时出现在「或」与「非」里
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

/**
 * 一颗 chip 对一行命中不命中（窄谓词）。
 *
 * 祖先链读**记录里已带着的那条**——它与求值器可见树是同一条父链（不含自己），
 * 不必再走一遍树；标签读行块的归属边（`_tags` 直读），不含经由下级标签的
 * 「算作」——那是成员栏的口径，不是「这块带着什么标签」的口径。
 */
export function quickFilterAtomMatches(atom: QuickFilterAtom, r: ViewRecord): boolean {
  if ('up' in atom) return r.path.some((p) => p.id === atom.up.is)
  return r.tags.some((t) => t.id === atom.tag)
}

/**
 * 把 chips 状态用到结果集上：包含并（任一），排除藏（任一），两列都空＝原样。
 *
 * 返回**新数组**，不改造入参的行；空 chips 时原样返回同一引用——
 * 「没筛」是调用方能一眼确认的事实，不是「筛了一遍恰好全过」。
 */
export function applyQuickFilter(records: readonly ViewRecord[], state: QuickFilterState): ViewRecord[] {
  if (state.include.length === 0 && state.remove.length === 0) return records as ViewRecord[]
  return records.filter((r) => {
    if (state.remove.some((a) => quickFilterAtomMatches(a, r))) return false
    return state.include.length === 0 || state.include.some((a) => quickFilterAtomMatches(a, r))
  })
}

/** 一颗候选 chip：条件原子 ＋ 显示名 ＋ 结果集里的命中数 */
export interface QuickFilterCandidate {
  atom: QuickFilterAtom
  /** 显示名（页／标签同一条读法：主名叶子，退正文投影） */
  label: string
  /** 结果集里命中这个条件的行数（chips 上的那个数字） */
  count: number
}

/**
 * 候选 chips：**结果集里出现过的**页与标签，各带计数。
 *
 * 页＝祖先链上有 `page` 露面的块（行住在哪一页，与「这一行从哪来」同一个读法；
 * 日记天不是页，不作候选）；标签＝行块自己的归属边。两族都按计数降序、
 * 同数按先出现序——最可能点的排前面，计数是选项上的一句事实，不是排序之外的装饰。
 */
export function quickFilterCandidates(records: readonly ViewRecord[]): {
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
  const out = (m: Map<string, { block: Block; count: number }>, atomOf: (id: string) => QuickFilterCandidate['atom']) =>
    [...m.entries()].map(([id, acc]) => ({
      atom: atomOf(id),
      label: displayNameOf(acc.block) || plainText(acc.block.content).trim(),
      count: acc.count,
    }))
  return { pages: out(pages, (id) => ({ up: { is: id } })), tags: out(tags, (id) => ({ tag: id })) }
}

/**
 * chips 状态的**条件语言投影**（同一份条件的全路径读法；空 ⇒ `null`＝没有条件）。
 *
 * 包含列之间是「或」，排除列是「或」再包一层「非」，两列之间是「且」——
 * 与 `applyQuickFilter` 的判定逐字对应。chips 摘一颗，这里就少一个节点。
 */
export function quickFilterNode(state: QuickFilterState): QueryNode | null {
  const parts: QueryNode[] = []
  if (state.include.length === 1) parts.push(state.include[0]!)
  else if (state.include.length > 1) parts.push({ any: [...state.include] })
  if (state.remove.length === 1) parts.push({ not: state.remove[0]! })
  else if (state.remove.length > 1) parts.push({ not: { any: [...state.remove] } })
  if (parts.length === 0) return null
  if (parts.length === 1) return parts[0]!
  return { all: parts }
}
