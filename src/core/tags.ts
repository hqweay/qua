/**
 * **标签 ＝ 块上的一格分类字段**（`props._tags`，有序的标签块 id 列表）。
 *
 * 判据：标签标的是**整个块**，不是正文里的某一个位置。
 * 句子内要指某个东西，用引用（`[[ ]]`）；标签只做整块分类。
 * 所以它不该占正文的一格 —— 那一格会被当成「这里」的意思，而它本来没有位置语义。
 *
 * 这个判据推出的三件事：
 *   ① 删字不会顺手删掉标签，摘标签是一次**显式**动作（没有「边藏在正文里」这种半截状态）；
 *   ② 顺序＝用户打的先后，存在数组里；正文里没有位点需要维护，锚点映射也不必管它；
 *   ③ 「哪些块打了这个标签」是**派生**的：`tagMemberIds` 扫一遍森林，
 *      或查 `IndexPort` 的 `tagMembers` 表（调用方优先用后者，扫描是 O(n)）。
 *
 * 标签本身仍是**块**（`tag` 角色）：名字住在它的正文里，归属存 id ⇒ 改名自动传播。
 * ⚠️ 「在正文里敲 `#foo` 变成标签」当前不做，接缝在 `view/editor.ts` 的输入同步路径：
 *    在那里把闭合的名字交给 `ensureTag` ＋ `addTagId`，与命令路径共用同一对函数。
 */
import { uuidv7Hex } from './ids.ts'
import { addRole, hasRole, prop, type Block, type Role } from './model.ts'
import { walkForest } from './walk.ts'
import { findByAlias, isAddressable, normalizeAlias } from './alias.ts'
import type { Atom } from './annotations.ts'

/**
 * 标签块的角色：标签 ＝ 一个带 `tag` 角色的普通块。
 *
 * ⚠️ 它**不占据树上的位置**（必须在顶层）——所有读路径都按 id 找标签（不按位置），
 *    而所有树操作（缩进／拖拽／删除）都会把一个"住在子树里的标签"当货物搬走。
 */
export const TAG_ROLE: Role = 'tag'

/** 「这块带着哪些标签」的系统属性（有序 id 列表，pos ＝ 数组下标） */
export const TAGS_PROP = '_tags'

/**
 * 标签名的规范化。
 *
 * ⚠️ 定义在 `core/alias.ts`（页名与标签名共用同一个名字空间）；
 *    这里保留导出只是为了调用方读得通 —— **不要另写一份 trim/lower**。
 */
export const normalizeTag = normalizeAlias

/** 造一个标签块（名字就是正文；图标走系统属性） */
export function mkTagBlock(name: string): Block {
  return {
    id: uuidv7Hex(),
    text: name,
    children: [],
    props: { _roles: [TAG_ROLE], _icon: 'lucide:hash' },
  }
}

/**
 * 按名字找标签块（先序；只认 `tag` 角色）。
 *
 * ⚠️ 名字比较**必须**走 `normalizeTag`：这是「标签名规范化只有一处定义」的落点，
 *    查询条件与 `ensureTag` 共用它，口径不会分叉。
 */
export function findTagByName(forest: readonly Block[], name: string): Block | undefined {
  return findByAlias(forest, name, (b) => hasRole(b, TAG_ROLE))
}

/** 在森林里找一个标签块（先序；只认 `tag` 角色，比较走地址规范化） */
function findTag(forest: readonly Block[], name: string): Block | undefined {
  return findByAlias(forest, name, (b) => hasRole(b, TAG_ROLE))
}

