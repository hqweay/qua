/**
 * `DockEntry` 的契约：**种类由 `kind` 说**，扁平 key 只认身份。
 *
 * 这里钉的是「旧字节怎么读」与「坏项怎么丢」——两条都曾经是静默失败：
 * 旧实现靠字符串形状分辨种类，块 id 一旦不合 hex，整张窗口卡不画也不报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalDockEntries,
  dockKey,
  DERIVED_CARDS,
  DOCK_SHORTCUT_PREFIX,
  pinDefaultFor,
  pruneEphemeralWindows,
} from '../src/core/views/dock.ts'

test('dock: 三种条目的扁平 key 各自唯一（身份，不是种类）', () => {
  assert.equal(dockKey({ kind: 'block', block: 'b1' }), 'b1')
  assert.equal(dockKey({ kind: 'derived', card: 'inspect' }), 'inspect')
  assert.equal(dockKey({ kind: 'cmd', command: 'core.page/new' }), 'cmd:core.page/new')
})

test('dock: 旧字节（扁平字符串）读成显式条目；派生卡目录是闭集', () => {
  assert.deepEqual(canonicalDockEntries(['cmd:core.page/new', 'inspect', 'belongs', 'b1']), [
    { kind: 'cmd', command: 'core.page/new' },
    { kind: 'derived', card: 'inspect' },
    { kind: 'derived', card: 'belongs' },
    { kind: 'block', block: 'b1' },
  ])
})

test('dock: 旧字节里形状不对的 id 也当块留住（不按 hex 形状丢窗口）', () => {
  // 生成端写坏的 id（带 `-`）曾经让整张窗口卡静默消失；读时不该再按形状判它不是块
  assert.deepEqual(canonicalDockEntries(['000-7fde24687001b6f5e2cbf226a3aa']), [
    { kind: 'block', block: '000-7fde24687001b6f5e2cbf226a3aa' },
  ])
})

test('dock: 新形状逐项校验；坏项丢掉，不连累整槽', () => {
  const raw = [
    { kind: 'block', block: 'b1' },
    { kind: 'derived', card: 'inspect' },
    { kind: 'cmd', command: 'core.page/new' },
    { kind: 'derived', card: 'nope' }, // 目录外的派生卡：没有渲染器
    { kind: 'block', block: '' },
    { kind: 'cmd', command: '' },
    { kind: 'wat' },
    { block: 'b2' }, // 缺 kind
    null,
    42,
  ]
  assert.deepEqual(canonicalDockEntries(raw), [
    { kind: 'block', block: 'b1' },
    { kind: 'derived', card: 'inspect' },
    { kind: 'cmd', command: 'core.page/new' },
  ])
})

test('dock: 同一个 key 只留第一份（块/派生卡不能重复露面）', () => {
  assert.deepEqual(
    canonicalDockEntries([
      { kind: 'block', block: 'b1' },
      { kind: 'block', block: 'b1' },
      { kind: 'derived', card: 'inspect' },
      'inspect',
      'cmd:x',
      { kind: 'cmd', command: 'x' },
    ]),
    [
      { kind: 'block', block: 'b1' },
      { kind: 'derived', card: 'inspect' },
      { kind: 'cmd', command: 'x' },
    ],
  )
})

test('dock: 整格不是数组 ⇒ 空清单（调用方按默认布局兜底）', () => {
  for (const bad of [undefined, null, 'x', 0, {}]) assert.deepEqual(canonicalDockEntries(bad), [])
})

test('dock: 派生卡目录的 id 唯一（画廊与渲染分支共用这一份）', () => {
  const ids = DERIVED_CARDS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length)
})

/* ---------------- pin（常驻） ---------------- */

test('dock: pin 缺省跟着进入动作走——拖入（钉）＝常驻，打开来看＝不常驻', () => {
  assert.equal(pinDefaultFor('drop'), true)
  assert.equal(pinDefaultFor('view'), false)
})

test('dock: 重启清理——非 pin 的块窗口卡清掉，pin 的保留', () => {
  const cards = [
    { kind: 'block', block: 'ephemeral' },
    { kind: 'block', block: 'pinned' },
    { kind: 'derived', card: 'backrefs' },
    { kind: 'cmd', command: 'core.page/new' },
  ] as const
  const out = pruneEphemeralWindows(cards, { pinned: true })
  assert.deepEqual(out, [
    { kind: 'block', block: 'pinned' },
    { kind: 'derived', card: 'backrefs' },
    { kind: 'cmd', command: 'core.page/new' },
  ])
})

test('dock: 重启清理——全 pin 时原样返回（含派生卡/命令卡）', () => {
  const cards = [
    { kind: 'block', block: 'b1' },
    { kind: 'derived', card: 'calendar' },
    { kind: 'cmd', command: 'x' },
  ] as const
  assert.deepEqual(pruneEphemeralWindows(cards, { b1: true }), [...cards])
})

test('dock: 重启清理——空 pin 表 ⇒ 只剩家具（派生卡/命令卡）', () => {
  const cards = [
    { kind: 'block', block: 'b1' },
    { kind: 'derived', card: 'calendar' },
    { kind: 'cmd', command: 'x' },
  ] as const
  assert.deepEqual(pruneEphemeralWindows(cards, {}), [
    { kind: 'derived', card: 'calendar' },
    { kind: 'cmd', command: 'x' },
  ])
})

/* ---------------- 快捷小卡（指向一个块的常驻入口） ---------------- */

test('dock: 快捷卡与窗口卡是两条独立露面——同一块的 key 不同，才能并存', () => {
  assert.equal(dockKey({ kind: 'shortcut', block: 'b1' }), `${DOCK_SHORTCUT_PREFIX}b1`)
  assert.notEqual(dockKey({ kind: 'shortcut', block: 'b1' }), dockKey({ kind: 'block', block: 'b1' }))
  assert.deepEqual(
    canonicalDockEntries([
      { kind: 'shortcut', block: 'b1' },
      { kind: 'block', block: 'b1' },
    ]),
    [
      { kind: 'shortcut', block: 'b1' },
      { kind: 'block', block: 'b1' },
    ],
  )
})

test('dock: 快捷卡逐项校验；目标块删了也留住这一格，空 block 才丢', () => {
  assert.deepEqual(canonicalDockEntries([
    { kind: 'shortcut', block: 'gone-but-kept' },
    { kind: 'shortcut', block: '' },
    { kind: 'shortcut' },
    { kind: 'shortcut', block: 'dup' },
    { kind: 'shortcut', block: 'dup' },
  ]), [
    { kind: 'shortcut', block: 'gone-but-kept' },
    { kind: 'shortcut', block: 'dup' },
  ])
})

test('dock: 重启清理不碰快捷卡（它是槽的家具，不是打开来看的窗口）', () => {
  const cards = [
    { kind: 'block', block: 'b1' },
    { kind: 'shortcut', block: 'b1' },
    { kind: 'shortcut', block: 'b2' },
    { kind: 'cmd', command: 'x' },
  ] as const
  assert.deepEqual(pruneEphemeralWindows(cards, {}), [
    { kind: 'shortcut', block: 'b1' },
    { kind: 'shortcut', block: 'b2' },
    { kind: 'cmd', command: 'x' },
  ])
})
