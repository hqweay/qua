/**
 * **日期选择器**（斜杠菜单「日期」的落点）：一个月网格 ＋ 「今日」按钮。
 *
 * 为什么是一个浮层而不是一张卡：它回答「**选哪一天**」，是一次性的任务面——
 * 选完即走，不常驻。日历卡回答的是「哪天写过、怎么去」（导航，常驻）。
 * 两者共用同一个月网格原语（`chrome/month-grid`），差异只剩策略参数：
 * 选择器的月外格子**灰显可点**（「引用下月 3 号」不该被月界挡住）。
 *
 * 点格/点「今日」都只回调 `onPick(date)`：**物化与插引用不在这里**——
 * 那是命令路径的事（`core.editor/insert-date-ref` 带日期），选择器只回答日期。
 */
import { todayISO } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { monthGrid } from '../chrome/month-grid.ts'

export interface DatePickerOpts {
  /** 选中某一天（`YYYY-MM-DD`）。一次选择关一次浮层，由调用方负责关 */
  onPick: (date: string) => void
}

export function datePicker(opts: DatePickerOpts): HTMLElement {
  const root = document.createElement('div')
  root.className = 'cal datepick'

  root.appendChild(
    monthGrid({
      outOfMonth: 'dim',
      onPick: (date) => opts.onPick(date),
      dayLabel: (date) => t('ui.datepick.dayLabel', { date }),
    }).el,
  )

  const foot = document.createElement('div')
  foot.className = 'datepick-foot'
  const today = document.createElement('button')
  today.type = 'button'
  today.className = 'datepick-today'
  today.textContent = t('ui.datepick.today')
  today.addEventListener('click', () => opts.onPick(todayISO()))
  foot.appendChild(today)
  root.appendChild(foot)

  return root
}
