/**
 * **工作集的行缓存与合并**：把 `doc`／`loadBlocks` 读回来的行装进唯一一份
 * `BlockStore`，并保证**已加载块的对象身份不变**。
 *
 * ## 为什么行缓存留在这里，而不是每次从库里重读
 *
 * 部分装载下会反复打开同一批块（今日窗口、引用目标、标签/定义）。每次重读会把
 * 同一块变成第二个对象（I3），也会把本地还没落盘的编辑覆盖回旧行。行缓存让
 * 「这次要装哪些块」只决定**新增**谁；已在工作集里的块仍用原对象。
 *
 * ## 合并规则
 *
 * - **已加载的 id 不换对象、不改内容**：本地编辑（op 写入）永远比缓存行新；
 *   只有新 id 才建对象。
 * - **新块按 `parent`／`left` 接进已加载的父块**：`left` 由 `rowsToWorkspace` 的
 *   兄弟链投影给出；找不到前兄弟（未加载）就落在最前。顺序只在「已加载的兄弟之间」
 *   有保证——这不是新约束，部分装载下本来就没有完整的兄弟表。
 * - **已加载块若在新行里换了父**（例如先作为顶层根加载、后来父块也被装载）：
 *   从旧位置摘下来再接过去。反过来（本地刚移动过、缓存行还是旧父）不会发生：
 *   本地移动会改 `children`，而行缓存只在装载时写。
 *
 * ## 边界
 *
 * 不变量：`store.blocks` 与 `store.isLoaded` 只经 `setWorkset` 一起更新。
 * 本文件不做淘汰决策（预算与 pin 判据在 `BlockStore.trimWorkset`），只在淘汰后
 * 把被淘汰块的行一起丢掉，防止下一次装载把它们又算进来。
 */
import type { Op } from '../kb/types.ts'
import type { Block } from '../model/model.ts'
import { isDeleted } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import type { BlockStore } from '../model/store.ts'
import { rowsToWorkspace, type RawLibraryRows, type RowWrite } from './db-rows.ts'
import { derivedPruneWrites, type BlockRelationRow } from './derived-rows.ts'
import { relationEdgesOfBlock } from '../relations/relations.ts'

type Row = Record<string, unknown>

function emptyRows(): RawLibraryRows {
  return { blocks: [], props: [], aliases: [], lists: [], meta: {} }
}

function idOf(row: Row): string {
  const id = row.id
  return typeof id === 'string' ? id : ''
}

function blockIdOf(row: Row): string {
  const id = row.block
  return typeof id === 'string' ? id : ''
}

export class Workset {
  private readonly store: BlockStore
  private rows: RawLibraryRows = emptyRows()
  /** 与 `store.isLoaded` 同步的一份 id 集合（淘汰后按它裁行缓存） */
  private ids = new Set<string>()
  /**
   * **祖先链完整的块**（`from_root`／`hidden` 这类派生格的正确性前提）。
   * Doc 装载（子树＋祖先链）与显式 `complete` 的装载都进这一份；普通按 id 的
   * 预取（引用目标）不进——它的父链还在库里。派生关系行只重铺完整链上的源块。
   */
  private complete = new Set<string>()

  constructor(store: BlockStore) {
    this.store = store
  }

  isComplete(id: string): boolean {
    return this.complete.has(id)
  }

  /** 完整链集合的快照（测试/诊断用；派生行写读它） */
  completeIds(): ReadonlySet<string> {
    return this.complete
  }

  get size(): number {
    return this.ids.size
  }

  isLoaded(id: string): boolean {
    return this.ids.has(id)
  }

  /**
   * 装一个 Doc：子树行 ＋ 祖先链行（调用方把祖先并进同一个 `RawLibraryRows`）。
   *
   * @returns `rootIds` 对应的活块（按传入顺序；未装载的 id 跳过）
   */
  loadDoc(rows: RawLibraryRows, rootIds: readonly string[]): Block[] {
    this.mergeRows(rows)
    this.apply()
    // Doc 行自带完整祖先链：这一批的块从此都可算 from_root
    for (const r of rows.blocks) this.complete.add(idOf(r))
    const out: Block[] = []
    for (const id of rootIds) {
      const b = this.store.find(id)
      if (b) out.push(b)
    }
    return out
  }

