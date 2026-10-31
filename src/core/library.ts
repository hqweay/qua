/**
 * 库的身份与注册表 —— **纯函数层**（零 DOM、零 Node、零存储）。
 *
 * 为什么单独一份而不是塞进 `storage/`：这一层要同时被**两个进程**读
 *   · 主进程：读/写 `app.json`、判 `library.json`、开库前算版本；
 *   · 渲染层：显示库名、判「这一屏是不是一个库」。
 * 放进 `storage/` 就等于主进程要 import 一个带存储实现的文件；放在 `core/` 顶层且**零依赖**，
 * 主进程才能只拿类型与判据（见 arch 断言的主进程准入白名单）。
 *
 * 三条形状口径：
 *   ① **库 id 是目录名**：32 位小写 hex，形状坏掉＝库打不开，所以生成端必须有单测；
 *   ② `library.json.id` 是**权威**，目录名只是默认值；三者不一致时不许静默择一；
 *   ③ 库的 schema 版本**只有一个判据**（`PRAGMA user_version`），偏大拒绝、偏小迁移。
 */

/* ------------------------------------------------------------ 形状常量（改一个＝旧库打不开） */

/** 库目录里内容真相的文件名。**不许改**：改了就是「所有已有库都找不到自己的数据」。 */
export const DB_FILE = 'qua.db'
/** 库目录的身份标记。它的职责只是「这目录像不像一个库」，不判数据能不能读。 */
export const MANIFEST_FILE = 'library.json'
/** 资产字节的目录（内容寻址：`<hash 前 2 位>/<hash>.<ext>`；元信息在 `qua.db` 的 `assets` 表）。 */
export const ASSETS_DIR = 'assets'
/** 迁移前快照。放在库目录里，因为「拷贝目录＝完整备份」要求它跟着走。 */
export const BACKUPS_DIR = 'backups'

/** `library.json.kind` 的固定值。别人的目录绝不能往里撒 `qua.db`。 */
export const LIBRARY_KIND = 'qua-library'
/** `library.json.format` 的当前值。它偏大＝这个库比我们新。 */
export const LIBRARY_FORMAT = 1

/**
 * `qua.db` 的 schema 版本（`PRAGMA user_version`）。
 *
 * 这是**库的唯一 schema 版本**。`library.json.format` 判「是不是库」、
 * `app.json.version` 判「注册表怎么读」、`WORKSPACE_VERSION` 是当前过渡期的载荷版本 ——
 * 三者都不判「这份数据能不能读」，只有这一格判。
 *
 * 为什么是 4：v1 是过渡形状——`workspace` 表里一整份库 JSON，每次编辑整份覆盖写
 * （写成本随库体量线性增长）。v2 把块拆成 `Block`／`BlockProperty`／`BlockAlias`／`BlockList`
 * 四张表，一次编辑只写它动过的那几块的行。v3 是**日志即状态**：`op_log` 的 op 形状改成
 * 完整、可重放的格写入（`block.exist` 三态、genesis 带 `created`/内容），
 * 旧的 op 历史按「升版作废」的纪律丢掉。v4 让**资产元信息回到库里**
 * （`assets` 表；`assets/` 目录只留字节），并且启动不再扫目录 —— 那一步的重建
 * 是一次性的 `reindex()`。
 * v5 是**查询条件**的形状变了：`{todo}` 原子退场（三态改由属性条件表达），
 * 库里存的 `_query` 带着它就读不出来了。条件住在内容里 ⇒ 只能连内容一起作废重 seed。
 *
 * **不写数据迁移**：原型不做旧数据迁移，旧库作废重 seed（`judgeDbVersion` 判到
 * `migrate` 时跑 `MIGRATIONS` 里那一步**只丢旧形状、不搬数据**的 DDL）。
 * `user_version` 只增不减。
 */
export const DB_SCHEMA_VERSION = 5

