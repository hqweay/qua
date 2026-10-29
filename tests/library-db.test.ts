/**
 * `qua.db` 的版本与迁移（可判定验收，跑**真 SQLite**）。
 *
 * 这一组测试的判据只有四条：
 *   ① `user_version` 偏大 ⇒ **拒绝打开**（不是重 seed，不是猜着读）；
 *   ② `user_version` 偏小 ⇒ **走迁移**，且迁移后库可用（不是 `expired` 重 seed）；
 *   ③ 迁移与版本号在**同一事务**里（实测：`PRAGMA user_version` 随事务回滚）；
 *   ④ 负向断言：**任何** schema 变更路径下，seed 都不许覆盖用户数据。
 *
 * 为什么要一条 ④：这是「接库之后仍然清库」的唯一防线。前三条绿了而 ④ 红，
 * 说明我们把 localStorage 那条「升版即清库」的纪律原样搬进了 SQLite。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_CONTENT_TABLES, DB_SCHEMA_VERSION, DB_TABLES, META_KEYS } from '../src/core/library.ts'
import { mkBlock } from '../src/core/model.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { diff, forestFingerprint, replay } from '../src/core/kb/diff.ts'
import type { Op } from '../src/core/kb/types.ts'
import { rowWritesFor, rowsToWorkspace, workspaceToRowWrites, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import {
  appendOp,
  appendLocalOps,
  applyRowWrites,
  hasContent,
  openLibraryDb,
  readContentRows,
  readMeta,
  readSeq,
  replaceContentRows,
  writeMeta,
  type Migration,
  type RowWrite,
} from '../electron/library/sqlite.ts'

const dirs: string[] = []
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'qua-db-'))
  dirs.push(d)
  return join(d, 'qua.db')
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 造一个「上一版代码留下的库」：给定版本号，只有它那一版的表（v1 是整份 blob） */
function legacyDb(file: string, userVersion: number): void {
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode=wal')
  db.exec('create table workspace (id integer primary key check (id = 1), json text not null, saved_at integer not null)')
  db.exec("insert into workspace values (1, '{\"blocks\":[]}', 1)")
  db.exec('create table settings (key text primary key, value text not null)')
  db.exec('create table meta (key text primary key, value text not null)')
  db.exec(`pragma user_version = ${userVersion}`)
  db.close()
}

/** 一行最小的块写入（编码层的事由 `tests/storage/db-rows.test.ts` 管） */
const blockRow = (id: string, extra: Record<string, string | number | null> = {}): RowWrite => ({
  table: 'Block',
  op: 'upsert',
  key: { id },
  values: { content: '[]', created: 1, modified: 1, parent: null, left: null, ...extra },
})

/* ------------------------------------------------------------ ① 偏大 ⇒ 拒绝 */

test('user_version 偏大 ⇒ too-new：不建表、不写入、原样留给更新版', () => {
  const file = tmpDb()
  legacyDb(file, DB_SCHEMA_VERSION + 1)
  const r = openLibraryDb(file)
  assert.equal(r.status, 'too-new', `偏大必须拒绝打开，实际 ${r.status}`)
  assert.equal(r.db, undefined, 'too-new 不许把可写连接交出去')

  // 拒绝打开不能顺手改掉它的版本号 —— 那会让更新版误以为「已经迁移过了」
  const db = new DatabaseSync(file)
  const v = (db.prepare('pragma user_version').all()[0] as { user_version: number }).user_version
  db.close()
  assert.equal(v, DB_SCHEMA_VERSION + 1, '拒绝打开之后版本号必须原样')
})

/* ------------------------------------------------------------ ② 偏小 ⇒ 迁移 */

test('user_version 偏小 ⇒ migrate：旧形状退场、内容表建好、版本号升到当前', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  const r = openLibraryDb(file)
  assert.equal(r.status, 'migrated', `偏小必须走迁移，实际 ${r.status}`)
  const db = r.db!
  // 旧形状（整份 blob）必须退场：一个库里只有一种形状
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name)
  assert.equal(tables.includes('workspace'), false, `v2 不该还留着 v1 的 blob 表：${tables.join(',')}`)
  for (const t of DB_CONTENT_TABLES) assert.ok(tables.includes(t), `内容表 ${t} 应当被迁移建出来：${tables.join(',')}`)
  assert.equal(r.version, DB_SCHEMA_VERSION)
  db.close()
})

