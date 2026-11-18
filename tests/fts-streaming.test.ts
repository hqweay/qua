/**
 * FTS 流式后台重建：**编排三条出口** ＋ **与整森林重建的等式**。
 *
 * 编排（假 client／store ＋ 真分词器）：
 *   ① 全根成功 ⇒ 置 ready（带分词器版本与水位），每根的索引行都落了；
 *   ② 任一根读失败 ⇒ 不置 ready（半表比空表危险——ready 是「可以信」的承诺）；
 *   ③ 重建期间有编辑被跳过 ⇒ 自动重试一轮，干净后才 ready。
 *
 * 等式（真 SQLite 对拍）：同一份内容，整森林重建（`rebuildSearch`）与流式重建
 * 走两条路落进两个真库，**同一个查询的命中必须相同**——尤其是跨子树的 helper
 * （tag 行要标签块的名字、link 行要引用目标的现算名）：切片里缺这些块，
 * 来源行就静默少词，用户只能感知为「搜索不可信」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { rebuildFtsStreaming } from '../src/app/boot/fts-rebuild.ts'
import { rebuildSearch } from '../src/app/search/rebuild.ts'
import { SearchIndexer, tokenizeManyWith } from '../src/app/search/indexer.ts'
import { tokenizeText, type TokenizedText } from '../src/core/search/tokenizer.ts'
import { compileMatch } from '../src/core/search/query.ts'
import { META_KEYS } from '../src/core/identity/library.ts'
import { workspaceToRowWrites, type RawLibraryRows, type RowWrite, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import { applyRowWrites, openLibraryDb, searchFts, type Db } from '../electron/library/sqlite.ts'
import { readBlockRows, readDocRows, readRootIds } from '../electron/library/reads.ts'
import type { LibraryClient, LibraryReadResult } from '../src/core/storage/library-client.ts'
import type { Block } from '../src/core/model/model.ts'

const tokenize = (text: string): TokenizedText => tokenizeText(text, cut, pinyin as never)
const indexerOf = (): SearchIndexer => new SearchIndexer(undefined, tokenizeManyWith(tokenize))

const id = (c: string) => c.repeat(32)

function block(idStr: string, text: string, children: Block[] = [], props?: Record<string, unknown>): Block {
  return {
    id: idStr,
    content: text.length > 0 ? [{ id: `${idStr}-t`, t: 'text', v: text }] : [],
    children,
    created: 1_700_000_000_000,
    modified: 1_700_000_000_001,
    ...(props ? { props } : {}),
  }
}

/* ═══════════════════════════════════════════════════════ 编排 */

type Row = Record<string, unknown>
const blockRow = (bid: string, text: string, parent: string | null = null): Row => ({
  id: bid,
  parent,
  left: null,
  content: JSON.stringify(text.length > 0 ? [{ id: `${bid}-t`, t: 'text', v: text }] : []),
  created: 1,
  modified: 1,
})
const rows = (blocks: Row[]): RawLibraryRows => ({ blocks, props: [], aliases: [], lists: [], meta: {} })
const emptyRows = (): RawLibraryRows => ({ blocks: [], props: [], aliases: [], lists: [], meta: {} })

function fakeClient(
  rootIds: string[],
  subtrees: Map<string, RawLibraryRows>,
  helpers: RawLibraryRows,
  failDocs: ReadonlySet<string> = new Set(),
): LibraryClient & { calls: string[] } {
  const calls: string[] = []
  const ok = <T>(value: T): LibraryReadResult<T> => ({ status: 'ok', value })
  return {
    calls,
    doc: async (ids) => {
      calls.push(`doc:${ids[0]}`)
      if (ids.some((x) => failDocs.has(x))) return { status: 'error', error: 'boom' }
      return ok({ rows: subtrees.get(ids[0]!) ?? rows([]), ancestors: [], rootIds: [...ids] })
    },
    blocks: async (ids) => {
      calls.push(`blocks:${ids.length}`)
      return ok({ ...helpers, blocks: helpers.blocks.filter((b) => ids.includes(String(b.id))) })
    },
    candidates: async () => ok([]),
    tree: async () => ok(emptyRows()),
    identity: async () => ok(emptyRows()),
    ftsMap: async () => ok([]),
    dependents: async () => ok({ content: [], tag: [], prop: [] }),
    roots: async () => {
      calls.push('roots')
      return ok(rootIds)
    },
    catalog: async () => ok({} as never),
    relations: async () => ok({ rows: [], ready: true }),
  }
}

