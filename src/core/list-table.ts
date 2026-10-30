/**
 * **大纲 → 表格**：把一棵两层树摊成一张「表头＝一级子块、一列＝那个子块的孩子」的表。
 *
 * 三条口径（与「视图不是实体」同源）：
 *   · **行列完全由节点关系推导**：第一行是容器的直接子块（一列＝一个子块），
 *     第 i 列的第 j 项＝那个子块的第 j 个孩子。没有合并、不需要任何「同名才算一列」的判据
 *     —— 位置就是唯一的对齐依据。
 *   · **列不是配置**：列＝「一个直接子块」，树一变含义就变；所以这里**不读也不存**列。
 *     这与平表的 `table.columns`（属性定义）是两种东西。
 *   · **不改数据**：本文件只读；写回永远是「改那一块的正文/属性」，走各自已有的入口。
 *
 * ⚠️ 位置对齐会**错位**：某一列比别的列少一项，那一行就只有左侧有内容（右侧往下空）。
 *    这是这条映射的固有代价，不是缺陷，因此这里不补「列数不一致」的提示。
 * ⚠️ 零 DOM、零写库：渲染由 `ui/view-list-table.ts` 负责，写由命令层在事务里做。
 */
import { isDeleted, type Block } from './model.ts'
import type { KbClient } from './kb/types.ts'
import { plainText } from './runs.ts'
import type { ListSort } from './view.ts'

/** 一列里的一项：某一列（表头块）的第 j 个孩子 ＋ 它自己的孩子（三级起只做「可展开」） */
export interface ListTableItem {
  block: Block
  /** 这一项自己的孩子（位置无关，只用于「＋N 项」的展开） */
  children: readonly Block[]
}

/** 一行：每列各取第 j 项（`cells[i]` 是第 i 列的第 j 项） */
export interface ListTableRow {
  /** `cells[i]` 是第 `i` 列的那一项；`null` ＝ 这一列没有第 j 项（往下空） */
  cells: readonly (ListTableItem | null)[]
}

export interface ListTable {
  /** 表标题＝容器自己（它不是一列，也不占一行） */
  root: Block | undefined
  /** 表头行＝容器的直接子块（顺序＝children 顺序）；列数就是它的长度 */
  columns: readonly Block[]
  /** 行数＝max(每列项数)；每行的 `cells.length` 恒等于 `columns.length` */
  rows: readonly ListTableRow[]
}

/**
 * 这一行的排序值：第 `col` 列里那一项的正文投影。
 *
 * 为什么是**正文**而不是属性：结构映射表里一格就是块，块的可比内容就是它的文本投影；
 * 属性是平表的列语义，这里没有列定义可用。
 */
export function listSortValueOf(row: ListTableRow, col: number): string {
  const cell = row.cells[col]
  return cell ? plainText(cell.block.content) : ''
}

/**
 * 取一张结构映射表（**派生**，每次现读，不缓存）。
 *
 * 软删的块在表头与格里都跳过：被删的块仍在树上（可恢复），但把它画进表里会多出一列
 * 打不开的东西。跳过是**位置语义的一部分**：同一列在各棵「活着的树」之间对齐，
 * 而不是在墓碑之间对齐。
 */
export function listTableOf(rootId: string, kb: KbClient): ListTable {
  const root = kb.get(rootId)
  if (!root) return { root: undefined, columns: [], rows: [] }
  const columns: Block[] = []
  /** `itemsByCol[i]` ＝ 第 i 列的各项（顺序＝children 顺序，软删的已跳过） */
  const itemsByCol: ListTableItem[][] = []
  for (const child of kb.children(rootId)) {
    if (isDeleted(child)) continue
    columns.push(child)
    const items: ListTableItem[] = []
    for (const item of kb.children(child.id)) {
      if (isDeleted(item)) continue
      items.push({ block: item, children: liveChildren(kb, item.id) })
    }
    itemsByCol.push(items)
  }
  const height = itemsByCol.reduce((n, items) => Math.max(n, items.length), 0)
  const rows: ListTableRow[] = []
  for (let j = 0; j < height; j++) {
    rows.push({ cells: itemsByCol.map((items) => items[j] ?? null) })
  }
  return { root, columns, rows }
}

function liveChildren(kb: KbClient, id: string): Block[] {
  return kb.children(id).filter((b) => !isDeleted(b))
}

/**
 * 按第 `col` 列排**显示序**。
 *
 * 与平表同一条口径：空值永远最后、相等保持来源顺序（`children` 顺序）、
 * **不改任何数据**（排序只影响这一次渲染的顺序）。
 *
 * ⚠️ 行是「每列各取第 j 项」的**位置元组**：按某一列排序会把整行（别的列的第 j 项）
 *    一起带走 —— 这与平表「按一列排序，行是记录」是同一条语义，不是把各列独立排序。
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