test('迁移是一条条走的：中间版本也能升到当前（不是只认「上一版」）', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  /** 合成两步迁移：证明机制支持多步（真实迁移表只有 v1→v2 一步，所以这里注入） */
  const steps: Migration[] = [
    { to: 2, up: (db) => void db.exec('create table t2 (a integer)') },
    { to: 3, up: (db) => void db.exec('create table t3 (a integer)') },
  ]
  const r = openLibraryDb(file, { migrations: steps, target: 3 })
  assert.equal(r.status, 'migrated')
  const db = r.db!
  const tables = (db.prepare("select name from sqlite_master where type='table' order by name").all() as { name: string }[]).map(
    (t) => t.name,
  )
  assert.ok(tables.includes('t2'), `t2 应当被第一步建出来：${tables.join(',')}`)
  assert.ok(tables.includes('t3'), `t3 应当被第二步建出来：${tables.join(',')}`)
  assert.equal(r.version, 3)
  db.close()
})

test('迁移缺一步 ⇒ 如实失败（不许「版本号升了、表没建」）', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  // 目标 3 但只给到 2 那一步：跳过缺失的步骤会留下一个「能打开、但每次读写都撞 no such table」的库
  const r = openLibraryDb(file, { migrations: [{ to: 2, up: (db) => void db.exec('create table t2 (a integer)') }], target: 3 })
  assert.equal(r.status, 'migrate-failed', `缺步骤必须如实报，实际 ${r.status}`)

  const db = new DatabaseSync(file)
  const v = (db.prepare('pragma user_version').all()[0] as { user_version: number }).user_version
  db.close()
  assert.equal(v, 1, '失败之后版本号必须还是旧的')
})

/* ------------------------------------------------------------ ③ 原子性 */

test('迁移失败 ⇒ 版本号与表一起回滚（不许留半迁移库）', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  const bad: Migration[] = [
    { to: 2, up: (db) => void db.exec('create table t2 (a integer)') },
    {
      to: 3,
      up: (db) => {
        db.exec('create table t3 (a integer)')
        throw new Error('synthetic migration failure')
      },
    },
  ]
  const r = openLibraryDb(file, { migrations: bad, target: 3 })
  assert.equal(r.status, 'migrate-failed', `迁移抛错必须如实报，实际 ${r.status}`)

  // 主库仍是旧版本、旧数据还在：可以只读打开，绝不能被写成新版本或空库
  const db = new DatabaseSync(file)
  const v = (db.prepare('pragma user_version').all()[0] as { user_version: number }).user_version
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name)
  const blob = db.prepare('select json from workspace where id = 1').all() as { json: string }[]
  db.close()
  assert.equal(v, 1, '失败之后版本号必须还是旧的')
  assert.equal(tables.includes('t2'), false, '第一步建的表也要一起回滚（事务边界）')
  assert.equal(blob.length, 1, '旧数据必须还在')
})

/* ------------------------------------------------------------ ④ 负向：seed 不覆盖 */

test('负向断言：库里有数据时，任何打开路径都不许 seed 覆盖', () => {
  const file = tmpDb()
  // 一个「用户已经写了东西」的库
  const first = openLibraryDb(file)
  assert.equal(first.status, 'created')
  const db = first.db!
  applyRowWrites(db, [blockRow('user-written'), { table: 'meta', op: 'upsert', key: { key: META_KEYS.name }, values: { value: '我的库' } }])
  db.close()

  // 再打开三次（模拟启动三次）：每次都必须是 ok，且**绝不**把 seed 写进去
  for (let i = 0; i < 3; i++) {
    const again = openLibraryDb(file)
    assert.equal(again.status, 'ok', `第 ${i + 1} 次打开应当是 ok，实际 ${again.status}`)
    const d = again.db!
    assert.deepEqual(readContentRows(d).blocks.map((b) => b.id), ['user-written'], '用户数据必须还在')
    assert.equal(readMeta(d, META_KEYS.name), '我的库')
    d.close()
  }
})

