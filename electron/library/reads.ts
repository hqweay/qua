/**
 * **主进程侧的只读执行器**：跑 `core/storage/library-reads.ts` 的具名查询，不做块语义。
 *
 * 职责只有三件：
 *   1. 用参数绑定额外的 `json_each(?)` 列表；
 *   2. 把四张表的结果拼成一个 `RawLibraryRows`（交给渲染层 `rowsToWorkspace`）；
 *   3. 把 catalog 的四个小查询原样返回。
 *
 * 它**不认识**「页／标签／日记」——那些判据在 core 的 SQL 文本里；这里只是执行器。
 * 这与行写入的纪律对称：主进程认表名/列名，不认块。
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  candidatePageSql,
  candidatePlanSql,
  gramQueryOf,
  LIBRARY_READS,
  necessaryTextNeedles,
  type CandidatePlan,
  type BlockIndexRow,
  type CandidatePage,
  type CatalogAlias,
  type CatalogJournal,
  type CatalogPropDef,
  type CatalogTag,
  type CatalogTrashRoot,
  type LibraryCatalog,
  type LibraryDocRows,
  type RawLibraryRows,
} from '../../src/core/storage/library-reads.ts'
import { META_KEYS } from '../../src/core/identity/library.ts'
import { readMeta } from './sqlite.ts'

type Row = Record<string, unknown>

/** 一个／多个 root 的子树行 ＋ 祖先链；`rows` 可直接交给 `rowsToWorkspace` */
export function readDocRows(db: DatabaseSync, rootIds: readonly string[]): LibraryDocRows {
  if (rootIds.length === 0) {
    return { rows: { blocks: [], props: [], aliases: [], lists: [], meta: {} }, ancestors: [], rootIds: [] }
  }
  const blocks = db.prepare(LIBRARY_READS.docSubtree).all(JSON.stringify(rootIds)) as Row[]
  /**
   * 祖先按 root 逐个向上查，结果按 id 去重。
   * 不把祖先并进 `docSubtree`：那会把祖先前面的兄弟/兄弟子树也带进来，
   * 工作集就从「一条路径」变成「整棵祖先子树」——首帧成本会跟着库的顶层分叉走。
   */
  const ancestors: Row[] = []
  const seen = new Set<string>()
  for (const id of rootIds) {
    for (const row of db.prepare(LIBRARY_READS.docAncestors).all(id) as Row[]) {
      const key = String(row.id)
      if (seen.has(key)) continue
      seen.add(key)
      ancestors.push(row)
    }
  }
  /**
   * 附属行按「子树 ∪ 祖先链」取：祖先也要有名字，否则面包屑只能显示正文
   * （页名住在 `_aliases` 里，而块行只带内容）。祖先的附属行与子树行同一形状，
   * 一起交给编码层；`rows.blocks` 仍只含子树行 —— 要不要把祖先接进树是装载方的决定。
   */
  const allIds = [...blocks.map((b) => String(b.id)), ...ancestors.map((a) => String(a.id))]
  const idJson = JSON.stringify([...new Set(allIds)])
  const props = db.prepare(LIBRARY_READS.docProps).all(idJson) as Row[]
  const aliases = db.prepare(LIBRARY_READS.docAliases).all(idJson) as Row[]
  const lists = db.prepare(LIBRARY_READS.docLists).all(idJson) as Row[]
  return { rows: { blocks, props, aliases, lists, meta: {} }, ancestors, rootIds: [...rootIds] }
}

/**
 * **一批块自己的行**（不带子树）：引用目标／标签／字段定义／槽快捷卡的装载单位。
 *
 * 与 `readDocRows` 同一套附属行查询，只是 block 集合由 id 直接给。
 * 上限由调用方（IPC handler）校验：这里不做「一次问整库」的口子。
 */
