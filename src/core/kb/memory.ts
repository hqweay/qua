/**
 * **阶段 1（整库在内存）的接库实现**：把「整片森林」收进一个对象，
 * 读写都经它走，从而让读面只有一个入口、写面只有一个事务。
 *
 * 三条实现取舍，都是**为将来换实现留的位**，不是现在就需要的复杂度：
 *
 * 1. **读面只转调 `core/` 的纯函数**（`findInForest`／`fieldRows`／`gutterFieldsFor`／
 *    `tagsOf`／`findByAlias`／`runQuery`／`backrefsOf`）。派生逻辑一旦在这里重写一遍，
 *    就会有两份「这条属性该不该显示」「这个标签算不算成员」的答案 —— 而它们能不一致。
 * 2. **写面先把内存改完，再产出 op**：`tx` 成功才交付 `{ ops, changes }`；
 *    失败按快照整批恢复。阶段 1 不做逆 op，理由与撤销同源 —— 整库快照已经够快，
 *    而逆 op 是「同一件事的第二个正确性来源」，早晚与正路径分叉。
 * 3. **结构不作 diff**：`patch` 只看正文、改动时刻与属性；子树变化一律抛错，逼调用方显式
 *    `insert`／`move`／`remove`。结构若靠 diff 猜，删掉的整棵后代就会凭空消失
 *    —— 不报错，只是数据少了一截。
 *
 * ⚠️ 本文件零 DOM、零持久化：op 只是被**算出来**，谁来落盘由上层决定。
 */
import { backrefBlocks, backrefsOf, type BackrefBlock, type BackrefSource } from '../backrefs.ts'
import { aliasesOf, ALIASES_PROP, DELETED_AT_PROP, hasList, isDeleted, LISTS_PROP, listsOf, type Block } from '../model.ts'
import { findByAlias } from '../alias.ts'
import { findInForest, trashOf } from '../tree.ts'
import { walkForest } from '../walk.ts'
import { findTagByName, tagsOf as tagsOfBlock, tagIdsOf } from '../tags.ts'
import { findJournalDay } from '../journal.ts'
import { blockIdByAlias, indexPathOf, queryByIndex } from '../index-port.ts'
import {
  allPropDefs,
  declaredFields,
  fieldRows,
  gutterFieldsFor,
  type FieldRow,
  type GutterField,
  setValue,
  clearValue,
} from '../props.ts'
import type { QueryHit, QuerySpec } from '../query.ts'
import type { BlockStore } from '../store.ts'
import type { Change, KbClient, Op, PathEntry, Tx, TxOpts, TxResult } from './types.ts'
import type { Anno } from '../runs.ts'

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

