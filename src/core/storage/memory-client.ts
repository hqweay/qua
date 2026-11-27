/**
 * **内存读面**（web 单库的 `LibraryClient` 实现）——与桌面同一条契约的另一套实现。
 *
 * ## 为什么有两套实现
 *
 * 契约只有一份（`library-client.ts`）：按 root／按 id／按计划装块。
 * 桌面的实现是「IPC ＋ `library-reads.ts` 的具名 SQL」；web 没有 SQLite，
 * 也没有「用户选的库目录」这个语义——它把整份模型放在内存里，读面从模型现场编码。
 * 消费面（装载咽喉、导航、搜索的依赖方查询）只认契约，不认实现 ⇒ web 与桌面
 * 走同一批消费代码，不再各留一份「没有库面 ⇒ 不做」的分叉。
 *
 * ## 登记的代价（有意的非对称）
 *
 * web 持有**全量模型**，读面编码是每次查询现算的 O(子树) 走树。
 * 这在 1M 块的桌面上不可接受，在 web 的演示体量（几千块）下无所谓——
 * web 不背 SQLite WASM，代价是内存全量。桌面的有界工作集在这里**没有**对应物：
 * web 的 `isLoaded` 永远全真，装载体量跟着库走。
 *
 * ## 编码口径只有一份
 *
 * 「块长成哪几行」的唯一答案在 `db-rows.ts`（`rowsOfBlock`）；这里只做选择
 * （哪些块进这一次回复），不做编码。列名与桌面 SQL 的 `select *` 逐字一致，
 * 行进 `rowsToWorkspace` 时两边同解。
 */
import { walkForest } from '../model/walk.ts'
import { DELETED_AT_PROP, aliasesOf, hasList, isDeleted, type Block } from '../model/model.ts'
import { isJournal, journalDate } from '../identity/journal.ts'
import { normalizeAlias } from '../identity/address-key.ts'
import { ensureIndexLists, relationsTo, type Index } from '../infra/index-port.ts'
import type { BlockStore } from '../model/store.ts'
import { positionsOf, rowsOfBlock, type RawLibraryRows, type StoredWorkspace } from './db-rows.ts'
import type { AliasTarget, CandidatePage, LibraryCatalog, LibraryDocRows, LibraryDocWindow } from './library-reads.ts'
import type { LibraryClient, LibraryReadResult } from './library-client.ts'
import type { CandidatePlan } from './library-reads.ts'
import { DERIVED_PATH_VERSION } from '../identity/library.ts'

/** web 的派生答案就是内存索引本身：永远整份、永远现行 ⇒ 状态恒 ready、路径口径恒现行 */
const MEMORY_DERIVED_STATE = 'ready'

type Rows = RawLibraryRows

const emptyRows = (): Rows => ({ blocks: [], props: [], aliases: [], lists: [], meta: {} })

export interface MemoryLibraryDeps {
  /** 活的工作区（整份模型；读面从它现场编码） */
  ws: () => StoredWorkspace
  /** 块存储（索引与森林的唯一持有者） */
  store: BlockStore
}

