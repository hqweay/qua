/**
 * **阶段 1（整库在内存）的接库实现**：把「整片森林」收进一个对象，
 * 读写都经它走，从而让读面只有一个入口、写面只有一个事务。
 *
 * 三条实现取舍，都是**为将来换实现留的位**，不是现在就需要的复杂度：
 *
 * 1. **读面只转调 `core/` 的纯函数**（`findInForest`／`fieldRows`／`gutterFieldsFor`／
 *    `tagsOf`／`findByAlias`／`runQuery`／`backrefsOf`）。派生逻辑一旦在这里重写一遍，
 *    就会有两份「这条属性该不该显示」「这个标签算不算成员」的答案 —— 而它们能不一致。
 * 2. **写面先把内存改完，再产出 op**：`tx` 成功才交付 `{ ops, changes, undo }`；
 *    失败按回滚日志整批恢复。不做逆 op：逆 op 是「同一件事的第二个正确性来源」，
 *    早晚与正路径分叉。撤销条目存的是**状态**（前态／后态），不是「怎么退回去」。
 * 3. **结构不作 diff**：`patch` 只看正文、改动时刻与属性；子树变化一律抛错，逼调用方显式
 *    `insert`／`move`／`remove`。结构若靠 diff 猜，删掉的整棵后代就会凭空消失
 *    —— 不报错，只是数据少了一截。
 *
 * ⚠️ 本文件零 DOM、零持久化：op 只是被**算出来**，谁来落盘由上层决定。
 */
import { backrefBlocks, backrefsOf, type BackrefBlock, type BackrefSource } from '../relations/backrefs.ts'
import type { RelationEdge } from '../relations/relations.ts'
import { aliasesOf, DELETED_AT_PROP, hasList, isDeleted, type Block } from '../model/model.ts'
import { findInForest, trashOf } from '../model/tree.ts'
import { walkForest } from '../model/walk.ts'
import { findTagByName, tagsOf as tagsOfBlock } from '../identity/tags.ts'
import { isPropDef } from '../props/props.ts'
import { findJournalDay } from '../identity/journal.ts'
import { blockIdByAlias, indexPathOf, queryByIndex, relationsFrom, relationsTo } from '../infra/index-port.ts'
import {
  declaredFields,
  fieldRowsWithParent,
  gutterFieldsFor,
  type FieldRow,
  type GutterField,
  setValue,
  clearValue,
} from '../props/props.ts'
import type { QueryHit, QuerySpec } from '../query/query.ts'
import type { BlockStore } from '../model/store.ts'
import { changesOf } from './changes.ts'
import { applyOps, cellsOf, diffTouched, type BeforeBlock, type Placement, type TouchedBlock } from './diff.ts'
import { captureOf } from './scoped.ts'
import type { UndoCapture } from './scoped.ts'
import type { KbClient, Op, PathEntry, Tx, TxOpts, TxResult } from './types.ts'
import type { Anno } from '../model/runs.ts'

/** 按含**被删块**的遍历找块（可见遍历看不见它们；恢复路径用） */
function findIncludingDeleted(forest: readonly Block[], id: string): Block | undefined {
  let hit: Block | undefined
  walkForest(
    forest,
    (b) => {
      if (b.id === id) {
        hit = b
        return false
      }
    },
    { includeDeleted: true },
  )
  return hit
}

/** 一层的兄弟列表；`null` 父 ⇒ 森林顶层 */
function siblings(store: BlockStore, parentId: string | null): Block[] | undefined {
  if (parentId === null) return store.blocks
  // 同 `get`：索引优先，miss 退回遍历（批内刚建出来的父块还不在索引里）
  const p = store.find(parentId) ?? findInForest(store.blocks, parentId)
  return p?.children
}

/** 子树里的全部块（先序，**含自身**）—— 成环检查用 */
function subtreeIds(block: Block): string[] {
  const out: string[] = []
  walkForest([block], (b) => {
    out.push(b.id)
  })
  return out
}

