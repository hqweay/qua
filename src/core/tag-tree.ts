/**
 * **标签这一侧的边读法**（「算作」）：成员、成员块。
 *
 * 边本身在 `core/hierarchy.ts`（一条边，不分 kind、不设端点约束）。
 * 本文件只回答标签专有的那个问题：**谁算这个标签的成员**。
 *
 * 三条口径（都容易写错）：
 *   · **算作做**：查 `#人物` 要能看到只打了 `#演员` 的块 —— 成员沿**下级标签**展开；
 *   · **字段继承不做**：`fieldsOf` 只看块实际打着的标签（见 `core/props.ts`）。
 *     多出来的成员**不获得**上级标签的字段（否则「算作」会悄悄改变这块有哪些属性）；
 *   · 只向**下级**收集：`#演员` 同时归在 `#人物` 与 `#艺术家` 下时，
 *     `#人物` 的成员不会混进只归在 `#艺术家` 下的块。
 *   · 只收带 `tag` 露面的下级：归属边能连任何块，但「成员」说的仍然是
 *     「打了这个标签的块」—— 内容块之间的一条边不该让它凭空变成某个标签的成员。
 */
import { hasList, type Block } from './model.ts'
import { buildAdjacency, descendantIds, type Adjacency } from './hierarchy.ts'
import { tagMemberIds } from './tags.ts'
import { walkForest } from './walk.ts'

/**
 * 下级**标签** id（含自己）——「算作」的成员从这里来。
 *
 * `adj` 可传（同一屏要算好几个标签时共用一张表）；不传就现建一次。
 */
export function descendantTagIds(tagId: string, forest: readonly Block[], adj?: Adjacency): Set<string> {
  const a = adj ?? buildAdjacency(forest)
  const out = new Set<string>()
  for (const id of descendantIds(tagId, a)) {
    const b = a.byId.get(id)
    if (b && hasList(b, 'tag')) out.add(id)
  }
  return out
}

/**
 * 成员（**含算作**）：自己 ∪ 下级标签的成员。
 *
 * ⚠️ 每个标签各扫一遍森林（`tagMemberIds` 是 O(n)）⇒ 标签很多时这里会变成 O(n·标签数)。
 *    逐行渲染的调用方先自己扫一遍建「块 → 标签」表，别在循环里调这个。
 */
export function membersOf(tagId: string, forest: readonly Block[], adj?: Adjacency): Set<string> {
  const a = adj ?? buildAdjacency(forest)
  const out = new Set<string>()
  for (const id of descendantTagIds(tagId, forest, a)) {
    for (const member of tagMemberIds(id, forest)) out.add(member)
  }
  return out
}

/** 成员块（按森林先序；用于 footer 渲染） */
export function memberBlocks(tagId: string, forest: readonly Block[], adj?: Adjacency): Block[] {
  const ids = membersOf(tagId, forest, adj)
  const out: Block[] = []
  walkForest(forest, (b) => {
    if (ids.has(b.id)) out.push(b)
  })
  return out
}
