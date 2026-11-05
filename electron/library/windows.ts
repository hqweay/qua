/**
 * 一库一窗：窗口 ↔ 库 ↔ 会话的**唯一**登记处。
 *
 * ## 为什么是「一张表管会话」而不是「每个窗口自己开库」
 *
 * 一库一窗的形状。三个失败模式都只在散开时出现：
 *   ① 同一库开两个窗口 ⇒ 两条连接、两个写者 ⇒ WAL 下不报错、只丢更新；
 *   ② 窗口关了连接没关 ⇒ 下次打开撞「database is locked」；
 *   ③ IPC 不知道消息来自哪个库 ⇒ 渲染层得自己带库 id，而它拿到的 id 可能过期。
 *
 * ⇒ 两张 Map（`byId`／`byWebContents`）＋ 一条规则：**消息按 `event.sender.id` 路由**，
 * 渲染层永远不告诉主进程「我是哪个库」。
 *
 * ## 关闭握手（最容易「差一句」的地方）
 *
 * `close` → `preventDefault` → 通知 renderer flush → 等 ack（或 1.5s 超时）→
 * 写窗口 bounds → 关该库 DB（若是最后一窗）→ `destroy()`。
 *
 * 为什么必须握手：renderer 的落盘是 250ms 防抖，关窗那一刻可能还有一笔没发出去。
 * 不握手＝「关掉重开少最后一句」。
 */
import { BrowserWindow, app, ipcMain, type WebContents } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DB_SCHEMA_VERSION,
  MANIFEST_FILE,
  parseManifest,
  type LibraryEntry,
} from '../../src/core/identity/library.ts'
import { libraryDir, loadRegistry, markOpened, saveRegistry, type RegistryIo } from './registry.ts'
import { loadContent, openSession, saveContent, type OpenFailure, type RepoSession } from './session.ts'
import { readSeq, searchFts, snapshotLibrary, type RowWrite } from './sqlite.ts'

/** 关窗握手等 renderer 回话的上限。超时就强关——卡住比丢一句话更糟。 */
const CLOSE_ACK_TIMEOUT_MS = 1500

export interface LibraryManagerDeps {
  io: RegistryIo
  /** 建一个库窗口；`libraryId` 是它订阅的库 */
  createWindow: (libraryId: string, title: string) => BrowserWindow
  /** 读窗口位置记忆（主进程自己的 `window-state.json`） */
  readBounds: () => { x?: number; y?: number; width: number; height: number; maximized?: boolean }
  writeBounds: (win: BrowserWindow) => void
  /**
   * 注册表刚落了一次盘（开库／建库都会走到）。
   * 「最近的库」这类**构建时快照**的消费者靠它重建自己，否则永远停在启动那一刻。
   */
  onRegistryChanged?: () => void
}

export interface OpenedLibrary {
  entry: LibraryEntry
  session: RepoSession
}

export class LibraryManager {
  /** `libraryId → 会话`。**一个库一条连接、一个写者。** */
  private readonly sessions = new Map<string, RepoSession>()
  /** `webContents.id → libraryId`。IPC 只按这一条路由。 */
  private readonly ofContents = new Map<number, string>()
  /** `libraryId → 窗口`。同库再打开＝聚焦这一扇。 */
  private readonly windows = new Map<string, BrowserWindow>()
  /** 正在关闭的窗口：`close` 里 preventDefault 之后走到这里，避免重入 */
  private readonly closing = new Set<number>()

  constructor(private readonly deps: LibraryManagerDeps) {}

  /* ------------------------------------------------------------ 注册表 */

  get registry() {
    return loadRegistry(this.deps.io)
  }

  saveRegistry(): void {
    // 每次都从盘上重读再写，避免两份内存副本（主进程只有一处状态：盘）
    saveRegistry(this.deps.io, this.registry.registry)
  }

  /* ------------------------------------------------------------ 打开 */

  /**
   * 打开一个库（已有窗口就聚焦）。
   *
   * 返回失败原因时**不建窗口**：让调用方决定怎么说（欢迎页／对话框）。
   */
  open(id: string): { status: 'ok'; window: BrowserWindow } | { status: 'failed'; failure: OpenFailure } {
    const existing = this.windows.get(id)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return { status: 'ok', window: existing }
    }

