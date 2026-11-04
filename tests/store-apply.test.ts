/**
 * **一个转移**：模型变化只有一个宣布者 —— 事务的出口（`Kb.tx` → `store.apply`）。
 *
 * 判据（每一条都能被独立推翻）：
 *
 * | # | 不变量 | 怎么证伪 |
 * |---|---|---|
 * | ① | 一次事务 ⇒ 订阅者被通知**恰好一次** | 把 `emitChange` 里的 `store.touch` 加回去，本条红 |
 * | ② | 一次事务 ⇒ 索引**不整库重建**（只按 op 修补） | 同上（`touch` 会无条件 `invalidateIndex`） |
 * | ③ | 索引对象**身份不变**（就地修补） | 若某处作废了索引，`store.index` 会换对象 |
 * | ④ | 事务失败 ⇒ 别的视图**不被通知**（模型没变） | 失败路径若也 `apply`，本条红 |
 *
 * 为什么这条比「少一次 JSON.stringify」重要：两个宣布者对「索引还准不准」给出
 * **相反答案**，而两者都不报错 —— 界面只是慢一点、抖一点。这是「同一件事两个宣布者」
 * 的典型形状，也是 `agent-presence-vs-value` 那类静默失效的温床。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, writeBlockContent } from '../src/core/model/model.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

function fixture(): { kb: MemoryKb; store: BlockStore; ids: string[] } {
  const a = mkBlock('甲')
  const b = mkBlock('乙')
  const store = new BlockStore([a, b])
  const kb = new MemoryKb(store)
  // 先让索引建起来（第一次读就是重建；之后的写不该再触发重建）
  store.index
  return { kb, store, ids: [a.id, b.id] }
}

test('① 一次事务 ⇒ 订阅者被通知**恰好一次**', () => {
  const { kb, store, ids } = fixture()
  const calls: number[] = []
  store.subscribe(() => calls.push(1))
  kb.tx((tx) => tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('改过')))
  )
  assert.equal(calls.length, 1, '一次事务只宣布一次（曾经是两次：事务出口一次、编辑器 touch 一次）')
})

test('② 一次事务 ⇒ 索引**不整库重建**（按 op 修补）', () => {
  const { kb, store, ids } = fixture()
  const before = store.probe.rebuildCount
  kb.tx((tx) => tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('改过')))
  )
  // 读一次索引（若被作废，这里就会重建）
  assert.ok(store.index.blocks.has(ids[0]!))
  assert.equal(store.probe.rebuildCount, before, '一次打字之后第一次读索引不该整库重建')
})

test('③ 索引对象身份不变（就地修补，不是作废重建）', () => {
  const { kb, store, ids } = fixture()
  const before = store.index
  kb.tx((tx) => tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('改过')))
  )
  assert.equal(store.index, before, '索引被就地修补 ⇒ 同一个对象；作废重建会换对象')
})

test('④ 事务失败 ⇒ 别的视图不被通知（模型没变）', () => {
  const { kb, store, ids } = fixture()
  const calls: number[] = []
  store.subscribe(() => calls.push(1))
  const rebuilds = store.probe.rebuildCount
  assert.throws(
    () => kb.tx((tx) => tx.patch(ids[0]!, (b) => {
      writeBlockContent(b, textRuns('改过'))
      b.children.push(mkBlock('偷偷塞进去'))
    })),
    /changed children/,
    'patch 不许改子树（结构改动必须走 insert/move/remove）',
  )
  assert.equal(calls.length, 0, '失败的事务什么都没发生 ⇒ 不该宣布')
  assert.equal(store.probe.rebuildCount, rebuilds, '失败路径也不该触发重建（下次读索引时按需）')
})

test('连续 N 次事务 ⇒ 通知 N 次、重建 0 次（成本不随次数累积）', () => {
  const { kb, store, ids } = fixture()
  let calls = 0
  store.subscribe(() => calls++)
  const rebuilds = store.probe.rebuildCount
  for (let i = 0; i < 5; i++) {
    kb.tx((tx) => tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns(`第${i}次`)))
    )
  }
  assert.equal(calls, 5, 'N 次事务 ⇒ N 次通知（不是 2N）')
  assert.equal(store.probe.rebuildCount, rebuilds, 'N 次事务 ⇒ 0 次整库重建')
})

/* ------------------------------------------------------------ 撤销条目：合并窗口与字节 */

