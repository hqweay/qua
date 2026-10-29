/**
 * **平表视图**：把一个容器的直接子块渲染成一张表。
 *
 * 三条口径（为什么长这样）：
 *   · **不用 `<table>`**：`<tr>` 是 internal table box，`content-visibility` 在它上面实测是
 *     no-op ⇒ 窗口化那档直接失效。用 **div 行 ＋ 每行 `display:grid` ＋ 共享 `--qv-cols`**：
 *     列宽只在一个变量里，行是普通块级盒，`content-visibility` / 绝对定位都能用。
 *   · **标题列是块本身**：投影成 run（marks/引用/图片都在），点文字才换成一台单块编辑器
 *     （见 `block-cell.ts`）。所以「改正文」和「改属性」是同一批块，没有第二份数据。
 *   · **行按 blockId 局部修补**：整表 `textContent=''` 重挂会重演「按下的按钮被换掉 ⇒ click
 *     不派发」「正在输入的单元格被换掉 ⇒ IME 断掉」。结构变了（增/删/排序）才整体重排。
 *
 * 三档规模（按行数选渲染策略，不按「看起来会不会卡」猜）：
 *   `< 300` 全量挂；`300–2000` 全量挂但行上 `content-visibility: auto`；
 *   `>= 2000` **窗口化**（只挂可视范围 ± 若干行，用上下留白撑出滚动高度）。
 */
import type { Block, BlockStore, ViewColumn, ViewConfig, ViewRecord } from '../core/index.ts'
import { clockLabel, displayNameOf, hasValue, propKindOf, propLabel } from '../core/index.ts'
import type { FieldRow } from '../core/props.ts'
import { plainText } from '../core/runs.ts'
import { t } from '../core/msg.ts'
import { makeTagChipEl } from '../view/block-dom.ts'
import type { BlockCell } from './block-cell.ts'
import { makeCellEditor } from './properties.ts'
import {
  CHILDREN_COLUMN,
  CREATED_COLUMN,
  MODIFIED_COLUMN,
  TAGS_COLUMN,
  TITLE_COLUMN,
  defaultWidthOf,
  isSortableColumn,
  sortRecords,
  visibleColumns,
} from '../core/view.ts'

export interface ViewTableDeps {
  store: BlockStore
  /** 容器块（活引用）：行是它的直接子块（查询源则由装配层给命中） */
  host: () => Block
  /** 当前激活的视图配置（活引用） */
  view: () => ViewConfig
  /** 行（**派生**，由装配层按源算好：children＝直接子块；query＝命中） */
  records: () => ViewRecord[]
  /** 属性定义（列头文案与类型） */
  defs: () => readonly Block[]
  /** 没有显式列时的默认列（由装配层按读门面算：`core/view.ts` 的 `defaultColumns`） */
  defaults: () => ViewColumn[]
  setValue: (blockId: string, propId: string, value: unknown) => void
  clearValue: (blockId: string, propId: string) => void
  /** 表头排序：`dir === ''` 取消（children 源只改显示序；查询源由装配层转成重查） */
  sort: (by: string, dir: string) => void
  insertRow: () => void
  deleteRow: (rowId: string) => void
  openBlock: (blockId: string) => void
  /** 标题格（投影 ＋ 单块编辑器浮层） */
  cell: BlockCell
  /** `ref` 值的选择器（属性区那一份复用；省略 ＝ ref 列只读） */
  pickRef?: (owner: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  refLabel?: (targetId: string) => string
}

/** 行高（px）：三档密度；窗口化按它算，所以必须固定 */
const ROW_H: Record<'compact' | 'cozy' | 'comfortable', number> = { compact: 28, cozy: 36, comfortable: 44 }
/** 窗口外的缓冲行数：滚动时不留白，也不多挂 */
const OVERSCAN = 8
/** 低于这个宽度就降级成紧凑列表（表的最多列在这个宽度里已经读不动了） */
const MIN_TABLE_W = 560
/** 窗口化的门槛：再往下全挂也不会卡，全挂反而更简单（编辑/选区不用管窗口） */
const VIRTUAL_FROM = 2000

interface RowEls {
  row: HTMLElement
  title: HTMLElement
  cells: Map<string, HTMLElement>
}

export class ViewTable {
  readonly root: HTMLElement
  private readonly scroll: HTMLElement
  private readonly head: HTMLElement
  private readonly body: HTMLElement
  private readonly deps: ViewTableDeps
  /** 当前列（可见列） */
  private cols: ViewColumn[] = []
  /** 当前行（已按视图排序） */
  private rows: ViewRecord[] = []
  private rendered = new Map<string, RowEls>()
  /** 列/行高/紧凑/虚拟的签名：变了就整表重排，没变就只 patch 行 */
  private shape = ''
  private virtual = false
  private compact = false
  private rowH = ROW_H.cozy
  private winFrom = -1
  private winTo = -1
  /** 表头排序状态的形状（点第三次取消，所以要记住当前是升还是降） */
  private sortSig = ''
  private readonly ro: ResizeObserver | null
  private readonly onScroll = (): void => this.windowIfNeeded()

