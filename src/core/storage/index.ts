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
import { rowWritesFor, workspaceToRowWrites, type RowWrite } from './db-rows.ts'
import type { IndexWriteBatch } from './index-rows.ts'
import type { FtsCommitPlan, FtsCommitSource } from './fts-port.ts'

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
 * 只有字节后端（web 单库）走这条装载路；桌面库的读面在 `LibraryClient`。
 */
export type LoadedWorkspace = ParseResult | { status: 'storage-error'; error: unknown }

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
  /**
   * **派生行的批量落盘**（流式重建用）：与常规提交共用一条串行队列，但不产 op、
   * 不进日志（派生表可从内容重建，不是历史）。字节后端无行可写 ⇒ 恒 ok。
   */
  commitRaw: (writes: readonly RowWrite[]) => Promise<{ ok: true } | { ok: false; error: unknown }>
  clear: () => Promise<void>
  /**
   * 作废前抄一份原始字节（见 `StoragePort.backup`）。
   * 后端不支持 ⇒ `null`；备份失败 ⇒ 抛出（调用方中止覆盖）。
   */
  backup: () => Promise<string | null>
  /** 等已在途的提交落盘 */
  settle: () => Promise<void>
}

/** 把字节后端的读盘结果判定成上层能直接分支的形状 */
export function judge(r: LoadResult): LoadedWorkspace {
  if (r.status === 'storage-error') return { status: 'storage-error', error: r.error }
  if (r.status === 'incompatible') return { status: 'storage-error', error: new Error(r.reason) }
  if (r.status === 'empty') return { status: 'empty' }
  return parseWorkspace(r.raw)
}

/**
 * 一批 op ⇒ 这批 op 让**哪几类对象**失效。
 *
 * 唯一实现在 `core/kb/changes.ts`：`apply` 与落盘层读同一份推导，
 * 不再有「tx 里手写一个 ChangeSink、落盘层再从 op 推一个」的两份答案。
 */
export { changesOf }

export interface WorkspaceStoreHooks {
  /**
   * **派生关系行写**（层 2）：工作集侧按 op 批算出 `BlockRelation` 的 prune＋upsert，
   * 与行写入同一批（主进程同一个事务）。省略 ＝ 不维护（派生表保持装载侧现状）。
   */
  relationWrites?: (ops: readonly Op[]) => RowWrite[]
  /**
   * **派生位置行的增量维护**：按 op 批算出 `BlockIndex` 的新行与前缀改写计划，
   * 与内容行同一个事务。**异步**是因为中点要夹在库里的存量段之间（读一次库）。
   *
   * 省略 ＝ 不维护（web 单库没有派生表）。读失败时内容照常落盘、派生行这一笔跳过
   * （与 FTS 计划同一条纪律：派生数据坏了不该连累用户输入的正文），失败会被记下来。
   */
  indexWrites?: (ops: readonly Op[]) => Promise<IndexWriteBatch>
}

export function createWorkspaceStore(port: StoragePort, fts?: FtsCommitSource, hooks?: WorkspaceStoreHooks): WorkspaceStore {
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
    load: port.load
      ? async () => judge(await port.load!())
      : async () => ({
          status: 'storage-error',
          error: new Error('this backend has no byte load; reads go through the workset'),
        }),

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
           * **派生关系行与内容行同一批**（层 2）： prune 在前、upsert 在后，
           * 主进程同一个事务里执行。整份替换不追加——replace 自带清表重建语义。
           */
          if (!replace) {
            const derived = hooks?.relationWrites?.(ops)
            if (derived && derived.length > 0) batch.writes.push(...derived)
          }

          /**
           * **派生位置行与内容行同一批**（root/path/hidden）：新行进 `writes`，前缀改写／清除／
           * hidden 重算进 `plans`（未装载的子孙只能按前缀交给 SQL）。
           *
           * 这里要读库（中点夹在存量段之间），所以是异步的；读在 store 的串行队列里，
           * 看到的一定是上一批已落盘的状态。读失败 → 内容照常落盘、这一笔位置行跳过
           * （与 FTS 计划同一条纪律），失败会留在日志里。
           */
          if (!replace && hooks?.indexWrites) {
            try {
              const indexWrites = await hooks.indexWrites(ops)
              if (indexWrites.writes.length > 0) batch.writes.push(...indexWrites.writes)
              if (indexWrites.plans.length > 0) batch.plans = indexWrites.plans
            } catch (e) {
              console.warn(`[derived] index writes skipped; saving content without index rows: ${e instanceof Error ? e.message : String(e)}`)
            }
          }

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

    /**
   * **派生行的批量落盘**（流式重建用）：与常规提交共用同一条串行队列，
   * 但不产 op、不进日志——派生表可从内容重建，不是历史的一部分。
   * 整个批就是一个事务；逐根调用时每根一个小事务，与用户输入的写入交错不抢锁。
   */
  commitRaw: async (writes: readonly RowWrite[]) => {
    const run = async (): Promise<{ ok: true } | { ok: false; error: unknown }> => {
      try {
        const batch: CommitBatch = { ops: [], changes: [], writes: [...writes], savedAt: Date.now() }
        if (port.consumes !== 'rows') return { ok: true as const }
        const r = await port.commit(batch)
        return r.ok ? { ok: true as const } : { ok: false as const, error: r.error }
      } catch (error) {
        return { ok: false as const, error }
      }
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
