/**
 * `StoragePort` ——持久化的**唯一契约**。
 *
 * 为什么要它：上层（装配层／命令）曾经直接 `localStorage.setItem` 整库，于是
 *   ① 上层依赖了**同步**语义；② 换实现（内核 SQLite／主进程单写者）等于重写调用方；
 *   ③ 「把整份库一次性丢掉」变成了事实上的对外契约。
 *
 * 本文件**只有类型，零运行时**——和 `core/ports.ts` 同一个规矩：
 *   · 实现（`local-storage.ts`／未来 `kernel.ts`）藏在 `storage/` 里；
 *   · 上层只 `import type { StoragePort } from './storage/port.ts'`，不 import 任何实现。
 *
 * 三条硬口径：
 *   1. **异步**：`load`／`commit` 都返回 Promise，上层不得依赖同步返回。
 *   2. **批次**：写入的单位是 `Change[]`（一块或几块），不是「整个库」。
 *      ⚠️ `LocalStorageAdapter` 内部仍然整份序列化 —— 那是**实现细节**
 *      （浏览器没有库，只能存一份字节），不是契约：`commit` 只承诺「这批改动落盘了」。
 *      接库的适配器（`consumes: 'rows'`）只写这批 op 动过的块的行。
 *   3. **单写者**：目标形态是主进程 SQLite ＋ WAL，renderer 经端口调用、不直接碰存储
 * 适配器必须自己保证「同一时刻只有一次提交在飞」。
 */

import type { Op } from '../kb/types.ts'
import type { RowWrite } from './db-rows.ts'

/** 被写的两类对象：块森林 ＋ 块上的可引用区间 */
export type ChangeKind = 'blocks' | 'annos'

/**
 * 一条改动。
 *
 * ⚠️ **不带 payload**：契约只说「这类对象里的这一条动过」，不说动成了什么
 *    （落盘字节由 `CommitBatch.payload` 承载，落库行由 `CommitBatch.writes` 承载）。
 *    将来接同步层时这里会扩成 `{ kind, id, op: 'upsert' | 'delete', value }`，
 *    但**对外形状不变**——适配器照样只承诺「这批改动落盘了」。
 *
 * `id` 两种取值，消费者必须都处理：
 *   · 具体 id —— 精确到块／区间，索引可只重算它；
 *   · `'*'`  —— 「这一类都可能动过」，拿不到精确 id 时的**保守**声明。
 *
 * ⚠️ `'*'` 不是「没实现」的兜底，而是「确实不知道」的如实表达
 *    （例如换库、批量导入、结构性重排）。宁可多重建一次，也不要自相矛盾的索引。
 */
export interface Change {
  kind: ChangeKind
  /** 对象 id（块／区间），或 `'*'` ＝ 整类对象都动过 */
  id: string
}

export const WHOLE_CLASS = '*'

/** 这批改动里，`kind` 这一类是不是「整类都动过」 */
export function isWholeClass(changes: readonly Change[], kind: ChangeKind): boolean {
  return changes.some((c) => c.kind === kind && c.id === WHOLE_CLASS)
}

/** 这批改动里 `kind` 这一类点到的具体 id（**不含** `'*'`） */
export function idsOfKind(changes: readonly Change[], kind: ChangeKind): string[] {
  const out = new Set<string>()
  for (const c of changes) if (c.kind === kind && c.id !== WHOLE_CLASS) out.add(c.id)
  return [...out]
}

/**
 * 一次提交的内容。
 *
 * **适配器按自己的 `consumes` 取其中一份**：
 *   · `bytes`（`localStorage`）要 `payload`（整份序列化）——浏览器没有库，只能存一份字节；
 *   · `rows`（Electron 的 `qua.db`）要 `writes`（这批 op 动过的块的行）——**只写动过的那几块**。
 *
 * 为什么不是「两个都给」：`payload` 是整库序列化，成本随库体量线性增长。
 * 在接库之后仍然每次提交都算一遍它，等于把「整库覆盖写」的成本从存储层搬到了 CPU 上，
 * 而验收口径是「打一个字的落盘成本不随库体量增长」——那条也包含这一份。
 */
