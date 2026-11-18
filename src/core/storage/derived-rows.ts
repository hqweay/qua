/**
 * **派生层的行编码**：一片森林 → `BlockIndex`／`BlockRelation` 两张派生表的行。
 *
 * ## 为什么是「森林 → 行」，不是另一套块语义
 *
 * 这两张表回答的问题，内存里的 `Index` 早就回答了（`rootOf`／先序位置／关系边）。
 * 要做的不该是再写一份答案，而是**把同一份答案放进 SQLite**：库大时不必在渲染层
 * 为整库重建 `Index`，反链／查询／排序都能按索引查。
 *
 * ⇒ 本文件**不另写走树与关系提取**：
 *   · 走树用 `walkForest`（可见性、兄弟序的全仓唯一判据）；
 *   · 关系边用 `relationEdgesOfBlock`（kind 语义的唯一判据）。
 * 这里只做「投影成行」这件事，外加路径编码。两份答案会漂，投影不会。
 *
 * ## 三格的口径
 *
 * | 格 | 是什么 | 谁维护 |
 * |---|---|---|
 * | `BlockIndex.root` | 顶层祖先（自己就是根时＝自己） | 重建／移动子树 |
 * | `BlockIndex.path` | 由 `parent`／`left` 物化的**先序键**（定长段，前缀＝子树） | 重建／插入／移动 |
 * | `BlockIndex.hidden` | **自己或祖先**被软删 ⇒ `1`，否则 `null` | 删除／恢复（按 path 前缀重算） |
 * | `BlockRelation` | 源块的全部出向边，按 `(from,to,kind)` 去重 | 重建／源块内容或属性变化 |
 *
 * ## 两处刻意的选择
 *
 * 1. **`BlockIndex` 含被软删的块**（`hidden=1`）：回收站、恢复、按 id 找回都不能
 *    依赖「全库可见」。`hidden` 是一条独立的派生位，查询自己决定要不要过滤。
 * 2. **`BlockRelation` 只收可见块发出的边**：与 `Index` 的可见性判据逐字一致
 *    （`walkForest` 默认跳过被删子树）。恢复一个子树时，它的边按子树重算；
 *    这件事属于内容写事务，不是这里。
 *
 * ## 路径格式（`path` 是可排序文本，不是给人看的）
 *
 * 每层一个**定宽偏置十进制**段：`rank + PATH_SEGMENT_BIAS`，左补零到
 * `PATH_SEGMENT_WIDTH`，段间 `/`，整条以 `/` 开头和结尾。于是：
 *
 *   · 字典序 ＝ 先序（父路径是子路径的前缀，前缀先生）；
 *   · 子树 ＝ `path LIKE '<root path>%'`；
 *   · 增量维护用中点 rank 时，插入/移动只改被移子树的段（按前缀批量 update），
 *     不必重排后面的兄弟；重建是另一条路径，按兄弟下标铺段。
 *
 * 偏置让**负数 rank 仍可字典序比较**（前插会产生负 rank）。rank 的步长与内存
 * 先序 rank 同源（`ORDER_STEP`）；重建按兄弟下标铺 `(i+1)*ORDER_STEP`，
 * 与 `assignSubtreeRanks` 一致。编码器只接受整数 rank —— 写路径的中点插入
 * 若产生小数，应当整层重编号（`renumberLevel` 的形状），而不是截断后静默错序。
 */
