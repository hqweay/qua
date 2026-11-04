/**
 * 端到端（真 SQLite）：分词 → RowWrite → contentless FTS → 查询编译 → bm25。
 *
 * 这一条钉的是报告里最容易静默失效的两件事：
 *   · `人口` 被 jieba 的更长词条吞掉时，`chars : "人 口"` 仍能召回；
 *   · 拼音前缀查询 `"ren kou"*` 能命中。
 *
 * 不经过 UI、不经过 worker：worker 只是同一个 `tokenizeText` 的运输层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { mkBlock } from '../../src/core/model/model.ts'
import type { StoredWorkspace } from '../../src/core/storage/db-rows.ts'
import { applyRowWrites, openLibraryDb, searchFts } from '../../electron/library/sqlite.ts'
import { buildAllFtsWrites } from '../../src/core/search/rows.ts'
import { ftsRowKey } from '../../src/core/search/sources.ts'
import { compileMatch } from '../../src/core/search/query.ts'
import { tokenizeText, type TokenizedText } from '../../src/core/search/tokenizer.ts'

const dirs: string[] = []
function db() {
  const d = mkdtempSync(join(tmpdir(), 'qua-fts-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)

test('端到端：词中字（人口）靠 chars phrase 召回，拼音前缀命中，删索引后不残留', () => {
  const database = db()
  const a = mkBlock('人口密度很大的城市', { created: 1, modified: 1 })
  const b = mkBlock('无关的一条', { created: 2, modified: 2 })
  const ws: StoredWorkspace = { blocks: [a, b], activeId: a.id, savedAt: 1 }
  const tokens = new Map<string, TokenizedText>([
    [ftsRowKey(a.id, 'content'), tokenize('人口密度很大的城市')],
    [ftsRowKey(b.id, 'content'), tokenize('无关的一条')],
  ])
  // 分词器把「人口密度」当整词（报告里的召回缺口），chars 列仍是逐字
  assert.equal(tokens.get(ftsRowKey(a.id, 'content'))!.seg, '人口密度 很大 的 城市')
  const built = buildAllFtsWrites(ws, tokens)
  applyRowWrites(database, built.writes)

  const q = (text: string) => {
    const match = compileMatch(text)
    assert.ok(match, `查询 ${text} 应当编译出表达式`)
    return searchFts(database, match!, 20).map((h) => h.blockId)
  }
  assert.deepEqual(q('人口'), [a.id], 'seg 单 token 会漏，chars phrase 必须补上')
  assert.deepEqual(q('人口 城市'), [a.id], '多词 AND')
  assert.deepEqual(q('ren kou'), [a.id], '拼音前缀')
  assert.deepEqual(q('城市'), [a.id], '2 字词')
  assert.deepEqual(q('不存在的词'), [], '真没有就是空，不是错误')

  // 改正文：旧索引按 rowid 删掉，新正文重新插（block id 不变）
  const a2 = { ...a, content: [{ t: 'text' as const, v: '换了一条正文' }], modified: 3 }
  const next = buildAllFtsWrites(
    { blocks: [a2, b], activeId: a.id, savedAt: 2 },
    new Map([
      [ftsRowKey(a.id, 'content'), tokenize('换了一条正文')],
      [ftsRowKey(b.id, 'content'), tokenize('无关的一条')],
    ]),
  )
  applyRowWrites(database, [
    { table: 'BlockFTS', op: 'clear', key: {} },
    { table: 'BlockFTSMap', op: 'clear', key: {} },
    ...next.writes,
  ])
  assert.deepEqual(q('人口'), [], '旧行必须真的从索引里消失')
  assert.deepEqual(q('换了一条'), [a.id])
  database.close()
})

test('端到端：`chars : 笔记` 静默 0 —— 编译器的逐字 phrase 是唯一正确写法', () => {
  const database = db()
  const a = mkBlock('这本笔记本很厚', { created: 1, modified: 1 })
  const ws: StoredWorkspace = { blocks: [a], activeId: a.id, savedAt: 1 }
  const built = buildAllFtsWrites(ws, new Map([[ftsRowKey(a.id, 'content'), tokenize('这本笔记本很厚')]]))
  applyRowWrites(database, built.writes)

  assert.deepEqual(
    searchFts(database, 'chars : "笔记"', 10),
    [],
    '整词写法在 unicode61 下就是 0（不报错）',
  )
  assert.deepEqual(
    searchFts(database, 'chars : "笔 记"', 10).map((h) => h.blockId),
    [a.id],
    '逐字 phrase 才能召回「笔记本」里的「笔记」',
  )
  database.close()
})
