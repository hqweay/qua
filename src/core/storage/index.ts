/**
 * 持久化门面 —— 上层（装配层／命令）面对的唯一对象。
 *
 * 分了三层，各管一件事：
 *
 * ```
 *   workspace.ts       ← 导出面：`import { ... } from './workspace.ts'` 的老路径不变
 *        │
 *   storage/port.ts     契约（纯类型）
 *   storage/shape.ts    落盘形状与校验（纯函数，无 I/O）
 *   storage/prefs.ts    偏好：设备状态、默认值与形状兜底
 *   storage/device.ts   设备偏好（主题／槽宽／钉住）的落盘，**不进库**
 *   storage/<实现>.ts   字节的进与出（目前只有 local-storage）
 * ```
 *
 * **唯一持有者**：装配层（`main.ts`）持一个 `StoragePort` 实例，交给 `createWorkspaceStore`。
 * 命令 handler 拿不到端口、也不该拿到 —— 要落盘就 `scheduleSave()`（承 arch-check [17]）。
 */
import type { Change, CommitBatch, LoadResult, StoragePort } from './port.ts'
import type { Op } from '../kb/types.ts'
import { changesOf } from '../kb/changes.ts'
import { META_KEYS } from '../identity/library.ts'
import { parseWorkspace, type ParseResult, type Workspace } from './shape.ts'
import { rowWritesFor, workspaceToRowWrites } from './db-rows.ts'
import type { FtsCommitPlan, FtsCommitSource, FtsLoadState } from './fts-port.ts'

/** 「整份库都动过」的那批改动：本地适配器的最细粒度（信封实现与门面共用同一份声明） */
export const WHOLE_LIBRARY_CHANGES: Change[] = [
  { kind: 'blocks', id: '*' },
  { kind: 'annos', id: '*' },
]

/**
 * 门面层的读盘结果：**在 `ParseResult` 上补一条适配器级的失败**。
 *
 * `storage-error` 与 `corrupt` 必须分开：前者「读不到」，后者「读到了但打不开」，
 * 给用户的建议完全不同（换个浏览器 / 备份抢救）。
 */
export type LoadedWorkspace =
  | (ParseResult & { search?: FtsLoadState })
  | { status: 'storage-error'; error: unknown; search?: FtsLoadState }

export interface WorkspaceStore {
  readonly kind: string
  load: () => Promise<LoadedWorkspace>
  /**
   * 提交一批 op（序列化／行编码与 changes 推导归这里）。
   *
   * `replace` 为真 ＝ 库里现在就是这份模型（种子／换库）：整份写行，**并重置变更流**
   * （清 `op_log`、序号归零，再把这一批作为新 genesis 写进去）。日志永远不混两段历史。
   * 常规编辑传假：只写这批 op 说到的那些格。
   */
  commit: (
    ws: Workspace,
    ops: readonly Op[],
    opts?: { replace?: boolean },
  ) => Promise<{ ok: true } | { ok: false; error: unknown }>
  clear: () => Promise<void>
  /**
   * 作废前抄一份原始字节（见 `StoragePort.backup`）。
   * 后端不支持 ⇒ `null`；备份失败 ⇒ 抛出（调用方中止覆盖）。
   */
  backup: () => Promise<string | null>
  /** 等已在途的提交落盘 */
  settle: () => Promise<void>
}

/** 把适配器的读盘结果判定成上层能直接分支的形状的要害就在这） */
export function judge(r: LoadResult): LoadedWorkspace {
  if (r.status === 'storage-error') return { status: 'storage-error', error: r.error }
  if (r.status === 'incompatible') return { status: 'storage-error', error: new Error(r.reason) }
  if (r.status === 'empty') return { status: 'empty' }
  const parsed = parseWorkspace(r.raw)
  return r.search === undefined ? parsed : { ...parsed, search: r.search }
}

