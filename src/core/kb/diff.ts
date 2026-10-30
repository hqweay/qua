/**
 * **「把状态的变化表达成一批 op」的代数**：`diff`／`diffTouched`／`applyOps`／`replay`。
 *
 * ## 一句话
 *
 * 状态是日志的 fold。`op_log` 里的每一格都是**绝对写入**，所以
 * `replay(ops)` 能从空森林重建整库；数据库行只是这份 fold 的物化视图。
 *
 * ## 为什么一条 op 里可以带多个「块级格」
 *
 * `block.upsert{content, modified}` 本来就是一格账（一次改动只有一个时刻）。
 * 新块的 genesis 同理：`{parent, prev, created, modified, content}` 一次说全，
 * 省掉「位置一条、出生一条、正文一条」的三条账 —— 它们本来就是同一件事。
 * **属性与 annos 仍各走各的格**：把整袋属性塞进 genesis 会让「改一格」变成「写一整袋」，
 * 而那正是「同一个格两种地址」的老路。
 *
 * ## 四条必须成立的性质（`tests/kb-diff.test.ts` 与 `tests/kb-replay.test.ts` 逐条钉住）
 *
 * 1. **等式**：`apply(a, diff(a, b))` 与 `b` **逐字节相等**（键序也算，见 `forestFingerprint`）。
 * 2. **完备**：`diff(x, x) == []`（未变的不发 op）。
 * 3. **顺序**：发射序 ＝ 目标森林的**先序**（父 op 先于子 op）。
 * 4. **时刻**：`at` 从**目标**派生（不取 `Date.now()`）；同一次 diff 跑两次逐字节相同。
 *
 * ## 五条实现口径
 *
 * 1. **存在是一个格、三个值**：`block.exist{present|deleted|purged}`。
 *    软删／恢复与「撤销一次插入」的清除不再共用一个词。
 * 2. **派生格不进日志**：曾经有一格 `_queryResult`（那次查询的冻结结果）不投影，
 *    现在它**根本不在模型里**——结果按表面实例冻结，重开重算。
 *    `_deletedAt` 不走 `prop`（它是 `exist` 在内存里的表示）。
 * 3. **新块从 op 里生出来**：`applyOps` 遇到位置 op 时若块不存在，就按 op 里的
 *    `created`／`modified`／`content` 造一块，再挂上去。**不需要 `source` 快照**。
 * 4. **原地写格**：`applyOps` 不替换未动块的对象（索引存的是活引用）。
 * 5. **`diffTouched` 吃 tx 的 touched 表**：只比动过的块，成本与库体量无关；
 *    它是 `Tx` 的唯一 op 生产者（`kb/memory.ts`）。
 *
 * ⚠️ 本文件零 DOM、零持久化、零 store：它只吃森林与 op，所以能直接单测。
 */
import { DELETED_AT_PROP, type Block } from '../model.ts'
import { walkForest } from '../walk.ts'
import type { Anno } from '../runs.ts'
import type { Op } from './types.ts'

/* ------------------------------------------------------------ 格与落点 */

/** 一块的**块级格**（位置另算；属性与 annos 各走各的 op） */
export type BlockCells = Pick<Block, 'content' | 'created' | 'modified' | 'props' | 'annos'>

/** 落点：父与前兄弟（`null` ＝ 顶层／该层第一个） */
export interface Placement {
  parent: string | null
  prev: string | null
}

/**
 * tx 里「碰到一块之前」的快照。
 *
 * `children` 不是格：它只用来做两件事 —— `patch` 的「不许改子树」校验、
 * 以及失败回滚。位置另记在 `TouchedBlock.beforePlacement`，因为只有 `move` 需要它。
 */
export interface BeforeBlock {
  cells: BlockCells
  children: Block[]
}

/** `Tx` 出口要处理的一块：改前快照（新块为 `null`）＋ 改后落点（没动就不给） */
export interface TouchedBlock {
  block: Block
  before: BeforeBlock | null
  beforePlacement?: Placement
  afterPlacement?: Placement
}

export function cellsOf(b: Block): BlockCells {
  return { content: b.content, created: b.created, modified: b.modified, props: b.props, annos: b.annos }
}

