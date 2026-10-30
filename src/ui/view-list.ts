/**
 * **记录列表**（`ViewKind === 'list'`）：一行一条记录，标题 ＋ 若干字段。
 *
 * 与另外两种「像表」的东西分工写死：
 *
 * | 渲染器 | 行是什么 | 有缩进/折叠吗 |
 * |---|---|---|
 * | 大纲（`outline`） | 树 | 有（这是它的全部） |
 * | 结构映射表（`list-table`） | 位置元组（第 j 行＝每列各取第 j 项） | 没有（层级被摊成列） |
 * | **记录列表**（`list`） | **一条记录**（命中／子块／`_items`） | 没有（它就是一条） |
 *
 * 为什么不给 `list` 加缩进：它的三种源里只有 children 是树，另外两种是**平的一批**。
 * 一份「有时缩进有时不缩进」的列表会让「这一行在谁的下面」变成一个不稳定的答案。
 *
 * items 源的三件事（加一行／删一行／拖一下）都只写 `_items`：**不删块**、不改父子。
 * 「收藏」是一批**引用**，不是一批被搬进来的东西。
 */
import { TITLE_COLUMN, sortRecords, type BlockStore, type ViewConfig, type ViewRecord } from '../core/index.ts'
import { t } from '../core/msg.ts'

export interface ViewListDeps {
  store: BlockStore
  /** 记录（派生）：query＝冻结命中／children＝直接子块／items＝`_items` */
  records: () => ViewRecord[]
  /** 当前视图（读 `list.fields` 与 `table.sort`） */
  view: () => ViewConfig | null
  /** 列的显示名（属性定义 id → 名字；由装配层给，`ui` 不扫森林） */
  fieldLabel: (id: string) => string
  /** 标题那一格的投影（run／引用／图片；与表格同一份口径） */
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  /** 某一列的值投影（与表格同一份口径） */
  project: (record: ViewRecord, key: string, into: HTMLElement) => void
  openBlock: (blockId: string) => void
  /** items 源才有：加一条引用（块选择器由装配层弹） */
  addItem?: (columnId: string) => void
  /** items 源才有：摘一条引用（**不删块**） */
  removeItem?: (blockId: string) => void
  /** items 源才有：拖序（`to` 是当前列表里的插入下标） */
  moveItem?: (blockId: string, to: number) => void
  /** 摘引用之后给一句提示（摘要要说清「N 条（M 条已删）」） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 一条记录最多显示几个字段：再多就不是「看一眼」而是表格了 */
const MAX_FIELDS = 3

export class ViewList {
  readonly root: HTMLElement
  private readonly deps: ViewListDeps
  private readonly rowsEl: HTMLElement
  private readonly emptyEl: HTMLElement
  /** 拖动中的那一行（只在 items 源里有意义） */
  private dragging = ''
  /** 拖动中那一行当时的**位置**（`moveCollectionItem` 的 `to` 按「原列表」的下标算） */
  private draggingAt = -1

  constructor(deps: ViewListDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vl'

    this.rowsEl = document.createElement('div')
    this.rowsEl.className = 'vl-rows'

    this.emptyEl = document.createElement('p')
    this.emptyEl.className = 'vl-empty'
    this.emptyEl.hidden = true

    this.root.append(this.rowsEl, this.emptyEl)
  }

  /** 列表没有订阅（外面换数据就整表重画）：留着这个方法是为了与其它渲染器同形 */
  dispose(): void {}

  /** 这一份视图要显示哪几个字段（跳掉标题：标题已经在行首了） */
  private fieldsOf(view: ViewConfig | null): string[] {
    const explicit = view?.list?.fields
    if (explicit && explicit.length > 0) return explicit.filter((k) => k !== TITLE_COLUMN).slice(0, MAX_FIELDS)
    return []
  }

  render(): void {
    const records = sortRecords(this.deps.records(), this.deps.view()?.table?.sort)
    const view = this.deps.view()
    const fields = this.fieldsOf(view)
    this.rowsEl.replaceChildren()

    const canEdit = this.deps.moveItem !== undefined
    if (records.length === 0) {
      this.emptyEl.hidden = false
      this.emptyEl.textContent = t('ui.list.empty')
    } else {
      this.emptyEl.hidden = true
    }

    records.forEach((r, index) => {
      const row = document.createElement('div')
      row.className = 'vl-row'
      row.dataset.blockId = r.block.id
      if (canEdit) row.draggable = true

      // 行首：块标（点它＝打开那一块，与正文同一套手势）
      const bullet = document.createElement('button')
      bullet.type = 'button'
      bullet.className = 'vl-bullet'
      bullet.title = t('ui.list.open')
      bullet.addEventListener('click', () => this.deps.openBlock(r.block.id))
      row.appendChild(bullet)

      const title = document.createElement('span')
      title.className = 'vl-title ui-ellipsis'
      this.deps.projectTitle(r, title)
      row.appendChild(title)

      for (const key of fields) {
        const cell = document.createElement('span')
        cell.className = 'vl-field ui-ellipsis'
        cell.dataset.key = key
        cell.title = this.deps.fieldLabel(key)
        this.deps.project(r, key, cell)
        row.appendChild(cell)
      }

      if (this.deps.removeItem) {
        const del = document.createElement('button')
        del.type = 'button'
        del.className = 'vl-x'
        del.textContent = '×'
        del.title = t('ui.list.unlink')
        del.addEventListener('click', (e) => {
          e.stopPropagation()
          this.deps.removeItem?.(r.block.id)
        })
        row.appendChild(del)
      }

      if (canEdit) {
        row.addEventListener('dragstart', (e) => {
          this.dragging = r.block.id
          this.draggingAt = index
          e.dataTransfer?.setData('text/plain', r.block.id)
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        })
        row.addEventListener('dragend', () => {
          this.dragging = ''
          this.draggingAt = -1
        })
        row.addEventListener('dragover', (e) => {
          if (this.dragging === '') return
          e.preventDefault()
          row.dataset.dropTarget = '1'
        })
        row.addEventListener('dragleave', () => {
          delete row.dataset.dropTarget
        })
        row.addEventListener('drop', (e) => {
          delete row.dataset.dropTarget
          if (this.dragging === '') return
          e.preventDefault()
          /**
           * 落在**第 `index` 行这一格**上 ⇒ 原列表里的落点是 `index`；
           * 往下拖时要越过被拖的那一行（它还在列表里占着位），所以 ＋1。
           * 这与 `moveCollectionItem` 的「先摘再插、往后拖自己减一」是同一套口径。
           */
          const to = index > this.draggingAt ? index + 1 : index
          const moved = this.dragging
          this.dragging = ''
          this.draggingAt = -1
          this.deps.moveItem?.(moved, to)
        })
      }

      this.rowsEl.appendChild(row)
    })

    if (this.deps.addItem) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'vl-add ui-btn ui-btn--quiet'
      add.textContent = t('ui.list.add')
      add.addEventListener('click', () => this.deps.addItem?.(''))
      this.rowsEl.appendChild(add)
    }
  }

  /** 一条记录在**别的**视图里消失时给一句实话（悬空引用不静默消失） */
  noteMissing(total: number, alive: number): void {
    if (total === alive) return
    this.deps.toast?.(t('ui.list.missing', { n: String(alive), gone: String(total - alive) }), 'info')
  }
}

