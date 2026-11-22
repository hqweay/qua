/**
 * **关系边**：一张可重建的派生表，回答「谁指向谁／谁归谁／谁提到谁」。
 *
 * 关系不是块：它不落盘、不进森林、不进 undo／同步。唯一真相仍是块内容与属性槽，
 * 这里只是把三处分散的读路径（正文 ref run、`_tags`、属性里的 `ref` 值、`_embed`…）
 * 收成**一份带 kind 的边表**，避免「同一个问题有多个答案」。
 *
 * 为什么 kind 必须显式：块 id 出现在很多槽里，但语义不同 ——
 * `[[名]]`是引用、`_tags`是归类、`Author`属性是属性引用、`_embed`是露面、
 * `_items`是收藏、`_belongsTo`是归属。按形状猜「凡是一个块 id 就是引用」会把
 * 这些关系混成一锅，且不报错。
 */
import { hasList, isPropDefBlock, type Block } from '../model/model.ts'
import { refRunsOf } from '../model/runs.ts'
import { tagIdsOf } from '../identity/tags.ts'
import { propKindOf, type PropKind } from '../props/props.ts'
import { readEmbed } from '../views/embed.ts'
import { parentIdsOf } from './hierarchy.ts'
import { annotatesPairsOf } from './annotates.ts'
import { walkForest } from '../model/walk.ts'

/**
 * 关系种类。
 *
 * | kind | 从哪来 | 回答 |
 * |---|---|---|
 * | `inline` | 正文里无 flavor 的 ref run；或 flavor `#` 但目标**不是标签类**（记录＝实例胶囊、普通块） | 谁在正文里引用了我 |
 * | `property` | 用户属性定义 `kind:'ref'` 的值 | 哪个属性指向我 |
 * | `embed` | `_embed.block` | 谁把我露在别处 |
 * | `tag` | `_tags` | 谁归我管 |
 * | `tagMention` | 正文里 `flavor:'#'` 且目标仍是标签类的 ref run | 谁在正文里用行内标签指向我 |
 * | `belongsTo` | `_belongsTo` | 谁归在谁下面 |
 * | `annotates` | `_annotates`（备注块的指向槽） | 谁在评论我的一段 |
 * | `item` | `_items` | 谁把我收进集合 |
 */
export type RelationKind =
  | 'inline'
  | 'property'
  | 'embed'
  | 'tag'
  | 'tagMention'
  | 'belongsTo'
  | 'annotates'

/**
 * 「引用」收四类：正文引用、属性引用、露面指针、**行内标签**（指向标签类的 `#名`）。
 * 行内标签有指向边、点击跳目标、改名跟随，符合术语表「引用＝有指向边的出现」；
 * 它的**分类语义**由 `{tag}` 另答，不影响它作为引用被计数与查询。
 * 标签归属（`tag`）与备注（`annotates`）是另外两种事实，不是引用。
 */
export type RefKind = Extract<RelationKind, 'inline' | 'property' | 'embed' | 'tagMention'>

export const REFERENCE_KINDS: readonly RefKind[] = ['inline', 'property', 'embed', 'tagMention']

export function isRefKind(v: unknown): v is RefKind {
  return v === 'inline' || v === 'property' || v === 'embed' || v === 'tagMention'
}

/** 一个边对象。同一 `(from,to,kind,propId,view,pos)` 只出现一次；`inline` 用 `count` 记次数。 */
export interface RelationEdge {
  from: string
  to: string
  kind: RelationKind
  /** `property`：字段定义块 id；`annotates`：被标注区间锚（anno）的 id——同宿主多区间靠它消歧 */
  propId?: string
  /** `inline`／`tagMention`：同一源块里出现几次 */
  count?: number
  /** `embed`：这次露面选的视图（`''`／`'outline'`／视图 id） */
  view?: string
  /** `item`：它在这一格里的位置 */
  pos?: number
}

/** 稳定排序用：同一条边在两条路径（全量／增量）里必须得到同一个串。 */
export function relationEdgeKey(e: RelationEdge): string {
  return [
    e.to,
    e.from,
    e.kind,
    e.propId ?? '',
    e.view ?? '',
    e.pos === undefined ? '' : String(e.pos),
    e.count === undefined ? '' : String(e.count),
  ].join('\u0001')
}

