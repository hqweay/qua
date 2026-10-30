/**
 * **视图配置**：一个**拥有者**「怎么看」（不是它是什么）。
 *
 * 四条判据（与模型层的「数据只回答是什么」同源）：
 *   · **视图不是新实体**：配置住在拥有者的两个系统属性里（`_views`／`_activeView`），
 *     不造视图块、不引入 `_type`。旧库没有这两格 ⇒ 读作「这一种源的默认看法」。
 *   · **源是派生的**：块的源按 `_query` → `_items` → `_embed` → children 依次判（见 `sourceOf`），
 *     不存 `_source`，因为「它是什么」已经由数据回答了。
 *   · **配置入 KB、状态外挂**：列/序/行高是「这个视图是什么」⇒ 进库；
 *     滚动/选中/当前行/**冻结的查询结果**是「我此刻看到哪」⇒ 表面实例状态，这里一概不碰。
 *   · **源 × kind 的兼容只有一张表**（`STORED_KINDS_BY_SOURCE`）。渲染器各判一遍的下场是
 *     「命令能写、读回来被丢掉」，也就是「点了没生效」。
 *
 * ⚠️ 本文件**零 DOM、零写库**：读只吃块与读门面，写由命令层在事务里做。
 * ⚠️ 行／记录层与「怎么画」分开：这里只回答「有哪些记录、按什么序」，
 *    `ui/view-*.ts` 才决定画成表还是列表。
 */
import { ACTIVE_VIEW_PROP, VIEWS_PROP, isDeleted, isQueryBlock, type Block, type BlockProps } from './model.ts'
import { readEmbed } from './embed.ts'
import { collectionItems, isCollectionBlock } from './collection.ts'
import type { KbClient } from './kb/types.ts'
import { declaredFieldIds, ownFieldIds } from './props.ts'
import { plainText } from './runs.ts'
import type { QuerySpec, SortKey } from './query.ts'

/* ------------------------------------------------------------ 类型 */

/**
 * 视图种类。
 *
 * `outline` **不落盘**——它等价于「没有激活视图」（children/query 源的默认）。
 * `list` 是**记录列表**（标题 ＋ 可选字段），不是大纲树：没有缩进、没有折叠三角。
 * `list-table` 是**结构映射表**（表头＝直接子块、一列＝它的孩子），只接 children。
 */
export type ViewKind = 'outline' | 'list' | 'table' | 'list-table' | 'board' | 'gallery' | 'calendar' | 'mindmap'

/** 可落盘的视图种类（`outline` 不在其中） */
export type StoredViewKind = Exclude<ViewKind, 'outline'>

const STORED_KINDS: readonly StoredViewKind[] = ['list', 'table', 'list-table', 'board', 'gallery', 'calendar', 'mindmap']

/**
 * 可落盘的视图种类（**唯一一份**）：命令面与读路径都要判「这个 kind 认不认识」。
 * 分两处各写一份的后果是「命令能写、读回来被丢掉」，也就是「点了没生效」。
 */
export const STORED_VIEW_KINDS: readonly StoredViewKind[] = STORED_KINDS

/**
 * **源 × kind 的兼容表（唯一一份）**。
 *
 * 三条形状上的理由，不是口味：
 *   · query 源的命中是一组平的行，**没有「第 k 个孩子」可对齐** ⇒ 不接 `list-table`；
 *     导图要画一整棵子树，而命中集合不是树 ⇒ 不接 `mindmap`；
 *   · items 源是**手选的一批引用**，不是树 ⇒ 同样不接 `list-table`／`mindmap`；
 *   · 只有 children 是树，所以只有它两种都接。
 *
 * `canonicalViews` 与 UI 的「能切哪几种」都读这一张表。
 */
export const STORED_KINDS_BY_SOURCE: Record<Source['kind'], readonly StoredViewKind[]> = {
  query: ['list', 'table', 'board', 'gallery', 'calendar'],
  children: ['list', 'table', 'list-table', 'board', 'gallery', 'calendar', 'mindmap'],
  items: ['list', 'table', 'board', 'gallery', 'calendar'],
}

/** 这一份源能落盘的视图种类 */
export function storedKindsFor(source: Source): readonly StoredViewKind[] {
  return STORED_KINDS_BY_SOURCE[source.kind] ?? []
}

/**
 * 这一份源在**没有激活视图**时的默认看法。
 *
 * items 源的默认是 `list` 而不是大纲：收藏不是一棵树，画成大纲等于凭空造出
 * 「第一项是第二项的父」这种关系。
 */
export function defaultKindFor(source: Source): ViewKind {
  return source.kind === 'items' ? 'list' : 'outline'
}

/**
 * 一列。
 *
 * `key` 是**属性定义块的 id**，或下面这些保留键：
 * `title`（正文投影）／`tags`（归属）／`children`（子块数）／`created`／`modified`。
 */
