/**
 * FTS 增量写入：**同一份分配口径**跑出「重建」与「增量」两种结果，再对账。
 *
 * 四条判据（每条都能单独证伪）：
 *   ① 改正文 ⇒ 旧 rowid 先删、新行再插，映射跟着走；
 *   ② 软删一棵子树 ⇒ **整棵子树**摘索引（op 只落在根上，子树的不可见是继承的）；
 *   ③ 恢复 ⇒ 整棵子树重新进索引；
 *   ④ 增量走到头 ≡ 整库重建（A4），比较的是块 id → 三列内容，不是 rowid。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock, type Block } from '../../src/core/model/model.ts'
import { BlockStore } from '../../src/core/model/store.ts'
import { MemoryKb } from '../../src/core/kb/memory.ts'
import type { Op } from '../../src/core/kb/types.ts'
import { WORKSPACE_VERSION, type Workspace } from '../../src/core/infra/workspace.ts'
import type { RowWrite, StoredWorkspace } from '../../src/core/storage/db-rows.ts'
import { buildAllFtsWrites } from '../../src/core/search/rows.ts'
import { tokenizeText, type TokenizedText } from '../../src/core/search/tokenizer.ts'
import { SearchIndexer, tokenizeManyWith } from '../../src/app/search/indexer.ts'
import { createWorkspaceStore } from '../../src/core/storage/index.ts'
import type { CommitBatch, StoragePort } from '../../src/core/storage/port.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)

function wsOf(blocks: readonly Block[]): Workspace {
  return { version: WORKSPACE_VERSION, blocks: [...blocks], activeId: blocks[0]?.id ?? '', savedAt: 1 }
}
function stored(ws: Workspace): StoredWorkspace {
  return { blocks: ws.blocks, activeId: ws.activeId, savedAt: ws.savedAt }
}
function tokensOf(ws: Workspace): Map<string, TokenizedText> {
  const out = new Map<string, TokenizedText>()
  const walk = (b: Block): void => {
    const text = b.content.map((r) => (r.t === 'text' ? r.v : '')).join('')
    if (text.trim() !== '') out.set(b.id, tokenize(text))
    for (const c of b.children) walk(c)
  }
  for (const b of ws.blocks) walk(b)
  return out
}
function makeIndexer(): SearchIndexer {
  return new SearchIndexer(
    { map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: 't' },
    tokenizeManyWith(tokenize),
  )
}

/** 把一批 FTS 行「应用」成块 id → 三列内容（模拟库里的最终状态） */
function applyWrites(state: Map<string, TokenizedText>, writes: readonly RowWrite[]): Map<string, TokenizedText> {
  const byRow = new Map<number, TokenizedText>()
  const idOfRow = new Map<number, string>()
  const out = new Map(state)
  for (const w of writes) {
    if (w.table === 'BlockFTS' && w.op === 'insert') {
      byRow.set(Number(w.key.rowid), {
        seg: String(w.values!.seg),
        chars: String(w.values!.chars),
        pinyin: String(w.values!.pinyin),
      })
    }
  }
  for (const w of writes) {
    if (w.table === 'BlockFTSMap' && w.op === 'upsert') {
      const row = Number(w.values!.fts_rowid)
      const id = String(w.key.block_id)
      idOfRow.set(row, id)
      const token = byRow.get(row)
      if (token) out.set(id, token)
    }
  }
  for (const w of writes) {
    if (w.table !== 'BlockFTSMap' || w.op !== 'delete') continue
    const id = String(w.key.block_id)
    out.delete(id)
  }
  // 被更新的块：旧映射先删、新映射后写，以最后一次为准
  for (const [row, id] of idOfRow) {
    const token = byRow.get(row)
    if (token) out.set(id, token)
  }
  return out
}

