/**
 * 属性 handler：值的写与清、字段定义的新建/加/摘。
 */
import type { ChoiceScope } from '../../core/props.ts'
import type { Handler, PropTarget } from '../../core/ports.ts'
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
    // 同名两义：显式「新建同名属性」跳过同名复用；其它值一律按默认复用
    const mode = a.mode === 'new' ? 'new' : 'reuse'
    return app.createPropDef(blockId, label, kind, target, mode) !== ''
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
  /* ---- 选项（select）：选项是定义块的直接子块，值存选项块 id ---- */
  'core.props/add-choice': (a, app) => {
    const defId = S(a.defId)
    const label = S(a.label)
    if (!defId || !label) return false
    return app.addChoice(defId, label, a.scope as ChoiceScope | undefined) !== ''
  },
  'core.props/set-choice-label': (a, app) => {
    const choiceId = S(a.choiceId)
    const label = S(a.label)
    if (!choiceId || !label) return false
    app.setChoiceLabel(choiceId, label)
    return true
  },
  'core.props/move-choice': (a, app) => {
    const defId = S(a.defId)
    const choiceId = S(a.choiceId)
    if (!defId || !choiceId) return false
    app.moveChoice(defId, choiceId, S(a.beforeId))
    return true
  },
  'core.props/set-choice-scope': (a, app) => {
    const choiceId = S(a.choiceId)
    const scope = a.scope as ChoiceScope | undefined
    if (!choiceId || !scope) return false
    app.setChoiceScope(choiceId, scope)
    return true
  },
  'core.props/delete-choice': (a, app) => {
    const choiceId = S(a.choiceId)
    if (!choiceId) return false
    app.deleteChoice(choiceId)
    return true
  },
}