export interface ViewColumn {
  key: string
  /** 列宽（px）；缺省按列的种类给 */
  width?: number
  /** 隐藏但保留配置（再显示时宽度还在）；数组位仍是列序 */
  hidden?: boolean
}

/**
 * 排序键：**与查询的 `SortKey` 是同一个形状**（`by` ＋ `dir`），直接复用那一个。
 *
 * 为什么不另立一个：两者回答的是同一件事（「按哪一列的什么方向排」），
 * 而两份同形的类型会让「表格排序」与「查询排序」看起来需要各自的转换代码。
 * `by` 的取值与列的 `key` 同一套：属性定义 id 或保留键。
 */
export type { SortKey } from './query.ts'

export type RowHeight = 'compact' | 'cozy' | 'comfortable'

export interface TableConfig {
  columns: ViewColumn[]
  rowHeight?: RowHeight
  /** **显示排序**：只排当前这批成员，不重查（与 `QuerySpec.sort` 是两件事） */
  sort?: SortKey[]
}

/**
 * 结构映射表的排序：**按第 k 列**（不是按属性列）。
 *
 * `col` 是列的位置（`0` ＝ 第一列＝表头的第一个直接子块），与平表的 `SortKey.by`
 * （属性定义 id 或保留键）刻意分开：那边排序的对象是**列定义**，这边是**位置**，
 * 树一变位置的含义就变 —— 合成同一个键会让「这一列是什么意思」有两个答案。
 */
export interface ListSort {
  col: number
  dir: 'asc' | 'desc'
}

/** 记录列表（`list`）：标题 ＋ 可选字段。不是大纲树，没有缩进与折叠 */
export interface ListConfig {
  /** 要显示的字段（属性定义 id 或保留键）；缺省只显示标题 */
  fields?: string[]
  rowHeight?: 'compact' | 'cozy'
}

/**
 * 一个命名视图（`_views[]` 里的一项）。
 *
 * 只保留**这个 kind 自己的**子配置：table 视图不带着 board 配置走（两份配置迟早分叉）。
 *
 * ⚠️ `list` 是记录列表，`listTable` 是结构映射表 —— 名字必须分开，
 *    因为它们曾经共用一个 `list` 键（那时「列表视图」还不存在）。
 */
export interface ViewConfig {
  id: string
  name?: string
  kind: StoredViewKind
  table?: TableConfig
  /** 记录列表（不是大纲树、不是结构映射表） */
  list?: ListConfig
  /** 结构映射表：**只有排序**，没有列（列＝一个直接子块，不是配置） */
  listTable?: { sort?: ListSort }
  board?: { groupBy: string; groupOrder?: string[]; cardFields?: string[]; showEmpty?: boolean }
  gallery?: { cover?: 'first-asset' | 'none'; cardFields?: string[]; size?: 's' | 'm' | 'l' }
  calendar?: { dateBy: string; showUndated?: boolean }
  mindmap?: { cardFields?: string[]; direction?: 'both' | 'right' }
}

/** 一个拥有者的视图集：命名视图 ＋ 默认激活的那个（缺省＝ `defaultKindFor`） */
export interface ViewSet {
  views: ViewConfig[]
  activeView?: string
}

/** 从一个 `ViewSet` 里读出命名视图与激活的那一张（激活项解析不到 ⇒ `null` ＝ 默认看法） */
export function readViewSet(set: ViewSet): { views: ViewConfig[]; active: ViewConfig | null } {
  const id = set.activeView
  if (typeof id !== 'string' || id === '') return { views: set.views, active: null }
  return { views: set.views, active: set.views.find((v) => v.id === id) ?? null }
}

/** 在一个视图集里按 id 找那张视图（`''`／`'outline'` 都不是落盘视图 ⇒ `null`） */
export function resolveView(set: ViewSet, viewId: string): ViewConfig | null {
  if (viewId === '' || viewId === 'outline') return null
  return set.views.find((v) => v.id === viewId) ?? null
}

/* ------------------------------------------------------------ 保留列键 */

export const TITLE_COLUMN = 'title' as const
export const TAGS_COLUMN = 'tags' as const
export const CHILDREN_COLUMN = 'children' as const
export const CREATED_COLUMN = 'created' as const
export const MODIFIED_COLUMN = 'modified' as const

/*
 * 保留列键＝上面这五个常量（其余列键一律是属性定义块 id）。
 * 刻意**不**提供「是不是保留键」的判定函数：列头文案与排序都按名字分派，
 * 多一个布尔函数就多一条要跟着同步的清单。
 */

/**
 * 能不能按这一列排序。
 *
 * `created`／`modified` 只显示、不排序：它们不是属性值，给它们排要另开一条
 * 「系统键也能排」的口径，而那是本轮之外的成本（登记，不是遗漏）。
 */