test('增量：改正文先删旧 rowid、再写新行；映射同步前进', async () => {
  const a = mkBlock('旧的笔记', { created: 1, modified: 1 })
  const store = new BlockStore([a])
  const kb = new MemoryKb(store)
  const indexer = makeIndexer()
  indexer.beginRebuild()
  await indexer.planRebuild(stored(wsOf(store.blocks)), new Set([a.id]))
  indexer.endRebuild('t', false)
  assert.equal(indexer.mapSize, 1)

  const edit = kb.tx((tx) => tx.patch(a.id, (b) => { b.content = [{ t: 'text', v: '更新的笔记' }] })).ops
  const plan = await indexer.plan(stored(wsOf(store.blocks)), edit)
  assert.ok(plan)
  const deletes = plan!.writes.filter((w) => w.table === 'BlockFTS' && w.op === 'delete')
  const inserts = plan!.writes.filter((w) => w.table === 'BlockFTS' && w.op === 'insert')
  assert.equal(deletes.length, 1, '旧索引先删')
  assert.equal(inserts.length, 1, '新正文再插')
  assert.match(String(inserts[0]!.values!.seg), /更新/)
  plan!.apply()
  assert.equal(indexer.mapSize, 1, '一块只有一条映射')
})

test('软删：op 只落在根上，但整棵子树都要摘索引；恢复时整棵回来', async () => {
  const root = mkBlock('根上的笔记', { created: 1, modified: 1 })
  const child = mkBlock('子块的笔记', { created: 2, modified: 2 })
  const grand = mkBlock('孙块的笔记', { created: 3, modified: 3 })
  child.children = [grand]
  root.children = [child]
  const store = new BlockStore([root])
  const kb = new MemoryKb(store)
  const indexer = makeIndexer()
  indexer.beginRebuild()
  await indexer.planRebuild(stored(wsOf(store.blocks)), new Set([root.id, child.id, grand.id]))
  indexer.endRebuild('t', false)
  assert.equal(indexer.mapSize, 3)

  const delOps = kb.tx((tx) => tx.remove(root.id)).ops
  assert.equal(delOps.length, 1, '软删只有根一条 op（子树不可见是继承来的）')
  const plan = await indexer.plan(stored(wsOf(store.blocks)), delOps)
  assert.ok(plan)
  const removed = plan!.writes.filter((w) => w.table === 'BlockFTSMap' && w.op === 'delete').map((w) => w.key.block_id)
  assert.deepEqual([...removed].sort(), [child.id, grand.id, root.id].sort(), '整棵子树都要摘')
  plan!.apply()
  assert.equal(indexer.mapSize, 0)

  const backOps = kb.tx((tx) => tx.restore(root.id)).ops
  const back = await indexer.plan(stored(wsOf(store.blocks)), backOps)
  assert.ok(back)
  assert.equal(back!.writes.filter((w) => w.table === 'BlockFTS' && w.op === 'insert').length, 3, '恢复整棵子树')
  back!.apply()
  assert.equal(indexer.mapSize, 3)
})

test('清除：purged 只摘这一块（撤销插入时每块各一条 op）', async () => {
  const a = mkBlock('要撤销的笔记', { created: 1, modified: 1 })
  const store = new BlockStore([a])
  const kb = new MemoryKb(store)
  const indexer = makeIndexer()
  indexer.beginRebuild()
  await indexer.planRebuild(stored(wsOf(store.blocks)), new Set([a.id]))
  indexer.endRebuild('t', false)
  const ops = kb.tx((tx) => tx.remove(a.id)).ops
  const purged: Op[] = ops.map((op) => (op.e === 'block' ? { ...op, op: 'exist', state: 'purged' } : op))
  const plan = await indexer.plan(stored(wsOf(store.blocks)), purged)
  assert.ok(plan)
  assert.equal(plan!.writes.filter((w) => w.table === 'BlockFTSMap' && w.op === 'delete').length, 1)
})

