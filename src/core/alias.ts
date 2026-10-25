/**
 * **地址**：一个块用什么名字被找到（页名、标签名共用同一个名字空间）。
 *
 * 口径（别名 ＝ 唯一地址）：
 *   · 地址住在 `props._aliases`（0..N，**首个是主名**），与正文（`text`）分离：
 *     地址负责「找到」，正文负责「描述」；
 *   · **每个别名全局唯一**（规范化后）——页与标签不再各有一套名字空间；
 *   · 归一化（分段 trim、丢空段、大小写折叠）**只在本文件定义一次**，所有查找都走它；
 *   · `/` 只是名字里的路径分隔符：它**不产生父子关系**、不碰 `parent`／`pageOf`，
 *     存在的收益是「全名唯一、显示叶子」——`[[A/B]]` 精确，行头只显示 `B`。
 *
 * ⚠️ 归一化只影响**比较**，不写回：`# 设计 ` 找到的是「设计」，块上的 `_aliases`
 *    不会被改写。
 * ⚠️ **`text` 不在地址空间里**：只是正文恰好等于某个名字，不构成「这个块也叫那个名」。
 *    这条是地址模型最重要的一处分界：地址只有 `_aliases` 一个来源。若让正文也参与，
 *    那么「敲字」就变成了「重命名」—— 块尾回车、退格都会顺手改掉它的地址。
 */
import { ALIASES_PROP, aliasesOf, listsOf, primaryAliasOf, type Block } from './model.ts'
import { plainText } from './runs.ts'
import { walkForest } from './walk.ts'

/** 旧落盘键（v13 及以前）。新代码**不读**它；形状校验把它判成 corrupt。 */
export const LEGACY_ALIAS_PROP = '_alias' as const

/**
 * 地址的规范化 —— **唯一定义点**（tag 名、页名、`[[ ]]` 查找共用）。
 *
 * 按 `/` 分段逐段 trim 并丢掉空段：`A / B` → `a/b`，`a//b` → `a/b`。
 * 丢空段而不是保留，是因为空段在显示上不可见、在比较上却会分出一个新地址。
 */
export function normalizeAlias(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg !== '')
    .join('/')
}

/**
 * 名字的**叶子段**（原始大小写，用于显示）。
 *
 * 显示只取最后一段：`A/B` 这一行头要显示 `B`（全名仍用于解析）。
 * 路径结尾是 `/`（或整串为空）时没有叶子 ⇒ 退回原串，让调用方看到「名字就是它」。
 */
export function aliasLeaf(name: string): string {
  const raw = name.trim()
  const at = raw.lastIndexOf('/')
  if (at < 0) return raw
  const leaf = raw.slice(at + 1).trim()
  return leaf === '' ? raw : leaf
}

/** 主名（**原始字符串**；从 `model.ts` 转出，调用方不必知道存储位） */
export { primaryAliasOf }

/** 全部地址（**规范化后的副本**，与 `_aliases` 同序） */
export function addressesOf(b: Block): string[] {
  return aliasesOf(b).map(normalizeAlias).filter((a) => a !== '')
}

/** 主地址（规范化后的比较键） */
export function addressOf(b: Block): string {
  return normalizeAlias(primaryAliasOf(b))
}

/**
 * 这一块**被引用时**的显示名：主名叶子 > 正文。
 *
 * ⚠️ 与 `refTitle` 的分工：本函数不兜底「无标题」，因为它是「这块有什么名字」的
 *    纯派生；要不要兜底文案是呈现层的事。正文为空 ⇒ 返回空串。
 * ⚠️ `_display` **不参与**：它只决定这一行自己的头怎么显示；引用／反链永远叫主名叶子。
 */
export function displayNameOf(b: Block): string {
  return aliasLeaf(primaryAliasOf(b)) || plainText(b.content).trim()
}

/** 能被地址找到的块 —— **只看 `_aliases`**，不再看页／标签列表。 */
export function isAddressable(b: Block): boolean {
  return aliasesOf(b).length > 0
}

/**
 * 先序第一个地址命中的块 —— **比较口径的唯一落点**。
 *
 * 匹配的是**块的全部别名**（任一）；`accept` 只收窄「哪些块参与」，
 * 不让调用方另写一套比较（两套比较就会「活着找不到、删了却找得到」）。
 */
