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
import { sortRecords, type BlockStore, type ViewConfig, type ViewRecord } from '../core/index.ts'
import { t } from '../core/msg.ts'

export interface ViewCalendarDeps {
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string) => void
  /** 今天（本地日 `YYYY-MM-DD`）；由装配层给，测试与截图才钉得住 */
  today: () => string
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
      const hint = document.createElement('p')
      hint.className = 'tv-unsupported'
      hint.textContent = t('ui.calendar.needsDate')
      this.root.appendChild(hint)
      return
    }

    const today = this.deps.today()
    if (this.month === '') this.month = today.slice(0, 7)
    const records = sortRecords(this.deps.records(), view?.table?.sort)

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
    prev.title = t('ui.calendar.prev')
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
    next.title = t('ui.calendar.next')
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
          const chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'vc-item ui-ellipsis'
          chip.dataset.blockId = r.block.id
          chip.textContent = r.title || t('ui.page.untitled')
          chip.addEventListener('click', () => this.deps.openBlock(r.block.id))
          box.appendChild(chip)
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
      for (const r of undated) {
        const chip = document.createElement('button')
        chip.type = 'button'
        chip.className = 'vc-item ui-ellipsis'
        chip.dataset.blockId = r.block.id
        chip.textContent = r.title || t('ui.page.untitled')
        chip.addEventListener('click', () => this.deps.openBlock(r.block.id))
        box.appendChild(chip)
      }
      this.root.appendChild(box)
    }
  }
}

/** 这一条落在哪一天（`YYYY-MM-DD`）；没有／不是日期形状 ⇒ 空串 */
export function dateOf(r: ViewRecord, key: string): string {
  const v = key === '_date' ? r.block.props?._date : r.values[key]
  if (typeof v !== 'string') return ''
  const s = v.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
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
      row.push(isoOf(cur))
    }
    out.push(row)
  }
  return out
}

function isoOf(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y!, (m ?? 1) - 1 + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
