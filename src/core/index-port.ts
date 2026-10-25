/**
 * **索引**（IndexPort）：把「谁指向谁」这类问题从「每次全库扫一遍」变成「查表」。
 *
 * 判据（派生层不物化）：索引**不是真相源**，是可从「块森林（含块上的行内内容）」重建的派生视图。
 *   ⇒ `rebuild(source)` 与「一路增量累积」必须得到**同一份**索引（`fingerprint` 逐字节相等）。
 *   这条等式就是本文件的验收标准 —— 它挡住的正是那种「增量更新漏了一种失效点、
 *   但界面上看起来只是偶尔少一条」的静默错误。
 *
 * ⚠️ 索引里存的是**块的活引用**，不是拷贝：块是可变的（正文可经 `writeBlockText` 就地改写），
 *    所以「块的内容变了」不需要动索引（活引用自动可见），需要动的只有**结构**（谁在场、住哪页、
 *    谁认领哪个名字）——按 op 修补的正是这一部分（`applyOps`）。
 * ⚠️ 本文件零 DOM、零持久化：它只吃森林，所以能直接单测。
 */
import { aliasesOf, hasList, type Block } from './model.ts'
import { refRunsOf } from './runs.ts'
import { walkForest } from './walk.ts'
import { normalizeAlias } from './alias.ts'
import { journalDate, isJournal } from './journal.ts'
import { tagIdsOf } from './tags.ts'
import type { Op } from './kb/types.ts'
import { evaluateQuery, firstJournal, isExactRoleJournal, type QueryEnv, type QueryHit, type QueryNode, type QuerySpec } from './query.ts'

/**
 * 一份索引。五张表各答一类问题，**全是派生**：
 *
 * | 表 | 答什么 | 谁在用 |
 * |---|---|---|
 * | `blocks` | 这个 id 现在是哪一块、叫什么 | 引用解析（`resolveRef`） |
 * | `incoming` | 谁引用它、引用了几次 | 反链 |
 * | `tagMembers` | 谁打了这个标签（**从块上的 `_tags` 建**，同块多次只算一次） | 标签成员 |
 * | `tags` / `journals` | 按名字/日期找块 | 标签解析、日记条件 |
 * | `pageOf` | 这块住哪一页 | 反链按来源页聚合 |
 */
export interface Index {
  /** 块 id → 块（**活引用**） */
  blocks: Map<string, Block>
  /**
   * 入向边：targetId → (源块 id → **引用数**)。
   *
   * ⚠️ 只算**引用**（`[[名]]`）：标签是块级归属，不进这张表（它没有位点，也就没有边数）。
   *    标签的成员关系在 `tagMembers`，两张表不要合并。
   * ⚠️ 值是**计数**不是集合：反链要显示「这一页共有几处指向我」，
   *    同一块里引用两次就是两条边。用 `Set` 会把它压成 1（行为会悄悄变）。
   */
  incoming: Map<string, Map<string, number>>
  /**
   * 标签成员：tagBlockId → 打这个标签的块 id。
   *
   * ⚠️ 与 `incoming` 分开存，是因为语义不同：一个 `[[标签块]]` 的**引用**不是「打了这个标签」。
   *    合并成一张表会让「引用到标签块」凭空变成一条成员关系。
   * ⚠️ 这里是**集合**：同一块打两次同一标签只算一个成员（成员关系不是次数）。
   * ⚠️ 数据源是**块上的 `_tags`**（不是原子）：所以只有块变化才需要重算这张表。
   */
  tagMembers: Map<string, Set<string>>
  /**
   * 标签名表：规范化标签名 → 标签块 id。
   *
   * ⚠️ 一个标签有多个别名时，**每一个**都进这张表（都指向同一块）；
   *    重名时先序第一个赢。这里与 `findByAlias` 同口径，不另写一套比较。
   */
  tags: Map<string, string>
  /** 日期（`YYYY-MM-DD`）→ journal 块 id */
  journals: Map<string, string>
  /** 块 id → 它所在的**顶层块** id（含自己）—— 反链按来源页聚合要用 */
  pageOf: Map<string, string>
  /**
   * 内部簿记：引用 run id → 它此刻贡献的那条边（**不进 fingerprint**）。
   *
   * 为什么必须有它：`incoming` 的单位是「target → (源块 → 次数)」，不按 run id 键控——
   * 一条引用**改了指向**时，摘掉旧边需要知道它原来指哪，而 op 只带新值。
   * 全量重建天然有这个信息（重扫所有块的内容）；增量路径靠这张表补齐。
   */
  edgeByAnno: Map<string, { target: string; source: string }>
}

