/**
 * **派生栏的候选装载**：让「引用／备注／成员／同类／提及／谁在用」在部分装载下也是全库口径。
 *
 * ## 为什么它住 `app/boot/`
 *
 * 读库是装配层的事（`LibraryClient` 只在桌面宿主存在），而「这一栏该装什么」是**视图的
 * 判断**。把这个判断收成一个带依赖的模块，两边都不必知道对方：挂载区只报「哪一格的哪个
 * 来源」，装配层只交出读写面。与流式重建同一条位置感（`app/boot/derived-rebuild.ts`）。
 *
 * ## 两条形状，一条闸
 *
 * · **有 `QuerySpec` 的五个源**（引用／谁在用／成员／同类／提及）：交给查询那条管道
 *   （`ensureQueryLoaded`）——候选从 SQL 来、是超集，matcher 仍是判定源。
 * · **备注栏没有 `QuerySpec`**（`annotates` 不是引用，不进条件语言）：它的候选就是
 *   **关系表里指向本宿主子树的 annotates 边**（`relations` 读面，同一张 `BlockRelation`），
 *   把来源块按 id 连祖先链装进来，内存索引随即自己长出这批记录。
 *
 * 两条都走同一道闸：`derived_state` 不是 `ready` ⇒ 什么都不装（退回工作集口径），
 * 而不是把半张表当真。**返回「这次真的装进了新块」**——调用方据此只重画一次，
 * 不装的时候不该引起重画。
 */
import type { QueryContext, QuerySpec } from '../../core/query/query.ts'
import type { Block } from '../../core/model/model.ts'
import { walkForest } from '../../core/model/walk.ts'
import type { LibraryClient } from '../../core/storage/library-client.ts'
import type { Workset } from '../../core/storage/workset.ts'
import { derivedSpecOf, type DerivedSource } from '../../core/views/mount.ts'

/**
 * 这一层要的「存储」只有三格（判工作集、判已装载、构条件用的森林）。
 *
 * 不 import `BlockStore` 的类型：`app/` 不许碰块存储的类（装配层才持有它）。
 * `BlockStore` 结构上就满足这三格 ⇒ 装配层直接把实例交进来。
 */
export interface DerivedLoadStore {
  readonly partial: boolean
  isLoaded(id: string): boolean
  readonly blocks: readonly Block[]
}

export interface DerivedLoadDeps {
  /** 库读面（web 单库没有 ⇒ 不装：那里的内存读面本来就是全量） */
  client: LibraryClient | null
  /** 工作集（装载落点） */
  workset: Workset | null
  /** 判工作集 / 判已装载 / 构条件用的森林（见 `DerivedLoadStore`） */
  store: DerivedLoadStore
  /** 查询候选装载：与查询视图同一个函数（装配层的 `ensureQueryLoaded`） */
  ensureQueryLoaded: (spec: QuerySpec, ctx: QueryContext, host: Block | undefined) => Promise<boolean>
}

/** 这一栏的候选装进工作集了没有（`true` ＝ 真的装进了新块，值得重画一次） */
export async function ensureDerivedLoaded(
  deps: DerivedLoadDeps,
  host: Block,
  source: DerivedSource,
): Promise<boolean> {
  const { client, workset, store } = deps
  if (!client || !workset || !store.partial) return false
  if (source === 'notes') return ensureNotesLoaded(deps, host)
  const spec = derivedSpecOf(host, store.blocks, source)
  if (!spec) return false
  return deps.ensureQueryLoaded(spec, { selfId: host.id, excludeIds: [host.id] }, host)
}

/**
 * 备注栏的候选：宿主子树为**目标**的 annotates 边 → 来源块（连祖先链）。
 *
 * 只装「还没装载」的那些：已装载的来源块本来就在内存索引里，再装一遍会白读。
 * `ready:false` ⇒ 关系表还没重建完，退回工作集口径（与引用角标同一条退回）。
 */
async function ensureNotesLoaded(deps: DerivedLoadDeps, host: Block): Promise<boolean> {
  const { client, workset, store } = deps
  const targets = new Set<string>()
  walkForest([host], (b) => {
    targets.add(b.id)
  })
  const r = await client!.relations([...targets])
  if (r.status !== 'ok') throw new Error(`library/relations: ${r.status === 'error' ? r.error : r.status}`)
  if (!r.value.ready) return false
  const sources = [
    ...new Set(
      r.value.rows
        .filter((x) => x.kind === 'annotates' && !store.isLoaded(x.from_id))
        .map((x) => x.from_id),
    ),
  ]
  if (sources.length === 0) return false
  const rows = await client!.tree(sources, false)
  if (rows.status !== 'ok') throw new Error(`library/tree: ${rows.status === 'error' ? rows.error : rows.status}`)
  workset!.loadBlocks(rows.value, true)
  return true
}
