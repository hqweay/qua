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
import { aliasesOf, ALIASES_PROP, hasList, isDeleted, isPropDefBlock, LISTS_PROP, type Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import { normalizeAlias } from '../identity/alias.ts'
import { journalDate, isJournal } from '../identity/journal.ts'
import { fieldTableOf, propKindOf, type PropKind } from '../props/props.ts'
import {
  collectPropKinds,
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
  isExactRoleJournal,
  resolveSelfSpec,
  usesRef,
  usesSelf,
  type QueryEnv,
  type QueryHit,
  type QueryNode,
  type QuerySpec,
  type RefSources,
} from '../query/query.ts'

/**
 * 一份索引。各表各答一类问题，**全是派生**：
 *
 * | 表 | 答什么 | 谁在用 |
 * |---|---|---|
 * | `blocks` | 这个 id 现在是哪一块、叫什么 | 引用解析（`resolveRef`） |
 * | `relations` / `outgoing` | 谁指向谁、以什么 kind | 反链、标签成员、属性引用、关系面板 |
 * | `propKinds` | 哪些字段定义是 `ref`（决定属性值算不算关系） | 关系边提取 |
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
}

function emptyIndex(): Index {
  return {
    blocks: new Map(),
    relations: new Map(),
    outgoing: new Map(),
    propKinds: new Map(),
    tags: new Map(),
    aliases: new Map(),
    journals: new Map(),
    rootOf: new Map(),
    parentOf: new Map(),
    all: new Map(),
    parentOfAll: new Map(),
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
   * 先收定义 kind，再收边：字段定义块可能住在后面的顶层根里，
   * 边提取时 `propKinds` 必须已经知道哪些属性是 `ref`。
   */
  idx.propKinds = collectPropKinds(forest)

  // 块表 / 标签表 / 日记表 / 根表 / 关系边（一次先序遍历；与增量修补同一口径）。
  // ⚠️ 遍历默认跳过被删的子树（原位软删：被删的块对索引不可见）。
  for (const b of forest) indexSubtree(idx, b, b.id, null)

  return idx
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
  for (const e of relationEdgesOfBlock(live, idx.propKinds)) addEdge(idx, e)
}

/**
 * 全量重算关系边（只用于**低频且影响面大**的改动：字段定义的 kind 改了/定义块被删）。
 * 正常打字/改标签/改属性只走 `refreshRelations`，成本与这一块的边数有关。
 */