/**
 * 一块上的全部出向关系（纯函数；`propKinds`／`tagClass` 由调用方一次建好，避免每块扫全库）。
 *
 * `tagClass` 是「目标 id → 是不是标签类」的集合（`collectTagClassIds` 的产物）：
 * 行内 `#名` 的语义**由目标身份决定**，不由 run 的显示风味决定 —— 指向标签类的那一枚
 * 是分类提及（tagMention），指向记录／普通块的那一枚是指向具体目标的引用（inline）。
 * 渲染层按同一份目标身份分流三种呈现（`refKindOf`），这里不另认一遍。目标不在集合里
 * （含目标已退场的 dangling）一律 inline；集合变化时由调用方全量重算边。
 *
 * `annoHosts` 是「anno id → 宿主块」的反查表：`to` 可以指向 anno，但边的 `to`
 * 必须是块 id —— 在**边生成处**归一化一次，下游的反链／入向计数／`{ref}` 查询
 * 就都不必认识 anno。不传这张表时行为与从前完全一致。
 */
export function relationEdgesOfBlock(
  block: Block,
  propKinds: ReadonlyMap<string, PropKind>,
  tagClass: ReadonlySet<string>,
  annoHosts?: ReadonlyMap<string, { hostId: string }>,
): RelationEdge[] {
  const out: RelationEdge[] = []
  const inline = new Map<string, number>()
  const tagMention = new Map<string, number>()
  for (const r of refRunsOf(block.content)) {
    if (!r.to) continue
    if (r.flavor === '#' && tagClass.has(r.to)) {
      tagMention.set(r.to, (tagMention.get(r.to) ?? 0) + 1)
      continue
    }
    const to = annoHosts?.get(r.to)?.hostId ?? r.to
    inline.set(to, (inline.get(to) ?? 0) + 1)
  }
  for (const [to, count] of inline) out.push({ from: block.id, to, kind: 'inline', count })
  for (const [to, count] of tagMention) out.push({ from: block.id, to, kind: 'tagMention', count })

  for (const tagId of tagIdsOf(block)) out.push({ from: block.id, to: tagId, kind: 'tag' })

  for (const [propId, value] of Object.entries(block.props ?? {})) {
    if (propKinds.get(propId) !== 'ref') continue
    if (typeof value !== 'string' || value === '') continue
    out.push({ from: block.id, to: value, kind: 'property', propId })
  }

  const embed = readEmbed(block)
  if (embed) out.push({ from: block.id, to: embed.block, kind: 'embed', view: embed.view })

  for (const parentId of parentIdsOf(block)) out.push({ from: block.id, to: parentId, kind: 'belongsTo' })

  // 备注边：一对一条。同宿主多区间靠 propId＝anno id 消歧，边的唯一键才不互踩。
  for (const pair of annotatesPairsOf(block)) {
    out.push({ from: block.id, to: pair.block, kind: 'annotates', propId: pair.anno })
  }
  return out
}

/** 森林里**可见**块的属性定义 kind 表（全量路径与增量路径共用这一份口径） */
export function collectPropKinds(forest: readonly Block[]): Map<string, PropKind> {
  const out = new Map<string, PropKind>()
  walkForest(forest, (x) => {
    if (isPropDefBlock(x)) out.set(x.id, propKindOf(x))
  })
  return out
}

/**
 * 森林里**可见**的标签类块 id 集（行内 `#名` 分类判据的同一份上游，与 `refKindOf` 的
 * `hasList(b,'tag')` 同一读法）。集合只在建/删标签、同名块被收编时变 —— 低频动作，
 * 调用方在变化时全量重算关系边，不必逐边追踪。
 */
export function collectTagClassIds(forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  walkForest(forest, (b) => {
    if (hasList(b, 'tag')) out.add(b.id)
  })
  return out
}

/** 一份森林的关系边（先收定义 kind 与标签类，再收边：定义块可能住在后面的顶层根里） */
export function relationEdgesOfForest(forest: readonly Block[]): {
  edges: RelationEdge[]
  propKinds: Map<string, PropKind>
} {
  const propKinds = collectPropKinds(forest)
  const tagClass = collectTagClassIds(forest)
  const edges: RelationEdge[] = []
  walkForest(forest, (b) => {
    edges.push(...relationEdgesOfBlock(b, propKinds, tagClass))
  })
  return { edges, propKinds }
}
