/**
 * **视图配置**：一个块**怎么看**（不是它是什么）。
 *
 * 三条判据（与模型层的「数据只回答是什么」同源）：
 *   · **视图不是新实体**：配置住在容器的两个系统属性里（`_views`／`_activeView`），
 *     不造视图块、不引入 `_type`。旧库没有这两格 ⇒ 读作大纲。
 *   · **源是派生的**：有 `_query` 就是查询源（命中集合），否则就是 children 源（直接子块）。
 *     不存 `_source`，因为「它是什么」已经由数据回答了。
 *   · **配置入 KB、状态外挂**：列/序/行高是「这个视图是什么」⇒ 进库；滚动/选中/当前行是
 *     「我此刻看到哪」⇒ 设备状态，这里一概不碰。
 *
 * ⚠️ 本文件**零 DOM、零写库**：读只吃块与读门面，写由命令层在事务里做。
 * ⚠️ 行／记录层与「怎么画」分开：这里只回答「有哪些记录、按什么序」，
 *    `ui/view-table.ts` 才决定画成表还是列表。看板/画廊/日历/导图是同一层的后续渲染器，
 *    本刀只实现 `table`。
 */
import { ACTIVE_VIEW_PROP, VIEWS_PROP, isDeleted, isQueryBlock, type Block, type BlockProps } from './model.ts'
import type { KbClient } from './kb/types.ts'
import { declaredFieldIds, ownFieldIds } from './props.ts'
import { plainText } from './runs.ts'
import type { SortKey } from './query.ts'

/* ------------------------------------------------------------ 类型 */

/**
 * 视图种类。`outline` **不落盘**——它等价于「没有激活视图」。
 *
 * 为什么把它列进来：切换器的选项里有「大纲」，而用户看到的是一串同级的名字；
 * 但 `ViewConfig.kind` 收窄成 `Exclude<…,'outline'>`，于是「大纲」没有配置可存。
 */
export type ViewKind = 'outline' | 'table' | 'board' | 'gallery' | 'calendar' | 'mindmap'

/** 可落盘的视图种类（`outline` 不在其中） */
export type StoredViewKind = Exclude<ViewKind, 'outline'>

const STORED_KINDS: readonly StoredViewKind[] = ['table', 'board', 'gallery', 'calendar', 'mindmap']

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
  sort?: SortKey[]
}

/**
 * 一个命名视图（`_views[]` 里的一项）。
 *
 * 只保留**这个 kind 自己的**子配置：table 视图不带着 board 配置走（两份配置迟早分叉）。
 */
