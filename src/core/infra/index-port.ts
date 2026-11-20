/**
 * **索引**（IndexPort）：把「谁指向谁」这类问题从「每次全库扫一遍」变成「查表」。
 *
 * 判据（派生层不物化）：索引**不是真相源**，是可从「块森林（含块上的行内内容）」重建的派生视图。
 *   ⇒ `rebuild(source)` 与「一路增量累积」必须得到**同一份**索引（`fingerprint` 逐字节相等）。
 *   这条等式就是本文件的验收标准 —— 它挡住的正是那种「增量更新漏了一种失效点、
 *   但界面上看起来只是偶尔少一条」的静默错误。
 *
 * ⚠️ 索引里存的是**块的活引用**，不是拷贝：块是可变的（正文可经 `writeBlockContent` 就地改写），
 *    所以「块的内容变了」不需要动索引（活引用自动可见），需要动的只有**结构**（谁在场、住哪页、
 *    谁认领哪个名字）与**内容里指向谁**（边）——按 op 修补的正是这两部分（`applyOps`）。
 * ⚠️ 本文件零 DOM、零持久化：它只吃森林，所以能直接单测。
 */
import { aliasesOf, ALIASES_PROP, hasList, isAutomationBlock, isDeleted, isPropDefBlock, LISTS_PROP, type Block } from '../model/model.ts'
import type { Anno } from '../model/runs.ts'
import { walkForest } from '../model/walk.ts'
import { normalizeAlias } from '../identity/alias.ts'
import { journalDate, isJournal } from '../identity/journal.ts'
import { assignSubtreeRanks, assignTailRanks, compareRanks, ORDER_STEP, rankBetween, renumberLevel, type RankMap } from './order.ts'
import {
  CARDINALITY_PROP,
  CHECK_PROP,
  DEFAULT_PROP,
  FIELD_DEFS_PROP,
  USE_PROP,
  fieldTableOf,
  propKindOf,
  type FieldTable,
  type PropKind,
} from '../props/props.ts'
import {
  collectPropKinds,
  collectTagClassIds,
  isRefKind,
  relationEdgeKey,
  relationEdgesOfBlock,
  REFERENCE_KINDS,
  type RefKind,
  type RelationEdge,
  type RelationKind,
} from '../relations/relations.ts'
import type { Op } from '../kb/types.ts'
import {
  evaluateQuery,
  evaluateQueryIds,
  createMatcher,
  isExactRoleJournal,
  resolveSelfSpec,
  usesRef,
  usesRefAny,
  usesSelf,
  type QueryEnv,
  type QueryHit,
  type QueryNode,
  type QuerySpec,
  type RefFroms,
  type RefSources,
} from '../query/query.ts'
import { candidateIdsOf, type CandidateTables } from '../query/candidates.ts'

/**
 * 一份索引。各表各答一类问题，**全是派生**：
 *
 * | 表 | 答什么 | 谁在用 |
 * |---|---|---|
 * | `blocks` | 这个 id 现在是哪一块、叫什么 | 引用解析（`resolveRef`） |
 * | `relations` / `outgoing` | 谁指向谁、以什么 kind | 反链、标签成员、属性引用、关系面板 |
 * | `propKinds` | 哪些字段定义是 `ref`（决定属性值算不算关系） | 关系边提取 |
 * | `tagClassIds` | 哪些块是标签类（决定 `#名` 算提及还是引用） | 关系边提取 |
 * | `tags` / `journals` | 按名字/日期找块 | 标签解析、日记条件 |
 * | `rootOf` | 这块住在哪个顶层根 | 反链按来源根聚合 |
 * | `parentOf` | 这块的**树父**（`null` ＝ 森林顶层） | 面包屑／路径：沿父链向上 O(depth) |
 */
export interface Index {
  /** 块 id → 块（**活引用**） */
  blocks: Map<string, Block>
  /**
   * 入向关系：targetId → 指向它的边。
   *
   * ⚠️ 关系有 kind：`inline`／`property`／`embed`／`tag`／`tagMention`／`belongsTo`／`item`。
   *    不要再把「标签归属」和「正文引用」合成一张无 kind 的计数表——那会让
   *    「谁归我管」和「谁指向我」变成同一个答案。
   */
  relations: Map<string, RelationEdge[]>
  /** 出向关系：sourceId → 它发出的边（同一条 `RelationEdge` 对象，用于增量重算） */
  outgoing: Map<string, RelationEdge[]>
  /** 字段定义 id → kind（只登记 `ref` 时用来判属性值算不算关系） */
  propKinds: Map<string, PropKind>
  /**
   * 标签类块 id 集（`_lists` 里有 `tag` 的活块）。
   *
   * 行内 `#名` 算「分类提及」还是「引用」，判据是**目标的身份**（与渲染层 `refKindOf`
   * 同一份读法），不是 run 上的显示风味。集合成员变化（建/删标签、同名块被收编）时
   * 引用者的边 kind 要跟着重算 —— 低频动作，走一次关系全量重算。
   */
  tagClassIds: Set<string>
  /**
   * 标签名表：规范化标签名 → 标签块 id。
   *
   * ⚠️ 一个标签有多个别名时，**每一个**都进这张表（都指向同一块）；
   *    重名时先序第一个赢。这里与 `findByAlias` 同口径，不另写一套比较。
   */
  tags: Map<string, string>
  /**
   * **全地址表**：规范化地址 → 块 id（**任何**有地址的块，不只是标签）。
   *
   * 与 `tags` 的区别：`tags` 只收「有 `tag` 露面的块」（标签解析用），
   * 这张表收所有 `_aliases` 非空的块（`[[名字]]` 解析、`@` 补全、改名查重都用它）。
   *
   * 为什么要单独一张：`resolveAlias` 曾经是**遍历整片森林**（50000 块时 1.1ms，
   * 而 `@` 补全每敲一个字都要问一次）。表在这里、口径与 `findByAlias` 同一条
   * （先序第一个赢），所以读侧换表不改语义。
   */
  aliases: Map<string, string>
  /** 日期（`YYYY-MM-DD`）→ journal 块 id */
  journals: Map<string, string>
  /** 块 id → 它所在的**顶层块** id（含自己）—— 反链按来源根聚合要用 */
  rootOf: Map<string, string>
  /**
   * 块 id → 它的**树父** id（`null` ＝ 森林顶层）。
   *
   * ⚠️ 只走**内容树**（`children`），与 `_belongsTo` 那条归属边无关：面包屑回答
   *    「它在哪」，归属边回答「它归在谁下面」，两者可以指向不同的块。
   * ⚠️ 这张表是**派生**的：`children` 仍是唯一真相。有它之后取路径是 O(depth)，
   *    不再为每条反链／每个查询结果各走一遍整片森林。
   */
  parentOf: Map<string, string | null>
  /**
   * 块 id → **它在本层兄弟之间的 rank**（先序位置，不含路径）。
   *
   * 完整先序键 = 从根到自己逐层 rank 的数组（`locateOf` 现拼）：这样移动只改被移块的
   * 一格，子孙的 rank 仍是它们各自父块里的位置。口径与代价见 `infra/order.ts`。
   *
   * ⚠️ 覆盖**树上全部块（含软删）**：模型 `children` 数组里有它们，位置没变 ⇒ 删除不清、
   *    purge 才摘、恢复免费。查询只按可见块取候选，不受影响。
   */
  order: RankMap
  /**
   * 块 id → 块（**含被软删的块**）。
   *
   * 与 `blocks` 的区别只有可见性：`blocks` 是「读路径看得见谁」（软删退场），
   * 这张表是「树上有谁」。撤销的恢复路径要按 id 找回一个被软删的块，
   * 而它已经不在 `blocks` 里了 —— 没有这张表，⌘Z 只能摊平整库再找。
   *
   * ⚠️ 它**不是**第二份内容真相：值仍是块的活引用，树形仍以 `children` 为准。
   *    维护点与 `blocks` 同源：位置/清除/恢复走同一批函数。
   */
  all: Map<string, Block>
  /** 块 id → 树父（**含被软删的块**）；与 `parentOf` 的可见集不同，其余口径相同 */
  parentOfAll: Map<string, string | null>
  /**
   * anno id → 宿主块 id 与那条 anno（**活引用**）。
   *
   * `RefRun.to` 可以指向 anno 而不是块：读侧要能回答「这条引用指的那句话在哪个块」，
   * 反链才能归到宿主块、解析才能显示引文。维护点四处：全量在 `indexSubtree`、
   * 增量在 `applyOps` 的 anno op、删块在 `applyBlockDelete`、`fingerprint` 必须含它
   * （否则「全量 == 增量」这条等式对它是瞎的）。
   */
  annos: Map<string, { hostId: string; anno: Anno }>
  /**
   * **派生全局列表**（森林先序）：页／标签／字段定义／回收站。
   *
   * 它们只在「成员／顺序／声明」变化时变，内容写在热路径上——所以按 op 标脏、
   * 读时重建，而不是每次现扫。`null` ＝ 需重建（`ensureIndexLists` 的判据）。
   *
   * ⚠️ 不能用 `tags`／`propKinds` 表反推：`tags` 只收「有别名」的标签，同名非首个也不在
   * values 里；列表是「森林里有哪些块」，必须按 `hasList`／`isPropDefBlock` 走一趟。
   */
  lists: {
    pages: Block[] | null
    tags: Block[] | null
    propDefs: Block[] | null
    trash: Block[] | null
    /**
     * **全部日记块**（可见、森林先序）。`journals` 表是「一天一个」，答不了
     * 「所有日记块」；组合条件里的 `{role:'journal'}` 又只是普通谓词（不去重）。
     * 与别的列表同一套失效口径：`_date` 写、含日记的子树挪动/存在性变化。
     */
    journals: Block[] | null
    /**
     * **全部自动化块**（可见、森林先序）。命令面板投影与「自动化」库视图都要
     * 枚举它们；判据是 `_automation` 在场（`isAutomationBlock`），与 propDefs 同套失效口径。
     */
    automations: Block[] | null
  }
  /**
   * **字段读取表**缓存（`fieldTableOf` 的两趟全林扫描）。
   *
   * 消费者是查询（`queryByIndex`／`blockMatchesSpec`）；内容写不失效，只随
   * 标签声明／定义 kind／缺省值／用途／基数与标签/定义的结构变化失效。
   */
  fields: FieldTable | null
  /** 派生缓存的重建计数（只增、不清零；给「打字不许触发重建」这类断言一个读数） */
  cacheProbe: {
    listsBuilds: number
    fieldBuilds: number
    /** 走候选迭代的查询次数（候选路径不遍历森林） */
    candidateQueries: number
    /** 回退全林的查询次数（不可枚举形状／定不了位）；「不许静默全林」看它 */
    fallbackQueries: number
  }
}

