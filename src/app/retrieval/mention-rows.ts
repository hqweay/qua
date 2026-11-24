/**
 * **`@` 源的行**：最匹配（精确地址）＋ 页 ＋ 块 ＋ 新建页。
 *
 * 为什么单独一份：第一段的触发表（`triggers.ts`）要装配斜杠命令的浮层行，
 * 而这一份是**纯判据**——只读森林、只产出行数据。分开才能被单测直接钉住
 * （测试环境跑不了浮层那一份 DOM 装配）。与 `member-rows.ts` 同一个分工。
 *
 * 三档确定性：查询词恰好是一个地址 ⇒ 最匹配（置顶）；**名字**里有它 ⇒ 页，
 * 或带地址的普通块（块组内排在正文命中之前）；**正文**里有它 ⇒ 块。
 * 「有没有名字」看的是**地址**（`_aliases`），不是页露面——页只是块的一种渲染。
 *
 * **词法只有一份**：按空白切词、全部出现（AND，`scanTerms`/`termsMatch`），
 * 与全局搜索同一个意思。行里的 `parts` 标出每个命中——候选行必须自证为什么命中，
 * 否则用户得打开每一行去确认。
 *
 * ⚠️ 线性扫：接口保持 `query => Row[]`，接全文索引时换这一个函数，浮层与落点都不动。
 * ⚠️ 身份块不进「块」这一栏：标签的正文就是它的名字、日记的正文是那天的描述，
 *    它们被引用时的显示名不是这段字（引用它们有各自的入口），列在这里只会点出怪结果。
 */
