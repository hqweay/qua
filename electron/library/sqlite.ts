/**
 * `qua.db` 的 SQLite 适配器 —— **主进程唯一的 SQL 落点**。
 *
 * ## 这个文件负责什么、不负责什么
 *
 * | 这里 | 别处 |
 * |---|---|
 * | 建表、迁移、`user_version`、`wal_checkpoint` | 「一个块长成哪几行」→ `src/core/storage/db-rows.ts` |
 * | **通用**行写入（`applyRowWrites`／`replaceContentRows`） | 什么时候写、写哪一批 → 渲染层的 `StoragePort` |
 * | `settings`／`meta`／`op_log` 的读写 | 块语义、查询、渲染（主进程一律不许） |
 *
 * 判据：主进程只认**表名与列名**，不认「块」。渲染层送来的是一批行写入，
 * 这里校验表名/列名白名单后拼 SQL —— 这样「块长什么样」只有一份定义，
 * 而主进程仍然拿不到任何块语义（`arch-check [2+]` 的白名单也照旧成立）。
 *
 * ## 为什么建表与迁移都是「一个事务包住版本号」
 *
 * 实测（Node 26 / SQLite 3.53）：`PRAGMA user_version` **随事务原子回滚**。
 * ⇒ 「建表/改表 ＋ 版本号 +1」可以包在一个事务里：崩在中间只会回到旧版本，不会留下半迁移库。
 * 这条是「主进程开库时迁移」这条选法的最大红利 —— 失败状态天然可判（旧版本＝可只读打开）。
 *
 * ## `op_log` 为什么先建表、后来才接写入
 *
 * 它是**不可逆历史**：没人写过的历史补不回来。所以第一版只建表、只钉幂等断言，
 * 等「所有让库变化的路径都产 op」成立之后才接 —— 否则 append-only 日志里的空洞
 * 与「那段时间什么都没发生」无法区分（**半截历史比没有历史更糟**）。
 *
 * 现在它接了：撤销改走 `diff`、冷启动物化走事务、换库天然跨库不混流 ⇒ 三个缺口都销了。
 * 写入与内容行**同一个事务**（`applyRowWrites`），整份替换那几笔不产 op。
 *
 * ⚠️ 这个文件在主进程里跑：`node:sqlite` 是同步 API，一次批量导入会卡 UI（已知代价）。
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  DB_CONTENT_TABLES,
  DB_SCHEMA_VERSION,
  DB_TABLES,
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
 * 内容表的 DDL —— **v2 起的形状**：块拆成行，写成本只与「这次动过几块」有关。
 *
 * 列的分工与「为什么这么分」在 `src/core/storage/db-rows.ts`（编码层）；这里只有 SQL。
 *
 * 三条口径：
 *   · **`parent`／`left` 不设外键**：写入顺序按 op 流来，子块可能先于父块落行
 *     （`insert` 一棵子树时 op 是逐块报的）。设了外键就会把「顺序」变成一个必须满足的前提，
 *     而那个前提在并发/重放里不成立 —— 真出现悬空指针时，读路径按「当顶层」兜底，不报错也不丢块。
 *   · **子表也不设外键**：删一块时由写入端显式删它的属性/地址/露面行（`db-rows.ts` 的
 *     `blockWrites`），比 `on delete cascade` 更容易在测试里数清楚「这次写了几行」。
 *   · **`pos` 进主键**：属性与地址都是有序的，`pos` 是顺序本身；不放进主键就只能靠 `rowid`，
 *     而 `rowid` 的顺序不是语义。
 */
