/**
 * `qua.db` 的 SQLite 适配器 —— **有意的临时形状**。
 *
 * ## 这是有意的临时形状，不是终态
 *
 * 现在只把**整份 `Workspace` JSON** 塞进 `workspace(id=1, json, saved_at)`，
 * 为的是先把多库／多窗口／关闭握手／持久化跑通。**下一步必须换成规范化 schema**
 * （blocks/content/props/aliases/lists/tags/belongs/annos/settings/meta）并写迁移。
 *
 * 两条纪律，别让临时形状变成终态：
 *   ① **不许在这里长规范化表**（`Block`／`BlockProperty`／`BlockAlias`…）——那会让下一次迁移
 *      的迁移同时面对「两种形状混在一个库里」；
 *   ② **不许写旧数据迁移**（开发阶段旧数据可弃，`WORKSPACE_VERSION` 升一即作废）。
 *
 * ## 为什么建表与迁移都是「一个事务包住版本号」
 *
 * 实测（Node 26 / SQLite 3.53）：`PRAGMA user_version` **随事务原子回滚**。
 * ⇒ 「建表/改表 ＋ 版本号 +1」可以包在一个事务里：崩在中间只会回到旧版本，不会留下半迁移库。
 * 这条是 B4 选「主进程开库时迁移」的最大红利 —— 失败状态天然可判（旧版本＝可只读打开）。
 *
 * ## 为什么 `op_log` 现在就建（哪怕还不接生产写入）
 *
 * 它是**不可逆历史**：没人写过的历史补不回来。表在这里，`op_json` 的**内容形状**
 * （`index` 还是 `prev`）等同步层立项时拍板 —— 所以现在**只建表 + 一条幂等断言**，不接写入路径。
 *
 * ⚠️ 这个文件在主进程里跑：`node:sqlite` 是同步 API，一次批量导入会卡 UI（已知代价）。
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  DB_SCHEMA_VERSION,
  META_KEYS,
  judgeDbVersion,
  type DbVersionVerdict,
} from '../../src/core/library.ts'

export type Db = DatabaseSync

/** 一步迁移：把库从 `to - 1` 抬到 `to`。`up` 里只做 DDL／数据搬运，**不碰版本号**。 */
export interface Migration {
  to: number
  up: (db: Db) => void
}

/**
 * 迁移表。**现在是空的**：还没有任何一版 schema 需要抬。
 *
 * 加一步的判据：只有当**已经有人写过**的库需要换形状时才加。
 * 「blob → 规范化表」会是第一步。
 */
export const MIGRATIONS: Migration[] = []

export type OpenResult =
  /** 全新目录：建了表，版本号写当前 */
  | { status: 'created'; db: Db; version: number }
  /** 版本正好：直接开 */
  | { status: 'ok'; db: Db; version: number }
  /** 版本偏旧：迁移成功 */
  | { status: 'migrated'; db: Db; version: number }
  /** 版本偏新：**拒绝打开**，不交可写连接、不改它的版本号 */
  | { status: 'too-new'; version: number }
  /** 迁移失败：事务已回滚，主库仍是旧版本（调用方应只读打开并指向快照） */
  | { status: 'migrate-failed'; version: number; error: unknown }
  /** `user_version` 不是合法版本号（负数／小数） */
  | { status: 'corrupt'; version: number }

/**
 * Table set for now. The normalized schema (blocks/props/aliases/...) is the next step's job;
 * nothing here may grow into it, otherwise the next migration has to face two shapes
 * living in one database.
 */
const DDL = `
create table if not exists workspace (
  id integer primary key check (id = 1),
  json text not null,
  saved_at integer not null
);
create table if not exists settings (
  key text primary key,
  value text not null
);
create table if not exists meta (
  key text primary key,
  value text not null
);
-- Change stream. PK(device_id, seq) makes a resend idempotent by construction.
-- The edit path does not write here yet: whether op_json carries "index" or
-- "prev" is irreversible history and is still undecided, so writing now would weld
-- the ambiguity into the first rows.
create table if not exists op_log (
  device_id text not null,
  seq integer not null,
  at integer not null,
  op_json text not null,
  primary key (device_id, seq)
);
create index if not exists idx_op_log_at on op_log(at);
`

/** 读 `user_version`（唯一 schema 版本判据） */
export function readUserVersion(db: Db): number {
  const rows = db.prepare('pragma user_version').all() as { user_version: number }[]
  return rows[0]?.user_version ?? 0
}

function setUserVersion(db: Db, v: number): void {
  // PRAGMA 不吃参数绑定 ⇒ 只能是字面量。`v` 来自我们的常量或已校验的整数，不是外部字符串。
  db.exec(`pragma user_version = ${Math.trunc(v)}`)
}

/** 事务包一层：`fn` 抛错就整批回滚（含版本号，实测）。 */
function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec('begin immediate')
  try {
    const out = fn()
    db.exec('commit')
    return out
  } catch (e) {
    try {
      db.exec('rollback')
    } catch {
      /* 已经滚了（例如 SQLite 自己因错误回滚）：不掩盖原始错误 */
    }
    throw e
  }
}

/**
 * 打开一个库文件。
 *
 * 顺序是判据的一部分：**先读版本，再决定要不要建/迁**。
 * 建表与迁移都在事务里，所以「崩在中间」的落点是确定的（旧版本、旧数据）。
 */
