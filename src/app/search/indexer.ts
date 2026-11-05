/**
 * 渲染层的**索引状态**：块 id ↔ FTS rowid、状态、下一次分配。
 *
 * 它只做「按计划改内存」这一件事；真正的分词由注入的 `tokenize` 完成
 * （worker 或测试里的假实现）。这样索引逻辑能在 Node 单测里跑，不需要 WASM。
 */
import type { Op } from '../../core/kb/types.ts'
import type { RowWrite, StoredWorkspace } from '../../core/storage/db-rows.ts'
import type { FtsCommitPlan, FtsCommitSource } from '../../core/storage/fts-port.ts'
import type { FtsSource } from '../../core/search/sources.ts'
import { META_KEYS } from '../../core/identity/library.ts'
import type { TokenizedText } from '../../core/search/tokenizer.ts'
import { buildFtsWrites, ftsSourceTexts, ftsTargets } from '../../core/search/rows.ts'
import { ftsRowKey, parseFtsRowKey } from '../../core/search/sources.ts'

/** `pending`／`building` 时查询降级扫描；只有 `ready` 才相信索引 */
export type FtsState = 'pending' | 'building' | 'ready'

export interface SearchSnapshot {
  /**
   * 索引行 → FTS rowid。键是 `ftsRowKey(块 id, 来源)`（一行一个来源），
   * 不是块 id——一块最多五行（正文／地址／标签／属性／链接各一行）。
   */
  map: Map<string, number>
  state: FtsState
  rowidSeq: number
  /** 建索引时用的分词器版本；与当前版本不一致 ⇒ 作废重建 */
  tokenizer: string
}

export type TokenizeMany = (items: readonly { id: string; text: string }[]) => Promise<Map<string, TokenizedText>>

/** `fts_rowid_seq` 的一行写入：分配器的水位与索引行一起提交，重开从这里接着发号 */
function rowidSeqWrite(seq: number): RowWrite {
  return {
    table: 'meta',
    op: 'upsert',
    key: { key: META_KEYS.ftsRowidSeq },
    values: { value: String(seq) },
  }
}

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

  constructor(snapshot: SearchSnapshot | undefined, tokenize: TokenizeMany) {
    this.map = new Map(snapshot?.map ?? [])
    /**
     * **水位不能低于映射里的最大值**。
     *
     * `fts_rowid` 在 `BlockFTSMap` 上是全局 UNIQUE：水位若从旧 meta 起算，新分配的
     * rowid 会撞上仍然存在的映射行（重开之后第一次编辑必撞）。增量写从这一版起
     * 会把水位一起落盘；但存量库里的水位可能已经是旧的，所以加载时按映射兜底。
     */
    let rowid = snapshot?.rowidSeq ?? 0
    for (const used of this.map.values()) if (used > rowid) rowid = used
    this.rowid = rowid
    this.state = snapshot?.state ?? 'pending'
    this.tokenizer = snapshot?.tokenizer ?? ''
    this.tokenize = tokenize
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

  /** 诊断用：某个块的某个来源行现在有没有索引（键见 `ftsRowKey`） */
  rowidOf(blockId: string, source: FtsSource): number | undefined {
    return this.map.get(ftsRowKey(blockId, source))
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
   * 重建的一批：算全来源文本、分配 rowid 并产写行。与增量共用 `buildFtsWrites`。
   *
   * 直接改内存映射（重建是独占过程，失败就整份作废，不存在「盘上有、内存没有」）。
   */
  async planRebuild(
    ws: StoredWorkspace,
    ids: ReadonlySet<string>,
  ): Promise<{ writes: ReturnType<typeof buildFtsWrites>['writes']; nextRowid: number }> {
    const texts = ftsSourceTexts(ws, ids)
    const items = texts.map((x) => ({ id: x.key, text: x.text }))
    const tokens = items.length > 0 ? await this.tokenize(items) : new Map<string, TokenizedText>()
    const index = new Map<FtsSource, Set<string>>()
    for (const { key } of texts) {
      const parsed = parseFtsRowKey(key)
      if (!parsed) continue
      let set = index.get(parsed.source)
      if (!set) {
        set = new Set()
        index.set(parsed.source, set)
      }
      set.add(parsed.blockId)
    }
    const built = buildFtsWrites({ index, remove: new Map() }, tokens, this.map, this.rowid)
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
      if (ops.length > 0) this.dirtyWhileUnindexed = true
      return null
    }
    const targets = ftsTargets(ws, ops)
    if (targets.index.size === 0 && targets.remove.size === 0) return null

    const want = new Set<string>()
    for (const ids of targets.index.values()) for (const id of ids) want.add(id)
    const texts = ftsSourceTexts(ws, want)
    const items = texts.map((x) => ({ id: x.key, text: x.text }))
    const tokens = items.length > 0 ? await this.tokenize(items) : new Map<string, TokenizedText>()
    const built = buildFtsWrites(targets, tokens, this.map, this.rowid)
    if (built.writes.length === 0) return null
    return {
      /**
       * **水位与映射同一批**。
       *
       * 只在重建时写 meta、增量不写，会让「重开之后接着发号」从一个旧数字开始：
       * 盘上映射里的 rowid 还在，新分配的会撞 `fts_rowid` 的 UNIQUE（实测）。
       * 放进同一批还有一个好处：事务失败时两者一起回滚，不会出现「水位涨了、
       * 映射没落盘」的第二个坏状态。
       */
      writes: [...built.writes, rowidSeqWrite(built.nextRowid)],
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
    /**
     * **不在这里自动重建**：整份替换通常是「种下一份新库」，此刻用户还没开始搜索；
     * 后台建 100k 索引会和第一次打字抢同一批写库行数（诊断面的「一个字写几行」
     * 会读到一个不属于这次输入的峰值）。索引在第一次搜索（`start()`）时再建，
     * 期间查询走扫描，功能不缺。
     */
  }
}
