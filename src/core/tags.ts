/**
 * **标签 ＝ 一条指向边**（71.4 选 A：不留第二套正则解析）。
 *
 * 形状：**标签不是一个特殊实体**
 *   · **标签**是一个**块**（`tag` 角色），名字就是它的正文 —— 不是字符串，也不是新实体；
 *   · **打标签**＝插一个 `tag` 行内原子，它的 `target` 指向那个标签块。
 *     ⇒ 边在**正文里**（占位符 U+FFFC）⇒ 删掉那几个字，边随之消失，不留孤儿。
 *
 * 为什么必须是边而不是文本：
 *   ① 改名传播 —— 标签块改名，所有 `#旧名` 跟着变（复用 `core/ref.ts` 的解析）；
 *   ② 反链免费 —— 「哪些块打了这个标签」＝ 标签块的入向边，不写第二套扫描；
 *   ③ 只有一处认 `#tag` —— 以前 `insert-tag` 写文本、`hasTag` 正则扫文本、渲染再正则包
 *      一层 span，三处各认一次。现在只有本文件认。
 *
 * ⚠️ 不做字段声明（`_schema`）与标签继承（`_is`）—— 两者都不改数据形状，
 *    属于「标签能声明哪些字段」那一层，明确后置。
 * ⚠️ 「在正文里敲 `#foo` 自动成边」**当前不做**（只走 `insert-tag` 命令）。
 *    将来要加，接缝在 `view/editor.ts` 的 `syncFromDom`：在那里扫一次文本并调用 `ensureTag`
 *    即可，与命令路径共用同一个函数，不会分叉成第二条解析。
 */
import { uuidv7Hex } from './ids.ts'
import { addRole, hasRole, type Block, type Role } from './model.ts'
import { walkForest } from './walk.ts'
import { findByAlias, isAddressable, normalizeAlias } from './alias.ts'
import type { Atom } from './annotations.ts'

/**
 * 标签块的角色：标签 ＝ 一个带 `tag` 角色的普通块。
 *
 * ⚠️ 它**不占据树上的位置**（必须在顶层）——因为它只是指向边的另一端。
 *    位置属于内容，名字属于身份：所有读路径都按 id 找标签（不按位置），
 *    而所有树操作（缩进／拖拽／删除）都会把一个"住在子树里的标签"当货物搬走。
 */
export const TAG_ROLE: Role = 'tag'

/**
 * 标签名的规范化。
 *
 * ⚠️ 定义在 `core/alias.ts`（页名与标签名共用同一个名字空间）；
 *    这里保留导出只是为了调用方读得通 —— **不要另写一份 trim/lower**。
 */
export const normalizeTag = normalizeAlias

/** 造一个标签块（名字就是正文；图标走系统属性，70.2） */
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
 * ⚠️ 名字比较**必须**走 `normalizeTag`：这是「标签名规范化只有一处定义」的落点（71.4 边界），
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

/**
 * 一个块当前带着哪些标签块（**按边判定**，不是扫文本）。
 *
 * ⚠️ 返回**标签块本身**（活引用），不是名字 —— 要 id 取 `.id`，要显示名走 `refTitle`（会跟着改名）。
 * ⚠️ 同一标签打多次只算一条；顺序按**正文里出现的先后**（边是有位点的）。
 */
export function tagsOf(blockId: string, forest: readonly Block[], atoms: readonly Atom[]): Block[] {
  const byId = new Map<string, Block>()
  for (const t of allTags(forest)) byId.set(t.id, t)
  const out: Block[] = []
  const seen = new Set<string>()
  for (const a of atoms) {
    if (a.kind !== 'tag' || a.blockId !== blockId || !a.target) continue
    const t = byId.get(a.target.id)
    if (!t || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}

/**
 * 一个块带不带某个标签（`hasTag` 的新实现：**查边**）。
 * @param tagId 标签块的 id —— **认 id 不认名字**（71.3），改名不影响边的判定。
 */
export function hasTagEdge(blockId: string, tagId: string, atoms: readonly Atom[]): boolean {
  return atoms.some((a) => a.kind === 'tag' && a.blockId === blockId && a.target?.id === tagId)
}

/** 按名字判断（给查询条件用；内部解析成 id 再查边） */
export function hasTagName(blockId: string, name: string, forest: readonly Block[], atoms: readonly Atom[]): boolean {
  const want = normalizeTag(name)
  const tag = findTag(forest, want)
  if (!tag) return false
  return hasTagEdge(blockId, tag.id, atoms)
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
 * 这就是「标签页的反链」：反链＝指向它的入向边，标签成员＝指向标签块的 tag 边。
 * 两者**数据上同构**，区别只在呈现（`[[名]]` vs `#名`）—— 见 AK6 的边 role 表。
 */
export function tagMemberIds(tagId: string, atoms: readonly Atom[]): Set<string> {
  const out = new Set<string>()
  for (const a of atoms) {
    if (a.kind === 'tag' && a.target?.id === tagId) out.add(a.blockId)
  }
  return out
}

/**
 * **指向边**的源块集合：引用与标签都算（供反链与「改名传播」共用）。
 *
 * 为什么需要它：`backrefsOf` 原先只认 `kind === 'page'` ⇒ 标签边不是入向边
 * ⇒ 「标签块的反链」永远是空的。两类边同构，不该在扫描时分别对待。
 */
export function edgeSourceIds(atoms: readonly Atom[], targetId: string): Set<string> {
  const out = new Set<string>()
  for (const a of atoms) {
    if ((a.kind === 'page' || a.kind === 'tag') && a.target?.id === targetId) out.add(a.blockId)
  }
  return out
}
