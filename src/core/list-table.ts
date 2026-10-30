/**
 * **大纲 → 表格**：把一棵两层树摊成一张「行＝一级子块、列＝位置」的表。
 *
 * 三条口径（与「视图不是实体」同源）：
 *   · **行列完全由节点关系推导**：行是容器的直接子块，第 k 格是那一块的第 (k−1) 个直接子块。
 *     没有表头判定、没有合并、不需要任何「同名才算一列」的判据——位置就是唯一的对齐依据。
 *   · **列不是配置**：列＝「第 k 个孩子」这个位置，树一变含义就变；所以这里**不读也不存**列。
 *     这与平表的 `table.columns`（属性定义）是两种东西。
 *   · **不改数据**：本文件只读；写回永远是「改那一块的正文/属性」，走各自已有的入口。
 *
 * ⚠️ 位置对齐会**错位**：某一行的孩子比别的行多，整行就右移一格。这是这条映射的固有代价
 *    （参考实现的语义就是如此），不是缺陷，因此这里不补「列数不一致」的提示。
 * ⚠️ 零 DOM、零写库：渲染由 `ui/view-list-table.ts` 负责，写由命令层在事务里做。
 */
import { isDeleted, type Block } from './model.ts'
import type { KbClient } from './kb/types.ts'
import { plainText } from './runs.ts'
import type { ListSort } from './view.ts'

/** 一格：第 k 格里的那一块 ＋ 它自己的直接子块（三级起只做「可展开」，不进主表列） */
export interface ListTableCell {
  block: Block
  /** 这一格里的块自己的孩子（位置无关，只用于「第一行 ＋ N 项」的展开） */
  children: readonly Block[]
}

/** 一行：一级子块自己（第 1 格）＋ 它的孩子（第 2 格起，位置对齐） */
export interface ListTableRow {
  block: Block
  /** `cells[i]` 是第 `i+2` 格；`null` ＝ 这一行没有第 `i+1` 个孩子（右侧空格） */
  cells: readonly (ListTableCell | null)[]
}

export interface ListTable {
  /** 表标题＝容器自己（它不是一行） */
  root: Block | undefined
  rows: readonly ListTableRow[]
  /** `max(各行孩子数) + 1`：最少也有「第 1 格」那一列 */
  columns: number
}

/**
 * 这一格的排序值：第 1 格是行自己的正文，第 k 格是第 (k−1) 个孩子的正文。
 *
 * 为什么是**正文**而不是属性：结构映射表里格就是块，块的可比内容就是它的文本投影；
 * 属性是平表的列语义，这里没有列定义可用。
 */
export function listSortValueOf(row: ListTableRow, col: number): string {
  if (col <= 0) return plainText(row.block.content)
  const cell = row.cells[col - 1]
  return cell ? plainText(cell.block.content) : ''
}

/**
 * 取一张结构映射表（**派生**，每次现读，不缓存）。
 *
 * 软删的块在行与格里都跳过：被删的块仍在树上（可恢复），但把它画进表里会多出一行打不开的东西。
 * 跳过是**位置语义的一部分**：同一列在两棵「活着的树」之间对齐，而不是在墓碑之间对齐。
 */
export function listTableOf(rootId: string, kb: KbClient): ListTable {
  const root = kb.get(rootId)
  if (!root) return { root: undefined, rows: [], columns: 1 }
  const rows: ListTableRow[] = []
  let columns = 1
  for (const child of kb.children(rootId)) {
    if (isDeleted(child)) continue
    const cells: (ListTableCell | null)[] = []
    for (const grand of kb.children(child.id)) {
      if (isDeleted(grand)) continue
      cells.push({ block: grand, children: liveChildren(kb, grand.id) })
    }
    columns = Math.max(columns, cells.length + 1)
    rows.push({ block: child, cells })
  }
  return { root, rows, columns }
}

function liveChildren(kb: KbClient, id: string): Block[] {
  return kb.children(id).filter((b) => !isDeleted(b))
}

/**
 * 按第 `col` 格排**显示序**。
 *
 * 与平表同一条口径：空值永远最后、相等保持来源顺序（`children` 顺序）、
 * **不改任何数据**（排序只影响这一次渲染的顺序）。
 */
export function sortListRows(rows: readonly ListTableRow[], sort: ListSort | undefined): ListTableRow[] {
  if (!sort) return [...rows]
  const indexed = rows.map((r, i) => ({ r, i, v: listSortValueOf(r, sort.col) }))
  indexed.sort((a, b) => {
    const ea = a.v.trim() === ''
    const eb = b.v.trim() === ''
    if (ea && eb) return a.i - b.i
    if (ea) return 1
    if (eb) return -1
    const c = a.v.localeCompare(b.v, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
    return c === 0 ? a.i - b.i : sort.dir === 'desc' ? -c : c
  })
  return indexed.map((x) => x.r)
}

