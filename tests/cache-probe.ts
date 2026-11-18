/**
 * 派生缓存的等价性探针（测试专用，不是生产代码）。
 *
 * 判据只有一条：**索引上的缓存必须等于「从森林现算」**。
 * 缓存是派生视图，不是第二份真相；`listsFingerprint` / `fieldTableFingerprint`
 * 用规范化序列化来比，避免把 Map/Set 的插入顺序误报成内容差异。
 */
import assert from 'node:assert/strict'
import {
  ensureIndexLists,
  fieldTableOf,
  hasList,
  indexFieldTable,
  isJournalBlock,
  isPropDefBlock,
  trashOf,
  walkForest,
  type FieldTable,
  type Index,
} from '../src/core/index.ts'
import type { Block } from '../src/core/model/model.ts'

const ids = (blocks: readonly Block[]): string[] => blocks.map((b) => b.id)

/** 五张全局列表的规范化指纹（顺序＝森林先序，必须保留） */
export function listsFingerprint(lists: {
  pages: readonly Block[]
  tags: readonly Block[]
  propDefs: readonly Block[]
  trash: readonly Block[]
  journals: readonly Block[]
}): string {
  return JSON.stringify({
    pages: ids(lists.pages),
    tags: ids(lists.tags),
    propDefs: ids(lists.propDefs),
    trash: ids(lists.trash),
    journals: ids(lists.journals),
  })
}

/** 从森林现算的五张列表（与 `MemoryKb` 重构前的实现逐字一致） */
export function pureLists(forest: readonly Block[]): {
  pages: Block[]
  tags: Block[]
  propDefs: Block[]
  trash: Block[]
  journals: Block[]
} {
  const pages: Block[] = []
  const tags: Block[] = []
  const propDefs: Block[] = []
  const journals: Block[] = []
  walkForest(forest, (b) => {
    if (hasList(b, 'page')) pages.push(b)
    if (hasList(b, 'tag')) tags.push(b)
    if (isPropDefBlock(b)) propDefs.push(b)
    if (isJournalBlock(b)) journals.push(b)
  })
  return { pages, tags, propDefs, trash: trashOf(forest), journals }
}

const sortedEntries = (m: ReadonlyMap<string, unknown>): [string, unknown][] =>
  [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))

/** `FieldTable` 的规范化指纹：Map 的 key 排序，数组内部顺序保留（先序/声明序有语义） */
export function fieldTableFingerprint(t: FieldTable): string {
  return JSON.stringify({
    byTag: sortedEntries(t.byTag),
    liveTags: [...t.liveTags].sort(),
    kinds: sortedEntries(t.kinds),
    defaults: sortedEntries(t.defaults),
    byUse: sortedEntries(t.byUse),
    cardinality: sortedEntries(t.cardinality),
  })
}

/** 断言索引上的两份派生缓存与全量现算逐项一致 */
export function assertDerivedCaches(index: Index, forest: readonly Block[], label: string): void {
  const lists = ensureIndexLists(index, forest)
  assert.equal(listsFingerprint(lists), listsFingerprint(pureLists(forest)), `${label}：列表缓存必须等于从森林现算`)
  const fields = indexFieldTable(index, forest)
  assert.equal(
    fieldTableFingerprint(fields),
    fieldTableFingerprint(fieldTableOf(forest)),
    `${label}：字段表缓存必须等于全量重建`,
  )
}
