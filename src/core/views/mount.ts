/**
 * **块的挂载区**：这一块下面挂哪几栏。
 *
 * 形状上它和 `props._tags`／`props._belongsTo` 同族：**一格结构槽、一串有序项、渲染在正文之外**。
 * 它回答的是「这一块的看板配了哪几栏」，不是「这一块有哪些子块」——
 * 所以它不进 `children`（那会污染子树读路径：反链来源根、折叠三角、`⌘A`、子树复制）。
 *
 * ## 两类 tab：来源与身份
 *
 * | 种类 | 存哪 | 有配置吗 | 为什么 |
 * |---|---|---|---|
 * | `derived`（引用／同类／提及） | **不存**，每次按宿主现算 | 没有 | 存下来的引用永远不会长；存下来的标签列表会过期 |
 * | `local` | 宿主块 `_mounts`／日记 `Prefs.journalMounts` | **自己拥有** spec ＋ views | 随手加一栏不该在树里多一个对象；删 tab＝删这份查询，⌘Z 可撤 |
 *
 * ## 两条纪律
 *
 * ⚠️ **每个 entry 有一个稳定 `id`**（`t-<hex>`；内置栏 `d-<source>`）。数组位只表示顺序；
 *    激活项／展开栈／冻结缓存／收起状态都按 `id` 记。用 `user:<index>` 当下标的后果是
 *    删掉第一栏之后，active 与冻结全体漂到别一栏上，而不报错。
 *
 * ⚠️ **local tab 不是块，也不指向块**：它没有身份、不能被引用、不能被单独打开。
 *    要一份能被引用／共享的查询，写「查询块」（内容对象）；两者共用同一套条件与视图，
 *    但拥有者不同 —— 面板里的查询只属于这一块，查询块属于树。
 *
 * ⚠️ 本文件零 DOM：`core` 不认识 tab 条长什么样，只回答「该有哪几栏、每栏是什么」。
 *    tab 上的字：local 用它自己的 label，derived 由 UI 按 `source` 查字典。
 */
import { uuidv7Hex } from '../model/ids.ts'
import { isJournal, journalDate, todayISO } from '../identity/journal.ts'
import { displayTextOf } from '../identity/alias.ts'
import { hasList, primaryAliasOf, prop, type Block } from '../model/model.ts'
import { tagIdsOf } from '../identity/tags.ts'
import { descendantTagIds } from '../identity/tag-tree.ts'
import { plainText } from '../model/runs.ts'
import type { QueryHit, QueryNode, QuerySpec } from '../query/query.ts'
import { findById, isQuerySpec } from '../query/query.ts'
import { isRefKind, REFERENCE_KINDS, type RefKind } from '../relations/relations.ts'
import { t } from '../infra/msg.ts'
import {
  canonicalViews,
  cloneViews,
  MATCHED_COLUMN,
  MODIFIED_COLUMN,
  PATH_COLUMN,
  REF_COUNT_COLUMN,
  REL_KINDS_COLUMN,
  resolveRows,
  SHARED_TAGS_COLUMN,
  TITLE_COLUMN,
  VIA_COLUMN,
  type DerivedViewKind,
  type ViewColumn,
  type ViewConfig,
  type ViewRecord,
} from './view.ts'
import type { KbClient } from '../kb/types.ts'

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

/**
 * 内置四栏的来源（**宿主现算**，没有配置）。
 *
 * `refs`／`mentions` 是任何宿主都有的问题；`members` 只属于标签块（谁归我管），
 * `same` 只属于非日记块（谁和我同类）。后两者**不再合并**：
 * 「我的成员」与「和我同标签的块」是两个问题，合并会让标签页的「同类」名不副实。
 *
 * **规范顺序**：这个数组同时是「没拖过时的默认序」。拖过的顺序住 `_mounts` 的数组位
 * （整条 tab 条一条顺序）；派生栏没有配置，落进去的只是位置标记。
 */
export const DERIVED_SOURCES = ['members', 'refs', 'same', 'mentions'] as const
export type DerivedSource = (typeof DERIVED_SOURCES)[number]

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