function emptyIndex(): Index {
  return {
    blocks: new Map(),
    relations: new Map(),
    outgoing: new Map(),
    propKinds: new Map(),
    tagClassIds: new Set(),
    tags: new Map(),
    aliases: new Map(),
    journals: new Map(),
    rootOf: new Map(),
    parentOf: new Map(),
    order: new Map(),
    all: new Map(),
    parentOfAll: new Map(),
    annos: new Map(),
    lists: { pages: null, tags: null, propDefs: null, trash: null, journals: null, automations: null },
    fields: null,
    cacheProbe: { listsBuilds: 0, fieldBuilds: 0, candidateQueries: 0, fallbackQueries: 0 },
  }
}

/* ------------------------------------------------------------ 构建 */

/**
 * **从源头重建**（全量）。这是唯一的正确性基准：
 * 任何增量路径的结果都必须与它逐字节一致。
 */
export function rebuild(forest: readonly Block[]): Index {
  const idx = emptyIndex()

  /**
   * 先收定义 kind 与标签类，再收边：字段定义块可能住在后面的顶层根里，
   * 边提取时 `propKinds` 必须已经知道哪些属性是 `ref`，`#名` 的分类
   * 必须已经知道哪些目标是标签类。
   */
  idx.propKinds = collectPropKinds(forest)
  idx.tagClassIds = collectTagClassIds(forest)

  // 块表 / 标签表 / 日记表 / 根表 / 关系边（一次先序遍历；与增量修补同一口径）。
  // ⚠️ 遍历默认跳过被删的子树（原位软删：被删的块对索引不可见）。
  for (const b of forest) indexSubtree(idx, b, b.id, null)
  // 顶层 rank：`indexSubtree` 只记子孙（根的位置取决于它父级的邻居，它没有）。
  for (let i = 0; i < forest.length; i++) idx.order.set(forest[i]!.id, (i + 1) * ORDER_STEP)
  // 日期表：先序第一个赢（与 `journalDays` 同一条）；不在 `indexSubtree` 里逐块打点
  rebuildJournalMap(idx, forest)

  return idx
}

/**
 * **装载路径的索引接入**：一批已知对象的新片段根（父可能已装载，也可能为顶层）。
 *
 * 与 `applyOps` 里 `block.upsert{parent}` 那一支同一份判据（`indexSubtree` ＋ 秩 ＋
 * 派生列表失效），差别只在**对象直接由调用方给**：装载时刚建好的块就在手上，不必再按 id
 * 在森林里走一遍——那是 O(树)，批量装载会退化成 O(N²)（实测 10 万块分 50 窗要几分钟）。
 */
export function indexInsertedSubtrees(
  index: Index,
  entries: readonly { block: Block; parent: string | null }[],
  forest: readonly Block[],
): void {
  if (entries.length === 0) return
  const orderTouched = new Map<string | null, Set<string>>()
  let journalsDirty = false
  for (const { block, parent } of entries) {
    const rootId = parent === null ? block.id : (index.rootOf.get(parent) ?? block.id)
    /**
     * 已经索引过的块只可能是**换位置**（先当根装进来、后来父也装进来）：与
     * `applyBlockUpsert` 的 known 分支同口径——父指针与 root 前缀要跟着改，
     * 名字/成员/边都不动（内容没变）。
     */
    if (index.all.has(block.id)) {
      index.parentOf.set(block.id, parent)
      index.parentOfAll.set(block.id, parent)
      reindexSubtreeRoot(index, block, rootId)
    } else {
      indexSubtree(index, block, rootId, parent)
      if (invalidateForSubtree(index, block)) journalsDirty = true
    }
    markOrderTouched(orderTouched, parent, block.id)
  }
  flushOrder(index, orderTouched, forest)
  if (journalsDirty) rebuildJournalMap(index, forest)
}

/* ------------------------------------------------------------ 派生缓存 */

/** `ensureIndexLists` 的返回值：六张表都保证已建好（`Index.lists` 的可空是「未建」标记） */
export interface IndexLists {
  pages: Block[]
  tags: Block[]
  propDefs: Block[]
  trash: Block[]
  journals: Block[]
  automations: Block[]
}

/**
 * **按需重建派生列表**（页／标签／字段定义／回收站）。
 *
 * 只填 `null` 的那些：一次 `block.exist` 只需重建 trash 时，已建好的 pages/tags 不换数组
 * （换数组会让调用方手里的快照凭空过期，而它们本来没变）。
 *
 * 口径与 `MemoryKb` 原来那四个方法逐字一致：可见 `walkForest` 收前三张；`includeDeleted`
 * 一趟 + `isDeleted` 收回收站——顺序都是森林先序，回收站与 `trashOf(forest)` 同解。
 */
export function ensureIndexLists(index: Index, forest: readonly Block[]): IndexLists {
  const lists = index.lists
  const wantPages = lists.pages === null
  const wantTags = lists.tags === null
  const wantDefs = lists.propDefs === null
  const wantTrash = lists.trash === null
  const wantJournals = lists.journals === null
  const wantAutomations = lists.automations === null
  if (!wantPages && !wantTags && !wantDefs && !wantTrash && !wantJournals && !wantAutomations) return lists as IndexLists

  index.cacheProbe.listsBuilds++
  if (wantPages) lists.pages = []
  if (wantTags) lists.tags = []
  if (wantDefs) lists.propDefs = []
  if (wantJournals) lists.journals = []
  if (wantAutomations) lists.automations = []

  if (wantPages || wantTags || wantDefs || wantJournals || wantAutomations) {
    walkForest(forest, (b) => {
      if (wantPages && hasList(b, 'page')) lists.pages!.push(b)
      if (wantTags && hasList(b, 'tag')) lists.tags!.push(b)
      if (wantDefs && isPropDefBlock(b)) lists.propDefs!.push(b)
      if (wantJournals && isJournal(b)) lists.journals!.push(b)
      if (wantAutomations && isAutomationBlock(b)) lists.automations!.push(b)
    })
  }

  if (wantTrash) {
    const trash: Block[] = []
    walkForest(
      forest,
      (b) => {
        if (isDeleted(b)) trash.push(b)
      },
      { includeDeleted: true },
    )
    lists.trash = trash
  }

  return lists as IndexLists
}

/**
 * **字段读取表**缓存：`fieldTableOf` 是两趟全林（标签声明 ＋ 定义），查询/条件树会反复要。
 *
 * 只在成员/声明/顺序变化时由 `applyOps` 置 null；内容写不失效。
 */
export function indexFieldTable(index: Index, forest: readonly Block[]): FieldTable {
  if (index.fields !== null) return index.fields
  index.cacheProbe.fieldBuilds++
  index.fields = fieldTableOf(forest)
  return index.fields
}

/** 把一条关系边挂进两张表（同一条对象，两个方向共用） */
function addEdge(idx: Index, e: RelationEdge): void {
  const byTarget = idx.relations.get(e.to)
  if (byTarget) byTarget.push(e)
  else idx.relations.set(e.to, [e])
  const bySource = idx.outgoing.get(e.from)
  if (bySource) bySource.push(e)
  else idx.outgoing.set(e.from, [e])
}

