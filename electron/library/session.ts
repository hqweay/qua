/**
 * 一个打开的库 ＝ 一条 `RepoSession`。
 *
 * ## 它持有什么、为什么只有它持有
 *
 * ```
 * RepoSession {
 *   id       库 id（`library.json` 是权威；目录名只是默认值）
 *   dir      库目录
 *   db       qua.db 的连接（**单写者**：一个库一条连接）
 *   assets   assets/ 的适配器
 *   windows  订阅这个库的窗口（webContentsId）
 * }
 * ```
 *
 * 为什么收在一处：**窗口 / 库 / SQLite 的连接生命周期只能有一个地方管**。
 * 散开之后最容易出现的两个形状都是静默的：
 *   ① 最后一个窗口关了但连接没关 ⇒ 下次打开撞「database is locked」；
 *   ② 两个窗口各开一条连接 ⇒ 两个写者，WAL 下不会报错，只会丢更新。
 *
 * ## 打开 = 一串有明确出口的判定
 *
 * 目录是不是库（`library.json`）→ 身份对不对（manifest vs 目录名 vs `meta.library_id`）
 * → schema 版本（`user_version`：偏大拒绝 / 偏小迁移）。
 * 每一步失败都返回**一个能显示的原因**，绝不「打不开就新建一个」——
 * 那正是「往用户的项目目录里撒 qua.db」的形状。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSETS_DIR,
  BACKUPS_DIR,
  DB_FILE,
  LIBRARY_KIND,
  MANIFEST_FILE,
  META_KEYS,
  parseManifest,
  serializeManifest,
  type LibraryEntry,
  type LibraryManifest,
} from '../../src/core/identity/library.ts'
import { createFolderAssetStore, type AssetStore } from './assets.ts'
import {
  readBlockRows,
  readBlockTreeRows,
  readCandidatePage,
  readCatalogRows,
  readDocRows,
  readDependents,
  readFtsMapRows,
  readIdentityRows,
  readIndexChildren as readIndexChildrenFor,
  readIndexFollowing as readIndexFollowingFor,
  readIndexRows as readIndexRowsFor,
  planIsDense,
  readRelationsFor,
  readRootIds,
} from './reads.ts'
import type {
  BlockIndexRow,
  CandidatePage,
  CandidatePlan,
  LibraryCatalog,
  LibraryDocRows,
  RawLibraryRows,
} from '../../src/core/storage/library-reads.ts'
import type { DerivedPlan } from '../../src/core/storage/derived-plans.ts'
import {
  applyRowWrites,
  openLibraryDb,
  readMeta,
  replaceContentRows,
  writeMeta,
  writeSetting,
  type Db,
  type RowWrite,
} from './sqlite.ts'

export type OpenFailure =
  /** 目录里没有 `library.json`：这不是一个库，拒绝往里撒文件 */
  | { reason: 'not-a-library'; dir: string }
  /** `library.json` 读不懂（别人的 kind / 偏大的 format / 坏 id） */
  | { reason: 'bad-manifest'; dir: string; detail: 'parse' | 'kind' | 'format' | 'id' }
  /** 身份不一致：这是**另一个库的副本** */
  | { reason: 'identity-conflict'; dir: string; manifestId: string; dirId?: string; metaId?: string }
  /** `user_version` 偏大：拒绝打开，提示用更新版 */
  | { reason: 'too-new'; dir: string; version: number }
  /** `user_version` 不是合法版本号 */
  | { reason: 'corrupt'; dir: string; version: number }
  /** 迁移失败：主库已回滚到旧版本，可只读打开 */
  | { reason: 'migrate-failed'; dir: string; detail: string }
  /** 权限 / 磁盘：明确报错，不静默换目录 */
  | { reason: 'io'; dir: string; detail: string }