/**
 * 复制随块走的那几栏（**整块拷贝用**）。
 *
 * · `local` 的 `spec`／`views` **深拷成独立对象**：复制之后原件与副本各自演化，
 *   共享同一份配置就是「改一个动两个」——要共享请 embed 一个查询块，不要靠拷贝悄悄共享。
 * · `derived` 只拷指针：它本来就不拥有配置。
 * · **`id` 不变**：复制的是内容，而「这一栏是这一栏」是它的身份；换 id 会让
 *   副本上「激活的是哪一栏」失去依据。
 */
export function cloneMountEntries(entries: readonly MountEntry[]): MountEntry[] {
  return canonicalMountEntries(entries).map((e) =>
    e.kind === 'local'
      ? { ...e, spec: JSON.parse(JSON.stringify(e.spec)) as QuerySpec, views: cloneViews(e.views) }
      : e,
  )
}

/**
 * **挪一栏**：把 `tabId` 挪到 `targetId` 的前／后。
 *
 * 传进来的是**整条 tab 条**（`mountEntriesOf` 的返回值），所以派生栏与用户栏可以互相越位；
 * 派生栏没有配置，落进 `_mounts` 的只是一条位置标记（`{kind:'derived', source}`）。
 * 命令层决定写哪一份：只动 local、且这一格还没有标记时，保持原来那几栏（不为了拖一栏
 * local 就把内置栏物化进内容）；涉及派生栏时才把整条列表写回（首次换序＝物化）。
 *
 * 返回 `null` ＝ 什么都没变（同一个 id ／任一不在这一格里）—— 调用方据此判断「要不要写」，
 * 不写就不该产生一次可撤销动作。
 */
export function moveMountEntry(
  entries: readonly MountEntry[],
  tabId: string,
  targetId: string,
  place: 'before' | 'after',
): MountEntry[] | null {
  if (tabId === targetId) return null
  const from = entries.findIndex((e) => e.id === tabId)
  if (from < 0) return null
  if (!entries.some((e) => e.id === targetId)) return null
  const next = [...entries]
  const [moved] = next.splice(from, 1)
  /**
   * 目标下标必须按**摘掉之后**的数组重算：先按下标算好再 `splice` 会让「往后挪」差一格
   * （摘掉源之后，目标的下标已经左移了一位）。
   */
  const at = next.findIndex((e) => e.id === targetId)
  next.splice(place === 'before' ? at : at + 1, 0, moved!)
  return next
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

/** 一块落在哪种宿主上（`MountHost` 的唯一构造点：别在各处再写一遍三元） */
export function mountHostOf(b: Block): MountHost {
  return isJournal(b) ? { kind: 'journal' } : { kind: 'block', blockId: b.id }
}

/* ------------------------------------------------------------ 派生栏的看法 */

/**
 * 派生栏的视图选择（**设备状态**，与 `_mounts` 无关）。
 *
 * 为什么不是拥有者配置：派生栏没有条件、没有视图列表，它「谁跟我有关」是现算的。
 * 给它一份 `_views` 就等于给一个没有 owner 的东西造 owner —— 第二真相。
 */
export type MountViews = Readonly<Record<string, DerivedViewKind>>

/**
 * 派生栏设备状态的**宿主键**：`block:<id>` / `journal`。
 *
 * 与 `mountViewKey` 同一族（看法是「宿主＋来源」，顺序是「宿主」）：
 * 换宿主（换块、跨天）时两者一起失效。
 */
export function mountHostKey(host: MountHost): string {
  return host.kind === 'journal' ? 'journal' : `block:${host.blockId}`
}

/** 一格派生栏的设备状态键：`block:<宿主块 id>:<来源>` / `journal:<来源>` */
export function mountViewKey(host: MountHost, source: DerivedSource): string {
  return `${mountHostKey(host)}:${source}`
}

/** 这一格选了什么（缺省大纲；未知值在 `normalizePrefs` 那一层已经丢掉了） */
export function readMountView(views: MountViews | undefined, host: MountHost, source: DerivedSource): DerivedViewKind {
  const v = views?.[mountViewKey(host, source)]
  return v === 'list' || v === 'table' ? v : 'outline'
}

/**
 * 内置三栏的条件。它们**只用已有的条件原子**，`'$self'` 是值位上的哨兵——
 * 不给条件语言加 `mentions` 这类专用键：那会把名字解析偷偷塞进条件语言，
 * 而「提及」本来就能用「正文有我这串字 ∧ 没有指向我的边」说清。
 */
const SPEC_REFS: QuerySpec = { where: { ref: '$self' } }
const SPEC_MENTIONS: QuerySpec = { where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] } }

