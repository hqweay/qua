/**
 * 渲染层的 `StoragePort` 实现 —— 把**行写入**交给主进程（Electron 的库）。
 *
 * ## 为什么这层是「薄得只剩一次转发」
 *
 * `StoragePort` 的契约是「这批改动落盘了没有」，而落盘归主进程（`node:sqlite` 必须在主进程）。
 * 所以这里只做三件事：把行写入转过去、把行读回来交给编码层、把错误如实报出去。
 * 上层（装配层/命令）一行都不用知道「库在哪」——这正是端口存在的原因。
 *
 * ## 为什么编码在这一侧（渲染层）而不是主进程
 *
 * 「一个块长成哪几行」是**块语义**，而主进程不许有块语义（它只认表名与列名，见
 * `electron/library/sqlite.ts` 的白名单）。⇒ 编码住 `core/storage/db-rows.ts`，
 * 主进程只做通用 SQL。两边共享的只有**表名**（`core/library.ts` 的 `DB_TABLES`）。
 *
 * ## 为什么装载要补回 `version`
 *
 * 库的 schema 版本只有一个判据：`PRAGMA user_version`（主进程读，装载前就能拿到）。
 * 而 `Workspace` 的形状里也带一份 `version`——两份版本并存时，真实故障形状是**中间态**：
 * `user_version` 认了、payload 里的还是旧值 ⇒ 装载成功、模型按旧口径解释、**不报错**。
 * ⇒ 库里不存 `version`，装载时由这里补上当前值。这样「能不能读」永远只有一个答案。
 */
import type { CommitBatch, LoadResult, SaveResult, StoragePort } from './port.ts'
import { WORKSPACE_VERSION, type Workspace } from './shape.ts'
import { rowsToWorkspace, type RawLibraryRows, type RowWrite } from './db-rows.ts'

/** 主进程那一侧的最小面（`electron/preload.ts` 暴露的同名方法） */
export interface LibraryBridge {
  onFlush?(cb: () => void | Promise<void>): void
  libraryInfo(): Promise<unknown>
  load(): Promise<unknown>
  save(writes: unknown[], opts?: { replace?: boolean }): Promise<unknown>
}

export const IPC_BACKEND = 'ipc-library'

/** 从库里读出来的库补回当前 `version`（装载用） */
export function withVersion(stored: Omit<Workspace, 'version'>): Workspace {
  return { ...stored, version: WORKSPACE_VERSION }
}

export function createIpcAdapter(bridge: LibraryBridge): StoragePort {
  /** 单写者：与 localStorage 适配器同一条口径（后一次提交永远排在前一次之后） */
  let tail: Promise<unknown> = Promise.resolve()

  return {
    kind: IPC_BACKEND,
    consumes: 'rows',

    async load(): Promise<LoadResult> {
      let r: unknown
      try {
        r = await bridge.load()
      } catch (error) {
        return { status: 'storage-error', error }
      }
      const res = r as { status?: string; rows?: RawLibraryRows } | null
      if (!res || typeof res !== 'object') return { status: 'storage-error', error: new Error('bad bridge reply') }
      if (res.status === 'empty') return { status: 'empty' }
      if (res.status === 'ok' && res.rows) {
        // 补回当前版本：库里不存版本（唯一真相是 user_version）
        return { status: 'ok', raw: JSON.stringify(withVersion(rowsToWorkspace(res.rows))) }
      }
      // `no-library` 等：这不是「库坏了」，是「这个窗口没有库」
      return { status: 'incompatible', reason: String(res.status ?? 'unknown') }
    },

    commit(batch: CommitBatch): Promise<SaveResult> {
      const run = async (): Promise<SaveResult> => {
        try {
          const writes: RowWrite[] = batch.writes ?? []
          const r = (await bridge.save(writes, { replace: batch.replace === true })) as
            | { ok?: boolean; error?: unknown }
            | null
          if (r && r.ok === true) return { ok: true, savedAt: batch.savedAt }
          // 失败必须如实返回：假装存上了会让用户以为写进去了
          return { ok: false, error: r?.error ?? 'save failed' }
        } catch (error) {
          return { ok: false, error }
        }
      }
      const next = tail.then(run, run)
      tail = next
      return next
    },

    /**
     * 清空。**故意什么都不做**：一条 `dev.workspace/reset` 在接上真库之后就是一次数据事故。
     * 要清库只能删目录（用户显式动作）。
     */
    async clear(): Promise<void> {
      console.warn('[storage] clear() is a no-op on a library-backed workspace')
    },

    async settle(): Promise<void> {
      await tail
    },
  }
}

/** 读库里的内容并判成 `Workspace`（行 → 模型，补当前版本） */
export function parseLibraryRows(rows: RawLibraryRows): Workspace {
  return withVersion(rowsToWorkspace(rows))
}
