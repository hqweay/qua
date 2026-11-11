/**
 * **条件的人话投影**（`ui/query/query-builder.ts` 的 `queryChips`）。
 *
 * 判据只有两条：
 *   ① **同一份树**：chip 与条件树读的是同一个模型（方向、「非」、组、某一天都拆得动）；
 *   ② **修饰管整组**：`{not:{all:[A,B]}}` 是一条「非·（A 且 B）」，不是两条「非 A」「非 B」；
 *      方向同理 —— 组挂方向与每条各挂方向必须读得出区别。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queryChips } from '../src/ui/query/query-builder.ts'
import { dayStartMs, type QuerySpec } from '../src/core/index.ts'

const fields = [{ id: 'p', label: '状态' }]
const chips = (where: QuerySpec['where']): string[] => queryChips({ where }, fields)
const one = (where: QuerySpec['where']): string => {
  const out = chips(where)
  assert.equal(out.length, 1, `应合成一条：${JSON.stringify(out)}`)
  return out[0]!
}

test('普通叶子：标签／正文／属性按人话读', () => {
  assert.deepEqual(chips({ tag: '任务' }), ['#任务'])
  assert.deepEqual(chips({ text: '提到' }), ['正文含「提到」'])
  assert.deepEqual(chips({ prop: { id: 'p', eq: false } }), ['状态 ＝ false'])
  assert.deepEqual(chips({ prop: { id: 'p', exists: true } }), ['状态 有值'])
})

test('属性：定义不在了说「属性已删除」；系统槽用它的显示名', () => {
  assert.deepEqual(chips({ prop: { id: 'gone', eq: 1 } }), ['属性已删除 ＝ 1'])
  assert.deepEqual(chips({ prop: { id: '_date', eq: '2026-10-20' } }), ['日记日期 ＝ 2026-10-20'])
})

test('`select` 的值是选项 id：chip 要显示选项名', () => {
  const withChoices = queryChips(
    { where: { prop: { id: 'p', eq: 'c1' } } },
    fields,
    (propId) => (propId === 'p' ? [{ id: 'c1', label: '已完成' }] : []),
  )
  assert.deepEqual(withChoices, ['状态 ＝ 已完成'])
})

test('引用／就是／角色：这些形状以前一律是「复合条件」', () => {
  const label = (id: string) => (id === 'x' ? '目标块' : id)
  assert.deepEqual(queryChips({ where: { ref: 'x' } }, fields, undefined, label), ['引用 目标块'])
  assert.deepEqual(queryChips({ where: { is: 'x' } }, fields, undefined, label), ['就是 目标块'])
  assert.deepEqual(queryChips({ where: { role: 'journal' } }, fields), ['是日记'])
  assert.deepEqual(queryChips({ where: { up: { is: '$self' } } }, fields), ['上级 · 就是 根块'])
})

test('某一天：固定日期／相对／与根块同一天', () => {
  assert.deepEqual(
    chips({ all: [{ role: 'journal' }, { prop: { id: '_date', eq: '2026-10-20' } }] }),
    ['2026-10-20 那天'],
  )
  assert.deepEqual(chips({ today: { offset: 0 } }), ['今天'])
  assert.deepEqual(chips({ today: { offset: 2 } }), ['今天 +2 天'])
  assert.deepEqual(chips({ today: { offset: -1 } }), ['今天 -1 天'])
  assert.deepEqual(
    chips({ up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: '$self' } }] } }),
    ['上级 · 与根块同一天'],
  )
})

test('时间范围读成一句：字段 ＋ 问法 ＋ 日期', () => {
  assert.deepEqual(
    chips({ prop: { id: 'core/created', gte: dayStartMs('2026-10-20') } }),
    ['创建时间 从这天起 2026-10-20'],
  )
  assert.deepEqual(
    chips({ prop: { id: 'core/modified', lt: dayStartMs('2026-10-20') } }),
    ['修改时间 早于这一天 2026-10-20'],
  )
  assert.deepEqual(
    chips({
      all: [
        { prop: { id: 'core/created', gte: dayStartMs('2026-10-20') } },
        { prop: { id: 'core/created', lt: dayStartMs('2026-10-21') } },
      ],
    }),
    ['创建时间 就在这一天 2026-10-20'],
  )
})

test('修饰管整组：「非（A 且 B）」不是两条「非 A」', () => {
  assert.deepEqual(chips({ not: { all: [{ tag: '甲' }, { tag: '乙' }] } }), ['非·（#甲 且 #乙）'])
  assert.deepEqual(chips({ not: { tag: '甲' } }), ['非·#甲'])
})

test('方向挂组与每条各挂：两种形状读得出区别（且各是一条／两条）', () => {
  assert.deepEqual(chips({ up: { all: [{ tag: '甲' }, { tag: '乙' }] } }), ['上级 · （#甲 且 #乙）'])
  assert.deepEqual(chips({ all: [{ up: { tag: '甲' } }, { up: { tag: '乙' } }] }), ['上级 · #甲', '上级 · #乙'])
  assert.deepEqual(chips({ not: { up: { ref: 'x' } } }), ['非·上级 · 引用 x'])
})

test('拆不动的形状照旧说「复合条件」（不猜着拆一半）', () => {
  assert.deepEqual(chips({ up: { not: { tag: 'x' } } }), ['复合条件（用 JSON 编辑）'])
  assert.deepEqual(chips({ up: { down: { tag: 'x' } } }), ['复合条件（用 JSON 编辑）'])
  assert.deepEqual(chips({ ref: { to: 'x' } }), ['复合条件（用 JSON 编辑）'])
})