/** `meta` 表里被代码解释的键（其余键归将来，不在这里登记）。 */
export const META_KEYS = {
  /** 库的身份：必须与 `library.json.id` 一致（不一致＝这个目录是副本） */
  libraryId: 'library_id',
  /** 显示名。改名不改目录。 */
  name: 'name',
  /** 这台设备在这个库上的写序号水位（与 `op_log` 同一事务推进） */
  seq: 'seq',
  /** 中心槽持有的「当前对象」（块 id）。它属于内容：换台机器接着看同一处 */
  activeId: 'active_id',
  /** 上一次落盘时刻（墙钟毫秒）。只给人看（诊断面／「改到哪了」） */
  savedAt: 'saved_at',
} as const

/**
 * 内容表的**名字**（主进程建表与通用 SQL 用；编码语义在 `core/storage/db-rows.ts`）。
 *
 * 为什么表名住这里：主进程要建表、要按表名拼 SQL，而它**不许 import 块语义**
 * （白名单只放零依赖的 `core/library.ts` 与纯类型的 core）。表名是「库的形状」，
 * 与 `DB_FILE`／`MANIFEST_FILE` 同一类事实，所以和它们放一处。
 */
export const DB_TABLES = {
  /** 块：一行一块（`content`／`annos` ＋ 落库编码的 `parent`／`left`） */
  block: 'Block',
  /** 属性：一格一行（有序字符串列表拆成多行 ＋ `pos`） */
  property: 'BlockProperty',
  /** 地址：一块 0..N 行，`pos` 有序，首个是主名 */
  alias: 'BlockAlias',
  /** 露面：一块 0..N 行（page／tag），PK 保证不重复 */
  list: 'BlockList',
  /** 库级两格（`active_id`／`saved_at`）＋ 身份与序号水位 */
  meta: 'meta',
  /** 每库设置（窗口 bounds／槽布局／折叠态这类视图状态） */
  settings: 'settings',
  /** 变更流（`PK(device_id, seq)` 让重发天然幂等） */
  opLog: 'op_log',
  /**
   * 资产元信息：一行一份字节（`hash` 是主键，也是正文里引用的地址）。
   *
   * 为什么是**库级**表（不放内容表那一组）：内容表在「换库／重 seed」时整份清掉，
   * 而资产行描述的是**盘上的字节**，不该被一次内容替换连坐。
   */
  assets: 'assets',
} as const

/** 内容表（**装载时整份读、换库时整份清**的那四张） */
export const DB_CONTENT_TABLES = [DB_TABLES.block, DB_TABLES.property, DB_TABLES.alias, DB_TABLES.list] as const

/* ------------------------------------------------------------ id */

const HEX32 = /^[0-9a-f]{32}$/

/** 48 位时间戳只能**取模**，不能用位与：掩码会被 ToInt32 收成 `-1`（见 `ids.ts` 的同一条教训） */
const TS_MOD = 0x1000000000000

function hex32(now: number, version: number, seq: number): string {
  const ts = Math.floor(now) % TS_MOD
  const rnd = new Uint8Array(8)
  for (let i = 0; i < 8; i++) rnd[i] = Math.floor(Math.random() * 256)
  const pad = (n: number, w: number): string => n.toString(16).padStart(w, '0')
  return (
    pad(ts, 12) +
    pad((version << 12) | seq, 4) +
    pad(0x8000 | (((rnd[0]! << 8) | rnd[1]!) & 0x3fff), 4) +
    Array.from(rnd.slice(2), (b) => pad(b, 2)).join('')
  )
}

let librarySeq = 0
let deviceSeq = 0

/**
 * 一个新的库 id。
 *
 * 为什么**不复用** `uuidv7Hex`：块 id 的判据会跟着块 id 的演化走（118 就是一次演化），
 * 而库 id 是**目录名** —— 它的判据一旦跟着块 id 变，用户库就会在某次重构后「路径失效」。
 * 两个判据同形但**分开**，各自有单测。
 *
 * 同一毫秒连续调用靠 `seq` 区分：目录同名就是两个库撞一个目录。
 */