/** 摘掉一个源块的全部出向边（内容/属性变了就整块重算；块级边数很小） */
function removeOutgoing(idx: Index, source: string): void {
  const edges = idx.outgoing.get(source)
  if (!edges || edges.length === 0) return
  const touched = new Set<string>()
  for (const e of edges) touched.add(e.to)
  for (const target of touched) {
    const list = idx.relations.get(target)
    if (!list) continue
    const next = list.filter((e) => e.from !== source)
    if (next.length > 0) idx.relations.set(target, next)
    else idx.relations.delete(target)
  }
  idx.outgoing.delete(source)
}

/** 重算一个块的全部出向关系（内容或任一关系型属性变了都走这里） */
function refreshRelations(idx: Index, blockId: string): void {
  const live = idx.blocks.get(blockId)
  if (!live) return
  removeOutgoing(idx, blockId)
  for (const e of relationEdgesOfBlock(live, idx.propKinds, idx.tagClassIds, idx.annos)) addEdge(idx, e)
}

/**
 * 全量重算关系边（只用于**低频且影响面大**的改动：字段定义的 kind 改了/定义块被删）。
 * 正常打字/改标签/改属性只走 `refreshRelations`，成本与这一块的边数有关。
 */
function refreshAllRelations(idx: Index): void {
  idx.relations.clear()
  idx.outgoing.clear()
  for (const b of idx.blocks.values()) {
    for (const e of relationEdgesOfBlock(b, idx.propKinds, idx.tagClassIds, idx.annos)) addEdge(idx, e)
  }
}

/**
 * **子树里有没有身份块／被删块**——决定派生列表要不要失效。
 *
 * 走 `includeDeleted`：可见子树里也可能挂着被单独软删的后代（标签/定义进了回收站），
 * 移动/插入这棵子树会改变 trash 的顺序。普通单块插入只访问一块，成本可忽略。
 */
function invalidateForSubtree(index: Index, block: Block): boolean {
  let pages = false
  let tags = false
  let defs = false
  let trash = false
  let journals = false
  let automations = false
  walkForest(
    [block],
    (b) => {
      if (hasList(b, 'page')) pages = true
      if (hasList(b, 'tag')) tags = true
      if (isPropDefBlock(b)) defs = true
      if (isDeleted(b)) trash = true
      if (isJournal(b)) journals = true
      if (isAutomationBlock(b)) automations = true
    },
    { includeDeleted: true },
  )
  if (pages) index.lists.pages = null
  if (tags) {
    index.lists.tags = null
    index.fields = null
  }
  if (defs) {
    index.lists.propDefs = null
    index.fields = null
  }
  if (trash) index.lists.trash = null
  if (journals) index.lists.journals = null
  if (automations) index.lists.automations = null
  return journals
}

/** 属性槽 → 派生缓存失效（只标脏，读时重建）。 */
function invalidateForProp(index: Index, name: string): void {
  if (name === LISTS_PROP) {
    index.lists.pages = null
    index.lists.tags = null
    index.fields = null
    return
  }
  if (name === '_kind') {
    index.lists.propDefs = null
    index.fields = null
    return
  }
  if (name === '_date') {
    index.lists.journals = null
    return
  }
  if (name === '_automation') {
    index.lists.automations = null
    return
  }
  if (
    name === FIELD_DEFS_PROP ||
    name === DEFAULT_PROP ||
    name === USE_PROP ||
    name === CHECK_PROP ||
    name === CARDINALITY_PROP
  ) {
    index.fields = null
  }
}

/**
 * **按 op 增量应用**（一批 op ＝ 一个事务的那批）。
 *
 * 修补的单位是 **op**（`MemoryKb.tx` 产出的持久化操作序列），不是 `Change`：
 * `Change` 只说「哪类对象动过」，op 说清「哪一块、动了什么」——
 * 名字表/成员表/入向边才能只修被点到的那些条目。
 *
 * 修补的正确性靠两件事：
 *   · **索引持有的是活引用**——「摘掉旧条目」要的旧状态，很多就记在索引自己的表里
 *     （名字表里谁认领这个名字、关系表里这块发过哪些边），从表里反查即可，不需要 op 带旧值；
 *   · **关系边按源块整块重算**（`refreshRelations`）——op 只带新值时也能得到与全量一致的边，
 *     因为边提取只读活块的内容/属性，不依赖旧边。
 *
 * 与 `rebuild` 的口径对齐点（逐条对过，改任何一边都要回头查另一边）：
 *   · 名字表：先序第一个认领者赢 ⇒ 增量加名时「表里已有人就不抢」；
 *     摘块时受影响的名字**重扫森林**找下一个认领者（被删的块无权认领）；
 *   · 日期表：先序第一个赢（与 `journalDays` 同一条）⇒ 任何可能改写归属的变化都整表重建，
 *     不做逐条接手（「谁先序第一」只有整片森林知道）；
 *   · 先序 rank：位置 op 之后按**最终森林**给受影响的父级放 rank；同一批多块 ⇒ 该层重编号；
 *   · 成员表：`tag` 边是集合语义，同块打两次同一标签只算一个；
 *   · 关系边：数据源是**可见源块**的内容/属性——删块把「源在这个子树里」的边一起摘
 *     （恢复时随子树重建），与 rebuild 同口径。
 *
 * 找不到块（op 引用的 id 既不在索引也不在森林）⇒ 跳过该 op：op 序列是事实陈述，
 * 不是「必须可执行」的指令；等式测试会把任何因此产生的分叉抓出来。
 */
export function applyOps(index: Index, ops: readonly Op[], forest: readonly Block[]): Index {
  /**
   * 这一批里**刚由位置 op 建进索引**的块。
   *
   * 位置 op 的 `indexSubtree` 读的是**模型最终值**：新块的地址/露面/标签/日期
   * 已经写进索引了。紧随其后的 `prop.set(_aliases|_lists|_tags|_date)` 是同一笔
   * genesis 的格，**不必再扫一遍名字表找「摘掉的旧名字」** —— 新块没有旧名字。
   * 不跳过的话，建页/建标签在 50,000 块时要扫全库（实测 15.8ms）。
   */
  const fresh = new Set<string>()
  /**
   * 这一批里**位置变过的子块**：父 id（`null` = 森林顶层）→ 子块 id 集合。
   * 批次结束后统一放 rank：只动了一个子块 ⇒ 在最终邻居之间取中点；
   * 同一父下动了多个（撤销/批量移动）⇒ 该层重编号——中点会互相踩，重编号是唯一稳的。
   */
  const orderTouched = new Map<string | null, Set<string>>()
  /** 日记归属可能变了（`_date` 写 / 含日记的子树挪动、删除、恢复）⇒ 整表重建 */
  let journalsDirty = false
  // 边的 `to` 会按 anno 反查表归一化 ⇒ 表的**成员**一变，所有指向 anno 的边都得按最终表重算。
  // 只改 range 的打字不改变成员（hostId 不变），所以这次重算不会落到按键路径上。
  //
  // ⚠️ 快照**按需取**：成员只可能被 `anno` op 或 `block.exist`（删块摘表）改。
  //    内容/属性批不付这份 O(anno) 的全表快照——打字是最高频的那一档。
  let annoKeysBefore: Set<string> | null = null
  for (const op of ops) {
    if (op.e === 'anno' || (op.e === 'block' && op.op === 'exist')) {
      annoKeysBefore ??= new Set(index.annos.keys())
    }
    switch (op.e) {
      case 'block':
        if (op.op === 'upsert') {
          if (op.value.parent !== undefined && !index.blocks.has(op.id)) fresh.add(op.id)
          applyBlockUpsert(index, op.id, op.value, forest, orderTouched)
          /**
           * 结构变化才可能动派生列表：普通插块（没有 page/tag/def 后代）不失效，
           * 否则每次 Enter 都会把下一次 `pages()/tags()` 打回 O(N)。
           */
          if (op.value.parent !== undefined) {
            const b = index.blocks.get(op.id) ?? index.all.get(op.id)
            if (b && invalidateForSubtree(index, b)) journalsDirty = true
          }
        } else {
          if (applyBlockExist(index, op.id, op.state, forest)) journalsDirty = true
          /**
           * 删除/恢复/清除会带走或带回整棵子树：里面可能有页/标签/定义，
           * 也可能改变回收站的成员与顺序。低频动作，保守全失效。
           */
          index.lists.pages = null
          index.lists.tags = null
          index.lists.propDefs = null
          index.lists.trash = null
          index.lists.journals = null
          index.lists.automations = null
          index.fields = null
        }
        break
      case 'prop':
        /**
         * 哪个属性槽喂哪张表：地址/露面 → 名字表；日期 → 日记表；
         * 其余关系型属性 → 关系表（`refreshRelations` 会重算这一块的全部出向边）。
         *
         * ⚠️ **存在（`_deletedAt`）不走 `prop`**：它是 `block.exist` 这一格。
         *    曾经它确实在这里，而那时「软删」与「清除」共用一个 `block.delete`，
         *    撤销一次插入再重开会让块从回收站冒出来 —— 一个格只能有一种地址。
         */
        // 派生缓存失效必须放在 `fresh` 跳过之前：新标签/新定义的 `_lists`/`_kind`
        // 可能就在同一笔 genesis 里，而 `fresh` 会让下面的修补整段跳过。
        invalidateForProp(index, op.name)
        if (op.name === '_date') journalsDirty = true
        if (fresh.has(op.block) && (op.name === ALIASES_PROP || op.name === LISTS_PROP || op.name === '_tags' || op.name === '_date' || op.name === '_kind')) break
        if (op.name === ALIASES_PROP || op.name === LISTS_PROP) {
          refreshTagsClaim(index, op.block, forest)
          /**
           * 标签类成员变化（`ensureTag` 收编同名块等）⇒ 指向它的 `#名` 边在
           * 提及与引用之间翻转，引用者都得重算。低频动作，走一次全量重算
           * 换掉「漏刷新一条边」的静默错误（与 `_kind` 同一权衡）。
           */
          const liveOp = index.blocks.get(op.block)
          const isTagClass = liveOp !== undefined && hasList(liveOp, 'tag')
          if (isTagClass !== index.tagClassIds.has(op.block)) {
            if (isTagClass) index.tagClassIds.add(op.block)
            else index.tagClassIds.delete(op.block)
            refreshAllRelations(index)
          } else {
            refreshRelations(index, op.block)
          }
        } else if (op.name === '_date') {
          refreshRelations(index, op.block)
        } else if (op.name === '_kind') {
          /**
           * 字段定义从/到 `ref` 时，所有使用该字段的块都要重算边。
           * 这是低频动作（改 schema），用一次全量重算换掉「漏刷新一条边」的静默错误。
           */
          const def = index.blocks.get(op.block)
          if (def && isPropDefBlock(def)) index.propKinds.set(def.id, propKindOf(def))
          refreshAllRelations(index)
        } else {
          refreshRelations(index, op.block)
        }
        break
      case 'anno':
        // anno 不产生边（边只从引用 run 提取），但它自己是引用目标：按 id 维护这张反查表
        if (op.op === 'delete') index.annos.delete(op.id)
        else if (op.value) index.annos.set(op.value.id, { hostId: op.block, anno: op.value })
        break
    }
  }
  flushOrder(index, orderTouched, forest)
  if (journalsDirty) rebuildJournalMap(index, forest)
  if (annoKeysBefore !== null) {
    let annoKeysChanged = annoKeysBefore.size !== index.annos.size
    if (!annoKeysChanged) {
      for (const k of annoKeysBefore) {
        if (!index.annos.has(k)) {
          annoKeysChanged = true
          break
        }
      }
    }
    // `applyBlockDelete` 也会摘表，同样在这里被捕获；与全量重算用同一份最终表
    if (annoKeysChanged) refreshAllRelations(index)
  }
  return index
}

