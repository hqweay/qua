/**
 * **拥有者模型**的类型与纯函数（**零 DOM、零存储**）。
 *
 * 一句话：**块是内容，命名视图是配置，`ViewRef` 是一次露面，冻结结果是表面实例的状态。**
 * 四个东西各归各，不再互相兼任。
 *
 * ## 为什么要有这一层
 *
 * 视图配置曾经散在四处各读一遍：中心直接摸 `props._views`、面板读 `_mounts` 里复制的一份
 * 条件、露面块自己存一份 `_views`。同一张表于是在库里有三份可编辑副本 ——
 * 「这里改了列宽，那里没跟着变」既不是共享也不是独立，只是三份互相看不见的副本。
 *
 * 这一层把「**谁拥有这份配置**」变成**一个类型**：
 *
 * | 拥有者 | 存哪 | 能被引用吗 |
 * |---|---|---|
 * | `block` | `props._query`／`_views`／`_activeView` | 能（它是内容对象） |
 * | `tab`（只指 local） | 块宿主 `_mounts`／日记 `Prefs.journalMounts` | 不能 |
 * | `derived` | **没有配置**（宿主现算） | — |
 *
 * 而 **绑定**（linked tab／embed／dock 卡）只存「指向谁 ＋ 选了哪张视图」，
 * 不拥有任何配置。
 *
 * ⚠️ 命令与 UI 只经 `ViewOwnerStore`（实现在 `app/wiring/owners.ts`）读写视图配置；
 *    不许在各处直接摸 `props._views`／`_mounts`／`Prefs`（`arch-check` 钉住了这一条）。
 * ⚠️ 本文件只有类型与纯函数：读写发生在**装配层**，因为「一次动作一笔事务」在那里才做得到。
 */
import { ACTIVE_VIEW_PROP, VIEWS_PROP, isQueryBlock, type Block } from './model.ts'
import { readEmbed, type ViewRef } from './embed.ts'
import { canonicalViews, readViews, resolveView, sourceOf, type Source, type ViewConfig, type ViewSet } from './view.ts'
import type { QuerySpec } from './query.ts'
import type { MountEntry, MountHost } from './mount.ts'

/* ------------------------------------------------------------ 拥有者 */

/**
 * **拥有者**：谁持有「条件 ＋ 命名视图」这一份配置。
 *
 * ⚠️ `tab` 只指 **local tab**：linked tab 是绑定（它指着别人），不是拥有者。
 *    把两者合成一个 `{host, tabId}` 就会出现「改这一栏的条件，其实是改另一个块的」。
 */
export type ViewOwnerRef =
  | { kind: 'block'; blockId: string }
  | { kind: 'tab'; host: MountHost; tabId: string }

/** 一个拥有者的全部配置（读出来的快照；写按字段给，不整份替换） */
export interface ViewOwnerData extends ViewSet {
  /** 只有 query 源有（`_query`／local tab 的 `spec`） */
  query?: QuerySpec
  /** tab 的名字（块拥有者的名字是它的地址，不在这里） */
  label?: string
}

/**
 * 往拥有者上写：**只写给出的字段**。
 *
 * 为什么不能「整份替换」：`ViewOwnerData` 的字段来自三处（块属性／tab 条目／设备状态），
 * 一次只该动一部分。整份替换会把没传的字段写成「没有」——
 * 实测形状是「改了一下显示排序，查询条件没了」，而那一格本来不该被这次写碰到。
 */
export function applyOwnerPatch(data: ViewOwnerData, patch: Partial<ViewOwnerData>): ViewOwnerData {
  const out: ViewOwnerData = { views: patch.views ?? data.views }
  const active = patch.activeView !== undefined ? patch.activeView : data.activeView
  if (active !== undefined && active !== '') out.activeView = active
  else delete out.activeView
  const query = patch.query !== undefined ? patch.query : data.query
  if (query !== undefined) out.query = query
  const label = patch.label !== undefined ? patch.label : data.label
  if (label !== undefined) out.label = label
  return out
}