export function isSortableColumn(key: string): boolean {
  return key !== CREATED_COLUMN && key !== MODIFIED_COLUMN
}

/* ------------------------------------------------------------ 读 */

const ROW_HEIGHTS: readonly RowHeight[] = ['compact', 'cozy', 'comfortable']
const LIST_ROW_HEIGHTS: readonly NonNullable<ListConfig['rowHeight']>[] = ['compact', 'cozy']

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

/**
 * `_views` 的**形状**判据（落盘校验与读路径共用一份）。
 *
 * 只判「它是不是一份视图列表」：逐项内容由 `canonicalViews` 逐条重建。
 * 两个消费者要的粒度不同 —— 落盘侧问「这坨字节能不能读」，读侧问「这一项还能不能用」。
 */
export function isViewsValue(v: unknown): boolean {
  if (!Array.isArray(v)) return false
  return v.every((x) => !!x && typeof x === 'object' && !Array.isArray(x))
}

/** `_activeView` 的形状：非空字符串（能不能解析到视图由读路径判） */
export function isActiveViewValue(v: unknown): boolean {
  return typeof v === 'string'
}

function columnOf(raw: unknown): ViewColumn | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Partial<ViewColumn>
  if (!isStr(c.key)) return null
  const out: ViewColumn = { key: c.key }
  // 宽度夹到 min/max：坏值不该让整列消失，也不该让表宽成几千像素
  if (typeof c.width === 'number' && Number.isFinite(c.width)) out.width = Math.max(60, Math.min(480, Math.round(c.width)))
  if (c.hidden === true) out.hidden = true
  return out
}

function sortOf(raw: unknown): SortKey | null {
  if (!raw || typeof raw !== 'object') return null
  const k = raw as Partial<SortKey>
  if (!isStr(k.by)) return null
  return { by: k.by, dir: k.dir === 'desc' ? 'desc' : 'asc' }
}

function tableOf(raw: unknown): TableConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const t = raw as Partial<TableConfig>
  const columns = Array.isArray(t.columns) ? t.columns.map(columnOf).filter((c): c is ViewColumn => c !== null) : []
  const out: TableConfig = { columns }
  if (t.rowHeight && ROW_HEIGHTS.includes(t.rowHeight)) out.rowHeight = t.rowHeight
  const sort = Array.isArray(t.sort) ? t.sort.map(sortOf).filter((s): s is SortKey => s !== null) : []
  if (sort.length > 0) out.sort = sort
  return out
}

/** 记录列表的配置：字段 ＋ 行高 */
function listOf(raw: unknown): ListConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const l = raw as Partial<ListConfig>
  const out: ListConfig = {}
  if (Array.isArray(l.fields)) {
    const fields = l.fields.filter(isStr)
    if (fields.length > 0) out.fields = fields
  }
  if (l.rowHeight && LIST_ROW_HEIGHTS.includes(l.rowHeight)) out.rowHeight = l.rowHeight
  return out
}

/** 结构映射表的排序配置：只认「第几格 ＋ 方向」，别的键一律丢掉 */
function listSortOf(raw: unknown): ListSort | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const s = raw as Partial<ListSort>
  if (!Number.isInteger(s.col) || (s.col as number) < 0) return undefined
  return { col: s.col as number, dir: s.dir === 'desc' ? 'desc' : 'asc' }
}

/**
 * 逐项重建视图列表（与 `canonicalSpec` 同一条纪律）。
 *
 * 判据与后果：
 *   · `kind` 不在枚举里／`id` 重复（后者丢弃）／形状不对 ⇒ **丢掉该项**，不抛；
 *   · **源不兼容的 kind 直接丢**（表只有 `STORED_KINDS_BY_SOURCE` 一张）；
 *   · 只保留 `kind` 对应的那份子配置。
 *
 * 为什么不抛：JSON／旧库里的一个错键不该让**整个块打不开** ——
 * 用户看到的是「没有结果」，而真相是「这封信没人读得懂」。丢掉那一项、回默认看法、
 * 由调用方提示一句，比让一块内容消失好。
 */
