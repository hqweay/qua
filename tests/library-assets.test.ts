/**
 * 资产文件夹适配器（**真文件系统 ＋ 真 SQLite**）。
 *
 * 判据（新的四条不变量一一对应）：
 *   ① **一图一行一文件**：字节在 `assets/<hh>/<hash>.<ext>`，元信息在 `qua.db` 的
 *      `assets` 表里 —— 目录里**没有** `.json` 侧车（那是第二个 store，与正文没有事务关系）；
 *   ② **字节只增、行才说话**：`put` 先写文件再写行 ⇒ 崩溃只会多出孤儿文件，
 *      任何一行指向的文件一定还在（DB 回滚不会产生坏引用）；
 *   ③ **后缀只写不读**：它是 `mime` 的投影，给 Finder／外部工具看；类型只从行里来；
 *   ④ **`reindex()` 是「外人给的字节」的唯一入口**：导入／修复／旧库迁移同一个动作 ——
 *      它会补后缀、会校验「名字与内容一致」（内容寻址的意义就在这里），
 *      也会把行里空着的尺寸从字节头补回来（只补空格，不覆盖已有值），
 *      正常启动**不**扫目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFolderAssetStore } from '../electron/library/assets.ts'
import { openLibraryDb, type Db } from '../electron/library/sqlite.ts'
import { DB_TABLES } from '../src/core/library.ts'

const dirs: string[] = []
/** 一个「库目录」：`qua.db` ＋ 空的 `assets/` */
function tmpLibrary(): { db: Db; assets: string; close: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'qua-assets-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  const assets = join(d, 'assets')
  mkdirSync(assets, { recursive: true })
  const db = r.db!
  return { db, assets, close: () => db.close() }
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * 一份最小 PNG 头（96×60）：够嗅类型、够读尺寸，不是能解码的图。
 *
 * 用它而不是随手一段文本，是因为尺寸只有字节头能给——`reindex` 那条路不解码。
 */
function pngHead(w = 96, h = 60): Uint8Array {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13], 8) // IHDR 的载荷长
  b.set(new TextEncoder().encode('IHDR'), 12)
  const be32 = (o: number, v: number): void => {
    b[o] = (v >>> 24) & 0xff
    b[o + 1] = (v >>> 16) & 0xff
    b[o + 2] = (v >>> 8) & 0xff
    b[o + 3] = v & 0xff
  }
  be32(16, w)
  be32(20, h)
  b.set([8, 2, 0, 0, 0], 24) // 位深／颜色类型／压缩／滤波／隔行
  return b
}

test('put：内容寻址 —— 同一份字节两次入库只有一行、一个文件', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const a = await store.put(bytes('same bytes'), 'image/png')
  const b = await store.put(bytes('same bytes'), 'image/png')
  assert.equal(a.hash, b.hash, '同一份字节必须是同一个 hash')
  assert.match(a.hash, /^[0-9a-f]{64}$/, 'hash 是 SHA-256 的小写 hex')
  assert.equal(a.mime, 'image/png')
  assert.equal(a.size, 10)
  assert.equal(store.rows().length, 1, '一行')
  assert.deepEqual(readdirSync(join(lib.assets, a.hash.slice(0, 2))), [`${a.hash}.png`], '一个文件，没有侧车')
  lib.close()
})

test('put：按 hash 前两位分桶，文件名是 `<hash>.<ext>`（Finder 能预览）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const meta = await store.put(bytes('bucket me'), 'image/webp')
  const bucket = join(lib.assets, meta.hash.slice(0, 2))
  assert.ok(existsSync(bucket), `应当落在 ${bucket}`)
  assert.deepEqual(readdirSync(bucket), [`${meta.hash}.webp`], '后缀是 mime 的投影（webp → .webp）')
  lib.close()
})

test('② 元信息在库里：重开库（新 store）之后 mime／尺寸仍然在，不靠侧车', async () => {
  const lib = tmpLibrary()
  const first = await createFolderAssetStore(lib.db, lib.assets)
  const meta = await first.put(bytes('hello'), 'image/webp', { w: 40, h: 20 })
  lib.close()

  // 同一个库再开一次：新连接、新 store —— 只有 DB 里那一行能回答「它是什么、多大」
  const reopened = openLibraryDb(join(lib.assets, '..', 'qua.db'))
  assert.equal(reopened.status, 'ok')
  const store = createFolderAssetStore(reopened.db!, lib.assets)
  const [row] = store.rows()
  assert.equal(row.hash, meta.hash)
  assert.equal(row.mime, 'image/webp')
  assert.equal(row.w, 40)
  assert.equal(row.h, 20)
  assert.deepEqual(store.locate(meta.hash), {
    path: join(lib.assets, meta.hash.slice(0, 2), `${meta.hash}.webp`),
    mime: 'image/webp',
  })
  assert.equal(store.locate('0'.repeat(64)), null, '没有这一行 ⇒ 没有地址（不是猜一个）')
  reopened.db!.close()
})

