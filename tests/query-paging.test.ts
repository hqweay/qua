/**
 * **候选流分页**：一页页取到的求值结果，与「整库一次求值」逐条相同。
 *
 * 判据四条：
 *   ① **分页 == 整集**：每个条件在「一页页装到到底」之后求值，结果集与整库相同；
 *   ② **边装边出**：没有 `sort` 时首窗的命中是完整命中的**前缀**（文档序），
 *      后续补页不会把已出行挪位；
 *   ③ **早停只看文档序**：够 `target` 条命中就停（不停在到底）；有 `sort` 必须取到底；
 *   ④ **游标**：最后一页 `next === null`；同一条件连续取页不重复、不漏。
 *
 * 库要大到**必须翻页**（`CANDIDATE_PAGE` = 400），否则这条测试只测到一页。
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
import { CANDIDATE_PAGE, loadCandidateWindow, type QueryLoadDeps } from '../src/app/boot/query-load.ts'
import { candidateBuildOf } from '../src/core/storage/query-candidates.ts'
import type { QuerySpec } from '../src/core/index.ts'

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

type Db = NonNullable<ReturnType<typeof openLibraryDb>['db']>

const runs = (...rs: string[]): string => JSON.stringify(rs.map((v) => ({ t: 'text', v })))

function block(id: string, parent: string | null, left: string | null, extra: Record<string, string | number | null> = {}): RowWrite {
  return { table: 'Block', op: 'upsert', key: { id }, values: { content: '[]', created: 1, modified: 1, parent, left, ...extra } }
}

/**
 * 一棵**必须翻页**的树：页 P 下 450 行（超过一页 400），其中 5 行带标签 TAG；
 * 另有一天日记 J。行 id 用 `c000`…`c449`（与 `runs` 的文本区分开）。
 */
function seed(): RowWrite[] {
  const rows: RowWrite[] = [
    block('P', null, null),
    block('TAG', null, 'P'),
    block('J', null, 'TAG', { date: '2026-11-19' }),
  ]
  let prev: string | null = null
  for (let i = 0; i < 450; i++) {
    const id = `c${String(i).padStart(3, '0')}`
    rows.push(block(id, 'P', prev))
    rows.push({ table: 'Block', op: 'update', key: { id }, values: { content: runs(`mark ${i}`) } })
    if (i % 90 === 0) {
      rows.push({ table: 'BlockProperty', op: 'upsert', key: { block: id, name: '_tags', pos: 0 }, values: { multi: 0, value: 'TAG' } })
    }
    prev = id
  }
  rows.push({ table: 'BlockList', op: 'upsert', key: { block: 'P', list: 'page' } })
  rows.push({ table: 'BlockList', op: 'upsert', key: { block: 'TAG', list: 'tag' } })
  return rows
}

function tmp(): { db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'qua-paging-'))
  dirs.push(dir)
  const opened = openLibraryDb(join(dir, 'qua.db'))
  assert.ok(opened.db, `open failed: ${opened.status}`)
  return { db: opened.db, close: () => opened.db!.close() }
}

/** 只走具名读面的库读端（本测试用到的那几格） */
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
  } as unknown as LibraryClient
}

/** 空工作集（真实首帧的极端：什么都没装） */
function blank(db: Db): { deps: QueryLoadDeps; store: BlockStore; kb: MemoryKb } {
  const store = new BlockStore([])
  const workset = new Workset(store)
  workset.loadBlocks(readIdentityRows(db), true)
  return { deps: { client: readClient(db), workset, store }, store, kb: new MemoryKb(store) }
}

const ids = (kb: MemoryKb, spec: QuerySpec): string[] => kb.query(spec, {}).map((h) => h.blockId)

const CASES: { name: string; spec: QuerySpec }[] = [
  { name: 'not（走全林一侧）', spec: { where: { not: { is: 'NOPE' } } } },
  { name: 'tag 成员', spec: { where: { tag: 'TAG' } } },
  { name: 'role page', spec: { where: { role: 'page' } } },
  { name: 'text 前缀', spec: { where: { text: 'mark' } } },
]

