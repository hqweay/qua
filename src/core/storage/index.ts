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
 *   storage/<实现>.ts   字节的进与出（目前只有 local-storage）
 * ```
 *
 * **唯一持有者**：装配层（`main.ts`）持一个 `StoragePort` 实例，交给 `createWorkspaceStore`。
 * 命令 handler 拿不到端口、也不该拿到 —— 要落盘就 `scheduleSave()`（承 arch-check [17]）。
 */
import type { Change, CommitBatch, LoadResult, StoragePort } from './port.ts'
import { parseWorkspace, type ParseResult, type Workspace } from './shape.ts'

/** 「整份库都动过」的那批改动：demo 适配器的最细粒度（信封实现与门面共用同一份声明） */
export const WHOLE_LIBRARY_CHANGES: Change[] = [
  { kind: 'blocks', id: '*' },
  { kind: 'marks', id: '*' },
  { kind: 'atoms', id: '*' },
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
  /** 提交一批改动（序列化归这里，适配器只收字节）；不带 changes ＝ 整类对象都动过 */
  commit: (ws: Workspace, changes?: Change[]) => Promise<{ ok: true } | { ok: false; error: unknown }>
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

export function createWorkspaceStore(port: StoragePort): WorkspaceStore {
  return {
    kind: port.kind,
    load: async () => judge(await port.load()),

    async commit(ws, changes) {
      const batch: CommitBatch = {
        // demo 的适配器只能报「整类对象都动过」；接 Tx/Changes 后这里换成真改动
        changes: changes ?? WHOLE_LIBRARY_CHANGES,
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
