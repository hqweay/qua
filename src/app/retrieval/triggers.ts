/**
 * **触发表**：一个检索源，三种呈现入口。
 *
 * 形状是一张**数据表**（`ch → 源`），不是三处 `if`：
 *   加第四个触发字符 ＝ 在这里加一行 ＋ 在 `core/trigger.ts` 加它的边界判据。
 *
 * 每个源都是 `source(query) => Row[]`：**同步、只读内存森林**。
 * 判据是「换实现不改调用方」——`@` 今天是 `walkForest` ＋ `plainText` 线性扫，
 * 将来接全文索引时，换的是 `mention-rows.ts` 的 `mentionRows`，浮层与落点一行都不用动。
 *
 * ⚠️ 行上只放「选中了**谁**」（`Row.pick`），不放「选中之后插什么」：
 *    同一条 `#名` 行按 Enter 与 ⌥Enter 落到两个不同的结果，那是触发字符那一栏的事。
 * ⚠️ 只有**标签类行**带 `keyHint`（⌥↵）：它才支持「归到本块」这个第二种按法。
 *    在不支持的行上画这个徽标，等于告诉用户一个按了没用的键。
 */
import {
  blockLabel,
  displayNameOf,
  findInForest,
  hasIdentity,
  normalizeAlias,
  plainText,
  primaryAliasOf,
  tagIdsOf,
  walkForest,
  type Block,
  type CtxKeys,
} from '../../core/index.ts'
import { resolveBindings } from '../../core/infra/bindings.ts'
import { t } from '../../core/infra/msg.ts'
import type { TriggerChar } from '../../core/infra/trigger.ts'
import { matchedNameOf } from '../../core/search/match-source.ts'
import { rowsFromBindings, type Row } from '../../ui/overlay/layers.ts'
import { createTagChoice } from './name-choice.ts'
// 第二段（成员搜索）的判据住在 `member-rows.ts`（纯函数，可单测）；这里只取成员上限常量，
// 并把形状转发给装配层（`main.ts` 从这里拿 `memberRows`，与 `createTriggers` 同一个门面）。
import { INSTANCE_CAP } from './member-rows.ts'
// `@` 源的行也住在自己那份（纯判据，可单测——测试环境跑不了浮层那一份 DOM 装配）
import { mentionRows } from './mention-rows.ts'
export { INSTANCE_CAP, memberRows, type MemberTagRef } from './member-rows.ts'

/** 源能问到的东西：整片森林（现取）与浮层要用到的上下文键 */
export interface TriggerDeps {
  /** ⚠️ 现取而不是传值：换库（演示状态）之后这里必须拿到新库 */
  forest: () => readonly Block[]
  ctx: () => CtxKeys
  /** 键位提示（斜杠菜单右侧的徽标；各命令的键位在绑定表里） */
  keyHints: () => Map<string, string>
  /**
   * `#` 行的三种按法（平台相关）：`↵` 行内标签 / `⌥↵` 块标签 / `⇧↵` 实例。
   *
   * ⚠️ 三种落点由**按键**区分，不由行区分；所以每一行都画同一枚徽标，
   *    否则用户会以为「换一行才能换一种落法」。
   */
  shortcutHint: string
  /** `@` 新建页行的第二落点徽标：`⌥↵` 建普通块（不建页） */
  newPageAltHint: string
  /**
   * 正在打字的那一块（`@` 源用它把自己排除在候选外）。
   *
   * 用户写了一半的正文自己含着 `@查询词` —— 线性扫会把它当成「一块命中查询词的块」，
   * 而点它等于「插一枚指向自己的引用」。这不是可引用的目标。
   */
  selfBlockId: () => string | null
  /**
   * 一块被引用的总次数（反链口径：只数引用边）。块行的出处旁用它当权威信号——
   * 同一段字可能出现在几块里，被引用得多的是「大家都在指的那块」。
   * 提供者是装配层传的（走关系索引查表）；源自己不认得索引长什么样。
   */
  refCount: (blockId: string) => number
}

export interface Trigger {
  ch: TriggerChar
  /** 浮层抬头 */
  title: string
  /** 一行都没有时的说法（**不是**「没有匹配项」那类通用话） */
  emptyText: string
  /** 这次要列哪些行（随输入重建）*/
  source: (query: string) => Row[]
}

/* ------------------------------------------------------------ 斜杠（命令源）*/

/**
 * 把现有斜杠菜单原样搬进来：候选仍是 `resolveBindings('slash', …)` 的渲染结果。
 * 行为一个字都没变——变的是「谁来触发它」（现在也由触发表驱动，与 `#`／`@` 同一条路）。
 */
function slashRows(query: string, deps: TriggerDeps): Row[] {
  return rowsFromBindings(resolveBindings('slash', deps.ctx(), { query }), deps.keyHints(), { showKeywords: true }).map(
    (row) => ({
      ...row,
      pick: { kind: 'command' as const, command: row.command ?? '', args: row.args },
    }),
  )
}

/* ------------------------------------------------------------ 标签（`#` 源）*/

/** 名字命中：主名或任一别名（多词按同一个名字里全含，与页行共用 `matchedNameOf`） */
function matchesName(b: Block, want: string): boolean {
  return want === '' || matchedNameOf(b, want) !== null
}

