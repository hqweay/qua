/**
 * **日志即状态**的验收：`replay(ops)` 必须与当前模型逐字节相等。
 *
 * 这不是「再测一遍 diff」：`tests/kb-diff.test.ts` 测的是 `apply(a, diff(a,b)) == b`，
 * 它允许 `applyOps` 拿目标快照当「复活块的来源」。这里测的是**只凭日志**：
 * 从空森林开始，一条一条应用 `op_log` 里的历史，结果必须与库里的模型一致。
 *
 * 三条判据（任意一条红都说明日志不是完整的事实源）：
 *   ① `replay(diff(∅, 种子) ＋ 编辑流) == 当前森林`；
 *   ② 同一批 op 应用两次 ＝ 一次（幂等）；
 *   ③ 撤销产生的 op 也在同一条流里，重放能走回快照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, writeBlockContent } from '../src/core/model.ts'
import { textRuns } from '../src/core/runs.ts'
import { diff, forestFingerprint, replay } from '../src/core/kb/diff.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { Op } from '../src/core/kb/types.ts'

const at = (n: number): Partial<{ created: number; modified: number }> => ({ created: n, modified: n })

function same(forest: readonly unknown[], ops: readonly Op[]): void {
  assert.equal(
    forestFingerprint(replay(ops) as never),
    forestFingerprint(forest as never),
    '重放结果必须与模型逐字节相等（键序已规范化）',
  )
}

test('① 空库 → 种子：diff(∅, 种子) 的每一块都自带位置、出生、时刻与正文', () => {
  const tag = mkBlock('todo', { ...at(10), props: { _aliases: ['todo'], _lists: ['tag'] } })
  const child = mkBlock('子块', at(11))
  const page = mkBlock('页面', {
    ...at(12),
    props: { _aliases: ['页面', '别名'], _lists: ['page'], _icon: 'lucide:x' },
    children: [child],
  })
  const forest = [page, tag]
  same(forest, diff([], forest))
})

test('② 一次事务会话：插入／改字／改属性／标签／annos／移动／软删／恢复 全部可重放', () => {
  const a = mkBlock('甲', at(100))
  const b = mkBlock('乙', at(101))
  const store = new BlockStore([a, b])
  const kb = new MemoryKb(store)
  const ops: Op[] = [...diff([], store.blocks)]

  const fresh = mkBlock('新块', at(102))
  ops.push(...kb.tx((tx) => tx.insert(fresh, a.id, 0)).ops)
  ops.push(...kb.tx((tx) => tx.patch(fresh.id, (x) => writeBlockContent(x, textRuns('改过的')))).ops)
  ops.push(...kb.tx((tx) => tx.setProp(fresh.id, '_icon', 'lucide:star')).ops)
  ops.push(...kb.tx((tx) => tx.setTags(b.id, [fresh.id])).ops)
  ops.push(...kb.tx((tx) => tx.setAnnos(a.id, [{ id: 'an1', range: { start: 0, end: 1 } }])).ops)
  ops.push(...kb.tx((tx) => tx.move(b.id, null, 0)).ops)
  ops.push(...kb.tx((tx) => tx.remove(a.id)).ops)
  ops.push(...kb.tx((tx) => tx.restore(a.id)).ops)

  same(store.blocks, ops)
  assert.equal(store.find(fresh.id)?.created, 102, 'created 从 genesis 一路保留')
  assert.equal(store.find(a.id)?.props?._tags, undefined)
})

test('③ 撤销产生的 op 在同一条流里：重放能走回快照', () => {
  const a = mkBlock('甲', at(200))
  const store = new BlockStore([a])
  const kb = new MemoryKb(store)
  const ops: Op[] = [...diff([], store.blocks)]

  const snap = store.snap(null)
  const fresh = mkBlock('插进去的', at(201))
  ops.push(...kb.tx((tx) => tx.insert(fresh, a.id, 0)).ops)
  const undo = store.restore(snap)
  ops.push(...undo.ops)

  assert.equal(store.find(fresh.id), undefined, '撤销把它清除了')
  same(store.blocks, ops)
  assert.ok(
    undo.ops.some((o) => o.e === 'block' && o.op === 'exist' && o.state === 'purged' && o.id === fresh.id),
    '撤销一次插入必须是 purged，不是软删',
  )
})

test('④ 幂等：同一批 op 应用两次 ＝ 一次', () => {
  const a = mkBlock('甲', at(300))
  const forest = [a]
  const ops = diff([], forest)
  const once = replay(ops)
  const twice = replay(ops)
  assert.equal(forestFingerprint(twice), forestFingerprint(once))
  // 再把这批 op 应用到已经重放出来的森林上
  const again = replay([...ops, ...ops])
  assert.equal(forestFingerprint(again), forestFingerprint(once))
})

test('⑤ 软删与清除是两件事：软删留在树上，purged 真的消失', () => {
  const a = mkBlock('甲', at(400))
  const store = new BlockStore([a])
  const kb = new MemoryKb(store)
  const ops: Op[] = [...diff([], store.blocks)]
  const beforeRemove = store.snap(null)

  ops.push(...kb.tx((tx) => tx.remove(a.id)).ops)
  let r = replay(ops)
  assert.equal(r.length, 1, '软删不摘树')
  assert.equal(typeof r[0]!.props?._deletedAt, 'number', '软删标记在块上')
  assert.equal(forestFingerprint(r), forestFingerprint(store.blocks))

  ops.push(...store.restore(beforeRemove).ops) // 撤销删除（回到没删的样子）
  r = replay(ops)
  assert.equal(r[0]!.props?._deletedAt, undefined)
  same(store.blocks, ops)
})

test('⑥ 父必须先出现：残缺日志抛错，不静默落到顶层', () => {
  assert.throws(
    () =>
      replay([
        {
          e: 'block',
          id: 'child',
          op: 'upsert',
          value: { parent: 'missing-parent', prev: null, created: 1, modified: 1, content: [] },
          at: 1,
        },
      ]),
    /missing parent/,
    '父不在树上是日志残缺，不是「当顶层」的许可',
  )
})
