/**
 * 标签块的**事务内**「找到或创建」：与 `ensureTag` 同一判据，但每一笔写都经 `Tx`。
 *
 * 为什么要单独一份而不是复用 `ensureTag`：`ensureTag` 直接改活块（`addList`／改 `props`
 * ／往森林里 push），这些改动**不进 op** —— 正文进了事务、新建块与归属却留在事务外，
 * 落盘就会得到「字改了、标签没建」或「引用有了、归属没写」的半批。
 *
 * 判据仍只有一份：这里转调同一个 `findTagByName` / `findByAlias` / `mkTagBlock` 的判据
 * （名字解析经 `TagLookup`），不另写一份 trim/规范化（名字空间与页共用，分叉就会得出两个答案）。
 *
 * ⚠️ 只报告「变了什么」：同名标签已经在库里 ⇒ 一条 op 都不发（`setLists`／`setProp`
 *    也不该被调用，否则每敲一次同一个标签都会写一遍归属）。
 */
import { findByAlias } from '../identity/alias.ts'
import { DISPLAY_PROP, listsOf, prop, type Block } from '../model/model.ts'
import { findTagByName, mkTagBlock, normalizeTag } from '../identity/tags.ts'
import { UnloadedAliasError } from './unsupported.ts'
import type { KbClient, Tx } from './types.ts'

/**
 * 名字解析的**窄口**：找标签块／找同名块都经它 —— 调用方不必持有整片森林。
 * `KbClient` 天然满足；无门面的调用方（编辑器）用 store 上的同判据函数现造一份。
 */
export interface TagLookup extends Pick<KbClient, 'findTag' | 'resolveAlias' | 'roots'> {
  /**
   * **全量地址表的两格**（工作集装载的防重判据）：名字 → 目标 id（未装载也回答）
   * 与「这块在不在内存里」。两格都在场 ⇒ 名字命中但目标未装载时**拒绝新建**
   * （`UnloadedAliasError`）；只给老三样的调用方（整库模式）保持原行为。
   */
  aliasTargetId?: (name: string) => string | undefined
  isLoaded?: (id: string) => boolean
}

/**
 * 找到或创建一个标签块，**写路径全部走 `tx`**。
 *
 * @param lookup 名字解析（`findTag`／`resolveAlias`）与顶层列表（新标签块插在森林顶层）
 * @returns 标签块；名字为空（规范化后）⇒ `null`（没有名字的标签没有身份）
 */
export function ensureTagInTx(lookup: TagLookup, name: string, tx: Tx): Block | null {
  // 空名字不建块：建了就是一个孤儿（与 `ensureTag` 同一条判据）
  if (normalizeTag(name) === '') return null
  const found = lookup.findTag(name)
  if (found) return found
  /**
   * 同名块已经存在（页 / 兼位块）⇒ 复用它，只补 `tag` 露面位。
   * 不能建第二个同名块：地址空间全局唯一，两份会让「它到底是谁」取决于先序扫描。
   */
  const existing = lookup.resolveAlias(name)
  if (existing) {
    tx.setLists(existing.id, [...listsOf(existing), 'tag'])
    // 第一次成为标签 ⇒ 行头默认显示名字；已有显式显示模式的不动
    if (prop(existing, DISPLAY_PROP) === undefined) tx.setProp(existing.id, DISPLAY_PROP, 'alias')
    return existing
  }
  refuseUnloaded(lookup, name)
  // 身份块住森林顶层：位置对身份不承载信息，而树操作会把住在子树里的标签当货物搬走
  const block = mkTagBlock(name.trim())
  tx.insert(block, null, lookup.roots().length)
  return block
}

/** 名字被一个未装载的块占着 ⇒ 抛 `UnloadedAliasError`（调用方决定装载还是留成纯文本） */
function refuseUnloaded(lookup: { aliasTargetId?: (name: string) => string | undefined; isLoaded?: (id: string) => boolean }, name: string): void {
  const known = lookup.aliasTargetId?.(name)
  if (known !== undefined && lookup.isLoaded?.(known) === false) throw new UnloadedAliasError(name, known)
}

/**
 * 供无门面调用方（编辑器持 store）现造解析器的同判据转调，判据只有 `core/alias.ts` 那一份。
 *
 * `world` 给了 store（编辑器的情形）⇒ 防重判据的两格也接上：名字被未装载块占着时
 * 新建会被拒绝（`UnloadedAliasError`），不会造出第二个同名身份。
 */
export const tagLookupOf = (
  forest: readonly Block[],
  world?: { aliasTargetId(name: string): string | undefined; isLoaded(id: string): boolean },
): TagLookup => ({
  findTag: (name) => findTagByName(forest, name),
  resolveAlias: (name) => findByAlias(forest, name),
  roots: () => forest,
  ...(world
    ? { aliasTargetId: (name: string) => world.aliasTargetId(name), isLoaded: (id: string) => world.isLoaded(id) }
    : {}),
})