export function canonicalViews(raw: unknown, source: Source): ViewConfig[] {
  if (!Array.isArray(raw)) return []
  const allowed = storedKindsFor(source)
  const seen = new Set<string>()
  const out: ViewConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as Partial<ViewConfig>
    if (!isStr(v.id) || seen.has(v.id)) continue
    const kind = v.kind
    if (typeof kind !== 'string' || !STORED_KINDS.includes(kind as StoredViewKind)) continue
    if (!allowed.includes(kind as StoredViewKind)) continue
    const view: ViewConfig = { id: v.id, kind: kind as StoredViewKind }
    if (isStr(v.name)) view.name = v.name
    // **只留这个 kind 自己的那份**：别的 kind 的配置跟着一个不存在的 kind 走，
    // 切过去时是「上一份视图的残留」，而没人能说清它该不该生效
    if (kind === 'table') {
      const table = tableOf(v.table)
      if (table) view.table = table
    } else if (kind === 'list') {
      const list = listOf(v.list)
      if (list) view.list = list
    } else if (kind === 'list-table') {
      const sort = listSortOf(v.listTable?.sort)
      if (sort) view.listTable = { sort }
    } else if (kind === 'board') {
      const b = v.board
      if (b && typeof b === 'object' && isStr(b.groupBy)) {
        view.board = { groupBy: b.groupBy }
        if (Array.isArray(b.groupOrder)) view.board.groupOrder = b.groupOrder.filter(isStr)
        if (Array.isArray(b.cardFields)) view.board.cardFields = b.cardFields.filter(isStr)
        if (b.showEmpty === true) view.board.showEmpty = true
      } else continue
    } else if (kind === 'gallery') {
      view.gallery = { cover: v.gallery?.cover === 'none' ? 'none' : 'first-asset' }
    } else if (kind === 'calendar') {
      const c = v.calendar
      if (!c || typeof c !== 'object' || !isStr(c.dateBy)) continue
      view.calendar = { dateBy: c.dateBy, ...(c.showUndated === true ? { showUndated: true } : {}) }
    } else {
      const m = v.mindmap
      view.mindmap = { direction: m?.direction === 'right' ? 'right' : 'both' }
    }
    seen.add(view.id)
    out.push(view)
  }
  return out
}

/** 这一块的视图列表（已逐项校验；坏项已丢） */
export function readViews(b: Block | undefined): ViewConfig[] {
  if (!b) return []
  return canonicalViews(b.props?.[VIEWS_PROP], sourceOf(b))
}

/**
 * 激活的视图。
 *
 * `null` ＝ 这一份源的默认看法（`defaultKindFor`：children/query 是**大纲**，items 是**列表**）——
 * 不猜、不回退到第一项：配置坏了就退回最原始的那一种看法，而不是把用户塞进另一张视图。
 */
export function activeView(b: Block | undefined): ViewConfig | null {
  if (!b) return null
  const id = b.props?.[ACTIVE_VIEW_PROP]
  if (typeof id !== 'string' || id === '') return null
  return readViews(b).find((v) => v.id === id) ?? null
}

/** 激活视图的 id（没有 = 空串；命令面用它做参数与判等） */
export function activeViewId(b: Block | undefined): string {
  return activeView(b)?.id ?? ''
}

/** `_views` 存在但一项都读不出来 ⇒ 配置坏了（调用方据此提示「视图配置无法读取」） */
export function viewsBroken(b: Block | undefined): boolean {
  if (!b) return false
  const raw = b.props?.[VIEWS_PROP]
  if (raw === undefined) return false
  return !Array.isArray(raw) || canonicalViews(raw, sourceOf(b)).length === 0
}

/**
 * 这一块**是不是「一个视图的宿主」**：查询块、收藏块，或激活了某个非默认视图的块。
 *
 * 装配层用它决定「这一段的段尾要不要建视图宿主」——写成一处，
 * 免得「查询块」「收藏块」「普通块带视图」各自在装配层里判一遍（早晚分叉）。
 *
 * ⚠️ **收藏块即使没有 `_activeView` 也要建宿主**：它的默认看法是列表，不画出来
 *    用户就只看到一行「N 条」的摘要，而 `_items` 里的东西一个都看不到。
 */
export function isViewRoot(b: Block | undefined): boolean {
  if (!b) return false
  /**
   * **露面块自己不拥有配置**：它只有一根指针（`_embed = { block, view }`），
   * 看法住在源块上。所以它不算视图宿主 —— 把它算进来，装配层就会给一次露面
   * 建一台「读不到配置」的视图宿主（空屏）。
   */
  if (readEmbed(b) !== null) return false
  return isQueryBlock(b) || isCollectionBlock(b) || activeView(b) !== null
}

/* ------------------------------------------------------------ 源 */

/**
 * 行／节点的来源（**派生不落盘**）。
 *
 * 「取直接子块还是整棵子树」由 kind 决定（表格看直接子块、导图看整棵子树），不是源的一部分：
 * 同一个 children 源，表格看直接子块、导图看整棵子树。
 */
export type Source =
  | { kind: 'query'; spec: QuerySpec }
  | { kind: 'children'; blockId: string }
  | { kind: 'items'; blockId: string }

