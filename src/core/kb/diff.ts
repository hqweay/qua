/**
 * **`diff`：把「从 a 变成 b」这件事表达成一批 op。**
 *
 * ## 为什么需要它
 *
 * 撤销今天不是一次写入，是一次**旁路**：`BlockStore.restore` 把整片森林换成快照里那份
 * （`JSON.parse` + `splice`），于是落盘层只能靠一个计数器（`replacementCount`）猜
 * 「这批必须整份写」⇒ 每次 ⌘Z 都是「清四表 + 整库重写」。
 *
 * 而「库变成了另一份」本来就是可以表达成 op 的：op 说的是**每一格现在是什么**。
 * 补齐这个函数之后，撤销就是 `apply(diff(当前, 快照))` —— 与一次普通编辑走同一条路。
 *
 * ## 它不推翻任何已定口径
 *
 * **快照仍是唯一真相**：输入是两份森林，输出只是「怎么走」。这**不是逆 op**
 * （逆 op 是「撤销语义的第二份正确性来源」，已在 `kb/memory.ts` 文件头否决）。
 * 与 `HANDOFF 120.3` 的 `lastOpPositions` 同一条判据：**读侧派生不产生第二份真相**。
 *
 * ## 四条必须成立的性质（`tests/kb-diff.test.ts` 逐条钉住）
 *
 * 1. **等式**：`apply(a, diff(a, b))` 与 `b` **逐字节相等**。
 * 2. **完备**：`diff(x, x)` ＝ `[]`（未变的不发 op）。
 * 3. **顺序**：发射序 ＝ 目标森林的**先序**（父 op 先于子 op）—— `HANDOFF 120.2 ④`
 *    登记的「子树 op 隐含拓扑序」在这里兑现。
 * 4. **时刻**：`at` 从**目标**森林派生（不取 `Date.now()`）。否则同一次撤销重放两次
 *    会得到不同的字节，第 1 条当场失效。
 *
 * ⚠️ 本文件零 DOM、零持久化、零 store：它只吃两片森林，所以能直接单测。
 */
import type { Block } from '../model.ts'
import { walkForest } from '../walk.ts'
import type { Op } from './types.ts'

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

