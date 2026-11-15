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
import type { AssetMeta, AssetView } from '../core/infra/assets.ts'
import type { AssetStorePort } from '../core/storage/asset-port.ts'
import { assetRefKindOf } from '../core/props/props.ts'

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

/**
 * **属性值那一侧的两态分派**：内态 hash 去查索引（web 的 Blob URL／桌面版的协议地址），
 * 外态 http(s) 链接本身就是要给 `<img src>` 的地址，不查索引。
 *
 * 为什么放在这一层而不在 UI：两种来源在渲染侧只有「能不能拿到一个地址」这一个差别，
 * 合并成一个 `AssetView` 之后，真图／缺失／不可用三态在正文与属性面就是同一套画法。
 * 外态的「腐烂」（外链取不到）由 `<img>` 的 error 现算，不落盘，与内态 missing 同归显示态。
 */
export function assetRefView(ref: string): AssetView {
  if (assetRefKindOf(ref) === 'external') return { state: 'ready', url: ref }
  return assetViewOf(ref)
}

/** 地址就绪（或某份被判定缺失）时回调。返回取消订阅。 */
export function onAssetChange(fn: (hash: string) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/* ------------------------------------------------------------ 点一枚露面会发生什么 */

/** 字节数的人话形式（详情浮层与 lightbox 共用一份，免得两处各算一套） */
export function formatBytesOf(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** 点一枚资产引用的**默认动作**：它指向链接／图／文件，动作跟着指向走。 */
export type AssetClickAction =
  /** 外态 http(s)：这是一条链接，交给系统浏览器 */
  | { t: 'external'; url: string }
  /** 内态且索引说是图片：开 lightbox（副标题＝尺寸 · 字节 · hash 短码，帮人确认是哪张图） */
  | { t: 'lightbox'; url: string; subtitle: string }
  /** 其余（内态非图／缺失／库打不开）：给详情，那里说清「这是什么、为什么看不了」 */
  | { t: 'details' }

/**
 * 「点一枚资产引用，默认动作是什么」的**唯一答案**（纯判据；执行归调用方）。
 *
 * 为什么按指向分派而不按声明格式：格式（image/file/any）是写入端的意图，
 * 读侧只信索引里的 mime 与值的 scheme——「声明成 image 的外链」仍是一条链接，
 * 浏览器比我们更知道怎么打开它。内态非图（文件）今天没有打开通道，落详情不假装能开。
 */
export function assetClickActionOf(ref: string): AssetClickAction {
  if (assetRefKindOf(ref) === 'external') return { t: 'external', url: ref }
  const view = assetViewOf(ref)
  if (view.state === 'ready' && view.url && (view.mime ?? '').startsWith('image/')) {
    const meta = assetMetaOf(ref)
    const dims = view.w && view.h ? `${view.w}×${view.h}` : ''
    const size = meta ? formatBytesOf(meta.size) : ''
    const subtitle = [dims, size, ref.slice(0, 8)].filter((x) => x !== '').join(' · ')
    return { t: 'lightbox', url: view.url, subtitle }
  }
  return { t: 'details' }
}
