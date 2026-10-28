/**
 * **事务失败 ⇒ 森林逐字节等于进门时**（回滚日志的正确性）。
 *
 * 判据是**性质**，不是「看起来恢复了」：
 *
 * > 任意一条 `tx` 抛错之后，`forestFingerprint(森林)` 必须与进门时**逐字节相等**。
 *
 * 为什么要它：回滚日志替掉的是「整库快照」这个实现细节 —— 语义不变，只是成本从
 * O(整库) 降到 O(动过的块)。而「语义不变」这句话只有逐字节比对能证明：
 * 少记一格（例如 `children`）时，界面看起来只是「那一块多了一个子块」，
 * 没有任何一层会报错。
 *
 * 反证方式：把 `snapBlock` 里 `children: b.children.slice()` 那一项删掉，
 * 「patch 改 children 后抛错」那一条立刻红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, writeBlockContent } from '../src/core/model.ts'
import { textRuns } from '../src/core/runs.ts'
import { forestFingerprint } from '../src/core/kb/diff.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

function fixture(): { kb: MemoryKb; store: BlockStore; ids: string[] } {
  const a1 = mkBlock('甲的子块')
  const a = { ...mkBlock('甲'), children: [a1] }
  const b = mkBlock('乙')
  const c = mkBlock('丙')
  const store = new BlockStore([a, b, c])
  const kb = new MemoryKb(store)
  return { kb, store, ids: [a.id, a1.id, b.id, c.id] }
}

/** 断言：这一笔抛错，且抛错之后森林与进门时逐字节相等 */
function failsWithoutChange(kb: MemoryKb, store: BlockStore, run: () => void, pattern: RegExp): void {
  const before = forestFingerprint(store.blocks)
  assert.throws(run, pattern)
  assert.equal(forestFingerprint(store.blocks), before, '抛错之后森林必须逐字节等于进门时')
}

test('回滚①：patch 改了 `children` ⇒ 抛错，且子树退回原样', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(
    kb,
    store,
    () => kb.tx((tx) => tx.patch(ids[0]!, (b) => void b.children.push(mkBlock('偷偷塞进去')))),
    /changed children/,
  )
})

test('回滚②：patch 改了正文与属性之后抛错 ⇒ 两者都退回', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(
    kb,
    store,
    () =>
      kb.tx((tx) => {
        tx.patch(ids[0]!, (b) => {
          writeBlockContent(b, textRuns('改了'))
          b.modified = 999
          b.props = { _icon: 'lucide:x' }
        })
        throw new Error('boom')
      }),
    /boom/,
  )
})

test('回滚③：move 进自己的子树 ⇒ 抛错，且位置不变', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(kb, store, () => kb.tx((tx) => tx.move(ids[0]!, ids[1]!, 0)), /own subtree/)
})

test('回滚④：insert 到不存在的父 ⇒ 抛错，且什么都没插进去', () => {
  const { kb, store } = fixture()
  failsWithoutChange(kb, store, () => kb.tx((tx) => tx.insert(mkBlock('新'), '不存在', 0)), /no such parent/)
})

test('回滚⑤：一次成功写入之后又抛错 ⇒ 那一次写入也退回', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(
    kb,
    store,
    () =>
      kb.tx((tx) => {
        tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('改了')))
        tx.setTags(ids[2]!, ['t1'])
        tx.insert(mkBlock('新'), ids[0]!, 0)
        throw new Error('boom')
      }),
    /boom/,
  )
})

test('回滚⑥：软删之后抛错 ⇒ 删除标记摘回去', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(
    kb,
    store,
    () =>
      kb.tx((tx) => {
        tx.remove(ids[2]!)
        throw new Error('boom')
      }),
    /boom/,
  )
})

test('回滚⑦：撤销一次软删之后抛错 ⇒ 标记回到「已删」', () => {
  const { kb, store, ids } = fixture()
  kb.tx((tx) => tx.remove(ids[2]!))
  failsWithoutChange(
    kb,
    store,
    () =>
      kb.tx((tx) => {
        tx.restore(ids[2]!)
        throw new Error('boom')
      }),
    /boom/,
  )
})

test('回滚⑧：同一块被改两次后抛错 ⇒ 退回到**第一次之前**（逆序应用）', () => {
  const { kb, store, ids } = fixture()
  failsWithoutChange(
    kb,
    store,
    () =>
      kb.tx((tx) => {
        tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('第一次')))
        tx.patch(ids[0]!, (b) => writeBlockContent(b, textRuns('第二次')))
        throw new Error('boom')
      }),
    /boom/,
  )
})

/* ------------------------------------------------------------ 成本：不再整库序列化 */

/**
 * **一次事务不再序列化整片森林。**
 *
 * 判据用**序列化字节数**，不用耗时（耗时在并发门禁下抖动，断言会脆）：
 * 把 `JSON.stringify` 包一层数总输出字节 —— 旧实现进门就 `JSON.stringify(整片森林)`
 * ⇒ 字节数 ≈ 库大小；新实现只序列化动过的那一块的内容 ⇒ 与库体量**无关**。
 *
 * 这条是「小库 == 大库」在 CPU 侧的最小版本（落盘侧已有 `tests/storage/write-cost.test.ts`）。
 * 反证方式：在 `tx` 进门加回 `JSON.stringify(this.store.blocks)`，本条立刻红。
 */
test('成本：一次事务的序列化字节**不随库体量增长**', () => {
  const bytesPerTx = (n: number): number => {
    const blocks = Array.from({ length: n }, (_, i) => mkBlock(`块${i}`))
    const store = new BlockStore(blocks)
    const kb = new MemoryKb(store)
    const target = blocks[Math.floor(n / 2)]!
    // 预热（索引首次重建不该算进被测的那一笔）
    kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('预热'))))

    const orig = JSON.stringify
    let total = 0
    // eslint-disable-next-line no-global-assign
    JSON.stringify = ((v: unknown, ...rest: unknown[]) => {
      const out = (orig as (...a: unknown[]) => string | undefined)(v, ...rest)
      total += typeof out === 'string' ? out.length : 0
      return out
    }) as typeof JSON.stringify
    try {
      kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('改了'))))
    } finally {
      JSON.stringify = orig
    }
    return total
  }

  const small = bytesPerTx(10)
  const large = bytesPerTx(400)
  assert.equal(
    small,
    large,
    `一次事务的序列化字节必须与库体量无关：10 块 ⇒ ${small} 字节，400 块 ⇒ ${large} 字节。` +
      `进门若仍是「整片森林 JSON」，400 块会比 10 块大一个量级`,
  )
  assert.ok(small < 2000, `一次打字只该序列化动过的那一块：实际 ${small} 字节`)
})
