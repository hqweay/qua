/**
 * **撤销条目的 scoped 表示**：只记这次事务动过的块的前态／后态，撤销时只对这几块生成 op。
 *
 * ## 一句话
 *
 * 撤销存的仍然是**状态**（这一刻这几块长什么样），不是「怎么退回去」的指令；
 * 「怎么走」仍由 `diff` 的同一个代数回答（`existingBlockOps`／`newBlockOps` 复用 `kb/diff.ts`）。
 * 变的只是作用域：从「整片森林」缩到 touched 的那几块。
 *
 * ## 为什么必须成对地缩（快照 ＋ diff）
 *
 * 只把快照换成 touched、撤销时仍 `diff(整片森林, …)`，⌘Z 还是 O(整库)：
 * 省掉的只是序列化，最大那一笔（摊平两份森林比一遍）一点没少。
 * ⇒ 条目里带 **before 与 after 两侧**，撤销/重做各自只对这两侧做过的那几块生成 op。
 *
 * ## 三态存在
 *
 * `TouchedState.present` 只有两值，但落到 op 上是三态（`block.exist{state}`）：
 *
 * | 目标侧 | 当前侧 | 生成 |
 * |---|---|---|
 * | `present:false` | 在树上 | `exist{purged}`（撤销一次插入） |
 * | `present:true` ＋ `_deletedAt` | 在树上、无标记 | `exist{deleted}`（重做一次删除） |
 * | `present:true`、无标记 | 在树上、有标记 | `exist{present}`（撤销一次删除） |
 * | `present:true`、无标记 | **不在树上** | genesis（重做一次插入，**同一个 id**） |
 *
 * 「软删」不是 `present:false`：被软删的块仍在树上的原位（可恢复），`present:false` 只表示
 * 「这一侧根本没有这块」。两者混起来会让「撤销删除」变成「复活一个不存在的 id」。
 *
 * ## 顺序
 *
 * · **恢复父先于子**：`applyOps` 的 `placeAt` 在父不存在时抛错（静默落顶层会把子树挂错地方）；
 * · **清除子先于父**：父先消失时子块的落点已经在树外，日志里就补不回来了。
 *
 * 两者都按**树深**排（不是调用顺序）：touched 的登记顺序只对「同一 tx 内的兄弟插入」有意义，
 * 而深度是落点本身的属性。同深度保持登记序（`Array#sort` 稳定）——那正是「先插 A 再插 B」
 * 在重放时变成 `[B, A]` 的原因。
 *
 * ## 边界（明确不做）
 *
 * · 不引入逆 op：条目里没有「怎么退」；
 * · 不存整片森林：条目里只有 touched 的 id ＋ 格 ＋ 落点；
 * · 不依赖「块已在内存」以外的世界：条目不持有 `Block`，只有 id 与深拷的格（为懒加载留门）。
 *
 * ⚠️ 本文件零 DOM、零持久化；它只吃一份「现在的样子」与条目，所以能直接单测。
 */
import type { Block } from '../model/model.ts'
import { walkForest } from '../model/walk.ts'
import type { Op } from './types.ts'
import {
  cellsOf,
  existingBlockOps,
  newBlockOps,
  snapshotValue,
  type BlockCells,
  type Placement,
  type TouchedBlock,
} from './diff.ts'

/**
 * 一侧（before／after）的一块。
 *
 * `cells`／`placement` 都可能缺席，它们回答的是不同的问题：
 *   · `cells` 缺席 ⇔ `present:false`（这一侧没有这块）；
 *   · `placement` 缺席 ⇔ **这次事务没动过它的位置**（没插入、没移动）。
 *     「没动过」不等于「没有落点」——把当前位置抄一份进来会让每次打字都存一对
 *     parent/prev，也会让撤销多出一条无意义的位置 op（而位置 op 会触发整页结构重画）。
 */
export interface TouchedState {
  id: string
  /** 这一侧在不在树上（见文件头的三态表） */
  present: boolean
  /** present 时的块级格；**深拷**（props／annos 可被就地改，content 会被后续写替换） */
  cells?: BlockCells
  /** 这一侧**被显式指定的**落点（新块的出生位置 / 移动后的位置） */
  placement?: Placement
}

/** 一次事务交出的撤销捕获：两侧状态 ＋ 「这次是不是一行里的直接编辑」 */
export interface UndoCapture {
  before: TouchedState[]
  after: TouchedState[]
  /**
   * 这次写入带 `directEdit`（查询块正文只在这条路上可写）。
   * 撤销/重做要带同一个选项，否则同一次写入在反向时会撞上内容闸。
   */
  directEdit: boolean
}

