/**
 * **行内内容 ＝ run 序列**（纯函数层，零 DOM、零持久化）。
 *
 * 一个块的正文不是一根字符串，而是一列 run：文本段（`text`）与行内原子
 * （`ref` 引用／`link` 外链／`image` 图片）。原子是**不可分节点**——它没有「半格」，
 * 位置由邻居天然携带，所以不需要任何偏移映射机制；格式（粗体等）是 run 上的
 * 属性集合，编辑文本时格式跟着 run 走，天然粘性。
 *
 * ## 两套坐标（本文件所有 `start/end/off` 参数都要先问自己用的是哪套）
 *
 * | 坐标 | 定义 | 谁在用 |
 * |---|---|---|
 * | **plain 偏移** | 文本字符数 ＋ 每个原子算 1 格（与 DOM 展示同一坐标系） | 选区/光标/IME、run 切片、anno.range |
 * | **投影偏移** | `plainText(content)` 里的位置（原子贡献 0） | quote 引文快照（exact 必须是投影的子串） |
 *
 * 两者在有原子的块上不相等——`projectOff`/`projectRange` 负责换算，别手算。
 *
 * ## 归一化（幂等，可测断言）
 *
 * 相邻同形 text run（同 marks）合并、空文本段清除、marks 去重排序、
 * image run 永不携带 marks（格式对位图没有视觉对应物）。所有写入口的产出
 * 都经过 `normalizeRuns`，于是「库里的内容只有一种等价形状」。
 */
import { uuidv7Hex } from './ids.ts'

/** 行内格式的封闭种类（bold/italic/highlight/code）。 */
export type MarkType = 'bold' | 'italic' | 'highlight' | 'code'

export const MARK_TYPES: readonly MarkType[] = ['bold', 'italic', 'highlight', 'code']

/* ------------------------------------------------------------- run 形状 */

export interface TextRun {
  t: 'text'
  v: string
  /** 粗体/斜体/高亮/代码；集合语义，无序；没有格式就不写这个键 */
  marks?: MarkType[]
}

/**
 * 引用 run：指向另一个块。
 *
 * - `to` 可选：解析不到目标就是没有目标（dangling 是派生态，不造假 id）；
 * - `flavor: '#'` ＝ 行内标签的显示风味（显示成 `#名`、点击跳目标），
 *   它与普通引用是**同一种 run**，只是呈现不同；
 * - `label` 是**插入时的名字快照**，只在目标找不到时当兜底显示名——
 *   目标改名后它就是过期的字，显示名一律现算（`core/ref.ts`）。
 */
export interface RefRun {
  id: string
  t: 'ref'
  to?: string
  flavor?: '#'
  label?: string
  marks?: MarkType[]
}

/** 外链 run：`v` 是显示文本，`url` 是目标。外链不产生块间边。 */
export interface LinkRun {
  id: string
  t: 'link'
  v: string
  url: string
  marks?: MarkType[]
}

/**
 * 图片 run：**行内小图**（整张贴图作为内容是资产块的事，不在这层）。
 *
 * `asset` 只存定位信息：`bytes` 这类载荷住在资产侧，行内内容不携带载荷——
 * 否则同一次粘贴会在正文里留两份二进制，改一处就与另一处分叉。
 * `w/h` 只做宽高比占位（防加载跳动），不是尺寸约束。
 *
 * ⚠️ 唯一不许携带 marks 的 run：四种格式对位图都没有对应物，
 *    「技术上能盖上」不构成开禁的理由。
 */
export interface ImageRun {
  id: string
  t: 'image'
  asset: { hash: string; name?: string; state: 'ready' | 'missing' }
  w?: number
  h?: number
}

/** 一个 run。判别键 `t` 开放扩展（插件自定义种类从这型往外长）。 */
export type Run = TextRun | RefRun | LinkRun | ImageRun

/** 带身份的 run（原子节点：编辑器按不可分元素对待）。 */
export type RunWithId = RefRun | LinkRun | ImageRun

/** 一块的行内内容。空块 ＝ `[]`。 */
export type Content = readonly Run[]

