/**
 * **块的挂载区**：这一块下面挂哪几栏。
 *
 * 形状上它和 `props._tags`／`props._belongsTo` 同族：**一格结构槽、一串有序项、渲染在正文之外**。
 * 它回答的是「这一块的看板配了哪几栏」，不是「这一块有哪些子块」——
 * 所以它不进 `children`（那会污染子树读路径：反链来源根、折叠三角、`⌘A`、子树复制）。
 *
 * ## 三类 tab：来源与身份
 *
 * | 种类 | 存哪 | 有配置吗 | 为什么 |
 * |---|---|---|---|
 * | `derived`（引用／同类／提及） | **不存**，每次按宿主现算 | 没有 | 存下来的引用永远不会长；存下来的标签列表会过期 |
 * | `local` | 宿主块 `_mounts`／日记 `Prefs.journalMounts` | **自己拥有** spec ＋ views | 随手加一栏不该在树里多一个对象；删 tab＝删这份查询，⌘Z 可撤 |
 * | `linked` | 同上 | **没有**，只有 `{block,view}` 指针 | 条件/视图只有一份真相；共享就是共享 |
 *
 * ## 两条纪律
 *
 * ⚠️ **每个 entry 有一个稳定 `id`**（`t-<hex>`；内置栏 `d-<source>`）。数组位只表示顺序；
 *    激活项／展开栈／冻结缓存／收起状态都按 `id` 记。用 `user:<index>` 当下标的后果是
 *    删掉第一栏之后，active 与冻结全体漂到别一栏上，而不报错。
 *
 * ⚠️ **local tab 不是块**：它没有身份、不能被引用、不能被单独打开。要引用一份查询，
 *    那是「查询块」（一个内容对象）的事，与这里是两个问题 —— 那条路是 `promote`（显式复制）。
 *
 * ⚠️ 本文件零 DOM：`core` 不认识 tab 条长什么样，只回答「该有哪几栏、每栏是什么」。
 *    tab 上的字：local 用它自己的 label，linked 用目标名（可被 label 覆盖），
 *    derived 由 UI 按 `source` 查字典。
 */
import { uuidv7Hex } from './ids.ts'
import { isJournal, journalDate, todayISO } from './journal.ts'
import { displayTextOf } from './alias.ts'
import { hasList, primaryAliasOf, prop, type Block } from './model.ts'
import { tagIdsOf } from './tags.ts'
import { descendantTagIds } from './tag-tree.ts'
import type { QueryNode, QuerySpec } from './query.ts'
import { findById, isQuerySpec } from './query.ts'
import { canonicalViews, type ViewConfig } from './view.ts'

/** `_mounts`：块宿主上的一格（有序） */
export const MOUNTS_PROP = '_mounts'

/**
 * 挂载的**宿主**：两种，判据只有它一个。
 *
 * | 宿主 | 写哪 |
 * |---|---|
 * | `{kind:'block', blockId}` | 那一块的 `props._mounts`（**内容**，随块同步） |
 * | `{kind:'journal'}` | `Prefs.journalMounts`（**设备状态**，解析到今天；过去的天不可编辑） |
 */
export type MountHost = { kind: 'block'; blockId: string } | { kind: 'journal' }

/** 内置三栏的来源（**宿主现算**，没有配置） */
export type DerivedSource = 'refs' | 'same' | 'mentions'

/**
 * 一栏。
 *
 * `kind` 是**语义**（谁能拥有配置），不是样式：UI 按它查字典、决定能不能摘除，
 * 也决定「改条件」这件事落在谁的 `_query`／`spec` 上。
 */
export type MountEntry =
  | { id: string; kind: 'derived'; source: DerivedSource }
  | {
      id: string
      kind: 'local'
      label: string
      spec: QuerySpec
      views: ViewConfig[]
      activeView?: string
    }
  | { id: string; kind: 'linked'; block: string; view: string; label?: string }

/**
 * 复制随块走的那几栏（**整块拷贝用**）。
 *
 * · `local` 的 `spec`／`views` **深拷成独立对象**：复制之后原件与副本各自演化，
 *   共享同一份配置就是「改一个动两个」——要共享请用 linked（显式指针），不要靠拷贝悄悄共享。
 * · `linked`／`derived` 只拷指针：它们本来就不拥有配置。
 * · **`id` 不变**：复制的是内容，而「这一栏是这一栏」是它的身份；换 id 会让
 *   副本上「激活的是哪一栏」失去依据。
 */
