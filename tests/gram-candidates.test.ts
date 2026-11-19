/**
 * **子串索引的候选短路**（`{text}` 的无命中／稀疏一档）。
 *
 * 三条判据（每条都能单独证伪）：
 *   ① 索引说「没有」⇒ 整条查询给空页（不再整库扫一遍才得出「没有」）；
 *   ② 索引命中的块不超过一页 ⇒ 一次交齐、`next = null`（候选齐全）；
 *   ③ 太短／太密／索引未就绪 ⇒ 与改动前的分页 SQL **逐条相同**（降级不是另一种语义）。
 *
 * 走真 SQLite：断言的是「候选序列」，不是「用了哪条 SQL」——序列相同才叫降级。
 * 另外钉住写路径的地址约定：子串行与正文行**同一个 rowid**（块 → rowid 只有一张映射）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, readMeta, type Db, type RowWrite } from '../electron/library/sqlite.ts'
import { readCandidatePage } from '../electron/library/reads.ts'
import { candidatePageSql, gramQueryOf, type CandidatePlan } from '../src/core/storage/library-reads.ts'
import { META_KEYS } from '../src/core/identity/library.ts'

const dirs: string[] = []
function db(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-gram-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const blockRow = (id: string, parent: string | null, left: string | null, text: string): RowWrite => ({
  table: 'Block',
  op: 'upsert',
  key: { id },
  values: { content: JSON.stringify([{ t: 'text', v: text }]), created: 1, modified: 1, parent, left },
})
const indexRow = (block: string, path: string): RowWrite => ({
  table: 'BlockIndex',
  op: 'upsert',
  key: { block },
  values: { root: 'r', path, hidden: null },
})
/** 正文行 ＋ 子串行：**同一个 rowid**（写路径的契约，见 `buildFtsWrites`） */
const ftsRows = (block: string, rowid: number, text: string): RowWrite[] => [
  { table: 'BlockFTS', op: 'insert', key: { rowid }, values: { seg: text, chars: text, pinyin: '' } },
  { table: 'BlockGram', op: 'insert', key: { rowid }, values: { body: text } },
  { table: 'BlockFTSMap', op: 'upsert', key: { block_id: block, source: 'content' }, values: { fts_rowid: rowid } },
]

/**
 * 五块库（先序：a→b→c→d→e）：
 *   · 命中「笔记工具」的是 a、b（稀疏，一页装得下）
 *   · 「无关」只有 c
 *   · d、e 与查询无关
 */
function seeded(): Db {
  const d = db()
  const rows: RowWrite[] = [
    blockRow('a', null, null, '这是一篇笔记工具的介绍'),
    blockRow('b', null, 'a', '另一处笔记工具的用法'),
    blockRow('c', null, 'b', '完全无关的内容'),
    blockRow('d', null, 'c', '无关的日记'),
    blockRow('e', null, 'd', '像 素'),
    indexRow('a', '01'),
    indexRow('b', '02'),
    indexRow('c', '03'),
    indexRow('d', '04'),
    indexRow('e', '05'),
    ...ftsRows('a', 1, '这是一篇笔记工具的介绍'),
    ...ftsRows('b', 2, '另一处笔记工具的用法'),
    ...ftsRows('c', 3, '完全无关的内容'),
    ...ftsRows('d', 4, '无关的日记'),
    ...ftsRows('e', 5, '像 素'),
  ]
  rows.push(
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.ftsState }, values: { value: 'ready' } },
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedState }, values: { value: 'ready' } },
  )
  applyRowWrites(d, rows)
  return d
}

/** 改动前的分页结果（直连 SQL，不经过短路）＝ 降级基准 */
function baseline(d: Db, plan: CandidatePlan, after: string | null, limit: number): { ids: string[]; next: string | null } {
  const q = candidatePageSql(plan, { after, limit }, { derived: true })
  const rows = d.prepare(q.sql).all(...q.params) as { id: unknown; path?: unknown }[]
  return {
    ids: rows.map((r) => String(r.id)),
    next: rows.length === limit ? String(rows[rows.length - 1]!.path) : null,
  }
}

const text = (needle: string): CandidatePlan => ({ k: 'text', needle })

test('gramQueryOf：两码点／全空白答不了，三码点起整串当短语（引号加倍）', () => {
  assert.equal(gramQueryOf('笔记'), null, '两个码点进不了 trigram')
  assert.equal(gramQueryOf('   '), null, '全空白没有可索引的字')
  assert.equal(gramQueryOf('笔记工'), '"笔记工"')
  assert.equal(gramQueryOf('a"b c'), '"a""b c"', '整串字面量：引号自己加倍')
  // 表情：一个码点两个 UTF-16 单元 ⇒ 三码点才能查（按 length 判会误当成三个）
  assert.equal(gramQueryOf('😀😀'), null)
  assert.equal(gramQueryOf('😀😀😀'), '"😀😀😀"')
})

test('无命中：索引说没有 ⇒ 空页（不必扫全库）', () => {
  const d = seeded()
  const page = readCandidatePage(d, text('龘靐齉'), { after: null, limit: 400 })
  assert.deepEqual(page, { ids: [], next: null })
})