/** 值比较：数组/对象也比内容。键序不承载语义，但 `forestFingerprint` 会规范化。 */
function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * op 里的属性值必须是**当时的快照**。
 *
 * `pendingOps` 会活到防抖窗口结束（250ms）；这段时间里调用方可以就地改属性数组
 * （`props.arr.push`，`patch` 是允许的）。只存引用的话，先落进队列的那条 op
 * 会被后来的就地修改改掉 —— 日志记的就不再是「当时是什么」。
 * 属性值都很小（id 列表／标量），深拷一次的代价远低于一条错账。
 */
function snapshotValue(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v)) as unknown
}

/** 一块的「时刻」：`at` 从这个字段派生（不是 `Date.now()`，见文件头第 4 条） */
const stampOf = (b: Block): number => b.modified

function deletedAtOf(cells: Pick<Block, 'props'> | undefined): number | undefined {
  const v = cells?.props?.[DELETED_AT_PROP]
  return typeof v === 'number' ? v : undefined
}

/**
 * 哪些属性键**不是**普通 prop 格（各有各的地址）。
 *
 * 目前只有删除标记：它是 `block.exist` 在内存里的表示，不是「这一格的值」。
 * （曾经冻结的查询结果也在这里豁免；那一格已从模型里删掉——结果按表面实例冻结，
 * 不再经过 op。）
 */
function isPropCell(name: string): boolean {
  return name !== DELETED_AT_PROP
}

/* ------------------------------------------------------------ 生成 op */

function positionOp(block: Block, placement: Placement): Op {
  return {
    e: 'block',
    id: block.id,
    op: 'upsert',
    value: { parent: placement.parent, prev: placement.prev },
    at: stampOf(block),
  }
}

/**
 * 新块的**一条 genesis**：位置 ＋ 出生 ＋ 时刻 ＋ 正文。
 *
 * 属性与 annos 不在其中（各走各的格）。这条 op 让 `applyOps` 能在空森林里
 * 只凭它就把一块造出来 —— 不需要任何外部快照。
 */
function genesisOp(block: Block, placement: Placement): Op {
  return {
    e: 'block',
    id: block.id,
    op: 'upsert',
    value: {
      parent: placement.parent,
      prev: placement.prev,
      created: block.created,
      modified: block.modified,
      content: block.content,
    },
    at: stampOf(block),
  }
}

function existOp(id: string, before: number | undefined, after: number | undefined, stamp: number): Op | undefined {
  if (before === after) return undefined
  if (after !== undefined) return { e: 'block', id, op: 'exist', state: 'deleted', at: after }
  return { e: 'block', id, op: 'exist', state: 'present', at: stamp }
}

function propOps(id: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, stamp: number): Op[] {
  const out: Op[] = []
  const a = before ?? {}
  const b = after ?? {}
  for (const name of Object.keys(b)) {
    if (!isPropCell(name)) continue
    if (name in a && same(a[name], b[name])) continue
    out.push({ e: 'prop', block: id, name, op: 'set', value: snapshotValue(b[name]), at: stamp })
  }
  for (const name of Object.keys(a)) {
    if (!isPropCell(name)) continue
    if (name in b) continue
    out.push({ e: 'prop', block: id, name, op: 'delete', at: stamp })
  }
  return out
}

function annoOps(id: string, before: readonly Anno[] | undefined, after: readonly Anno[] | undefined, stamp: number): Op[] {
  const out: Op[] = []
  const a = new Map((before ?? []).map((x) => [x.id, x]))
  const b = new Map((after ?? []).map((x) => [x.id, x]))
  for (const [aid, anno] of b) {
    const old = a.get(aid)
    if (old && same(old, anno)) continue
    out.push({ e: 'anno', block: id, id: aid, op: 'set', value: anno, at: stamp })
  }
  for (const [aid, anno] of a) {
    if (b.has(aid)) continue
    out.push({ e: 'anno', block: id, id: aid, op: 'delete', value: anno, at: stamp })
  }
  return out
}

/** 新块：genesis ＋ 存在（若一开始就是软删） ＋ 属性 ＋ annos */
function newBlockOps(block: Block, placement: Placement): Op[] {
  const out: Op[] = [genesisOp(block, placement)]
  const deleted = deletedAtOf(block)
  if (deleted !== undefined) {
    out.push({ e: 'block', id: block.id, op: 'exist', state: 'deleted', at: deleted })
  }
  out.push(...propOps(block.id, undefined, block.props, stampOf(block)))
  out.push(...annoOps(block.id, undefined, block.annos, stampOf(block)))
  return out
}

