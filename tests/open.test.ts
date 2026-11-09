/**
 * 「一次点击去哪／看什么」与「一次点击带下来的修饰键」的纯判据。
 *
 * 这几个函数被所有入口共用：`openActionOf` 回答动作，`clickModsOf` 决定读不读得到手势。
 * 后者曾经在表格标题格、卡片、属性区被顺手抄成 `{ altKey, shiftKey }` ——
 * ⌘+点于是静默退化成普通点击，而且可选字段让类型检查也拦不住。
 * 这里钉住「四个字段齐全、缺省是 false」、动作优先级，以及 `tabWide` 的归一／一次性档位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clickModsOf, openActionOf, openAxisOf, openPlaceOf } from '../src/core/views/open.ts'

test('动作优先级：⌥ 最高；⌘/Ctrl+Shift 是唯一被承认的两键组合', () => {
  assert.equal(openActionOf({ altKey: true, shiftKey: true }), 'inspect')
  assert.equal(openActionOf({ altKey: true, metaKey: true }), 'inspect')
  assert.equal(openActionOf({ altKey: true, metaKey: true, shiftKey: true }), 'inspect', '⌥ 压过 ⌘⇧')
  assert.equal(openActionOf({ shiftKey: true, metaKey: true }), 'tabWide')
  assert.equal(openActionOf({ shiftKey: true, ctrlKey: true }), 'tabWide')
})

test('动作：⌥ 看第二层、Shift 右槽、⌘/Ctrl 新页签、普通点击回中心', () => {
  assert.equal(openActionOf({ altKey: true }), 'inspect')
  assert.equal(openActionOf({ shiftKey: true }), 'dock')
  assert.equal(openActionOf({ metaKey: true }), 'tab')
  assert.equal(openActionOf({ ctrlKey: true }), 'tab')
  assert.equal(openActionOf({}), 'center')
  assert.equal(openActionOf(clickModsOf({})), 'center')
})

test('tabWide 归一成 tab；只有它带一次性宽屏（档位仍住窗口）', () => {
  assert.equal(openPlaceOf('tabWide'), 'tab')
  assert.equal(openAxisOf('tabWide'), 'wide')
  for (const action of ['center', 'dock', 'tab', 'inspect'] as const) {
    assert.equal(openPlaceOf(action), action, `${action} 归一后不变`)
    assert.equal(openAxisOf(action), null, `${action} 不碰窗口`)
  }
})

test('修饰键取法：四个字段齐全，缺省是 false（不是 undefined）', () => {
  assert.deepEqual(clickModsOf({ metaKey: true }), {
    altKey: false,
    shiftKey: false,
    metaKey: true,
    ctrlKey: false,
  })
  assert.deepEqual(clickModsOf({}), { altKey: false, shiftKey: false, metaKey: false, ctrlKey: false })
})
