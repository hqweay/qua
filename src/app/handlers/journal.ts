/**
 * 日记 handler：回今日 / 翻日 / 删除当前日记。
 *
 * 「今日是落点，不是特例代码路径」——这里不给今天写任何分支，
 * 形态差异全部由门面里的 `journalToday` / `journalShift` 决定。
 */
import type { Handler } from '../../core/ports.ts'

export const JOURNAL_HANDLERS: Record<string, Handler> = {
  /* ---- 日记 ---- */
  'core.journal/today': (a, app) => {
    app.journalToday(typeof a.date === 'string' ? a.date : undefined)
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
  'core.page/delete': (_a, app) => {
    app.deletePage(app.activePageId())
    return true
  },
}
