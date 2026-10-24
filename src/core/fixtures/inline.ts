/**
 * 迷你 DSL：种子正文里直接写 `**粗**` / `==高亮==` / `` `代码` `` / `[[页面]]` / `![[图.png]]`，
 * 由 `parseInline` 解析成**区间锚点与行内原子**——这正是 demo 要展示的模型形状
 * （锚点带 blockId、原子占 1 格），而不是把富文本塞进 DOM。
 *
 * 单独一层是为了让「种子内容长什么样」与「内容怎么变成块」分开：
 * 换一批假数据不需要碰到解析器，改 DSL 也不需要碰任何一页的内容。
 */
import { ATOM_PLACEHOLDER, type BlockProps, type MarkType } from '../index.ts'

export interface SeedBlock {
  text: string
  /**
   * 任务状态（**值是属性**，落进 `props[TASK_STATUS_PROP_ID]`）：
   * `true` ＝ 做完了，`false` ＝ 是任务、还没做完。
   *
   * 与正文里的 `#任务` 是两件事（值 ＋ 分类），本字段只管值；
   * 它们必须成对出现才有 entry：gutter 上那个方框由**标签声明**的字段决定。
   */
  task?: boolean
  /**
   * 打哪些标签（按名字）。
   *
   * 标签标的是**整个块**，所以它不占正文的一格：解析成标签块 id 后写进 `props._tags`。
   * 名字到 id 的解析与「敲 `#名字`」共用 `ensureTag` ⇒ 同名块不会被建出两份。
   */
  tags?: string[]
  /** 系统属性：查询块的 `_query` 条件就落在这里 */
  props?: BlockProps
  children?: SeedBlock[]
}

export interface RawAtom {
  kind: 'page' | 'image'
  start: number
  label: string
  missing?: boolean
  dangling?: boolean
}

export type InlineMark = { type: MarkType; start: number; end: number }

/** ① 先把 `[[..]]` / `![[..]]` 换成占位符（**恒占 1 格**），② 再解析成对格式标记 */
export function parseInline(src: string): { text: string; marks: InlineMark[]; atoms: RawAtom[] } {
  let text = ''
  const atoms: RawAtom[] = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const img = /^!\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
    if (img) {
      text += ATOM_PLACEHOLDER
      atoms.push({
        kind: 'image',
        start: text.length - 1,
        label: img[1]!.trim(),
        missing: /\.missing$|丢失/.test(img[1]!.trim()),
      })
      i += img[0].length
      continue
    }
    const page = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(rest)
    if (page) {
      text += ATOM_PLACEHOLDER
      atoms.push({ kind: 'page', start: text.length - 1, label: page[1]!.trim() })
      i += page[0].length
      continue
    }
    text += src[i]
    i++
  }

  const marks: InlineMark[] = []
  /**
   * 删掉一对标记字符 ⇒ 它右边的**所有位置**左移。
   * ⚠️ 这里必须把**前面几趟已经找到的 mark 端点**一起挪，否则「先 ==高亮== 后 **加粗**」
   * 这类句子里，加粗的区间会整体偏掉（这一趟删的字符在它左边）。
   */
  const shiftFrom = (from: number, delta: number) => {
    for (const a of atoms) if (a.start >= from) a.start += delta
    for (const m of marks) {
      if (m.start >= from) m.start += delta
      if (m.end >= from) m.end += delta
    }
  }
  // 顺序要紧：先 `**` 再 `*`（否则 `**` 会被单星吃掉）
  for (const [open, close, type] of [
    ['**', '**', 'bold'],
    ['==', '==', 'highlight'],
    ['`', '`', 'code'],
    ['*', '*', 'italic'],
  ] as [string, string, MarkType][]) {
    let out = ''
    let idx = 0
    while (idx < text.length) {
      const a = text.indexOf(open, idx)
      if (a < 0) {
        out += text.slice(idx)
        break
      }
      const b = text.indexOf(close, a + open.length)
      if (b < 0) {
        out += text.slice(idx)
        break
      }
      out += text.slice(idx, a)
      const start = out.length
      const inner = text.slice(a + open.length, b)
      shiftFrom(a + open.length, -open.length)
      shiftFrom(b, -close.length)
      out += inner
      marks.push({ type, start, end: start + inner.length })
      idx = b + close.length
    }
    text = out
  }
  return { text, marks, atoms }
}
