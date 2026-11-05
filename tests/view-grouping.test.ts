/**
 * **分组分桶**（列表／表格／看板共用的一份）：次序、多值 fan-out、「未设置」、组名。
 *
 * 钉的是三个渲染器共用的那份口径——任何一份漂了，这里先红：
 *   · 次序：声明选项在前、没见过的按第一次出现、「未设置」最后；
 *   · 多值键：一块进每个所属组（fan-out），没值只进「未设置」；
 *   · 组名：块 id 值翻译成名字，解析不到原样显示（数据不静默消失）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, type Block, type ViewRecord } from '../src/core/index.ts'
import { bucketize, bucketLabel, orderBuckets, GROUP_UNSET } from '../src/ui/views/grouping.ts'

const rec = (id: string, values: Record<string, unknown> = {}): ViewRecord => ({
  block: mkBlock(id),
  path: [],
  title: id,
  tags: [],
  values,
})

const CHOICES = [
  { id: 'c1', label: '甲' },
  { id: 'c2', label: '乙' },
]

test('bucketize：单值分组——声明序在前、新值按第一次出现、「未设置」最后', () => {
  const { buckets, order } = bucketize(
    [rec('a', { g: 'c2' }), rec('b', { g: 'c1' }), rec('c', { g: '新值' }), rec('d', {})],
    'g',
    { choices: () => CHOICES },
  )
  assert.deepEqual(
    orderBuckets(buckets, order).map((b) => [b.raw, b.records.map((r) => r.title)]),
    [
      ['c1', ['b']],
      ['c2', ['a']],
      ['新值', ['c']],
      [undefined, ['d']],
    ],
  )
  assert.equal(orderBuckets(buckets, order)[order.length - 1]!.unset, true, '「未设置」在最后')
})

test('bucketize：多值键 fan-out——一块进每个所属组；没值只进「未设置」', () => {
  const { multi, buckets } = bucketize(
    [rec('a', { _tags: ['t1', 't2'] }), rec('b', { _tags: ['t2'] }), rec('c', {})],
    '_tags',
    { choices: () => [{ id: 't1', label: '标签一' }, { id: 't2', label: '标签二' }] },
  )
  assert.equal(multi, true)
  const t2 = buckets.find((b) => b.raw === 't2')!
  assert.deepEqual(t2.records.map((r) => r.title), ['a', 'b'], '同属两组的块在两组都出现')
  const unset = buckets.find((b) => b.unset)!
  assert.deepEqual(unset.records.map((r) => r.title), ['c'])
})

test('bucketize：groupOrder 把用户排过的组提到前面（存原始值，带 s: 前缀合成键）', () => {
  const { buckets, order } = bucketize(
    [rec('a', { g: 'x' }), rec('b', { g: 'y' })],
    'g',
    { choices: () => [], groupOrder: ['y'] },
  )
  assert.deepEqual(orderBuckets(buckets, order).map((b) => b.raw), ['y', 'x'])
})

test('orderBuckets：按完整次序摆桶——声明了但还没出现的值可以补空桶（看板空列）', () => {
  const { buckets, order } = bucketize([rec('a', { g: 'c2' })], 'g', { choices: () => CHOICES })
  assert.equal(order.length, 3, '次序含未出现的声明值与未设置')
  const filled = [...buckets, { id: 's:c1', raw: 'c1', records: [], unset: false }]
  const ordered = orderBuckets(filled, order)
  assert.deepEqual(
    ordered.map((b) => b.raw),
    ['c1', 'c2'],
    '声明序在前，空桶也能站进次序',
  )
})

test('bucketLabel：块 id 值翻译成名字；解析不到原样显示；「未设置」给专名', () => {
  const { buckets } = bucketize([rec('a', { g: 'c1' }), rec('b', { g: '幽灵' }), rec('c', {})], 'g', {
    choices: () => CHOICES,
  })
  const o = { choices: () => CHOICES }
  assert.equal(bucketLabel(buckets[0]!, 'g', o), '甲')
  assert.equal(bucketLabel(buckets[1]!, 'g', o), '幽灵', '选项被删的值原样显示')
  assert.equal(bucketLabel(buckets[2]!, 'g', o), '未设置')
  assert.equal(buckets[2]!.id, GROUP_UNSET)
})

test('bucketize：空值（含空串）算「未设置」；类型前缀不让 `1` 与 `"1"` 混桶', () => {
  const { buckets } = bucketize([rec('a', { g: '' }), rec('b', { g: 1 }), rec('c', { g: '1' })], 'g', {
    choices: () => [],
  })
  assert.equal(buckets.length, 3, '1 与 "1" 的合成键不同，不混桶')
  assert.equal(buckets.every((b) => b.raw !== '' || b.unset), true, '空串落「未设置」桶')
})