export function cloneMountEntries(entries: readonly MountEntry[]): MountEntry[] {
  return canonicalMountEntries(entries).map((e) =>
    e.kind === 'local'
      ? { ...e, spec: JSON.parse(JSON.stringify(e.spec)) as QuerySpec, views: e.views.map((v) => ({ ...v })) }
      : e,
  )
}

/** 一个 tab 的稳定 id（数组位只表示顺序，所以身份必须另给一个） */
export function mkTabId(): string {
  /**
   * ⚠️ 取 **16** 位（时间前缀 ＋ 序号），不是 12 位的纯时间前缀：
   * 同一毫秒里加两栏会让两个 id 相同，而 id 是激活项与冻结缓存的键 ——
   * 撞了的表现是「切到这一栏，激活态跑到另一栏」，不报错。
   */
  return `t-${uuidv7Hex().slice(0, 16)}`
}

/**
 * 内置栏的 id 是**派生**的（同一个宿主、同一个来源 ⇒ 同一个 id）。
 *
 * 直接就用来源名（`refs`／`same`／`mentions`）：一个宿主下每种内置栏最多一条，
 * 所以它在**这一个挂载区**里天然唯一；而这个串同时是好看的调试锚点
 * （`[data-tab="refs"]`），不必再发明一套 key。
 */
export function derivedTabId(source: DerivedSource): string {
  return source
}

/** 两个宿主是不是同一个（`MountHost` 是「这一栏写哪」的唯一判别器） */
export function sameHost(a: MountHost, b: MountHost): boolean {
  if (a.kind === 'journal' || b.kind === 'journal') return a.kind === b.kind && a.kind === 'journal'
  return a.blockId === b.blockId
}

/**
 * 内置三栏的条件。它们**只用已有的条件原子**，`'$self'` 是值位上的哨兵——
 * 不给条件语言加 `mentions` 这类专用键：那会把名字解析偷偷塞进条件语言，
 * 而「提及」本来就能用「正文有我这串字 ∧ 没有指向我的边」说清。
 */
const SPEC_REFS: QuerySpec = { where: { ref: '$self' } }
const SPEC_MENTIONS: QuerySpec = { where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] } }

/**
 * 这一块的**内置三栏**（不落盘，每次现算）。
 *
 * 出现条件只读**身份**（带着标签吗、有没有可读文本），不读内容：
 * 于是 tab 条在你打字时不会变——否则每敲一个字整条就重排一次。
 * 日记的 tab 条因此恒为「引用 ＋ 提及」：它有日期投影（可读文本非空），但没有标签。
 */
export function derivedEntriesOf(host: Block, forest: readonly Block[]): MountEntry[] {
  const out: MountEntry[] = [{ id: derivedTabId('refs'), kind: 'derived', source: 'refs' }]
  /**
   * 「同类」＝ 与这一块**同一条分类轴**的块。
   *
   * 两个来源合成同一栏，因为它们是同一个问题的两种问法：
   *   · 普通块：它带着哪些标签（`_tags`）⇒ 同标签的块；
   *   · **标签块自己**：它就是那条轴 ⇒ 它的成员（「这一支下面有哪些块」）。
   * 少了后一边，打开一个标签就再也看不到它的成员了（成员列表原来的落点是标签页 footer）。
   * ⚠️ 标签块用**自己的主名**当条件（派生时现算，改名自动跟上）；它没有 `_tags`，
   *    所以 `{tag:'$self'}` 对它永远是空集，必须把这一支显式并进去。
   */
  if (sameSpecOf(host, forest) !== null) out.push({ id: derivedTabId('same'), kind: 'derived', source: 'same' })
  if (displayTextOf(host) !== '') out.push({ id: derivedTabId('mentions'), kind: 'derived', source: 'mentions' })
  return out
}

/** 一栏内置项的条件（`derived` 栏没有配置，它只有这个） */
export function derivedSpecOf(host: Block, forest: readonly Block[], source: DerivedSource): QuerySpec | null {
  if (source === 'refs') return SPEC_REFS
  if (source === 'mentions') return SPEC_MENTIONS
  return sameSpecOf(host, forest)
}