/**
 * 块 upsert：`content` ⇒ 重算这块的关系边（引用 run 增删/改向都在内容里）；
 * `parent` ⇒ 挪位/新进。`blocks` 里是活引用，块自己的内容变化不用回头改表，
 * 需要动的只有**以源块为单位的出向边**。
 */
function applyBlockUpsert(
  index: Index,
  id: string,
  value: { content?: unknown; parent?: string | null },
  forest: readonly Block[],
  orderTouched: Map<string | null, Set<string>>,
): void {
  const known = index.blocks.get(id)
  if (value.content !== undefined && known) {
    // 内容变了 ⇒ 这一块的出向边整块重算（含正文 ref run 与 `#` 提及）
    refreshRelations(index, id)
  }
  if (value.parent === undefined) return
  const parent = value.parent
  const rootId = parent === null ? id : (index.rootOf.get(parent) ?? id)
  if (known) {
    // 挪位不改 props ⇒ 名字表/成员表都不动；`blocks` 里是活引用，也无事可做。
    // `parentOf` 只改**被移的这一块**：后代的父还是它自己，不需要重打。
    index.parentOf.set(id, parent)
    index.parentOfAll.set(id, parent)
    reindexSubtreeRoot(index, known, rootId)
    // rank 只属于层：被移的块换一格，子孙的 rank 不动（它们仍是各自父块里的位置）
    markOrderTouched(orderTouched, parent, id)
    return
  }
  const block = findInForest(forest, id)
  if (!block) return
  indexSubtree(index, block, rootId, parent)
  // 新子树：子孙的 rank 由 `indexSubtree` 记；根的 rank 取决于父级邻居，批次末尾统一放
  markOrderTouched(orderTouched, parent, id)
}

/** 记一笔「这个父级下这个子块的位置变了」；批次末尾统一放 rank */
function markOrderTouched(touched: Map<string | null, Set<string>>, parent: string | null, id: string): void {
  const set = touched.get(parent)
  if (set) set.add(id)
  else touched.set(parent, new Set([id]))
}

/**
 * 批次末尾放 rank（读**最终森林**：`children` 数组是唯一真相）。
 *
 * 只动了一个子块 ⇒ 在最终邻居之间取中点，O(1)；同一父下动了多个（撤销/批量移动）⇒
 * 该层重编号——中点按 op 顺序放会互相踩（前一个刚放的中点可能已经越过后一个的邻居）。
 * 邻居缺 rank 说明索引与森林已分叉，也走重编号（宁可慢，不要静默错位）。
 */
function flushOrder(index: Index, touched: Map<string | null, Set<string>>, forest: readonly Block[]): void {
  for (const [parentId, ids] of touched) {
    const children = parentId === null ? forest : (index.all.get(parentId)?.children ?? [])
    if (children.length === 0) continue
    if (ids.size === 1) {
      const id = ids.values().next().value as string
      const i = children.findIndex((b) => b.id === id)
      if (i >= 0) {
        const prev = i > 0 ? index.order.get(children[i - 1]!.id) : undefined
        const next = i < children.length - 1 ? index.order.get(children[i + 1]!.id) : undefined
        const neighborsKnown = (i === 0 || prev !== undefined) && (i === children.length - 1 || next !== undefined)
        const rank = neighborsKnown ? rankBetween(prev, next) : undefined
        if (rank !== undefined) {
          index.order.set(id, rank)
          continue
        }
      }
    }
    // 这一批恰好排在层尾（装载、文末回车）⇒ 顺序记下去就够，不必整层重编号
    if (assignTailRanks(index.order, children, ids)) continue
    renumberLevel(index.order, children)
  }
}

/**
 * 块 delete：**原位软删**的索引面——块还在森林里，但要从索引表里退场。
 *
 * 退场的是「可见集合」：根 ＋ 它**还没被删**的后代（本来就删了的已经不在表里）。
 * 入向边跟着源块退场（`edgeByAnno` 簿记摘旧边）——数据源 atoms 没动，
 * 但 rebuild 只数可见源块的原子，两条路必须同口径。名字表的接手者重扫森林时
 * 同样跳过被删子树（被删的块无权认领名字）。
 *
 * @returns 这棵子树里有没有日记块（有 ⇒ 日记归属要整表重建；`applyOps` 用它标脏）
 */
