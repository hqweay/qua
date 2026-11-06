/**
 * 转引用：提及栏命中的一键转换，以及划选气泡的「选区转引用」。
 *
 * 判据（哪里算一处、怎么切、怎么复核）只有 `core/relations/mention.ts` 那一份；
 * 这里只做门面该做的事：读门面取两边、按目标此刻的名字复核、落**一条**内容写。
 * 转换后这一块有了指向目标的边——同一个关系索引里它从提及换到引用。
 *
 * 两处入口的差别只在「目标从哪来」：
 *   · 提及命中：目标就是这一栏的来源块（页/标签），已由渲染端给到；
 *   · 选区：按选中的字找同名地址；**没有就建一个页块再引用**（与 `@` 提到的
 *     「同名地址不存在时新建」是同一条创建路径，不另写一份）。
 */
import {
  canWriteText,
  convertSpotToRef,
  displayTextOf,
  ensurePageInTx,
  plainText,
  sliceRuns,
  writeBlockContent,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App } from '../../core/infra/ports.ts'
import type { MentionDeps } from './types.ts'

export function mentionCommands(d: MentionDeps): Pick<App, 'convertMention' | 'convertSelectionToRef'> {
  return {
    convertMention: (blockId, to, start, end) => {
      const src = d.kb.get(blockId)
      const target = d.kb.get(to)
      if (!src || !target) return false
      /**
       * 正文是名字或投影的块（日记／字段定义／查询／只读类型）**不许**走这条路：
       * 内容写闸会在发看点 `throw`，用户只会看到「点了没反应」。
       * 在入口说一句实话，模型一个字节都不动。
       */
      if (!canWriteText(src)) {
        d.toast(t('ui.toast.mentionReadonly'), 'warn')
        return false
      }
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

    convertSelectionToRef: () => {
      const spot = d.selection()
      if (!spot) return false
      const src = d.kb.get(spot.blockId)
      if (!src) return false
      if (!canWriteText(src)) {
        d.toast(t('ui.toast.mentionReadonly'), 'warn')
        return false
      }
      /**
       * 写前复核与提及那条同口径：区间里必须仍是那串**纯文本**。选区从渲染到点击
       * 之间正文可能已经变了（或选区里夹着原子），复核不过就一个字节不写。
       */
      const slice = sliceRuns(src.content, spot.start, spot.end)
      if (slice.length === 0 || slice.some((r) => r.t !== 'text') || plainText(slice) !== spot.text) {
        d.toast(t('ui.toast.mentionStale'), 'warn')
        return false
      }
      /**
       * 目标：同名地址已经存在 ⇒ 指向它（**不改它的身份**——一个已经存在的标签
       * 不该因为被引用一次就变成页）；不存在 ⇒ 建页块（自带首个子块，可继续写）。
       * 两件事与正文替换同一笔事务：一次撤销把「新建的页」也一起撤掉。
       */
      const existing = d.kb.resolveAlias(spot.text)
      let created = false
      const r = d.run((tx) => {
        const target =
          existing ??
          ensurePageInTx(
            { resolveAlias: (name) => d.kb.resolveAlias(name), roots: () => d.kb.roots() },
            spot.text,
            tx,
          )
        if (!target) return false
        created = !existing
        const next = convertSpotToRef(src.content, spot, target.id, spot.text)
        if (!next) return false
        tx.patch(spot.blockId, (x) => {
          writeBlockContent(x, next)
          x.modified = Date.now()
        })
        return true
      })
      if (!r.result) return false
      if (created) {
        // 新建的页落在森林顶层，可能不在这一屏里；左槽清单要当场跟上
        d.refreshList()
        d.toast(t('ui.toast.selectionToRefCreated', { name: spot.text }), 'ok')
      }
      // 引用占 1 格：光标落在它之后（重画会摘掉原选区，这里补回来）
      d.placeCaret(spot.blockId, spot.start + 1)
      return true
    },
  }
}
