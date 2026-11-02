/**
 * 资产对象的纯函数层（零 DOM、零存储）。
 *
 * 资产不是正文实体：正文里只存一个内容 hash，字节住在资产库。这里只回答
 * 「这份字节的地址是什么、它是什么类型、它是否在允许入图片的范围内」——
 * 不碰 IndexedDB／文件系统，也不做渲染。
 *
 * 为什么 hash 要用内容算：同一张图贴两次应该只有一份字节；地址由内容决定，
 * 去重、校验、跨设备复制都不需要额外的 id 映射。
 */

/** 资产对象的内容元信息；字节本身由资产库持有。 */
export interface AssetMeta {
  /** SHA-256(原始字节) 的小写 hex */
  hash: string
  mime: string
  /** 字节数 */
  size: number
  /** 视觉媒体的显示宽（EXIF 已校正）；非视觉媒体没有这一格 */
  w?: number
  /** 视觉媒体的显示高 */
  h?: number
  /** 入库时刻（墙钟毫秒，仅用于诊断/GC，不参与内容身份） */
  createdAt: number
}

/**
 * 行内资产在**此刻**看到的样子。
 *
 * `state` 是派生值，不落盘：`missing` 是「库里没有这份 hash」，`unavailable`
 * 是「资产库本身打不开」——两者给用户的建议不同，不能压成一个。
 */
export interface AssetView {
  state: 'ready' | 'missing' | 'unavailable'
  mime?: string
  /** 已解析的对象 URL；缺失/不可用时没有 */
  url?: string
  w?: number
  h?: number
}

/** 图片入库上限：挡住误贴的超大文件，不拿内存和配额赌博。 */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** 解码后的像素上限：压缩炸弹的字节可能很小，但解码会吃内存。 */
export const MAX_IMAGE_PIXELS = 50_000_000

/** v1 只开这些图片类型；SVG/HEIC 等明确拒绝，不静默降级成文件图标。 */
export const IMAGE_MIME_ALLOWLIST = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/avif',
] as const

export type ImageMime = (typeof IMAGE_MIME_ALLOWLIST)[number]

export function isSupportedImageMime(mime: string): mime is ImageMime {
  return (IMAGE_MIME_ALLOWLIST as readonly string[]).includes(mime)
}

/** 64 位小写 hex：内容寻址地址的形状。 */
export function isAssetHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/**
 * 桌面版把字节交给渲染层的**协议名**（壳注册、渲染层拼地址）。
 *
 * 为什么是一条自定义协议而不是 IPC／对象 URL：`<img src>` 需要一个**同步可写**的地址，
 * 而主进程恰好有能力把这个地址映射到一份文件。给了地址，渲染层就不必再管
 * 「取字节 → 建 URL → 什么时候回收」那套生命周期 —— 那套东西漏一次就是内存泄漏。
 */
export const ASSET_SCHEME = 'qua-asset'

/**
 * 一份资产在桌面版的地址。
 *
 * ⚠️ **地址里不含库 id**：内容寻址 ⇒ 同一个 hash 在哪个库里都是同一份字节。
 *    「这是哪个库的」不是这个地址需要回答的问题，让它多带一格只会多一处能错的地方。
 */
export function assetUrl(hash: string): string {
  return `${ASSET_SCHEME}://${hash}`
}

/**
 * 字节落盘时的**文件名后缀**（`mime` 的纯投影）。
 *
 * 为什么要有它：文件名是给**人和外部工具**看的（Finder 能预览、能双击、能拖给别的
 * app，导出成 Markdown 时链接可以独立成立）。没有后缀的文件在 Finder 里是一张白纸。
 *
 * ⚠️ **代码不许读后缀**。类型只有一处真相：入库时从字节嗅出来的 `mime`（随行装载）。
 *    去读后缀，就是把一个外部随手可改的东西拉进判断 —— 那正是「两份答案能不一致」的形状。
 */
export function extOf(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/gif':
      return 'gif'
    case 'image/webp':
      return 'webp'
    case 'image/avif':
      return 'avif'
    default:
      return 'bin'
  }
}

