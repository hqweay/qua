/**
 * **派生表的流式重建**（层 5 bulk 的第一片）：按顶层根逐批「读子树 → 算派生行 →
 * 同队列落盘」，跑完置 `derived_state='ready'`。
 *
 * ## 为什么按根逐批，而不是一次全量
 *
 * 一次全量要把整库行读进渲染层（那是层 1 消灭掉的形状）；逐根批的内存是
 * O(单棵子树)，落盘是每根一个小事务——与用户输入的写入在同一队列里交错，
 * 不抢锁也不阻塞首帧。失败按根记账：**有失败就不置 ready**（半表比空表更危险，
 * ready 是「可以信」的承诺）。
 *
 * ⚠️ **顶层的段值必须先整层分配好**（`topRanksOf`）：逐根算时每棵只有一个顶层根，
 * 段编码会把每一根都铺成段 1。撞车后候选流按 `path > cursor` 翻页会静默少行。
 * 读存量段值只为少改路径；撞车/缺失/乱序一律按文档序整层重铺。
 *
 * ## 与增量维护的交接
 *
 * 编辑中的增量行（层 2 的 `relationWritesFor`）与本重建写同一批表；重建期间用户
 * 改了某块 ⇒ 增量行先/后到都可能，**源块的下一次编辑会自愈**——登记为已知的
 * 小窗口，不做锁。
 */
import { DERIVED_PATH_VERSION, META_KEYS } from '../../core/identity/library.ts'
import { derivedRowWrites, derivedRowsOf, topRanksOf } from '../../core/storage/derived-rows.ts'
import { rowsToWorkspace } from '../../core/storage/db-rows.ts'
import type { LibraryClient } from '../../core/storage/library-client.ts'
import type { WorkspaceStore } from '../../core/storage/index.ts'

export interface DerivedRebuildDeps {
  client: LibraryClient
  store: WorkspaceStore
  onProgress?: (done: number, total: number) => void
  shouldCancel?: () => boolean
}

export interface DerivedRebuildResult {
  ok: boolean
  done: number
  total: number
  failed: number
}

export async function rebuildDerivedTables(deps: DerivedRebuildDeps): Promise<DerivedRebuildResult> {
  const r = await deps.client.roots()
  if (r.status !== 'ok') {
    console.warn('[derived] root list failed:', r.status === 'error' ? r.error : r.status)
    return { ok: false, done: 0, total: 0, failed: 0 }
  }
  const roots = r.value
  /**
   * **顶层段要先整层分配好，再逐根写。** 逐根算时每棵子树只有一个顶层根，
   * 编码器会把段 1 给每一根（37 个根同段：`docWindow` 跨根、候选流 `path > cursor`
   * 跳行）。分配见 `topRanksOf`：优先保留存量段值，撞车/缺失/乱序才按文档序重铺。
   *
   * 读不到现有行（web 无派生表读面）⇒ 按空表处理 ⇒ 整层重铺；重铺本身是对的，
   * 只是不再保留原有段值。
   */
  let existing: { block: string; path: string }[] = []
  const readChildren = deps.client.indexChildren?.bind(deps.client)
  if (readChildren) {
    const prev = await readChildren(null)
    if (prev.status === 'ok') existing = prev.value
    else console.warn('[derived] top-level index read failed:', prev.status === 'error' ? prev.error : prev.status)
  }
  const ranks = topRanksOf(roots, existing)
  let done = 0
  let failed = 0
  for (const [i, rootId] of roots.entries()) {
    if (deps.shouldCancel?.()) return { ok: false, done, total: roots.length, failed }
    const doc = await deps.client.doc([rootId])
    if (doc.status !== 'ok') {
      console.warn('[derived] root read failed:', rootId, doc.status === 'error' ? doc.error : doc.status)
      failed++
      continue
    }
    const forest = rowsToWorkspace(doc.value.rows).blocks
    // `doc(root)` 的契约是一棵子树；根数不对说明读面坏了——不把一格 rank 乱铺到别处
    if (forest.length !== 1) {
      console.warn('[derived] root read is not a single subtree:', rootId, `top=${forest.length}`)
      failed++
      continue
    }
    const saved = await deps.store.commitRaw(
      derivedRowWrites(derivedRowsOf(forest, { topRanks: [ranks[i]!] })),
    )
    if (!saved.ok) {
      console.warn('[derived] root write failed:', rootId, String(saved.error))
      failed++
      continue
    }
    done++
    deps.onProgress?.(done, roots.length)
  }
  // 全部成功才置 ready：半表比空表更危险（ready 是「可以信」的承诺）
  if (failed === 0 && done === roots.length) {
    const saved = await deps.store.commitRaw([
      { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedState }, values: { value: 'ready' } },
      { table: 'meta', op: 'upsert', key: { key: META_KEYS.derivedPathVersion }, values: { value: DERIVED_PATH_VERSION } },
    ])
    if (!saved.ok) return { ok: false, done, total: roots.length, failed: 1 }
  }
  return { ok: failed === 0 && done === roots.length, done, total: roots.length, failed }
}
