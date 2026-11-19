/**
 * 渲染层的 `StoragePort` 实现 —— 把**行写入**交给主进程（Electron 的库）。
 *
 * ## 为什么这层是「薄得只剩一次转发」
 *
 * `StoragePort` 的契约是「这批改动落盘了没有」，而落盘归主进程（`node:sqlite` 必须在主进程）。
 * 读不走这里：桌面读面是 `LibraryClient`（`library-client.ts`）的具名查询——
 * 按 root／按 id／按计划装工作集，没有「一次读走整库」的口子。
 * 上层（装配层/命令）一行都不用知道「库在哪」——这正是端口存在的原因。
 *
 * ## 为什么编码在这一侧（渲染层）而不是主进程
 *
 * 「一个块长成哪几行」是**块语义**，而主进程不许有块语义（它只认表名与列名，见
 * `electron/library/sqlite.ts` 的白名单）。⇒ 编码住 `core/storage/db-rows.ts`，
 * 主进程只做通用 SQL。两边共享的只有**表名**（`core/library.ts` 的 `DB_TABLES`）。
 */
import type { CommitBatch, SaveResult, StoragePort } from './port.ts'
import type { RowWrite } from './db-rows.ts'

/** 主进程那一侧的最小面（`electron/preload.ts` 暴露的同名方法） */
export interface LibraryBridge {
  /**
   * 壳的平台（同步常量，只在 Electron 里有）：顶栏按它给原生窗口控件让位。
   * 可选是因为测试可以只造一张瘦桥（web 宿主根本没有 `window.qua`）。
   */
  platform?: string
  onFlush?(cb: () => void | Promise<void>): void
  libraryInfo(): Promise<unknown>
  /**
   * 落一批行写入 ＋（可选）这一批的变更流。
   *
   * `oplog` 与 `writes` 必须落在**同一个事务**里：分开写会在崩溃时重号（幂等失效）
   * 或跳号（对端水位出现空洞），而 `op_log` 的两条性质都建立在这条上。
   */
  save(
    writes: unknown[],
    opts?: {
      replace?: boolean
      oplog?: { at: number; opJson: string }[]
      derived?: boolean
      plans?: readonly unknown[]
    },
  ): Promise<unknown>

  /**
   * 全文检索查询。`match` 由渲染层编译（含列过滤与 phrase），主进程只把它当参数绑定。
   * 返回 `blockId` ＋ BM25 分数；路径、片段、软删过滤都归渲染层。
   */
  search?(match: string, limit: number, offset?: number): Promise<unknown>

  /**
   * **工作集读面**（可选：web 宿主没有库面，测试也能造瘦桥）。
   *
   * 三个具名查询：`doc(roots)` 回子树＋祖先链，`blocks(ids)` 回一批块自己的行
   * （**不带子树**——引用目标/标签/定义按 id 装一块），`catalog()` 回槽的全局身份摘要。
   * 主进程只执行 `core/storage/library-reads.ts` 的 SQL，不认块语义；
   * 参数只有 id 列表，没有任意 SQL 过桥的口子。
   */
  doc?(roots: readonly string[]): Promise<unknown>
  /** 一窗 Doc（DFS 前缀）＋下一页游标：巨大 Doc 的分段装载 */
  docWindow?(root: string, after: string | null, limit: number): Promise<unknown>
  blocks?(ids: readonly string[]): Promise<unknown>
  /** 查询候选 id（计划由 core 编译，主进程只执行 SQL） */
  candidates?(plan: unknown): Promise<unknown>
  /** 候选装载：块＋全部祖先链（可选一层子级） */
  tree?(ids: readonly string[], withChildren: boolean): Promise<unknown>
  catalog?(): Promise<unknown>
  /** 全局身份块（页/标签/定义/回收站根） */
  identity?(): Promise<unknown>
  /** FTS 映射按块查（增量索引用） */
  ftsMap?(ids: readonly string[]): Promise<unknown>
  /** 依赖方查询（正文引用/标签成员/属性值三路分类） */
  dependents?(targetId: string): Promise<unknown>
  /** 顶层根清单（派生表流式重建用） */
  roots?(): Promise<unknown>
  /** 入向关系按目标批查（引用角标的全库计数；未 ready 时 ready:false） */
  relations?(ids: readonly string[]): Promise<unknown>

  /**
   * 资产面（内容寻址；字节走 ArrayBuffer，主进程写进库目录的 `assets/`）。
   *
   * 只有两格：**写字节**与**一次拿全部元信息**。地址不走 IPC（`qua-asset://<hash>`
   * 由壳的协议处理器接住）—— 少一次往返，也少一处「地址什么时候失效」的状态。
   */
  assetIndex(): Promise<unknown>
  assetPut(bytes: ArrayBuffer, mime: string, dims?: { w?: number; h?: number }): Promise<unknown>

  /**
   * 库的 `settings` 表（跟库走的视图状态住这里）。回复形状归宿主，这里只当不透明值转发。
   * 这个接口只有桌面宿主会实现（web 宿主根本没有库面），所以是必有格。
   */
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: string): Promise<unknown>

  /**
   * 整库快照（主进程 `VACUUM INTO` 到库目录的 `backups/`）。返回快照路径。
   * 渲染层显式清库前调用它；主进程失败会原样报错，让清空中止。
   */
  backupLibrary?(label?: string): Promise<unknown>
}

export const IPC_BACKEND = 'ipc-library'

export function createIpcAdapter(bridge: LibraryBridge): StoragePort {
  /** 单写者：与 localStorage 适配器同一条口径（后一次提交永远排在前一次之后） */
  let tail: Promise<unknown> = Promise.resolve()

  return {
    kind: IPC_BACKEND,
    consumes: 'rows',

    commit(batch: CommitBatch): Promise<SaveResult> {
      const run = async (): Promise<SaveResult> => {
        try {
          const writes: RowWrite[] = batch.writes ?? []
          /**
           * **变更流随行写入一起发**：主进程把它们与行写入放进**同一个事务**
           * （分开写会在崩溃时重号或跳号，而 `op_log` 的幂等与水位都建立在这条上）。
           */
          const oplog = batch.oplog?.map((op) => ({ at: op.at, opJson: JSON.stringify(op) })) ?? []
          const r = (await bridge.save(writes, {
            replace: batch.replace === true,
            oplog,
            plans: batch.plans ?? [],
          })) as
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
     * 整库快照：主进程把**当前已落盘的字节** `VACUUM INTO` 到库目录的 `backups/`。
     *
     * 只快照「已经在盘上」的那份 —— 调用方必须先把渲染层的写队列 flush 掉
     * （`StoragePort.backup` 的契约）。失败**抛出**，清空动作据此中止。
     * 没有这个接口的宿主 ⇒ `null`（web 的 localStorage 有它自己的实现）。
     */
    async backup(): Promise<string | null> {
      if (!bridge.backupLibrary) return null
      const r = (await bridge.backupLibrary('before-reset')) as
        | { status?: string; path?: string; error?: unknown }
        | null
      if (r?.status === 'ok' && typeof r.path === 'string') return r.path
      throw new Error(typeof r?.error === 'string' ? r.error : `library backup failed: ${String(r?.status)}`)
    },

    /**
     * 清空。**故意什么都不做**：库的内容只走用户显式的「恢复空库」——
     * 它先拍一份 `backup()` 快照再整份替换，不是一条可以随手调的 `clear()`。
     */
    async clear(): Promise<void> {
      console.warn('[storage] clear() is a no-op on a library-backed workspace')
    },

    async settle(): Promise<void> {
      await tail
    },
  }
}