/** 已有块：位置（若动） ＋ 存在（若变） ＋ created/content/modified ＋ 属性 ＋ annos */
function existingBlockOps(old: BlockCells, block: Block, placement?: Placement): Op[] {
  const out: Op[] = []
  if (placement) out.push(positionOp(block, placement))

  const exist = existOp(block.id, deletedAtOf(old), deletedAtOf(block), stampOf(block))
  if (exist) out.push(exist)

  if (old.created !== block.created) {
    out.push({ e: 'block', id: block.id, op: 'upsert', value: { created: block.created }, at: stampOf(block) })
  }

  /**
   * **正文**：整组替换；时刻并进同一条 op（一次改动一条账）。
   * 只有时刻变了（例如属性写入顺带改了 `modified`）⇒ 单独一条 `{modified}`。
   */
  const contentChanged = !same(old.content, block.content)
  const timeChanged = old.modified !== block.modified
  if (contentChanged) {
    out.push({
      e: 'block',
      id: block.id,
      op: 'upsert',
      value: { content: block.content, ...(timeChanged ? { modified: block.modified } : {}) },
      at: stampOf(block),
    })
  } else if (timeChanged) {
    out.push({ e: 'block', id: block.id, op: 'upsert', value: { modified: block.modified }, at: stampOf(block) })
  }

  out.push(...propOps(block.id, old.props, block.props, stampOf(block)))
  out.push(...annoOps(block.id, old.annos, block.annos, stampOf(block)))
  return out
}

/* ------------------------------------------------------------ 两份森林 */

/** 一份森林的扁平视图：块 id → 块，以及它的落点（父与前兄弟） */
interface Snapshot {
  /** 先序的块（含被软删的：它们在树上原位，只是不可见） */
  order: readonly Block[]
  byId: ReadonlyMap<string, Block>
  /** 块 id → 它的父（`null` ＝ 森林顶层） */
  parent: ReadonlyMap<string, string | null>
  /** 块 id → 它在该层的前兄弟（`null` ＝ 该层第一个） */
  prev: ReadonlyMap<string, string | null>
  /** 块 id → 它在树上（含被删的块） */
  inTree: ReadonlySet<string>
}

/**
 * 摊平一份森林。
 *
 * 走 `walkForest`（块树遍历的唯一入口，`arch-check [22]`）：它给的 `ctx.parent`／`ctx.index`
 * 就是落点要的原料。**含被删的块**：它们在树上原位，恢复路径要能看见。
 */
function snapshotOf(forest: readonly Block[]): Snapshot {
  const order: Block[] = []
  const byId = new Map<string, Block>()
  const parent = new Map<string, string | null>()
  const prev = new Map<string, string | null>()
  const inTree = new Set<string>()
  walkForest(
    forest,
    (b, ctx) => {
      order.push(b)
      byId.set(b.id, b)
      parent.set(b.id, ctx.parent?.id ?? null)
      const list = ctx.parent ? ctx.parent.children : forest
      prev.set(b.id, ctx.index === 0 ? null : (list[ctx.index - 1]?.id ?? null))
      inTree.add(b.id)
    },
    { includeDeleted: true },
  )
  return { order, byId, parent, prev, inTree }
}

/* ------------------------------------------------------------ diff */

/**
 * **把 `from → to` 表达成一批 op**（撤销用）。
 *
 * @param from 起点森林（通常是「当前」）
 * @param to   终点森林（通常是「快照里那份」）
 */
export function diff(from: readonly Block[], to: readonly Block[]): Op[] {
  const a = snapshotOf(from)
  const b = snapshotOf(to)
  const ops: Op[] = []

  /**
   * **清除**（在 `from` 里、不在 `to` 里）：块从树上消失。
   *
   * 这与「软删」是两件事：软删是**留在原位、打标记**（可恢复）；清除是**真的不在树上**。
   * 撤销一次「插入块」要的是清除 —— 用软删会让回收站每撤一次新建就涨一条。
   *
   * ⚠️ **先发清除，再发目标先序**：否则「同一块先在 to 里、又在 from 里」这种
   *    不存在的形状会被后来的 op 覆盖掉。
   */
  for (const block of a.order) {
    if (b.inTree.has(block.id)) continue
    ops.push({ e: 'block', id: block.id, op: 'exist', state: 'purged', at: stampOf(block) })
  }

  /**
   * **按目标森林的先序发射**（父先于子）：一棵子树的 op 隐含「父在子前」这个拓扑序。
   * 用 `to` 的 `order` 而不是 `from` 的：目标才是「应该长成什么样」。
   */
  for (const block of b.order) {
    const old = a.byId.get(block.id)
    const placement: Placement = { parent: b.parent.get(block.id) ?? null, prev: b.prev.get(block.id) ?? null }

    if (!old) {
      ops.push(...newBlockOps(block, placement))
      continue
    }

    const moved =
      a.parent.get(block.id) !== placement.parent || a.prev.get(block.id) !== placement.prev
    ops.push(...existingBlockOps(old, block, moved ? placement : undefined))
  }

  return ops
}