/**
 * 「同类」的条件；两个来源都空 ⇒ `null`（这一栏根本不出现）。
 *
 * ⚠️ 标签那一支要**沿下级标签展开**（「算作」）：`#人物` 的成员含只打 `#演员` 的块。
 *    这条口径只在 `core/tag-tree.ts` 里有一份（`descendantTagIds`）——在这里另写一遍
 *    「沿归属边往下走」就会出现两种「谁算这一支的成员」。
 */
function sameSpecOf(host: Block, forest: readonly Block[]): QuerySpec | null {
  const nodes: QueryNode[] = []
  if (tagIdsOf(host).length > 0) nodes.push({ tag: '$self' })
  if (hasList(host, 'tag')) {
    for (const id of descendantTagIds(host.id, forest)) {
      const tag = findById(forest, id)
      const name = tag ? primaryAliasOf(tag).trim() : ''
      if (name !== '') nodes.push({ tag: name })
    }
  }
  if (nodes.length === 0) return null
  return { where: nodes.length === 1 ? nodes[0]! : { any: nodes } }
}

/* ------------------------------------------------------------ 读 */

export interface MountReadOpts {
  /** 日记宿主的那一组（`Prefs.journalMounts`）：由装配层从设备状态取 */
  journalMounts?: readonly MountEntry[]
  now?: Date
}

/**
 * 这一块该有哪些 tab：**内置在前、用户项在后**。
 *
 * ⚠️ 日记只有**今天**这一块能读用户栏：过去的天没有用户栏，也不给「＋」——
 *    这是「只挂今日」的直接后果（与「按块各自一份」互斥，只能选一个）。
 */
export function mountEntriesOf(host: Block, forest: readonly Block[], opts: MountReadOpts = {}): MountEntry[] {
  const stored = storedEntriesOf(host, opts)
  return [...derivedEntriesOf(host, forest), ...stored]
}

/**
 * **存下来的那几栏**（不含内置）：块宿主读 `props._mounts`，日记宿主读 `journalMounts`。
 *
 * `MountHost` 是唯一判别器 —— 装配层不该自己判「是不是日记」再决定读哪一处，
 *    那会让「这一栏写哪」有两个答案。
 */
export function storedEntriesOf(host: Block, opts: MountReadOpts = {}): MountEntry[] {
  if (isJournal(host)) {
    if (journalDate(host) !== todayISO(opts.now ?? new Date())) return []
    return canonicalMountEntries(opts.journalMounts)
  }
  return readMounts(host)
}

/**
 * 这一块能不能配用户栏（也决定「＋」出不出现）。
 *
 * 判据与 `storedEntriesOf` 同源：**过去的日记天不能**。单独留一个入口，是为了让 UI
 * 不必自己再判一次「今天」——两处各判一次，「哪天算今天」就有两个答案。
 */
export function canEditMounts(host: Block, now: Date = new Date()): boolean {
  return !isJournal(host) || journalDate(host) === todayISO(now)
}

/** 读一格 `_mounts`（块宿主）。形状不合法 ⇒ 当作没有（不抛、不修） */
export function readMounts(b: Block | undefined): MountEntry[] {
  const raw = b ? prop<unknown>(b, MOUNTS_PROP) : undefined
  if (!isMountsValue(raw)) return []
  return canonicalMountEntries(raw)
}

/**
 * 逐项重建栏列表（与 `canonicalSpec`／`canonicalViews` 同一条纪律）。
 *
 * 判据与后果：
 *   · `kind` 不在三态里 ⇒ **丢掉该项**；
 *   · `local` 缺 `label`/`spec` ⇒ 丢；`views` 按 **query 源**校验（local 的源永远是 query）；
 *   · `linked` 缺 `block` ⇒ 丢；`view` 缺省 `''`（跟随目标的默认看法）；
 *   · `id` 缺失／重复 ⇒ **补一个或丢掉**：id 是激活项与冻结缓存的键，
 *     两条同名 id 会让「切到这一栏」落到别一栏上而不报错。
 *
 * 为什么不抛：一格坏数据不该让**整个块打不开**。丢掉那一项、由调用方提示一句，
 * 比让一块内容消失好。
 */
