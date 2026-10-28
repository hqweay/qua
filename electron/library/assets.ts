/**
 * 资产库的**文件夹适配器** —— 每个库自己的 `assets/`（内容寻址）。
 *
 * 形状（与 IDB 版同一个端口，调用方零改动）：
 *
 * ```
 * assets/<hash 前 2 位>/<hash>          # 字节，文件名就是 hash
 * assets/<hash 前 2 位>/<hash>.json     # { mime, size, w, h, createdAt }
 * ```
 *
 * 三条纪律：
 *   ① **字节是真相、侧车可重建**：侧车坏了/丢了只影响 mime/尺寸提示，不影响图能不能读；
 *   ② **临时文件 + rename**（不写半截、重复写幂等）；
 *   ③ **`keys()` 只扫一遍目录**：它是「这份 hash 在不在」的同步判据，启动时拉一次。
 *
 * 为什么不用 IDB：库要能「拷目录＝完整备份」。字节住在浏览器数据库里就拷不走，
 * 而 `assets/` 跟着库目录走，图就一起走。
 *
 * ⚠️ 这个文件在主进程里跑（`node:fs`）；渲染层拿到的仍然是 `AssetStorePort` 的形状，
 * 经 IPC 转发 —— 换实现不改调用方。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AssetMeta } from '../../src/core/assets.ts'

export interface AssetStore {
  put(bytes: Uint8Array, mime: string, dims?: { w?: number; h?: number }): Promise<AssetMeta>
  get(hash: string): Promise<Uint8Array | null>
  stat(hash: string): Promise<AssetMeta | null>
  keys(): Promise<string[]>
}

/** hash 的前两位分桶：一个目录里不会堆几万个文件（Finder 与 readdir 都会变慢） */
function bucketOf(hash: string): string {
  return hash.slice(0, 2)
}

function hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function createFolderAssetStore(assetsDir: string): AssetStore {
  /** 启动快照：`keys()` 只扫一次目录，之后由 `put` 增量维护（避免每次渲染都 readdir） */
  let known: Set<string> | null = null

  const pathOf = (hash: string): string => join(assetsDir, bucketOf(hash), hash)
  const metaPathOf = (hash: string): string => `${pathOf(hash)}.json`

  function scan(): Set<string> {
    const out = new Set<string>()
    if (!existsSync(assetsDir)) return out
    for (const bucket of readdirSync(assetsDir)) {
      const dir = join(assetsDir, bucket)
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const n of names) {
        // 只认「文件名就是 32 位以上 hex、且不带 .json」的那些
        if (n.endsWith('.json')) continue
        if (!/^[0-9a-f]{16,}$/.test(n)) continue
        out.add(n)
      }
    }
    return out
  }

  return {
    async put(bytes, mime, dims = {}) {
      const hash = hex(bytes)
      const dest = pathOf(hash)
      mkdirSync(join(assetsDir, bucketOf(hash)), { recursive: true })

      // 幂等：同一份字节第二次入库不重写（内容寻址 ⇒ 同 hash 就是同内容）
      if (!existsSync(dest)) {
        const tmp = `${dest}.tmp-${process.pid}`
        writeFileSync(tmp, bytes)
        renameSync(tmp, dest)
      }

      const meta: AssetMeta = {
        hash,
        mime,
        size: bytes.byteLength,
        ...(dims.w !== undefined ? { w: dims.w } : {}),
        ...(dims.h !== undefined ? { h: dims.h } : {}),
        createdAt: Date.now(),
      }
      // 侧车：字节是真相，这一份是可重建的提示（写失败不影响读图）
      try {
        writeFileSync(metaPathOf(hash), JSON.stringify(meta, null, 2))
      } catch (e) {
        console.warn('[assets] sidecar write failed (bytes are still fine)', e)
      }
      known?.add(hash)
      return meta
    },

    async get(hash) {
      const p = pathOf(hash)
      if (!existsSync(p)) return null
      return new Uint8Array(readFileSync(p))
    },

    async stat(hash) {
      const p = pathOf(hash)
      if (!existsSync(p)) return null
      const size = statSync(p).size
      // 侧车优先（它有 mime 与尺寸）；侧车坏了就按字节推一个最小 meta
      try {
        const raw = JSON.parse(readFileSync(metaPathOf(hash), 'utf8')) as Partial<AssetMeta>
        if (raw && raw.hash === hash && typeof raw.mime === 'string') return raw as AssetMeta
      } catch {
        /* 侧车不是真相 */
      }
      return { hash, mime: 'application/octet-stream', size, createdAt: 0 }
    },

    async keys() {
      known = scan()
      return [...known]
    },
  }
}
