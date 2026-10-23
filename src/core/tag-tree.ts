/**
 * **标签层级（算作 / 包含）**。
 *
 * 一条边、两个读法：
 *   · 存储：**子标签**上 `_parentTags`（有序 ref 列表，方向 子 → 父）；
 *   · 「包含多个」＝ 同一条边的反向读法（`childTags`），**不设第二条边**（否则两处真相）。
 *
 * 口径：
 *   · **算作做**：查 `#人物` 要能看到只打了 `#演员` 的块（成员沿后代标签展开）；
 *   · **字段继承不做**：`fieldsOf` 只看块实际打着的标签（见 `core/props.ts`）。
 *
 * ⚠️ 多父 + 多子 ⇒ 图是 DAG：三条配套约束在这里落地 ——
 *    不串味（只向**后代**收集）、菱形去重（Set）、禁环（写入时拒绝，不靠读时兜底）。
 * ⚠️ 删父标签**不自动摘边**：子标签上那条 ref 留着（悬空可见、可清理、撤销免费）。
 */
import { hasList, prop, type Block } from './model.ts'
import { walkForest } from './walk.ts'
import { findInForest } from './tree.ts'
import { allTags, tagMemberIds } from './tags.ts'
import { displayNameOf } from './alias.ts'

/** 子标签 → 父标签的有序 ref 列表 */
export const PARENT_TAGS_PROP = '_parentTags'

