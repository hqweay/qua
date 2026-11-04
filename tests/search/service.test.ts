/**
 * 搜索门面：**只有 ready 才相信索引**，其余一律扫描降级。
 *
 * 三个真问题：
 *   ① 索引还没建好时，搜索必须还能用（扫描），而不是空结果；
 *   ② 索引里有、模型里已经没有的块（刚软删）不能出现在结果里；
 *   ③ 分词器版本变了 ⇒ 旧索引作废（不能拿旧口径的索引回答新查询）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock, type Block } from '../../src/core/model/model.ts'
import { tokenizeText, FTS_TOKENIZER_VERSION, type TokenizedText } from '../../src/core/search/tokenizer.ts'
import { tokenizeManyWith } from '../../src/app/search/indexer.ts'
import { createSearchService, type SearchBridge } from '../../src/app/search/service.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)

function forest(): Block[] {
  const a = mkBlock('虎鲸笔记是本地优先的', { created: 1, modified: 1 })
  const b = mkBlock('另一条笔记', { created: 2, modified: 2 })
  const gone = mkBlock('已经软删的笔记', { created: 3, modified: 3 })
  gone.props = { _deletedAt: 9 }
  return [a, b, gone]
}

function bridgeOf(
  search?: (match: string, limit: number) => Promise<unknown>,
  saves: unknown[][] = [],
): SearchBridge {
  return {
    save: async (writes) => {
      saves.push(writes)
      return { ok: true }
    },
    ...(search ? { search } : {}),
  }
}

test('没有库面（web）⇒ 扫描；命中与查询口径一致', async () => {
  const blocks = forest()
  const svc = createSearchService({ bridge: null, forest: () => blocks, tokenizer: tokenizeManyWith(tokenize) })
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'scan')
  assert.deepEqual(r.hits.map((h) => h.blockId), blocks.slice(0, 2).map((b) => b.id), '软删的块不出现')
  assert.equal(svc.status(), 'pending')
})

test('索引 ready ⇒ 走 FTS；结果按模型过滤（索引里还有刚软删的块也不给）', async () => {
  const blocks = forest()
  const calls: string[] = []
  const bridge = bridgeOf(async (match) => {
    calls.push(match)
    return { status: 'ok', hits: [{ blockId: blocks[2]!.id, score: 0.1 }, { blockId: blocks[0]!.id, score: 0.2 }] }
  })
  const svc = createSearchService({
    bridge,
    forest: () => blocks,
    snapshot: { map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: FTS_TOKENIZER_VERSION },
    tokenizer: tokenizeManyWith(tokenize),
  })
  assert.equal(svc.mode(), 'fts')
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'fts')
  assert.deepEqual(r.hits.map((h) => h.blockId), [blocks[0]!.id], '软删块被过滤')
  assert.match(calls[0]!, /chars : "笔 记"/)
})

test('FTS 查询失败/主进程报错 ⇒ 当场扫描，不把空结果冒充成功', async () => {
  const blocks = forest()
  const svc = createSearchService({
    bridge: bridgeOf(async () => ({ status: 'error', error: 'boom' })),
    forest: () => blocks,
    snapshot: { map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: FTS_TOKENIZER_VERSION },
    tokenizer: tokenizeManyWith(tokenize),
  })
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'scan')
  assert.equal(r.hits.length, 2)
})

test('分词器版本不匹配 ⇒ 旧索引作废：查询扫描，且要重建', async () => {
  const blocks = forest()
  let rebuilt = 0
  const bridge = bridgeOf(
    async () => {
      throw new Error('should not query stale index')
    },
    [],
  )
  bridge.save = async (writes) => {
    rebuilt += 1
    void writes
    return { ok: true }
  }
  const svc = createSearchService({
    bridge,
    forest: () => blocks,
    snapshot: { map: new Map([['x', 1]]), state: 'ready', rowidSeq: 1, tokenizer: 'old-tokenizer' },
    tokenizer: tokenizeManyWith(tokenize),
  })
  assert.equal(svc.status(), 'pending')
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'scan')
  await svc.rebuild()
  assert.ok(rebuilt > 0, '不匹配的索引必须重建')
  assert.equal(svc.status(), 'ready')
})

test('重建后查询开始走 FTS（状态推进是查询路径的唯一开关）', async () => {
  const blocks = forest()
  let searched = 0
  const bridge = bridgeOf(async () => {
    searched += 1
    return { status: 'ok', hits: [{ blockId: blocks[0]!.id, score: 0 }] }
  })
  const svc = createSearchService({
    bridge,
    forest: () => blocks,
    tokenizer: tokenizeManyWith(tokenize),
  })
  assert.equal(svc.mode(), 'scan')
  await svc.rebuild()
  assert.equal(svc.status(), 'ready')
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'fts')
  assert.equal(searched, 1)
})

test('命中带来源：一块多来源命中去重成一行，留分数最好的来路；扫描降级没有来路', async () => {
  const blocks = forest()
  const bridge = bridgeOf(async () => ({
    status: 'ok',
    hits: [
      { blockId: blocks[0]!.id, source: 'alias', score: 3 },
      { blockId: blocks[0]!.id, source: 'content', score: 1 },
      { blockId: blocks[1]!.id, source: 'tag', score: 2 },
    ],
  }))
  const svc = createSearchService({
    bridge,
    forest: () => blocks,
    snapshot: { map: new Map(), state: 'ready', rowidSeq: 0, tokenizer: FTS_TOKENIZER_VERSION },
    tokenizer: tokenizeManyWith(tokenize),
  })
  const r = await svc.query('笔记')
  assert.equal(r.mode, 'fts')
  assert.deepEqual(
    r.hits.map((h) => `${h.blockId}|${h.source}`),
    [`${blocks[0]!.id}|content`, `${blocks[1]!.id}|tag`],
    '同一块只留一行，来路是分数最好的那一行',
  )

  const scanSvc = createSearchService({ bridge: null, forest: () => blocks, tokenizer: tokenizeManyWith(tokenize) })
  const scanned = await scanSvc.query('笔记')
  assert.equal(scanned.mode, 'scan')
  assert.equal(scanned.hits[0]!.source, undefined, '扫描只搜正文，没有「经由」可言')
})
