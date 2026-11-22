import { collatorLocale } from '../infra/locale.ts'
/**
 * 视图的**记录投影族**：记录（`ViewRecord`）、结构列、分组、行序——
 * 「有哪些记录、按什么序」住这里，「怎么画」住 `ui/views/*`，
 * 视图配置词汇住 `view.ts`（它从这里再导出，**对外的符号名不变**）。
 *
 * 为什么单独一个文件：这是视图层唯一吃**读门面**（`KbClient`）的段——
 * 记录是派生的（每次装载按 id 现读），不缓存、不落盘；把它与配置读写分住，
 * 「配置怎么存」的改动碰不到「记录怎么算」。
 *
 * 与 `view.ts` 的两条类型引用（`Source`／调用方拿 `ViewRecord`）编译期擦除，
 * 运行时依赖单向（records → view 的列词汇，再 → 各读路径模块）。
 */
import { hasList, isDeleted, liveChildren, type Block, type BlockProps } from '../model/model.ts'
import { displayNameOf } from '../identity/alias.ts'
import { journalDateInChain } from '../identity/journal.ts'
import { tagIdsOf } from '../identity/tags.ts'
import { plainText } from '../model/runs.ts'
import { t } from '../infra/msg.ts'
import type { KbClient } from '../kb/types.ts'
import { declaredFieldIds, ENGINE_CREATED, ENGINE_MODIFIED, ownFieldIds } from '../props/props.ts'
import { randomRankOf, type QuerySpec, type SortKey } from '../query/query.ts'
import {
  CHILDREN_COLUMN,
  CREATED_COLUMN,
  MATCHED_COLUMN,
  MODIFIED_COLUMN,
  PATH_COLUMN,
  REF_COUNT_COLUMN,
  REL_KINDS_COLUMN,
  SHARED_TAGS_COLUMN,
  TAGS_COLUMN,
  TITLE_COLUMN,
  VIA_COLUMN,
} from './view.ts'
import type { Source } from './view.ts'
/* ------------------------------------------------------------ 记录层 */

/**
 * 表格／卡片／日历共用的一条记录。
 *
 * ⚠️ 记录是**派生的**（每次装载按 id 现读），不缓存、不落盘：
 * 缓存一份就等于承认「表里的值」可以短暂地不是块上的值。
 */
export interface ViewRecord {
  block: Block
  /** 从根到父（不含自己）；children 为 `[容器]`；query 为命中祖先 */
  path: readonly Block[]
  /** 正文的纯文本投影（排序与紧凑列表用；表里画的是 run，不是这个） */
  title: string
  tags: readonly Block[]
  /** 属性袋的只读视图（按列键取值用；不拷一份 Map：5k 行不值得） */
  values: BlockProps
  /**
   * **派生的列**（`refCount`／`matched`／`sharedTags`）：由源适配器现算填进来。
   *
   * 它们不进 `props`、不落盘、不参与复制 —— 写进内容层就会在数据变了之后说谎。
   */
  derived?: Readonly<Record<string, unknown>>
}

/**
 * 记录行的标签块：**按 `_tags` 里的 id 点查**，不调 `kb.tagsOf`。
 *
 * `kb.tagsOf` 每次都会建一张全库标签表（`tagsById`）；表格/卡片是「每行一条记录」，
 * 按行调用就是 O(行 × 库)。这里只按这一行实际带的几个 id 走读门面的 O(1) 取块，
 * 成本回到 O(行 × 该行标签数)。顺序仍是用户打的先后，重复 id 只算一次；
 * 未装载/已删/已摘标签身份的块跳过（与 `tagsOf` 同一条可见性口径）。
 */
function rowTagsOf(block: Block, kb: KbClient): Block[] {
  const out: Block[] = []
  const seen = new Set<string>()
  for (const id of tagIdsOf(block)) {
    if (seen.has(id)) continue
    seen.add(id)
    const tag = kb.get(id)
    if (tag && hasList(tag, 'tag')) out.push(tag)
  }
  return out
}