export function canonicalMountEntries(raw: unknown): MountEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: MountEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const e = item as Partial<MountEntry> & { kind?: string }
    if (e.kind === 'derived') {
      const source = (e as { source?: unknown }).source
      if (source !== 'refs' && source !== 'same' && source !== 'mentions') continue
      const id = stableId(e.id, seen, derivedTabId(source))
      if (!id) continue
      seen.add(id)
      out.push({ id, kind: 'derived', source })
      continue
    }
    if (e.kind === 'local') {
      const l = e as Partial<Extract<MountEntry, { kind: 'local' }>>
      if (typeof l.label !== 'string' || l.label.trim() === '') continue
      /**
       * **条件读不出来 ⇒ 这一栏不出现**（不是「出现一个空结果」）。
       *
       * 设备状态里的 `journalMounts` 不跟着库作废（它是偏好），所以它可能带着旧版本的
       * 条件形状 —— 那种栏求值只会静默空着。丢掉它，用户看到的是「少了一栏」，
       * 而不是一条永远为空的查询。
       */
      if (!isQuerySpec(l.spec)) continue
      const id = stableId(l.id, seen, null)
      if (!id) continue
      seen.add(id)
      const entry: Extract<MountEntry, { kind: 'local' }> = {
        id,
        kind: 'local',
        label: l.label.trim(),
        spec: l.spec,
        // local 的源**永远是 query**（它是面板局部的一次查询，没有块、没有 children/items）
        views: canonicalViews(l.views, { kind: 'query', spec: l.spec }),
      }
      if (typeof l.activeView === 'string' && l.activeView !== '') entry.activeView = l.activeView
      out.push(entry)
      continue
    }
    if (e.kind === 'linked') {
      const l = e as Partial<Extract<MountEntry, { kind: 'linked' }>>
      if (typeof l.block !== 'string' || l.block.trim() === '') continue
      const id = stableId(l.id, seen, null)
      if (!id) continue
      seen.add(id)
      const entry: Extract<MountEntry, { kind: 'linked' }> = {
        id,
        kind: 'linked',
        block: l.block,
        view: typeof l.view === 'string' ? l.view : '',
      }
      if (typeof l.label === 'string' && l.label.trim() !== '') entry.label = l.label.trim()
      out.push(entry)
    }
  }
  return out
}

/**
 * 一个 entry 的 id：**有就用，没有就造**。
 *
 * ⚠️ 为什么宁可造也不丢：丢掉会让「用户配的那栏整个消失」（静默丢内容）；
 *    造一个只影响「这一栏的激活态记在哪个键上」，而那一栏本来就还没有状态。
 *    重复则相反 —— 两条同 id 的栏会让状态互相覆盖，所以重复的**丢掉**。
 */
function stableId(id: unknown, seen: ReadonlySet<string>, fallback: string | null): string | null {
  if (typeof id === 'string' && id.trim() !== '') {
    if (seen.has(id)) return null
    return id
  }
  if (fallback === null) {
    let next = mkTabId()
    while (seen.has(next)) next = mkTabId()
    return next
  }
  if (seen.has(fallback)) return null
  return fallback
}

/**
 * `_mounts` 这个值的**形状判据**（读路径与落盘校验共用这一份）。
 *
 * 判据与 `_aliases` 同款严格度：数组、每项是对象、`kind` 在三态里、各态的必填字段齐全。
 * 「这一项还能不能用」由 `canonicalMountEntries` 逐条重建，这里只判「这坨字节能不能读」。
 */
export function isMountsValue(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const e = item as { kind?: unknown }
    if (e.kind === 'derived') {
      const source = (item as { source?: unknown }).source
      if (source !== 'refs' && source !== 'same' && source !== 'mentions') return false
      continue
    }
    if (e.kind === 'local') {
      const l = item as { label?: unknown; spec?: unknown }
      if (typeof l.label !== 'string' || l.label.trim() === '') return false
      if (!l.spec || typeof l.spec !== 'object' || Array.isArray(l.spec)) return false
      if (!('where' in (l.spec as object))) return false
      continue
    }
    if (e.kind === 'linked') {
      const l = item as { block?: unknown }
      if (typeof l.block !== 'string' || l.block.trim() === '') return false
      continue
    }
    return false
  }
  return true
}

