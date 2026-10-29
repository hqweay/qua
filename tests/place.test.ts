/**
 * **锚定落位**（`ui/place.ts`）的纯函数断言。
 *
 * 为什么值得单测：落位是最容易「看着对、实际差 8px」的一类代码。它此前散在
 * 菜单／信息浮层／划选气泡三处，每处各写一遍 `Math.min(Math.max(pad, …))`，
 * 差别不在「想不一样」，而在**各自忘了另外两种对齐**。这类偏差在真浏览器里只能靠量，
 * 量一次就要起一整套冒烟；纯函数把「算」与「量」分开，这里跑毫秒级。
 *
 * 口径（与 `placeNear` 的注释同源）：
 *   · 水平：按 `align` 对齐锚点后**夹进视口**，贴边的浮层永远不越界；
 *   · 竖直：优先放 `side`，放不下**翻面**，两面都放不下才夹；
 *   · 没有锚点：水平居中、竖直落在视口上部。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { placeNear, type Placement } from '../src/ui/place.ts'

const VW = 1440
const VH = 900
const base = (o: Partial<Placement> = {}): Placement => ({
  boxW: 240,
  boxH: 200,
  vw: VW,
  vh: VH,
  anchor: null,
  side: 'below',
  align: 'left',
  gap: 8,
  pad: 8,
  ...o,
})

const rect = (left: number, top: number, w = 0, h = 0) => ({ left, top, right: left + w, bottom: top + h })

test('没有锚点：水平居中、竖直落在视口上部（命令面板那一档）', () => {
  const r = placeNear(base({ boxW: 430 }))
  assert.equal(r.left, Math.round((VW - 430) / 2))
  assert.equal(r.top, Math.round(VH * 0.16))
  assert.equal(r.flipped, false)
})

test('贴锚点左边：锚点在左半屏时 left 就等于锚点 left（不无端居中）', () => {
  const r = placeNear(base({ anchor: rect(100, 100) }))
  assert.equal(r.left, 100)
})

test('贴锚点右边：浮层右缘与锚点右缘对齐（不是左边对齐）', () => {
  const r = placeNear(base({ anchor: rect(600, 100, 200), align: 'right' }))
  assert.equal(r.left, 600 + 200 - 240)
})

test('居中对齐：浮层中线落在锚点中线上', () => {
  const r = placeNear(base({ anchor: rect(500, 100, 200), align: 'center' }))
  assert.equal(r.left, 500 + 100 - 120)
})

test('靠右的锚点会被夹回视口内（浮层不许越出右缘）', () => {
  const r = placeNear(base({ anchor: rect(VW - 40, 100) }))
  assert.equal(r.left, VW - 240 - 8)
  assert.ok(r.left + 240 <= VW, `右缘必须留在视口内：${r.left + 240} > ${VW}`)
})

test('靠左的锚点会被夹回视口内（不许越出左缘）', () => {
  const r = placeNear(base({ anchor: rect(2, 100), align: 'right' }))
  assert.equal(r.left, 8)
})

test('锚点下方放得下 ⇒ 贴在下方（gap 生效）', () => {
  const r = placeNear(base({ anchor: rect(100, 100, 0, 20) }))
  assert.equal(r.top, 100 + 20 + 8)
  assert.equal(r.flipped, false)
})

test('锚点下方放不下 ⇒ 翻到上方（不是硬塞在下方被裁掉）', () => {
  const r = placeNear(base({ anchor: rect(100, VH - 40, 0, 20) }))
  assert.equal(r.top, VH - 40 - 200 - 8)
  assert.equal(r.flipped, true)
})

test('上下都放不下 ⇒ 夹进视口，并如实标出 clamped（不假装放得下）', () => {
  // 视口比浮层还矮：任何一侧都放不下
  const r = placeNear(base({ vh: 150, boxH: 200, anchor: rect(100, 60, 0, 20) }))
  assert.equal(r.top, 8)
  assert.equal(r.clamped, true)
})

test('side=above 的偏好也被尊重（划选气泡要贴在选区上方）', () => {
  const r = placeNear(base({ side: 'above', anchor: rect(100, 500, 0, 20) }))
  assert.equal(r.top, 500 - 200 - 8)
  assert.equal(r.flipped, false)
})

test('浮层比视口还宽 ⇒ 夹到左边留白，不产生负坐标', () => {
  const r = placeNear(base({ boxW: VW + 100, anchor: rect(700, 100) }))
  assert.equal(r.left, 8)
})
