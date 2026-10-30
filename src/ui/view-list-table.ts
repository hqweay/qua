/**
 * **结构映射表**：把一棵大纲树摊成「第一行＝直接子块（表头）、一列＝那个子块的孩子」的表。
 *
 * 渲染口径（为什么长这样）：
 *   · **格就是块**：表头格画那个直接子块的正文，身体格画它的第 j 个孩子。用的是
 *     `BlockCell` 的 run 投影 ＋ 一台按需浮层编辑器 —— 不是 `<input>`、不是每格 contenteditable、
 *     也不是每行一台编辑器（一屏几十格里各开一台，DOM 与订阅会随格数翻倍）。
 *   · **表头是真表头**：第一行就是容器的直接子块，数据上不需要额外字段（列＝那个块）。
 *     吸顶 ＋ 加粗只是让它读起来像表头，没有第二份事实。
 *   · **列数由树推导**：`columns.length`（＝活着的直接子块数）。某一列少一项 ⇒ 那一行
 *     右侧/下方空格，别的列不错位。
 *   · **三级起不进主表列**：身体格里的块自己的孩子收成「＋N 项」，点开在**那一格里面**摊开。
 *   · **行高按内容**：这里没有固定行高，也不做窗口化（那套按固定行高算窗口，套上来会抖）。
 *     平表的三档规模策略**不适用于这一档**。
 *   · **按 blockId 局部修补**：整表重挂会重演「正在输入的格子被换掉 ⇒ IME 断掉」。
 *
 * 代价登记：每次模型通知都会重算一次派生（`listTableOf` 是 O(列×项)），因为「结构有没有变」
 * 只有重算才知道（增/删子块的通知只带新块 id，不带父 id）。这一档不做窗口化，所以规模上限
 * 是「一张人读得完的表」；真到几千行时该补的是按父 id 失效的结构缓存，而不是把窗口化硬套上来。
 */
