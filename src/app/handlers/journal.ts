/**
 * 日记 handler：回今日 / 翻日 / 打开某一天。
 *
 * 「删除这一天」不在这里：删除只有一条命令（`core.block/delete`），
 * 日记只是它的一个落点形态。
 *
 * 「今日是落点，不是特例代码路径」——这里不给今天写任何分支，
 * 形态差异全部由门面里的 `journalToday` / `journalShift` 决定。
 */
import type { Handler } from '../../core/infra/ports.ts'
import { openAxisOf } from '../../core/index.ts'

export const JOURNAL_HANDLERS: Record<string, Handler> = {
  /* ---- 日记 ---- */
  'core.journal/today': (a, app) => {
    app.journalToday(typeof a.date === 'string' ? a.date : undefined)
    return true
  },
  /**
   * 打开某一天（日历 / 复盘空天格子）。`place` 缺省中心——与点日期同义。
   * ⚠️ 物化在 `openJournal` 里（`ensure` 只有那一处），handler 只校验日期形状。
   */
  'core.journal/open': (a, app) => {
    const date = typeof a.date === 'string' ? a.date : ''
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return false
    const place =
      a.place === 'tabWide' ? 'tabWide' : a.place === 'dock' ? 'dock' : a.place === 'tab' ? 'tab' : a.place === 'inspect' ? 'inspect' : 'center'
    app.openJournal(date, place)
    // 一次性进档：档位仍住窗口（窗口任务态），只是这次打开顺手把空间给足
    const axis = openAxisOf(place)
    if (axis) app.axisTo(axis)
    return true
  },
  'core.journal/prev': (_a, app) => {
    app.journalShift(-1)
    return true
  },
  'core.journal/next': (_a, app) => {
    app.journalShift(1)
    return true
  },
  'core.journal/review': (a, app) => {
    app.journalReview(typeof a.days === 'number' ? a.days : 3)
    return true
  },
  'core.journal/feed-layout': (a, app) => {
    app.journalFeedLayout(a.layout === 'row' ? 'row' : 'column')
    return true
  },
}
