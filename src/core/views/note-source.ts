/**
 * **备注的来源**：这条备注在评论谁的哪一段——装载根行首那一格。
 *
 * 备注块住森林顶层（身份不占位置），在宿主看来它只是一条独立的块；它「评谁」的
 * 事实住在自己的 `_annotates` 槽上。把这份事实画出来，是让备注在**离开宿主页面**
 * （页签／侧栏／搜索结果）时仍知道自己属于哪里——否则它是一条没有上下文的评论。
 *
 * ⚠️ 槽里的 id 是**事实**，宿主／锚有没有活着是**读**的事（与 `_belongsTo` 同一口径）：
 *    解析不到就报 `dangling`，让一个被删的宿主变成一句「原文已删除」，而不是一片空白。
 * ⚠️ 位置只取宿主所在**页**的名字（路径首格）：宿主是哪一句由引文回答，读者要找的
 *    是「去哪一页看」。宿主本身是顶层块时，它自己就是那一页。
 */
import { indexPathOf, type Index } from '../infra/index-port.ts'
import type { Block } from '../model/model.ts'
import { annotatesPairsOf } from '../relations/annotates.ts'
import { blockLabel } from '../relations/ref.ts'

/** 一格来源：一个宿主（跨块备注有多格） */
export interface NoteSourceCell {
  /** 宿主块 id（点击的去处） */
  hostId: string
  /** 宿主所在页的名字；`dangling` 时为空 */
  label: string
  /** 被标注那一段的引文快照（`quote.exact`）；空串＝那枚锚没有引文 */
  quote: string
  /** 宿主块或那枚区间锚已经不在库里 */
  dangling: boolean
}

/** 一条备注评论了哪些（宿主，锚）；不是备注 ⇒ 空数组 */
export function noteSourceCellsOf(note: Block, index: Index): NoteSourceCell[] {
  const find = (id: string) => index.blocks.get(id)
  const cells: NoteSourceCell[] = []
  for (const pair of annotatesPairsOf(note)) {
    const host = find(pair.block)
    const anno = host?.annos?.find((a) => a.id === pair.anno)
    if (!host || !anno) {
      cells.push({ hostId: pair.block, label: '', quote: '', dangling: true })
      continue
    }
    const page = indexPathOf(index, host.id)[0] ?? host
    cells.push({
      hostId: host.id,
      label: blockLabel(page, find),
      quote: anno.quote?.exact ?? '',
      dangling: false,
    })
  }
  return cells
}