  /**
   * 装一批不带子树的块（引用目标、标签、字段定义……）。
   *
   * `complete` ＝ 这批行**自带完整祖先链**（`tree` 读、全局身份块）⇒ 装完即可算
   * from_root/hidden。普通按 id 预取不给：父链还在库里，派生格先不算。
   */
  loadBlocks(rows: RawLibraryRows, complete = false): void {
    if (rows.blocks.length === 0) return
    this.mergeRows(rows)
    this.apply()
    if (complete) for (const r of rows.blocks) this.complete.add(idOf(r))
  }

  /** 钉住这些块（与 `BlockStore.pin` 同一份判据） */
  pin(ids: Iterable<string>): void {
    this.store.pin(ids)
  }

  /** 按预算淘汰，并把被淘汰块的行从缓存里裁掉 */
  trim(budget: number): number {
    const evicted = this.store.trimWorkset(budget)
    if (evicted === 0) return 0
    const keep = new Set<string>()
    for (const id of this.ids) if (this.store.isLoaded(id)) keep.add(id)
    this.ids = keep
    this.rows = {
      ...this.rows,
      blocks: this.rows.blocks.filter((r) => keep.has(idOf(r))),
      props: this.rows.props.filter((r) => keep.has(blockIdOf(r))),
      aliases: this.rows.aliases.filter((r) => keep.has(blockIdOf(r))),
      lists: this.rows.lists.filter((r) => keep.has(blockIdOf(r))),
    }
    return evicted
  }

  /** 已加载 id 的快照（诊断/探针用） */
  loadedIds(): ReadonlySet<string> {
    return new Set(this.ids)
  }

  /** 这次 op 批的派生关系行写（只重铺祖先链完整的源块，见 `relationWritesOf`） */
  relationWritesFor(ops: readonly Op[]): RowWrite[] {
    return relationWritesOf(this.store, this.complete, ops)
  }

  /* ------------------------------------------------------------ 内部 */

  private mergeRows(incoming: RawLibraryRows): void {
    const blockById = new Map<string, Row>()
    for (const r of this.rows.blocks) {
      const id = idOf(r)
      if (id !== '') blockById.set(id, r)
    }
    for (const r of incoming.blocks) {
      const id = idOf(r)
      if (id !== '') blockById.set(id, r)
    }
    this.rows = {
      blocks: [...blockById.values()],
      props: mergeGrouped(this.rows.props, incoming.props),
      aliases: mergeGrouped(this.rows.aliases, incoming.aliases),
      lists: mergeGrouped(this.rows.lists, incoming.lists),
      meta: { ...this.rows.meta, ...incoming.meta },
    }
    for (const id of blockById.keys()) this.ids.add(id)
  }

