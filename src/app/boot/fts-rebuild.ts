/**
 * **FTS 的流式后台重建**（层 5 bulk）：按顶层根逐批「读子树 → 算索引行 → 同队列落盘」，
 * 全部成功才置 `fts_state='ready'`。
 *
 * ## 为什么必须有这一条
 *
 * 工作集模式下启动路径不读全库，内存森林只有已装载块——旧的整森林重建
 * （`rebuild.ts`）会把索引建残，所以被 `isPartial` 闸住。结果是新库（种子后）/
 * 分词器升版的库永远停在 `pending`，⌘K 显式空。流式重建补上这一段：
 * 读的单位是根（与派生重建同形状），内存 O(单棵子树)，落盘每根一个小事务，
 * 与用户输入在同一串行队列里交错。
 *
 * ## helper 闭包
 *
 * 索引文本不只来自切片自己的块：tag 行要标签块的名字、prop 行要定义块的 kind、
 * link 行要引用目标的现算名。切片森林里没有跨子树的块 ⇒ 每根先算 helper 清单，
 * 缺的按 id 从库里补进来（`ftsWantedIds` 是唯一判据）。缺一个，那个来源行就
 * 静默少词——搜标签名找不到归属块这种错，用户只能感知为「搜索不可信」。
 *
 * ## 失败与 dirty
 *
 * 与派生重建同一条承诺：**有失败就不置 ready**。重建期间的编辑被增量路径跳过
 * （两份身份不能并存）⇒ 结尾按 dirty 判据重试一轮（与整森林重建同一上限）；
 * 跑不完的部分等下次打开重来。清表发生在开头——迁移老库（索引已 ready）根本
 * 不会进这条路径，所以「建一半失败」只发生在本来就没有可用索引的库上。
 */
import { rowsToWorkspace, type RowWrite } from '../../core/storage/db-rows.ts'
import { META_KEYS } from '../../core/identity/library.ts'
import { FTS_TOKENIZER_VERSION } from '../../core/search/tokenizer.ts'
import { ftsWantedIds } from '../../core/search/rows.ts'
import type { Block } from '../../core/model/model.ts'
import { walkForest } from '../../core/model/walk.ts'
import type { SearchIndexer } from '../search/indexer.ts'
import type { LibraryClient } from '../../core/storage/library-client.ts'
import type { WorkspaceStore } from '../../core/storage/index.ts'

export interface FtsRebuildDeps {
  client: LibraryClient
  store: WorkspaceStore
  indexer: SearchIndexer
  onProgress?: (done: number, total: number) => void
  shouldCancel?: () => boolean
}

export interface FtsRebuildResult {
  ok: boolean
  done: number
  total: number
  failed: number
}

function meta(key: string, value: string): RowWrite {
  return { table: 'meta', op: 'upsert', key: { key }, values: { value } }
}

/** 整森林重建的脏判据重试上限（同一份答案，不另写一份） */
const MAX_ATTEMPTS = 4

export async function rebuildFtsStreaming(deps: FtsRebuildDeps): Promise<FtsRebuildResult> {
  const r = await deps.client.roots()
  if (r.status !== 'ok') {
    console.warn('[fts] root list failed:', r.status === 'error' ? r.error : r.status)
    return { ok: false, done: 0, total: 0, failed: 0 }
  }
  const roots = r.value

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const pass = await rebuildPass(deps, roots)
    if (pass.cancelled) return { ok: false, done: pass.done, total: roots.length, failed: pass.failed }
    if (!pass.ok || !pass.dirty) return pass.result
    // 期间有编辑被跳过：索引还差一批——按当前内容再来一轮（整森林重建同一条规则）
  }
  return { ok: false, done: 0, total: roots.length, failed: 0 }
}

type PassResult = {
  ok: boolean
  dirty: boolean
  cancelled: boolean
  done: number
  failed: number
  result: FtsRebuildResult
}