export function createMemoryLibraryClient(deps: MemoryLibraryDeps): LibraryClient {
  const forest = (): readonly Block[] => deps.store.blocks
  const index = (): Index => deps.store.index

  const ok = <T>(value: T): LibraryReadResult<T> => ({ status: 'ok', value })

  /** 一次走树找齐目标块（含软删；找不到的调用方自己判） */
  function findByIds(want: ReadonlySet<string>): Map<string, Block> {
    const found = new Map<string, Block>()
    if (want.size === 0) return found
    walkForest(
      forest(),
      (b) => {
        if (want.has(b.id)) found.set(b.id, b)
      },
      { includeDeleted: true },
    )
    return found
  }

  /** 一片的四张行（位置从整片森林推一次；与桌面 SQL 的 `select *` 同列） */
  function rowsFor(ids: Iterable<string>): Rows {
    const want = [...new Set(ids)]
    const pos = positionsOf(forest())
    const found = findByIds(new Set(want))
    const out = emptyRows()
    for (const id of want) {
      const b = found.get(id)
      const p = pos.get(id)
      if (!b || !p) continue
      const r = rowsOfBlock(b, p)
      out.blocks.push(r.block)
      out.props.push(...r.props)
      out.aliases.push(...r.aliases)
      out.lists.push(...r.lists)
    }
    return out
  }

  /** 一个 root 的子树块（含软删、先序） */
  function subtreeOf(root: Block): Block[] {
    const out: Block[] = []
    walkForest(
      [root],
      (b) => {
        out.push(b)
      },
      { includeDeleted: true },
    )
    return out
  }

  /** pos 表里的 parent 链向上走到顶层（不含自己） */
  function ancestorIdsOf(id: string, pos: Map<string, { parent: string | null; left: string | null }>): string[] {
    const out: string[] = []
    const seen = new Set<string>([id])
    let cur = pos.get(id)?.parent ?? null
    while (cur !== null && !seen.has(cur)) {
      out.push(cur)
      seen.add(cur)
      cur = pos.get(cur)?.parent ?? null
    }
    return out
  }

  return {
    async doc(roots): Promise<LibraryReadResult<LibraryDocRows>> {
      if (roots.length === 0) return ok({ rows: emptyRows(), ancestors: [], rootIds: [] })
      const pos = positionsOf(forest())
      const subtreeIds: string[] = []
      const ancestorIds: string[] = []
      const seen = new Set<string>()
      const want = new Set(roots)
      for (const root of findByIds(want).values()) {
        for (const b of subtreeOf(root)) {
          if (seen.has(b.id)) continue
          seen.add(b.id)
          subtreeIds.push(b.id)
        }
      }
      for (const id of roots) {
        if (!want.has(id) || !pos.has(id)) continue
        for (const a of ancestorIdsOf(id, pos)) {
          if (seen.has(a)) continue
          seen.add(a)
          ancestorIds.push(a)
        }
      }
      const subtree = rowsFor(subtreeIds)
      const ancestors = rowsFor(ancestorIds)
      // 附属行取「子树 ∪ 祖先链」（祖先也要有名字，否则面包屑只剩正文）；
      // rows.blocks 仍只含子树——要不要把祖先接进树是装载方的决定
      return ok({
        rows: {
          blocks: subtree.blocks,
          props: [...subtree.props, ...ancestors.props],
          aliases: [...subtree.aliases, ...ancestors.aliases],
          lists: [...subtree.lists, ...ancestors.lists],
          meta: {},
        },
        ancestors: ancestors.blocks,
        rootIds: [...roots],
      })
    },

    async docWindow(root, after, limit): Promise<LibraryReadResult<LibraryDocWindow>> {
      /**
       * 与桌面同一条契约：DFS 前缀 ＋ 不透明游标。这里的游标是**上一窗最后一块的 id**
       * （web 没有派生路径）——调用方只把它原样传回来，两套实现的游标形态可以不同。
       */
      const b = findByIds(new Set([root])).get(root)
      if (!b) return ok({ rows: emptyRows(), ancestors: [], rootIds: [root], next: null })
      const all = subtreeOf(b)
      let start = 0
      if (after !== null) {
        const at = all.findIndex((x) => x.id === after)
        start = at < 0 ? all.length : at + 1
      }
      const slice = all.slice(start, start + limit)
      const rows = rowsFor(slice.map((x) => x.id))
      const pos = positionsOf(forest())
      const ancestors = after === null ? rowsFor(ancestorIdsOf(root, pos)) : emptyRows()
      return ok({
        rows: {
          blocks: rows.blocks,
          props: [...rows.props, ...ancestors.props],
          aliases: [...rows.aliases, ...ancestors.aliases],
          lists: [...rows.lists, ...ancestors.lists],
          meta: {},
        },
        ancestors: ancestors.blocks,
        rootIds: [root],
        next: start + slice.length < all.length && slice.length > 0 ? slice[slice.length - 1]!.id : null,
      })
    },

    async identity(): Promise<LibraryReadResult<Rows>> {
      /**
       * 全局身份块：被软删的、字段定义、有 page/tag 露面的、自动化、引述类型表——
       * 与桌面同一份判据（`catalogIdentity` 的五段 union，逐段对得上；
       * 自动化与类型表都靠「那个属性在场」认）。
       */
      const ids: string[] = []
      walkForest(
        forest(),
        (b) => {
          if (
            isDeleted(b) ||
            b.props?.['_kind'] !== undefined ||
            b.props?.['_automation'] !== undefined ||
            b.props?.['_calloutTypes'] !== undefined ||
            hasList(b, 'page') ||
            hasList(b, 'tag')
          ) {
            ids.push(b.id)
          }
        },
        { includeDeleted: true },
      )
      return ok(rowsFor(ids))
    },

    async ftsMap(): Promise<LibraryReadResult<{ block_id: string; source: string | null; fts_rowid: number }[]>> {
      // web 没有 FTS 表：查询走森林扫描（service 按 bridge 缺席分派），映射恒空
      return ok([])
    },

    async dependents(targetId): Promise<LibraryReadResult<{ content: string[]; tag: string[]; prop: string[] }>> {
      const out: { content: string[]; tag: string[]; prop: string[] } = { content: [], tag: [], prop: [] }
      walkForest(
        forest(),
        (b) => {
          if (isDeleted(b)) return
          // 正文引用：run 的 `t === 'ref'` 且目标命中
          if (
            b.content.some((r) => (r as { t?: string }).t === 'ref' && (r as { to?: string }).to === targetId)
          ) {
            out.content.push(b.id)
            return
          }
          const tags = b.props?.['_tags']
          const tagFlat = Array.isArray(tags) ? tags.flat() : tags !== undefined ? [tags] : []
          if (tagFlat.includes(targetId)) {
            out.tag.push(b.id)
            return
          }
          for (const [name, value] of Object.entries(b.props ?? {})) {
            if (name.startsWith('_')) continue
            const flat = Array.isArray(value) ? value : [value]
            if (flat.some((v) => JSON.stringify(v) === JSON.stringify(targetId))) {
              out.prop.push(b.id)
              return
            }
          }
        },
        { includeDeleted: false },
      )
      return ok(out)
    },

    async roots(): Promise<LibraryReadResult<string[]>> {
      // 顶层根（含软删根）：rowid 序在内存里就是森林序
      return ok(forest().map((b) => b.id))
    },

    async relations(ids) {
      const pos = positionsOf(forest())
      const rootOf = (id: string): string => {
        let cur = id
        for (;;) {
          const p = pos.get(cur)?.parent ?? null
          if (p === null) return cur
          cur = p
        }
      }
      const rows: { to_id: string; from_id: string; kind: string; from_root: string; count: number | null }[] = []
      const seen = new Set<string>()
      for (const to of ids) {
        for (const e of relationsTo(index(), to)) {
          const key = `${e.from}\u0000${e.to}\u0000${e.kind}`
          if (seen.has(key)) continue
          seen.add(key)
          rows.push({
            to_id: e.to,
            from_id: e.from,
            kind: e.kind,
            from_root: rootOf(e.from),
            count: e.count ?? null,
          })
        }
      }
      return ok({ rows, ready: true })
    },

    async candidates(plan: CandidatePlan): Promise<LibraryReadResult<CandidatePage>> {
      // 内存读面的候选是**超集的最简形状**：能按 id 直达的就直达，其余给全部可见块
      // （matcher 仍是判定的唯一来源；web 体量下「全部可见」就是正确的宽候选）。
      // 没有派生表 ⇒ 没有跨会话稳定的文档序游标 ⇒ 一页装完（`next:null`）。
      if (plan.k === 'none') return ok({ ids: [], next: null })
      if (plan.k === 'ids') {
        const found = findByIds(new Set(plan.ids))
        return ok({ ids: plan.ids.filter((id: string) => found.has(id)), next: null })
      }
      const out: string[] = []
      walkForest(
        forest(),
        (b) => {
          if (!isDeleted(b)) out.push(b.id)
        },
        { includeDeleted: false },
      )
      return ok({ ids: out, next: null })
    },

    async tree(ids, withChildren): Promise<LibraryReadResult<Rows>> {
      if (ids.length === 0) return ok(emptyRows())
      const pos = positionsOf(forest())
      const want = new Set<string>()
      for (const id of ids) {
        if (!pos.has(id)) continue
        want.add(id)
        for (const a of ancestorIdsOf(id, pos)) want.add(a)
      }
      if (withChildren) {
        // 直接子级一层就够：「子块在不在」的判定不需要整棵子树
        for (const [id, p] of pos) {
          if (p.parent !== null && want.has(p.parent)) want.add(id)
        }
      }
      return ok(rowsFor(want))
    },

    async blocks(ids): Promise<LibraryReadResult<Rows>> {
      return ok(rowsFor(ids))
    },

    async catalog(): Promise<LibraryReadResult<LibraryCatalog>> {
      const ws = deps.ws()
      const journals: { id: string; date: string; deleted: number | null }[] = []
      const trash: { id: string; deleted: number }[] = []
      walkForest(
        forest(),
        (b) => {
          // 含软删天：「这一天存在过」是物化判据（恢复同一块，不新建第二个身份）
          if (isJournal(b)) {
            const at = b.props?.[DELETED_AT_PROP]
            journals.push({ id: b.id, date: journalDate(b), deleted: typeof at === 'number' ? at : null })
          }
          if (isDeleted(b)) {
            const at = b.props?.[DELETED_AT_PROP]
            if (typeof at === 'number') trash.push({ id: b.id, deleted: at })
          }
        },
        { includeDeleted: true },
      )
      journals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      trash.sort((a, b) => (a.deleted !== b.deleted ? b.deleted - a.deleted : a.id < b.id ? -1 : 1))
      const lists = ensureIndexLists(index(), forest())
      const tags = lists.tags
        .filter((b) => !isDeleted(b) && aliasesOf(b).length > 0)
        .map((b) => ({ id: b.id, name: aliasesOf(b)[0]! }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const propDefs = lists.propDefs
        .filter((b) => !isDeleted(b))
        .map((b) => ({ id: b.id, kind: String(b.props?.['_kind'] ?? ''), name: aliasesOf(b)[0] ?? null }))
        .sort((a, b) => ((a.name ?? '') < (b.name ?? '') ? -1 : (a.name ?? '') > (b.name ?? '') ? 1 : 0))
      return ok({
        meta: {
          activeId: ws.activeId,
          savedAt: ws.savedAt,
          ftsState: 'pending',
          ftsTokenizer: '',
          ftsRowidSeq: 0,
          derivedState: MEMORY_DERIVED_STATE,
          derivedPathVersion: DERIVED_PATH_VERSION,
        },
        journals,
        tags,
        propDefs,
        trash,
      })
    },

    /**
     * **按名点查归属**：内存读面覆盖**整片森林**（含软删），所以标准工作集装载下
     * 这条读面回答的就是旧全量地址表的那一整个名字空间——这正是它与具名 SQL 读面
     * 对拍的意义（`tests/memory-client.test.ts`）。
     *
     * 归一化键与桌面同一份函数；同一键撞上两块时**先序第一个赢**（与 `Index.aliases`
     * 及桌面 `order by block, pos` 的口径一致）。
     */
    async aliasTargets(names): Promise<LibraryReadResult<AliasTarget[]>> {
      const want = new Set(names.map((n) => normalizeAlias(n)).filter((n) => n !== ''))
      if (want.size === 0) return ok([])
      const hit = new Map<string, string>()
      walkForest(
        forest(),
        (b) => {
          for (const raw of aliasesOf(b)) {
            const key = normalizeAlias(raw)
            if (want.has(key) && !hit.has(key)) hit.set(key, b.id)
          }
        },
        { includeDeleted: true },
      )
      return ok([...hit.entries()].map(([norm, block]) => ({ norm, block })))
    },
  }
}
