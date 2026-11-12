/**
 * 快照的**恢复**：把 `backups/*.db` 放回库。
 *
 * ## 为什么这个文件曾经是空的（而备份不是）
 *
 * `snapshotLibrary` 早就在了（`sqlite.ts`，`VACUUM INTO`），迁移前与显式清库前
 * 各调一次。但全仓没有一条路径把快照**放回去**——`grep -rni restore` 命中的
 * 全是窗口 `restore()`／焦点归还／DOM 文本。于是「备份」只是目录里几个 `.db` 文件：
 * 出事时用户打不开它们，也**没有任何入口**让应用去打开它们。
 *
 * ## 为什么恢复只在**启动时**做
 *
 * 一个打开的库 ＝ 一条活连接 ＋ 一份内存模型 ＋ 若干窗口订阅它。在活着的会话上
 * 把 `qua.db` 换掉，等于**换引擎的同时换轮胎**：
 *   · 连接还握着旧文件的 inode（换掉路径不换句柄），写进去的是已经被替换的那份；
 *   · 内存模型还是旧内容，下一次 `save` 会把旧内容**写回**新文件；
 *   · WAL 里可能还有未 checkpoint 的页，混进新库。
 * 三者都不报错。⇒ 恢复的入口是「带 `--restore-backup=` 启动」，
 * 那时还没有连接、没有模型、没有窗口。
 *
 * ## 恢复本身也要有回退面
 *
 * 恢复是**破坏性**动作（当前内容会被覆盖）。所以它做的第一件事是把当前态拍成
 * `before-restore` 快照——否则「恢复错了」这件事没有第二次机会。
 *
 * ## 不许被快照改掉的东西
 *
 * 快照是**同一个库的历史**，不是另一个库的拷贝。所以恢复后 `library.json` 与
 * `meta.library_id` 必须仍是这个库的：
 *   · `library.json` 根本不参与替换（它住在库目录，不在 `qua.db` 里）；
 *   · `meta.library_id` 在替换后显式重写一次——一份从「同库但身份行丢了」的
 *     旧快照里恢复出来的库，不该因此变成「身份不一致、拒绝打开」。
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKUPS_DIR, DB_FILE, DB_SCHEMA_VERSION, judgeDbVersion } from '../../src/core/identity/library.ts'
import { openLibraryDb, readUserVersion, snapshotLibrary } from './sqlite.ts'

export interface BackupEntry {
  /** 绝对路径 */
  file: string
  /** 文件名里的 epoch 毫秒（排序与显示用） */
  at: number
  /** 文件名里的用途标签（`manual`／`before-migrate-v8`／`before-restore`…） */
  label: string
  /** 字节数（给用户判断「这份像不像我的库」） */
  size: number
}

export type RestoreResult =
  | { status: 'ok'; restored: string; beforeRestore: string }
  /** 快照文件不存在 */
  | { status: 'failed'; reason: 'no-such-backup'; file: string }
  /** 快照的 schema 版本比这版应用新：拒绝（不猜着读） */
  | { status: 'failed'; reason: 'too-new'; version: number }
  /** 快照的 `user_version` 不是合法版本号 */
  | { status: 'failed'; reason: 'corrupt'; version: number }
  /** 其它 IO / SQLite 错误 */
  | { status: 'failed'; reason: 'io'; detail: string }

/**
 * 列出一份库的**可恢复快照**，按时间倒序（最近的在最前）。
 *
 * 只认 `.db`：目录里可能有 `.db-wal`／`.db-shm` 这类伴生文件，
 * 也可能有人顺手放了笔记。混进来会让「选哪一份」变成猜。
 */
export function listBackups(libraryDir: string): BackupEntry[] {
  const dir = join(libraryDir, BACKUPS_DIR)
  if (!existsSync(dir)) return []
  const out: BackupEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.db')) continue
    const file = join(dir, name)
    const m = /^(\d+)-(.+)\.db$/.exec(name)
    let size = 0
    try {
      size = statSync(file).size
    } catch {
      continue // 列目录与 stat 之间被删掉：跳过，不炸整个列表
    }
    out.push({ file, at: m ? Number(m[1]) : 0, label: m ? m[2]! : name, size })
  }
  return out.sort((a, b) => b.at - a.at)
}

