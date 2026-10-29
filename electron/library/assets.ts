/**
 * 资产库的**文件夹适配器** —— 每个库自己的 `assets/`（内容寻址）。
 *
 * ## 形状
 *
 * ```
 * qua.db                          # 一行元信息：assets(hash PK, mime, size, w, h, added_at)
 * assets/<hash 前 2 位>/<hash>.<ext>   # 字节；文件名是地址，后缀是类型的人话投影
 * ```
 *
 * **一个资产 ＝ 一行 ＋ 一个文件。** 没有侧车（上一版每个文件旁边还有一份 `.json`）。
 *
 * ## 为什么这么分
 *
 * - **字节在文件系统**：库是按目录同步／备份的（`~/Documents/Qua/repos/<id>/`）。
 *   几百 MB 图片塞进一个 SQLite 文件，会让每一次同步都退化成整文件冲突。
 * - **元信息在 DB**：`mime/size/w/h` 是这一份字节的属性，读者只有正文，而正文就在
 *   同一个库里 ⇒ 它们该和正文住同一个事务，而不是旁边一个没人管的文件。
 *   （侧车真正维护的是「DB 丢了但字节还在」这个组合 —— 可那时正文也没了，
 *   没人会引用这份元信息。它在维护一份注定没人读的东西。）
 * - **后缀只写不读**：Finder 能预览、能双击、能拖给别的 app。类型只有一处真相 ——
 *   入库时从字节嗅出来的 `mime`（见 `core/assets.ts` 的 `extOf`）。
 *
 * ## 三条不变量
 *
 *   ① **字节只增**：先写文件（临时名 + rename），**再**写行。
 *   ② **行必有文件**：崩溃只可能落在两者之间 ⇒ 只会多出孤儿文件。
 *   ③ **文件可不必然有行**：用户往 `assets/` 里丢东西、回滚一次 DB，都只影响孤儿数量。
 *
 * ②＋③ 推出一个很硬的性质：**DB 回滚不会产生坏引用**（文件只增 ⇒ 任何一行指向的文件
 * 一定还在）。每种失败都退化成无害的那一侧。
 *
 * ## `reindex()` 是「外人给的字节」的唯一入口
 *
 * 导入、修复、旧库迁移三件事是同一个动作：**从目录重建索引**。它与正常路径方向相反
 * （行 → 路径 / 路径 → 行），共享的只有 hash 算法。正常启动**不**扫目录。
 *
 * ⚠️ 这个文件在主进程里跑（`node:fs`）；渲染层拿到的仍然是 `AssetStorePort` 的形状，
 * 经 IPC 转发 —— 换实现不改调用方。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extOf, sniffImageMime, type AssetMeta } from '../../src/core/assets.ts'
import { DB_TABLES } from '../../src/core/library.ts'
import type { Db } from './sqlite.ts'

export interface AssetStore {
  put(bytes: Uint8Array, mime: string, dims?: { w?: number; h?: number }): Promise<AssetMeta>
  /** 全库元信息（随库装载一次；**不读字节**） */
  rows(): AssetMeta[]
  /** 协议处理器用：hash → 文件路径与类型；没有这一行 ⇒ `null` */
  locate(hash: string): { path: string; mime: string } | null
  /** 从目录重建索引（导入 / 修复 / 旧库迁移） */
  reindex(): { rows: number; renamed: number }
}

/** hash 的前两位分桶：一个目录里不会堆几万个文件（Finder 与 readdir 都会变慢） */
function bucketOf(hash: string): string {
  return hash.slice(0, 2)
}

function hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface AssetRow {
  hash: string
  mime: string
  size: number
  w: number | null
  h: number | null
  added_at: number
}

function rowToMeta(r: AssetRow): AssetMeta {
  return {
    hash: r.hash,
    mime: r.mime,
    size: r.size,
    ...(r.w !== null ? { w: r.w } : {}),
    ...(r.h !== null ? { h: r.h } : {}),
    createdAt: r.added_at,
  }
}