export function isAtomicRun(r: Run): r is RunWithId {
  return r.t !== 'text'
}

/* ------------------------------------------------------------- anno 形状 */

/**
 * **可引用区间**（按需物化）：只有「被别处引用」时才存在，住所在块上。
 *
 * 抗失效三层：
 * ① `range` 位置锚（plain 偏移对，**缓存**——文本变了它可以漂，漂了靠②找回）；
 * ② `quote` 引文快照（`exact` 是 `plainText` 投影的子串，`prefix/suffix` 是上下文）；
 * ③ `version`（并发下的版本状态；本地单写者阶段用不到，留给协作）。
 *
 * `id` 全局唯一且**不许换**：它是别人引用的地址，换 id ＝ 静默杀死那些引用。
 */
export interface Anno {
  id: string
  range: { start: number; end: number }
  quote?: { exact: string; prefix: string; suffix: string }
  version?: number
}

/* ------------------------------------------------------------- 投影 */

/**
 * `plainText`＝text run 的 `v` 依序 join。ref/link/image **不进投影**——
 * 它们不是文本流的一部分（搜索/导出/引文都按这个口径，永不各说一套）。
 */
export function plainText(content: Content): string {
  let out = ''
  for (const r of content) if (r.t === 'text') out += r.v
  return out
}

/** plain 偏移总量（文本字符数 ＋ 原子各 1 格）。选区/光标/切片都以它为长度。 */
export function plainLen(content: Content): number {
  let n = 0
  for (const r of content) n += r.t === 'text' ? r.v.length : 1
  return n
}

/** 空内容判定（空块）。等价 `plainLen(content) === 0`，但不用数长度。 */
export function isEmptyContent(content: Content): boolean {
  return content.length === 0
}

/* ------------------------------------------------------------- 归一化 */

function normMarks(marks: readonly MarkType[] | undefined): MarkType[] | undefined {
  if (!marks || marks.length === 0) return undefined
  // 集合语义 ⇒ 存储形状固定为「去重 ＋ 固定序」，等价内容只有一种形状
  const sorted = [...new Set(marks)].sort((a, b) => a.localeCompare(b))
  return sorted.length === 0 ? undefined : sorted
}

/** 两个 marks 集合等价（归一化后逐项比） */
function sameMarks(a: MarkType[] | undefined, b: MarkType[] | undefined): boolean {
  const x = normMarks(a)
  const y = normMarks(b)
  if (x === undefined || y === undefined) return x === y
  return x.length === y.length && x.every((m, i) => m === y[i])
}

function withoutMarks<T extends object>(r: T): T {
  if (!('marks' in r) || (r as { marks?: MarkType[] }).marks === undefined) return r
  const copy = { ...r } as T & { marks?: MarkType[] }
  delete copy.marks
  return copy
}

/**
 * 归一化：相邻同形 text run 合并、空文本段清除、marks 去重排序、
 * image 的 marks 剥掉。**幂等**（`normalizeRuns(normalizeRuns(x))` 逐字节相等）——
 * 这条是写入口的纪律：库里永远只存规范形态，「碰过但没改」才可能被识别出来。
 */
export function normalizeRuns(content: Content): Run[] {
  const out: Run[] = []
  for (const r of content) {
    if (r.t === 'text') {
      if (r.v === '') continue
      const marks = normMarks(r.marks)
      const last = out[out.length - 1]
      if (last?.t === 'text' && sameMarks(last.marks, marks)) {
        last.v += r.v
        continue
      }
      out.push(marks === undefined ? { t: 'text', v: r.v } : { t: 'text', v: r.v, marks })
      continue
    }
    if (r.t === 'image') {
      // 红线：格式不上 image run。写入时剥掉，不靠每个调用方自觉。
      out.push(withoutMarks(r))
      continue
    }
    const marks = normMarks(r.marks)
    out.push(marks === undefined ? withoutMarks(r) : ({ ...r, marks } as RunWithId))
  }
  return out
}