function firstByAddress(
  forest: readonly Block[],
  name: string,
  accept: (b: Block) => boolean,
): Block | undefined {
  const want = normalizeAlias(name)
  if (want === '') return undefined
  let found: Block | undefined
  walkForest(forest, (b) => {
    if (!accept(b) || !addressesOf(b).includes(want)) return
    found = b
    return false
  })
  return found
}

/**
 * 按地址找块（先序第一个命中）。
 *
 * `accept` 让调用方收窄范围（例如「只找带 tag 列表的」），但**比较永远走同一个规范化**。
 */
export function findByAlias(
  forest: readonly Block[],
  name: string,
  accept: (b: Block) => boolean = isAddressable,
): Block | undefined {
  return firstByAddress(forest, name, accept)
}

/**
 * 改地址前的查重。命中已有地址（森林里的**活块**，不含自己）⇒ 返回冲突块。
 *
 * 比较的是**每一块的每一个别名**：只比主名会漏掉「第二别名撞了主名」这种形状，
 * 而那种冲突在解析时同样是「永远只能找到一个」。
 *
 * ⚠️ 回收站里的同名块**不算冲突**：那是「复活还是新建」的问题，由调用方决定。
 *    把两者混在一起，用户删掉一个标签之后就再也不能建同名的了。
 */
export function aliasConflict(forest: readonly Block[], b: Block, name: string): Block | undefined {
  const want = normalizeAlias(name)
  if (want === '') return undefined
  let found: Block | undefined
  walkForest(forest, (x) => {
    if (!isAddressable(x) || x.id === b.id) return
    if (!addressesOf(x).includes(want)) return
    found = x
    return false
  })
  return found
}

/**
 * 给这一块加一个地址（追加；规范化去重；空串拒绝）。
 *
 * 只动这一个块，**不查重**：唯一性是写入侧的约束，由 `claimAlias`／`renameAlias`
 * 统一问一次。这样「先问、再决定写什么」的调用方能拿同一个答案走各自的失败处理。
 */
export function addAlias(b: Block, name: string): boolean {
  const raw = name.trim()
  const want = normalizeAlias(raw)
  if (want === '') return false
  if (addressesOf(b).includes(want)) return false
  b.props = { ...(b.props ?? {}), [ALIASES_PROP]: [...aliasesOf(b), raw] }
  return true
}

/**
 * 能不能删掉这个别名（**不变量：列表非空 ⇒ 至少有一个名字**）。
 *
 * 单独留一个判据是给「别名编辑器」用的：它要在按钮上先回答「这条能不能删」，
 * 而不是等 `removeAlias` 返回 false 再猜原因。
 */
export function canRemoveAlias(b: Block): boolean {
  return aliasesOf(b).length > 1 || listsOf(b).length === 0
}

/**
 * 删掉一个别名（主名也能删）。
 *
 * ⚠️ 删到 0 个且列表非空 ⇒ **拒绝**：那会得到「在页列表里出现、但没有任何地址」的块，
 *    而这种块既不能被 `[[ ]]` 引用、也不能被标签解析找到 —— 一个没有名字的身份。
 *    调用方要先 `removeList` 清空列表，再删最后一个名字。
 */
export function removeAlias(b: Block, name: string): boolean {
  const aliases = aliasesOf(b)
  const want = normalizeAlias(name)
  const at = aliases.findIndex((a) => normalizeAlias(a) === want)
  if (at < 0) return false
  if (aliases.length === 1 && listsOf(b).length > 0) return false
  const next = aliases.filter((_, i) => i !== at)
  const props = { ...(b.props ?? {}) }
  if (next.length === 0) delete props[ALIASES_PROP]
  else props[ALIASES_PROP] = next
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
  return true
}

/**
 * 把已有别名设成主名（移到首位；**不新增**）。
 *
 * 只移动不新增：调用方要的是「在这几个名字里挑一个当主名」，
 * 名字不存在时返回 false 比偷偷造一个新地址安全。
 */
export function setPrimaryAlias(b: Block, name: string): boolean {
  const aliases = aliasesOf(b)
  const want = normalizeAlias(name)
  const at = aliases.findIndex((a) => normalizeAlias(a) === want)
  if (at <= 0) return false
  const next = [aliases[at]!, ...aliases.filter((_, i) => i !== at)]
  b.props = { ...(b.props ?? {}), [ALIASES_PROP]: next }
  return true
}

