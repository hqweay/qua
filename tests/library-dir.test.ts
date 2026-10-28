/**
 * 注册表与库目录（**真文件系统**，临时目录）。
 *
 * 这一组测的是「磁盘上真的留下了什么」，不是纯函数的形状：
 *   ① `app.json` 是**原子写**（崩在中间不留半截）；
 *   ② 坏 `app.json` **不许静默丢库**（备份 + 从 `repos/` 重建）；
 *   ③ `library.json` 是身份权威，与目录名/DB meta 不一致时**拒绝打开**（副本判定）；
 *   ④ 非空目录不许被初始化（不往用户的项目目录里撒 `qua.db`）；
 *   ⑤ `user_version` 偏大时拒绝打开，且**不改它的版本号**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, LIBRARY_KIND, MANIFEST_FILE, META_KEYS, serializeManifest, libraryId } from '../src/core/library.ts'
import {
  findLibrary,
  libraryDir,
  loadRegistry,
  markOpened,
  removeLibrary,
  saveRegistry,
  upsertLibrary,
  writeFileAtomic,
  type RegistryIo,
} from '../electron/library/registry.ts'
import { loadContent, openSession, saveContent } from '../electron/library/session.ts'

const dirs: string[] = []
function tmpRoot(): RegistryIo {
  const d = mkdtempSync(join(tmpdir(), 'qua-reg-'))
  dirs.push(d)
  return { file: join(d, 'app.json'), reposDir: join(d, 'repos') }
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/* ------------------------------------------------------------ ① 原子写 */

test('writeFileAtomic：写完之后目录里只剩目标文件（不留临时文件）', () => {
  const io = tmpRoot()
  writeFileAtomic(io.file, '{"a":1}')
  assert.equal(readFileSync(io.file, 'utf8'), '{"a":1}')
  const left = readdirSync(join(io.file, '..')).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(left, [], `不该留下临时文件：${left.join(',')}`)
})

test('writeFileAtomic：父目录不存在时会建出来（首次启动就是这个形状）', () => {
  const io = tmpRoot()
  assert.equal(existsSync(io.file), false)
  writeFileAtomic(io.file, 'x')
  assert.equal(existsSync(io.file), true)
})

/* ------------------------------------------------------------ ② 坏注册表 */

test('loadRegistry：从没写过 ⇒ 起一份空列表，并**生成 device_id 写回**', () => {
  const io = tmpRoot()
  const loaded = loadRegistry(io)
  assert.deepEqual(loaded.registry.libraries, [])
  assert.ok(loaded.generatedDeviceId, '首次启动必须生成 device_id')
  assert.ok(existsSync(io.file), '生成之后必须写回，否则下次启动又生成一个')
  // 再读一次：不再生成（同一个设备身份）
  const again = loadRegistry(io)
  assert.equal(again.generatedDeviceId, false)
  assert.equal(again.registry.deviceId, loaded.registry.deviceId, 'device_id 必须稳定：变了就是历史断成两条设备线')
})

test('loadRegistry：坏 JSON ⇒ 备份 + 从 repos 重建默认库（**不静默丢库**）', () => {
  const io = tmpRoot()
  const id = libraryId()
  mkdirSync(join(io.reposDir, id), { recursive: true })
  writeFileSync(join(io.reposDir, id, MANIFEST_FILE), serializeManifest(id))
  writeFileSync(io.file, '{ this is not json')

  const loaded = loadRegistry(io)
  assert.ok(loaded.backup, '坏文件必须先备份（用户可能想手修）')
  assert.ok(existsSync(loaded.backup!), `备份文件应当真的在：${loaded.backup}`)
  assert.equal(loaded.recovered, 1, '默认库必须被扫回来')
  assert.deepEqual(loaded.registry.libraries.map((l) => l.id), [id], '扫回来的库要进列表')
})

test('loadRegistry：坏 JSON 且 repos 是空 ⇒ 空列表（不是崩）', () => {
  const io = tmpRoot()
  writeFileSync(io.file, 'nope')
  const loaded = loadRegistry(io)
  assert.deepEqual(loaded.registry.libraries, [])
  assert.equal(loaded.recovered, 0)
})

