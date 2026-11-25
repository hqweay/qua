/**
 * Markdown → 块的**纯解析**：不碰 DOM、不碰模型，只把一段文本拆成可插入的块描述。
 *
 * 标题不落成类型：它只决定父子关系（树的深度已经是层级，再存一个 level 就是第二真相）。
 * 不支持的块级语法整行原样带出，行内也不转换——半转换会让同一段里两种口径并存。
 */
import type { Marks } from '../model/runs.ts'

export type ParsedInline =
  | { t: 'text'; v: string; marks?: Marks }
  | { t: 'link'; url: string; v: string }
  | { t: 'ref'; id: string }

export interface ParsedBlock {
  inline: ParsedInline[]
  /** `quote` 与 `divider` 落到类型；`fence` 在编辑器面才决定怎么落 */
  kind?: 'quote' | 'divider' | 'fence'
  /** 围栏内的代码（不含围栏行）——有编辑面时直接落成代码块 */
  code?: string
  lang?: string
  /** 围栏整段原文（含围栏行），未支持时的降级载荷 */
  raw?: string
  children: ParsedBlock[]
}

export interface MarkdownParse {
  blocks: ParsedBlock[]
  unsupported: string[]
}

const text = (v: string, marks?: Marks): ParsedInline =>
  marks === undefined ? { t: 'text', v } : { t: 'text', v, marks }

/**
 * 行内扫描：代码段与链接先认（它们的内部不再是格式语法），其后是三种 mark，
 * 最后是 `((id))` 引用记号。没认出的字符原样攒着，不吞字。
 */
function inlineOf(src: string): ParsedInline[] {
  const out: ParsedInline[] = []
  let buf = ''
  const flush = () => {
    if (buf !== '') {
      out.push(text(buf))
      buf = ''
    }
  }
  let rest = src
  while (rest !== '') {
    const take = (re: RegExp): RegExpExecArray | null => {
      const m = re.exec(rest)
      return m && m.index === 0 ? m : null
    }
    let m = take(/^`([^`]+)`/)
    if (m) {
      flush()
      out.push(text(m[1]!, { code: true }))
      rest = rest.slice(m[0].length)
      continue
    }
    m = take(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/)
    if (m) {
      flush()
      out.push({ t: 'link', v: m[1]!, url: m[2]! })
      rest = rest.slice(m[0].length)
      continue
    }
    const marks: Array<[RegExp, Marks]> = [
      [/^\*\*([^*]+)\*\*/, { bold: true }],
      [/^__([^_]+)__/, { bold: true }],
      [/^~~([^~]+)~~/, { strike: true }],
      [/^\*([^*]+)\*/, { italic: true }],
      [/^_([^_]+)_/, { italic: true }],
    ]
    let hit: { value: string; marks: Marks; size: number } | null = null
    for (const [re, mk] of marks) {
      const r = take(re)
      if (r) {
        hit = { value: r[1]!, marks: mk, size: r[0].length }
        break
      }
    }
    if (hit) {
      flush()
      out.push(text(hit.value, hit.marks))
      rest = rest.slice(hit.size)
      continue
    }
    m = take(/^\(\(([0-9a-fA-F]{16,64})\)\)/)
    if (m) {
      flush()
      out.push({ t: 'ref', id: m[1]! })
      rest = rest.slice(m[0].length)
      continue
    }
    buf += rest[0]
    rest = rest.slice(1)
  }
  flush()
  return out
}

/** 一行的原文块：不支持的语法不转换器，连行首的 `-`／`|` 都照原样留下 */
const rawBlock = (line: string): ParsedBlock => ({
  inline: [text(line)],
  children: [],
})

export function parseMarkdown(source: string): MarkdownParse {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ParsedBlock[] = []
  /** 打开的节：源级只用来弹栈/压栈，落到输出里的只有父子关系 */
  const sections: Array<{ block: ParsedBlock; level: number }> = []
  /** 打开的多级列表：缩进只用来定父子，不落进块 */
  const lists: Array<{ block: ParsedBlock; indent: number }> = []
  const unsupported: string[] = []
  const note = (kind: string) => {
    if (!unsupported.includes(kind)) unsupported.push(kind)
  }
  const attach = (b: ParsedBlock) => {
    const top = sections[sections.length - 1]
    if (top) top.block.children.push(b)
    else blocks.push(b)
  }
  const closeLists = () => {
    lists.length = 0
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // 空行是段落分隔，不生成空块
    if (line.trim() === '') {
      closeLists()
      continue
    }

    // 围栏代码：整段原样带出，语言只作提示（编辑面在另一层决定怎么落）
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/.exec(line)
    if (fence) {
      closeLists()
      const mark = fence[1]![0]!
      const min = fence[1]!.length
      const close = new RegExp(`^\\s*${mark === '`' ? '`' : '~'}{${min},}\\s*$`)
      let j = i + 1
      while (j < lines.length && !close.test(lines[j]!)) j++
      const end = j < lines.length ? j : lines.length - 1
      attach({
        inline: [],
        code: lines.slice(i + 1, j < lines.length ? j : lines.length).join('\n'),
        kind: 'fence',
        ...(fence[2] ? { lang: fence[2] } : {}),
        raw: lines.slice(i, end + 1).join('\n'),
        children: [],
      })
      i = end
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeLists()
      const level = heading[1]!.length
      // 跳级按树归一：`# A` 后接 `### C` 会让 C 直接挂在 A 下
      while (sections.length > 0 && sections[sections.length - 1]!.level >= level) sections.pop()
      const b: ParsedBlock = { inline: inlineOf(heading[2]!), children: [] }
      attach(b)
      sections.push({ block: b, level })
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeLists()
      attach({ inline: [], kind: 'divider', children: [] })
      continue
    }

    if (/^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)) {
      closeLists()
      attach(rawBlock(line))
      note('task')
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeLists()
      attach(rawBlock(line))
      note('table')
      continue
    }
    if (/^\s*!\[[^\]]*\]\([^)]*\)/.test(line)) {
      closeLists()
      attach(rawBlock(line))
      note('image')
      continue
    }
    if (/^\s*<[A-Za-z]/.test(line)) {
      closeLists()
      attach(rawBlock(line))
      note('html')
      continue
    }
    if (/^\s*\[\^[^\]]+\]:/.test(line)) {
      closeLists()
      attach(rawBlock(line))
      note('footnote')
      continue
    }

    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      closeLists()
      attach({ inline: inlineOf(quote[1]!), kind: 'quote', children: [] })
      continue
    }

    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
    if (list) {
      const indent = list[1]!.replace(/\t/g, '  ').length
      while (lists.length > 0 && lists[lists.length - 1]!.indent >= indent) lists.pop()
      // 有序列表没有渲染承载 ⇒ 把编号留在正文里，不丢字也不假装成有序列表
      const body = /^\d+\./.test(list[2]!) ? `${list[2]!} ${list[3]!}` : list[3]!
      const b: ParsedBlock = { inline: inlineOf(body), children: [] }
      const parent = lists[lists.length - 1]
      if (parent) parent.block.children.push(b)
      else attach(b)
      lists.push({ block: b, indent })
      continue
    }

    closeLists()
    attach({ inline: inlineOf(line), children: [] })
  }

  return { blocks, unsupported }
}
