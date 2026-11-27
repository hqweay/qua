/**
 * 引述类型（`_callout` 的值域）的 handler：一个块写值与类型表本身的编辑。
 *
 * 「类型存在且未删」的闸只在这里：值域开放之后，值层不再能靠封闭集防拼错，
 * 拼错若静默回落成缺省类型，用户看到的会是「选了默认」而不是「这个类型没了」。
 * 读侧仍宽容（未知 id 按缺省画、不静默改盘）——两道门槛加在一起，
 * 既不把旧数据判死，也不让新写入口落进一个不存在的类型。
 */
import { liveCalloutTypeOf } from '../../core/index.ts'
import { calloutTypesIn, findCalloutTypesBlock } from '../../core/kb/ensure-callout-types.ts'
import { t } from '../../core/infra/msg.ts'
import type { Handler } from '../../core/infra/ports.ts'
import { curBlock, S, targetBlock } from './shared.ts'

export const CALLOUT_HANDLERS: Record<string, Handler> = {
  /**
   * 设这一块引述的类型（`_callout`）：值＝类型记录 id。
   * 缺省类型＝摘键（盘上不留「引述」这个说了等于没说的值）。
   */
  'core.block/set-callout': (a, app) => {
    const id = S(a.blockId) || curBlock(app)
    const typeId = S(a.variant, '')
    if (!id || typeId === '') return false
    const types = calloutTypesIn(findCalloutTypesBlock(app.ed.store.blocks))
    if (!liveCalloutTypeOf(typeId, types)) {
      app.toast(t('ui.callout.typeMissing'), 'warn')
      return false
    }
    return app.setCalloutVariant(id, typeId)
  },

  /* ---- 类型表（菜单与管理浮层的入口；参数由那两处给） ---- */
  'core.callout/add-type': (a, app) => {
    const label = S(a.label).trim()
    if (label === '') return false
    return app.addCalloutType(label, S(a.icon) || undefined, S(a.color) || undefined) !== ''
  },
  'core.callout/rename-type': (a, app) => {
    const typeId = S(a.typeId)
    const label = S(a.label)
    if (typeId === '') return false
    return app.renameCalloutType(typeId, label)
  },
  'core.callout/set-type-icon': (a, app) => {
    const typeId = S(a.typeId)
    if (typeId === '') return false
    // 空串合法：摘掉图标，渲染回落引述图标
    return app.setCalloutTypeIcon(typeId, S(a.icon))
  },
  'core.callout/set-type-color': (a, app) => {
    const typeId = S(a.typeId)
    if (typeId === '') return false
    // 空串合法：摘色（中性是合法态）
    return app.setCalloutTypeColor(typeId, S(a.color))
  },
  'core.callout/move-type': (a, app) => {
    const typeId = S(a.typeId)
    if (typeId === '') return false
    // `beforeId` 空串合法：挪到末尾
    return app.moveCalloutType(typeId, S(a.beforeId))
  },
  'core.callout/delete-type': (a, app) => {
    const typeId = S(a.typeId)
    return typeId === '' ? false : app.deleteCalloutType(typeId)
  },
  'core.callout/restore-type': (a, app) => {
    const typeId = S(a.typeId)
    return typeId === '' ? false : app.restoreCalloutType(typeId)
  },
  /** 新建类型并应用到这一块引述：同一笔事务（一步撤销） */
  'core.callout/create-and-apply': (a, app) => {
    const id = targetBlock(a, app)
    const label = S(a.label).trim()
    if (!id || label === '') return false
    return app.createCalloutTypeAndApply(id, label) !== ''
  },
}
