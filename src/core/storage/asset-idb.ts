/**
 * IndexedDB 资产库 —— **浏览器端**的 `AssetStorePort` 实现。
 *
 * 为什么不是 localStorage：图片是二进制，base64 会多 33% 且很快撞 5MB 配额；
 * IDB 原生能存二进制，配额也大得多。字节仍然**不进正文**，正文只存 hash。
 *
 * ## 两个 store：索引与字节分家（与桌面版同一条口径）
 *
 * 桌面版是「`qua.db` 一行元信息 ＋ `assets/<hash>.<ext>` 一份字节」。浏览器没有库目录，
 * 但**分家这件事本身**是口径：`index()` 只读元信息那一半，不把全库字节拉进内存。
 *
 * ## 地址的生命周期住在这里
 *
 * 浏览器没有自定义协议，地址只能是 `blob:` —— 而对象 URL 是要还的。既然
 * 「谁创建谁回收」是唯一可靠的纪律，创建与回收就都放进本文件：
 * 渲染层拿到的只是一个字符串，它没有能力（也没有责任）去泄漏。
 *
 * ⚠️ 库名 `qua.assets` 是**不可逆契约**：换名等于已有资产静默消失。
 *    与 `qua.workspace` 同级对待，arch 断言会钉住。
 *
 * ⚠️ **记录里存 `ArrayBuffer`，不存 `Blob`**：两者结构化克隆都能过，但 `Blob`
 *    在「把存储快照出来再放回去」的链路上会掉成空对象（验收脚本的存储快照就是这条路），
 *    于是一次「关掉重开」之后每张图都读不出字节 —— 表现为「图全丢了」，而库里 key 还在。
 *    `ArrayBuffer` 两个方向都原样往返；`urlOf()` 再按 mime 包回 `Blob` 建地址。
 */
import type { AssetMeta } from '../assets.ts'
import { prepareAssetBlob } from './asset-prepare.ts'
import type { AssetStorePort } from './asset-port.ts'

const DB_NAME = 'qua.assets'
/**
 * v3：**元信息与字节拆成两个 store**（v2 把两者塞进同一条记录 ⇒ 拿索引就得把所有字节
 * 读进内存）。旧记录新代码不读 ⇒ 显式作废（删库重建），不写迁移 —— 原型不做迁移。
 */
const DB_VERSION = 3
const META = 'meta'
const BYTES = 'bytes'

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
      // 旧版本的记录形状新代码不读 ⇒ 整库作废重建（原型纪律：升版清库，不写迁移）
      for (const name of [META, BYTES]) if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
      db.createObjectStore(META, { keyPath: 'hash' })
      db.createObjectStore(BYTES)
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    // 另一个标签页/窗口正拿着旧版本：不替它悄悄升级，明确失败。
    r.onblocked = () => reject(new Error('asset database is blocked by another window'))
  })
}

/** 记录 → 对外元信息（不带 bytes；避免调用方误把载荷当元数据传回去）。 */
function toMeta(rec: AssetMeta): AssetMeta {
  return {
    hash: rec.hash,
    mime: rec.mime,
    size: rec.size,
    ...(rec.w !== undefined ? { w: rec.w } : {}),
    ...(rec.h !== undefined ? { h: rec.h } : {}),
    createdAt: rec.createdAt,
  }
}

/*
 * 读一张图的显示尺寸、嗅探类型、算 hash、挡像素炸弹——**判据只有一份**，
 * 住在 `asset-prepare.ts`（IDB 与 IPC 两个适配器共用，见那边的文件头）。
 */

export function createIdbAssetStore(): AssetStorePort {
  let dbp: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => (dbp ??= openDb())

  /** hash → 对象 URL。**唯一创建处**，也是唯一回收处（见文件头）。 */
  const urls = new Map<string, string>()
  /** 正在取字节的 hash：同一份被多行引用时只发一次请求 */
  const inflight = new Set<string>()
  const listeners = new Set<(hash: string) => void>()

  const notify = (hash: string): void => {
    for (const fn of listeners) fn(hash)
  }

  /** 取字节 → 建地址 → 通知。重复调用是幂等的（`inflight` 挡住并发）。 */
  const ensureUrl = (hash: string): void => {
    if (urls.has(hash) || inflight.has(hash)) return
    inflight.add(hash)
    void (async () => {
      try {
        const d = await db()
        const tx = d.transaction(BYTES, 'readonly')
        const rec = await req<ArrayBuffer | undefined>(tx.objectStore(BYTES).get(hash))
        /**
         * 字节读出来不是 `ArrayBuffer` ⇒ 这条记录坏了（旧形状/被外力改过）。
         * 不建地址、不抛错：**一份坏记录不该让整个资产库变成「不可用」**，
         * 那一份显示 `missing` 就够了，其余图照常。
         */
        if (rec instanceof ArrayBuffer && !urls.has(hash)) urls.set(hash, URL.createObjectURL(new Blob([rec])))
      } catch {
        /* 取不到就是取不到：`urlOf` 继续返回空串，视图停在 chip 上 */
      } finally {
        inflight.delete(hash)
        notify(hash)
      }
    })()
  }

  return {
    async put(blob: Blob): Promise<AssetMeta> {
      const p = await prepareAssetBlob(blob)
      const d = await db()
      const read = d.transaction(META, 'readonly')
      const old = await req<AssetMeta | undefined>(read.objectStore(META).get(p.hash))
      if (old) return toMeta(old)

      const meta: AssetMeta = {
        hash: p.hash,
        mime: p.mime,
        size: p.bytes.byteLength,
        ...(p.w !== undefined ? { w: p.w } : {}),
        ...(p.h !== undefined ? { h: p.h } : {}),
        createdAt: Date.now(),
      }
      // 元信息与字节**同一个事务**：要么两半都有，要么都没有（不存在「行指了指不存在的字节」）
      const tx = d.transaction([META, BYTES], 'readwrite')
      tx.objectStore(META).put(meta)
      tx.objectStore(BYTES).put(p.buffer, p.hash)
      await txDone(tx)
      return meta
    },

    async index(): Promise<AssetMeta[]> {
      const d = await db()
      const tx = d.transaction(META, 'readonly')
      const rows = await req<AssetMeta[]>(tx.objectStore(META).getAll())
      return rows.map(toMeta)
    },

    urlOf(hash: string): string {
      const url = urls.get(hash)
      // 没有就排一次取字节：首帧画 chip、地址到了再重画这一行（见文件头）
      if (!url) ensureUrl(hash)
      return url ?? ''
    },

    onAddressChange(fn: (hash: string) => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}
