/**
 * **触发表**：一个检索源，三种呈现入口。
 *
 * 形状是一张**数据表**（`ch → 源`），不是三处 `if`：
 *   加第四个触发字符 ＝ 在这里加一行 ＋ 在 `core/trigger.ts` 加它的边界判据。
 *
 * 每个源都是 `source(query) => Row[]`：**同步、只读内存森林**。
 * 判据是「换实现不改调用方」——`@` 今天是 `walkForest` ＋ `plainText` 线性扫，
 * 将来接全文索引时，换的是这个文件里的 `mentionRows`，浮层与落点一行都不用动。
 *
 * ⚠️ 行上只放「选中了**谁**」（`Row.pick`），不放「选中之后插什么」：
 *    同一条 `#名` 行按 Enter 与 ⌥Enter 落到两个不同的结果，那是触发字符那一栏的事。
 * ⚠️ 只有**标签类行**带 `keyHint`（⌥↵）：它才支持「归到本块」这个第二种按法。
 *    在不支持的行上画这个徽标，等于告诉用户一个按了没用的键。
 */
import {
  addressesOf,
  allTags,
  buildAdjacency,
  displayNameOf,
  findByAlias,
  hasIdentity,
  hasList,
  isJournal,
  normalizeAlias,
  parentsOf,
  plainText,
  primaryAliasOf,
  tagIdsOf,
  walkForest,
  type Block,
  type CtxKeys,
} from '../../core/index.ts'
import { resolveBindings } from '../../core/bindings.ts'
import { t } from '../../core/msg.ts'
import { TRIGGER_QUERY_MAX, type TriggerChar } from '../../core/trigger.ts'
import { rowsFromBindings, type Row } from '../../ui/layers.ts'

/** 源能问到的东西：整片森林（现取）与浮层要用到的上下文键 */
export interface TriggerDeps {
  /** ⚠️ 现取而不是传值：换库（演示状态）之后这里必须拿到新库 */
  forest: () => readonly Block[]
  ctx: () => CtxKeys
  /** 键位提示（斜杠菜单右侧的徽标；各命令的键位在绑定表里） */
  keyHints: () => Map<string, string>
  /** 「归到本块」的按键徽标（平台相关） */
  altEnterHint: string
  /**
   * 正在打字的那一块（`@` 源用它把自己排除在候选外）。
   *
   * 用户写了一半的正文自己含着 `@查询词` —— 线性扫会把它当成「一块命中查询词的块」，
   * 而点它等于「插一枚指向自己的引用」。这不是可引用的目标。
   */
  selfBlockId: () => string | null
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

/** 名字命中：主名叶子或**任一**别名（规范化只有一处：`normalizeAlias`） */
function matchesName(b: Block, want: string): boolean {
  if (want === '') return true
  return addressesOf(b).some((a) => normalizeAlias(a).includes(want)) || displayNameOf(b).toLowerCase().includes(want)
}

/**
 * `#` 源：**已有实例** ＋ **标签类** ＋ 一行「新建记录」。
 *
 * 三条候选对应三种语义，由**选中的那一行**决定（不由按键决定）：
 *   · 实例 ＝ 这个标签的一次出现 ⇒ 引用那条记录（`ref` ＋ `flavor:'#'`）；
 *   · 标签类 ⇒ 引用标签本身（同一个 `ref` run，只差 `to` 指向谁）；
 *   · 新建记录 ⇒ 建标签（缺则建）＋ 建一条落在今天的记录 ＋ 插入指向它的露面。
 *
 * ⚠️ **只有标签类行带 `keyHint`（⌥↵）**：它才支持「归到本块」这个第二种按法。
 *    在实例/新建行上画这个徽标，等于告诉用户一个按了没用的键。
 * ⚠️ 空查询不列实例：`#` 刚敲下时先给「有哪些标签」，实例靠继续打字收窄；
 *    否则一屏就是全库带标签的块，滚滚不到底。
 * ⚠️ 实例行**排除身份块与空正文块**：
 *    · 身份块（页／标签／日记／定义／查询）的正文是名字或投影，不是「一次出现」的描述；
 *    · 空正文的成员多半是「刚被 chip 归类、还没写字」的宿主块 —— 引用它会显示「无标题」，
 *      这不是用户想提及的对象。正在打字的这一块也排除（引用自己没有意义）。
 */
const INSTANCE_CAP = 20

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
    const label = displayNameOf(b).trim() || t('ui.page.untitled')
    hits.push({
      modified: b.modified,
      row: {
        id: `retrieval/obj/${b.id}`,
        label: `#${label}`,
        hint: ids.map((id) => `#${displayNameOf(byId.get(id)!)}`).join('、'),
        icon: 'lucide:square-dashed',
        group: 'retrieval/1-instance',
        pick: { kind: 'instance', id: b.id, name: label },
      },
    })
  })
  // 最近的在前：同一段文字可能有很多次出现，用户更可能想引用刚记下的那一条
  return hits.sort((a, b) => b.modified - a.modified).slice(0, INSTANCE_CAP).map((h) => h.row)
}

