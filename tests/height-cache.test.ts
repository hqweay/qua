/**
 * `HeightCache`：虚拟化占位「量到过就用实测」的判据。
 *
 * 为什么这条值得单测：它是「滚动条长度可不可信」的全部逻辑，而它**没有 DOM**——
 * 真行高由 `checks/probe-row-height.mjs` 量（折行块 107px vs 估 30px），这里钉的是
 * 「有了真值之后怎么用、什么时候作废」。两者合起来才是完整覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HeightCache } from '../src/view/editor/height-cache.ts'

const EST = 30

test('没量过的行走估算；量过之后用实测（折行长块不再按 LINE_H 算）', () => {
  const c = new HeightCache()
  assert.equal(c.heightOf('a', () => EST), EST, '没量过 ⇒ 估算')
  c.set('a', 107.25)
  assert.equal(c.heightOf('a', () => EST), 107.25, '量过 ⇒ 实测，不再用 LINE_H')
})

test('0 高不记账（折叠子树 display:none 量出来是 0，记进去会把占位压成零高）', () => {
  const c = new HeightCache()
  c.set('a', 0)
  assert.equal(c.has('a'), false, '0 高不进表')
  assert.equal(c.heightOf('a', () => EST), EST, '仍走估算')
})

test('宽度变了整表作废（折行数随可用宽度变，旧高没有参考价值）', () => {
  const c = new HeightCache()
  c.set('a', 107)
  c.set('b', 28)
  assert.equal(c.size, 2)
  c.invalidate(1440)
  assert.equal(c.size, 0, '换宽度 ⇒ 清表')
})

test('同一宽度重复作废是 no-op（竖直拉伸不该让占位白抖一次）', () => {
  const c = new HeightCache()
  c.invalidate(1440)
  c.set('a', 107)
  c.invalidate(1440)
  assert.equal(c.size, 1, '宽度没变 ⇒ 不清表')
  c.invalidate(800)
  assert.equal(c.size, 0, '宽度变了 ⇒ 清表')
})

test('无参作废＝无条件清（换虚拟化档／换装载单位时前提已变，不赌宽度）', () => {
  const c = new HeightCache()
  c.invalidate(1440)
  c.set('a', 107)
  c.invalidate()
  assert.equal(c.size, 0)
})

test('单行被重画 ⇒ 只删那一格，其余保留（改了正文那一行高度失效，别的行没变）', () => {
  const c = new HeightCache()
  c.set('a', 107)
  c.set('b', 28)
  c.forget('a')
  assert.equal(c.has('a'), false, '被重画的那行退回估算')
  assert.equal(c.heightOf('b', () => EST), 28, '其余行不受影响')
})

test('pending：只交还没量过的行（离屏批量测量按它排活）', () => {
  const c = new HeightCache()
  c.set('a', 28)
  assert.deepEqual(c.pending(['a', 'b', 'c']), ['b', 'c'])
})