    const loaded = loadRegistry(this.deps.io)
    const entry = loaded.registry.libraries.find((l) => l.id === id)
    if (!entry) {
      return { status: 'failed', failure: { reason: 'not-a-library', dir: id } }
    }

    const dir = libraryDir(this.deps.io, entry)
    const opened = openSession(dir, { expectId: id, deviceId: loaded.registry.deviceId })
    if (opened.status === 'failed') return { status: 'failed', failure: opened.failure }

    const session = opened.session
    this.sessions.set(id, session)

    // 记「这次打开的是它」，并把名字写回注册表（库名以 manifest/DB 为准，注册表只缓存）
    saveRegistry(this.deps.io, markOpened(loaded.registry, id))
    this.deps.onRegistryChanged?.()

    const win = this.deps.createWindow(id, entry.name)
    this.windows.set(id, win)
    this.bind(win, session)

    return { status: 'ok', window: win }
  }

  /** 新建一个库：建目录 → 初始化 → 开窗 */
  create(id: string, name: string, parentDir?: string): { status: 'ok'; window: BrowserWindow } | { status: 'failed'; failure: OpenFailure } {
    const loaded = loadRegistry(this.deps.io)
    const dir = parentDir ?? join(this.deps.io.reposDir, id)
    const opened = openSession(dir, { expectId: id, deviceId: loaded.registry.deviceId })
    if (opened.status === 'failed') return { status: 'failed', failure: opened.failure }

    const session = opened.session
    this.sessions.set(id, session)
    const entry: LibraryEntry = parentDir ? { id, name, path: parentDir } : { id, name }
    const next = markOpened(
      { ...loaded.registry, libraries: [...loaded.registry.libraries.filter((l) => l.id !== id), entry] },
      id,
    )
    saveRegistry(this.deps.io, next)
    this.deps.onRegistryChanged?.()

    const win = this.deps.createWindow(id, name)
    this.windows.set(id, win)
    this.bind(win, session)
    return { status: 'ok', window: win }
  }

  /**
   * 打开一个**任意目录**下的库（「打开库…」与首次启动的「加载已有库」走这里）。
   *
   * 身份从**目录里的 manifest** 读（`library.json.id` 是权威），不信任路径与调用方：
   *   · 目录里没有 manifest ⇒ 不是库，拒绝（绝不往用户目录里撒文件）；
   *   · 这个 id 已经登记在别处 ⇒ 拒绝（两份同 id 是副本；打开哪份都必须是显式的）；
   *   · 没登记过 ⇒ 登记为外部库（`entry.path`），显示名先用目录名（open 之后以库为准）。
   * 之后的流程与 `open(id)` 完全同一条：同库已开＝聚焦，否则开窗。
   */
  openAt(dir: string): { status: 'ok'; window: BrowserWindow } | { status: 'failed'; failure: OpenFailure } {
    const raw = (() => {
      try {
        return readFileSync(join(dir, MANIFEST_FILE), 'utf8')
      } catch {
        return null
      }
    })()
    const parsed = parseManifest(raw)
    if (parsed.status === 'missing') return { status: 'failed', failure: { reason: 'not-a-library', dir } }
    if (parsed.status === 'corrupt') {
      return { status: 'failed', failure: { reason: 'bad-manifest', dir, detail: parsed.reason } }
    }
    const id = parsed.manifest.id
    const loaded = loadRegistry(this.deps.io)
    const known = loaded.registry.libraries.find((l) => l.id === id)
    if (known && libraryDir(this.deps.io, known) !== dir) {
      return { status: 'failed', failure: { reason: 'identity-conflict', dir, manifestId: id } }
    }
    if (!known) {
      const entry: LibraryEntry = { id, name: dir.split('/').pop() ?? id, path: dir }
      saveRegistry(this.deps.io, {
        ...loaded.registry,
        libraries: [...loaded.registry.libraries, entry],
      })
      this.deps.onRegistryChanged?.()
    }
    return this.open(id)
  }

  /* ------------------------------------------------------------ 窗口绑定与关闭握手 */

  private bind(win: BrowserWindow, session: RepoSession): void {
    const wc = win.webContents
    this.ofContents.set(wc.id, session.id)
    session.windows.add(wc.id)

    wc.on('destroyed', () => {
      this.ofContents.delete(wc.id)
      session.windows.delete(wc.id)
    })

    win.on('close', (e) => {
      if (this.closing.has(wc.id)) return
      e.preventDefault()
      void this.closeWithHandshake(win, session)
    })

    win.on('closed', () => {
      this.windows.delete(session.id)
    })
  }

  /**
   * 关闭握手。
   *
   * 顺序：通知 renderer flush → 等 ack（超时强关）→ 写 bounds → 最后一窗时关连接 → destroy。
   *
   * ⚠️ `session.windows` 里 `wc.id` 的移除在 `destroyed` 事件里，而这里要**先**判断
   * 「是不是最后一窗」——所以先把它从集合里摘掉再判，否则永远判成「不是最后一窗」，
   * 连接就永远不关（下次打开撞 database is locked）。
   */
  private async closeWithHandshake(win: BrowserWindow, session: RepoSession): Promise<void> {
    const wc = win.webContents
    if (this.closing.has(wc.id)) return
    this.closing.add(wc.id)

    await this.askRendererToFlush(wc)

    try {
      this.deps.writeBounds(win)
    } catch (e) {
      console.warn('[library] window bounds write failed', e)
    }

    // 先摘再判「最后一窗」
    session.windows.delete(wc.id)
    this.ofContents.delete(wc.id)
    if (session.windows.size === 0) {
      // 关连接前 checkpoint 一次（session.close 内部会做，这里只是把时机写清）
      try {
        session.close()
      } catch (e) {
        console.warn('[library] session close failed', e)
      }
      this.sessions.delete(session.id)
    }

    if (!win.isDestroyed()) win.destroy()
  }

  /** 让 renderer 把待落盘的那批发出来，并等它回 ack（超时放行） */
  private askRendererToFlush(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (why: string): void => {
        if (done) return
        done = true
        ipcMain.removeListener('qua:flush/ack', onAck)
        clearTimeout(timer)
        if (why !== 'ack') console.warn(`[library] close handshake timed out (${why})`)
        resolve()
      }
      const onAck = (e: Electron.IpcMainEvent): void => {
        if (e.sender.id === wc.id) finish('ack')
      }
      ipcMain.on('qua:flush/ack', onAck)
      const timer = setTimeout(() => finish('timeout'), CLOSE_ACK_TIMEOUT_MS)
      try {
        wc.send('qua:flush')
      } catch {
        finish('send-failed')
      }
    })
  }

  /** `before-quit`：等所有库 settle 再退出 */
  async quitAll(): Promise<void> {
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    await Promise.all(
      wins.map(
        (w) =>
          new Promise<void>((resolve) => {
            const wc = w.webContents
            if (wc.isDestroyed()) return resolve()
            const done = (): void => resolve()
            wc.once('destroyed', done)
            w.close()
            // 兜底：握手超时之后 closeWithHandshake 会 destroy，这里不重复等
            setTimeout(done, CLOSE_ACK_TIMEOUT_MS + 500)
          }),
      ),
    )
    for (const s of this.sessions.values()) {
      try {
        s.close()
      } catch (e) {
        console.warn('[library] quit: session close failed', e)
      }
    }
    this.sessions.clear()
  }

  /* ------------------------------------------------------------ 资产地址 */

  /**
   * `qua-asset://<hash>` → 库目录里的那份文件（协议处理器用）。
   *
   * 为什么不带库 id：**内容寻址 ⇒ 同一个 hash 在哪个库里都是同一份字节**。
   * 「这是哪个库的」不是这个地址要回答的问题；让它多带一格，就多一处能错的地方
   * （而且渲染层手里的库 id 可能是过期的 —— 那正是 IPC 一律按 `sender.id` 路由的原因）。
   */
  assetFileOf(hash: string): { path: string; mime: string } | null {
    for (const s of this.sessions.values()) {
      const hit = s.assets.locate(hash)
      if (hit) return hit
    }
    return null
  }

  /* ------------------------------------------------------------ IPC 路由 */

  /**
   * 装 IPC。**所有消息按 `event.sender.id` 路由**，渲染层不告诉主进程「我是哪个库」。
   *
   * 为什么：渲染层手里的库 id 可能是过期的（窗口切库／库被移除），
   * 而 `sender.id` 是 Electron 给的事实。
   */
  installIpc(): void {
    const sessionOf = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): RepoSession | undefined => {
      const id = this.ofContents.get(e.sender.id)
      return id ? this.sessions.get(id) : undefined
    }

    /** 库身份与能力（渲染层启动时问一次） */
    ipcMain.handle('qua:library/info', (e) => {
      const s = sessionOf(e)
      if (!s) return { status: 'no-library' }
      const loaded = loadRegistry(this.deps.io)
      const entry = loaded.registry.libraries.find((l) => l.id === s.id)
      return {
        status: 'ok',
        id: s.id,
        name: entry?.name ?? s.id,
        dir: s.dir,
        deviceId: loaded.registry.deviceId,
        schemaVersion: DB_SCHEMA_VERSION,
        seq: readSeq(s.db),
        /**
         * 这个库到目前为止**写过多少行**（`saveContent` 累加）。
         *
         * 给诊断面与自检脚本用：`rows` 是「写成本」的直接证据 ——
         * 「打一个字写几行」只能靠它回答，而「行数随库体量增长」正是要消灭的形状。
         */
        writes: { ...s.writes },
      }
    })

    /**
     * 读内容（四张内容表的**全部行**）。
     *
     * 送行不送「一份库」：编码归渲染层，主进程不认识块语义。
     * `status: 'empty'` ＝ 这个库还没有内容（新建／被作废的旧库），渲染层据此 seed。
     */
    ipcMain.handle('qua:storage/load', (e) => {
      const s = sessionOf(e)
      if (!s) return { status: 'no-library' }
      const content = loadContent(s)
      return content ? { status: 'ok', rows: content } : { status: 'empty' }
    })

    /**
     * 落一批行写入。
     *
     * `writes` 是渲染层按 `core/storage/db-rows.ts` 算出来的行（表名/列名由主进程校验）；
     * `replace` 为真 ＝ 整份替换（种子／换库／撤销之后）。**失败必须如实返回**：
     * 假装存上了会让用户以为写进去了。
     */
    ipcMain.handle('qua:storage/save', (e, writes: unknown, opts: unknown) => {
      const s = sessionOf(e)
      if (!s) return { ok: false, error: 'no-library' }
      if (!Array.isArray(writes)) return { ok: false, error: 'bad-args' }
      const o = opts as { replace?: unknown; oplog?: unknown; derived?: unknown } | null
      const replace = Boolean(o?.replace)
      const derived = Boolean(o?.derived)
      /**
       * **变更流**（可选）：与行写入**同一个事务**追加进 `op_log`。
       * 校验它是不是数组，但不认识 op 的语义 —— 编码与形状归渲染层，
       * 主进程只做「原样存进去 + 推进水位」。
       */
      const oplog: { at: number; opJson: string }[] = Array.isArray(o?.oplog)
        ? (o!.oplog as unknown[])
            .filter((x): x is { at: unknown; opJson: unknown } => !!x && typeof x === 'object')
            // 只做**形状**校验（数字/字符串），不认识 op 的语义：编码归渲染层
            .map((x) => ({ at: Number(x.at), opJson: String(x.opJson) }))
            .filter((x) => Number.isFinite(x.at) && x.opJson.length > 0)
        : []
      try {
        const changed = saveContent(s, writes as RowWrite[], { replace, oplog, derived })
        return { ok: true, changed }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    })

    /**
     * 全文检索。`match` 是渲染层编译好的 FTS5 表达式（数据，不是代码）：
     * 主进程只把它绑定进固定 SQL，不做块语义判断；软删过滤与片段都在渲染层。
     */
    ipcMain.handle('qua:search/query', (e, match: unknown, limit: unknown, offset: unknown) => {
      const s = sessionOf(e)
      if (!s) return { status: 'no-library' }
      if (typeof match !== 'string' || match.length === 0 || match.length > 4096) {
        return { status: 'bad-args' }
      }
      try {
        const hits = searchFts(s.db, match, Number(limit) || 50, Number(offset) || 0)
        return { status: 'ok', hits }
      } catch (err) {
        return { status: 'error', error: String(err) }
      }
    })

    /** 每库设置（窗口 bounds / 槽布局 / 折叠态） */
    ipcMain.handle('qua:settings/get', (e, key: unknown) => {      const s = sessionOf(e)
      if (!s || typeof key !== 'string') return { status: 'no-library' }
      const rows = s.db.prepare('select value from settings where key = ?').all(key) as { value: string }[]
      return rows[0] ? { status: 'ok', value: rows[0].value } : { status: 'empty' }
    })

    ipcMain.handle('qua:settings/set', (e, key: unknown, value: unknown) => {
      const s = sessionOf(e)
      if (!s || typeof key !== 'string' || typeof value !== 'string') return { ok: false, error: 'bad-args' }
      try {
        s.db
          .prepare('insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value')
          .run(key, value)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    })

    /**
     * **整库快照**（`backups/<epoch>-<label>.db`）：给用户显式的「恢复空库」当回退面。
     *
     * 只在这里做：`VACUUM INTO` 要一条活着的连接，而连接归会话所有（一库一窗、单写者）。
     * 返回**绝对路径**：渲染层把它原样说给用户听，不自己拼库目录。
     * 失败如实返回错误 —— 调用方会中止覆盖，绝不做没有备份的清空。
     */
    ipcMain.handle('qua:library/backup', (e, label: unknown) => {
      const s = sessionOf(e)
      if (!s) return { status: 'no-library' }
      const name = typeof label === 'string' && /^[a-z0-9-]{1,40}$/.test(label) ? label : 'manual'
      try {
        return { status: 'ok', path: snapshotLibrary(s.db, s.dir, name) }
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    })

    /**
     * 资产：**一次拿全部元信息** ＋ 写一份字节。
     *
     * 地址（`qua-asset://<hash>`）不走 IPC —— 壳里注册的协议处理器直接把它映射到
     * 库目录里的文件。少一次往返，也少一处「地址什么时候失效」的状态。
     */
    ipcMain.handle('qua:assets/index', (e) => {
      const s = sessionOf(e)
      return s ? { status: 'ok', rows: s.assets.rows() } : { status: 'no-library' }
    })

    ipcMain.handle('qua:assets/put', async (e, bytes: unknown, mime: unknown, dims: unknown) => {
      const s = sessionOf(e)
      if (!s || !(bytes instanceof ArrayBuffer) || typeof mime !== 'string') return { status: 'bad-args' }
      const d = (dims && typeof dims === 'object' ? dims : {}) as { w?: number; h?: number }
      const meta = await s.assets.put(new Uint8Array(bytes), mime, d)
      return { status: 'ok', meta }
    })

    /** 库列表（欢迎页／菜单用） */
    ipcMain.handle('qua:library/list', () => {
      const loaded = loadRegistry(this.deps.io)
      return {
        status: 'ok',
        deviceId: loaded.registry.deviceId,
        lastOpenedId: loaded.registry.lastOpenedId ?? null,
        libraries: loaded.registry.libraries,
        dropped: loaded.dropped,
        backup: loaded.backup ?? null,
        recovered: loaded.recovered ?? 0,
      }
    })

    ipcMain.handle('qua:library/open', (_e, id: unknown) => {
      if (typeof id !== 'string') return { status: 'failed', reason: 'bad-args' }
      const r = this.open(id)
      return r.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: r.failure }
    })

    ipcMain.handle('qua:library/create', (_e, id: unknown, name: unknown, dir: unknown) => {
      if (typeof id !== 'string' || typeof name !== 'string') return { status: 'failed', reason: 'bad-args' }
      if (dir !== undefined && typeof dir !== 'string') return { status: 'failed', reason: 'bad-args' }
      const r = this.create(id, name, dir)
      return r.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: r.failure }
    })

    /**
     * 打开一个**目录**下的库（目录里必须有 `library.json`）。身份从 manifest 读，
     * 没登记过就登记为外部库——「打开库…」与将来欢迎页的共用落点。
     */
    ipcMain.handle('qua:library/open-at', (_e, dir: unknown) => {
      if (typeof dir !== 'string' || dir === '') return { status: 'failed', reason: 'bad-args' }
      const r = this.openAt(dir)
      return r.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: r.failure }
    })

    /** `shellInfo` 是原有那条；这里不重复注册 */
    void app
  }
}