/**
 * 这一块的**内置栏**（不落盘，每次现算）。
 *
 * 出现条件只读**宿主类型**（是不是标签块、是不是日记），**不读这一刻的数据**：
 * 于是 tab 条在你打字时不会变。数据缺了是 body 里一句因果不同的空态，
 * 不是把这一栏藏掉（否则「重排之后才出现的栏」就没有落点）。
 *
 * 集合：
 *   · 标签块：成员 → 引用 → 同类 → 提及；
 *   · 普通块：引用 → 同类 → 提及；
 *   · 日记：引用 → 提及（日期身份不参与标签归属，不挂一个永远空的「同类」）。
 *
 * 这是**规范序**（没拖过时的默认）。拖过的顺序住 `_mounts`（宿主那一格 tab 列表）：
 * 派生栏也是那条列表里的项，见 `mountEntriesOf` 的合并规则。
 */
export function derivedEntriesOf(host: Block): Extract<MountEntry, { kind: 'derived' }>[] {
  const out: Extract<MountEntry, { kind: 'derived' }>[] = []
  if (hasList(host, 'tag')) out.push({ id: derivedTabId('members'), kind: 'derived', source: 'members' })
  out.push({ id: derivedTabId('refs'), kind: 'derived', source: 'refs' })
  if (!isJournal(host)) out.push({ id: derivedTabId('same'), kind: 'derived', source: 'same' })
  out.push({ id: derivedTabId('mentions'), kind: 'derived', source: 'mentions' })
  return out
}

/**
 * 一栏内置项的条件（`derived` 栏没有配置，它只有这个）。
 *
 * 返回 `null` ＝ **这一栏的维度不存在**（不是「成员为空」）：没有标签就没有「同类」、
 * 没有可读文本就没有「提及」。tab 仍然在（按宿主类型常驻），body 用这句话说原因。
 * ⚠️ `mentions` 必须在这里判：`resolveSelfSpec` 会把空的 `$self` 文本变成 `NEVER`，
 *    条件本身不会报「空」，UI 也就分不出「没人提到」与「没有名字可查」。
 */
export function derivedSpecOf(host: Block, forest: readonly Block[], source: DerivedSource): QuerySpec | null {
  if (source === 'refs') return SPEC_REFS
  if (source === 'mentions') return displayTextOf(host) === '' ? null : SPEC_MENTIONS
  if (source === 'members') return memberSpecOf(host, forest)
  return sameSpecOf(host)
}

/**
 * 「成员」＝ 标签块自己的成员（含下级标签，口径只在 `core/tag-tree.ts` 一份）。
 *
 * 标签块没有 `_tags`，`{tag:'$self'}` 对它永远是空集，所以这一支用**自己的主名**
 * 现算条件（改名自动跟上）；只有标签块才有这一栏。
 */
function memberSpecOf(host: Block, forest: readonly Block[]): QuerySpec | null {
  if (!hasList(host, 'tag')) return null
  const names = new Set<string>()
  for (const id of descendantTagIds(host.id, forest)) {
    const tag = findById(forest, id)
    const name = tag ? primaryAliasOf(tag).trim() : ''
    if (name !== '') names.add(name)
  }
  if (names.size === 0) return null
  const nodes: QueryNode[] = [...names].map((name) => ({ tag: name }))
  return { where: nodes.length === 1 ? nodes[0]! : { any: nodes } }
}

