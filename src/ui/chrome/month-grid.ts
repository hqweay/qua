/**
 * **月网格原语**：月份游标 ＋ 翻月 ＋ 点月份回本月 ＋ 星期表头 ＋ 日子格子。
 *
 * 为什么抽出来：「一个月」这套拼装（游标、翻月、表头、今天标记、格子画法）
 * 同时是**日历卡**（导航：点格去那天）与**日期选择器**（选择：点格选那天）的身体。
 * 两者的差异只有两个真实的策略点，都留成参数，不留分叉：
 *
 *   · **月外的格子**：`blank`（占位不可点——导航卡画邻月日期会让「几号」靠位置猜，
 *     同一个月里出现两个「1」）｜ `dim`（灰显可点——选择器要让「跨月的那天」也能选，
 *     「引用下月 3 号」不该被月界挡住）；
 *   · **每格的额外标记**：`mark`（卡用它一次性标「哪几天写过」；每次重画都会重调，
 *     所以「存在哪些天」的读取也发生在重画那一刻——写完一天回来要能立刻看见）。
 *
 * 这一层不认 `kb`／`registry`：存不存在、点了去哪，都由调用方给（与 `card-parts` 同一口径）。
 * 月份的算术只有一份（`view-calendar` 的 `monthCells`／`shiftMonth`）。
 */
import { todayISO } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { monthCells, shiftMonth } from '../views/view-calendar.ts'
import { renderIcon } from '../../view/icons.ts'

export interface MonthGridOpts {
  /** 点某天（拿原始事件：卡要用修饰键算落点，选择器不需要） */
  onPick: (date: string, e: MouseEvent) => void
  outOfMonth: 'blank' | 'dim'
  /** 每格的读屏文案（两处动作不同：「打开这天的日记」／「选这一天」） */
  dayLabel: (date: string) => string
  /** 每次重画后追加的标记（一次拿到全部格子，调用方在这里一次性读「哪几天写过」） */
  mark?: (cells: ReadonlyMap<string, HTMLButtonElement>) => void
}

export interface MonthGrid {
  el: HTMLElement
  /** 重画（翻月内部自动调；库里的「写过」变了要跟上时由调用方调） */
  refresh: () => void
}

/** 本月格子集合：date → 格子（重画时重建；`mark` 与调用方都按它找格子） */
export function monthGrid(opts: MonthGridOpts): MonthGrid {
  const el = document.createElement('div')
  el.className = 'cal'

  /** 当前显示的月份（`YYYY-MM`；视图状态，不入库：翻月是本次查看的一部分，不是配置） */
  let cursor = todayISO().slice(0, 7)

  const head = document.createElement('div')
  head.className = 'cal-head'
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'dock-btn cal-nav'
  prev.title = t('ui.cal.prevMonth')
  prev.setAttribute('aria-label', t('ui.cal.prevMonth'))
  renderIcon(prev, 'lucide:chevron-left', 'chevron-left')
  const label = document.createElement('button')
  label.type = 'button'
  label.className = 'cal-label'
  label.addEventListener('click', () => {
    cursor = todayISO().slice(0, 7)
    paint()
  })
  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'dock-btn cal-nav'
  next.title = t('ui.cal.nextMonth')
  next.setAttribute('aria-label', t('ui.cal.nextMonth'))
  renderIcon(next, 'lucide:chevron-right', 'chevron-right')
  head.append(prev, label, next)
  el.appendChild(head)

  const grid = document.createElement('div')
  grid.className = 'cal-grid'
  el.appendChild(grid)

  const paint = (): void => {
    const [y, m] = cursor.split('-').map(Number)
    label.textContent = t('ui.cal.monthLabel', { y: String(y), m: String(m) })
    label.title = t('ui.cal.thisMonth')
    label.setAttribute('aria-label', t('ui.cal.thisMonth'))
    grid.replaceChildren()

    // 表头：周一起始
    for (const w of t('ui.cal.weekdays').split(',')) {
      const cell = document.createElement('span')
      cell.className = 'cal-week'
      cell.textContent = w
      grid.appendChild(cell)
    }

    const today = todayISO()
    const cells = new Map<string, HTMLButtonElement>()
    for (const week of monthCells(cursor)) {
      for (const date of week) {
        const out = date.slice(0, 7) !== cursor
        if (out && opts.outOfMonth === 'blank') {
          // 月外的空格：不可点、不画数字（它只是占位，让 1 号落在正确的星期几）
          const pad = document.createElement('span')
          pad.className = 'cal-cell cal-pad'
          grid.appendChild(pad)
          continue
        }
        const cell = document.createElement('button')
        cell.type = 'button'
        cell.className = 'cal-cell'
        cell.dataset.date = date
        if (date === today) cell.dataset.today = '1'
        if (out) cell.dataset.out = '1'
        cell.title = date
        cell.setAttribute('aria-label', opts.dayLabel(date))
        const num = document.createElement('span')
        num.className = 'cal-day'
        num.textContent = String(Number(date.slice(8, 10)))
        cell.appendChild(num)
        cell.addEventListener('click', (e) => opts.onPick(date, e))
        cells.set(date, cell)
        grid.appendChild(cell)
      }
    }
    opts.mark?.(cells)
  }

  prev.addEventListener('click', () => {
    cursor = shiftMonth(cursor, -1)
    paint()
  })
  next.addEventListener('click', () => {
    cursor = shiftMonth(cursor, 1)
    paint()
  })

  paint()

  return { el, refresh: paint }
}
