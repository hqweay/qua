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
import type { Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import type { BlockStore } from '../model/store.ts'
import { rowsToWorkspace, type RawLibraryRows } from './db-rows.ts'

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

  constructor(store: BlockStore) {
    this.store = store
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
    const out: Block[] = []
    for (const id of rootIds) {
      const b = this.store.find(id)
      if (b) out.push(b)
    }
    return out
  }

  /** 装一批不带子树的块（引用目标、标签、字段定义……） */
  loadBlocks(rows: RawLibraryRows): void {
    if (rows.blocks.length === 0) return
    this.mergeRows(rows)
    this.apply()
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
      target.children.splice(0, target.children.length, ...info.block.children.map((c) => mapped.get(c.id)!))
    }

    // 4) 老父块：只补缺的孩子，按新树里的兄弟序插到最近的前兄弟之后
    for (const [id, info] of freshInfo) {
      if (!existingInfo.has(id)) continue
      const target = mapped.get(id)!
      const kids = info.block.children.map((c) => mapped.get(c.id)!)
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
