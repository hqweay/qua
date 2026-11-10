/**
 * **条件树草稿的往返**：`specOfTree(treeOfSpec(s))` 必须与 `canonicalSpec(s)` 逐字节相等。
 *
 * 为什么这条比 UI 冒烟更先写：树 UI 的每个手势最后都落到「拼回一份 spec」这一处；
 * 拼错一个算子，界面上只是「改完没生效」，而没有任何一层报错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalSpec,
  specOfTree,
  treeIncomplete,
  treeLeafCount,
  treeOfSpec,
  TASK_STATUS_PROP_ID,
  type QuerySpec,
} from '../src/core/index.ts'

const roundTrip = (spec: QuerySpec): void => {
  const draft = treeOfSpec(spec)
  assert.ok(draft, `可编辑形状不该被拒：${JSON.stringify(spec)}`)
  assert.equal(JSON.stringify(specOfTree(draft)), JSON.stringify(canonicalSpec(spec)), JSON.stringify(spec))
}

test('条件树往返：组／非／算子／待办预设／路径与方向／引用都逐字节相等', () => {
  const day = { up: { all: [{ role: 'journal' as const }, { prop: { id: '_date', eq: '2026-10-20' } }] } }
  const cases: QuerySpec[] = [
    { where: { tag: '任务' } },
    { where: { text: '提到' } },
    { where: { ref: 'x' } },
    { where: { is: 'x' } },
    { where: { role: 'journal' } },
    { where: { role: 'page' } },
    { where: { prop: { id: 'p-1', eq: 1 } } },
    { where: { prop: { id: 'p-1', eq: '' } } },
    { where: { prop: { id: 'p-1', eq: '42' } } },
    { where: { prop: { id: 'p-1', eq: 'true' } } },
    { where: { prop: { id: 'p-1', neq: 'x' } } },
    { where: { prop: { id: 'p-1', contains: 'x' } } },
    { where: { prop: { id: 'p-1', gt: 3 } } },
    { where: { prop: { id: 'p-1', exists: false } } },
    { where: { prop: { id: 'p-1', empty: true } } },
    { where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } } },
    { where: { prop: { id: TASK_STATUS_PROP_ID, eq: true } } },
    { where: { prop: { id: TASK_STATUS_PROP_ID, exists: false } } },
    { where: { all: [{ tag: '任务' }, { prop: { id: 'p-1', eq: false } }] }, limit: 5 },
    { where: { any: [{ tag: '甲' }, { text: '乙' }] }, sort: [{ by: '_date', dir: 'desc' }] },
    { where: { not: { tag: '任务' } } },
    { where: { not: { all: [{ tag: '甲' }, { text: '乙' }] } } },
    { where: { all: [{ not: { tag: '甲' } }, { any: [{ text: '乙' }, { prop: { id: 'p', eq: 7 } }] }] } },
    { where: { any: [] } },
    { where: { all: [{ any: [{ tag: '甲' }] }] } },
    { where: day },
    { where: { up: { today: { offset: 0 } } } },
    { where: { up: { today: { offset: 2 } } } },
    { where: { up: { today: { offset: -1 } } } },
    { where: { up: { today: { offset: 0 } } }, todayFrom: 'host' },
    { where: { up: { is: 'x' } } },
    { where: { down: { is: 'x' } } },
    { where: { near: { is: 'x' } } },
    { where: { all: [{ down: { is: 'x' } }, { near: { is: 'y' } }] } },
    { where: { prop: { id: '_date', eq: '$self' } } },
  ]
  for (const spec of cases) roundTrip(spec)
})

/**
 * **空组＝没有条件，不是恒真**（「默认不查询」）。
 *
 * `{all:[]}` 在判定里是恒真（`[].every`）——把「还没条件」拼成它，结果就是整个库。
 * 用户看着一个空组时想的是「还没开始筛」，所以树把它读成 `{any:[]}`（永不命中），
 * 与新建查询块的出生条件同一个形状。
 */
test('空组拼回去是「没有条件」：`{all:[]}` 读成 `{any:[]}`，绝不变成全库', () => {
  const draft = treeOfSpec({ where: { all: [] } })
  assert.ok(draft, '空 `all` 要能读进树（不是不可编辑形状）')
  assert.deepEqual(specOfTree(draft).where, { any: [] })
})

test('条件树：路径只认一种顺序（反过来语义相同但字节不同 ⇒ 不假装能编辑）', () => {
  assert.ok(
    treeOfSpec({
      where: { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: '2026-10-20' } }] } },
    }),
  )
  assert.equal(
    treeOfSpec({
      where: { up: { all: [{ prop: { id: '_date', eq: '2026-10-20' } }, { role: 'journal' }] } },
    }),
    null,
  )
})

test('条件树：拆不动的形状返回 null（调用方走只读 JSON，不猜着拆一半）', () => {
  const hard: unknown[] = [
    { where: { down: { text: 'x' } } },
    { where: { near: { tag: 'x' } } },
    { where: { up: { down: { text: 'x' } } } },
    { where: { ref: { to: 'x' } } },
    { where: { ref: { to: 'x', kind: 'inline' } } },
    { where: { role: 'nope' } },
    { where: { not: { not: { tag: 'x' } } } },
    { where: { prop: { id: 'p', eq: 1, neq: 2 } } },
    // 相对日期只在「某一天之下」那行有值位：裸的 `{today}` 走 JSON（语言层合法，树上不假装）
    { where: { today: { offset: 0 } } },
  ]
  for (const spec of hard) assert.equal(treeOfSpec(spec as QuerySpec), null, JSON.stringify(spec))
})

test('多键排序拆得动：树草稿整组保全，拼回去逐字节相等（树自己不编辑它，抬头排序面板是唯一入口）', () => {
  const multi: QuerySpec = { where: { tag: 'x' }, sort: [{ by: 'a', dir: 'asc' }, { by: 'b', dir: 'desc' }] }
  const draft = treeOfSpec(multi)
  assert.ok(draft, '多键排序不再把整份条件逼进 JSON')
  assert.deepEqual(draft.sort, multi.sort)
  assert.equal(JSON.stringify(specOfTree(draft)), JSON.stringify(canonicalSpec(multi)), '往返逐字节相等')
})

test('条件树：没填完的行要能被指出来（不静默丢掉刚敲的那一行）', () => {
  const draft = treeOfSpec({ where: { all: [{ tag: '任务' }, { text: 'x' }] } })
  assert.ok(draft)
  assert.equal(treeIncomplete(draft.root), false)
  const leaf = draft.root.items[1]
  assert.ok(leaf && leaf.kind === 'leaf' && leaf.row.kind === 'text')
  leaf.row.value = ''
  assert.equal(treeIncomplete(draft.root), true)
  assert.equal(treeLeafCount(draft.root), 2, '条数按叶子算（未填的也算一条，用户看得见）')
})
