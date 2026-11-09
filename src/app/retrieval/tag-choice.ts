/**
 * **「选一个标签」**：候选判据 ＋ 一次打开只建一遍的目录 ＋ 浮层打开。
 *
 * 这个模块只回答两件事：**列出哪些标签**、**用户选了谁**。它不写库 ——
 * 「插进正文」「归到本块」「新建标签」都是调用方的落点，各自走自己的命令。
 *
 * 为什么要一个目录（`TagChoice`）而不是一个 `rows(query)` 纯函数：
 * 标签表与边图邻接表都在一次打开里**不变**（浮层是模态的，选中即关闭），
 * 而旧写法把 `buildAdjacency` 放在逐行的 `.map` 里，每行重建一次全库邻接表。
 * 目录把这两张表的建成点收成「打开这一刻」，失效点也就是关闭／重开 ——
 * 不是超时，也不是某个布尔标志。
 *
 * ⚠️ 浮层输入框里的组合期守卫住在 `ui/overlay/layers.ts`（所有菜单共用）：
 * 这个模块只负责「给一份当前查询词的行」，不碰 DOM、不碰按键。
 * ⚠️ 没有防抖：过滤是纯内存的，即时比延迟正确。
 */
import {
  addressesOf,
  allTags,
  buildAdjacency,
  descendantIds,
  displayNameOf,
  findByAlias,
  hasList,
  normalizeAlias,
  parentsOf,
  primaryAliasOf,
  type Adjacency,
  type Block,
  type ForestWalker,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Layers, Row } from '../../ui/overlay/layers.ts'

/** 名字为空时的兜底：与装配层的 `shortId` 同一口径（末 6 位） */
const shortName = (b: Block): string => displayNameOf(b).trim() || b.id.slice(-6)

/** 候选来源：默认全部标签；`rootId` 给了就只留它的下级闭包（按 `_belongsTo` 边） */
export interface TagChoiceOpts {
  /** 限定子树：只列这个根的下级（含根自己） */
  rootId?: string
  /** 已选（单选场景就是「当前这个」）：不再出现在候选里 */
  selectedIds?: readonly string[]
  /** 排除项与 `selectedIds` 合并：不列出 */
  excludeIds?: readonly string[]
  /** 已用标签优先：这些 id 排在最前（其余保持地址序） */
  priorityIds?: readonly string[]
  /** 是否给「新建」行（默认 true） */
  allowCreate?: boolean
  /** 新建行排在最前（默认 true，与插入标签的浮层一致） */
  createFirst?: boolean
  /** 行 id 前缀（默认 `tagpick`） */
  idPrefix?: string
  /** 标签行／新建行的分组（默认 `tagpick/1`、`tagpick/0`） */
  tagGroup?: string
  createGroup?: string
  /** 行尾按键徽标（`#` 浮层用） */
  keyHint?: string
  /** 成员计数（调用方给按 id 取数的函数 ⇒ 组件不为此扫库） */
  memberCount?: (tagId: string) => number
  /** 新建行的文案／提示／图标／行 id（缺省是「插入标签」浮层那一套） */
  createLabel?: (name: string, page: Block | undefined) => string
  createHint?: (page: Block | undefined) => string
  createIcon?: string
  createId?: (name: string) => string
}

/**
 * **一次打开算一次的目录**：标签表（按主地址排序）＋ 边图邻接表。
 *
 * `terrain` 是可注入的遍历函数，只为一件事：让单测能数「这张表建了几遍」。
 */
export function tagCatalog(
  forest: readonly Block[],
  walk?: ForestWalker,
): { tags: Block[]; adj: Adjacency } {
  const tags = allTags(forest)
    .slice()
    // 排序用**主地址**（全名、规范化）而不是显示叶子：`A/B` 与 `C/B` 的叶子相同，
    // 按叶子排会让两行看起来没有稳定顺序。
    .sort((a, b) => (addressesOf(a)[0] ?? shortName(a)).localeCompare(addressesOf(b)[0] ?? shortName(b)))
  return { tags, adj: buildAdjacency(forest, walk) }
}

/** 查询词命中：任一地址包含它，或显示叶子包含它（规范化只有一处：`normalizeAlias`） */
function matches(tag: Block, want: string): boolean {
  if (want === '') return true
  return (
    addressesOf(tag).some((a) => a.includes(want)) ||
    normalizeAlias(displayNameOf(tag)).includes(want)
  )
}

/**
 * 一个**打开期间**的标签选择会话。
 *
 * `rows(query)` 只做过滤／排序／投影：标签表与邻接表在构造时就建好了。
 * 库真在打开期间变了（理论上不发生）⇒ 关掉重开就是新的会话，即失效点。
 */
export interface TagChoice {
  /** 全部标签（已排序；`#` 的第一段也用它当实例匹配的源） */
  readonly tags: readonly Block[]
  readonly adj: Adjacency
  rows(query: string): Row[]
  /** 这个输入词对应的同名页（新建行会说明「复用它」） */
  pageFor(query: string): Block | undefined
  /** 行 id → 标签块（调用方要拿 id 时不必再扫一遍全库） */
  tagById(id: string): Block | undefined
}

