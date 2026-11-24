/**
 * 页 handler：新建 / 打开 / 上下一个 / 改名 / 删除。
 *
 * 页与日记分开成两个文件：它们共用「换当前对象」这条能力，但判据不同——
 * 页是枚举与环绕，日记是日期算术。混在一起，两套判据会互相冒充。
 */
import type { Handler } from '../../core/infra/ports.ts'
import { S } from './shared.ts'

export const PAGE_HANDLERS: Record<string, Handler> = {
  /* ---- 页面 ---- */
  /**
   * **用户面的「新建页」＝先问名字**：页的名字就是它的地址，先造一个未命名页再改名，
   * 等于先占一个假地址再换人；中途取消，那个页还会漏在库里。
   * 建页本身是 `core.page/create`（名字与页同一笔），`@` 建页与它是同一个构造。
   */
  'core.page/new': (_a, app) => {
    app.openPagePicker()
    return true
  },
  'core.page/create': (a, app) => {
    const name = S(a.name)
    // 带名字 ⇒ 按名字落页（同名地址在场就复用它并补 `page` 露面）；不带 ⇒ 未命名页
    if (name === '') app.newPage()
    else app.openOrCreatePage(name)
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
  // ⚠️ 命令不知道 UI：这里**只表达意图**，焦点/选区由装配层的 `app.focusTitle` 负责。
  //    「handler 越界碰 DOM」就是这里——`scripts/arch-check.mjs` 的 [18] 现在会拦它。
  'core.page/rename': (_a, app) => {
    app.focusTitle()
    return true
  },
}
