/**
 * **落盘不写整库**：接库之后，写路径的输入只有「这批 op 说到的那些格」。
 *
 * 判据只有一条，但它是整个改造的验收口径：
 *
 * > **打一个字的落盘成本，不随库里块数增长。**
 *
 * 这条断言拦的是「有人顺手把整库又序列化了一遍」——那种写法看起来只是慢一点，
 * 实际把成本从存储层搬到了 CPU，而且下一次「库变大了」时它会变成卡顿，
 * 没有任何一层会报错。
 *
 * 三条子判据：
 *   ① 门面按适配器的 `consumes` 准备载荷：`rows` 适配器**不序列化整库**（`payload` 为空）；
 *   ② `bytes` 适配器（浏览器）反过来：要 `payload`、不要行；
 *   ③ 行写入的条数只与**这批 op 碰到的块数**有关（见 `tests/storage/db-rows.test.ts` 的成本断言）。
 *
 * 反证方式：在 `storage/index.ts` 里无条件写 `batch.payload = JSON.stringify(ws)`，本条即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock } from '../../src/core/model.ts'
import { WORKSPACE_VERSION, type Workspace } from '../../src/core/workspace.ts'
import { createWorkspaceStore } from '../../src/core/storage/index.ts'
import { rowWritesFor } from '../../src/core/storage/db-rows.ts'
import type { CommitBatch, StoragePort } from '../../src/core/storage/port.ts'

const ws = (): Workspace => ({
  version: WORKSPACE_VERSION,
  blocks: [mkBlock('x')],
  activeId: '',
  savedAt: 1,
})

function capturePort(consumes: 'bytes' | 'rows'): { port: StoragePort; batch: () => CommitBatch | null } {
  let captured: CommitBatch | null = null
  const port: StoragePort = {
    kind: 'test',
    consumes,
    load: async () => ({ status: 'empty' }),
    commit: async (b) => {
      captured = b
      return { ok: true, savedAt: b.savedAt }
    },
    clear: async () => {},
    settle: async () => {},
  }
  return { port, batch: () => captured }
}

test('门面：`rows` 适配器**不**序列化整库（成本不随库体量增长）', async () => {
  const { port, batch } = capturePort('rows')
  const store = createWorkspaceStore(port)
  const w = ws()
  await store.commit(w, [{ e: 'block', id: w.blocks[0]!.id, op: 'upsert', value: { content: [], modified: 2 }, at: 2 }])
  const b = batch()
  assert.ok(b)
  assert.equal(b!.payload, undefined, '接库的适配器不该收到整份字节：那份序列化就是「整库覆盖写」的成本')
  assert.ok(Array.isArray(b!.writes) && b!.writes!.length > 0, '它要的是行写入')
})

test('门面：`bytes` 适配器反过来 —— 要整份字节、不要行', async () => {
  const { port, batch } = capturePort('bytes')
  const store = createWorkspaceStore(port)
  const w = ws()
  await store.commit(w, [])
  const b = batch()
  assert.ok(b)
  assert.equal(typeof b!.payload, 'string', '浏览器没有库，只能存一份字节')
  assert.equal(b!.writes, undefined, '别把两套载荷都算一遍')
})

test('门面：`replace` 显式传入（不是「零 op 就整份写」——翻页也是零 op）', async () => {
  const { port, batch } = capturePort('rows')
  const store = createWorkspaceStore(port)
  await store.commit(ws(), [])
  assert.equal(batch()!.replace, false, '零 op 且没有整份替换的声明 ⇒ 只写 meta 两格（翻页不该整库重写）')
  await store.commit(ws(), [], { replace: true })
  assert.equal(batch()!.replace, true, '声明了整份替换就必须如实传下去')
})

test('门面：整份替换的行写入覆盖全部块（换库/撤销之后盘上要等于模型）', async () => {
  const { port, batch } = capturePort('rows')
  const store = createWorkspaceStore(port)
  const w = ws()
  await store.commit(w, [], { replace: true })
  const ids = (batch()!.writes ?? []).filter((x) => x.table === 'Block' && x.op === 'upsert').map((x) => x.key.id)
  assert.deepEqual(ids, [w.blocks[0]!.id])
})

/* ------------------------------------------------------------ 撤销：与库体量无关 */

/**
 * **撤销的落盘成本只与「这次撤销涉及的块数」有关，与库体量无关。**
 *
 * 判据沿用本文件的主口径（「小库 == 大库」），只是把它搬到撤销路径上。
 * 为什么这条能一眼证伪旧实现：撤销曾经走 `replace: true` ⇒
 * `workspaceToRowWrites` 把**整库**每一块都写一遍，行数随体量线性增长。
 */
test('撤销：小库与大库的落盘行数**相同**（撤销不再整库重写）', async () => {
  const { mkBlock, writeBlockContent } = await import('../../src/core/model.ts')
  const { textRuns } = await import('../../src/core/runs.ts')
  const { BlockStore } = await import('../../src/core/store.ts')
  const { MemoryKb } = await import('../../src/core/kb/memory.ts')

  /** 造一个 n 块的库，改中间一块的正文，然后撤销 —— 返回这批 op 的行写入条数 */
  const rowsForUndo = (n: number): number => {
    const blocks = Array.from({ length: n }, (_, i) => mkBlock(`块${i}`))
    const store = new BlockStore(blocks)
    const kb = new MemoryKb(store)
    const target = blocks[Math.floor(n / 2)]!

    const before = store.snap(null)
    kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('改了'))))
    store.record(before, 'other', Date.now())

    const r = store.undo('me', null)!
    // 撤销产出的 op 走同一条增量编码路径（`rowWritesFor`，不是 `workspaceToRowWrites`）
    const writes = rowWritesFor({ version: WORKSPACE_VERSION, blocks: store.blocks, activeId: '', savedAt: 1 }, r.ops)
    return writes.filter((w) => w.table === 'Block').length
  }

  const small = rowsForUndo(10)
  const large = rowsForUndo(400)
  assert.equal(small, large, `撤销的 Block 行数必须与库体量无关：10 块 ⇒ ${small} 行，400 块 ⇒ ${large} 行`)
  assert.ok(small > 0, '撤销确实写了东西（不是零行假绿）')
})
