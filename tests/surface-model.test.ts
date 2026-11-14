/**
 * **浮面模型的两条内核**：位置求解与意图持有者。
 *
 * 这些断言钉的是「模型」而不是某个组件：拖动为什么不是特殊模式、
 * 锚点消失为什么不是特判、hover 状态机为什么可以不存在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { solve } from '../src/ui/surface/solve.ts'
import { HolderSet } from '../src/ui/surface/holders.ts'
import type { Rect } from '../src/ui/surface/types.ts'

const VIEW: Rect = { x: 0, y: 0, w: 1000, h: 800 }
const SIZE = { w: 200, h: 100 }
const ANCHOR: Rect = { x: 100, y: 200, w: 80, h: 30 }

test('锚点约束：按 prefer 落在期望侧', () => {
  assert.deepEqual(
    solve({ size: SIZE, bounds: VIEW, constraints: [{ kind: 'anchor', rect: ANCHOR, prefer: 'below' }] }),
    { x: 100, y: 238, w: 200, h: 100 },
  )
})

test('用户约束覆盖锚点：锚点怎么动都不回弹', () => {
  const moved: Rect = { ...ANCHOR, y: 500 }
  assert.deepEqual(
    solve({
      size: SIZE,
      bounds: VIEW,
      constraints: [{ kind: 'anchor', rect: moved, prefer: 'below' }, { kind: 'at', x: 500, y: 300 }],
    }),
    { x: 500, y: 300, w: 200, h: 100 },
  )
})

test('锚点消失但用户拖过：约束集没空，浮面留在原地', () => {
  const r = solve({ size: SIZE, bounds: VIEW, constraints: [{ kind: 'at', x: 500, y: 300 }] })
  assert.ok(r && r.x === 500 && r.y === 300, `at 单独也该解出矩形：${JSON.stringify(r)}`)
})

test('没有任何位置约束 ⇒ null（锚点消失即退场，不是一句特判）', () => {
  assert.equal(solve({ size: SIZE, bounds: VIEW, constraints: [] }), null)
  assert.equal(solve({ size: SIZE, bounds: VIEW, constraints: [{ kind: 'avoid', rects: [] }] }), null)
})

test('避让：期望侧撞上当前行就翻到对侧', () => {
  const line: Rect = { x: 0, y: 230, w: 1000, h: 120 }
  const r = solve({
    size: SIZE,
    bounds: VIEW,
    constraints: [
      { kind: 'anchor', rect: ANCHOR, prefer: 'below' },
      { kind: 'avoid', rects: [line] },
    ],
  })
  assert.ok(r && r.y === 92, `below 被占 ⇒ above：${JSON.stringify(r)}`)
})

test('钳位：贴边不越界；视口比浮面小也不返回负宽', () => {
  assert.deepEqual(
    solve({ size: SIZE, bounds: VIEW, constraints: [{ kind: 'at', x: 900, y: 760 }] }),
    { x: 800, y: 700, w: 200, h: 100 },
  )
  const small = solve({ size: SIZE, bounds: { x: 0, y: 0, w: 50, h: 40 }, constraints: [{ kind: 'at', x: 20, y: 20 }] })
  assert.ok(small && small.x === 0 && small.y === 0, `${JSON.stringify(small)}`)
})

test('持有者：任一个在就活，全释放才退场', () => {
  const h = new HolderSet()
  let changes = 0
  h.onChange(() => changes++)
  assert.equal(h.alive, false)
  const offPointer = h.acquire('chip', 'pointer')
  const offFocus = h.acquire('editor', 'focus')
  assert.equal(h.alive, true)
  assert.deepEqual([...h.kinds].sort(), ['focus', 'pointer'])
  offPointer()
  assert.equal(h.alive, true, '焦点还在 ⇒ 鼠标移开不该关')
  offFocus()
  assert.equal(h.alive, false)
  assert.equal(changes, 4)
})

test('幂等 set 不重复通知；拖动手势自动成为持有者；pin 换 scope', () => {
  const h = new HolderSet()
  let n = 0
  h.onChange(() => n++)
  h.set('drag', 'gesture')
  h.set('drag', 'gesture')
  assert.equal(n, 1)
  assert.equal(h.alive, true)
  h.set('pinned', 'pin', 'workspace')
  assert.ok(h.scopes.includes('workspace'))
  h.clear()
  assert.equal(h.alive, false)
})
