/**
 * **「选一个名字」**：候选判据 ＋ 一次打开只建一遍的目录 ＋ 浮层打开。
 *
 * 这个模块只回答两件事：**列出哪些候选**、**用户选了谁**。它不写库 ——
 * 「插进正文」「归到本块」「新建标签」都是调用方的落点，各自走自己的命令。
 *
 * 候选来源按 `kind` 一份路由：标签（只列标签块）、页、页＋标签、引用（全森林文档序）。
 * 四个来源共用同一套**名字匹配**（任一地址或显示名包含查询词）、同一套
 * **主地址排序**（`ref` 除外——引用选择器保持文档序，翻页找块的手感不换）、
 * 同一套隐藏／优先／子树收窄；差别只在枚举范围与行的投影（图标、前缀、分组）。
 *
 * 为什么要一个目录（`NameChoice`）而不是一个 `rows(query)` 纯函数：
 * 候选表与边图邻接表都在一次打开里**不变**（浮层是模态的，选中即关闭），
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
  blockLabel,
  displayNameOf,
  findByAlias,
  flatten,
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

/** 行的显示名：呈现摘要 ＋ 唯一兜底（标签/页恒有地址；防形状坏时不露裸 id） */
const rowName = (b: Block): string => blockLabel(b)

/** 候选来源：标签／页／页＋标签／引用（全森林） */
export type NameChoiceKind = 'tag' | 'page' | 'pageOrTag' | 'ref'

export interface NameChoiceOpts {
  /** 候选从哪儿来（默认 `tag`：全部标签） */
  kind?: NameChoiceKind
  /** 限定子树：只列这个根的下级（含根自己；按 `_belongsTo` 边） */
  rootId?: string
  /** 已选（单选场景就是「当前这个」）：不再出现在候选里 */
  selectedIds?: readonly string[]
  /** 排除项与 `selectedIds` 合并：不列出 */
  excludeIds?: readonly string[]
  /** 已用候选优先：这些 id 排在最前（其余保持既定顺序） */
  priorityIds?: readonly string[]
  /** 当前值的那一行标「当前」徽标（值选择器接住「现在选的是谁」） */
  currentId?: string
  /** 是否给「新建」行（只有 `tag` 源有新建；默认 true） */
  allowCreate?: boolean
  /** 新建行排在最前（默认 true，与插入标签的浮层一致） */
  createFirst?: boolean
  /** 行 id 前缀（默认：tag 源 `tagpick`、ref 源 `ref`、其余 `namepick`） */
  idPrefix?: string
  /** 标签行／新建行的分组（tag 源默认 `tagpick/1`、`tagpick/0`；页/标签身份组固定复用 `pick/1`、`pick/2`） */
  tagGroup?: string
  createGroup?: string
  /** 行尾按键徽标（`#` 浮层用） */
  keyHint?: string
  /** 成员计数（调用方给按 id 取数的函数 ⇒ 组件不为此扫库；只有 tag 源用） */
  memberCount?: (tagId: string) => number
  /** 新建行的文案／提示／图标／行 id（缺省是「插入标签」浮层那一套） */
  createLabel?: (name: string, page: Block | undefined) => string
  createHint?: (page: Block | undefined) => string
  createIcon?: string
  createId?: (name: string) => string
}

/** 主地址比较：`A/B` 与 `C/B` 的叶子相同，按叶子排会让两行看起来没有稳定顺序 */
const byPrimaryAddress = (a: Block, b: Block): number =>
  (addressesOf(a)[0] ?? displayNameOf(a).trim()).localeCompare(addressesOf(b)[0] ?? displayNameOf(b).trim())

/**
 * **候选枚举的一条路由**：枚举范围与既定顺序都在这里定，过滤／投影不在此。
 *
 * `ref` 刻意**不排序**：引用选择器保持文档序（深度优先），翻页找块的手感不换。
 */
function candidates(forest: readonly Block[], kind: NameChoiceKind): Block[] {
  const docOrder = flatten({ roots: [...forest] })
  switch (kind) {
    case 'tag':
      return allTags(forest).slice().sort(byPrimaryAddress)
    case 'page':
      return docOrder.filter((b) => hasList(b, 'page')).sort(byPrimaryAddress)
    case 'pageOrTag':
      return docOrder.filter((b) => hasList(b, 'page') || hasList(b, 'tag')).sort(byPrimaryAddress)
    case 'ref':
      return docOrder
  }
}