/** 直接父标签 id（有序；**不校验存活**） */
export function parentTagIds(tag: Block): string[] {
  const raw = prop<unknown>(tag, PARENT_TAGS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/** 直接父标签（活引用；悬空的不返回） */
export function parentTags(tag: Block, forest: readonly Block[]): Block[] {
  const out: Block[] = []
  for (const id of parentTagIds(tag)) {
    const b = findInForest(forest, id)
    if (b) out.push(b)
  }
  return out
}

/** 直接子标签（反向读同一条边；先序，稳定） */
export function childTags(tag: Block, forest: readonly Block[]): Block[] {
  return allTags(forest).filter((t) => parentTagIds(t).includes(tag.id))
}

/**
 * 祖先闭包（**不含自己**；去重）。
 *
 * 菱形：`#A` 属于 `#B`、`#C`，而 `#B`、`#C` 都属于 `#D` ⇒ `{B, C, D}`（D 只一次）。
 * 环：读时用 visited 兜底防死循环，但写入路径已经拒绝成环（见 `addParentTag`）。
 */
export function ancestorIds(tagId: string, forest: readonly Block[]): Set<string> {
  const byId = new Map(allTags(forest).map((t) => [t.id, t]))
  const out = new Set<string>()
  const self = byId.get(tagId)
  if (!self) return out
  const queue = [...parentTagIds(self)]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (out.has(id)) continue
    out.add(id)
    const t = byId.get(id)
    if (t) for (const p of parentTagIds(t)) if (!out.has(p)) queue.push(p)
  }
  return out
}

/**
 * 后代标签 id（**含自己**）——「算作」的成员从这里来。
 *
 * 只向**后代**方向收集：`#演员` 同时属于 `#人物` 与 `#艺术家` 时，
 * `#人物` 的成员**不会**混进只属于 `#艺术家` 的块（兄弟方向不传播）。
 */
export function descendantTagIds(tagId: string, forest: readonly Block[]): Set<string> {
  const out = new Set<string>([tagId])
  for (const t of allTags(forest)) {
    if (t.id !== tagId && ancestorIds(t.id, forest).has(tagId)) out.add(t.id)
  }
  return out
}

/**
 * 成员（**含算作**）：自己 ∪ 后代标签的成员。
 *
 * ⚠️ 与 `core/props.ts` 的 `fieldsOf` 解耦：这里多出来的块**不获得**祖先标签的字段。
 * ⚠️ 每个标签各扫一遍森林（`tagMemberIds` 是 O(n)）⇒ 标签很多时这里会变成 O(n·标签数)。
 *    调用方若是逐行渲染，先自己扫一遍建「块 → 标签」表，别在循环里调这个。
 */
export function membersOf(tagId: string, forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  for (const id of descendantTagIds(tagId, forest)) {
    for (const member of tagMemberIds(id, forest)) out.add(member)
  }
  return out
}

/** 成员块（按森林先序；用于 footer 渲染） */
export function memberBlocks(tagId: string, forest: readonly Block[]): Block[] {
  const ids = membersOf(tagId, forest)
  const out: Block[] = []
  walkForest(forest, (b) => {
    if (ids.has(b.id)) out.push(b)
  })
  return out
}

/* ------------------------------------------------------------ 写边 */

export type AddParentResult =
  | { ok: true }
  | { ok: false; reason: 'self' | 'duplicate' | 'cycle' | 'not-tag'; path?: string[] }

/**
 * **只检查**能不能加这条边（不写模型）。
 *
 * 与 `addParentTag` 分开，是为了让「被拒绝的写入」连一次撤销快照都不产生。
 */
export function checkAddParent(child: Block, parent: Block, forest: readonly Block[]): AddParentResult {
  if (child.id === parent.id) return { ok: false, reason: 'self' }
  if (!hasList(parent, 'tag')) return { ok: false, reason: 'not-tag' }
  if (parentTagIds(child).includes(parent.id)) return { ok: false, reason: 'duplicate' }
  // 把 parent 的祖先闭包算出来：里面若有 child ⇒ 添这条边会成环
  const anc = ancestorIds(parent.id, forest)
  if (anc.has(child.id)) {
    const path = [child.id, parent.id, ...anc].filter((id, i, arr) => arr.indexOf(id) === i)
    return { ok: false, reason: 'cycle', path }
  }
  return { ok: true }
}

/**
 * 加一条「child 属于 parent」。
 *
 * 禁环在**写入时**拒绝（不是读时去重兜底）：A 与 B 互为父时「谁是父」没有答案，
 * 静默接受一个语义错误的状态比拒绝写入更坏。
 */
export function addParentTag(child: Block, parent: Block, forest: readonly Block[]): AddParentResult {
  const check = checkAddParent(child, parent, forest)
  if (!check.ok) return check
  child.props = { ...(child.props ?? {}), [PARENT_TAGS_PROP]: [...parentTagIds(child), parent.id] }
  return { ok: true }
}

/** 删一条归属（只动子标签这一侧） */
export function removeParentTag(child: Block, parentId: string): boolean {
  const ids = parentTagIds(child)
  if (!ids.includes(parentId)) return false
  child.props = { ...(child.props ?? {}), [PARENT_TAGS_PROP]: ids.filter((id) => id !== parentId) }
  return true
}

/** 悬空父引用：ref 指向的块已经不在森林里（状态派生，不落盘） */
export function danglingParentIds(tag: Block, forest: readonly Block[]): string[] {
  return parentTagIds(tag).filter((id) => !findInForest(forest, id))
}

/** 清掉悬空归属（**只清不可解析的那些**；正常归属一条不动） */
export function pruneParentTags(tag: Block, forest: readonly Block[]): number {
  const ids = parentTagIds(tag)
  const alive = ids.filter((id) => findInForest(forest, id))
  if (alive.length === ids.length) return 0
  tag.props = { ...(tag.props ?? {}), [PARENT_TAGS_PROP]: alive }
  return ids.length - alive.length
}

/** 环路径的显示文本（用标签名；缺失的退回短 id） */
export function cyclePathLabels(path: readonly string[], forest: readonly Block[], shortId: (id: string) => string): string[] {
  const byId = new Map(allTags(forest).map((t) => [t.id, t]))
  return path.map((id) => {
    const b = byId.get(id)
    // 显示名走主名叶子：标签的正文是描述，名字在 `_aliases` 里
    return `#${b ? displayNameOf(b) || shortId(id) : shortId(id)}`
  })
}
