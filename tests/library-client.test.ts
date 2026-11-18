/**
 * 库读端口（`LibraryClient`）与主进程读计数。
 *
 * 判据三条：
 *   ① `doc`／`catalog` 的回复必须**分型**：`no-library`／`bad-args`／`error` 不许被解包成
 *      「空 Doc」——那会让上一页看起来真的空；
 *   ② 坏回复在**发生的那一层**停下（带通道名），不把 `undefined` 漏给调用方；
 *   ③ 读计数：`doc`／`catalog` 不增 `full`，全库装载单独记 `full`／`fullRows`——
 *      这是「首帧到底读了整库没有」的直接证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { libraryId } from '../src/core/identity/library.ts'
import { createLibraryClient, type LibraryReadBridge } from '../src/core/storage/library-client.ts'
import type { LibraryCatalog, LibraryDocRows } from '../src/core/storage/library-reads.ts'
import { loadContent, openSession, readCatalog, readDoc, saveContent } from '../electron/library/session.ts'
import type { RowWrite } from '../electron/library/sqlite.ts'

function doc(root = 'p'): LibraryDocRows {
  return { rows: { blocks: [{ id: root }], props: [], aliases: [], lists: [], meta: {} }, ancestors: [], rootIds: [root] }
}

function catalog(): LibraryCatalog {
  return { journals: [], tags: [], propDefs: [], trash: [] }
}

function bridgeOf(replies: { doc?: unknown; catalog?: unknown }): LibraryReadBridge & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    doc: async (roots) => {
      calls.push([...roots])
      return replies.doc
    },
    catalog: async () => replies.catalog,
  }
}

/* ------------------------------------------------------------ ① 正常转发 */

test('client：doc 原样转发 root 列表并解包；catalog 同', async () => {
  const bridge = bridgeOf({
    doc: { status: 'ok', doc: doc() },
    catalog: { status: 'ok', catalog: catalog() },
  })
  const client = createLibraryClient(bridge)

  const r = await client.doc(['a', 'b'])
  assert.equal(r.status, 'ok')
  if (r.status === 'ok') assert.deepEqual(r.value.rootIds, ['p'])
  assert.deepEqual(bridge.calls, [['a', 'b']], 'roots 是装配层的决定，传输层不改写')

  const c = await client.catalog()
  assert.equal(c.status, 'ok')
  if (c.status === 'ok') assert.deepEqual(c.value.tags, [])
})

/* ------------------------------------------------------------ ② 失败分型 */

test('client：no-library／bad-args／error 如实分型，不把失败当空 Doc', async () => {
  const noLib = createLibraryClient(bridgeOf({ doc: { status: 'no-library' }, catalog: { status: 'no-library' } }))
  assert.deepEqual(await noLib.doc(['p']), { status: 'no-library' })
  assert.deepEqual(await noLib.catalog(), { status: 'no-library' })

  const badArgs = createLibraryClient(bridgeOf({ doc: { status: 'bad-args' } }))
  assert.deepEqual(await badArgs.doc([]), { status: 'bad-args' })

  const err = createLibraryClient(bridgeOf({ doc: { status: 'error', error: 'db boom' } }))
  assert.deepEqual(await err.doc(['p']), { status: 'error', error: 'library/doc: db boom' })
})

test('client：坏回复停在发生的那一层（状态不对／形状不对都报错）', async () => {
  const unknown = createLibraryClient(bridgeOf({ doc: null }))
  const a = await unknown.doc(['p'])
  assert.equal(a.status, 'error')

  const flat = createLibraryClient(bridgeOf({ doc: { status: 'ok', doc: { blocks: [] } } }))
  const b = await flat.doc(['p'])
  assert.equal(b.status, 'error')
  assert.match(b.status === 'error' ? b.error : '', /bad reply shape/)

  const cat = createLibraryClient(bridgeOf({ catalog: { status: 'ok', catalog: { tags: [] } } }))
  const c = await cat.catalog()
  assert.equal(c.status, 'error')
  assert.match(c.status === 'error' ? c.error : '', /bad reply shape/)
})

test('client：桥抛错 ⇒ error（带通道名，不静默）', async () => {
  const bridge: LibraryReadBridge = {
    doc: async () => {
      throw new Error('ipc gone')
    },
    catalog: async () => {
      throw new Error('ipc gone')
    },
  }
  const client = createLibraryClient(bridge)
  assert.deepEqual(await client.doc(['p']), { status: 'error', error: 'library/doc: ipc gone' })
  assert.deepEqual(await client.catalog(), { status: 'error', error: 'library/catalog: ipc gone' })
})

/* ------------------------------------------------------------ ③ 读计数 */

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

test('session 读计数：doc/catalog 不增 full；全库装载单独记行数', () => {
  const root = mkdtempSync(join(tmpdir(), 'qua-read-count-'))
  dirs.push(root)
  const id = libraryId()
  const opened = openSession(join(root, id), { expectId: id })
  assert.equal(opened.status, 'ok', `应当初始化成功，实际 ${JSON.stringify(opened)}`)
  const s = opened.status === 'ok' ? opened.session : null
  assert.ok(s)

  const rows: RowWrite[] = [
    { table: 'Block', op: 'upsert', key: { id: 'p' }, values: { content: '[]', created: 1, modified: 1, parent: null, left: null } },
    { table: 'Block', op: 'upsert', key: { id: 'a' }, values: { content: '[]', created: 1, modified: 1, parent: 'p', left: null } },
    { table: 'Block', op: 'upsert', key: { id: 'tag' }, values: { content: '[]', created: 1, modified: 1, parent: null, left: 'p' } },
    { table: 'BlockAlias', op: 'upsert', key: { name: 'P' }, values: { block: 'p', pos: 0 } },
    { table: 'BlockAlias', op: 'upsert', key: { name: 'Tag' }, values: { block: 'tag', pos: 0 } },
    { table: 'BlockList', op: 'upsert', key: { block: 'p', list: 'page' } },
    { table: 'BlockList', op: 'upsert', key: { block: 'tag', list: 'tag' } },
    { table: 'BlockProperty', op: 'upsert', key: { block: 'a', name: 'x', pos: 0 }, values: { multi: 0, value: '"v"' } },
  ]
  saveContent(s!, rows)

  const d = readDoc(s!, ['p'])
  const c = readCatalog(s!)
  assert.equal(d.rows.blocks.length, 2, 'Doc 只有 P 的子树（p／a）')
  assert.equal(c.tags.length, 1)
  assert.deepEqual(s!.reads, {
    full: 0,
    fullRows: 0,
    doc: 1,
    docRows: 5, // blocks 2 + props 1 + aliases 1 + lists 1
    catalog: 1,
    catalogRows: 1, // tags 1
  })

  const all = loadContent(s!)
  assert.ok(all, '库里有内容')
  assert.equal(s!.reads.full, 1)
  // blocks 3 + props 1 + aliases 2 + lists 2（+ FTS 映射 0）
  assert.equal(s!.reads.fullRows, 8)
  assert.equal(s!.reads.doc, 1, '全库装载不重复记 doc')
  s!.close()
})