export function readBlockRows(db: DatabaseSync, blockIds: readonly string[]): RawLibraryRows {
  if (blockIds.length === 0) return { blocks: [], props: [], aliases: [], lists: [], meta: {} }
  const idJson = JSON.stringify([...new Set(blockIds)])
  const blocks = db.prepare(LIBRARY_READS.blocksByIds).all(idJson) as Row[]
  const props = db.prepare(LIBRARY_READS.docProps).all(idJson) as Row[]
  const aliases = db.prepare(LIBRARY_READS.docAliases).all(idJson) as Row[]
  const lists = db.prepare(LIBRARY_READS.docLists).all(idJson) as Row[]
  return { blocks, props, aliases, lists, meta: {} }
}

/** 默认槽要显示的全局身份摘要（页列表不在这里：它是查询视图，按页查） */
export function readCatalogRows(db: DatabaseSync): LibraryCatalog {
  const meta = new Map<string, string>()
  for (const row of db.prepare('select key, value from meta').all() as { key: string; value: string }[]) {
    meta.set(row.key, row.value)
  }
  const savedAt = Number(meta.get(META_KEYS.savedAt) ?? 0)
  const ftsSeq = Number(meta.get(META_KEYS.ftsRowidSeq) ?? 0)
  const journals = db.prepare(LIBRARY_READS.catalogJournals).all() as CatalogJournal[]
  const tags = db.prepare(LIBRARY_READS.catalogTags).all() as CatalogTag[]
  const propDefs = db.prepare(LIBRARY_READS.catalogPropDefs).all() as CatalogPropDef[]
  const aliases = db.prepare(LIBRARY_READS.catalogAliases).all() as CatalogAlias[]
  const trash = db.prepare(LIBRARY_READS.catalogTrash).all() as CatalogTrashRoot[]
  return {
    meta: {
      activeId: meta.get(META_KEYS.activeId) ?? '',
      savedAt: Number.isFinite(savedAt) ? savedAt : 0,
      ftsState: meta.get(META_KEYS.ftsState) ?? 'pending',
      ftsTokenizer: meta.get(META_KEYS.ftsTokenizer) ?? '',
      ftsRowidSeq: Number.isFinite(ftsSeq) && ftsSeq >= 0 ? ftsSeq : 0,
      derivedState: meta.get(META_KEYS.derivedState) ?? 'pending',
    },
    journals,
    tags,
    propDefs,
    aliases,
    trash,
  }
}

/* ------------------------------------------------------------ 查询候选 */

/**
 * **候选计划的执行：一页候选**（按文档先序的 keyset 分页）。
 *
 * 计划是**超集**（⊇ 真命中）：matcher 在渲染层仍是判定的唯一来源，这里少给一行
 * 就是静默丢结果，多给只是多装几块。
 *
 * **派生两表可信吗**在**这一处**问（`derived_state`）：它只决定「收窄得多准」与
 * 「能不能按文档序分页」——不可信时退回根上的 `deleted` 位与**一页装完**
 * （`next: null`），宽但真（详见 `candidatePageSql`）。
 */
/**
 * **小计划的上限**：计划的前 N 行一次取回来不超过这个数，就按「计划本身装得下」处理。
 *
 * 为什么是绝对行数而不是密度：密度的分母（库有多大）要一次全表 count（1M ≈ 数十 ms），
 * 而「取前 N 行」的成本只跟 N 同阶。N 的取舍按两条路的成本曲线相交处量：
 * 物化一份计划约 1.2µs/行，下推按「扫到凑够一页」≈ 1.2µs × 一页 × 库/命中数
 * ⇒ 相交在 命中数 ≈ √(一页 × 库)。1M、400/页 时约 2 万；取 5000 更保守：
 * 此时物化 ≤ 6ms，而下推要扫 8 万行（≈ 100ms）。
 */
const SMALL_PLAN_CAP = 5000

/** 这些计划的成本跟**结果集大小**走（不是「扫一遍正文」），所以要不要下推看基数 */
function isIndexDriven(plan: CandidatePlan): boolean {
  return plan.k === 'prop' || plan.k === 'tagged' || plan.k === 'aliased'
}

/**
 * 这条计划的**结果集超过「小计划」上限吗**（一次 `count(*)`，不搬行）。
 *
 * 主进程的会话把它按「计划 + 写入代数」缓存：一次查询按页来问十几次，而基数在一次
 * 查询期间基本不变。缓存放 `RepoSession.candidateRoute`，每次写入清空——判断错了
 * 只是走慢那条路，但状态讲错话的代价比几毫秒大。
 */
