/**
 * 快照恢复：`backups/*.db` 能**放回**库，且放回是安全的。
 *
 * 这一组测的是「恢复链的最后一格」——在这之前 `snapshotLibrary` 拍得出快照，
 * 但全仓没有任何一条路径把快照放回去（`grep -rni restore` 命中的全是窗口
 * `restore()`／焦点归还／DOM 文本）。有拍无回，等于备份只是个文件。
 *
 * 五条判据：
 *   ① 恢复**先拍当前态**：恢复本身是破坏性动作，它也需要回退面；
 *   ② 恢复后**内容真的换了**（不是「命令成功了」）；
 *   ③ 恢复**不改库身份**：`library.json` 与 `meta.library_id` 不许被快照里的旧值覆盖
 *      （快照是同库的历史，不是另一个库的拷贝）；
 *   ④ 版本**偏大**的快照拒绝恢复：那是更新版写的，用旧版打开会让它按旧口径解释；
 *   ⑤ 恢复失败时**主库仍是原来那份**（不半途改坏）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKUPS_DIR, DB_FILE, DB_SCHEMA_VERSION, META_KEYS } from '../src/core/identity/library.ts'
import { openSession } from '../electron/library/session.ts'
import { restoreFromBackup, listBackups } from '../electron/library/restore.ts'
import { readMeta } from '../electron/library/sqlite.ts'

const dirs: string[] = []
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'qua-restore-'))
  dirs.push(d)
  return d
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/** 建一个库，往里写一行可辨认的内容，返回 { dir, id } */
function makeLibrary(root: string, id: string, marker: string): { dir: string; id: string } {
  const dir = join(root, 'repos', id)
  const opened = openSession(dir, { expectId: id, deviceId: 'dev-test' })
  assert.equal(opened.status, 'ok', `建库失败：${JSON.stringify(opened)}`)
  const s = opened.session!
  s.db.prepare('insert or replace into settings (key, value) values (?, ?)').run('marker', marker)
  s.close()
  return { dir, id }
}

