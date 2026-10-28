/**
 * 资产文件夹适配器（**真文件系统**）。
 *
 * 判据（与 114.3 的三条纪律一一对应）：
 *   ① **字节是真相**：侧车（`.json`）丢了/坏了，图照样读得出来；
 *   ② **临时文件 + rename**：不留半截文件；重复写幂等；
 *   ③ **`keys()` 只扫一遍**：启动时拉一次，之后 `put` 增量维护。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFolderAssetStore } from '../electron/library/assets.ts'

const dirs: string[] = []
function tmpAssets(): string {
  const d = mkdtempSync(join(tmpdir(), 'qua-assets-'))
  dirs.push(d)
  return join(d, 'assets')
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

test('put：内容寻址 —— 同一份字节两次入库只落一个文件', async () => {
  const store = createFolderAssetStore(tmpAssets())
  const a = await store.put(bytes('same bytes'), 'image/png')
  const b = await store.put(bytes('same bytes'), 'image/png')
  assert.equal(a.hash, b.hash, '同一份字节必须是同一个 hash')
  assert.match(a.hash, /^[0-9a-f]{64}$/, 'hash 是 SHA-256 的小写 hex')
  assert.equal(a.mime, 'image/png')
  assert.equal(a.size, 10)
})

test('put：按 hash 前两位分桶（一个目录不堆几万个文件）', async () => {
  const dir = tmpAssets()
  const store = createFolderAssetStore(dir)
  const meta = await store.put(bytes('bucket me'), 'image/png')
  const bucket = join(dir, meta.hash.slice(0, 2))
  assert.ok(existsSync(bucket), `应当落在 ${bucket}`)
  assert.deepEqual(readdirSync(bucket).sort(), [meta.hash, `${meta.hash}.json`].sort())
})

test('get / stat：读得回字节；meta 从侧车来', async () => {
  const store = createFolderAssetStore(tmpAssets())
  const meta = await store.put(bytes('hello'), 'image/webp', { w: 40, h: 20 })
  const back = await store.get(meta.hash)
  assert.deepEqual(back, bytes('hello'))
  const st = await store.stat(meta.hash)
  assert.equal(st!.mime, 'image/webp')
  assert.equal(st!.w, 40)
  assert.equal(st!.h, 20)
  assert.equal(await store.get('0'.repeat(64)), null, '不存在的 hash ⇒ null（不是抛错）')
  assert.equal(await store.stat('0'.repeat(64)), null)
})

test('① 侧车丢了 ⇒ 字节还在，stat 降级成最小 meta（不假装知道 mime）', async () => {
  const dir = tmpAssets()
  const store = createFolderAssetStore(dir)
  const meta = await store.put(bytes('sidecar gone'), 'image/png')
  rmSync(join(dir, meta.hash.slice(0, 2), `${meta.hash}.json`))

  assert.deepEqual(await store.get(meta.hash), bytes('sidecar gone'), '字节是真相：侧车没了图照样读得出')
  const st = await store.stat(meta.hash)
  assert.ok(st, 'stat 仍要给出一个结果（不是 null）')
  assert.equal(st!.mime, 'application/octet-stream', '侧车没了就只能说「不知道是什么」')
  assert.equal(st!.size, 12)
})

test('① 侧车坏了（不是 JSON）⇒ 同样降级，不抛错', async () => {
  const dir = tmpAssets()
  const store = createFolderAssetStore(dir)
  const meta = await store.put(bytes('sidecar broken'), 'image/png')
  writeFileSync(join(dir, meta.hash.slice(0, 2), `${meta.hash}.json`), '{ not json')
  const st = await store.stat(meta.hash)
  assert.equal(st!.mime, 'application/octet-stream')
})

test('② 不留临时文件（写完目录里只有字节与侧车）', async () => {
  const dir = tmpAssets()
  const store = createFolderAssetStore(dir)
  const meta = await store.put(bytes('no tmp'), 'image/png')
  const names = readdirSync(join(dir, meta.hash.slice(0, 2)))
  const stray = names.filter((n) => n.includes('.tmp-'))
  assert.deepEqual(stray, [], `不该留下临时文件：${stray.join(',')}`)
})

test('③ keys()：只认字节文件名，不把侧车当资产', async () => {
  const store = createFolderAssetStore(tmpAssets())
  const a = await store.put(bytes('one'), 'image/png')
  const b = await store.put(bytes('two'), 'image/jpeg')
  const keys = await store.keys()
  assert.deepEqual(keys.sort(), [a.hash, b.hash].sort(), '侧车（.json）不能被当成资产')
})

test('③ keys()：目录还不存在时返回空（新建库的第一次启动）', async () => {
  const store = createFolderAssetStore(tmpAssets())
  assert.deepEqual(await store.keys(), [])
})

test('③ keys() 之后再 put ⇒ 新 hash 立刻在名单里（不必重新扫）', async () => {
  const store = createFolderAssetStore(tmpAssets())
  await store.keys()
  const meta = await store.put(bytes('after scan'), 'image/png')
  assert.ok((await store.keys()).includes(meta.hash))
})
