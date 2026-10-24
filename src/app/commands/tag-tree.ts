/**
 * 标签层级命令：「child 属于 parent」这条边唯一的写入口。
 *
 * 成环检查要算**祖先闭包**（全库读），所以经装配层注入的窄口（`checkAdd`），
 * 命令层不持有森林；写路径只动子标签这一个块（`appendParentTag`），经事务产 op。
 */
import {
  displayNameOf,
  parentTagIds,
  removeParentTag,
  appendParentTag,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { TagTreeDeps } from './types.ts'

export function tagTreeCommands(
  d: TagTreeDeps,
): Pick<App, 'addTagParent' | 'removeTagParent' | 'pruneTagParents'> {
  return {
    /**
     * 加一条「child 属于 parent」。
     *
     * 两个入口（子标签的「属于」、父标签的「包含」）**写的是同一处**：
     * `child._parentTags`。成环在写入前拒绝，并给出循环路径。
     */
    addTagParent: (childId, parentId) => {
      const child = d.kb.get(childId)
      const parent = d.kb.get(parentId)
      if (!child || !parent) return false
      const check = d.checkAdd(child, parent)
      if (!check.ok) {
        if (check.reason === 'cycle') {
          const path = d.cycleLabels(check.path ?? []).join(' → ')
          d.toast(t('ui.tagpanel.cycle', { path }), 'warn')
        } else if (check.reason === 'self') d.toast(t('ui.tagpanel.self'), 'warn')
        else if (check.reason === 'duplicate') d.toast(t('ui.tagpanel.duplicate'), 'info')
        return false
      }
      d.write(childId, () => appendParentTag(child, parent))
      d.toast(t('ui.tagpanel.added', { child: displayNameOf(child), parent: displayNameOf(parent) }))
      return true
    },

    removeTagParent: (childId, parentId) => {
      const child = d.kb.get(childId)
      if (!child || !parentTagIds(child).includes(parentId)) return
      d.write(childId, () => removeParentTag(child, parentId))
    },

    pruneTagParents: (childId) => {
      const child = d.kb.get(childId)
      if (!child || d.danglingOf(child).length === 0) return
      let n = 0
      d.write(childId, () => {
        n = d.pruneDangling(child)
      })
      if (n > 0) d.toast(t('ui.tagpanel.pruned', { count: n }))
    },
  }
}
