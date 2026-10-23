/**
 * 页 handler：新建 / 打开 / 上下一个 / 改名 / 删除。
 *
 * 页与日记分开成两个文件：它们共用「换当前对象」这条能力，但判据不同——
 * 页是枚举与环绕，日记是日期算术。混在一起，两套判据会互相冒充。
 */
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

export const PAGE_HANDLERS: Record<string, Handler> = {
  /* ---- 页面 ---- */
  'core.page/new': (_a, app) => {
    app.newPage()
    return true
  },
  'core.page/open': (a, app) => {
    const id = S(a.pageId)
    if (!id) return false
    app.openPage(id)
    return true
  },
  'core.page/next': (_a, app) => {
    const pages = app.listPages()
    const i = pages.findIndex((p) => p.id === app.activePageId())
    const next = pages[(i + 1) % pages.length]
    if (!next) return false
    app.openPage(next.id)
    return true
  },
  'core.page/prev': (_a, app) => {
    const pages = app.listPages()
    const i = pages.findIndex((p) => p.id === app.activePageId())
    const prev = pages[(i - 1 + pages.length) % pages.length]
    if (!prev) return false
    app.openPage(prev.id)
    return true
  },
  // ⚠️ 命令不知道 UI（59 ）：这里**只表达意图**，焦点/选区由装配层的 `app.focusTitle` 负责。
  //    底座轮记的「handler 越界碰 DOM」就是这里——`scripts/arch-check.mjs` 的 §17 现在会拦它。
  'core.page/rename': (_a, app) => {
    app.focusTitle()
    return true
  },
}