test('A4：增量走到头 ≡ 整库重建（按块 id → 三列内容比较，不看 rowid）', async () => {
  const a = mkBlock('第一条笔记', { created: 1, modified: 1 })
  const b = mkBlock('第二条笔记 应用', { created: 2, modified: 2 })
  const store = new BlockStore([a, b])
  const kb = new MemoryKb(store)
  const indexer = makeIndexer()

  // 从空索引重建：初始状态
  const initial = buildAllFtsWrites(stored(wsOf(store.blocks)), tokensOf(wsOf(store.blocks)))
  let state = applyWrites(new Map(), initial.writes)
  indexer.beginRebuild()
  await indexer.planRebuild(stored(wsOf(store.blocks)), new Set([a.id, b.id]))
  indexer.endRebuild('t', false)

  // 增量：改 A、删 B
  const ops: Op[] = [
    ...kb.tx((tx) => tx.patch(a.id, (block) => { block.content = [{ t: 'text', v: '第零条笔记 应用' }] })).ops,
    ...kb.tx((tx) => tx.remove(b.id)).ops,
  ]
  const plan = await indexer.plan(stored(wsOf(store.blocks)), ops)
  assert.ok(plan)
  state = applyWrites(state, plan!.writes)
  plan!.apply()

  // 从空索引整库重建当前模型，应与增量走到的状态逐块相同
  const fresh = buildAllFtsWrites(stored(wsOf(store.blocks)), tokensOf(wsOf(store.blocks)))
  const rebuildState = applyWrites(new Map(), fresh.writes)
  assert.deepEqual([...state.keys()].sort(), [...rebuildState.keys()].sort(), '命中的块集合必须一致')
  for (const id of state.keys()) assert.deepEqual(state.get(id), rebuildState.get(id), `块 ${id} 的三列必须一致`)
  assert.equal(state.has(b.id), false, '删掉的块不在索引里')
  assert.match(state.get(a.id)!.seg, /第零/)
})

test('计划失败/未就绪：不写索引行，内容照常落盘', async () => {
  const writes: CommitBatch[] = []
  const port: StoragePort = {
    kind: 'fake',
    consumes: 'rows',
    load: async () => ({ status: 'empty' }),
    commit: async (b) => {
      writes.push(b)
      return { ok: true, savedAt: 1 }
    },
    clear: async () => {},
    settle: async () => {},
  }
  const store = createWorkspaceStore(port)
  const w = wsOf([mkBlock('正文', { created: 1, modified: 1 })])
  await store.commit(w, [])
  assert.equal(writes.length, 1)
  assert.equal(writes[0]!.writes!.some((x) => x.table === 'BlockFTS'), false, '没有索引源 ⇒ 不写 FTS')
})

test('提交失败 ⇒ 索引映射保持提交前（不能拿一个没落盘的 rowid 去删）', async () => {
  let fail = true
  const port: StoragePort = {
    kind: 'fake',
    consumes: 'rows',
    load: async () => ({ status: 'empty' }),
    commit: async () => (fail ? { ok: false, error: 'disk full' } : { ok: true, savedAt: 1 }),
    clear: async () => {},
    settle: async () => {},
  }
  const indexer = new SearchIndexer(
    { map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: 't' },
    tokenizeManyWith(tokenize),
  )
  const store = createWorkspaceStore(port, indexer)
  const a = mkBlock('笔记', { created: 1, modified: 1 })
  const w = wsOf([a])
  // 先成功建一次映射
  indexer.beginRebuild()
  await indexer.planRebuild(stored(w), new Set([a.id]))
  indexer.endRebuild('t', false)
  const before = indexer.mapSize

  const ops: Op[] = [{ e: 'block', id: a.id, op: 'upsert', value: { content: [{ t: 'text', v: '改了' }] }, at: 2 }]
  const r = await store.commit(w, ops)
  assert.equal(r.ok, false)
  assert.equal(indexer.mapSize, before, '失败不推进映射')
  fail = false
  const r2 = await store.commit(w, ops)
  assert.equal(r2.ok, true)
  assert.equal(indexer.mapSize, 1)
})
