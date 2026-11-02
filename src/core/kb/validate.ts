/**
 * **`validate`：在任何写入之前回答「这一批 op 能不能应用」。**
 *
 * ## 为什么它是原子性的前提
 *
 * 原子性来自「先算后写」，不来自「快照后恢复」：
 * 校验覆盖**已知非法**（父不存在、成环、格名不对、值形状不对），回滚日志覆盖**未知非法**（意外抛错）。
 * 两者分工明确，而快照是最后一道兜底 —— 不是第一道。
 *
 * ## 它顺带是同步收端的前提
 *
 * 对端的 op 流必须先**验**再吃：不验就应用，一次坏流会让本地库变成一坨没法解释的状态，
 * 而且「哪一条坏了」也无从定位。同一个函数服务两条路（本地事务 / 远端流）。
 *
 * ## 成本口径：O(ops)，不是 O(库)
 *
 * 森林只按需摊平（第一次需要 `byId`／父表时才走一遍），值判据（⑤）是纯 per-op 的、
 * 完全不碰森林。打字路径**不经过这里**（tx 的产出在发看点已验，`kb/diff.ts`）；
 * 走到这里的是撤销/回放/远端流——撤销本来就陪着一次 O(库) 的 `diff`，多一遍同量级遍历不改变量级。
 *
 * ## 判据（每一条都能被独立推翻，`tests/kb-validate.test.ts` 钉住）
 *
 * | # | 非法形状 | 为什么必须拒 |
 * |---|---|---|
 * | ① | 父不存在（且不是「重放到一半」的中间态） | 落库会得到「父块不存在」的孤儿，下次装载自己冒出来 |
 * | ② | 移进自己的子树 | 成环 ⇒ 整棵树从那一点起读不出来（`walkForest` 会无限递归或截断） |
 * | ③ | 格名是 `''` | 空的属性名在落盘时没有地址（`BlockProperty` 的主键含 `name`） |
 * | ④ | `prop.set` 的值是 `undefined` | 「有槽无值」与「没有这一格」是两件事，混起来派生层会给两种答案 |
 * | ⑤ | 系统键的值形状不对／键未登记 | 判据只有一份（`core/system-props.ts`），收端放行一条坏值，本地两台设备就会各自解释 |
 * | ⑥ | 往身份块／只读类型的正文里写 content | 正文是名字或投影（`canWriteText` 判据）——收端不拦，一次坏流就是一次静默改名 |
 *
 * ⚠️ 本文件零 DOM、零持久化：它只读森林，所以能直接单测。
 */
import { walkForest } from '../model/walk.ts'
import type { Block } from '../model/model.ts'
import { canWriteText } from '../model/types.ts'
import { systemPropViolation } from '../props/system-props.ts'
import type { Op } from './types.ts'

/** 一条非法：给人看的一句话 ＋ 定位（哪个 op、哪一块） */
export interface Violation {
  /** op 在批里的下标（`-1` ＝ 不属于某一条 op，而是整批的问题） */
  index: number
  /** 出问题的块 id（没有具体块时为 `null`） */
  blockId: string | null
  /** 为什么非法（英文：这是开发者日志与断言用的，不是用户文案） */
  reason: string
}

/**
 * **校验一批 op**。返回空数组 ＝ 可以应用。
 *
 * @param forest 应用前的森林（含被软删的块：位置 op 可能指向它们）
 * @param ops    待应用的一批
 */
export function validate(forest: readonly Block[], ops: readonly Op[]): Violation[] {
  const out: Violation[] = []

  /**
   * **惰性摊平**：森林里有哪些块、各挂在哪。只在批里出现「需要看森林的规则」
   * （①②⑥）时才走这一遍；纯值判据的批（⑤③④）一个块都不碰。
   */
  let byIdCache: Map<string, Block> | null = null
  let parentOfCache: Map<string, string | null> | null = null
  const tables = (): { byId: Map<string, Block>; parentOf: Map<string, string | null> } => {
    if (byIdCache === null || parentOfCache === null) {
      byIdCache = new Map()
      parentOfCache = new Map()
      walkForest(
        forest,
        (b, ctx) => {
          byIdCache!.set(b.id, b)
          parentOfCache!.set(b.id, ctx.parent?.id ?? null)
        },
        { includeDeleted: true },
      )
    }
    return { byId: byIdCache, parentOf: parentOfCache }
  }

  /** 本批里新出现的块（父可能是同批的块 ⇒ 判父存在时要算上它们） */
  const introduced = new Set<string>()
  for (const op of ops) if (op.e === 'block' && op.op === 'upsert' && op.value.parent !== undefined) introduced.add(op.id)

  /**
   * **祖先判据**：从 `nodeId` 沿父链往上（O(depth)）。
   * ⚠️ 不用索引：校验发生在**任何写入之前**，此刻索引还没修补过这一批 ——
   *    拿它判会把「同批的父子」判错。父表按当前森林现算。
   */
  const isAncestorOf = (candidate: string, nodeId: string): boolean => {
    const { parentOf } = tables()
    let cur: string | null = nodeId
    let guard = 0
    while (cur !== null && guard++ < 1024) {
      if (cur === candidate) return true
      cur = parentOf.get(cur) ?? null
    }
    return false
  }

  for (const [i, op] of ops.entries()) {
    if (op.e === 'block') {
      if (op.op === 'upsert') {
        /**
         * **⑥ 内容闸（op 级）**：往一个**已存在**的身份块／只读类型块里写 content。
         * 「块不存在」＝ 新块 genesis，内容随构造给定，不拦。
         */
        if (op.value.content !== undefined) {
          const pre = tables().byId.get(op.id)
          if (pre && !canWriteText(pre)) {
            out.push({ index: i, blockId: op.id, reason: 'content is protected (journal/prop-def/query/readonly text)' })
          }
        }
        const parentId = op.value.parent
        if (parentId !== undefined) {
          if (parentId !== null && !tables().byId.has(parentId) && !introduced.has(parentId)) {
            out.push({ index: i, blockId: op.id, reason: `parent "${parentId}" does not exist` })
            continue
          }
          /**
           * **成环**：`op.id` 不能是自己的祖先。
           * 判据走「从父往上找」，不扫全库：O(depth)，且只在结构 op 上跑（不是打字路径）。
           */
          if (parentId !== null && isAncestorOf(op.id, parentId)) {
            out.push({ index: i, blockId: op.id, reason: `cannot place "${op.id}" inside its own subtree` })
          }
        }
      }
      continue
    }
    if (op.e === 'prop') {
      if (op.name === '') {
        out.push({ index: i, blockId: op.block, reason: 'empty prop name has no address' })
        continue
      }
      /**
       * `prop.set` 的值不能是 `undefined`：`{name: undefined}` 与「没有这一格」在
       * `JSON.stringify` 之后是同一个字节，但在模型里是两种东西（`exists` 条件要区分它们）。
       * 想摘掉这一格 ⇒ 用 `prop.delete`。
       */
      if (op.op === 'set' && op.value === undefined) {
        out.push({ index: i, blockId: op.block, reason: `prop "${op.name}" set to undefined — use delete` })
        continue
      }
      /**
       * **⑤ 系统键的值形状**（`core/system-props.ts` 的同一张表）：本地 tx 的产出
       * 在发看点已验过，这里拦的是远端流／历史日志里的坏值与未登记键。
       */
      if (op.op === 'set') {
        const why = systemPropViolation(op.name, op.value)
        if (why) out.push({ index: i, blockId: op.block, reason: why })
      }
      continue
    }
  }
  return out
}