/**
 * **合并窗口内不新建条目，且撤销一次回到第一笔之前。**
 *
 * 判据是行为而不是实现：旧实现靠「合并时跳过整库快照」省时间；现在捕获只含 touched 的块，
 * 无论合不合并都不会碰整片森林 —— 所以这里钉「一步」的语义，字节另有一条。
 */
test('撤销条目：合并窗口内不新建条目，撤销一次回到第一笔之前', () => {
  const blocks = Array.from({ length: 200 }, (_, i) => mkBlock(`块${i}`))
  const store = new BlockStore(blocks)
  const kb = new MemoryKb(store)
  const target = blocks[100]!
  const t0 = 1_000_000

  const first = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一'))))
  store.record(first.undo, null, 'insert', t0)
  const second = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一二'))))
  store.record(second.undo, null, 'insert', t0 + 10)

  assert.equal(store.undoStack.depth(), 1, '窗口内两笔合并成一格')
  const r = store.undo('me', null)!
  assert.equal(plainText(target.content), '块100', '撤销回到第一笔之前，而不是第二笔之前')
  assert.ok(r.ops.length > 0)
})

test('撤销条目：超出合并窗口 ⇒ 两笔各占一格', () => {
  const blocks = Array.from({ length: 50 }, (_, i) => mkBlock(`块${i}`))
  const store = new BlockStore(blocks)
  const kb = new MemoryKb(store)
  const target = blocks[25]!
  const t0 = 1_000_000
  const at = t0 + store.undoStack.mergeWindowMs + 1

  const a = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一'))))
  store.record(a.undo, null, 'insert', t0)
  const b = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一二'))))
  store.record(b.undo, null, 'insert', at)

  assert.equal(store.undoStack.depth(), 2, '超出窗口就不合并，两笔各占一格')
})

/* ------------------------------------------------------------ 真实按键链路 */

/**
 * **「用户按一下」的撤销条目字节，不随库体量增长**（首次按键与连续按键都一样）。
 *
 * 为什么用字节不用耗时：耗时在并发门禁下会抖；序列化字节数是**决定性**的。
 * 旧实现在首次按键时序列化整片森林（100 → 10,000 块约大两个量级），
 * 现在条目只含这一块的前后态。
 */
test('真实按键链路：撤销条目字节在 100 块与 10,000 块的库上**相同**', () => {
  /** @returns 第一笔、第二笔（合并窗口内）各自的条目字节 */
  const bytes = (n: number): [number, number] => {
    // 目标块的初始正文在两档库里**完全一样**：条目字节只该反映「动过的那一块」
    const blocks = Array.from({ length: n }, (_, i) => mkBlock(i === Math.floor(n / 2) ? '目标块' : `块${i}`))
    const store = new BlockStore(blocks)
    const kb = new MemoryKb(store)
    const target = blocks[Math.floor(n / 2)]!
    const t0 = 1_000_000
    // 预热：索引先建起来（首次重建不算进被测那一笔）
    store.index

    const first = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一'))))
    store.record(first.undo, null, 'insert', t0)
    const second = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('一二'))))
    store.record(second.undo, null, 'insert', t0 + 10)
    assert.equal(store.undoStack.depth(), 1, '同一窗口内两笔是一步')
    return [JSON.stringify(first.undo).length, JSON.stringify(second.undo).length]
  }

  const small = bytes(100)
  const large = bytes(10_000)
  assert.deepEqual(
    large,
    small,
    `撤销条目字节必须与库体量无关：100 块 ⇒ ${small.join('/')}，10000 块 ⇒ ${large.join('/')}。` +
      `条目里若还带着整片森林，10000 块会比 100 块大两个量级`,
  )
  assert.ok(small[1] < 500, `一次连续打字的条目只该序列化动过的那一块：实际 ${small[1]} 字节`)
})