function fakeStore(onCommit?: (w: readonly RowWrite[]) => void): { writes: RowWrite[]; store: never } {
  const writes: RowWrite[] = []
  const store = {
    commitRaw: async (w: readonly RowWrite[]) => {
      writes.push(...w)
      onCommit?.(w)
      return { ok: true as const }
    },
  }
  return { writes, store: store as never }
}

const readyWrite = (writes: readonly RowWrite[]): RowWrite | undefined =>
  writes.find(
    (w) => w.table === 'meta' && (w.key as Record<string, unknown>).key === META_KEYS.ftsState && w.values?.value === 'ready',
  )

test('流式重建：全部根成功 ⇒ 置 ready（带分词器版本与水位），逐根落索引行', async () => {
  const client = fakeClient(
    ['r1', 'r2'],
    new Map([
      ['r1', rows([blockRow('r1', '第一条笔记'), blockRow('c1', '子块内容', 'r1')])],
      ['r2', rows([blockRow('r2', '另一条笔记')])],
    ]),
    rows([]),
  )
  const { writes, store } = fakeStore()
  const indexer = indexerOf()
  const r = await rebuildFtsStreaming({ client, store, indexer })
  assert.equal(r.ok, true)
  assert.deepEqual(client.calls, ['roots', 'doc:r1', 'doc:r2'], '逐根读，干净路径没有第二次重试')
  assert.ok(readyWrite(writes), '置 ready 的 meta 行在场')
  assert.ok(writes.some((w) => w.table === 'meta' && (w.key as Record<string, unknown>).key === META_KEYS.ftsTokenizer))
  assert.equal(indexer.status, 'ready')
  assert.ok(indexer.mapSize >= 3, 'r1/c1/r2 的来源行都进了映射')
  assert.ok(writes.filter((w) => w.table === 'BlockFTS' && w.op === 'insert').length >= 3)
})

test('流式重建：任一根读失败 ⇒ 不置 ready', async () => {
  const client = fakeClient(
    ['r1', 'r2'],
    new Map([
      ['r1', rows([blockRow('r1', '第一条')])],
      ['r2', rows([blockRow('r2', '第二条')])],
    ]),
    rows([]),
    new Set(['r2']),
  )
  const { writes, store } = fakeStore()
  const indexer = indexerOf()
  const r = await rebuildFtsStreaming({ client, store, indexer })
  assert.equal(r.ok, false)
  assert.equal(r.failed, 1)
  assert.equal(readyWrite(writes), undefined, '失败 ⇒ ready 永不出现')
  assert.equal(indexer.status, 'pending')
})

test('流式重建：期间有编辑被跳过 ⇒ 自动重试一轮，干净后才 ready', async () => {
  const client = fakeClient(['r1'], new Map([['r1', rows([blockRow('r1', '第一条笔记')])]]), rows([]))
  const indexer = indexerOf()
  // 第一轮的索引行落盘之后模拟一次编辑：增量路径在 rebuilding 状态下跳过并记 dirty
  let dirtyInjected = false
  const { writes, store } = fakeStore((w) => {
    if (!dirtyInjected && w.some((x) => x.table === 'BlockFTS' && x.op === 'insert')) {
      dirtyInjected = true
      void indexer.plan({ blocks: [], activeId: '', savedAt: 0 }, [
        { kind: 'block.upsert', id: 'zz', content: [], created: 9, modified: 9, props: {} } as never,
      ])
    }
  })
  const r = await rebuildFtsStreaming({ client, store, indexer })
  assert.equal(r.ok, true, '重试一轮后干净')
  assert.equal(client.calls.filter((c) => c === 'doc:r1').length, 2, '重试 ⇒ 同一根读两轮')
  assert.ok(readyWrite(writes))
})

/* ═══════════════════════════════════════════════════════ 等式（真 SQLite） */

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function freshDb(): { db: Db; dir: string } {
  const d = mkdtempSync(join(tmpdir(), 'qua-fts-'))
  dirs.push(d)
  const opened = openLibraryDb(join(d, 'qua.db'))
  assert.ok(opened.status === 'created' || opened.status === 'ok', `开库失败：${opened.status}`)
  return { db: opened.db, dir: d }
}

