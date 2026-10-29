/**
 * **资产在此刻长什么样** —— 把「正文里那个 hash」变成渲染需要的 `AssetView`。
 *
 * ## 这一层现在只做两件事
 *
 *   ① 把**随库装载一次的索引**（`AssetStorePort.index()`）变成一张表；
 *   ② 把「行在不在」「文件在不在」两件事合成一个 `state`。
 *
 * 上一版这里有一整套缓存：对象 URL、inflight 去重、订阅、回收 —— 那是「字节在渲染层
 * 没有一个可以名字的地址」的补偿。地址有了（`qua-asset://<hash>`），补偿就没了：
 * 地址是**同步**的字符串，字节由 `<img>` 自己去取。
 *
 * ## 三条纪律
 *
 *   1. **答案不落盘**：`state` 由索引与文件现算（`missing` / `unavailable` 是两种失败，
 *      给用户的建议不同）。写进 run 会在文件被清／还没同步时说谎。
 *   2. **`missing` 有三种来源，压成一个状态**：索引里没有这行（从没入库）、
 *      文件被删（`<img>` 报错 → `markAssetMissing`）、库打不开（`unavailable`，不是 missing）。
 *   3. **索引是唯一真相**：`mime/w/h` 都从这里来 —— 首帧就能画对，不靠「先画占位、
 *      等字节回来再重画」。
 */
import type { AssetMeta, AssetView } from '../core/assets.ts'
import type { AssetStorePort } from '../core/storage/asset-port.ts'

/** 资产库打不开：所有资产都是 `unavailable`（不是「没有这份资产」）。 */
let store: AssetStorePort | null = null
let broken = false

/** 随库装载一次的索引：hash → 元信息。 */
const rows = new Map<string, AssetMeta>()
/** 行在、文件没了（`<img>` 报错过的 hash）。一次上锁，重开库时重来。 */
const gone = new Set<string>()
/** 需要重画的订阅者（地址就绪／文件判定缺失时）。 */
const listeners = new Set<(hash: string) => void>()
/** 与**实现**之间的那一条订阅（换库时要退掉，否则旧实现还会往新库的订阅者里打事件）。 */
let unsubPort: (() => void) | null = null

function notify(hash: string): void {
  for (const fn of listeners) fn(hash)
}

/**
 * 装上一个资产库并清空快照。`null` ⇒ 资产库不可用（web 里没开 IDB 也能跑）。
 *
 * ⚠️ 换库时把**实现的地址**一起放掉：订阅退掉、索引清空。上一版的清理逻辑在这里
 *    回收对象 URL；现在 URL 的生命周期归实现（它自己创建、自己回收），这层不再持有。
 */
export function useAssetStore(port: AssetStorePort | null): void {
  unsubPort?.()
  unsubPort = null
  store = port
  broken = false
  rows.clear()
  gone.clear()
  unsubPort = port?.onAddressChange((hash) => notify(hash)) ?? null
}

/**
 * 拉一次全库索引。
 *
 * 读失败 ⇒ **整个资产库标成不可用**（`unavailable`），而不是「没有资产」：
 * 后者会让每一张图都显示「缺失」，用户会去找图，而真正要修的是存储。
 */
export async function loadAssetIndex(): Promise<void> {
  if (!store) {
    broken = true
    return
  }
  try {
    const list = await store.index()
    rows.clear()
    for (const m of list) rows.set(m.hash, m)
  } catch {
    broken = true
  }
}

/** 入库成功后立刻登记：新插的 run 要能当场画出图，不用等下一次启动。 */
export function primeAsset(meta: AssetMeta): void {
  rows.set(meta.hash, meta)
  gone.delete(meta.hash)
}

/** 这份 hash 的元信息（详情浮层用）；没有就是 `null`。 */
export function assetMetaOf(hash: string): AssetMeta | null {
  return rows.get(hash) ?? null
}

/**
 * 这份 hash 的字节取不到（`<img>` 报错）。
 *
 * 为什么由 `<img>` 来告诉我们：我们本来就不知道文件在不在 —— 直到浏览器去取。
 * 它正好会回答，而且只在这一份上回答一次（之后按 `missing` 画，不再重试）。
 */
export function markAssetMissing(hash: string): void {
  if (gone.has(hash)) return
  gone.add(hash)
  notify(hash)
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
export function assetRowCount(): number {
  return rows.size
}

/**
 * 取一份资产**此刻**的样子。
 *
 * `missing` 与 `unavailable` 必须分开：前者「库里没有这份字节」（等同步／找回文件），
 * 后者「资产库本身打不开」（换环境／修存储）。两者给用户的动作不一样。
 *
 * 纯读：不发请求、不改状态 —— 地址由实现给（桌面版是个常量字符串）。
 */
export function assetViewOf(hash: string): AssetView {
  if (!store || broken) return { state: 'unavailable' }
  const meta = rows.get(hash)
  if (!meta || gone.has(hash)) return { state: 'missing' }
  const url = store.urlOf(hash)
  return {
    state: 'ready',
    mime: meta.mime,
    ...(url ? { url } : {}),
    ...(meta.w !== undefined ? { w: meta.w } : {}),
    ...(meta.h !== undefined ? { h: meta.h } : {}),
  }
}

/** 地址就绪（或某份被判定缺失）时回调。返回取消订阅。 */
export function onAssetChange(fn: (hash: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