/**
 * **tx 出口的唯一 op 生产者**：只比 `touched` 里那几块，成本与库体量无关。
 *
 * `touched` 的插入顺序就是输出顺序。`Tx.insert` 按子树先序登记，所以
 * **父 op 先于子 op** 这条性质由调用方保持；其它方法都只碰一块，顺序无歧义。
 */
export function diffTouched(touched: Iterable<TouchedBlock>): Op[] {
  const ops: Op[] = []
  for (const t of touched) {
    if (t.before === null) {
      if (!t.afterPlacement) throw new Error(`kb: new block "${t.block.id}" has no placement`)
      ops.push(...newBlockOps(t.block, t.afterPlacement))
      continue
    }
    const moved =
      t.beforePlacement !== undefined &&
      t.afterPlacement !== undefined &&
      (t.beforePlacement.parent !== t.afterPlacement.parent || t.beforePlacement.prev !== t.afterPlacement.prev)
    ops.push(...existingBlockOps(t.before.cells, t.block, moved ? t.afterPlacement : undefined))
  }
  return ops
}

/* ------------------------------------------------------------ apply / replay */

/**
 * **把 op 应用到一片森林**（`diff` 的逆运算，也是 `replay` 的解释器）。
 *
 * 1. **原地写格、保持未动块的对象身份**。索引存的是块的**活引用**；
 *    若这里替换块对象（CoW／`JSON.parse`），索引会静默失效 —— 它手里那批对象当场过期，
 *    而没有任何一层会报错。所以「换一片森林」不是这个函数做的事。
 * 2. **新块从 op 里生出来**：位置 op 若带 `created`／`modified`／`content`（genesis），
 *    就直接造一块；不再需要 `source` 快照。
 * 3. **父必须先出现**：op 流按目标先序发射；父不在树上是**日志残缺**，
 *    抛错而不是静默落到顶层（静默会让一棵子树长到错的地方，且不报错）。
 *
 * @param forest 要改的森林（原地改）
 * @param ops    `diff`／`diffTouched` 的输出，或 `op_log` 里的历史
 */
export function applyOps(forest: Block[], ops: readonly Op[]): void {
  /**
   * **空森林 ⇒ 走构建器**：`replay` 与「从日志重建整库」都从这里过。
   *
   * 为什么单独一条路：逐条 `findAnywhere` ＋ `splice` 在 50,000 块的 genesis 上是
   * O(n²)（实测 82.7s）。构建器维护 `id → 父`、`父 → 子列表`、`父 → 最后一个孩子` 三张表，
   * 新块按 `prev` 追加是 O(1)；只有真正的「插到中间」才 `findIndex`。
   * 它写出的仍是同一批 `byId` 里的块与同一套格，不是第二份语义。
   */
  if (forest.length === 0) {
    buildFromEmpty(forest, ops)
    return
  }

  /** ① **清除**：块从树上消失（与软删是两件事）。 */
  for (const op of ops) {
    if (op.e === 'block' && op.op === 'exist' && op.state === 'purged') removeFromTree(forest, op.id)
  }

  /** ② **位置与 genesis**：按 op 顺序逐条落（同父多条时，后一条依赖前一条已就位）。 */
  for (const op of ops) {
    if (op.e !== 'block' || op.op !== 'upsert' || op.value.parent === undefined) continue
    let block = findAnywhere(forest, op.id)
    if (!block) {
      const created = op.value.created ?? 0
      block = {
        id: op.id,
        content: op.value.content ?? [],
        children: [],
        created,
        modified: op.value.modified ?? created,
      }
    }
    if (op.value.created !== undefined) block.created = op.value.created
    if (op.value.content !== undefined) block.content = op.value.content
    if (op.value.modified !== undefined) block.modified = op.value.modified
    placeAt(forest, block, op.value.parent, op.value.prev ?? null)
  }

  /** ③ **格**：正文／出生／时刻／属性／annos／存在（原地写，对象身份不变）。 */
  const byId = new Map<string, Block>()
  walkForest(forest, (b) => void byId.set(b.id, b), { includeDeleted: true })
  for (const op of ops) {
    if (op.e === 'block' && op.op === 'exist' && op.state === 'purged') continue
    applyCellOp(op, byId)
  }
}