const CONTENT_DDL = `
create table if not exists ${DB_TABLES.block} (
  id text primary key,
  content text not null,
  annos text,
  parent text,
  left text,
  created integer not null,
  modified integer not null,
  deleted integer,
  display text,
  kind text,
  date text,
  query text,
  type text
);
create index if not exists idx_Block_parent_left on ${DB_TABLES.block}(parent, left);
create index if not exists idx_Block_date on ${DB_TABLES.block}(date);
create index if not exists idx_Block_deleted on ${DB_TABLES.block}(deleted) where deleted is not null;

create table if not exists ${DB_TABLES.property} (
  block text not null,
  name text not null,
  pos integer not null,
  multi integer not null default 0,
  value text,
  primary key (block, name, pos)
);

create table if not exists ${DB_TABLES.alias} (
  name text primary key,
  block text not null,
  pos integer not null
);
create index if not exists idx_BlockAlias_block on ${DB_TABLES.alias}(block);

create table if not exists ${DB_TABLES.list} (
  block text not null,
  list text not null,
  primary key (block, list)
);
create index if not exists idx_BlockList_list on ${DB_TABLES.list}(list);
`

/**
 * 库级表（`settings`／`meta`／`op_log`）—— 与内容表分开：它们**换库不换形状**，
 * 从 v1 起就在这里（`workspace` 那张临时表才是 v1 的产物）。
 */
const BASE_DDL = `
create table if not exists ${DB_TABLES.settings} (
  key text primary key,
  value text not null
);
create table if not exists ${DB_TABLES.meta} (
  key text primary key,
  value text not null
);
-- Change stream (append-only history). PK(device_id, seq) makes a resend idempotent
-- by construction: the same (device, seq) can only ever be one row.
-- Written in the SAME transaction as the content rows (see applyRowWrites): a batch
-- is one user action, so a half-batch would leave the log claiming something the
-- tables do not show. Full replacements (seed / switching libraries) do not write
-- here — they say "the library is now this", not "someone did something".
create table if not exists ${DB_TABLES.opLog} (
  device_id text not null,
  seq integer not null,
  at integer not null,
  op_json text not null,
  primary key (device_id, seq)
);
create index if not exists idx_op_log_at on ${DB_TABLES.opLog}(at);
-- Asset metadata: one row per blob. The bytes live in the library's assets/ dir
-- (a library must stay copyable as a directory; hundreds of MB of binaries in one
-- SQLite file turn every sync into a whole-file conflict). Keeping bytes out of here
-- also gives us: files only ever grow, rows are written after the file lands, so
-- "every row has a file" always holds -- a DB rollback only ever leaves orphans,
-- never a broken reference.
create table if not exists ${DB_TABLES.assets} (
  hash text primary key,
  mime text not null,
  size integer not null,
  w integer,
  h integer,
  added_at integer not null
);
`

/**
 * 新建库的建表脚本。
 *
 * ⚠️ **不含 v1 的 `workspace` 表**：那是「一整份库 JSON 塞一行」的过渡形状。
 * 新建的库直接是 v2 —— 一个库里只有一种形状，迁移路径才不必同时应付两种。
 */
const DDL = `${BASE_DDL}${CONTENT_DDL}`

/**
 * 迁移表。
 *
 * **v1 → v2：丢掉整份 blob，建内容表**。这不是「旧数据迁移」，是**作废旧形状**：
 * 原型不做映射/兼容分支（`WORKSPACE_VERSION` 那套「升一版即作废重 seed」的纪律同样适用），
 * 但**也不许把用户的库变成打不开**——库的身份（`library.json`／`meta.library_id`）留着，
 * 只把内容清空，渲染层读到 `empty` 就重新 seed。
 *
 * ⇒ 用户看到的是「这个库重新变成空的」，而不是「这个库打不开了」。
 */