export interface RepoSession {
  id: string
  dir: string
  db: Db
  assets: AssetStore
  windows: Set<number>
  /**
   * **这台设备**的标识（来自 `app.json` 的注册表，库外）。
   *
   * 为什么每设备一个、且存在库外：`op_log` 的主键是 `(device_id, seq)`，
   * 身份跟随机器、序号跟随库 —— 库可以拷给别人，机器不会。若把 device_id 存进库，
   * 拷贝库目录就复制了身份（两台机器同 id ⇒ 序号撞车，幂等失效）。
   */
  deviceId: string
  /**
   * 这个会话**读过多少行、按哪条读面读的**。
   *
   * 为什么要记：工作集装载的验收不是「感觉快了」，是「首帧主进程读行数 ≤ Doc＋catalog 行数」。
   * 读面只有具名的几条（`doc`／`catalog`／`blocks`／…），各自记行数——
   * 没有一条能一次读走整库，这组数就是「这次启动读了多少」的直接证据。
   *
   * 只计数、不改行为：读面失败不在这里记账（调用方会拿到错误，计数不代表成功）。
   */
  reads: {
    doc: number
    docRows: number
    catalog: number
    catalogRows: number
    blocks: number
    blockRows: number
    candidates: number
    candidateIds: number
    identity: number
    identityRows: number
  }
  /**
   * 这个会话**累计写进去多少行**（`saveContent` 的返回值累加）。
   *
   * 为什么留这个数：它是「写成本」的直接证据 —— 「打一个字写几行」只能靠它回答。
   * 时间在 CI 上不稳，行数是确定的；而「行数随库体量增长」正是这次改造要消灭的形状。
   * 诊断面（`libraryInfo`）会把它报出去，自检脚本据此判「这一笔是不是整库重写」。
   */
  writes: { rows: number; ftsRows: number; saves: number }
  /**
   * 候选分页的**选路缓存**（计划 → 结果集是否超过「小计划」上限）。
   *
   * 为什么要它：判断一条计划的基数要把它数一遍（1M 上稠密计划约 5ms），而一次查询
   * 会按页来问十几次。这个答案只影响**走哪条路**（慢或快），不影响答案对不对；
   * 所以每次写入直接清空——用不出正确的状态比省下几毫秒重要得多。
   */
  candidateRoute: Map<string, boolean>
  /** 关连接（最后一个窗口关掉时调）。关之前 checkpoint，让主库文件自包含。 */
  close(): void
}

export type OpenSessionResult = { status: 'ok'; session: RepoSession } | { status: 'failed'; failure: OpenFailure }

function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 目录里除了 Finder 顺手留的 `.DS_Store` 之外什么都没有 */
function isEmptyDir(dir: string): boolean {
  if (!existsSync(dir)) return true
  try {
    if (!statSync(dir).isDirectory()) return false
    return readdirSync(dir).filter((n) => n !== '.DS_Store').length === 0
  } catch {
    return false
  }
}

/**
 * 初始化一个库目录：`library.json` ＋ `qua.db`（建表）＋ `assets/` ＋ `backups/`。
 *
 * 顺序有意为之：**先写 manifest 再建 DB**。崩在中间只留下「有 manifest 没 DB」——
 * 那是可判的坏库（重新初始化即可），而不是「有 DB 没身份」（后者拷贝后会被当成副本）。
 */
function initLibraryDir(dir: string, id: string, deviceId: string): { ok: true; session: RepoSession } | { ok: false; failure: OpenFailure } {
  try {
    mkdirSync(join(dir, ASSETS_DIR), { recursive: true })
    mkdirSync(join(dir, BACKUPS_DIR), { recursive: true })
    writeFileSync(join(dir, MANIFEST_FILE), serializeManifest(id))
  } catch (e) {
    return { ok: false, failure: { reason: 'io', dir, detail: String(e) } }
  }
  const opened = openLibraryDb(join(dir, DB_FILE))
  if (opened.status !== 'created' && opened.status !== 'ok') {
    return { ok: false, failure: { reason: 'io', dir, detail: `db open: ${opened.status}` } }
  }
  const db = opened.db
  writeMeta(db, META_KEYS.libraryId, id)
  writeMeta(db, META_KEYS.seq, '0')
  return { ok: true, session: makeSession(id, dir, db, deviceId) }
}

