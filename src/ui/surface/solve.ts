/**
 * **位置 = 约束求解的结果**，永远是派生值。
 *
 * 这是整个模型里最关键的一条：用户拖动不是「切到手动定位模式」，只是往约束集
 * 里加了一条更强的 `at`；滚动 / resize 时重新求解，那条约束还在，浮面就不会被
 * 拽回锚点；锚点消失也不是一句特判，只是弱约束退出 —— 若没有别的约束接手，
 * `solve` 返回 `null`，运行时据此退场。
 *
 * ⚠️ 纯函数：只吃数值快照，不碰 DOM。实时性由运行时每次 `reflow` 时重新取快照保证。
 */
import type { Constraint, Rect, Side } from './types.ts'

export interface SolveInput {
  size: { w: number; h: number }
  bounds: Rect
  constraints: readonly Constraint[]
}

const DEFAULT_GAP = 8

const OPPOSITE: Readonly<Record<Side, Side>> = {
  below: 'above',
  above: 'below',
  start: 'end',
  end: 'start',
}

function placeOn(side: Side, a: Rect, size: { w: number; h: number }, gap: number): Rect {
  switch (side) {
    case 'below': return { x: a.x, y: a.y + a.h + gap, w: size.w, h: size.h }
    case 'above': return { x: a.x, y: a.y - size.h - gap, w: size.w, h: size.h }
    case 'end': return { x: a.x + a.w + gap, y: a.y, w: size.w, h: size.h }
    case 'start': return { x: a.x - size.w - gap, y: a.y, w: size.w, h: size.h }
  }
}

/** 期望侧优先；允许翻面时对侧紧随其后，再试其余两侧。`flip: false` 就只认期望侧 */
function sideOrder(prefer: Side, flip: boolean): readonly Side[] {
  if (!flip) return [prefer]
  const rest = (['below', 'above', 'start', 'end'] as const).filter(
    (s) => s !== prefer && s !== OPPOSITE[prefer],
  )
  return [prefer, OPPOSITE[prefer], ...rest]
}

function padded(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p }
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** 视口比浮面还小时取左上角，不返回负宽 */
function clampTo(r: Rect, b: Rect): Rect {
  return {
    x: Math.min(Math.max(r.x, b.x), Math.max(b.x, b.x + b.w - r.w)),
    y: Math.min(Math.max(r.y, b.y), Math.max(b.y, b.y + b.h - r.h)),
    w: r.w,
    h: r.h,
  }
}

/**
 * @returns 落位矩形；`null` ＝ **没有任何位置约束了**，调用方应当退场
 */
export function solve({ size, bounds, constraints }: SolveInput): Rect | null {
  const at = constraints.find((c): c is Extract<Constraint, { kind: 'at' }> => c.kind === 'at')
  const anchor = constraints.find((c): c is Extract<Constraint, { kind: 'anchor' }> => c.kind === 'anchor')
  if (!at && !anchor) return null

  // 用户约束最强：拖过的落点就是他的意图，只钳位，不参与避让
  if (at) return clampTo({ x: at.x, y: at.y, w: size.w, h: size.h }, bounds)
  if (!anchor) return null

  const avoid = constraints
    .filter((c): c is Extract<Constraint, { kind: 'avoid' }> => c.kind === 'avoid')
    .flatMap((c) => c.rects.map((r) => padded(r, c.padding ?? 0)))

  const candidates = sideOrder(anchor.prefer, anchor.flip !== false)
    .map((side) => placeOn(side, anchor.rect, size, anchor.gap ?? DEFAULT_GAP))
    .map((r) => clampTo(r, bounds))
  return candidates.find((r) => avoid.every((a) => !overlaps(a, r))) ?? candidates[0] ?? null
}
