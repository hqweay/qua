/**
 * **标签 ＝ 块上的一格分类字段**（`props._tags`，有序的标签块 id 列表）。
 *
 * 判据：标签标的是**整个块**，不是正文里的某一个位置 ⇒ **归属只有这一份**。
 * 「在句子里指某个东西」是引用（`[[ ]]`）的事，不是标签的事。
 *
 * ⚠️ **「归到这块」与「正文里提到它」是两个动作，写两处，互不代替**：
 *   · **归属**（块级，`props._tags`）：无位点，渲染成正文之后的 chip。这是**唯一**
 *     让块成为标签成员、拿到标签声明字段的入口（`fieldRows`／`tagMembers` 只读它）。
 *   · **行内 `#名`**：正文里的一枚 ref run（带 `flavor: '#'`，占 1 格，见 `core/runs.ts`），
 *     指向一个标签类或一条实例。它是一次**提及**，**不写** `_tags` ⇒ 提及不会让宿主变成实例、
 *     也不会给宿主长出字段。
 *   · 两者唯一的重叠：行内那枚提到「这块本来就已经归属的标签」时，chip **让位**不画
 *     （同一个 `#名` 不该在一行里出现两次）。
 *
 * 这个判据推出的四件事：
 *   ① 删字不会顺手摘标签：删掉行内那一枚只是不再在正文里提它，
 *      归属仍在 ⇒ 下一次渲染 chip 落回来。摘标签是一次**显式**动作（面板 ×／命令）。
 *   ② 顺序＝用户打的先后，存在数组里；正文里的提及位置与顺序无关。
 *   ③ 「哪些块打了这个标签」是**派生**的：`tagMemberIds` 扫一遍森林，
 *      或查 `IndexPort` 的 `tagMembers` 表（调用方优先用后者，扫描是 O(n)）。
 *   ④ 写归属的入口只有两个：块标签（`⌥↵`／属性面板／命令）与实例物化（`core/obj.ts`）。
 *      **行内提及不是第三个**——它只插 run。反过来，写归属也不碰正文（不替你删字、
 *      不替你造 chip 的 run：chip 不是 run，它画在标签槽里）。
 *
 * 标签本身仍是**块**：名字住在 `_aliases`（`_lists` 里有 `tag`），归属存 id ⇒ 改名自动传播。
 */
import { uuidv7Hex } from './ids.ts'
import {
  ALIASES_PROP,
  DISPLAY_PROP,
  LISTS_PROP,
  addList,
  hasList,
  prop,
  type Block,
} from './model.ts'
import { walkForest } from './walk.ts'
import { findByAlias, normalizeAlias } from './alias.ts'
import { refRunsOf, textRuns } from './runs.ts'

/** 「这块带着哪些标签」的系统属性（有序 id 列表，pos ＝ 数组下标） */
export const TAGS_PROP = '_tags'

/**
 * 标签名的规范化。
 *
 * ⚠️ 定义在 `core/alias.ts`（页名与标签名共用同一个名字空间）；
 *    这里保留导出只是为了调用方读得通 —— **不要另写一份 trim/lower**。
 */
export const normalizeTag = normalizeAlias

/**
 * 造一个标签块：名字进 `_aliases`，正文只作**描述**（初值可以等于名字）。
 *
 * ⚠️ `_display:'alias'`：新建的标签行头显示名字（叶子），描述仍可在正文里写。
 * ⚠️ 标签块**不占据树上位置**（调用方 append 到森林顶层）：所有读路径都按 id 找它，
 *    位置对身份不承载信息，而所有树操作都会把「住在子树里的标签」当货物搬走。
 */
export function mkTagBlock(name: string): Block {
  const title = name.trim()
  const now = Date.now()
  return {
    id: uuidv7Hex(),
    content: textRuns(title),
    children: [],
    created: now,
    modified: now,
    props: { [ALIASES_PROP]: [title], [LISTS_PROP]: ['tag'], [DISPLAY_PROP]: 'alias', _icon: 'lucide:hash' },
  }
}

/**
 * 按名字找标签块（先序；只认 `_lists` 里有 `tag` 的块）。
 *
 * ⚠️ 名字比较**必须**走 `normalizeTag`：这是「标签名规范化只有一处定义」的落点，
 *    查询条件与 `ensureTag` 共用它，口径不会分叉。
 */
export function findTagByName(forest: readonly Block[], name: string): Block | undefined {
  return findByAlias(forest, name, (b) => hasList(b, 'tag'))
}

/** 在森林里找一个标签块（先序；只认 `tag` 列表，比较走地址规范化） */
function findTag(forest: readonly Block[], name: string): Block | undefined {
  return findByAlias(forest, name, (b) => hasList(b, 'tag'))
}

