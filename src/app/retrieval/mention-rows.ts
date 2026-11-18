/**
 * **`@` 源的行**：最匹配（精确地址）＋ 页 ＋ 新建页。
 *
 * 为什么单独一份：第一段的触发表（`triggers.ts`）要装配斜杠命令的浮层行，
 * 而这一份是**纯判据**——只读森林、只产出行数据。分开才能被单测直接钉住
 * （测试环境跑不了浮层那一份 DOM 装配）。与 `member-rows.ts` 同一个分工。
 *
 * 三组是**「你要引谁」的三档确定性**：查询词恰好是一个地址 ⇒ 最匹配（置顶）；
 * 名字里有它 ⇒ 页；正文里有它 ⇒ 块。
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
  isDeleted,
  isJournal,
  plainText,
  walkForest,
  type Block,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { TRIGGER_QUERY_MAX } from '../../core/infra/trigger.ts'
import { highlightSnippet, markTerms, termsMatch } from '../../core/search/query.ts'
import { matchedNameOf } from '../../core/search/match-source.ts'
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

export function mentionRows(query: string, deps: MentionDeps): Row[] {
  const raw = query.trim().slice(0, TRIGGER_QUERY_MAX)
  const forest = deps.forest()
  const pages: Row[] = []
  const blocks: Row[] = []
  const selfId = deps.selfBlockId()
  /**
   * **精确地址置顶**：查询词逐字等于某个地址 ⇒ 这个对象是这次输入最强的信号，
   * 比「名字 / 正文包含这几个字」强。与划选转引用的候选同一判据（那边叫「最匹配」）。
   *
   * 只取 `@` 本来会列的目标：标签 / 日记有各自的入口（`#`），软删块不是目标。
   * 正在打字的自己排除的理由与下面那条相同。
   */
  const exact =
    raw === ''
      ? undefined
      : findByAlias(
          forest,
          raw,
          (b) => b.id !== selfId && !isDeleted(b) && (hasList(b, 'page') || (!hasList(b, 'tag') && !isJournal(b))),
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
      if (pages.length < MENTION_CAP) {
        // 行显**命中的名字**：主名命中仍是主名（blockLabel 兜底防形状坏——页恒有地址）；
        // 别名命中显别名——用户是用这个名字把它找出来的，选中之后落进正文的那一格
        // 也该读这个名字（`anchor` 覆盖层由落点写入，主名路径不带、改名继续跟随）。
        const name = named.isPrimary ? blockLabel(b, (id) => findInForest(deps.forest(), id)) : named.text
        pages.push({
          id: `retrieval/page/${b.id}`,
          label: name,
          // 名字是短文本：不截窗，所有查询词都标出来（与块行的片段高亮同一份判据）
          parts: markTerms(name, raw),
          hint: addressesOf(b).find((a) => a.includes('/')) ?? '',
          icon: 'lucide:file',
          group: 'retrieval/1-page',
          pick: { kind: 'page', id: b.id, name, ...(named.isPrimary ? {} : { anchor: named.text }) },
        })
      }
      return
    }
    if (hasList(b, 'tag') || isJournal(b)) return
    if (text.trim() === '') return
    // 多词是 AND（与全局搜索/扫描同一份语义）：空格不再被当成字面字符
    if (!termsMatch(text, raw)) return
    if (blocks.length >= MENTION_CAP) return
    // 来源根（块住在哪个顶层根）作为提示：同一段字可能出现在几处，用户要能分清
    const root = ctx.path[0]
    const rootName = root && root.id !== b.id && hasList(root, 'page') ? displayNameOf(root) : ''
    // 被引用的次数缀在出处旁（0 次不占位）：区分「同一段字出现在几块」
    const refs = deps.refCount(b.id)
    const hint = refs > 0 ? [rootName, t('ui.retrieval.refCount', { n: refs })].filter(Boolean).join(' · ') : rootName
    blocks.push({
      id: `retrieval/block/${b.id}`,
      label: snippet(text),
      // 片段以**首个命中**为中心开窗并标出全部词——行必须自证为什么命中：
      // 只截正文头 N 字时，命中靠后的行看起来根本不含查询词。空查询没有命中可标，
      // 保留头部摘要（`label` 兜底），不必为一屏「全部」多算一份高亮。
      ...(raw === '' ? {} : { parts: highlightSnippet(text, raw, 72) }),
      hint,
      icon: 'lucide:list-tree',
      group: 'retrieval/2-block',
      pick: { kind: 'block', id: b.id, name: snippet(text) },
    })
  })
  /**
   * **无同名页 ⇒ 建页**。判据用「地址」而不是「这一屏有没有行」：
   * 正文命中了几行，不代表用户想引用的那个名字已经存在；`Foo` 对 `Foobar`
   * 只是正文包含，不能拦住建 `Foo` 这个页。
   *
   * 同名地址已经存在（页 / 标签 / 普通块）⇒ 这一行改说「会复用」，不建第二个。
   */
  const newRows: Row[] = []
  if (raw !== '') {
    const existingPage = findByAlias(forest, raw, (b) => hasList(b, 'page'))
    if (!existingPage) {
      const existing = findByAlias(forest, raw)
      newRows.push({
        id: `retrieval/newPage/${raw}`,
        label: t('ui.retrieval.newPage', { name: raw }),
        hint: existing ? t('ui.retrieval.newPageReuseHint') : t('ui.retrieval.newPageHint'),
        icon: 'lucide:plus',
        group: 'retrieval/3-new',
        // 第二落点画在行上（↵ 建页是默认，不必说）；⌥↵ 建普通块，与划选转引用同键同义
        keyHint: deps.newPageAltHint,
        pick: { kind: 'newPage', name: raw },
      })
    }
  }
  return [...exactRows, ...pages, ...blocks, ...newRows]
}