function emptyIndex(): Index {
  return {
    blocks: new Map(),
    incoming: new Map(),
    tagMembers: new Map(),
    tags: new Map(),
    journals: new Map(),
    pageOf: new Map(),
    edgeByAnno: new Map(),
  }
}

/* ------------------------------------------------------------ 构建 */

/**
 * **从源头重建**（全量）。这是唯一的正确性基准：
 * 任何增量路径的结果都必须与它逐字节一致。
 */
export function rebuild(forest: readonly Block[]): Index {
  const idx = emptyIndex()

  // ① 块表 / 标签表 / 日记表 / 父页表 / 成员表 / 入向边（一次先序遍历；与增量修补同一口径）。
  //    边从块内容里的引用 run 提取——只有引用（无 flavor）；行内标签（flavor '#'）
  //    是归属的露面，不是指向边，不进 `incoming`。
  // ⚠️ 遍历默认跳过被删的子树（原位软删：被删的块对索引不可见）。
  for (const b of forest) indexSubtree(idx, b, b.id)

  return idx
}

/** 把一条引用累加进 `incoming`（`delta` 负值＝摘边；计数到 0 就把空壳摘干净） */
function bump(idx: Index, target: string, source: string, delta: 1 | -1): void {
  if (delta > 0) {
    const perSource = idx.incoming.get(target)
    if (perSource) perSource.set(source, (perSource.get(source) ?? 0) + 1)
    else idx.incoming.set(target, new Map([[source, 1]]))
    return
  }
  const perSource = idx.incoming.get(target)
  if (!perSource) return
  const n = (perSource.get(source) ?? 0) - 1
  if (n > 0) perSource.set(source, n)
  else {
    perSource.delete(source)
    if (perSource.size === 0) idx.incoming.delete(target)
  }
}

