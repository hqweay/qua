/**
 * **条件树的字段候选**（`core/query-fields.ts`）。
 *
 * 判据：下拉里出现的每一项都要**用户能填出值**——
 * 属性定义（值控件按 kind 分派）＋ 系统槽（日期控件／名字文本／引述类型）。
 * 引擎属性与没有值控件的系统槽不进下拉（它们仍可由 JSON 写成）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkPropDef, queryFieldsOf, type Block } from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'

const b = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

test('字段候选：属性定义在前（带 kind／基数），系统槽在后', () => {
  const defs = [
    mkPropDef('状态', 'checkbox', {}, 'p-check'),
    mkPropDef('标签集', 'select', { _cardinality: 'many' }, 'p-many'),
  ]
  const fields = queryFieldsOf([...defs, b('plain', '普通一行')])
  const ids = fields.map((f) => f.id)
  assert.deepEqual(ids, ['p-check', 'p-many', '_date', '_aliases', '_type', '_callout', '_lang'])
  assert.deepEqual(fields[0], { id: 'p-check', label: '状态', kind: 'checkbox' })
  assert.equal(fields[1]?.kind, 'select')
  assert.equal(fields[1]?.cardinality, 'many')
  assert.deepEqual(fields[2], { id: '_date', label: '日记日期', kind: 'date' })
  assert.deepEqual(fields[3], { id: '_aliases', label: '别名', kind: 'text' })
  // `_type` 的值域是封闭注册表，但盘上有别的版本写进来的未知 id：照原文显示（open）
  assert.deepEqual(fields[4], { id: '_type', label: '块类型', kind: 'select', open: true })
  assert.deepEqual(fields[5], { id: '_callout', label: '引述类型', kind: 'select' })
  assert.deepEqual(fields[6], { id: '_lang', label: '代码语言', kind: 'select', open: true })
})

test('引擎属性不进下拉：值是毫秒，日期控件填进去对不上', () => {
  const fields = queryFieldsOf([])
  assert.ok(!fields.some((f) => f.id === 'core/created' || f.id === 'core/modified'))
})

test('软删的标签与定义不进候选（与构建器「库里有什么」同源）', () => {
  const def = mkPropDef('旧的', 'text', {}, 'p-old')
  const trashed: Block = { ...def, props: { ...(def.props ?? {}), _deletedAt: 1 } }
  const fields = queryFieldsOf([trashed])
  assert.deepEqual(fields.map((f) => f.id), ['_date', '_aliases', '_type', '_callout', '_lang'])
})

/* ------------------------------------------------------------ 覆盖率排序（候选来自结果） */

import { fieldCoverageOf } from '../src/core/index.ts'

const rec = (values: Record<string, unknown>) => ({ values })

test('有覆盖率的字段排前（覆盖率降序），没人有的殿后，系统槽恒在尾', () => {
  const defs = [
    mkPropDef('甲', 'text', {}, 'p-a'),
    mkPropDef('乙', 'text', {}, 'p-b'),
    mkPropDef('丙', 'text', {}, 'p-c'),
  ]
  const coverage = fieldCoverageOf([
    rec({ 'p-c': 'x' }),
    rec({ 'p-c': 'y', 'p-b': 1 }),
    rec({ 'p-c': 'z', 'p-b': 2, 'p-a': 'w' }),
  ])
  assert.equal(coverage?.total, 3)
  const fields = queryFieldsOf(defs, coverage)
  // 覆盖率降序：丙(3) → 乙(2) → 甲(1)；没人有的不在这批里；系统槽殿后
  assert.deepEqual(
    fields.map((f) => [f.id, f.count, f.total]),
    [
      ['p-c', 3, 3],
      ['p-b', 2, 3],
      ['p-a', 1, 3],
      ['_date', undefined, undefined],
      ['_aliases', undefined, undefined],
      ['_type', undefined, undefined],
      ['_callout', undefined, undefined],
      ['_lang', undefined, undefined],
    ],
  )
})

test('同覆盖率保持库序（排序是稳定的，不因计数并列而洗牌）', () => {
  const defs = [mkPropDef('甲', 'text', {}, 'p-a'), mkPropDef('乙', 'text', {}, 'p-b')]
  const fields = queryFieldsOf(defs, fieldCoverageOf([rec({ 'p-a': 1, 'p-b': 2 }), rec({ 'p-a': 3, 'p-b': 4 })]))
  assert.deepEqual(fields.map((f) => f.id), ['p-a', 'p-b', '_date', '_aliases', '_type', '_callout', '_lang'], '甲乙都 2／2：按库序；系统槽殿后不参与排序')
})

test('空结果 ⇒ undefined ⇒ 回落全量平铺（没有可数的答案不假装知道）', () => {
  const defs = [mkPropDef('甲', 'text', {}, 'p-a')]
  assert.equal(fieldCoverageOf([]), undefined)
  const fields = queryFieldsOf(defs, fieldCoverageOf([]))
  assert.deepEqual(fields.map((f) => f.id), ['p-a', '_date', '_aliases', '_type', '_callout', '_lang'], '与不传覆盖率逐字节同形')
  // 只有空值的记录算不出任何覆盖 ⇒ 全体殿后（仍是原库序），不下假推荐
  const empty = fieldCoverageOf([rec({ 'p-a': '' }), rec({ 'p-a': [] })])
  assert.equal(empty?.total, 2)
  assert.equal(empty?.counts.size, 0)
  assert.deepEqual(queryFieldsOf(defs, empty).map((f) => f.id), ['p-a', '_date', '_aliases', '_type', '_callout', '_lang'])
})
