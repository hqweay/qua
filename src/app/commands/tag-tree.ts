/**
 * 标签层级命令：「child 属于 parent」这条边唯一的写入口。
 */
import {
  addParentTag,
  checkAddParent,
  cyclePathLabels,
  danglingParentIds,
  displayNameOf,
  findInForest,
  parentTagIds,
  pruneParentTags,
  removeParentTag,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { App } from '../../core/ports.ts'
import type { TagTreeDeps } from './types.ts'

export function tagTreeCommands(
  d: TagTreeDeps,
): Pick<App, 'addTagParent' | 'removeTagParent' | 'pruneTagParents'> {
  const find = (id: string): Block | undefined => findInForest(d.blocks(), id)

  return {
    /**
     * 加一条「child 属于 parent」。
     *
     * 两个入口（子标签的「属于」、父标签的「包含」）**写的是同一处**：
     * `child._parentTags`。成环在写入前拒绝，并给出循环路径。
     */
    addTagParent: (childId, parentId) => {
      const child = find(childId)
      const parent = find(parentId)
      if (!child || !parent) return false
      const check = checkAddParent(child, parent, d.blocks())
      if (!check.ok) {
        if (check.reason === 'cycle') {
          const path = cyclePathLabels(check.path ?? [], d.blocks(), d.shortId).join(' → ')
          d.toast(t('ui.tagpanel.cycle', { path }), 'warn')
        } else if (check.reason === 'self') d.toast(t('ui.tagpanel.self'), 'warn')
        else if (check.reason === 'duplicate') d.toast(t('ui.tagpanel.duplicate'), 'info')
        return false
      }
      d.write(childId, () => addParentTag(child, parent, d.blocks()))
      d.toast(t('ui.tagpanel.added', { child: displayNameOf(child), parent: displayNameOf(parent) }))
      return true
    },

    removeTagParent: (childId, parentId) => {
      const child = find(childId)
      if (!child || !parentTagIds(child).includes(parentId)) return
      d.write(childId, () => removeParentTag(child, parentId))
    },

    pruneTagParents: (childId) => {
      const child = find(childId)
      if (!child || danglingParentIds(child, d.blocks()).length === 0) return
      let n = 0
      d.write(childId, () => {
        n = pruneParentTags(child, d.blocks())
      })
      if (n > 0) d.toast(t('ui.tagpanel.pruned', { count: n }))
    },
  }
}