export function planIsDense(db: DatabaseSync, plan: CandidatePlan): boolean {
  const q = candidatePlanSql(plan, { derived: true })
  const n = (
    db.prepare(`select count(*) as n from (${q.sql} limit ?)`).get(...q.params, SMALL_PLAN_CAP + 1) as { n: number }
  ).n
  return n > SMALL_PLAN_CAP
}

/** 这条计划的**全部 id**（只在 `planIsDense` 说「装得下」之后调） */
function planIds(db: DatabaseSync, plan: CandidatePlan): string[] {
  const q = candidatePlanSql(plan, { derived: true })
  const rows = db.prepare(`select id from (${q.sql})`).all(...q.params) as { id: unknown }[]
  return rows.map((r) => String(r.id))
}

/**
 * 选路的**决策来源**：调用方（会话）带缓存时用它，否则 `readCandidatePage` 自己按
 * 每次调用算一遍（单测与探针不需要跨请求缓存）。
 */
export interface CandidateRoute {
  denseOf(plan: CandidatePlan): boolean
}

export function readCandidatePage(
  db: DatabaseSync,
  plan: CandidatePlan,
  page: { after: string | null; limit: number },
  route?: CandidateRoute,
): CandidatePage {
  const derived = readMeta(db, META_KEYS.derivedState) === 'ready'
  const ftsReady = readMeta(db, META_KEYS.ftsState) === 'ready'
  if (derived && ftsReady) {
    const short = gramCandidates(db, plan, page)
    if (short) return short
  }
  /**
   * 索引驱动的计划先量一次基数：**装得下**（≤ CAP，且 CAP 远小于「下推要扫的行数」）
   * ⇒ 整个计划一次交齐、按文档序切页；装不下 ⇒ 下推成行本地谓词，沿 path 序凑够
   * 一页就停。两条路的候选序列相同（`in (plan)` 与行本地谓词同集）。
   *
   * 同一页里同一个节点只问一次：`dense` 回调与这里共用一份判断。
   */
  const local = new Map<CandidatePlan, boolean>()
  const dense = (p: CandidatePlan): boolean => {
    if (route) return route.denseOf(p)
    const hit = local.get(p)
    if (hit !== undefined) return hit
    const v = planIsDense(db, p)
    local.set(p, v)
    return v
  }
  if (derived && isIndexDriven(plan) && !dense(plan)) return planPage(db, planIds(db, plan), page)
  const q = candidatePageSql(plan, page, { derived, ...(derived ? { dense } : {}) })
  const rows = db.prepare(q.sql).all(...q.params) as { id: unknown; path?: unknown }[]
  const ids = rows.map((r) => String(r.id)).filter((id) => id !== '' && id !== 'null')
  // 只有「取满一页」才可能还有下一页；不满 ⇒ 到底（下一问会是空页，少一次猜测）
  const next = derived && rows.length === page.limit ? String(rows[rows.length - 1]!.path) : null
  return { ids, next }
}

/**
 * 「计划本身装得下」的一页：把已知的 id 集合按文档序排好切一页。
 *
 * 集合是**齐全**的（调用方按 CAP 证明过）⇒ 切不完时 `next` 是这一页最后一条的 path，
 * 切完就是 `null`——与普通分页同一条游标语义，只是不必再碰计划 SQL。
 */
function planPage(db: DatabaseSync, ids: readonly string[], page: { after: string | null; limit: number }): CandidatePage {
  const idJson = JSON.stringify([...new Set(ids)])
  const rows = (
    page.after === null
      ? db.prepare(LIBRARY_READS.idsByPath).all(idJson)
      : db.prepare(LIBRARY_READS.idsByPathAfter).all(idJson, page.after)
  ) as { id: unknown; path?: unknown }[]
  const slice = rows.slice(0, page.limit)
  return {
    ids: slice.map((r) => String(r.id)),
    next: rows.length > page.limit ? String(slice[slice.length - 1]!.path) : null,
  }
}

