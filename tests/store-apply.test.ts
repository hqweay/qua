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
import { mkBlock, writeBlockContent } from '../src/core/model.ts'
import { textRuns } from '../src/core/runs.ts'
import { BlockStore } from '../src/core/store.ts'
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

/* ------------------------------------------------------------ 撤销快照：合并时不许取 */

/**
 * **连续打字时不许取撤销快照**。
 *
 * 判据用**序列化字节数**（不用耗时：耗时在并发门禁下会抖）。
 * 一次按键的撤销快照是 `JSON.stringify(整片森林)`；而连续打字时它会被合并进上一笔、
 * **取完就丢**。实测 50000 块时那一笔 10.2ms，而事务本身只有 0.55ms。
 *
 * 反证方式：把 `syncFromDom` 里的 `willMerge` 判断删掉（无条件 `this.snap()`），本条红。
 */
test('撤销快照：合并窗口内**不序列化整片森林**', () => {
  const blocks = Array.from({ length: 200 }, (_, i) => mkBlock(`块${i}`))
  const store = new BlockStore(blocks)
  const target = blocks[100]!

  const orig = JSON.stringify
  let total = 0
  // eslint-disable-next-line no-global-assign
  JSON.stringify = ((v: unknown, ...rest: unknown[]) => {
    const out = (orig as (...a: unknown[]) => string | undefined)(v, ...rest)
    total += typeof out === 'string' ? out.length : 0
    return out
  }) as typeof JSON.stringify
  try {
    const at = Date.now()
    // 第一笔：会真的入栈 ⇒ 必须取快照
    const first = store.undoStack.willMerge('insert', at) ? null : store.snap(null)
    store.record(first, 'insert', at)
    const afterFirst = total
    assert.ok(afterFirst > 0, '第一笔必须取快照（否则撤销无内容可回）')

    // 第二笔（同一毫秒内、同类）⇒ 会被合并 ⇒ 不许再取
    const second = store.undoStack.willMerge('insert', at) ? null : store.snap(null)
    store.record(second, 'insert', at)
    assert.equal(total, afterFirst, '合并窗口内不该再序列化一次整片森林')
    assert.equal(store.undoStack.depth(), 1, '两笔合并成一格（撤销一次回到第一笔之前）')
  } finally {
    JSON.stringify = orig
  }
})

test('撤销快照：超出合并窗口 ⇒ 照常入栈并取快照', () => {
  const blocks = Array.from({ length: 50 }, (_, i) => mkBlock(`块${i}`))
  const store = new BlockStore(blocks)
  const t0 = 1_000_000
  store.record(store.snap(null), 'insert', t0)
  // 超出 1200ms 窗口 ⇒ 不合并
  const at = t0 + store.undoStack.mergeWindowMs + 1
  assert.equal(store.undoStack.willMerge('insert', at), false, '超出窗口就不合并')
  store.record(store.snap(null), 'insert', at)
  assert.equal(store.undoStack.depth(), 2, '两笔各占一格')
})
