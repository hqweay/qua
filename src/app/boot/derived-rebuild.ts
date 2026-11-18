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
 * ## 与增量维护的交接
 *
 * 编辑中的增量行（层 2 的 `relationWritesFor`）与本重建写同一批表；重建期间用户
 * 改了某块 ⇒ 增量行先/后到都可能，**源块的下一次编辑会自愈**——登记为已知的
 * 小窗口，不做锁。
 */
import { derivedRowWrites, derivedRowsOf } from '../../core/storage/derived-rows.ts'
import { rowsToWorkspace } from '../../core/storage/db-rows.ts'
import { META_KEYS } from '../../core/identity/library.ts'
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
  let done = 0
  let failed = 0
  for (const rootId of roots) {
    if (deps.shouldCancel?.()) return { ok: false, done, total: roots.length, failed }
    const doc = await deps.client.doc([rootId])
    if (doc.status !== 'ok') {
      console.warn('[derived] root read failed:', rootId, doc.status === 'error' ? doc.error : doc.status)
      failed++
      continue
    }
    const forest = rowsToWorkspace(doc.value.rows).blocks
    const saved = await deps.store.commitRaw(derivedRowWrites(derivedRowsOf(forest)))
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
    ])
    if (!saved.ok) return { ok: false, done, total: roots.length, failed: 1 }
  }
  return { ok: failed === 0 && done === roots.length, done, total: roots.length, failed }
}
