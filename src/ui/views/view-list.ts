/**
 * **记录列表**（`ViewKind === 'list'`）：一行一条记录，标题 ＋ 若干字段。
 *
 * 与另外两种「像表」的东西分工写死：
 *
 * | 渲染器 | 行是什么 | 有缩进/折叠吗 |
 * |---|---|---|
 * | 大纲（`outline`） | 树 | 有（这是它的全部） |
 * | 结构映射表（`list-table`） | 位置元组（第 j 行＝每列各取第 j 项） | 没有（层级被摊成列） |
 * | **记录列表**（`list`） | **一条记录**（命中／子块） | 没有（它就是一条） |
 *
 * 为什么不给 `list` 加缩进：它的两种源里只有 children 是树，query 命中是**平的一批**。
 * 一份「有时缩进有时不缩进」的列表会让「这一行在谁的下面」变成一个不稳定的答案。
 */
import { TITLE_COLUMN, openPlaceOf, sortRecords, type BlockStore, type OpenPlace, type ViewConfig, type ViewRecord } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'

export interface ViewListDeps {
  store: BlockStore
  /** 记录（派生）：query＝冻结命中／children＝直接子块 */
  records: () => ViewRecord[]
  /** 当前视图（读 `list.fields` 与 `table.sort`） */
  view: () => ViewConfig | null
  /** 列的显示名（属性定义 id → 名字；由装配层给，`ui` 不扫森林） */
  fieldLabel: (id: string) => string
  /** 标题那一格的投影（run／引用／图片；与表格同一份口径） */
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  /** 某一列的值投影（与表格同一份口径） */
  project: (record: ViewRecord, key: string, into: HTMLElement) => void
  openBlock: (blockId: string, place?: OpenPlace) => void
}

/** 一条记录最多显示几个字段：再多就不是「看一眼」而是表格了 */
const MAX_FIELDS = 3

export class ViewList {
  readonly root: HTMLElement
  private readonly deps: ViewListDeps
  private readonly rowsEl: HTMLElement
  private readonly emptyEl: HTMLElement

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

    if (records.length === 0) {
      this.emptyEl.hidden = false
      this.emptyEl.textContent = t('ui.list.empty')
    } else {
      this.emptyEl.hidden = true
    }

    records.forEach((r) => {
      const row = document.createElement('div')
      row.className = 'vl-row'
      row.dataset.blockId = r.block.id

      // 行首：块标（点它＝打开那一块，与正文同一套手势）
      const bullet = document.createElement('button')
      bullet.type = 'button'
      bullet.className = 'vl-bullet'
      bullet.title = t('ui.list.open')
      bullet.addEventListener('click', (e) => this.deps.openBlock(r.block.id, openPlaceOf(e)))
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

      this.rowsEl.appendChild(row)
    })
  }
}