function applyBlockDelete(index: Index, id: string, forest: readonly Block[], purge: boolean): boolean {
  /**
   * 软删过的块不在 `blocks` 里 —— 清除它时要到 `all` 里取（否则子树摘不掉，
   * 索引会留下一个「已经不存在的 id」；而撤销会因此以为它还在）。
   */
  const block = index.blocks.get(id) ?? (purge ? index.all.get(id) : undefined)
  if (!block) return false
  // ⚠️ 取子树要**含被删块**：执行到这里时根已被打上标记（tx 先改内存、后修补索引），
  //    默认遍历会把整棵子树跳过去——一张都摘不掉。退场的正是「这棵子树里的全部」。
  const gone = walkSubtreeIncludingDeleted(block)
  const goneSet = new Set(gone)
  // 退场子树里的 anno 不再是可引用目标：摘表（引用变 dangling，但 anno 的 id 不换）
  for (const [aid, rec] of index.annos) if (goneSet.has(rec.hostId)) index.annos.delete(aid)
  /**
   * **先只从这棵子树里收集名字/日期**，再摘索引。
   *
   * 不从 `index.tags`／`index.aliases` 里过滤（那是 O(整库)：50,000 块删一个普通块要 2ms，
   * 删一个带地址的块要 13.5ms）。子树通常很小，名字只可能是这棵子树里的那些。
   * 只有**真的丢掉一个名字**时才需要重扫森林找接手者（O(n)，但只发生在删页/标签这种低频动作）。
   */
  const names = new Set<string>()
  const dates = new Set<string>()
  let droppedPropKind = false
  let droppedTagClass = false
  walkForest(
    [block],
    (b) => {
      for (const alias of aliasesOf(b)) {
        const name = normalizeAlias(alias)
        if (name !== '') names.add(name)
      }
      if (isJournal(b)) dates.add(journalDate(b))
      if (index.propKinds.delete(b.id)) droppedPropKind = true
      if (index.tagClassIds.delete(b.id)) droppedTagClass = true
    },
    { includeDeleted: true },
  )

  for (const bid of gone) {
    index.blocks.delete(bid)
    index.rootOf.delete(bid)
    index.parentOf.delete(bid)
  }
  /**
   * 名字表：删掉这些块认领的名字，再让**还活着**的认领者按 rebuild 的口径接手。
   *
   * ⚠️ **两张表都要走**（`tags` 与 `aliases` 收的块不同，但记的是同一批名字）。
   *    只处理 `tags` 会让 `aliases` 里留下死条目 —— 那时 `resolveAlias` 会返回一个
   *    已经不在树上的块 id，而没有任何一层会报错（等式断言抓到的正是这个）。
   */
  const tagNames = [...names].filter((name) => {
    const owner = index.tags.get(name)
    return owner !== undefined && goneSet.has(owner)
  })
  for (const name of tagNames) index.tags.delete(name)
  for (const name of tagNames) {
    const heir = firstTagClaimant(forest, name)
    if (heir) index.tags.set(name, heir)
  }
  const aliasNames = [...names].filter((name) => {
    const owner = index.aliases.get(name)
    return owner !== undefined && goneSet.has(owner)
  })
  for (const name of aliasNames) index.aliases.delete(name)
  for (const name of aliasNames) {
    const heir = firstAddressClaimant(forest, name)
    if (heir !== undefined) index.aliases.set(name, heir)
  }
  // 日期表：先序第一个赢 ⇒ 「谁接手」只有整片森林知道，整表在 `applyOps` 末尾重建
  // 关系边：源在退场子树里的边一起摘（恢复时随子树重建）。
  // 字段定义退场 ⇒ 所有使用它的属性值都不再算关系，走一次全量重算（低频）。
  // 标签类退场 ⇒ 指向它的 `#名` 边从提及翻成引用（目标不再是标签类），同一权衡。
  if (droppedPropKind || droppedTagClass) {
    refreshAllRelations(index)
  } else {
    for (const bid of gone) removeOutgoing(index, bid)
  }
  /**
   * **清除**才从「树上有谁」里消失；软删只是从可见表退场。
   * 这两件事共用一个函数，但条目不是同一件事 —— 混起来会让撤销找不到被软删的块
   * （`all` 里没了 ⇒ 恢复路径以为是 genesis，落点又没记 ⇒ 直接抛错）。
   */
  if (purge) {
    for (const bid of gone) {
      index.all.delete(bid)
      index.parentOfAll.delete(bid)
      index.order.delete(bid)
    }
  }
  return dates.size > 0
}

/**
 * 重算一个块对**名字表**的认领：索引里记在这个块名下的先摘掉，
 * 再按活块现在的别名/露面重打（表里已有别的块认领的名字不抢——先序第一优先）。
 */
function refreshTagsClaim(index: Index, blockId: string, forest: readonly Block[]): void {
  const live = index.blocks.get(blockId)
  if (!live) return

  /**
   * **这一块名下现在记着哪些名字**（摘掉之前先记下）。
   *
   * ⚠️ 两张表都要收：`tags` 与 `aliases` 收的块不同（标签 vs 所有有地址的块），
   *    但它们记的是**同一批名字**。只从 `tags` 收会漏掉「这一块不是标签、
   *    但它的旧名字被别人接手」那一半（等式断言抓到的就是这个）。
   */
  const dropped: string[] = []
  for (const [name, owner] of [...index.tags]) {
    if (owner !== blockId) continue
    index.tags.delete(name)
    dropped.push(name)
  }
  for (const [name, owner] of [...index.aliases]) {
    if (owner !== blockId) continue
    index.aliases.delete(name)
    if (!dropped.includes(name)) dropped.push(name)
  }

  /**
   * **现在**这个名字属于谁：先序第一个（与 `rebuild` 同一条口径）。
   *
   * 为什么接手者要重扫森林：同名不同块时先序第一个赢，而「谁是第一个」只有森林知道。
   * 只重打自己会让那个名字消失 —— 与 `rebuild` 不一致，等式断言会抓出来。
   */
  const names = new Set<string>(dropped)
  const own: string[] = []
  for (const alias of aliasesOf(live)) {
    const n = normalizeAlias(alias)
    if (n === '') continue
    names.add(n)
    own.push(n)
  }
  const isTag = hasList(live, 'tag')
  for (const name of names) {
    // 全地址表：按先序第一个赢
    if (!index.aliases.has(name)) {
      const heir = firstAddressClaimant(forest, name)
      if (heir !== undefined) index.aliases.set(name, heir)
    }
    /**
     * 标签名表：只有**这一块自己现在还有的**名字才可能归它。
     * ⚠️ 摘掉的旧名字不许重打回 `tags` —— 那正是「旧名字残留」的形状。
     */
    if (isTag && own.includes(name) && !index.tags.has(name)) index.tags.set(name, blockId)
  }
}

/** 森林里先序第一个以这个名字为地址的**可见**块（与 `rebuild` 同一条口径） */
function firstAddressClaimant(forest: readonly Block[], name: string): string | undefined {
  let hit: string | undefined
  walkForest(forest, (b) => {
    if (hit !== undefined) return false
    if (!aliasesOf(b).some((a) => normalizeAlias(a) === name)) return
    hit = b.id
    return false
  })
  return hit
}

/**
 * **日期表整表重建**（先序第一个赢，与 `journalDays` 同一条口径）。
 *
 * 为什么不是逐条接手：`_date` 写、日记块挪位/删除/恢复都可能改变「谁先序第一」，
 * 而「谁是第一」只有整片森林知道。这些动作都不在打字路径上——一次 O(N) 换掉
 * 一整类静默分叉（日期表与 `journalDays` 各说各的）。
 */
function rebuildJournalMap(index: Index, forest: readonly Block[]): void {
  index.journals.clear()
  walkForest(forest, (b) => {
    if (!isJournal(b)) return
    const d = journalDate(b)
    if (d !== '' && !index.journals.has(d)) index.journals.set(d, b.id)
  })
}

/**
 * **存在这一格的三态**：
 *
 * - `deleted`／`present`：块仍在树上（软删只是打标记），按**当前**删除态重算可见性 ——
 *   与旧 `_deletedAt` 属性走的是同一条 `refreshVisibility`。
 * - `purged`：块已经不在树上，但索引里还在 ⇒ 直接按「退场」摘掉整棵子树。
 *
 * 为什么 `purged` 不能也走 `refreshVisibility`：它在森林里找不到这块（`includeDeleted`
 * 也找不到），而索引里的旧条目必须被摘掉 —— 那正是「同一个词两个意思」时漏掉的一支。
 */
function applyBlockExist(index: Index, id: string, state: 'present' | 'deleted' | 'purged', forest: readonly Block[]): boolean {
  if (state === 'purged') {
    return applyBlockDelete(index, id, forest, true)
  }
  // 幂等：已经在索引里（可见）的块再收到一次 present ⇒ 一个字节都不该动
  if (state === 'present' && index.blocks.has(id)) return false
  return refreshVisibility(index, id, forest)
}

/**
 * **重算一个块的可见性**（`block.exist` 这一格）。
 *
 * 软删是「块还在树上原位、但索引看不见它」⇒ 这一格改了要按**当前**的删除态
 * 把整棵子树加进／移出索引（子树的可不见是继承来的，所以必须整棵一起动）。
 *
 * 口径与 `rebuild` 一致：走 `walkForest`，用 `includeDeleted` 让被删的块也参与遍历，
 * 再按 `isDeleted` 自己判 —— 与 `rebuild`／`applyBlockDelete` 同一份判据。
 */
function refreshVisibility(index: Index, blockId: string, forest: readonly Block[]): boolean {
  // 走 `walkForest` 含被删块找它（`findInForest` 是可见遍历，看不见软删的块）
  let block: Block | undefined
  let parentId: string | null = null
  walkForest(
    forest,
    (b, ctx) => {
      if (b.id !== blockId) return
      block = b
      parentId = ctx.parent?.id ?? null
      return false
    },
    { includeDeleted: true },
  )
  if (!block) return false
  if (isDeleted(block)) {
    // 变不可见 ⇒ 与「退场」走同一条路径（摘子树、退名字/成员/边）；块仍在树上，`all` 不动
    return applyBlockDelete(index, blockId, forest, false)
  }
  /**
   * 变可见 ⇒ 重新入场。
   *
   * ⚠️ 父**不能**从 `index.parentOf` 取：退场时它已经被摘掉了（`applyBlockDelete` 会删
   * 子树三张表）——拿它会让恢复出来的块变成「父为空、自己是根」，
   * 而全量重建会给出真实父。这条正是等式断言抓到的那种「哪一层都不报错」的分叉。
   */
  const rootId = parentId === null ? blockId : (index.rootOf.get(parentId) ?? blockId)
  indexSubtree(index, block, rootId, parentId)
  /**
   * 恢复的子树里如果带字段定义，别处使用该字段的属性值也要重新变成关系边
   * （它们退场时 `propKinds` 被摘掉了）；带标签类同理 —— 指向它的 `#名` 边
   * 要翻回提及。低频动作，走一次全量重算。
   * 同一趟顺带回答「这里有没有日记」——有 ⇒ 日记归属整表重建（先序第一可能换人）。
   */
  let hasPropDef = false
  let hasJournal = false
  let hasTagClass = false
  walkForest([block], (b) => {
    if (isPropDefBlock(b)) hasPropDef = true
    if (isJournal(b)) hasJournal = true
    if (hasList(b, 'tag')) hasTagClass = true
  })
  if (hasPropDef || hasTagClass) refreshAllRelations(index)
  // 名字：入场后要重新认领（被删期间它们无权认领，见 `rebuild` 的同一口径）
  refreshTagsClaim(index, blockId, forest)
  return hasJournal
}

