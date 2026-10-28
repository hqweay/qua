/**
 * 库的身份与注册表（纯函数层）。
 *
 * 契约只有四条，测试名就是那四条：
 *   ① 库 id 是**目录名** ⇒ 形状恒为 32 位小写 hex，且生成端在「低 32 位为负」的时刻也不得写出 `-`；
 *   ② `library.json` 的 `id` 是权威 ⇒ 与目录名不一致时**不许静默择一**，要能判出来；
 *   ③ 注册表坏掉时**不许静默丢库**（能救的救、救不了的如实报）；
 *   ④ 库的 schema 版本只有一个判据（`user_version`），偏大＝拒绝、偏小＝迁移、等于 0＝新建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSETS_DIR,
  BACKUPS_DIR,
  DB_FILE,
  DB_SCHEMA_VERSION,
  LIBRARY_FORMAT,
  LIBRARY_KIND,
  MANIFEST_FILE,
  META_KEYS,
  deviceId,
  isDeviceId,
  isLibraryId,
  judgeDbVersion,
  libraryId,
  parseManifest,
  parseRegistry,
  serializeRegistry,
  type AppRegistry,
} from '../src/core/library.ts'

/* ------------------------------------------------------------ ① 库 id 的形状 */

test('libraryId：恒为 32 位小写十六进制（它是目录名，路径不认别的形状）', () => {
  for (let i = 0; i < 50; i++) {
    const id = libraryId()
    assert.match(id, /^[0-9a-f]{32}$/, `不该出现非十六进制字符：${id}`)
    assert.ok(isLibraryId(id), `应通过 isLibraryId：${id}`)
  }
})

test('libraryId：时间戳低 32 位为负时也不得写出带 `-` 的目录名', () => {
  /**
   * 与块 id 同一条教训（位与的掩码会被 ToInt32 收成 `-1`）：负时间戳经 `toString(16)`
   * 带负号，补位又加在负号前面 ⇒ 目录名里出现 `-`。
   * 这里独立再钉一次，因为**库 id 是路径**：形状坏掉不是「id 变丑」，是「库打不开」。
   */
  const negativeLow32 = 2 ** 32 * 417 + 2 ** 31 + 1234
  assert.ok((negativeLow32 | 0) < 0, '这个时刻应当落进负半区（用例前提）')
  const id = libraryId(negativeLow32)
  assert.match(id, /^[0-9a-f]{32}$/, `负半区也要是干净的 32 位 hex：${id}`)
  assert.ok(isLibraryId(id), `负半区也应通过 isLibraryId：${id}`)
})

test('isLibraryId：拒掉大写、带连字符、长度不对、以及空值', () => {
  const good = libraryId()
  assert.ok(isLibraryId(good))
  assert.equal(isLibraryId(good.toUpperCase()), false, '大写不算同一个 id（大小写不敏感的文件系统会骗人）')
  assert.equal(isLibraryId(`${good.slice(0, 8)}-${good.slice(8)}`), false, '带连字符的是块 id 的另一种写法')
  assert.equal(isLibraryId(good.slice(0, 31)), false, '短一位就不是这个形状')
  assert.equal(isLibraryId(''), false)
  assert.equal(isLibraryId(null), false)
  assert.equal(isLibraryId(42), false)
})

test('libraryId：同一毫秒连续生成也不撞（目录同名就是两个库撞一个目录）', () => {
  const t = 1_700_000_000_000
  const ids = new Set(Array.from({ length: 200 }, () => libraryId(t)))
  assert.equal(ids.size, 200, `同毫秒生成的 id 必须互不相同，实际只有 ${ids.size} 个`)
})

test('deviceId：形状与库 id 同族，且各有独立判据', () => {
  const d = deviceId()
  assert.ok(isDeviceId(d), `deviceId 应通过 isDeviceId：${d}`)
  assert.ok(isLibraryId(d), '两个判据当前同形（都是 32 位 hex），但函数分开 ⇒ 将来可以各自演化')
  const negativeLow32 = 2 ** 32 * 417 + 2 ** 31 + 1234
  assert.match(deviceId(negativeLow32), /^[0-9a-f]{32}$/, '负半区也要干净')
})

/* ------------------------------------------------------------ ② 目录身份 */

test('parseManifest：认 kind/format/id；id 不合法就是 corrupt（不是 missing）', () => {
  const id = libraryId()
  const ok = parseManifest(JSON.stringify({ kind: LIBRARY_KIND, format: LIBRARY_FORMAT, id }))
  assert.equal(ok.status, 'ok')
  if (ok.status === 'ok') assert.equal(ok.manifest.id, id)

  assert.equal(parseManifest(null).status, 'missing', '没这个文件 ＝ 这不是一个库')
  assert.equal(parseManifest('{').status, 'corrupt', '连 JSON 都不是')
  assert.equal(
    parseManifest(JSON.stringify({ kind: 'something-else', format: 1, id })).status,
    'corrupt',
    'kind 不对 ＝ 别人的目录，绝不能往里撒 qua.db',
  )
  assert.equal(
    parseManifest(JSON.stringify({ kind: LIBRARY_KIND, format: 2, id })).status,
    'corrupt',
    'format 偏大 ＝ 这个库比我们新，不能猜着读',
  )
  assert.equal(
    parseManifest(JSON.stringify({ kind: LIBRARY_KIND, format: 1, id: 'not-an-id' })).status,
    'corrupt',
    'id 形状不对 ⇒ 目录名与身份无从对照，必须报出来而不是补一个',
  )
})

