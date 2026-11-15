/**
 * **多值（List）的读法与落盘口径**。
 *
 * 一条判据贯穿两个面：**一格值是一个列表**，读它必须逐项读、写它必须整份写。
 * 三个地方各能把它压坏一次，所以三条断言各钉一处：
 *   ① 读值：`number` 多值是数字数组，只认字符串的读法会把它读成空（有值却显示待填）；
 *   ② 落盘：数组必须铺成 `multi:1` 的多行，判据是「值是不是数组」而不是「元素是不是字符串」；
 *   ③ 选项序：多值 select 的 chips 与名字**逐项对齐**，摘除按 id 不按下标猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { allowsMany, fieldRows, mkPropDef, setChoices, valueItemsOf, valueListOf } from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { propRows } from '../src/core/storage/db-rows.ts'

test('基数轴的允许集按 kind 收：date 先 one、checkbox 永不 many', () => {
  assert.equal(allowsMany('text'), true)
  assert.equal(allowsMany('number'), true)
  assert.equal(allowsMany('select'), true)
  assert.equal(allowsMany('ref'), true)
  assert.equal(allowsMany('asset'), true)
  assert.equal(allowsMany('date'), false)
  assert.equal(allowsMany('checkbox'), false)
})

test('多值读法：valueItemsOf 不滤类型（number 多值不走只认字符串的那一条）', () => {
  assert.deepEqual(valueItemsOf([3, 1, 2]), [3, 1, 2], '数字数组逐项读出')
  assert.deepEqual(valueItemsOf(7), [7], '单值视为只有一项')
  assert.deepEqual(valueItemsOf([]), [], '空数组 ＝ 没填')
  assert.deepEqual(valueItemsOf(undefined), [], '没有这格')
  assert.deepEqual(
    valueListOf([3, 1] as unknown),
    [],
    '对照：valueListOf 只认字符串（它就是给 id 类 kind 用的，别拿它读 number）',
  )
})

test('落盘：数组一律铺成 multi:1 多行（判据是「是不是数组」）', () => {
  const rows = propRows('b1', 'p-num', [3, 1])
  assert.equal(rows.length, 2, '两项两行')
  assert.deepEqual(
    rows.map((r) => (r.values as { multi: number }).multi),
    [1, 1],
    'multi 位必须是 1：否则读回来形状对、口径丢了',
  )
  assert.deepEqual(
    rows.map((r) => ({ pos: (r.key as { pos: number }).pos, value: r.values?.value })),
    [
      { pos: 0, value: '3' },
      { pos: 1, value: '1' },
    ],
    '按 pos 保留顺序',
  )
  assert.deepEqual(propRows('b1', 'p-num', []), [], '空数组 ＝ 没有这一格')
  assert.deepEqual(
    propRows('b1', 'p-num', 5).map((r) => (r.values as { multi: number }).multi),
    [0],
    '单值仍是 multi:0',
  )
})

test('多值 select：chips 的 id 与名字逐项对齐（摘除按 id，不按标签反查）', () => {
  const def = mkPropDef('标签集', 'select', { _cardinality: 'many' }, 'p-multi')
  setChoices(def, [
    { id: 'c1', label: '甲' },
    { id: 'c2', label: '乙' },
    { id: 'c3', label: '丙' },
  ])
  const host: Block = {
    id: 'h',
    content: textRuns('带多值'),
    children: [],
    created: 1,
    modified: 1,
    // 写入序与选项序不同：chips 要按**选项序**显示
    props: { 'p-multi': ['c3', 'c1'] },
  }
  const row = fieldRows(host, [def, host]).find((r) => r.propId === 'p-multi')!
  assert.deepEqual(row.currentChoiceLabels, ['甲', '丙'])
  assert.deepEqual(row.currentChoiceIds, ['c1', 'c3'], '与名字同一序、同一长度')
  assert.equal(row.currentChoiceLabels?.length, row.currentChoiceIds?.length, '逐项对齐')
})

test('多值 select：值指向已 purge 的选项时，名字位保留「已删除」但 id 位仍在（摘得掉）', () => {
  const def = mkPropDef('标签集', 'select', { _cardinality: 'many' }, 'p-multi')
  setChoices(def, [{ id: 'c1', label: '甲' }])
  const host: Block = {
    id: 'h',
    content: textRuns('带多值'),
    children: [],
    created: 1,
    modified: 1,
    props: { 'p-multi': ['c1', 'gone'] },
  }
  const row = fieldRows(host, [def, host]).find((r) => r.propId === 'p-multi')!
  assert.equal(row.currentChoiceLabels?.length, 2, '两项都占名字位（缺失项兜底）')
  assert.deepEqual(row.currentChoiceIds, ['c1', 'gone'], 'id 位不许少：少了就摘不掉那个悬空值')
})
