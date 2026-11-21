/**
 * **可见行投影**（DOM-free）：把「这一屏画哪些行」的缓存、行索引与行位置收在一处。
 *
 * 从 `editor.ts` 抽出来的理由（判据是**缝**，不是行数）：这一块的失效键、
 * 缓存代际与读法都是自洽的一组——消费方只有编辑器的渲染路径与上下文键，
 * 生命周期跟着「装载的 Doc / 折叠态 / 树的形状」，领域语义是「可见行投影」。
 * 抽出来之后它是纯的（不碰 DOM、不碰 store 的写面），可以像 `height-index`
 * 一样直接单测失效边界，而不必起 Electron 探针。
 *
 * **五个失效轴**（每一轴的判据见下方缓存键的注释）：
 *   · 装载形状：`doc` 身份、`roots` 身份、`folded` 对象身份、`focusRoot*`、`viewRootId`；
 *   · 结构：`structureRevision`（parent/prev/exist/换库）；
 *   · 属性：`propsRevision`（`_activeView`／`_query` 决定哪一行画身体、子块让不让位）；
 *   · 内容：`revision`——**只**影响筛选结果（筛选可读正文/标签），不影响行集合；
 *   · 画不画身体：`withBody()`（`events.viewBody` 已接）。
 *
 * ⚠️ 缓存的是**数组本体**：调用方只读（`find`／`filter`／遍历），不要原地排序/增删。
 * ⚠️ 行里的 `block` 是活引用：正文改了不需要重算行，读 `.content` 自然是新值。
 * ⚠️ **`doc` / `roots` 按不可变使用**：原地 `roots.push` 不换身份 ⇒ 缓存不失效。
 *    不经事务的追加（下滚加载）必须换一份 `doc`；经事务的结构变化由 `structureRevision` 覆盖。
 */
import {
  filterVisibleRows,
  flatten,
  hasChildrenViewBody,
  pathTo,
  visibleRows,
  type Block,
  type Doc,
  type RowVerdict,
  type VisibleRow,
} from '../../core/index.ts'

/** 行筛选判据（三态：keep／drop／neutral） */
export type RowFilter = (block: Block, path: readonly Block[]) => RowVerdict

/** 只读的三个修订号（`BlockStore` 满足这个形状；测试可传哑对象） */
export interface RowRevisions {
  structureRevision: number
  propsRevision: number
  revision: number
}

export interface RowProjectionDeps {
  /** 装载的那份文档（`loadPage` 会换对象，所以传 getter） */
  doc: () => Doc
  revisions: () => RowRevisions
  /** 此刻的行筛选判据；`null` ＝ 不筛 */
  filter: () => RowFilter | null
  /** 光标块（筛选时它和祖先链永远算命中） */
  caret: () => string | null
  /** 这一屏真会画身体吗（查询块/露面行的身体让子块行让位） */
  withBody: () => boolean
  /** 调用计数（可选；诊断面读，测试不传） */
  probe?: { rowsCalls: number; rowsAllCalls: number }
}

export class RowProjection {
  // 不用参数属性：Node 的 strip-only 模式不支持 `constructor(private x)`（单测直接跑 TS）
  private readonly deps: RowProjectionDeps

  constructor(deps: RowProjectionDeps) {
    this.deps = deps
  }

  /**
   * **当前装载的活块数**（`flatten(doc).length` 的口径：含折叠隐藏、不含软删）。
   * 角标、诊断快照、按键上下文的 `blockCount` 每次按键都读它；跟着投影换代重算一次。
   */
  get blockCount(): number {
    return this.liveBlocks
  }
  private liveBlocks = 0

  private rawCache: {
    doc: Doc
    roots: Doc['roots']
    folded: Doc['folded']
    focusRootId: string | undefined
    focusRootOpen: boolean | undefined
    viewRootId: string | undefined
    structureRev: number
    propsRev: number
    withBody: boolean
    rows: VisibleRow[]
  } | null = null

  /** 与投影同一代的行索引（`blockId → VisibleRow`） */
  private rowIndex: Map<string, VisibleRow> | null = null
  /** 与投影同一代的行位置（`blockId → 行下标`） */
  private rowPos: Map<string, number> | null = null
  /** 行位置表对应的是哪一份行数组（筛选会换数组，索引必须跟着换） */
  private rowPosFor: readonly VisibleRow[] | null = null

  private filteredCache: {
    all: VisibleRow[]
    filter: RowFilter
    caret: string | null
    rev: number
    rows: VisibleRow[]
  } | null = null

  /** 这一块在**当前可见行**里的下标（不在这一屏/没有行 ⇒ undefined） */
  rowPosition(id: string): number | undefined {
    return this.rowPos?.get(id)
  }

