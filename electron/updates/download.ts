/**
 * 把更新安装包下载到用户看得见的地方（「下载」目录）。
 *
 * ## 为什么是「下载」而不是「后台装好」
 *
 * macOS 的安装那一步由系统组件完成，它判断「新包是不是我发的」只看代码签名；
 * 当前发布形态未签名，装不进去。所以这一步只把安装包送到用户手边：下载完打开它，
 * 最后一步（拖进「应用程序」／点安装器）由用户完成。签名定下来以后，换掉的是
 * `index.ts` 里「下载 → 打开」这一段，`pick.ts` 的版本与通道判据原样不动。
 *
 * ## 校验
 *
 * 字节数必须与 release asset 一致；GitHub 给了 `sha256` 摘要就一并核对。下载先写
 * `.part`，全部通过才改名——中途断网／磁盘满不会留下一个「看起来能用」的坏安装包。
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { net } from 'electron'
import type { UpdateAsset } from './pick.ts'

/** 一次下载的进度（`total` 用 release asset 的字节数，不信响应头） */
export interface DownloadProgress {
  received: number
  total: number
}

export interface DownloadOptions {
  /** 下载到哪个目录（自检注入点用它避开用户真实的「下载」目录） */
  dir: string
  /** 进度回调；调用频率已节流，菜单重建不用自己做第二次 */
  onProgress?: (p: DownloadProgress) => void
  /** 请求头里的身份；GitHub 的资产 CDN 不要求，但别匿名得像爬虫 */
  userAgent: string
}

/** 进度回调的最小间隔：菜单重建跟着它走，不必每读一块就重建一次 */
const PROGRESS_INTERVAL_MS = 300

/** 下载的总时限。150MB 在慢网也能走完；卡死的连接不许把「检查更新」永久占住 */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

/**
 * 下载 `asset` 到 `opts.dir`，返回本地路径。
 *
 * 同名文件已经存在且字节数对得上 ⇒ 直接复用（用户点了「稍后」再点一次不必重下）。
 * 失败时抛错，`.part` 会被清掉；调用方只负责把原因说出来。
 */
export async function downloadUpdate(asset: UpdateAsset, opts: DownloadOptions): Promise<string> {
  const name = basename(asset.name)
  if (!name || name !== asset.name) throw new Error(`bad asset name: ${asset.name}`)

  mkdirSync(opts.dir, { recursive: true })
  const dest = join(opts.dir, name)
  if (existsSync(dest) && statSync(dest).size === asset.size) return dest

  const part = `${dest}.part`
  rmSync(part, { force: true })

  const res = await net.fetch(asset.url, {
    headers: { 'user-agent': opts.userAgent, accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`download responded ${res.status}`)
  if (!res.body) throw new Error('download has no body')

  const hash = createHash('sha256')
  let received = 0
  let lastEmit = 0
  const total = asset.size
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = now
        opts.onProgress?.({ received, total })
      }
      callback(null, chunk)
    },
  })

  try {
    await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), meter, createWriteStream(part))
    opts.onProgress?.({ received, total })
    if (received !== asset.size) throw new Error(`size mismatch: got ${received}, want ${asset.size}`)
    if (asset.digest) {
      const [algo, want] = asset.digest.split(':')
      if (algo === 'sha256' && hash.digest('hex') !== want.toLowerCase()) throw new Error('sha256 mismatch')
    }
    // Windows 上 rename 覆盖已有文件不可靠：先删旧件再改名（旧件的字节数本来就没对上）
    rmSync(dest, { force: true })
    renameSync(part, dest)
    return dest
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
}
