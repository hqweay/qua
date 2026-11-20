/**
 * **结构映射表**：把一棵大纲树摊成「第一行＝直接子块（表头）、一列＝那个子块的孩子」的表。
 *
 * 渲染口径（为什么长这样）：
 *   · **格就是块**：表头格画那个直接子块的正文，身体格画它的第 j 个孩子。用的是
 *     `SurfaceEditor` 的 run 投影 ＋ 一台就地单块编辑器 —— 不是 `<input>`、不是每格 contenteditable、
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
  listTableOf,
  clickModsOf,
  openActionOf,
  sortListRows,
  type Block,
  type BlockStore,
  type ListTableItem,
  type ListTableRow,
  type OpenAction,
  type ViewConfig,
} from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import { t } from '../../core/infra/msg.ts'
import type { SurfaceEditor } from '../block-ui/surface-editor.ts'

export interface ViewListTableDeps {
  store: BlockStore
  /** 容器块（活引用）：表头是它的直接子块 */
  host: () => Block
  /** 当前激活的视图配置（活引用；排序在里面） */
  view: () => ViewConfig
  kb: KbClient
  /** 格子：run 投影 ＋ 一台按需浮层编辑器（与平表同一台组件） */
  cell: SurfaceEditor
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 往某一列（表头块）末尾插一项：写在那个块下面，与大纲里敲 ↵＋Tab 同一条路 */
  insertItem: (columnId: string) => void
  /** 删除一列／一项＝软删那一块（可恢复；命令是 `core.view/delete-row`） */
  deleteBlock: (blockId: string) => void
}

const CELLS_MIN = 160

export class ViewListTable {
  readonly root: HTMLElement
  private readonly scroll: HTMLElement
  private readonly grid: HTMLElement
  private readonly deps: ViewListTableDeps
  private rows: ListTableRow[] = []
  private columns: readonly Block[] = []
  /** 展开过的项（块 id）：**视图状态**，不入库；结构变了就丢掉不再存在的项 */
  private expanded = new Set<string>()
  /** 这一屏画着的每一块的投影体（按 blockId 修补，不整表重挂） */
  private readonly bodies = new Map<string, HTMLElement>()
  /** 整片重搭的形状签名：列 ＋ 每行有哪些格（**不含显示排序、不含展开集**） */
  private shape = ''
  /** 上一次重搭/换格时展开的项：用来只换受影响那一格，而不是拆整表 */
  private renderedExpanded = new Set<string>()

  constructor(deps: ViewListTableDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'lt'
    this.scroll = document.createElement('div')
    this.scroll.className = 'lt-scroll'
    this.grid = document.createElement('div')
    this.grid.className = 'lt-grid'
    this.scroll.appendChild(this.grid)
    this.root.append(this.scroll)
  }

  dispose(): void {
    this.bodies.clear()
    this.root.remove()
  }

  /**
   * 重画。
   *
   * 形状（列 ＋ 每行的格）变了才整表重搭；显示排序只就地搬已有行节点；
   * 展开/收起只换那一格。整表重搭是最后手段 —— 它会把正在输入的格摘掉。
   */
  render(ids?: readonly string[]): void {
    const table = listTableOf(this.deps.host().id, this.deps.kb)
    const rows = sortListRows(table.rows, this.deps.view().listTable?.sort)
    // 展开集只留还在表里的项：块被删/搬走之后，那一格不再是「同一格」
    const live = new Set<string>()
    for (const r of rows) for (const c of r.cells) if (c) live.add(c.block.id)
    for (const id of [...this.expanded]) if (!live.has(id)) this.expanded.delete(id)

    const shape = this.shapeOf(rows, table.columns)
    this.rows = rows
    this.columns = table.columns

    if (shape !== this.shape) {
      // 列或行成员真的变了：只有这时才整表重搭
      this.shape = shape
      this.buildAll()
      return
    }

    // 展开/收起：只换受影响那一格，别的格（可能在编辑）不动
    const changed = new Set<string>()
    for (const id of this.expanded) if (!this.renderedExpanded.has(id)) changed.add(id)
    for (const id of this.renderedExpanded) if (!this.expanded.has(id)) changed.add(id)
    if (changed.size > 0) {
      this.renderedExpanded = new Set(this.expanded)
      this.refreshExpandedCells(changed)
    }

    // 显示排序：把已有行节点就地搬成新序；实在对不上才退回整表重搭
    if (!this.reorderInPlace(rows)) {
      this.buildAll()
      return
    }

    if (ids && ids.length > 0) this.patch(ids)
    else this.patchAll()
  }

  /** 形状：列 id ＋ 每行的格 id 序列（行序无关）——排序与展开都不算形状 */
  private shapeOf(rows: readonly ListTableRow[], columns: readonly Block[]): string {
    return JSON.stringify({
      columns: columns.map((c) => c.id),
      rows: rows
        .map((r) => r.cells.map((c) => c?.block.id ?? '').join(','))
        .sort(),
    })
  }