export function openLibraryDb(
  file: string,
  opts: { migrations?: Migration[]; target?: number } = {},
): OpenResult {
  const target = opts.target ?? DB_SCHEMA_VERSION
  const migrations = opts.migrations ?? MIGRATIONS

  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  // WAL：单写者＋读不挡写。`busy_timeout` 给多进程（编辑器 + 自检脚本）留余量。
  db.exec('pragma journal_mode=wal')
  db.exec('pragma busy_timeout=5000')
  db.exec('pragma foreign_keys=on')

  const found = readUserVersion(db)
  const verdict: DbVersionVerdict = judgeDbVersion(found, target)

  if (verdict.status === 'too-new') {
    // **不许改它的版本号**：更新版会据此判「已经迁移过了」
    db.close()
    return { status: 'too-new', version: found }
  }
  if (verdict.status === 'corrupt') {
    db.close()
    return { status: 'corrupt', version: found }
  }

  if (verdict.status === 'fresh') {
    try {
      inTransaction(db, () => {
        db.exec(DDL)
        setUserVersion(db, target)
      })
    } catch (e) {
      db.close()
      return { status: 'migrate-failed', version: found, error: e }
    }
    return { status: 'created', db, version: target }
  }

  if (verdict.status === 'ok') return { status: 'ok', db, version: found }

  // 偏旧：按 `to` 升序跑（支持跨多版），每一步一个事务还是整段一个事务？
  // ⇒ **整段一个**：半迁移的库比慢一点严重得多，而 SQLite 的 DDL 事务是原子的。
  try {
    inTransaction(db, () => {
      const steps = migrations.filter((m) => m.to > found && m.to <= target).sort((a, b) => a.to - b.to)
      for (const step of steps) step.up(db)
      // 版本号**在同一个事务里**抬到最后：崩在中间只会回到 found
      setUserVersion(db, target)
    })
  } catch (e) {
    db.close()
    return { status: 'migrate-failed', version: found, error: e }
  }
  return { status: 'migrated', db, version: target }
}

/* ------------------------------------------------------------ workspace blob */

export function readWorkspaceBlob(db: Db): { json: string; savedAt: number } | undefined {
  const rows = db.prepare('select json, saved_at from workspace where id = 1').all() as { json: string; saved_at: number }[]
  const row = rows[0]
  return row ? { json: row.json, savedAt: row.saved_at } : undefined
}

export function writeWorkspaceBlob(db: Db, json: string, savedAt: number): void {
  db.prepare(
    'insert into workspace (id, json, saved_at) values (1, ?, ?) on conflict(id) do update set json = excluded.json, saved_at = excluded.saved_at',
  ).run(json, savedAt)
}

/* ------------------------------------------------------------ settings / meta */

export function readSetting(db: Db, key: string): string | undefined {
  const rows = db.prepare('select value from settings where key = ?').all(key) as { value: string }[]
  return rows[0]?.value
}

export function writeSetting(db: Db, key: string, value: string): void {
  db.prepare(
    'insert into settings (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, value)
}

export function readMeta(db: Db, key: string): string | undefined {
  const rows = db.prepare('select value from meta where key = ?').all(key) as { value: string }[]
  return rows[0]?.value
}

export function writeMeta(db: Db, key: string, value: string): void {
  db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(
    key,
    value,
  )
}

/* ------------------------------------------------------------ op_log（A4） */

export interface OpRow {
  deviceId: string
  seq: number
  at: number
  opJson: string
}

/** 读这台设备在这个库上的序号水位（`meta.seq`） */
export function readSeq(db: Db): number {
  const raw = readMeta(db, META_KEYS.seq)
  const n = raw === undefined ? 0 : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * 追加一批 op，**并把水位推进**——同一个事务。
 *
 * 为什么必须同一事务：分开写会在崩溃时重号（幂等失效）或跳号（对端水位出现空洞）。
 * `startSeq` 缺省从当前水位接着走；撞主键（重发）时整批不落、水位不动。
 *
 * @returns 真正写进去的行数（重发 ⇒ 0）
 */
export function appendLocalOps(
  db: Db,
  deviceId: string,
  ops: { at: number; opJson: string }[],
  opts: { startSeq?: number } = {},
): number {
  if (ops.length === 0) return 0
  let written = 0
  inTransaction(db, () => {
    let seq = opts.startSeq ?? readSeq(db)
    for (const op of ops) {
      seq += 1
      // `insert or ignore`：同 (device_id, seq) 已存在 ＝ 这次是重发，跳过而不是炸掉整批
      const r = db
        .prepare('insert or ignore into op_log (device_id, seq, at, op_json) values (?, ?, ?, ?)')
        .run(deviceId, seq, op.at, op.opJson)
      if (Number(r.changes) > 0) written++
    }
    // 水位**只在真写了之后**推进（重发时 `seq` 的增量是白算的，不推进就对了）
    if (written > 0) writeMeta(db, META_KEYS.seq, String(readSeq(db) + written))
  })
  return written
}

/** 单条追加（幂等断言用；生产路径走 `appendLocalOps`） */
export function appendOp(db: Db, row: OpRow): void {
  db.prepare('insert or ignore into op_log (device_id, seq, at, op_json) values (?, ?, ?, ?)').run(
    row.deviceId,
    row.seq,
    row.at,
    row.opJson,
  )
}
