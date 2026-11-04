/**
 * 存储层眼里的**全文索引计划**（只有类型）。
 *
 * 为什么索引写入要经过存储门面而不是自己开一条 IPC：
 *   · 内容行与 FTS 行必须**同一个事务**（半批会让「模型里有、索引里没有」成为常态）；
 *   · 事务失败时映射必须回滚（否则下一次编辑会按一个没落盘的 rowid 去删索引）。
 *
 * 实现（分词、rowid 分配、重建）住在 `app/search/`：`core` 不该知道 WASM，
 * `electron/` 不该知道块语义；存储层只负责把计划塞进这一批行写入。
 */
import type { Op } from '../kb/types.ts'
import type { RowWrite, StoredWorkspace } from './db-rows.ts'

export interface FtsCommitPlan {
  writes: RowWrite[]
  /** **事务成功之后**才调用：内存里的映射到这一刻才与盘上一致 */
  apply(): void
}

export interface FtsCommitSource {
  /**
   * 规划这一批的索引写入；`null` ＝ 这批不碰索引（状态未就绪／没有正文变化）。
   *
   * 可能异步（分词在 worker 里）；**必须在落盘前完成**，因为行写入要一起进事务。
   */
  plan(ws: StoredWorkspace, ops: readonly Op[]): Promise<FtsCommitPlan | null>
  /** 分词／规划失败：内容照常落盘，索引降级为 pending（下一次重建修） */
  onError(): void
  /** 整份替换（种子／换库）已成功：索引作废，等重建 */
  onReplace(): void
}