/** 深拷贝（活动对象之间共享引用：改内存不能改到快照里那份） */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

export class MemoryKb implements KbClient {
  private readonly store: BlockStore
  private readonly now: () => number

  constructor(store: BlockStore, opts: { now?: () => number } = {}) {
    this.store = store
    // 时间注入只为让「op 带 at」可断言；默认就是墙钟
    this.now = opts.now ?? (() => Date.now())
  }

  /* ------------------------------------------------------------ 读面 */

  /**
   * 按 id 取块：**先走索引（O(1)），miss 才退回全树可见遍历**。
   *
   * 为什么不能只信索引：事务是「先改内存、出口才修补索引」——同一笔里刚插入的块
   * 还不在索引表里。为什么不能只走遍历：`Tx` 的每个方法都 `require` 一次，
   * 而一次按键改的是第几块由用户决定（100k 库改中间一块 ≈ 1ms，全花在这次遍历上）。
   */
  get(id: string): Block | undefined {
    return this.store.find(id) ?? findInForest(this.store.blocks, id)
  }

  children(id: string): readonly Block[] {
    return this.get(id)?.children ?? []
  }

  roots(): readonly Block[] {
    return this.store.blocks
  }

  parentOf(id: string): Block | undefined {
    const parentId = this.store.index.parentOf.get(id)
    if (parentId === undefined || parentId === null) return undefined
    return this.store.index.blocks.get(parentId)
  }

  pathOf(id: string): readonly Block[] {
    return indexPathOf(this.store.index, id)
  }

  /**
   * 按地址找块 —— **走索引**（`aliases` 表），不遍历森林。
   *
   * 与 `findByAlias` 同一条口径（规范化同一份、先序第一个赢）；差别只在成本：
   * 遍历是 O(整库)（50000 块 ≈ 1.1ms），而 `@` 补全每敲一个字都要问一次。
   *
   * ⚠️ 索引里存的是 **id**：拿块要再 `find(id)` —— 索引的块表是活引用，但
   *    「地址 → id」这一格是快照，改名/删块由 `refreshTagsClaim`／`applyBlockDelete` 修补。
   */
  resolveAlias(name: string): Block | undefined {
    const id = blockIdByAlias(this.store.index, name)
    return id === undefined ? undefined : this.store.find(id)
  }

  allPaths(): readonly PathEntry[] {
    // 只收真的能用 `[[名字]]` 指到的（先序第一个认领者）；**走索引**，不逐块 `findByAlias`
    // （后者是 O(整库)，10,000 块时会退化成 O(n²)：实测 12.4s）
    const out: PathEntry[] = []
    walkForest(this.store.blocks, (b) => {
      const name = aliasesOf(b)[0]
      if (name !== undefined && blockIdByAlias(this.store.index, name) === b.id) out.push({ name, block: b })
    })
    return out
  }

  fieldsOf(id: string): readonly FieldRow[] {
    const b = this.get(id)
    if (!b) return []
    // 面板与属性行同一口径：父块声明了 `_childProps` ⇒ 面板里也见得到（否则点了那行没处聚焦）
    return fieldRowsWithParent(b, this.store.blocks, this.parentOf(id) ?? null, this.store.index.blocks)
  }

  gutterFieldsOf(ids: readonly string[]): Map<string, GutterField[]> {
    const blocks = ids.map((id) => this.get(id)).filter((b): b is Block => b !== undefined)
    return gutterFieldsFor(blocks, this.store.blocks)
  }

  tagsOf(id: string): readonly Block[] {
    const b = this.get(id)
    return b ? tagsOfBlock(b, this.store.blocks) : []
  }

  propDefs(): readonly Block[] {
    // **库里的定义块**（引擎合成定义不进：它不是库对象，没有定义页；
    // 重名校验、新建集合、清单都以这一份为准）。行构造处的 defs 表吃
    // `allPropDefs`（含引擎），两份清单各自回答自己的问题。
    const out: Block[] = []
    walkForest(this.store.blocks, (b) => {
      if (isPropDef(b)) out.push(b)
    })
    return out
  }

