/**
 * 属性 handler：值的写与清、字段定义的新建/加/摘。
 */
import type { PropTarget } from '../../core/ports.ts'
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

/**
 * 属性挂到块上的两个去处（`own` / `declared`）。
 *
 * **缺省 `own`**：不传就是「给这一块自己加一条」——这是最不会误解的那一边。
 * 以前靠「这个块有没有 page/tag 露面」推断，于是标签块永远加不了自己的属性；
 * 现在意图必须显式给，没给就按「自己的值」办。
 */
const propTargetOf = (v: unknown): PropTarget => (v === 'declared' ? 'declared' : 'own')

export const PROPS_HANDLERS: Record<string, Handler> = {
  /* ---- 属性 ---- */
  'core.props/set-value': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.setPropValue(blockId, propId, a.value)
    return true
  },
  'core.props/clear-value': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.clearPropValue(blockId, propId)
    return true
  },
  'core.props/create-def': (a, app) => {
    const blockId = S(a.blockId)
    const label = S(a.label)
    const kind = S(a.kind, 'text')
    const target = propTargetOf(a.target)
    if (!label) return false
    return app.createPropDef(blockId, label, kind, target) !== ''
  },
  'core.props/add-field': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    const target = propTargetOf(a.target)
    if (!blockId || !propId) return false
    app.addProp(blockId, propId, target)
    return true
  },
  'core.props/undeclare': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.undeclareProp(blockId, propId)
    return true
  },
}