export function libraryId(now: number = Date.now()): string {
  librarySeq = (librarySeq + 1) & 0x0fff
  return hex32(now, 7, librarySeq)
}

/** 一个设备 id。与库 id 同形、**独立判据**（理由同上：它落 `app.json`，与库目录无关）。 */
export function deviceId(now: number = Date.now()): string {
  deviceSeq = (deviceSeq + 1) & 0x0fff
  return hex32(now, 7, deviceSeq)
}

export function isLibraryId(v: unknown): v is string {
  return typeof v === 'string' && HEX32.test(v)
}

export function isDeviceId(v: unknown): v is string {
  return typeof v === 'string' && HEX32.test(v)
}

/* ------------------------------------------------------------ library.json */

export interface LibraryManifest {
  kind: typeof LIBRARY_KIND
  format: number
  id: string
}

export type ManifestResult =
  | { status: 'ok'; manifest: LibraryManifest }
  /** 这个目录里没有 `library.json` ＝ 它不是 Qua 库（不许往里撒 `qua.db`） */
  | { status: 'missing' }
  /** 有文件但读不懂：别人的 `kind`、偏大的 `format`、坏掉的 `id` */
  | { status: 'corrupt'; reason: 'parse' | 'kind' | 'format' | 'id' }

export function parseManifest(raw: string | null): ManifestResult {
  if (raw === null) return { status: 'missing' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'corrupt', reason: 'parse' }
  }
  if (!value || typeof value !== 'object') return { status: 'corrupt', reason: 'parse' }
  const m = value as Partial<LibraryManifest>
  if (m.kind !== LIBRARY_KIND) return { status: 'corrupt', reason: 'kind' }
  if (typeof m.format !== 'number' || !Number.isInteger(m.format) || m.format < 1) {
    return { status: 'corrupt', reason: 'format' }
  }
  if (m.format > LIBRARY_FORMAT) return { status: 'corrupt', reason: 'format' }
  if (!isLibraryId(m.id)) return { status: 'corrupt', reason: 'id' }
  return { status: 'ok', manifest: { kind: LIBRARY_KIND, format: m.format, id: m.id } }
}

