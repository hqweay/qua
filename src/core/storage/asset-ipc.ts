/**
 * 经 IPC 的资产库 —— 字节住在**库目录的 `assets/`**（主进程读写，渲染层只过桥）。
 *
 * 为什么渲染层不自己写文件：renderer 是沙箱页（没有 Node），而「这个窗口的库在哪」
 * 是主进程按 `sender.id` 路由的事实 —— 渲染层手里的库 id 可能过期。所以字节搬运
 * 全在壳那一侧（`electron/library/assets.ts`），这里只把 preload 暴露的两个方法
 * 包成 `AssetStorePort` 的形状。与 IDB 版同一个端口：换实现不改调用方。
 *
 * ## 地址是**拼出来的**，不走 IPC
 *
 * `urlOf` 不需要问主进程：`qua-asset://<hash>` 由壳那边的协议处理器接住。
 * 一次同步的字符串拼接替代了「取字节 → 建对象 URL → 通知重画」的整条链路。
 *
 * ## 信封口径（与内容存储的 `qua:storage/*` 同一家风）
 *
 * 非 `ok` ⇒ **reject**。「库本身打不开」必须让 `loadAssetIndex()` 把整个库标成
 * `unavailable`（用户看到「资产库不可用」，而不是一片假装没有图的空白）。
 */
import { assetUrl, type AssetMeta } from '../assets.ts'
import type { AssetStorePort } from './asset-port.ts'
import { prepareAssetBlob } from './asset-prepare.ts'
import type { LibraryBridge } from './ipc-adapter.ts'

/** 这一层只需要桥上的资产面（`LibraryBridge` 的子集 —— 测试好造瘦桥） */
export type AssetBridge = Pick<LibraryBridge, 'assetIndex' | 'assetPut'>

/** 主进程回信的信封（meta／名单都在 `status:'ok'` 里） */
interface Envelope {
  status?: string
  meta?: unknown
  rows?: unknown
}

function envelope(r: unknown): Envelope {
  return (r && typeof r === 'object' ? r : {}) as Envelope
}

/** 信封里的 meta 只信形状对的：坏形状按「库那边出了问题」处理（reject），不当成功 */
function asMeta(v: unknown): AssetMeta | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (typeof m.hash !== 'string' || typeof m.mime !== 'string' || typeof m.size !== 'number') return null
  return {
    hash: m.hash,
    mime: m.mime,
    size: m.size,
    ...(typeof m.w === 'number' ? { w: m.w } : {}),
    ...(typeof m.h === 'number' ? { h: m.h } : {}),
    createdAt: typeof m.createdAt === 'number' ? m.createdAt : 0,
  }
}

export function createIpcAssetStore(bridge: AssetBridge): AssetStorePort {
  /** 这一侧也留一份元信息：`put` 之前先问它，已经有的字节不必再过一次 IPC。 */
  const known = new Map<string, AssetMeta>()

  return {
    async put(blob: Blob): Promise<AssetMeta> {
      const p = await prepareAssetBlob(blob)
      const existing = known.get(p.hash)
      if (existing) return existing

      const r = envelope(
        await bridge.assetPut(
          p.buffer,
          p.mime,
          p.w !== undefined || p.h !== undefined ? { w: p.w, h: p.h } : undefined,
        ),
      )
      if (r.status !== 'ok') throw new Error(`asset put failed: ${String(r.status ?? 'unknown')}`)
      const meta = asMeta(r.meta)
      if (!meta) throw new Error('asset put reply has no meta')
      /**
       * 两侧各自算 hash（渲染层 WebCrypto，主进程 node:crypto）—— 不一致就是
       * 编码层坏了。此时 run 会指向一个不存在的地址，静默过去就是坏引用，
       * 宁可响：让这一枚入库失败（`missing`），而不是悄悄写错正文。
       */
      if (meta.hash !== p.hash) {
        throw new Error(`asset hash mismatch: renderer=${p.hash} main=${meta.hash}`)
      }
      known.set(meta.hash, meta)
      return meta
    },

    async index(): Promise<AssetMeta[]> {
      const r = envelope(await bridge.assetIndex())
      if (r.status !== 'ok' || !Array.isArray(r.rows)) {
        throw new Error(`asset index failed: ${String(r.status ?? 'unknown')}`)
      }
      const rows: AssetMeta[] = []
      for (const raw of r.rows) {
        const meta = asMeta(raw)
        // 坏行**不 reject 整库**：只是一份资产显示 missing，其余照常
        if (meta) rows.push(meta)
      }
      known.clear()
      for (const m of rows) known.set(m.hash, m)
      return rows
    },

    urlOf(hash: string): string {
      return assetUrl(hash)
    },

    onAddressChange(): () => void {
      // 地址是常量 ⇒ 永远不会「刚准备好」：没有要通知的事
      return () => {}
    },
  }
}