function tagRows(query: string, deps: TriggerDeps): Row[] {
  const forest = deps.forest()
  const want = normalizeAlias(query)
  const tags = allTags(forest)
    .slice()
    // 排序用**主地址**（全名）而不是显示叶子：`A/B` 与 `C/B` 的叶子相同，按叶子排会看着无序
    .sort((a, b) => (primaryAliasOf(a) || displayNameOf(a)).localeCompare(primaryAliasOf(b) || displayNameOf(b)))

  // 边图邻接表一次建好：这一屏要为每个标签问「它的上级是谁」，逐个现建就是 O(标签数 × 全库)
  const adj = buildAdjacency(forest)
  const classRows: Row[] = tags.filter((tag) => matchesName(tag, want)).map((tag) => {
    const name = displayNameOf(tag)
    const parents = parentsOf(tag, adj)
    return {
      id: `retrieval/tag/${tag.id}`,
      label: `#${name}`,
      hint: parents.length > 0 ? t('ui.tagPicker.hierarchy', { parents: parents.map((p) => `#${displayNameOf(p)}`).join('、') }) : '',
      icon: 'lucide:hash',
      group: 'retrieval/2-tag',
      keyHint: deps.altEnterHint,
      pick: { kind: 'tag', id: tag.id, name: primaryAliasOf(tag) || name },
    }
  })

  const trimmed = query.trim()
  // 同名页会**兼作标签**（`ensureTagInTx` 复用）——这件事必须在行上说出来
  const page = trimmed === '' ? undefined : findByAlias(forest, trimmed, (b) => hasList(b, 'page') && !hasList(b, 'tag'))
  const newRows: Row[] =
    trimmed === ''
      ? []
      : [
          {
            id: `retrieval/newObj/${trimmed}`,
            label: t('ui.retrieval.newObj', { name: trimmed }),
            hint: page ? t('ui.tagPicker.reuseHint') : t('ui.retrieval.newObjHint'),
            icon: 'lucide:plus',
            group: 'retrieval/3-new',
            pick: { kind: 'newObj', name: trimmed },
          },
        ]
  return [...instanceRows(tags, want, deps), ...classRows, ...newRows]
}

/* -------------------------------------------------------- 页与块（`@` 源）*/

/** 每组最多列这么多：`@` 空查询就是「全部」，没有上限的话浮层永远滚不到底 */
const MENTION_CAP = 20

/** 行上用一段正文当名字：截短，别把一行撑成一段 */
function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ')
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/**
 * `@` 源：**页** ＋ **块**。
 *
 * 页 ＝ `_lists` 里有 `page` 的块；块 ＝ 正文命中查询词的块。
 * 「正文」是投影（`plainText`）：行内标签那一格不进正文，也就不会被 `@` 搜出来
 * （引用一枚标签该走 `#`，不走这里）。
 *
 * ⚠️ 这是**临时实现**：整片森林线性扫一遍。块数上千会慢；接上索引时换这一个函数，
 *    接口（`query => Row[]`）与两个调用点都不变。
 * ⚠️ 身份块不进「块」这一栏：标签的正文就是它的名字、日记的正文是那天的描述，
 *    它们被引用时的显示名不是这段字（引用它们有各自的入口），列在这里只会点出怪结果。
 */
function mentionRows(query: string, deps: TriggerDeps): Row[] {
  const q = query.trim().toLowerCase().slice(0, TRIGGER_QUERY_MAX)
  const pages: Row[] = []
  const blocks: Row[] = []
  const selfId = deps.selfBlockId()
  walkForest(deps.forest(), (b, ctx) => {
    // 正在打字的这一块不进候选：它的正文里还留着 `@查询词`，而且「引用自己」没有意义
    if (b.id === selfId) return
    const text = plainText(b.content)
    if (hasList(b, 'page') && matchesName(b, q)) {
      if (pages.length < MENTION_CAP) {
        const name = displayNameOf(b).trim()
        pages.push({
          id: `retrieval/page/${b.id}`,
          label: name === '' ? t('ui.page.untitled') : name,
          hint: addressesOf(b).find((a) => a.includes('/')) ?? '',
          icon: 'lucide:file',
          group: 'retrieval/1-page',
          pick: { kind: 'page', id: b.id, name: name === '' ? t('ui.page.untitled') : name },
        })
      }
      return
    }
    if (hasList(b, 'tag') || isJournal(b)) return
    if (text.trim() === '') return
    if (q !== '' && !text.toLowerCase().includes(q)) return
    if (blocks.length >= MENTION_CAP) return
    // 来源页（块住在哪一页）作为提示：同一段字可能出现在几处，用户要能分清
    const root = ctx.path[0]
    blocks.push({
      id: `retrieval/block/${b.id}`,
      label: snippet(text),
      hint: root && root.id !== b.id && hasList(root, 'page') ? displayNameOf(root) : '',
      icon: 'lucide:list-tree',
      group: 'retrieval/2-block',
      pick: { kind: 'block', id: b.id, name: snippet(text) },
    })
  })
  return [...pages, ...blocks]
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
