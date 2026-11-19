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
import type { AliasState, Tx } from '../kb/types.ts'
import { AliasUncheckedError, UnloadedAliasError } from '../kb/unsupported.ts'
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
} from '../model/model.ts'
import { t } from '../infra/msg.ts'

/**
 * 一个空页块：正文空（描述）、名字进 `_aliases`、身份是 `_lists:['page']`。
 *
 * ⚠️ **不写默认图标**：页的 file 图标是角色信号（渲染时回落，见 `identity/faces.ts`），
 *    落盘会把「用户明确选了 file」与「默认 file」焊成不可区分。
 */
export function mkPageBlock(name?: string): Block {
  const b = mkBlock('')
  const title = (name ?? '').trim()
  const alias = title === '' ? t('ui.page.untitledAlias', { id: b.id.slice(-6) }) : title
  return {
    ...b,
    children: [mkBlock('')],
    props: { [ALIASES_PROP]: [alias], [LISTS_PROP]: ['page'], [DISPLAY_PROP]: 'alias' },
  }
}

/**
 * **行住在哪一页**：自己是页就是自己；否则沿祖先链（根→父）从末尾往前找
 * 最近的 `page` 露面——块不是「放进」那一页的，但它的位置回答了「它住在谁的下面」，
 * 分组要的正是这个坐标。链上没有页 ⇒ 落**顶层根**（祖先链的第一个）：
 * 分组永远有落点，「住处不明」不该在界面上出现。链为空且自己不是页 ⇒ `undefined`。
 *
 * 与快速过滤的页候选**不是同一个问**，不要合并：过滤问「这行跟这页有关吗」——
 * 链上**任何一页**都算（嵌套时祖先也算）；这里问「它住哪」——**最近的一页**赢
 * （与 `journalDateInChain` 的「贴着自己的那一天优先」同一条口径）。
 */
export function nearestPageInChain(b: Block, ancestors: readonly Block[]): Block | undefined {
  if (hasList(b, 'page')) return b
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i]!
    if (hasList(a, 'page')) return a
  }
  return ancestors[0]
}

/** 名字解析的窄口：与 `TagLookup` 同形，只取页需要的两项。 */
export interface PageLookup {
  resolveAlias(name: string): Block | undefined
  roots(): readonly Block[]
  /**
   * 防重判据（三态）：命中但目标未装载 ⇒ `UnloadedAliasError`；还没核定 ⇒
   * `AliasUncheckedError`。两种都不许新建（否则地址空间出现第二个同名身份）。
   */
  aliasState?: (name: string) => AliasState
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
  // 这个名字此刻不能拿去新建：未装载的目标先装、未核定的先问库
  const state = lookup.aliasState?.(title)
  if (state?.kind === 'unchecked') throw new AliasUncheckedError(title)
  if (state?.kind === 'owned' && !state.loaded) throw new UnloadedAliasError(title, state.id)
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
