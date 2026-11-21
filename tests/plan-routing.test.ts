/**
 * **索引驱动计划的按基数选路**（`PageSqlOpts.dense`）。
 *
 * 判据：路线可以不同，**候选序列必须逐条相同**。
 *   · 稠密（结果集 > 一页）⇒ 行本地下推：沿 path 序扫、凑够一页就停；
 *   · 稀疏（≤ 一页）⇒ 物化整份计划（它本来就小），保持 `in (plan)`；
 *   · 不给 `dense`（老调用方）⇒ 与这一档出现之前逐条相同。
 *
 * 走真 SQLite：比的是「一页页取到底」的 id 序列，不是 SQL 文本。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, type Db, type RowWrite } from '../electron/library/sqlite.ts'
import { readCandidatePage } from '../electron/library/reads.ts'
import { candidatePageSql, candidatePlanSql, type CandidatePlan } from '../src/core/storage/library-reads.ts'
import { DERIVED_PATH_VERSION, META_KEYS } from '../src/core/identity/library.ts'

const dirs: string[] = []
function db(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-route-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const block = (id: string, parent: string | null, left: string | null): RowWrite => ({
  table: 'Block',
  op: 'upsert',
  key: { id },
  values: { content: '[]', created: 1, modified: 1, parent, left },
})
const index = (b: string, path: string): RowWrite => ({
  table: 'BlockIndex',
  op: 'upsert',
  key: { block: b },
  values: { root: 'r', path, hidden: null },
})

/**
 * 六块（先序 a→f）：p1 在 a/b/c/d（4/6 稠密）；标签标识在 a/b/c；地址在 c/d/e。
 * 三种计划各有一个「稠密」与「稀疏」的形状可用（页大小就是分界）。
 */
function seeded(): Db {
  const d = db()
  const rows: RowWrite[] = [
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id) => block(id, null, id === 'a' ? null : String.fromCharCode(id.charCodeAt(0) - 1))),
    ...['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => index(id, String(i + 1).padStart(2, '0'))),
  ]
  for (const id of ['a', 'b', 'c', 'd']) {
    rows.push({ table: 'BlockProperty', op: 'upsert', key: { block: id, name: 'p1', pos: 0 }, values: { multi: 0, value: '"值"' } })
  }
  for (const id of ['a', 'b', 'c']) rows.push({ table: 'BlockList', op: 'upsert', key: { block: id, list: 'page' }, values: {} })
  for (const id of ['c', 'd', 'e']) {
    rows.push({ table: 'BlockAlias', op: 'upsert', key: { name: `页-${id}` }, values: { block: id, pos: 0, norm: `页-${id}` } })
  }
  rows.push(
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedState }, values: { value: 'ready' } },
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedPathVersion }, values: { value: DERIVED_PATH_VERSION } },
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.ftsState }, values: { value: 'pending' } },
  )
  applyRowWrites(d, rows)
  return d
}

/** 计划的全集（按文档序）＝ 比对的基准 */
function planIds(d: Db, plan: CandidatePlan): string[] {
  const p = candidatePlanSql(plan, { derived: true })
  const ids = new Set((d.prepare(p.sql).all(...p.params) as { id: unknown }[]).map((r) => String(r.id)))
  const order = d.prepare('select block from BlockIndex order by path').all() as { block: string }[]
  return order.map((r) => r.block).filter((id) => ids.has(id))
}

/** 一页页取到底（走读面：路线由它自己按基数挑） */
function readAll(d: Db, plan: CandidatePlan, limit: number): string[] {
  const out: string[] = []
  let after: string | null = null
  for (let i = 0; i < 100; i++) {
    const page = readCandidatePage(d, plan, { after, limit })
    out.push(...page.ids)
    after = page.next
    if (after === null) break
  }
  return out
}

const CASES: { name: string; plan: CandidatePlan; dense: boolean }[] = [
  // 页大小 2 ⇒ 结果集（4 / 3 / 3）都超过一页 ⇒ 下推
  { name: 'prop 4/6（页 2）', plan: { k: 'prop', name: 'p1' }, dense: true },
  { name: 'tagged 3/6（页 2）', plan: { k: 'tagged' }, dense: true },
  { name: 'aliased 3/6（页 2）', plan: { k: 'aliased' }, dense: true },
]

for (const c of CASES) {
  test(`${c.name}：后一条与计划 SQL 逐条相同（下推路）`, () => {
    const d = seeded()
    assert.deepEqual(readAll(d, c.plan, 2), planIds(d, c.plan))
  })
  test(`${c.name}：页 400 ⇒ 不超过一页（物化路），序列仍相同`, () => {
    const d = seeded()
    assert.deepEqual(readAll(d, c.plan, 400), planIds(d, c.plan))
  })
}

test('同一条计划在两种页大小下给同一条序列（路线不同，答案不变）', () => {
  const d = seeded()
  const plan: CandidatePlan = { k: 'prop', name: 'p1' }
  assert.deepEqual(readAll(d, plan, 1), readAll(d, plan, 400))
})

test('不给 dense 回调 ⇒ 与这一档之前逐条相同（candidatePageSql 直连）', () => {
  const d = seeded()
  const plan: CandidatePlan = { k: 'prop', name: 'p1' }
  const q = candidatePageSql(plan, { after: null, limit: 2 }, { derived: true })
  const ids = (d.prepare(q.sql).all(...q.params) as { id: unknown }[]).map((r) => String(r.id))
  assert.deepEqual(ids, planIds(d, plan).slice(0, 2), '仍是 in (plan) 的形状，按先序取两行')
})

test('行本地谓词与计划同集：三来源（值／自有槽／标签声明）都不漏', () => {
  const d = seeded()
  applyRowWrites(d, [
    // 自有槽：块上直接挂的槽（不靠任何定义）
    { table: 'BlockProperty', op: 'upsert', key: { block: 'e', name: '_ownProps', pos: 0 }, values: { multi: 0, value: '"p2"' } },
    { table: 'BlockProperty', op: 'upsert', key: { block: 'f', name: '_ownProps', pos: 0 }, values: { multi: 0, value: '"p2"' } },
    // 标签声明：TAG 的 `_fieldDefs` 声明了 p2 ⇒ 带这个标签的块也算「有这一栏」
    { table: 'BlockProperty', op: 'upsert', key: { block: 'TAG', name: '_fieldDefs', pos: 0 }, values: { multi: 1, value: '"p2"' } },
    { table: 'BlockProperty', op: 'upsert', key: { block: 'a', name: '_tags', pos: 0 }, values: { multi: 1, value: '"TAG"' } },
    { table: 'BlockList', op: 'upsert', key: { block: 'TAG', list: 'tag' }, values: {} },
  ])
  const plan: CandidatePlan = { k: 'prop', name: 'p2' }
  assert.deepEqual(readAll(d, plan, 1), ['a', 'e', 'f'], '三条来源都进候选（页 1 ⇒ 必然下推）')
  assert.deepEqual(readAll(d, plan, 400), ['a', 'e', 'f'], '物化路同解')
})