test('负向断言：`created` 只建空表，不写任何块行（seed 是调用方的事）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  assert.equal(r.status, 'created')
  const db = r.db!
  assert.equal(hasContent(db), false, '建库不许顺手塞一份种子：种子一旦写进来，「用户数据」与「演示数据」就分不开了')
  db.close()
})

/* ------------------------------------------------------------ 形状：内容四张表 ＋ 库级三张 */

test('v2 的表形状：四张内容表 ＋ settings／meta／op_log（没有 blob 表）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const tables = (db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as {
    name: string
  }[]).map((t) => t.name).sort()
  db.close()
  assert.deepEqual(
    tables,
    [DB_TABLES.alias, DB_TABLES.block, DB_TABLES.list, DB_TABLES.meta, DB_TABLES.opLog, DB_TABLES.property, DB_TABLES.settings].sort(),
    `实际：${tables.join(',')}`,
  )
})

test('Block 的列形状是契约：`parent`／`left` 是落库编码，`deleted` 是软删时刻', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const cols = (db.prepare(`pragma table_info(${DB_TABLES.block})`).all() as { name: string }[]).map((c) => c.name)
  db.close()
  for (const c of ['id', 'content', 'annos', 'parent', 'left', 'created', 'modified', 'deleted']) {
    assert.ok(cols.includes(c), `Block 少了列 ${c}：${cols.join(',')}`)
  }
})

/* ------------------------------------------------------------ 行写入 */

test('行写入：一批一个事务，撞错整批回滚（不留半批）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  assert.throws(
    () =>
      applyRowWrites(db, [
        blockRow('a'),
        // 表名不在白名单 ⇒ 拼 SQL 之前就被拦下（渲染层送来的表名是数据，不是代码）
        { table: 'NoSuchTable' as RowWrite['table'], op: 'upsert', key: { id: 'x' } },
      ]),
    /unknown table/,
  )
  assert.equal(hasContent(db), false, '整批失败之后一行都不许留下')
  db.close()
})

test('行写入：`delete` 只给一部分主键 ⇒ 删这一块的全部行', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  applyRowWrites(db, [
    blockRow('a'),
    { table: 'BlockProperty', op: 'upsert', key: { block: 'a', name: '_icon', pos: 0 }, values: { multi: 0, value: '"x"' } },
    { table: 'BlockProperty', op: 'upsert', key: { block: 'a', name: '_tags', pos: 0 }, values: { multi: 1, value: '"t1"' } },
    { table: 'BlockProperty', op: 'upsert', key: { block: 'a', name: '_tags', pos: 1 }, values: { multi: 1, value: '"t2"' } },
  ])
  applyRowWrites(db, [{ table: 'BlockProperty', op: 'delete', key: { block: 'a' } }])
  const left = db.prepare(`select count(*) as n from ${DB_TABLES.property}`).all() as { n: number }[]
  assert.equal(left[0]!.n, 0, '按块删必须把这块的每一格都删掉')
  db.close()
})

test('整份替换：先清四张内容表再写（换库/种子/撤销之后）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  applyRowWrites(db, [blockRow('old')])
  replaceContentRows(db, [blockRow('new')])
  assert.deepEqual(readContentRows(db).blocks.map((b) => b.id), ['new'], '整份替换之后旧块必须不在')
  db.close()
})

/* ------------------------------------------------------------ A4：序号与幂等 */

test('A4：同一 (device_id, seq) 重放两次 ⇒ 一行、效果与一次相同（主键即幂等）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'a'.repeat(32)
  const op = JSON.stringify({ e: 'block', id: 'b1', op: 'delete', at: 1 })

  appendOp(db, { deviceId: dev, seq: 1, at: 1, opJson: op })
  appendOp(db, { deviceId: dev, seq: 1, at: 1, opJson: op })

  const rows = db.prepare('select count(*) as n from op_log where device_id = ? and seq = ?').all(dev, 1) as { n: number }[]
  assert.equal(rows[0]!.n, 1, '同一 (device_id, seq) 只能有一行：重发天然幂等')
  db.close()
})

