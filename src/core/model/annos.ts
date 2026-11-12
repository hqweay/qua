/**
 * **anno 区间的映射与重定位**（纯函数层，零 DOM、零持久化）。
 *
 * `anno.range` 是「这一刻的位置缓存」，不是真相：正文一改它就会漂。维护点只有一处 ——
 * `writeBlockContent`（全仓唯一内容写入口）；本文件提供它要用的两个纯判据：
 * 改了哪一段（公共前缀/后缀剥离）、漂了怎么找回（引文重定位）。
 *
 * 两套坐标（与 `runs.ts` 同一份口径，别手算）：
 *   · `range` 用 **plain 偏移**（文本字符 ＋ 原子各 1 格，与选区同系）；
 *   · `quote.exact/prefix/suffix` 用 **plainText 投影**（原子贡献 0）。
 * 两者靠 `projectOff` / `fromProjection` 换算。
 *
 * ⚠️ 全程不生成、不更换 anno 的 id：它是别人引用的地址，换 id ＝ 静默杀死那些引用。
 */
import {
  fromProjection,
  plainLen,
  plainText,
  projectOff,
  type Anno,
  type Content,
} from './runs.ts'

/** 一格一字符的比较串：原子用 U+FFFC 占位（与「U+FFFC 不进 quote」同族）。只在内存里比，不落盘。 */
const ATOM_CELL = '\uFFFC'

function cellsOf(content: Content): string {
  let out = ''
  for (const r of content) out += r.t === 'text' ? r.v : ATOM_CELL
  return out
}

export interface ContentEdit {
  /** 改前被替换区间的起点（plain） */
  from: number
  /** 改前被替换区间的终点（plain） */
  to: number
  /** 插入的格数 */
  inserted: number
}

/**
 * 公共前缀/后缀剥离：局部编辑（打一字、删一字、粘一段）时前后缀几乎覆盖全长，
 * 中间那段就是 splice 参数，**O(n) 且精确**。整块替换退化成一个大区间 ⇒ 交给 quote 重定位。
 *
 * 只看「格」（文本字符 / 原子），不看格式：格式变了但字没变，剥出来的就是空编辑。
 */
export function editSpanOf(before: Content, after: Content): ContentEdit {
  const a = cellsOf(before)
  const b = cellsOf(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  return { from: pre, to: a.length - suf, inserted: b.length - pre - suf }
}

/** 格式操作（toggleMark／clearMarks）不改 plain 长度 ⇒ 剥出这个形状，锚一个都不动。 */
export function isFormatOnlyEdit(e: ContentEdit): boolean {
  return e.from === e.to && e.inserted === 0
}

/**
 * 按一次编辑平移 / 重定位区间。
 *
 * 判据（写字不改 id）：
 *   · 完全在编辑点之前 ⇒ 不动；
 *   · 完全在编辑点之后 ⇒ 整体平移 `delta`；
 *   · 与编辑区间相交 ⇒ 用 quote 重定位；找不回就**保留旧 range 漂着**（id 与 quote 都在，
 *     下次任何读点还能再试），绝不删条、绝不换 id。
 *   · 整块替换（前缀后缀都剥不动）⇒ 所有区间都相交 ⇒ 整批走重定位。
 */
export function mapAnnos(before: Content, after: Content, annos: readonly Anno[]): Anno[] {
  if (annos.length === 0) return []
  const edit = editSpanOf(before, after)
  if (isFormatOnlyEdit(edit)) return [...annos]
  const delta = edit.inserted - (edit.to - edit.from)
  return annos.map((a) => {
    if (a.range.end <= edit.from) return { ...a }
    if (a.range.start >= edit.to) {
      return { ...a, range: { start: a.range.start + delta, end: a.range.end + delta } }
    }
    return relocateAnno(after, a) ?? { ...a }
  })
}

/**
 * 引文重定位：在 `quote.exact` 的完整出现里，挑「上下文最像 ＋ 离原位置最近」的一处。
 *
 * 口径（本轮判断，可证伪）：
 *   · **不缩短 exact** —— 缩短会匹配到别的句子，那是「看起来找回了其实找错了」的
 *     静默坏法，比显式失效更糟。exact 不再完整出现 ⇒ 判失效（返回 `null`）。
 *   · 多义命中先按 prefix/suffix 吻合数打分，再按离原 range 的距离裁决
 *     （编辑通常是局部的，最近的那处最可能是同一句）。
 *   · 都不像时仍取最近的一处，不臆造新位置。
 *
 * 返回的是**换过 range 的新 anno**（id/quote 原样带回），改不动就 `null`。
 */
export function relocateAnno(content: Content, anno: Anno): Anno | null {
  const q = anno.quote
  if (!q || q.exact === '') return null
  const plain = plainText(content)
  const hits: number[] = []
  for (let i = plain.indexOf(q.exact); i >= 0; i = plain.indexOf(q.exact, i + 1)) hits.push(i)
  if (hits.length === 0) return null
  const anchor = projectOff(content, Math.min(Math.max(0, anno.range.start), plainLen(content)))
  const scored = hits.map((p) => ({
    p,
    ctx:
      (plain.slice(Math.max(0, p - q.prefix.length), p) === q.prefix ? 1 : 0) +
      (plain.slice(p + q.exact.length, p + q.exact.length + q.suffix.length) === q.suffix ? 1 : 0),
    dist: Math.abs(p - anchor),
  }))
  scored.sort((x, y) => y.ctx - x.ctx || x.dist - y.dist || x.p - y.p)
  const best = scored[0]!
  return {
    ...anno,
    range: {
      start: fromProjection(content, best.p),
      end: fromProjection(content, best.p + q.exact.length),
    },
  }
}

/** 合并：把被并块的 annos 按粘接点平移后并进保留块（id 一个不换）。 */
export function shiftAnnos(annos: readonly Anno[] | undefined, at: number): Anno[] {
  return (annos ?? []).map((a) => ({ ...a, range: { start: a.range.start + at, end: a.range.end + at } }))
}

/**
 * 拆块：切点两侧的 annos 各归各块；跨切点的那条**留在原块**，不拆成两条 ——
 * 拆就要生成新 id，而 id 是引用目标。左半 range 不变，右半减 `off`；跨切点的
 * 裁成右半那截（quote 仍在，下次重定位还能找回完整句子）。
 */
export function splitAnnos(
  annos: readonly Anno[] | undefined,
  off: number,
): { left: Anno[]; right: Anno[] } {
  const left: Anno[] = []
  const right: Anno[] = []
  for (const a of annos ?? []) {
    if (a.range.end <= off) left.push({ ...a })
    else if (a.range.start >= off) right.push({ ...a, range: { start: a.range.start - off, end: a.range.end - off } })
    else right.push({ ...a, range: { start: 0, end: Math.max(0, a.range.end - off) } })
  }
  return { left, right }
}