/**
 * 一批 op ⇒ 这批 op 让**哪几类对象**失效。
 *
 * 唯一实现在 `core/kb/changes.ts`：`apply` 与落盘层读同一份推导，
 * 不再有「tx 里手写一个 ChangeSink、落盘层再从 op 推一个」的两份答案。
 */
export { changesOf }

export function createWorkspaceStore(port: StoragePort, fts?: FtsCommitSource): WorkspaceStore {
  /**
   * **提交从「生成行」到「映射推进」全程串行**。
   *
   * 端口本来就把落盘排成一条队，但 FTS 计划在这条队**之前**算：两个提交同时规划
   * 会从同一张映射里各分配一个 rowid，先落盘的那个赢、后一个写进一个不存在的身份。
   * 把规划也放进队列，映射的推进顺序就与事务顺序一致。
   */
  let tail: Promise<unknown> = Promise.resolve()
  const pendingMeta = (): { table: 'meta'; op: 'upsert'; key: { key: string }; values: { value: string } } => ({
    table: 'meta',
    op: 'upsert',
    key: { key: META_KEYS.ftsState },
    values: { value: 'pending' },
  })

  return {
    kind: port.kind,
    load: async () => judge(await port.load()),

    commit(ws, ops, opts = {}) {
      const run = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
        const replace = opts.replace === true
        const batch: CommitBatch = {
          // 一批 op ＝ 一个事务（写适配器的契约）。零 op 且非整份替换 ⇒ 这批不是事务产的
          // （例如只换了落点），按整类提交是**保守**的如实表达
          ops: [...ops],
          changes: ops.length === 0 ? WHOLE_LIBRARY_CHANGES : changesOf(ops),
          savedAt: ws.savedAt,
        }
        /**
         * **按适配器的 `consumes` 准备载荷**：接库只要「这批 op 说到的那些格的行」，
         * 浏览器只要整份字节。两条都备着就等于每次都把整库序列化一遍 ——
         * 那是把「整库覆盖写」的成本从存储层搬到 CPU 上，验收口径一样过不去。
         */
        if (port.consumes === 'rows') {
          batch.replace = replace
          batch.writes = replace ? workspaceToRowWrites(ws) : rowWritesFor(ws, ops)

          /**
           * **增量索引与内容行同一批**。规划可能失败（分词器没起来／worker 崩了）：
           * 内容照常落盘，索引降级 pending —— 派生数据坏了不该连累用户输入的正文。
           * 规划成功也不在这里 apply：事务失败时映射必须保持上一次落盘的值。
           */
          let plan: FtsCommitPlan | null = null
          if (!replace && fts) {
            try {
              plan = await fts.plan(ws, ops)
              if (plan) batch.writes.push(...plan.writes)
            } catch (e) {
              console.warn(`[search] index plan failed; saving content without fts: ${e instanceof Error ? e.message : String(e)}`)
              fts.onError()
              batch.writes.push(pendingMeta())
            }
          }

          /**
           * **变更流与行写入同一批**（落库侧同一事务追加进 `op_log`）。
           *
           * 整份替换（种子／换库）也带 op：它是**新 genesis** —— 清旧日志、序号归零、
           * 再把这一批写进去。日志不混两段历史，重放永远从「空森林 ＋ 这一批」开始。
           */
          if (ops.length > 0) batch.oplog = ops

          const r = await port.commit(batch)
          if (r.ok) {
            plan?.apply()
            if (replace) fts?.onReplace()
            return { ok: true as const }
          }
          return { ok: false as const, error: r.error }
        }

        batch.payload = JSON.stringify(ws)
        const r = await port.commit(batch)
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error }
      }
      const next = tail.then(run, run)
      tail = next
      return next
    },

    clear: () => port.clear(),

    /**
     * 备份是**可选能力**：没有就是 `null`（「没有备份」与「备份失败」必须分开——
     * 前者可以继续，后者必须中止）。
     */
    backup: async () => (port.backup ? port.backup() : null),
    settle: async () => {
      await tail
      await port.settle()
    },
  }
}