/** 值比较：数组/对象也比内容（键序不承载语义，所以按 JSON 比是够的——两边的来源同一套） */
function same(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** 一块的「时刻」：`at` 从这个字段派生（不是 `Date.now()`，见文件头第 4 条） */
const stampOf = (b: Block): number => b.modified

/**
 * **把 `from → to` 表达成一批 op**。
 *
 * 输出只含三种种类（`block`／`prop`／`anno`）—— 一格一个地址（见 `kb/types.ts` 的 `Op`）。
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
   * ⚠️ 顺序：先发清除，再发 upsert。否则「同一块先在 to 里、又在 from 里」这种
   *    不存在的形状会被后来的 op 覆盖掉（这里显式写出来，免得读代码的人以为顺序无所谓）。
   */
  for (const block of a.order) {
    if (b.inTree.has(block.id)) continue
    ops.push({ e: 'block', id: block.id, op: 'delete', at: stampOf(block) })
  }

  /**
   * **按目标森林的先序发射**（父先于子）：子树 op 隐含拓扑序（`HANDOFF 120.2 ④`）。
   * 用 `to` 的 `order` 而不是 `from` 的：目标才是「应该长成什么样」。
   */
  for (const block of b.order) {
    const old = a.byId.get(block.id)
    const wasInTree = a.inTree.has(block.id)

    /**
     * **位置**：新建（不在起点树里）或移动（父/前兄弟变了）都要报。
     * 落点从**目标**森林现算（`b.parent`／`b.prev`）—— op 只记「它现在挂在哪」。
     */
    const moved = !wasInTree || a.parent.get(block.id) !== b.parent.get(block.id) || a.prev.get(block.id) !== b.prev.get(block.id)
    if (moved) {
      ops.push({
        e: 'block',
        id: block.id,
        op: 'upsert',
        value: { parent: b.parent.get(block.id) ?? null, prev: b.prev.get(block.id) ?? null },
        at: stampOf(block),
      })
    }

    if (!old) continue // 新建块：位置 op 已带上它，属性与内容随整块落库

    /**
     * **正文**：整组替换（run 序列是「一组事实」）。时刻并进同一条 op ——
     * 一次改动是一条账，多一条属性写账本就会翻倍（与 `Tx.patch` 同一条口径）。
     */
    const contentChanged = !same(old.content, block.content)
    const timeChanged = old.modified !== block.modified
    if (contentChanged || timeChanged) {
      ops.push({
        e: 'block',
        id: block.id,
        op: 'upsert',
        value: { ...(contentChanged ? { content: block.content } : {}), ...(timeChanged ? { modified: block.modified } : {}) },
        at: stampOf(block),
      })
    }

    /**
     * **属性**：按**格**比（一个格一条 op）。这里不按整袋报：
     * `prop` op 的地址是 `block:<id>.prop:<name>`，整袋报会让「改一格」变成「写 N 格」。
     */
    const aProps = old.props ?? {}
    const bProps = block.props ?? {}
    for (const name of Object.keys(bProps)) {
      if (name in aProps && same(aProps[name], bProps[name])) continue
      ops.push({ e: 'prop', block: block.id, name, op: 'set', value: bProps[name], at: stampOf(block) })
    }
    for (const name of Object.keys(aProps)) {
      if (name in bProps) continue
      ops.push({ e: 'prop', block: block.id, name, op: 'delete', at: stampOf(block) })
    }

    /**
     * **annos**：按 anno id 一条一格。
     * ⚠️ 落库侧会把它收成一整列（`db-rows.ts` 的 `anno` 分支）—— 那是**投影的粗粒度**，
     *    不是代数里有两套地址。代数必须按条，因为「哪一条被引用了」是逐条的事实。
     */
    const aAnnos = new Map((old.annos ?? []).map((x) => [x.id, x]))
    const bAnnos = new Map((block.annos ?? []).map((x) => [x.id, x]))
    for (const [aid, anno] of bAnnos) {
      const prevAnno = aAnnos.get(aid)
      if (prevAnno && same(prevAnno, anno)) continue
      ops.push({ e: 'anno', block: block.id, id: aid, op: 'set', value: anno, at: stampOf(block) })
    }
    for (const [aid, anno] of aAnnos) {
      if (bAnnos.has(aid)) continue
      ops.push({ e: 'anno', block: block.id, id: aid, op: 'delete', value: anno, at: stampOf(block) })
    }
  }

  return ops
}

/**
 * **把 op 应用到一片森林**（`diff` 的逆运算）。
 *
 * 两条硬口径：
 *
 * 1. **原地写格、保持未动块的对象身份**。索引存的是块的**活引用**（`index-port.ts` 文件头）；
 *    若这里替换块对象（CoW／`JSON.parse`），索引会静默失效 —— 它手里那批对象当场过期，
 *    而没有任何一层会报错。所以「换一片森林」不是这个函数做的事。
 * 2. **需要「重新出现」的块从 `source` 里取**（撤销的 `source` ＝ 目标快照那份森林）。
 *    只给 op 是不够的：`block.upsert{parent,prev}` 只说「它挂在哪」，
 *    块的内容与属性在目标那份森林里 —— 那也是「快照仍是唯一真相」的落地方式。
 *
 * @param forest 要改的森林（原地改）
 * @param ops    `diff` 的输出（或任何同形状的一批 op）
 * @param source 目标森林（用来取「要重新出现的块」；省略 ⇒ 不处理这类 op）
 */
