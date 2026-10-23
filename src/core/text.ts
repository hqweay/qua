/**
 * 纯文本：单次替换 diff 与偏移粘性映射（已验证实现，口径不许改）。
 */

import type { Block } from './model.ts'
import { displayNameOf } from './alias.ts'
export interface TextChange {
  from: number
  to: number
  insert: string
}

/** 前缀/后缀 diff：把「旧文本 → 新文本」表达为**单次替换** */
export function diffText(oldT: string, newT: string): TextChange {
  const minLen = Math.min(oldT.length, newT.length)
  let p = 0
  while (p < minLen && oldT[p] === newT[p]) p++
  let s = 0
  while (s < minLen - p && oldT[oldT.length - 1 - s] === newT[newT.length - 1 - s]) s++
  const from = p
  const to = oldT.length - s
  const insert = newT.slice(p, newT.length - s)
  return { from, to, insert }
}

/**
 * 逐端粘性映射。
 * `bias = +1` 用于区间**起点**：恰好落在起点的插入 ⇒ 起点右移（插入在区间**外**，不撑大）。
 * `bias = -1` 用于区间**终点**：恰好落在终点的插入 ⇒ 终点不动（插入在区间**外**，不撑大）。
 */
export function mapOffset(p: number, c: TextChange, bias: 1 | -1): number {
  const L = c.insert.length
  const delta = L - (c.to - c.from)
  if (p < c.from) return p
  if (p > c.to) return p + delta
  if (p === c.from) return bias > 0 ? c.from + L : c.from
  if (p === c.to) return bias < 0 ? c.from : c.from + L
  return bias > 0 ? c.from + L : c.from
}

/** 把一次块内文本变更应用到该块的区间锚点上 */

/**
 * 一块在**被叫出名字**时的文本：主名叶子 > 正文。
 *
 * ⚠️ 别名不进正文：`contenteditable` 仍然编辑 `b.text`，这里是只读派生。
 */
export function blockDisplayText(b: Block): string {
  return displayNameOf(b)
}

/* ---------------------------------------------------- 区间锚点（marks） */