  declaredFieldsOf(id: string): readonly Block[] {
    const b = this.get(id)
    return b ? declaredFields(b, this.store.blocks) : []
  }

  pages(): readonly Block[] {
    const out: Block[] = []
    walkForest(this.store.blocks, (b) => {
      if (hasList(b, 'page')) out.push(b)
    })
    return out
  }

  tags(): readonly Block[] {
    const out: Block[] = []
    walkForest(this.store.blocks, (b) => {
      if (hasList(b, 'tag')) out.push(b)
    })
    return out
  }

  trash(): readonly Block[] {
    return trashOf(this.store.blocks)
  }

  purgeTrash(ids: readonly string[]): readonly Op[] {
    /**
     * 按**含被删块**的读面找（可见遍历看不见它们）。只认带删除标记的块：
     * 回收站列的就是这些；没带标记的 id（活动块）不在这里清——清它该先删进回收站。
     */
    const lookup = this.store.undoLookup()
    /** 已发过 op 的块：嵌套条目（子树里另有带标记的后代）不重复发 */
    const covered = new Set<string>()
    const ops: Op[] = []
    for (const id of ids) {
      const root = lookup.get(id)
      if (!root || !isDeleted(root) || covered.has(id)) continue
      /**
       * 每条根的**整棵子树**都要一条 op（含不带标记的后代）——清除按结构级联，
       * 子块若没有自己的账，重放时它就是「挂在已消失的父下」的孤儿。
       * 子先于父（与撤销捕获的清除序同一纪律）：父先退场，子块的落点就补不回来了。
       */
      const subtree: Block[] = []
      walkForest(
        [root],
        (b) => {
          subtree.push(b)
        },
        { includeDeleted: true },
      )
      for (let i = subtree.length - 1; i >= 0; i--) {
        const b = subtree[i]!
        if (covered.has(b.id)) continue
        covered.add(b.id)
        ops.push({ e: 'block', id: b.id, op: 'exist', state: 'purged', at: this.now() })
      }
    }
    if (ops.length === 0) return []

    /**
     * 与撤销/重做同形（不进 `Tx`，见 `KbClient.purgeTrash` 的说明）：
     * 原地应用、出口宣布（索引按 op 修补、订阅者按 op 重画），
     * op 交调用方落盘。`source` 不传：这不是某台编辑器的编辑，所有视图都该跟。
     */
    applyOps(this.store.blocks, ops, lookup)
    this.store.apply(ops)
    return ops
  }

  findTag(name: string): Block | undefined {
    return findTagByName(this.store.blocks, name)
  }

  journalDay(date: string): Block | undefined {
    return findJournalDay(this.store.blocks, date)
  }

  /**
   * 库里存在哪几天（升序）。
   *
   * 走索引的 `journals` 表，不是遍历森林：日历一屏要问几十天，
   * 而 `journalDay` 每次都会重建一张「日期 → 块」表。
   */
  journalDates(): readonly string[] {
    return [...this.store.index.journals.keys()].sort()
  }

  annosOf(id: string): readonly Anno[] {
    return this.get(id)?.annos ?? []
  }

  query(
    spec: QuerySpec,
    opts: { selfId?: string; excludeIds?: readonly string[]; today?: string } = {},
  ): QueryHit[] {
    // 走索引：ref/tag/journal 查表，判定与顺序与纯函数路径共用一份
    return queryByIndex(this.store.index, this.store.blocks, spec, {
      selfId: opts.selfId,
      excludeIds: opts.excludeIds,
      ...(opts.today ? { today: opts.today } : {}),
    })
  }

  backlinksOf(id: string): readonly BackrefSource[] {
    return backrefsOf({ blocks: this.store.blocks, targetId: id, index: this.store.index })
  }

