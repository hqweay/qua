/**
 * **归属边**的三个命令：「child 归在 parent 下」这条边唯一的写入口。
 *
 * 三条口径都在模型层，命令层只做「查一遍、说人话、写一次」：
 *   · **加边**：自环／重复／成环在写入前拒绝（成环要祖先闭包 ⇒ 全库读，经注入的窄口拿）；
 *     被拒绝的写入**连一次撤销快照都不产生**（所以检查与写分成两步）。
 *   · **删边**：只动子块这一侧 —— 不碰名字、不碰 `children`、不动上级那一条。
 *   · **清理**：只清「上级真的没了」的那些；回收站里的上级一条不动（复活要自愈）。
 *
 * 任何块都能配（模型不查露面）：候选集合的收窄是**入口**的事，两个入口
 * （属性区的「属于」、归属树面板的拖入）各自只列页与标签。
 */
import { displayNameOf, parentIdsOf, removeEdge, appendEdge } from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { BelongsToDeps } from './types.ts'

export function belongsToCommands(
  d: BelongsToDeps,
): Pick<App, 'addBelongsTo' | 'removeBelongsTo' | 'pruneBelongs'> {
  return {
    addBelongsTo: (childId, parentId) => {
      const child = d.kb.get(childId)
      const parent = d.kb.get(parentId)
      if (!child || !parent) return false
      const check = d.checkAdd(child, parent)
      if (!check.ok) {
        if (check.reason === 'cycle') {
          const path = d.cycleLabels(check.path ?? []).join(' → ')
          d.toast(t('ui.belongs.cycle', { path }), 'warn')
        } else if (check.reason === 'self') d.toast(t('ui.belongs.self'), 'warn')
        else if (check.reason === 'duplicate') d.toast(t('ui.belongs.duplicate'), 'info')
        return false
      }
      d.write(childId, () => appendEdge(child, parent))
      d.toast(t('ui.belongs.added', { child: displayNameOf(child), parent: displayNameOf(parent) }))
      return true
    },

    removeBelongsTo: (childId, parentId) => {
      const child = d.kb.get(childId)
      if (!child || !parentIdsOf(child).includes(parentId)) return
      d.write(childId, () => removeEdge(child, parentId))
    },

    pruneBelongs: (childId) => {
      const child = d.kb.get(childId)
      if (!child || d.danglingOf(child).gone.length === 0) return
      let n = 0
      d.write(childId, () => {
        n = d.pruneGone(child)
      })
      if (n > 0) d.toast(t('ui.belongs.pruned', { count: n }))
    },
  }
}