/** 「同类」＝ 与这一块有共同标签的块；没有 `_tags` ⇒ 这一栏根本不出现。 */
function sameSpecOf(host: Block): QuerySpec | null {
  return tagIdsOf(host).length > 0 ? { where: { tag: '$self' } } : null
}

/**
 * 派生栏的**一行**：来源块 ＋ 这一栏特有的派生列。
 *
 * 三条口径：
 *   · 上下文沿用挂载区那一条：`selfId`＝宿主、**不给子树锚点**、`excludeIds` 含宿主。
 *     给派生栏传子树锚点会让引用／提及恒空（那些块本来就在别处）。
 *   · 引用是**块粒度**（谁引用了我），不按「第几处引用」拆行；
 *   · 派生值不进 `props`、不落盘：`refCount`／`matched`／`sharedTags` 都是这次读出来的。
 */
export function derivedRecordsOf(host: Block, kb: KbClient, source: DerivedSource): ViewRecord[] {
  const spec = derivedSpecOf(host, kb.roots(), source)
  if (!spec) return []
  const hits = kb.query(spec, { selfId: host.id, excludeIds: [host.id] })
  const rows = resolveRows(hits, kb)
  if (source === 'refs') return refRecords(host, kb, rows)
  if (source === 'members') return memberRecords(host, kb, rows)
  if (source === 'mentions') return mentionRecords(host, kb)
  const own = new Set(kb.tagsOf(host.id).map((t) => plainText(t.content)))
  return rows.map((r) => {
    const shared = r.tags.map((t) => plainText(t.content)).filter((name) => own.has(name))
    return shared.length === 0 ? r : { ...r, derived: { sharedTags: shared } }
  })
}

/** 引用行：一个来源块一行，带**次数**与**关系 kind**（正文／属性·字段名／嵌入） */
function refRecords(host: Block, kb: KbClient, rows: readonly ViewRecord[]): ViewRecord[] {
  const bySource = new Map<string, { count: number; kinds: Set<RefKind>; props: Set<string> }>()
  for (const e of kb.relationsTo(host.id)) {
    if (!isRefKind(e.kind)) continue
    const acc = bySource.get(e.from) ?? { count: 0, kinds: new Set<RefKind>(), props: new Set<string>() }
    acc.count += e.count ?? 1
    acc.kinds.add(e.kind)
    if (e.kind === 'property' && e.propId) acc.props.add(e.propId)
    bySource.set(e.from, acc)
  }
  if (bySource.size === 0) return [...rows]
  const names = propNamesOf(kb)
  return rows.map((r) => {
    const m = bySource.get(r.block.id)
    if (!m) return r
    const labels: string[] = []
    for (const kind of REFERENCE_KINDS) {
      if (!m.kinds.has(kind)) continue
      if (kind === 'property') {
        const props = [...m.props].map((id) => names.get(id) ?? '').filter((x) => x !== '')
        if (props.length === 0) labels.push(t('ui.mount.kind.property'))
        for (const p of props) labels.push(t('ui.mount.kind.propertyWith', { name: p }))
      } else {
        labels.push(t(kind === 'inline' ? 'ui.mount.kind.inline' : 'ui.mount.kind.embed'))
      }
    }
    return { ...r, derived: { refCount: m.count, relKinds: labels, relKindKeys: REFERENCE_KINDS.filter((k) => m.kinds.has(k)) } }
  })
}

/** 成员行：标签块自己的成员；`viaTags` 为空＝直接成员，否则是经由的下级标签 */
function memberRecords(host: Block, kb: KbClient, rows: readonly ViewRecord[]): ViewRecord[] {
  const selfName = primaryAliasOf(host).trim()
  const allowed = new Set<string>()
  for (const id of descendantTagIds(host.id, kb.roots())) {
    const tag = kb.get(id)
    const name = tag ? primaryAliasOf(tag).trim() : ''
    if (name !== '') allowed.add(name)
  }
  return rows.map((r) => {
    const names = r.tags.map((x) => plainText(x.content).trim()).filter((n) => allowed.has(n))
    if (names.includes(selfName)) return { ...r, derived: { viaDirect: true } }
    return names.length === 0 ? r : { ...r, derived: { viaTags: names } }
  })
}

