/**
 * **`BlockIndex` 的增量维护**：一次 op 批 → 「这一批让位置行变成什么」。
 *
 * ## 它回答的问题
 *
 * 重建（`derivedRowsOf`）能把整片森林铺成派生行；这里做同一件事的增量版：
 * 插入／移动／软删／恢复／清除之后，把**受影响的那几片**行改对，不碰别处。
 * 判据与关系行同一条：增量维护后的表必须与「用当前森林整份重建」逐行同解
 * （按先序／深度／root／hidden 比，不比原始段值——中点插入本来就不该与重建逐字节相同）。
 *
 * ## 为什么一半答案在库里
 *
 * 结构写能发生的前提是那一块已装载（它是用户眼前的东西），但**兄弟的存量段值**
 * 只在库里：重建时刻按兄弟下标铺的段，后来的中点插入又改过它；渲染器手里的 rank
 * 是这次会话装载时现算的另一串数。中点必须夹在**存量的**左右邻居之间，否则两个
 * 兄弟会拿到同一个段（顺序错而不报错）。⇒ 读面三条（`IndexReads`）：
 *
 *   · `byBlock`：被移子树的旧前缀、父块的路径前缀／root／hidden、前兄弟的存量段；
 *   · `following`：落点的**库后继**——顶层根在工作集里只装了一部分，内存里看不见它
 *     后面还有谁，而新块恰恰落在「内存前一个根」的右边；
 *   · `children`：中点夹不出来（段耗尽／同一层多笔落点）时整层重铺，要这一层的旧前缀。
 *
 * ## 为什么「改行」与「改片」是两种写法
 *
 * 新块的行渲染器认识（刚在内存里造出来），按 id 逐行写；而被移／被删／被恢复的子树
 * 里可能有**未装载的子孙**——它们的行只能按前缀交给主进程的 SQL（`DerivedPlan`）。
 * 两种写法在同一批里合成一个事务：内容行 → 新行 → 计划。
 *
 * ## 与内存 `Index` 的关系
 *
 * 不另算一棵树：受影响子树的**内部**段值用内存 rank（`Index.order`，它已按兄弟序维护），
 * 只有「子树根落在库里哪个位置」要问库。这条分工让增量与重建同解：内部用同一套有序性
 * 判据，边界用库里的存量段。
 */
import type { Op } from '../kb/types.ts'
import type { Index } from '../infra/index-port.ts'
import { isDeleted } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import { ORDER_STEP, rankBetween } from '../infra/order.ts'
import type { RowWrite } from './db-rows.ts'
import type { DerivedPlan } from './derived-plans.ts'
import type { LibraryClient } from './library-client.ts'
import { lastSegmentRank, pathSegmentOf, type BlockIndexRow } from './derived-rows.ts'

/** 增量维护要问库的三件事（桌面宿主实现；web 没有派生表，不接这条钩子） */
export interface IndexReads {
  byBlock(ids: readonly string[]): Promise<Map<string, BlockIndexRow>>
  following(parent: string | null, prev: string | null): Promise<BlockIndexRow | null>
  children(parent: string | null): Promise<BlockIndexRow[]>
}

/**
 * 把 `LibraryClient` 上的三条具名读接成 `IndexReads`。
 *
 * 缺任何一条就整体不接（`null`）：web 单库没有派生表，它的「派生答案」就是内存索引本身。
 * 读失败**抛出**——调用方（store 的钩子）负责「内容照常落盘、这一笔位置行跳过」，
 * 这里不把失败解释成「没有行」（那会让增量维护静默停摆）。
 */
