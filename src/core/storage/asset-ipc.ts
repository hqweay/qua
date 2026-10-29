/**
 * 经 IPC 的资产库 —— 字节住在**库目录的 `assets/`**（主进程读写，渲染层只过桥）。
 *
 * 为什么渲染层不自己写文件：renderer 是沙箱页（没有 Node），而「这个窗口的库在哪」
 * 是主进程按 `sender.id` 路由的事实——渲染层手里的库 id 可能过期。所以字节搬运
 * 全在壳那一侧（`electron/library/assets.ts`），这里只把 preload 暴露的四个方法
 * 包成 `AssetStorePort` 的形状。与 IDB 版同一个端口：换实现不改调用方。
 *
 * 信封口径（与内容存储的 `qua:storage/*` 同一家风）：
 *   · `{status:'missing'}` ⇒ 返回 `null`——「没有这份资产」是状态，不是错误；
 *   · 其余非 `ok`（`no-library`／`bad-args`）⇒ **reject**——「库本身打不开」必须让
 *     `loadAssetKeys()` 把整个库标成 `unavailable`（用户看到「资产库不可用」，
 *     而不是一片假装没有图的空白）。
 */
import type { AssetMeta } from '../assets.ts'
import type { AssetStorePort } from './asset-port.ts'
import { prepareAssetBlob } from './asset-prepare.ts'
import type { LibraryBridge } from './ipc-adapter.ts'

/** 这一层只需要桥上的资产面（`LibraryBridge` 的子集——测试好造瘦桥） */
export type AssetBridge = Pick<LibraryBridge, 'assetKeys' | 'assetGet' | 'assetStat' | 'assetPut'>

/** 主进程回信的信封（字节/名单/meta 都在 `status:'ok'` 里） */
interface Envelope {
  status?: string
  keys?: unknown
  bytes?: unknown
  mime?: unknown
  meta?: unknown
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
  const stat = async (hash: string): Promise<AssetMeta | null> => {
    const r = envelope(await bridge.assetStat(hash))
    if (r.status === 'ok') return asMeta(r.meta)
    if (r.status === 'missing') return null
    throw new Error(`asset stat failed: ${String(r.status ?? 'unknown')}`)
  }

  return {
    async put(blob: Blob): Promise<AssetMeta> {
      const p = await prepareAssetBlob(blob)
      /**
       * 先问一次 stat：已在库里的字节不再经 IPC 搬第二遍（这条上的是**整份字节**，
       * 重复传是它最贵的失败模式）。stat 失败不拦 put——能不能写进去由 put 自己回答。
       */
      const existing = await stat(p.hash).catch(() => null)
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
       * 两侧各自算 hash（渲染层 WebCrypto，主进程 node:crypto）——不一致就是
       * 编码层坏了。此时 run 会指向一个不存在的地址，静默过去就是坏引用，
       * 宁可响：让这一枚入库失败（`missing`），而不是悄悄写错正文。
       */
      if (meta.hash !== p.hash) {
        throw new Error(`asset hash mismatch: renderer=${p.hash} main=${meta.hash}`)
      }
      return meta
    },

    async get(hash: string): Promise<Blob | null> {
      const r = envelope(await bridge.assetGet(hash))
      if (r.status === 'missing') return null
      if (r.status !== 'ok' || !(r.bytes instanceof ArrayBuffer)) {
        throw new Error(`asset get failed: ${String(r.status ?? 'unknown')}`)
      }
      return new Blob([r.bytes], { type: typeof r.mime === 'string' ? r.mime : 'application/octet-stream' })
    },

    stat,

    async keys(): Promise<string[]> {
      const r = envelope(await bridge.assetKeys())
      if (r.status !== 'ok' || !Array.isArray(r.keys)) {
        throw new Error(`asset keys failed: ${String(r.status ?? 'unknown')}`)
      }
      return r.keys.filter((k): k is string => typeof k === 'string')
    },
  }
}
