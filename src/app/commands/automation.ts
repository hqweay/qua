/**
 * 自动化域的命令实现：创建（物化顶层）、手动运行（真原子）、启停与定义写回。
 *
 * 分工：core 的 runner（`core/automation/run.ts`）只认事务与定义；
 * 这一层负责「当前块是谁」（手动链目标）、重画与 toast——
 * 与属性/视图命令同一条分工（core 判据，app 收尾）。
 *
 * ⚠️ runner 的每一笔写都走**装配层的事务入口**（`tx`）：那是 op 进落盘队列、
 *    撤销记账、按 changes 重画的唯一通道——绕过它（裸 `kb.tx`）的写内存里看得见、
 *    盘上没有，重开就丢。
 */
import { isAutomationBlock, mkBlock, isAutomationDef, type Block } from '../../core/index.ts'
import { textRuns } from '../../core/model/runs.ts'
import type { Op } from '../../core/kb/types.ts'
import type { Tx as KbTx } from '../../core/kb/types.ts'
import {
  automationName,
  canonicalAutomation,
  mkAutomationBlock,
  readAutomation,
  type AutomationDef,
} from '../../core/automation/automation.ts'
import { manualRunGuards, moveIdentityConstraint, runAutomationSteps, type AutomationKb } from '../../core/automation/run.ts'
import { t } from '../../core/infra/msg.ts'

/** 新建自动化的出生定义：手动触发、**默认停用**（分享来的规则不自觉生效）、空步骤 */
export function freshAutomationDef(): { enabled: false; triggers: ['manual']; steps: [] } {
  return { enabled: false, triggers: ['manual'], steps: [] }
}