/**
 * **空森林构建器**：新块的 genesis 按 `prev` 追加 O(1)，最后一次性物化 `children`。
 *
 * 口径与 `applyOps` 的增量路径完全相同：位置 op 才造块／挂树；`purged` 先退场；
 * 其余格走同一个 `applyCellOp`。差别只有「怎么把块挂上去」这一层数据结构。
 */
function buildFromEmpty(forest: Block[], ops: readonly Op[]): void {
  const byId = new Map<string, Block>()
  const parentOf = new Map<string, string | null>()
  const kids = new Map<string | null, Block[]>()
  const lastOf = new Map<string | null, string | null>()

  const detach = (id: string): void => {
    if (!parentOf.has(id)) return
    const parent = parentOf.get(id)!
    const list = kids.get(parent)
    if (list) {
      const i = list.findIndex((b) => b.id === id)
      if (i >= 0) list.splice(i, 1)
      lastOf.set(parent, list.at(-1)?.id ?? null)
    }
    parentOf.delete(id)
  }

  const attach = (block: Block, parent: string | null, prev: string | null): void => {
    if (parent !== null && !byId.has(parent)) {
      throw new Error(`kb: replay: missing parent "${parent}" for block "${block.id}"`)
    }
    detach(block.id)
    const list = kids.get(parent) ?? []
    kids.set(parent, list)
    if (prev === null) {
      list.unshift(block)
    } else if (lastOf.get(parent) === prev) {
      // 目标先序里「接在最后一个孩子后面」是最常见的一支：O(1)
      list.push(block)
    } else {
      const i = list.findIndex((x) => x.id === prev)
      if (i < 0) list.unshift(block)
      else list.splice(i + 1, 0, block)
    }
    lastOf.set(parent, list.at(-1)?.id ?? null)
    parentOf.set(block.id, parent)
  }

  /**
   * **按日志顺序走一遍**：清除、位置、格都在同一条流里。
   *
   * 不能像增量路径那样「先把所有 purge 跑完，再挂所有位置」：完整日志里
   * 「先插入、后撤销」的 purge 出现在 position 之后；先跑 purge 会让它扑空，
   * 块又被后面的 position 造出来 ⇒ 撤销掉的块在重放里复活。
   */
  for (const op of ops) {
    if (op.e === 'block' && op.op === 'exist' && op.state === 'purged') {
      detach(op.id)
      byId.delete(op.id)
      continue
    }
    if (op.e === 'block' && op.op === 'upsert' && op.value.parent !== undefined) {
      let block = byId.get(op.id)
      if (!block) {
        const created = op.value.created ?? 0
        block = {
          id: op.id,
          content: op.value.content ?? [],
          children: [],
          created,
          modified: op.value.modified ?? created,
        }
        byId.set(op.id, block)
      }
      if (op.value.created !== undefined) block.created = op.value.created
      if (op.value.content !== undefined) block.content = op.value.content
      if (op.value.modified !== undefined) block.modified = op.value.modified
      attach(block, op.value.parent, op.value.prev ?? null)
      continue
    }
    applyCellOp(op, byId)
  }

  /** ④ 物化：把「父 → 子列表」写回块；根列表写回 `forest`。 */
  for (const [parent, list] of kids) {
    if (parent === null) continue
    const p = byId.get(parent)
    if (p) p.children = list
  }
  forest.push(...(kids.get(null) ?? []))
}

