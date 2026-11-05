/**
 * 查询编译：用户输入 → FTS5 `MATCH` 表达式；以及**扫描降级**要的同一套词项。
 *
 * 一条硬规则（实测得来）：`chars` 列是逐字 token，查 `chars : 笔记` 会**静默 0 命中**；
 * 唯一正确写法是 `chars : "笔 记"`。所以这里的编译器对 CJK 永远产 phrase，
 * 并把它与 `seg` 词级匹配 OR 起来 —— `seg` 单用会漏「词中字」（`人口` 被 `人口密度` 吞），
 * `chars` 单用会过匹配（丢标点后相邻）。两条一起才是召回和精度都够的默认路径。
 *
 * 为什么查询编译是纯函数：web 扫描、FTS、以及单测都要**同一套词项**；
 * 各写一份就会得到「同一个词，两种结果」。
 */
import { charsOf, hasHan, latinRuns } from './tokenizer.ts'
import { isPropDefBlock, type Block } from '../model/model.ts'
import { plainText } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { displayTextOf } from '../identity/alias.ts'
import { tagIdsOf } from '../identity/tags.ts'

/** FTS5 字符串字面量：引号内的 `"` 要翻倍，否则查询语法会当场报错 */
function q(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

/**
 * 一段汉字 → 词级候选。
 *
 * 这里刻意**不**在查询端跑 jieba：分词器在 worker 里，查询是同步输入路径，
 * 为了编译一条查询去等一次 worker 往返只会让每个字都卡一下。用「整段 OR 相邻二字」
 * 覆盖词级：整段命中 jieba 没拆开的词，二字命中常用词；召回不够时还有 `chars` 兜底。
 */
function hanSegAlternatives(run: string): string {
  const parts: string[] = [`seg : ${q(run)}`]
  if (run.length >= 2) {
    const bigrams: string[] = []
    const cap = Math.min(run.length - 1, 8)
    for (let i = 0; i < cap; i++) bigrams.push(`seg : ${q(run.slice(i, i + 2))}`)
    parts.push(`(${bigrams.join(' AND ')})`)
  }
  return `(${parts.join(' OR ')})`
}

/** 一段拉丁／数字 → 词级候选（前缀，边打边搜） */
function latinSegAlternative(run: string): string {
  return `seg : ${q(run)}*`
}

/**
 * 一个空白分隔的词 → 一组 FTS 子句（OR 关系）。
 *
 * 返回 `''` 表示这个词没有可检索内容（全是标点）。
 */
function compileTerm(term: string): string {
  const clauses: string[] = []

  // 汉字：整段／二字词级 OR 逐字 phrase
  for (const run of term.match(/\p{Script=Han}+/gu) ?? []) {
    clauses.push(hanSegAlternatives(run))
    const chars = charsOf(run)
    if (chars !== '') clauses.push(`chars : ${q(chars)}`)
  }

  // 拉丁：原样前缀。英文词在 seg／chars 两列都有；拼音查询在下面单独加一支
  for (const run of latinRuns(term)) {
    clauses.push(latinSegAlternative(run))
    clauses.push(`chars : ${q(run)}*`)
  }

  return clauses.length === 0 ? '' : `(${clauses.join(' OR ')})`
}

/**
 * 用户输入 → `MATCH` 表达式；没有可检索词项 ⇒ `null`（调用方直接给空结果）。
 *
 * 多个空白分隔的词之间是 **AND**（「先搜到这些词都在的块」），每个词内部是 OR。
 */
export function compileMatch(input: string): string | null {
  const raw = input.trim()
  if (raw === '') return null
  const terms = raw.split(/\s+/).filter(Boolean)
  const clauses: string[] = []
  for (const term of terms) {
    const c = compileTerm(term)
    if (c !== '') clauses.push(c)
  }
  if (clauses.length === 0) return null
  const literal = clauses.length === 1 ? clauses[0]! : clauses.map((c) => `(${c})`).join(' AND ')

  /**
   * 纯拉丁输入**额外**走一支拼音：`"bi ji"*` 是「音节 bi 后面跟一个以 ji 开头的音节」。
   * 星号必须在引号**外**，写进引号里会被当成字面星号。
   *
   * ⚠️ 拼音与字面是 **OR**，不是 AND：用户输入 `ren kou` 时，正文里既没有
   * 「ren」这个词、也没有「kou」；若与字面条件 AND 起来，拼音这一支永远不会被看到。
   * 反过来，英文查询仍由字面那一支命中（拼音列里没有英文字母）。
   */
  if (!hasHan(raw)) {
    const syllables = terms
      .flatMap((term) => term.toLowerCase().match(/[a-z]+/g) ?? [])
      .filter((x) => x !== '')
    if (syllables.length > 0) return `(${literal}) OR (pinyin : ${q(syllables.join(' '))}*)`
  }

  return literal
}

/**
 * 扫描降级用的词项：与 FTS 的召回口径尽量对齐（每个空白词都要出现）。
 *
 * 为什么不做拼音：扫描要在每次按键上跑一遍全库，逐块算拼音会把「降级」变成更慢。
 * 拼音只在 FTS 就绪时可用；web 宿主因此只保证文本子串（明确的功能降级）。
 */
export function scanTerms(input: string): string[] {
  return input
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 扫描时这一块的可搜文本：正文投影 ＋ **标签名**。
 *
 * 为什么标签要单独补：正文投影只收 text run（`plainText` 的既定口径），
 * 行内 `#名` 是 ref run、归属 `_tags` 是属性——两者都不在正文里。FTS 有独立的
 * tag 行兜住它们；扫描降级若只读正文，就会「明明打了标签却搜不到（web / 索引未就绪）」。
 * 名字走 `displayTextOf` 现算，与 FTS 的标签行同一个口径。
 *
 * 只补标签（不补别名／属性／外链）：扫描是无索引时的兜底，每多一个来源就多一次
 * 逐块解析；标签是用户最常直接搜的那一类，其余来源在索引就绪后由 FTS 覆盖。
 */
function scanTextOf(b: Block, byId: ReadonlyMap<string, Block>): string {
  let out = plainText(b.content)
  const names: string[] = []
  for (const tid of new Set(tagIdsOf(b))) {
    const t = byId.get(tid)
    if (t) names.push(displayTextOf(t))
  }
  // 行内 `#名` 是提及不是归属（不写 `_tags`）⇒ 只能从 run 里取
  for (const r of b.content) {
    if (r.t !== 'ref' || r.flavor !== '#' || !r.to) continue
    const t = byId.get(r.to)
    if (t) names.push(displayTextOf(t))
  }
  const tags = names.filter((x) => x.trim() !== '').join(' ')
  if (tags !== '') out = out === '' ? tags : `${out} ${tags}`
  return out
}

/** 扫描替身：返回命中的块 id（森林先序，与查询的缺省顺序同一口径） */
export function scanSearch(roots: readonly Block[], input: string, limit: number): string[] {
  const terms = scanTerms(input)
  if (terms.length === 0 || limit <= 0) return []
  // 标签名住在别的块里：扫两遍森林（第一遍建查找表，第二遍匹配），仍是 O(n)
  const byId = new Map<string, Block>()
  walkForest(roots, (b) => {
    byId.set(b.id, b)
  })
  const out: string[] = []
  walkForest(roots, (b, ctx) => {
    // 属性定义的子树是「这栏能选什么」，不是内容行（与查询求值同一口径）
    if (ctx.path.slice(0, -1).some(isPropDefBlock)) return
    const text = scanTextOf(b, byId).toLowerCase()
    if (text === '') return
    if (!terms.every((t) => text.includes(t))) return
    out.push(b.id)
    return out.length >= limit ? false : undefined
  })
  return out
}

/* ------------------------------------------------------------ 片段与高亮 */

export interface TextPart {
  text: string
  /** 这一段命中查询词，渲染端标成 `mark` */
  mark?: boolean
}

interface Range {
  start: number
  end: number
}

/**
 * 从正文里截一段结果片段，并标出命中位置。
 *
 * 只在**字面**命中的词上打标：拼音命中没有字面对应，片段从开头截、不硬标
 * （宁可少一个高亮，也不要标错一段字）。
 */
export function highlightSnippet(text: string, input: string, max = 96): TextPart[] {
  const terms = input
    .trim()
    .split(/\s+/)
    .map((x) => x.toLowerCase())
    .filter(Boolean)
  const lower = text.toLowerCase()
  const ranges: Range[] = []
  for (const term of terms) {
    let from = 0
    while (from < lower.length) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      ranges.push({ start: at, end: at + term.length })
      from = at + term.length
    }
  }
  ranges.sort((a, b) => a.start - b.start)

  const first = ranges[0]?.start ?? 0
  const start = first > 24 ? first - 16 : 0
  let end = Math.min(text.length, start + max)
  // 不让窗口正好切在命中片段中间：命中尾巴超出时把窗口往后推
  const overflowing = ranges.find((r) => r.start < end && r.end > end)
  if (overflowing) end = Math.min(text.length, overflowing.end)
  const slice = text.slice(start, end)

  const parts: TextPart[] = []
  if (start > 0) parts.push({ text: '…' })
  let cursor = 0
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) continue
    const s = Math.max(r.start, start) - start
    const e = Math.min(r.end, end) - start
    if (s < cursor) continue
    if (s > cursor) parts.push({ text: slice.slice(cursor, s) })
    parts.push({ text: slice.slice(s, e), mark: true })
    cursor = e
  }
  if (cursor < slice.length) parts.push({ text: slice.slice(cursor) })
  if (end < text.length) parts.push({ text: '…' })
  return parts.length > 0 ? parts : [{ text: slice }]
}