export function createFolderAssetStore(db: Db, assetsDir: string): AssetStore {
  /** 内存索引：hash → 元信息。启动时一次读完（行数 = 资产数，不是字节数）。 */
  const metas = new Map<string, AssetMeta>()

  const hydrate = (): void => {
    metas.clear()
    const rows = db
      .prepare(`select hash, mime, size, w, h, added_at from ${DB_TABLES.assets}`)
      .all() as unknown as AssetRow[]
    for (const r of rows) metas.set(r.hash, rowToMeta(r))
  }
  hydrate()

  /** 路径**只在这里构造**：`(hash, mime)` 的纯函数。外面一律拿 hash 问。 */
  const pathOf = (hash: string, mime: string): string =>
    join(assetsDir, bucketOf(hash), `${hash}.${extOf(mime)}`)

  const insert = (m: AssetMeta): void => {
    db.prepare(
      `insert into ${DB_TABLES.assets} (hash, mime, size, w, h, added_at) values (?, ?, ?, ?, ?, ?)
       on conflict(hash) do nothing`,
    ).run(m.hash, m.mime, m.size, m.w ?? null, m.h ?? null, m.createdAt)
  }

  return {
    async put(bytes, mime, dims = {}) {
      const hash = hex(bytes)
      const meta: AssetMeta = {
        hash,
        mime,
        size: bytes.byteLength,
        ...(dims.w !== undefined ? { w: dims.w } : {}),
        ...(dims.h !== undefined ? { h: dims.h } : {}),
        createdAt: Date.now(),
      }

      // ① 字节先落（幂等：同一份字节第二次入库不重写）
      const dest = pathOf(hash, mime)
      mkdirSync(join(assetsDir, bucketOf(hash)), { recursive: true })
      if (!existsSync(dest)) {
        const tmp = `${dest}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
        writeFileSync(tmp, bytes)
        renameSync(tmp, dest)
      }

      // ② 行才说话（已有同 hash 的行 ⇒ 保留它的 `added_at`：入库时刻是第一次）
      insert(meta)
      const kept = metas.get(hash) ?? meta
      metas.set(hash, kept)
      return kept
    },

    rows() {
      return [...metas.values()]
    },

    locate(hash) {
      const m = metas.get(hash)
      if (!m) return null
      return { path: pathOf(hash, m.mime), mime: m.mime }
    },

    reindex() {
      if (!existsSync(assetsDir)) return { rows: 0, renamed: 0 }
      let inserted = 0
      let renamed = 0
      for (const bucket of readdirSync(assetsDir)) {
        // 只认两字符的 hex 桶；`未命名文件夹` / `.DS_Store` 这类是外人的东西，不参与
        if (!/^[0-9a-f]{2}$/.test(bucket)) continue
        const bucketDir = join(assetsDir, bucket)
        let names: string[]
        try {
          names = readdirSync(bucketDir)
        } catch {
          continue
        }
        for (const name of names) {
          const m = /^([0-9a-f]{64})(?:\.([a-z0-9]{1,8}))?$/.exec(name)
          if (!m) continue
          const hash = m[1]
          const file = join(bucketDir, name)
          let bytes: Uint8Array
          try {
            bytes = new Uint8Array(readFileSync(file))
          } catch {
            continue
          }
          /**
           * **名字与内容对不上就不是我们的文件**：内容寻址的意义就在于这一点可校验。
           * 改过名的、被别的工具写过的东西一律不收（宁可它显示 missing，也不要
           * 让一个错地址进索引 —— 那会变成「图显示成别人」的静默事故）。
           */
          if (hex(bytes) !== hash) {
            console.warn(`[assets] skip ${name}: content does not match its name`)
            continue
          }
          const mime = sniffImageMime(bytes) ?? 'application/octet-stream'
          // 旧版文件名没有后缀：就地补上（这是那次形状变化的唯一一次动作）
          const want = `${hash}.${extOf(mime)}`
          if (name !== want) {
            try {
              renameSync(file, join(bucketDir, want))
              renamed++
            } catch (e) {
              console.warn('[assets] rename to add extension failed', e)
            }
          }
          const mtime = (() => {
            try {
              return Math.round(statSync(file).mtimeMs) || Date.now()
            } catch {
              return Date.now()
            }
          })()
          if (!metas.has(hash)) {
            insert({ hash, mime, size: bytes.byteLength, createdAt: mtime })
            inserted++
          }
        }
      }
      hydrate()
      return { rows: inserted, renamed }
    },
  }
}
