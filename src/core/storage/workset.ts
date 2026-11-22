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
 * 不变量：`store.blocks` 与「已加载集合」只由存储层一起更新（装载是 `adoptLoaded` 的
 * 增量路径、换库是 `reset`、**本笔事务新建的子树是 `markCreated`**——它本来就在内存里，
 * 不算装载，但不入册会让 `needsDoc` 把「刚建出来的块」报成「还没装」）。本文件不做淘汰决策
 * （预算与 pin 判据在 `BlockStore.trimWorkset`），只在淘汰后把被淘汰块的行一起丢掉，
 * 防止下一次装载把它们又算进来。
 *
 * ## 为什么是「只装这一批」而不是「攒起来一起投影」
 *
 * 整份投影是 O(已装)：装第 N 窗要重算前面全部，分 50 窗装 10 万块要 31 秒（实测），
 * 而一次装完只要 0.39 秒。窗口是 **DFS 前缀**，新块永远接在已装兄弟后面，所以增量挂接
 * 是 O(本窗)（同一次实测 0.7 秒／每窗 8–12ms）。索引走 `applyOps` 的同一份增量判据，
 * 装载出来的索引与整份重建逐条一致（`tests/doc-window.test.ts` 的 `fingerprint` 等式）。
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
    this.absorb(rows)
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
    this.absorb(rows)
    if (complete) for (const r of rows.blocks) this.complete.add(idOf(r))
  }

  /**
   * **children 读全了没有**（`BlockStore.childrenKnown` 的装载侧入口）。
   *
   * 按 id 的预取（`loadBlocks`）不带子树，装进来的块在形状上与真叶子一样；
   * 调用方读完子树（`doc`／`tree(…, true)`）后必须 `markChildrenKnown`，
   * 否则打开这一块时会拿只有根行的正文，直到别处的装载把它凑齐。
   */
  childrenKnown(id: string): boolean {
    return this.store.childrenKnown(id)
  }

  markChildrenUnknown(ids: Iterable<string>): void {
    this.store.markChildrenUnknown(ids)
  }

  markChildrenKnown(ids: Iterable<string>): void {
    this.store.markChildrenKnown(ids)
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

  /**
   * 行缓存合并，返回**这次新见的 id**。
   *
   * 纯追加（装载一个从没见过的窗口）时不再整表拷贝、不再按 id 去重——那是 O(已装)。
   * 只有与已装块重合（重复装载同一片、或按 id 预取已装块）才走整表替换：
   * 那种时候后到的行可能更新，得按块整组换掉。
   */
  private mergeRows(incoming: RawLibraryRows): string[] {
    const fresh: string[] = []
    for (const r of incoming.blocks) {
      const id = idOf(r)
      if (id !== '' && !this.ids.has(id)) fresh.push(id)
    }
    const overlapping = fresh.length !== incoming.blocks.length
    if (!overlapping) {
      this.rows.blocks.push(...incoming.blocks)
      this.rows.props.push(...incoming.props)
      this.rows.aliases.push(...incoming.aliases)
      this.rows.lists.push(...incoming.lists)
      this.rows.meta = { ...this.rows.meta, ...incoming.meta }
    } else {
      const blockById = new Map<string, Row>()
      for (const r of this.rows.blocks) blockById.set(idOf(r), r)
      for (const r of incoming.blocks) blockById.set(idOf(r), r)
      this.rows = {
        blocks: [...blockById.values()],
        props: mergeGrouped(this.rows.props, incoming.props),
        aliases: mergeGrouped(this.rows.aliases, incoming.aliases),
        lists: mergeGrouped(this.rows.lists, incoming.lists),
        meta: { ...this.rows.meta, ...incoming.meta },
      }
    }
    for (const id of fresh) this.ids.add(id)
    return fresh
  }

  /**
   * **把一批行接进树上**——装载的唯一入口：只投影这一批，增量挂接、增量索引。
   *
   * 为什么不是「攒着一起投影」：那样每装一窗都要 O(已装) 重算，10 万块分 50 窗要 31 秒
   * （实测），而一次装完只要 0.39 秒。窗口是 **DFS 前缀**，所以新块永远接在已装兄弟后面：
   * `left` 只用来定位「接在哪一位」，不需要整树 diff。
   *
   * 已装块的对象与内容一律不动（本地未落盘的编辑永远比缓存行新）——这也是「同一个 id
   * 只有一个对象」这条的落点。
   */
  private absorb(incoming: RawLibraryRows): void {
    const fresh = this.mergeRows(incoming)
    const fragment = rowsToWorkspace(incoming)
    /** 片段里的块与它**在片段内**的父（`null` ＝ 片段根） */
    const frag = new Map<string, { block: Block; parent: string | null }>()
    walkForest(
      fragment.blocks,
      (b, ctx) => {
        frag.set(b.id, { block: b, parent: ctx.parent?.id ?? null })
      },
      { includeDeleted: true },
    )
    if (frag.size === 0) return

    const rowParent = new Map<string, string | null>()
    const rowLeft = new Map<string, string | null>()
    for (const r of incoming.blocks) {
      const id = idOf(r)
      if (id === '') continue
      rowParent.set(id, typeof r.parent === 'string' ? r.parent : null)
      rowLeft.set(id, typeof r.left === 'string' ? r.left : null)
    }

    // 1) 最终对象：已装的用老对象（内容以内存为准）
    const obj = new Map<string, Block>()
    for (const [id, info] of frag) obj.set(id, this.store.loadedObject(id) ?? info.block)

    /**
     * 2) 这块最终挂在谁下面：片段内的父子关系比行里的 `parent` 更完整（祖先行也可能在窗里）；
     * 片段根的父还没装载时，它暂时是顶层根（`null`）——今天同一条兜底。
     */
    const finalParent = new Map<string, string | null>()
    for (const [id, info] of frag) {
      if (info.parent !== null) {
        finalParent.set(id, info.parent)
        continue
      }
      const pid = rowParent.get(id) ?? null
      finalParent.set(id, pid !== null && this.store.loadedObject(pid) !== undefined ? pid : null)
    }

    // 3) 换位置：已装块的目标父与当前父不同（先当根装进来、后来父也装进来）⇒ 先摘
    const moved = new Set<string>()
    for (const [id] of frag) {
      const current = this.store.parentIdInTree(id)
      if (current === undefined) continue
      if (current === (finalParent.get(id) ?? null)) continue
      this.store.detachFromTree(id, current)
      moved.add(id)
    }

    // 4) 片段内的父子：新块直接取片段的孩子；已装父块只补缺（新孩子接在末尾）
    for (const [id, info] of frag) {
      const target = obj.get(id)!
      const kids = info.block.children.map((c) => obj.get(c.id)!)
      if (target === info.block) {
        target.children.splice(0, target.children.length, ...kids)
        continue
      }
      if (kids.length === 0) continue
      const have = new Set(target.children.map((c) => c.id))
      for (const kid of kids) if (!have.has(kid.id)) target.children.push(kid)
    }

    // 5) 落位：被摘下来的 ＋ 还没在树上的片段根，按 `left` 定位
    const groups = new Map<string | null, { id: string; left: string | null }[]>()
    for (const [id, info] of frag) {
      // 父也在片段里 ⇒ 4) 已经把它的 children 摆好了，这里再挂一次就是重复
      if (info.parent !== null) continue
      const unplaced = this.store.parentIdInTree(id) === undefined
      if (!unplaced && !moved.has(id)) continue
      const pid = finalParent.get(id) ?? null
      const slot = groups.get(pid)
      const entry = { id, left: rowLeft.get(id) ?? null }
      if (slot) slot.push(entry)
      else groups.set(pid, [entry])
    }
    /** 索引要接的：新块里的「顶层新块」＋ 换过位置的块 */
    const entries: { block: Block; parent: string | null }[] = []
    const freshSet = new Set(fresh)
    for (const [pid, slot] of groups) {
      const holder = pid === null ? null : this.store.loadedObject(pid)
      const list = holder ? holder.children : this.store.blocks
      const anchor = slot[0]!.left
      const at = anchor === null ? -1 : list.findIndex((b) => b.id === anchor)
      const blocks = slot.map((s) => obj.get(s.id)!)
      if (at >= 0) list.splice(at + 1, 0, ...blocks)
      else list.unshift(...blocks)
    }
    for (const [id] of frag) {
      const pid = finalParent.get(id) ?? null
      if (this.store.isIndexed(id)) {
        if (moved.has(id)) entries.push({ block: obj.get(id)!, parent: pid })
        continue
      }
      // 父也是新块 ⇒ 由父那条子树一次收进去，不重复走
      if (pid !== null && freshSet.has(pid)) continue
      entries.push({ block: obj.get(id)!, parent: pid })
    }

    // 6) 已加载集合与索引：**增量**（不作废索引，也不通知订阅者）
    this.store.adoptLoaded(fresh)
    this.store.indexLoaded(entries)
  }

}

/** 同组行（props／aliases／lists）按 block 整组替换：新读面给的是这块的当前全集 */
function mergeGrouped(current: readonly Row[], incoming: readonly Row[]): Row[] {
  if (incoming.length === 0) return [...current]
  const touched = new Set<string>()
  for (const r of incoming) touched.add(blockIdOf(r))
  return [...current.filter((r) => !touched.has(blockIdOf(r))), ...incoming]
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
    for (const e of relationEdgesOfBlock(b, index.propKinds, index.tagClassIds, index.annos)) {
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
