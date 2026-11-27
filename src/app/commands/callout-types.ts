/**
 * 引述类型表（记录数组）的命令面：增、改名、换脸（图标/颜色）、排序、墓碑/恢复，
 * 以及「新建并应用」（建类型与改这一块引述是**同一笔事务**，一步撤销）。
 *
 * 为什么这些规则在命令层而不是记录层：
 *   · 类型名**同时是引述容器的显示名**（面包屑、引用 chip 都读它）——空名会让整块没名字，
 *     重名会让「这条面包屑说的是哪个类型」没有答案；
 *   · 值域虽然开放（`_callout` 收任意非空 id），但**写入口**不能把拼错当默认：
 *     静默回落成「引述」看起来像用户选对了。闸在这里，读侧仍宽容。
 *
 * 词汇级重画的落点：改名/换色**不产生引述块的 op**，块级订阅看不到 ⇒
 * 每次编辑后由装配层注入的 `vocabularyChanged` 重画用到它的屏幕（登记在代价里）。
 */
import {
  CALLOUT_PROP,
  CALLOUT_TYPES_BLOCK_ID,
  DEFAULT_CALLOUT,
  QUOTE_TYPE,
  blockTypeOf,
  calloutLabelTaken,
  isColorValue,
  newChoiceId,
  type Block,
  type CalloutType,
} from '../../core/index.ts'
import {
  calloutTypesIn,
  findCalloutTypesBlock,
  writeCalloutTypesInTx,
  type CalloutTypesWriteOutcome,
} from '../../core/kb/ensure-callout-types.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import type { CalloutTypeDeps } from './types.ts'

/** 新类型的默认脸：中性便签（用户建完就能在管理面里换成自己的） */
export const DEFAULT_NEW_TYPE_ICON = 'lucide:sticky-note'

export function calloutTypeCommands(
  d: CalloutTypeDeps,
): Pick<
  App,
  | 'addCalloutType'
  | 'renameCalloutType'
  | 'setCalloutTypeIcon'
  | 'setCalloutTypeColor'
  | 'moveCalloutType'
  | 'deleteCalloutType'
  | 'restoreCalloutType'
  | 'createCalloutTypeAndApply'
