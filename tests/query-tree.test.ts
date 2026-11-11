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
  dayStartMs,
  runQuery,
  shiftISO,
  specOfTree,
  treeIncomplete,
  treeLeafCount,
  treeNodeOfRow,
  treeOfSpec,
  TASK_STATUS_PROP_ID,
  type Block,
  type QuerySpec,
  type TreeRow,
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
    // 方向是节点上的一格：任意叶子 / 整组都能挂（「上级匹配所有」两种形状各有字节）
    { where: { down: { text: 'x' } } },
    { where: { near: { tag: '甲' } } },
    { where: { up: { ref: 'x' } } },
    { where: { up: { prop: { id: 'p-1', eq: 7 } } } },
    { where: { up: { all: [{ tag: '甲' }, { text: '乙' }] } } },
    { where: { down: { any: [{ tag: '甲' }, { text: '乙' }] } } },
    { where: { all: [{ up: { tag: '甲' } }, { up: { tag: '乙' } }] } },
    { where: { not: { up: { ref: 'x' } } } },
    { where: { not: { down: { all: [{ tag: '甲' }, { text: '乙' }] } } } },
    { where: { today: { offset: 1 } } },
    { where: { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: '$self' } }] } } },
    // 时间范围：三种形状各自往返（值是本地日零点上的毫秒）
    { where: { prop: { id: 'core/created', gte: dayStartMs('2026-10-20') } } },
    { where: { prop: { id: 'core/modified', lt: dayStartMs('2026-10-20') } } },
    {
      where: {
        all: [
          { prop: { id: 'core/created', gte: dayStartMs('2026-10-20') } },
          { prop: { id: 'core/created', lt: dayStartMs('2026-10-21') } },
        ],
      },
    },
    // 不是零点的时刻没有日期等价物 ⇒ 当普通属性行（字节仍不变）
    { where: { prop: { id: 'core/created', gte: dayStartMs('2026-10-20') + 3_600_000 } } },
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

test('「某一天」的预设只认一种顺序；反过来的 all 仍可编辑（当成组，字节不变）', () => {
  const preset = treeOfSpec({
    where: { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: '2026-10-20' } }] } },
  })
  assert.ok(preset)
  assert.equal(preset.root.items[0]?.kind, 'leaf', '顺序对 ⇒ 一行「某一天」（预设）')

  // 顺序反了：不是预设，但它是「一层组挂上级」，照样能编辑；拼回去逐字节相等
  const reversed: QuerySpec = {
    where: { up: { all: [{ prop: { id: '_date', eq: '2026-10-20' } }, { role: 'journal' }] } },
  }
  const draft = treeOfSpec(reversed)
  assert.ok(draft)
  assert.equal(draft.root.items[0]?.kind, 'group', '顺序反 ⇒ 当普通组，不假装认成预设')
  roundTrip(reversed)
})

test('条件树：拆不动的形状返回 null（调用方走只读 JSON，不猜着拆一半）', () => {
  const hard: unknown[] = [
    // 方向里再套方向：UI 只给一层（语言层合法）
    { where: { up: { down: { text: 'x' } } } },
    // 「非」不在最外层：`{up:{not:…}}` 与 `{not:{up:…}}` 语义不同，只认后者
    { where: { up: { not: { text: 'x' } } } },
    { where: { ref: { to: 'x' } } },
    { where: { ref: { to: 'x', kind: 'inline' } } },
    { where: { role: 'nope' } },
    { where: { not: { not: { tag: 'x' } } } },
    { where: { prop: { id: 'p', eq: 1, neq: 2 } } },
  ]
  for (const spec of hard) assert.equal(treeOfSpec(spec as QuerySpec), null, JSON.stringify(spec))
})

test('「非」在外、方向在内：两种语义不混成一种形状', () => {
  // 没有这样的上级（最常用）⇒ 可编辑，拼回去逐字节相等
  roundTrip({ where: { not: { up: { ref: 'x' } } } })
  // 上级里存在一块不满足 ⇒ 只读 JSON（语言层合法，树不生成它）
  assert.equal(treeOfSpec({ where: { up: { not: { ref: 'x' } } } }), null)
})

test('方向挂组与挂叶子是两种形状：「同一处满足整组」≠「各条件各找一处」', () => {
  const one: QuerySpec = { where: { up: { all: [{ tag: '甲' }, { text: '乙' }] } } }
  const each: QuerySpec = { where: { all: [{ up: { tag: '甲' } }, { up: { text: '乙' } }] } }
  roundTrip(one)
  roundTrip(each)
  assert.notEqual(
    JSON.stringify(specOfTree(treeOfSpec(one)!)),
    JSON.stringify(specOfTree(treeOfSpec(each)!)),
    '两种语义的字节必须不同（否则 specKey 判不出「条件变了」）',
  )
})

test('合成根上的方向也是真的（用户给根组挂了上级）', () => {
  const draft = treeOfSpec({ where: { tag: 'x' } })
  assert.ok(draft && draft.synthesizedRoot)
  draft.root.dir = 'up'
  assert.deepEqual(specOfTree(draft).where, { up: { tag: 'x' } }, '不因为多了方向就包一层 all')
})

test('时间范围：就在这一天＝[当天零点, 次日零点)，从起／早于各是一侧', () => {
  const start = dayStartMs('2026-10-20')
  const next = dayStartMs(shiftISO('2026-10-20', 1))
  const row: TreeRow = { kind: 'stamp', field: 'core/created', op: 'on', date: '2026-10-20' }
  assert.deepEqual(
    treeNodeOfRow(row),
    { all: [{ prop: { id: 'core/created', gte: start } }, { prop: { id: 'core/created', lt: next } }] },
    '「就在这一天」展开成半开区间，不含次日零点',
  )

  const mk = (id: string, created: number): Block => ({ id, content: [], children: [], created, modified: created })
  const blocks = [
    mk('before', start - 1),
    mk('mid', start + 12 * 3_600_000),
    mk('edge', next),
  ]
  const hits = (r: TreeRow) =>
    runQuery({ where: treeNodeOfRow(r)! }, { blocks }).map((h) => h.blockId)

  assert.deepEqual(hits(row), ['mid'], '当天中午命中、次日零点不命中')
  assert.deepEqual(hits({ ...row, op: 'after' }), ['mid', 'edge'], '从这天起＝当天零点以后')
  assert.deepEqual(hits({ ...row, op: 'before' }), ['before'], '早于这一天＝当天零点以前')
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