/** 从一个**块**读出拥有者数据（纯读：调用方负责在事务里写回） */
export function ownerDataOfBlock(b: Block | undefined): ViewOwnerData {
  if (!b) return { views: [] }
  const out: ViewOwnerData = { views: readViews(b) }
  const active = b.props?.[ACTIVE_VIEW_PROP]
  if (typeof active === 'string' && active !== '') out.activeView = active
  if (isQueryBlock(b)) out.query = b.props?._query as QuerySpec
  return out
}

/** 从一个 **local tab** 读出拥有者数据；不是 local ⇒ `null`（linked/derived 不拥有配置） */
export function ownerDataOfTab(entry: MountEntry | undefined): ViewOwnerData | null {
  if (!entry || entry.kind !== 'local') return null
  const out: ViewOwnerData = { views: entry.views, query: entry.spec, label: entry.label }
  if (entry.activeView !== undefined && entry.activeView !== '') out.activeView = entry.activeView
  return out
}

/** 把一份数据写回一个 **local tab** 条目（返回新条目；不改入参） */
export function withTabOwnerData(entry: Extract<MountEntry, { kind: 'local' }>, data: ViewOwnerData): MountEntry {
  const out: Extract<MountEntry, { kind: 'local' }> = {
    id: entry.id,
    kind: 'local',
    label: typeof data.label === 'string' && data.label.trim() !== '' ? data.label : entry.label,
    // local tab 的源**永远是 query**：它是面板局部的一次查询，没有块可挂
    spec: data.query ?? entry.spec,
    views: canonicalViews(data.views, { kind: 'query', spec: data.query ?? entry.spec }),
  }
  if (data.activeView !== undefined && data.activeView !== '') out.activeView = data.activeView
  return out
}

/**
 * 把一份数据写回一个**块**的属性袋（返回新属性袋；不改入参）。
 *
 * ⚠️ 空集合一律**删掉那一格**：空数组会让「有没有配置」出现两份答案。
 */
export function withBlockOwnerData(
  props: Record<string, unknown> | undefined,
  data: ViewOwnerData,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = { ...(props ?? {}) }
  if (data.query !== undefined) out._query = data.query
  if (data.views.length === 0) delete out[VIEWS_PROP]
  else out[VIEWS_PROP] = data.views
  if (data.activeView === undefined || data.activeView === '') delete out[ACTIVE_VIEW_PROP]
  else out[ACTIVE_VIEW_PROP] = data.activeView
  return Object.keys(out).length === 0 ? undefined : out
}

/** 这一份拥有者数据的源（**派生**；query 源优先） */
export function sourceOfOwner(owner: ViewOwnerRef, data: ViewOwnerData, block?: Block): Source {
  if (data.query) return { kind: 'query', spec: data.query }
  if (owner.kind === 'block' && block) return sourceOf(block)
  if (owner.kind === 'block') return { kind: 'children', blockId: owner.blockId }
  // local tab 没有 query（不该发生：`core.mount/add-local` 必给 spec）
  return { kind: 'children', blockId: '' }
}

/* ------------------------------------------------------------ 绑定 */

/**
 * **绑定**：一次「在别处看一次」的指针。它只有「指向谁 ＋ 选了哪张视图」。
 *
 * | 绑定 | 指针住在哪 |
 * |---|---|
 * | `linked-tab` | `_mounts`／`Prefs.journalMounts` 里的 `{block,view}` |
 * | `embed` | 露面块的 `props._embed` |
 * | `dock` | 设备状态里的卡片（本轮先只留接口，per-card view 后置） |
 */
export type ViewBindingRef =
  | { kind: 'linked-tab'; host: MountHost; tabId: string }
  | { kind: 'embed'; blockId: string }
  | { kind: 'dock'; side: 'left' | 'right'; cardId: string }

/** 一个绑定解析出来的结果：指向哪个拥有者、选了哪张视图 */
export interface BindingTarget {
  owner: ViewOwnerRef
  /** `''` 跟随目标的默认看法；`'outline'` 强制大纲；否则是目标 `_views` 里的 id */
  view: string
}