export function applyOps(forest: Block[], ops: readonly Op[], source?: readonly Block[]): void {
  const srcById = new Map<string, Block>()
  if (source) walkForest(source, (b) => void srcById.set(b.id, b), { includeDeleted: true })

  /** ① **清除**：块从树上消失（不是软删 —— 软删走 `prop.delete(_deletedAt)`）。 */
  for (const op of ops) {
    if (op.e !== 'block' || op.op !== 'delete') continue
    removeFromTree(forest, op.id)
  }

  /** ② **位置**：按 op 顺序逐条落（同父多条时，后一条依赖前一条已就位）。 */
  for (const op of ops) {
    if (op.e !== 'block' || op.op !== 'upsert') continue
    const parentId = op.value.parent
    if (parentId === undefined) continue
    // 块可能不在树上（撤销一次清除 ⇒ 它要回来）⇒ 从 `source` 取一份（深拷：不改快照那份）
    let block = findAnywhere(forest, op.id)
    if (!block) {
      const orig = srcById.get(op.id)
      if (!orig) continue
      block = JSON.parse(JSON.stringify(orig)) as Block
    }
    placeAt(forest, block, parentId, op.value.prev ?? null)
  }

  /** ③ **格**：正文／时刻／属性／annos（原地写，对象身份不变）。 */
  const byId = new Map<string, Block>()
  walkForest(forest, (b) => void byId.set(b.id, b), { includeDeleted: true })
  for (const op of ops) {
    if (op.e === 'prop') {
      const block = byId.get(op.block)
      if (!block) continue
      const props = { ...(block.props ?? {}) }
      if (op.op === 'delete') delete props[op.name]
      else props[op.name] = op.value
      // 属性袋不留空壳：`{}` 与「没有属性」是两种东西
      if (Object.keys(props).length === 0) delete block.props
      else block.props = props
      continue
    }
    if (op.e === 'anno') {
      const block = byId.get(op.block)
      if (!block) continue
      const list = [...(block.annos ?? [])]
      const i = list.findIndex((x) => x.id === op.id)
      if (op.op === 'delete') {
        if (i >= 0) list.splice(i, 1)
      } else if (i >= 0 && op.value) list[i] = op.value
      else if (op.value) list.push(op.value)
      block.annos = list.length === 0 ? undefined : list
      continue
    }
    if (op.e === 'block' && op.op === 'upsert') {
      const block = byId.get(op.id)
      if (!block) continue
      if (op.value.content !== undefined) block.content = op.value.content
      if (op.value.modified !== undefined) block.modified = op.value.modified
    }
  }
}

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
 * 把块放到 `(parentId, prev)` 这个位置（父不存在 ⇒ 落到顶层末尾，与 `BlockPatch.prev` 的
 * 悬空兜底同一条口径：**宁可放到可预期的位置，也不要静默夹取**）。
 *
 * ⚠️ 遍历一律走 `walkForest`（块树遍历的唯一入口，`arch-check [22]`）——
 *    这里要「改树」，所以先把「摘掉」与「找落点」拆成两次走，中间不改结构。
 */
function placeAt(forest: Block[], block: Block, parentId: string | null, prev: string | null): void {
  // 先摘（同一层内换位时，不摘会让下标算错）
  removeFromTree(forest, block.id)

  /**
   * 目标列表：`parentId === null` ⇒ 顶层；否则找那一块的 `children`。
   * 走 `walkForest`（唯一遍历入口）—— 只读不写，改结构留给下面。
   */
  const siblings: Block[] = parentId === null ? forest : (findAnywhere(forest, parentId)?.children ?? forest)

  if (prev === null) {
    siblings.unshift(block)
    return
  }
  const i = siblings.findIndex((b) => b.id === prev)
  // 前兄弟不在了（含「父也不在了」的兜底）⇒ 落该层首位，与 `BlockPatch.prev` 同一条口径
  siblings.splice(i < 0 ? 0 : i + 1, 0, block)
}


/** 供断言用：一份森林的可比较投影（键序稳定，所以能逐字节比） */
export function forestFingerprint(forest: readonly Block[]): string {
  const out: unknown[] = []
  walkForest(forest, (b) => void out.push(b), { includeDeleted: true })
  return JSON.stringify(out)
}
