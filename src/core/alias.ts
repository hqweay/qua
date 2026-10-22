/**
 * **地址**：一个块用什么名字被找到（页名、标签名共用同一个名字空间）。
 *
 * 口径（方案 A）：
 *   · 地址（`_alias`）与正文（`text`）分离：地址负责「找到」，正文原样保留；
 *   · **同名必同一块**——页与标签不再各有一套名字空间；
 *   · 归一化（去空白、大小写折叠）**只在本文件定义一次**，所有查找都走它。
 *
 * ⚠️ 归一化只影响**比较**，不写回：`# 设计 ` 找到的是「设计」，块上的正文不会被改写。
 * ⚠️ 派生地址（`aliasOf`）在没写 `_alias` 时回落到正文 —— 首版一个块一个名字，
 *    `_alias` 是留给「地址与正文不同」的显式声明，不是第二份必须同步的真相。
 */
import { DELETED_AT_PROP, hasRole, prop, writeBlockText, type Block } from './model.ts'
import { walkForest } from './walk.ts'

/** 地址属性（系统属性；用户不可见） */
export const ALIAS_PROP = '_alias'

/** 地址的规范化 —— **唯一定义点**（tag 名、页名、`[[ ]]` 查找共用） */
export function normalizeAlias(name: string): string {
  return name.trim().toLowerCase()
}

/** 块的地址（原样，未规范化）：显式 `_alias` 优先，否则就是正文 */
export function aliasOf(b: Block): string {
  const raw = prop<unknown>(b, ALIAS_PROP)
  return typeof raw === 'string' && raw.trim() !== '' ? raw : b.text
}

/** 块的地址（规范化后的比较键） */
export function addressOf(b: Block): string {
  return normalizeAlias(aliasOf(b))
}

/**
 * 能被地址找到的块 —— **页与标签**。
 *
 * `schema` 块的正文是字段显示名（允许重名），不进地址空间；
 * 普通内容块也没有地址（它靠块 id 被引用）。
 */
export function isAddressable(b: Block): boolean {
  return hasRole(b, 'page') || hasRole(b, 'tag')
}

/**
 * 先序第一个地址命中的块 —— **比较口径的唯一落点**。
 *
 * 活森林与回收站都走这里：两个名字空间用的是同一套地址（同名必同一块），
 * 判据分叉就会出现「活着找不到、删了却找得到」这种自相矛盾。
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
    if (!accept(b) || addressOf(b) !== want) return
    found = b
    return false
  })
  return found
}

/**
 * 按地址找块（先序第一个命中）。
 *
 * `accept` 让调用方收窄范围（例如「只找带 tag 角色的」），但**比较永远走同一个规范化**。
 */
export function findByAlias(
  forest: readonly Block[],
  name: string,
  accept: (b: Block) => boolean = isAddressable,
): Block | undefined {
  return firstByAddress(forest, name, accept)
}

/**
 * 在回收站里按地址找（复活前的查询）。
 *
 * 与 `findByAlias` 的差别只有**搜哪儿**：地址不会因为块被删掉就属于别人。
 * 这正是「再打同名标签时该问一句『要不要复活那块』」的依据。
 */
export function findInTrash(trash: readonly Block[], name: string): Block | undefined {
  return firstByAddress(trash, name, isAddressable)
}

/**
 * 回收站里同地址的块（给「再打同名标签」时的询问用）。
 *
 * 与 `findInTrash` 是同一个查询的两个叫法：一个是复活前自己找、一个是拿去给人看
 * 「有这个已删除的同名块」。两个名字必须同判据，所以这里直接委托，不另写一遍比较。
 */
export function trashByAddress(trash: readonly Block[], name: string): Block | undefined {
  return findInTrash(trash, name)
}

/** 清掉删除标记（复活时用）：属性袋不留空壳，否则「有没有属性」会有两份答案 */
function clearDeletedAt(b: Block): void {
  if (b.props === undefined || !(DELETED_AT_PROP in b.props)) return
  const props = { ...b.props }
  delete props[DELETED_AT_PROP]
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
}

/**
 * 从回收站复活一个块（连同子树）：接回森林顶层，清掉删除标记。返回是否成功。
 *
 * ⚠️ 接回的是**森林顶层**，不是原来的父块：原父块可能已经不存在了，而「复活」要保证
 *    至少回到能看见、能再拖回去的地方。这是诚实的降级 —— 位置可以再摆，身份丢了接不回来。
 *    （身份块本来就要求住在顶层，这一条对它们没有任何损失。）
 * ⚠️ 森林里已经有这个 id 时**不再挂第二份**：撤销可能已经把同一棵子树接回去了，
 *    同一个块出现两次会让「改一处、另一处也变了」变成难查的 bug。
 */
export function reviveFromTrash(forest: Block[], trash: Block[], blockId: string): boolean {
  const i = trash.findIndex((b) => b.id === blockId)
  if (i < 0) return false
  const [b] = trash.splice(i, 1)
  clearDeletedAt(b!)
  let alive = false
  walkForest(forest, (x) => {
    if (x.id !== b!.id) return
    alive = true
    return false
  })
  if (!alive) forest.push(b!)
  return true
}

/**
 * 改地址前的查重。命中已有地址（森林里的**活块**，不含自己）⇒ 返回冲突块。
 *
 * ⚠️ 回收站里的同名块**不算冲突**：那是「复活还是新建」的问题，由调用方决定。
 *    把两者混在一起，用户删掉一个标签之后就再也不能建同名的了。
 */
export function aliasConflict(forest: readonly Block[], b: Block, name: string): Block | undefined {
  const want = normalizeAlias(name)
  if (want === '') return undefined
  let found: Block | undefined
  walkForest(forest, (x) => {
    if (!isAddressable(x) || addressOf(x) !== want) return
    if (x.id === b.id) return
    found = x
    return false
  })
  return found
}

/**
 * 给一个块写显式地址。
 *
 * ⚠️ 只写地址、不动正文：地址与正文是两个东西（正文可能带大小写与空白）。
 * ⚠️ 违反「同名必同一块」的写入由调用方先查 `findByAlias` 再决定（合并/复用/拒绝）。
 */
export function setAlias(b: Block, name: string): void {
  b.props = { ...(b.props ?? {}), [ALIAS_PROP]: name }
}

/**
 * 改地址 ＋ 同步正文。
 *
 * 撞车（森林里已有别的块用这个地址）⇒ **拒绝**，一个字节都不写，返回冲突块。
 * 判据：同名必同一块。造出两个同地址的块，`[[名字]]` 就永远只能指到其中一个，
 * 另一个再也引用不到 —— 而用户以为自己只是改了个名字。
 *
 * ⚠️ 拒绝时**不改正文**：正文与地址是一起的，只改正文会让「显示的名字」
 *    与「能被找到的名字」分叉。
 * ⚠️ **回收站里的同名块不算冲突**：那是「复活还是新建」的问题，由调用方问用户。
 * ⚠️ 只有**占地址的块**（页／标签）才查重：内容块本来就不在地址空间里，
 *    拿它去跟页名比会让「正文恰好等于某个页名」的普通块再也写不进正文。
 */
export function renameBlock(
  forest: readonly Block[],
  b: Block,
  name: string,
): { ok: true } | { ok: false; conflict: Block } {
  if (isAddressable(b)) {
    const conflict = aliasConflict(forest, b, name)
    if (conflict) return { ok: false, conflict }
  }
  writeBlockText(b, name)
  const raw = prop<unknown>(b, ALIAS_PROP)
  if (typeof raw === 'string' && raw.trim() !== '') setAlias(b, name)
  return { ok: true }
}
