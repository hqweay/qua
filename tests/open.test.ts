/**
 * 「一次点击去哪／看什么」与「一次点击带下来的修饰键」的纯判据。
 *
 * 这两个函数被所有入口共用：`openActionOf` 回答动作，`clickModsOf` 决定读不读得到手势。
 * 后者曾经在表格标题格、卡片、属性区被顺手抄成 `{ altKey, shiftKey }` ——
 * ⌘+点于是静默退化成普通点击，而且可选字段让类型检查也拦不住。
 * 这里钉住「四个字段齐全、缺省是 false」与四档动作的优先级。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clickModsOf, openActionOf } from '../src/core/views/open.ts'

test('动作优先级：⌥ > Shift > ⌘/Ctrl；组合键只产生一种语义', () => {
  assert.equal(openActionOf({ altKey: true, shiftKey: true }), 'inspect')
  assert.equal(openActionOf({ altKey: true, metaKey: true }), 'inspect')
  assert.equal(openActionOf({ shiftKey: true, metaKey: true }), 'dock')
  assert.equal(openActionOf({ shiftKey: true, ctrlKey: true }), 'dock')
})

test('动作：⌥ 看第二层、⌘/Ctrl 新页签、普通点击回中心', () => {
  assert.equal(openActionOf({ altKey: true }), 'inspect')
  assert.equal(openActionOf({ metaKey: true }), 'tab')
  assert.equal(openActionOf({ ctrlKey: true }), 'tab')
  assert.equal(openActionOf({}), 'center')
  assert.equal(openActionOf(clickModsOf({})), 'center')
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