function makeSession(id: string, dir: string, db: Db, deviceId: string): RepoSession {
  const assets = createFolderAssetStore(db, join(dir, ASSETS_DIR))
  /**
   * **索引空、目录非空 ⇒ 索引丢了**（旧库升级、从别处拷来、行被清）。
   * 从目录重建一次 —— 这是「导入／修复」那条通用入口，与正常路径方向相反。
   * 正常启动不扫目录：只有第一次看见一个没有索引的 `assets/` 才会走到这里。
   */
  if (assets.rows().length === 0) {
    const rebuilt = assets.reindex()
    if (rebuilt.rows > 0 || rebuilt.renamed > 0 || rebuilt.filled > 0) {
      console.log(
        `[assets] reindexed ${rebuilt.rows} asset(s), renamed ${rebuilt.renamed}, filled ${rebuilt.filled} dims`,
      )
    }
  }
  return {
    id,
    dir,
    db,
    assets,
    windows: new Set<number>(),
    deviceId,
    reads: { doc: 0, docRows: 0, catalog: 0, catalogRows: 0, blocks: 0, blockRows: 0, candidates: 0, candidateIds: 0, identity: 0, identityRows: 0 },
    writes: { rows: 0, ftsRows: 0, saves: 0 },
    candidateRoute: new Map<string, boolean>(),
    close: () => {
      try {
        // 关之前 checkpoint：WAL 里的内容回主库 ⇒「只拷 qua.db」也能读出完整数据。
        // 实测：不 checkpoint 时只拷主库的副本读不出表（`no such table`）。
        db.exec('pragma wal_checkpoint(truncate)')
      } catch (e) {
        console.warn('[library] wal checkpoint failed', e)
      }
      db.close()
    },
  }
}

/**
 * 打开一个库目录。
 *
 * @param expectId 调用方（注册表）认为这个目录是哪个库。给了就**必须一致**，否则是副本。
 */
export function openSession(dir: string, opts: { expectId?: string; deviceId?: string } = {}): OpenSessionResult {
  const parsed = parseManifest(readTextFile(join(dir, MANIFEST_FILE)))

  if (parsed.status === 'missing') {
    // 没有 manifest ⇒ 只有**空目录**才允许被初始化（`expectId` 说明调用方已经决定要建它）
    if (!opts.expectId) return { status: 'failed', failure: { reason: 'not-a-library', dir } }
    if (!isEmptyDir(dir)) return { status: 'failed', failure: { reason: 'not-a-library', dir } }
    const made = initLibraryDir(dir, opts.expectId, opts.deviceId ?? '')
    return made.ok ? { status: 'ok', session: made.session } : { status: 'failed', failure: made.failure }
  }

  if (parsed.status === 'corrupt') {
    return { status: 'failed', failure: { reason: 'bad-manifest', dir, detail: parsed.reason } }
  }

  const manifest: LibraryManifest = parsed.manifest
  const dirName = dir.split('/').pop() ?? ''
  const dirId = /^[0-9a-f]{32}$/.test(dirName) ? dirName : undefined

  if (opts.expectId && opts.expectId !== manifest.id) {
    return { status: 'failed', failure: { reason: 'identity-conflict', dir, manifestId: manifest.id, dirId, metaId: opts.expectId } }
  }

  const opened = openLibraryDb(join(dir, DB_FILE))
  if (opened.status === 'too-new') return { status: 'failed', failure: { reason: 'too-new', dir, version: opened.version } }
  if (opened.status === 'corrupt') return { status: 'failed', failure: { reason: 'corrupt', dir, version: opened.version } }
  if (opened.status === 'migrate-failed') {
    return { status: 'failed', failure: { reason: 'migrate-failed', dir, detail: String(opened.error) } }
  }

  const db = opened.db

  // 身份三方对照：manifest（权威）vs DB meta vs 目录名
  const metaId = readMeta(db, META_KEYS.libraryId)
  if (metaId !== undefined && metaId !== manifest.id) {
    db.close()
    return { status: 'failed', failure: { reason: 'identity-conflict', dir, manifestId: manifest.id, dirId, metaId } }
  }
  if (dirId !== undefined && dirId !== manifest.id) {
    db.close()
    return { status: 'failed', failure: { reason: 'identity-conflict', dir, manifestId: manifest.id, dirId, metaId } }
  }

  // 首次打开（或旧库还没写过）：把身份补进 `meta`
  if (metaId === undefined) writeMeta(db, META_KEYS.libraryId, manifest.id)
  if (readMeta(db, META_KEYS.seq) === undefined) writeMeta(db, META_KEYS.seq, '0')

  return { status: 'ok', session: makeSession(manifest.id, dir, db, opts.deviceId ?? '') }
}

