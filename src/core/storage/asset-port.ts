/**
 * `AssetStorePort` —— 资产字节的唯一契约（纯类型，零运行时）。
 *
 * 为什么单独一个端口：正文只存 hash，不知道字节在 IndexedDB、库目录还是云端。
 * 换存储（原型 IDB → 工作区 `assets/` → 将来的 BlobStore）时，渲染/命令一行不改。
 *
 * 三条硬口径：
 *   1. **内容寻址**：`put` 算 hash；同一份字节重复 `put` 幂等。
 *   2. **字节不进正文**：端口只返回元信息/Blob，不把 bytes 塞回 run。
 *   3. **缺失是状态**：`get`/`stat` 找不到返回 `null`，不抛「资产不存在」的错误；
 *      「库本身打不开」由装配层区分成 `unavailable`。
 */
import type { AssetMeta } from '../assets.ts'

export interface AssetStorePort {
  /**
   * 写入一份字节，返回它的内容元信息。
   *
   * 实现负责算 hash、嗅 MIME、读尺寸、去重；失败必须 reject（配额/权限/坏字节），
   * 不许假装成功。`w/h` 对非视觉媒体可以缺。
   */
  put(blob: Blob): Promise<AssetMeta>
  /** 取字节；没有这份资产返回 `null`。 */
  get(hash: string): Promise<Blob | null>
  /** 取元信息；没有返回 `null`。 */
  stat(hash: string): Promise<AssetMeta | null>
  /**
   * 启动时一次拿全库 key，让「这份资产在不在」可以同步判。
   *
   * 返回的是 hash 列表；顺序无语义。读失败必须 reject——「不知道有哪些资产」
   * 和「没有资产」不是一件事。
   */
  keys(): Promise<string[]>
}
