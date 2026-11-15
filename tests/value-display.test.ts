/**
 * **属性值的人话投影**（core `propValueText`——「哪些 kind 的值是 id、要翻成什么」的唯一判据）。
 *
 * 判据：
 *   ① `select` 的值查选项表（含墓碑），翻不到返回 `undefined`（调用方兜底，数据不静默消失）；
 *   ② `ref` 的值走 `refLabel`；
 *   ③ 其余 kind／kind 不明 ⇒ `undefined`——不猜值的形状，翻错了比不翻更难查。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { propValueText } from '../src/core/index.ts'

const deps = {
  choices: (propId: string) => (propId === 'p' ? [{ id: 'c1', label: '已完成' }] : []),
  refLabel: (id: string) => (id === 'blk1' ? '项目页' : '已删除'),
}

test('`select`：值是选项 id，翻成选项名；表里没有返回 undefined', () => {
  assert.equal(propValueText({ id: 'p', kind: 'select' }, 'c1', deps), '已完成')
  assert.equal(propValueText({ id: 'p', kind: 'select' }, 'gone', deps), undefined)
})

test('`ref`：值是块 id，走显示名链；目标没了由 refLabel 兜「已删除」', () => {
  assert.equal(propValueText({ id: 'r', kind: 'ref' }, 'blk1', deps), '项目页')
  assert.equal(propValueText({ id: 'r', kind: 'ref' }, 'gone', deps), '已删除')
})

test('字面量 kind 与 kind 不明：不猜着翻，返回 undefined 交调用方原样显示', () => {
  assert.equal(propValueText({ id: 'n', kind: 'number' }, '42', deps), undefined)
  assert.equal(propValueText({ id: 'unknown' }, 'c1', deps), undefined)
})

test('空值与多值形状不在这里读：返回 undefined（多值由调用方逐项问）', () => {
  assert.equal(propValueText({ id: 'r', kind: 'ref' }, '', deps), undefined)
  assert.equal(propValueText({ id: 'r', kind: 'ref' }, ['blk1'], deps), undefined)
})