test('② 不留临时文件（写完目录里只有那份字节）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const meta = await store.put(bytes('no tmp'), 'image/png')
  const names = readdirSync(join(lib.assets, meta.hash.slice(0, 2)))
  assert.deepEqual(names.filter((n) => n.includes('.tmp-')), [], `不该留下临时文件：${names.join(',')}`)
  lib.close()
})

test('④ reindex：行全丢了、字节还在 ⇒ 从目录重建（导入／修复同一入口）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const meta = await store.put(bytes('orphan bytes'), 'image/png')
  // 模拟「DB 回滚到没有这一行」：行没了，文件还在
  lib.db.prepare(`delete from ${DB_TABLES.assets}`).run()

  const rebuilt = createFolderAssetStore(lib.db, lib.assets)
  assert.deepEqual(rebuilt.rows(), [], '新 store 只认行 —— 行没了就等于「库里没有这份资产」')
  assert.ok(existsSync(join(lib.assets, meta.hash.slice(0, 2), `${meta.hash}.png`)), '年龄文件仍在（只增）')

  const r = rebuilt.reindex()
  assert.equal(r.rows, 1, '从目录重建出一行')
  assert.equal(rebuilt.rows()[0].hash, meta.hash)
  assert.equal(rebuilt.locate(meta.hash)?.mime, 'application/octet-stream', '非图片字节：类型说「不知道」，不猜')
  lib.close()
})

test('④ reindex：旧版无后缀的文件就地在补后缀（那一次形状变化的唯一动作）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const meta = await store.put(bytes('legacy'), 'image/gif')
  const bucket = join(lib.assets, meta.hash.slice(0, 2))
  renameSync(join(bucket, `${meta.hash}.gif`), join(bucket, meta.hash))
  lib.db.prepare(`delete from ${DB_TABLES.assets}`).run()

  const rebuilt = createFolderAssetStore(lib.db, lib.assets)
  const r = rebuilt.reindex()
  assert.equal(r.renamed, 1, '应把一个无后缀文件补成 `.bin`（嗅不出图片类型）')
  assert.deepEqual(readdirSync(bucket), [`${meta.hash}.bin`])
  lib.close()
})

test('④ reindex：名字与内容不符的文件不收（内容寻址的意义是可校验）', async () => {
  const lib = tmpLibrary()
  const stray = 'a'.repeat(64)
  mkdirSync(join(lib.assets, stray.slice(0, 2)), { recursive: true })
  writeFileSync(join(lib.assets, stray.slice(0, 2), `${stray}.png`), bytes('not that hash'))

  const store = createFolderAssetStore(lib.db, lib.assets)
  const r = store.reindex()
  assert.equal(r.rows, 0, '内容与名字对不上 ⇒ 不进索引（宁可它 missing，也不要「图显示成别人」）')
  assert.deepEqual(store.rows(), [])
  lib.close()
})

test('④ reindex：目录里的外人东西（非 hex 桶／杂物）不参与', async () => {
  const lib = tmpLibrary()
  mkdirSync(join(lib.assets, '未命名文件夹'), { recursive: true })
  writeFileSync(join(lib.assets, '.DS_Store'), 'junk')
  const store = createFolderAssetStore(lib.db, lib.assets)
  assert.equal(store.reindex().rows, 0)
  lib.close()
})

test('④ reindex：行里空着的尺寸从字节头补回（旧库的尺寸原本写在侧车里）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  const meta = await store.put(pngHead(), 'image/png')
  assert.equal(meta.w, undefined, '入库时没给尺寸 ⇒ 行里就是空的')

  const r = store.reindex()
  assert.equal(r.filled, 1, '补回一行的尺寸')
  const [row] = store.rows()
  assert.deepEqual([row.w, row.h], [96, 60], '尺寸来自字节头，不需要侧车')
  assert.equal(store.reindex().filled, 0, '已经填满 ⇒ 再跑一次无事可做（幂等）')
  lib.close()
})

test('④ reindex：行里已有的尺寸不被字节头覆盖（解码结果比读头更准）', async () => {
  const lib = tmpLibrary()
  const store = createFolderAssetStore(lib.db, lib.assets)
  // 40×20 是「解码后、EXIF 已校正」的尺寸：字节头里的 96×60 是原始像素，方向可能不同
  await store.put(pngHead(), 'image/png', { w: 40, h: 20 })
  assert.equal(store.reindex().filled, 0)
  const [row] = store.rows()
  assert.deepEqual([row.w, row.h], [40, 20], '补空格，不覆盖——否则一次 reindex 会把好数据改坏')
  lib.close()
})
