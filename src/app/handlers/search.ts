/**
 * 全文检索的入口（⌘K）。它只表达「要搜索」，浮层与异步结果都在装配层。
 *
 * `place` ＝ 修饰键带来的**落点**（与块打开的 `openActionOf` 同一套语言）：
 * 缺省／`center` ＝ ⌘K 浮层；`dock` ＝ 搜索卡住进右槽；`tab` ＝ 中心 tab；
 * `tabWide` ＝ 同一张 tab ＋ 一次性宽屏。
 * 只回答「去哪」，不回答「搜什么」——三种挂载是同一份 `SearchFace`。
 */
import type { Handler } from '../../core/infra/ports.ts'

export const SEARCH_HANDLERS: Record<string, Handler> = {
  'core.search/open': (a, app) => {
    const raw = a.place
    const place = raw === 'dock' || raw === 'tab' || raw === 'tabWide' ? raw : undefined
    app.openSearch(place)
    return true
  },
}
