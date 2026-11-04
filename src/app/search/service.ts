/**
 * 搜索的**运行时门面**：查询走 FTS 还是扫描、索引什么时候重建，都在这一处回答。
 *
 * 三条口径：
 *   · **只有 `ready` 才相信索引**；其余状态一律扫描（用户不该因为「索引还没建完」就搜不到）；
 *   · **重建失败不连累正文**：索引是派生数据，状态留在 pending，下一次打开可以重来；
 *   · **重建期间的编辑被跳过**：不标 ready，宁可再建一轮，也不让索引缺一块却看起来正常。
 */
import type { Block } from '../../core/model/model.ts'
import { findInForest } from '../../core/model/tree.ts'
import type { RowWrite } from '../../core/storage/db-rows.ts'
import type { FtsState } from '../../core/storage/fts-port.ts'
import { compileMatch, scanSearch } from '../../core/search/query.ts'
import { FTS_TOKENIZER_VERSION } from '../../core/search/tokenizer.ts'
import { SearchIndexer, type SearchSnapshot, type TokenizeMany } from './indexer.ts'
import { rebuildSearch } from './rebuild.ts'
import { createTokenizerClient, type TokenizerClient } from './tokenizer-client.ts'

export interface SearchHit {
  blockId: string
  /** BM25 分数（越小越相关）；扫描降级时为 0 */
  score: number
}

export interface SearchResult {
  hits: SearchHit[]
  mode: 'fts' | 'scan'
}

/** 只取搜索需要的那一格桥面（`LibraryBridge` 的子集，测试可以只实现它） */
export interface SearchBridge {
  save(writes: unknown[], opts?: { replace?: boolean; oplog?: unknown[] }): Promise<unknown>
  search?(match: string, limit: number, offset?: number): Promise<unknown>
}

export interface SearchService {
  /** 交给存储门面：增量索引与内容行同一批 */
  readonly indexer: SearchIndexer
  query(text: string, limit?: number): Promise<SearchResult>
  /** 开库后调一次：需要重建就后台建 */
  start(): void
  /** 显式重建（诊断／测试） */
  rebuild(): Promise<void>
  status(): FtsState
  /** 这一次查询会不会走索引（UI 用来显示降级提示） */
  mode(): 'fts' | 'scan'
  dispose(): void
}

export interface SearchDeps {
  bridge: SearchBridge | null
  forest: () => Block[]
  snapshot?: SearchSnapshot
  /** 单测注入；缺省用 worker 客户端 */
  tokenizer?: TokenizeMany
  /** 重建结束后有编辑被跳过 ⇒ 再排一轮的延迟 */
  retryDelayMs?: number
}

export function createSearchService(deps: SearchDeps): SearchService {
  const bridge = deps.bridge
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let inflight: Promise<void> | null = null
  let client: TokenizerClient | null = null

  /**
   * 状态口径在进服务时收一次：旧分词器版本／`building`（上次没走完）都当 pending。
   * 这样后面的查询与重建只需要回答「ready 还是不是」。
   */
  const snapshot: SearchSnapshot | undefined = deps.snapshot
    ? {
        ...deps.snapshot,
        state:
          deps.snapshot.state === 'ready' && deps.snapshot.tokenizer === FTS_TOKENIZER_VERSION
            ? 'ready'
            : 'pending',
      }
    : undefined

  const tokenize: TokenizeMany = deps.tokenizer
    ? deps.tokenizer
    : async (items) => {
        if (!client) client = createTokenizerClient()
        return client.tokenize(items)
      }

  const indexer = new SearchIndexer(snapshot, tokenize, () => start())
  const canFts = Boolean(bridge?.search)

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  async function saveWrites(writes: readonly RowWrite[]): Promise<{ ok: true } | { ok: false; error: unknown }> {
    if (!bridge) return { ok: false, error: 'no library' }
    try {
      const r = (await bridge.save(writes as unknown[])) as { ok?: boolean; error?: unknown } | null
      return r && r.ok === true ? { ok: true } : { ok: false, error: r?.error ?? 'save failed' }
    } catch (error) {
      return { ok: false, error }
    }
  }

  function schedule(delay = 0): void {
    if (disposed || !bridge || !canFts) return
    if (inflight) return
    /**
     * 立即重建（不走定时器）：桌面壳在启动期可能把定时器与 worker 一起按后台页冻结，
     * 等 `load`／用户第一次搜索再建，才不会出现「索引永远停在 pending」。
     */
    if (delay <= 0) {
      void rebuild()
      return
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void rebuild()
    }, delay)
  }

  async function rebuild(): Promise<void> {
    if (disposed || !bridge || !canFts) return
    if (inflight) return inflight
    inflight = (async () => {
      const r = await rebuildSearch({ forest: deps.forest, indexer, save: saveWrites })
      if (!r.ok) console.warn('[search] rebuild failed; fall back to scanning')
      // 重建期间有编辑被跳过：稍后再来一轮（不立刻重入，避免输入期间空转）
      if (r.ok && !r.clean) schedule(deps.retryDelayMs ?? 1500)
    })().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function scan(text: string, limit: number): Promise<SearchResult> {
    return { hits: scanSearch(deps.forest(), text, limit).map((blockId) => ({ blockId, score: 0 })), mode: 'scan' }
  }

  /**
   * 「该建索引了」的**唯一入口**：等页面加载完再建。
   *
   * 为什么不等模块初始化就建：启动期渲染器还没真正活起来，worker 与定时器都可能
   * 被宿主按后台页冻结（桌面壳里窗口还没 show）。等 `load` 之后建，代价只是
   * 「第一次搜索先走扫描」，而索引仍在后台补齐。
   */
  function start(): void {
    if (disposed || !bridge || !canFts) return
    if (indexer.status === 'ready') return
    const kick = (): void => schedule()
    if (typeof document === 'undefined' || document.readyState === 'complete') kick()
    else window.addEventListener('load', kick, { once: true })
  }

  return {
    indexer,

    async query(text, limit = 50): Promise<SearchResult> {
      const n = Math.max(1, Math.min(200, Math.trunc(limit)))
      if (text.trim() === '') return { hits: [], mode: indexer.ready ? 'fts' : 'scan' }
      if (!indexer.ready || !bridge?.search) {
        // 用户开始搜索了：这是最可靠的「渲染器已活」信号，顺手把索引排上
        if (bridge && canFts) start()
        return scan(text, n)
      }
      const match = compileMatch(text)
      if (!match) return { hits: [], mode: 'fts' }
      try {
        const reply = (await bridge.search(match, n)) as
          | { status?: string; hits?: { blockId?: unknown; score?: unknown }[] }
          | null
        if (!reply || reply.status !== 'ok' || !Array.isArray(reply.hits)) return scan(text, n)
        const forest = deps.forest()
        const hits: SearchHit[] = []
        for (const h of reply.hits) {
          if (typeof h.blockId !== 'string') continue
          // 索引里可能还有刚被软删的块（删除那一批还没来得及落盘）⇒ 结果以模型为准
          if (!findInForest(forest, h.blockId)) continue
          hits.push({ blockId: h.blockId, score: typeof h.score === 'number' ? h.score : 0 })
          if (hits.length >= n) break
        }
        return { hits, mode: 'fts' }
      } catch (err) {
        console.warn(`[search] fts query failed; falling back to scan: ${err instanceof Error ? err.message : String(err)}`)
        return scan(text, n)
      }
    },

    start,

    rebuild,

    status: () => indexer.status,
    mode: () => (indexer.ready ? 'fts' : 'scan'),

    dispose() {
      disposed = true
      clearTimer()
      client?.dispose()
      client = null
    },
  }
}