/**
 * 提及行：正文文本命中（`{text} ∧ not {ref}`）＋ 行内 `#名` 提及。
 *
 * 两者合成一行；`matched` 记命中的词／标签。标签提及是**提及**，不是引用，
 * 也不是成员：它只回答「正文里提到了我」。
 */
function mentionRecords(host: Block, kb: KbClient): ViewRecord[] {
  const word = displayTextOf(host)
  const textHits = word === '' ? [] : kb.query(SPEC_MENTIONS, { selfId: host.id, excludeIds: [host.id] })
  const byBlock = new Map<string, Set<string>>()
  for (const h of textHits) {
    const set = byBlock.get(h.blockId) ?? new Set<string>()
    set.add(word)
    byBlock.set(h.blockId, set)
  }
  const tagWord = word === '' ? '' : `#${word}`
  for (const e of kb.relationsTo(host.id)) {
    if (e.kind !== 'tagMention' || e.from === host.id) continue
    const set = byBlock.get(e.from) ?? new Set<string>()
    set.add(tagWord)
    byBlock.set(e.from, set)
  }
  const hits: QueryHit[] = []
  for (const blockId of byBlock.keys()) {
    const path = kb.pathOf(blockId)
    if (path.length === 0) continue
    hits.push({ blockId, path: path.slice(0, -1).map((b) => b.id) })
  }
  const rows = resolveRows(hits, kb)
  return rows.map((r) => {
    const words = byBlock.get(r.block.id)
    return words && words.size > 0 ? { ...r, derived: { matched: [...words].join(' · ') } } : r
  })
}

function propNamesOf(kb: KbClient): Map<string, string> {
  const out = new Map<string, string>()
  for (const def of kb.propDefs()) {
    const name = primaryAliasOf(def).trim() || plainText(def.content).trim()
    if (name !== '') out.set(def.id, name)
  }
  return out
}

/**
 * 派生栏切到表格时的**默认列**（临时构造，不落盘：派生栏没有 `_views`）。
 *
 * 三种来源各自最要紧的那一列不同：引用看次数、提及看命中词、同类看共同标签；
 * 路径与修改时间是它们共有的「这条在哪、什么时候动过」。
 */
export function derivedColumns(source: DerivedSource): ViewColumn[] {
  const special =
    source === 'refs'
      ? [REL_KINDS_COLUMN, REF_COUNT_COLUMN]
      : source === 'members'
        ? [VIA_COLUMN]
        : source === 'mentions'
          ? [MATCHED_COLUMN]
          : [SHARED_TAGS_COLUMN]
  return [
    { key: TITLE_COLUMN, width: 260 },
    { key: PATH_COLUMN, width: 220 },
    ...special.map((key) => ({
      key,
      width: key === MATCHED_COLUMN ? 150 : key === REL_KINDS_COLUMN ? 180 : key === SHARED_TAGS_COLUMN ? 160 : 120,
    })),
    { key: MODIFIED_COLUMN, width: 150 },
  ]
}

/**
 * 派生栏切到列表时的字段（同样临时构造）。
 *
 * 列表只放两列：位置与「这一栏特有的那一列」—— 列表本来就是更瘦的一张表。
 */
export function derivedListFields(source: DerivedSource): string[] {
  const special =
    source === 'refs'
      ? REL_KINDS_COLUMN
      : source === 'members'
        ? VIA_COLUMN
        : source === 'mentions'
          ? MATCHED_COLUMN
          : SHARED_TAGS_COLUMN
  return [PATH_COLUMN, special]
}

/* ------------------------------------------------------------ 读 */

export interface MountReadOpts {
  /** 日记宿主的那一组（`Prefs.journalMounts`）：由装配层从设备状态取 */
  journalMounts?: readonly MountEntry[]
  now?: Date
}