/** 读一行 settings 当「内容指纹」——恢复前后比它 */
function markerOf(dir: string): string | undefined {
  const db = new DatabaseSync(join(dir, DB_FILE))
  try {
    const rows = db.prepare('select value from settings where key = ?').all('marker') as { value: string }[]
    return rows[0]?.value
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------ ② 内容真的换了 */

test('restoreFromBackup：把旧快照放回去之后，内容真的回到那一刻', () => {
  const root = tmpRoot()
  const { dir, id } = makeLibrary(root, 'a'.repeat(32), 'v1')
  // 拍一份「v1 时刻」的快照（此时 marker=v1）
  const snap = join(dir, BACKUPS_DIR, '1000-manual.db')
  const live = new DatabaseSync(join(dir, DB_FILE))
  live.exec(`vacuum into '${snap.replace(/'/g, "''")}'`)
  live.prepare('update settings set value = ? where key = ?').run('v2', 'marker')
  live.close()
  assert.equal(markerOf(dir), 'v2', '前置：拍完快照后又改成了 v2')

  const r = restoreFromBackup(dir, snap)
  assert.equal(r.status, 'ok', `恢复应成功：${JSON.stringify(r)}`)
  assert.equal(markerOf(dir), 'v1', '恢复后内容应是快照那一刻的 v1')
})

/* ------------------------------------------------------------ ① 恢复先拍当前态 */

test('restoreFromBackup：恢复**先拍当前态**——恢复本身也要有回退面', () => {
  const root = tmpRoot()
  const { dir, id } = makeLibrary(root, 'b'.repeat(32), 'old')
  const snap = join(dir, BACKUPS_DIR, '1000-manual.db')
  const live = new DatabaseSync(join(dir, DB_FILE))
  live.exec(`vacuum into '${snap.replace(/'/g, "''")}'`)
  live.prepare('update settings set value = ? where key = ?').run('new', 'marker')
  live.close()

  const before = listBackups(dir).length
  const r = restoreFromBackup(dir, snap)
  assert.equal(r.status, 'ok')
  const after = listBackups(dir)
  assert.equal(after.length, before + 1, `恢复前应多出一份 before-restore 快照：${JSON.stringify(after)}`)
  const made = after.find((b) => b.label.includes('before-restore'))
  assert.ok(made, `应有一份 label 含 before-restore 的快照：${JSON.stringify(after)}`)
  // 那一份里存的是恢复前的内容（new），不是快照里的（old）
  const db = new DatabaseSync(made!.file)
  const v = (db.prepare('select value from settings where key = ?').all('marker') as { value: string }[])[0]?.value
  db.close()
  assert.equal(v, 'new', 'before-restore 快照里应是恢复前那一刻的内容')
})

/* ------------------------------------------------------------ ③ 不改库身份 */

test('restoreFromBackup：**不改库身份**——manifest 与 meta.library_id 仍是这个库', () => {
  const root = tmpRoot()
  const id = 'c'.repeat(32)
  const { dir } = makeLibrary(root, id, 'v1')
  const snap = join(dir, BACKUPS_DIR, '1000-manual.db')
  const live = new DatabaseSync(join(dir, DB_FILE))
  live.exec(`vacuum into '${snap.replace(/'/g, "''")}'`)
  live.close()

  const r = restoreFromBackup(dir, snap)
  assert.equal(r.status, 'ok')

  // meta.library_id 必须还是这个库
  const db = new DatabaseSync(join(dir, DB_FILE))
  const metaId = readMeta(db, META_KEYS.libraryId)
  db.close()
  assert.equal(metaId, id, '恢复不许把 meta.library_id 换成快照里的值')

  // 重新打开仍然过身份三方对照（manifest vs meta vs 目录名）
  const reopened = openSession(dir, { expectId: id, deviceId: 'dev-test' })
  assert.equal(reopened.status, 'ok', `恢复后应能正常打开：${JSON.stringify(reopened)}`)
  reopened.status === 'ok' && reopened.session.close()
})

/* ------------------------------------------------------------ ④ 版本偏大拒绝 */

test('restoreFromBackup：版本**偏大**的快照拒绝恢复（不猜着读）', () => {
  const root = tmpRoot()
  const { dir } = makeLibrary(root, 'd'.repeat(32), 'v1')
  const snap = join(dir, BACKUPS_DIR, '1000-future.db')
  // 造一份「未来版本」的快照
  const fake = new DatabaseSync(snap)
  fake.exec(`pragma user_version = ${DB_SCHEMA_VERSION + 1}`)
  fake.close()

  const r = restoreFromBackup(dir, snap)
  assert.equal(r.status, 'failed', `偏大版本应拒绝：${JSON.stringify(r)}`)
  assert.equal(r.status === 'failed' && r.reason, 'too-new')
  assert.equal(markerOf(dir), 'v1', '拒绝时主库不许被改动')
})

/* ------------------------------------------------------------ ⑤ 失败不改坏主库 */

test('restoreFromBackup：快照文件不存在 ⇒ 失败，且主库**一个字节没动**', () => {
  const root = tmpRoot()
  const { dir } = makeLibrary(root, 'e'.repeat(32), 'keep')
  const sizeBefore = statSync(join(dir, DB_FILE)).size
  const r = restoreFromBackup(dir, join(dir, BACKUPS_DIR, "nope.db"))
  assert.equal(r.status, 'failed')
  assert.equal(r.status === 'failed' && r.reason, 'no-such-backup')
  assert.equal(markerOf(dir), 'keep', '主库内容不许变')
  assert.equal(statSync(join(dir, DB_FILE)).size, sizeBefore, '主库大小也不许变')
})

/* ------------------------------------------------------------ 快照列表 */

test('listBackups：按时间**倒序**（最近的在最前），且只认 .db', () => {
  const root = tmpRoot()
  const { dir } = makeLibrary(root, 'f'.repeat(32), 'v1')
  const live = new DatabaseSync(join(dir, DB_FILE))
  for (const name of ['1000-a.db', '3000-c.db', '2000-b.db']) {
    live.exec(`vacuum into '${join(dir, BACKUPS_DIR, name).replace(/'/g, "''")}'`)
  }
  live.close()
  // 非 .db 文件不该进列表
  const junk = join(dir, BACKUPS_DIR, 'notes.txt')
  writeFileSync(junk, 'x')

  const list = listBackups(dir)
  assert.deepEqual(
    list.map((b) => b.file.split('/').pop()),
    ['3000-c.db', '2000-b.db', '1000-a.db'],
    `应按 epoch 倒序：${JSON.stringify(list.map((b) => b.file))}`,
  )
})
