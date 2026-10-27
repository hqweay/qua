/**
 * IndexedDB 资产库 —— 原型期的 `AssetStorePort` 实现。
 *
 * 为什么不是 localStorage：图片是二进制，base64 会多 33% 且很快撞 5MB 配额；
 * IDB 原生能存二进制，配额也大得多。字节仍然**不进正文**，正文只存 hash。
 *
 * ⚠️ 库名 `qua.assets` 是**不可逆契约**：换名等于已有资产静默消失。
 *    与 `qua.workspace` 同级对待，arch 断言会钉住。
 *
 * ⚠️ 这是**过渡实现**：将来的工作区目录会有 `assets/<hash前2位>/<hash>` ＋ 侧车，
 *    端口不变，换适配器即可；调用方不要 import 本文件。
 *
 * ⚠️ **记录里存 `ArrayBuffer`，不存 `Blob`**：两者结构化克隆都能过，但 `Blob`
 *    在「把存储快照出来再放回去」的链路上会掉成空对象（验收脚本的存储快照就是这条路），
 *    于是一次「关掉重开」之后每张图都读不出字节 —— 表现为「图全丢了」，而库里 key 还在。
 *    `ArrayBuffer` 两个方向都原样往返；`get()` 再按 mime 包回 `Blob` 交给渲染层。
 */
import type { AssetMeta } from '../assets.ts'
import { MAX_IMAGE_PIXELS, sha256Hex, sniffImageMime } from '../assets.ts'
import type { AssetStorePort } from './asset-port.ts'

const DB_NAME = 'qua.assets'
/**
 * v2：记录里的字节从 `Blob` 改成 `ArrayBuffer`（见文件头最后一条）。
 * 旧记录新代码读不出字节 ⇒ **显式作废**（删库重建），不写迁移 —— 原型不做迁移。
 */
const DB_VERSION = 2
const STORE = 'assets'

interface AssetRecord extends AssetMeta {
  /** 原始字节；**不是 Blob**（理由见文件头） */
  bytes: ArrayBuffer
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest
    try {
      r = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      reject(e)
      return
    }
    r.onupgradeneeded = () => {
      const db = r.result
      // 旧版本的记录形状（Blob）新代码不读 ⇒ 整库作废重建（原型纪律：升版清库，不写迁移）
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE)
      db.createObjectStore(STORE, { keyPath: 'hash' })
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    // 另一个标签页/窗口正拿着旧版本：不替它悄悄升级，明确失败。
    r.onblocked = () => reject(new Error('asset database is blocked by another window'))
  })
}

/** 记录 → 对外元信息（不带 bytes；避免调用方误把载荷当元数据传回去）。 */
function toMeta(rec: AssetRecord): AssetMeta {
  return {
    hash: rec.hash,
    mime: rec.mime,
    size: rec.size,
    ...(rec.w !== undefined ? { w: rec.w } : {}),
    ...(rec.h !== undefined ? { h: rec.h } : {}),
    createdAt: rec.createdAt,
  }
}

/**
 * 读一张图的显示尺寸（EXIF 方向已校正）。
 *
 * 非图片/解码失败返回 `undefined`：尺寸只是布局提示，不是入库的前提；
 * 真正的类型判断由 `sniffImageMime` 做，渲染由 `<img>` 自己失败。
 */
async function imageSize(blob: Blob): Promise<{ w: number; h: number } | undefined> {
  if (typeof createImageBitmap !== 'function') return undefined
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' })
    const out = { w: bmp.width, h: bmp.height }
    bmp.close()
    return out
  } catch {
    return undefined
  }
}

export function createIdbAssetStore(): AssetStorePort {
  let dbp: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => (dbp ??= openDb())

  const stat = async (hash: string): Promise<AssetMeta | null> => {
    const d = await db()
    const tx = d.transaction(STORE, 'readonly')
    const rec = await req<AssetRecord | undefined>(tx.objectStore(STORE).get(hash))
    return rec ? toMeta(rec) : null
  }

  return {
    async put(blob: Blob): Promise<AssetMeta> {
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      const hash = await sha256Hex(bytes)
      const old = await stat(hash)
      if (old) return old

      const sniffed = sniffImageMime(bytes)
      const mime = sniffed ?? (blob.type || 'application/octet-stream')
      let w: number | undefined
      let h: number | undefined
      if (sniffed) {
        const size = await imageSize(blob)
        // 像素炸弹：字节不大但解码会吃内存；宁可拒绝，不给渲染器埋雷。
        if (size && size.w * size.h > MAX_IMAGE_PIXELS) {
          throw new Error(`image is too large to decode: ${size.w}x${size.h}`)
        }
        w = size?.w
        h = size?.h
      }
      const rec: AssetRecord = {
        hash,
        mime,
        size: bytes.byteLength,
        ...(w !== undefined ? { w } : {}),
        ...(h !== undefined ? { h } : {}),
        createdAt: Date.now(),
        bytes: buf,
      }
      const d = await db()
      const tx = d.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(rec)
      await txDone(tx)
      return toMeta(rec)
    },

    async get(hash: string): Promise<Blob | null> {
      const d = await db()
      const tx = d.transaction(STORE, 'readonly')
      const rec = await req<AssetRecord | undefined>(tx.objectStore(STORE).get(hash))
      if (!rec) return null
      /**
       * 字节读出来不是 `ArrayBuffer` ⇒ 这条记录坏了（旧形状/被外力改过）。
       * 返回 `null` 而不是抛错：**一份坏记录不该让整个资产库变成「不可用」**，
       * 那一份显示 `missing` 就够了，其余图照常。
       */
      if (!(rec.bytes instanceof ArrayBuffer)) return null
      return new Blob([rec.bytes], { type: rec.mime })
    },

    stat,

    async keys(): Promise<string[]> {
      const d = await db()
      const tx = d.transaction(STORE, 'readonly')
      const keys = await req<IDBValidKey[]>(tx.objectStore(STORE).getAllKeys())
      return keys.filter((k): k is string => typeof k === 'string')
    },
  }
}
