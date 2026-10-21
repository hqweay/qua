/**
 * **索引**（IndexPort）：把「谁指向谁」这类问题从「每次全库扫一遍」变成「查表」。
 *
 * 判据（派生层不物化）：索引**不是真相源**，是可从「块森林 ＋ 原子」重建的派生视图。
 *   ⇒ `rebuild(source)` 与「一路增量累积」必须得到**同一份**索引（`fingerprint` 逐字节相等）。
 *   这条等式就是本文件的验收标准 —— 它挡住的正是那种「增量更新漏了一种失效点、
 *   但界面上看起来只是偶尔少一条」的静默错误。
 *
 * ⚠️ 索引里存的是**块的活引用**，不是拷贝：块是可变的（`loc.block.text = …`），
 *    所以索引一旦可能过期就必须**整体重建**，不能拿着旧条目修补（那会得到两份分叉的真相）。
 * ⚠️ 本文件零 DOM、零持久化：它只吃「森林 ＋ 原子」，所以能直接单测。
 */
import type { Atom } from './annotations.ts'
import { hasRole, type Block } from './model.ts'
import { addressOf } from './alias.ts'
import { journalDate, isJournal } from './journal.ts'
import { normalizeTag, TAG_ROLE } from './tags.ts'
import type { Change } from './storage/port.ts'

/**
 * 一份索引。五张表各答一类问题，**全是派生**：
 *
 * | 表 | 答什么 | 谁在用 |
 * |---|---|---|
 * | `blocks` | 这个 id 现在是哪一块、叫什么 | 引用解析（`resolveRef`） |
 * | `incoming` | 谁指向它、指向了几次（引用 ＋ 标签都算） | 反链 |
 * | `tagMembers` | 谁打了这个标签（**只有 tag 边**，同块多次只算一次） | 标签成员 |
 * | `tags` / `journals` | 按名字/日期找块 | 标签解析、日记条件 |
 * | `pageOf` | 这块住哪一页 | 反链按来源页聚合 |
 */
export interface Index {
  /** 块 id → 块（**活引用**） */
  blocks: Map<string, Block>
  /**
   * 入向边：targetId → (源块 id → **边数**)。
   *
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
   */
  tagMembers: Map<string, Set<string>>
  /** 规范化标签名 → 标签块 id */
  tags: Map<string, string>
  /** 日期（`YYYY-MM-DD`）→ journal 块 id */
  journals: Map<string, string>
  /** 块 id → 它所在的**顶层块** id（含自己）—— 反链按来源页聚合要用 */
  pageOf: Map<string, string>
}

function emptyIndex(): Index {
  return {
    blocks: new Map(),
    incoming: new Map(),
    tagMembers: new Map(),
    tags: new Map(),
    journals: new Map(),
    pageOf: new Map(),
  }
}

/* ------------------------------------------------------------ 构建 */

/**
 * **从源头重建**（全量）。这是唯一的正确性基准：
 * 任何增量路径的结果都必须与它逐字节一致。
 */
export function rebuild(forest: readonly Block[], atoms: readonly Atom[]): Index {
  const idx = emptyIndex()

  // ① 块表 / 标签表 / 日记表 / 父页表（一次先序遍历；与增量修补同一口径）
  for (const b of forest) indexSubtree(idx, b)

  // ② 指向边（引用与标签都算）
  addEdges(idx, atoms)

  return idx
}

/** 把原子的指向边累加进 `incoming` / `tagMembers` */
function addEdges(idx: Index, atoms: readonly Atom[]): void {
  for (const a of atoms) {
    const target = a.target?.id
    if (!target) continue
    if (a.kind !== 'page' && a.kind !== 'tag') continue
    const perSource = idx.incoming.get(target)
    if (perSource) perSource.set(a.blockId, (perSource.get(a.blockId) ?? 0) + 1)
    else idx.incoming.set(target, new Map([[a.blockId, 1]]))
    if (a.kind === 'tag') {
      const members = idx.tagMembers.get(target)
      if (members) members.add(a.blockId)
      else idx.tagMembers.set(target, new Set([a.blockId]))
    }
  }
}

/**
 * **增量应用**（`Change[]`）。
 *
 * ⚠️ **块一类只要出现就一律全量重建**，不管报的是 `'*'` 还是具体 id。
 *
 * 为什么不做「按块修补」：修补的正确性依赖一个前提——**先摘掉旧条目、再改森林**。
 * 现在的调用链却正好相反（编辑器 `emitChange`、命令直接改块，都是「先改了再通知」），
 * 通知到达时**旧名字／旧位置已经读不到了** ⇒ 无法可靠地摘掉旧条目。
 * 实测代价就是「一个标签两个名字」：把 `t1` 从 `todo` 改成 `待办` 后，
 * `tags` 里同时留下 `todo` 和 `待办` 指向同一块 —— 索引不崩，只是**静默地错**。
 *
 * ⇒ 在 **Tx/Changes 落地之前**宁可全量重建。等真正的事务层把「改了什么」
 *   连同 `op` 一起报出来，这里再换成按块修补，**对外形状不变**
 *   （`Change` 已经预留了精确到 id 的语义）。
 *
 * 只有**原子**变化时才是真增量：块表／名字表／日记表／父页表完全不动，只重算两张边表。
 */
export function applyChanges(
  index: Index,
  changes: readonly Change[],
  forest: readonly Block[],
  atoms: readonly Atom[],
): Index {
  const kinds = new Set(changes.map((c) => c.kind))
  // `marks` 不进索引（区间锚点不参与「谁指向谁」）
  if (kinds.size === 0 || (kinds.size === 1 && kinds.has('marks'))) return index
  // 块动过 ⇒ 一切作废（见上面的「为什么不按块修补」）
  if (kinds.has('blocks')) return rebuild(forest, atoms)

  // 只剩原子变化：块表／名字表／日记表／父页表完全不动，只重算两张边表
  const next: Index = {
    blocks: index.blocks,
    incoming: new Map(),
    tagMembers: new Map(),
    tags: index.tags,
    journals: index.journals,
    pageOf: index.pageOf,
  }
  addEdges(next, atoms)
  return next
}

/** 把一棵子树写进索引（与 `rebuild` 的 `walk` 同一口径） */
function indexSubtree(index: Index, root: Block): void {
  const walk = (b: Block, rootId: string): void => {
    index.blocks.set(b.id, b)
    index.pageOf.set(b.id, rootId)
    if (hasRole(b, TAG_ROLE)) {
      const name = addressOf(b)
      if (name !== '' && !index.tags.has(name)) index.tags.set(name, b.id)
    }
    if (isJournal(b)) {
      const d = journalDate(b)
      if (d !== '') index.journals.set(d, b.id)
    }
    for (const c of b.children) walk(c, rootId)
  }
  walk(root, root.id)
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

/** 谁指向它（引用 ＋ 标签）—— 反链的源块清单 */
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
  return index.tags.get(normalizeTag(name))
}

/** 某天的 journal 块 id */
export function journalIdByDate(index: Index, date: string): string | undefined {
  return index.journals.get(date)
}
