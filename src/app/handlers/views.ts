/**
 * 视图命令的 handler：只做参数归一，然后交给 `App` 门面。
 *
 * ⚠️ 不许在这里碰 DOM（`arch-check [18]`）：切视图之后的重装、菜单的弹出都由门面落地。
 * ⚠️ 参数收成**拥有者**（`owner`），不是块 id：视图配置可以住在块上，也可以住在
 *    local tab 上 —— 「住哪」由拥有者回答，handler 不猜。
 */
import type { Handler } from '../../core/ports.ts'
import type { QuerySpec } from '../../core/query.ts'
import { ownerOrCur, S } from './shared.ts'

export const VIEW_CONFIG_HANDLERS: Record<string, Handler> = {
  'core.view/add': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    return app.addView(owner, S(a.kind, 'table')) !== ''
  },
  'core.view/set-active': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    return app.setActiveView(owner, S(a.viewId))
  },
  'core.view/remove': (a, app) => {
    const owner = ownerOrCur(a, app)
    const viewId = S(a.viewId)
    if (!owner || !viewId) return false
    return app.removeView(owner, viewId)
  },
  'core.view/rename': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    return app.renameActiveView(owner, S(a.name))
  },
  'core.view/set-sort': (a, app) => {
    const owner = ownerOrCur(a, app)
    const by = S(a.by)
    if (!owner || !by) return false
    return app.viewSetSort(owner, S(a.viewId), by, S(a.dir))
  },
  'core.view/new-row': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    return app.viewInsertRow(owner, S(a.blockId) || undefined)
  },
  'core.view/delete-row': (a, app) => {
    const rowId = S(a.rowId)
    if (!rowId) return false
    return app.viewDeleteRow(rowId)
  },
  /** 写条件（构建器／JSON 的落点）；只写条件，结果由各表面自己冻结 */
  'core.query/set-spec': (a, app) => {
    const owner = ownerOrCur(a, app)
    const spec = a.spec as QuerySpec | undefined
    if (!owner || !spec || typeof spec !== 'object' || !spec.where) return false
    return app.setQuerySpec(owner, spec)
  },
  /** 打开条件构建器（纯 UI 浮层，落在装配层） */
  'core.query/open-builder': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    app.openQueryBuilder(owner)
    return true
  },
  /** 新建查询页／页内查询块（内容对象） */
  'core.query/create': (a, app) => {
    const kind = S(a.kind, 'page')
    if (kind !== 'page' && kind !== 'block') return false
    const spec = (a.spec ?? { where: { any: [] } }) as QuerySpec
    const name = S(a.name)
    return app.createQuery(kind, name, spec, S(a.parentId) || undefined) !== ''
  },
  /**
   * 在当前块里建查询块（结构写交给门面），建完**当场打开构建器**：
   * 空条件的查询不配一下就没有意义，让用户再点一次等于多一道无收益的门。
   */
  'core.query/insert': (a, app) => {
    const id = app.insertQueryBlock(S(a.blockId) || undefined)
    if (id === '') return false
    app.openQueryBuilder({ kind: 'block', blockId: id })
    return true
  },
  'core.view/menu': (a, app) => {
    /**
     * 块菜单里这一条**不带参数**（绑定表是静态的，而菜单要的是「此刻聚焦的那一块」）。
     * 所以缺省退回光标所在块 —— 与「块菜单本来就是在给那一块做动作」同一条口径。
     */
    const owner = ownerOrCur(a, app)
    if (!owner) return false
    app.openViewMenu(owner)
    return true
  },
}