  /**
   * 把累计行投影成一片部分森林，再**只接新增的块**。
   *
   * `rowsToWorkspace` 对整份累计行跑一遍：它给出的树让新块知道自己该挂在谁下面、
   * 排在前兄弟之后；已经加载的块只借它的 `children` 关系，不拿它的内容覆盖对象。
   */
  private apply(): void {
    const fresh = rowsToWorkspace(this.rows)
    const freshInfo = new Map<string, { block: Block; parent: Block | null }>()
    walkForest(
      fresh.blocks,
      (b, ctx) => {
        freshInfo.set(b.id, { block: b, parent: ctx.parent })
      },
      { includeDeleted: true },
    )
    const existingInfo = new Map<string, { block: Block; parent: Block | null }>()
    walkForest(
      this.store.blocks,
      (b, ctx) => {
        existingInfo.set(b.id, { block: b, parent: ctx.parent })
      },
      { includeDeleted: true },
    )

    // 1) 老对象优先：同一个 id 只有一个对象
    const mapped = new Map<string, Block>()
    for (const [id, info] of freshInfo) mapped.set(id, existingInfo.get(id)?.block ?? info.block)

    // 2) 已加载块在新树里换了位置（根 ↔ 子、换了父）：先摘旧位置
    for (const [id, info] of freshInfo) {
      const existing = existingInfo.get(id)
      if (!existing) continue
      if ((existing.parent?.id ?? null) === (info.parent?.id ?? null)) continue
      detach(this.store, existing.block, existing.parent)
    }

    // 3) 新父块：children 直接取新树（全部是新对象或已映射的老对象）
    for (const [id, info] of freshInfo) {
      if (existingInfo.has(id)) continue
      const target = mapped.get(id)!
      target.children.splice(0, target.children.length, ...info.block.children.map((c: Block) => mapped.get(c.id)!))
    }

    // 4) 老父块：只补缺的孩子，按新树里的兄弟序插到最近的前兄弟之后
    for (const [id, info] of freshInfo) {
      if (!existingInfo.has(id)) continue
      const target = mapped.get(id)!
      const kids = info.block.children.map((c: Block) => mapped.get(c.id)!)
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]!
        if (target.children.includes(kid)) continue
        insertOrdered(target.children, kid, kids, i)
      }
    }

    // 5) 顶层按新树顺序排；本地多出来的根（同一次会话里新建、还没落到行缓存）保留在末尾
    const roots = fresh.blocks.map((b) => mapped.get(b.id)!)
    for (const r of roots) if (!this.store.blocks.includes(r)) this.store.blocks.push(r)
    const extra = this.store.blocks.filter((b) => !roots.includes(b))
    this.store.blocks.splice(0, this.store.blocks.length, ...roots, ...extra)

    /**
     * 已加载集合以**模型里实际存在的对象**为准，不以行缓存为准：
     * 同一会话里新建、还没落盘成行的块也在内存里，`find` 找得到就必须算已加载。
     * 行缓存只决定「下次装载能重建谁」，不反向否定内存里的对象。
     */
    const present = new Set<string>()
    walkForest(
      this.store.blocks,
      (b) => {
        present.add(b.id)
      },
      { includeDeleted: true },
    )
    this.ids = present
    this.store.setWorkset(this.store.blocks, this.ids)
  }
}

/** 同组行（props／aliases／lists）按 block 整组替换：新读面给的是这块的当前全集 */
function mergeGrouped(current: readonly Row[], incoming: readonly Row[]): Row[] {
  if (incoming.length === 0) return [...current]
  const touched = new Set<string>()
  for (const r of incoming) touched.add(blockIdOf(r))
  return [...current.filter((r) => !touched.has(blockIdOf(r))), ...incoming]
}

/** 从旧位置摘下来（根或父的 children）；找不到就什么都不做 */
function detach(store: BlockStore, block: Block, parent: Block | null): void {
  if (parent) {
    const at = parent.children.indexOf(block)
    if (at >= 0) parent.children.splice(at, 1)
    return
  }
  const at = store.blocks.indexOf(block)
  if (at >= 0) store.blocks.splice(at, 1)
}

/** 插到最近的前兄弟之后；没有可用的前兄弟就落在最前 */
function insertOrdered(list: Block[], block: Block, siblings: readonly Block[], index: number): void {
  for (let i = index - 1; i >= 0; i--) {
    const at = list.indexOf(siblings[i]!)
    if (at >= 0) {
      list.splice(at + 1, 0, block)
      return
    }
  }
  list.unshift(block)
}

/* ------------------------------------------------------------ 装载闭包 */

/** 块 id 的形状（uuidv7Hex）：形状不对的字符串不进装载闭包（名字、地址、外链都不是 id） */
const HEX32 = /^[0-9a-f]{32}$/

/** 一个 JSON 值里出现的所有块 id 形状的字符串（数组/对象递归；覆盖 select 值、归属边、声明槽） */
function collectValueIds(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (HEX32.test(v)) out.add(v)
    return
  }
  if (Array.isArray(v)) {
    for (const x of v) collectValueIds(x, out)
    return
  }
  if (v !== null && typeof v === 'object') {
    for (const x of Object.values(v as Record<string, unknown>)) collectValueIds(x, out)
  }
}

/**
 * **装载闭包**：要让这一片工作集**显示正确**还缺哪些块。
 *
 * 工作集装载的是视图子树；但正文里的引用、身上的标签、声明/值指向的定义块与
 * 选项块都住在子树外。不装它们，首帧的引用会显示成悬空、chip 没有名字——
 * 不是错误，是「少装了一层」。闭包只装**块自己**（不带子树），成本跟着
 * 这一屏的引用数走，不跟库大小走。
 *
 * @param extra 调用方自己知道的 id（槽快捷卡、当前对象这些不在 Doc 里的目标）
 */
