/**
 * `DockEntry` 的契约：**种类由 `kind` 说**，扁平 key 只认身份。
 *
 * 这里钉的是「旧字节怎么读」与「坏项怎么丢」——两条都曾经是静默失败：
 * 旧实现靠字符串形状分辨种类，块 id 一旦不合 hex，整张窗口卡不画也不报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalDockEntries, dockKey, DERIVED_CARDS } from '../src/core/dock.ts'

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