/**
 * **子串索引的短路**：正文条件命中不超过一页时，答案就是那一页的全部候选。
 *
 * 为什么值得单开一条路：`{text}` 的谓词是**行本地**的，按路径序扫、凑够一页才停
 * ——常见串因此是亚毫秒，但**稀疏与无命中**都要扫完整库（1M 约 1.3s/页）。
 * 子串索引（trigram）回答的正是「有没有、有几个」：无命中 0.02ms、稀疏一次查完。
 *
 * 只做**必要条件**（`all` 链上的 `text`，见 `necessaryTextNeedles`）：差集与析取
 * 的成员不是「每条命中都得满足」。命中集 ⊆ `MATCH` 结果 ⊆ 必要条件，所以：
 *   · `MATCH` 空 ⇒ 整条查询无命中，直接给空页；
 *   · `MATCH` 不超过一页 ⇒ 候选**已齐全**，按文档序交出去、`next = null`
 *     （候选可以是超集：matcher 仍会筛掉 `all` 里其余条件不成立的块）。
 *   · 超过一页 ⇒ 交回扫描路（常见串本来就是它快：按「凑够一页」计价）。
 *
 * 降级：索引没就绪（`fts_state !== 'ready'`）、或串太短／全空白答不了 ⇒ 返回 `null`，
 * 调用方走今天的分页 SQL，语义不变。
 */
function gramCandidates(
  db: DatabaseSync,
  plan: CandidatePlan,
  page: { after: string | null; limit: number },
): CandidatePage | null {
  const needles = necessaryTextNeedles(plan)
  if (needles.length === 0) return null
  let best: string[] | null = null
  for (const needle of needles) {
    const query = gramQueryOf(needle)
    if (query === null) continue
    const rows = db.prepare(LIBRARY_READS.gramMatch).all(query, page.limit + 1) as { block: unknown }[]
    if (rows.length === 0) return { ids: [], next: null }
    if (rows.length > page.limit) continue
    const ids = rows.map((r) => String(r.block))
    if (best === null || ids.length < best.length) best = ids
  }
  if (best === null) return null
  // 候选已齐全且不超过一页：按文档序交出去（`planPage` 的 next 自然是 null）
  return planPage(db, best, page)
}

/**
 * **一批块 ＋ 全部祖先链（＋一层子级）**：查询候选的装载单位。
 *
 * 候选判定要看上下文（`{up}`、`_date` 贴着的天、面包屑）；`{children:true}` 还要
 * 看子块在不在。祖先链是一条路径不是祖先的兄弟子树——成本跟候选数 × 深度走。
 */
export function readBlockTreeRows(db: DatabaseSync, blockIds: readonly string[], withChildren: boolean): RawLibraryRows {
  if (blockIds.length === 0) return { blocks: [], props: [], aliases: [], lists: [], meta: {} }
  const idJson = JSON.stringify([...new Set(blockIds)])
  const byId = new Map<string, Row>()
  for (const r of db.prepare(LIBRARY_READS.treeAncestors).all(idJson) as Row[]) byId.set(String(r.id), r)
  if (withChildren) {
    for (const r of db.prepare(LIBRARY_READS.treeChildren).all(idJson) as Row[]) byId.set(String(r.id), r)
  }
  const all = [...byId.values()]
  const allJson = JSON.stringify(all.map((r) => String(r.id)))
  const props = db.prepare(LIBRARY_READS.docProps).all(allJson) as Row[]
  const aliases = db.prepare(LIBRARY_READS.docAliases).all(allJson) as Row[]
  const lists = db.prepare(LIBRARY_READS.docLists).all(allJson) as Row[]
  return { blocks: all, props, aliases, lists, meta: {} }
}

