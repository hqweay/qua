/**
 * IPC 资产适配器（渲染层）—— 信封解包、去重、hash 对账、失败的三种脸。
 *
 * 判据：
 *   ① `index` 读不出来是错误（reject）——「不知道有哪些资产」和「没有资产」不是一件事；
 *      压成一个的话，整库 `unavailable` 会退化成每张图各说一次「缺失」；
 *   ② `put` 先问**索引**：已在库里的字节不再经 IPC 搬第二遍（这条搬的是整份字节）；
 *   ③ 两侧各自算 hash，不一致必须 reject——此时 run 会指向不存在的地址，
 *      静默过去就是坏引用；
 *   ④ 地址是**拼出来的**（`qua-asset://<hash>`），不走 IPC：桌面版没有对象 URL 生命周期；
 *   ⑤ 坏行只让**那一份**资产缺失，不许把整库判成「打不开」。
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
    assetIndex: async () => ({
      status: 'ok',
      rows: [...files.keys()].map((hash) => ({
        hash,
        mime: 'image/png',
        size: files.get(hash)!.byteLength,
        createdAt: 1,
      })),
    }),
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
  assetIndex: async () => ({ status: 'no-library' }),
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
  assert.equal(puts[0].mime, 'image/png', '嗅探出的 MIME 应随字节一起过桥（索引按它记类型）')
  assert.deepEqual(
    new Uint8Array(files.get(SEED_ASSET_HASH)!),
    seedAssetBytes(),
    '主进程收到的字节应与渲染层发出的逐字节相同',
  )
})

test('put：索引里已有这份字节 ⇒ 不再过桥（去重靠索引，不靠一次往返）', async () => {
  const { bridge, puts } = fakeBridge()
  const store = createIpcAssetStore(bridge)
  // 先装一次索引：库里已经有这份种子字节
  await store.put(new Blob([seedAssetBytes()], { type: 'image/png' }))
  assert.equal(puts.length, 1)

  const again = createIpcAssetStore(bridge)
  await again.index()
  const second = await again.put(new Blob([seedAssetBytes()], { type: 'image/png' }))
  assert.equal(second.hash, SEED_ASSET_HASH)
  assert.equal(puts.length, 1, '第二次入库不应再搬整份字节')
})

test('put：主进程算出的 hash 与渲染层不一致 ⇒ reject（不产坏引用）', async () => {
  const { bridge } = fakeBridge({ hashOverride: 'f'.repeat(64) })
  await assert.rejects(
    createIpcAssetStore(bridge).put(new Blob([seedAssetBytes()], { type: 'image/png' })),
    /hash mismatch/,
  )
})

test('index：ok ⇒ 行集；形状坏的行只丢那一行，不 reject 整库', async () => {
  const bridge: AssetBridge = {
    assetIndex: async () => ({
      status: 'ok',
      rows: [
        { hash: 'a'.repeat(64), mime: 'image/png', size: 1, createdAt: 1 },
        { hash: 42, mime: 'image/png', size: 1, createdAt: 1 },
        null,
      ],
    }),
    assetPut: async () => ({ status: 'bad-args' }),
  }
  const rows = await createIpcAssetStore(bridge).index()
  assert.equal(rows.length, 1, '只有形状对的那一行进来')
  assert.equal(rows[0].hash, 'a'.repeat(64))
})

test('urlOf：地址是拼出来的常量（`qua-asset://<hash>`），没有要等的东西', () => {
  const store = createIpcAssetStore(fakeBridge().bridge)
  assert.equal(store.urlOf(SEED_ASSET_HASH), `qua-asset://${SEED_ASSET_HASH}`)
  const off = store.onAddressChange(() => {
    throw new Error('桌面版的地址是常量，不该有「刚准备好」的时候')
  })
  off()
})

test('库打不开（no-library）⇒ index/put reject——这是 unavailable 的路，不是「没有资产」', async () => {
  const store = createIpcAssetStore(deadBridge)
  await assert.rejects(store.index())
  await assert.rejects(store.put(new Blob([seedAssetBytes()], { type: 'image/png' })))
})
