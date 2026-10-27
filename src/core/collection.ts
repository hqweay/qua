/**
 * **集合组件**：一个块，装一组有序的块 id（收藏／阅读清单／项目看板）。
 *
 * 三条判据：
 *   1. **不是 `children`**：集合里的块是**引用**，不是真实子块；否则会污染
 *      `rootOf`／反链来源根／折叠三角／子树复制。
 *   2. **零级联**：删集合不删里面的块；删块不删引用（留悬空项，块恢复后自动回来）。
 *   3. **配置进块属性**：`_items` 是集合自己的内容，复制集合时跟着走；
 *      它不是身份属性（地址/露面/归属/挂载那类），所以**不**进 `IDENTITY_PROPS`。
 *
 * 这个块是 `core/collection-widget` 类型；它在槽里是一张 large 卡，
 * 在正文里是一行只读摘要（`body: 'row'`）——两处读同一格 `_items`，一源多视。
 */
import { blockTypeOf, mkBlock, type Block } from './model.ts'
import type { FindBlock } from './ref.ts'
import { COLLECTION_TYPE } from './types.ts'

/** `_items`：集合块上的一格（有序引用） */
export const COLLECTION_PROP = '_items'

/** 读一格 `_items`：形状不合法就当作空（不抛、不修） */
export function collectionItems(b: Block | undefined): string[] {
  const raw = b?.props?.[COLLECTION_PROP]
  if (!Array.isArray(raw)) return []
  return raw.filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * 写一格 `_items`：去重、保序、空集合删掉这一格。
 *
 * 空数组与「没有这一格」是同一个意思；留一个 `[]` 会让「有没有配置」出现两份答案。
 */
export function setCollectionItems(b: Block, items: readonly string[]): void {
  const props = { ...(b.props ?? {}) }
  const next = [...new Set(items.filter((id): id is string => typeof id === 'string' && id !== ''))]
  if (next.length === 0) delete props[COLLECTION_PROP]
  else props[COLLECTION_PROP] = next
  if (Object.keys(props).length === 0) delete b.props
  else b.props = props
}

/**
 * 把一条引用移到新位置；`to` 是**当前列表**里的插入下标（含被拖的那一项）。
 *
 * 先摘再插，所以「往后拖」时目标下标要减一；与侧槽卡片的 `moveCard` 同一条口径。
 * 没有实际移动（同一位置、找不到、越界夹取后原位）⇒ `null`，调用方不该记一次撤销。
 */
export function moveCollectionItem(
  items: readonly string[],
  blockId: string,
  to: number,
): string[] | null {
  const from = items.indexOf(blockId)
  if (from < 0) return null
  const next = [...items]
  next.splice(from, 1)
  const at = Math.max(0, Math.min(to > from ? to - 1 : to, next.length))
  if (at === from) return null
  next.splice(at, 0, blockId)
  return next
}

/** 这一块是不是集合组件（按类型，不看它被放在哪） */
export function isCollectionBlock(b: Block | undefined): boolean {
  return b !== undefined && blockTypeOf(b) === COLLECTION_TYPE
}

/**
 * 造一个空集合块（森林顶层；调用方决定插到哪）。
 *
 * 名字进 `_aliases`（它是卡片的标题），不进 `_lists`——集合是组件，不是页/标签。
 * 空名字时也保留一个兜底标题，避免卡片出现「无标题」。
 */
export function mkCollectionBlock(name: string): Block {
  const title = name.trim()
  const props: Record<string, unknown> = { _type: COLLECTION_TYPE }
  if (title !== '') props._aliases = [title]
  return mkBlock('', { props })
}

/**
 * **摘要的两个数**：总条数 ／ 还在的条数。
 *
 * 为什么两个数都要：悬空引用是**保留**的（设计 §4「零级联」——块删了引用留着，
 * 块恢复后它自己回来）。只报「还在的」会让「收藏里有一条指向已删块的引用」
 * 这件事彻底看不见；只报总数则摘要会说「3 条」而正文里只画得出 2 行。
 * 两个数不相等 ⇒ 摘要明说「3 条（1 条已删）」，而不是替用户隐藏掉那一格。
 *
 * ⚠️ 目标是**按 id 查活块**（`find`），不是扫森林：摘要在正文每行渲染时都要算，
 *    让它顺带扫一遍全库就是把「画一行」变成 O(库)。
 */
export interface CollectionSummary {
  total: number
  alive: number
}

export function collectionSummary(b: Block, find: FindBlock): CollectionSummary {
  const items = collectionItems(b)
  let alive = 0
  for (const id of items) if (find(id)) alive++
  return { total: items.length, alive }
}