export interface ViewConfig {
  id: string
  name?: string
  kind: StoredViewKind
  table?: TableConfig
  board?: { groupBy: string; groupOrder?: string[]; cardFields?: string[]; showEmpty?: boolean }
  gallery?: { cover?: 'first-asset' | 'none'; cardFields?: string[]; size?: 's' | 'm' | 'l' }
  calendar?: { dateBy: string; showUndated?: boolean }
  mindmap?: { cardFields?: string[]; direction?: 'both' | 'right' }
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

/** `_activeView` 的形状：非空字符串（能不能解析到视图由 `activeView` 判） */
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

/**
 * 逐项重建视图列表（与 `canonicalSpec` 同一条纪律）。
 *
 * 判据与后果：
 *   · `kind` 不在枚举里／`id` 重复（后者丢弃）／形状不对 ⇒ **丢掉该项**，不抛；
 *   · 只保留 `kind` 对应的那份子配置；
 *   · **查询源 ＋ `mindmap`** 也丢弃：v1 导图只接子树（查询源没有「整棵子树」可画）。
 *
 * 为什么不抛：JSON／旧库里的一个错键不该让**整个块打不开** ——
 * 用户看到的是「没有结果」，而真相是「这封信没人读得懂」。丢掉那一项、回大纲、
 * 由调用方提示一句，比让一块内容消失好。
 */
export function canonicalViews(raw: unknown, source?: ViewSource): ViewConfig[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ViewConfig[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as Partial<ViewConfig>
    if (!isStr(v.id) || seen.has(v.id)) continue
    const kind = v.kind
    if (typeof kind !== 'string' || !STORED_KINDS.includes(kind as StoredViewKind)) continue
    if (source?.kind === 'query' && kind === 'mindmap') continue
    const view: ViewConfig = { id: v.id, kind: kind as StoredViewKind }
    if (isStr(v.name)) view.name = v.name
    // **只留这个 kind 自己的那份**：别的 kind 的配置跟着一个不存在的 kind 走，
    // 切过去时是「上一份视图的残留」，而没人能说清它该不该生效
    if (kind === 'table') {
      const table = tableOf(v.table)
      if (table) view.table = table
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
 * `null` ＝ 大纲（也是「`_activeView` 缺失／指向一个不存在的 id」的答案）——
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
 * 这一块**是不是「一个视图的宿主」**：查询块，或激活了某个非大纲视图的块。
 *
 * 装配层用它决定「这一段的段尾要不要建视图宿主」——写成一处，
 * 免得「查询块」与「普通块带视图」各自在装配层里判一遍（早晚分叉）。
 */
export function isViewRoot(b: Block | undefined): boolean {
  if (!b) return false
  return isQueryBlock(b) || activeView(b) !== null
}

/* ------------------------------------------------------------ 源 */

/**
 * 行／节点的来源（**派生不落盘**）。
 *
 * 「取直接子块还是整棵子树」由 kind 决定（表格看直接子块、导图看整棵子树），不是源的一部分：
 * 同一个 children 源，表格看直接子块、导图看整棵子树。
 */
export type ViewSource = { kind: 'query'; blockId: string } | { kind: 'children'; blockId: string }

export function sourceOf(b: Block): ViewSource {
  if (isQueryBlock(b)) return { kind: 'query', blockId: b.id }
  return { kind: 'children', blockId: b.id }
}

/* ------------------------------------------------------------ 记录层 */

/**
 * 表格/看板/画廊/日历共用的一条记录。
 *
 * ⚠️ 记录是**派生的**（每次装载按 id 现读），不缓存、不落盘：
 * 缓存一份就等于承认「表里的值」可以短暂地不是块上的值。
 */
export interface ViewRecord {
  block: Block
  /** 从根到父（不含自己）；children 源为 `[容器]`，顶层块为 `[]` */
  path: readonly Block[]
  /** 正文的纯文本投影（排序与紧凑列表用；表里画的是 run，不是这个） */
  title: string
  tags: readonly Block[]
  /** 属性袋的只读视图（按列键取值用；不拷一份 Map：5k 行不值得） */
  values: BlockProps
}

function recordOf(block: Block, path: readonly Block[], kb: KbClient): ViewRecord {
  return {
    block,
    path,
    title: plainText(block.content),
    tags: [...kb.tagsOf(block.id)],
    values: block.props ?? {},
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
 * 不传 `selfId` 给求值：那会改变 `$self` 的语义。
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

/* ------------------------------------------------------------ 列 */

/** 一列的默认宽度：按列的种类给（宽度是配置，但第一次必须有个能看的起点） */
export function defaultWidthOf(key: string): number {
  if (key === TITLE_COLUMN) return 260
  if (key === CHILDREN_COLUMN) return 84
  if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) return 150
  if (key === TAGS_COLUMN) return 160
  return 140
}

/**
 * 第一次切到这张视图时的默认列（**只算一次**，算完由命令层写进 `table.columns`）。
 *
 * 判据：children 源看子块**实际拥有的属性**（不逐行扫库：
 * 只看前若干个子块、且只用块自己身上的槽与标签声明）；一个都没有就退回
 * `title`／`tags`／`children`／`modified` 这四列——空表也要有列头，
 * 否则用户不知道「这里能放什么」。
 *
 * ⚠️ 之后**不随结果自动变**：列宽/列序会随结果漂移，那比列少更烦人。
 */
export function defaultColumns(rootId: string, kb: KbClient, opts: { limit?: number } = {}): ViewColumn[] {
  const limit = opts.limit ?? 4
  const cols: ViewColumn[] = [{ key: TITLE_COLUMN, width: defaultWidthOf(TITLE_COLUMN) }]
  const seen = new Set<string>()
  const children = kb.children(rootId)
  outer: for (const child of children) {
    const ids = [...ownFieldIds(child)]
    for (const tag of kb.tagsOf(child.id)) ids.push(...declaredFieldIds(tag))
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      cols.push({ key: id, width: defaultWidthOf(id) })
      if (cols.length > limit) break outer
    }
  }
  if (cols.length === 1) {
    cols.push(
      { key: TAGS_COLUMN, width: defaultWidthOf(TAGS_COLUMN) },
      { key: CHILDREN_COLUMN, width: defaultWidthOf(CHILDREN_COLUMN) },
      { key: MODIFIED_COLUMN, width: defaultWidthOf(MODIFIED_COLUMN) },
    )
  }
  return cols
}

/** 可见列（`hidden` 的保留配置但不画） */
export function visibleColumns(columns: readonly ViewColumn[]): ViewColumn[] {
  return columns.filter((c) => c.hidden !== true)
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
 * 按视图的 `sort` 排记录。
 *
 * 三条口径：
 *   · **空值永远排最后**（升序降序都一样）——`未设置` 不是最小值，它只是还没有；
 *   · 多键按声明序依次比较；
 *   · **稳定**：相等的行保持来源顺序（children 顺序），否则「排序后 children 顺序」
 *     这种断言永远说不清是稳定还是碰巧。
 */
export function sortRecords(records: readonly ViewRecord[], sort: readonly SortKey[] | undefined): ViewRecord[] {
  const keys = (sort ?? []).filter((k) => isSortableColumn(k.by))
  if (keys.length === 0) return [...records]
  const indexed = records.map((r, i) => ({ r, i }))
  indexed.sort((x, y) => {
    for (const k of keys) {
      const va = sortValueOf(x.r, k.by)
      const vb = sortValueOf(y.r, k.by)
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

/** 默认名字（切换器上的文案；用户改过名就用他自己的） */
export function viewNameOf(v: ViewConfig, label: (kind: StoredViewKind) => string): string {
  const name = v.name?.trim()
  return name && name !== '' ? name : label(v.kind)
}

export { ACTIVE_VIEW_PROP, VIEWS_PROP }
