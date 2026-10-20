/**
 * 收藏 ＝ **命名容器块 ＋ 一列块引用**。
 *
 * 判据（照原文，一条都不能省）：
 *   1. **不是新实体**：容器就是一个普通块，内部存的是「引用边 + 顺序位」——
 *      实现形体 ＝ 系统属性 `_favorites` 上的**有序块 id 列表**；
 *   2. **不依赖被收藏块本身的状态**：被收藏的块上**没有**任何 `favorite` 标记，
 *      它甚至不知道自己被收藏了；
 *   3. **删掉容器块，被收藏的数据不受影响**（解耦）——容器只存 id，不持有块；
 *   4. **代价登记**：同一块可被多个容器收藏，顺序各自独立；
 *      「某个块被收藏在哪」只能查引用边，不能 O(1) 读属性。
 *
 * ⚠️ 为什么是 id 列表而不是真的「边表」：现在还没有内核事务与边表，
 *   但**形状**必须是「有序引用」，不能是「页列表」——后者会把"收藏"退化成"全部页"，
 *   那正是这一条要修掉的既有偏差（2026-10-20）。
 * ⚠️ 悬空引用（被收藏的块后来被删了）**不静默丢弃**，由 `pruneFavorites` 显式清掉，
 * 且读取时按「还活着的」过滤（承 64 ：错指要看得见，不能假装存在）。
 */
import { findInForest, findPath } from './tree.ts'
import { prop, type Block, type BlockProps } from './model.ts'

/** 收藏容器块上的系统属性：有序的块 id 列表 */
export const FAVORITES_PROP = '_favorites'

/** 读一个容器的收藏列表（**不校验存活**，原件返回；校验用 `liveFavorites`） */
export function favoriteIds(container: Block): string[] {
  const raw = prop<unknown>(container, FAVORITES_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/** 收藏列表里**仍然存在**的那些（按原顺序，去掉悬空与重复） */
export function liveFavorites(forest: readonly Block[], container: Block): Block[] {
  const seen = new Set<string>()
  const out: Block[] = []
  for (const id of favoriteIds(container)) {
    if (seen.has(id)) continue // 去重：同一块不会被同一个容器收藏两次
    const b = findInForest(forest, id)
    if (!b) continue // 悬空：容器里留着记录，但这里不渲染
    seen.add(id)
    out.push(b)
  }
  return out
}

/** 往容器末尾加一个收藏（幂等：已收藏就不动，返回 false） */
export function addFavorite(container: Block, id: string): boolean {
  const ids = favoriteIds(container)
  if (ids.includes(id)) return false
  // 自引用没有意义（收藏自己所在的容器）
  if (id === container.id) return false
  writeFavorites(container, [...ids, id])
  return true
}

/** 从容器里移除（返回是否真的移除了） */
export function removeFavorite(container: Block, id: string): boolean {
  const ids = favoriteIds(container)
  const next = ids.filter((x) => x !== id)
  if (next.length === ids.length) return false
  writeFavorites(container, next)
  return true
}

/**
 * 移动一位（`delta = -1` 上移 / `+1` 下移）。
 * **顺序位是收藏自己的属性**的代价登记）：同一块在两个容器里顺序互不影响。
 */
export function moveFavorite(container: Block, id: string, delta: number): boolean {
  const ids = favoriteIds(container)
  const i = ids.indexOf(id)
  if (i < 0) return false
  const j = i + delta
  if (j < 0 || j >= ids.length) return false
  const next = [...ids]
  next.splice(i, 1)
  next.splice(j, 0, id)
  writeFavorites(container, next)
  return true
}

/**
 * 清掉**悬空的**收藏引用（被收藏的块已经不在森林里了）。
 * 返回清掉的条数；只改传进来的这个容器。
 */
export function pruneFavorites(forest: readonly Block[], container: Block): number {
  const ids = favoriteIds(container)
  const alive = ids.filter((id) => findInForest(forest, id) !== undefined)
  if (alive.length === ids.length) return 0
  writeFavorites(container, alive)
  return ids.length - alive.length
}

/**
 * 块所在的**收藏容器**（用于 UI 上的「已收藏」态）。
 *
 * ⚠️ 按的代价登记：这是**扫描**（查引用边），不是 O(1) 读属性——
 *   同一个块可能同时出现在多个容器里，所以返回数组。
 */
export function containersHolding(forest: readonly Block[], id: string): Block[] {
  return forest.filter((b) => favoriteIds(b).includes(id))
}

/** 找一个容器（按 id）；`undefined` ＝ 不存在 */
export function findContainer(forest: readonly Block[], containerId: string): Block | undefined {
  return findInForest(forest, containerId)
}

/**
 * 库里的**收藏容器块**（按森林顺序）。
 *
 * 判据：容器 ＝ 带 `favorites` **角色**的普通块（不是新实体）。
 * ⚠️ 用角色而不是「有没有 `_favorites` 属性」来认：空容器也该出现在左槽里
 *   （用户刚建、还没收藏东西），否则它会「看不见也删不掉」。
 */
export function favoritesContainers(forest: readonly Block[]): Block[] {
  return forest.filter((b) => b.role === 'favorites')
}

/**
 * 容器块的**显示名**：容器是「命名容器块」，名字 = 它自己的 `text`
 * 与页同一口径：块的名字就是正文，；空则交给调用方兜底）。
 */
export function containerTitle(container: Block): string {
  return container.text
}

/** 容器在森林里的路径（面包屑／诊断用；派生，不物化） */
export function containerPath(forest: readonly Block[], containerId: string): Block[] {
  return findPath(forest, containerId) ?? []
}

/** 写回属性（**成对引用边 + 顺序位**就是这一个列表；空列表 = 清空属性） */
function writeFavorites(container: Block, ids: string[]): void {
  const props: BlockProps = { ...(container.props ?? {}) }
  if (ids.length === 0) delete props[FAVORITES_PROP]
  else props[FAVORITES_PROP] = ids
  container.props = Object.keys(props).length === 0 ? undefined : props
}