> {
  /** 表不在就按内置表起手（与读路径同一条回落） */
  const recordsNow = (): CalloutType[] => calloutTypesIn(findCalloutTypesBlock(d.kb.roots()))

  /**
   * 一次写与一次重画。返回 `false` 当且仅当**一条 op 都没发**（表被软删或没有变化）——
   * 零 op 的动作不该占撤销步，也不该报成「已改」。
   */
  const write = (mutate: (records: CalloutType[]) => CalloutType[]): boolean => {
    let outcome: CalloutTypesWriteOutcome = 'ok'
    const r = d.run((tx) => {
      outcome = writeCalloutTypesInTx(d.kb.roots(), tx, mutate)
    })
    if (outcome !== 'ok' || r.ops.length === 0) return false
    // 首建的那一份不在启动 pins 里：补钉住，别让预算淘汰把自定义类型「吞掉」
    d.pin?.(CALLOUT_TYPES_BLOCK_ID)
    d.vocabularyChanged()
    return true
  }

  /** 空名/重名/找不到人 的三种拒绝；返回 `null` ＝ 可以写 */
  const labelIssue = (label: string, records: readonly CalloutType[], exceptId?: string): string | null => {
    if (label.trim() === '') return t('ui.callout.labelRequired')
    if (calloutLabelTaken(records, label, exceptId)) return t('ui.callout.labelTaken', { label: label.trim() })
    return null
  }

  return {
    addCalloutType: (label, icon, color) => {
      const name = label.trim()
      const records = recordsNow()
      const issue = labelIssue(name, records)
      if (issue !== null) {
        d.toast(issue, 'warn')
        return ''
      }
      if (color !== undefined && color !== '' && !isColorValue(color)) return ''
      const id = newChoiceId()
      const record: CalloutType = {
        id,
        label: name,
        icon: icon?.trim() || DEFAULT_NEW_TYPE_ICON,
        ...(color !== undefined && color !== '' ? { color } : {}),
      }
      const ok = write((list) => [...list, record])
      if (!ok) {
        d.toast(t('ui.callout.registryDeleted'), 'warn')
        return ''
      }
      d.toast(t('ui.callout.toast.created', { label: name }))
      return id
    },

    renameCalloutType: (typeId, label) => {
      const name = label.trim()
      const records = recordsNow()
      const target = records.find((x) => x.id === typeId)
      if (!target) return false
      if (name === target.label) return false
      const issue = labelIssue(name, records, typeId)
      if (issue !== null) {
        d.toast(issue, 'warn')
        return false
      }
      return write((list) => list.map((x) => (x.id === typeId ? { ...x, label: name } : x)))
    },

    setCalloutTypeIcon: (typeId, icon) => {
      const value = icon.trim()
      return write((list) => list.map((x) => (x.id === typeId ? { ...x, icon: value } : x)))
    },

    setCalloutTypeColor: (typeId, color) => {
      const value = color.trim()
      if (value !== '' && !isColorValue(value)) return false
      return write((list) =>
        list.map((x) => {
          if (x.id !== typeId) return x
          if (value === '') {
            const { color: _drop, ...rest } = x
            return rest
          }
          return { ...x, color: value }
        }),
      )
    },

    moveCalloutType: (typeId, beforeId) => {
      if (typeId === beforeId) return false
      const records = recordsNow()
      const from = records.findIndex((x) => x.id === typeId)
      if (from < 0) return false
      const moved = records[from]!
      const rest = records.filter((x) => x.id !== typeId)
      const before = beforeId === '' ? -1 : rest.findIndex((x) => x.id === beforeId)
      const index = before < 0 ? rest.length : before
      const next = [...rest.slice(0, index), moved, ...rest.slice(index)]
      // 位置没变 ⇒ 不写（零 op；否则一次上下移动会占两格撤销）
      if (next.every((x, i) => x.id === records[i]?.id)) return false
      return write(() => next)
    },

    deleteCalloutType: (typeId) => {
      if (typeId === DEFAULT_CALLOUT) {
        d.toast(t('ui.callout.quoteLocked'), 'info')
        return false
      }
      const target = recordsNow().find((x) => x.id === typeId)
      if (!target || target.deleted) return false
      const ok = write((list) => list.map((x) => (x.id === typeId ? { ...x, deleted: true as const } : x)))
      if (ok) d.toast(t('ui.callout.toast.deleted', { label: target.label }))
      return ok
    },

    restoreCalloutType: (typeId) => {
      const records = recordsNow()
      const target = records.find((x) => x.id === typeId)
      if (!target || !target.deleted) return false
      // 恢复一个名字已被占用的墓碑：两条记录同叫一个名字，面包屑就没有答案了
      const issue = labelIssue(target.label, records, typeId)
      if (issue !== null) {
        d.toast(issue, 'warn')
        return false
      }
      const ok = write((list) =>
        list.map((x) => {
          if (x.id !== typeId) return x
          const { deleted: _drop, ...rest } = x
          return rest
        }),
      )
      if (ok) d.toast(t('ui.callout.toast.restored', { label: target.label }))
      return ok
    },

    createCalloutTypeAndApply: (blockId, label) => {
      const block: Block | undefined = d.kb.get(blockId)
      if (!block || blockTypeOf(block) !== QUOTE_TYPE) return ''
      const name = label.trim()
      const records = recordsNow()
      const issue = labelIssue(name, records)
      if (issue !== null) {
        d.toast(issue, 'warn')
        return ''
      }
      const id = newChoiceId()
      const record: CalloutType = { id, label: name, icon: DEFAULT_NEW_TYPE_ICON }
      let outcome: CalloutTypesWriteOutcome = 'ok'
      const r = d.run((tx) => {
        outcome = writeCalloutTypesInTx(d.kb.roots(), tx, (list) => [...list, record])
        if (outcome !== 'ok') return
        // 建类型与落值同一笔：拆开就会留下「类型建了、引述没换」的半批，撤销也变两步
        tx.patch(blockId, (x) => {
          x.props = { ...(x.props ?? {}), [CALLOUT_PROP]: id }
        })
      })
      if (outcome !== 'ok' || r.ops.length === 0) {
        d.toast(t('ui.callout.registryDeleted'), 'warn')
        return ''
      }
      d.pin?.(CALLOUT_TYPES_BLOCK_ID)
      d.vocabularyChanged()
      d.toast(t('ui.callout.toast.created', { label: name }))
      return id
    },
  }
}
