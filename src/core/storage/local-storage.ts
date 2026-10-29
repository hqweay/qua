/**
 * `localStorage` 适配器 —— **唯一允许碰 `localStorage` 的文件**。
 *
 * 它只做三件事：字节的进、字节的出、信封的自描述。
 *   · 「这坨字节是不是一份能打开的库」归 `shape.ts`（纯函数，可单测）；
 *   · 「什么时候提交、提交什么」归装配层。
 *
 * **信封**：落盘值不是裸的库 JSON，而是
 *
 * ```json
 * { "qua.workspace": 1, "data": { …整份库… } }
 * ```
 *
 * 为什么值得多一层：将来接内核 SQLite 时，这个键位上可能残留别的后端写的东西；
 * 有 `backend` 字段就能说清「这是另一个后端的库」（`incompatible`），
 * 而不是误判成 `corrupt`、让用户以为数据坏了。
 *
 * ⚠️ 写信封会让**升级前的旧库读不出来**（旧值是裸 JSON）。原型不做旧数据迁移：
 *    `WORKSPACE_VERSION` 升一，旧库走 `expired` 显式作废重 seed。
 */
import type { CommitBatch, LoadResult, SaveResult, StoragePort } from './port.ts'

const BACKEND = 'local-storage'
const ENVELOPE = 1

interface Envelope {
  backend: typeof BACKEND
  envelope: typeof ENVELOPE
  data: unknown
}

function isEnvelope(x: unknown): x is Envelope {
  if (!x || typeof x !== 'object') return false
  const e = x as Partial<Envelope>
  return e.backend === BACKEND && e.envelope === ENVELOPE && 'data' in e
}

export function createLocalStorageAdapter(key: string): StoragePort {
  /**
   * 串行队列（单写者）：后一次提交永远排在前一次之后。
   * `tail` 只用来「排队」，吞掉失败 —— 失败由各次 `commit` 自己的分支如实返回。
   */
  let tail: Promise<unknown> = Promise.resolve()

  return {
    kind: BACKEND,
    /**
     * 浏览器没有库，只能存一份字节 ⇒ 要整份序列化。
     * 这条 `consumes` 就是「门面要不要序列化整库」的唯一判据（见 `port.ts`）。
     */
    consumes: 'bytes',

    async load(): Promise<LoadResult> {
      let raw: string | null
      try {
        raw = localStorage.getItem(key)
      } catch (error) {
        return { status: 'storage-error', error }
      }
      if (raw === null) return { status: 'empty' }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        // 连 JSON 都不是：交给上层判 `corrupt(parse)`，这里不替它下结论
        return { status: 'ok', raw }
      }
      // 裸库（升级前写的 / 别的适配器留的）：原样交出去，让 `shape.ts` 用 version 判 expired
      if (!isEnvelope(parsed) && parsed && typeof parsed === 'object' && 'version' in parsed) {
        return { status: 'ok', raw }
      }
      if (!isEnvelope(parsed)) return { status: 'incompatible', reason: 'not a library envelope' }
      return { status: 'ok', raw: JSON.stringify(parsed.data) }
    },

    commit(batch: CommitBatch): Promise<SaveResult> {
      const run = async (): Promise<SaveResult> => {
        // `payload` 一定在：门面按 `consumes: 'bytes'` 序列化过（见 `storage/index.ts`）
        const envelope: Envelope = { backend: BACKEND, envelope: ENVELOPE, data: JSON.parse(batch.payload ?? 'null') }
        try {
          localStorage.setItem(key, JSON.stringify(envelope))
          return { ok: true, savedAt: batch.savedAt }
        } catch (error) {
          // 配额满 / 隐私模式：**返回失败**，由装配层给用户可见提示；不假装存上了
          console.warn('[storage] localStorage commit failed', error)
          return { ok: false, error }
        }
      }
      const next = tail.then(run, run)
      tail = next
      return next
    },

    async clear(): Promise<void> {
      await tail
      try {
        localStorage.removeItem(key)
      } catch {
        /* ignore：清不掉不是致命错误，下一次 commit 会覆盖 */
      }
    },

    /**
     * 把当前字节抄到一个**独立键**，返回那个键名。
     *
     * 为什么抄原始字符串而不是解析后再序列化：损坏的库正是「解析不了」的那份，
     * 能抄的只有字节本身；备份的意义就是让用户事后还能用开发者工具把它导出。
     * 没有可抄的字节（从没保存过）⇒ `null`。
     * 写不进去（配额满 / 隐私模式）必须抛出：调用方会因此中止覆盖。
     */
    async backup(): Promise<string | null> {
      await tail
      const raw = localStorage.getItem(key)
      if (raw === null) return null
      const at = new Date().toISOString().replace(/[:.]/g, '-')
      const backupKey = `${key}.bak.${at}`
      localStorage.setItem(backupKey, raw)
      return backupKey
    },

    async settle(): Promise<void> {
      await tail
    },
  }
}