/**
 * **应用**一次别名替换（**不查重**）。
 *
 * 查重是 `claimAlias`／读门面 `resolveAlias` 的事；写路径由此收窄到「只动这一个块」，
 * 调用方才能把它放进事务里 —— 事务内不再扫森林（读面按 id／按名取数），
 * 也没有必要重扫：调用方查过重才走到这里。
 *
 * 语义与 `renameAlias` 的应用段相同：旧名在别名表里 ⇒ **原位替换**（块内同名去重）；
 * 旧名不在 ⇒ 追加（调用方表达的是「我要这个地址」，而不是「改那个不存在的」）。
 */
export function writeRename(b: Block, oldName: string, newName: string): void {
  const raw = newName.trim()
  if (normalizeAlias(raw) === '') return
  const aliases = aliasesOf(b)
  const oldWant = normalizeAlias(oldName)
  const at = aliases.findIndex((a) => normalizeAlias(a) === oldWant)
  if (at < 0) {
    addAlias(b, raw)
    return
  }
  const want = normalizeAlias(raw)
  const next: string[] = []
  for (let i = 0; i < aliases.length; i++) {
    if (i === at) next.push(raw)
    // 新名恰好已经是同一个块上的另一个别名 ⇒ 只保留被改的那一格，避免块内重复
    else if (normalizeAlias(aliases[i]!) !== want) next.push(aliases[i]!)
  }
  b.props = { ...(b.props ?? {}), [ALIASES_PROP]: next }
}

/**
 * 改一个别名（**保留它在数组里的位置**）。
 *
 * 先 claim 再应用：撞车时一个字节都不写，返回冲突块。
 * ⚠️ 旧名不存在 ⇒ 追加新名（调用方表达的是「我要这个地址」，而不是「删掉那个不存在的」）。
 *    这条选择让「块还没有名字时改名」不需要第二个分支。
 */
export function renameAlias(
  forest: readonly Block[],
  b: Block,
  oldName: string,
  newName: string,
): { ok: true } | { ok: false; conflict: Block } {
  // 新名即将写进 `_aliases` ⇒ 一律按「要占地址」查重（块此刻可能还没有名字）
  const claim = claimAlias(forest, b, newName, true)
  if (!claim.ok) return claim
  writeRename(b, oldName, newName)
  return { ok: true }
}

/**
 * **给这个块一个名字**：冲突就拒绝。
 *
 * 为什么要有它，而不是让每处自己调 `aliasConflict`：地址唯一性是「写入侧」的约束，
 * 而写入地址的路径会随功能增长（改名、加列表、打字提交、将来的重命名对话框…）。
 * 每加一条路径就复制一遍「查重 ⇒ 拒绝」，漏一条就静默造出两个同地址的块 ——
 * 而那两个块里的第二个**再也引用不到**，用户以为自己只是改了个名字。
 *
 * 它**不写任何东西**，只回答「能不能占」：这样「先问、再决定写什么」的调用方
 * 可以拿同一个答案去走各自的失败处理（提示、回滚、询问用户），而判据只有这一份。
 *
 * ⚠️ 只有**占地址的块**才查：内容块不在地址空间里，拿它跟页名比会让
 *    「正文恰好等于某个页名」的普通块再也写不进正文。
 * ⚠️ 「占不占地址」按 `它现在是否已经占着`（`isAddressable`）回答。有一条路径是在
 *    **加列表之前**问的（此刻它还没有名字，但这次提问问的正是「加完之后能不能占」），
 *    那种情况要由调用方显式告知 —— 否则加列表就跳过了查重。
 * ⚠️ 回收站里的同名块不算冲突：那是「复活还是新建」的问题，由调用方问用户。
 */
export function claimAlias(
  forest: readonly Block[],
  b: Block,
  name: string,
  occupiesAddress: boolean = isAddressable(b),
): { ok: true } | { ok: false; conflict: Block } {
  if (!occupiesAddress) return { ok: true }
  const conflict = aliasConflict(forest, b, name)
  return conflict ? { ok: false, conflict } : { ok: true }
}

/** 一次占多个地址：逐个问，返回**第一个**冲突（给「生成一组别名」的入口用） */
export function claimAliases(
  forest: readonly Block[],
  b: Block,
  names: string[],
): { ok: true } | { ok: false; conflict: Block } {
  for (const name of names) {
    // 这组名字即将写进 `_aliases` ⇒ 一律按「要占地址」查重，不看它此刻有没有名字
    const claim = claimAlias(forest, b, name, true)
    if (!claim.ok) return claim
  }
  return { ok: true }
}
