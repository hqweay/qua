/**
 * **块的挂载区**：这一块下面挂哪些查询 tab。
 *
 * 形状上它和 `props._tags`／`props._belongsTo` 同族：**一格结构槽、一串有序项、渲染在正文之外**。
 * 它回答的是「这一块的看板配了哪几栏」，不是「这一块有哪些子块」——
 * 所以它不进 `children`（那会污染子树读路径：反链来源根、折叠三角、`⌘A`、子树复制）。
 *
 * 三类 tab 的来源必须分清，否则会出现「同一栏有两份答案」：
 *
 * | 来源 | 存哪 | 为什么 |
 * |---|---|---|
 * | 引用／同类／提及 | **不存**，每次按宿主现算 | 存下来的引用永远不会长；存下来的标签列表会过期 |
 * | 用户 tab | 宿主块自己的一格 `_mounts` | 建 tab 就是写一格属性 ⇒ 没有孤儿块、没有悬空 id |
 * | 日记的用户 tab | **一份共享配置块**（见 `journalMountsId`） | 「跟随今天」靠共享定义，不靠物化新天时复制 |
 *
 * ⚠️ 用户 tab **不是块**：它没有身份、不能被引用、不能被单独打开。要引用一份查询，
 *    那是「查询块」（一个内容对象）的事，与这里是两个问题。
 * ⚠️ 本文件零 DOM：`core` 不认识 tab 条长什么样，只回答「该有哪几栏、每栏什么条件」。
 *    tab 上的字由 UI 按 `kind` 查字典（内置项的 label 故意留空）。
 */
import { derivedId } from './ids.ts'
import { isJournal, journalDate, todayISO } from './journal.ts'
import { displayTextOf } from './alias.ts'
import { hasList, primaryAliasOf, prop, type Block } from './model.ts'
import { tagIdsOf } from './tags.ts'
import { descendantTagIds } from './tag-tree.ts'
import type { QueryNode, QuerySpec } from './query.ts'
import { findById } from './query.ts'

/** `_mounts`：宿主块上的一格（有序） */
export const MOUNTS_PROP = '_mounts'

/**
 * 一栏 tab。
 *
 * `kind` 是**语义**（谁都能算的那三栏 vs 用户配的），不是样式：UI 按它查字典、
 * 决定能不能摘除（内置三栏不可摘），也决定数据从哪来。
 */
export type MountKind = 'refs' | 'same' | 'mentions' | 'user'

export interface MountTab {
  kind: MountKind
  /** 只有 `user` 有：用户给这一栏起的名字 */
  label?: string
  /** 条件；`ref`／`journal`／`tag`／`text` 的值可以是 `'$self'`（求值时按宿主解析） */
  spec: QuerySpec
}

/**
 * 内置三栏的条件。它们**只用已有的条件原子**，`'$self'` 是值位上的哨兵——
 * 不给条件语言加 `mentions` 这类专用键：那会把名字解析偷偷塞进条件语言，
 * 而「提及」本来就能用「正文有我这串字 ∧ 没有指向我的边」说清。
 */
const SPEC_REFS: QuerySpec = { where: { ref: '$self' } }
const SPEC_MENTIONS: QuerySpec = { where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] } }

/**
 * 这一块该有哪些 tab：**内置在前、用户项在后**。
 *
 * 出现条件只读**身份**（带着标签吗、有没有可读文本），不读内容：
 * 于是 tab 条在你打字时不会变——否则每敲一个字整条就重排一次。
 * 日记的 tab 条因此恒为「引用 ＋ 提及」：它有日期投影（可读文本非空），但没有标签。
 */
export function mountTabsOf(host: Block, forest: readonly Block[], now: Date = new Date()): MountTab[] {
  const tabs: MountTab[] = [{ kind: 'refs', spec: SPEC_REFS }]
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
  const same = sameSpecOf(host, forest)
  if (same) tabs.push({ kind: 'same', spec: same })
  if (displayTextOf(host) !== '') tabs.push({ kind: 'mentions', spec: SPEC_MENTIONS })
  for (const tab of userMountsOf(host, forest, now)) tabs.push(tab)
  return tabs
}

