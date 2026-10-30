/**
 * **结构映射表**：把一棵大纲树摊成「行＝一级子块、第 k 格＝第 (k−1) 个孩子」的表。
 *
 * 渲染口径（为什么长这样）：
 *   · **格就是块**：第 1 格画行自己的正文，第 k 格画那一块的第 (k−1) 个孩子。用的是
 *     `BlockCell` 的 run 投影 ＋ 一台按需浮层编辑器 —— 不是 `<input>`、不是每格 contenteditable、
 *     也不是每行一台编辑器（三格里各开一台，DOM 与订阅会随格数翻倍）。
 *   · **不做表头判定**：第一行就是普通一行，只在**视觉上**按表头（加粗 ＋ 吸顶）画；
 *     想要真表头就写成标题块。数据上没有任何「表头」字段。
 *   · **列数由树推导**：`max(各行孩子数) + 1`；某行孩子少 ⇒ 右侧空格，其它行不错位。
 *   · **三级起不进主表列**：第 k 格里的块自己的孩子收成「＋N 项」，点开在**那一格里面**摊开。
 *   · **行高按内容**：这里没有固定行高，也不做窗口化（那套按固定行高算窗口，套上来会抖）。
 *     平表的三档规模策略**不适用于这一档**。
 *   · **按 blockId 局部修补**：整表重挂会重演「正在输入的格子被换掉 ⇒ IME 断掉」。
 *
 * 代价登记：每次模型通知都会重算一次派生（`listTableOf` 是 O(行×格)），因为「结构有没有变」
 * 只有重算才知道（增/删子块的通知只带新块 id，不带父 id）。这一档不做窗口化，所以规模上限
 * 是「一张人读得完的表」；真到几千行时该补的是按父 id 失效的结构缓存，而不是把窗口化硬套上来。
 */