test('A4：seq 水位随写入推进，且落库不跳号（跳号会让对端水位出现空洞）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  assert.equal(readSeq(db), 0, '新库的序号从 0 起')

  const n = appendLocalOps(db, 'a'.repeat(32), [{ at: 1, opJson: '{"e":"x"}' }, { at: 2, opJson: '{"e":"y"}' }])
  assert.equal(n, 2)
  assert.equal(readSeq(db), 2, '两批写入之后水位必须是 2')

  const seqs = (db.prepare('select seq from op_log order by seq').all() as { seq: number }[]).map((x) => x.seq)
  assert.deepEqual(seqs, [1, 2], `序号必须从 1 连续，实际：${seqs.join(',')}`)
  db.close()
})

test('A4：seq 与 op_log 在同一事务里 —— 撞主键时水位不许前进', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'a'.repeat(32)
  appendLocalOps(db, dev, [{ at: 1, opJson: '{"e":"ok"}' }])
  assert.equal(readSeq(db), 1)

  // 从 0 起算 ⇒ 下一条还是 seq=1 ⇒ 撞主键 ⇒ 整批不落、水位不动
  const n = appendLocalOps(db, dev, [{ at: 9, opJson: '{"e":"dup"}' }], { startSeq: 0 })
  assert.equal(n, 0, '撞主键的那一条必须整体不落')
  assert.equal(readSeq(db), 1, '水位不许因为一次失败的批而前进（跳号会让对端出现空洞）')
  db.close()
})

test('A4：op_log 的列形状是契约（device_id/seq/at/op_json，PK 两列）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const cols = (db.prepare('pragma table_info(op_log)').all() as { name: string; pk: number }[]).map((c) => `${c.name}:${c.pk}`)
  db.close()
  assert.deepEqual(cols, ['device_id:1', 'seq:2', 'at:0', 'op_json:0'], `op_log 的列与主键是契约，实际：${cols.join(' ')}`)
})

/* ------------------------------------------------------------ S4：变更流接了 */

/**
 * **每一批行写入都有对应的 op 行**（同一个事务）。
 *
 * 这是 `op_log` 接上生产写入之后的最小可判定验收：不是「表里有行」，
 * 而是「**每一批**落盘都有一条账」—— 前者在有空洞时照样绿。
 */
test('S4：一批行写入 ＋ 变更流 ⇒ 同一个事务，op_log 与水位一起前进', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'b'.repeat(32)

  const ops = [
    { at: 11, opJson: JSON.stringify({ e: 'block', id: 'b1', op: 'upsert', value: { content: [] }, at: 11 }) },
    { at: 12, opJson: JSON.stringify({ e: 'prop', block: 'b1', name: '_icon', op: 'set', value: 'x', at: 12 }) },
  ]
  applyRowWrites(db, [blockRow('b1')], { deviceId: dev, oplog: ops })

  const rows = db.prepare('select seq, at, op_json from op_log where device_id = ? order by seq').all(dev) as {
    seq: number
    at: number
    op_json: string
  }[]
  assert.equal(rows.length, 2, '两批 op ⇒ 两行账（每一批落盘都有对应记录）')
  assert.deepEqual(rows.map((x) => x.seq), [1, 2], '序号连续')
  assert.equal(readSeq(db), 2, '水位与 op_log 一起前进')
  assert.equal(JSON.parse(rows[0]!.op_json).id, 'b1', 'op_json 存的是那条 op 本身（不拆列）')
  db.close()
})

