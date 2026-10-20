/** 行内原子在文本里的占位字符（统一用 U+FFFC） */
export const ATOM_PLACEHOLDER = '\uFFFC'

/**
 * 行内锚点：Mark（四型）／Atom（长度 1 的引用与图片）／粘性映射／规范化。
 * ⚠️ 它们是**区间**，不是 run 属性；结构上带 `blockId` ⇒ 不跨块。
 */

import { uuidv7Hex } from './ids.ts'
import { flatten, locate } from './tree.ts'
import type { Doc } from './model.ts'
import { mapOffset, type TextChange } from './text.ts'
export type MarkType = 'bold' | 'italic' | 'highlight' | 'code'

export const MARK_TYPES: readonly MarkType[] = ['bold', 'italic', 'highlight', 'code']

/** 区间锚点（对应的 annos；自研形状，**带 blockId ⇒ 结构性不跨块**） */
export interface Mark {
  id: string
  type: MarkType
  blockId: string
  start: number
  end: number
}

/* ------------------------------------------------------ 行内原子（atoms） */

export type AtomKind = 'page' | 'image'

/**
 * 行内原子：**一个只占 1 个字符位置的区间锚点**（`end = start + 1`，文本里那一格是 U+FFFC）。
 * - 引用：`target` 指向**实体 id**，不指向裸坐标 ⇒ 目标改名/移动不影响；
 * - 引文快照：`quote` C `TextQuoteSelector`；demo 里已随原子一起存；
 * - 图片：`asset` 是资产引用（hash 命名），`state: 'missing'` 演示「资产不可用是状态不是错误」。
 */
export interface Atom {
  id: string
  kind: AtomKind
  blockId: string
  start: number
  end: number
  label: string
  target?: { kind: 'page' | 'block'; id: string }
  quote?: { exact: string; prefix: string; suffix: string }
  asset?: { hash: string; name: string; bytes: number; mime: string; state: 'ready' | 'missing'; w?: number; h?: number }
  /** 引用是否还能解析到实体（状态机的 demo 版：resolved | dangling） */
  state?: 'resolved' | 'dangling'
}

export function mkAtom(kind: AtomKind, blockId: string, start: number, label: string, extra: Partial<Atom> = {}): Atom {
  return { id: uuidv7Hex(), kind, blockId, start, end: start + 1, label, ...extra }
}

/* ----------------------------------------------------------- tree utils */

export function mapMarks(marks: readonly Mark[], blockId: string, c: TextChange): Mark[] {
  const out: Mark[] = []
  for (const m of marks) {
    if (m.blockId !== blockId) {
      out.push(m)
      continue
    }
    const start = mapOffset(m.start, c, 1)
    const end = mapOffset(m.end, c, -1)
    if (start < end) out.push({ ...m, start, end })
  }
  return out
}

/** **朴素映射**（两端都用 bias=+1）：负面对照，证明「默认会吞」 */
export function mapMarksNaive(marks: readonly Mark[], blockId: string, c: TextChange): Mark[] {
  const out: Mark[] = []
  for (const m of marks) {
    if (m.blockId !== blockId) continue
    const start = mapOffset(m.start, c, 1)
    const end = mapOffset(m.end, c, 1)
    if (start < end) out.push({ ...m, start, end })
  }
  return out
}

export interface AtomMapResult {
  kept: Atom[]
  /** 占位符被删/被替换 ⇒ 原子失效（不可静默，调用方应提示） */
  lost: Atom[]
}

/**
 * 原子锚点的粘性映射：与 marks 同一套 `mapOffset`。
 * 原子恒占 1 格 ⇒ 映射后长度仍是 1 才存活；长度变了说明那一格被吃掉了。
 */
export function mapAtoms(atoms: readonly Atom[], blockId: string, c: TextChange): AtomMapResult {
  const kept: Atom[] = []
  const lost: Atom[] = []
  for (const a of atoms) {
    if (a.blockId !== blockId) {
      kept.push(a)
      continue
    }
    const start = mapOffset(a.start, c, 1)
    const end = mapOffset(a.end, c, -1)
    if (end - start === 1) kept.push({ ...a, start, end })
    else lost.push(a)
  }
  return { kept, lost }
}

/** 结构性变更后：按 idMap 重写锚点归属；块没了 ⇒ 锚点丢 */
export function remapAnchors<T extends { blockId: string }>(items: readonly T[], idMap: Map<string, string>): T[] {
  const out: T[] = []
  for (const it of items) {
    const next = idMap.get(it.blockId)
    if (next) out.push({ ...it, blockId: next })
  }
  return out
}

