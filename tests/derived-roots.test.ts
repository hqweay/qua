/**
 * **顶层段撞车**（真实库尺寸下的那一类）：派生表逐根重建时，每棵只有单根 ⇒
 * 缺省段编码会把**所有顶层根**铺成同一段。后果两条，这里各钉一条：
 *
 *   ① 候选流按 `path > cursor` 翻页：同段行过游标后被跳过 ⇒ 大库查询少行；
 *   ② `docWindow` 按前缀取窗会跨根（root 列限定兜住了，但索引本身仍是坏的）。
 *
 * 判据：
 *   · 重建后的顶层段**两两不同**，且顺序 = 重建前的**文档序**（不是 rowid 创建序）；
 *   · 版本未落盘时读面退回「一页装完」（不拿坏 path 分页）；重建完成写 ready ＋ 版本；
 *   · >400 候选分页得到的 id 序列 == 整库一次求值（`derivedRowsOf` 全林）的序列；
 *   · `docWindow` 只回自己 root 的子树。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyRowWrites, openLibraryDb, readContentRows, readMeta, writeMeta, type Db } from '../electron/library/sqlite.ts'
import { readCandidatePage, readDocRows, readDocWindow, readIndexChildren, readRootIds } from '../electron/library/reads.ts'
import { rebuildDerivedTables } from '../src/app/boot/derived-rebuild.ts'
import { DERIVED_PATH_VERSION, META_KEYS } from '../src/core/identity/library.ts'
import { derivedRowsOf } from '../src/core/storage/derived-rows.ts'
import { rowsToWorkspace, type RowWrite } from '../src/core/storage/db-rows.ts'
import { CANDIDATE_PAGE } from '../src/app/boot/query-load.ts'
import type { LibraryClient } from '../src/core/storage/library-client.ts'
import type { CandidatePlan } from '../src/core/storage/library-reads.ts'

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tmp(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'qua-roots-'))
  dirs.push(dir)
  const opened = openLibraryDb(join(dir, 'qua.db'))
  assert.ok(opened.db, `open failed: ${opened.status}`)
  return opened.db
}

const ROOTS = 450
const BROKEN_SEG = '/1000000001024/'
const ids = (n: number): string => `c${String(n).padStart(3, '0')}`

/** 文档序：`c449` 打头，之后 c000…c448（rowid 序是 c000…c449 —— 两条序不同） */
function documentRoots(): string[] {
  return [ids(ROOTS - 1), ...Array.from({ length: ROOTS - 1 }, (_, i) => ids(i))]
}

/**
 * 一个坏库：450 个顶层根 ＋ c000 下一个子块 x1；`BlockIndex` 是真实库里的坏形状
 * ——所有顶层根同段。`derived_state='ready'`、没有路径版本（存量库就是这样）。
 */
function brokenDb(): { db: Db; expected: string[] } {
  const db = tmp()
  const order = documentRoots()
  const rows: RowWrite[] = []
  for (let i = 0; i < ROOTS; i++) {
    const id = ids(i)
    // 行按 rowid 序插入，left 指向前兄弟 ⇒ 文档序由 left 链给出，与 rowid 序不同
    const prev = i === 0 ? ids(ROOTS - 1) : ids(i - 1)
    const left = id === order[0] ? null : prev
    rows.push({ table: 'Block', op: 'upsert', key: { id }, values: { content: '[]', created: 1, modified: 1, parent: null, left } })
    rows.push({ table: 'BlockIndex', op: 'upsert', key: { block: id }, values: { root: id, path: BROKEN_SEG, hidden: null } })
  }
  rows.push({ table: 'Block', op: 'upsert', key: { id: 'x1' }, values: { content: '[]', created: 1, modified: 1, parent: 'c000', left: null } })
  rows.push({
    table: 'BlockIndex',
    op: 'upsert',
    key: { block: 'x1' },
    values: { root: 'c000', path: `${BROKEN_SEG}0000000001024/`, hidden: null },
  })
  applyRowWrites(db, rows)
  writeMeta(db, META_KEYS.derivedState, 'ready')
  return { db, expected: order }
}

/** 只走具名读面的库读端 */
function dbClient(db: Db): LibraryClient {
  return {
    async roots() {
      return { status: 'ok', value: readRootIds(db) }
    },
    async doc(roots: readonly string[]) {
      return { status: 'ok', value: readDocRows(db, roots) }
    },
    async indexChildren(parent: string | null) {
      return { status: 'ok', value: readIndexChildren(db, parent) }
    },
  } as unknown as LibraryClient
}