/** 内容等价（按归一化形态比）。DOM 同步用：「碰过但没改」不值得发一次写。 */
export function sameRuns(a: Content, b: Content): boolean {
  return JSON.stringify(normalizeRuns(a)) === JSON.stringify(normalizeRuns(b))
}

/** 一段纯文本 → text run（空串 → 空内容）。新块/粘贴/程序化写入的入口。 */
export function textRuns(v: string, marks?: readonly MarkType[]): Run[] {
  const m = normMarks(marks)
  return v === '' ? [] : m ? [{ t: 'text', v, marks: m }] : [{ t: 'text', v }]
}

/* ------------------------------------------------------- run 定位 */

export interface RunCursor {
  /** run 下标（`content[cursor.index]`） */
  index: number
  /** run 内偏移：text ＝ 字符数；原子 ＝ 0（前缘）或 1（后缘） */
  inner: number
}

/**
 * plain 偏移 → run 游标。**派生量**：算出来就用、不持久化——
 * 真正存着的只有 content 本身，任何「当前光标在哪个 run」都是现算的。
 *
 * 边界约定：偏移落在原子**前缘**（`inner: 0`）算命中该原子，
 * 落在**后缘**（`inner: 1`）移到下一个 run。
 */
export function locateCursor(content: Content, off: number): RunCursor {
  const len = plainLen(content)
  const o = Math.max(0, Math.min(off, len))
  let acc = 0
  for (let i = 0; i < content.length; i++) {
    const r = content[i]!
    const w = r.t === 'text' ? r.v.length : 1
    if (o < acc + w) return { index: i, inner: o - acc }
    acc += w
  }
  if (content.length === 0) return { index: 0, inner: 0 }
  const last = content[content.length - 1]!
  return { index: content.length - 1, inner: last.t === 'text' ? last.v.length : 1 }
}

/* ------------------------------------------------------- 切片与拼接 */

/**
 * 取 plain 偏移区间 `[start, end)` 的内容为新的 run 序列。
 *
 * 原子不可分 ⇒ 它要么整枚在区间里（`cellStart >= start && cellEnd <= end`），
 * 要么整枚不在——不存在「半个原子」。文本在边界处截断。
 */
export function sliceRuns(content: Content, start: number, end: number): Run[] {
  const s = Math.max(0, start)
  const e = Math.min(end, plainLen(content))
  if (s >= e) return []
  const out: Run[] = []
  let acc = 0
  for (const r of content) {
    if (r.t === 'text') {
      const rs = acc
      const re = acc + r.v.length
      if (re > s && rs < e) {
        const seg = r.v.slice(Math.max(0, s - rs), Math.min(r.v.length, e - rs))
        out.push(...textRuns(seg, r.marks))
      }
      acc = re
      continue
    }
    const cell = acc
    if (cell >= s && cell + 1 <= e) out.push(r)
    acc = cell + 1
  }
  return out
}

/** 在 plain 偏移处切成两半（拆块用）。切点落在原子上 ⇒ 原子归右半。 */
export function splitRuns(content: Content, off: number): [Run[], Run[]] {
  const o = Math.max(0, Math.min(off, plainLen(content)))
  return [sliceRuns(content, 0, o), sliceRuns(content, o, plainLen(content))]
}

/** 拼接两段内容（合并块用）：边界两侧同形的 text run 会并成一个。 */
export function joinRuns(left: Content, right: Content): Run[] {
  return normalizeRuns([...left, ...right])
}

/**
 * 替换 plain 偏移区间 `[from, to)`：插入一段纯文本（继承**左邻** text run 的
 * 格式——打字是延续，不是新起一段）或一列现成的 run。
 *
 * 被区间**完整覆盖**的原子整枚消失（区间盖住它就是一次显式删除），
 * 区间外的原子一个字节不动——「删旁边的字顺手吃掉引用框」在结构上不可能。
 */