/**
 * **块的源优先级（唯一一份）**：
 *
 * 1. `_query` 存在 ⇒ **query**（查询页/查询块）；
 * 2. `isCollectionBlock(b)` ⇒ **items**（`_items`）；
 * 3. `_embed` 存在 ⇒ **目标块的源**（深度 1；目标不存在 ⇒ children 空容器）；
 * 4. 否则 ⇒ **children**（直接子块）。
 *
 * ⚠️ 三种「源的声明」**互斥**（`_query`／`_items`／`_embed` 只能有一个，见 `sourceConflicts`）：
 *    一个块不能同时是「查询」「收藏」「露面指针」。允许并存就会出现
 *    「改了 `_query` 却发现它根本不是源」这种静默的不生效。
 *
 * ⚠️ **露面的源是它指向的那一块，不是它自己**：露面块只是指针 ＋ 一次看法选择。
 */
export function sourceOf(b: Block, find?: (id: string) => Block | undefined): Source {
  if (isQueryBlock(b)) return { kind: 'query', spec: (b.props?._query ?? { where: { any: [] } }) as QuerySpec }
  if (isCollectionBlock(b)) return { kind: 'items', blockId: b.id }
  const embed = readEmbed(b)
  if (embed && embed.block !== b.id && find) {
    const target = find(embed.block)
    /**
     * **深度 1 构造性截断**：目标自己又是露面时不再往下钻。
     *
     * 不是 visited 集合 —— 露面体里不再展开露面是**形状上的决定**
     * （一层镜像够了，再套一层没有任何新的信息），不是防环的补丁。
     */
    if (target && readEmbed(target) === null) return sourceOf(target, find)
  }
  // 露面块自己没有 `_views`（看法住在源块上），所以这一支只在「这次露面指向谁」
  // 这件事上被用到；解析不到目标 ⇒ 一片空 children（由渲染层给一句实话）。
  return { kind: 'children', blockId: b.id }
}

/**
 * 源声明**冲突了吗**：`_query`／`_items`／`_embed` 只许有一个。
 *
 * 写入路径与落盘校验共用这一份判据 —— 两个地方各判一次，
 * 「什么算冲突」就会有两个答案，而冲突的块读起来是「静默不生效」。
 */
export function sourceConflicts(b: Block): boolean {
  const n =
    (isQueryBlock(b) ? 1 : 0) + (isCollectionBlock(b) ? 1 : 0) + (readEmbed(b) !== null ? 1 : 0)
  return n > 1
}

/* ------------------------------------------------------------ 记录层 */

/**
 * 表格/列表/看板/画廊/日历共用的一条记录。
 *
 * ⚠️ 记录是**派生的**（每次装载按 id 现读），不缓存、不落盘：
 * 缓存一份就等于承认「表里的值」可以短暂地不是块上的值。
 */
export interface ViewRecord {
  block: Block
  /** 从根到父（不含自己）；children 为 `[容器]`；query 为命中祖先；items 为 `[收藏块]` 或 `[]` */
  path: readonly Block[]
  /** 正文的纯文本投影（排序与紧凑列表用；表里画的是 run，不是这个） */
  title: string
  tags: readonly Block[]
  /** 属性袋的只读视图（按列键取值用；不拷一份 Map：5k 行不值得） */
  values: BlockProps
  /** 仅 items 源：这条在 `_items` 里的位置（拖动排序用） */
  itemIndex?: number
}

function recordOf(block: Block, path: readonly Block[], kb: KbClient, itemIndex?: number): ViewRecord {
  return {
    block,
    path,
    title: plainText(block.content),
    tags: [...kb.tagsOf(block.id)],
    values: block.props ?? {},
    ...(itemIndex === undefined ? {} : { itemIndex }),
  }
}

/**
 * children 源：容器的**直接子块**（顺序＝children 顺序）。
 *
 * ⚠️ **软删的子块自己在这里跳过**：`kb.children` 回答的是「children 数组里有什么」，
 *    它不替视图决定「被删的那一条还该不该占一行」。不跳过的后果是表里多一行
 *    打不开的块（点进去什么也没有），而没有任何一层会报错。
 */
export function childrenRecords(rootId: string, kb: KbClient): ViewRecord[] {
  const root = kb.get(rootId)
  if (!root) return []
  const path = [root]
  const out: ViewRecord[] = []
  for (const child of kb.children(rootId)) {
    if (isDeleted(child)) continue
    out.push(recordOf(child, path, kb))
  }
  return out
}

/**
 * 查询源：**每条命中都是一条记录**（不折叠祖先）。
 *
 * 与大纲查询视图的 `resolveFrozen` 有意不同：那里同一块既是根又是子块时只画一次
 * （DOM 里两遍是重复）；这里每一行是一条记录，父子同时命中就该各占一行。
 *
 * `excludeId` 过滤掉查询块自己 —— 它的正文也参与匹配，出现在自己的结果里没有意义。
 * 不把它塞进求值的 `selfId` 里：那会改变 `$self` 的语义。
 */