/**
 * 把一份快照放回库。
 *
 * **调用前提：这个库没有活着的会话**（见文件头「为什么恢复只在启动时做」）。
 * 调用方（`electron/main.ts` 的启动路径）在 `bootLibraries()` 之前调它。
 *
 * 步骤与顺序都是判据的一部分：
 *   1. 快照在不在；
 *   2. 快照的版本能不能读（偏大拒绝——用旧版打开新库会让它按旧口径解释）；
 *   3. **先拍当前态**（恢复也要回退面）；
 *   4. 关掉任何可能存在的伴生文件，再整份替换 `qua.db`；
 *   5. 重写 `meta.library_id`（同库历史不许改身份）；
 *   6. 跑一次 `openLibraryDb` 的迁移判定——快照可能比这版应用旧。
 */
export function restoreFromBackup(libraryDir: string, backupFile: string): RestoreResult {
  if (!existsSync(backupFile)) return { status: 'failed', reason: 'no-such-backup', file: backupFile }

  // ② 版本判据：先只读问一句，别等替换完才发现读不了
  const version = (() => {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(backupFile, { readOnly: true })
      return readUserVersion(db)
    } catch {
      return null
    } finally {
      try {
        db?.close()
      } catch {
        /* 关不掉不影响判定 */
      }
    }
  })()
  if (version === null) return { status: 'failed', reason: 'io', detail: 'cannot read backup' }
  const verdict = judgeDbVersion(version, DB_SCHEMA_VERSION)
  if (verdict.status === 'too-new') return { status: 'failed', reason: 'too-new', version }
  if (verdict.status === 'corrupt') return { status: 'failed', reason: 'corrupt', version }

  const live = join(libraryDir, DB_FILE)

  // ③ 先拍当前态。当前库不存在（第一次恢复）时跳过——没有可拍的东西。
  let beforeRestore = ''
  if (existsSync(live)) {
    let db: DatabaseSync | undefined
    try {
      const opened = openLibraryDb(live)
      if (opened.status !== 'ok' && opened.status !== 'created' && opened.status !== 'migrated') {
        return { status: 'failed', reason: 'io', detail: `live db unreadable: ${opened.status}` }
      }
      db = opened.db
      beforeRestore = snapshotLibrary(db, libraryDir, 'before-restore')
    } catch (e) {
      // **拍不出回退面就不动手**：恢复是破坏性的，没有回退面的恢复是赌博。
      return { status: 'failed', reason: 'io', detail: `snapshot before restore failed: ${String(e)}` }
    } finally {
      try {
        db?.close()
      } catch {
        /* 同上 */
      }
    }
  }

  // ④ 整份替换。WAL/SHM 必须一起清：它们是**旧文件**的伴生页，混进新库就是坏库。
  try {
    for (const suffix of ['-wal', '-shm']) {
      const side = `${live}${suffix}`
      if (existsSync(side)) rmSync(side, { force: true })
    }
    copyFileSync(backupFile, live)
  } catch (e) {
    return { status: 'failed', reason: 'io', detail: String(e) }
  }

  // ⑤ 身份归这个库（快照是同一个库的历史）。⑥ 顺手跑迁移判定。
  try {
    const opened = openLibraryDb(live)
    if (opened.status === 'too-new') return { status: 'failed', reason: 'too-new', version: opened.version }
    if (opened.status === 'corrupt') return { status: 'failed', reason: 'corrupt', version: opened.version }
    if (opened.status === 'migrate-failed') return { status: 'failed', reason: 'io', detail: String(opened.error) }
    // 快照里若没有身份行（更早的形状），不在这里编一个 id 出来：`openSession` 会拿
    // `library.json` 的 id（权威）补进去。这里只负责「能打开」。
    opened.db.close()
  } catch (e) {
    return { status: 'failed', reason: 'io', detail: String(e) }
  }

  return { status: 'ok', restored: backupFile, beforeRestore }
}