export function createTagChoice(
  forest: readonly Block[],
  opts: TagChoiceOpts = {},
  walk?: ForestWalker,
): TagChoice {
  const { tags, adj } = tagCatalog(forest, walk)
  const byId = new Map(tags.map((tag) => [tag.id, tag]))
  const hidden = new Set<string>([...(opts.selectedIds ?? []), ...(opts.excludeIds ?? [])])
  const subtree = opts.rootId !== undefined ? descendantIds(opts.rootId, adj) : null
  const priority = new Set(opts.priorityIds ?? [])
  const idPrefix = opts.idPrefix ?? 'tagpick'
  const tagGroup = opts.tagGroup ?? 'tagpick/1'
  const createGroup = opts.createGroup ?? 'tagpick/0'

  // 已用优先：这些 id 按调用方给的顺序先出，其余保持地址序（`sort` 是稳定的）
  const ordered = (): Block[] => {
    const prefs = (opts.priorityIds ?? []).flatMap((id) => {
      const tag = byId.get(id)
      return tag ? [tag] : []
    })
    return [...prefs, ...tags.filter((tag) => !priority.has(tag.id))]
  }

  const parentHint = (tag: Block): string => {
    const parents = parentsOf(tag, adj)
    return parents.length > 0
      ? t('ui.tagPicker.hierarchy', { parents: parents.map((p) => `#${shortName(p)}`).join('、') })
      : ''
  }

  const countHint = (tag: Block): string => {
    const count = opts.memberCount?.(tag.id) ?? 0
    return count > 0 ? t('ui.tagPicker.members', { count }) : ''
  }

  const pageFor = (query: string): Block | undefined => {
    const name = query.trim()
    if (name === '') return undefined
    return findByAlias(forest, name, (b) => hasList(b, 'page') && !hasList(b, 'tag'))
  }

  const rows = (query: string): Row[] => {
    const want = normalizeAlias(query)
    const tagRows: Row[] = ordered()
      .filter((tag) => hidden.size === 0 || !hidden.has(tag.id))
      .filter((tag) => subtree === null || subtree.has(tag.id))
      .filter((tag) => matches(tag, want))
      .map((tag) => ({
        id: `${idPrefix}/${tag.id}`,
        label: `#${shortName(tag)}`,
        hint: [parentHint(tag), countHint(tag)].filter((s) => s !== '').join(' · '),
        icon: 'lucide:hash',
        group: tagGroup,
        keyHint: opts.keyHint,
        pick: { kind: 'tag', id: tag.id, name: primaryAliasOf(tag) || shortName(tag) },
      }))

    const trimmed = query.trim()
    const exact = want !== '' && tags.some((tag) => addressesOf(tag).includes(want))
    const page = trimmed === '' || exact ? undefined : pageFor(trimmed)
    const create: Row[] =
      opts.allowCreate === false || trimmed === '' || exact
        ? []
        : [
            {
              id: opts.createId ? opts.createId(trimmed) : `${idPrefix}/new`,
              label: opts.createLabel
                ? opts.createLabel(trimmed, page)
                : page
                  ? t('ui.tagPicker.reusePage', { name: trimmed })
                  : t('ui.tagPicker.create', { name: trimmed }),
              hint: opts.createHint
                ? opts.createHint(page)
                : page
                  ? t('ui.tagPicker.reuseHint')
                  : '',
              icon: opts.createIcon ?? 'lucide:hash',
              group: createGroup,
              keyHint: opts.keyHint,
              pick: { kind: 'newTag', name: trimmed },
            },
          ]

    return opts.createFirst === false ? [...tagRows, ...create] : [...create, ...tagRows]
  }

  return { tags, adj, rows, pageFor, tagById: (id) => byId.get(id) }
}

/** 选中结果：已有标签给 id＋地址；新建给名字（与同名页的 id，便于调用方复用） */
export type TagChoicePick =
  | { kind: 'tag'; id: string; name: string }
  | { kind: 'create'; name: string; pageId?: string }

export interface OpenTagChoiceOpts extends TagChoiceOpts {
  layers: Layers
  forest: readonly Block[]
  anchor: DOMRect | null
  title: string
  emptyText: string
  onPick: (pick: TagChoicePick) => void
  /** 入口按钮：给了它，同一颗按钮再点一次就是收起（与其它值选择器同一条手势） */
  trigger?: HTMLElement
}

/**
 * 打开「插入标签」浮层。
 *
 * 目录在**打开这一刻**建一次，输入只做本地过滤；选中后关浮层，下一次打开才重建。
 */
export function openTagChoice(o: OpenTagChoiceOpts): void {
  const choice = createTagChoice(o.forest, o)
  o.layers.openMenu({
    rows: choice.rows(''),
    anchor: o.anchor,
    ...(o.trigger ? { trigger: o.trigger } : {}),
    title: o.title,
    searchable: true,
    focusSearch: true,
    emptyText: o.emptyText,
    onQuery: (q) => o.layers.setRows(choice.rows(q)),
    onPick: (row) => {
      if (row.pick?.kind === 'tag') {
        o.onPick({ kind: 'tag', id: row.pick.id, name: row.pick.name })
        return
      }
      if (row.pick?.kind === 'newTag') {
        const page = choice.pageFor(row.pick.name)
        o.onPick(page ? { kind: 'create', name: row.pick.name, pageId: page.id } : { kind: 'create', name: row.pick.name })
      }
    },
  })
}
