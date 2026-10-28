/**
 * 渲染层的 `StoragePort` 实现 —— 把字节交给主进程（Electron 的库）。
 *
 * ## 为什么这层是「薄得只剩一次转发」
 *
 * `StoragePort` 的契约是「这批改动落盘了没有」，而落盘归主进程（`node:sqlite` 必须在主进程）。
 * 所以这里只做三件事：把字节转过去、把结果转回来、把错误如实报出去。
 * 上层（装配层/命令）一行都不用知道「库在哪」——这正是端口存在的原因。
 *
 * ## 为什么 `version` 在落盘前被剥掉
 *
 * 库的 schema 版本只有一个判据：`PRAGMA user_version`（主进程读，装载前就能拿到）。
 * 而 `Workspace` 的 JSON 里也带一份 `version`——两份版本并存时，真实故障形状是**中间态**：
 * `user_version` 认了、payload 里的还是旧值 ⇒ 装载成功、模型按旧口径解释、**不报错**。
 * ⇒ 写之前剥掉，读之后补回当前值。这样「能不能读」永远只有一个答案。
 *
 * ⚠️ 这是过渡期的做法。换成规范化表之后 `Workspace` 这个整份 blob 本身会退场。
 */
import type { CommitBatch, LoadResult, SaveResult, StoragePort } from './port.ts'
import { WORKSPACE_VERSION, type Workspace } from './shape.ts'

/** 主进程那一侧的最小面（`electron/preload.ts` 暴露的同名方法） */
export interface LibraryBridge {
  onFlush?(cb: () => void | Promise<void>): void
  libraryInfo(): Promise<unknown>
  load(): Promise<unknown>
  save(json: string, savedAt: number): Promise<unknown>
}

export const IPC_BACKEND = 'ipc-library'

/** 从 `Workspace` 的 JSON 里剥掉 `version`（写库用） */
export function stripVersion(json: string): string {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return json
  }
  if (!value || typeof value !== 'object') return json
  const { version: _drop, ...rest } = value as Record<string, unknown>
  return JSON.stringify(rest)
}

/** 给从库里读出来的 JSON 补回当前 `version`（装载用） */
export function withVersion(json: string): string {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return json
  }
  if (!value || typeof value !== 'object') return json
  return JSON.stringify({ ...(value as Record<string, unknown>), version: WORKSPACE_VERSION })
}

export function createIpcAdapter(bridge: LibraryBridge): StoragePort {
  /** 单写者：与 localStorage 适配器同一条口径（后一次提交永远排在前一次之后） */
  let tail: Promise<unknown> = Promise.resolve()

  return {
    kind: IPC_BACKEND,

    async load(): Promise<LoadResult> {
      let r: unknown
      try {
        r = await bridge.load()
      } catch (error) {
        return { status: 'storage-error', error }
      }
      const res = r as { status?: string; json?: string } | null
      if (!res || typeof res !== 'object') return { status: 'storage-error', error: new Error('bad bridge reply') }
      if (res.status === 'empty') return { status: 'empty' }
      if (res.status === 'ok' && typeof res.json === 'string') {
        // 补回当前版本：库里的字节**不带**版本（唯一真相是 user_version）
        return { status: 'ok', raw: withVersion(res.json) }
      }
      // `no-library` 等：这不是「库坏了」，是「这个窗口没有库」
      return { status: 'incompatible', reason: String(res.status ?? 'unknown') }
    },

    commit(batch: CommitBatch): Promise<SaveResult> {
      const run = async (): Promise<SaveResult> => {
        try {
          const r = (await bridge.save(stripVersion(batch.payload), batch.savedAt)) as
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

/** 读库里的内容并判成 `Workspace`（当前的 blob 形状） */
export function parseLibraryJson(raw: string): Workspace {
  return JSON.parse(withVersion(raw)) as Workspace
}
