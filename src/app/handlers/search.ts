/**
 * 全文检索的入口（⌘P）。它只表达「要搜索」，浮层与异步结果都在装配层。
 */
import type { Handler } from '../../core/infra/ports.ts'

export const SEARCH_HANDLERS: Record<string, Handler> = {
  'core.search/open': (_a, app) => {
    app.openSearch()
    return true
  },
}