/** 把一块内容里的引用 run 累加进 `incoming`（登记簿记，增量的旧边摘除靠它） */
function addEdgesOfBlock(idx: Index, block: Block): void {
  for (const r of refRunsOf(block.content)) {
    if (r.flavor === '#') continue
    const target = r.to
    if (!target) continue
    idx.edgeByAnno.set(r.id, { target, source: block.id })
    bump(idx, target, block.id, 1)
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
 *     （名字表里谁认领这个名字、成员表里这块在哪些集合里），从表里反查即可，不需要 op 带旧值；
 *   · **引用边的旧指向记在 `edgeByAnno`**（见 Index 的簿记注释）——op 只带新值时从簿记摘旧边。
 *
 * 与 `rebuild` 的口径对齐点（逐条对过，改任何一边都要回头查另一边）：
 *   · 名字表：先序第一个认领者赢 ⇒ 增量加名时「表里已有人就不抢」；
 *     摘块时受影响的名字**重扫森林**找下一个认领者（被删的块无权认领）；
 *   · 日期表：rebuild 是先序**最后一个**赢 ⇒ 摘块重扫同样取最后一个；
 *   · 成员表：集合语义，同块打两次同标签只算一个；
 *   · 入向边：数据源是**原子数组**，但只算**可见源块**的——
 *     删块把「源在这个子树里」的边一起摘（恢复时随子树重建），与 rebuild 同口径。
 *
 * 找不到块（op 引用的 id 既不在索引也不在森林）⇒ 跳过该 op：op 序列是事实陈述，
 * 不是「必须可执行」的指令；等式测试会把任何因此产生的分叉抓出来。
 */
export function applyOps(index: Index, ops: readonly Op[], forest: readonly Block[]): Index {
  for (const op of ops) {
    switch (op.e) {
      case 'block':
        if (op.op === 'upsert') applyBlockUpsert(index, op.id, op.value, forest)
        else applyBlockDelete(index, op.id, forest)
        break
      case 'prop':
        // 哪个属性槽喂哪张表：地址/露面 → 名字表；归属 → 成员表；日期 → 日记表；其余不进索引
        if (op.name === '_aliases' || op.name === '_lists') refreshTagsClaim(index, op.block)
        else if (op.name === '_tags') refreshTagMembership(index, op.block)
        else if (op.name === '_date') refreshJournalClaim(index, op.block)
        break
      case 'alias':
      case 'list':
        refreshTagsClaim(index, op.block)
        break
      // `anno` 是按需物化的可引用区间，不是指向边：边只从引用 run 提取
    }
  }
  return index
}

/**
 * 块 upsert：`content` ⇒ 重算这块的指向边（引用 run 增删/改向都在内容里）；
 * `parent` ⇒ 挪位/新进。`blocks` 里是活引用，块自己的内容变化不用回头改表，
 * 需要动的只有**以 run id 键控的边簿记**。
 */
function applyBlockUpsert(
  index: Index,
  id: string,
  value: { content?: unknown; parent?: string | null },
  forest: readonly Block[],
): void {
  const known = index.blocks.get(id)
  if (value.content !== undefined && known) {
    // 摘旧边（簿记里 source 是这块的全部条目），再按新内容加回来
    for (const [rid, edge] of [...index.edgeByAnno]) {
      if (edge.source !== id) continue
      bump(index, edge.target, edge.source, -1)
      index.edgeByAnno.delete(rid)
    }
    addEdgesOfBlock(index, known)
  }
  if (value.parent === undefined) return
  const parent = value.parent
  const pageRoot = parent === null ? id : (index.pageOf.get(parent) ?? id)
  if (known) {
    // 挪位不改 props ⇒ 名字表/成员表都不动；`blocks` 里是活引用，也无事可做
    reindexSubtreePage(index, known, pageRoot)
    return
  }
  const block = findInForest(forest, id)
  if (!block) return
  indexSubtree(index, block, pageRoot)
}

/**
 * 块 delete：**原位软删**的索引面——块还在森林里，但要从五张表里退场。
 *
 * 退场的是「可见集合」：根 ＋ 它**还没被删**的后代（本来就删了的已经不在表里）。
 * 入向边跟着源块退场（`edgeByAnno` 簿记摘旧边）——数据源 atoms 没动，
 * 但 rebuild 只数可见源块的原子，两条路必须同口径。名字表/日期表的接手者重扫
 * 森林时同样跳过被删子树（被删的块无权认领名字）。
 */
function applyBlockDelete(index: Index, id: string, forest: readonly Block[]): void {
  const block = index.blocks.get(id)
  if (!block) return
  // ⚠️ 取子树要**含被删块**：执行到这里时根已被打上标记（tx 先改内存、后修补索引），
  //    默认遍历会把整棵子树跳过去——一张都摘不掉。退场的正是「这棵子树里的全部」。
  const gone = walkSubtreeIncludingDeleted(block)
  for (const bid of gone) {
    index.blocks.delete(bid)
    index.pageOf.delete(bid)
  }
  const goneSet = new Set(gone)
  // 名字表：删掉这些块认领的名字，再让**还活着**的认领者按 rebuild 的口径接手
  const names = [...index.tags].filter(([, owner]) => goneSet.has(owner)).map(([name]) => name)
  for (const name of names) index.tags.delete(name)
  for (const name of names) {
    const heir = firstTagClaimant(forest, name)
    if (heir) index.tags.set(name, heir)
  }
  // 日期表：同上（rebuild 是先序最后一个赢 ⇒ 接手也取最后一个）
  const dates = [...index.journals].filter(([, owner]) => goneSet.has(owner)).map(([d]) => d)
  for (const d of dates) index.journals.delete(d)
  for (const d of dates) {
    const heir = lastJournalClaimant(forest, d)
    if (heir) index.journals.set(d, heir)
  }
  // 成员表：把退场的块从所有集合里摘掉
  for (const members of index.tagMembers.values()) {
    for (const bid of gone) members.delete(bid)
  }
  // 入向边：源在退场子树里的边一起摘（恢复时随子树重建）
  for (const [aid, edge] of [...index.edgeByAnno]) {
    if (!goneSet.has(edge.source)) continue
    bump(index, edge.target, edge.source, -1)
    index.edgeByAnno.delete(aid)
  }
}

/**
 * 重算一个块对**名字表**的认领：索引里记在这个块名下的先摘掉，
 * 再按活块现在的别名/露面重打（表里已有别的块认领的名字不抢——先序第一优先）。
 */
function refreshTagsClaim(index: Index, blockId: string): void {
  const live = index.blocks.get(blockId)
  if (!live) return
  for (const [name, owner] of [...index.tags]) {
    if (owner === blockId) index.tags.delete(name)
  }
  if (!hasList(live, 'tag')) return
  for (const alias of aliasesOf(live)) {
    const name = normalizeAlias(alias)
    if (name !== '' && !index.tags.has(name)) index.tags.set(name, blockId)
  }
}

/** 重算一个块对**成员表**的归属（数据源是活块上的 `_tags`） */
function refreshTagMembership(index: Index, blockId: string): void {
  const live = index.blocks.get(blockId)
  if (!live) return
  for (const members of index.tagMembers.values()) members.delete(blockId)
  for (const tagId of tagIdsOf(live)) {
    const members = index.tagMembers.get(tagId)
    if (members) members.add(blockId)
    else index.tagMembers.set(tagId, new Set([blockId]))
  }
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

/** 把一棵子树的 `pageOf` 重打到新的顶层块（挪位只影响这一件事） */
function reindexSubtreePage(index: Index, root: Block, pageRoot: string): void {
  walkForest([root], (b) => {
    index.pageOf.set(b.id, pageRoot)
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

/** 把一棵子树写进索引（与 `rebuild` 同一口径：先序；`pageRoot` ＝ 它所在的顶层块） */
function indexSubtree(index: Index, root: Block, pageRoot: string): void {
  walkForest([root], (b) => {
    index.blocks.set(b.id, b)
    index.pageOf.set(b.id, pageRoot)
    // 指向边：数据源是块内容里的引用 run（可见源块，遍历口径与块表同一条）
    addEdgesOfBlock(index, b)
    // 标签成员（数据源是块上的 `_tags`）
    for (const tagId of tagIdsOf(b)) {
      const members = index.tagMembers.get(tagId)
      if (members) members.add(b.id)
      else index.tagMembers.set(tagId, new Set([b.id]))
    }
    /**
     * 标签名表：一个标签块有多个别名时，**每一个**都是它的地址。
     * 重复时先序第一个赢（与「先序第一个命中」同一个口径，不随机覆盖）。
     */
    if (hasList(b, 'tag')) {
      for (const alias of aliasesOf(b)) {
        const name = normalizeAlias(alias)
        if (name !== '' && !index.tags.has(name)) index.tags.set(name, b.id)
      }
    }
    if (isJournal(b)) {
      const d = journalDate(b)
      if (d !== '') index.journals.set(d, b.id)
    }
  })
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
  const flat = (m: Map<string, string>): unknown => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  const counts = (m: Map<string, Map<string, number>>): unknown =>
    [...m.entries()]
      .map(([k, v]) => [k, [...v.entries()].sort((a, b) => a[0].localeCompare(b[0]))] as const)
      .sort((a, b) => a[0].localeCompare(b[0]))
  const sets = (m: Map<string, Set<string>>): unknown =>
    [...m.entries()].map(([k, v]) => [k, [...v].sort()] as const).sort((a, b) => a[0].localeCompare(b[0]))
  return JSON.stringify({
    blocks: sortedKeys(index.blocks),
    incoming: counts(index.incoming),
    tagMembers: sets(index.tagMembers),
    tags: flat(index.tags),
    journals: flat(index.journals),
    pageOf: flat(index.pageOf),
  })
}

/** 这个 id 现在是哪一块（引用解析用；与 `store.find` 同语义） */
export function lookupBlock(index: Index, id: string): Block | undefined {
  return index.blocks.get(id)
}

/** 谁引用它（`[[名]]`）—— 反链的源块清单（标签成员见 `tagMemberIdsOf`） */
export function incomingIds(index: Index, targetId: string): string[] {
  return [...(index.incoming.get(targetId)?.keys() ?? [])]
}

/** 某个源块指向目标**几次**（同一块里多处引用各算一条边） */
export function incomingCount(index: Index, targetId: string, sourceId: string): number {
  return index.incoming.get(targetId)?.get(sourceId) ?? 0
}

/** 谁打了这个标签 —— 「标签的成员列表」 */
export function tagMemberIdsOf(index: Index, tagId: string): string[] {
  return [...(index.tagMembers.get(tagId) ?? [])]
}

/** 按规范化名字找标签块 id */
export function tagIdByName(index: Index, name: string): string | undefined {
  return index.tags.get(normalizeAlias(name))
}

/* ------------------------------------------------------------ 查询 */

/**
 * **查询走索引**：`ref`／`tag`／`journal` 三类条件查表（O(1)），其余谓词仍是逐块判定。
 *
 * 为什么不是「查询全在索引里」：索引是五张**派生表**，不记树的形状（`pageOf` 只到顶层、
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
  opts: { anchorId?: string } = {},
): QueryHit[] {
  const env: QueryEnv = {
    refs: refsByIndex(spec.where, index),
    tags: tagsByIndex(spec.where, index),
    journalDate: firstJournal(spec.where),
  }
  let roots: readonly Block[] = forest
  if (spec.scope !== 'all' && opts.anchorId) {
    const anchor = index.blocks.get(opts.anchorId)
    if (anchor) roots = [anchor]
  }
  if (env.journalDate) {
    const dayId = index.journals.get(env.journalDate)
    roots = dayId ? (index.blocks.get(dayId)?.children ?? []) : []
  }
  /**
   * 成员条件的白拿：**日期表就是这条条件的候选集**（一天一个、O(天数)），不用全库逐块判定。
   * 仅限 where 顶层就是 `{ role: 'journal' }` 本身、且没有范围条件与锚点时——
   * 嵌进组合里的 role 是普通谓词，收窄会把其它分支的候选丢掉。
   * 与纯函数路径（走 `journalDays`）的等式由测试钉住。
   */
  if (isExactRoleJournal(spec.where) && !env.journalDate && roots === forest) {
    roots = [...index.journals.values()]
      .map((id) => index.blocks.get(id))
      .filter((b): b is Block => b !== undefined)
  }
  return evaluateQuery(spec, roots, env)
}

/** `ref` 条件的目标块集合 —— 查**入向边表**，不再扫 atoms */
function refsByIndex(node: QueryNode, index: Index): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('ref' in n) for (const id of incomingIds(index, n.ref)) out.add(id)
  }
  visit(node)
  return out
}

/** `tag` 条件的目标块集合 —— 名字表解析成标签块，再查**成员表** */
function tagsByIndex(node: QueryNode, index: Index): Set<string> {
  const out = new Set<string>()
  const visit = (n: QueryNode): void => {
    if ('all' in n) n.all.forEach(visit)
    else if ('any' in n) n.any.forEach(visit)
    else if ('not' in n) visit(n.not)
    else if ('tag' in n) {
      const tagId = tagIdByName(index, n.tag)
      if (tagId) for (const id of tagMemberIdsOf(index, tagId)) out.add(id)
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