test('分页：每个条件一页页装到到底后，求值 == 整库求值', async () => {
  const { db, close } = tmp()
  applyRowWrites(db, seed())
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))

  for (const c of CASES) {
    const view = blank(db)
    let loadedCount = 0
    // 基线：整库装载求值（另开一份，避免与分页视图互相污染）
    const all = blank(db)
    all.deps.workset!.loadBlocks(readContentRows(db), true)
    const expected = ids(all.kb, c.spec)

    let after: string | null = null
    for (let i = 0; i < 100; i++) {
      const step = await loadCandidateWindow(view.deps, c.spec, {}, undefined, {
        after,
        target: Number.POSITIVE_INFINITY,
        onPage: () => (loadedCount += 1),
      })
      after = step.next
      if (after === null) break
    }
    const wantPages = expected.length > CANDIDATE_PAGE ? 2 : 1
    assert.ok(loadedCount >= wantPages, `「${c.name}」页数不够（${loadedCount} < ${wantPages}）：只测到一页`)
    assert.deepEqual(ids(view.kb, c.spec), expected, `「${c.name}」分页求值必须与整库相同`)
  }
  close()
})

test('边装边出 + 早停：无 sort 时够 target 就停；本页候选的命中顺序与整库一致', async () => {
  const { db, close } = tmp()
  applyRowWrites(db, seed())
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  const spec: QuerySpec = { where: { not: { is: 'NOPE' } } }

  const all = blank(db)
  all.deps.workset!.loadBlocks(readContentRows(db), true)
  const expected = ids(all.kb, spec)

  const view = blank(db)
  const first = await loadCandidateWindow(view.deps, spec, {}, undefined, {
    after: null,
    target: 30,
    hits: () => view.kb.query(spec, {}).length,
  })
  const window = ids(view.kb, spec)
  assert.equal(first.next === null, false, '装够 30 条命中就该停（后面还有页）')
  assert.ok(window.length >= 30, `首窗至少要够 target（实际 ${window.length}）`)
  assert.deepEqual(
    window.filter((id) => !expected.includes(id)),
    [],
    '首窗不能出现整库结果之外的块',
  )

  /**
   * **顺序判据只对「本页候选」成立**：闭包把后续根的标签/定义块一起装进来了，
   * 于是「属于下一页的根」会先出现在末尾、等下一页装齐后再落到它该在的位置
   * （边界一次重排，行本身不重排）。所以这里比的是：本页候选里命中的那些，
   * 在首窗与整库里的相对顺序必须一致。
   */
  const build = candidateBuildOf(spec, undefined, all.store.blocks, {})
  const page1 = readCandidatePage(db, build.plan, { after: null, limit: CANDIDATE_PAGE }).ids
  const inPage = new Set(page1)
  assert.deepEqual(
    window.filter((id) => inPage.has(id)),
    expected.filter((id) => inPage.has(id)),
    '本页候选的命中必须与整库同序（文档序，不按 id 排）',
  )
  close()
})

test('有 sort：必须取到底（全局排序需要全集）', async () => {
  const { db, close } = tmp()
  applyRowWrites(db, seed())
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  const spec: QuerySpec = { where: { not: { is: 'NOPE' } }, sort: [{ by: 'created', dir: 'desc' }] }

  const view = blank(db)
  let pages = 0
  const step = await loadCandidateWindow(view.deps, spec, {}, undefined, {
    after: null,
    target: Number.POSITIVE_INFINITY, // 视图对带 sort 的条件就是传这个
    hits: () => view.kb.query(spec, {}).length,
    onPage: () => (pages += 1),
  })
  assert.equal(step.next, null, '到底')
  assert.ok(pages >= 2, `带 sort 不能一页就停（实际 ${pages} 页）`)
  close()
})

test('禁用场景：派生表没建好 ⇒ 一页装完（next:null），不按 path 分页', async () => {
  const { db, close } = tmp()
  applyRowWrites(db, seed())
  // 不重建派生表：pending
  const view = blank(db)
  const step = await loadCandidateWindow(view.deps, { where: { not: { is: 'NOPE' } } }, {}, undefined, {
    after: null,
    target: Number.POSITIVE_INFINITY,
  })
  assert.equal(step.next, null, '没有可信的 path ⇒ 一页装完（同一 API 的退化，不是另一条语义）')
  assert.ok(CANDIDATE_PAGE >= 400)
  close()
})
