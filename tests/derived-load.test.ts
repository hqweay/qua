/**
 * **派生栏的全库口径**：部分装载下「引用／备注」装齐后 == 整库口径。
 *
 * 判据三条：
 *   ① 初始（只装了当前页）时，别页里的引用来源与备注**看不见**——这就是要修的那个洞；
 *   ② `ensureDerivedLoaded` 之后，记录与「整库装载」逐条相同（顺序也相同：按文档位置）；
 *   ③ 派生表还没建好（`derived_state` 不是 ready）时**显式不装**（返回 false），
 *      退回工作集口径——不拿半张表当真。
 *
 * 走的是真实那一条路：真 SQLite ＋ 具名读面 ＋ 查询候选装载（与本机 `main.ts` 的
 * `ensureQueryLoaded` 同一条：候选超集 → 按 id 连祖先链装进工作集 → matcher 判）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, readContentRows, type RowWrite } from '../electron/library/sqlite.ts'
import { readBlockTreeRows, readCandidatePage, readDocRows, readIdentityRows } from '../electron/library/reads.ts'
import { rebuildDerivedWrites } from '../src/core/storage/derived-rows.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset } from '../src/core/storage/workset.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { LibraryClient } from '../src/core/storage/library-client.ts'
import { ensureDerivedLoaded } from '../src/app/boot/derived-load.ts'
import { derivedRecordsOf, type DerivedSource } from '../src/core/views/mount.ts'
import type { Block } from '../src/core/index.ts'

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

type Db = NonNullable<ReturnType<typeof openLibraryDb>['db']>

function tmpDb(): { db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qua-derived-load-'))
  dirs.push(dir)
  const opened = openLibraryDb(join(dir, 'qua.db'))
  assert.ok(opened.db, `open failed: ${opened.status}`)
  return { db: opened.db, close: () => opened.db!.close() }
}

function block(id: string, parent: string | null, left: string | null, extra: Record<string, string | number | null> = {}): RowWrite {
  return { table: 'Block', op: 'upsert', key: { id }, values: { content: '[]', created: 1, modified: 1, parent, left, ...extra } }
}

const runs = (...rs: (string | { to: string })[]): string =>
  JSON.stringify(
    rs.map((r) =>
      typeof r === 'string'
        ? { t: 'text', v: r }
        : { t: 'ref', to: r.to, id: `run-${Math.random().toString(36).slice(2, 8)}` },
    ),
  )

/**
 * 两页一棵关系：
 *
 *   PAGE_A（页）─ a1（带一段 anno）
 *   PAGE_B（页）─ b1（正文引用 a1）
 *               └ n1（备注块的 `_annotates` 指向 a1 的那段 anno）
 */
function seed(): RowWrite[] {
  return [
    block('PAGE_A', null, null),
    block('a1', 'PAGE_A', null, { annos: JSON.stringify([{ id: 'anno1', range: { start: 0, end: 2 } }]) }),
    block('PAGE_B', null, 'PAGE_A'),
    block('b1', 'PAGE_B', null),
    block('n1', 'PAGE_B', 'b1'),
    { table: 'Block', op: 'update', key: { id: 'a1' }, values: { content: runs('被引用的一段') } },
    { table: 'Block', op: 'update', key: { id: 'b1' }, values: { content: runs('看 ', { to: 'PAGE_A' }) } },
    {
      table: 'BlockProperty',
      op: 'upsert',
      key: { block: 'n1', name: '_annotates', pos: 0 },
      values: { multi: 0, value: JSON.stringify([{ block: 'a1', anno: 'anno1' }]) },
    },
    { table: 'BlockList', op: 'upsert', key: { block: 'PAGE_A', list: 'page' } },
    { table: 'BlockList', op: 'upsert', key: { block: 'PAGE_B', list: 'page' } },
  ]
}

/** 只走具名读面的库读端（本模块只用这四格；其余格由真实客户端提供，测试里不需要） */
function readClient(db: Db): LibraryClient {
  return {
    async doc(roots) {
      return { status: 'ok', value: readDocRows(db, roots) }
    },
    async blocks(ids) {
      return { status: 'ok', value: readBlockTreeRows(db, ids, false) }
    },
    async tree(ids, withChildren) {
      return { status: 'ok', value: readBlockTreeRows(db, ids, withChildren) }
    },
    async identity() {
      return { status: 'ok', value: readIdentityRows(db) }
    },
    async candidates(plan, page) {
      return { status: 'ok', value: readCandidatePage(db, plan, page) }
    },
    async relations(ids) {
      const rows = db
        .prepare('select to_id, from_id, kind, from_root, count from BlockRelation where to_id in (select value from json_each(?))')
        .all(JSON.stringify(ids)) as { to_id: string; from_id: string; kind: string; from_root: string; count: number | null }[]
      const state = (db.prepare('select value from meta where key = ?').all('derived_state') as { value: string }[])[0]?.value
      return { status: 'ok', value: { rows, ready: state === 'ready' } }
    },
  } as unknown as LibraryClient
}

