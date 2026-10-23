/**
 * 属性 handler：值的写与清、字段定义的新建/加/摘。
 */
import type { Handler } from '../../core/ports.ts'
import { S } from './shared.ts'

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
    if (!label) return false
    return app.createPropDef(blockId, label, kind) !== ''
  },
  'core.props/add-field': (a, app) => {
    const blockId = S(a.blockId)
    const propId = S(a.propId)
    if (!blockId || !propId) return false
    app.addProp(blockId, propId)
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