test('loadRegistry：条目坏了被摘掉，但 dropped 如实报（不静默）', () => {
  const io = tmpRoot()
  const good = libraryId()
  writeFileSync(
    io.file,
    JSON.stringify({
      version: 1,
      deviceId: 'a'.repeat(32),
      libraries: [{ id: good, name: 'A' }, { id: 'bad-id', name: 'B' }],
    }),
  )
  const loaded = loadRegistry(io)
  assert.equal(loaded.dropped, 1, '摘掉几条必须报出来')
  assert.deepEqual(loaded.registry.libraries.map((l) => l.id), [good])
})

/* ------------------------------------------------------------ 纯内存的增删 */

test('upsertLibrary / removeLibrary / markOpened：同 id 只留一条；移除不删目录', () => {
  const io = tmpRoot()
  const a = libraryId()
  const b = libraryId()
  let reg = loadRegistry(io).registry
  reg = upsertLibrary(reg, { id: a, name: 'A' })
  reg = upsertLibrary(reg, { id: a, name: 'A 改名' })
  reg = upsertLibrary(reg, { id: b, name: 'B' })
  assert.equal(reg.libraries.length, 2, '同一个 id 不能有两条')
  assert.equal(findLibrary(reg, a)!.name, 'A 改名')

  reg = markOpened(reg, b, 42)
  assert.equal(reg.lastOpenedId, b)
  assert.equal(findLibrary(reg, b)!.lastOpenedAt, 42)

  reg = removeLibrary(reg, b)
  assert.equal(reg.lastOpenedId, undefined, '移除最后打开的那个，lastOpenedId 必须一起清')
  assert.equal(reg.libraries.length, 1)
})

test('libraryDir：默认库住 repos/<id>，外部库用自己的 path', () => {
  const io = tmpRoot()
  const id = libraryId()
  assert.equal(libraryDir(io, { id, name: 'A' }), join(io.reposDir, id))
  assert.equal(libraryDir(io, { id, name: 'A', path: '/tmp/elsewhere' }), '/tmp/elsewhere')
})

/* ------------------------------------------------------------ ③ 库目录与身份 */

test('openSession：空目录 + expectId ⇒ 初始化（manifest / db / assets / backups 四样齐）', () => {
  const io = tmpRoot()
  const id = libraryId()
  const dir = join(io.reposDir, id)
  const r = openSession(dir, { expectId: id })
  assert.equal(r.status, 'ok', `应当初始化成功，实际 ${JSON.stringify(r)}`)
  const s = r.status === 'ok' ? r.session : null
  assert.ok(s)
  assert.equal(s!.id, id)
  for (const name of [MANIFEST_FILE, DB_FILE, 'assets', 'backups']) {
    assert.ok(existsSync(join(dir, name)), `库目录里必须有 ${name}`)
  }
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'))
  assert.equal(manifest.kind, LIBRARY_KIND)
  assert.equal(manifest.id, id, '**目录名 == id** 是路径契约')
  s!.close()
})

test('openSession：非空目录 + 没有 manifest ⇒ 拒绝（不往里撒 qua.db）', () => {
  const io = tmpRoot()
  const dir = join(io.reposDir, 'some-project')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.ts'), 'export {}')
  const r = openSession(dir, { expectId: libraryId() })
  assert.equal(r.status, 'failed')
  if (r.status !== 'failed') return
  assert.equal(r.failure.reason, 'not-a-library')
  assert.equal(existsSync(join(dir, DB_FILE)), false, '**绝不能**往别人的目录里撒 qua.db')
})

test('openSession：manifest 的 id 与注册表说的不一致 ⇒ identity-conflict（副本判定）', () => {
  const io = tmpRoot()
  const real = libraryId()
  const other = libraryId()
  const dir = join(io.reposDir, real)
  assert.equal(openSession(dir, { expectId: real }).status, 'ok')

  const r = openSession(dir, { expectId: other })
  assert.equal(r.status, 'failed')
  if (r.status !== 'failed') return
  assert.equal(r.failure.reason, 'identity-conflict')
})

