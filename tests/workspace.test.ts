/**
 * 落盘形状的校验（纯函数，无 I/O）：**这七个分支每一条都是一次真数据安全事故**。
 *
 * 来历：旧实现把所有读失败压成 `null`，调用方只能 `?? seedWorkspace()`，
 * 随后立刻写回 ——过新/损坏的库被**静默覆盖**。
 * 所以这里断言的每条状态，都是「用户数据会不会丢」的判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspace, WORKSPACE_VERSION } from '../src/core/workspace.ts'

const valid = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: WORKSPACE_VERSION,
    blocks: [{ id: 'b1', text: 'hello', children: [] }],
    activeId: 'b1',
    prefs: {},
    savedAt: 0,
    marks: [],
    atoms: [],
    ...patch,
  })

test('parseWorkspace: 从没存过 ⇒ empty（不是错误）', () => {
  assert.deepEqual(parseWorkspace(null), { status: 'empty' })
})

test('parseWorkspace: 合法库 ⇒ ok，并补默认 prefs', () => {
  const r = parseWorkspace(valid())
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.equal(r.ws.blocks.length, 1)
  assert.equal(r.ws.prefs.theme, 'system')
  assert.deepEqual(r.ws.prefs.dock, {
    left: { open: true, width: null, pins: [] },
    right: { open: true, width: null, pins: [] },
  })
})

test('parseWorkspace: 钉住清单只做形状兜底（缺字段 ⇒ 空；非字符串/重复值丢掉）', () => {
  const r = parseWorkspace(
    valid({
      prefs: {
        dock: {
          left: { open: true, width: 300, pins: ['a', 7, null, 'a', '', 'b'] },
          right: { open: false, width: null },
        },
      },
    }),
  )
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.deepEqual(r.ws.prefs.dock.left, { open: true, width: 300, pins: ['a', 'b'] })
  assert.deepEqual(r.ws.prefs.dock.right, { open: false, width: null, pins: [] })
})

test('parseWorkspace: 比当前新的版本 ⇒ too-new（绝不 seed 覆盖）', () => {
  assert.deepEqual(parseWorkspace(valid({ version: WORKSPACE_VERSION + 1 })), {
    status: 'too-new',
    version: WORKSPACE_VERSION + 1,
  })
})

test('parseWorkspace: 旧版本 ⇒ expired（显式作废分支）', () => {
  assert.deepEqual(parseWorkspace(valid({ version: WORKSPACE_VERSION - 1 })), {
    status: 'expired',
    version: WORKSPACE_VERSION - 1,
  })
})

test('parseWorkspace: JSON 坏了 ⇒ corrupt(parse)', () => {
  assert.deepEqual(parseWorkspace('{oops'), { status: 'corrupt', reason: 'parse' })
})

test('parseWorkspace: 形状不对（空 blocks / 坏 children）⇒ corrupt(shape)', () => {
  assert.deepEqual(parseWorkspace(valid({ blocks: [] })), { status: 'corrupt', reason: 'shape' })
  const badChild = valid({ blocks: [{ id: 'b1', text: 'x', children: [{ id: 'b2' }] }] })
  assert.deepEqual(parseWorkspace(badChild), { status: 'corrupt', reason: 'shape' })
})

test('parseWorkspace: 缺 version ⇒ corrupt(shape)，不当作旧库', () => {
  assert.deepEqual(parseWorkspace(JSON.stringify({ blocks: [] })), { status: 'corrupt', reason: 'shape' })
})

test('parseWorkspace: v3 的裸 JSON（写信封之前）⇒ expired，不会被当成当前版本打开', () => {
  // 2026-10-20：v3 → v4（落盘套信封）。旧库必须走**显式作废**，不能静默当成 v4 读进来。
  assert.deepEqual(parseWorkspace(valid({ version: 3 })), { status: 'expired', version: 3 })
})