/** 从一个 **linked tab** 条目解析绑定 */
export function bindingOfLinked(entry: MountEntry | undefined): BindingTarget | null {
  if (!entry || entry.kind !== 'linked') return null
  return { owner: { kind: 'block', blockId: entry.block }, view: entry.view }
}

/** 从一次**露面**解析绑定 */
export function bindingOfEmbed(b: Block | undefined): BindingTarget | null {
  const ref = readEmbed(b)
  if (!ref || !b) return null
  return { owner: { kind: 'block', blockId: ref.block }, view: ref.view }
}

/** 改变一个绑定选的视图（返回新的 entry；不改入参） */
export function withLinkedView(
  entry: Extract<MountEntry, { kind: 'linked' }>,
  view: string,
): Extract<MountEntry, { kind: 'linked' }> {
  const out: Extract<MountEntry, { kind: 'linked' }> = { id: entry.id, kind: 'linked', block: entry.block, view }
  if (entry.label !== undefined) out.label = entry.label
  return out
}

/**
 * 一次绑定**实际选中的那张视图**。
 *
 * 三个取值各有各的意思（与 `ViewRef.view` 同一份口径）：
 *   · `'outline'` —— 强制大纲（这次露面自己的选择，目标上没有对应配置）；
 *   · `''` —— 跟随目标的默认看法（目标换默认，这里跟着换）；
 *   · 其它 —— 目标 `_views` 里那一张命名视图的 id。
 *
 * ⚠️ **id 解析不到 ⇒ 退回默认看法并报 `degraded`**，不猜、也不自动改指针：
 *    指针本身没坏（目标还在），坏的只是那一张视图。偷偷改写会把用户的一次选择
 *    换成另一个选择，而那是看不见的。
 */
export function resolveBoundView(
  binding: BindingTarget,
  data: ViewOwnerData,
): { view: ViewConfig | null; degraded: boolean } {
  if (binding.view === 'outline') return { view: null, degraded: false }
  if (binding.view === '') return { view: resolveView(data, data.activeView ?? ''), degraded: false }
  const hit = resolveView(data, binding.view)
  if (hit) return { view: hit, degraded: false }
  return { view: resolveView(data, data.activeView ?? ''), degraded: true }
}

/**
 * 目标视图的 **id 不存在**时怎么办：退回目标的默认看法（不猜、不删指针）。
 */
export function fallbackViewOf(data: ViewOwnerData, view: string): { view: string; degraded: boolean } {
  if (view === '' || view === 'outline') return { view, degraded: false }
  if (data.views.some((v) => v.id === view)) return { view, degraded: false }
  return { view: '', degraded: true }
}

/* ------------------------------------------------------------ 接缝 */

/**
 * **唯一读写接缝**：命令与 UI 只经它读写视图配置。
 *
 * 实现在 `app/wiring/owners.ts`（那里才拿得到事务与设备状态）；这里只定契约。
 *
 * ⚠️ `write` 是**一笔事务 / 一次设备保存**：一次动作一条撤销步。
 * ⚠️ `write` 只写给出的字段（`applyOwnerPatch`），不传的保持原值。
 */
export interface ViewOwnerStore {
  read(owner: ViewOwnerRef): ViewOwnerData | null
  write(owner: ViewOwnerRef, patch: Partial<ViewOwnerData>): void
  readBinding(binding: ViewBindingRef): BindingTarget | null
  setBindingView(binding: ViewBindingRef, view: string): void
}

/* ------------------------------------------------------------ 表面 */

/** 表面：一份配置**在哪儿**被看到。它只提供上下文与尺寸，不拥有配置 */
export type ViewSurface = 'center' | 'mount' | 'embed' | 'dock'

/** 一个视图的指针（`''`／`'outline'`／视图 id）。绑定与露面共用这一个形状 */
export type { ViewRef }

/** 这一块是不是一个「有自己配置的视图拥有者」（查询块／收藏块／激活了某张视图） */
export function isViewOwner(b: Block | undefined): boolean {
  if (!b) return false
  return isQueryBlock(b) || readViews(b).length > 0 || typeof b.props?.[ACTIVE_VIEW_PROP] === 'string'
}

export type { MountEntry, MountHost, ViewConfig, ViewSet }
