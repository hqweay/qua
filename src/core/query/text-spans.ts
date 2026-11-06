/**
 * **查询词在正文里的落点**：把「命中哪几个字」翻译成 **plain 偏移**。
 *
 * 为什么需要换算：查询词匹配的是 `plainText(content)`（投影坐标，原子不占格 ——
 * 见 `model/runs.ts` 的两套坐标），而高亮/切片/转换要的是 plain 坐标（每个原子算 1 格）。
 * 直接拿 `indexOf` 的位置当 plain 偏移，会在**有原子的块**上整体错位：错位的形态是
 * 「高亮画在旁边几个字上」，不报错。
 *
 * ⚠️ **原子里的字不算正文**：`plainText` 里根本没有它们（引用/chip 的显示名是目标的名字，
 * 不是这一块写下的内容）。按投影搜天然满足这条，不要为了「看起来也能搜到 chip」再去走 DOM。
 */
import { fromProjection, plainText, type Content } from '../model/runs.ts'

/** plain 偏移上的区间（文本段按字符数，原子整枚算 1 格） */
export interface TextSpan {
  start: number
  end: number
}

/**
 * `term` 在 `content` 正文里的全部落点（按出现序，允许重叠）。
 *
 * 口径与搜索面一致：按空白拆成多个词、各自大小写不敏感、同一段里出现几次就几处。
 */
export function textSpansOf(content: Content, term: string): TextSpan[] {
  const terms = term
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase())
  if (terms.length === 0) return []
  const low = plainText(content).toLowerCase()
  if (low === '') return []
  const out: TextSpan[] = []
  for (const t of terms) {
    let from = 0
    while (from < low.length) {
      const at = low.indexOf(t, from)
      if (at < 0) break
      // 两个端点各自换算：区间中间跨过几个原子，plain 偏移就会多出几格
      out.push({ start: fromProjection(content, at), end: fromProjection(content, at + t.length) })
      from = at + t.length
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
