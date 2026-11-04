/**
 * 渲染层的**索引状态**：块 id ↔ FTS rowid、状态、下一次分配。
 *
 * 它只做「按计划改内存」这一件事；真正的分词由注入的 `tokenize` 完成
 * （worker 或测试里的假实现）。这样索引逻辑能在 Node 单测里跑，不需要 WASM。
 */
import type { Op } from '../../core/kb/types.ts'
import type { StoredWorkspace } from '../../core/storage/db-rows.ts'
import type { FtsCommitPlan, FtsCommitSource } from '../../core/storage/fts-port.ts'
import type { TokenizedText } from '../../core/search/tokenizer.ts'
import { buildFtsWrites, ftsTargets, indexTexts } from '../../core/search/rows.ts'

/** `pending`／`building` 时查询降级扫描；只有 `ready` 才相信索引 */
export type FtsState = 'pending' | 'building' | 'ready'

export interface SearchSnapshot {
  map: Map<string, number>
  state: FtsState
  rowidSeq: number
  /** 建索引时用的分词器版本；与当前版本不一致 ⇒ 作废重建 */
  tokenizer: string
}

export type TokenizeMany = (items: readonly { id: string; text: string }[]) => Promise<Map<string, TokenizedText>>

/** 单测／降级用的同步分词器包装（真实实现是 worker） */
export function tokenizeManyWith(
  fn: (text: string) => TokenizedText,
): TokenizeMany {
  return async (items) => new Map(items.map((x) => [x.id, fn(x.text)] as const))
}

export class SearchIndexer implements FtsCommitSource {
  private map: Map<string, number>
  private rowid: number
  private state: FtsState
  private tokenizer: string
  /** 重建期间不接增量写：重建会整表重铺，增量插进来只会制造两份身份 */
  private rebuilding = false
  private dirtyDuringRebuild = false
  /**
   * 索引还没就绪时的编辑：这批被跳过了，但重建会读到**当前**森林，
   * 所以只要在 `beginRebuild` 清掉它，重建成功就等于把这批补上了。
   * 不记它就会出现「重建跑完、编辑没进索引、状态却是 ready」的静默漏。
   */
  private dirtyWhileUnindexed = false
  private readonly tokenize: TokenizeMany
  private readonly onNeedsRebuild: () => void

  constructor(
    snapshot: SearchSnapshot | undefined,
    tokenize: TokenizeMany,
    onNeedsRebuild: () => void,
  ) {
    this.map = new Map(snapshot?.map ?? [])
    this.rowid = snapshot?.rowidSeq ?? 0
    this.state = snapshot?.state ?? 'pending'
    this.tokenizer = snapshot?.tokenizer ?? ''
    this.tokenize = tokenize
    this.onNeedsRebuild = onNeedsRebuild
  }

  /** 现在能不能相信 FTS（查询路径读它） */
  get ready(): boolean {
    return this.state === 'ready' && !this.rebuilding
  }

  get status(): FtsState {
    return this.rebuilding ? 'building' : this.state
  }

  get tokenizerVersion(): string {
    return this.tokenizer
  }

  get mapSize(): number {
    return this.map.size
  }

  /** 重建期间有没有编辑被跳过（决定能不能标 ready） */
  get dirtyDuringBuild(): boolean {
    return this.dirtyDuringRebuild
  }
  /** 当前已分配的最后一个 rowid（重建时写进 meta） */
  get currentRowid(): number {
    return this.rowid
  }

  /** 重建开始：整表清空由调用方做；这里只把状态与分配器归零 */
  beginRebuild(): void {
    this.rebuilding = true
    this.dirtyDuringRebuild = false
    this.dirtyWhileUnindexed = false
    this.state = 'building'
    this.map = new Map()
    this.rowid = 0
    this.tokenizer = ''
  }

  /** 重建成功：`dirty` 表示期间有编辑被跳过 ⇒ 索引还差一批，不能标 ready */
  endRebuild(tokenizer: string, dirty: boolean): boolean {
    this.rebuilding = false
    const clean = !dirty && !this.dirtyDuringRebuild && !this.dirtyWhileUnindexed
    this.state = clean ? 'ready' : 'pending'
    if (clean) this.tokenizer = tokenizer
    return clean
  }

  /** 重建失败：保持 pending，查询继续扫描 */
  failRebuild(): void {
    this.rebuilding = false
    this.state = 'pending'
    this.tokenizer = ''
  }

  /**
   * 重建的一批：分配 rowid 并产写行。与增量共用 `buildFtsWrites`。
   *
   * 直接改内存映射（重建是独占过程，失败就整份作废，不存在「盘上有、内存没有」）。
   */
  async planRebuild(
    ws: StoredWorkspace,
    ids: ReadonlySet<string>,
  ): Promise<{ writes: ReturnType<typeof buildFtsWrites>['writes']; nextRowid: number }> {
    const items = indexTexts(ws, ids)
    const tokens = items.length > 0 ? await this.tokenize(items) : new Map<string, TokenizedText>()
    const built = buildFtsWrites(ws, { index: new Set(items.map((x) => x.id)), remove: new Set() }, tokens, this.map, this.rowid)
    this.map = built.map
    this.rowid = built.nextRowid
    return { writes: built.writes, nextRowid: built.nextRowid }
  }

  /* ------------------------------------------------------------ FtsCommitSource */

  async plan(ws: StoredWorkspace, ops: readonly Op[]): Promise<FtsCommitPlan | null> {
    if (this.rebuilding) {
      // 重建会重铺整表；这一批直接跳过，结束后由重建的 dirty 判据决定要不要再来一轮
      if (ops.length > 0) this.dirtyDuringRebuild = true
      return null
    }
    if (this.state !== 'ready') {
      /**
       * 索引没就绪时的编辑：这批不写索引，但必须记住「重建要覆盖它」。
       * 重建会按**当前**森林重铺，`beginRebuild` 会清掉这个标记。
       */
      if (ops.length > 0) {
        this.dirtyWhileUnindexed = true
        this.onNeedsRebuild()
      }
      return null
    }
    const targets = ftsTargets(ws, ops)
    if (targets.index.size === 0 && targets.remove.size === 0) return null

    const items = indexTexts(ws, targets.index)
    const tokens = items.length > 0 ? await this.tokenize(items) : new Map<string, TokenizedText>()
    const built = buildFtsWrites(ws, targets, tokens, this.map, this.rowid)
    if (built.writes.length === 0) return null
    return {
      writes: built.writes,
      apply: () => {
        this.map = built.map
        this.rowid = built.nextRowid
      },
    }
  }

  onError(): void {
    this.state = 'pending'
    this.tokenizer = ''
  }

  onReplace(): void {
    // 整份替换发生在重建途中：让当前重建走完（它写的是替换前的森林），
    // 标脏之后下一轮重来。这里若直接重置映射/状态，会把正在分配的身份抽掉。
    if (this.rebuilding) {
      this.dirtyDuringRebuild = true
      return
    }
    this.map = new Map()
    this.rowid = 0
    this.state = 'pending'
    this.tokenizer = ''
    this.dirtyWhileUnindexed = false
    this.onNeedsRebuild()
  }
}