import {
  displayNameOf,
  listTableOf,
  sortListRows,
  type Block,
  type BlockStore,
  type ListTableItem,
  type ListTableRow,
  type ViewConfig,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import type { BlockCell } from './block-cell.ts'

export interface ViewListTableDeps {
  store: BlockStore
  /** 容器块（活引用）：表头是它的直接子块 */
  host: () => Block
  /** 当前激活的视图配置（活引用；排序在里面） */
  view: () => ViewConfig
  kb: KbClient
  /** 格子：run 投影 ＋ 一台按需浮层编辑器（与平表同一台组件） */
  cell: BlockCell
  openBlock: (blockId: string) => void
  /** 往某一列（表头块）末尾插一项：写在那个块下面，与大纲里敲 ↵＋Tab 同一条路 */
  insertItem: (columnId: string) => void
  /** 删除一列／一项＝软删那一块（可恢复；命令是 `core.view/delete-row`） */
  deleteBlock: (blockId: string) => void
  /**
   * 要不要画表标题（＝容器名）。
   *
   * 判据是「这个名字是不是已经在上面一行了」，而这件事**只有挂载点知道**：
   * 整屏的视图宿主挂在段尾，容器就是这一屏的根（页面标题已经写着它）⇒ 不画；
   * 嵌入是一行里的投影，源的名字在屏幕上没有第二处 ⇒ 画。
   */
  showCaption?: boolean
}

const CELLS_MIN = 160

export class ViewListTable {
  readonly root: HTMLElement
  private readonly caption: HTMLElement
  private readonly scroll: HTMLElement
  private readonly grid: HTMLElement
  private readonly deps: ViewListTableDeps
  private rows: ListTableRow[] = []
  private columns: readonly Block[] = []
  /** 展开过的项（块 id）：**视图状态**，不入库；结构变了就丢掉不再存在的项 */
  private expanded = new Set<string>()
  /** 这一屏画着的每一块的投影体（按 blockId 修补，不整表重挂） */
  private readonly bodies = new Map<string, HTMLElement>()
  /** 形状签名：表头/项的 id 序列 ＋ 展开集。变了才整表重搭 */
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
    if (deps.showCaption === false) this.root.append(this.scroll)
    else this.root.append(this.caption, this.scroll)
  }

  dispose(): void {
    this.bodies.clear()
    this.root.remove()
  }

  /**
   * 重画。
   *
   * `ids` 是这次动过的块（由 store 的通知给出）：形状没变就只重画碰到的那几格，
   * 形状变了（增/删表头或项、换排序、展开/收起）才整表重搭。
   */
  render(ids?: readonly string[]): void {
    const table = listTableOf(this.deps.host().id, this.deps.kb)
    const rows = sortListRows(table.rows, this.deps.view().list?.sort)
    const title = table.root ? displayNameOf(table.root).trim() : ''
    // 展开集只留还在表里的项：块被删/搬走之后，那一格不再是「同一格」
    const live = new Set<string>()
    for (const r of rows) for (const c of r.cells) if (c) live.add(c.block.id)
    for (const id of [...this.expanded]) if (!live.has(id)) this.expanded.delete(id)

    const shape = JSON.stringify({
      title: this.deps.showCaption === false ? '' : title,
      columns: table.columns.map((c) => c.id),
      rows: rows.map((r) => r.cells.map((c) => c?.block.id ?? '')),
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
    this.bodies.clear()
    this.root.dataset.empty = this.columns.length === 0 ? '1' : '0'
    this.caption.textContent = title === '' ? t('ui.page.untitled') : title
    this.caption.dataset.emptyTitle = title === '' ? '1' : '0'
    this.root.style.setProperty(
      '--lt-cols',
      `repeat(${Math.max(1, this.columns.length)}, minmax(${CELLS_MIN}px, 1fr))`,
    )
    const frag = document.createDocumentFragment()
    if (this.columns.length > 0) frag.appendChild(this.makeHead())
    this.rows.forEach((r, i) => frag.appendChild(this.makeRow(r, i)))
    this.grid.replaceChildren(frag)
    if (this.columns.length === 0) this.grid.appendChild(this.emptyBlock(t('ui.view.listEmpty'), t('ui.view.listEmptyHint')))
    else if (this.rows.length === 0) this.grid.appendChild(this.emptyBlock(t('ui.view.listEmptyItems')))
  }

  private emptyBlock(text: string, hint?: string): HTMLElement {
    const empty = document.createElement('div')
    empty.className = 'lt-empty'
    empty.textContent = text
    if (hint) {
      const el = document.createElement('span')
      el.className = 'lt-empty-hint'
      el.textContent = hint
      empty.appendChild(el)
    }
    return empty
  }

  /** 第一行：一个直接子块一列（它的孩子就是这一列的各项） */
  private makeHead(): HTMLElement {
    const row = document.createElement('div')
    row.className = 'lt-row lt-row--head'
    this.columns.forEach((block, col) => {
      const cell = document.createElement('div')
      cell.className = 'lt-cell lt-cell--head'
      cell.dataset.col = String(col)
      cell.dataset.blockId = block.id
      cell.appendChild(this.bodyOf(block))
      cell.appendChild(this.chrome(block, { insertItem: true }))
      this.wireClick(cell, block.id)
      row.appendChild(cell)
    })
    return row
  }

  private makeRow(r: ListTableRow, index: number): HTMLElement {
    const row = document.createElement('div')
    row.className = 'lt-row'
    row.dataset.row = String(index)
    for (let col = 0; col < this.columns.length; col++) {
      const cell = r.cells[col]
      row.appendChild(cell ? this.makeItemCell(cell, col) : this.makeEmptyCell(col))
    }
    return row
  }

  /** 一格（身体）：投影体 ＋（有孩子时）「＋N 项」开关与展开区 ＋ 悬停才出现的块操作 */
  private makeItemCell(item: ListTableItem, col: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'lt-cell'
    el.dataset.col = String(col)
    el.dataset.blockId = item.block.id
    el.appendChild(this.bodyOf(item.block))
    el.appendChild(this.chrome(item.block, { insertItem: false }))
    if (item.children.length > 0) {
      const open = this.expanded.has(item.block.id)
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'lt-more'
      more.title = t('ui.view.moreItemsTitle')
      more.textContent = open ? t('ui.view.fewerItems') : t('ui.view.moreItems', { count: String(item.children.length) })
      more.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (open) this.expanded.delete(item.block.id)
        else this.expanded.add(item.block.id)
        this.render()
      })
      el.appendChild(more)
      if (open) el.appendChild(this.makeSub(item.children))
    }
    this.wireClick(el, item.block.id)
    return el
  }

  private makeEmptyCell(col: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'lt-cell lt-cell--empty'
    el.dataset.col = String(col)
    return el
  }

  /** 这一块的投影体（登记进 `bodies`：局部修补按 blockId 找得到它） */
  private bodyOf(block: Block): HTMLElement {
    const body = document.createElement('div')
    body.className = 'lt-body'
    this.deps.cell.render(block, body)
    this.bodies.set(block.id, body)
    return body
  }

  /**
   * 悬停才出现的块操作：打开／加一项（仅表头）／删除。
   *
   * 为什么在格子里而不是行首槽：这张表的「行」是位置元组，没有自己的块可打开；
   * 有身份的只有**格里的块**（表头块与项），所以操作跟着格走。
   */
  private chrome(block: Block, opts: { insertItem: boolean }): HTMLElement {
    const box = document.createElement('div')
    box.className = 'lt-chrome'

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'lt-marker'
    open.title = t('ui.view.openBlock')
    open.setAttribute('aria-label', t('ui.view.openBlock'))
    open.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.deps.openBlock(block.id)
    })
    box.appendChild(open)

    if (opts.insertItem) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'lt-add'
      add.title = t('ui.view.newItemTitle')
      add.setAttribute('aria-label', t('ui.view.newItem'))
      add.textContent = '＋'
      add.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        // 先结束正在进行的编辑：否则「改动时刻」的边界会落在一个马上重排的块上
        this.deps.cell.commit()
        this.deps.insertItem(block.id)
      })
      box.appendChild(add)
    }

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'lt-del'
    del.title = opts.insertItem ? t('ui.view.deleteColumn') : t('ui.view.deleteItem')
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.deps.cell.commit()
      this.deps.deleteBlock(block.id)
    })
    box.appendChild(del)
    return box
  }

  /**
   * 点格：引用/原子先导航，普通文字才进编辑（与平表标题列同一套手势）。
   * 判据在 `BlockCell.handleClick` 里（它只认 `[data-ref-to]` 与 `.tv-title-inner`）。
   */
  private wireClick(el: HTMLElement, blockId: string): void {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      this.deps.cell.handleClick(blockId, target, { altKey: e.altKey, shiftKey: e.shiftKey }, { x: e.clientX, y: e.clientY })
    })
  }

  /** 三级起：在那一格**里面**摊开（不进主表列） */
  private makeSub(children: readonly Block[]): HTMLElement {
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
      this.bodies.set(child.id, body)
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
    for (const [id, body] of this.bodies) this.patchBody(id, body)
  }

  private patch(ids: readonly string[]): void {
    for (const id of ids) {
      const body = this.bodies.get(id)
      if (body) this.patchBody(id, body)
    }
  }

  /**
   * 修补一块的投影体。
   *
   * ⚠️ 正在输入的那一格不碰：重建会把焦点与 IME 的预编辑串一起弄丢。
   */
  private patchBody(id: string, body: HTMLElement): void {
    if (this.deps.cell.editingId === id) return
    const b = this.deps.store.find(id)
    if (!b) return
    this.deps.cell.render(b, body)
  }
}
