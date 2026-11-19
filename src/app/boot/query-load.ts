/**
 * **候选流的分页装载**：查询与派生栏共用的**唯一**装载原语。
 *
 * ## 为什么分页的单位是「候选」而不是「结果」
 *
 * 判定（matcher）在渲染层，SQL 只给候选超集 ⇒ 「一页结果」只能由「装进一页候选、判一遍」
 * 得到。因此这里只做一件事：**取一页候选装进工作集**，游标是 `BlockIndex.path` 的 keyset
 * （上一页最后一条的 path）。调用方每取一页就重新求值，直到「命中够了」或「到底」——
 * 早停的口径在调用方：**有 `sort` 的条件必须取到底**（全局排序需要全集），
 * 文档序的条件可以按命中数早停。
 *
 * ## 两条不变量
 *
 * 1. **一次只问一页**（`CANDIDATE_PAGE`）：旧的一次性装载把「缺的候选」全部交给一个
 *    id 列表读面，超过传输上限就整批 `bad-args`（查询对用户静默少行）。分页让每次
 *    消息都在上限之内，不需要另一条「分片」的路。
 * 2. **web／整库模式不装载**：`store.partial` 为假时求值天然完整，返回 `next: null`
 *    （＝到底），调用方据此不再问——同一形状，不是另一条分支。
 */
import type { Block } from '../../core/model/model.ts'
import type { QueryContext, QuerySpec } from '../../core/query/query.ts'
import type { CandidateLoadStep, CandidateWindowRequest, LibraryClient } from '../../core/storage/library-client.ts'
import { candidateBuildOf } from '../../core/storage/query-candidates.ts'
import { worksetClosureIds, type Workset } from '../../core/storage/workset.ts'

/**
 * 一页候选的条数。
 *
 * 上限由传输契约给（一次 id 列表读面 ≤ 512），这里取 400 留余量：一页＝一次候选查询
 * ＋一次树装载，与 250ms 的落盘防抖同一个量级。
 */
export const CANDIDATE_PAGE = 400

/**
 * 这一层要的「存储」只有四格（判工作集、判已装载、构条件用的森林、按 id 取块）。
 * 不 import `BlockStore` 的类型：`app/` 不许碰块存储的类（装配层才持有它）。
 */
export interface QueryLoadStore {
  readonly partial: boolean
  isLoaded(id: string): boolean
  readonly blocks: readonly Block[]
  find(id: string): Block | undefined
}

export interface QueryLoadDeps {
  /** 库读面（web 单库没有 ⇒ 不装载：那里的内存读面本来就是全量） */
  client: LibraryClient | null
  /** 工作集（装载落点） */
  workset: Workset | null
  /** 判工作集 / 判已装载 / 构条件用的森林（见 `QueryLoadStore`） */
  store: QueryLoadStore
}

/** 一页装载的结果（形状住 core：`ui` 不许 import `app`） */
export type LoadStep = CandidateLoadStep

/**
 * 取**一页**候选装进工作集。
 *
 * 除了候选本身，还要把 matcher 环境要的两样一起装（与旧路径同一条口径，不是新概念）：
 * 条件里点名的标签／定义块，以及候选身上的引用目标／标签／字段定义（第二跳闭包）。
 */
export async function loadCandidatePage(
  deps: QueryLoadDeps,
  spec: QuerySpec,
  ctx: QueryContext,
  host: Block | undefined,
  after: string | null,
): Promise<LoadStep> {
  const { client, workset, store } = deps
  if (!client || !workset || !store.partial) return { loaded: false, next: null }
  const build = candidateBuildOf(spec, host, store.blocks, ctx)
  let loaded = false

  const named = build.loadIds.filter((id) => !store.isLoaded(id))
  if (named.length > 0) {
    const r = await client.blocks(named)
    if (r.status === 'ok') {
      workset.loadBlocks(r.value)
      loaded = true
    }
  }

  const page = await client.candidates(build.plan, { after, limit: CANDIDATE_PAGE })
  if (page.status !== 'ok') {
    throw new Error(`library/candidates: ${page.status === 'error' ? page.error : page.status}`)
  }
  const missing = page.value.ids.filter((id) => !store.isLoaded(id))
  if (missing.length > 0) {
    const rows = await client.tree(missing, build.children)
    if (rows.status !== 'ok') throw new Error(`library/tree: ${rows.status === 'error' ? rows.error : rows.status}`)
    workset.loadBlocks(rows.value, true)
    loaded = true
  }

  const pageBlocks = page.value.ids
    .map((id) => store.find(id))
    .filter((b): b is Block => b !== undefined)
  const closure = worksetClosureIds(pageBlocks, build.loadIds).filter((id) => !store.isLoaded(id))
  if (closure.length > 0) {
    const r = await client.blocks(closure)
    if (r.status === 'ok') {
      workset.loadBlocks(r.value)
      loaded = true
    }
  }

  return { loaded, next: page.value.next }
}

/** 一窗的硬上限（库坏了／游标不动时的刹车；正常一两页就够） */
const WINDOW_MAX_PAGES = 50

/** 补一窗的请求（形状住 core：`ui` 与这里共用同一个契约） */
export type WindowOpts = CandidateWindowRequest

/**
 * **取一窗候选**：一页页取到「命中够 `target`」或「到底」。
 *
 * 早停只有这一处判据（调用方给 `target`／`hits`）：文档序下先出现的就排在前面，
 * 多取不会改变已出行的位置；**有排序的条件必须取到底**——全局排序需要全集，
 * 提前停会让顺序错，而且每一页都会把已出行重排一次。
 */
export async function loadCandidateWindow(
  deps: QueryLoadDeps,
  spec: QuerySpec,
  ctx: QueryContext,
  host: Block | undefined,
  opts: WindowOpts,
): Promise<LoadStep> {
  let after = opts.after
  let loaded = false
  for (let i = 0; i < WINDOW_MAX_PAGES; i++) {
    const step = await loadCandidatePage(deps, spec, ctx, host, after)
    loaded = loaded || step.loaded
    after = step.next
    opts.onPage?.(step)
    if (after === null) break
    if (!opts.hits) break
    if (opts.hits() >= opts.target) break
  }
  return { loaded, next: after }
}