  constructor(deps: ViewTableDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'tv'
    this.scroll = document.createElement('div')
    this.scroll.className = 'tv-scroll'
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true })
    this.head = document.createElement('div')
    this.head.className = 'tv-head'
    this.body = document.createElement('div')
    this.body.className = 'tv-rows'
    this.scroll.append(this.head, this.body)
    this.root.appendChild(this.scroll)
    /**
     * **单元格里的 Enter / Esc 不许冒到命令层**。
     *
     * 表格嵌在 `#editor` 里 ⇒ `editorTextFocus` 为真 ⇒ 不拦的话 Enter 会命中「拆块」命令，
     * 把**根块**拆成两段（用户看到的是「改个数字，页面被拆了」）；而 Esc 也没有退路。
     * 所以在这里拦：Enter ＝ 提交并失焦，Esc ＝ 还原成模型里的值再失焦。
     */
    this.root.addEventListener(
      'keydown',
      (e) => {
        const el = e.target
        if (!(el instanceof HTMLElement) || !el.closest('.tv-editor')) return
        if (e.key !== 'Enter' && e.key !== 'Escape') return
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          this.revertCell(el)
          el.blur()
          return
        }
        /**
         * **Enter ＝ 提交**：显式派一次 `change` 再失焦。
         *
         * 只靠「失焦时浏览器自己发 change」是不够的——那条路只在**真按键改过值**时才走；
         * 而「改完按 Enter」是用户最常走的那一下，它必须在两条路上都成立。
         * （值没变时这次提交产出 0 条 op，所以多派一次是安全的。）
         */
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.blur()
      },
      true,
    )
    // 槽宽变了就切「表格 ⇄ 紧凑列表」：不这么做，360px 里那几列会横着溢出去
    this.ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.applyWidth())
    this.ro?.observe(this.root)
  }

  dispose(): void {
    this.ro?.disconnect()
    this.scroll.removeEventListener('scroll', this.onScroll)
    this.root.remove()
  }

  /** 单元格里的 Esc：把控件还原成**模型里的值**（浏览器只在「值与聚焦时不同」时才发 change） */
  private revertCell(el: HTMLElement): void {
    const cell = el.closest<HTMLElement>('.tv-cell[data-prop]')
    const blockId = el.closest<HTMLElement>('.tv-row')?.dataset.blockId ?? ''
    const propId = cell?.dataset.prop ?? ''
    const block = blockId ? this.deps.store.find(blockId) : undefined
    if (!block || propId === '') return
    const value = block.props?.[propId]
    const text = value === undefined || value === null ? '' : String(value)
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox') el.checked = value === true
      else el.value = text
    } else if (el instanceof HTMLSelectElement) {
      el.value = text
    }
  }

  /** 整表重排（首次装、列变了、行集合变了、降级形态变了） */
  render(): void {
    const host = this.deps.host()
    const view = this.deps.view()
    this.rowH = ROW_H[view.table?.rowHeight ?? 'cozy'] ?? ROW_H.cozy
    const declared = view.table?.columns ?? []
    this.cols = visibleColumns(declared.length > 0 ? declared : this.deps.defaults())
    this.rows = sortRecords(this.deps.records(), view.table?.sort)
    void host
    this.compact = this.root.clientWidth > 0 && this.root.clientWidth < MIN_TABLE_W
    this.virtual = !this.compact && this.rows.length >= VIRTUAL_FROM
    const nextShape = JSON.stringify({
      cols: this.cols,
      rowH: this.rowH,
      compact: this.compact,
      virtual: this.virtual,
      // 行的**身份序列**：只有结构/排序变了才需要重排（内容变化走 patch）
      ids: this.rows.map((r) => r.block.id),
    })
    if (nextShape !== this.shape) {
      this.shape = nextShape
      this.applyShape()
      this.buildAll()
      return
    }
    this.patchAll()
  }

  /** 只按 blockId 修补动过的那几行（内容/属性变化走这条） */
  sync(ids?: readonly string[]): void {
    const view = this.deps.view()
    const sorted = sortRecords(this.deps.records(), view.table?.sort)
    const sameSeq =
      sorted.length === this.rows.length && sorted.every((r, i) => r.block.id === this.rows[i]!.block.id)
    if (!sameSeq) {
      this.render()
      return
    }
    this.rows = sorted
    const sig = this.sortSignature(view)
    if (sig !== this.sortSig) {
      this.sortSig = sig
      this.paintHeadState()
    }
    if (ids === undefined || ids.length === 0) {
      this.patchAll()
      return
    }
    for (const id of ids) this.patch(id)
  }

  /** 竖直滚动：窗口化时才需要重算挂载范围 */
  private windowIfNeeded(): void {
    if (!this.virtual) return
    // 正在编辑的行不能被卸载：宁可这一帧不换窗口，也不要打断输入
    if (this.deps.cell.editingId) return
    this.renderWindow(false)
  }

  /**
   * 宽度变了：跨过阈值就整表重排，否则只更新一次列变量的像素值。
   *
   * 为什么要 ResizeObserver 而不是每次渲染读一次宽度：槽是**可拖宽**的，
   * 拖的过程中不重排、松手那一刻才要换形态；只在渲染时读会让「抽屉拖窄了但表没降级」
   * 一直停在溢出状态。
   */
  private applyWidth(): void {
    const next = this.root.clientWidth > 0 && this.root.clientWidth < MIN_TABLE_W
    if (next !== this.compact) this.render()
  }

  private applyShape(): void {
    this.root.dataset.compact = this.compact ? '1' : '0'
    this.root.dataset.virtual = this.virtual ? '1' : '0'
    // 300 行以上才让浏览器跳过屏幕外的行；窗口化那档不用它（DOM 里根本没有屏外的行）
    this.root.dataset.cv = !this.compact && !this.virtual && this.rows.length >= 300 ? '1' : '0'
    this.root.style.setProperty('--tv-row-h', CSS.px(this.rowH).toString())
    this.root.style.setProperty('--tv-gutter-w', CSS.px(this.compact ? 0 : 22).toString())
    const widths = this.compact ? [] : this.cols.map((c) => CSS.px(c.width ?? defaultWidthOf(c.key)))
    this.root.style.setProperty('--qv-cols', widths.join(' ') || CSS.px(240).toString())
  }

  private sortSignature(view: ViewConfig): string {
    return JSON.stringify(view.table?.sort ?? [])
  }

  /* ---------------------------------------------------------- 搭 */

  private buildAll(): void {
    this.rendered.clear()
    this.winFrom = -1
    this.winTo = -1
    if (this.compact) {
      this.buildCompact()
      return
    }
    this.buildHead()
    this.body.replaceChildren()
    this.renderWindow(true)
  }

  /** 紧凑列表：标题 ＋ 一两个值 ＋ 「在中心槽打开」，不横向溢出 */
  private buildCompact(): void {
    this.head.replaceChildren()
    this.head.hidden = true
    this.body.replaceChildren()
    this.body.classList.add('tv-rows--compact')
    const list = document.createElement('div')
    list.className = 'tv-compact'
    for (const r of this.rows) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'tv-compact-row'
      row.dataset.blockId = r.block.id
      const name = document.createElement('span')
      name.className = 'tv-compact-title ui-ellipsis'
      const text = plainText(r.block.content).trim()
      name.textContent = text === '' ? t('ui.page.untitled') : text
      row.appendChild(name)
      if (r.tags.length > 0) {
        const tag = document.createElement('span')
        tag.className = 'tv-compact-tag ui-ellipsis'
        tag.textContent = `#${displayNameOf(r.tags[0]!)}`
        row.appendChild(tag)
      }
      row.addEventListener('click', () => this.deps.openBlock(r.block.id))
      list.appendChild(row)
    }
    this.body.appendChild(list)
    const foot = document.createElement('div')
    foot.className = 'tv-compact-foot'
    const hint = document.createElement('span')
    hint.textContent = t('ui.view.compact')
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'tv-compact-open'
    open.textContent = t('ui.view.openCenter')
    open.addEventListener('click', () => this.deps.openBlock(this.deps.host().id))
    foot.append(hint, open)
    this.body.appendChild(foot)
  }

  private buildHead(): void {
    this.head.hidden = false
    this.head.replaceChildren()
    this.head.classList.remove('tv-rows--compact')
    const cell = (cls: string): HTMLElement => {
      const el = document.createElement('div')
      el.className = `tv-cell ui-ellipsis ${cls}`
      return el
    }
    const gutter = cell('tv-gutter')
    this.head.appendChild(gutter)
    const sort = this.deps.view().table?.sort ?? []
    for (const col of this.cols) {
      const title = col.key === TITLE_COLUMN
      const el = cell(`tv-h ${title ? 'tv-title' : 'tv-prop'}`)
      el.dataset.col = col.key
      const label = this.labelOf(col.key)
      el.textContent = label
      if (isSortableColumn(col.key)) {
        el.dataset.sortable = '1'
        el.title = t('ui.view.sortHint')
        el.addEventListener('click', () => this.toggleSort(col.key))
      }
      const dir = sort.find((s) => s.by === col.key)?.dir
      if (dir) {
        el.dataset.sort = dir
        const mark = document.createElement('span')
        mark.className = 'tv-sort'
        mark.textContent = dir === 'desc' ? '↓' : '↑'
        el.appendChild(mark)
      }
      this.head.appendChild(el)
    }
    this.head.appendChild(cell('tv-actions'))
    this.sortSig = this.sortSignature(this.deps.view())
  }

  private paintHeadState(): void {
    const sort = this.deps.view().table?.sort ?? []
    for (const el of this.head.querySelectorAll<HTMLElement>('[data-col]')) {
      const dir = sort.find((s) => s.by === el.dataset.col)?.dir
      delete el.dataset.sort
      el.querySelector('.tv-sort')?.remove()
      if (!dir) continue
      el.dataset.sort = dir
      const mark = document.createElement('span')
      mark.className = 'tv-sort'
      mark.textContent = dir === 'desc' ? '↓' : '↑'
      el.appendChild(mark)
    }
  }

  /** 点表头：升 → 降 → 取消（第三次点击回到「原样」） */
  private toggleSort(key: string): void {
    const cur = (this.deps.view().table?.sort ?? []).find((s) => s.by === key)?.dir
    this.deps.sort(key, cur === undefined ? 'asc' : cur === 'asc' ? 'desc' : '')
  }

  private labelOf(key: string): string {
    if (key === TITLE_COLUMN) return t('ui.view.kind.table')
    if (key === TAGS_COLUMN) return t('ui.props.tagsTitle')
    if (key === CHILDREN_COLUMN) return '#'
    if (key === CREATED_COLUMN) return t('ui.props.createdAt')
    if (key === MODIFIED_COLUMN) return t('ui.props.modifiedAt')
    const def = this.deps.defs().find((d) => d.id === key)
    return def ? propLabel(def) : t('ui.view.columnMissing')
  }

  /* ---------------------------------------------------------- 画行 */

  /**
   * 渲染窗口（`from` 之前的行用上留白撑开、`to` 之后用下留白撑开）。
   * 非窗口化时一次画全量。
   */
  private renderWindow(reset: boolean): void {
    const total = this.rows.length
    let from = 0
    let to = total
    if (this.virtual) {
      const headH = this.head.getBoundingClientRect().height || this.rowH
      const top = Math.max(0, this.scroll.scrollTop - headH)
      const viewH = this.scroll.clientHeight || 600
      from = Math.max(0, Math.floor(top / this.rowH) - OVERSCAN)
      to = Math.min(total, Math.ceil((top + viewH) / this.rowH) + OVERSCAN)
      if (!reset && from === this.winFrom && to === this.winTo) return
    }
    this.winFrom = from
    this.winTo = to
    this.rendered.clear()
    const frag = document.createDocumentFragment()
    for (let i = from; i < to; i++) frag.appendChild(this.makeRow(this.rows[i]!))
    this.body.replaceChildren()
    this.body.style.paddingTop = this.virtual ? CSS.px(from * this.rowH).toString() : ''
    this.body.appendChild(frag)
    if (this.virtual && to < total) {
      const tail = document.createElement('div')
      tail.className = 'tv-tail'
      tail.style.height = CSS.px((total - to) * this.rowH).toString()
      this.body.appendChild(tail)
    }
  }

  private makeRow(r: ViewRecord): HTMLElement {
    const row = document.createElement('div')
    row.className = 'tv-row'
    row.dataset.blockId = r.block.id
    row.dataset.depth = '0'

    const gutter = document.createElement('div')
    gutter.className = 'tv-cell tv-gutter'
    const marker = document.createElement('button')
    marker.type = 'button'
    marker.className = 'tv-marker'
    marker.title = t('ui.view.openBlock')
    marker.setAttribute('aria-label', t('ui.view.openBlock'))
    marker.addEventListener('click', (e) => {
      e.preventDefault()
      this.deps.openBlock(r.block.id)
    })
    gutter.appendChild(marker)
    row.appendChild(gutter)

    const cells = new Map<string, HTMLElement>()
    for (const col of this.cols) {
      const cell = document.createElement('div')
      cell.className = `tv-cell ui-ellipsis ${col.key === TITLE_COLUMN ? 'tv-title' : 'tv-prop'}`
      cell.dataset.col = col.key
      if (col.key !== TITLE_COLUMN) cell.dataset.prop = col.key
      cell.appendChild(col.key === TITLE_COLUMN ? this.titleInner(r) : this.cellContent(r, col.key))
      cells.set(col.key, cell)
      row.appendChild(cell)
    }

    const actions = document.createElement('div')
    actions.className = 'tv-cell tv-actions'
    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'tv-del'
    del.title = t('ui.view.deleteRow')
    del.textContent = '×'
    del.addEventListener('click', (e) => {
      e.preventDefault()
      // 先结束正在进行的标题编辑，否则那条「改动时刻」的边界会落在一个已经看不见的块上
      this.deps.cell.commit()
      this.deps.deleteRow(r.block.id)
    })
    actions.appendChild(del)
    row.appendChild(actions)

    this.rendered.set(r.block.id, { row, title: cells.get(TITLE_COLUMN)!, cells })
    return row
  }

  private titleInner(r: ViewRecord): HTMLElement {
    const box = document.createElement('div')
    box.classList.add('ui-ellipsis')
    this.deps.cell.render(r.block, box)
    const mods = (e: MouseEvent): { altKey: boolean; shiftKey: boolean } => ({ altKey: e.altKey, shiftKey: e.shiftKey })
    box.addEventListener('click', (e) => {
      // 引用/原子先导航：只认「点到的是谁」，不认「点在格子里」——否则点 `[[某页]]` 会进编辑
      const target = e.target as HTMLElement | null
      if (!target) return
      this.deps.cell.handleClick(r.block.id, target, mods(e), { x: e.clientX, y: e.clientY })
    })
    return box
  }

  private cellContent(r: ViewRecord, key: string): HTMLElement {
    if (key === TAGS_COLUMN) {
      const box = document.createElement('div')
      box.className = 'tv-tags'
      for (const tag of r.tags) box.appendChild(makeTagChipEl(tag.id, displayNameOf(tag)))
      if (r.tags.length === 0) box.dataset.empty = '1'
      return box
    }
    if (key === CHILDREN_COLUMN) {
      const box = document.createElement('div')
      box.className = 'tv-count'
      box.textContent = String(r.block.children.length)
      return box
    }
    if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) {
      const box = document.createElement('div')
      box.className = 'tv-time'
      box.textContent = clockLabel(key === CREATED_COLUMN ? r.block.created : r.block.modified)
      return box
    }
    return this.propEditor(r.block, key)
  }

  /**
   * 属性格：一个控件，一次提交一条 op。
   *
   * 控件与属性区**共用** `makeCellEditor`（`ui/properties.ts`）：两处各写一套，
   * 迟早在某个类型上分叉（例如数字在面板里是 number、在表里是字符串）。
   */
  private propEditor(block: Block, propId: string): HTMLElement {
    const box = document.createElement('div')
    box.className = 'tv-editor'
    if (!block) return box
    const def = this.deps.defs().find((d) => d.id === propId)
    const row = cellRow(block, propId, def)
    const deps = this.deps.pickRef
      ? { pickRef: this.deps.pickRef, refLabel: this.deps.refLabel ?? ((id: string) => id) }
      : undefined
    box.appendChild(
      makeCellEditor(
        row,
        (v) => {
          if (v === undefined) this.deps.clearValue(block.id, propId)
          else this.deps.setValue(block.id, propId, v)
        },
        deps,
        block,
      ),
    )
    return box
  }

  /* ---------------------------------------------------------- 修补 */

  private patchAll(): void {
    for (const r of this.rows) this.patchRow(r)
  }

  private patch(id: string): void {
    const r = this.rows.find((x) => x.block.id === id)
    if (!r) return
    this.patchRow(r)
  }

  /**
   * 修补一行：标题重新投影、值格重建。
   *
   * ⚠️ **正在输入的格子不碰**：重建会把焦点与 IME 的预编辑串一起弄丢。
   *    它的值本来就是这个格子的用户刚打的东西，不需要别人替他刷新。
   */
  private patchRow(r: ViewRecord): void {
    const els = this.rendered.get(r.block.id)
    if (!els) return
    const editing = this.deps.cell.editingId === r.block.id
    if (!editing && !els.title.contains(document.activeElement)) {
      els.title.replaceChildren(this.titleInner(r))
    }
    for (const [key, cell] of els.cells) {
      if (key === TITLE_COLUMN) continue
      if (cell.contains(document.activeElement)) continue
      cell.replaceChildren(this.cellContent(r, key))
    }
  }
}

/** 一格属性需要的 `FieldRow`（派生不落库；与属性区同一份形状，只少来源与顺序） */
function cellRow(block: Block, propId: string, def: Block | undefined): FieldRow {
  const value = block.props?.[propId]
  return {
    propId,
    label: def ? propLabel(def) || propId : propId,
    kind: def ? propKindOf(def) : 'text',
    value,
    filled: hasValue(block, propId),
    def,
    sources: [],
    order: 0,
  }
}