test('S4：行写入失败 ⇒ 变更流也不落（同一个事务，不能留半批）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'c'.repeat(32)

  // 一条会失败的写入：update 匹配不到行 ⇒ 抛错（见 `runWrite`）
  const bad = { table: 'Block' as const, op: 'update' as const, key: { id: '不存在' }, values: { content: '[]' } }
  assert.throws(() =>
    applyRowWrites(db, [bad], { deviceId: dev, oplog: [{ at: 1, opJson: '{"e":"x"}' }] }),
  )

  const n = (db.prepare('select count(*) as n from op_log').all() as { n: number }[])[0]!.n
  assert.equal(n, 0, '行写入失败 ⇒ 变更流一行都不许留（半批历史比没有历史更糟）')
  assert.equal(readSeq(db), 0, '水位也不许前进')
  db.close()
})

test('整份替换＝新 genesis：清旧日志、序号归零，再把这一批 op 写进去', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'd'.repeat(32)

  // 先写一段旧历史
  applyRowWrites(db, [blockRow('old')], {
    deviceId: dev,
    oplog: [{ at: 1, opJson: JSON.stringify({ e: 'block', id: 'old', op: 'exist', state: 'deleted', at: 1 }) }],
  })
  assert.equal(readSeq(db), 1)

  // 整份替换 ＋ 新 genesis：旧日志必须被清掉，序号从 0 重新开始
  replaceContentRows(db, [blockRow('seed')], {
    deviceId: dev,
    oplog: [
      { at: 2, opJson: JSON.stringify({ e: 'block', id: 'seed', op: 'upsert', value: { parent: null, prev: null, created: 2, modified: 2, content: [] }, at: 2 }) },
    ],
  })
  const rows = db.prepare('select seq, op_json from op_log order by seq').all() as { seq: number; op_json: string }[]
  assert.equal(rows.length, 1, '旧历史被清掉，只剩新 genesis 这一条')
  assert.equal(rows[0]!.seq, 1, '序号从 0 重新走到 1')
  assert.equal(JSON.parse(rows[0]!.op_json).id, 'seed')
  assert.equal(readSeq(db), 1)
  db.close()
})

/* ------------------------------------------------------------ 日志即状态 */

test('撤销一次插入后重开 ⇒ 块不进回收站（purged 删行，不是写 deleted）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const dev = 'e'.repeat(32)

  const root = mkBlock('根', { created: 1, modified: 1 })
  const store = new BlockStore([root])
  const kb = new MemoryKb(store)
  const wsOf = (): StoredWorkspace => ({ blocks: store.blocks, activeId: root.id, savedAt: 1 })
  const log = (ops: readonly Op[]): { at: number; opJson: string }[] =>
    ops.map((op) => ({ at: op.at, opJson: JSON.stringify(op) }))

  // 种子：整份替换 ＝ 新 genesis
  const genesis = diff([], store.blocks)
  replaceContentRows(db, workspaceToRowWrites(wsOf()), { deviceId: dev, oplog: log(genesis) })

  // 插入一块并落盘
  const snap = store.snap(null)
  const fresh = mkBlock('新', { created: 2, modified: 2 })
  const ins = kb.tx((tx) => tx.insert(fresh, root.id, 0)).ops
  applyRowWrites(db, rowWritesFor(wsOf(), ins), { deviceId: dev, oplog: log(ins) })

  // ⌘Z：撤销一次插入 ⇒ `exist{purged}`
  const undo = store.restore(snap).ops
  applyRowWrites(db, rowWritesFor(wsOf(), undo), { deviceId: dev, oplog: log(undo) })

  const reloaded = rowsToWorkspace(readContentRows(db))
  const found = reloaded.blocks.flatMap(function walk(b) { return [b, ...b.children.flatMap(walk)] }).find((b) => b.id === fresh.id)
  assert.equal(found, undefined, '撤销后重开：块必须真的不在（连回收站也不该有）')

  // 日志与行必须说同一件事：从空森林重放 op_log ＝ 装载出来的库
  const rows = db.prepare('select op_json from op_log order by seq').all() as { op_json: string }[]
  const ops = rows.map((x) => JSON.parse(x.op_json) as Op)
  assert.equal(
    forestFingerprint(replay(ops)),
    forestFingerprint(reloaded.blocks),
    'replay(op_log) 必须等于装载出来的模型（日志是状态的事实源）',
  )
  db.close()
})
