/**
 * 全量重建：分批、推进状态、失败降级、重建期间编辑不丢正文。
 *
 * 判据不是「写入行数漂亮」，而是三条可证伪的语义：
 *   ① 清表 → 建行 → 标 ready（顺序不能反：ready 之后读路径才相信索引）；
 *   ② 重建期间来的编辑被跳过 ⇒ 不能标 ready（否则索引缺一块，搜不到却不报错）；
 *   ③ 任何一步失败 ⇒ 状态保持 pending，查询继续扫描。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock } from '../../src/core/model/model.ts'
import type { Block } from '../../src/core/model/model.ts'
import type { Op } from '../../src/core/kb/types.ts'
import type { RowWrite } from '../../src/core/storage/db-rows.ts'
import { META_KEYS } from '../../src/core/identity/library.ts'
import { tokenizeText, type TokenizedText } from '../../src/core/search/tokenizer.ts'
import { SearchIndexer, tokenizeManyWith } from '../../src/app/search/indexer.ts'
import { rebuildSearch } from '../../src/app/search/rebuild.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)
const indexerOf = (): SearchIndexer =>
  new SearchIndexer(undefined, tokenizeManyWith(tokenize), () => {})

function capture(): { writes: RowWrite[][]; save: (w: readonly RowWrite[]) => Promise<{ ok: true }> } {
  const writes: RowWrite[][] = []
  return {
    writes,
    save: async (w) => {
      writes.push([...w])
      return { ok: true }
    },
  }
}

test('重建：先清表再分批写，最后标 ready（写进分词器版本与 rowid 水位）', async () => {
  const blocks = [mkBlock('第一条笔记', { created: 1, modified: 1 }), mkBlock('第二条笔记', { created: 2, modified: 2 })]
  const indexer = indexerOf()
  const cap = capture()
  const r = await rebuildSearch({ forest: () => blocks, indexer, save: cap.save })
  assert.equal(r.ok, true)
  assert.equal(r.clean, true)
  assert.equal(indexer.status, 'ready')
  assert.equal(indexer.mapSize, 2)

  const flat = cap.writes.flat()
  assert.ok(flat.some((w) => w.table === 'BlockFTS' && w.op === 'clear'), '第一步清表')
  assert.equal(flat.filter((w) => w.table === 'BlockFTS' && w.op === 'insert').length, 2)
  assert.ok(flat.some((w) => w.table === 'meta' && w.key.key === META_KEYS.ftsState && w.values?.value === 'ready'))
  assert.ok(flat.some((w) => w.table === 'meta' && w.key.key === META_KEYS.ftsTokenizer && String(w.values?.value).length > 0))
})

test('重建期间来了编辑 ⇒ 不标 ready（索引缺一块时宁可继续扫描）', async () => {
  const a = mkBlock('第一条笔记', { created: 1, modified: 1 })
  const blocks = [a]
  const indexer = indexerOf()
  const cap = capture()
  let injected = false
  const save = async (w: readonly RowWrite[]) => {
    // 第一批索引写进去之后，模拟用户改了一块：store 会走 indexer.plan
    if (!injected && w.some((x) => x.table === 'BlockFTS' && x.op === 'insert')) {
      injected = true
      const ops: Op[] = [{ e: 'block', id: a.id, op: 'upsert', value: { content: [{ t: 'text', v: '重建期间改的' }] }, at: 9 }]
      assert.equal(await indexer.plan({ blocks, activeId: a.id, savedAt: 1 }, ops), null)
    }
    return cap.save(w)
  }
  const r = await rebuildSearch({ forest: () => blocks, indexer, save })
  assert.equal(r.ok, true)
  assert.equal(r.clean, false, '重建期间有编辑 ⇒ 不算干净')
  assert.equal(indexer.status, 'pending', '仍要降级扫描')
  const flat = cap.writes.flat()
  assert.ok(
    flat.some((w) => w.table === 'meta' && w.key.key === META_KEYS.ftsState && w.values?.value === 'pending'),
    '把 pending 写回库，下次打开与本次看到同一个答案',
  )
})

test('重建中途写库失败 ⇒ 保持 pending（索引坏了不许连累正文）', async () => {
  const blocks = [mkBlock('笔记', { created: 1, modified: 1 })]
  const indexer = indexerOf()
  let n = 0
  const save = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
    n += 1
    // 第一次是清表，第二次是索引批次：让索引批次失败
    return n === 1 ? { ok: true } : { ok: false, error: 'disk full' }
  }
  const r = await rebuildSearch({ forest: () => blocks, indexer, save })
  assert.equal(r.ok, false)
  assert.equal(indexer.status, 'pending')
})

test('空库：清表之后直接 ready（没有块可建，不是失败）', async () => {
  const indexer = indexerOf()
  const cap = capture()
  const r = await rebuildSearch({ forest: () => [] as Block[], indexer, save: cap.save })
  assert.equal(r.ok, true)
  assert.equal(r.clean, true)
  assert.equal(indexer.status, 'ready')
})