/** 全局身份块（页/标签露面、字段定义、回收站根）＋附属行：catalog 的块对象面 */
export function readIdentityRows(db: DatabaseSync): RawLibraryRows {
  const blocks = db.prepare(LIBRARY_READS.catalogIdentity).all() as Row[]
  if (blocks.length === 0) return { blocks: [], props: [], aliases: [], lists: [], meta: {} }
  const idJson = JSON.stringify(blocks.map((r) => String(r.id)))
  const props = db.prepare(LIBRARY_READS.docProps).all(idJson) as Row[]
  const aliases = db.prepare(LIBRARY_READS.docAliases).all(idJson) as Row[]
  const lists = db.prepare(LIBRARY_READS.docLists).all(idJson) as Row[]
  return { blocks, props, aliases, lists, meta: {} }
}

/** FTS 映射按块查（增量索引的装配单位；块 id 过滤走索引，不搬整表） */
export function readFtsMapRows(db: DatabaseSync, blockIds: readonly string[]): { block_id: string; source: string | null; fts_rowid: number }[] {
  if (blockIds.length === 0) return []
  const idJson = JSON.stringify([...new Set(blockIds)])
  return db.prepare(LIBRARY_READS.ftsMapOf).all(idJson) as {
    block_id: string
    source: string | null
    fts_rowid: number
  }[]
}

/** 依赖方（正文引用／标签成员／属性值三路分类）：FTS 重铺与反链共用这一份口径 */
export function readDependents(
  db: DatabaseSync,
  targetId: string,
): { content: string[]; tag: string[]; prop: string[] } {
  const rows = db.prepare(LIBRARY_READS.dependentsOf).all(targetId, JSON.stringify(targetId)) as {
    id: string
    kind: string
  }[]
  const out = { content: [] as string[], tag: [] as string[], prop: [] as string[] }
  for (const r of rows) {
    const id = String(r.id)
    if (r.kind === 'content') out.content.push(id)
    else if (r.kind === 'tag') out.tag.push(id)
    else if (r.kind === 'prop') out.prop.push(id)
  }
  return out
}

/** 顶层根 id 清单（含软删根）：派生表流式重建的装载单位 */
export function readRootIds(db: DatabaseSync): string[] {
  const rows = db.prepare(LIBRARY_READS.catalogRoots).all() as { id: string }[]
  return rows.map((r) => String(r.id))
}

/** 入向关系按目标批查（引用角标的全库计数；派生表 ready 后才可读） */
export function readRelationsFor(
  db: DatabaseSync,
  targetIds: readonly string[],
): { to_id: string; from_id: string; kind: string; from_root: string }[] {
  if (targetIds.length === 0) return []
  const idJson = JSON.stringify([...new Set(targetIds)])
  return db.prepare(LIBRARY_READS.relationsFor).all(idJson) as {
    to_id: string
    from_id: string
    kind: string
    from_root: string
  }[]
}

/* ------------------------------------------------------------ 派生位置行 */

/** `BlockIndex` 行的四列按派生层的形状归一（`hidden` 只可能是 1 / null） */
function indexRows(rows: readonly unknown[]): BlockIndexRow[] {
  return (rows as Record<string, unknown>[]).map((r) => ({
    block: String(r.block),
    root: String(r.root),
    path: String(r.path),
    hidden: r.hidden === 1 ? 1 : null,
  }))
}

/** 一批块的派生位置行（增量维护：存量前缀／父前缀／前兄弟的存量段） */
export function readIndexRows(db: DatabaseSync, blockIds: readonly string[]): BlockIndexRow[] {
  if (blockIds.length === 0) return []
  const idJson = JSON.stringify([...new Set(blockIds)])
  return indexRows(db.prepare(LIBRARY_READS.indexByBlock).all(idJson))
}

/** 一个落点的库后继（`parent` 下 `left = ?` 的那一行；`left` 为 null ＝ 层首） */
export function readIndexFollowing(db: DatabaseSync, parent: string | null, left: string | null): BlockIndexRow | null {
  return indexRows(db.prepare(LIBRARY_READS.indexFollowing).all(parent, left))[0] ?? null
}

/** 一层的全部子块行（按库里的先序；整层重编号的取数口） */
export function readIndexChildren(db: DatabaseSync, parent: string | null): BlockIndexRow[] {
  return indexRows(db.prepare(LIBRARY_READS.indexChildren).all(parent))
}