async function rebuildPass(deps: FtsRebuildDeps, roots: readonly string[]): Promise<PassResult> {
  const { indexer } = deps
  indexer.beginRebuild()
  const reset = await deps.store.commitRaw([
    { table: 'BlockFTS', op: 'clear', key: {} },
    { table: 'BlockFTSMap', op: 'clear', key: {} },
    meta(META_KEYS.ftsState, 'building'),
    meta(META_KEYS.ftsRowidSeq, '0'),
  ])
  if (!reset.ok) {
    indexer.failRebuild()
    return { ok: false, dirty: false, cancelled: false, done: 0, failed: roots.length, result: { ok: false, done: 0, total: roots.length, failed: roots.length } }
  }

  let done = 0
  let failed = 0
  for (const rootId of roots) {
    if (deps.shouldCancel?.()) {
      return { ok: false, dirty: false, cancelled: true, done, failed, result: { ok: false, done, total: roots.length, failed } }
    }
    const doc = await deps.client.doc([rootId])
    if (doc.status !== 'ok') {
      console.warn('[fts] root read failed:', rootId, doc.status === 'error' ? doc.error : doc.status)
      failed++
      continue
    }
    const forest = rowsToWorkspace(doc.value.rows).blocks
    const ids = new Set<string>()
    walkForest(
      forest,
      (b) => {
        ids.add(b.id)
      },
      { includeDeleted: false },
    )
    // helper 闭包：跨子树的标签/定义/引用目标从库里补齐，来源文本才与整森林重建同解
    const wanted = ftsWantedIds({ blocks: forest, activeId: '', savedAt: 0 }, ids)
    const have = new Set(ids)
    const missing = wanted.filter((id) => !have.has(id))
    let helperBlocks: Block[] = []
    if (missing.length > 0) {
      const h = await deps.client.blocks(missing)
      if (h.status !== 'ok') {
        console.warn('[fts] helper read failed:', rootId, h.status === 'error' ? h.error : h.status)
        failed++
        continue
      }
      helperBlocks = rowsToWorkspace(h.value).blocks
    }
    const built = await indexer.planRebuild(
      { blocks: [...forest, ...helperBlocks], activeId: '', savedAt: 0 },
      ids,
    )
    const saved = await deps.store.commitRaw([
      ...built.writes,
      meta(META_KEYS.ftsRowidSeq, String(indexer.currentRowid)),
    ])
    if (!saved.ok) {
      console.warn('[fts] root write failed:', rootId, String(saved.error))
      indexer.failRebuild()
      return { ok: false, dirty: false, cancelled: false, done, failed: failed + 1, result: { ok: false, done, total: roots.length, failed: failed + 1 } }
    }
    done++
    deps.onProgress?.(done, roots.length)
  }

  // 全部成功才置 ready；有失败把状态拉回 pending（增量索引恢复接流，下次打开再来）
  if (failed > 0 || done < roots.length) {
    indexer.failRebuild()
    return { ok: false, dirty: false, cancelled: false, done, failed, result: { ok: false, done, total: roots.length, failed } }
  }
  if (indexer.dirtyDuringBuild) {
    await deps.store.commitRaw([meta(META_KEYS.ftsState, 'pending')])
    indexer.endRebuild(FTS_TOKENIZER_VERSION, true)
    return { ok: true, dirty: true, cancelled: false, done, failed, result: { ok: false, done, total: roots.length, failed } }
  }
  const ready = await deps.store.commitRaw([
    meta(META_KEYS.ftsState, 'ready'),
    meta(META_KEYS.ftsTokenizer, FTS_TOKENIZER_VERSION),
    meta(META_KEYS.ftsRowidSeq, String(indexer.currentRowid)),
  ])
  if (!ready.ok) {
    indexer.failRebuild()
    return { ok: false, dirty: false, cancelled: false, done, failed, result: { ok: false, done, total: roots.length, failed } }
  }
  const clean = indexer.endRebuild(FTS_TOKENIZER_VERSION, false)
  if (!clean) await deps.store.commitRaw([meta(META_KEYS.ftsState, 'pending')])
  return { ok: clean, dirty: !clean, cancelled: false, done, failed, result: { ok: clean, done, total: roots.length, failed } }
}
