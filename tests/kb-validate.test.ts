/**
 * **op 的值与正文判据**（`core/system-props.ts` 登记表 ＋ `kb/diff.ts` 发看点的两道闸
 * ＋ `kb/validate.ts` 的收端）。
 *
 * 判据是**性质**，不是「碰巧今天没人写坏值」：
 *
 * > 任何让库变化的路径——`setProp`、专用方法、`patch` 的就地改——都产不出
 * > 「系统键的值形状不对」或「往身份块正文里写字」的 op；收端对**不是本地产出的流**
 * > （撤销/回放/将来的远端）用同一张表先验再吃。
 *
 * 反证方式：把 `kb/diff.ts` `propOps` 里那段 `systemPropViolation` 删掉，
 * 「写侧逐键」整组立刻红；把 `applyOps` 入口的 `validate` 删掉，「收端」整组红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, mkPropDef, type Block } from '../src/core/index.ts'
import { writeBlockContent } from '../src/core/model/model.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { applyOps, diff, forestFingerprint } from '../src/core/kb/diff.ts'
import { validate } from '../src/core/kb/validate.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { mkJournalBlock } from '../src/core/identity/journal.ts'
import { DIVIDER_TYPE, setBlockType } from '../src/core/model/types.ts'
import { mkQueryBlock } from '../src/core/query/query-view.ts'
import type { Op } from '../src/core/kb/types.ts'

function fixture(): { kb: MemoryKb; store: BlockStore; ids: string[] } {
  const a1 = mkBlock('甲的子块')
  const a = { ...mkBlock('甲'), children: [a1] }
  const b = mkBlock('乙')
  const store = new BlockStore([a, b])
  const kb = new MemoryKb(store)
  return { kb, store, ids: [a.id, a1.id, b.id] }
}

/** 断言：这一笔抛错，且抛错之后森林与进门时逐字节相等（回滚语义不受新闸影响） */
function failsWithoutChange(kb: MemoryKb, store: BlockStore, run: () => void, pattern: RegExp): void {
  const before = forestFingerprint(store.blocks)
  assert.throws(run, pattern)
  assert.equal(forestFingerprint(store.blocks), before, '抛错之后森林必须逐字节等于进门时')
}

/* ------------------------------------------------------- 写侧：逐键非法值 */

test('写侧：系统键的坏值在 op 发看点被拒，森林逐字节不变', () => {
  const { kb, store, ids } = fixture()
  // 每行一个键：坏值 ⇒ 抛错；「合法 ⇒ 放行」由下一组单独证（防「永远红」的假绿）
  const bad: [key: string, value: unknown][] = [
    ['_tags', '任务'], // 不是数组
    ['_tags', ['t1', 42]], // 数组里混进非字符串
    ['_belongsTo', 42],
    ['_date', '2026/10/24'], // 格式错了会改变身份（id 由日期派生）
    ['_date', '2026年10月24日'],
    ['_kind', 'bogus'],
    ['_icon', ''],
    ['_fieldDefs', 42],
    ['_ownProps', 42],
    ['_uiPosition', 'center'],
    ['_aliases', []], // 空数组与「没有这一格」是两种写法
    ['_lists', ['page', 'page']], // 无序集合：重复没有第二种语义
    ['_display', 'both'],
    ['_query', 'garbage'],
    ['_query', { where: {} }], // where 里一个条件原子都没有 ⇒ 读不出来
    ['_views', 'x'],
    ['_activeView', 42],
    ['_mounts', 42],
    ['_embed', 42],
    ['_choiceScope', { mode: 'bogus' }],
  ]
  for (const [key, value] of bad) {
    failsWithoutChange(kb, store, () => kb.tx((tx) => tx.setProp(ids[2]!, key, value)), new RegExp(`invalid value for system prop "${key}"`))
  }
})

test('写侧：未登记的 `_` 键一律拒绝（保留区没有「顺手写一个」的格子）', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(kb, store, () => kb.tx((tx) => tx.setProp(ids[2]!, '_bogus', 'x')), /unregistered system prop "_bogus"/)
})

test('写侧：合法值放行（`_type` 刻意开放；id 列表允许悬空）', () => {
  const { kb, ids } = fixture()
  // 不抛 ＝ 放行；逐键的「坏 ⇒ 拒」已由上一组证明
  kb.tx((tx) => tx.setProp(ids[2]!, '_type', 'future-plugin-type'))
  kb.tx((tx) => tx.setProp(ids[2]!, '_tags', ['不存在的标签 id'])) // 悬空合法：软删要能自愈
  kb.tx((tx) => tx.setProp(ids[2]!, '_date', '2026-11-01'))
  kb.tx((tx) => tx.setProp(ids[2]!, '_query', { where: { text: 'x' } }))
})

test('写侧：专用方法与 `patch` 的就地改走同一道闸', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(kb, store, () => kb.tx((tx) => tx.setTags(ids[2]!, ['t1', 42])), /invalid value for system prop "_tags"/)
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(ids[2]!, (b) => { b.props = { ...(b.props ?? {}), _tags: 'garbage' } })),
    /invalid value for system prop "_tags"/,
  )
})

/* ------------------------------------------------------- 写侧：正文闸 */

test('正文闸：往日记行里写字 ⇒ 抛错且森林不变（正文是日期投影，不是内容）', () => {
  const { kb, store } = fixture()
  const day = mkJournalBlock('2026-11-01')
  kb.tx((tx) => tx.insert(day, null, 0))
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(day.id, (b) => writeBlockContent(b, textRuns('偷偷写进日期行')))),
    /content is protected/,
  )
})

