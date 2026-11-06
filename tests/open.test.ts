/**
 * 「打开一块的落点」与「一次点击带下来的修饰键」的纯判据。
 *
 * 这两个函数被所有入口共用：落点回答去哪，修饰键决定读不读得到那个手势。
 * 后者曾经在表格标题格、卡片、属性区被顺手抄成 `{ altKey, shiftKey }` ——
 * ⌘+点于是静默退化成普通点击，而且可选字段让类型检查也拦不住。
 * 这里钉住「四个字段齐全、缺省是 false」的形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clickModsOf, openPlaceOf } from '../src/core/views/open.ts'

test('落点：Shift 优先于 ⌘/Ctrl，组合键不产生第三种语义', () => {
  assert.equal(openPlaceOf({ shiftKey: true, metaKey: true }), 'dock')
  assert.equal(openPlaceOf({ shiftKey: true, ctrlKey: true }), 'dock')
})

test('落点：⌘ 与 Ctrl 都开新页签；普通点击回中心；⌥ 不参与落点', () => {
  assert.equal(openPlaceOf({ metaKey: true }), 'tab')
  assert.equal(openPlaceOf({ ctrlKey: true }), 'tab')
  assert.equal(openPlaceOf({}), 'center')
  assert.equal(openPlaceOf(clickModsOf({ altKey: true })), 'center')
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