  backrefBlocksOf(id: string): readonly BackrefBlock[] {
    return backrefBlocks({ blocks: this.store.blocks, targetId: id, index: this.store.index })
  }

  relationsTo(id: string): readonly RelationEdge[] {
    return relationsTo(this.store.index, id)
  }

  relationsFrom(id: string): readonly RelationEdge[] {
    return relationsFrom(this.store.index, id)
  }

  /* ------------------------------------------------------------ 写面 */

  /**
   * 一次事务：成功后交付 `{ ops, changes }`，抛错则**整批回滚**并重抛。
   *
   * ## 回滚成本只与「动过的块」有关
   *
   * 曾经这里进门就 `JSON.stringify(整片森林)`，失败时再 `JSON.parse` 回来 ——
   * 于是**每一次事务**（一次打字就是一次事务）都要整库序列化一遍。
   * 现在改成**回滚日志**：每个 `Tx` 方法在改之前记一条「怎么退回去」，
   * 失败时逆序应用。生命周期＝这一个调用，出门即丢。
   *
   * ⚠️ **回滚日志不是逆 op**。逆 op 是「撤销语义的第二份正确性来源」（文件头已否决）；
   *    这里是**一次事务内部**的异常安全机制：不落盘、不进历史、不参与同步。
   *    它替换掉的是一个实现细节（整库快照）；对外语义（失败整批回滚、不返回半批）不变。
   *
   * ## 校验在哪
   *
   * `Tx` 的每个方法在**改之前**校验自己的前置条件（`require` 查块在不在、
   * `siblings` 查父在不在、`move` 查不成环）—— 那是「已知非法」的防线，也是今天的现状。
   * 另一道 `validate(state, ops)` 服务**重放**（同步收端／`applyOps`）：对端的流必须先验再吃。
   * 两者不是重复：前者管「这次能不能写」，后者管「这批 op 能不能应用在别的库上」。
   *
   * ## `undo` 只交付、不记账
   *
   * 返回的 `UndoCapture` 交给**调用方**收集（编辑器把一次动作的多笔写并成一条撤销条目，
   * `store.record` 由装配层调）——`kb.tx` 自己不碰撤销栈。给模型层写撤销测试时
   * 别假设「tx 跑完栈里就有了」：要么走编辑器路径（冒烟），要么在测试里手动
   * `store.record(r.undo, …)` 再 `store.undo`——否则那条「撤销会／不会怎样」的断言恒真。
   */
  tx<R>(fn: (tx: Tx) => R, opts: TxOpts = {}): TxResult & { result: R; undo: UndoCapture } {
    /** 动过的块：改前快照（新块为 `null`）＋ 改后落点。出口处一次性比出 op。 */
    const touched = new Map<string, TouchedBlock>()
    /** 回滚日志：逆序应用的「怎么退回去」 */
    const rollback: (() => void)[] = []
    /**
     * **本事务内的父指针覆盖**：`store.index.parentOf` 是**事务出口**才更新的快照，
     * 同一笔里搬了 A 再搬 A 时，`Tx.move` 会按旧父去摘 —— 摘错列表，实测能把目标父
     * 自己从树上摘掉（整棵子树凭空消失）。这里按「本事务已经改过的父」覆盖一层，
     * 只覆盖动过的块，成本与库体量无关；出口 `store.apply(ops)` 仍按 op 重建索引。
     */
    const parentOverride = new Map<string, string | null>()
    try {
      const result = fn(this.makeTx(touched, rollback, parentOverride))
      /**
       * **op 只在出口产生**：`diffTouched` 只比动过的块，成本与库体量无关。
       * 每个 `Tx` 方法只改内存，不再各自 `ops.push` —— 完备性由构造保证：
       * 新加一个方法的人没有地方可以「忘记发 op」。
       */
      const ops = diffTouched(touched.values(), { directEdit: opts.directEdit })
      const changes = changesOf(ops)
      /**
       * **撤销捕获在出口取，且立刻深拷**（`captureOf` 里做）。
       *
       * `touched` 的 `block` 是活引用：事务返回后下一次编辑就会改它。
       * 条目要是只记引用，⌘Z 拿到的是「后来那份」——与 `pendingOps` 那条 250ms 的坑同源。
       * 成本只与 touched 有关，和库体量无关；这也正是收窄撤销作用域的前提。
       */
      const undo = captureOf(touched.values(), opts.directEdit === true)
      /**
       * **宣布只在这里发生**：`store.apply` 是状态转移的唯一入口 ——
       * 它同时做「按 op 修补索引」与「通知订阅者」两件事。
       *
       * 为什么必须在出口：失败路径不宣布（模型退回原样，别的视图本该看到的还是那份）；
       * 而成功的这一批 op 说清了「变了哪几格」，所以索引只修补、不作废。
       * 调用方（编辑器／命令）**不得**再自己宣布（那会让这次修补白做）。
       */
      this.store.apply(ops, opts.source)
      return { ops, changes, result, undo }
    } catch (err) {
      // 逆序回滚：后做的先退（同一块被改两次时，先退第二次再退第一次）
      for (let i = rollback.length - 1; i >= 0; i--) rollback[i]!()
      throw err
    }
  }