export interface AutomationDeps {
  /** 读门面（`automations`／`get`／`matchesSpec` 都是 guards 要的窄口） */
  kb: Omit<AutomationKb, 'tx'> & { automations(): readonly Block[] }
  /**
   * 事务入口（装配层 runTx）：core runner 在这里开**一笔**事务包住全部步骤（真原子）；
   * op 进落盘队列、撤销记账（一次运行＝一步撤销）、按 changes 重画都由它收。
   */
  tx: <R>(fn: (tx: KbTx) => R) => { ops: readonly Op[]; result: R }
  /** 重画一批块所在的行（目标块的样子变了） */
  repaintBlocks: (ids: readonly string[]) => void
  /** 新建后跳到那一块（作者的下一站就是写定义） */
  openBlock: (blockId: string) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export function automationCommands(d: AutomationDeps) {
  /** runner 的窄口：读面转发读门面，事务走装配层入口（op／撤销都不漏） */
  const runnerKb: AutomationKb = {
    get: (id) => d.kb.get(id),
    matchesSpec: (spec, block, opts) => d.kb.matchesSpec(spec, block, opts),
    propDefs: () => d.kb.propDefs(),
    findTag: (name) => d.kb.findTag(name),
    resolveAlias: (name) => d.kb.resolveAlias(name),
    roots: () => d.kb.roots(),
    tx: (fn) => d.tx(fn),
  }

  /**
   * 建一条自动化（**身份块物化顶层**，与属性定义块同一条落点口径——位置对身份
   * 不承载信息，树操作会把住在子树里的身份块当货物搬走）。
   */
  const createAutomation = (name: string): string => {
    const label = name.trim() === '' ? t('ui.automation.untitled') : name.trim()
    const block = mkAutomationBlock({ name: label, def: freshAutomationDef(), icon: 'lucide:zap' })
    d.tx((tx) => {
      tx.insert(block, null, d.kb.roots().length)
    })
    d.openBlock(block.id)
    d.toast(t('ui.automation.created', { name: label }))
    return block.id
  }

  /**
   * 手动运行：目标＝调用方给（缺省当前块）；guards 与面板灰态共用同一份判据。
   * 运行失败（步骤抛错）⇒ 事务已整批回滚，这里给一句实话，不静默。
   */
  const runAutomation = (automationId: string, targetId?: string): boolean => {
    const block = d.kb.get(automationId)
    if (!block || !isAutomationBlock(block)) return false
    const def = readAutomation(block)
    const target = targetId ?? ''
    const targetBlock = target === '' ? undefined : d.kb.get(target)
    const whenOk =
      def?.when === undefined ? true : targetBlock !== undefined && d.kb.matchesSpec({ where: def.when }, targetBlock)
    const g = manualRunGuards(def, automationId, target || undefined, whenOk)
    if (!def || !g.ok) {
      d.toast(t(`ui.automation.blocked.${g.reason ?? 'noManual'}`, { name: automationName(block) }), 'warn')
      return false
    }
    try {
      const r = runAutomationSteps(runnerKb, target, def, { lookup: d.kb })
      if (!r) return false
      d.repaintBlocks([target])
      d.toast(t('ui.automation.ran', { name: automationName(block), count: r.stepsRun }), 'ok')
      return true
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      d.toast(t('ui.automation.runFailed', { message: msg }), 'warn')
      return false
    }
  }

  /** 启停开关（enabled 是定义的一部分：随库同步，一次撤销） */
  const toggleAutomation = (automationId: string, on?: boolean): boolean => {
    const block = d.kb.get(automationId)
    if (!block) return false
    const cur = readAutomation(block)
    if (!cur) return false
    const next = on ?? !cur.enabled
    let changed = false
    d.tx((tx) => {
      tx.patch(automationId, (b) => {
        const now = readAutomation(b)
        if (!now || now.enabled === next) return
        b.props = { ...(b.props ?? {}), _automation: { ...now, enabled: next } }
        changed = true
      })
    })
    if (changed) d.repaintBlocks([automationId])
    return changed
  }

  /** 整份定义写回（块身体的编辑面落点；canonical 由调用方给，这里只收合法形状） */
  const setAutomationDef = (automationId: string, def: AutomationDef): boolean => {
    if (!d.kb.get(automationId) || !isAutomationDef(def)) return false
    d.tx((tx) => {
      tx.patch(automationId, (b) => {
        b.props = { ...(b.props ?? {}), _automation: canonicalAutomation(def) }
      })
    })
    d.repaintBlocks([automationId])
    return true
  }

  /**
   * `core.tree/insert-child {parentId, text}` 的落点：**id 绑定**的插块
   * （`core.editor/insert-block` 绑光标，不可当步骤用）。
   * 建子块是纯文本；与 runner 的原语同一判据，只是这里自己开一笔事务。
   */
  const treeInsertChild = (parentId: string, text: string): string => {
    if (parentId === '' || !d.kb.get(parentId)) return ''
    const block = mkBlock(textRuns(text))
    d.tx((tx) => {
      tx.insert(block, parentId, Number.MAX_SAFE_INTEGER)
    })
    d.repaintBlocks([parentId])
    return block.id
  }

  /** `core.tree/move {blockId, parentId, position}` 的落点（身份约束与 runner 同一份） */
  const treeMove = (blockId: string, parentId: string | null, position?: number): boolean => {
    if (blockId === '') return false
    if (parentId !== null && !d.kb.get(parentId)) return false
    const why = moveIdentityConstraint(d.kb, blockId, parentId)
    if (why) {
      console.warn(`[automation] move refused: ${why}`)
      return false
    }
    const idx = position === undefined || !Number.isFinite(position) || position < 0 ? Number.MAX_SAFE_INTEGER : position
    d.tx((tx) => {
      tx.move(blockId, parentId, idx)
    })
    d.repaintBlocks([blockId, ...(parentId !== null ? [parentId] : [])])
    return true
  }

  return {
    createAutomation,
    runAutomation,
    toggleAutomation,
    setAutomationDef,
    treeInsertChild,
    treeMove,
  }
}