/**
 * 这一块该有哪些 tab、按什么顺序。
 *
 * 一格 `_mounts` 有两种状态（**同一种形状**，不新增字段）：
 *   · **没有派生标记** ⇒ 没拖过：内置按规范序在前，用户栏按数组位在后；
 *   · **有派生标记** ⇒ 拖过：数组位就是**整条 tab 条**的顺序，派生与用户栏可以交错。
 *
 * 标记指向的来源当前不存在（普通块上的「成员」）⇒ 跳过但**留在数组里**；
 * 重排之后才出现的来源（块刚被标成标签）⇒ 插在**最后一个派生标记之后**
 * （没有派生前例就插到最前），不抢用户钉在最前面的查询。
 *
 * ⚠️ 日记只有**今天**这一块能读用户栏：过去的天没有用户栏，也不给「＋」——
 *    这是「只挂今日」的直接后果（与「按块各自一份」互斥，只能选一个）。
 */
export function mountEntriesOf(host: Block, opts: MountReadOpts = {}): MountEntry[] {
  const derived = derivedEntriesOf(host)
  const stored = storedEntriesOf(host, opts)
  const markers = stored.filter((e): e is Extract<MountEntry, { kind: 'derived' }> => e.kind === 'derived')
  if (markers.length === 0) return [...derived, ...stored]
  const bySource = new Map(derived.map((d) => [d.source, d]))
  const out: MountEntry[] = []
  for (const e of stored) {
    if (e.kind === 'local') {
      out.push(e)
      continue
    }
    const d = bySource.get(e.source)
    if (d) out.push(d)
  }
  const missing = derived.filter((d) => !markers.some((m) => m.source === d.source))
  if (missing.length > 0) {
    const last = out.reduce((at, e, i) => (e.kind === 'derived' ? i : at), -1)
    out.splice(last + 1, 0, ...missing)
  }
  return out
}

/**
 * **存下来的那几栏**（不含内置）：块宿主读 `props._mounts`，日记宿主读 `journalMounts`。
 *
 * `MountHost` 是唯一判别器 —— 装配层不该自己判「是不是日记」再决定读哪一处，
 *    那会让「这一栏写哪」有两个答案。
 */
export function storedEntriesOf(host: Block, opts: MountReadOpts = {}): MountEntry[] {
  if (isJournal(host)) {
    const all = canonicalMountEntries(opts.journalMounts)
    /**
     * 过去的日记天**没有用户栏**（那一栏只挂今天），但顺序是这条日记 tab 条共享的：
     * 只留位置标记，让派生栏在每一天都按用户排过的顺序出现。用户栏本身仍然不出现。
     */
    if (journalDate(host) !== todayISO(opts.now ?? new Date())) {
      return all.filter((e) => e.kind === 'derived')
    }
    return all
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
 *   · `kind` 不在两态里 ⇒ **丢掉该项**；
 *   · `local` 缺 `label`/`spec` ⇒ 丢；`views` 按 **query 源**校验（local 的源永远是 query）；
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
      if (source !== 'refs' && source !== 'members' && source !== 'same' && source !== 'mentions') continue
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
 * 判据与 `_aliases` 同款严格度：数组、每项是对象、`kind` 在两态里、各态的必填字段齐全。
 * 「这一项还能不能用」由 `canonicalMountEntries` 逐条重建，这里只判「这坨字节能不能读」。
 */
export function isMountsValue(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const e = item as { kind?: unknown }
    if (e.kind === 'derived') {
      const source = (item as { source?: unknown }).source
      if (source !== 'refs' && source !== 'members' && source !== 'same' && source !== 'mentions') return false
      continue
    }
    if (e.kind === 'local') {
      const l = item as { label?: unknown; spec?: unknown }
      if (typeof l.label !== 'string' || l.label.trim() === '') return false
      if (!l.spec || typeof l.spec !== 'object' || Array.isArray(l.spec)) return false
      if (!('where' in (l.spec as object))) return false
      continue
    }
    return false
  }
  return true
}

