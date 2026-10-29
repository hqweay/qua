/**
 * 视图命令的 handler：只做参数归一，然后交给 `App` 门面。
 *
 * ⚠️ 不许在这里碰 DOM（`arch-check [18]`）：切视图之后的重装、菜单的弹出都由门面落地。
 */
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

export const VIEW_CONFIG_HANDLERS: Record<string, Handler> = {
  'core.view/add': (a, app) => {
    const blockId = S(a.blockId)
    const kind = S(a.kind, 'table')
    if (!blockId || !kind) return false
    return app.addView(blockId, kind) !== ''
  },
  'core.view/set-active': (a, app) => {
    const blockId = S(a.blockId)
    if (!blockId) return false
    return app.setActiveView(blockId, S(a.viewId))
  },
  'core.view/remove': (a, app) => {
    const blockId = S(a.blockId)
    const viewId = S(a.viewId)
    if (!blockId || !viewId) return false
    return app.removeView(blockId, viewId)
  },
  'core.view/rename': (a, app) => {
    const blockId = S(a.blockId)
    if (!blockId) return false
    return app.renameActiveView(blockId, S(a.name))
  },
  'core.view/set-sort': (a, app) => {
    const blockId = S(a.blockId)
    const by = S(a.by)
    if (!blockId || !by) return false
    return app.viewSetSort(blockId, by, S(a.dir))
  },
  'core.view/new-row': (a, app) => {
    const blockId = S(a.blockId)
    if (!blockId) return false
    return app.viewInsertRow(blockId)
  },
  'core.view/delete-row': (a, app) => {
    const rowId = S(a.rowId)
    if (!rowId) return false
    return app.viewDeleteRow(rowId)
  },
  'core.view/menu': (a, app) => {
    /**
     * 块菜单里这一条**不带参数**（绑定表是静态的，而菜单要的是「此刻聚焦的那一块」）。
     * 所以缺省退回光标所在块 —— 与「块菜单本来就是在给那一块做动作」同一条口径。
     */
    const blockId = S(a.blockId) || app.ed.sel?.aBlock || ''
    if (!blockId) return false
    app.openViewMenu(blockId)
    return true
  },
}