/* ------------------------------------------------------------ 内容读写（行） */

/**
 * 工作集读面：一个／多个 root 的**子树＋祖先链**（具名 SQL 在主进程执行）。
 *
 * 读面只有具名的几条（按 root／按 id／按计划），各自记账——回答的是
 * 「打开这一页要读多少行」，与库多大无关；上层据此判「首帧没有读全库」。
 */
export function readDoc(session: RepoSession, roots: readonly string[]): LibraryDocRows {
  const doc = readDocRows(session.db, roots)
  session.reads.doc += 1
  session.reads.docRows +=
    doc.rows.blocks.length +
    doc.rows.props.length +
    doc.rows.aliases.length +
    doc.rows.lists.length +
    doc.ancestors.length
  return doc
}

/**
 * **一批块自己的行**（不带子树）：引用目标／标签／字段定义／槽快捷卡的装载单位。
 *
 * 与 `readDoc` 分开记账：它回答的是「把 N 个按 id 的目标装进工作集要读多少行」，
 * 与打开一个视图根是两件事。
 */
export function readBlocks(session: RepoSession, blockIds: readonly string[]): RawLibraryRows {
  const rows = readBlockRows(session.db, blockIds)
  session.reads.blocks += 1
  session.reads.blockRows +=
    rows.blocks.length + rows.props.length + rows.aliases.length + rows.lists.length
  return rows
}

/** 槽要显示的全局身份摘要（页列表不在这里：它是查询视图，按页查）：与 Doc 分开计行 */
export function readCatalog(session: RepoSession): LibraryCatalog {
  const catalog = readCatalogRows(session.db)
  session.reads.catalog += 1
  session.reads.catalogRows +=
    catalog.journals.length +
    catalog.tags.length +
    catalog.propDefs.length +
    catalog.aliases.length +
    catalog.trash.length
  return catalog
}

/**
 * 落一批行写入（**增量**：这批 op 动过的块）。
 *
 * `replace` 为真 ＝ 整份替换（种子／换库／撤销之后）。两者的区别只有一个：
 * 要不要先清空内容表。清空只该发生在「整份写」的入口 —— 常规编辑走增量，
 * 顺手清表是一次数据事故，而它看起来只是「慢了一点」。
 */
export function saveContent(
  session: RepoSession,
  writes: readonly RowWrite[],
  opts: {
    replace?: boolean
    oplog?: readonly { at: number; opJson: string }[]
    derived?: boolean
    /** 派生表的整片改写计划：同一个事务、行写入之后执行（见 `derived-plans.ts`） */
    plans?: readonly DerivedPlan[]
  } = {},
): number {
  /**
   * **变更流与行写入同一个事务**（`applyRowWrites` 内部把它并进同一层事务）。
   * 整份替换（种子／换库）也是**新 genesis**：清旧日志、序号归零，
   * 再把这一批 op 作为新历史的第一段写进去。
   */
  const changed = opts.replace
    ? replaceContentRows(session.db, writes, { deviceId: session.deviceId, oplog: opts.oplog })
    : applyRowWrites(session.db, writes, { deviceId: session.deviceId, oplog: opts.oplog, plans: opts.plans })
  /**
   * **派生索引的构建成本单独记账**：它不是「一次用户动作写了多少行」。
   * 同一个计数器里混进 100k 重建的 20 万行，会让「打一个字写几行」永远测不出来。
   */
  if (opts.derived) session.writes.ftsRows += changed
  else session.writes.rows += changed
  session.writes.saves += 1
  // 基数变了 ⇒ 上一批「走哪条路」的判断可能不再成立（只影响快慢，不影响答案）
  session.candidateRoute.clear()
  return changed
}