function reindexSubtreeRoot(index: Index, root: Block, rootId: string): void {
  walkForest([root], (b) => {
    index.rootOf.set(b.id, rootId)
  })
}

/** 名字表摘块后的接手者：还活着的块里先序第一个认领这个名字的标签 */
function firstTagClaimant(forest: readonly Block[], name: string): string | undefined {
  let heir: string | undefined
  walkForest(forest, (b) => {
    if (heir) return false
    if (!hasList(b, 'tag')) return
    for (const alias of aliasesOf(b)) {
      if (normalizeAlias(alias) === name) {
        heir = b.id
        return false
      }
    }
  })
  return heir
}

function findInForest(forest: readonly Block[], id: string): Block | undefined {
  let hit: Block | undefined
  walkForest(forest, (b) => {
    if (b.id === id) {
      hit = b
      return false
    }
  })
  return hit
}

/** 子树 id（**含被删的后代**）——删块退场用的是这棵子树的全部，不是它的可见部分 */
function walkSubtreeIncludingDeleted(root: Block): string[] {
  const out: string[] = []
  walkForest(
    [root],
    (b) => {
      out.push(b.id)
    },
    { includeDeleted: true },
  )
  return out
}

/** 把一棵子树写进索引（与 `rebuild` 同一口径：先序；`rootId` ＝ 它所在的顶层块） */
function indexSubtree(index: Index, root: Block, rootId: string, parentId: string | null): void {
  /**
   * **两趟**：先把块/名字/定义 kind 都写进去，再收关系边。
   * 关系边要读 `propKinds`，而字段定义块可能就在这棵子树里、甚至排在使用者后面。
   *
   * ⚠️ 日期表不在这里打点：它有「谁先序第一」这条全局判据，由 `applyOps` 末尾
   *    （或 `rebuild`）整表重建；这里逐块写入反而会造出第二个答案。
   */
  const visited: Block[] = []
  walkForest([root], (b, ctx) => {
    index.blocks.set(b.id, b)
    index.rootOf.set(b.id, rootId)
    /**
     * 根块的父不在**这棵子树里**（`ctx.parent === null`）⇒ 用调用方给的 `parentId`；
     * 后代从走查里拿。两者只有一个来源，不另传一张父表。
     */
    index.parentOf.set(b.id, ctx.parent?.id ?? parentId)
    if (isPropDefBlock(b)) index.propKinds.set(b.id, propKindOf(b))
    if (hasList(b, 'tag')) index.tagClassIds.add(b.id)
    /**
     * 地址表：**每一个**别名都是一个地址（一个块可以有多个名字）。
     * 重复时先序第一个赢（与「先序第一个命中」同一个口径，不随机覆盖）。
     *
     * 全地址表（`aliases`）与标签名表（`tags`）在同一趟里打：两者的规范化与
     * 「先序第一个赢」完全一致，只有「收哪些块」不同。
     */
    for (const alias of aliasesOf(b)) {
      const name = normalizeAlias(alias)
      if (name === '') continue
      if (!index.aliases.has(name)) index.aliases.set(name, b.id)
      if (hasList(b, 'tag') && !index.tags.has(name)) index.tags.set(name, b.id)
    }
    for (const a of b.annos ?? []) index.annos.set(a.id, { hostId: b.id, anno: a })
    visited.push(b)
  })
  for (const b of visited) {
    removeOutgoing(index, b.id)
    for (const e of relationEdgesOfBlock(b, index.propKinds, index.tagClassIds, index.annos)) addEdge(index, e)
  }
  /**
   * **全部块表**（含被软删的）：与可见那趟分开走。
   *
   * 可见那趟按「软删子树整棵跳过」走（那是全仓唯一可见性判据）；而 `all` 要回答的是
   * 「树上有谁」，所以必须 `includeDeleted`。合成一趟要在每次访问时判「祖先里有没有删的」，
   * 那是 O(depth) × n；两趟各走各的更便宜，也保持两条口径都只有一句。
   */
  walkForest(
    [root],
    (b, ctx) => {
      index.all.set(b.id, b)
      index.parentOfAll.set(b.id, ctx.parent?.id ?? parentId)
    },
    { includeDeleted: true },
  )
  // 先序 rank：只记子孙（含软删兄弟）；根的位置取决于父级邻居，批次末尾由 `flushOrder` 放
  assignSubtreeRanks(index.order, root)
}

/* ------------------------------------------------------------ 查询 */

/**
 * 规范序列化（**用于「两份索引逐字节一致」的断言**）。
 *
 * 排序是必须的：`Map`/`Set` 的遍历顺序是插入顺序，两条路径（全量 vs 增量）的插入顺序天然不同，
 * 不排序就会把「顺序不同」误报成「内容不同」——那种假失败会让人去改本来正确的代码。
 */
