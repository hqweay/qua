/**
 * 提及转引用：提及栏「候选引用」的一键转换。
 *
 * 判据（哪里算一处、怎么切、怎么复核）只有 `core/relations/mention.ts` 那一份；
 * 这里只做门面该做的事：读门面取两边、按目标此刻的名字复核、落**一条**内容写。
 * 转换后这一块有了指向目标的边——同一个关系索引里它从提及换到引用。
 */
import { convertSpotToRef, displayTextOf, writeBlockContent } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import type { MentionDeps } from './types.ts'

export function mentionCommands(d: MentionDeps): Pick<App, 'convertMention'> {
  return {
    convertMention: (blockId, to, start, end) => {
      const src = d.kb.get(blockId)
      const target = d.kb.get(to)
      if (!src || !target) return false
      // 名字快照取**此刻**的：渲染与点击之间目标可能改过名，旧区间就不该再转
      const word = displayTextOf(target)
      if (word === '') return false
      const next = convertSpotToRef(src.content, { start, end, text: word }, to, word)
      if (!next) {
        d.toast(t('ui.toast.mentionStale'), 'warn')
        return false
      }
      d.run((tx) =>
        tx.patch(blockId, (x) => {
          writeBlockContent(x, next)
          x.modified = Date.now()
        }),
      )
      return true
    },
  }
}