/** 查询词命中：任一地址包含它，或显示名包含它（规范化只有一处：`normalizeAlias`） */
function matches(b: Block, want: string): boolean {
  if (want === '') return true
  return (
    addressesOf(b).some((a) => a.includes(want)) ||
    normalizeAlias(displayNameOf(b)).includes(want)
  )
}

/** 这个输入词对应的同名页（新建行会说明「复用它」；身份块的查找口径只有这一份） */
function pageForName(forest: readonly Block[], name: string): Block | undefined {
  if (name.trim() === '') return undefined
  return findByAlias(forest, name.trim(), (b) => hasList(b, 'page') && !hasList(b, 'tag'))
}

/**
 * 一个**打开期间**的候选会话。
 *
 * `rows(query)` 只做过滤／排序／投影：候选表与邻接表在构造时就建好了。
 * 库真在打开期间变了（理论上不发生）⇒ 关掉重开就是新的会话，即失效点。
 */
export interface NameChoice {
  /** 候选全集（已按来源的既定顺序排好） */
  readonly blocks: readonly Block[]
  readonly adj: Adjacency
  rows(query: string): Row[]
  /** 行 id（去掉前缀）→ 候选块（调用方要拿 id 时不必再扫一遍全库） */
  byId(id: string): Block | undefined
}

export function createNameChoice(
  forest: readonly Block[],
  opts: NameChoiceOpts = {},
  walk?: ForestWalker,
): NameChoice {
  const kind = opts.kind ?? 'tag'
  const blocks = candidates(forest, kind)
  const adj = buildAdjacency(forest, walk)
  const byId = new Map(blocks.map((b) => [b.id, b]))
  const hidden = new Set<string>([...(opts.selectedIds ?? []), ...(opts.excludeIds ?? [])])
  const subtree = opts.rootId !== undefined ? descendantIds(opts.rootId, adj) : null
  const priority = new Set(opts.priorityIds ?? [])
  const idPrefix = opts.idPrefix ?? (kind === 'tag' ? 'tagpick' : kind === 'ref' ? 'ref' : 'namepick')
  const tagGroup = opts.tagGroup ?? 'tagpick/1'
  const createGroup = opts.createGroup ?? 'tagpick/0'

  // 已用优先：这些 id 按调用方给的顺序先出，其余保持既定顺序（`sort` 是稳定的）
  const ordered = (): Block[] => {
    const prefs = (opts.priorityIds ?? []).flatMap((id) => {
      const b = byId.get(id)
      return b ? [b] : []
    })
    return [...prefs, ...blocks.filter((b) => !priority.has(b.id))]
  }

  const parentHint = (b: Block): string => {
    const parents = parentsOf(b, adj)
    return parents.length > 0
      ? t('ui.tagPicker.hierarchy', { parents: parents.map((p) => `#${rowName(p)}`).join('、') })
      : ''
  }

  const countHint = (b: Block): string => {
    const count = opts.memberCount?.(b.id) ?? 0
    return count > 0 ? t('ui.tagPicker.members', { count }) : ''
  }

  /** 当前值行的徽标：值选择器里「现在选的是谁」比通用键位徽标优先 */
  const keyHintOf = (b: Block): string | undefined =>
    opts.currentId !== undefined && b.id === opts.currentId ? t('ui.props.refCurrent') : opts.keyHint

  /**
   * 行投影：身份源（tag/page/pageOrTag）按身份画（标签带 `#`、页是文件），引用源按「是页还是块」画。
   * 页/标签身份组复用 `pick/1`／`pick/2`（分组标题表里已有）；引用组沿用块选择器的两组。
   */
  const rowFor = (b: Block): Row => {
    if (kind === 'tag') {
      return {
        id: `${idPrefix}/${b.id}`,
        label: `#${rowName(b)}`,
        hint: [parentHint(b), countHint(b)].filter((s) => s !== '').join(' · '),
        icon: 'lucide:hash',
        group: tagGroup,
        keyHint: keyHintOf(b),
        pick: { kind: 'tag', id: b.id, name: primaryAliasOf(b) || displayNameOf(b).trim() },
      }
    }
    if (kind === 'ref') {
      const isPage = hasList(b, 'page')
      const title = rowName(b)
      return {
        id: `${idPrefix}/${b.id}`,
        label: title,
        hint: isPage ? t('ui.props.refIsPage') : t('ui.props.refIsBlock'),
        icon: isPage ? 'lucide:file' : 'lucide:square',
        group: isPage ? 'ref/1-page' : 'ref/2-block',
        keyHint: keyHintOf(b),
        pick: { kind: 'block', id: b.id, name: title },
      }
    }
    const isTag = hasList(b, 'tag')
    return {
      id: `${idPrefix}/${b.id}`,
      label: isTag ? `#${rowName(b)}` : rowName(b),
      hint: parentHint(b),
      icon: isTag ? 'lucide:hash' : 'lucide:file',
      group: isTag ? 'pick/2' : 'pick/1',
      keyHint: keyHintOf(b),
      pick: { kind: 'block', id: b.id, name: displayNameOf(b).trim() },
    }
  }

  const rows = (query: string): Row[] => {
    const want = normalizeAlias(query)
    const hits = ordered()
      .filter((b) => hidden.size === 0 || !hidden.has(b.id))
      .filter((b) => subtree === null || subtree.has(b.id))
      .filter((b) => matches(b, want))
      .map(rowFor)

    // 「新建」行是 tag 源独有的：页/归属/引用都是选已有，不该顺手造身份
    const trimmed = query.trim()
    const exact = want !== '' && blocks.some((b) => addressesOf(b).includes(want))
    const page = pageForName(forest, trimmed)
    const create: Row[] =
      kind !== 'tag' || opts.allowCreate === false || trimmed === '' || exact
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

    return opts.createFirst === false ? [...hits, ...create] : [...create, ...hits]
  }

  return { blocks, adj, rows, byId: (id) => byId.get(id) }
}