/** 一格的解释器（`applyOps` 与 `buildFromEmpty` 共用）：位置由调用方处理。 */
function applyCellOp(op: Op, byId: ReadonlyMap<string, Block>): void {
  if (op.e === 'prop') {
    const block = byId.get(op.block)
    if (!block) return
    const props = { ...(block.props ?? {}) }
    if (op.op === 'delete') delete props[op.name]
    else props[op.name] = op.value
    // 属性袋不留空壳：`{}` 与「没有属性」是两种东西
    if (Object.keys(props).length === 0) delete block.props
    else block.props = props
    return
  }
  if (op.e === 'anno') {
    const block = byId.get(op.block)
    if (!block) return
    const list = [...(block.annos ?? [])]
    const i = list.findIndex((x) => x.id === op.id)
    if (op.op === 'delete') {
      if (i >= 0) list.splice(i, 1)
    } else if (i >= 0 && op.value) list[i] = op.value
    else if (op.value) list.push(op.value)
    block.annos = list.length === 0 ? undefined : list
    return
  }
  if (op.e !== 'block') return

  const block = byId.get(op.id)
  if (!block) return
  if (op.op === 'exist') {
    if (op.state === 'purged') return
    const props = { ...(block.props ?? {}) }
    if (op.state === 'deleted') props[DELETED_AT_PROP] = op.at
    else delete props[DELETED_AT_PROP]
    if (Object.keys(props).length === 0) delete block.props
    else block.props = props
    return
  }
  if (op.value.created !== undefined) block.created = op.value.created
  if (op.value.content !== undefined) block.content = op.value.content
  if (op.value.modified !== undefined) block.modified = op.value.modified
}

/** **从空森林重放整条日志。** `replay(log)` 与当前状态逐字节相等，是「日志完整」的定义。 */
export function replay(ops: readonly Op[]): Block[] {
  const forest: Block[] = []
  applyOps(forest, ops)
  return forest
}

/* ------------------------------------------------------------ 小工具 */

/** 含被删块的遍历找块（可见遍历看不见软删的块） */
function findAnywhere(forest: readonly Block[], id: string): Block | undefined {
  let hit: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id !== id) return
      hit = b
      return false
    },
    { includeDeleted: true },
  )
  return hit
}

/**
 * 从树上摘掉一块（不管它在哪一层、是不是被软删的）。
 *
 * ⚠️ 走 `walkForest`（块树遍历的唯一入口，`arch-check [22]`）：自己不递归 `children`。
 *    先试顶层，再逐层试 —— 两次都只「找容器」，不边遍历边改结构。
 */
function removeFromTree(forest: Block[], id: string): void {
  const detach = (children: Block[]): boolean => {
    const i = children.findIndex((b) => b.id === id)
    if (i < 0) return false
    children.splice(i, 1)
    return true
  }
  if (detach(forest)) return
  walkForest(
    forest,
    (b) => {
      if (detach(b.children)) return false
    },
    { includeDeleted: true },
  )
}

/**
 * 把块放到 `(parentId, prev)` 这个位置。
 *
 * - **父不存在** ⇒ 抛错：完整日志里父一定先于子；静默落到顶层会把子树挂错地方，且不报错。
 * - **前兄弟不存在** ⇒ 落该层首位：这是 `BlockPatch.prev` 写明的确定性兜底
 *   （软删不搬位置，所以被删的前兄弟仍是合法锚点；只有 purge 或缺口会让它消失）。
 *
 * ⚠️ 遍历一律走 `walkForest`（块树遍历的唯一入口，`arch-check [22]`）——
 *    这里要「改树」，所以先把「摘掉」与「找落点」拆成两次走，中间不改结构。
 */
function placeAt(forest: Block[], block: Block, parentId: string | null, prev: string | null): void {
  // 先摘（同一层内换位时，不摘会让下标算错）
  removeFromTree(forest, block.id)

  const parent = parentId === null ? null : findAnywhere(forest, parentId)
  if (parentId !== null && !parent) {
    throw new Error(`kb: replay: missing parent "${parentId}" for block "${block.id}"`)
  }
  const siblings: Block[] = parent ? parent.children : forest

  if (prev === null) {
    siblings.unshift(block)
    return
  }
  const i = siblings.findIndex((b) => b.id === prev)
  // 前兄弟不在了 ⇒ 落该层首位，与 `BlockPatch.prev` 同一条口径
  siblings.splice(i < 0 ? 0 : i + 1, 0, block)
}

/* ------------------------------------------------------------ 断言用 */

/** 递归把对象键排序（数组顺序保留：数组是内容，对象键序不是） */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v !== null && typeof v === 'object') {
    const src = v as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = canonical(src[k])
    return out
  }
  return v
}

/**
 * 供断言用：一份森林的可比较投影。
 *
 * 先序 ＋ 规范化键序，所以「从日志重放」与「直接构造」可以逐字节比 ——
 * 即使两条路径给属性键的插入顺序不同（键序不是语义）。
 */
export function forestFingerprint(forest: readonly Block[]): string {
  const out: unknown[] = []
  walkForest(forest, (b) => void out.push(canonical(b)), { includeDeleted: true })
  return JSON.stringify(out)
}
