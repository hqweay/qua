/**
 * **文本提及 → 引用**：一处纯文本换成一枚指向目标块的 `RefRun`。
 *
 * 提及栏里的「候选引用」是**还没指向**目标的正文：`{text} ∧ ¬{ref}` 收进来的那一批行。
 * 转换做的是一次程序化内容编辑——把正文里出现目标名字的那一处切开、原位插一枚
 * 引用 run（`label` ＝ 插入时刻的名字快照）。转换之后这一块有了指向目标的边，
 * 同一个关系索引里它从「提及」（`{text} ∧ ¬{ref}`）换到「引用」（`{ref}`）。
 *
 * ⚠️ **`anchor` 只在「这里本来就有用户写的字」的路径上写**：提及命中的那段字就是
 *    目标此刻的名字，不写 anchor 才能跟着目标改名走；划选转引用相反——用户选的是
 *    自己写的字，目标可以叫别的名字，不写 anchor 的话 `resolveRef` 会拿目标现算名
 *    把这几个字顶掉（选中「现在」指向「时间管理」，正文就变成「时间管理」）。
 *    `anchor` 由**调用方**按路径决定，纯函数不替两边猜。
 *
 * 匹配跑在**投影**上（`plainText`，原子不占格）：`{text}` 条件怎么收，这里的
 * 出现处就怎么找——两份口径各写一遍，就会出现「列表说提到了、转换却找不到」。
 * 投影里相邻、plain 里被原子隔开的出现处**不收**：转换它得连原子一起吞掉，
 * 超出「换一处纯文本」的承诺。
 *
 * 本文件是纯函数层：零 DOM、零持久化。写（事务与撤销捕获）归命令面。
 */
import { uuidv7Hex } from '../model/ids.ts'
import { fromProjection, plainText, sliceRuns, spliceRuns, type Content, type RefRun, type Run } from '../model/runs.ts'
import type { TextPart } from '../search/query.ts'

/** 一处可转换的提及：plain 偏移区间 ＋ 该处的词（写时复核用） */
export interface MentionSpot {
  start: number
  end: number
  /** 这一处的词（＝找它时用的那个名字；写时拿它复核区间还是不是它） */
  text: string
}

/**
 * 正文里**可转换**的名字出现处（plain 区间，升序、不重叠）。
 *
 * 词为空 ⇒ 空表（没有名字就没有提及，更没有候选）。
 * 出现处在投影上定位、映射回 plain；区间里混着原子（或映射后对不齐）⇒ 跳过。
 */
export function mentionSpotsOf(content: Content, word: string): MentionSpot[] {
  const w = word.trim()
  if (w === '') return []
  const proj = plainText(content)
  if (proj === '') return []
  const out: MentionSpot[] = []
  let from = 0
  while (from <= proj.length - w.length) {
    const at = proj.indexOf(w, from)
    if (at < 0) break
    from = at + w.length
    // 投影偏移 → plain 起点（落在文本上的点才可逆；`fromProjection` 取「下一个文本位」）
    const start = fromProjection(content, at)
    const end = start + w.length
    // 区间里只要有一枚原子就不是「一处纯文本」：整段替换会把它一起吃掉
    const slice = sliceRuns(content, start, end)
    if (slice.length === 0 || slice.some((r) => r.t !== 'text')) continue
    if (plainText(slice) !== w) continue
    out.push({ start, end, text: w })
  }
  return out
}

/**
 * 把一处纯文本换成指向 `to` 的引用 run（`label` ＝ 目标名字快照）。
 *
 * `anchor` 是**这一处想显示什么**：只有替换「用户已经写下的字」时才传（通常是
 * `spot.text`），插入路径不传。写空串＝不写这个键，和 `RefRun.anchor` 的口径一致。
 *
 * 写前复核：区间里必须仍是那串纯文本。渲染与点击之间正文可能已经变了——
 * 复核不过就返回 `null`，**一个字节都不写**；调用方据此给一句「没转成」的实话，
 * 而不是把别的字换成引用。
 */
export function convertSpotToRef(
  content: Content,
  spot: MentionSpot,
  to: string,
  label: string,
  anchor?: string,
): Run[] | null {
  const slice = sliceRuns(content, spot.start, spot.end)
  if (slice.length === 0 || slice.some((r) => r.t !== 'text')) return null
  if (plainText(slice) !== spot.text) return null
  const run: RefRun = { id: uuidv7Hex(), t: 'ref', to, label, ...(anchor ? { anchor } : {}) }
  return spliceRuns(content, spot.start, spot.end, [run])
}

/**
 * 提及栏片段行的**结构化片段**：命中段标 `mark`，其余是普通文本段。
 *
 * 入参是**内容**不是串：spots 是 plain 偏移（原子占 1 格），展示串必须与之同一坐标系
 * ——文本照抄、原子各占一格占位符。喂「投影串」（原子不占格）会让 mark 在
 * 含引用/图等原子的块上整体错位甚至一处都画不出来（高亮与转换按钮一起消失）。
 *
 * 窗口从首个出现处附近起截（与搜索片段同一条纪律：宁可前后省略号，不把整段堆进一行）；
 * 窗口不许切在命中中间——尾巴越界就把窗口推到那一处之后。
 *
 * ⚠️ **序的约定**：标了 `mark` 的段按出现处顺序排列，第 k 个 mark 恰对应 `spots[k]`
 *    （窗口永远包含首个出现处 ⇒ 被窗口截掉的出现处只在尾部）。
 *    渲染端靠这条约定把「第 k 个高亮」接到「第 k 处转换」上。
 */
export function mentionSnippet(content: Content, spots: readonly MentionSpot[], max = 96): TextPart[] {
  const first = spots[0]
  if (!first || content.length === 0) return []
  const text = plainDisplay(content)
  const start = Math.max(0, first.start - 24)
  let end = Math.min(text.length, start + max)
  for (const s of spots) {
    if (s.start < end && s.end > end) end = Math.min(text.length, s.end)
  }
  const parts: TextPart[] = []
  if (start > 0) parts.push({ text: '…' })
  let cursor = start
  for (const s of spots) {
    if (s.start >= end) break
    if (s.start > cursor) parts.push({ text: text.slice(cursor, s.start) })
    parts.push({ text: text.slice(s.start, s.end), mark: true })
    cursor = s.end
  }
  if (cursor < end) parts.push({ text: text.slice(cursor, end) })
  if (end < text.length) parts.push({ text: '…' })
  return parts
}

/** 与 plain 偏移对齐的展示串：文本照抄，原子各占一格占位（原子不可转，只占位） */
function plainDisplay(content: Content): string {
  let out = ''
  for (const r of content) out += r.t === 'text' ? r.v : '□'
  return out
}