export function indexReadsOf(client: LibraryClient): IndexReads | null {
  const { indexRows, indexFollowing, indexChildren } = client
  if (!indexRows || !indexFollowing || !indexChildren) return null
  const why = (r: { status: string; error?: string }): string =>
    `${r.status === 'error' ? r.error : r.status}`
  return {
    async byBlock(ids) {
      const r = await indexRows.call(client, ids)
      if (r.status !== 'ok') throw new Error(`library/index-rows: ${why(r)}`)
      return new Map(r.value.map((row) => [row.block, row] as const))
    },
    async following(parent, prev) {
      const r = await indexFollowing.call(client, parent, prev)
      if (r.status !== 'ok') throw new Error(`library/index-following: ${why(r)}`)
      return r.value
    },
    async children(parent) {
      const r = await indexChildren.call(client, parent)
      if (r.status !== 'ok') throw new Error(`library/index-children: ${why(r)}`)
      return r.value
    },
  }
}

/** 一批派生位置写：行（新块）＋ 片（前缀改写／清除／hidden 重算） */
export interface IndexWriteBatch {
  writes: RowWrite[]
  plans: DerivedPlan[]
}

const EMPTY: IndexWriteBatch = { writes: [], plans: [] }

/** 一次落点（`block.upsert` 带 `parent`） */
interface Placement {
  parent: string | null
  prev: string | null
}

/**
 * 这次 op 批让哪些位置行变了。
 *
 * 只有两类 op 会动 `BlockIndex`：位置（`block.upsert` 带 `parent`）与存在
 * （`block.exist`）。正文／属性／anno 与这两列无关 —— 一批纯打字**一次库都不读**。
 */
