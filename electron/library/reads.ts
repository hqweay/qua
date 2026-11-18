/**
 * **主进程侧的只读执行器**：跑 `core/storage/library-reads.ts` 的具名查询，不做块语义。
 *
 * 职责只有三件：
 *   1. 用参数绑定额外的 `json_each(?)` 列表；
 *   2. 把四张表的结果拼成一个 `RawLibraryRows`（交给渲染层 `rowsToWorkspace`）；
 *   3. 把 catalog 的四个小查询原样返回。
 *
 * 它**不认识**「页／标签／日记」——那些判据在 core 的 SQL 文本里；这里只是执行器。
 * 这与行写入的纪律对称：主进程认表名/列名，不认块。
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  LIBRARY_READS,
  type CatalogJournal,
  type CatalogPropDef,
  type CatalogTag,
  type CatalogTrashRoot,
  type LibraryCatalog,
  type LibraryDocRows,
} from '../../src/core/storage/library-reads.ts'

type Row = Record<string, unknown>

/** 一个／多个 root 的子树行 ＋ 祖先链；`rows` 可直接交给 `rowsToWorkspace` */
export function readDocRows(db: DatabaseSync, rootIds: readonly string[]): LibraryDocRows {
  if (rootIds.length === 0) {
    return { rows: { blocks: [], props: [], aliases: [], lists: [], meta: {} }, ancestors: [], rootIds: [] }
  }
  const rootJson = JSON.stringify(rootIds)
  const blocks = db.prepare(LIBRARY_READS.docSubtree).all(rootJson) as Row[]
  const ids = blocks.map((b) => String(b.id))
  const idJson = JSON.stringify(ids)
  const props = db.prepare(LIBRARY_READS.docProps).all(idJson) as Row[]
  const aliases = db.prepare(LIBRARY_READS.docAliases).all(idJson) as Row[]
  const lists = db.prepare(LIBRARY_READS.docLists).all(idJson) as Row[]

  /**
   * 祖先按 root 逐个向上查，结果按 id 去重。
   * 不把祖先并进 `docSubtree`：那会把祖先前面的兄弟/兄弟子树也带进来，
   * 工作集就从「一条路径」变成「整棵祖先子树」——首帧成本会跟着库的顶层分叉走。
   */
  const ancestors: Row[] = []
  const seen = new Set<string>()
  for (const id of rootIds) {
    for (const row of db.prepare(LIBRARY_READS.docAncestors).all(id) as Row[]) {
      const key = String(row.id)
      if (seen.has(key)) continue
      seen.add(key)
      ancestors.push(row)
    }
  }
  return { rows: { blocks, props, aliases, lists, meta: {} }, ancestors, rootIds: [...rootIds] }
}

/** 默认槽要显示的全局身份摘要（页列表不在这里：它是查询视图，按页查） */
export function readCatalogRows(db: DatabaseSync): LibraryCatalog {
  const journals = db.prepare(LIBRARY_READS.catalogJournals).all() as CatalogJournal[]
  const tags = db.prepare(LIBRARY_READS.catalogTags).all() as CatalogTag[]
  const propDefs = db.prepare(LIBRARY_READS.catalogPropDefs).all() as CatalogPropDef[]
  const trash = db.prepare(LIBRARY_READS.catalogTrash).all() as CatalogTrashRoot[]
  return { journals, tags, propDefs, trash }
}
