/**
 * **obj 记录**的纯逻辑测试：记录不是新种类，是「带一条归属的普通内容块」。
 *
 * 这里钉四件事（都是实现里最容易走形的判据）：
 *   ① 记录**没有地址**：正文是描述，不写 `_aliases`；身份由「哪条引用指向它」给出；
 *   ② 记录**带 `_tags` 归属**：于是它自动是标签成员，查询/字段都不用另开一条路；
 *   ③ 记录**落当天**：与页块同一条落点口径；当天不存在时同一笔物化；
 *   ④ 无事务的兜底路径与事务路径**落同一天、同一个形状**（不能长出第二套判据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { aliasesOf, listsOf, tagIdsOf } from '../src/core/index.ts'
import { createObjRecordDirect, createObjRecordInTx, mkObjRecord } from '../src/core/obj.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { findJournalDay, journalId, mkJournalBlock, todayISO } from '../src/core/journal.ts'
import { plainText } from '../src/core/runs.ts'

test('mkObjRecord：正文＝键入名（描述）、归属＝标签、没有地址也没有露面', () => {
  const r = mkObjRecord(' 咖啡 ', 'tag-1')
  assert.equal(plainText(r.content), '咖啡')
  assert.deepEqual(tagIdsOf(r), ['tag-1'])
  assert.deepEqual(aliasesOf(r), [], '记录 v1 无地址：正文不参与「按名找块」')
  assert.deepEqual(listsOf(r), [], '记录不是页/标签：它只有归属，没有露面位')
  assert.ok(r.created > 0 && r.modified > 0, '块上的两个时刻是必填字段')
})

test('createObjRecordInTx：记录落在当天；当天不存在时与它同一笔物化', () => {
  const store = new BlockStore([])
  const kb = new MemoryKb(store)
  const at = new Date(2026, 9, 25, 9, 30)
  const { result, ops } = kb.tx((tx) => createObjRecordInTx(tx, (id) => kb.get(id), '咖啡', 'tag-1', at))

  const day = findJournalDay(store.blocks, todayISO(at))
  assert.ok(day, '当天应被物化（幂等）')
  assert.equal(day.children[0]?.id, result.id, '记录应落进当天、末尾')
  assert.equal(ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value.parent === null).length, 1, '天块本身在森林顶层：1 条')
  assert.equal(ops.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value.parent === day.id).length, 1, '记录挂在当天下：1 条')
})

test('createObjRecordInTx：当天已存在 ⇒ 只插记录（不重复物化天）', () => {
  const store = new BlockStore([mkJournalBlock('2026-10-25')])
  const kb = new MemoryKb(store)
  const at = new Date(2026, 9, 25, 18)
  const { result, ops } = kb.tx((tx) => createObjRecordInTx(tx, (id) => kb.get(id), '咖啡', 'tag-1', at))

  assert.equal(store.blocks.length, 1, '天块本来就在：森林仍是 1 个顶层块')
  assert.deepEqual(ops.map((o) => (o.e === 'block' ? o.value : null)), [{ parent: journalId('2026-10-25'), prev: null }])
  assert.equal(findJournalDay(store.blocks, '2026-10-25')?.children[0]?.id, result.id)
})

test('createObjRecordDirect：与事务路径同一天、同一个形状（兜底不另立口径）', () => {
  const at = new Date(2026, 9, 25, 23, 59)
  const forest = [mkJournalBlock(todayISO(at))]
  const r = createObjRecordDirect(forest, '咖啡', 'tag-1', at)
  assert.equal(forest.length, 1)
  assert.equal(forest[0]?.children.at(-1)?.id, r.id)
  assert.deepEqual(tagIdsOf(r), ['tag-1'])
})