/**
 * **找到或创建**标签块（幂等，与 journal「一天一个」同一口径）。
 *
 * 返回 `created` / `reused` 是因为三种情况在界面上是三件事：
 *   · 引用已有标签；
 *   · 新建了一个标签；
 *   · **同名块已经存在（页 / 兼位块）⇒ 复用它，只给它加 `tag` 角色**。
 *     这一种必须给用户**可见反馈**（否则他不知道自己刚把一个页变成了标签）。
 *
 * ⚠️ 空名字**不建块**，返回 `null`：没有名字的标签没有身份，建了就是个孤儿。
 * ⚠️ 地址比较只走 `findByAlias`（规范化只有一处）：`# 设计 ` 与 `#设计` 是同一个标签。
 */
export function ensureTag(
  forest: Block[],
  name: string,
): { block: Block | null; created: boolean; reused: boolean } {
  if (normalizeTag(name) === '') return { block: null, created: false, reused: false }
  const found = findTag(forest, name)
  if (found) return { block: found, created: false, reused: false }
  // 同名块已存在（能当地址用、但还不是标签）⇒ 复用并加角色，不建第二个同名的块
  const existing = findByAlias(forest, name, (b) => isAddressable(b) && !hasRole(b, TAG_ROLE))
  if (existing) {
    addRole(existing, TAG_ROLE)
    return { block: existing, created: false, reused: true }
  }
  const block = mkTagBlock(name.trim())
  forest.push(block)
  return { block, created: true, reused: false }
}

/** 库里现有的全部标签块（先序） */
export function allTags(forest: readonly Block[]): Block[] {
  const out: Block[] = []
  walkForest(forest, (b) => {
    if (hasRole(b, TAG_ROLE)) out.push(b)
  })
  return out
}

/** 标签块 id → 块（**一次扫描**：整屏渲染别按块调 `tagsOf`，那会退化成 O(n²)） */
export function tagsById(forest: readonly Block[]): Map<string, Block> {
  return new Map(allTags(forest).map((t) => [t.id, t]))
}

/**
 * 这块带着哪些标签 id（**有序**：就是用户打的先后；重复 id 只算一次）。
 *
 * ⚠️ 只读一个字段。不扫正文、不解析文本 —— 标签没有位点。
 */