test('openSession：manifest 与目录名不一致 ⇒ identity-conflict（改名过的副本）', () => {
  const io = tmpRoot()
  const real = libraryId()
  const dir = join(io.reposDir, real)
  assert.equal(openSession(dir, { expectId: real }).status, 'ok')
  // 目录被改成另一个「看起来像 id」的名字
  const renamed = join(io.reposDir, libraryId())
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(renamed, { recursive: true })
  writeFileSync(join(renamed, MANIFEST_FILE), serializeManifest(real))
  const r = openSession(renamed)
  assert.equal(r.status, 'failed')
  if (r.status !== 'failed') return
  assert.equal(r.failure.reason, 'identity-conflict')
})

test('openSession：内容往返（写进去的行读回来一模一样）', () => {
  const io = tmpRoot()
  const id = libraryId()
  const dir = join(io.reposDir, id)
  const r = openSession(dir, { expectId: id })
  assert.equal(r.status, 'ok')
  const s = r.status === 'ok' ? r.session : null
  assert.equal(loadContent(s!), undefined, '新建的库**没有内容**：seed 是调用方的事')

  /**
   * 一条最小的行写入：一个块 ＋ 库级两格。
   * ⚠️ 这里**不经过编码层**（`core/storage/db-rows.ts`）——测的是「主进程存得下、读得回」，
   *    编码的正确性由 `tests/storage/db-rows.test.ts` 用真模型往返钉住。
   */
  const writes = [
    {
      table: 'Block' as const,
      op: 'upsert' as const,
      key: { id: 'b1' },
      values: { content: '[]', created: 1, modified: 2, parent: null, left: null },
    },
    { table: 'meta' as const, op: 'upsert' as const, key: { key: META_KEYS.activeId }, values: { value: 'b1' } },
    { table: 'meta' as const, op: 'upsert' as const, key: { key: META_KEYS.savedAt }, values: { value: '7' } },
  ]
  saveContent(s!, writes, { replace: true })
  const back = loadContent(s!)
  assert.ok(back, '写进去之后必须读得出来')
  assert.deepEqual(back!.blocks.map((b) => b.id), ['b1'])
  assert.equal(back!.meta[META_KEYS.activeId], 'b1')
  assert.equal(back!.meta[META_KEYS.savedAt], '7')
  s!.close()

  // 重开：内容还在（这是当前完成判据里最小的那一格）
  const again = openSession(dir, { expectId: id })
  assert.equal(again.status, 'ok')
  const s2 = again.status === 'ok' ? again.session : null
  assert.deepEqual(loadContent(s2!)!.blocks.map((b) => b.id), ['b1'])
  s2!.close()
})

/* ------------------------------------------------------------ ⑤ 版本偏大 */

test('openSession：user_version 偏大 ⇒ too-new，且**不改**它的版本号', () => {
  const io = tmpRoot()
  const id = libraryId()
  const dir = join(io.reposDir, id)
  assert.equal(openSession(dir, { expectId: id }).status, 'ok')

  // 冒充「更新版写过这个库」
  const db = new DatabaseSync(join(dir, DB_FILE))
  db.exec('pragma user_version = 99')
  db.close()

  const r = openSession(dir, { expectId: id })
  assert.equal(r.status, 'failed')
  if (r.status !== 'failed') return
  assert.equal(r.failure.reason, 'too-new')
  assert.equal(r.failure.reason === 'too-new' ? r.failure.version : -1, 99)

  const check = new DatabaseSync(join(dir, DB_FILE))
  const v = (check.prepare('pragma user_version').all()[0] as { user_version: number }).user_version
  check.close()
  assert.equal(v, 99, '拒绝打开不许顺手把版本号改回来')
})

/* ------------------------------------------------------------ 附带：注册表写盘往返 */

test('saveRegistry：往返之后库列表与 device_id 都不变', () => {
  const io = tmpRoot()
  const reg = loadRegistry(io).registry
  const id = libraryId()
  const next = upsertLibrary(reg, { id, name: '新库' })
  saveRegistry(io, next)
  const back = loadRegistry(io).registry
  assert.deepEqual(back.libraries, next.libraries)
  assert.equal(back.deviceId, next.deviceId)
})