export const MIGRATIONS: Migration[] = [
  {
    to: 2,
    up: (db) => {
      db.exec(`drop table if exists workspace`)
      db.exec(CONTENT_DDL)
    },
  },
  {
    to: 3,
    up: (db) => {
      /**
       * **日志即状态**：旧 `op_log` 里的 op 不完整（新块的正文/属性/出生时刻
       * 从来没写进去、`block.delete` 一个词两个意思）⇒ 那份历史不可重放。
       * 按原型纪律：丢掉旧内容与旧日志，渲染层重新 seed；不写搬数据的迁移。
       */
      for (const t of DB_CONTENT_TABLES) db.exec(`drop table if exists ${t}`)
      db.exec(`drop table if exists ${DB_TABLES.opLog}`)
      db.exec(DDL)
      db.prepare(`delete from ${DB_TABLES.meta} where key = ?`).run(META_KEYS.seq)
    },
  },
  {
    to: 4,
    up: (db) => {
      /**
       * **资产元信息回到家（库）里**：只建表，不动内容。
       *
       * 旧形状把 `{mime,size,w,h}` 写在每份字节旁边的 `.json` 侧车里 —— 那是第二个
       * store，与正文没有事务关系。新形状一行一份字节，正文（同在这个库里）才是它的读者。
       *
       * 为什么这一步**不**像 v2/v3 那样丢内容：内容形状没变（`AssetRun` 的地址仍然是
       * hash），变的只是元信息住哪。旧资产由 `reindex()` 从目录重建行
       * （`electron/library/assets.ts`）—— 那正是「导入／修复」那条通用入口，
       * 顺手把它真跑一遍，等于免费验收。
       */
      db.exec(BASE_DDL)
    },
  },
  {
    to: 5,
    up: (db) => {
      /**
       * **查询条件换了形状**：`{todo}` 原子退场，三态改由属性条件表达
       * （`{prop:{id, eq:false|true}}` / `{exists:false}`）。
       *
       * 条件住在块的 `_query` 里，是**内容**，不是一张能单独改的表 ⇒ 旧条件读不出来时
       * 只会静默不命中（看起来像「这次真的没有结果」）。所以按原型纪律丢掉内容重 seed，
       * 不写「把 `{todo}` 翻译成 `{prop}`」的迁移分支。
       */
      for (const t of DB_CONTENT_TABLES) db.exec(`drop table if exists ${t}`)
      db.exec(`drop table if exists ${DB_TABLES.opLog}`)
      db.exec(DDL)
      db.prepare(`delete from ${DB_TABLES.meta} where key = ?`).run(META_KEYS.seq)
    },
  },
]

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
      /**
       * **每一步都得在**：缺一步就说明这个库是从一个我们没有迁移路径的版本升上来的。
       * 不报错而直接跳过，结果是「版本号升了、表没建」——一个看起来能打开、
       * 但每次读写都撞 `no such table` 的库。宁可在这里判失败（调用方据此提示重建）。
       */
      for (let to = found + 1; to <= target; to++) {
        const step = steps.find((m) => m.to === to)
        if (!step) throw new Error(`no migration step to schema v${to} (found v${found}, target v${target})`)
        step.up(db)
      }
      // 版本号**在同一个事务里**抬到最后：崩在中间只会回到 found
      setUserVersion(db, target)
    })
  } catch (e) {
    db.close()
    return { status: 'migrate-failed', version: found, error: e }
  }
  return { status: 'migrated', db, version: target }
}

/* ------------------------------------------------------------ 内容行（v2） */

/**
 * 读**整份内容行**：四张表各 `select *`。
 *
 * 为什么整份读：运行模型是「整片森林在内存」（阶段 1），装载必须一次拿全；
 * 而**写**是增量的（见 `applyRowWrites`）——读全、写增量，是本层的全部取舍。
 * 编码（行 → 块）归渲染层：主进程不认识块语义（白名单只放 `core/library.ts` 与纯类型）。
 */
export function readContentRows(db: Db): {
  blocks: Record<string, unknown>[]
  props: Record<string, unknown>[]
  aliases: Record<string, unknown>[]
  lists: Record<string, unknown>[]
  meta: Record<string, string>
} {
  const rows = (table: string): Record<string, unknown>[] =>
    db.prepare(`select * from ${table}`).all() as Record<string, unknown>[]
  const meta: Record<string, string> = {}
  for (const r of rows(DB_TABLES.meta) as { key: string; value: string }[]) meta[r.key] = r.value
  return {
    blocks: rows(DB_TABLES.block),
    props: rows(DB_TABLES.property),
    aliases: rows(DB_TABLES.alias),
    lists: rows(DB_TABLES.list),
    meta,
  }
}