export function spliceRuns(content: Content, from: number, to: number, insert: string | readonly Run[]): Run[] {
  const len = plainLen(content)
  const f = Math.max(0, Math.min(from, len))
  const t = Math.max(f, Math.min(to, len))
  const ins: Run[] = typeof insert === 'string' ? textRuns(insert, insertFrom(content, f)) : [...insert]
  return normalizeRuns([...sliceRuns(content, 0, f), ...ins, ...sliceRuns(content, t, len)])
}

/** 插入点左邻 text run 的格式（插入纯文本时继承它）。 */
function insertFrom(content: Content, off: number): MarkType[] | undefined {
  const cur = locateCursor(content, off)
  // 光标在 text run 内部/后缘 ⇒ 延续它自己的格式（原子后缘不继承原子的格式）
  const r = content[cur.index]
  if (r && r.t === 'text' && cur.inner > 0) return r.marks
  // 前一个 run 是 text ⇒ 延续它（在原子前缘打字跟随上一段的格式）
  const prev = content[cur.index - 1]
  if (prev?.t === 'text') return prev.marks
  return undefined
}

/** 在 plain 偏移处插入一枚原子 run（插引用/图片的落点）。 */
export function insertRunAt(content: Content, off: number, run: RunWithId): Run[] {
  return spliceRuns(content, off, off, [run])
}

/** 按 run id 找原子。 */
export function runById(content: Content, runId: string): RunWithId | undefined {
  for (const r of content) if (isAtomicRun(r) && r.id === runId) return r
  return undefined
}

/** 按 run id 删掉一枚原子（popover 的「删除」入口）。文本不受影响；两侧同形段照常合并。 */
export function removeRunById(content: Content, runId: string): Run[] {
  return normalizeRuns(content.filter((r) => !isAtomicRun(r) || r.id !== runId))
}

/* ------------------------------------------------------- 格式运算 */

/** 区间 `[start, end)` 是否已被 `type` 完全覆盖（决定 ⌘B 是加还是取消）。 */
export function isCovered(content: Content, type: MarkType, start: number, end: number): boolean {
  if (start >= end) return false
  let acc = 0
  let sawRange = false
  let coveredAll = true
  for (const r of content) {
    if (r.t === 'text') {
      const rs = acc
      const re = acc + r.v.length
      if (Math.max(rs, start) < Math.min(re, end)) {
        sawRange = true
        if (!r.marks?.includes(type)) coveredAll = false
      }
      acc = re
      continue
    }
    const cell = acc
    if (cell >= start && cell + 1 <= end) {
      sawRange = true
      // image 拿不了格式：区间里有它就永远「未全覆盖」⇒ toggle 走加的一支（它自己仍不动）
      if (r.t === 'image' || !r.marks?.includes(type)) coveredAll = false
    }
    acc = cell + 1
  }
  return sawRange && coveredAll
}

/**
 * ⌘B 手感：全覆盖 ⇒ 取消；否则 ⇒ 加。按 run 序列运算：文本在边界拆 run、
 * 覆盖段改 marks；ref/link 整枚改（不可分 ⇒ 零拆分成本）；image 永远不动。
 */
export function toggleMark(content: Content, type: MarkType, start: number, end: number): Run[] {
  if (start >= end) return normalizeRuns(content)
  const removing = isCovered(content, type, start, end)
  const out: Run[] = []
  let acc = 0
  for (const r of content) {
    if (r.t === 'text') {
      const rs = acc
      const re = acc + r.v.length
      const os = Math.max(rs, start)
      const oe = Math.min(re, end)
      if (os >= oe) {
        out.push(r)
        acc = re
        continue
      }
      // 至多三段：左（不动）/ 中（覆盖，改格式）/ 右（不动）
      if (os > rs) out.push(...textRuns(r.v.slice(0, os - rs), r.marks))
      out.push(...textRuns(r.v.slice(os - rs, oe - rs), flipMarks(r.marks, type, removing)))
      if (oe < re) out.push(...textRuns(r.v.slice(oe - rs), r.marks))
      acc = re
      continue
    }
    const cell = acc
    if (cell >= start && cell + 1 <= end && r.t !== 'image') {
      out.push({ ...r, marks: flipMarks(r.marks, type, removing) } as RunWithId)
    } else {
      out.push(r)
    }
    acc = cell + 1
  }
  return normalizeRuns(out)
}