function recordOf(block: Block, path: readonly Block[], kb: KbClient): ViewRecord {
  return {
    block,
    path,
    title: plainText(block.content),
    tags: rowTagsOf(block, kb),
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

/** 结构分组的一列：一级子块（＝组）＋ 它活着的直接子块（＝组里的记录） */
export interface StructureColumn {
  block: Block
  items: readonly Block[]
}

/**
 * **结构分组的最底层派生**：一级子块当组、它的直接子块当记录。
 *
 * 与 `childrenRecords` 只差一层（那边一级子块就是记录）。`list-table` 与
 * 「按一级子块分组的卡片」共用这一份——两处各取一次树，迟早会在
 * 「软删跳过」「组顺序」这些分支上各漂各的。
 *
 * 组顺序＝`children` 顺序；空组**保留**（它是一个真实子块，还能拖卡进去）。
 */
export function structuralColumnsOf(rootId: string, kb: KbClient): StructureColumn[] {
  const root = kb.get(rootId)
  if (!root) return []
  const out: StructureColumn[] = []
  for (const child of kb.children(rootId)) {
    if (isDeleted(child)) continue
    out.push({ block: child, items: kb.children(child.id).filter((b) => !isDeleted(b)) })
  }
  return out
}

/** 结构分组的一组：组块 ＋ 组里的记录（卡片消费；与 `list-table` 共用底层派生） */
export interface StructureGroup {
  block: Block
  records: readonly ViewRecord[]
}

export function structureGroupsOf(rootId: string, kb: KbClient): StructureGroup[] {
  const root = kb.get(rootId)
  if (!root) return []
  return structuralColumnsOf(rootId, kb).map((col) => ({
    block: col.block,
    // 路径到组块为止：记录属于那一组，不是容器的直接子块
    records: col.items.map((item) => recordOf(item, [root, col.block], kb)),
  }))
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

/* ------------------------------------------------------------ 列 */

/** 一列的默认宽度：按列的种类给（宽度是配置，但第一次必须有个能看的起点） */
export function defaultWidthOf(key: string): number {
  if (key === TITLE_COLUMN) return 260
  if (key === CHILDREN_COLUMN) return 84
  if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) return 150
  if (key === TAGS_COLUMN) return 160
  if (key === PATH_COLUMN) return 220
  if (key === REF_COUNT_COLUMN) return 96
  if (key === REL_KINDS_COLUMN) return 180
  if (key === VIA_COLUMN) return 120
  if (key === MATCHED_COLUMN) return 150
  if (key === SHARED_TAGS_COLUMN) return 160
  return 140
}

/**
 * 两键兜底：空源也要有能看的起点，但只放**真有内容的那一键**。
 * 系统元数据（子块数/创建/修改/路径）不默认占位：它们是「什么时候动过」不是「这块是什么」，
 * 而兜底出现的时机恰是「子块还没声明任何字段」——最该引导去声明字段的时候，
 * 摆几键凑数只会把「添加属性」的那一步往后推。想要它们走显示白名单（`core.view/set-display`）。
 */
function fallbackPropKeys(): string[] {
  return [TAGS_COLUMN]
}

/** 一批块「实际拥有的属性」⇒ 显示键（不逐行扫库，只看前若干个） */
function keysFromBlocks(blocks: readonly Block[], kb: KbClient, limit: number): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  outer: for (const child of blocks) {
    const ids = [...ownFieldIds(child)]
    for (const tag of rowTagsOf(child, kb)) ids.push(...declaredFieldIds(tag))
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      keys.push(id)
      if (keys.length > limit) break outer
    }
  }
  return keys.length > 0 ? keys : fallbackPropKeys()
}

/**
 * 条件里的 `tag`／`prop` 提到哪些键。
 *
 * 为什么先问条件：一个「任务清单」查询的显示就该是**它筛的那几个字段**，
 * 而不是命中里碰巧前四条带着的槽 —— 后者会随数据漂移，而白名单只算一次。
 */
function keysFromSpec(spec: QuerySpec, kb: KbClient): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    keys.push(id)
  }
  const visit = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const node = n as Record<string, unknown>
    if ('all' in node && Array.isArray(node.all)) return node.all.forEach(visit)
    if ('any' in node && Array.isArray(node.any)) return node.any.forEach(visit)
    if ('not' in node) return visit(node.not)
    if ('up' in node) return visit(node.up)
    if ('down' in node) return visit(node.down)
    if ('near' in node) return visit(node.near)
    if (typeof node.tag === 'string') {
      const tag = kb.findTag(node.tag)
      if (tag) for (const id of declaredFieldIds(tag)) push(id)
      return
    }
    const p = node.prop
    if (p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string') push((p as { id: string }).id)
  }
  visit(spec.where)
  return keys
}

