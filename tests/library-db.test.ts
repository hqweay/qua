/**
 * `qua.db` 的版本与迁移（A1／B4 的可判定验收，跑**真 SQLite**）。
 *
 * 这一组测试的判据只有四条：
 *   ① `user_version` 偏大 ⇒ **拒绝打开**（不是重 seed，不是猜着读）；
 *   ② `user_version` 偏小 ⇒ **走迁移**，且迁移后数据全可读（不是 `expired` 重 seed）；
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
import { DB_SCHEMA_VERSION, META_KEYS } from '../src/core/library.ts'
import {
  appendOp,
  appendLocalOps,
  openLibraryDb,
  readMeta,
  readSeq,
  readWorkspaceBlob,
  writeMeta,
  writeWorkspaceBlob,
  type Migration,
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

/** 造一个「上一版代码留下的库」：给定版本号，只有它那一版的表 */
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

test('user_version 偏小 ⇒ migrate：旧数据全可读，版本号升到当前', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  // 目标定 2：当前版本是 1，所以「偏小」要有一个真的更新的目标才成立
  const r = openLibraryDb(file, { target: 2, migrations: [{ to: 2, up: () => {} }] })
  assert.equal(r.status, 'migrated', `偏小必须走迁移，实际 ${r.status}`)
  assert.ok(r.db, '迁移成功要交出可写连接')
  const db = r.db!
  const blob = readWorkspaceBlob(db)
  assert.ok(blob, '迁移之后旧数据必须读得出来（不是 expired 重 seed）')
  assert.deepEqual(JSON.parse(blob!.json), { blocks: [] }, '读回来的是**原来那份**，不是种子的')
  assert.equal(r.version, 2)
  db.close()
})

test('迁移是一条条走的：中间版本也能升到当前（不是只认「上一版」）', () => {
  const file = tmpDb()
  legacyDb(file, 1)
  /** 合成两步迁移：证明机制支持多步（真实迁移表目前是空的，所以这里注入） */
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

test('负向断言：库里有数据时，任何打开路径都不许 seed 覆盖（including 新建库那条）', () => {
  const file = tmpDb()
  // 一个「用户已经写了东西」的库
  const first = openLibraryDb(file)
  assert.equal(first.status, 'created')
  const db = first.db!
  const userJson = JSON.stringify({ blocks: [{ id: 'user-written' }], activeId: 'user-written', savedAt: 1 })
  writeWorkspaceBlob(db, userJson, 1)
  writeMeta(db, META_KEYS.name, '我的库')
  db.close()

  // 再打开三次（模拟启动三次）：每次都必须是 ok，且**绝不**把 seed 写进去
  for (let i = 0; i < 3; i++) {
    const again = openLibraryDb(file)
    assert.equal(again.status, 'ok', `第 ${i + 1} 次打开应当是 ok，实际 ${again.status}`)
    const d = again.db!
    assert.equal(readWorkspaceBlob(d)?.json, userJson, '用户数据必须逐字节不变')
    assert.equal(readMeta(d, META_KEYS.name), '我的库')
    d.close()
  }
})

test('负向断言：`created` 只建空表，不写任何 workspace 行（seed 是调用方的事）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  assert.equal(r.status, 'created')
  const db = r.db!
  assert.equal(readWorkspaceBlob(db), undefined, '建库不许顺手塞一份种子：种子一旦写进来，「用户数据」与「演示数据」就分不开了')
  db.close()
})

/* ------------------------------------------------------------ 附带：临时形状的边界 */

test('当前的临时形状只有四张表（规范化 schema 是下一步的事，不许提前长出来）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const tables = (db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all() as {
    name: string
  }[]).map((t) => t.name).sort()
  db.close()
  assert.deepEqual(tables, ['meta', 'op_log', 'settings', 'workspace'], `现在只该有这四张表，实际：${tables.join(',')}`)
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
