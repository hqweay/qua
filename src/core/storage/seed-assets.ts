/**
 * **启动时把种子资产的字节放进资产库**（幂等）。
 *
 * 为什么需要它：夹具的正文里写着 `AssetRun` 的 hash，而字节住在资产库——
 * 两边都是真值，缺一边就有一张图显示成 `missing`。种子内容与资产必须同时成立，
 * 否则默认演示看起来就像「资产库坏了」，而用户没有任何办法把它修好。
 *
 * 三条纪律：
 *   1. **幂等**：已有这份 hash 就直接返回（`put` 自己也会去重，这里省一次读字节）。
 *   2. **失败只影响这一张图**：入不了库 ⇒ 那一枚 run 显示 `missing`，应用照常启动；
 *      绝不因为一张演示图把启动拦下来。
 *   3. **不写「刻意缺失」那一份**：`MISSING_ASSET_HASH` 的存在意义就是库里没有它。
 */
import type { AssetStorePort } from './asset-port.ts'
import { SEED_ASSET_HASH, seedAssetBytes } from '../fixtures/assets.ts'

export async function ensureSeedAssets(port: AssetStorePort): Promise<void> {
  try {
    if (await port.stat(SEED_ASSET_HASH)) return
    await port.put(new Blob([seedAssetBytes()], { type: 'image/png' }))
  } catch (e) {
    // 开发者日志（英文）：用户可见的后果是那一张图显示「缺失」，不是启动失败
    console.warn('[assets] seed asset could not be stored:', e)
  }
}