export function resolveRows(
  frozen: readonly { blockId: string }[],
  kb: KbClient,
  opts: { excludeId?: string } = {},
): ViewRecord[] {
  const out: ViewRecord[] = []
  for (const hit of frozen) {
    if (opts.excludeId && hit.blockId === opts.excludeId) continue
    const b = kb.get(hit.blockId)
    if (!b) continue
    const path = kb.pathOf(hit.blockId)
    out.push(recordOf(b, path.slice(0, -1), kb))
  }
  return out
}

/**
 * items 源：`_items` 解析到的**活块**（悬空跳过），顺序＝`_items` 顺序。
 *
 * ⚠️ 悬空项**不出行**，但引用本身保留（删块不摘引用，块恢复后自己回来）——
 *    「有几条指向已删块」由摘要（`collectionSummary`）明说，不由这里静默隐藏。
 */
export function itemsRecords(blockId: string, kb: KbClient): ViewRecord[] {
  const owner = kb.get(blockId)
  if (!owner) return []
  const items = collectionItems(owner)
  const path = [owner]
  const out: ViewRecord[] = []
  items.forEach((id, i) => {
    const b = kb.get(id)
    if (!b || isDeleted(b)) return
    out.push(recordOf(b, path, kb, i))
  })
  return out
}

/* ------------------------------------------------------------ 列 */

/** 一列的默认宽度：按列的种类给（宽度是配置，但第一次必须有个能看的起点） */
export function defaultWidthOf(key: string): number {
  if (key === TITLE_COLUMN) return 260
  if (key === CHILDREN_COLUMN) return 84
  if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) return 150
  if (key === TAGS_COLUMN) return 160
  return 140
}

/** 四列兜底：空表也要有列头，否则用户不知道「这里能放什么」 */
function fallbackColumns(): ViewColumn[] {
  return [
    { key: TITLE_COLUMN, width: defaultWidthOf(TITLE_COLUMN) },
    { key: TAGS_COLUMN, width: defaultWidthOf(TAGS_COLUMN) },
    { key: CHILDREN_COLUMN, width: defaultWidthOf(CHILDREN_COLUMN) },
    { key: MODIFIED_COLUMN, width: defaultWidthOf(MODIFIED_COLUMN) },
  ]
}

/** 一批块「实际拥有的属性」⇒ 列（不逐行扫库，只看前若干个） */
function columnsFromBlocks(blocks: readonly Block[], kb: KbClient, limit: number): ViewColumn[] {
  const cols: ViewColumn[] = [{ key: TITLE_COLUMN, width: defaultWidthOf(TITLE_COLUMN) }]
  const seen = new Set<string>()
  outer: for (const child of blocks) {
    const ids = [...ownFieldIds(child)]
    for (const tag of kb.tagsOf(child.id)) ids.push(...declaredFieldIds(tag))
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      cols.push({ key: id, width: defaultWidthOf(id) })
      if (cols.length > limit) break outer
    }
  }
  return cols.length > 1 ? cols : fallbackColumns()
}

/**
 * 条件里的 `tag`／`prop` 提到哪些列。
 *
 * 为什么先问条件：一个「任务清单」查询的列就该是**它筛的那几个字段**，
 * 而不是命中里碰巧前四条带着的槽 —— 后者会随数据漂移，而列只算一次。
 */
function columnsFromSpec(spec: QuerySpec, kb: KbClient): ViewColumn[] {
  const cols: ViewColumn[] = [{ key: TITLE_COLUMN, width: defaultWidthOf(TITLE_COLUMN) }]
  const seen = new Set<string>([TITLE_COLUMN])
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    cols.push({ key: id, width: defaultWidthOf(id) })
  }
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const node = n as Record<string, unknown>
    if ('all' in node && Array.isArray(node.all)) return node.all.forEach(visit)
    if ('any' in node && Array.isArray(node.any)) return node.any.forEach(visit)
    if ('not' in node) return visit(node.not)
    if (typeof node.tag === 'string') {
      const tag = kb.findTag(node.tag)
      if (tag) for (const id of declaredFieldIds(tag)) push(id)
      return
    }
    const p = node.prop
    if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') push((p as { id: string }).id)
  }
  visit(spec.where)
  return cols.length > 1 ? cols : []
}

/**
 * **第一次切到这张视图时的默认列**（**只算一次**，算完由命令层写进配置）。
 *
 * 三份源各有各的问法：
 *   · **query**：先看条件里的标签声明与属性条件，再看前若干条命中的自有属性；
 *   · **children**：看前几个直接子块实际拥有的属性 ＋ 标签声明；
 *   · **items**：看前几条 `_items` 的自有属性 ＋ 标签声明。
 * 一个都没有 ⇒ 退回 `title`／`tags`／`children`／`modified` 四列。
 *
 * ⚠️ 之后**不随结果自动变**：列宽/列序会随结果漂移，那比列少更烦人。
 * ⚠️ 这是**唯一入口**：不要在各渲染器里各算一套（那会得到三份默认列）。
 */
