/**
 * 全量重建：清表 → 按活块分批分词 → 写索引 → 推进 `fts_state`。
 *
 * 为什么分批而不是一口气：分词在 worker 里，但**写库在主进程**。一批 500 块
 * 让事件循环有机会处理输入与渲染；100k 块的整库重建因此不会变成一次长卡顿。
 *
 * 失败语义：**保留 pending／building**，查询继续走扫描。索引是派生数据，
 * 没有「必须建成功才能搜」的道理；下一次打开可以重来。
 */
import { walkForest } from '../../core/model/walk.ts'
import type { Block } from '../../core/model/model.ts'
import type { RowWrite } from '../../core/storage/db-rows.ts'
import { META_KEYS } from '../../core/identity/library.ts'
import { FTS_TOKENIZER_VERSION } from '../../core/search/tokenizer.ts'
import type { SearchIndexer } from './indexer.ts'

export interface RebuildDeps {
  forest: () => Block[]
  indexer: SearchIndexer
  /** 落一批行写入（主进程同一个事务）；失败如实返回 */
  save: (writes: readonly RowWrite[]) => Promise<{ ok: true } | { ok: false; error: unknown }>
  onProgress?: (done: number, total: number) => void
}

export interface RebuildResult {
  ok: boolean
  /** false ＝ 重建期间有编辑被跳过，索引还差一批（调用方应再排一轮） */
  clean: boolean
}

/** 一批多少块：够大（摊薄往返）又够小（一批写库不长时间占住主进程） */
const BATCH = 500

function meta(key: string, value: string): RowWrite {
  return { table: 'meta', op: 'upsert', key: { key }, values: { value } }
}

export async function rebuildSearch(deps: RebuildDeps): Promise<RebuildResult> {
  /**
   * 一轮建完若发现「期间有编辑被跳过」，**当场再来一轮**（不挂在定时器上）：
   * 桌面壳会把后台定时器冻住，挂 timer 的补建在窗口还没显示时会永远等不到。
   * 连续两轮仍不干净才交回 pending，搜索继续扫描，下一次查询会再排。
   */
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await rebuildOnce(deps)
    if (!r.ok || r.clean) return r
  }
  return { ok: true, clean: false }
}

async function rebuildOnce(deps: RebuildDeps): Promise<RebuildResult> {
  const { indexer } = deps
  indexer.beginRebuild()

  const reset: RowWrite[] = [
    { table: 'BlockFTS', op: 'clear', key: {} },
    { table: 'BlockFTSMap', op: 'clear', key: {} },
    meta(META_KEYS.ftsState, 'building'),
    meta(META_KEYS.ftsRowidSeq, '0'),
  ]
  const started = await deps.save(reset)
  if (!started.ok) {
    indexer.failRebuild()
    return { ok: false, clean: false }
  }

  const ids: string[] = []
  walkForest(deps.forest(), (b) => {
    // 不按「有没有正文」筛：别名／标签／属性值同样成行，该不该建由文本计划逐来源判
    ids.push(b.id)
  })
  const ws = { blocks: deps.forest(), activeId: '', savedAt: 0 }

  let done = 0
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const built = await indexer.planRebuild(ws, new Set(slice))
    const writes: RowWrite[] = [...built.writes, meta(META_KEYS.ftsRowidSeq, String(indexer.currentRowid))]
    const saved = await deps.save(writes)
    if (!saved.ok) {
      indexer.failRebuild()
      return { ok: false, clean: false }
    }
    done += slice.length
    deps.onProgress?.(done, ids.length)
  }

  // 重建期间有编辑被跳过 ⇒ 还不能相信索引：保留 pending，交给下一轮
  if (indexer.dirtyDuringBuild) {
    await deps.save([meta(META_KEYS.ftsState, 'pending')])
    indexer.endRebuild(FTS_TOKENIZER_VERSION, true)
    return { ok: true, clean: false }
  }

  const ready: RowWrite[] = [
    meta(META_KEYS.ftsState, 'ready'),
    meta(META_KEYS.ftsTokenizer, FTS_TOKENIZER_VERSION),
    meta(META_KEYS.ftsRowidSeq, String(indexer.currentRowid)),
  ]
  const saved = await deps.save(ready)
  if (!saved.ok) {
    indexer.failRebuild()
    return { ok: false, clean: false }
  }
  /**
   * 写 ready 这一批 await 期间可能又有编辑进来（`plan` 看到 rebuilding 会跳过它）。
   * `endRebuild` 会再判一次 dirty：不干净就把状态压回 pending，并补写一条 meta，
   * 让「本次打开」与「下次打开」看到同一个答案。
   */
  const clean = indexer.endRebuild(FTS_TOKENIZER_VERSION, false)
  if (!clean) await deps.save([meta(META_KEYS.ftsState, 'pending')])
  return { ok: true, clean }
}