import { isDeleted, type Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import { ORDER_STEP } from '../infra/order.ts'
import { collectPropKinds, relationEdgesOfBlock, type RelationKind } from '../relations/relations.ts'
import { META_KEYS } from '../identity/library.ts'
import { rowsToWorkspace, type RawLibraryRows, type RowWrite } from './db-rows.ts'

/** 一段 rank 的偏置：让负数 rank 的编码仍是等宽非负十进制 */
export const PATH_SEGMENT_BIAS = 1_000_000_000_000
/** 一段 rank 的宽度（13 位：偏置之后可表示约 ±9.99e12 的 rank） */
export const PATH_SEGMENT_WIDTH = 13

/** 一行 `BlockIndex`（列名与 DDL 逐字一致） */
export interface BlockIndexRow {
  block: string
  root: string
  path: string
  hidden: 1 | null
}

/** 一行 `BlockRelation`（`from_id`／`to_id` 即关系语义里的 from／to；避开 SQL 关键字） */
export interface BlockRelationRow {
  from_id: string
  to_id: string
  kind: RelationKind
  from_root: string
  /** 同一源块里出现几次（inline／tagMention 有；其余单边为 null——读侧按 1 算） */
  count: number | null
}

export interface DerivedRows {
  index: BlockIndexRow[]
  relations: BlockRelationRow[]
}

/** 一层 rank → 定宽段（不含分隔符） */
function encodeRank(rank: number): string {
  if (!Number.isInteger(rank)) {
    throw new Error(`derived path: rank must be an integer, got ${rank}`)
  }
  const v = rank + PATH_SEGMENT_BIAS
  const text = String(v)
  if (v < 0 || text.length > PATH_SEGMENT_WIDTH) {
    throw new Error(`derived path: rank ${rank} out of encodable range`)
  }
  return text.padStart(PATH_SEGMENT_WIDTH, '0')
}

/** 段 + 尾分隔符：父路径直接拼它得到子路径（父路径是子路径的前缀） */
export function pathSegmentOf(rank: number): string {
  return `${encodeRank(rank)}/`
}

/**
 * 路径末段 → rank（`pathSegmentOf` 的逆）。坏路径返回 `NaN`——调用方必须把它当
 * 「这段不可用」（例如放弃中点、整层重编号），不要拿 `NaN` 去比较。
 */
export function lastSegmentRank(path: string): number {
  const end = path.endsWith('/') ? path.length - 1 : path.length
  const start = path.lastIndexOf('/', end - 1)
  const text = path.slice(start + 1, end)
  if (!/^\d+$/.test(text)) return Number.NaN
  return Number(text) - PATH_SEGMENT_BIAS
}

/**
 * 整片森林的派生行。
 *
 * ⚠️ 这是**全量重建**：O(库) 时间与内存（`rowsToWorkspace` 会建整片模型）。
 * 启动路径不许调它；它是迁移／修复／批量重建的语义基准。流式重建是另一条批量路径
 * （逐批解析、逐批写），本函数是它的正确性基准。
 */
export function derivedRowsOf(forest: readonly Block[]): DerivedRows {
  return derive(forest, null)
}

/**
 * 只给**指定块**的派生行（内容写事务的增量维护入口）。
 *
 * `blocks` 是「这次可能变了的块」：改内容的块、移动的子树、删除/恢复的子树。
 * 它只影响**自己发出的边**与**自己的 index 行**；指向它们的边属于别的源块，
 * 不在这个集合里。集合外的旧行由 `derivedPruneWrites` 清掉。
 *
 * 成本：几趟全林走查（位置一趟；可见集三趟：定义 kind／anno／关系），
 * 与库大小有关但与「这次改了几块」无关 —— 写路径若发现这是热路径，再收窄到子树窗口；
 * 语义先保证一份。
 */
export function derivedRowsOfBlocks(forest: readonly Block[], blocks: Iterable<string>): DerivedRows {
  const wanted = blocks instanceof Set ? blocks : new Set(blocks)
  if (wanted.size === 0) return { index: [], relations: [] }
  return derive(forest, wanted)
}

function derive(forest: readonly Block[], wanted: ReadonlySet<string> | null): DerivedRows {
  const index: BlockIndexRow[] = []
  /** 祖先链的先序键与根：子块直接拼父块那两格（walkForest 是先序，父一定先访问） */
  const pathOf = new Map<string, string>()
  const rootOf = new Map<string, string>()
  const hiddenOf = new Map<string, boolean>()

  walkForest(
    forest,
    (b, ctx) => {
      const path = ctx.parent === null ? `/${pathSegmentOf((ctx.index + 1) * ORDER_STEP)}` : `${pathOf.get(ctx.parent.id)!}${pathSegmentOf((ctx.index + 1) * ORDER_STEP)}`
      const root = ctx.parent === null ? b.id : rootOf.get(ctx.parent.id)!
      const hidden = isDeleted(b) || (ctx.parent !== null && hiddenOf.get(ctx.parent.id) === true)
      pathOf.set(b.id, path)
      rootOf.set(b.id, root)
      hiddenOf.set(b.id, hidden)
      if (wanted === null || wanted.has(b.id)) {
        index.push({ block: b.id, root, path, hidden: hidden ? 1 : null })
      }
    },
    // 被删的块与子树也在树上（原位软删）：index 要收它们，用 hidden 表达不可见
    { includeDeleted: true },
  )

  /**
   * 关系边的两条前置表，与 `Index.rebuild` 同一口径：
   *   · `propKinds` 只收**可见**的字段定义（定义被删 ⇒ 那格属性不再算关系）；
   *   · `annoHosts` 只收可见块的 anno（引用的 `to` 必须是块 id：在边生成处归一化一次）。
   */
  const propKinds = collectPropKinds(forest)
  const annoHosts = new Map<string, { hostId: string }>()
  walkForest(forest, (b) => {
    for (const a of b.annos ?? []) annoHosts.set(a.id, { hostId: b.id })
  })

  const relations: BlockRelationRow[] = []
  const seen = new Set<string>()
  walkForest(forest, (b) => {
    if (wanted !== null && !wanted.has(b.id)) return
    for (const e of relationEdgesOfBlock(b, propKinds, annoHosts)) {
      /**
       * 去重键只有 `(from,to,kind)`：同一源到同一目标的多条边（同一块里引用两次、
       * 多个 anno 区间指向同一段）在「谁指向谁」这个问题下是一件事。
       * 计数与属性 id 仍从内容行算 —— 这张表不存它们，就不存在第二份计数。
       */
      const key = `${e.from}\u0000${e.to}\u0000${e.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      relations.push({ from_id: e.from, to_id: e.to, kind: e.kind, from_root: rootOf.get(e.from)!, count: e.count ?? null })
    }
  })

  return { index, relations }
}

/**
 * 派生行 → 通用行写入。
 *
 * `clear` 只给**全量重建**用（先清两张表再铺）；增量维护用
 * `derivedPruneWrites(affected)` ＋ 本函数的 upsert（同一事务）。
 */
export function derivedRowWrites(rows: DerivedRows, opts: { clear?: boolean } = {}): RowWrite[] {
  const out: RowWrite[] = []
  if (opts.clear === true) {
    out.push({ table: 'BlockIndex', op: 'clear', key: {} })
    out.push({ table: 'BlockRelation', op: 'clear', key: {} })
  }
  for (const r of rows.index) {
    out.push({ table: 'BlockIndex', op: 'upsert', key: { block: r.block }, values: { root: r.root, path: r.path, hidden: r.hidden } })
  }
  for (const r of rows.relations) {
    out.push({
      table: 'BlockRelation',
      op: 'upsert',
      key: { from_id: r.from_id, to_id: r.to_id, kind: r.kind },
      values: { from_root: r.from_root, count: r.count },
    })
  }
  return out
}

/**
 * 增量维护的**清旧行**：对集合里的块删 index 行、对集合里的源删它发出的全部边。
 *
 * 两个集合通常相同（这次动过的块），但分开传：移动子树时 index 的受影响面是整棵
 * 被移子树，关系的受影响面是该子树里**可见**的块（隐藏块本来就没有边行）。
 * 两个集合都按「全删再重铺」处理，不做逐边 diff —— 一块的边数很小，
 * 逐边 diff 的判据面却大得多（漏一种 kind 就静默少一条）。
 */
export function derivedPruneWrites(blocks: Iterable<string>, relationFrom: Iterable<string>): RowWrite[] {
  const out: RowWrite[] = []
  for (const id of new Set(blocks)) out.push({ table: 'BlockIndex', op: 'delete', key: { block: id } })
  for (const id of new Set(relationFrom)) out.push({ table: 'BlockRelation', op: 'delete', key: { from_id: id } })
  return out
}

/**
 * **全量重建**的完整一批行：清两张表 → 从内容行重铺 → `derived_state='ready'`。
 *
 * ⚠️ 只接受**整库**行（`readContentRows` 的结果）。一份 Doc 的局部行也能骗过类型，
 * 但拿它重建会把其余块从派生表里抹掉 —— 调用点必须是「整库重建」这一个语义。
 *
 * 状态与行写入在**同一批**（主进程同一个事务）：崩在中间只会回到 `pending`，
 * 不会留下「一半的派生表 + ready」。
 */
export function rebuildDerivedWrites(raw: RawLibraryRows): RowWrite[] {
  const ws = rowsToWorkspace(raw)
  return [
    ...derivedRowWrites(derivedRowsOf(ws.blocks), { clear: true }),
    { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedState }, values: { value: 'ready' } },
  ]
}

/**
 * 规范指纹（**用于「重建 == 增量」的断言**）。
 *
 * 排序是必须的：两条路径的铺设顺序天然不同，不排序会把「顺序不同」误报成
 * 「内容不同」。
 *
 * ⚠️ **原始 rank 数值不进契约**——与 `infra/index-port.ts` 的 `fingerprint` 同一条：
 * 重建按兄弟下标铺等步长段，增量维护在中点插入会得到不同的段值；两者的契约是
 * **同一棵有序树**，不是同一串数字。所以指纹按 `path` 排成先序，只记
 * `(块 id, root, hidden, 深度)`——先序序列 ＋ 深度序列唯一确定有序森林的形状；
 * root 与 hidden 再各挡一类错。`path` 的内部数值若被拿来比，会把正确的中点插入
 * 误报成失败，那种假失败会让人去改本来正确的代码。
 *
 * 关系边没有编码细节，直接逐行比较（排序后）。
 */
export function derivedFingerprint(rows: DerivedRows): string {
  const ordered = [...rows.index].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.block < b.block ? -1 : a.block > b.block ? 1 : 0,
  )
  const index = ordered.map((r) => [r.block, r.root, r.hidden === null ? '' : '1', String(depthOf(r.path))].join('\u0000'))
  const relations = rows.relations
    .map((r) => [r.from_id, r.to_id, r.kind, r.from_root].join('\u0000'))
    .sort()
  return JSON.stringify({ index, relations })
}

/** 路径深度（`/段/段/` ⇒ 2）：由定宽段格式直接数分隔符 */
function depthOf(path: string): number {
  let slashes = 0
  for (const ch of path) if (ch === '/') slashes++
  return slashes - 1
}
