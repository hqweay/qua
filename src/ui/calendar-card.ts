/**
 * **日历卡**：一个月一屏，点一格就去那天写日记。
 *
 * 为什么它是一张卡而不是一个「日历页」：日历是**导航**，不是内容——
 * 它回答「哪天写过、怎么去那天」，而不承载任何一块数据。
 * 造一个「日历页」等于造第二种实体，而「一切皆块」里没有它的位置。
 *
 * 三条判据（都来自它要回答的问题）：
 *   ① **一屏一个月**，不滚动翻月：翻月是显式动作（← →），不是滚出来的。
 *      滚动翻月会让「现在看的是哪个月」取决于滚到哪，而那是**不可读**的状态。
 *   ② **有内容的日期要看得见**：日历的用处一半是「这天写过」，只画数字等于没用。
 *      判据是索引里的 `journals` 表（与 `journalDay` 同源），不是遍历森林。
 *   ③ **点一格 ＝ 去那天**（`core.journal/today` 带 `date`）。走命令面而不是
 *      在这里直接物化：物化要进事务、要产 op、要让索引跟上——三条只有一处入口。
 *
 * ⚠️ 这一层不认 `registry`／`ws`：能力由 `CalendarDeps` 收进来（与 `dock-content` 同一口径）。
 */
import { todayISO } from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { renderIcon } from '../view/icons.ts'
import type { DockCard } from './dock.ts'

export interface CalendarDeps {
  /** 读门面：只用来问「库里存在哪几天」 */
  kb: KbClient
  /** 去某一天（`YYYY-MM-DD`）。由装配层接到 `core.journal/today` 的 `date` 参数 */
  openDate: (date: string) => void
}

/**
 * 某个月的网格。
 *
 * 口径：**周一起始**（中文日历的惯例），一格一天，月外的格子留空而不是画邻月日期——
 * 画邻月会让「这一格是几号」需要靠位置猜（同一个月里出现两个「1」）。
 *
 * @param month `YYYY-MM`；`null` ＝ 跟着「今天」所在的那一个月
 */
function monthOf(date: string): { y: number; m: number } {
  const [y, m] = date.split('-').map(Number)
  return { y: y ?? 1970, m: m ?? 1 }
}

/** `YYYY-MM` → 这个月有几天 */
function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate()
}

/** 这一天是周几（**0 ＝ 周一**，与本仓日历的起始一致） */
function weekdayIndex(y: number, m: number, d: number): number {
  const jsDay = new Date(y, m - 1, d).getDay() // 0 ＝ 周日
  return (jsDay + 6) % 7
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 这一格的日期串（与 `journalDate` 同一种形状） */
function isoOf(y: number, m: number, d: number): string {
  return `${String(y)}-${pad2(m)}-${pad2(d)}`
}

export function calendarCard(deps: CalendarDeps): DockCard {
  const body = document.createElement('div')
  body.className = 'cal'

  /** 当前显示的月份（视图状态，不入库：翻月是本次查看的一部分，不是配置） */
  let cursor = todayISO()

  const head = document.createElement('div')
  head.className = 'cal-head'
  const prev = document.createElement('button')
  prev.type = 'button'
  prev.className = 'dock-btn cal-nav'
  prev.title = t('ui.cal.prevMonth')
  prev.setAttribute('aria-label', t('ui.cal.prevMonth'))
  renderIcon(prev, 'lucide:chevron-left', 'chevron-left')
  const label = document.createElement('span')
  label.className = 'cal-label'
  const next = document.createElement('button')
  next.type = 'button'
  next.className = 'dock-btn cal-nav'
  next.title = t('ui.cal.nextMonth')
  next.setAttribute('aria-label', t('ui.cal.nextMonth'))
  renderIcon(next, 'lucide:chevron-right', 'chevron-right')
  head.append(prev, label, next)
  body.appendChild(head)

  const grid = document.createElement('div')
  grid.className = 'cal-grid'
  body.appendChild(grid)

  /**
   * 画这个月。
   *
   * ⚠️ 每次重画都重新读一次「哪几天存在」：写完一天之后日历要能立刻标出来，
   *    而它没有自己的 change 订阅（卡不是编辑器）。
   */
  const paint = (): void => {
    const { y, m } = monthOf(cursor)
    label.textContent = t('ui.cal.monthLabel', { y: String(y), m: String(m) })
    grid.replaceChildren()

    // 表头：周一起始
    for (const w of t('ui.cal.weekdays').split(',')) {
      const cell = document.createElement('span')
      cell.className = 'cal-week'
      cell.textContent = w
      grid.appendChild(cell)
    }

    const today = todayISO()
    const written = new Set(deps.kb.journalDates())
    const first = weekdayIndex(y, m, 1)
    const total = daysInMonth(y, m)

    // 月外的格子留空（不画邻月日期：那会让「几号」要靠位置猜）
    for (let i = 0; i < first; i++) {
      const pad = document.createElement('span')
      pad.className = 'cal-cell cal-pad'
      grid.appendChild(pad)
    }

    for (let d = 1; d <= total; d++) {
      const date = isoOf(y, m, d)
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'cal-cell'
      cell.dataset.date = date
      if (date === today) cell.dataset.today = '1'
      if (written.has(date)) cell.dataset.written = '1'
      cell.title = t(written.has(date) ? 'ui.cal.openWritten' : 'ui.cal.openBlank')
      cell.setAttribute('aria-label', t('ui.cal.dayLabel', { date }))

      const num = document.createElement('span')
      num.className = 'cal-day'
      num.textContent = String(d)
      cell.appendChild(num)

      // 有内容：一颗小点。只画数字等于「这天写过」看不出来，而那是日历一半的用处
      if (written.has(date)) {
        const dot = document.createElement('span')
        dot.className = 'cal-dot'
        cell.appendChild(dot)
      }

      cell.addEventListener('click', () => deps.openDate(date))
      grid.appendChild(cell)
    }
  }

  prev.addEventListener('click', () => {
    const { y, m } = monthOf(cursor)
    const at = new Date(y, m - 1, 1)
    at.setMonth(at.getMonth() - 1)
    cursor = isoOf(at.getFullYear(), at.getMonth() + 1, 1)
    paint()
  })
  next.addEventListener('click', () => {
    const { y, m } = monthOf(cursor)
    const at = new Date(y, m - 1, 1)
    at.setMonth(at.getMonth() + 1)
    cursor = isoOf(at.getFullYear(), at.getMonth() + 1, 1)
    paint()
  })

  paint()

  /**
   * 卡头动作：**回本月**（翻远了之后回到今天那一月）。
   *
   * 它是这颗「回到起点」的唯一入口：日历没有「关闭」，翻月又没有边界，
   * 没有它就得靠记得今天是几月。
   */
  const actions: DockCard['actions'] = [
    {
      label: 'lucide:calendar',
      title: t('ui.cal.thisMonth'),
      onClick: () => {
        cursor = todayISO()
        paint()
      },
    },
  ]

  return { id: 'calendar', title: t('ui.cal.title'), body, actions }
}