/** 清掉区间上的**全部**格式（四种一起）。image 无格式可清，天然不动。 */
export function clearMarks(content: Content, start: number, end: number): Run[] {
  if (start >= end) return normalizeRuns(content)
  const out: Run[] = []
  let acc = 0
  for (const r of content) {
    if (r.t === 'text') {
      const rs = acc
      const re = acc + r.v.length
      const os = Math.max(rs, start)
      const oe = Math.min(re, end)
      if (os >= oe) {
        out.push(r)
        acc = re
        continue
      }
      if (os > rs) out.push(...textRuns(r.v.slice(0, os - rs), r.marks))
      out.push(...textRuns(r.v.slice(os - rs, oe - rs)))
      if (oe < re) out.push(...textRuns(r.v.slice(oe - rs), r.marks))
      acc = re
      continue
    }
    const cell = acc
    if (cell >= start && cell + 1 <= end && r.t !== 'image') {
      out.push(withoutMarks(r))
    } else {
      out.push(r)
    }
    acc = cell + 1
  }
  return normalizeRuns(out)
}

function flipMarks(marks: MarkType[] | undefined, type: MarkType, removing: boolean): MarkType[] | undefined {
  if (removing) {
    const next = (marks ?? []).filter((m) => m !== type)
    return next.length === 0 ? undefined : next
  }
  return normMarks([...(marks ?? []), type])
}

/** 区间上**出现过**哪些格式（划选气泡的按压态：亮着的不一定是全覆盖）。 */
export function marksInRange(content: Content, start: number, end: number): MarkType[] {
  const out = new Set<MarkType>()
  let acc = 0
  for (const r of content) {
    if (r.t === 'text') {
      const re = acc + r.v.length
      if (Math.max(acc, start) < Math.min(re, end)) for (const m of r.marks ?? []) out.add(m)
      acc = re
      continue
    }
    const cell = acc
    // image 没有格式可报；写在这里只是让类型收窄，语义等价（它永远没有 marks）
    if (cell >= start && cell + 1 <= end && r.t !== 'image') for (const m of r.marks ?? []) out.add(m)
    acc = cell + 1
  }
  return [...out].sort((a, b) => a.localeCompare(b))
}

/* ------------------------------------------------------- 原子与边 */

/** 内容里的引用 run（按出现序）。指向边、行内标签露面都从这提取。 */
export function refRunsOf(content: Content): RefRun[] {
  const out: RefRun[] = []
  for (const r of content) if (r.t === 'ref') out.push(r)
  return out
}

/**
 * 复制内容并给所有原子发**新 id**。
 *
 * 复制的是内容不是身份：两枚同名引用是两个独立的行内对象，
 * 各自有自己的「诞生时刻」；共用水久 id 会让「按 run id 删这一枚」
 * 变成「删掉两枚」。
 */
export function cloneRunsNewIds(content: Content): Run[] {
  return content.map((r) => (isAtomicRun(r) ? ({ ...r, id: uuidv7Hex() } as RunWithId) : { ...r }))
}

/* --------------------------------------------------- 投影坐标换算 */

/** plain 偏移 → 投影偏移（原子贡献 0）。引文快照的坐标是投影，不是 plain。 */
export function projectOff(content: Content, off: number): number {
  const o = Math.max(0, Math.min(off, plainLen(content)))
  let plain = 0
  let proj = 0
  for (const r of content) {
    if (r.t === 'text') {
      const re = plain + r.v.length
      if (o <= re) return proj + (o - plain)
      proj += r.v.length
      plain = re
      continue
    }
    plain += 1
  }
  return proj
}

/**
 * 投影偏移 → plain 偏移（`projectOff` 的逆；`fromProjection(projectOff(x)) = x`
 * 对所有落在文本上的点成立）。「在纯文本里找到的位置」要拿回 run 序列上操作时用它。
 */