/**
 * `scopedOps` 只问「现在什么样」，不遍历森林。
 *
 * 为什么不直接收 `Block[]`：那会逼着每个调用方（包括 ⌘Z）摊平一遍整库——
 * 而作用域收窄的全部意义就是**不摊平**。索引／页缓存将来可以提供 O(1) 的实现。
 *
 * ⚠️ `get` 必须**看得见被软删的块**（它们在树上的原位，恢复路径要找它们）。
 *    `store.index` 今天只收可见块（`applyBlockDelete` 会把它们摘掉），所以它不能直接充当
 *    这个 lookup —— 接 store 时要么补一张「全部块」表，要么保留一趟含删遍历。
 */
export interface ForestLookup {
  /** 在树上（含软删）就返回块；不在树上返回 `undefined` */
  get(id: string): Block | undefined
  /** 这一块的树父；`null` ＝ 森林顶层。只对 `get` 得到的块调用 */
  parentOf(id: string): string | null
}

/** 把一片森林摊成 lookup（**含被软删的块**）。没有索引时的实现，也是测试与非 store 路径的入口。 */
export function lookupOf(forest: readonly Block[]): ForestLookup {
  const byId = new Map<string, Block>()
  const parent = new Map<string, string | null>()
  walkForest(
    forest,
    (b, ctx) => {
      byId.set(b.id, b)
      parent.set(b.id, ctx.parent?.id ?? null)
    },
    { includeDeleted: true },
  )
  return {
    get: (id) => byId.get(id),
    parentOf: (id) => parent.get(id) ?? null,
  }
}

/** 深拷一格（口径与 `kb/diff.ts` 的 op 值相同：条目要活到下一次编辑之后） */
function copyCells(c: BlockCells): BlockCells {
  return snapshotValue(c) as BlockCells
}

/**
 * **出口捕获**：把 `Tx` 的 touched 表变成撤销条目要的两侧状态。
 *
 * 为什么在出口深拷：`touched` 里的 `block` 是**活引用**，事务返回后它还会被下一次编辑改；
 * 条目若只记引用，撤销拿到的就是「后来那份」。这一条与 `pendingOps` 的 250ms 是同一个病。
 */
export function captureOf(touched: Iterable<TouchedBlock>, directEdit = false): UndoCapture {
  const before: TouchedState[] = []
  const after: TouchedState[] = []
  for (const t of touched) {
    before.push(stateOfBefore(t))
    /**
     * `Tx` 今天没有 purge（清除只由撤销产生），所以 touched 的块在出口一定还在树上。
     * 将来若 `Tx` 长出 purge，这里会连同 `scopedOps` 的三态表一起失效 ——
     * 所以用断言把「改后一定 present」写成显式前提，而不是靠沉默。
     */
    after.push({
      id: t.block.id,
      present: true,
      cells: copyCells(cellsOf(t.block)),
      ...(t.afterPlacement ? { placement: { ...t.afterPlacement } } : {}),
    })
  }
  return { before, after, directEdit }
}

function stateOfBefore(t: TouchedBlock): TouchedState {
  if (t.before === null) return { id: t.block.id, present: false }
  return {
    id: t.block.id,
    present: true,
    cells: copyCells(t.before.cells),
    ...(t.beforePlacement ? { placement: { ...t.beforePlacement } } : {}),
  }
}

/** 由一侧状态造一个「只为 emit op 用」的块（不复用活块：ops 的 content/props 要是这一侧的） */
function blockOfState(s: TouchedState): Block {
  if (!s.cells) throw new Error(`kb: scoped undo: block "${s.id}" is present but has no cells`)
  const b: Block = {
    id: s.id,
    content: s.cells.content,
    children: [],
    created: s.cells.created,
    modified: s.cells.modified,
  }
  if (s.cells.props !== undefined) b.props = s.cells.props
  if (s.cells.annos !== undefined) b.annos = s.cells.annos
  return b
}

/**
 * **把「现在」走到目标状态，只发 touched 那几块的 op**。
 *
 * @param current 现在的森林（只按 id / 父链问，不摊平）
 * @param states  目标侧（`entry.before` 或 `entry.after`）
 * @param opts    `directEdit` 必须与捕获时一致（见 `UndoCapture.directEdit`）
 */
