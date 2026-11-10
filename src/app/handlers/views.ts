/**
 * 视图命令的 handler：只做参数归一，然后交给 `App` 门面。
 *
 * ⚠️ 不许在这里碰 DOM（`arch-check [18]`）：切视图之后的重装、菜单的弹出都由门面落地。
 * ⚠️ 参数收成**拥有者**（`owner`），不是块 id：视图配置可以住在块上，也可以住在
 *    local tab 上 —— 「住哪」由拥有者回答，handler 不猜。
 */
import type { Handler } from '../../core/infra/ports.ts'
import { isQueryNode, type QueryNode, type QuerySpec } from '../../core/query/query.ts'
import { curBlock, ownerOrCur, S } from './shared.ts'

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
  /** 表格的整份列清单（列管理）：形状校验在命令层（`columnsOfRaw`），这里只接参数 */
  'core.view/set-columns': (a, app) => {
    const owner = ownerOrCur(a, app)
    if (!owner || !Array.isArray(a.columns)) return false
    return app.viewSetColumns(owner, S(a.viewId), a.columns)
  },
  /** 写卡片封面；只认卡片视图（别的 kind 会被 canonicalViews 丢掉） */
  'core.view/set-cover': (a, app) => {
    const owner = ownerOrCur(a, app)
    const viewId = S(a.viewId)
    const cover = S(a.cover)
    if (!owner || !viewId) return false
    if (cover !== 'first-asset' && cover !== 'none') return false
    return app.viewSetCover(owner, viewId, cover)
  },
  /** 页签方向：横向／纵向（只认这两档；是不是页签视图由命令层判） */
  'core.view/set-tabs-direction': (a, app) => {
    const owner = ownerOrCur(a, app)
    const viewId = S(a.viewId)
    const direction = S(a.direction)
    if (!owner || !viewId) return false
    if (direction !== 'horizontal' && direction !== 'vertical') return false
    return app.viewSetTabsDirection(owner, viewId, direction)
  },
  /**
   * 写分组键；`groupBy:''` ＝ 清掉（与 set-sort 的空串清掉同一约定）。
   *
   * `structure:true` ＝ 按一级子块分组（组＝容器的直接子块）；它与按值分组互斥，
   * 命令层只传一个来源，清另一份是 `withGroup`／`withStructureGroup` 的事。
   */
  'core.view/set-group': (a, app) => {
    const owner = ownerOrCur(a, app)
    const viewId = S(a.viewId)
    if (!owner || !viewId) return false
    const groupBy = S(a.groupBy)
    const rawOrder = a.groupOrder
    const groupOrder = Array.isArray(rawOrder) ? rawOrder.map((g) => S(g)).filter((g) => g !== '') : undefined
    return app.viewSetGroup(owner, viewId, groupBy, groupOrder, a.structure === true)
  },
  /** 写一张视图的切片；显式 `null` ＝ 清掉，缺参 ＝ 拒绝（不能把「没传」当成清空） */
  'core.view/set-filter': (a, app) => {
    const owner = ownerOrCur(a, app)
    /**
     * `viewId === ''` 是**默认看法（大纲）的切片**（拥有者的 `_defaultFilter`）——
     * 新建查询块还没有命名视图，这是它唯一能落脚的地方。所以「空串」是合法值，
     * 只有**没传**这一格才拒绝（写必须说清是哪一张视图的镜头）。
     */
    const viewId = a.viewId
    if (!owner || typeof viewId !== 'string') return false
    const raw = a.filter
    if (raw === undefined) return false
    if (raw !== null && !isQueryNode(raw)) return false
    return app.setViewFilter(owner, viewId, raw as QueryNode | null)
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
  /** 新建查询块（内容对象） */
  'core.query/create': (a, app) => {
    const spec = (a.spec ?? { where: { any: [] } }) as QuerySpec
    const name = S(a.name)
    return app.createQuery(name, spec, S(a.parentId) || undefined) !== ''
  },
  /**
   * 在当前块里建查询块（结构写交给门面）。新块当场出现条件条——
   * 内联体默认收起条件树（不撑爆结果区），点那一条就地在抬头下展开。
   */
  'core.query/insert': (a, app) => {
    const id = app.insertQueryBlock(S(a.blockId) || undefined)
    if (id === '') return false
    return true
  },
  /**
   * 斜杠「插入看法」，两段式（与 `core.embed/insert` 同款）：
   * 不带 `kind` ⇒ 开看法选择器；带 `kind` ⇒ 建一个预配看法的容器块。
   * 落点与其它插块命令同一条判据（收在编辑器的 `insertViewAfter`）。
   */
  'core.view/insert': (a, app) => {
    const at = S(a.blockId) || curBlock(app)
    if (!at) return false
    const kind = S(a.kind)
    if (!kind) {
      app.showViewPicker(at)
      return true
    }
    return app.insertViewBlock(at, kind) !== ''
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
