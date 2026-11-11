/**
 * **条件树的字段候选**（`core/query-fields.ts`）。
 *
 * 判据：下拉里出现的每一项都要**用户能填出值**——
 * 属性定义（值控件按 kind 分派）＋ 两个系统槽（日期控件／名字文本）。
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

test('字段候选：属性定义在前（带 kind／基数），两个系统槽在后', () => {
  const defs = [
    mkPropDef('状态', 'checkbox', {}, 'p-check'),
    mkPropDef('标签集', 'select', { _cardinality: 'many' }, 'p-many'),
  ]
  const fields = queryFieldsOf([...defs, b('plain', '普通一行')])
  const ids = fields.map((f) => f.id)
  assert.deepEqual(ids, ['p-check', 'p-many', '_date', '_aliases'])
  assert.deepEqual(fields[0], { id: 'p-check', label: '状态', kind: 'checkbox' })
  assert.equal(fields[1]?.kind, 'select')
  assert.equal(fields[1]?.cardinality, 'many')
  assert.deepEqual(fields[2], { id: '_date', label: '日记日期', kind: 'date' })
  assert.deepEqual(fields[3], { id: '_aliases', label: '别名', kind: 'text' })
})

test('引擎属性不进下拉：值是毫秒，日期控件填进去对不上', () => {
  const fields = queryFieldsOf([])
  assert.ok(!fields.some((f) => f.id === 'core/created' || f.id === 'core/modified'))
})

test('软删的标签与定义不进候选（与构建器「库里有什么」同源）', () => {
  const def = mkPropDef('旧的', 'text', {}, 'p-old')
  const trashed: Block = { ...def, props: { ...(def.props ?? {}), _deletedAt: 1 } }
  const fields = queryFieldsOf([trashed])
  assert.deepEqual(fields.map((f) => f.id), ['_date', '_aliases'])
})
