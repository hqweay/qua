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
import { parseWorkspace, type ParseResult, type Workspace } from './shape.ts'

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
export type LoadedWorkspace = ParseResult | { status: 'storage-error'; error: unknown }

export interface WorkspaceStore {
  readonly kind: string
  load: () => Promise<LoadedWorkspace>
  /** 提交一批 op（序列化与 changes 推导归这里）；op 为空 ＝ 整类对象都动过 */
  commit: (ws: Workspace, ops: readonly Op[]) => Promise<{ ok: true } | { ok: false; error: unknown }>
  clear: () => Promise<void>
  /** 等已在途的提交落盘 */
  settle: () => Promise<void>
}

/** 把适配器的读盘结果判定成上层能直接分支的形状的要害就在这） */
export function judge(r: LoadResult): LoadedWorkspace {
  if (r.status === 'storage-error') return { status: 'storage-error', error: r.error }
  if (r.status === 'incompatible') return { status: 'storage-error', error: new Error(r.reason) }
  if (r.status === 'empty') return { status: 'empty' }
  return parseWorkspace(r.raw)
}

/**
 * 一批 op ⇒ 这批 op 让**哪几类对象**失效。
 *
 * `StoragePort` 的契约只收 `Change[]`（「这类对象里这一条动过」），所以这里是 op 到
 * `Change` 的**最小投影**：内容/属性/别名/露面/标签都落在块的骨架上 ⇒ `blocks`；
 * 可引用区间是住块上的第二种对象 ⇒ `annos`。
 *
 * ⚠️ 同 kind ＋ 同 id 去重：一次打字可能对一块报好几条 op，订阅者只需要重渲染一次。
 */
export function changesOf(ops: readonly Op[]): Change[] {
  const out: Change[] = []
  const seen = new Set<string>()
  const add = (kind: Change['kind'], id: string): void => {
    const key = `${kind}\u0000${id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, id })
  }
  for (const o of ops) {
    if (o.e === 'anno') {
      add('annos', o.block)
      continue
    }
    add('blocks', o.e === 'block' ? o.id : o.block)
  }
  return out
}

export function createWorkspaceStore(port: StoragePort): WorkspaceStore {
  return {
    kind: port.kind,
    load: async () => judge(await port.load()),

    async commit(ws, ops) {
      const batch: CommitBatch = {
        // 一批 op ＝ 一个事务（写适配器的契约）；op 为空 ⇒ 这批不是事务产的（迁移期直写），
        // 只能按整类提交——这是迁移期的真相，不是兜底
        ops: [...ops],
        changes: ops.length === 0 ? WHOLE_LIBRARY_CHANGES : changesOf(ops),
        // 本地适配器只能收整份字节；接 SQLite 后由写适配器把 op 落成行
        payload: JSON.stringify(ws),
        savedAt: ws.savedAt,
      }
      const r = await port.commit(batch)
      return r.ok ? { ok: true } : { ok: false, error: r.error }
    },

    clear: () => port.clear(),
    settle: () => port.settle(),
  }
}