export function serializeManifest(id: string): string {
  const manifest: LibraryManifest = { kind: LIBRARY_KIND, format: LIBRARY_FORMAT, id }
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/* ------------------------------------------------------------ app.json 注册表 */

/** 一条库记录。`path` 缺省 ＝ 默认库（住在 `repos/<id>`）；有 `path` ＝ 用户选的外部目录。 */
export interface LibraryEntry {
  id: string
  name: string
  /** 外部库的绝对路径。默认库不写这一格（相对 `repos/<id>`，库根搬走也跟着走） */
  path?: string
  lastOpenedAt?: number
}

export interface AppRegistry {
  /** 注册表自己的格式版本（与库的 schema 版本是两件事） */
  version: 1
  /**
   * 设备身份。**每设备一个、住库外**：库可以拷给别人，机器不会。
   * 它一旦变了，这台机器在 `op_log` 里的历史就断成两条设备线。
   */
  deviceId: string
  libraries: LibraryEntry[]
  lastOpenedId?: string
}

export const REGISTRY_VERSION = 1

export type RegistryResult =
  | { status: 'empty' }
  | {
      status: 'ok'
      registry: AppRegistry
      /** 这次生成过 `device_id`（调用方必须写回，否则下次启动又生成一个） */
      generatedDeviceId: boolean
      /** 被摘掉的坏条目数。**必须报出来**：不报就是「用户的库静默消失」 */
      dropped: number
    }
  | { status: 'corrupt'; reason: 'parse' | 'version' | 'device' | 'libraries' }

/**
 * 读注册表。
 *
 * 三条口径：
 *   · `null` ⇒ `empty`（从没写过，不是坏）；
 *   · `device_id` **只在缺失时生成**，坏值直接判 corrupt —— 猜一个会让历史断线；
 *   · 坏条目摘掉但**报数**，同 id 只留第一条（一个 id 只能对应一个会话）。
 */
export function parseRegistry(raw: string | null): RegistryResult {
  if (raw === null) return { status: 'empty' }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return { status: 'corrupt', reason: 'parse' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'corrupt', reason: 'parse' }
  const r = value as Partial<AppRegistry> & { version?: unknown }
  if (r.version !== undefined && r.version !== REGISTRY_VERSION) return { status: 'corrupt', reason: 'version' }

  let generatedDeviceId = false
  let dev = r.deviceId
  if (dev === undefined || dev === null || dev === '') {
    dev = deviceId()
    generatedDeviceId = true
  } else if (!isDeviceId(dev)) {
    return { status: 'corrupt', reason: 'device' }
  }

  if (r.libraries !== undefined && !Array.isArray(r.libraries)) return { status: 'corrupt', reason: 'libraries' }

  const seen = new Set<string>()
  const libraries: LibraryEntry[] = []
  let dropped = 0
  for (const item of (r.libraries ?? []) as unknown[]) {
    if (!item || typeof item !== 'object') {
      dropped++
      continue
    }
    const e = item as Partial<LibraryEntry>
    if (!isLibraryId(e.id) || typeof e.name !== 'string') {
      dropped++
      continue
    }
    if (seen.has(e.id)) {
      dropped++
      continue
    }
    seen.add(e.id)
    const entry: LibraryEntry = { id: e.id, name: e.name }
    if (typeof e.path === 'string' && e.path !== '') entry.path = e.path
    if (typeof e.lastOpenedAt === 'number' && Number.isFinite(e.lastOpenedAt)) entry.lastOpenedAt = e.lastOpenedAt
    libraries.push(entry)
  }

  const registry: AppRegistry = { version: REGISTRY_VERSION, deviceId: dev, libraries }
  // `lastOpenedId` 指向不存在的库 ⇒ 清掉：留着只会让每次启动白跑一次「路径失效」
  if (isLibraryId(r.lastOpenedId) && seen.has(r.lastOpenedId)) registry.lastOpenedId = r.lastOpenedId
  return { status: 'ok', registry, generatedDeviceId, dropped }
}

export function serializeRegistry(reg: AppRegistry): string {
  return `${JSON.stringify(reg, null, 2)}\n`
}

/* ------------------------------------------------------------ schema 版本判定 */

export type DbVersionVerdict =
  /** 全新的库：建表，版本号写当前 */
  | { status: 'fresh' }
  | { status: 'ok' }
  /** 比我们新：拒绝打开（不猜、不改它的版本号） */
  | { status: 'too-new'; found: number }
  /** 比我们旧：走迁移 */
  | { status: 'migrate'; found: number }
  /** 不是版本号（负数／小数）⇒ 当作坏库 */
  | { status: 'corrupt'; found: number }

/**
 * 「这个库的 schema 版本能不能读」的**唯一判据**。
 *
 * 纯函数、不碰数据库：读 `user_version` 归适配器，判归这里。
 * 为什么要在装载前判：**能在装载前拒绝的版本，必须在装载前拿到** ——
 * `user_version` 是 SQLite 自己读的，不依赖能不能解析 payload。
 */
export function judgeDbVersion(found: number, target: number = DB_SCHEMA_VERSION): DbVersionVerdict {
  if (!Number.isInteger(found) || found < 0) return { status: 'corrupt', found }
  if (found === 0) return { status: 'fresh' }
  if (found > target) return { status: 'too-new', found }
  if (found < target) return { status: 'migrate', found }
  return { status: 'ok' }
}