  /** 这一块此刻的**可见行**（命中行索引 O(1)；没有就现算一次并查） */
  rowOf(id: string): VisibleRow | undefined {
    const hit = this.rowIndex?.get(id)
    if (hit) return hit
    return this.rows().find((r) => r.block.id === id)
  }

  /** 全部可见行（**不筛**）：筛选的候选与计数读它（筛过的那份会让候选自己消失） */
  rowsAll(): VisibleRow[] {
    if (this.deps.probe) this.deps.probe.rowsAllCalls++
    return this.rawRows()
  }

  /** 可见行（折叠的子树已排除；有筛选时只留命中行与它们的上下文） */
  rows(): VisibleRow[] {
    if (this.deps.probe) this.deps.probe.rowsCalls++
    const all = this.rawRows()
    const filter = this.deps.filter()
    if (!filter) return all
    /**
     * **正在编辑的那一块永远算命中**（连同它的祖先链）。
     * 否则刚敲出来的空块（不带任何被筛的页/标签）会在下一帧凭空消失，
     * 而光标还在里面——编辑面不能被它自己的镜头藏掉。
     */
    const caret = this.deps.caret()
    /**
     * 筛选结果也**按代复用**：判据、光标链不变、模型没动过时，同一份 `all` 的
     * 筛选结果不会变。滚动/换窗会反复问 `rows()`，没有这一格就退化成每次
     * O(可见行)（高度索引也就永远建在同一份新数组上）。
     * ⚠️ 内容改动会推 `revision`：筛选可以读正文/标签，所以它必须参与失效。
     */
    const rev = this.deps.revisions().revision
    const cached = this.filteredCache
    if (cached && cached.all === all && cached.filter === filter && cached.caret === caret && cached.rev === rev) {
      this.ensureRowPos(cached.rows)
      return cached.rows
    }
    const force = new Set<string>()
    if (caret !== null) {
      const chain = pathTo(this.deps.doc(), caret)
      if (chain) for (const b of chain) force.add(b.id)
      else force.add(caret)
    }
    const rows = filterVisibleRows(all, (r, path) => filter(r.block, path), force)
    this.filteredCache = { all, filter, caret, rev, rows }
    this.ensureRowPos(rows)
    return rows
  }

  private rawRows(): VisibleRow[] {
    const doc = this.deps.doc()
    const withBody = this.deps.withBody()
    const revisions = this.deps.revisions()
    const structureRev = revisions.structureRevision
    const propsRev = revisions.propsRevision
    const c = this.rawCache
    if (
      c !== null &&
      c.doc === doc &&
      c.roots === doc.roots &&
      c.folded === doc.folded &&
      c.focusRootId === doc.focusRootId &&
      c.focusRootOpen === doc.focusRootOpen &&
      c.viewRootId === doc.viewRootId &&
      c.structureRev === structureRev &&
      c.propsRev === propsRev &&
      c.withBody === withBody
    ) {
      return c.rows
    }
    /**
     * 活块数的口径是 `flatten(doc)`（含折叠隐藏、不含软删）。
     *
     * 没有身体宿主时，`visibleRows` 走到的节点就是 `flatten` 的全集 ⇒ 直接用它
     * 这一趟的输出长度，不再单独摊平一遍。有身体宿主时，身体子树被跳过
     * （children 由视图宿主渲染，不在正文行里）⇒ 仍需 `flatten` 补上那一段；
     * 这条分支只属于容器视图，低频。
     */
    const all = visibleRows(doc, {
      // 只有这一屏真会画身体的编辑器才让子块行让位（没有 viewBody 回调的
      // 里层编辑器——挂载区／镜像／查询结果——子块仍照常画）
      ...(withBody ? { bodyHosts: hasChildrenViewBody } : {}),
    })
    this.liveBlocks = withBody ? flatten(doc).length : all.length
    const rows = all.filter((r) => !r.hidden)
    this.rawCache = {
      doc,
      roots: doc.roots,
      folded: doc.folded,
      focusRootId: doc.focusRootId,
      focusRootOpen: doc.focusRootOpen,
      viewRootId: doc.viewRootId,
      structureRev,
      propsRev,
      withBody,
      rows,
    }
    this.rowIndex = new Map(rows.map((r) => [r.block.id, r]))
    this.ensureRowPos(rows)
    return rows
  }

  /** 让行位置表对上这一份行数组（O(N)，只在数组换代时走） */
  private ensureRowPos(rows: VisibleRow[]): void {
    if (this.rowPosFor === rows) return
    this.rowPos = new Map(rows.map((r, i) => [r.block.id, i]))
    this.rowPosFor = rows
  }
}