/**
 * 一条行写入。形状与 `core/storage/db-rows.ts` 的 `RowWrite` 同构（主进程只认形状，不认语义）。
 *
 * 三种操作，`update` 与 `upsert` 的区别是**语义**不是风格：
 *   · `upsert` —— 这一行可能还不存在（新块、新属性），缺的列必须有默认值或由调用方给全；
 *   · `update` —— 这一行**必须已经存在**（改一个已存在块的正文／一格属性）。
 *     为什么需要它：`insert … on conflict do update` 在 SQLite 里会**先校验 NOT NULL**
 *     （实测：对已存在的行做部分列的 upsert 也会撞 `NOT NULL constraint failed`），
 *     所以「只改一列」不能走 upsert。走 update 的好处是它**匹配不到行就报错**——
 *     「改一个盘上没有的块」是 bug，不该静默变成「插入一行只有这一列的块」。
 *   · `delete` —— 只给一部分主键 ＝ 删这一组的全部行。
 */
export interface RowWrite {
  table: 'Block' | 'BlockProperty' | 'BlockAlias' | 'BlockList' | 'meta'
  /**
   * `relink` ＝ **兄弟链维护**：`Block.left` 是「前一个兄弟」的 id，所以一个块换位置时
   * 有两个邻居要跟着改（旧位置的后继、新位置的后继），光写自己那一格会让链断掉 ——
   * 断链不会报错，只会在下次装载时把顺序排错。
   * 这两条改法只依赖 `left`／`parent` 两列，不需要块语义，所以留在主进程。
   */
  op: 'upsert' | 'update' | 'delete' | 'relink'
  key: Record<string, string | number | null>
  values?: Record<string, string | number | null>
}

/** 主进程只允许写这几张表（渲染层送来的表名是**数据**，不能拿它拼任意 SQL） */
const WRITABLE = new Set<string>(['Block', 'BlockProperty', 'BlockAlias', 'BlockList', 'meta'])

/**
 * 列名白名单：只允许出现 DDL 里真实存在的列。
 *
 * 为什么要它：表名／列名会被拼进 SQL（SQLite 不吃参数绑定），而它们来自渲染层。
 * 不校验就等于把「拼 SQL」的入口交给了对面；校验之后最坏情况只是「写错一格」。
 */
const COLUMNS: Record<string, ReadonlySet<string>> = {
  Block: new Set(['id', 'content', 'annos', 'parent', 'left', 'created', 'modified', 'deleted', 'display', 'kind', 'date', 'query', 'type']),
  BlockProperty: new Set(['block', 'name', 'pos', 'multi', 'value']),
  BlockAlias: new Set(['block', 'pos', 'name']),
  BlockList: new Set(['block', 'list']),
  meta: new Set(['key', 'value']),
}