/** 只装 PAGE_A（＋身份块）：工作集的真实首帧形状 */
function partialView(db: Db): { store: BlockStore; workset: Workset; kb: MemoryKb } {
  const store = new BlockStore([])
  const workset = new Workset(store)
  workset.loadDoc(readDocRows(db, ['PAGE_A']).rows, ['PAGE_A'])
  workset.loadBlocks(readIdentityRows(db), true)
  return { store, workset, kb: new MemoryKb(store) }
}

/** 整库装载（判据的基线） */
function fullView(db: Db): MemoryKb {
  const view = partialView(db)
  view.workset.loadBlocks(readContentRows(db), true)
  return view.kb
}

const idsOf = (kb: MemoryKb, source: DerivedSource): string[] =>
  derivedRecordsOf(hostBlock(kb), kb, source).map((r) => r.block.id)

function hostBlock(kb: MemoryKb): Block {
  const b = kb.get('PAGE_A')
  assert.ok(b, 'PAGE_A 必须装载')
  return b
}

test('部分装载：引用栏装齐后与整库逐条相同（别页的来源在装之前看不见）', async () => {
  const { db, close } = tmpDb()
  applyRowWrites(db, seed())
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))

  const view = partialView(db)
  const full = fullView(db)
  const a = hostBlock(view.kb)
  assert.deepEqual(idsOf(view.kb, 'refs'), [], '只装了 PAGE_A 时看不到别页的引用来源')

  const loaded = await ensureDerivedLoaded({ client: readClient(db), workset: view.workset, store: view.store }, a, 'refs')
  assert.equal(loaded, true, '应当真的装进了新块')
  assert.deepEqual(idsOf(view.kb, 'refs'), idsOf(full, 'refs'), '装齐后与整库口径逐条相同（顺序也相同）')
  assert.deepEqual(idsOf(view.kb, 'refs'), ['b1'], '来源是 PAGE_B 里的 b1')

  // 再问一次：什么都不缺 ⇒ 不该报「装进了新块」（否则挂载区会空转重画）
  const again = await ensureDerivedLoaded({ client: readClient(db), workset: view.workset, store: view.store }, a, 'refs')
  assert.equal(again, false)
  close()
})

test('引用栏候选连一层子级：透传块的 children 装进来（reload 后的补装靠这一层摊开）', async () => {
  const { db, close } = tmpDb()
  const seed2 = [
    ...seed(),
    // b1 变成透传块（正文只有一枚引用）＋一个子块：引用栏上它默认摊开
    { table: 'Block', op: 'update', key: { id: 'b1' }, values: { content: runs({ to: 'PAGE_A' }) } },
    block('b1-child', 'b1', null),
    { table: 'Block', op: 'update', key: { id: 'b1-child' }, values: { content: runs('引用真正指到的内容') } },
  ]
  applyRowWrites(db, seed2)
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))

  const view = partialView(db)
  const a = hostBlock(view.kb)
  await ensureDerivedLoaded({ client: readClient(db), workset: view.workset, store: view.store }, a, 'refs')

  const b1 = view.store.find('b1')
  assert.ok(b1, '候选来源 b1 已装载')
  assert.equal(
    b1.children.some((c) => c.id === 'b1-child'),
    true,
    '透传块的直接子级随候选一起装载——否则 reload 后引用栏只剩一枚孤引用',
  )
  close()
})

test('备注栏没有 QuerySpec：候选来自关系表的 annotates 边，装齐后与整库相同', async () => {
  const { db, close } = tmpDb()
  applyRowWrites(db, seed())
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))

  const view = partialView(db)
  const full = fullView(db)
  const a = hostBlock(view.kb)
  assert.deepEqual(idsOf(view.kb, 'notes'), [], '只装了 PAGE_A 时看不到别页的备注')

  const loaded = await ensureDerivedLoaded({ client: readClient(db), workset: view.workset, store: view.store }, a, 'notes')
  assert.equal(loaded, true)
  assert.deepEqual(idsOf(view.kb, 'notes'), idsOf(full, 'notes'), '备注栏装齐后与整库口径相同')
  assert.deepEqual(idsOf(view.kb, 'notes'), ['n1'])
  close()
})

test('派生表没建好：显式不装（返回 false），退回工作集口径', async () => {
  const { db, close } = tmpDb()
  applyRowWrites(db, seed())
  // 不重建派生表 ⇒ derived_state 仍是 pending
  const view = partialView(db)
  const a = hostBlock(view.kb)
  const deps = { client: readClient(db), workset: view.workset, store: view.store }
  assert.equal(await ensureDerivedLoaded(deps, a, 'notes'), false, '关系表不可信 ⇒ 不装，不假装全库')
  assert.deepEqual(idsOf(view.kb, 'notes'), [])
  close()
})
