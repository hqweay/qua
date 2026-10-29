/**
 * IPC 资产适配器（渲染层）—— 信封解包、去重、hash 对账、失败的三种脸。
 *
 * 判据：
 *   ① `missing` 是状态（`null`），库打不开是错误（reject）——两种失败不能压成一个
 *      （压成一个的话，整库 `unavailable` 会退化成每张图各说一次「缺失」）；
 *   ② `put` 先问一次 stat：已在库里的字节不再经 IPC 搬第二遍（这条搬的是整份字节）；
 *   ③ 两侧各自算 hash，不一致必须 reject——此时 run 会指向不存在的地址，
 *      静默过去就是坏引用；
 *   ④ 字节过桥原样往返（`ArrayBuffer` 进、`Blob` 出，内容与 mime 不走样）。
 *
 * 跑在 Node：`crypto.subtle` 是全局的（与渲染层同一条 WebCrypto），
 * `createImageBitmap` 不在 ⇒ 尺寸为 `undefined`，判据不依赖它。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcAssetStore, type AssetBridge } from '../../src/core/storage/asset-ipc.ts'
import { SEED_ASSET_HASH, seedAssetBytes } from '../../src/core/fixtures/assets.ts'

const sha256Hex = async (buf: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(buf))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * 「主进程形状」的假桥：内存 map 当 `assets/`，信封与真壳同款。
 * `hashOverride` 用来模拟「主进程算出的地址与渲染层不一致」（判据 ③）。
 */
function fakeBridge(opts: { hashOverride?: string } = {}): {
  bridge: AssetBridge
  files: Map<string, ArrayBuffer>
  puts: { byteLength: number; mime: string; dims: { w?: number; h?: number } }[]
} {
  const files = new Map<string, ArrayBuffer>()
  const puts: { byteLength: number; mime: string; dims: { w?: number; h?: number } }[] = []
  const bridge: AssetBridge = {
    assetKeys: async () => ({ status: 'ok', keys: [...files.keys()] }),
    assetGet: async (hash: string) => {
      const bytes = files.get(hash)
      return bytes ? { status: 'ok', bytes, mime: 'image/png' } : { status: 'missing' }
    },
    assetStat: async (hash: string) =>
      files.has(hash)
        ? { status: 'ok', meta: { hash, mime: 'image/png', size: files.get(hash)!.byteLength, createdAt: 1 } }
        : { status: 'missing' },
    assetPut: async (bytes: ArrayBuffer, mime: string, dims?: { w?: number; h?: number }) => {
      puts.push({ byteLength: bytes.byteLength, mime, dims: dims ?? {} })
      const hash = opts.hashOverride ?? (await sha256Hex(bytes))
      files.set(hash, bytes)
      return { status: 'ok', meta: { hash, mime, size: bytes.byteLength, createdAt: 1 } }
    },
  }
  return { bridge, files, puts }
}

/** 打不开的桥：所有方法都回 `no-library`（窗口没挂上库的样子） */
const deadBridge: AssetBridge = {
  assetKeys: async () => ({ status: 'no-library' }),
  assetGet: async () => ({ status: 'no-library' }),
  assetStat: async () => ({ status: 'no-library' }),
  assetPut: async () => ({ status: 'no-library' }),
}

test('put：真字节过桥——hash 对上、字节与 mime 原样到达、meta 形状完整', async () => {
  const { bridge, files, puts } = fakeBridge()
  const meta = await createIpcAssetStore(bridge).put(new Blob([seedAssetBytes()], { type: 'image/png' }))

  assert.equal(meta.hash, SEED_ASSET_HASH, '渲染层算出的 hash 应等于种子的内容地址')
  assert.equal(meta.mime, 'image/png')
  assert.equal(meta.size, seedAssetBytes().byteLength)
  assert.equal(puts.length, 1, '应恰好搬一次字节')
  assert.equal(puts[0].byteLength, seedAssetBytes().byteLength)
  assert.equal(puts[0].mime, 'image/png', '嗅探出的 MIME 应随字节一起过桥（侧车按它写）')
  assert.deepEqual(
    new Uint8Array(files.get(SEED_ASSET_HASH)!),
    seedAssetBytes(),
    '主进程收到的字节应与渲染层发出的逐字节相同',
  )
})

test('put：同一份字节第二次入库不再过桥（stat 命中就短路）', async () => {
  const { bridge, puts } = fakeBridge()
  const store = createIpcAssetStore(bridge)
  const first = await store.put(new Blob([seedAssetBytes()], { type: 'image/png' }))
  const second = await store.put(new Blob([seedAssetBytes()], { type: 'image/png' }))

  assert.equal(second.hash, first.hash)
  assert.equal(puts.length, 1, '第二次入库不应再搬整份字节')
})

test('put：主进程算出的 hash 与渲染层不一致 ⇒ reject（不产坏引用）', async () => {
  const { bridge } = fakeBridge({ hashOverride: 'f'.repeat(64) })
  await assert.rejects(
    createIpcAssetStore(bridge).put(new Blob([seedAssetBytes()], { type: 'image/png' })),
    /hash mismatch/,
  )
})

test('get：ok ⇒ Blob（字节与 mime 原样回来）；missing ⇒ null', async () => {
  const { bridge } = fakeBridge()
  const store = createIpcAssetStore(bridge)
  await store.put(new Blob([seedAssetBytes()], { type: 'image/png' }))

  const blob = await store.get(SEED_ASSET_HASH)
  assert.ok(blob instanceof Blob)
  assert.equal(blob.type, 'image/png', 'Blob 的 MIME 应来自信封（对象 URL 的 Content-Type）')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), seedAssetBytes())

  assert.equal(await store.get('0'.repeat(64)), null, '没有这份资产是 null，不是错误')
})

test('stat / keys：ok 给名单与元信息，missing 给 null', async () => {
  const { bridge } = fakeBridge()
  const store = createIpcAssetStore(bridge)
  await store.put(new Blob([seedAssetBytes()], { type: 'image/png' }))

  assert.equal(await store.stat('0'.repeat(64)), null)
  const meta = await store.stat(SEED_ASSET_HASH)
  assert.ok(meta && meta.hash === SEED_ASSET_HASH && meta.mime === 'image/png')
  assert.deepEqual(await store.keys(), [SEED_ASSET_HASH])
})

test('库打不开（no-library）⇒ 所有方法 reject——这是 unavailable 的路，不是「没有资产」', async () => {
  const store = createIpcAssetStore(deadBridge)
  await assert.rejects(store.keys())
  await assert.rejects(store.get(SEED_ASSET_HASH))
  await assert.rejects(store.stat(SEED_ASSET_HASH))
  await assert.rejects(store.put(new Blob([seedAssetBytes()], { type: 'image/png' })))
})