/**
 * **找到或创建**标签块（幂等，与 journal「一天一个」同一口径）。
 *
 * 返回 `created` / `reused` 是因为三种情况在界面上是三件事：
 *   · 引用已有标签；
 *   · 新建了一个标签；
 *   · **同名块已经存在（页 / 兼位块）⇒ 复用它，只给它加 `tag` 列表**。
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
  // 同名块已存在（有地址、但还没有 tag 列表）⇒ 复用它，不建第二个同名的块
  const existing = findByAlias(forest, name)
  if (existing) {
    addList(existing, 'tag')
    // 第一次成为标签 ⇒ 行头默认显示名字（叶子）；已有显式显示模式的不动
    if (prop(existing, DISPLAY_PROP) === undefined) {
      existing.props = { ...(existing.props ?? {}), [DISPLAY_PROP]: 'alias' }
    }
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
    if (hasList(b, 'tag')) out.push(b)
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
 * `#` 在 `at` 这一格算不算**标签语法的开头**（只看它前面）。
 *
 * 判据只有一条：**URL 的 `#fragment` 不算**（`https://x.dev/#anchor`）。
 *
 * ⚠️ **前面挨着字也算**（`中文#设计`、`C#`）：触发符号要像 `@` 一样「接着打就弹」，
 *    否则用户得先敲一个空格才能叫出标签面板。`C#` 这类正文靠 `Esc` 退出
 *    （面板关掉、字原样留着），而不是靠「前面有没有字」猜用户想不想弹。
 */
export function hashStartAt(text: string, at: number): boolean {
  if (text[at] !== '#') return false
  // URL 的 `#fragment`（`https://x.dev/#anchor`）：整串是个链接，不是标签语法
  if (/[a-z][a-z0-9+.-]*:\/\/\S*$/i.test(text.slice(0, at))) return false
  return true
}

/**
 * **从一段正文里切出「刚敲完的那个 `#名字`」**。纯函数，零 DOM。
 *
 * 判据：`#名字` 后面必须**真的跟了分隔符**（空格／中英文标点）。
 *
 * ⚠️ **行尾不算闭合**。这是踩出来的：每敲一个字符都会同步一次，
 *    若把行尾当闭合，`#自` 就会在最边缘的时刻成边 ⇒ 标签变成「自」，
 *    后面接着敲的「动边」留在正文里。必须等用户敲下那个分隔符。
 *    （唯一的例外是**编辑边界**：回车/离开这一行时 `allowEnd: true`——
 *     那时「还在敲」的可能性已经归零，行尾就是敲完了。）
 *
 * ⚠️ `#` **紧跟在字后面也算**（`中文#名`、`C#`）：触发与转换共用同一份开头判据，
 *    而现在的口径是「接着打就弹」。URL 的 `#fragment` 仍不算。
 *
 * ⚠️ `#` 后面必须有至少一个非空白、非 `#` 的字符 —— 光一个 `#` 不成边。
 *
 * @returns 命中则给出名字与区间（区间**不含**分隔符）；否则 `null`
 */
export function trailingHashTag(
  text: string,
  opts: { allowEnd?: boolean } = {},
): { name: string; from: number; to: number } | null {
  /** 分隔类字符：`#名字` 后面跟了它 ⇒ 说明这个名字敲完了 */
  const SEP = /[\s.,;:!?)\]}。，、；：！？）】]/
  const hash = text.lastIndexOf('#')
  if (hash < 0) return null
  if (!hashStartAt(text, hash)) return null
  const rest = text.slice(hash + 1)
  // `#` 之后不能有空白或再一个 `#`
  if (rest.length === 0 || /^[\s#]/.test(rest)) return null
  const cut = rest.search(SEP)
  if (cut < 0) {
    // 没有分隔符 ⇒ **还在敲**（哪怕已经在行尾）⇒ 不成边；编辑边界除外
    if (!opts.allowEnd) return null
    return { name: rest, from: hash, to: text.length }
  }
  const name = rest.slice(0, cut)
  if (name.length === 0) return null
  return { name, from: hash, to: hash + 1 + name.length }
}

/**
 * 这一块**在正文里露面**了哪些标签 id（按出现位置排序，去重）。
 *
 * 露面 ＝ 行内那枚带 `#` 风味的引用 run（位置跟着用户敲的地方走）。
 * ⚠️ 这是**显示**用的，不是归属：归属看 `tagIdsOf`（`props._tags`）。
 *    两者不一致时的口径见文件头 ①：露面可以比归属先少（删字不摘标签）。
 */
export function inlineTagIdsOf(block: Block): string[] {
  const out: string[] = []
  for (const r of refRunsOf(block.content)) {
    if (r.flavor !== '#' || !r.to) continue
    if (!out.includes(r.to)) out.push(r.to)
  }
  return out
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
 * **指向边**的源块集合：引用（含行内标签露面）的源块（供「改名传播」共用）。
 *
 * ⚠️ 标签的**归属**不在这里（它在 `_tags` 里，见上方 ①）；
 *    但标签的**行内露面**在这里 —— 那是一枚带 `#` 风味的引用 run，名字是渲染时解析的，
 *    改名后也要重画。所以本函数收**全部**引用 run，不只无风味的。
 */
export function edgeSourceIds(forest: readonly Block[], targetId: string): Set<string> {
  const out = new Set<string>()
  walkForest(forest, (b) => {
    for (const r of refRunsOf(b.content)) {
      if (r.to === targetId) out.add(b.id)
    }
  })
  return out
}
