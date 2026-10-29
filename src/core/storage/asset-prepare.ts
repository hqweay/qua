/**
 * 入库前的公共准备（hash ／ 类型嗅探 ／ 尺寸 ／ 像素炸弹守卫）。
 *
 * 为什么单独一份：IDB 与 IPC 两个适配器都要这段，而**判据必须只有一份**——
 * 像素炸弹守卫在一边加上、另一边忘掉，就变成「只有一条入库路径会拒绝」；
 * 嗅探口径分叉则会让同一段字节在两个库里得到不同的 MIME。这里只做判断，
 * 不做落盘（落盘是各适配器的事）。
 *
 * 跑在渲染层：`createImageBitmap`／WebCrypto 都在。Node 单测里没有
 * `createImageBitmap` ⇒ 尺寸读不出（`undefined`），守卫自然跳过——
 * 断言只关心 hash 与嗅探，不依赖尺寸。
 */
import { MAX_IMAGE_PIXELS, sha256Hex, sniffImageMime } from '../assets.ts'

/** 一份已通过入库前检查的字节（两个 `put` 实现共用的中间形状）。 */
export interface PreparedAsset {
  /** 原始字节（`assetPut` 走 IPC 时搬的就是它） */
  buffer: ArrayBuffer
  /** 同一份字节的视图（hash 与嗅探的输入） */
  bytes: Uint8Array
  hash: string
  mime: string
  w?: number
  h?: number
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

/**
 * 嗅探、算地址、读尺寸、挡像素炸弹。
 *
 * ⚠️ 判断在**去重之前**跑：同一份字节第二次入库也走同一条守卫——
 * 「已经在库里」不该是一条更松的路径（重复贴一张解码炸弹图同样要拒绝）。
 * 去重本身是适配器的策略（问各自的 stat），不在这里。
 */
export async function prepareAssetBlob(blob: Blob): Promise<PreparedAsset> {
  const buffer = await blob.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const hash = await sha256Hex(bytes)

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

  return {
    buffer,
    bytes,
    hash,
    mime,
    ...(w !== undefined ? { w } : {}),
    ...(h !== undefined ? { h } : {}),
  }
}
