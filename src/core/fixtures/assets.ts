/**
 * **种子里的样本资产**：一张真的 PNG（96×60）＋ 一张刻意缺失的 hash。
 *
 * 为什么内置真字节而不是程序生成的渐变图：`missing` 是**状态**，不是默认样子。
 * 如果种子里的图全都指向不存在的 hash，默认演示看起来就像「资产库坏了」，
 * 而用户没有任何办法让它们变好——那样连「图能显示」这件事都验不到。
 *
 * 为什么字节放这里、hash 写死：`seedWorkspace()` 是同步的（夹具与单测都要同步造库），
 * 而 hash 要现算才是真的。两边的连接点是 `tests/assets.test.ts` 的一条断言：
 * `sha256Hex(SEED_ASSET_BYTES) === SEED_ASSET_HASH`。写错了那条会红，不会静默变成 missing。
 *
 * ⚠️ 同一份字节可以被多枚 run 引用（不同 `label`）：这正是内容寻址要演示的去重。
 */
import { MAX_IMAGE_BYTES, isAssetHash } from '../assets.ts'

/** 样本 PNG（96×60，纯色块画的「草图」）：base64 而非二进制文件，夹具才能同步 import。 */
const SEED_ASSET_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAjElEQVR42u3ZMRHAIAxAUeQggqEK0FOx6KDHhoNeBxhC391X8BYSkvoz9FJCAAgQIECAAAEKWb7bxwCtBipXPSBAgAABAvRPIM88IECAAAECBMg2Hy1AgNYBbfxyBQQIkKuGsw8gQIAAARIgg+K2kRIQIECAAEUEEiBAgAABAgQIECABAgQIECBARzYB/ny/5OUmDAQAAAAASUVORK5CYII='

/** 样本字节（`sha256Hex` 的输入；也是入库时被 `put` 的那一份）。 */
export function seedAssetBytes(): Uint8Array {
  const bin = atob(SEED_ASSET_PNG_BASE64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 样本字节的 SHA-256（由 `tests/assets.test.ts` 现算核对）。 */
export const SEED_ASSET_HASH = '6743b62328fe8d48b0c214a92a89ebcc6b2426b1e64f1f5916bc056169432d12'

/** 样本的显示尺寸（与 PNG 头一致；run 上的 `w/h` 就是它）。 */
export const SEED_ASSET_W = 96
export const SEED_ASSET_H = 60

/**
 * 刻意缺失的 hash：**库里没有这份字节**。
 *
 * 它必须是合法形状（64 位小写 hex）且不等于样本 hash —— 否则「缺失」会退化成
 * 「形状非法」，而形状校验是另一条断言的事。这里用一个内容上永远不会出现的值。
 */
export const MISSING_ASSET_HASH = '00000000000000000000000000000000000000000000000000000000000000ff'

/** 样本字节没超过入库上限（同一条上限也管粘贴；种子里不该有「只有种子能过」的例外）。 */
export const SEED_ASSET_WITHIN_LIMIT = seedAssetBytes().byteLength <= MAX_IMAGE_BYTES

/** 两个 hash 都得是合法地址（种子造错了会让「缺失」变成「形状坏」）。 */
export const SEED_ASSET_HASHES_VALID = isAssetHash(SEED_ASSET_HASH) && isAssetHash(MISSING_ASSET_HASH)
