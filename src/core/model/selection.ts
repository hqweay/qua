/**
 * 选区：块内/跨块的区间选择，以及「选区 ↔ 文本区间」的互转。
 */

import { locate } from './tree.ts'
import type { Doc } from './model.ts'
import { flatten } from './tree.ts'
import { plainLen } from './runs.ts'
export interface Sel {
  aBlock: string
  aOff: number
  hBlock: string
  hOff: number
}

export interface SelRange {
  startBlock: string
  startOff: number
  endBlock: string
  endOff: number
}

/** 归一化为「起点在前」的形态 */
export function normSel(doc: Doc, sel: Sel): SelRange {
  const all = flatten(doc)
  const ai = all.findIndex((b) => b.id === sel.aBlock)
  const hi = all.findIndex((b) => b.id === sel.hBlock)
  if (ai < 0 || hi < 0) return { startBlock: sel.aBlock, startOff: sel.aOff, endBlock: sel.hBlock, endOff: sel.hOff }
  const forward = ai < hi || (ai === hi && sel.aOff <= sel.hOff)
  const S = forward ? { b: sel.aBlock, o: sel.aOff } : { b: sel.hBlock, o: sel.hOff }
  const E = forward ? { b: sel.hBlock, o: sel.hOff } : { b: sel.aBlock, o: sel.aOff }
  return { startBlock: S.b, startOff: S.o, endBlock: E.b, endOff: E.o }
}

export function isCollapsed(sel: Sel): boolean {
  return sel.aBlock === sel.hBlock && sel.aOff === sel.hOff
}

/** 选区覆盖的块 id 集合（**判据②的核心**：选区能表达「块 ID 集合」） */
export function blockIdsOf(doc: Doc, sel: Sel): string[] {
  const r = normSel(doc, sel)
  const all = flatten(doc)
  const i = all.findIndex((b) => b.id === r.startBlock)
  const j = all.findIndex((b) => b.id === r.endBlock)
  if (i < 0 || j < 0 || j < i) return []
  const same = i === j
  if (same && r.startOff === r.endOff) return []
  return all.slice(i, j + 1).map((b) => b.id)
}

export function fromBlockSet(doc: Doc, ids: readonly string[]): Sel | null {
  const all = flatten(doc)
  const idx = ids.map((id) => all.findIndex((b) => b.id === id)).filter((n) => n >= 0).sort((a, b) => a - b)
  if (idx.length === 0) return null
  const first = all[idx[0]!]!
  const last = all[idx[idx.length - 1]!]!
  return { aBlock: first.id, aOff: 0, hBlock: last.id, hOff: plainLen(last.content) }
}

export function selToTextRanges(doc: Doc, sel: Sel): { blockId: string; start: number; end: number }[] {
  const r = normSel(doc, sel)
  const ids = blockIdsOf(doc, sel)
  return ids.map((id) => {
    const b = locate(doc, id)!.block
    const start = id === r.startBlock ? r.startOff : 0
    const end = id === r.endBlock ? r.endOff : plainLen(b.content)
    return { blockId: id, start, end }
  })
}

export function textRangesToSel(ranges: readonly { blockId: string; start: number; end: number }[]): Sel | null {
  if (ranges.length === 0) return null
  const first = ranges[0]!
  const last = ranges[ranges.length - 1]!
  return { aBlock: first.blockId, aOff: first.start, hBlock: last.blockId, hOff: last.end }
}

export function crossesBlocks(ranges: readonly { blockId: string }[]): boolean {
  return new Set(ranges.map((r) => r.blockId)).size > 1
}

/* ------------------------------------------------------------ 撤销栈 */