/** 每库设置（窗口 bounds / 槽布局 / 折叠态）：存的是块 id，必须跟着库走 */
export function saveViewState(session: RepoSession, key: string, value: unknown): void {
  writeSetting(session.db, key, JSON.stringify(value))
}

export { LIBRARY_KIND }
export type { LibraryEntry }

/* ------------------------------------------------------------ 查询候选 */

/** 一页候选（SQL 计划在 core 编译；这里是执行与记账）。游标是上一页最后一条的 path */
export function readCandidates(
  session: RepoSession,
  plan: CandidatePlan,
  page: { after: string | null; limit: number },
): CandidatePage {
  const out = readCandidatePage(session.db, plan, page, {
    denseOf: (p) => {
      const key = JSON.stringify(p)
      const hit = session.candidateRoute.get(key)
      if (hit !== undefined) return hit
      const v = planIsDense(session.db, p)
      session.candidateRoute.set(key, v)
      return v
    },
  })
  session.reads.candidates += 1
  session.reads.candidateIds += out.ids.length
  return out
}

/** 候选装载（块＋祖先链，可选一层子级）：与 `readBlocks` 分开记账 */
export function readTree(session: RepoSession, blockIds: readonly string[], withChildren: boolean): RawLibraryRows {
  const rows = readBlockTreeRows(session.db, blockIds, withChildren)
  session.reads.blocks += 1
  session.reads.blockRows += rows.blocks.length + rows.props.length + rows.aliases.length + rows.lists.length
  return rows
}

/** 全局身份块装载（catalog 的块对象面）：与 catalog 分开记账（它带的是块行） */
export function readIdentity(session: RepoSession): RawLibraryRows {
  const rows = readIdentityRows(session.db)
  session.reads.identity += 1
  session.reads.identityRows += rows.blocks.length + rows.props.length + rows.aliases.length + rows.lists.length
  return rows
}

/** FTS 映射按块查（增量索引不再依赖全量映射进内存） */
export function readFtsMap(session: RepoSession, blockIds: readonly string[]): { block_id: string; source: string | null; fts_rowid: number }[] {
  return readFtsMapRows(session.db, blockIds)
}

/** 依赖方查询（全库口径；改名／清除的 FTS 重铺用） */
export function readDependentIds(
  session: RepoSession,
  targetId: string,
): { content: string[]; tag: string[]; prop: string[] } {
  return readDependents(session.db, targetId)
}

/** 顶层根 id 清单（派生表流式重建的装载单位） */
export function readRoots(session: RepoSession): string[] {
  return readRootIds(session.db)
}

/** 入向关系按目标批查（引用角标的全库计数） */
export function readRelations(
  session: RepoSession,
  targetIds: readonly string[],
): { to_id: string; from_id: string; kind: string; from_root: string }[] {
  return readRelationsFor(session.db, targetIds)
}

/**
 * **派生位置行的三条读面**（增量维护的取数口）。
 *
 * 不计入 `reads` 的行数账：那组数是「首帧装载读了多少」的证据，而这三条发生在
 * 结构写的路径上（一次一两行；`indexChildren` 只在整层重编号时读一层）。
 * 混进去会让「首帧读数」这条断言失去意义。
 */
export function readIndexRows(session: RepoSession, blockIds: readonly string[]): BlockIndexRow[] {
  return readIndexRowsFor(session.db, blockIds)
}

export function readIndexFollowing(
  session: RepoSession,
  parent: string | null,
  left: string | null,
): BlockIndexRow | null {
  return readIndexFollowingFor(session.db, parent, left)
}

export function readIndexChildren(session: RepoSession, parent: string | null): BlockIndexRow[] {
  return readIndexChildrenFor(session.db, parent)
}
