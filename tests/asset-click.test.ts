/**
 * **点一枚资产露面会发生什么**：判据只有一个（`assetClickActionOf`），
 * 块下属性行与行内原子都吃它。这里钉的是三态分派与「按指向分派，不按声明格式」：
 *
 *   · 外态 http(s) ⇒ 链接，交给系统浏览器（它比我们更知道怎么打开）；
 *   · 内态且索引说是图片 ⇒ lightbox（副标题＝尺寸 · 字节 · hash 短码）；
 *   · 其余（内态非图／缺失／库打不开）⇒ 详情，不假装能开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetClickActionOf, formatBytesOf, primeAsset, useAssetStore } from '../src/view/asset-views.ts'
import type { AssetMeta, AssetStorePort } from '../src/core/index.ts'

const meta = (hash: string, mime: string, extra: Partial<AssetMeta> = {}): AssetMeta => ({
  hash,
  mime,
  size: 2048,
  createdAt: 1,
  ...extra,
})

/** 最小端口：只有索引与地址是真的，其余这轮测试用不到 */
function fakePort(): AssetStorePort {
  return {
    put: async () => {
      throw new Error('not used')
    },
    index: async () => [],
    urlOf: (hash) => `asset://${hash}`,
    onAddressChange: () => () => {},
  }
}

const HASH = 'a'.repeat(64)

test('点资产露面：外态链接 ⇒ 交系统浏览器（声明成 image 的外链也是链接）', () => {
  assert.deepEqual(assetClickActionOf('https://example.com/cover.png'), {
    t: 'external',
    url: 'https://example.com/cover.png',
  })
})

test('点资产露面：内态图片 ⇒ lightbox，副标题带尺寸与字节', () => {
  useAssetStore(fakePort())
  primeAsset(meta(HASH, 'image/png', { w: 32, h: 64 }))
  try {
    const a = assetClickActionOf(HASH)
    assert.equal(a.t, 'lightbox')
    if (a.t === 'lightbox') {
      assert.equal(a.url, `asset://${HASH}`)
      assert.ok(a.subtitle.includes('32×64'), '副标题要有尺寸')
      assert.ok(a.subtitle.includes('2.0 KB'), '副标题要有字节')
      assert.ok(a.subtitle.includes(HASH.slice(0, 8)), '副标题要有 hash 短码')
    }
  } finally {
    useAssetStore(null)
  }
})

test('点资产露面：内态非图（文件）与缺失 ⇒ 详情，不假装能开', () => {
  useAssetStore(fakePort())
  primeAsset(meta(HASH, 'application/pdf'))
  try {
    assert.deepEqual(assetClickActionOf(HASH), { t: 'details' }, '内态非图 ⇒ 详情')
    assert.deepEqual(assetClickActionOf('b'.repeat(64)), { t: 'details' }, '索引里没有 ⇒ 详情')
  } finally {
    useAssetStore(null)
  }
})

test('点资产露面：库没装上 ⇒ 全部落详情（不炸）', () => {
  useAssetStore(null)
  assert.deepEqual(assetClickActionOf(HASH), { t: 'details' })
})

test('formatBytesOf：同一份人话，浮层与 lightbox 各处取用都对得上', () => {
  assert.equal(formatBytesOf(512), '512 B')
  assert.equal(formatBytesOf(2048), '2.0 KB')
  assert.equal(formatBytesOf(3 * 1024 * 1024), '3.0 MB')
})