import {
  displayNameOf,
  listTableOf,
  sortListRows,
  type Block,
  type BlockStore,
  type ListTableRow,
  type ViewConfig,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import type { BlockCell } from './block-cell.ts'

export interface ViewListTableDeps {
  store: BlockStore
  /** 容器块（活引用）：行是它的直接子块 */
  host: () => Block
  /** 当前激活的视图配置（活引用；排序在里面） */
  view: () => ViewConfig
  kb: KbClient
  /** 格子：run 投影 ＋ 一台按需浮层编辑器（与平表同一台组件） */
  cell: BlockCell
  openBlock: (blockId: string) => void
  deleteRow: (rowId: string) => void
}

interface RowEls {
  row: HTMLElement
  /** 第 1 格的投影体（行自己的正文） */
  self: HTMLElement
  /** 第 k 格的投影体（`cells[i]` ＝ 第 `i+2` 格；空格没有这一项） */
  cells: Map<string, HTMLElement>
  /** 展开区里各子块的投影体（三级起；没有展开就是空表） */
  subs: Map<string, HTMLElement>
}

const CELLS_MIN = 160

export class ViewListTable {
  readonly root: HTMLElement
  private readonly caption: HTMLElement
  private readonly scroll: HTMLElement
  private readonly grid: HTMLElement
  private readonly deps: ViewListTableDeps
  private rows: ListTableRow[] = []
  private columns = 1
  /** 展开过的格子（块 id）：**视图状态**，不入库；结构变了就丢掉不再存在的项 */
  private expanded = new Set<string>()
  private rendered = new Map<string, RowEls>()
  /** 形状签名：行/格的身份序列 ＋ 列数 ＋ 展开集。变了才整表重搭 */
  private shape = ''

  constructor(deps: ViewListTableDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'lt'
    this.caption = document.createElement('div')
    this.caption.className = 'lt-caption'
    this.scroll = document.createElement('div')
    this.scroll.className = 'lt-scroll'
    this.grid = document.createElement('div')
    this.grid.className = 'lt-grid'
    this.scroll.appendChild(this.grid)
    this.root.append(this.caption, this.scroll)
  }

  dispose(): void {
    this.root.remove()
  }

  /**
   * 重画。
   *
   * `ids` 是这次动过的块（由 store 的通知给出）：形状没变就只重画碰到的那几格，
   * 形状变了（增/删子块、换排序、展开/收起）才整表重搭。
   */
  render(ids?: readonly string[]): void {
    const table = listTableOf(this.deps.host().id, this.deps.kb)
    const rows = sortListRows(table.rows, this.deps.view().list?.sort)
    const title = table.root ? displayNameOf(table.root).trim() : ''
    // 展开集只留还在表里的块：块被删/搬走之后，那个格子不再是「同一格」
    const live = new Set<string>()
    for (const r of rows) for (const c of r.cells) if (c) live.add(c.block.id)
    for (const id of [...this.expanded]) if (!live.has(id)) this.expanded.delete(id)

    const shape = JSON.stringify({
      title,
      columns: table.columns,
      rows: rows.map((r) => [r.block.id, r.cells.map((c) => c?.block.id ?? '')]),
      expanded: [...this.expanded],
    })
    this.rows = rows
    this.columns = table.columns
    if (shape !== this.shape) {
      this.shape = shape
      this.buildAll(title)
      return
    }
    if (ids && ids.length > 0) this.patch(ids)
    else this.patchAll()
  }

  /* ---------------------------------------------------------- 搭 */

  private buildAll(title: string): void {
    this.root.dataset.empty = this.rows.length === 0 ? '1' : '0'
    this.caption.textContent = title === '' ? t('ui.page.untitled') : title
    this.caption.dataset.emptyTitle = title === '' ? '1' : '0'
    this.root.style.setProperty(
      '--lt-cols',
      `repeat(${Math.max(1, this.columns)}, minmax(${CELLS_MIN}px, 1fr))`,
    )
    this.rendered.clear()
    const frag = document.createDocumentFragment()
    this.rows.forEach((r, i) => frag.appendChild(this.makeRow(r, i)))
    this.grid.replaceChildren(frag)
    if (this.rows.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'lt-empty'
      empty.textContent = t('ui.view.listEmpty')
      const hint = document.createElement('span')
      hint.className = 'lt-empty-hint'
      hint.textContent = t('ui.view.listEmptyHint')
      empty.appendChild(hint)
      this.grid.appendChild(empty)
    }
  }

  private makeRow(r: ListTableRow, index: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'lt-row'
    row.dataset.blockId = r.block.id
    // 第一行只做**视觉**表头（加粗 ＋ 吸顶）：数据上它和别的行一样
    if (index === 0) row.classList.add('lt-row--head')

    const gutter = document.createElement('div')
    gutter.className = 'lt-gutter'
    const marker = document.createElement('button')
    marker.type = 'button'
    marker.className = 'lt-marker'
    marker.title = t('ui.view.openBlock')
    marker.setAttribute('aria-label', t('ui.view.openBlock'))
    marker.addEventListener('click', (e) => {
      e.preventDefault()
      this.deps.openBlock(r.block.id)
    })
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'lt-del'
    del.title = t('ui.view.deleteRow')
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.preventDefault()
      // 先结束正在进行的编辑：否则「改动时刻」的边界会落在一个马上看不见的块上
      this.deps.cell.commit()
      this.deps.deleteRow(r.block.id)
    })
    gutter.append(marker, del)
    row.appendChild(gutter)

    const selfCell = this.makeCell(r.block, 0)
    row.appendChild(selfCell)
    const cells = new Map<string, HTMLElement>()
    const subs = new Map<string, HTMLElement>()
    for (let i = 0; i < this.columns - 1; i++) {
      const cell = r.cells[i]
      if (!cell) {
        const empty = document.createElement('div')
        empty.className = 'lt-cell lt-cell--empty'
        empty.dataset.col = String(i + 1)
        row.appendChild(empty)
        continue
      }
      const el = this.makeCell(cell.block, i + 1, cell.children, subs)
      cells.set(cell.block.id, el.querySelector<HTMLElement>('.lt-body')!)
      row.appendChild(el)
    }

    this.rendered.set(r.block.id, { row, self: selfCell.querySelector<HTMLElement>('.lt-body')!, cells, subs })
    return row
  }

  /** 一格：投影体 ＋（有孩子时）「＋N 项」开关与展开区 */
  private makeCell(
    block: Block,
    col: number,
    children: readonly Block[] = [],
    subs?: Map<string, HTMLElement>,
  ): HTMLElement {
    const el = document.createElement('div')
    el.className = 'lt-cell'
    if (col === 0) el.classList.add('lt-cell--self')
    el.dataset.col = String(col)
    el.dataset.blockId = block.id

    const body = document.createElement('div')
    body.className = 'lt-body'
    this.deps.cell.render(block, body)
    el.appendChild(body)

    if (children.length > 0) {
      const open = this.expanded.has(block.id)
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'lt-more'
      more.title = t('ui.view.moreItemsTitle')
      more.textContent = open ? t('ui.view.fewerItems') : t('ui.view.moreItems', { count: String(children.length) })
      more.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (open) this.expanded.delete(block.id)
        else this.expanded.add(block.id)
        this.render()
      })
      el.appendChild(more)
      if (open) el.appendChild(this.makeSub(children, subs))
    }
    /**
     * 点格：引用/原子先导航，普通文字才进编辑（与平表标题列同一套手势）。
     * 判据在 `BlockCell.handleClick` 里（它只认 `[data-ref-to]` 与 `.tv-title-inner`）。
     */
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      this.deps.cell.handleClick(block.id, target, { altKey: e.altKey, shiftKey: e.shiftKey }, { x: e.clientX, y: e.clientY })
    })
    return el
  }

  /** 三级起：在第 k 格**里面**摊开（不进主表列） */
  private makeSub(children: readonly Block[], subs?: Map<string, HTMLElement>): HTMLElement {
    const box = document.createElement('div')
    box.className = 'lt-sub'
    for (const child of children) {
      const row = document.createElement('div')
      row.className = 'lt-sub-item'
      row.dataset.blockId = child.id
      const marker = document.createElement('button')
      marker.type = 'button'
      marker.className = 'lt-sub-marker'
      marker.title = t('ui.view.openBlock')
      marker.dataset.dragFor = child.id
      marker.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.deps.openBlock(child.id)
      })
      const body = document.createElement('div')
      body.className = 'lt-sub-body'
      this.deps.cell.render(child, body)
      subs?.set(child.id, body)
      /**
       * 展开区里的格也是**块本身**：点字进编辑（改的是那一块），点引用先导航。
       * 这里必须单独挂一次：外层的点击处理只认这一格自己的块 id。
       */
      body.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null
        if (!target) return
        // 展开区在**这一格里面**：不拦的话外层的点击处理会把它当成「点这一格」再开一台编辑器
        e.stopPropagation()
        this.deps.cell.handleClick(child.id, target, { altKey: e.altKey, shiftKey: e.shiftKey }, { x: e.clientX, y: e.clientY })
      })
      row.append(marker, body)
      box.appendChild(row)
    }
    return box
  }

  /* ---------------------------------------------------------- 修补 */

  private patchAll(): void {
    for (const r of this.rows) this.patchRow(r, null)
  }

  private patch(ids: readonly string[]): void {
    const set = new Set(ids)
    for (const r of this.rows) this.patchRow(r, set)
  }

  /**
   * 修补一行里**被改到的格**。
   *
   * ⚠️ 正在输入的那一格不碰：重建会把焦点与 IME 的预编辑串一起弄丢。
   */
  private patchRow(r: ListTableRow, ids: ReadonlySet<string> | null): void {
    const els = this.rendered.get(r.block.id)
    if (!els) return
    const dirty = (id: string): boolean =>
      (ids === null || ids.has(id)) && this.deps.cell.editingId !== id
    if (dirty(r.block.id)) this.deps.cell.render(r.block, els.self)
    for (const c of r.cells) {
      if (!c) continue
      const body = els.cells.get(c.block.id)
      if (!body || !dirty(c.block.id)) continue
      this.deps.cell.render(c.block, body)
    }
    for (const sub of els.subs) {
      const b = this.deps.store.find(sub[0])
      if (!b || !dirty(sub[0])) continue
      this.deps.cell.render(b, sub[1])
    }
  }
}