export interface CommitBatch {
  /**
   * 这批**持久化 op** —— 「一批 op ＝ 一个事务」是写适配器的契约：
   * SQLite 落行时一批开一个事务、`block.delete` 级联、失败整批回滚。
   */
  ops: Op[]
  /** 索引/订阅侧的最小失效投影（与 op 同源；适配器不消费） */
  changes: Change[]
  /** 整份库的字节（只有 `consumes: 'bytes'` 的适配器要） */
  payload?: string
  /** 这批 op 动过的块的行（只有 `consumes: 'rows'` 的适配器要；编码见 `db-rows.ts`） */
  writes?: RowWrite[]
  /**
   * **这一批 op 本身**（变更流）。落库适配器把它追加进 `op_log`，**与行写入同一个事务**。
   *
   * 为什么它与 `writes` 分开而不是让适配器从行反推：行说的是「现在是什么」，
   * op 说的是「怎么变的」—— 前者可重建，后者不可逆（`op_log` 是 append-only 历史）。
   * 反推出来的「怎么变」是猜的，而猜错的历史补不回来。
   *
   * ⚠️ 与 `writes` 不同，这一份**不是** `consumes` 的替代品：`bytes` 适配器（浏览器）
   *    没有 `op_log`，也就不消费它（浏览器端没有跨设备同步的前提）。
   */
  oplog?: readonly Op[]
  /**
   * **整份替换**：这批不是增量，而是「库里现在就是这份模型」。
   *
   * 只有三种情况会置它：首次落种子、换库、撤销/重做（整片森林被换掉）。
   * 常规编辑一律走增量 —— 顺手整份替换是一次数据事故，而它看起来只是「慢了一点」。
   */
  replace?: boolean
  /** 跟这批一起记的自描述时间（落盘形状的一部分，见 `parseWorkspace`） */
  savedAt: number
}

/* ------------------------------------------------------------ 读的结果 */

/**
 * 读盘结果：**必须区分「没有库」与「库有问题」**。
 *
 * 旧实现把所有失败都压成 `null`，调用方只能 `?? seedWorkspace()`，随后立刻覆盖写 ——
 * 过新/损坏的库会被**静默覆盖**（真数据丢失）。
 */
export type LoadResult =
  | { status: 'ok'; raw: string }
  /** 从没保存过 */
  | { status: 'empty' }
  /**
   * 读到了字节，但适配器**看不懂自己的信封**（例如未来内核库被旧版 localStorage 适配器读到）。
   * 与 `corrupt` 分开：这不是库坏了，是**换了后端**。
   */
  | { status: 'incompatible'; reason: string }
  /** 存储本身不可用（隐私模式 / 权限 / 磁盘） */
  | { status: 'storage-error'; error: unknown }

/* ------------------------------------------------------------ 写的结果 */

export type SaveResult = { ok: true; savedAt: number } | { ok: false; error: unknown }

/* ------------------------------------------------------------ 端口 */

export interface StoragePort {
  /** 适配器名（诊断面板显示「数据存在哪」） */
  readonly kind: string
  /**
   * 这个适配器**要哪一种提交载荷**。
   *
   * 门面（`createWorkspaceStore`）据此决定「要不要序列化整份库」——
   * 判据是「存储要什么」，而不是「哪个适配器更省事」：接库之后仍然每笔都序列化整库，
   * 就是把整库覆盖写的成本从存储层搬到了 CPU 上。
   */
  readonly consumes: 'bytes' | 'rows'
  load(): Promise<LoadResult>
  /** 提交一批改动；**失败必须返回失败**，不许假装存上了 */
  commit(batch: CommitBatch): Promise<SaveResult>
  /** 清空（演示状态切换 / 重置用） */
  clear(): Promise<void>
  /**
   * 释放已排队的提交并**等待它落盘**。
   *
   * 为什么不是 `flush(): void`：批量提交是异步的，`beforeunload` 里只能同步等不到 Promise
   * —— 所以等待点由调用方决定（页面隐藏 / 卸载前），而不是假装能在 `beforeunload` 里救场。
   */
  settle(): Promise<void>
}

/** 序：把若干改动按先后排成一批（同一 tick 内的多次触摸合成一次提交） */
export type ChangeSink = (changes: Change[]) => void
