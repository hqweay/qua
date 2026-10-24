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
 * 3. **结构不作 diff**：`patch` 只看正文与属性；子树变化一律抛错，逼调用方显式
 *    `insert`／`move`／`remove`。结构若靠 diff 猜，删掉的整棵后代就会凭空消失
 *    —— 不报错，只是数据少了一截。
 *
 * ⚠️ 本文件零 DOM、零持久化：op 只是被**算出来**，谁来落盘由上层决定。
 */
import type { Atom, Mark } from '../annotations.ts'
import { backrefsOf, type BackrefSource } from '../backrefs.ts'
import { aliasesOf, DELETED_AT_PROP, listsOf, type Block } from '../model.ts'
import { findByAlias } from '../alias.ts'
import { findPath, findInForest } from '../tree.ts'
import { walkForest } from '../walk.ts'
import { tagsOf as tagsOfBlock, tagIdsOf } from '../tags.ts'
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
import { runQuery, type QueryHit, type QuerySpec } from '../query.ts'
import type { BlockStore } from '../store.ts'
import type { Change, KbClient, Op, PathEntry, Tx, TxOpts, TxResult } from './types.ts'

/** 一层的兄弟列表；`null` 父 ⇒ 森林顶层 */
function siblings(store: BlockStore, parentId: string | null): Block[] | undefined {
  if (parentId === null) return store.blocks
  const p = findInForest(store.blocks, parentId)
  return p?.children
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

/** 旧的没了（按旧序：先删旧位再按新序 set，`pos` 才对得上） */
function gone<T>(next: readonly T[], prev: readonly T[]): T[] {
  return prev.filter((x) => !next.includes(x))
}

/** 新的多了（按新序：`pos` 就是它在新数组里的下标） */
function came<T>(next: readonly T[], prev: readonly T[]): T[] {
  return next.filter((x) => !prev.includes(x))
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
    const path = findPath(this.store.blocks, id)
    return path && path.length >= 2 ? path[path.length - 2] : undefined
  }

  pathOf(id: string): readonly Block[] {
    return findPath(this.store.blocks, id) ?? []
  }

  resolveAlias(name: string): Block | undefined {
    return findByAlias(this.store.blocks, name)
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

  annotationsOf(id: string): { marks: readonly Mark[]; atoms: readonly Atom[] } {
    return {
      marks: this.store.marks.filter((m) => m.blockId === id),
      atoms: this.store.atoms.filter((a) => a.blockId === id),
    }
  }

  query(spec: QuerySpec, opts: { scopeId?: string } = {}): QueryHit[] {
    return runQuery(spec, { blocks: this.store.blocks, atoms: this.store.atoms, anchorId: opts.scopeId })
  }

  backlinksOf(id: string): readonly BackrefSource[] {
    return backrefsOf({ blocks: this.store.blocks, atoms: this.store.atoms, targetId: id, index: this.store.index })
  }

  /* ------------------------------------------------------------ 写面 */

  /**
   * 一次事务：进门前快照，成功后交付 `{ ops, changes }`，抛错则**整批恢复**并重抛。
   *
   * 快照是整片森林 ＋ 锚点 ＋ 回收站：阶段 1 的工作集就是整库，
   * 所以「回滚」与撤销是同一种机制 —— 它们本来回答的就是同一个问题。
   */
  tx<R>(fn: (tx: Tx) => R, opts: TxOpts = {}): TxResult & { result: R } {
    const snap = {
      blocks: JSON.stringify(this.store.blocks),
      marks: JSON.stringify(this.store.marks),
      atoms: JSON.stringify(this.store.atoms),
      trash: JSON.stringify(this.store.trash),
    }
    const ops: Op[] = []
    const changes: Change[] = []
    const sink = new ChangeSink(changes)
    try {
      const result = fn(this.makeTx(ops, sink))
      // 失效与广播只在成功之后：失败路径恢复的是同一份快照，索引没有理由重算，
      // 而 `touch` 会把「改过」推给每个订阅者 —— 回滚后再推一次等于让他们白渲染两次。
      this.store.invalidateIndex()
      this.store.touch(opts.source, sink.ids())
      return { ops, changes, result }
    } catch (err) {
      this.restore(snap)
      throw err
    }
  }

  /** 按序列化快照原地恢复（保持数组身份：视图手里的引用不会失效） */
  private restore(snap: { blocks: string; marks: string; atoms: string; trash: string }): void {
    const blocks = JSON.parse(snap.blocks) as Block[]
    this.store.blocks.splice(0, this.store.blocks.length, ...blocks)
    const marks = JSON.parse(snap.marks) as Mark[]
    this.store.marks.splice(0, this.store.marks.length, ...marks)
    const atoms = JSON.parse(snap.atoms) as Atom[]
    this.store.atoms.splice(0, this.store.atoms.length, ...atoms)
    const trash = JSON.parse(snap.trash) as Block[]
    this.store.trash.splice(0, this.store.trash.length, ...trash)
    this.store.invalidateIndex()
    this.store.touch(undefined)
  }

  private makeTx(ops: Op[], sink: ChangeSink): Tx {
    const at = (): number => this.now()
    const require = (id: string): Block => {
      const b = this.get(id)
      if (!b) throw new Error(`kb: no such block "${id}"`)
      return b
    }

    // `this` 是 **MemoryKb**：事务句柄要同步改内存（`siblings`／`parentOf` 都在外层）
    const self = this
    return {
      patch(id, fn) {
        const b = require(id)
        const before = { text: b.text, props: b.props ? clone(b.props) : undefined, kids: b.children.slice() }
        fn(b)
        // 子树不归 patch 管：能改 `children` 的只有结构 op，否则结构变化会被 diff 静默吞掉
        const kids = b.children
        const sameKids = kids.length === before.kids.length && kids.every((k, i) => k === before.kids[i])
        if (!sameKids) {
          throw new Error(`kb: patch("${id}") changed children — use insert/move/remove`)
        }
        if (b.text !== before.text) {
          ops.push({ e: 'block', id, op: 'upsert', value: { text: b.text }, at: at() })
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
        // 一棵新子树里每一块都要有落点：后代报**它们自己的** parent/index，
        // 不是把根的 parent 复制一遍（那会让整棵子树在库里都挂到同一层）
        const place = (node: Block, parent: string | null, index: number): void => {
          ops.push({ e: 'block', id: node.id, op: 'upsert', value: { parent, index }, at: at() })
          sink.blocks(node.id)
          node.children.forEach((kid, i) => place(kid, node.id, i))
        }
        place(block, parentId, at_)
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
        from.splice(from.indexOf(b), 1)
        const at_ = Math.max(0, Math.min(index, list.length))
        list.splice(at_, 0, b)
        ops.push({ e: 'block', id, op: 'upsert', value: { parent: parentId, index: at_ }, at: at() })
        sink.blocks(id)
      },

      remove(id, opts = {}) {
        const b = require(id)
        const parent = self.parentOf(id)
        const list = siblings(self.store, parent?.id ?? null)
        if (!list) throw new Error(`kb: no such block "${id}"`)
        list.splice(list.indexOf(b), 1)
        // 与 `removeBlock` 同形：回收站成员靠 `_deletedAt` 标记（阶段 1），
        // 子树只是跟着根一起被摘出来，后代不各写一份。
        // `trash: false` ⇒ 这块是被并掉的（内容已在别处），不留空壳。
        if (opts.trash !== false) {
          b.props = { ...(b.props ?? {}), [DELETED_AT_PROP]: at() }
          self.store.trash.push(b)
        }
        // 子树逐个 delete：级联是**落库实现**的事（递归 CTE），op 序列本身要说得清删了哪些块
        for (const kid of subtreeIds(b)) {
          ops.push({ e: 'block', id: kid, op: 'delete', at: at() })
          sink.blocks(kid)
        }
      },

      setProp(id, name, value, pos) {
        const b = require(id)
        setValue(b, name, value)
        ops.push({ e: 'prop', block: id, name, op: 'set', value, ...(pos === undefined ? {} : { pos }), at: at() })
        sink.blocks(id)
      },

      clearProp(id, name) {
        const b = require(id)
        clearValue(b, name)
        ops.push({ e: 'prop', block: id, name, op: 'delete', at: at() })
        sink.blocks(id)
      },

      setAliases(id, aliases) {
        const b = require(id)
        const prev = aliasesOf(b)
        const next = aliases.filter((a) => a.trim() !== '')
        // 校验与落库分开：撞名由调用方先问（`aliasConflict`），这里只保证「写了什么就报什么」
        b.props = { ...(b.props ?? {}) }
        if (next.length === 0) delete b.props._aliases
        else b.props._aliases = [...next]
        const dropped = gone(next, prev)
        // 先删旧位、再按**新序**逐个 set：`pos` 是数组下标，两者的先后决定它指向谁。
        // 只换序、或删掉一个导致后面整体前移，都要把新 pos 写出来。
        let touched = dropped.length > 0
        for (const name of dropped) ops.push({ e: 'alias', block: id, name, op: 'delete', at: at() })
        for (let i = 0; i < next.length; i++) {
          const name = next[i]!
          if (prev.indexOf(name) === i) continue
          ops.push({ e: 'alias', block: id, name, op: 'set', pos: i, at: at() })
          touched = true
        }
        if (touched) sink.blocks(id)
      },

      setLists(id, lists) {
        const b = require(id)
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
        for (const list of gone(next, prev)) {
          ops.push({ e: 'list', block: id, list, op: 'delete', at: at() })
          sink.blocks(id)
        }
        for (const list of came(next, prev)) {
          ops.push({ e: 'list', block: id, list, op: 'set', at: at() })
          sink.blocks(id)
        }
      },

      setTags(id, tagIds) {
        const b = require(id)
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
        if (gone(next, prev).length === 0 && came(next, prev).length === 0) return
        ops.push({ e: 'prop', block: id, name: '_tags', op: 'set', value: next, at: at() })
        sink.blocks(id)
      },

      setAnnotations(id, marks, atoms) {
        require(id)
        /**
         * 按 id diff。**未变的锚点不发 op**：一次渲染里重算同一批锚点是常见路径，
         * 每次都整组重写会把「碰过」当成「改过」，让落盘与同步看到一堆空转的写入。
         */
        const diff = <T extends Mark | Atom>(prev: readonly T[], next: readonly T[], kind: 'marks' | 'atoms'): void => {
          const before = new Map(prev.filter((x) => x.blockId === id).map((x) => [x.id, x]))
          const after = new Map(next.filter((x) => x.blockId === id).map((x) => [x.id, x]))
          let touched = false
          for (const [aid, a] of after) {
            const old = before.get(aid)
            if (old && JSON.stringify(old) === JSON.stringify(a)) continue
            ops.push({ e: 'anno', block: id, id: aid, op: 'set', value: a, at: at() })
            touched = true
          }
          for (const [aid, a] of before) {
            if (after.has(aid)) continue
            ops.push({ e: 'anno', block: id, id: aid, op: 'delete', value: a, at: at() })
            touched = true
          }
          if (touched) sink[kind](id)
        }
        // 只换这一块的：别的块的锚点原样留在库里（整块替换 = 摘掉这块的、再接上新的）
        const nextMarks = [...self.store.marks.filter((m) => m.blockId !== id), ...marks]
        const nextAtoms = [...self.store.atoms.filter((a) => a.blockId !== id), ...atoms]
        diff(self.store.marks, nextMarks, 'marks')
        diff(self.store.atoms, nextAtoms, 'atoms')
        self.store.marks.splice(0, self.store.marks.length, ...clone(nextMarks))
        self.store.atoms.splice(0, self.store.atoms.length, ...clone(nextAtoms))
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
  marks(id: string): void {
    this.push('marks', id)
  }
  atoms(id: string): void {
    this.push('atoms', id)
  }
  /** 给 `store.touch(source, ids)`：这次动过的块（含只动锚点的块） */
  ids(): string[] {
    return [...new Set(this.list.map((c) => c.id))]
  }
}