/**
 * `#` 源：**已有实例** ＋ **标签类** ＋ 一行「新建实例」。
 *
 * 三条候选只是**目标**；落点由按键区分（`↵` 行内标签 / `⌥↵` 块标签 / `⇧↵` 实例）：
 *   · `↵` 实例行 ⇒ 引用那条记录（`ref` ＋ `flavor:'#'`）；标签类 ⇒ 引用类块；
 *   · `⌥↵` ⇒ 把这一行标签归到本块（写宿主 `_tags`，行尾出 chip）；
 *   · `⇧↵` ⇒ 不管选的是哪一行，都为这个标签建一条住森林顶层的新实例。
 *
 * ⚠️ **三种落点由按键区分，不由行区分**：所以三栏都画同一枚按键徽标。
 * ⚠️ 空查询不列实例：`#` 刚敲下时先给「有哪些标签」，实例靠继续打字收窄；
 *    否则一屏就是全库带标签的块，滚滚不到底。
 * ⚠️ 实例行**排除身份块与空正文块**：
 *    · 身份块（页／标签／日记／定义／查询）的正文是名字或投影，不是「一次出现」的描述；
 *    · 空正文的成员多半是「刚被 chip 归类、还没写字」的宿主块 —— 引用它会显示「无标题」，
 *      这不是用户想提及的对象。正在打字的这一块也排除（引用自己没有意义）。
 */
function instanceRows(tags: readonly Block[], want: string, deps: TriggerDeps): Row[] {
  if (want === '') return []
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const matched = new Set(tags.filter((tag) => matchesName(tag, want)).map((tag) => tag.id))
  if (matched.size === 0) return []
  const selfId = deps.selfBlockId()
  const hits: { row: Row; modified: number }[] = []
  walkForest(deps.forest(), (b) => {
    if (b.id === selfId || hasIdentity(b)) return
    const name = plainText(b.content).trim()
    if (name === '') return
    const ids = tagIdsOf(b).filter((id) => matched.has(id))
    if (ids.length === 0) return
    // 呈现摘要 ＋ 唯一兜底（匹配语义不动：上面按 plainText 过滤的口径照旧）
    const label = blockLabel(b, (id) => findInForest(deps.forest(), id))
    // 实例行也带着「它属于哪个标签」：⌥↵ 归类、⇧↵ 进成员搜索都要用到这个名字
    const owner = byId.get(ids[0]!)
    const tagName = owner ? primaryAliasOf(owner) || displayNameOf(owner) : ''
    hits.push({
      modified: b.modified,
      row: {
        id: `retrieval/obj/${b.id}`,
        label: `#${label}`,
        hint: ids.map((id) => `#${displayNameOf(byId.get(id)!)}`).join('、'),
        icon: 'lucide:square-dashed',
        group: 'retrieval/1-instance',
        keyHint: deps.shortcutHint,
        pick: { kind: 'instance', id: b.id, name: label, tag: tagName, tagId: ids[0]! },
      },
    })
  })
  // 最近的在前：同一段文字可能有很多次出现，用户更可能想引用刚记下的那一条
  return hits.sort((a, b) => b.modified - a.modified).slice(0, INSTANCE_CAP).map((h) => h.row)
}

/* -------------------------------------------------- 成员搜索（`#` 的第二段）*/

// 判据住在 `member-rows.ts`（纯函数，可单测）；这里只转发装配层要用的形状。
// （import／export 都在文件头，`tagRows` 不经过它——成员搜索由装配层直接问 member-rows。）

function tagRows(query: string, deps: TriggerDeps): Row[] {
  const forest = deps.forest()
  // 候选、排序、新建行的口径和「插入标签」浮层只有一份（行形状仍由各自决定）
  const choice = createTagChoice(forest, {
    idPrefix: 'retrieval/tag',
    tagGroup: 'retrieval/2-tag',
    createGroup: 'retrieval/3-new',
    createFirst: false,
    keyHint: deps.shortcutHint,
    createIcon: 'lucide:plus',
    createId: (name) => `retrieval/newTag/${name}`,
    createLabel: (name) => t('ui.retrieval.newTag', { name }),
    createHint: (page) => (page ? t('ui.tagPicker.reuseHint') : t('ui.retrieval.newTagHint')),
  })
  return [...instanceRows(choice.blocks, normalizeAlias(query), deps), ...choice.rows(query)]
}

/* ------------------------------------------------------------ 触发表 */

/**
 * 三行数据。`ch` 的**边界判据**在 `core/trigger.ts`（纯函数、被单测逐条钉）；
 * 这里只管「判定成立之后列什么」。
 */
export function createTriggers(deps: TriggerDeps): ReadonlyMap<TriggerChar, Trigger> {
  const table: Trigger[] = [
    {
      ch: '/',
      title: t('menu.title.slashFilter'),
      emptyText: t('ui.slash.empty'),
      source: (query) => slashRows(query, deps),
    },
    {
      ch: '#',
      title: t('ui.retrieval.tagTitle'),
      emptyText: t('ui.retrieval.tagEmpty'),
      source: (query) => tagRows(query, deps),
    },
    {
      ch: '@',
      title: t('ui.retrieval.mentionTitle'),
      emptyText: t('ui.retrieval.mentionEmpty'),
      source: (query) => mentionRows(query, deps),
    },
  ]
  return new Map(table.map((x) => [x.ch, x]))
}

export type { TriggerChar }
