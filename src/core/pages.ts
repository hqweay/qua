/**
 * **页块**的构造与「找到或创建」。
 *
 * 页不是一个类型，只是块上加了一格 `page` 露面（`_lists`）＋ 一个地址（`_aliases`）。
 * 这里把「新建入口」需要的两件事收在一起：
 *   · 空页天生带一个空首子块 —— 页名行展示名字，没有子块就没有写正文的地方；
 *   · 「按名字建页」优先复用已有地址（同一地址空间），只补 `page` 露面。
 *
 * ⚠️ **落点由调用方给**：命令层的「新建页」、`@` 无匹配时的当场建页都落在森林顶层；
 *    落点不是页的定义（页可以住在任何位置，`标记为页` 仍然原地）。
 * ⚠️ 与 `ensureTag` 同一判据：名字解析只走 `findByAlias`，不另写一份 trim/规范化。
 */
import { findByAlias } from './alias.ts'
import type { Tx } from './kb/types.ts'
import {
  ALIASES_PROP,
  DISPLAY_PROP,
  LISTS_PROP,
  addList,
  hasList,
  listsOf,
  mkBlock,
  prop,
  type Block,
} from './model.ts'
import { t } from './msg.ts'

/** 一个空页块：正文空（描述）、名字进 `_aliases`、身份是 `_lists:['page']`。 */
export function mkPageBlock(name?: string): Block {
  const b = mkBlock('')
  const title = (name ?? '').trim()
  const alias = title === '' ? t('ui.page.untitledAlias', { id: b.id.slice(-6) }) : title
  return {
    ...b,
    children: [mkBlock('')],
    props: { [ALIASES_PROP]: [alias], [LISTS_PROP]: ['page'], [DISPLAY_PROP]: 'alias', _icon: 'lucide:file' },
  }
}

/** 名字解析的窄口：与 `TagLookup` 同形，只取页需要的两项。 */
export interface PageLookup {
  resolveAlias(name: string): Block | undefined
  roots(): readonly Block[]
}

/**
 * 按名字「找到或创建」一个页块（事务内）。
 *
 * 同名地址已经存在 ⇒ 复用它、只补 `page` 露面：地址空间全局唯一，
 * 建第二个同名块会让「它到底是谁」取决于先序扫描。
 * 名字为空 ⇒ `null`（没有名字的页没有身份；`@` 的空查询不建行）。
 */
export function ensurePageInTx(lookup: PageLookup, name: string, tx: Tx): Block | null {
  const title = name.trim()
  if (title === '') return null
  const existing = lookup.resolveAlias(title)
  if (existing) {
    if (!hasList(existing, 'page')) tx.setLists(existing.id, [...listsOf(existing), 'page'])
    if (prop(existing, DISPLAY_PROP) === undefined) tx.setProp(existing.id, DISPLAY_PROP, 'alias')
    return existing
  }
  const block = mkPageBlock(title)
  tx.insert(block, null, lookup.roots().length)
  return block
}

/** 无事务入口时的兜底（只给没有 `write` 的视图）：正常写路径一律走 `ensurePageInTx`。 */
export function ensurePageDirect(forest: Block[], name: string): Block | null {
  const title = name.trim()
  if (title === '') return null
  const existing = findByAlias(forest, title)
  if (existing) {
    if (!hasList(existing, 'page')) addList(existing, 'page')
    if (prop(existing, DISPLAY_PROP) === undefined) {
      existing.props = { ...(existing.props ?? {}), [DISPLAY_PROP]: 'alias' }
    }
    return existing
  }
  const block = mkPageBlock(title)
  forest.push(block)
  return block
}