/** 同上，连落点（parent ＋ index）一起给（恢复 op 要报「回来了还在原位」） */
function locateIncludingDeleted(forest: readonly Block[], id: string): { parent: Block | null; index: number; block: Block } | null {
  let hit: { parent: Block | null; index: number; block: Block } | null = null
  walkForest(
    forest,
    (b, ctx) => {
      if (b.id === id) {
        hit = { parent: ctx.parent, index: ctx.index, block: b }
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
  const p = findInForest(store.blocks, parentId)
  return p?.children
}

/**
 * 一块在它所在兄弟列表里的**前一块**（`null` ＝ 它是第一块）。
 *
 * 为什么要单独算而不是用 `locateIncludingDeleted` 给的 `index`：恢复的 op 要记
 * 「前兄弟 id」，而 `index` 是相对值（见 `BlockPatch.prev` 的说明）。
 * 这里走**含被删块**的遍历：恢复的块可能正挨着另一块被删的块，
 * 而那两块都还在原位（软删不搬位置）。
 *
 * ⚠️ 走 `walkForest` 而不是自己递归：块树遍历只有一个入口（`arch-check [22]`）。
 */
function prevSiblingIdOf(forest: readonly Block[], id: string): string | null {
  let prev: string | null = null
  walkForest(
    forest,
    (b, ctx) => {
      if (b.id !== id) return
      prev = ctx.index === 0 ? null : (ctx.parent ? ctx.parent.children[ctx.index - 1]?.id : forest[ctx.index - 1]?.id) ?? null
      return false
    },
    { includeDeleted: true },
  )
  return prev
}

/** 子树里的全部块（先序，**含自身**）——删子树时要逐个报 op，不靠「级联」这个词 */
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

/** 值比较：数组/对象也要比内容（`Object.is` 会把「就地 push」当成没变） */
function sameValue(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)
}

/** 属性袋比较：键集合相同且每个值相同（键的顺序不承载语义） */
function sameProps(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const ka = Object.keys(a ?? {})
  const keys = Object.keys(b ?? {})
  if (ka.length !== keys.length) return false
  for (const k of ka) if (!(k in (b ?? {})) || !sameValue(a?.[k], b?.[k])) return false
  return true
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

  get(id: string): Block | undefined {
    return findInForest(this.store.blocks, id)
  }

  children(id: string): readonly Block[] {
    return findInForest(this.store.blocks, id)?.children ?? []
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
    // 只收真的能用 `[[名字]]` 指到的（`isAddressable` 由 `findByAlias` 的默认 accept 表达）
    const out: PathEntry[] = []
    walkForest(this.store.blocks, (b) => {
      const name = aliasesOf(b)[0]
      if (name !== undefined && findByAlias(this.store.blocks, name) === b) out.push({ name, block: b })
    })
    return out
  }

  fieldsOf(id: string): readonly FieldRow[] {
    const b = this.get(id)
    return b ? fieldRows(b, this.store.blocks) : []
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
    return allPropDefs(this.store.blocks)
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

  findTag(name: string): Block | undefined {
    return findTagByName(this.store.blocks, name)
  }

  journalDay(date: string): Block | undefined {
    return findJournalDay(this.store.blocks, date)
  }

  annosOf(id: string): readonly Anno[] {
    return findInForest(this.store.blocks, id)?.annos ?? []
  }

  query(spec: QuerySpec, opts: { scopeId?: string; selfId?: string } = {}): QueryHit[] {
    // 走索引：ref/tag/journal 查表，判定与顺序与纯函数路径共用一份
    return queryByIndex(this.store.index, this.store.blocks, spec, { anchorId: opts.scopeId, selfId: opts.selfId })
  }

  backlinksOf(id: string): readonly BackrefSource[] {
    return backrefsOf({ blocks: this.store.blocks, targetId: id, index: this.store.index })
  }

  backrefBlocksOf(id: string): readonly BackrefBlock[] {
    return backrefBlocks({ blocks: this.store.blocks, targetId: id, index: this.store.index })
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
   */
  tx<R>(fn: (tx: Tx) => R, opts: TxOpts = {}): TxResult & { result: R } {
    const ops: Op[] = []
    const changes: Change[] = []
    const sink = new ChangeSink(changes)
    /** 回滚日志：逆序应用的「怎么退回去」 */
    const rollback: (() => void)[] = []
    try {
      const result = fn(this.makeTx(ops, sink, rollback))
      /**
       * **宣布只在这里发生**：`store.apply` 是状态转移的唯一入口 ——
       * 它同时做「按 op 修补索引」与「通知订阅者」两件事。
       *
       * 为什么必须在出口：失败路径不宣布（模型退回原样，别的视图本该看到的还是那份）；
       * 而成功的这一批 op 说清了「变了哪几格」，所以索引只修补、不作废。
       * 调用方（编辑器／命令）**不得**再自己宣布（那会让这次修补白做）。
       */
      this.store.apply(ops, opts.source, sink.ids())
      return { ops, changes, result }
    } catch (err) {
      // 逆序回滚：后做的先退（同一块被改两次时，先退第二次再退第一次）
      for (let i = rollback.length - 1; i >= 0; i--) rollback[i]!()
      throw err
    }
  }

  private makeTx(ops: Op[], sink: ChangeSink, rollback: (() => void)[]): Tx {
    const at = (): number => this.now()
    const require = (id: string): Block => {
      const b = this.get(id)
      if (!b) throw new Error(`kb: no such block "${id}"`)
      return b
    }

    /**
     * 记一块的**字段**快照（第一次碰到这一块时记一次，之后不再重复记）。
     *
     * 为什么不整块深拷：`content`／`props`／`annos` 已经是**按需替换**的（每次写都是新对象），
     * 所以记引用就够了 —— 回滚时把那几个引用放回去，块对象本身不变（视图手里的引用不失效）。
     *
     * ⚠️ **`children` 也要记**，而且必须记**内容**（`splice` 原地放回、保持数组身份）：
     *    `patch` 的唯一约束是「不许改子树」，而它恰恰是**改完才检查**的
     *    （要等 `fn` 跑完才知道有没有动）⇒ 抛错时子树已经被改过，必须退回去。
     *    只记引用是不够的：`children` 是同一个数组被就地 `push`。
     */
    const seen = new Set<string>()
    const snapBlock = (b: Block): void => {
      if (seen.has(b.id)) return
      seen.add(b.id)
      const before = { content: b.content, modified: b.modified, props: b.props, annos: b.annos, children: b.children.slice() }
      rollback.push(() => {
        b.content = before.content
        b.modified = before.modified
        if (before.props === undefined) delete b.props
        else b.props = before.props
        if (before.annos === undefined) delete b.annos
        else b.annos = before.annos
        b.children.splice(0, b.children.length, ...before.children)
      })
    }

    // `this` 是 **MemoryKb**：事务句柄要同步改内存（`siblings`／`parentOf` 都在外层）
    const self = this
    return {
      patch(id, fn) {
        const b = require(id)
        snapBlock(b)
        const before = {
          content: JSON.stringify(b.content),
          modified: b.modified,
          props: b.props ? clone(b.props) : undefined,
          kids: b.children.slice(),
        }
        fn(b)
        // 子树不归 patch 管：能改 `children` 的只有结构 op，否则结构变化会被 diff 静默吞掉
        const kids = b.children
        const sameKids = kids.length === before.kids.length && kids.every((k, i) => k === before.kids[i])
        if (!sameKids) {
          throw new Error(`kb: patch("${id}") changed children — use insert/move/remove`)
        }
        // 行内内容（文本/格式/原子）是**一组事实**：一次改动就是一条 content upsert，
        // 落库与同步看到的是整组替换，不是「字一条、格式一条、原子一条」的碎账。
        // `modified` 与它**同值同一条**：时刻是这次改动的属性，不是第二件事。
        const sameContent = JSON.stringify(b.content) === before.content
        const sameTime = b.modified === before.modified
        if (!sameContent || !sameTime) {
          ops.push({
            e: 'block',
            id,
            op: 'upsert',
            value: { content: b.content, ...(sameTime ? {} : { modified: b.modified }) },
            at: at(),
          })
          sink.blocks(id)
        }
        if (!sameProps(before.props, b.props)) {
          for (const name of Object.keys(b.props ?? {})) {
            if (before.props && sameValue(before.props[name], b.props?.[name])) continue
            ops.push({ e: 'prop', block: id, name, op: 'set', value: b.props?.[name], at: at() })
          }
          for (const name of Object.keys(before.props ?? {})) {
            if (b.props && name in b.props) continue
            ops.push({ e: 'prop', block: id, name, op: 'delete', at: at() })
          }
          sink.blocks(id)
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
            const prev =
              ctx.parent === null
                ? rootPrev
                : ctx.index === 0
                  ? null
                  : (ctx.parent.children[ctx.index - 1]?.id ?? null)
            ops.push({ e: 'block', id: node.id, op: 'upsert', value: { parent, prev }, at: at() })
            sink.blocks(node.id)
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
        const from = siblings(self.store, self.parentOf(id)?.id ?? null)
        const list = siblings(self.store, parentId)
        if (!from || !list) throw new Error(`kb: no such parent "${parentId}"`)
        // 先摘再夹取下标：`index` 是**最终**位置，同列表往后挪时调用方不必自己减一
        const fromIndex = from.indexOf(b)
        from.splice(fromIndex, 1)
        const at_ = Math.max(0, Math.min(index, list.length))
        list.splice(at_, 0, b)
        // 回滚＝放回原位（原父与原下标都记下来；`from` 与 `list` 可能是同一个数组）
        rollback.push(() => {
          const i = list.indexOf(b)
          if (i >= 0) list.splice(i, 1)
          from.splice(fromIndex, 0, b)
        })
        ops.push({
          e: 'block',
          id,
          op: 'upsert',
          value: { parent: parentId, prev: at_ === 0 ? null : (list[at_ - 1]?.id ?? null) },
          at: at(),
        })
        sink.blocks(id)
      },

      remove(id) {
        const b = require(id)
        // **原位软删**：块带着子树留在树上的原位，只写删除标记。op 只落操作根一条——
        // 子树的不可见是继承来的（遍历跳过被删子树），落库也是一行的事（`deleted_at` 写在根行）。
        // 「退化成一次属性写入」说的是模型动作；op 的说法仍是 `block.delete`——
        // 删除只有这一个词，落库侧才能只认一种形状。
        snapBlock(b)
        b.props = { ...(b.props ?? {}), [DELETED_AT_PROP]: at() }
        ops.push({ e: 'block', id, op: 'delete', at: at() })
        sink.blocks(id)
      },

      restore(id) {
        // 按含被删块的遍历找（可见遍历看不见它）：摘掉标记 ＋ 报一条「回来了还在原位」
        const b = findIncludingDeleted(self.store.blocks, id)
        if (!b || !isDeleted(b)) throw new Error(`kb: no deleted block "${id}"`)
        const loc = locateIncludingDeleted(self.store.blocks, id)
        if (!loc) throw new Error(`kb: no such block "${id}"`)
        snapBlock(b)
        const props = { ...(b.props ?? {}) }
        delete props[DELETED_AT_PROP]
        // 属性袋不留空壳：`{}` 与「没有属性」是两种东西
        if (Object.keys(props).length === 0) delete b.props
        else b.props = props
        ops.push({
          e: 'block',
          id,
          op: 'upsert',
          value: { parent: loc.parent?.id ?? null, prev: prevSiblingIdOf(self.store.blocks, id) },
          at: at(),
        })
        sink.blocks(id)
      },

      setProp(id, name, value) {
        const b = require(id)
        snapBlock(b)
        setValue(b, name, value)
        ops.push({ e: 'prop', block: id, name, op: 'set', value, at: at() })
        sink.blocks(id)
      },

      clearProp(id, name) {
        const b = require(id)
        snapBlock(b)
        clearValue(b, name)
        ops.push({ e: 'prop', block: id, name, op: 'delete', at: at() })
        sink.blocks(id)
      },

      setAliases(id, aliases) {
        const b = require(id)
        snapBlock(b)
        const prev = aliasesOf(b)
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
        if (sameValue(prev, next)) return
        ops.push({ e: 'prop', block: id, name: ALIASES_PROP, op: 'set', value: next, at: at() })
        sink.blocks(id)
      },

      setLists(id, lists) {
        const b = require(id)
        snapBlock(b)
        const prev = listsOf(b)
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
        if (sameValue(prev, next)) return
        ops.push({ e: 'prop', block: id, name: LISTS_PROP, op: 'set', value: next, at: at() })
        sink.blocks(id)
      },

      setTags(id, tagIds) {
        const b = require(id)
        snapBlock(b)
        const prev = tagIdsOf(b)
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
        if (sameValue(prev, next)) return
        ops.push({ e: 'prop', block: id, name: '_tags', op: 'set', value: next, at: at() })
        sink.blocks(id)
      },

      setAnnos(id, annos) {
        const b = require(id)
        snapBlock(b)
        const before = new Map((b.annos ?? []).map((a) => [a.id, a]))
        const after = new Map(annos.map((a) => [a.id, a]))
        /**
         * 按 id diff。**未变的不发 op**：anno 的 id 是别人引用的地址，
         * 逐条比对才能做到「没变的那条一个字节不动」。
         * 同一条 anno 被**重物化**（range 漂了、quote 重定位了）⇒ set 覆盖，id 不换。
         */
        for (const [aid, a] of after) {
          const old = before.get(aid)
          if (old && JSON.stringify(old) === JSON.stringify(a)) continue
          ops.push({ e: 'anno', block: id, id: aid, op: 'set', value: a, at: at() })
          sink.annos(id)
        }
        for (const [aid, a] of before) {
          if (after.has(aid)) continue
          ops.push({ e: 'anno', block: id, id: aid, op: 'delete', value: a, at: at() })
          sink.annos(id)
        }
        b.annos = annos.length === 0 ? undefined : clone([...annos])
      },
    }
  }
}

/** `Change` 的累积器：**同 kind 同 id 只报一次**（一次事务里改十次正文也是一条失效） */
class ChangeSink {
  private readonly seen = new Set<string>()
  readonly list: Change[]
  constructor(target: Change[]) {
    this.list = target
  }
  private push(kind: Change['kind'], id: string): void {
    const key = `${kind}\u0000${id}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.list.push({ kind, id })
  }
  blocks(id: string): void {
    this.push('blocks', id)
  }
  annos(id: string): void {
    this.push('annos', id)
  }
  /** 给 `store.touch(source, ids)`：这次动过的块 */
  ids(): string[] {
    return [...new Set(this.list.map((c) => c.id))]
  }
}