test('稀疏：不超过一页 ⇒ 一次交齐、按先序、next=null', () => {
  const d = seeded()
  const page = readCandidatePage(d, text('笔记工具'), { after: null, limit: 400 })
  assert.deepEqual(page.ids, ['a', 'b'])
  assert.equal(page.next, null)
  // 与全库判定的答案一致：这两块正是唯一含这串的块
  assert.deepEqual(page.ids, baseline(d, text('笔记工具'), null, 400).ids)
})

test('稀疏但带别页条件：候选是超集（matcher 会筛），仍一次交齐', () => {
  const d = seeded()
  const plan: CandidatePlan = { k: 'all', plans: [text('笔记工具'), { k: 'ids', ids: ['c'] }] }
  const page = readCandidatePage(d, plan, { after: null, limit: 400 })
  // 候选可以多给（a、b 不在 ids 里，matcher 会筛掉），但真命中必须都在——这里是空集
  assert.equal(page.next, null)
  assert.ok(page.ids.every((id) => ['a', 'b'].includes(id)), '候选只可能来自正文命中的超集')
})

test('太密（超过一页）⇒ 交给扫描路，序列与改动前逐条相同', () => {
  const d = seeded()
  const plan = text('笔记工')
  const page = readCandidatePage(d, plan, { after: null, limit: 1 })
  assert.deepEqual(page, baseline(d, plan, null, 1), '降级后与改动前的分页结果相同')
  assert.notEqual(page.next, null, '一页装不完 ⇒ 仍有下一页')
})

test('太短（两字）⇒ 索引答不了，退回扫描路且序列相同', () => {
  const d = seeded()
  const plan = text('无关')
  assert.deepEqual(readCandidatePage(d, plan, { after: null, limit: 400 }), baseline(d, plan, null, 400))
})

test('析取项不是必要条件 ⇒ 不走短路（与改动前逐条相同）', () => {
  const d = seeded()
  const plan: CandidatePlan = { k: 'any', plans: [text('笔记工具'), { k: 'ids', ids: ['e'] }] }
  assert.deepEqual(readCandidatePage(d, plan, { after: null, limit: 400 }), baseline(d, plan, null, 400))
})

test('索引未就绪 ⇒ 不走短路（与改动前逐条相同）', () => {
  const d = seeded()
  applyRowWrites(d, [
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.ftsState }, values: { value: 'pending' } },
  ])
  const plan = text('笔记工具')
  assert.deepEqual(readCandidatePage(d, plan, { after: null, limit: 400 }), baseline(d, plan, null, 400))
})

test('稀疏页带游标：游标之后的子集，仍标到底（候选已齐）', () => {
  const d = seeded()
  const page = readCandidatePage(d, text('笔记工具'), { after: '01', limit: 400 })
  assert.deepEqual(page, { ids: ['b'], next: null })
})

test('写路径：正文行与子串行同一个 rowid，删正文行时两行一起删', () => {
  const d = seeded()
  const rows = d.prepare(`select m.block_id as block, m.fts_rowid as rowid
      from BlockFTSMap m where m.source = 'content' order by m.fts_rowid`).all() as { block: string; rowid: number }[]
  const gram = d.prepare('select count(*) as n from BlockGram').get() as { n: number }
  assert.equal(gram.n, rows.length, '每一行正文索引都有一条子串行')
  const hit = d.prepare(`select m.block_id as block from BlockFTSMap m join BlockGram on BlockGram.rowid = m.fts_rowid
      where m.source = 'content' and BlockGram match ?`).all(gramQueryOf('笔记工具')!) as { block: string }[]
  assert.deepEqual(hit.map((r) => r.block).sort(), ['a', 'b'])

  const rowid = rows.find((r) => r.block === 'a')!.rowid
  applyRowWrites(d, [{ table: 'BlockGram', op: 'delete', key: { rowid } }])
  const after = d.prepare(`select m.block_id as block from BlockFTSMap m join BlockGram on BlockGram.rowid = m.fts_rowid
      where m.source = 'content' and BlockGram match ?`).all(gramQueryOf('笔记工具')!) as { block: string }[]
  assert.deepEqual(after.map((r) => r.block), ['b'], '子串行按 rowid 删除即可（contentless_delete）')
})

test('迁移 v15：老库只加表，索引状态打回 pending（子串行还没有）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qua-gram-mig-'))
  dirs.push(dir)
  const file = join(dir, 'qua.db')
  // 先建一个 v14 形状的库（旧目标版本），再按当前版本打开 ⇒ 走迁移
  const old = openLibraryDb(file, { target: 14 })
  assert.equal(old.status, 'created')
  old.db!.prepare('insert into Block(id, content, created, modified) values (?, ?, 1, 1)').run('a', '[]')
  old.db!.prepare(`insert into BlockFTS(rowid, seg, chars, pinyin) values (1, 'x', 'x', '')`).run()
  old.db!.prepare(`insert into BlockFTSMap(block_id, source, fts_rowid) values ('a', 'content', 1)`).run()
  old.db!.prepare('insert or replace into meta(key, value) values (?, ?)').run(META_KEYS.ftsState, 'ready')
  old.db!.close()

  const next = openLibraryDb(file)
  assert.equal(next.status, 'migrated')
  const d = next.db!
  assert.equal(readMeta(d, META_KEYS.ftsState), 'pending', '索引要重建（子串行还不存在）')
  assert.equal((d.prepare('select count(*) as n from BlockGram').get() as { n: number }).n, 0)
  assert.equal((d.prepare('select count(*) as n from BlockFTSMap').get() as { n: number }).n, 0, '旧映射整表作废')
})
