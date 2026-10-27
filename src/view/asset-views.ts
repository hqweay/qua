/**
 * **资产在此刻长什么样** —— 把「正文里那个 hash」变成渲染需要的 `AssetView`。
 *
 * 为什么单独一层：渲染（`block-dom.ts`）是**同步纯函数**，而字节在资产库里（异步）。
 * 两者之间必须有人回答「现在这份 hash 在不在、URL 有没有」——
 * 而且这个答案**不落盘**：`state` 由资产库现算（`missing`／`unavailable` 是两种失败，
 * 给用户的建议不同）。把答案写进 run 会在字节被清／还没同步时说谎。
 *
 * 三条纪律（都在这里实现，别处不要再写一份）：
 *   1. **对象 URL 只在这里创建与回收**：按 hash 缓存，同一份字节全库一个 URL。
 *      每次重渲染都 `createObjectURL` 会一直泄漏（浏览器不回收，直到文档卸载）。
 *   2. **渲染路径只读、不 await**：`view()` 返回已知状态，缺 URL 时**排一次取字节**，
 *      取到后通知订阅者重画那几行 —— 所以「首帧没有图、第二帧有」是设计内的，
 *      不是「渲染有时序依赖」。
 *   3. **启动快照**：`keys()` 一次拿全，让「这份 hash 在不在」同步可判。
 *      快照过期（别处写入）时由 `prime()` 补进来。
 */
import type { AssetMeta, AssetView } from '../core/assets.ts'
import type { AssetStorePort } from '../core/storage/asset-port.ts'

/** 资产库打不开：所有资产都是 `unavailable`（不是「没有这份资产」）。 */
let store: AssetStorePort | null = null
let broken = false

/** 启动时一次拿全的 key 快照（＋入库时补进来的）。 */
const known = new Set<string>()
/** 已知元信息（`put` 的返回、`stat` 的返回）；缺了不影响渲染，只影响详情浮层。 */
const metas = new Map<string, AssetMeta>()
/** hash → 对象 URL。唯一创建处，见文件头第 1 条。 */
const urls = new Map<string, string>()
/** 正在取的 hash：同一个 hash 被多行同时引用时只发一次请求。 */
const inflight = new Set<string>()
/** URL 就绪的订阅者（装配层用它重画引用了这份资产的行）。 */
const listeners = new Set<(hash: string) => void>()

/**
 * 装上一个资产库并重置快照。`null` ⇒ 资产库不可用（web 里没开 IDB 也能跑）。
 *
 * ⚠️ **换库时先回收旧 URL**：对象 URL 指向的是**上一份资产库里的字节**，
 * 换库之后它们既不该再被引用，也不该继续占着内存。回收放在这里而不是让调用方记得，
 * 是因为「换资产库」只有这一个入口 —— 每个调用方各记一次就会漏一次。
 */
export function useAssetStore(port: AssetStorePort | null): void {
  revokeAssetUrls()
  store = port
  broken = false
  known.clear()
  metas.clear()
}

/**
 * 拉一次全库 key。
 *
 * 读失败 ⇒ **整个资产库标成不可用**（`unavailable`），而不是「没有资产」：
 * 后者会让每一张图都显示「缺失」，用户会去找图，而真正要修的是存储。
 */
export async function loadAssetKeys(): Promise<void> {
  if (!store) {
    broken = true
    return
  }
  try {
    const keys = await store.keys()
    known.clear()
    for (const k of keys) known.add(k)
  } catch {
    broken = true
  }
}

/** 入库成功后立刻登记：新插的 run 要能当场画出图，不用等下一次启动。 */
export function primeAsset(meta: AssetMeta): void {
  known.add(meta.hash)
  metas.set(meta.hash, meta)
}

/** 这份 hash 的元信息（详情浮层用）；没有就是 `null`。 */
export function assetMetaOf(hash: string): AssetMeta | null {
  return metas.get(hash) ?? null
}

/** 资产库此刻可用吗（装配层判「能不能贴图」）。 */
export function assetsAvailable(): boolean {
  return store !== null && !broken
}

/**
 * 启动快照里有多少份资产。
 *
 * 为什么把它给诊断面：「图显示不出来」有两种原因——字节不在库（`missing`）、
 * 库本身打不开（`unavailable`）。只看得见 DOM 的话这两种长得一样，
 * 断言就必须能问到「库里有几份」才能分清。
 */
export function assetKeyCount(): number {
  return known.size
}

/**
 * 取一份资产**此刻**的样子。
 *
 * `missing` 与 `unavailable` 必须分开：前者「库里没有这份字节」（等同步／找回文件），
 * 后者「资产库本身打不开」（换环境／修存储）。两者给用户的动作不一样。
 *
 * ⚠️ 缺 URL 时**排一次**取字节（见文件头第 2 条）：本函数本身仍是同步纯读，
 *    唯一副作用是「第一次问就发一次请求」。
 */
export function assetViewOf(hash: string): AssetView {
  if (!store || broken) return { state: 'unavailable' }
  if (!known.has(hash)) return { state: 'missing' }
  const meta = metas.get(hash)
  const url = urls.get(hash)
  if (!url) ensureUrl(hash)
  return {
    state: 'ready',
    ...(url ? { url } : {}),
    ...(meta ? { mime: meta.mime, ...(meta.w !== undefined ? { w: meta.w } : {}), ...(meta.h !== undefined ? { h: meta.h } : {}) } : {}),
  }
}

/** URL 就绪（或「其实没有这份资产」被判定出来）时回调。返回取消订阅。 */
export function onAssetReady(fn: (hash: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * 取字节 → 建 URL → 补齐元信息 → 通知。
 *
 * `get` 返回 `null` ＝ 库里没有（`keys()` 快照过期或字节被清）⇒ 把它从快照里摘掉，
 * 下一次渲染就是 `missing`；`get` reject ＝ 库坏了 ⇒ 整个库转 `unavailable`。
 *
 * ⚠️ **元信息要在这里补**：`keys()` 只给 key，而「这份资产是不是图片」需要 `mime`。
 *    不补的话首帧只能画文件占位，一张真图永远停在 chip 上（看起来像「图没显示」）。
 *    `stat` 只在**这一份 hash 第一次被渲染**时发生一次，之后走缓存。
 */
function ensureUrl(hash: string): void {
  if (!store || inflight.has(hash)) return
  const port = store
  inflight.add(hash)
  port
    .get(hash)
    .then(async (blob) => {
      if (!blob) {
        known.delete(hash)
        metas.delete(hash)
        return
      }
      // 同一 hash 在这期间已被别的行取到 ⇒ 别建第二个 URL
      if (!urls.has(hash)) urls.set(hash, URL.createObjectURL(blob))
      if (!metas.has(hash)) {
        const meta = await port.stat(hash).catch(() => null)
        if (meta) metas.set(hash, meta)
      }
    })
    .catch(() => {
      broken = true
    })
    .finally(() => {
      inflight.delete(hash)
      for (const fn of listeners) fn(hash)
    })
}

/**
 * 统一回收（一个 URL 都没漏在进程里）。
 *
 * 私有：回收只应该发生在 `useAssetStore`（换库）这一条路上 —— 公开出去，
 * 每个调用方都会以为自己该在某个时刻调一次，而漏掉的那一次就是泄漏。
 */
function revokeAssetUrls(): void {
  for (const url of urls.values()) URL.revokeObjectURL(url)
  urls.clear()
  inflight.clear()
}