/**
 * 用户配的那几栏（不含内置三栏）。
 *
 * 日记只有**今天**这一块能读共享配置：过去的天没有用户 tab，也不给「＋」——
 * 这是「只挂今日」的直接后果（与「按块各自一份」互斥，只能选一个）。
 */
export function userMountsOf(host: Block, forest: readonly Block[], now: Date = new Date()): MountTab[] {
  if (!canEditMounts(host, now)) return []
  const source = isJournal(host) ? journalMountsBlock(forest) : host
  return readMounts(source)
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

/**
 * 这一块能不能配用户 tab（也决定「＋」出不出现）。
 *
 * 判据与 `userMountsOf` 同源：**过去的日记天不能**。单独留一个入口，是为了让 UI
 * 不必自己再判一次「今天」——两处各判一次，「哪天算今天」就有两个答案。
 */
export function canEditMounts(host: Block, now: Date = new Date()): boolean {
  return !isJournal(host) || journalDate(host) === todayISO(now)
}

/**
 * 日记用户 tab 的共享配置块 id（**派生**，与 `journalId(date)` 同一个 id 机制）。
 *
 * 为什么是一个块而不是库级字段：库级字段要**新增一种 op 种类**才能写；而「一个块 ＋
 * 我们已经有的那一格」走现有属性写路径，零新实体、零新 op。
 * 代价（登记在文档里）：库里多一个没有任何列表露面的内部块——它只按 id 找，不可寻址。
 */
export function journalMountsId(): string {
  return derivedId('journal-mounts', '')
}

/** 共享配置块（只按 id 找；没有 ⇒ `undefined`，那时「加一栏」才物化它） */
export function journalMountsBlock(forest: readonly Block[]): Block | undefined {
  return findById(forest, journalMountsId())
}

/**
 * 造那个共享配置块：一个**只有 `_mounts` 一格**的顶层块。
 *
 * 它不占地址、不进任何列表（`_aliases`／`_lists` 都没有）⇒ 不参与组织、不可寻址。
 * 与字段定义块同类：只按 id 找、只由一个读路径消费。
 */
export function mkJournalMountsBlock(mounts: readonly MountTabWrite[] = []): Block {
  const now = Date.now()
  const block: Block = { id: journalMountsId(), content: [], children: [], created: now, modified: now }
  if (mounts.length > 0) block.props = { [MOUNTS_PROP]: mounts.map(toStored) }
  return block
}

/** 落盘的一项：**只有名字与条件**（没有 id、没有位点） */
export interface MountTabWrite {
  label: string
  spec: QuerySpec
}

const toStored = (m: MountTabWrite): MountTabWrite => ({ label: m.label.trim(), spec: m.spec })

/**
 * 读一格 `_mounts`。**形状不合法就当作没有**（`[]`），不抛、不修。
 *
 * 为什么不在这里修：读到一半的数据去「猜它想说什么」，会把一个坏库变成一个
 * 看起来正常、其实少了几栏的库。落盘那一侧（`storage/shape.ts`）判 corrupt，
 * 让用户看得见「这份库打不开」；读路径只保证不因为一格坏数据就崩。
 */
export function readMounts(b: Block | undefined): MountTab[] {
  const raw = b ? prop<unknown>(b, MOUNTS_PROP) : undefined
  if (!isMountsValue(raw)) return []
  return (raw as MountTabWrite[]).map((m) => ({ kind: 'user' as const, label: m.label, spec: m.spec }))
}

/**
 * `_mounts` 这个值的**形状判据**（读路径与落盘校验共用这一份）。
 *
 * 判据与 `_aliases` 同款严格度：数组、每项是对象、`label` 是非空串、`spec` 是对象、
 * **名字两两不重复**（同一个块下两栏同名，用户点哪一栏都一样，那说明写坏了）。
 */
export function isMountsValue(raw: unknown): raw is MountTabWrite[] {
  if (!Array.isArray(raw)) return false
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') return false
    const tab = item as Partial<MountTabWrite>
    if (typeof tab.label !== 'string' || tab.label.trim() === '') return false
    if (!tab.spec || typeof tab.spec !== 'object' || Array.isArray(tab.spec)) return false
    if (!tab.spec.where || typeof tab.spec.where !== 'object' || Array.isArray(tab.spec.where)) return false
    const label = tab.label.trim()
    if (seen.has(label)) return false
    seen.add(label)
  }
  return true
}