function sqlOf(w: RowWrite): string {
  if (!WRITABLE.has(w.table)) throw new Error(`row write: unknown table "${w.table}"`)
  const allowed = COLUMNS[w.table]!
  const keys = Object.keys(w.key)
  const vals = Object.keys(w.values ?? {})
  for (const c of [...keys, ...vals]) if (!allowed.has(c)) throw new Error(`row write: unknown column "${w.table}.${c}"`)
  if (keys.length === 0) throw new Error('row write: empty key')
  const where = keys.map((c) => `${c} = ?`).join(' and ')
  if (w.op === 'delete') {
    // 只给一部分主键 ＝ 删这块的全部行（`{block}`），给全 ＝ 删那一行
    return `delete from ${w.table} where ${where}`
  }
  if (w.op === 'update') {
    if (vals.length === 0) throw new Error(`row write: update ${w.table} with no values`)
    return `update ${w.table} set ${vals.map((c) => `${c} = ?`).join(', ')} where ${where}`
  }
  if (w.op === 'relink') {
    /**
     * 兄弟链的两条维护语句（见 `RowWrite.op` 的说明）：
     *   ① 旧位置的后继（`left` 指着我）改指我的旧前驱 —— 我的旧前驱从**库里现读**，
     *      因为模型里已经没有旧位置那份兄弟列表了；
     *   ② 新位置的后继（`parent`／`left` 等于我的新落点）改指我。
     *
     * 顺序不能换：① 读的是**改之前**那一行的 `left`，先写我自己那一格就把它冲掉了。
     * 两条都带 `id <> ?`：我自己也在「left 指着我」的集合里（挪到首位时），不能把自己改坏。
     */
    return relinkSql(w.table)[0]
  }
  const cols = [...new Set([...keys, ...vals])]
  const set = cols.filter((c) => !keys.includes(c))
  const insert = `insert into ${w.table} (${cols.join(', ')}) values (${cols.map(() => '?').join(', ')})`
  const conflict = `on conflict(${keys.join(', ')}) do update set ${set.map((c) => `${c} = excluded.${c}`).join(', ')}`
  return set.length === 0 ? `${insert} on conflict(${keys.join(', ')}) do nothing` : `${insert} ${conflict}`
}

/**
 * 参数顺序必须与 `sqlOf` 拼出来的占位符顺序**逐字对齐**：
 * `update` 是 `set` 在前、`where` 在后；其余是 `where`／`values` 按列名合并的顺序。
 */
/**
 * 兄弟链的两条维护语句（`relink` 用；参数顺序与调用处逐字对齐）。
 *
 * 为什么这两条留在主进程而不是编码层：它们只依赖 `left`／`parent` 两列与 id，
 * **不认识块**。放进编码层反而要把「怎么写 SQL」搬到渲染层去。
 */
function relinkSql(table: string): [string, string] {
  return [
    `update ${table} set left = (select left from ${table} where id = ?) where left = ? and id <> ?`,
    `update ${table} set left = ? where parent is ? and left is ? and id <> ?`,
  ]
}

function argsOf(w: RowWrite): (string | number | null)[] {
  if (w.op === 'update') {
    const vals = Object.keys(w.values ?? {}).map((c) => w.values![c] ?? null)
    return [...vals, ...Object.keys(w.key).map((c) => w.key[c]!)]
  }
  const cols = [...new Set([...Object.keys(w.key), ...Object.keys(w.values ?? {})])]
  return cols.map((c) => (c in w.key ? w.key[c]! : (w.values?.[c] ?? null)))
}

/**
 * 落一行；`update` 匹配不到行 ⇒ **抛错**。
 *
 * 为什么这里必须抛：`update` 的语义是「改一个已经存在的块」。匹配不到就说明
 * 盘上少了一行而模型里还有它 —— 静默忽略会让「这次改动没落盘」变成一个不报错的洞，
 * 要等到重开之后才发现字没了。
 */
function runWrite(db: Db, w: RowWrite): number {
  /**
   * `relink` 是两条语句 ⇒ 分开执行（`prepare().run()` 一次只吃一条）。
   * 用 `exec` 会丢掉参数绑定，所以这里按 `;` 切开、各自 `run`。
   */
  if (w.op === 'relink') {
    const id = w.key.id as string
    const parent = (w.values?.parent ?? null) as string | null
    const left = (w.values?.left ?? null) as string | null
    const [fixOld, fixNew] = relinkSql(w.table)
    let n = Number(db.prepare(fixOld).run(id, id, id).changes)
    n += Number(db.prepare(fixNew).run(id, parent, left, id).changes)
    return n
  }
  const r = db.prepare(sqlOf(w)).run(...argsOf(w))
  const n = Number(r.changes)
  if (w.op === 'update' && n === 0) {
    throw new Error(`row write: update matched no row in ${w.table} (${JSON.stringify(w.key)})`)
  }
  return n
}