/**
 * **表格缺省时的计算列**（显示轴的缺省答案，**唯一入口**；不在各渲染器里各算一套）。
 *
 * 两份源各有各的问法：
 *   · **query**：先看条件里的标签声明与属性条件，再看前若干条命中的自有属性；
 *   · **children**：看前几个直接子块实际拥有的属性 ＋ 标签声明。
 * 一个都没有 ⇒ 退回标签一列。
 *
 * 返回**不含标题列**的键清单（标题恒在第一位，由渲染器自己放）。
 * ⚠️ 之后**不随结果自动变**：显示随结果漂移比列少更烦人；一旦写过 `displayProps`
 *    白名单就稳定（不再算缺省）。
 */
export function defaultDisplayPropsFor(
  source: Source,
  kb: KbClient,
  opts: { hits?: readonly { blockId: string }[]; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? 4
  if (source.kind === 'children') {
    const root = kb.get(source.blockId)
    return keysFromBlocks(root ? [...kb.children(source.blockId)].filter((b) => !isDeleted(b)) : [], kb, limit)
  }
  // query：条件优先，命中兜底
  const fromSpec = keysFromSpec(source.spec, kb)
  if (fromSpec.length > 0) return fromSpec
  const hits = opts.hits ?? []
  const blocks = hits
    .slice(0, limit + 1)
    .map((h) => kb.get(h.blockId))
    .filter((b): b is Block => b !== undefined)
  return blocks.length > 0 ? keysFromBlocks(blocks, kb, limit) : fallbackPropKeys()
}

/** 一条记录在树里的位置：祖先的显示名拼接（空祖先跳过） */
export function pathTextOf(r: ViewRecord): string {
  const names: string[] = []
  for (const b of r.path) {
    const name = displayNameOf(b).trim()
    if (name !== '') names.push(name)
  }
  return names.join(' / ')
}

/**
 * 一格的**纯文本**（卡片用；表格画的是 run，不走这里）。
 *
 * `resolve` 给「值是一个块 id」的列（`select` 的选项、`ref` 的目标）一次解析机会：
 * 那些值按 id 直接显示是一串 hex，用户看不懂。解析不到就原样显示 ——
 * **数据不静默消失**（「选项已删除」那种状态要看得见，而不是空白）。
 */
export function fieldTextOf(r: ViewRecord, key: string, resolve?: (value: unknown) => string | null): string {
  if (key === TITLE_COLUMN) return r.title
  if (key === TAGS_COLUMN) return r.tags.map((t) => plainText(t.content)).join(' ')
  if (key === CHILDREN_COLUMN) return String(liveChildren(r.block).length)
  if (key === PATH_COLUMN) return pathTextOf(r)
  if (key === REF_COUNT_COLUMN) {
    const v = r.derived?.[REF_COUNT_COLUMN]
    return typeof v === 'number' ? String(v) : ''
  }
  if (key === REL_KINDS_COLUMN) {
    const v = r.derived?.[REL_KINDS_COLUMN]
    return Array.isArray(v) ? v.map((x) => String(x)).join(' · ') : ''
  }
  if (key === VIA_COLUMN) {
    if (r.derived?.viaDirect === true) return t('ui.mount.via.direct')
    const v = r.derived?.viaTags
    return Array.isArray(v) ? v.map((x) => `#${String(x)}`).join(' · ') : ''
  }
  if (key === MATCHED_COLUMN) {
    const v = r.derived?.[MATCHED_COLUMN]
    return typeof v === 'string' ? v : ''
  }
  if (key === SHARED_TAGS_COLUMN) {
    const v = r.derived?.[SHARED_TAGS_COLUMN]
    return Array.isArray(v) ? v.map((x) => String(x)).join(' ') : ''
  }
  if (key === CREATED_COLUMN || key === MODIFIED_COLUMN) {
    const at = key === CREATED_COLUMN ? r.block.created : r.block.modified
    return new Date(at).toLocaleDateString(collatorLocale())
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
 * `_date` 读**所属的那一天**（与成员排序同一份取值，`journalDateInChain`）：
 * 行自己不是日记时，它住在哪一天下面，那一天就是它的日志时间。
 * 定义缺失时值照旧返回（「数据不静默消失」）。
 */
export function sortValueOf(r: ViewRecord, key: string): unknown {
  if (key === TITLE_COLUMN) return r.title
  if (key === CHILDREN_COLUMN) return liveChildren(r.block).length
  if (key === CREATED_COLUMN) return r.block.created
  if (key === MODIFIED_COLUMN) return r.block.modified
  if (key === TAGS_COLUMN) return r.tags.map((t) => plainText(t.content)).join(' ')
  if (key === PATH_COLUMN) return pathTextOf(r)
  if (key === '_date') return journalDateInChain(r.block, r.path)
  // 「随机」在显示排序里也是同一个确定性序值（种子 0）：成员排序与视图排序共用一份
  // 哈希，同一个键在两个面不会给出两个顺序
  if (key === 'random') return randomRankOf(r.block.id, undefined)
  // 派生列按**数**排（引用次数 9 < 10；按串排会得到 10 < 9），其余按显示文本
  if (key === REF_COUNT_COLUMN) {
    const v = r.derived?.[REF_COUNT_COLUMN]
    return typeof v === 'number' ? v : undefined
  }
  if (key === REL_KINDS_COLUMN || key === VIA_COLUMN || key === MATCHED_COLUMN || key === SHARED_TAGS_COLUMN) {
    return fieldTextOf(r, key)
  }
  return r.values[key]
}

/**
 * 显示白名单的**列键 → 块下行的 propId**。
 *
 * `created`／`modified` 在列面上是保留键，在行面上是引擎属性（`core/created` 那一对，
 * 值住块字段）。两套键各说各的语言，这里是唯一一座桥：卡片与大纲都读这一份，
 * 免得某处把 `created` 当普通属性去 `props['created']` 里找（永远找不到，
 * 表现就是「勾了不出现」）。
 */
export function displayRowPropId(key: string): string {
  if (key === CREATED_COLUMN) return ENGINE_CREATED
  if (key === MODIFIED_COLUMN) return ENGINE_MODIFIED
  return key
}

/**
 * 显示白名单里**能落成块下行**的那一批（`undefined` ＝ 不覆写）。
 *
 * 列面上的 `tags`／`children`／`path` 在行面上没有对应物件（标签是正文原子／chips，
 * 子块与位置由缩进与面包屑表达）——让它们进 `wanted` 只会补出一条「待填」的裸键行。
 * 卡片与大纲共用这一份，免得两处各判一遍、漏一个键就多出一条假行。
 */
export function displayRowPropIds(keys: readonly string[] | undefined): string[] | undefined {
  if (keys === undefined) return undefined
  return keys.map(displayRowPropId).filter((id) => id !== TAGS_COLUMN && id !== CHILDREN_COLUMN && id !== PATH_COLUMN)
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
  return String(a).localeCompare(String(b), collatorLocale(), { numeric: true, sensitivity: 'base' })
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
 *
 * ⚠️ **排序键按配置原样生效**，包括 `created`／`modified` 这类保留键：视图面板写得进
 * 它们（「按创建时间排」是画廊最常用的镜头之一），渲染层再过滤一遍就是「写了不生效」。
 * 表头能不能点（`isSortableColumn`）是**表头那一层的可操作性**，不是这里的过滤理由。
 */
export function sortRecords(
  records: readonly ViewRecord[],
  sort: readonly SortKey[] | undefined,
  resolve?: (r: ViewRecord, key: string) => unknown,
): ViewRecord[] {
  const keys = sort ?? []
  if (keys.length === 0) return [...records]
  const valueOf = (r: ViewRecord, k: SortKey): unknown =>
    k.by === 'random' ? randomRankOf(r.block.id, k.seed) : resolve ? resolve(r, k.by) : sortValueOf(r, k.by)
  const indexed = records.map((r, i) => ({ r, i }))
  indexed.sort((x, y) => {
    for (const k of keys) {
      const va = valueOf(x.r, k)
      const vb = valueOf(y.r, k)
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
