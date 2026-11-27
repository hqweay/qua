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
import { mkBlock, mkPageBlock, PAGE_COLUMN, type Block, type ViewRecord } from '../src/core/index.ts'
import { builtinCalloutTypes, calloutGroupChoices } from '../src/core/infra/callout.ts'
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

test('bucketize：用户字段多值（`_cardinality: many`）与 `_tags` 同一口径——fan-out，旧单值不落「未设置」', () => {
  /**
   * 基数轴推广到全 kind 之后，多值键不再只有 `_tags`：`cardinalityOf` 是唯一判据
   * （`isMultiValueKey`）。这条同时钉住「定义刚从 one 切成 many、旧块还是单值」的过渡态：
   * 单值要读成一项，不能掉进「未设置」。
   */
  const { multi, buckets } = bucketize(
    [rec('a', { 'p-num': ['x', 'y'] }), rec('b', { 'p-num': 'y' }), rec('c', { 'p-num': [] })],
    'p-num',
    { choices: () => [], cardinalityOf: (id) => (id === 'p-num' ? 'many' : 'one') },
  )
  assert.equal(multi, true, '多值键走 fan-out 分支')
  const y = buckets.find((b) => b.raw === 'y')!
  assert.deepEqual(
    y.records.map((r) => r.title),
    ['a', 'b'],
    '数组里的每一项各进一组；旧单值读成一项',
  )
  const unset = buckets.find((b) => b.unset)!
  assert.deepEqual(
    unset.records.map((r) => r.title),
    ['c'],
    '空数组＝没值，只进「未设置」',
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

test('bucketLabel：ref 的值是块 id，走 valueLabel 翻译；非 ref 字段不碰它（text 组的值是普通字）', () => {
  const { buckets } = bucketize([rec('a', { g: 'blk1' }), rec('b', { g: '一段普通文本' })], 'g', {
    choices: () => [],
  })
  const o = {
    choices: () => [] as readonly { id: string; label: string }[],
    valueLabel: (propId: string, raw: unknown) => (raw === 'blk1' ? '目标块' : undefined),
  }
  assert.equal(bucketLabel(buckets[0]!, 'g', o), '目标块', 'ref 值翻译成名字，不露裸 id')
  assert.equal(bucketLabel(buckets[1]!, 'g', o), '一段普通文本', '解析不了的原样回落（text 组不被误翻）')
})

test('按引述类型分组：墓碑类型的段头读得出旧名（不露裸 id）', () => {
  // 类型表含一条已删的「旧提示」：旧引述还在，段头不能变成它的 32 位 id
  const types = [...builtinCalloutTypes(), { id: 'gone', label: '旧提示', icon: 'lucide:flag', deleted: true as const }]
  const choices = calloutGroupChoices(types)
  const { buckets } = bucketize([rec('a', { _callout: 'gone' }), rec('b', { _callout: 'info' })], '_callout', {
    choices: () => choices,
  })
  const o = { choices: () => choices }
  assert.equal(bucketLabel(buckets[0]!, '_callout', o), '旧提示')
  assert.equal(bucketLabel(buckets[1]!, '_callout', o), '信息')
})

test('bucketize：所在页（派生键）——按最近的页分桶，无页祖先落根身份', () => {
  const outer = mkPageBlock('外')
  const inner = mkPageBlock('内')
  const root = mkBlock('根')
  const withPath = (id: string, path: readonly Block[]) =>
    ({ ...rec(id), path }) as ViewRecord
  const { buckets, multi } = bucketize(
    [withPath('a', [outer, inner]), withPath('b', [outer]), withPath('c', [root])],
    PAGE_COLUMN,
    { choices: () => [] },
  )
  assert.equal(multi, false, '所在页是单值键，不 fan-out')
  assert.deepEqual(
    buckets.map((b) => [b.raw, b.records.map((r) => r.title)]),
    [
      [inner.id, ['a']],
      [outer.id, ['b']],
      [root.id, ['c']],
    ],
  )
})