export function fingerprint(index: Index): string {
  const sortedKeys = (m: Map<string, unknown>): string[] => [...m.keys()].sort()
  const flat = (m: Map<string, string | null>): unknown => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const edgeMap = (m: Map<string, RelationEdge[]>): unknown =>
    [...m.entries()]
      .map(([k, edges]) => [k, edges.map(relationEdgeKey).sort()] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify({
    blocks: sortedKeys(index.blocks),
    relations: edgeMap(index.relations),
    outgoing: edgeMap(index.outgoing),
    propKinds: [...index.propKinds.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    tagClassIds: [...index.tagClassIds].sort(),
    tags: flat(index.tags),
    aliases: flat(index.aliases),
    journals: flat(index.journals),
    rootOf: flat(index.rootOf),
    parentOf: flat(index.parentOf),
    all: sortedKeys(index.all),
    parentOfAll: flat(index.parentOfAll),
    /**
     * **先序 id 序列**（按逐层 rank 排序）＋ 缺 rank 的 id；**原始 rank 数值不进契约**。
     *
     * 增量路径的中点 rank 与全量重建的等步长 rank 天然不同字节；契约是「顺序一样」，
     * 与上面 `sortedKeys`／`flat` 把 Map 插入顺序排掉同一个理由。`missing` 单列：
     * 只要一边有缺而另一边没有，等式就红（而不是被排序悄悄吞掉）。
     */
    order: orderFingerprint(index),
    // range 与引文一起进指纹：内容写入口平移了区间而增量漏维护时，等式断言必须抓得到
    annos: [...index.annos.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, v.hostId, v.anno.range.start, v.anno.range.end, v.anno.quote?.exact ?? '']),
  })
}

/** 先序指纹：**排好序的 id 序列** ＋ 缺 rank 的 id（原始 rank 数值不进契约） */function orderFingerprint(index: Index): { seq: string[]; missing: string[] } {
  const rankPathOf = (id: string): number[] | undefined => {
    const out: number[] = []
    const seen = new Set<string>()
    let cur: string | null = id
    while (cur !== null) {
      if (seen.has(cur)) return undefined
      seen.add(cur)
      const rank = index.order.get(cur)
      if (rank === undefined) return undefined
      out.push(rank)
      const parent = index.parentOfAll.get(cur)
      if (parent === undefined) return undefined
      cur = parent
    }
    return out.reverse()
  }
  const ranked: { id: string; path: number[] }[] = []
  const missing: string[] = []
  for (const id of index.all.keys()) {
    const path = rankPathOf(id)
    if (path === undefined) missing.push(id)
    else ranked.push({ id, path })
  }
  ranked.sort((a, b) => {
    const d = compareRanks(a.path, b.path)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  return { seq: ranked.map((r) => r.id), missing: missing.sort() }
}

/**
 * **先序 id 序列**（含软删块；缺 rank 的块不在序列里）。
 * 测试与探针用它直接比「索引给出的顺序」与「森林走查的顺序」。
 */
export function orderSequenceOf(index: Index): string[] {
  return orderFingerprint(index).seq
}

/**
 * 这个 id 现在是哪一块（引用解析用；与 `store.find` 同语义）。
 * `to` 也可以是 anno id ⇒ 返回它的宿主块，让引用解析／跳转／反链都落在同一块上；
 * 显示名仍由引用 run 自己的 `anchor`（引文片段）覆盖，不会显示成宿主页名。
 */
export function lookupBlock(index: Index, id: string): Block | undefined {
  const b = index.blocks.get(id)
  if (b) return b
  const rec = index.annos.get(id)
  return rec ? index.blocks.get(rec.hostId) : undefined
}

/**
 * 从根到它（含自己）——面包屑。
 *
 * 沿 `parentOf` 向上再反转：O(depth)，不再对每条反链／每个查询结果走一遍森林。
 * 找不到（或父链中途断开／成环）⇒ 空数组：**宁可没有路径，也不给半截路径**
 * （半截面包屑会指向错误的位置，比不显示更糟）。
 */
export function indexPathOf(index: Index, id: string): Block[] {
  const out: Block[] = []
  const seen = new Set<string>()
  let cur: string | null = id
  while (cur !== null) {
    if (seen.has(cur)) return []
    seen.add(cur)
    const b = index.blocks.get(cur)
    if (!b) return []
    out.push(b)
    const parent = index.parentOf.get(cur)
    // `undefined` ＝ 索引里没有这条（不该发生）⇒ 整条路径不可信；`null` ＝ 到了顶层
    if (parent === undefined) return []
    cur = parent
  }
  return out.reverse()
}

/** 候选求值的一站：块本体 ＋ 真实祖先链（root→父）＋ 逐层 rank（root→自己） */
export interface LocatedSite {
  block: Block
  ancestors: readonly Block[]
  ranks: readonly number[]
}

/**
 * 候选 id 的**位置读面**：一次向上走查同时给出路径与先序 rank。
 *
 * 三态：可见且链完整 ⇒ 站点；**不可见**（不存在／被软删）⇒ `null`（确定不命中，跳过）；
 * 可见却缺 rank／断链 ⇒ `undefined`（索引分叉，调用方回退全林，不静默丢行、也不乱序）。
 * 路径与 rank 必须来自同一条真实祖先链——候选块不能被当成 root（那会把 `path` 截断，
 * 也会让 `_date` 排序看不到它所属的那一天）。
 */
export function locateOf(index: Index, id: string): LocatedSite | null | undefined {
  if (!index.blocks.has(id)) return null
  const path = indexPathOf(index, id)
  if (path.length === 0) return undefined
  const ranks: number[] = []
  for (const b of path) {
    const rank = index.order.get(b.id)
    if (rank === undefined) return undefined
    ranks.push(rank)
  }
  return { block: path[path.length - 1]!, ancestors: path.slice(0, -1), ranks }
}

/** 指向某个目标的所有关系边（入向；UI 按 kind 过滤） */
export function relationsTo(index: Index, targetId: string): readonly RelationEdge[] {
  return index.relations.get(targetId) ?? []
}

/** 某个源块发出的所有关系边（出向） */
export function relationsFrom(index: Index, sourceId: string): readonly RelationEdge[] {
  return index.outgoing.get(sourceId) ?? []
}

/** 谁引用它（默认只算 `inline`／`property`／`embed`）—— 反链的源块清单。
 *  kinds 放宽到全量 `RelationKind`：备注栏按 `['annotates']` 查（备注不是引用，不进缺省口径）。 */
export function incomingIds(
  index: Index,
  targetId: string,
  kinds: readonly RelationKind[] = REFERENCE_KINDS,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of index.relations.get(targetId) ?? []) {
    if (!(kinds as readonly RelationKind[]).includes(e.kind)) continue
    if (seen.has(e.from)) continue
    seen.add(e.from)
    out.push(e.from)
  }
  return out
}

/** 某个源块指向目标**几次**（同一块里多处引用各算一条边；属性/嵌入各算一次） */
export function incomingCount(
  index: Index,
  targetId: string,
  sourceId: string,
  kinds: readonly RefKind[] = REFERENCE_KINDS,
): number {
  let n = 0
  for (const e of index.relations.get(targetId) ?? []) {
    if (e.from !== sourceId) continue
    if (!(kinds as readonly RelationKind[]).includes(e.kind)) continue
    n += e.count ?? 1
  }
  return n
}

/**
 * 指向目标**总共几处**（全部来源加总；口径同 `incomingCount`——只认引用边，
 * 标签归属不混进来）。反链卡的「按根聚合」各有分工：那个回答「谁引用我」，
 * 这个只回答「被引用得多不多」——检索候选行上区分「同一段字出现在几块」时的
 * 那个权威信号。O(这一块自己的边数)，查表不遍历森林。
 */
export function inboundRefCount(index: Index, targetId: string): number {
  let n = 0
  for (const e of index.relations.get(targetId) ?? []) {
    if (!(REFERENCE_KINDS as readonly RelationKind[]).includes(e.kind)) continue
    n += e.count ?? 1
  }
  return n
}

/** 谁打了这个标签 —— 「标签的成员列表」（只认 `tag` 边，不认正文里的 `#名` 提及） */
export function tagMemberIdsOf(index: Index, tagId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const e of index.relations.get(tagId) ?? []) {
    if (e.kind !== 'tag' || seen.has(e.from)) continue
    seen.add(e.from)
    out.push(e.from)
  }
  return out
}

/**
 * 下级**标签** id（含自己）——「算作」的闭包在索引上的那一份。
 *
 * 口径与 `identity/tag-tree.ts` 的 `descendantTagIds` 必须一致：沿归属边走全部下级，
 * 但只把**带 `tag` 露面**的收进来——归属边能连任何块，而「成员」说的仍然是
 * 「打了这个标签的块」。两级查询路径（纯函数／索引）给两个答案，比没有这个参数更糟。
 */
function descendantTagIdsOfIndex(index: Index, tagId: string): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>()
  const stack = [tagId]
  while (stack.length > 0) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const b = index.blocks.get(id)
    if (b && hasList(b, 'tag')) out.add(id)
    // 归属边：from＝下级、to＝上级 ⇒ `relations.get(id)` 是 id 的直接下级
    for (const e of index.relations.get(id) ?? []) {
      if (e.kind === 'belongsTo' && !seen.has(e.from)) stack.push(e.from)
    }
  }
  return out
}

/** 某个目标上每种关系出现了几次（UI 的 kind chips 用；`inline` 按出现次数计） */
export function relationKindCounts(index: Index, targetId: string): Map<RelationKind, number> {
  const out = new Map<RelationKind, number>()
  for (const e of index.relations.get(targetId) ?? []) {
    out.set(e.kind, (out.get(e.kind) ?? 0) + (e.count ?? 1))
  }
  return out
}

/** 按规范化名字找标签块 id */
/**
 * 按**地址**查块 id（`[[名字]]` 解析、`@` 补全、改名查重都走它）。
 *
 * 与 `findByAlias` 同一条口径（先序第一个赢），只是查表而不是遍历森林：
 * 50000 块时遍历是 1.1ms，而 `@` 补全每敲一个字都要问一次。
 *
 * ⚠️ 返回的是 **id**，调用方要拿块得再 `find(id)`：索引存的是活引用，但
 *    「地址 → id」是快照（改名会让它失效，而那一格由 `refreshTagsClaim` 修补）。
 */
export function blockIdByAlias(index: Index, name: string): string | undefined {
  const want = normalizeAlias(name)
  if (want === '') return undefined
  return index.aliases.get(want)
}

/* ------------------------------------------------------------ 查询 */

/**
 * **查询走索引**：可枚举条件先抽候选，再**按候选 id 迭代**（不再遍历全林）；
 * 顺序由 `Index.order`（按层先序 rank）给出，路径由 `parentOf` 现拼。
 *
 * 不可枚举的形状（方向原子／`refCount` 排序／`prop`／`text`／…）整次回退到
 * `evaluateQuery` 的 `walk(forest)`。两条路径的判定与排序语义共用 `query.ts`
 * （同一份 matcher／`applySort`），只有「候选与环境怎么来」不同；回退可计数
 * （`cacheProbe.fallbackQueries`）。
 *
 * 与纯函数路径 `runQuery` 的等式（同一输入 ⇒ 同一输出）由测试钉住；
 * 换成 SQLite 之后，这张等式的另一边就是 SQL 查询要复刻的口径。
 */
export function queryByIndex(
  index: Index,
  forest: readonly Block[],
  spec: QuerySpec,
  opts: { selfId?: string; excludeIds?: readonly string[]; today?: string } = {},
): QueryHit[] {
  const { q, env } = specContextOf(index, forest, spec, opts)
  /**
   * 候选集只换「哪些块可能命中」，不换 roots：把候选块当 root 会截断 `QueryHit.path`。
   * 顶层精确日记与其它形状互斥（where 只有一个节点），所以这里只有一个来源。
   */
  const candidates = isExactRoleJournal(q.where)
    ? new Set(journalDaysOfIndex(index, forest).map((day) => day.id))
    : candidateIdsOf(q.where, candidateTablesOf(index, forest, env))
  if (candidates !== undefined) {
    const hits = evaluateQueryIds(q, candidates, env, (id) => locateOf(index, id))
    if (hits !== undefined) {
      index.cacheProbe.candidateQueries++
      return hits
    }
  }
  // 不可枚举 / 方向原子 / refCount 排序 / 任一候选定不了位 ⇒ 全林回退（可计数）
  index.cacheProbe.fallbackQueries++
  return evaluateQuery(q, forest, env, forest)
}

