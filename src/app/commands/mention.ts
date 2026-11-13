/**
 * 转引用：提及栏命中的一键转换，以及划选气泡的「选区转引用」。
 *
 * 判据（哪里算一处、怎么切、怎么复核）只有 `core/relations/mention.ts` 那一份；
 * 这里只做门面该做的事：读门面取两边、按目标此刻的名字复核、落**一条**内容写。
 * 转换后这一块有了指向目标的边——同一个关系索引里它从提及换到引用。
 *
 * 两处入口的差别只在「目标从哪来」：
 *   · 提及命中：目标就是这一栏的来源块（页/标签），已由渲染端给到；
 *   · 选区：一键默认按选中的字找同名地址（没有就建页），或由「关联到…」选择器
 *     指定任一已有块／新建一个普通块。所有目标都在**同一笔事务**里定下来。
 *
 * ⚠️ 选区这条路写 `anchor ＝ 选中的字`：它是用户已经写下的内容，不是查询词。
 *    提及命中那条不写（那里的字就是目标名，该跟着目标改名走）。
 */
import {
  blockLabel,
  canWriteText,
  convertSpotToRef,
  displayTextOf,
  ensurePageInTx,
  mkBlock,
  plainText,
  sliceRuns,
  writeBlockContent,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { App, SelectionToRefRequest } from '../../core/infra/ports.ts'
import type { KbClient } from '../../core/kb/types.ts'
import type { MentionDeps } from './types.ts'

/**
 * 新建普通块的落点：宿主的**下一个兄弟**。
 *
 * 为什么不是顶层：新块是「从这句话旁边长出来的」，和宿主同层才看得见、面包屑
 * 也才有意义；页的顶层落点（`ensurePageInTx`）是「立一个地址」，两者不是一件事。
 * 用读门面的可见子块算下标（软删的兄弟已退场），与 `Tx.insert` 的 index 同一口径。
 */
function nextSiblingSlot(kb: KbClient, hostId: string): { parentId: string | null; index: number } {
  const parent = kb.parentOf(hostId)
  if (!parent) return { parentId: null, index: kb.roots().length }
  const kids = kb.children(parent.id)
  const at = kids.findIndex((b) => b.id === hostId)
  return { parentId: parent.id, index: at < 0 ? kids.length : at + 1 }
}

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

    convertSelectionToRef: (req: SelectionToRefRequest = {}) => {
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
       * 选择器抢过焦点也不影响这一条：写入用的是**模型选区**，不是 DOM Range。
       */
      const slice = sliceRuns(src.content, spot.start, spot.end)
      if (slice.length === 0 || slice.some((r) => r.t !== 'text') || plainText(slice) !== spot.text) {
        d.toast(t('ui.toast.mentionStale'), 'warn')
        return false
      }
      /** 用对象装「建了什么」：赋值发生在事务回调里，裸 let 会被 TS 窄成初始值 */
      const made: { kind: 'page' | 'block' | null } = { kind: null }
      const r = d.run((tx) => {
        let target: Block | null | undefined
        if (req.to) {
          // 选择器挑中的已有目标：只认 id，不改它的身份、不补 page 露面
          target = d.kb.get(req.to)
        } else if (req.create === 'block') {
          // ⌥↵：以选中的字造一个普通块（不进地址空间，也没有 page 露面）
          const slot = nextSiblingSlot(d.kb, spot.blockId)
          target = mkBlock(spot.text)
          tx.insert(target, slot.parentId, slot.index)
          made.kind = 'block'
        } else {
          /**
           * 一键默认：同名地址已经存在 ⇒ 指向它（**不改它的身份**——一个已经存在的
           * 标签不该因为被引用一次就变成页）；不存在 ⇒ 建页块。
           */
          const existing = d.kb.resolveAlias(spot.text)
          target =
            existing ??
            ensurePageInTx(
              { resolveAlias: (name) => d.kb.resolveAlias(name), roots: () => d.kb.roots() },
              spot.text,
              tx,
            )
          if (!existing && target) made.kind = 'page'
        }
        if (!target) return false
        // label 是目标的名字快照（dangling 兜底）；anchor 才是这一处要显示的字
        const label = blockLabel(target, (id) => d.kb.get(id))
        const next = convertSpotToRef(src.content, spot, target.id, label, spot.text)
        if (!next) return false
        tx.patch(spot.blockId, (x) => {
          writeBlockContent(x, next)
          x.modified = Date.now()
        })
        return true
      })
      if (!r.result) return false
      if (made.kind === 'page') {
        // 新建的页落在森林顶层，可能不在这一屏里；左槽清单要当场跟上
        d.refreshList()
        d.toast(t('ui.toast.selectionToRefCreated', { name: spot.text }), 'ok')
      } else if (made.kind === 'block') {
        // 新块落在宿主的下一个兄弟，不重画这一屏就看不见；页清单不因它变化
        d.refreshEditor()
        d.toast(t('ui.toast.selectionToRefBlockCreated', { name: spot.text }), 'ok')
      }
      // 引用占 1 格：光标落在它之后（重画会摘掉原选区，这里补回来）
      d.placeCaret(spot.blockId, spot.start + 1)
      return true
    },
  }
}