/**
 * 选中结果：身份源给 id＋名字；引用源给块 id；新建（只有 tag 源）给名字（与同名页的 id，便于调用方复用）
 */
export type NameChoicePick =
  | { kind: 'tag'; id: string; name: string }
  | { kind: 'block'; id: string; name: string }
  | { kind: 'create'; name: string; pageId?: string }

/** tag 源的选中结果：已有标签给 id＋地址；新建给名字（与同名页的 id，便于调用方复用） */
export type TagChoicePick =
  | { kind: 'tag'; id: string; name: string }
  | { kind: 'create'; name: string; pageId?: string }

export interface OpenNameChoiceOpts extends NameChoiceOpts {
  layers: Layers
  forest: readonly Block[]
  anchor: DOMRect | null
  title: string
  emptyText: string
  onPick: (pick: NameChoicePick) => void
  /** 入口按钮：给了它，同一颗按钮再点一次就是收起（与其它值选择器同一条手势） */
  trigger?: HTMLElement
}

/**
 * 打开「选一个名字」浮层。
 *
 * 目录在**打开这一刻**建一次，输入只做本地过滤；选中后关浮层，下一次打开才重建。
 */
export function openNameChoice(o: OpenNameChoiceOpts): void {
  const choice = createNameChoice(o.forest, o)
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
      const p = row.pick
      if (p?.kind === 'tag') {
        o.onPick({ kind: 'tag', id: p.id, name: p.name })
        return
      }
      if (p?.kind === 'block') {
        o.onPick({ kind: 'block', id: p.id, name: p.name })
        return
      }
      if (p?.kind === 'newTag') {
        const page = pageForName(o.forest, p.name)
        o.onPick(page ? { kind: 'create', name: p.name, pageId: page.id } : { kind: 'create', name: p.name })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// tag 源的薄壳：三个既有入口（条件树、插入标签、`#` 补全）的签名不变
// ---------------------------------------------------------------------------

/** tag 源的候选会话：`blocks` 就是标签表（按主地址排序） */
export interface TagChoice extends NameChoice {
  pageFor(query: string): Block | undefined
  tagById(id: string): Block | undefined
}

export function createTagChoice(
  forest: readonly Block[],
  opts: NameChoiceOpts = {},
  walk?: ForestWalker,
): TagChoice {
  const choice = createNameChoice(forest, { ...opts, kind: 'tag' }, walk)
  return {
    ...choice,
    pageFor: (query) => pageForName(forest, query),
    tagById: choice.byId,
  }
}

export interface OpenTagChoiceOpts extends Omit<OpenNameChoiceOpts, 'onPick'> {
  onPick: (pick: TagChoicePick) => void
}

/** tag 源的浮层：`kind` 固定，且 tag 源的行只会产出 `tag`／`create` 两种选中 */
export function openTagChoice(o: OpenTagChoiceOpts): void {
  openNameChoice({
    ...o,
    kind: 'tag',
    onPick: (pick) => {
      if (pick.kind === 'tag' || pick.kind === 'create') o.onPick(pick)
    },
  })
}
