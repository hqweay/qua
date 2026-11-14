/**
 * **块下属性区画几行**（`belowFieldsRows`）：一行摘要 / 一栏一行。
 *
 * 为什么这个纯函数值得单独钉：它是**渲染与虚拟化估高共用的那一份判据**。
 * 两处各算一遍的症状是「可见区对了、滚动条不对」——不报错，只在滚到底部露出来。
 * 所以这里钉的是「三种输入 → 同一个行数」，实现里不许再有第二个判断。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { belowFieldsRows, type BelowFields } from '../src/core/index.ts'
import { mkBlock } from '../src/core/model/model.ts'
import { PROP_LINE_H, visibleRowHeight } from '../src/view/editor/block-dom.ts'

const fields = (n: number, pending = 0): Pick<BelowFields, 'rows' | 'pendingRows'> => ({
  rows: Array.from({ length: n }, () => ({}) as never),
  pendingRows: Array.from({ length: pending }, () => ({}) as never),
})

test('没有属性行 ⇒ 0 行（整格不画）', () => {
  assert.equal(belowFieldsRows(fields(0), 'summary'), 0)
  assert.equal(belowFieldsRows(fields(0), 'list'), 0)
  assert.equal(belowFieldsRows(undefined, 'list'), 0)
})

test('summary 档恒 1 行（多出来的收进 +N）', () => {
  assert.equal(belowFieldsRows(fields(1), 'summary'), 1)
  assert.equal(belowFieldsRows(fields(5), 'summary'), 1)
})

test('list 档＝一栏一行（行数＝有值的栏数 ＋ 待填的栏数）', () => {
  assert.equal(belowFieldsRows(fields(1), 'list'), 1)
  assert.equal(belowFieldsRows(fields(5), 'list'), 5)
  // 读全档不许藏东西：声明了没填的栏照样占一行
  assert.equal(belowFieldsRows(fields(3, 2), 'list'), 5)
  // 摘要档只多一行条数（`+N`），不因为待填而变高
  assert.equal(belowFieldsRows(fields(3, 2), 'summary'), 1)
})

test('单块就地展开：summary 档下也按一栏一行算', () => {
  assert.equal(belowFieldsRows(fields(4), 'summary', true), 4)
  // list 档下 expanded 是冗余信息，不该翻倍或变 0
  assert.equal(belowFieldsRows(fields(4), 'list', true), 4)
})

test('返回值是「行数」不是「要不要画」：0 与 1 不能混', () => {
  // 虚拟化按 `propRows * PROP_LINE_H` 累加，把「1 行」误写成「true」就会少算一行高
  assert.notEqual(belowFieldsRows(fields(1), 'summary'), 0)
  assert.equal(typeof belowFieldsRows(fields(2), 'list'), 'number')
})

test('行数直接进估高：多一行就多一份 PROP_LINE_H（虚拟化占位的唯一算法）', () => {
  const b = mkBlock('一块')
  const one = visibleRowHeight(b, 0, false, 1)
  const four = visibleRowHeight(b, 0, false, 4)
  assert.equal(four - one, 3 * PROP_LINE_H, '差 3 行就该正好差 3 个行高；不能是「有属性区」的布尔')
  assert.equal(visibleRowHeight(b, 0, false, 0), one - PROP_LINE_H, '0 行＝没有这一格')
})