test('目录形状常量：DB／manifest／assets／backups 的名字是契约（改一个就是旧库打不开）', () => {
  assert.equal(DB_FILE, 'qua.db')
  assert.equal(MANIFEST_FILE, 'library.json')
  assert.equal(ASSETS_DIR, 'assets')
  assert.equal(BACKUPS_DIR, 'backups')
  assert.equal(META_KEYS.libraryId, 'library_id')
  assert.equal(META_KEYS.name, 'name')
  assert.equal(META_KEYS.seq, 'seq')
})

/* ------------------------------------------------------------ ③ 注册表 */

function registry(patch: Partial<AppRegistry> = {}): AppRegistry {
  return {
    version: 1,
    deviceId: deviceId(),
    libraries: [{ id: libraryId(), name: '默认库', lastOpenedAt: 1 }],
    ...patch,
  }
}

test('parseRegistry：从没写过 ⇒ empty（不是 corrupt）', () => {
  assert.deepEqual(parseRegistry(null), { status: 'empty' })
})

test('parseRegistry：往返稳定（写出去再读回来是同一份）', () => {
  const reg = registry()
  const parsed = parseRegistry(serializeRegistry(reg))
  assert.equal(parsed.status, 'ok')
  if (parsed.status !== 'ok') return
  assert.deepEqual(parsed.registry, reg)
  assert.equal(parsed.generatedDeviceId, false)
})

test('parseRegistry：缺 device_id ⇒ 生成一个并如实报告（只在缺失时生成，坏值不猜）', () => {
  const reg = registry()
  const raw = JSON.stringify({ ...reg, deviceId: undefined })
  const parsed = parseRegistry(raw)
  assert.equal(parsed.status, 'ok')
  if (parsed.status !== 'ok') return
  assert.equal(parsed.generatedDeviceId, true, '这次生成过 device_id，调用方必须写回')
  assert.ok(isDeviceId(parsed.registry.deviceId), '生成出来的必须是合法形状')
})

test('parseRegistry：device_id 形状不对 ⇒ corrupt（重新生成会让历史断成两条设备线）', () => {
  const reg = registry()
  const parsed = parseRegistry(JSON.stringify({ ...reg, deviceId: 'oops' }))
  assert.equal(parsed.status, 'corrupt')
})

test('parseRegistry：坏条目被摘掉但**库不静默消失**（摘了几条要如实报）', () => {
  const good = { id: libraryId(), name: 'A', lastOpenedAt: 1 }
  const reg = { version: 1, deviceId: deviceId(), libraries: [good, { id: 'bad', name: 'B' }, null] }
  const parsed = parseRegistry(JSON.stringify(reg))
  assert.equal(parsed.status, 'ok')
  if (parsed.status !== 'ok') return
  assert.deepEqual(parsed.registry.libraries.map((l) => l.id), [good.id])
  assert.equal(parsed.dropped, 2, '被摘掉的条目数必须报出来，否则用户看到的是「库没了」')
})

test('parseRegistry：同一 id 出现两次 ⇒ 只留第一条并报告（一个 id 只能对应一个会话）', () => {
  const id = libraryId()
  const reg = {
    version: 1,
    deviceId: deviceId(),
    libraries: [
      { id, name: 'A', lastOpenedAt: 1 },
      { id, name: 'A 的副本', lastOpenedAt: 2 },
    ],
  }
  const parsed = parseRegistry(JSON.stringify(reg))
  assert.equal(parsed.status, 'ok')
  if (parsed.status !== 'ok') return
  assert.equal(parsed.registry.libraries.length, 1)
  assert.equal(parsed.dropped, 1)
})

test('parseRegistry：version 偏大 ⇒ corrupt（不能拿旧代码猜新格式）', () => {
  const parsed = parseRegistry(JSON.stringify({ ...registry(), version: 2 }))
  assert.equal(parsed.status, 'corrupt')
})

test('parseRegistry：lastOpenedId 指向不存在的库 ⇒ 清掉（不是 corrupt）', () => {
  const reg = registry()
  const parsed = parseRegistry(JSON.stringify({ ...reg, lastOpenedId: libraryId() }))
  assert.equal(parsed.status, 'ok')
  if (parsed.status !== 'ok') return
  assert.equal(parsed.registry.lastOpenedId, undefined, '指向不存在的库只会让启动每次白跑一次')
})

/* ------------------------------------------------------------ ④ schema 版本 */

test('judgeDbVersion：等于当前版本 ⇒ ok；偏大 ⇒ too-new（拒绝打开）；偏小 ⇒ migrate', () => {
  assert.deepEqual(judgeDbVersion(DB_SCHEMA_VERSION), { status: 'ok' })
  assert.deepEqual(judgeDbVersion(DB_SCHEMA_VERSION + 1), { status: 'too-new', found: DB_SCHEMA_VERSION + 1 })
  // 用显式的 target 验「偏小」：`DB_SCHEMA_VERSION - 1` 现在正好是 0，那是「全新库」不是迁移
  assert.deepEqual(judgeDbVersion(1, 2), { status: 'migrate', found: 1 })
  assert.deepEqual(judgeDbVersion(0, 2), { status: 'fresh' }, '0 永远是「全新库」，与 target 无关')
})

test('judgeDbVersion：0 ＝ 全新的库（建表），不是「从 0 迁移」', () => {
  assert.deepEqual(judgeDbVersion(0), { status: 'fresh' })
})

test('judgeDbVersion：负数／非整数 ⇒ 当作坏库（不猜）', () => {
  assert.equal(judgeDbVersion(-1).status, 'corrupt')
  assert.equal(judgeDbVersion(1.5).status, 'corrupt')
})