export function fromProjection(content: Content, projOff: number): number {
  let plain = 0
  let proj = 0
  for (const r of content) {
    if (r.t === 'text') {
      const re = plain + r.v.length
      const pe = proj + r.v.length
      if (projOff < pe || (projOff === pe && re === plainLen(content))) return plain + (projOff - proj)
      proj = pe
      plain = re
      continue
    }
    plain += 1
  }
  return plain
}

/**
 * 取 plain 区间的**引文快照**：`exact` 是 `plainText` 的子串、
 * `prefix/suffix` 各取 20 字上下文。选区里没有文本（纯原子）⇒ `null`：
 * 引文是文本的属性，没有文本就没有引文，不造空快照。
 */
export function projectRange(
  content: Content,
  start: number,
  end: number,
): { exact: string; prefix: string; suffix: string } | null {
  const plain = plainText(content)
  const ps = projectOff(content, Math.min(start, end))
  const pe = projectOff(content, Math.max(start, end))
  const exact = plain.slice(ps, pe)
  if (exact === '') return null
  return {
    exact,
    prefix: plain.slice(Math.max(0, ps - 20), ps),
    suffix: plain.slice(pe, pe + 20),
  }
}

/**
 * 从一个 plain 选区**物化一条 anno**（「引用这段」的落点）。
 *
 * `range` 用 plain 坐标（与选区同系，可直接缓存）；`quote` 用投影坐标换算出来
 * （`exact` 恒为投影子串，永不与投影各说一套）。没有文本 ⇒ `null`——
 * 引用一段纯原子没有可定位的东西，走整块引用。
 */
export function mkAnno(content: Content, start: number, end: number): Anno | null {
  const quote = projectRange(content, start, end)
  if (!quote) return null
  return { id: uuidv7Hex(), range: { start: Math.min(start, end), end: Math.max(start, end) }, quote }
}

/* ------------------------------------------------------- 形状校验 */

const MARK_SET: ReadonlySet<string> = new Set(['bold', 'italic', 'highlight', 'code'])

function isMarks(x: unknown): x is MarkType[] {
  return Array.isArray(x) && x.every((m) => typeof m === 'string' && MARK_SET.has(m))
}

/** 落盘形状校验用：这真的是一个合法 run 吗（image 带 marks 一律判非法）。 */
export function isRun(x: unknown): x is Run {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (r.marks !== undefined && !isMarks(r.marks)) return false
  switch (r.t) {
    case 'text':
      return typeof r.v === 'string'
    case 'ref':
      return (
        typeof r.id === 'string' &&
        (r.to === undefined || typeof r.to === 'string') &&
        (r.label === undefined || typeof r.label === 'string') &&
        (r.flavor === undefined || r.flavor === '#')
      )
    case 'link':
      return typeof r.id === 'string' && typeof r.v === 'string' && typeof r.url === 'string'
    case 'image': {
      if (r.marks !== undefined) return false
      const a = r.asset
      if (!a || typeof a !== 'object') return false
      const asset = a as Record<string, unknown>
      return (
        typeof r.id === 'string' &&
        typeof asset.hash === 'string' &&
        (asset.name === undefined || typeof asset.name === 'string') &&
        (asset.state === 'ready' || asset.state === 'missing')
      )
    }
    default:
      return false
  }
}

/** 落盘形状校验用：这是一条合法 anno 吗。 */
export function isAnno(x: unknown): x is Anno {
  if (!x || typeof x !== 'object') return false
  const a = x as Record<string, unknown>
  if (typeof a.id !== 'string' || !a.range || typeof a.range !== 'object') return false
  const rg = a.range as Record<string, unknown>
  if (typeof rg.start !== 'number' || typeof rg.end !== 'number') return false
  if (a.quote !== undefined) {
    const q = a.quote as Record<string, unknown>
    if (!q || typeof q !== 'object') return false
    if (typeof q.exact !== 'string' || typeof q.prefix !== 'string' || typeof q.suffix !== 'string') return false
  }
  return a.version === undefined || typeof a.version === 'number'
}
