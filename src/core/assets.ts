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
