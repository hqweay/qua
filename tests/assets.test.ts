/**
 * 资产层：内容地址、类型嗅探、**种子样本与哈希的一致性**。
 *
 * 这些断言钉的是「入口能失败」：
 *   · 不信文件名（改后缀骗不过嗅探）；
 *   · 未知类型不静默当图片；
 *   · 尺寸只从字节来（读头不解码），读不出就是 `null`——不猜一个宽高比；
 *   · hash 由字节决定（同一份字节永远同一个地址）；
 *   · **种子里的 hash 真的是那份字节的 hash**——写错的话默认演示会静默变成 `missing`，
 *     而那种失败看起来像「资产库坏了」，没有任何报错指向真正的原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isAssetHash,
  isSupportedImageMime,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  sha256Hex,
  sniffImageDims,
  sniffImageMime,
} from '../src/core/assets.ts'
import {
  MISSING_ASSET_HASH,
  SEED_ASSET_H,
  SEED_ASSET_HASH,
  SEED_ASSET_W,
  seedAssetBytes,
} from '../src/core/fixtures/assets.ts'

const bytes = (...xs: number[]): Uint8Array => Uint8Array.from(xs)

test('sha256Hex：已知向量（空串 / abc）', async () => {
  assert.equal(await sha256Hex(bytes()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(
    await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('sha256Hex：同一份字节永远同一地址，改一个字节就变', async () => {
  const a = await sha256Hex(bytes(1, 2, 3))
  const b = await sha256Hex(bytes(1, 2, 3))
  const c = await sha256Hex(bytes(1, 2, 4))
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 64)
  assert.ok(isAssetHash(a))
  assert.ok(!isAssetHash(a.slice(0, 63)))
  assert.ok(!isAssetHash(a.toUpperCase()))
})

test('sniffImageMime：只认 allowlist 的字节头', () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0)
  const gif = new TextEncoder().encode('GIF89a....')
  const webp = new Uint8Array(16)
  webp.set(new TextEncoder().encode('RIFF'), 0)
  webp.set(new TextEncoder().encode('WEBP'), 8)
  const avif = new Uint8Array(16)
  avif.set(new TextEncoder().encode('ftyp'), 4)
  avif.set(new TextEncoder().encode('avif'), 8)
  const avis = new Uint8Array(16)
  avis.set(new TextEncoder().encode('ftyp'), 4)
  avis.set(new TextEncoder().encode('avis'), 8)

  assert.equal(sniffImageMime(png), 'image/png')
  assert.equal(sniffImageMime(jpeg), 'image/jpeg')
  assert.equal(sniffImageMime(gif), 'image/gif')
  assert.equal(sniffImageMime(webp), 'image/webp')
  assert.equal(sniffImageMime(avif), 'image/avif')
  assert.equal(sniffImageMime(avis), 'image/avif')
})

test('sniffImageMime：截断/伪装/未知一律 null，不猜', () => {
  assert.equal(sniffImageMime(bytes(0x89, 0x50, 0x4e)), null)
  assert.equal(sniffImageMime(new TextEncoder().encode('<svg xmlns=')), null)
  assert.equal(sniffImageMime(new TextEncoder().encode('hello')), null)
  assert.equal(sniffImageMime(bytes(0x00, 0x00, 0x00)), null)
})

test('sniffImageDims：从字节头读尺寸，不解码（PNG／GIF／JPEG／WebP）', () => {
  // PNG：签名 8 ＋ 长度 4 ＋ 'IHDR' 4 ⇒ 宽高各 4 字节大端
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0)
  png.set(new TextEncoder().encode('IHDR'), 12)
  png.set([0, 0, 0, 96, 0, 0, 0, 60], 16)

  // GIF：'GIF89a' 之后是逻辑屏幕宽高，各 2 字节小端
  const gif = new Uint8Array(10)
  gif.set(new TextEncoder().encode('GIF89a'), 0)
  gif.set([96, 0, 60, 0], 6)

  // JPEG：APP0 段走完之后是 SOF0，宽高在 SOF 的载荷里
  const jpeg = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x3c, 0x00, 0x60)

  // WebP（无损）：'VP8L' ＋ 签名 0x2f ＋ 14 位宽 ＋ 14 位高（各减一）
  const webp = new Uint8Array(25)
  webp.set(new TextEncoder().encode('RIFF'), 0)
  webp.set(new TextEncoder().encode('WEBP'), 8)
  webp.set(new TextEncoder().encode('VP8L'), 12)
  webp.set([0x2f, 0x5f, 0xc0, 0x0e, 0x00], 20)

  assert.deepEqual(sniffImageDims(png), { w: 96, h: 60 })
  assert.deepEqual(sniffImageDims(gif), { w: 96, h: 60 })
  assert.deepEqual(sniffImageDims(jpeg), { w: 96, h: 60 })
  assert.deepEqual(sniffImageDims(webp), { w: 96, h: 60 })
})

test('sniffImageDims：读不出就 null —— 不猜一个宽高比', () => {
  // 截断的 PNG 头（没有 IHDR 的宽高）
  assert.equal(sniffImageDims(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), null)
  // 进了扫描数据还没遇到 SOF 的 JPEG
  assert.equal(sniffImageDims(bytes(0xff, 0xd8, 0xff, 0xda, 0x00, 0x02)), null)
  // AVIF 的 `ispe` 埋在任意深度的 box 里 ⇒ 不猜
  const avif = new Uint8Array(16)
  avif.set(new TextEncoder().encode('ftyp'), 4)
  avif.set(new TextEncoder().encode('avif'), 8)
  assert.equal(sniffImageDims(avif), null)
  assert.equal(sniffImageDims(new TextEncoder().encode('hello')), null)
})

test('sniffImageDims：真样本（种子 PNG）读出它自己的尺寸', () => {
  assert.deepEqual(sniffImageDims(seedAssetBytes()), { w: SEED_ASSET_W, h: SEED_ASSET_H })
})

test('isSupportedImageMime：v1 allowlist 与上限常量', () => {
  assert.ok(isSupportedImageMime('image/png'))
  assert.ok(isSupportedImageMime('image/jpeg'))
  assert.ok(isSupportedImageMime('image/webp'))
  assert.ok(isSupportedImageMime('image/gif'))
  assert.ok(isSupportedImageMime('image/avif'))
  assert.ok(!isSupportedImageMime('image/svg+xml'))
  assert.ok(!isSupportedImageMime('image/heic'))
  assert.ok(!isSupportedImageMime('application/pdf'))
  assert.equal(MAX_IMAGE_BYTES, 25 * 1024 * 1024)
  assert.equal(MAX_IMAGE_PIXELS, 50_000_000)
})

/* ------------------------------------------------------------ 种子样本 */

test('种子样本：hash 就是那份字节的 hash（写错会让默认演示静默变 missing）', async () => {
  assert.equal(await sha256Hex(seedAssetBytes()), SEED_ASSET_HASH)
})

test('种子样本：是合法的 PNG，尺寸与常量一致', () => {
  const b = seedAssetBytes()
  assert.equal(sniffImageMime(b), 'image/png')
  // PNG 的 IHDR：宽高各 4 字节大端，从第 16 字节起（签名 8 ＋ 长度 4 ＋ 'IHDR' 4）
  const be32 = (o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  assert.equal(be32(16), SEED_ASSET_W)
  assert.equal(be32(20), SEED_ASSET_H)
  assert.ok(b.byteLength <= MAX_IMAGE_BYTES)
})

test('种子样本：两个 hash 都是合法地址，且「缺失」那个不等于样本', () => {
  assert.ok(isAssetHash(SEED_ASSET_HASH))
  assert.ok(isAssetHash(MISSING_ASSET_HASH))
  assert.notEqual(MISSING_ASSET_HASH, SEED_ASSET_HASH)
})