export async function indexWritesOf(
  index: Index,
  ops: readonly Op[],
  reads: IndexReads,
): Promise<IndexWriteBatch> {
  const placements = new Map<string, Placement>()
  const exists: { id: string; state: 'deleted' | 'present' | 'purged' }[] = []
  for (const op of ops) {
    if (op.e !== 'block') continue
    if (op.op === 'upsert' && op.value.parent !== undefined) {
      placements.set(op.id, { parent: op.value.parent, prev: op.value.prev ?? null })
    } else if (op.op === 'exist') {
      exists.push({ id: op.id, state: op.state })
    }
  }
  // 「建了又清除」：块行也会被删，位置行没有可写的（清除计划按前缀删整片）
  for (const e of exists) if (e.state === 'purged') placements.delete(e.id)
  if (placements.size === 0 && exists.length === 0) return EMPTY

  const parentOf = (id: string): string | null | undefined => index.parentOfAll.get(id)

  /** 祖先链是否**完整**（一路走到森林顶层）：root／路径前缀都要求它，缺一段就不写 */
  const chainLoaded = (id: string): boolean => {
    let cur = parentOf(id)
    while (cur !== undefined && cur !== null) {
      if (!index.all.has(cur)) return false
      cur = parentOf(cur)
    }
    return cur === null
  }

  /** 这一批里祖上也动过 ⇒ 跟着祖先的计划走，不单独算（同一批先移父后在新位置建子块） */
  const coveredByAncestor = (id: string, marks: ReadonlySet<string>): boolean => {
    for (let cur = parentOf(id); cur !== undefined && cur !== null; cur = parentOf(cur)) {
      if (marks.has(cur)) return true
    }
    return false
  }

  const placedIds = new Set(placements.keys())
  const roots: string[] = []
  for (const id of placedIds) {
    if (coveredByAncestor(id, placedIds)) continue
    if (!index.all.has(id) || !chainLoaded(id)) continue
    roots.push(id)
  }

  const byParent = new Map<string | null, string[]>()
  for (const id of roots) {
    const parent = placements.get(id)!.parent
    const list = byParent.get(parent)
    if (list) list.push(id)
    else byParent.set(parent, [id])
  }

  /* ------------------------------------------------------------------ 读 */

  const want = new Set<string>()
  for (const id of roots) want.add(id)
  for (const pl of placements.values()) {
    if (pl.parent !== null) want.add(pl.parent)
    if (pl.prev !== null) want.add(pl.prev)
  }
  const existIds = new Set(exists.map((e) => e.id))
  for (const e of exists) {
    want.add(e.id)
    const parent = parentOf(e.id)
    if (typeof parent === 'string') want.add(parent)
  }
  const rows: Map<string, BlockIndexRow> = want.size > 0 ? await reads.byBlock([...want]) : new Map()

  /* ------------------------------------------------------------------ 写 */

  const batch: IndexWriteBatch = { writes: [], plans: [] }
  /** 这一批里算出了新前缀的子树根（子块的父前缀取它，而不是库里的旧值） */
  const newPath = new Map<string, string>()
  const newHidden = new Map<string, boolean>()
  const newRoot = new Map<string, string>()

  const prefixOf = (parent: string): string | undefined => newPath.get(parent) ?? rows.get(parent)?.path

  const rootOf = (parent: string | null): string | undefined => {
    if (parent === null) return undefined
    return newRoot.get(parent) ?? rows.get(parent)?.root
  }

  const hiddenAboveOf = (parent: string | null): boolean => {
    if (parent === null) return false
    const fresh = newHidden.get(parent)
    return fresh !== undefined ? fresh : rows.get(parent)?.hidden === 1
  }

  /** 子树内部一层层的段值：内存 rank 是整数就用它，否则按兄弟下标铺（与重建同解） */
  const childRank = (at: number, id: string): number => {
    const rank = index.order.get(id)
    return rank !== undefined && Number.isInteger(rank) ? rank : (at + 1) * ORDER_STEP
  }

  /** **新子树**：块是这一批造的，行由渲染器逐行写（库里还没有它的位置） */
  const emitNewSubtree = (rootId: string, rootPath: string, parent: string | null): void => {
    const root = index.all.get(rootId)
    if (!root) return
    const rootColumn = parent === null ? rootId : (rootOf(parent) ?? rootId)
    const above = hiddenAboveOf(parent)
    const pathOf = new Map<string, string>()
    const hiddenOf = new Map<string, boolean>()
    walkForest(
      [root],
      (b, ctx) => {
        const path =
          ctx.parent === null
            ? rootPath
            : `${pathOf.get(ctx.parent.id)!}${pathSegmentOf(childRank(ctx.index, b.id))}`
        const hidden = (ctx.parent === null ? above : hiddenOf.get(ctx.parent.id) === true) || isDeleted(b)
        pathOf.set(b.id, path)
        hiddenOf.set(b.id, hidden)
        batch.writes.push({
          table: 'BlockIndex',
          op: 'upsert',
          key: { block: b.id },
          values: { root: rootColumn, path, hidden: hidden ? 1 : null },
        })
      },
      { includeDeleted: true },
    )
    newHidden.set(rootId, hiddenOf.get(rootId) === true)
    newRoot.set(rootId, rootColumn)
  }

  /**
   * 一个子树根落到 `path`：新块写行，已有的按旧前缀整片改写。
   *
   * `hidden` 只在「祖先链的可见性变了」（移进被删子树，或它自己本来 hidden）时重算：
   * 两边都可见的普通移动不动 `hidden`，省掉一趟 O(子树) 的更新。
   */
  const emitPlacement = (id: string, path: string): void => {
    const pl = placements.get(id)!
    newPath.set(id, path)
    newRoot.set(id, pl.parent === null ? id : (rootOf(pl.parent) ?? id))
    const old = rows.get(id)
    if (!old) {
      emitNewSubtree(id, path, pl.parent)
      return
    }
    batch.plans.push({ p: 'reindexSubtree', oldPrefix: old.path, newPrefix: path, parent: pl.parent, block: id })
    const above = hiddenAboveOf(pl.parent)
    newHidden.set(id, above)
    if (above || old.hidden === 1) batch.plans.push({ p: 'recomputeHidden', block: id, hiddenAbove: above ? 1 : 0 })
  }

  /**
   * **整层段的分配**：`order` 是最终兄弟序；`stored` 是没动的兄弟的存量段。
   *
   * 动过的块掩在存量段之间，按「等距整数」分（`gap > k` 必有空位）。空位不够或新段与
   * **动过的兄弟的旧段**重合（另一笔计划按旧前缀改写时会顺手改到刚写进去的行）⇒ 返回
   * `null`，调用方换 `freshSegments`。
   */
  const spreadSegments = (
    order: readonly string[],
    stored: ReadonlyMap<string, number>,
    banned: ReadonlySet<number>,
  ): Map<string, number> | null => {
    const out = new Map(stored)
    let prev: number | undefined
    let i = 0
    while (i < order.length) {
      const known = stored.get(order[i]!)
      if (known !== undefined) {
        if (prev !== undefined && known <= prev) return null
        prev = known
        i++
        continue
      }
      let j = i
      while (j < order.length && stored.get(order[j]!) === undefined) j++
      const k = j - i
      const next = j < order.length ? stored.get(order[j]!) : undefined
      const ranks: number[] = []
      if (prev === undefined && next === undefined) {
        for (let t = 0; t < k; t++) ranks.push((t + 1) * ORDER_STEP)
      } else if (prev === undefined) {
        for (let t = 0; t < k; t++) ranks.push(next! - (k - t) * ORDER_STEP)
      } else if (next === undefined) {
        for (let t = 0; t < k; t++) ranks.push(prev + (t + 1) * ORDER_STEP)
      } else {
        const gap = next - prev
        if (gap <= k) return null
        for (let t = 0; t < k; t++) ranks.push(prev + Math.floor(((t + 1) * gap) / (k + 1)))
      }
      if (ranks.some((r) => banned.has(r))) return null
      for (let t = 0; t < k; t++) out.set(order[i + t]!, ranks[t]!)
      prev = ranks[k - 1]!
      i = j
    }
    return out
  }

  /**
   * 整层重铺的段值：**全部落在这一层现存最大值之上**。
   *
   * 不重铺成 `(i+1)*步长`：那会和「动过的兄弟的旧段」撞号（换位时必然撞——A 的新段
   * 正是 B 的旧段），两笔前缀改写就会互相改到对方刚写的行。铺在最大值之上，
   * 新段与任何旧段都不重合，计划的顺序就无关紧要。段值仍然是严格递增的，
   * 先序不受影响。
   */
  const freshSegments = (order: readonly string[], ranks: Iterable<number>): Map<string, number> => {
    let max = 0
    for (const r of ranks) if (Number.isFinite(r) && r > max) max = r
    const start = max + ORDER_STEP
    return new Map(order.map((id, at) => [id, start + at * ORDER_STEP] as const))
  }

  /**
   * 同一父块下**多笔落点**（撤销批量移动、批量粘贴）或中点夹不出来（段耗尽）：整层重铺。
   *
   * 最终兄弟序从库里的层（按 path）出发，把动过的块按 `prev` 链插进去 —— 不读内存的
   * 兄弟序：顶层只装了一部分根，内存序与库里的层不是同一份事实。
   */
  const resolveLevel = async (parent: string | null, ids: readonly string[], prefix: string): Promise<void> => {
    const level = await reads.children(parent)
    const moved = new Set(ids)
    /**
     * 这一批里**位置动过的全部块**：在这一层里出现、但要搬去别处的块不能当成「没动过」——
     * 它自己有一笔落点计划，这里再按本层重铺一次就会把它写到错的位置（两笔计划抢同一个旧前缀）。
     */
    const leaving = (r: BlockIndexRow): boolean => moved.has(r.block) || placedIds.has(r.block)
    const groups = new Map<string | null, string[]>()
    for (const id of ids) {
      const prev = placements.get(id)!.prev
      const list = groups.get(prev)
      if (list) list.push(id)
      else groups.set(prev, [id])
    }
    const order: string[] = []
    const emitAfter = (anchor: string | null): void => {
      for (const id of groups.get(anchor) ?? []) {
        order.push(id)
        emitAfter(id)
      }
    }
    emitAfter(null)
    for (const r of level) {
      if (leaving(r)) continue
      order.push(r.block)
      emitAfter(r.block)
    }
    for (const id of ids) if (!order.includes(id)) order.push(id)

    const byId = new Map(level.map((r) => [r.block, r] as const))
    const stored = new Map<string, number>()
    const oldRanks: number[] = []
    let clean = true
    for (const r of level) {
      const rank = lastSegmentRank(r.path)
      if (!Number.isFinite(rank)) {
        clean = false
        continue
      }
      oldRanks.push(rank)
      if (!leaving(r)) stored.set(r.block, rank)
    }
    const banned = new Set<number>()
    for (const id of ids) {
      const old = rows.get(id) ?? byId.get(id)
      const rank = old === undefined ? Number.NaN : lastSegmentRank(old.path)
      if (Number.isFinite(rank)) banned.add(rank)
      else clean = false
    }
    const spread = clean ? spreadSegments(order, stored, banned) : null
    const segments = spread ?? freshSegments(order, [...oldRanks, ...banned])
    for (const id of order) {
      const path = prefix + pathSegmentOf(segments.get(id)!)
      if (moved.has(id)) {
        emitPlacement(id, path)
        continue
      }
      const old = byId.get(id)!
      if (path === old.path) continue
      // 没动过的兄弟只换段值：前缀整片改，root/hidden 不变
      newPath.set(id, path)
      batch.plans.push({ p: 'reindexSubtree', oldPrefix: old.path, newPrefix: path, parent, block: id })
    }
  }

  /** 一笔落点：夹在「存量前兄弟」与「存量后继」之间 */
  const resolveOne = async (id: string, prefix: string, pl: Placement): Promise<void> => {
    // 前兄弟在库里没有行（只可能是库与模型分叉）：交给整层判定，别拿 NaN 去夹中点
    if (pl.prev !== null && !rows.has(pl.prev)) {
      await resolveLevel(pl.parent, [id], prefix)
      return
    }
    const next = await reads.following(pl.parent, pl.prev)
    const prevRank = pl.prev === null ? undefined : lastSegmentRank(rows.get(pl.prev)!.path)
    const nextRank = next === null ? undefined : lastSegmentRank(next.path)
    const rank = rankBetween(prevRank, nextRank)
    if (rank !== undefined && Number.isInteger(rank)) {
      emitPlacement(id, prefix + pathSegmentOf(rank))
      return
    }
    await resolveLevel(pl.parent, [id], prefix)
  }

  const pending = new Set(roots)
  while (pending.size > 0) {
    let progressed = false
    for (const id of [...pending]) {
      if (!pending.has(id)) continue
      const pl = placements.get(id)!
      const prefix = pl.parent === null ? '/' : prefixOf(pl.parent)
      if (prefix === undefined) continue // 父块这一批也被移：下一轮它的新前缀就有了
      // 同一父块下这一批的多笔落点是一次整层判定（中点会互相踩）
      const group = (byParent.get(pl.parent) ?? [id]).filter((x) => pending.has(x))
      for (const x of group) pending.delete(x)
      progressed = true
      if (group.length > 1) await resolveLevel(pl.parent, group, prefix)
      else await resolveOne(id, prefix, pl)
    }
    // 父链在库里和这一批里都断着：宁可不动，也不写一份算错的行
    if (!progressed) break
  }

  /* ---------------------------------------------------------------- 存在 */

  for (const e of exists) {
    if (coveredByAncestor(e.id, existIds)) continue
    const old = rows.get(e.id)
    if (!old) continue
    if (e.state === 'purged') {
      batch.plans.push({ p: 'dropSubtree', prefix: old.path })
      continue
    }
    const parent = parentOf(e.id)
    batch.plans.push({
      p: 'recomputeHidden',
      block: e.id,
      hiddenAbove: hiddenAboveOf(typeof parent === 'string' ? parent : null) ? 1 : 0,
    })
  }

  if (batch.writes.length === 0 && batch.plans.length === 0) return EMPTY
  return batch
}