function refreshAllRelations(idx: Index): void {
  idx.relations.clear()
  idx.outgoing.clear()
  for (const b of idx.blocks.values()) {
    for (const e of relationEdgesOfBlock(b, idx.propKinds)) addEdge(idx, e)
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
 *   · 日期表：rebuild 是先序**最后一个**赢 ⇒ 摘块重扫同样取最后一个；
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
  for (const op of ops) {
    switch (op.e) {
      case 'block':
        if (op.op === 'upsert') {
          if (op.value.parent !== undefined && !index.blocks.has(op.id)) fresh.add(op.id)
          applyBlockUpsert(index, op.id, op.value, forest)
        } else applyBlockExist(index, op.id, op.state, forest)
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
        if (fresh.has(op.block) && (op.name === ALIASES_PROP || op.name === LISTS_PROP || op.name === '_tags' || op.name === '_date' || op.name === '_kind')) break
        if (op.name === ALIASES_PROP || op.name === LISTS_PROP) {
          refreshTagsClaim(index, op.block, forest)
          refreshRelations(index, op.block)
        } else if (op.name === '_date') {
          refreshJournalClaim(index, op.block)
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
      // `anno` 是按需物化的可引用区间，不是指向边：边只从引用 run 提取
    }
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
    return
  }
  const block = findInForest(forest, id)
  if (!block) return
  indexSubtree(index, block, rootId, parent)
}

/**
 * 块 delete：**原位软删**的索引面——块还在森林里，但要从索引表里退场。
 *
 * 退场的是「可见集合」：根 ＋ 它**还没被删**的后代（本来就删了的已经不在表里）。
 * 入向边跟着源块退场（`edgeByAnno` 簿记摘旧边）——数据源 atoms 没动，
 * 但 rebuild 只数可见源块的原子，两条路必须同口径。名字表/日期表的接手者重扫
 * 森林时同样跳过被删子树（被删的块无权认领名字）。
 */
function applyBlockDelete(index: Index, id: string, forest: readonly Block[], purge: boolean): void {
  /**
   * 软删过的块不在 `blocks` 里 —— 清除它时要到 `all` 里取（否则子树摘不掉，
   * 索引会留下一个「已经不存在的 id」；而撤销会因此以为它还在）。
   */
  const block = index.blocks.get(id) ?? (purge ? index.all.get(id) : undefined)
  if (!block) return
  // ⚠️ 取子树要**含被删块**：执行到这里时根已被打上标记（tx 先改内存、后修补索引），
  //    默认遍历会把整棵子树跳过去——一张都摘不掉。退场的正是「这棵子树里的全部」。
  const gone = walkSubtreeIncludingDeleted(block)
  const goneSet = new Set(gone)
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
  walkForest(
    [block],
    (b) => {
      for (const alias of aliasesOf(b)) {
        const name = normalizeAlias(alias)
        if (name !== '') names.add(name)
      }
      if (isJournal(b)) dates.add(journalDate(b))
      if (index.propKinds.delete(b.id)) droppedPropKind = true
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
  // 日期表：同上（rebuild 是先序最后一个赢 ⇒ 接手也取最后一个）
  const goneDates = [...dates].filter((d) => {
    const owner = index.journals.get(d)
    return owner !== undefined && goneSet.has(owner)
  })
  for (const d of goneDates) index.journals.delete(d)
  for (const d of goneDates) {
    const heir = lastJournalClaimant(forest, d)
    if (heir) index.journals.set(d, heir)
  }
  // 关系边：源在退场子树里的边一起摘（恢复时随子树重建）。
  // 字段定义退场 ⇒ 所有使用它的属性值都不再算关系，走一次全量重算（低频）。
  if (droppedPropKind) {
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
    }
  }
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

/** 重算一个块对**日期表**的认领（口径与 rebuild 相同：无条件覆盖＝先序最后一个赢） */
function refreshJournalClaim(index: Index, blockId: string): void {
  const live = index.blocks.get(blockId)
  if (!live) return
  for (const [d, owner] of [...index.journals]) {
    if (owner === blockId) index.journals.delete(d)
  }
  if (isJournal(live)) {
    const d = journalDate(live)
    if (d !== '') index.journals.set(d, blockId)
  }
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
function applyBlockExist(index: Index, id: string, state: 'present' | 'deleted' | 'purged', forest: readonly Block[]): void {
  if (state === 'purged') {
    applyBlockDelete(index, id, forest, true)
    return
  }
  // 幂等：已经在索引里（可见）的块再收到一次 present ⇒ 一个字节都不该动
  if (state === 'present' && index.blocks.has(id)) return
  refreshVisibility(index, id, forest)
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
function refreshVisibility(index: Index, blockId: string, forest: readonly Block[]): void {
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
  if (!block) return
  if (isDeleted(block)) {
    // 变不可见 ⇒ 与「退场」走同一条路径（摘子树、退名字/日期/成员/边）；块仍在树上，`all` 不动
    applyBlockDelete(index, blockId, forest, false)
    return
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
   * （它们退场时 `propKinds` 被摘掉了）。低频动作，走一次全量重算。
   */
  let hasPropDef = false
  walkForest([block], (b) => {
    if (isPropDefBlock(b)) hasPropDef = true
  })
  if (hasPropDef) refreshAllRelations(index)
  // 名字/日期：入场后要重新认领（被删期间它们无权认领，见 `rebuild` 的同一口径）
  refreshTagsClaim(index, blockId, forest)
  refreshJournalClaim(index, blockId)
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

/** 日期表摘块后的接手者：先序**最后一个**（与 rebuild 的无条件覆盖同一口径） */
function lastJournalClaimant(forest: readonly Block[], date: string): string | undefined {
  let heir: string | undefined
  walkForest(forest, (b) => {
    if (isJournal(b) && journalDate(b) === date) heir = b.id
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
   * **两趟**：先把块/名字/日期/定义 kind 都写进去，再收关系边。
   * 关系边要读 `propKinds`，而字段定义块可能就在这棵子树里、甚至排在使用者后面。
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
    if (isJournal(b)) {
      const d = journalDate(b)
      if (d !== '') index.journals.set(d, b.id)
    }
    visited.push(b)
  })
  for (const b of visited) {
    removeOutgoing(index, b.id)
    for (const e of relationEdgesOfBlock(b, index.propKinds)) addEdge(index, e)
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
    tags: flat(index.tags),
    aliases: flat(index.aliases),
    journals: flat(index.journals),
    rootOf: flat(index.rootOf),
    parentOf: flat(index.parentOf),
    all: sortedKeys(index.all),
    parentOfAll: flat(index.parentOfAll),
  })
}

/** 这个 id 现在是哪一块（引用解析用；与 `store.find` 同语义） */
export function lookupBlock(index: Index, id: string): Block | undefined {
  return index.blocks.get(id)
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

/** 指向某个目标的所有关系边（入向；UI 按 kind 过滤） */
export function relationsTo(index: Index, targetId: string): readonly RelationEdge[] {
  return index.relations.get(targetId) ?? []
}

/** 某个源块发出的所有关系边（出向） */
export function relationsFrom(index: Index, sourceId: string): readonly RelationEdge[] {
  return index.outgoing.get(sourceId) ?? []
}

/** 谁引用它（默认只算 `inline`／`property`／`embed`）—— 反链的源块清单 */
export function incomingIds(
  index: Index,
  targetId: string,
  kinds: readonly RefKind[] = REFERENCE_KINDS,
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
 * **查询走索引**：`ref`／`tag`／`journal` 三类条件查表（O(1)），其余谓词仍是逐块判定。
 *
 * 为什么不是「查询全在索引里」：索引是派生**表**，不记树的形状（`rootOf` 只到顶层、
 * 挪位后 `blocks` 的插入顺序会漂移）——候选迭代与结果顺序仍按森林先序走，
 * 判定与顺序共用 `query.ts` 的 `evaluateQuery`（两条路径只有「环境怎么来」不同）。
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
  /**
   * `'$self'` 的解析与纯函数路径**共用同一份**（`resolveSelfSpec`），
   * 连「没有宿主 ⇒ 空结果」这条也在同一个判据上：两条路径只许在「环境怎么来」上不同。
   */
  const host = opts.selfId !== undefined ? lookupBlock(index, opts.selfId) : undefined
  if (!host && usesSelf(spec.where)) return []
  const q = host ? resolveSelfSpec(spec, host, forest) : spec
  const env: QueryEnv = {
    refSources: usesRef(q.where) ? refSourcesByIndex(index) : () => undefined,
    tags: tagsByIndex(q.where, index),
    fields: fieldTableOf(forest),
    ...(opts.today ? { today: opts.today } : {}),
    ...(opts.excludeIds && opts.excludeIds.length > 0 ? { excludeIds: new Set(opts.excludeIds) } : {}),
  }
  const roots: readonly Block[] = forest
  /**
   * 成员条件的候选集：顶层就是 `{role:'journal'}` 时，日期表就是「库里有哪些天」
   * （一天一个、O(天数)），不用全库逐块判定。它与纯函数路径的 `journalDays` 同口径，
   * 等式由测试钉住；不是范围条件，判定不做特殊处理。
   */
  const memberRoots = isExactRoleJournal(q.where)
    ? [...index.journals.values()].map((id) => index.blocks.get(id)).filter((b): b is Block => b !== undefined)
    : roots
  return evaluateQuery(q, memberRoots, env, forest)
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
 * 「名字 → 标签块 id」的查表访问器：改名传播、候选显示名等仍按名字问索引。
 * ⚠️ 查询的 `{tag}` 条件**不走这里**——它按标签块 id 存（与 `{prop}` 同一条纪律），
 *    名字表只服务「用户嘴里说的是哪个标签」这一类问题。
 */
export function tagIdByName(index: Index, name: string): string | undefined {
  return index.tags.get(normalizeAlias(name))
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
      const tag = lookupBlock(index, n.tag)
      if (tag && hasList(tag, 'tag')) for (const id of tagMemberIdsOf(index, tag.id)) out.add(id)
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
