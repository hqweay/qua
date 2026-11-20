/**
 * 自动化与树结构的 handler。
 *
 * `core.tree/*` 是**id 绑定**的机器形状（`core.editor/insert-block` 绑光标，
 * 不可当步骤用）；参数由自动化步骤与机器接口给，面板裸按只会「未处理」⇒ 不进面板。
 */
import type { Handler } from '../../core/infra/ports.ts'
import { curBlock, S } from './shared.ts'

export const AUTOMATION_HANDLERS: Record<string, Handler> = {
  'core.automation/create': (a, app) => {
    app.createAutomation(S(a.name))
    return true
  },
  /** 手动链目标＝当前块（缺省）；显式给 `blockId` 的调用面照走同一份 guards */
  'core.automation/run': (a, app) => {
    const automationId = S(a.automationId)
    if (automationId === '') return false
    return app.runAutomation(automationId, S(a.blockId) || curBlock(app) || undefined)
  },
  'core.automation/toggle-enabled': (a, app) => {
    const automationId = S(a.automationId)
    if (automationId === '') return false
    return app.toggleAutomation(automationId, a.on === undefined ? undefined : a.on === true)
  },
  'core.automation/set-def': (a, app) => {
    const automationId = S(a.automationId)
    const def = a.def
    if (automationId === '' || !def || typeof def !== 'object') return false
    return app.setAutomationDef(automationId, def as import('../../core/automation/automation.ts').AutomationDef)
  },
  'core.tree/insert-child': (a, app) => {
    const parentId = S(a.parentId)
    if (parentId === '') return false
    return app.treeInsertChild(parentId, S(a.text)) !== ''
  },
  'core.tree/move': (a, app) => {
    const blockId = S(a.blockId)
    if (blockId === '') return false
    const parent = S(a.parentId)
    const position = typeof a.position === 'number' && Number.isFinite(a.position) ? a.position : undefined
    return app.treeMove(blockId, parent === '' ? null : parent, position)
  },
}