import {
  addressesOf,
  blockLabel,
  displayNameOf,
  findByAlias,
  findInForest,
  hasList,
  isAddressable,
  isJournal,
  plainText,
  walkForest,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { TRIGGER_QUERY_MAX } from '../../core/infra/trigger.ts'
import { highlightSnippet, markTerms, termsMatch } from '../../core/search/query.ts'
import { matchedNameOf, type MatchedName } from '../../core/search/match-source.ts'
import type { Row } from '../../ui/overlay/layers.ts'

/** 每组最多列这么多：`@` 空查询就是「全部」，没有上限的话浮层永远滚不到底 */
const MENTION_CAP = 20

/** 这一份判据能问到的东西（`TriggerDeps` 的子集，测试可以只实现它） */
export interface MentionDeps {
  forest: () => readonly Block[]
  /** 正在打字的这一块：它的正文里还留着 `@查询词`，引用自己没有意义 */
  selfBlockId: () => string | null
  /** 一块被引用的总次数（块行出处旁的消歧信号：同一段字可能出现在几块） */
  refCount: (blockId: string) => number
  /** 新建页行的第二落点徽标（`⌥↵` 建普通块） */
  newPageAltHint: string
}

/** 行上用一段正文当名字：截短，别把一行撑成一段 */
function snippet(text: string): string {
  const s = text.trim().replace(/\s+/g, ' ')
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

/** 块行的出处：来源根名 ＋ 被引次数（0 次不占位）——同一段字可能出现在几处，用户要能分清 */
function blockHint(b: Block, root: Block | undefined, deps: MentionDeps): string {
  const rootName = root && root.id !== b.id && hasList(root, 'page') ? displayNameOf(root) : ''
  const refs = deps.refCount(b.id)
  return refs > 0 ? [rootName, t('ui.retrieval.refCount', { n: refs })].filter(Boolean).join(' · ') : rootName
}

/**
 * 精确命中的那一行：行显**用户点名的那个名字**。
 *
 * 名字的读法只有一份——与页行共用 `matchedNameOf`（主名优先 / 别名显别名 /
 * 路径取叶子）。别名命中时插入写 `anchor` 覆盖层，落点与页行同一口径。
 */
function exactRowOf(b: Block, raw: string, deps: MentionDeps): Row {
  const named = matchedNameOf(b, raw)
  const name = named?.text ?? blockLabel(b, (id) => findInForest(deps.forest(), id))
  const isPage = hasList(b, 'page')
  return {
    id: `retrieval/exact/${b.id}`,
    label: name,
    parts: markTerms(name, raw),
    // 与划选转引用的「最匹配」同一句：这是同一个状态，不该有两种说法
    hint: t('ui.selRef.exactHint'),
    icon: isPage ? 'lucide:file' : 'lucide:list-tree',
    group: 'retrieval/1-exact',
    pick: {
      kind: isPage ? 'page' : 'block',
      id: b.id,
      name,
      ...(isPage && named && !named.isPrimary ? { anchor: named.text } : {}),
    },
  }
}

/**
 * **页行**：`@` 的页组与页候选共用的唯一构造。
 *
 * 行显**命中的名字**：主名命中仍是主名（`blockLabel` 兜底防形状坏——页恒有地址）；
 * 别名命中显别名——用户是用这个名字把它找出来的。别名点名时 `pick.anchor` 带上同一句
 * （`@` 落进正文的引用就用它当显示字）；主名命中不带，引用继续跟随改名。
 */
function pageRowOf(b: Block, raw: string, named: MatchedName, forest: readonly Block[]): Row {
  const name = named.isPrimary ? blockLabel(b, (id) => findInForest(forest, id)) : named.text
  return {
    id: `retrieval/page/${b.id}`,
    label: name,
    // 名字是短文本：不截窗，所有查询词都标出来（与块行的片段高亮同一份判据）
    parts: markTerms(name, raw),
    hint: addressesOf(b).find((a) => a.includes('/')) ?? '',
    icon: 'lucide:file',
    group: 'retrieval/1-page',
    pick: { kind: 'page', id: b.id, name, ...(named.isPrimary ? {} : { anchor: named.text }) },
  }
}

/**
 * **「新建页面」行**（`@` 与页候选共用的构造）。
 *
 * 判据用**地址**而不是「这一屏有没有行」：正文命中了几行，不代表用户想点名的那个名字
 * 已经存在；`Foo` 对 `Foobar` 只是正文包含，不能拦住建 `Foo` 这个页。
 * 同名**页**已经存在 ⇒ 不产这一行（那一行就是已有页本身）；同名落在别的形态上
 * （普通块 / 标签）⇒ 这一行改说「会复用」，落点仍是同一个「找到或创建」。
 *
 * `altHint` 只给有第二落点的面（`@` 的 `⌥↵` 建普通块）；没有插入点的地方没有第二落点。
 */
function newPageRowOf(raw: string, forest: readonly Block[], altHint?: string): Row | null {
  if (raw === '') return null
  if (findByAlias(forest, raw, (b) => hasList(b, 'page'))) return null
  const existing = findByAlias(forest, raw)
  return {
    id: `retrieval/newPage/${raw}`,
    label: t('ui.retrieval.newPage', { name: raw }),
    hint: existing ? t('ui.retrieval.newPageReuseHint') : t('ui.retrieval.newPageHint'),
    icon: 'lucide:plus',
    group: 'retrieval/3-new',
    ...(altHint === undefined ? {} : { keyHint: altHint }),
    pick: { kind: 'newPage', name: raw },
  }
}

/**
 * **页候选**（`core.page/new` 打开的那一张面）：输入即找页、`↵` 去那儿；没有同名页时
 * 多一行「新建页面」。
 *
 * 与 `@` 的页组共用同一份行构造与同一份判据（`matchedNameOf`），差别只有两条：
 * ① 空查询列**最近改过的页**（这里要「一跳就走」；`@` 的空查询不承担这个职能）；
 * ② 没有插入点，所以不产块行、也不画 `⌥↵` 徽标。
 *
 * 排序：**精确地址第一**（点名的对象比「名字里含这几个字」强），其余按 `modified` 新在前。
 * 「新建页面」行排第一——按下这个键的默认意图是建；它只在没有同名页时出现，
 * 所以「同名页已经在场」时第一条就是那一页，不会指错。
 */
export interface PagePickerDeps {
  forest: () => readonly Block[]
}

export function pagePickerRows(query: string, deps: PagePickerDeps): Row[] {
  const raw = query.trim().slice(0, TRIGGER_QUERY_MAX)
  const forest = deps.forest()
  const exactId = raw === '' ? undefined : findByAlias(forest, raw, (b) => hasList(b, 'page'))?.id
  const hits: { row: Row; rank: number; modified: number }[] = []
  walkForest(forest, (b) => {
    if (!hasList(b, 'page')) return
    // 空查询＝全部页（没有命中可标，也就不做名字匹配）；非空按名字命中收窄
    const named: MatchedName | null =
      raw === '' ? { text: displayNameOf(b), isPrimary: true } : matchedNameOf(b, raw)
    if (!named) return
    hits.push({ row: pageRowOf(b, raw, named, forest), rank: b.id === exactId ? 0 : 1, modified: b.modified })
  })
  hits.sort((a, b) => a.rank - b.rank || b.modified - a.modified)
  const rows = hits.slice(0, MENTION_CAP).map((h) => h.row)
  const newRow = newPageRowOf(raw, forest)
  return newRow ? [newRow, ...rows] : rows
}

export function mentionRows(query: string, deps: MentionDeps): Row[] {
  const raw = query.trim().slice(0, TRIGGER_QUERY_MAX)
  const forest = deps.forest()
  const pages: Row[] = []
  const namedBlocks: Row[] = []
  const textBlocks: Row[] = []
  const selfId = deps.selfBlockId()
  /**
   * **精确地址置顶**：查询词逐字等于某个地址 ⇒ 这个对象是这次输入最强的信号，
   * 比「名字 / 正文包含这几个字」强。与划选转引用的候选同一判据（那边叫「最匹配」）。
   *
   * 只取 `@` 本来会列的目标：标签 / 日记有各自的入口（`#`）。回收站里的块由
   * `walkForest` 的默认口径跳过（删块连同整棵子树），这里不必另判。
   * 正在打字的自己排除的理由与下面那条相同。
   */
  const exact =
    raw === ''
      ? undefined
      : findByAlias(
          forest,
          raw,
          (b) => b.id !== selfId && (hasList(b, 'page') || (!hasList(b, 'tag') && !isJournal(b))),
        )
  const exactRows: Row[] = exact ? [exactRowOf(exact, raw, deps)] : []
  walkForest(forest, (b, ctx) => {
    // 正在打字的这一块不进候选：它的正文里还留着 `@查询词`，而且「引用自己」没有意义
    if (b.id === selfId) return
    // 已经置顶 ⇒ 不再出现在页 / 块组里（同一个目标只给一行）
    if (b.id === exact?.id) return
    const text = plainText(b.content)
    const named = hasList(b, 'page') ? matchedNameOf(b, raw) : null
    if (named) {
      if (pages.length < MENTION_CAP) pages.push(pageRowOf(b, raw, named, forest))
      return
    }
    if (hasList(b, 'tag') || isJournal(b)) return
    /**
     * **名字命中**：地址（`_aliases`）是**任何块**的属性，不是页专属。带地址的普通块
     * 按名字命中时，行显那个名字、落在块组——它比「正文碰巧含这几个字」精确，所以
     * 排在正文命中之前，不能在同组上限里被正文行挤掉。
     */
    if (isAddressable(b)) {
      const hit = matchedNameOf(b, raw)
      if (hit) {
        if (namedBlocks.length < MENTION_CAP) {
          namedBlocks.push({
            id: `retrieval/block/${b.id}`,
            label: hit.text,
            parts: markTerms(hit.text, raw),
            hint: blockHint(b, ctx.path[0], deps),
            icon: 'lucide:list-tree',
            group: 'retrieval/2-block',
            pick: { kind: 'block', id: b.id, name: hit.text },
          })
        }
        return
      }
    }
    if (text.trim() === '') return
    // 多词是 AND（与全局搜索/扫描同一份语义）：空格不再被当成字面字符
    if (!termsMatch(text, raw)) return
    if (textBlocks.length >= MENTION_CAP) return
    textBlocks.push({
      id: `retrieval/block/${b.id}`,
      label: snippet(text),
      // 片段以**首个命中**为中心开窗并标出全部词——行必须自证为什么命中：
      // 只截正文头 N 字时，命中靠后的行看起来根本不含查询词。空查询没有命中可标，
      // 保留头部摘要（`label` 兜底），不必为一屏「全部」多算一份高亮。
      ...(raw === '' ? {} : { parts: highlightSnippet(text, raw, 72) }),
      hint: blockHint(b, ctx.path[0], deps),
      icon: 'lucide:list-tree',
      group: 'retrieval/2-block',
      pick: { kind: 'block', id: b.id, name: snippet(text) },
    })
  })
  /**
   * **无同名页 ⇒ 建页**（`⇧↵`／`⌥↵` 的两种落点由按键区分，行只报「建这个页」）。
   *
   * `@` 的第一落点是「插一枚指向它/新建它的引用」，所以这里画 `⌥↵` 的第二种建法；
   * 没有插入点的面（页候选）传 `altHint` 为空，那一格不画。
   */
  const newRow = newPageRowOf(raw, forest, deps.newPageAltHint)
  const newRows: Row[] = newRow ? [newRow] : []
  // 块组内：名字命中在前，正文命中在后；两组各自有上限，合并后再按组上限收一次
  const blocks = [...namedBlocks, ...textBlocks].slice(0, MENTION_CAP)
  return [...exactRows, ...pages, ...blocks, ...newRows]
}