export function defaultColumnsForSource(
  source: Source,
  kb: KbClient,
  opts: { hits?: readonly { blockId: string }[]; limit?: number } = {},
): ViewColumn[] {
  const limit = opts.limit ?? 4
  if (source.kind === 'children') {
    const root = kb.get(source.blockId)
    return columnsFromBlocks(root ? [...kb.children(source.blockId)].filter((b) => !isDeleted(b)) : [], kb, limit)
  }
  if (source.kind === 'items') {
    const owner = kb.get(source.blockId)
    const items = owner ? collectionItems(owner) : []
    const blocks = items.map((id) => kb.get(id)).filter((b): b is Block => b !== undefined && !isDeleted(b))
    return columnsFromBlocks(blocks.slice(0, limit + 1), kb, limit)
  }
  // query：条件优先，命中兜底
  const fromSpec = columnsFromSpec(source.spec, kb)
  if (fromSpec.length > 1) return fromSpec
  const hits = opts.hits ?? []
  const blocks = hits
    .slice(0, limit + 1)
    .map((h) => kb.get(h.blockId))
    .filter((b): b is Block => b !== undefined)
  return blocks.length > 0 ? columnsFromBlocks(blocks, kb, limit) : fallbackColumns()
}

/** 可见列（`hidden` 的保留配置但不画） */
export function visibleColumns(columns: readonly ViewColumn[]): ViewColumn[] {
  return columns.filter((c) => c.hidden !== true)
}

/**
 * 一格的**纯文本**（列表／看板／画廊用；表格画的是 run，不走这里）。
 *
 * `resolve` 给「值是一个块 id」的列（`select` 的选项、`ref` 的目标）一次解析机会：
 * 那些值按 id 直接显示是一串 hex，用户看不懂。解析不到就原样显示 ——
 * **数据不静默消失**（「选项已删除」那种状态要看得见，而不是空白）。
 */
export function fieldTextOf(r: ViewRecord, key: string, resolve?: (value: unknown) => string | null): string {
  if (key === TITLE_COLUMN) return r.title
  if (key === TAGS_COLUMN) return r.tags.map((t) => plainText(t.content)).join(' ')
  if (key === CHILDREN_COLUMN) return String(r.block.children.length)
  if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) {
    const at = key === CREATED_COLUMN ? r.block.created : r.block.modified
    return new Date(at).toLocaleDateString('zh-Hans-CN')
  }
  const v = r.values[key]
  if (v === undefined || v === null) return ''
  if (resolve) {
    const hit = resolve(v)
    if (hit !== null) return hit
  }
  if (Array.isArray(v)) return v.map((x) => String(x)).join(' ')
  return typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/* ------------------------------------------------------------ 排序 */

/**
 * 取一列的排序值（**只读**，不做格式化）。
 *
 * 属性列直接取 `props[key]`；标签列取标签名的拼接串；子块列取子块数。
 * 定义缺失时值照旧返回（「数据不静默消失」）。
 */
