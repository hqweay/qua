/**
 * **日历**：按某一列的日期把记录落进月网格。
 *
 * 三条判据：
 *   · **一天一格，不是一条一卡**：同一天的多条挤在格子里并显示「还有 N 条」——
 *     日历回答的是「这一段时间里有什么」，不是「逐条列一遍」。
 *   · **今天有描边**：在一个没有「当前」的网格里，用户第一眼要找的就是今天。
 *   · **没有日期的条目仍然列出来**：藏起来等于告诉用户「这些不存在」。
 *     它们在网格下方一列（`showUndated`），而「有日期但不在这个月」的条目完全不画
 *     —— 那是「翻到那个月」的事，不是「这一格装不下」。
 */
import {
  belowFieldsFor,
  blockLabel,
  constrainBelowFields,
  displayRowPropIds,
  isJournalDate,
  openActionOf,
  sortRecords,
  todayISO,
  type BelowFields,
  type Block,
  type BlockStore,
  type OpenAction,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { fieldRowText } from '../block-ui/props-line.ts'
import { viewNote } from './view-note.ts'

export interface ViewCalendarDeps {
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 今天（本地日 `YYYY-MM-DD`）；由装配层给，测试与截图才钉得住 */
  today: () => string
  /** `ref` 值的显示名（显式 displayProps 时，日格里的属性值要翻名字） */
  refLabel: (targetId: string) => string
}

const WEEK = 7

export class ViewCalendar {
  readonly root: HTMLElement
  private readonly deps: ViewCalendarDeps
  /** 当前显示的月份（`YYYY-MM`）；首次渲染落在「今天」那个月 */
  private month = ''

  constructor(deps: ViewCalendarDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vc'
  }

  dispose(): void {}

  render(): void {
    const view = this.deps.view()
    const key = view?.calendar?.dateBy ?? ''
    this.root.replaceChildren()
    if (key === '') {
      this.root.appendChild(viewNote(t('ui.calendar.needsDate')))
      return
    }

    const today = this.deps.today()
    if (this.month === '') this.month = today.slice(0, 7)
    const records = sortRecords(this.deps.records(), view?.sort)
    const below = this.propsOf(view, records)

    /** 按日期分格；没有日期的单独一列（不静默消失） */
    const byDay = new Map<string, ViewRecord[]>()
    const undated: ViewRecord[] = []
    for (const r of records) {
      const date = dateOf(r, key)
      if (date === '') {
        undated.push(r)
        continue
      }
      const list = byDay.get(date)
      if (list) list.push(r)
      else byDay.set(date, [r])
    }

    const head = document.createElement('div')
    head.className = 'vc-head'
    const prev = document.createElement('button')
    prev.type = 'button'
    prev.className = 'vc-nav'
    prev.textContent = '‹'
    prev.dataset.tip = t('ui.calendar.prev')
    prev.addEventListener('click', () => {
      this.month = shiftMonth(this.month, -1)
      this.render()
    })
    const title = document.createElement('span')
    title.className = 'vc-title'
    title.textContent = this.month
    const next = document.createElement('button')
    next.type = 'button'
    next.className = 'vc-nav'
    next.textContent = '›'
    next.dataset.tip = t('ui.calendar.next')
    next.addEventListener('click', () => {
      this.month = shiftMonth(this.month, 1)
      this.render()
    })
    head.append(prev, title, next)
    this.root.appendChild(head)

    const grid = document.createElement('div')
    grid.className = 'vc-grid'
    for (const cells of monthCells(this.month)) {
      for (const cell of cells) {
        const box = document.createElement('div')
        box.className = 'vc-day'
        box.dataset.date = cell
        if (!cell.startsWith(this.month)) box.dataset.other = '1'
        if (cell === today) box.dataset.today = '1'
        const num = document.createElement('span')
        num.className = 'vc-day-num'
        num.textContent = String(Number(cell.slice(8, 10)))
        box.appendChild(num)

        const dayRows = byDay.get(cell) ?? []
        dayRows.slice(0, 3).forEach((r) => {
          box.appendChild(this.itemChip(r, below))
        })
        if (dayRows.length > 3) {
          const more = document.createElement('span')
          more.className = 'vc-more'
          more.textContent = t('ui.calendar.more', { n: String(dayRows.length - 3) })
          box.appendChild(more)
        }
        grid.appendChild(box)
      }
    }
    this.root.appendChild(grid)

    if (undated.length > 0 && view?.calendar?.showUndated !== false) {
      const box = document.createElement('div')
      box.className = 'vc-undated'
      const label = document.createElement('div')
      label.className = 'vc-undated-title'
      label.textContent = t('ui.calendar.undated')
      box.appendChild(label)
      for (const r of undated) box.appendChild(this.itemChip(r, below))
      this.root.appendChild(box)
    }
  }

  /**
   * 日格里的**属性行**：只有显式 `displayProps` 才加——缺省是只标题（日格是紧凑面）。
   *
   * 与卡片同一份口径：白名单在场＝唯一权威（行集与待填计数一起收窄）；
   * 日历没有块标与 gutter ⇒ 归 `block-left` 的属性并进这一行（否则勾了看不见）。
   */
  private propsOf(view: ViewConfig | null, records: readonly ViewRecord[]): ReadonlyMap<string, BelowFields> {
    const allowed = displayRowPropIds(view?.displayProps)
    if (allowed === undefined) return new Map()
    const parentOf = (id: string): Block | null => {
      const pid = this.deps.store.index.parentOf.get(id) ?? null
      return pid ? (this.deps.store.find(pid) ?? null) : null
    }
    const below = belowFieldsFor(
      records.map((r) => r.block),
      this.deps.store.blocks,
      parentOf,
      this.deps.store.index.blocks,
      { wanted: allowed, includeGutter: true },
    )
    return constrainBelowFields(below, allowed)
  }

  /**
   * 一条记录在日格里的样子：标题 ＋（显式白名单时）一行属性。
   *
   * 属性行是**一行省略文本**而不是块下属性行的控件：日格只有一格宽，
   * 点它仍然是打开这一块（读值，不在日历里改值）。
   */
  private itemChip(r: ViewRecord, below: ReadonlyMap<string, BelowFields>): HTMLButtonElement {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'vc-item'
    chip.dataset.blockId = r.block.id
    const title = blockLabel(r.block, (id) => this.deps.store.find(id))
    const titleEl = document.createElement('span')
    titleEl.className = 'vc-item-title ui-ellipsis'
    titleEl.textContent = title
    chip.appendChild(titleEl)
    const rows = below.get(r.block.id)?.rows ?? []
    if (rows.length > 0) {
      const props = document.createElement('span')
      props.className = 'vc-item-props ui-ellipsis'
      props.textContent = rows.map((row) => `${row.label} ${fieldRowText(row, this.deps.refLabel)}`).join(' · ')
      chip.appendChild(props)
      chip.dataset.tip = `${title}\n${props.textContent}`
    }
    chip.addEventListener('click', (e) => this.deps.openBlock(r.block.id, openActionOf(e)))
    return chip
  }
}

/** 这一条落在哪一天（`YYYY-MM-DD`）；没有／不是日期形状 ⇒ 空串 */
export function dateOf(r: ViewRecord, key: string): string {
  const v = key === '_date' ? r.block.props?._date : r.values[key]
  if (typeof v !== 'string') return ''
  const s = v.slice(0, 10)
  return isJournalDate(s) ? s : ''
}

/** 一个月的格子（含前后补白，六行封顶）：`YYYY-MM` → 周 × 7 个 `YYYY-MM-DD` */
export function monthCells(month: string): string[][] {
  const [y, m] = month.split('-').map(Number)
  if (!y || !m) return []
  const first = new Date(y, m - 1, 1)
  // 周一开头（中文日历的习惯）：`getDay()` 的 0 是周日
  const lead = (first.getDay() + 6) % WEEK
  const start = new Date(y, m - 1, 1 - lead)
  const out: string[][] = []
  for (let w = 0; w < 6; w++) {
    const row: string[] = []
    for (let d = 0; d < WEEK; d++) {
      const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * WEEK + d)
      row.push(todayISO(cur))
    }
    out.push(row)
  }
  return out
}

/** `YYYY-MM` ± delta 个月（月网格的游标移动只有这一份） */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y!, (m ?? 1) - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