function has(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/**
 * 从字节头判图片类型。
 *
 * 不信文件名/`File.type`：它们由用户提供，改个后缀就能骗过去；渲染最终吃的是字节。
 * 只认 v1 allowlist 里的五种；其余（含 SVG/HEIC）返回 `null`，由调用方给明确文案。
 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // GIF: GIF87a / GIF89a
  if (bytes.length >= 6 && (has(bytes, 0, 'GIF87a') || has(bytes, 0, 'GIF89a'))) {
    return 'image/gif'
  }
  // WebP: RIFF....WEBP
  if (bytes.length >= 12 && has(bytes, 0, 'RIFF') && has(bytes, 8, 'WEBP')) {
    return 'image/webp'
  }
  // AVIF: ....ftyp + avif/avis
  if (bytes.length >= 12 && has(bytes, 4, 'ftyp') && (has(bytes, 8, 'avif') || has(bytes, 8, 'avis'))) {
    return 'image/avif'
  }
  return null
}

function be16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}

function be32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0
}

function le16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}

function le24(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
}

/** JPEG 的尺寸在某个 SOF 段里，前面有一串长度可变的段要走过去。 */
function jpegDims(bytes: Uint8Array): { w: number; h: number } | null {
  let p = 2
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return null
    const marker = bytes[p + 1]
    if (marker === 0xff) {
      p++ // 填充字节
      continue
    }
    // 无载荷的标记：SOI／TEM／RSTn
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2
      continue
    }
    if (marker === 0xda) return null // 进了扫描数据还没有 SOF：这份字节读不出尺寸
    const len = be16(bytes, p + 2)
    if (len < 2) return null
    // SOF0..SOF15，除了 DHT(C4)／JPG(C8)／DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (p + 9 > bytes.length) return null
      const h = be16(bytes, p + 5)
      const w = be16(bytes, p + 7)
      return w > 0 && h > 0 ? { w, h } : null
    }
    p += 2 + len
  }
  return null
}

/**
 * 从字节头读**显示尺寸**（不解码像素）。
 *
 * 正常入库那条路已经解码过一次（`prepareAssetBlob`），尺寸直接来自解码结果，比读头更准
 * （EXIF 方向已校正）。这里只服务一件事：**外人给的字节没有行**——旧库升级、从别处拷来的
 * `assets/`、被清过索引的库。有了尺寸，图还没解码完时行高才不塌下去再弹回来。
 *
 * 读不出就返回 `null`：尺寸是布局提示，不是入库前提。不认识的容器（AVIF 的 `ispe` 埋在
 * 任意深度的 box 里）宁可不猜——**一个错的宽高比比没有宽高比更糟**。
 */
export function sniffImageDims(bytes: Uint8Array): { w: number; h: number } | null {
  const mime = sniffImageMime(bytes)
  if (mime === null) return null

  if (mime === 'image/png') {
    // 签名 8 ＋ 长度 4 ＋ 'IHDR' 4 ⇒ 宽高各 4 字节大端
    if (bytes.length < 24 || !has(bytes, 12, 'IHDR')) return null
    const w = be32(bytes, 16)
    const h = be32(bytes, 20)
    return w > 0 && h > 0 ? { w, h } : null
  }

  if (mime === 'image/gif') {
    // 逻辑屏幕宽高：各 2 字节小端
    if (bytes.length < 10) return null
    const w = le16(bytes, 6)
    const h = le16(bytes, 8)
    return w > 0 && h > 0 ? { w, h } : null
  }

  if (mime === 'image/jpeg') return jpegDims(bytes)

  if (mime === 'image/webp') {
    // RIFF 头 12 字节之后第一个 chunk 说明用哪种编码，三种的尺寸位置各不相同
    if (bytes.length >= 30 && has(bytes, 12, 'VP8X')) {
      return { w: le24(bytes, 24) + 1, h: le24(bytes, 27) + 1 } // 画布尺寸存的是「值 - 1」
    }
    if (bytes.length >= 30 && has(bytes, 12, 'VP8 ')) {
      // 3 字节帧标签 ＋ 起始码 9d 01 2a 之后才是宽高（各 14 位）
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
      const w = le16(bytes, 26) & 0x3fff
      const h = le16(bytes, 28) & 0x3fff
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (bytes.length >= 25 && has(bytes, 12, 'VP8L')) {
      // 签名 0x2f 之后：14 位宽 ＋ 14 位高，各减一
      if (bytes[20] !== 0x2f) return null
      const b0 = bytes[21]
      const b1 = bytes[22]
      const b2 = bytes[23]
      const b3 = bytes[24]
      return { w: 1 + (((b1 & 0x3f) << 8) | b0), h: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) }
    }
    return null
  }

  // AVIF：`ispe` 在 meta→iprp→ipco 里，位置不固定 ⇒ 不猜
  return null
}

/**
 * 原始字节的 SHA-256（小写 hex）。
 *
 * 用 WebCrypto：浏览器、Electron renderer、Node 26 都有；不引入 Node 的 `crypto`
 * 模块，core 才能同时跑在两端。
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 开发者日志用；不是用户可见文案。 */
export function shortAssetHash(hash: string): string {
  return hash.slice(0, 8)
}