export function worksetClosureIds(blocks: readonly Block[], extra: readonly string[] = []): string[] {
  const out = new Set<string>()
  for (const id of extra) if (HEX32.test(id)) out.add(id)
  walkForest(
    blocks,
    (b) => {
      for (const r of b.content) {
        if (r.t === 'ref' && typeof r.to === 'string' && r.to !== '') out.add(r.to)
      }
      if (b.props) {
        for (const v of Object.values(b.props)) collectValueIds(v, out)
      }
    },
    { includeDeleted: true },
  )
  return [...out]
}

/* ------------------------------------------------------------ 派生关系行（层 2 第一片） */

/**
 * **这次 op 批让谁的「出向关系边」变了**（关系行是**按源块**的行——不需要兄弟序，
 * 是两张派生表里唯一能从部分工作集正确算的一张；`BlockIndex.path` 要全库兄弟 rank，
 * 留给主进程侧的 SQL 设计，`derived_state` 在那之前保持 `pending`）。
 *
 * 返回两份集合：
 *   · `prune`——关系行要**清掉**的源块（删除/清除的子树整棵都清，含已不可见的块）；
 *   · `upsert`——关系行要**重铺**的源块（只含祖先链完整的块：`from_root` 要沿父链走到顶层）。
 * 祖先链不完整的块**不动**：宁可让它的关系行保持库里原值（消费侧有 `derived_state` 闸），
 * 也不写一份算错 root 的行。
 */
export interface AffectedRelations {
  prune: Set<string>
  upsert: Set<string>
}

function subtreeIdsOf(root: Block | undefined, id: string): { all: string[]; visible: string[] } {
  if (!root) return { all: [id], visible: [id] }
  const all: string[] = []
  const visible: string[] = []
  walkForest(
    [root],
    (b) => {
      all.push(b.id)
      if (!isDeleted(b)) visible.push(b.id)
    },
    { includeDeleted: true },
  )
  return { all, visible }
}

export function relationWritesOf(store: BlockStore, complete: ReadonlySet<string>, ops: readonly Op[]): RowWrite[] {
  const index = store.index
  const prune = new Set<string>()
  const upsert = new Set<string>()
  const addSubtree = (id: string): void => {
    const { all, visible } = subtreeIdsOf(index.all.get(id), id)
    for (const x of all) prune.add(x)
    for (const x of visible) upsert.add(x)
  }
  for (const op of ops) {
    if (op.e === 'block') {
      if (op.op === 'upsert' && op.value.parent !== undefined) addSubtree(op.id)
      else if (op.op === 'exist') addSubtree(op.id)
      else {
        // content/modified：正文里的引用边可能消失 ⇒ 先 prune 再按当前内容重铺
        prune.add(op.id)
        upsert.add(op.id)
      }
    } else {
      // prop/anno：属性值边与 anno 边同理（清掉值＝边消失）
      prune.add(op.block)
      upsert.add(op.block)
    }
  }
  // 祖先链不完整的块不重铺（from_root 会算错）；但 prune 照做——旧行清掉是对的
  const sources = [...upsert].filter((id) => complete.has(id) && index.blocks.has(id))
  if (prune.size === 0 && sources.length === 0) return []
  const out = derivedPruneWrites([], prune)
  const seen = new Set<string>()
  const relations: BlockRelationRow[] = []
  for (const id of sources) {
    const b = index.blocks.get(id)
    if (!b) continue
    // from_root：沿父链走到顶层（祖先链完整的块，链上每一块都在内存里）
    let root = id
    for (let cur: string | null | undefined = id; cur !== null && cur !== undefined; cur = index.parentOf.get(cur)) {
      root = cur
    }
    for (const e of relationEdgesOfBlock(b, index.propKinds, index.annos)) {
      const key = `${e.from}\u0000${e.to}\u0000${e.kind}`
      if (seen.has(key)) continue
      seen.add(key)
      relations.push({ from_id: e.from, to_id: e.to, kind: e.kind, from_root: root, count: e.count ?? null })
    }
  }
  if (relations.length > 0) {
    for (const r of relations) {
      out.push({
        table: 'BlockRelation',
        op: 'upsert',
        key: { from_id: r.from_id, to_id: r.to_id, kind: r.kind },
        values: { from_root: r.from_root, count: r.count },
      })
    }
  }
  return out
}
