/**
 * FTS rowid 的**水位必须与映射一起落盘**。
 *
 * 症状：重启之后再编辑一块，报 `UNIQUE constraint failed: BlockFTSMap.fts_rowid`。
 * 根因候选有两条，这一组分别钉住：
 *   ① 增量计划只写 `BlockFTS`／`BlockFTSMap`，不推进 `meta.fts_rowid_seq`；
 *      重开时按一个**旧水位**起算，新分配的 rowid 撞上仍存在的映射行；
 *   ② 即使盘上水位旧了（历史库），加载时也要按映射里的最大 rowid 兜底，
 *      否则第一次编辑仍然会撞——修未来数据不能把存量库留在坏状态里。
 *
 * 走真 SQLite：UNIQUE 是库给的判据，不是我们在内存里自说自话。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock } from '../../src/core/model/model.ts'
import { BlockStore } from '../../src/core/model/store.ts'
import { MemoryKb } from '../../src/core/kb/memory.ts'
import { META_KEYS } from '../../src/core/identity/library.ts'
import { ftsRowKey } from '../../src/core/search/sources.ts'
import { tokenizeText, type TokenizedText } from '../../src/core/search/tokenizer.ts'
import { applyRowWrites, openLibraryDb, readMeta, type Db } from '../../electron/library/sqlite.ts'
import { SearchIndexer, tokenizeManyWith } from '../../src/app/search/indexer.ts'
import { rebuildSearch } from '../../src/app/search/rebuild.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)
const tokenizeMany = tokenizeManyWith(tokenize)

const dirs: string[] = []
function freshDb(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-fts-seq-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 从盘上把渲染层启动时看到的那份快照读回来（与 `ipc-adapter.searchOf` 同口径） */
function snapshotOf(db: Db): { map: Map<string, number>; rowidSeq: number } {
  const map = new Map<string, number>()
  for (const r of db.prepare('select block_id, source, fts_rowid from BlockFTSMap').all() as {
    block_id: string
    source: string
    fts_rowid: number
  }[]) {
    map.set(ftsRowKey(r.block_id, r.source), Number(r.fts_rowid))
  }
  return { map, rowidSeq: Number(readMeta(db, META_KEYS.ftsRowidSeq) ?? 0) }
}

async function indexed(): Promise<{
  db: Db
  store: BlockStore
  kb: MemoryKb
  indexer: SearchIndexer
  a: ReturnType<typeof mkBlock>
  b: ReturnType<typeof mkBlock>
}> {
  const db = freshDb()
  const a = mkBlock('第一块正文', { created: 1, modified: 1 })
  const b = mkBlock('第二块正文', { created: 2, modified: 2 })
  const store = new BlockStore([a, b])
  const kb = new MemoryKb(store)
  const indexer = new SearchIndexer(undefined, tokenizeMany)
  const r = await rebuildSearch({
    forest: () => store.blocks,
    indexer,
    save: async (writes) => {
      applyRowWrites(db, writes)
      return { ok: true as const }
    },
  })
  assert.equal(r.ok && r.clean, true, `前置：索引要建干净 ${JSON.stringify(r)}`)
  assert.equal(indexer.status, 'ready')
  return { db, store, kb, indexer, a, b }
}

test('增量编辑：水位与映射同一批落盘（重开不会回退）', async () => {
  const { db, store, kb, indexer, a } = await indexed()
  const edit = kb.tx((tx) => tx.patch(a.id, (blk) => { blk.content = [{ t: 'text', v: '第一块改写' }] })).ops
  const plan = await indexer.plan({ blocks: store.blocks, activeId: '', savedAt: 1 }, edit)
  assert.ok(plan, '改正文要产一份索引计划')
  applyRowWrites(db, plan!.writes)
  plan!.apply()

  const seq = Number(readMeta(db, META_KEYS.ftsRowidSeq) ?? 0)
  assert.equal(seq, indexer.currentRowid, '落盘水位必须等于内存分配器（重启从这里接着发号）')
  const maxInMap = Math.max(...snapshotOf(db).map.values())
  assert.equal(seq, maxInMap, '水位与映射里的最大 rowid 对齐')
})

test('重开之后继续编辑：新 rowid 不复用盘上已有的映射', async () => {
  const { db, store, kb, indexer, a, b } = await indexed()
  // 第一次增量：把水位推到重建之后（旧实现里这一步不落盘）
  const first = kb.tx((tx) => tx.patch(a.id, (blk) => { blk.content = [{ t: 'text', v: '第一块改写' }] })).ops
  const p1 = await indexer.plan({ blocks: store.blocks, activeId: '', savedAt: 1 }, first)
  assert.ok(p1)
  applyRowWrites(db, p1!.writes)
  p1!.apply()

  // 模拟「关掉再打开」：只从盘上读快照
  const snap = snapshotOf(db)
  const reopened = new SearchIndexer(
    { map: snap.map, state: 'ready', rowidSeq: snap.rowidSeq, tokenizer: 't' },
    tokenizeMany,
  )
  const second = kb.tx((tx) => tx.patch(b.id, (blk) => { blk.content = [{ t: 'text', v: '第二块改写' }] })).ops
  const p2 = await reopened.plan({ blocks: store.blocks, activeId: '', savedAt: 1 }, second)
  assert.ok(p2, '重开后的第一次编辑也要能规划')
  // 旧实现会把上面这行之前的 apply 抛在 UNIQUE 上；走到这里再显式对账一次
  assert.doesNotThrow(() => applyRowWrites(db, p2!.writes), '重开后的新 rowid 不许撞已有映射')
  p2!.apply()
  const values = [...snapshotOf(db).map.values()]
  assert.equal(new Set(values).size, values.length, `fts_rowid 必须全局唯一：${JSON.stringify(values)}`)
})

test('历史库水位偏旧：加载时按映射最大值兜底（存量库不需要重建）', async () => {
  const { db, store, kb, indexer, a, b } = await indexed()
  const first = kb.tx((tx) => tx.patch(a.id, (blk) => { blk.content = [{ t: 'text', v: '第一块改写' }] })).ops
  const p1 = await indexer.plan({ blocks: store.blocks, activeId: '', savedAt: 1 }, first)
  assert.ok(p1)
  applyRowWrites(db, p1!.writes)
  p1!.apply()

  // 故意把水位读成 0（老版本落下的库就是这个形状）
  const snap = snapshotOf(db)
  const reopened = new SearchIndexer(
    { map: snap.map, state: 'ready', rowidSeq: 0, tokenizer: 't' },
    tokenizeMany,
  )
  const second = kb.tx((tx) => tx.patch(b.id, (blk) => { blk.content = [{ t: 'text', v: '第二块改写' }] })).ops
  const p2 = await reopened.plan({ blocks: store.blocks, activeId: '', savedAt: 1 }, second)
  assert.ok(p2)
  assert.doesNotThrow(() => applyRowWrites(db, p2!.writes), '水位偏旧时也要从映射最大值之后发号')
  const values = [...snapshotOf(db).map.values()]
  assert.equal(new Set(values).size, values.length, `fts_rowid 必须全局唯一：${JSON.stringify(values)}`)
})