export function scopedOps(
  current: ForestLookup,
  states: readonly TouchedState[],
  opts: { directEdit?: boolean } = {},
): Op[] {
  const byId = new Map(states.map((s) => [s.id, s]))
  const ops: Op[] = []

  /* ① 清除：子先于父 ------------------------------------------------ */
  const gone = states.filter((s) => !s.present)
  if (gone.length > 0) {
    const purgeIds = new Set(gone.map((s) => s.id))
    const ordered = [...gone].sort((a, b) => depthInCurrent(current, b.id) - depthInCurrent(current, a.id))
    for (const s of ordered) {
      const cur = current.get(s.id)
      if (!cur) continue // 已经不在了：撤销重放两次仍然收敛（幂等）
      assertSubtreeGone(cur, purgeIds)
      ops.push({ e: 'block', id: s.id, op: 'exist', state: 'purged', at: cur.modified })
    }
  }

  /* ② 恢复 / 改写：父先于子 ------------------------------------------ */
  const there = states.filter((s) => s.present)
  if (there.length > 0) {
    const memo = new Map<string, number>()
    const depthOf = (id: string, trail: Set<string>): number => {
      const hit = memo.get(id)
      if (hit !== undefined) return hit
      if (trail.has(id)) throw new Error(`kb: scoped undo: placement cycle through "${id}"`)
      trail.add(id)
      const parent = parentInTarget(current, byId, id)
      const d = parent === null ? 0 : 1 + depthOf(parent, trail)
      trail.delete(id)
      memo.set(id, d)
      return d
    }
    const ordered = [...there].sort((a, b) => depthOf(a.id, new Set()) - depthOf(b.id, new Set()))

    for (const s of ordered) {
      const cur = current.get(s.id)
      if (!cur) {
        /* genesis：这一侧有、现在没有（重做一次插入 / 恢复被清掉的块） */
        if (!s.placement) throw new Error(`kb: scoped undo: block "${s.id}" needs a placement to be restored`)
        const parent = s.placement.parent
        if (parent !== null) {
          const parentState = byId.get(parent)
          if (parentState && !parentState.present) {
            throw new Error(`kb: scoped undo: block "${s.id}" hangs under purged block "${parent}"`)
          }
          if (!parentState && !current.get(parent)) {
            throw new Error(`kb: scoped undo: missing parent "${parent}" for block "${s.id}"`)
          }
        }
        ops.push(...newBlockOps(blockOfState(s), s.placement))
        continue
      }
      /* 已存在：只发变了的格；位置只在这次事务真的动过它时发 */
      ops.push(...existingBlockOps(cellsOf(cur), blockOfState(s), s.placement, opts))
    }
  }

  return ops
}

/** 当前树深（子先于父的排序键）；不在树上 ⇒ 0 */
function depthInCurrent(current: ForestLookup, id: string): number {
  let d = 0
  let cur: string | null = id
  const seen = new Set<string>()
  while (cur !== null) {
    if (seen.has(cur)) throw new Error(`kb: scoped undo: tree cycle through "${cur}"`)
    seen.add(cur)
    cur = current.parentOf(cur)
    if (cur !== null) d++
  }
  return d
}

/** 目标侧树深：动过位置就用目标落点，没动过就沿用当前位置（它没变） */
function parentInTarget(
  current: ForestLookup,
  byId: ReadonlyMap<string, TouchedState>,
  id: string,
): string | null {
  const s = byId.get(id)
  if (s?.placement) return s.placement.parent
  if (s && !current.get(id)) {
    throw new Error(`kb: scoped undo: block "${id}" is absent and has no placement`)
  }
  const cur = current.get(id)
  if (!cur) return null
  return current.parentOf(id)
}

/**
 * 清除一块**会带走整棵子树**：子树里每一块都必须在同一批清除里，否则这份条目
 * 记的就不是「这次事务的全部影响」——父块消失时子块会被静默丢掉，且日志里没有它的账。
 *
 * 正常路径下这条恒真（`Tx.insert` 按子树先序把每一块都登进 touched；删除是原位软删，
 * 从不 purge）。它拦的是「合并多个事务的条目漏了一块」这一类构造性错误。
 */
function assertSubtreeGone(root: Block, purgeIds: ReadonlySet<string>): void {
  walkForest(
    [root],
    (b) => {
      if (b.id === root.id) return
      if (purgeIds.has(b.id)) return
      throw new Error(`kb: scoped undo: purging "${root.id}" would drop untracked block "${b.id}"`)
    },
    { includeDeleted: true },
  )
}
