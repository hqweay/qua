/**
 * **obj 记录**的纯逻辑测试：记录不是新种类，是「带一条归属的普通内容块」。
 *
 * 这里钉四件事（都是实现里最容易走形的判据）：
 *   ① 记录**没有地址**：正文是描述，不写 `_aliases`；身份由「哪条引用指向它」给出；
 *   ② 记录**带 `_tags` 归属**：于是它自动是标签成员，查询/字段都不用另开一条路；
 *   ③ 记录**落在森林顶层**：与页块、标签块同一条落点口径；不为了它先物化一天；
 *   ④ 无事务的兜底路径与事务路径**落同一个位置、同一个形状**（不能长出第二套判据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasesOf, listsOf, tagIdsOf } from '../src/core/index.ts'
import { createObjRecordDirect, createObjRecordInTx, mkObjRecord } from '../src/core/obj.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { journalId, mkJournalBlock } from '../src/core/journal.ts'
import { plainText } from '../src/core/runs.ts'

test('mkObjRecord：正文＝键入名（描述）、归属＝标签、没有地址也没有露面', () => {
  const r = mkObjRecord(' 咖啡 ', 'tag-1')
  assert.equal(plainText(r.content), '咖啡')
  assert.deepEqual(tagIdsOf(r), ['tag-1'])
  assert.deepEqual(aliasesOf(r), [], '记录 v1 无地址：正文不参与「按名找块」')
  assert.deepEqual(listsOf(r), [], '记录不是页/标签：它只有归属，没有露面位')
  assert.ok(r.created > 0 && r.modified > 0, '块上的两个时刻是必填字段')
})

test('createObjRecordInTx：记录落在森林顶层；不为了它先物化一天', () => {
  const store = new BlockStore([])
  const kb = new MemoryKb(store)
  const { result, ops } = kb.tx((tx) => createObjRecordInTx(tx, store.blocks, '咖啡', 'tag-1'))

  assert.equal(store.blocks.length, 1, '森林里只有这条记录')
  assert.equal(store.blocks[0]?.id, result.id, '记录本身是根块')
  assert.equal(store.blocks.some((b) => b.props?._date !== undefined), false, '不该顺手物化今天')
  const positions = ops.filter((o): o is Extract<(typeof ops)[number], { e: 'block' }> => o.e === 'block')
  assert.equal(positions.length, 1, `只应报这一块：${JSON.stringify(ops)}`)
  assert.equal(positions[0]!.value.parent, null, '记录的 parent 是 null')
  assert.equal(positions[0]!.value.prev, null, '空森林里它是第一个根')
})

test('createObjRecordInTx：森林已有别的根 ⇒ 记录接在末尾（前兄弟是最后一个根）', () => {
  const store = new BlockStore([mkJournalBlock('2026-10-25')])
  const kb = new MemoryKb(store)
  const { result, ops } = kb.tx((tx) => createObjRecordInTx(tx, store.blocks, '咖啡', 'tag-1'))

  assert.equal(store.blocks.length, 2, '天块本来就在：森林多出一个根')
  assert.equal(store.blocks[1]?.id, result.id)
  const pos = ops.filter(
    (o): o is Extract<(typeof ops)[number], { e: 'block' }> =>
      o.e === 'block' && o.op === 'upsert' && o.value.parent !== undefined,
  )
  assert.equal(pos.length, 1, `只插记录一块：${JSON.stringify(ops)}`)
  assert.equal(pos[0]!.value.parent, null)
  assert.equal(pos[0]!.value.prev, journalId('2026-10-25'), '接在已有根的末尾')
  assert.equal(plainText(pos[0]!.value.content ?? []), '咖啡', 'genesis 带正文')
  const tagOp = ops.find((o) => o.e === 'prop' && o.name === '_tags')
  assert.ok(tagOp && tagOp.e === 'prop' && tagOp.op === 'set', '归属走 prop 格')
  assert.deepEqual(tagOp.value, ['tag-1'])
})

test('createObjRecordDirect：与事务路径同一个位置、同一个形状（兜底不另立口径）', () => {
  const forest = [mkJournalBlock('2026-10-25')]
  const r = createObjRecordDirect(forest, '咖啡', 'tag-1')
  assert.equal(forest.length, 2)
  assert.equal(forest[1]?.id, r.id, '兜底路径也落在顶层末尾')
  assert.deepEqual(tagIdsOf(r), ['tag-1'])
})