export function sortValueOf(r: ViewRecord, key: string): unknown {
  if (key === TITLE_COLUMN) return r.title
  if (key === CHILDREN_COLUMN) return r.block.children.length
  if (key === CREATED_COLUMN) return r.block.created
  if (key === MODIFIED_COLUMN) return r.block.modified
  if (key === TAGS_COLUMN) return r.tags.map((t) => plainText(t.content)).join(' ')
  return r.values[key]
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

/** 两个非空值比大小。数字按数值（**不退化成字典序**），其余按本地化字符串比较 */
function compareAny(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  const na = typeof a === 'number' ? a : NaN
  const nb = typeof b === 'number' ? b : NaN
  // 「一边是数字」也算数值比较：属性值可能被写成 `"3"`（旧输入框的遗留），
  // 判成字典序会让 10 排在 9 前面，且从表面看只是「顺序怪怪的」
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a).localeCompare(String(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
}

/**
 * 按视图的 `sort` 排记录（**显示排序**：只排当前这批成员）。
 *
 * 三条口径：
 *   · **空值永远排最后**（升序降序都一样）——`未设置` 不是最小值，它只是还没有；
 *   · 多键按声明序依次比较；
 *   · **稳定**：相等的行保持来源顺序（children／`_items`／冻结顺序），否则「排序后 children 顺序」
 *     这种断言永远说不清是稳定还是碰巧。
 *
 * `resolve` 给**排序键的取值**换一条来源（默认 `sortValueOf`）：`select` 列的值是
 * 选项块 id，按 id 字典序排没有意义 —— 调用方传「id → 选项兄弟顺序」，
 * 不在列表里的值返回 `null`（按空值排最后）。不传时行为与以前一个字不差。
 */
export function sortRecords(
  records: readonly ViewRecord[],
  sort: readonly SortKey[] | undefined,
  resolve?: (r: ViewRecord, key: string) => unknown,
): ViewRecord[] {
  const keys = (sort ?? []).filter((k) => isSortableColumn(k.by))
  if (keys.length === 0) return [...records]
  const indexed = records.map((r, i) => ({ r, i }))
  indexed.sort((x, y) => {
    for (const k of keys) {
      const va = resolve ? resolve(x.r, k.by) : sortValueOf(x.r, k.by)
      const vb = resolve ? resolve(y.r, k.by) : sortValueOf(y.r, k.by)
      const ea = isEmpty(va)
      const eb = isEmpty(vb)
      if (ea && eb) continue
      if (ea) return 1
      if (eb) return -1
      const c = compareAny(va, vb)
      if (c !== 0) return k.dir === 'desc' ? -c : c
    }
    return x.i - y.i
  })
  return indexed.map((x) => x.r)
}

/* ------------------------------------------------------------ 写（纯函数，命令层在事务里调） */

function cloneView(v: ViewConfig): ViewConfig {
  const out: ViewConfig = { ...v }
  if (v.table) {
    const table: TableConfig = { ...v.table, columns: v.table.columns.map((c) => ({ ...c })) }
    if (v.table.sort) table.sort = v.table.sort.map((s) => ({ ...s }))
    out.table = table
  }
  if (v.list) {
    const list: ListConfig = { ...v.list }
    if (v.list.fields) list.fields = [...v.list.fields]
    out.list = list
  }
  if (v.listTable) out.listTable = v.listTable.sort ? { sort: { ...v.listTable.sort } } : {}
  return out
}

/** 往列表里加一个视图（**幂等**：同一个 id 已在就替换） */
export function upsertView(views: readonly ViewConfig[], next: ViewConfig): ViewConfig[] {
  const out = views.map(cloneView)
  const at = out.findIndex((v) => v.id === next.id)
  if (at >= 0) out[at] = cloneView(next)
  else out.push(cloneView(next))
  return out
}

/** 删一个视图：只动配置，一个字节记录都不碰（不变量 1） */
export function removeView(views: readonly ViewConfig[], id: string): ViewConfig[] {
  return views.filter((v) => v.id !== id).map(cloneView)
}

/** 给视图改名（空名 ＝ 清掉名字，回到「按 kind 的默认名」） */
export function renameView(views: readonly ViewConfig[], id: string, name: string): ViewConfig[] {
  return views.map((v) => {
    const next = cloneView(v)
    if (next.id !== id) return next
    if (name.trim() === '') delete next.name
    else next.name = name.trim()
    return next
  })
}

/** 写表格的排序列（`undefined`／空数组 ＝ 不排序，删掉那一格而不是留个空数组） */
export function withSort(view: ViewConfig, sort: readonly SortKey[] | undefined): ViewConfig {
  const next = cloneView(view)
  if (!next.table) next.table = { columns: [] }
  if (!sort || sort.length === 0) delete next.table.sort
  else next.table.sort = sort.map((s) => ({ ...s }))
  return next
}

/** 写列（显隐/宽度/顺序）：整组替换，一次一条 `prop.set` */
export function withColumns(view: ViewConfig, columns: readonly ViewColumn[]): ViewConfig {
  const next = cloneView(view)
  if (!next.table) next.table = { columns: [] }
  next.table.columns = columns.map((c) => ({ ...c }))
  return next
}

/** 写记录列表的字段（空 ⇒ 只显示标题） */
export function withListFields(view: ViewConfig, fields: readonly string[] | undefined): ViewConfig {
  const next = cloneView(view)
  const list: ListConfig = { ...(next.list ?? {}) }
  if (!fields || fields.length === 0) delete list.fields
  else list.fields = [...fields]
  next.list = list
  return next
}

/**
 * 写结构映射表的排序（`undefined`／空 ⇒ 删掉那一格，回到 children 顺序）。
 *
 * 与 `withSort` 分开：那边的键是列定义，这边的键是**位置**（第几列）。
 */
export function withListSort(view: ViewConfig, sort: ListSort | undefined): ViewConfig {
  const next = cloneView(view)
  if (!sort) {
    delete next.listTable
    return next
  }
  next.listTable = { sort: { col: sort.col, dir: sort.dir } }
  return next
}

/** 默认名字（切换器上的文案；用户改过名就用他自己的） */
export function viewNameOf(v: ViewConfig, label: (kind: StoredViewKind) => string): string {
  const name = v.name?.trim()
  return name && name !== '' ? name : label(v.kind)
}

export { ACTIVE_VIEW_PROP, VIEWS_PROP }