test('正文闸：字段定义的名字只能经创建/改名路径来', () => {
  const { kb, store } = fixture()
  const def = mkPropDef('状态', 'text')
  kb.tx((tx) => tx.insert(def, null, 0))
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(def.id, (b) => writeBlockContent(b, textRuns('改名')))),
    /content is protected/,
  )
})

test('正文闸：`text: readonly` 类型（分割线）没有正文可写', () => {
  const { kb, store, ids } = fixture()
  kb.tx((tx) => tx.patch(ids[2]!, (b) => void setBlockType(b, DIVIDER_TYPE)))
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(ids[2]!, (b) => writeBlockContent(b, textRuns('分割线上写字')))),
    /content is protected/,
  )
})

test('正文闸：普通块照常可写（闸只拦身份与只读）', () => {
  const { kb, ids } = fixture()
  kb.tx((tx) => tx.patch(ids[2]!, (b) => writeBlockContent(b, textRuns('普通内容'))))
})

/* -------------------------------------------- 查询块：正文即标题，直接打字可写 */

test('正文闸：查询块的正文（标题）只许直接编辑写，结构写路径仍被拦', () => {
  const { kb, store } = fixture()
  const q = mkQueryBlock({ name: '', spec: { where: { all: [] } } })
  kb.tx((tx) => tx.insert(q, null, 0))

  // 不带「直接编辑」标记的同一笔（结构写路径）必须抛错并整批回滚
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(q.id, (b) => writeBlockContent(b, textRuns('查询标题')))),
    /content is protected/,
  )

  // 直接编辑（打字／行内粘贴／行内删除）放行，且只产出一条正文 op
  const r = kb.tx((tx) => tx.patch(q.id, (b) => writeBlockContent(b, textRuns('查询标题'))), {
    directEdit: true,
  })
  assert.equal(plainText(store.find(q.id)!.content), '查询标题')
  assert.ok(
    r.ops.some((op) => op.e === 'block' && op.id === q.id && op.op === 'upsert' && op.value.content !== undefined),
    '直接编辑必须产生一条正文 op',
  )
})

test('回放：查询块正文 op 应用后仍在（收端按直接改名接受）', () => {
  const { kb } = fixture()
  const q = mkQueryBlock({ name: '', spec: { where: { all: [] } } })
  kb.tx((tx) => tx.insert(q, null, 0))
  const r = kb.tx((tx) => tx.patch(q.id, (b) => writeBlockContent(b, textRuns('查询标题'))), {
    directEdit: true,
  })

  // 同形森林（查询块正文还是空的）＋ 这一笔 op ⇒ 重放后正文在
  const forest: Block[] = [{ ...q, content: textRuns('') }]
  applyOps(forest, r.ops)
  assert.equal(plainText(forest[0]!.content), '查询标题')
})

/* ------------------------------------------------------- 收端：op 流先验再吃 */

test('收端：validate 对系统键坏值 / 未登记键 / 受保护正文各给一条违规', () => {
  const journal = mkJournalBlock('2026-11-01')
  const forest: Block[] = [journal]
  const violations = validate(forest, [
    { e: 'prop', block: journal.id, name: '_tags', op: 'set', value: 'garbage', at: 1 },
    { e: 'prop', block: journal.id, name: '_bogus', op: 'set', value: 'x', at: 1 },
    { e: 'block', id: journal.id, op: 'upsert', value: { content: textRuns('x') }, at: 1 },
  ] as Op[])
  assert.equal(violations.length, 3)
  assert.match(violations[0]!.reason, /invalid value for system prop "_tags"/)
  assert.match(violations[1]!.reason, /unregistered system prop/)
  assert.match(violations[2]!.reason, /content is protected/)

  // 查询块的正文是它的标题：收端按「直接改名」接受（其余受保护块仍拒，见上）
  const query = mkQueryBlock({ name: '', spec: { where: { all: [] } } })
  const queryViolations = validate([query], [
    { e: 'block', id: query.id, op: 'upsert', value: { content: textRuns('查询标题') }, at: 1 },
  ] as Op[])
  assert.equal(queryViolations.length, 0)
})

test('收端：validate 保留结构判据（父存在 / 成环）', () => {
  const a: Block = { ...mkBlock('甲'), id: 'a' }
  const b1: Block = { ...mkBlock('乙'), id: 'b' }
  const forest: Block[] = [{ ...a, children: [b1] }]
  const violations = validate(forest, [
    { e: 'block', id: 'new', op: 'upsert', value: { parent: 'missing', prev: null }, at: 1 },
    { e: 'block', id: 'a', op: 'upsert', value: { parent: 'b', prev: null }, at: 1 },
  ] as Op[])
  assert.equal(violations.length, 2)
  assert.match(violations[0]!.reason, /parent "missing" does not exist/)
  assert.match(violations[1]!.reason, /inside its own subtree/)
})

test('收端：applyOps 对坏流抛错，森林一个字节不动', () => {
  const journal = mkJournalBlock('2026-11-01')
  const forest: Block[] = [journal]
  const before = forestFingerprint(forest)
  const bad: Op[] = [{ e: 'prop', block: journal.id, name: '_tags', op: 'set', value: 'garbage', at: 1 }]
  assert.throws(() => applyOps(forest, bad), /op batch rejected/)
  assert.equal(forestFingerprint(forest), before, '校验失败必须发生在任何写入之前')
})

test('收端：合法流照常应用（闸不拦正常业务）', () => {
  const { store, ids } = fixture()
  const target = JSON.parse(JSON.stringify(store.blocks)) as Block[]
  const t = target.find((x) => x.id === ids[2]!)!
  t.props = { ...(t.props ?? {}), _tags: ['t1'] }
  const ops = diff(store.blocks, target)
  applyOps(store.blocks, ops)
  assert.deepEqual(store.blocks.find((x) => x.id === ids[2]!)?.props?._tags, ['t1'])
})