/**
 * 落一批行写入 —— **一个事务**。
 *
 * 为什么必须整批一个事务：一批 op 是一次用户动作；半批落盘＝模型改了、盘上只有一半，
 * 而读回来那份会是一棵缺了父块或顺序错乱的树（不报错）。
 *
 * @returns 真正改到的行数（诊断面与成本断言用它数「打一个字写了几行」）
 */
export function applyRowWrites(
  db: Db,
  writes: readonly RowWrite[],
  opts: { deviceId?: string; oplog?: readonly { at: number; opJson: string }[] } = {},
): number {
  if (writes.length === 0) return 0
  let changed = 0
  inTransaction(db, () => {
    for (const w of writes) changed += runWrite(db, w)
    /**
     * **变更流与行写入同一个事务**：分开写会在崩溃时重号（幂等失效）或跳号
     * （对端水位出现空洞）。`appendLocalOps` 自己**不开**事务（它假定已在事务里），
     * 所以这里不能把两层事务套起来。
     */
    const oplog = opts.oplog ?? []
    if (oplog.length > 0 && opts.deviceId) appendLocalOpsInner(db, opts.deviceId, oplog)
  })
  return changed
}

/**
 * **整份替换**：清空四张内容表再写进去（种子、换库）。
 *
 * 与 `applyRowWrites` 分开是因为「清空」这件事只该发生在这几个入口：
 * 常规编辑走增量，谁都不许顺手清表（那是一次数据事故，而且看起来只是「慢了一点」）。
 *
 * ⚠️ **替换 ＝ 新 genesis**：同一个事务里也清掉 `op_log`、把 `meta.seq` 归零，
 * 再把这一批 op 写进去。日志永远不混两段历史 —— 否则重放会把「换库前」与
 * 「换库后」的两份事实拼成一份不存在的库。
 */
export function replaceContentRows(
  db: Db,
  writes: readonly RowWrite[],
  opts: { deviceId?: string; oplog?: readonly { at: number; opJson: string }[] } = {},
): number {
  let changed = 0
  inTransaction(db, () => {
    for (const t of DB_CONTENT_TABLES) changed += Number(db.prepare(`delete from ${t}`).run().changes)
    changed += applyRowWritesInner(db, writes)
    db.prepare(`delete from ${DB_TABLES.opLog}`).run()
    db.prepare(`delete from ${DB_TABLES.meta} where key = ?`).run(META_KEYS.seq)
    const oplog = opts.oplog ?? []
    if (oplog.length > 0 && opts.deviceId) appendLocalOpsInner(db, opts.deviceId, oplog)
  })
  return changed
}

/** 事务内的行写入（`replaceContentRows` 用；不再开一层事务） */
function applyRowWritesInner(db: Db, writes: readonly RowWrite[]): number {
  let changed = 0
  for (const w of writes) changed += runWrite(db, w)
  return changed
}

/** 内容是不是空的（新建的库／被迁移作废的库 ⇒ 渲染层据此 seed） */
export function hasContent(db: Db): boolean {
  const r = db.prepare(`select exists(select 1 from ${DB_TABLES.block}) as n`).all() as { n: number }[]
  return (r[0]?.n ?? 0) === 1
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
    written = appendLocalOpsInner(db, deviceId, ops, opts)
  })
  return written
}

/**
 * **事务内**追加一批 op 并推进水位（调用方负责已在事务里）。
 *
 * 为什么单拆出来：生产路径是「行写入 ＋ 变更流**同一个事务**」（`applyRowWrites`），
 * 而 `appendLocalOps` 自己会开事务 —— 套起来就是嵌套事务（`begin` 会报错）。
 * 两条路共用这一份写入逻辑，水位口径只有一处。
 */
function appendLocalOpsInner(
  db: Db,
  deviceId: string,
  ops: readonly { at: number; opJson: string }[],
  opts: { startSeq?: number } = {},
): number {
  let written = 0
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