/** 结构性变更后丢掉已不存在块的锚点 */
export function pruneAnchors<T extends { blockId: string }>(items: readonly T[], doc: Doc): T[] {
  const alive = new Set(flatten(doc).map((b) => b.id))
  return items.filter((it) => alive.has(it.blockId))
}

/** 锚点裁剪：保证落在块文本长度内、按位置排序、去掉零长 */
export function pruneToText<T extends { blockId: string; start: number; end: number }>(
  items: readonly T[],
  doc: Doc,
  fixedLen = false,
): T[] {
  const out: T[] = []
  for (const it of items) {
    const b = locate(doc, it.blockId)
    if (!b) continue
    const len = b.block.text.length
    const start = Math.max(0, Math.min(it.start, len))
    const end = fixedLen ? Math.min(start + 1, len) : Math.max(0, Math.min(it.end, len))
    if (end <= start) continue
    out.push({ ...it, start, end })
  }
  return out
}

/* -------------------------------------------------------- 规范化 */

/**
 * 规范化（/ 21 ）：**同型**重叠或相接 ⇒ 合并；异型允许重叠。
 * 合并保留「排序后最靠前那条」的 id（保留既有 id，禁止生成新 id）。
 */
export function normalizeMarks(marks: readonly Mark[]): Mark[] {
  const byBlock = new Map<string, Mark[]>()
  for (const m of marks) {
    const arr = byBlock.get(m.blockId) ?? []
    arr.push({ ...m })
    byBlock.set(m.blockId, arr)
  }
  const out: Mark[] = []
  for (const [, list] of byBlock) {
    for (const type of MARK_TYPES) {
      const same = list.filter((m) => m.type === type).sort((a, b) => a.start - b.start || a.end - b.end)
      const merged: Mark[] = []
      for (const cur of same) {
        const last = merged[merged.length - 1]
        if (last && cur.start <= last.end) last.end = Math.max(last.end, cur.end)
        else merged.push({ ...cur })
      }
      out.push(...merged)
    }
  }
  return out.sort((a, b) => a.blockId.localeCompare(b.blockId) || a.start - b.start)
}

export function addMark(marks: readonly Mark[], type: MarkType, blockId: string, start: number, end: number): Mark[] {
  if (start >= end) return [...marks]
  return normalizeMarks([...marks, { id: uuidv7Hex(), type, blockId, start, end }])
}

/** 选区是否已被同型锚点完全覆盖（决定 ⌘B 是「加」还是「取消」） */
export function isCovered(marks: readonly Mark[], type: MarkType, blockId: string, start: number, end: number): boolean {
  const segs = marks
    .filter((m) => m.blockId === blockId && m.type === type)
    .map((m) => [Math.max(m.start, start), Math.min(m.end, end)] as [number, number])
    .filter(([s, e]) => s < e)
    .sort((a, b) => a[0] - b[0])
  let cur = start
  for (const [s, e] of segs) {
    if (s > cur) return false
    cur = Math.max(cur, e)
    if (cur >= end) return true
  }
  return cur >= end
}

/**
 * 取消一段同型锚点：整条覆盖 ⇒ 删掉；部分重叠 ⇒ 切开。
 * 切开时**保留原 id 给左半**，右半发新 id的「保留既有 id」在可做到处做到）。
 */
export function removeMarkRange(
  marks: readonly Mark[],
  type: MarkType,
  blockId: string,
  start: number,
  end: number,
): Mark[] {
  const out: Mark[] = []
  for (const m of marks) {
    if (m.blockId !== blockId || m.type !== type || m.end <= start || m.start >= end) {
      out.push(m)
      continue
    }
    if (m.start < start) out.push({ ...m, end: start })
    if (m.end > end) out.push({ ...m, id: uuidv7Hex(), start: end })
  }
  return normalizeMarks(out)
}

/** ⌘B 的手感：全覆盖 ⇒ 取消；否则 ⇒ 加（并随规范化合并） */
export function toggleMark(
  marks: readonly Mark[],
  type: MarkType,
  blockId: string,
  start: number,
  end: number,
): Mark[] {
  if (start >= end) return [...marks]
  if (isCovered(marks, type, blockId, start, end)) return removeMarkRange(marks, type, blockId, start, end)
  return addMark(marks, type, blockId, start, end)
}

/* ---------------------------------------------------------- 选区 */