export function tagIdsOf(block: Block): string[] {
  const raw = prop<unknown>(block, TAGS_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * 给块加一个标签（**幂等**；追加到末尾 ＝ 顺序就是用户打的先后）。
 *
 * @returns 真的写进去了才 `true`；已经有这个标签 ⇒ `false` 且一个字节不动
 *          （调用方据此决定要不要记一次撤销、要不要弹提示）。
 */
export function addTagId(block: Block, tagId: string): boolean {
  const ids = tagIdsOf(block)
  if (ids.includes(tagId)) return false
  block.props = { ...(block.props ?? {}), [TAGS_PROP]: [...ids, tagId] }
  return true
}

/** 摘掉一个标签（幂等）；最后一个摘掉时连槽位一起删，不留空壳 */
export function removeTagId(block: Block, tagId: string): boolean {
  const ids = tagIdsOf(block)
  if (!ids.includes(tagId)) return false
  const next = ids.filter((id) => id !== tagId)
  const props = { ...(block.props ?? {}) }
  if (next.length === 0) delete props[TAGS_PROP]
  else props[TAGS_PROP] = next
  // 属性袋不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
  if (Object.keys(props).length === 0) delete block.props
  else block.props = props
  return true
}

/**
 * 一个块当前带着哪些标签块（**活引用**，顺序＝打的先后）。
 *
 * ⚠️ 返回标签块本身，不是名字 —— 要 id 取 `.id`，要显示名走 `refTitle`（会跟着改名）。
 * ⚠️ 目标块不在了（标签块被删）⇒ 那一格跳过：悬空归属由 tag 面板的清理入口处理，
 *    这里不替它造一个假目标。
 * ⚠️ 逐块调用要扫一遍森林找标签块；整屏渲染先用 `tagsById` 建一次表，
 *    再按 `tagIdsOf` 取。
 */
export function tagsOf(block: Block, forest: readonly Block[]): Block[] {
  const byId = tagsById(forest)
  return resolveTagIds(block, byId)
}

/** `tagsOf` 的批量版：标签表已经建好时用它，省掉「每块扫一遍全库」 */
export function resolveTagIds(block: Block, byId: ReadonlyMap<string, Block>): Block[] {
  const out: Block[] = []
  const seen = new Set<string>()
  for (const id of tagIdsOf(block)) {
    if (seen.has(id)) continue
    const t = byId.get(id)
    if (!t) continue
    seen.add(id)
    out.push(t)
  }
  return out
}

/**
 * 一个块带不带某个标签。
 * @param tagId 标签块的 id —— **认 id 不认名字**，改名不影响归属的判定。
 */
export function hasTag(block: Block, tagId: string): boolean {
  return tagIdsOf(block).includes(tagId)
}

/** 按名字判断（给查询条件用；内部解析成 id 再查归属） */
export function hasTagName(block: Block, name: string, forest: readonly Block[]): boolean {
  const tag = findTag(forest, name)
  if (!tag) return false
  return hasTag(block, tag.id)
}

/**
 * **从一段正文里切出「刚敲完的那个 `#名字`」**。纯函数，零 DOM。
 *
 * 判据：`#名字` 后面必须**真的跟了分隔符**（空格／中英文标点）。
 *
 * ⚠️ **行尾不算闭合**。这是踩出来的：每敲一个字符都会同步一次，
 *    若把行尾当闭合，`#自` 就会在最边缘的时刻成边 ⇒ 标签变成「自」，
 *    后面接着敲的「动边」留在正文里。必须等用户敲下那个分隔符。
 *
 * ⚠️ `#` 后面必须有至少一个非空白、非 `#` 的字符 —— 光一个 `#` 不成边。
 *
 * @returns 命中则给出名字与区间（区间**不含**分隔符）；否则 `null`
 */
export function trailingHashTag(text: string): { name: string; from: number; to: number } | null {
  /** 分隔类字符：`#名字` 后面跟了它 ⇒ 说明这个名字敲完了 */
  const SEP = /[\s.,;:!?)\]}。，、；：！？）】]/
  const hash = text.lastIndexOf('#')
  if (hash < 0) return null
  const rest = text.slice(hash + 1)
  // `#` 之后不能有空白或再一个 `#`
  if (rest.length === 0 || /^[\s#]/.test(rest)) return null
  const cut = rest.search(SEP)
  // 没有分隔符 ⇒ **还在敲**（哪怕已经在行尾）⇒ 不成边
  if (cut < 0) return null
  const name = rest.slice(0, cut)
  if (name.length === 0) return null
  return { name, from: hash, to: hash + 1 + name.length }
}

/**
 * 打了某个标签的**块 id** 集合（标签的「成员列表」）。
 *
 * ⚠️ 这是**全库扫描**（O(n)）：归属住在块上，没有反向指针，这是派生索引该做的事。
 *    `IndexPort` 已经有一张 `tagMembers` 表，渲染循环与查询里请优先查表。
 */
export function tagMemberIds(tagId: string, forest: readonly Block[]): Set<string> {
  const out = new Set<string>()
  walkForest(forest, (b) => {
    if (hasTag(b, tagId)) out.add(b.id)
  })
  return out
}

/**
 * **指向边**的源块集合：引用（`[[ ]]`）的源块（供反链与「改名传播」共用）。
 *
 * ⚠️ 标签**不在**这里：标签是块级归属，不是一个位点上的边 —— 它没有「另一端在正文哪儿」，
 *    所以改名传播与反链要单独问 `tagIdsOf`（见 `view/editor.ts` 的重画路径）。
 */
export function edgeSourceIds(atoms: readonly Atom[], targetId: string): Set<string> {
  const out = new Set<string>()
  for (const a of atoms) {
    if (a.kind === 'page' && a.target?.id === targetId) out.add(a.blockId)
  }
  return out
}