/** 跨子树的形状：页 A 归属标签 T、引用页 B；标签与字段定义都是自己的顶层根 */
function richForest(): Block[] {
  const tagBlock = block(id('t'), '', [], { _aliases: ['标签一'], _lists: ['tag'] })
  const defBlock = block(id('k'), '', [], { _aliases: ['备注'], _kind: 'text' })
  const pageB = block(id('b'), '', [block(id('y'), '目标页里的正文内容')], { _aliases: ['页二'], _lists: ['page'] })
  const pageA = block(
    id('a'),
    '',
    [
      block(id('x'), '带归属的块', [], { _tags: [id('t')], [id('k')]: 'AttributeValue' }),
      {
        id: id('m'),
        content: [
          { id: 'm1', t: 'text', v: '看这篇 ' },
          { id: 'm2', t: 'ref', to: id('b') },
        ] as Block['content'],
        children: [],
        created: 1_700_000_000_000,
        modified: 1_700_000_000_001,
      },
    ],
    { _aliases: ['页一', '页别名'], _lists: ['page'], _date: '2026-11-19' },
  )
  return [pageA, pageB, tagBlock, defBlock]
}

test('等式：流式重建与整森林重建在真库上命中相同（含跨子树 helper）', async () => {
  const forest = richForest()
  const ws: StoredWorkspace = { blocks: forest, activeId: id('a'), savedAt: 1 }

  const a = freshDb()
  applyRowWrites(a.db, workspaceToRowWrites(ws))
  const b = freshDb()
  applyRowWrites(b.db, workspaceToRowWrites(ws))

  // 路 A：整森林重建（旧路径的语义基准）
  const indexerA = indexerOf()
  const rA = await rebuildSearch({
    forest: () => forest,
    indexer: indexerA,
    save: async (w) => {
      applyRowWrites(a.db, w)
      return { ok: true as const }
    },
  })
  assert.equal(rA.ok, true)

  // 路 B：流式重建——逐根从库里读（helper 闭包也按 id 从库里补）
  const client: LibraryClient = {
    doc: async (ids) => ({ status: 'ok', value: readDocRows(b.db, ids) }),
    blocks: async (ids) => ({ status: 'ok', value: readBlockRows(b.db, ids) }),
    roots: async () => ({ status: 'ok', value: readRootIds(b.db) }),
    identity: async () => ({ status: 'ok', value: emptyRows() }),
    ftsMap: async () => ({ status: 'ok', value: [] }),
    dependents: async () => ({ status: 'ok', value: { content: [], tag: [], prop: [] } }),
    candidates: async () => ({ status: 'ok', value: [] }),
    tree: async () => ({ status: 'ok', value: emptyRows() }),
    catalog: async () => ({ status: 'ok', value: {} as never }),
    relations: async () => ({ status: 'ok', value: { rows: [], ready: true } }),
  }
  const indexerB = indexerOf()
  const rB = await rebuildFtsStreaming({
    client,
    store: {
      commitRaw: async (w) => {
        applyRowWrites(b.db, w)
        return { ok: true as const }
      },
    } as never,
    indexer: indexerB,
  })
  assert.equal(rB.ok, true)
  assert.equal(indexerB.status, 'ready')

  // 同一个查询在两个库上命中相同（块 id ＋ 来源；相同内容应同序同分）
  const queries = ['笔记', '正文内容', '标签一', '页二', '页别名', 'AttributeValue']
  for (const q of queries) {
    const match = compileMatch(q)
    assert.ok(match, `查询「${q}」应能编译`)
    const hitsOf = (db: Db) => searchFts(db, match!, 50).map((h) => `${h.blockId}:${h.source}`).sort()
    assert.deepEqual(hitsOf(b.db), hitsOf(a.db), `查询「${q}」两个库的命中应相同`)
  }
  // 跨子树 helper 的对拍点必须有真命中：没有它们，这两个查询会双双空手
  const tagHits = searchFts(a.db, compileMatch('标签一')!, 50)
  assert.ok(tagHits.some((h) => h.blockId === id('x')), '按标签名应搜到归属块（tag 行）')
  const refHits = searchFts(a.db, compileMatch('页二')!, 50)
  assert.ok(refHits.some((h) => h.blockId === id('m')), '按目标名应搜到引用块（link 行）')
})