function storeOf(db: Db): never {
  return {
    commitRaw: async (w: readonly RowWrite[]) => {
      applyRowWrites(db, w)
      return { ok: true as const }
    },
  } as never
}

/** 一页页取到底 */
function readAllCandidates(db: Db, plan: CandidatePlan): string[] {
  const out: string[] = []
  let after: string | null = null
  for (let i = 0; i < 100; i++) {
    const page = readCandidatePage(db, plan, { after, limit: CANDIDATE_PAGE })
    out.push(...page.ids)
    after = page.next
    if (after === null) return out
  }
  throw new Error('paging did not terminate')
}

test('流式逐根重建：顶层段唯一且按文档序（不是 rowid 序）', async () => {
  const { db, expected } = brokenDb()
  assert.deepEqual(readRootIds(db), expected, '根清单按 left 兄弟链，不按 rowid')

  const r = await rebuildDerivedTables({ client: dbClient(db), store: storeOf(db) })
  assert.equal(r.ok, true)
  assert.equal(r.total, ROOTS)
  assert.equal(readMeta(db, META_KEYS.derivedState), 'ready')
  assert.equal(readMeta(db, META_KEYS.derivedPathVersion), DERIVED_PATH_VERSION)

  const all = db.prepare('select block, path from BlockIndex').all() as { block: string; path: string }[]
  const pathOf = new Map(all.map((x) => [x.block, x.path]))
  const top = db
    .prepare('select i.block as block, i.path as path from BlockIndex i join Block b on b.id = i.block where b.parent is null')
    .all() as { block: string; path: string }[]
  assert.equal(top.length, ROOTS)
  const paths = expected.map((id) => pathOf.get(id)!)
  assert.equal(new Set(paths).size, ROOTS, '顶层段必须两两不同')
  for (let i = 1; i < paths.length; i++) {
    assert.ok(paths[i - 1]! < paths[i]!, `第 ${i} 个根应排在文档序里（${paths[i - 1]} < ${paths[i]}）`)
  }
  assert.equal(pathOf.get('x1'), `${pathOf.get('c000')}1000000001024/`, '子块挂在它自己那根的段下面')
  db.close()
})

test('版本缺失 ⇒ 读面不拿坏 path 分页；重建后 >400 候选分页 == 整库求值', async () => {
  const { db, expected } = brokenDb()
  const plan: CandidatePlan = { k: 'visible' }

  // 存量库：state=ready、版本缺失 ⇒ 一页装完（宽但真），不按坏 path 翻页
  const before = readCandidatePage(db, plan, { after: null, limit: CANDIDATE_PAGE })
  assert.equal(before.next, null, '版本不符 ⇒ 不按 path 分页（否则同段行过游标后静默消失）')
  assert.equal(before.ids.length, ROOTS + 1, '降级也要给全命中')

  const r = await rebuildDerivedTables({ client: dbClient(db), store: storeOf(db) })
  assert.equal(r.ok, true)

  /**
   * 整库求值的基准：同一份内容行铺一整棵森林（`derivedRowsOf` 是正确性基准），
   * 取先序。分页必须逐条相同、条数相同。
   */
  const whole = derivedRowsOf(rowsToWorkspace(readContentRows(db)).blocks)
  const want = [...whole.index].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((x) => x.block)
  const paged = readAllCandidates(db, plan)
  assert.equal(paged.length, ROOTS + 1)
  assert.ok(paged.length > CANDIDATE_PAGE, '必须真的翻页（一页 400）')
  assert.deepEqual(paged, want, '分页序列 == 整库求值序列（无重、无漏、同序）')
  // 文档序的独立佐证：第一个是你文档里的头号根，不是 rowid 最小的那个
  assert.equal(paged[0], expected[0])
  assert.equal(expected[0], ids(ROOTS - 1))
  db.close()
})

test('docWindow 只回自己的 root（顶层段唯一时，前缀限定与 root 列同时成立）', async () => {
  const { db } = brokenDb()
  const r = await rebuildDerivedTables({ client: dbClient(db), store: storeOf(db) })
  assert.equal(r.ok, true)

  const win = (root: string): string[] => {
    const w = readDocWindow(db, root, null, CANDIDATE_PAGE)
    assert.ok(w, `${root} 应有派生路径`)
    return w.rows.blocks.map((b) => String(b.id))
  }
  assert.deepEqual(win('c449'), ['c449'])
  assert.deepEqual(win('c000'), ['c000', 'x1'])
  db.close()
})