/**
 * 抽取要的读数：全部取自索引已有表／派生列表，不为查询新建表。
 * 列表按需重建（`ensureIndexLists`），与 `pages()/tags()` 的读面同一条失效口径。
 */
function candidateTablesOf(index: Index, forest: readonly Block[], env: QueryEnv): CandidateTables {
  const lists = (): IndexLists => ensureIndexLists(index, forest)
  return {
    tagUnion: () => env.tags,
    refSources: (targetId, kinds) => incomingIds(index, targetId, kinds),
    pages: () => lists().pages.map((b) => b.id),
    tags: () => lists().tags.map((b) => b.id),
    journals: () => lists().journals.map((b) => b.id),
  }
}

/**
 * **候选求值**：从一组 id 出发，不遍历森林；环境与 `queryByIndex` 同一份。
 *
 * `undefined` ＝ 这份条件不该由候选路径回答（方向原子／`refCount` 排序，或任一候选
 * 定不了位）——调用方回退 `queryByIndex`，不拿半批结果。
 */
export function queryByIndexIds(
  index: Index,
  forest: readonly Block[],
  spec: QuerySpec,
  ids: Iterable<string>,
  opts: { selfId?: string; excludeIds?: readonly string[]; today?: string } = {},
): QueryHit[] | undefined {
  const { q, env } = specContextOf(index, forest, spec, opts)
  return evaluateQueryIds(q, ids, env, (id) => locateOf(index, id))
}

/**
 * 一份条件的**求值上下文**（`$self` 解析 ＋ 环境表 ＋ 成员候选集）：
 * `queryByIndex`（整库求值）与 `blockMatchesSpec`（单块判定）共用，
 * 「环境怎么来」只有这一份，两条读路不许各漂各的。
 */
function specContextOf(
  index: Index,
  forest: readonly Block[],
  spec: QuerySpec,
  opts: { selfId?: string; excludeIds?: readonly string[]; today?: string } = {},
): { q: QuerySpec; env: QueryEnv } {
  /**
   * `'$self'` 的解析与纯函数路径**共用同一份**（`resolveSelfSpec`），
   * 连「没有宿主 ⇒ 空结果」这条也在同一个判据上：两条路径只许在「环境怎么来」上不同。
   */
  const host = opts.selfId !== undefined ? lookupBlock(index, opts.selfId) : undefined
  if (!host && usesSelf(spec.where)) return { q: { where: { any: [] } }, env: neverEnv() }
  // 字段表是两趟全林：查询/条件树会反复要，走 Index 上的缓存；`$self` 的 `{prop}` 分支也吃这一份
  const fields = indexFieldTable(index, forest)
  const q = host ? resolveSelfSpec(spec, host, forest, fields) : spec
  const env: QueryEnv = {
    refSources: usesRef(q.where) ? refSourcesByIndex(index) : () => undefined,
    ...(usesRefAny(q.where) ? { refFroms: refFromsByIndex(index) } : {}),
    tags: tagsByIndex(q.where, index),
    fields,
    ...(opts.today ? { today: opts.today } : {}),
    ...(opts.excludeIds && opts.excludeIds.length > 0 ? { excludeIds: new Set(opts.excludeIds) } : {}),
  }
  return { q, env }
}

/**
 * 顶层精确日记的成员集（一天一个、先序第一个）——与 `journalDays` 同一条。
 *
 * 从**全部日记块列表**去重，而不是从日期表取 values：日期表是「按日期找块」的解析表，
 * 它的赢家口径不能反过来定义查询成员。列表是森林先序，去重结果与 `journalDays` 逐条相同。
 */
function journalDaysOfIndex(index: Index, forest: readonly Block[]): Block[] {
  const byDate = new Map<string, Block>()
  for (const b of ensureIndexLists(index, forest).journals) {
    const d = journalDate(b)
    if (d !== '' && !byDate.has(d)) byDate.set(d, b)
  }
  return [...byDate.values()]
}

/** 「没有宿主 ⇒ 恒假」的环境：调用方直接拿空结果，不走判定 */
function neverEnv(): QueryEnv {
  return { refSources: () => undefined, tags: new Set<string>(), fields: fieldTableOf([]) }
}

/**
 * **单块判定**：一个（可能还不在树里的）块若此刻在库里，会不会命中这份条件。
 *
 * 消费者是看板列尾的「新建」：按钮的可用性由「新卡的出生形态（只有列值、
 * 无引用、无父块）能不能命中」**推导**出来——按钮出现即兑现，不出现即「这里长不出块」。
 * 环境与 `queryByIndex` 同一份（`specContextOf`），判定与整库求值不许各漂各的。
 */
export function blockMatchesSpec(
  index: Index,
  forest: readonly Block[],
  spec: QuerySpec,
  block: Block,
  opts: { selfId?: string; excludeIds?: readonly string[]; today?: string } = {},
): boolean {
  const { q, env } = specContextOf(index, forest, spec, opts)
  return createMatcher(forest, env).matches(q.where, block)
}

/**
 * `ref` 条件的读面：**按目标懒建**（表已在索引里，不必整片扫）。
 *
 * 与纯函数路径同一个形状、同一个判定：`evaluateQuery` 只看 `(目标, kind) → 来源`，
 * 两条路只许在「表怎么来」上不同。用 `incomingIds` 而不是自己遍历 `relations`，
 * 是为了让「什么算引用」仍然只有那一处口径。
 */
function refSourcesByIndex(index: Index): RefSources {
  const cache = new Map<string, ReadonlyMap<RelationKind, ReadonlySet<string>>>()
  return (targetId) => {
    const hit = cache.get(targetId)
    if (hit) return hit
    const edges = index.relations.get(targetId)
    if (!edges || edges.length === 0) return undefined
    const byKind = new Map<RelationKind, ReadonlySet<string>>()
    for (const kind of REFERENCE_KINDS) {
      const ids = incomingIds(index, targetId, [kind])
      if (ids.length > 0) byKind.set(kind, new Set(ids))
    }
    cache.set(targetId, byKind)
    return byKind
  }
}

/**
 * 「这块发过哪些 kinds 的引用边」——`{ref}` 不限目标时的读面，按块**懒查** `outgoing`
 * （表已在索引里，与 `refSourcesByIndex` 同一个理由）。判定与纯函数路径共用
 * `evaluateQuery`，这里只管把同一份口径的表递过去；只认 `REFERENCE_KINDS`，
 * 标签归属／`#名` 提及等非引用边从这张表里就进不来。
 */
function refFromsByIndex(index: Index): RefFroms {
  const cache = new Map<string, ReadonlySet<RelationKind>>()
  return (blockId) => {
    const hit = cache.get(blockId)
    if (hit) return hit
    const kinds = new Set<RelationKind>()
    for (const e of index.outgoing.get(blockId) ?? []) if (isRefKind(e.kind)) kinds.add(e.kind)
    cache.set(blockId, kinds)
    return kinds
  }
}

/**
 * 「名字 → 标签块 id」的查表访问器：改名传播、候选显示名等仍按名字问索引。
 * ⚠️ 查询的 `{tag}` 条件**不走这里**——它按标签块 id 存（与 `{prop}` 同一条纪律），
 *    名字表只服务「用户嘴里说的是哪个标签」这一类问题。
 */
export function tagIdByName(index: Index, name: string): string | undefined {
  return index.tags.get(normalizeAlias(name))
}

/** 一个标签（含 `desc` 闭包）的成员 id 集合 */
function tagMemberSetOf(tag: Block, desc: boolean, index: Index): Set<string> {
  const out = new Set<string>()
  const tags = desc ? descendantTagIdsOfIndex(index, tag.id) : [tag.id]
  for (const tid of tags) for (const mid of tagMemberIdsOf(index, tid)) out.add(mid)
  return out
}

/** `tag` 条件的目标块集合 —— id 解析成标签块，再查**成员表** */
function tagsByIndex(node: QueryNode, index: Index): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('up' in n) visit(n.up)
    else if ('down' in n) visit(n.down)
    else if ('near' in n) visit(n.near)
    else if ('tag' in n) {
      // 条件按**标签块 id**存；与纯函数路径同一条守卫：id 要解析得到活着的标签块
      const id = typeof n.tag === 'string' ? n.tag : n.tag.id
      const desc = typeof n.tag === 'string' ? false : n.tag.desc === true
      const tag = lookupBlock(index, id)
      if (!tag || !hasList(tag, 'tag')) return
      for (const mid of tagMemberSetOf(tag, desc, index)) out.add(mid)
    }
  }
  visit(node)
  return out
}

/**
 * 某天的 journal 块 id。
 *
 * ⚠️ **口径与 `journal.ts` 的 `journalDays` 同源**（`isJournal` ＋ `journalDate`，整片森林、
 *    同一天取先序第一个）—— 两条路必须给同一个答案，否则「这一天是哪一块」会有两说。
 */
export function journalIdByDate(index: Index, date: string): string | undefined {
  return index.journals.get(date)
}