  /** 一行 DOM 的格 id 序列（与 `shapeOf` 里每行的键同口径） */
  private rowKeyOf(row: HTMLElement): string {
    return [...row.children]
      .filter((el): el is HTMLElement => el instanceof HTMLElement && el.classList.contains('lt-cell'))
      .map((c) => c.dataset.blockId ?? '')
      .join(',')
  }

  /**
   * 显示排序只改行的先后：把已有的 `.lt-row` 按新序 `appendChild` 搬一遍。
   * 节点不变 ⇒ 正在输入的格、hover、展开的子树都不丢；表头 `makeHead` 仍是第一个孩子
   * （只在它后面追加行节点，从不碰它）。已经是新序时一个节点都不动。
   */
  private reorderInPlace(rows: readonly ListTableRow[]): boolean {
    if (rows.length === 0) return true
    const body = [...this.grid.children].filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && el.classList.contains('lt-row') && !el.classList.contains('lt-row--head'),
    )
    const wanted = rows.map((r) => r.cells.map((c) => c?.block.id ?? '').join(','))
    if (body.length !== wanted.length) return false
    if (body.every((el, i) => this.rowKeyOf(el) === wanted[i])) return true

    const byKey = new Map<string, HTMLElement[]>()
    for (const el of body) {
      const key = this.rowKeyOf(el)
      const list = byKey.get(key)
      if (list) list.push(el)
      else byKey.set(key, [el])
    }
    // 先确认新序的每一行都有现成节点，再动手（失败时不留半截 DOM）
    const need = new Map<string, number>()
    for (const key of wanted) need.set(key, (need.get(key) ?? 0) + 1)
    for (const [key, count] of need) if ((byKey.get(key)?.length ?? 0) < count) return false

    wanted.forEach((key, index) => {
      const el = byKey.get(key)!.shift()!
      el.dataset.row = String(index)
      this.grid.appendChild(el)
    })
    return true
  }

  /* ---------------------------------------------------------- 搭 */

  private buildAll(): void {
    // 整表重搭会把正在编辑的格摘掉：先把这次编辑收尾
    this.deps.cell.commit()
    this.bodies.clear()
    this.renderedExpanded = new Set(this.expanded)
    this.root.dataset.empty = this.columns.length === 0 ? '1' : '0'
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
      more.dataset.tip = t('ui.view.moreItemsTitle')
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
    // `tv-title-inner` 是「这一格是块本身」的既有类名（样式与断言都按它选）
    body.className = 'lt-body tv-title-inner'
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
    open.dataset.tip = t('ui.view.openBlock')
    open.setAttribute('aria-label', t('ui.view.openBlock'))
    open.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.deps.openBlock(block.id, openActionOf(e))
    })
    box.appendChild(open)

    if (opts.insertItem) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'lt-add'
      add.dataset.tip = t('ui.view.newItemTitle')
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
    del.dataset.tip = opts.insertItem ? t('ui.view.deleteColumn') : t('ui.view.deleteItem')
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
   * 槽位是格里的那个投影体（`.lt-body`）：点格上的按钮（打开/删除/加一项）不算编辑。
   */
  private wireClick(el: HTMLElement, blockId: string): void {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      const slot = target.closest<HTMLElement>('.lt-body')
      this.deps.cell.handleClick(blockId, target, clickModsOf(e), { x: e.clientX, y: e.clientY }, slot)
    })
  }

  /** 一次就地编辑结束：只重画那一格 */
  afterEdit(blockId: string): void {
    const body = this.bodies.get(blockId)
    if (body) this.patchBody(blockId, body)
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
      marker.dataset.tip = t('ui.view.openBlock')
      marker.dataset.dragFor = child.id
      marker.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        this.deps.openBlock(child.id, openActionOf(e))
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
        this.deps.cell.handleClick(child.id, target, clickModsOf(e), { x: e.clientX, y: e.clientY }, body)
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

  /** 找到某个 id 在哪一列的哪一行（展开/收起时按它重建那一格） */
  private itemOf(id: string): { item: ListTableItem; col: number } | undefined {
    for (const r of this.rows) {
      for (let col = 0; col < r.cells.length; col++) {
        const cell = r.cells[col]
        if (cell?.block.id === id) return { item: cell, col }
      }
    }
    return undefined
  }

  /** 展开/收起只换那一格：旧格连同展开区里登记的投影体一起退掉，再用 `makeItemCell` 建新格 */
  private refreshExpandedCells(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      const cells = [...this.grid.querySelectorAll<HTMLElement>('.lt-cell')].filter(
        (c) => !c.classList.contains('lt-cell--head') && c.dataset.blockId === id,
      )
      const found = this.itemOf(id)
      for (const old of cells) {
        // 旧格（含展开区）里的投影体已不在 DOM 上，别留给后面的 patch
        for (const el of [old, ...old.querySelectorAll<HTMLElement>('[data-block-id]')]) {
          if (el.dataset.blockId) this.bodies.delete(el.dataset.blockId)
        }
        if (found) old.replaceWith(this.makeItemCell(found.item, found.col))
      }
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