  private makeTx(
    touched: Map<string, TouchedBlock>,
    rollback: (() => void)[],
    parentOverride: Map<string, string | null>,
  ): Tx {
    const at = (): number => this.now()
    const require = (id: string): Block => {
      const b = this.get(id)
      if (!b) throw new Error(`kb: no such block "${id}"`)
      return b
    }

    /**
     * 记一块的**改前快照**（第一次碰到这一块时记一次，之后不再重复记）。
     *
     * 为什么不整块深拷：`content`／`props`／`annos` 已经是**按需替换**的（每次写都是新对象），
     * 所以记引用就够了 —— 回滚时把那几个引用放回去，块对象本身不变（视图手里的引用不失效）。
     *
     * ⚠️ **`children` 也要记**，而且必须记**内容**（`splice` 原地放回、保持数组身份）：
     *    `patch` 的唯一约束是「不许改子树」，而它恰恰是**改完才检查**的
     *    （要等 `fn` 跑完才知道有没有动）⇒ 抛错时子树已经被改过，必须退回去。
     *    只记引用是不够的：`children` 是同一个数组被就地 `push`。
     */
    const touch = (b: Block): TouchedBlock => {
      const old = touched.get(b.id)
      if (old) return old
      /**
       * **属性袋与 annos 深拷**：`patch` 的调用方可以就地改它们（`props.arr.push`），
       * 只记引用会让「改前」跟着一起变 ⇒ 出口的 diff 看不见这次改动（真踩过）。
       * 正文不深拷：写正文的路径一律替换数组（`writeBlockContent`），没有就地改的入口。
       */
      const before: BeforeBlock = {
        cells: {
          ...cellsOf(b),
          ...(b.props ? { props: clone(b.props) } : {}),
          ...(b.annos ? { annos: clone(b.annos) } : {}),
        },
        children: b.children.slice(),
      }
      const t: TouchedBlock = { block: b, before }
      touched.set(b.id, t)
      rollback.push(() => {
        b.content = before.cells.content
        b.created = before.cells.created
        b.modified = before.cells.modified
        if (before.cells.props === undefined) delete b.props
        else b.props = before.cells.props
        if (before.cells.annos === undefined) delete b.annos
        else b.annos = before.cells.annos
        b.children.splice(0, b.children.length, ...before.children)
      })
      return t
    }

    /** 新块：`before: null`，落点由调用方给（`insert` 按子树先序、`move` 改最终落点） */
    const touchNew = (b: Block, placement: Placement): void => {
      if (touched.has(b.id)) throw new Error(`kb: block "${b.id}" already exists`)
      touched.set(b.id, { block: b, before: null, afterPlacement: placement })
    }

    // `this` 是 **MemoryKb**：事务句柄要同步改内存（`siblings`／`parentOf` 都在外层）
    const self = this
    return {
      patch(id, fn) {
        const b = require(id)
        const t = touch(b)
        /**
         * 本事务 `insert` 进来的块没有改前状态（`touchNew` 记 `before: null`）——
         * 它的一切本就该由 `insert` 的一次成型决定。裸放行的话调用方拿到的是
         * 一个没有话的 TypeError（读 `null.children`），报不出「为什么」。
         */
        if (!t.before) {
          throw new Error(`kb: patch("${id}") — block was inserted in this same tx; give it its cells at insert time`)
        }
        const before = t.before
        fn(b)
        // 子树不归 patch 管：能改 `children` 的只有结构 op，否则结构变化会被 diff 静默吞掉
        const kids = b.children
        const sameKids = kids.length === before.children.length && kids.every((k, i) => k === before.children[i])
        if (!sameKids) {
          throw new Error(`kb: patch("${id}") changed children — use insert/move/remove`)
        }
        // 出生时刻是只写一次的格：任何 patch 都不许改它（重放要从 genesis 拿到同一个值）
        if (b.created !== before.cells.created) {
          throw new Error(`kb: patch("${id}") changed created — it is immutable`)
        }
      },

      insert(block, parentId, index) {
        const list = siblings(self.store, parentId)
        if (!list) throw new Error(`kb: no such parent "${parentId}"`)
        const at_ = Math.max(0, Math.min(index, list.length))
        list.splice(at_, 0, block)
        // 回滚＝把它从列表里摘掉（新子树里的块本来就不在树上，摘根即可）
        rollback.push(() => {
          const i = list.indexOf(block)
          if (i >= 0) list.splice(i, 1)
        })
        // 一棵新子树里每一块都要有落点：后代报**它们自己的** parent/prev，
        // 不是把根的 parent 复制一遍（那会让整棵子树在库里都挂到同一层）。
        // 走 `walkForest` 而不是自己递归：块树遍历只有一个入口（`arch-check [22]`）。
        //
        // ⚠️ `walkForest` 给的 `ctx.index` 是**子树内部**的下标，不是根块在目标列表里的位置
        //    ⇒ 根块的前兄弟要单独算（它就是目标列表里 `at_` 之前那一块）。
        const rootPrev = at_ === 0 ? null : (list[at_ - 1]?.id ?? null)
        walkForest(
          [block],
          (node, ctx) => {
            const parent = ctx.parent?.id ?? parentId
            const placement: Placement = {
              parent,
              prev:
                ctx.parent === null
                  ? rootPrev
                  : ctx.index === 0
                    ? null
                    : (ctx.parent.children[ctx.index - 1]?.id ?? null),
            }
            touchNew(node, placement)
            // 新块还不在索引里：本事务内若紧接着搬它，`parentOf` 要能答出真父
            parentOverride.set(node.id, parent)
          },
          // 新子树里没有软删的块，但显式写出来：这条路径不该被「看不见的块」影响
          { includeDeleted: true },
        )
      },

      move(id, parentId, index) {
        const b = require(id)
        if (parentId !== null && subtreeIds(b).includes(parentId)) {
          throw new Error(`kb: cannot move "${id}" into its own subtree`)
        }
        const parentBefore = parentOverride.has(id) ? parentOverride.get(id)! : (self.parentOf(id)?.id ?? null)
        const from = siblings(self.store, parentBefore)
        const list = siblings(self.store, parentId)
        if (!from || !list) throw new Error(`kb: no such parent "${parentId}"`)
        // 先摘再夹取下标：`index` 是**最终**位置，同列表往后挪时调用方不必自己减一
        const fromIndex = from.indexOf(b)
        const beforePlacement: Placement = {
          parent: parentBefore,
          prev: fromIndex === 0 ? null : (from[fromIndex - 1]?.id ?? null),
        }
        from.splice(fromIndex, 1)
        const at_ = Math.max(0, Math.min(index, list.length))
        list.splice(at_, 0, b)
        // 回滚＝放回原位（原父与原下标都记下来；`from` 与 `list` 可能是同一个数组）
        rollback.push(() => {
          const i = list.indexOf(b)
          if (i >= 0) list.splice(i, 1)
          from.splice(fromIndex, 0, b)
        })
        const t = touch(b)
        // 同一块被移动两次：改前落点取第一次，改后落点取最后一次 ⇒ 净变化由 diff 判
        t.beforePlacement ??= beforePlacement
        t.afterPlacement = { parent: parentId, prev: at_ === 0 ? null : (list[at_ - 1]?.id ?? null) }
        parentOverride.set(id, parentId)
      },

      remove(id) {
        const b = require(id)
        touch(b)
        // **原位软删**：块带着子树留在树上的原位，只写删除标记。
        // op 只落操作根一条 `block.exist{deleted}` —— 子树的不可见是继承来的，
        // 落库也是一行的事（`deleted` 写在根行）。
        b.props = { ...(b.props ?? {}), [DELETED_AT_PROP]: at() }
      },

      restore(id) {
        // 按含被删块的遍历找（可见遍历看不见它）：摘掉标记，块回到原位
        const b = findIncludingDeleted(self.store.blocks, id)
        if (!b || !isDeleted(b)) throw new Error(`kb: no deleted block "${id}"`)
        touch(b)
        const props = { ...(b.props ?? {}) }
        delete props[DELETED_AT_PROP]
        // 属性袋不留空壳：`{}` 与「没有属性」是两种东西
        if (Object.keys(props).length === 0) delete b.props
        else b.props = props
      },

      setProp(id, name, value) {
        const b = require(id)
        touch(b)
        setValue(b, name, value)
      },

      clearProp(id, name) {
        const b = require(id)
        touch(b)
        clearValue(b, name)
      },

      setAliases(id, aliases) {
        const b = require(id)
        touch(b)
        const next = aliases.filter((a) => a.trim() !== '')
        // 校验与落库分开：撞名由调用方先问（`aliasConflict`），这里只保证「写了什么就报什么」
        b.props = { ...(b.props ?? {}) }
        if (next.length === 0) {
          delete b.props._aliases
          // 属性袋不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
          if (Object.keys(b.props).length === 0) delete b.props
        } else b.props._aliases = [...next]
        // 地址走**一个属性槽**：`_aliases` 的整组值就是事实，所以一条 set 说完整件事
        // （与 `setTags` 同形；不再发 `alias.set/delete` —— 同一个格不许有两种地址）
      },

      setLists(id, lists) {
        const b = require(id)
        touch(b)
        const next = [...new Set(lists)]
        if (next.length === 0) {
          if (b.props) {
            delete b.props._lists
            // 属性袋不留空壳：`{}` 与「没有属性」在快照比较里是两种东西
            if (Object.keys(b.props).length === 0) delete b.props
          }
        } else {
          b.props = { ...(b.props ?? {}), _lists: next }
        }
        // 露面同样走一个属性槽（理由见 `setAliases`）
      },

      setTags(id, tagIds) {
        const b = require(id)
        touch(b)
        const next = [...new Set(tagIds)]
        if (next.length === 0) {
          if (b.props) {
            delete b.props._tags
            if (Object.keys(b.props).length === 0) delete b.props
          }
        } else {
          b.props = { ...(b.props ?? {}), _tags: next }
        }
        // 归属走一个属性槽：`_tags` 的整组值就是事实，所以一条 set 说完整件事
      },

      setAnnos(id, annos) {
        const b = require(id)
        touch(b)
        // 按 id 的增删改由出口的 `annoOps` 比出来；这里只写内存
        b.annos = annos.length === 0 ? undefined : clone([...annos])
      },
    }
  }
}
