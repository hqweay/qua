/**
 * 诊断飞行记录器：**常开、只记形状、永不记内容**。
 *
 * ## 为什么需要它
 *
 * 打磨期最贵的一件事是「用户报了一个 bug，但报不出来」——「卡了一下」「图没出来」
 * 「点了没反应」这三句话里没有任何能定位的东西。而事后开一个 debug 构建没有用：
 * 故障已经发生了。
 *
 * ## 为什么形状是「固定事件 ＋ 封闭词汇 ＋ 计数/时长」
 *
 * 一个通用 trace（把 message、堆栈、请求都记下来）看起来更有用，但它会**把用户笔记
 * 写进日志文件**——而日志文件会被备份工具、同步盘、发给别人的诊断包带走。所以：
 *
 * | 记 | 不记 |
 * |---|---|
 * | 事件的**种类**（`launch`／`error`／`crash`／`count`／`slow`） | 错误 message、堆栈、SQL |
 * | **封闭枚举**里的值（`family: 'io'`／`process: 'renderer'`） | 文件路径、页面名、笔记正文 |
 * | **计数与时长**（`n: 42`／`ms: 850`） | URL、凭据、查询词 |
 *
 * 这条纪律由 `tests/diagnostics.test.ts` 的负向断言钉住：喂含可辨认内容的错误，
 * 断言落盘文件里**搜不到**它。类型允许 `message` 存在，只有断言不许它落地。
 *
 * ## 为什么事件是封闭联合而不是 `Record<string, unknown>`
 *
 * 口袋字段一旦存在，下一个加字段的人就有地方塞内容。所以 `DiagEvent` 是本文件的
 * 枚举，`push()` 会**拒绝**未登记的 kind（返回 `false`），而不是静默写进去。
 *
 * ## 落盘形状（照 Tine 的 ADR 0058 的形状，但按本仓的原子写纪律）
 *
 * ```
 * <userData>/diagnostics/
 *   history.jsonl     本次运行的事件，一行一个 JSON；上限 1 MiB
 *   session-active    空文件；存在 ⇒ 上次运行没有正常退出
 * ```
 *
 * 启动时读一次上一次的 `history.jsonl`（≤1 MiB）留在内存里当「上一次会话」，
 * 然后被本次覆盖。所以一份报告同时描述**这次**与**上一次**。
 *
 * ## 与 `console.*` 的关系
 *
 * 不替换 `console`：那是开发者日志，可以带路径（`[library] restore failed: …`）。
 * 记录器是**给用户/诊断包看的**那一份，两者受众不同。要做的只有一件事：
 * 在关键节点显式 `push`／`error`／`crash`，而不是把 console 也搬进来。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 事件文件上限：1 MiB（含换行）。超了就留一条 `truncated` 标记并停止追加。 */
export const DIAG_LIMIT_BYTES = 1024 * 1024

/**
 * 错误族：**封闭枚举**。
 *
 * 判据是「排障时这三个字够不够分类」——不够就该加一个新成员（一次显式动作），
 * 而不是把 message 记下来让人自己看。
 */
export type ErrorFamily = 'unknown' | 'io' | 'network' | 'parse' | 'assert' | 'budget'

/** 崩溃的进程：主进程还是渲染进程（只有这两个）。 */
export type CrashProcess = 'main' | 'renderer'

/**
 * 崩溃原因：**封闭枚举**。
 *
 * ⚠️ Electron 的 `render-process-gone` 给的 `details.reason` 是**外部字符串**
 * （值域随版本变，且理论上可以是任意内容）⇒ 必须在 `crash()` 里映射成这里的成员，
 * 认不出的降级成 `unknown`。不许透传。
 */
export type CrashReason =
  | 'crashed'
  | 'oom'
  | 'killed'
  | 'abnormal-exit'
  | 'launch-failed'
  | 'integrity-failure'
  | 'unknown'

/** 计数对象：封闭枚举（想统计新东西＝在这里加一个词）。 */
export type CountWhat = 'blocks' | 'windows' | 'libraries' | 'commands' | 'searchHits' | 'assets'

/**
 * 一次「慢」的落点：封闭枚举。
 *
 * 这些是用户会读成「卡了一下」的地方；`ms` 只是数字，不带任何内容。
 */
export type SlowWhere = 'boot' | 'open-library' | 'migrate' | 'fts-rebuild' | 'load-rows' | 'save' | 'query'

/**
 * 事件的**封闭联合**。加一个成员＝一次显式动作（`push` 的 kind 白名单也要跟着加）。
 *
 * 每条都带 `schemaVersion` 与 `elapsedMs`（由 `push` 统一补），所以读报告的人
 * 能对上版本、也能算「这件事发生在启动后多久」。
 */
export type DiagEvent =
  | { kind: 'launch'; version: string; platform: string; isolated: boolean }
  | { kind: 'error'; family: ErrorFamily; where: string }
  | { kind: 'crash'; process: CrashProcess; reason: CrashReason }
  | { kind: 'count'; what: CountWhat; n: number }
  | { kind: 'slow'; where: SlowWhere; ms: number }
  | { kind: 'exit'; orderly: true }
  | { kind: 'truncated'; limitBytes: number }

/** 落盘时统一补的两个字段 */
type Envelope = DiagEvent & { schemaVersion: number; elapsedMs: number }

const SCHEMA_VERSION = 1

/** 事件种类的白名单（与 `DiagEvent` 的 `kind` 一一对应；漏一个 ⇒ `push` 会拒它）。 */
const KINDS: ReadonlySet<string> = new Set<DiagEvent['kind']>([
  'launch',
  'error',
  'crash',
  'count',
  'slow',
  'exit',
  'truncated',
])

/**
 * 从错误对象里判**族**，不读 message 的内容做分支。
 *
 * 判据落在 `code`（Node 的结构化字段）与错误类型上——`code` 是枚举，
 * 而 message 是自由文本（按 message 子串分派还有它自己的问题：措辞一改就静默失配）。
 */
export function familyOf(e: unknown): ErrorFamily {
  const code = (e as { code?: unknown } | null)?.code
  if (typeof code === 'string') {
    if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC' || code === 'EBUSY') return 'io'
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return 'network'
  }
  if (e instanceof SyntaxError) return 'parse'
  if (e instanceof TypeError || e instanceof RangeError) return 'assert'
  if (e instanceof Error && /^(AssertionError)$/.test(e.name)) return 'assert'
  return 'unknown'
}

/**
 * 把 Electron 给的 `reason` 映射进封闭枚举。认不出 ⇒ `unknown`（**绝不透传**）。
 */
export function crashReasonOf(raw: unknown): CrashReason {
  switch (raw) {
    case 'crashed':
    case 'oom':
    case 'killed':
    case 'abnormal-exit':
    case 'launch-failed':
    case 'integrity-failure':
      return raw
    default:
      return 'unknown'
  }
}

export interface Recorder {
  /**
   * 推一条事件。**未登记的 kind 返回 `false` 且不落盘**——
   * 这样「加了个新 kind 忘了登记」会当场可判，而不是写进去之后才发现。
   */
  push(ev: DiagEvent): boolean
  launch(info: { version: string; platform: string; isolated: boolean }): void
  error(where: 'uncaught' | 'unhandled' | 'rejection' | 'window', e: unknown): void
  crash(process: CrashProcess, reason: unknown): void
  count(what: CountWhat, n: number): void
  slow(where: SlowWhere, ms: number): void
  /** 正常退出：写一条 `exit` 并删掉 `session-active` */
  orderlyExit(): void
  /** 把内存里的事件写盘（幂等；每次写都是「当前完整的一份」） */
  flush(): void
  /** 上一次运行留下的事件（启动时读一次；本次还没写过时也在） */
  previousEvents(): Envelope[]
  /** 启动时 `session-active` 存在 ⇒ 上次没有正常退出 */
  readonly previousExitUnclean: boolean
}

export interface RecorderOptions {
  /** 目录（`<userData>/diagnostics`）。不存在会建出来。 */
  dir: string
  /** 注入时钟（测试用）。缺省 `Date.now`。 */
  now?: () => number
}

/**
 * 建一个记录器。
 *
 * 构造时做三件事（顺序是判据）：
 *   1. 建目录；
 *   2. 读上一次的 `history.jsonl`（≤1 MiB）留在内存；
 *   3. 看 `session-active` 在不在 ⇒ `previousExitUnclean`；
 *      然后**写本次的 `session-active`**（本次也可能崩）。
 */
export function createRecorder(opts: RecorderOptions): Recorder {
  const { dir } = opts
  const now = opts.now ?? Date.now
  const t0 = now()
  const historyFile = join(dir, 'history.jsonl')
  const activeFile = join(dir, 'session-active')

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不出来 ⇒ 记录器退化成内存态（不影响应用运行） */
  }

  // ② 读上一次（上限保护：只读前 1 MiB）
  let previous: Envelope[] = []
  try {
    if (existsSync(historyFile)) {
      const raw = readFileSync(historyFile, 'utf8')
      const cut = raw.length > DIAG_LIMIT_BYTES ? raw.slice(0, DIAG_LIMIT_BYTES) : raw
      previous = cut
        .split('\n')
        .filter((l) => l.length > 0)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as Envelope]
          } catch {
            return [] // 半截行（崩溃时写的）：跳过，不炸
          }
        })
    }
  } catch {
    previous = []
  }

  // ③ 上次是否非正常退出；然后立刻写本次的标记
  const previousExitUnclean = existsSync(activeFile)
  try {
    writeFileSync(activeFile, '')
  } catch {
    /* 写不出标记 ⇒ 下次会把这次误报成非正常退出。可接受（宁多报一条） */
  }

  let events: Envelope[] = []
  let bytes = 0
  let truncated = false

  const serialize = (ev: Envelope): string => `${JSON.stringify(ev)}\n`

  const push = (ev: DiagEvent): boolean => {
    if (!KINDS.has(ev.kind)) return false
    if (truncated) return true // 已经截断：安静接受，不再追加（状态已诚实登记）
    const full: Envelope = { ...ev, schemaVersion: SCHEMA_VERSION, elapsedMs: Math.max(0, now() - t0) }
    const line = serialize(full)
    if (bytes + line.length > DIAG_LIMIT_BYTES) {
      // **诚实标记**：不静默丢，也不让文件无限长
      truncated = true
      const mark = serialize({ kind: 'truncated', limitBytes: DIAG_LIMIT_BYTES, schemaVersion: SCHEMA_VERSION, elapsedMs: Math.max(0, now() - t0) })
      events.push(JSON.parse(mark) as Envelope)
      bytes += mark.length
      writeAll()
      return true
    }
    events.push(full)
    bytes += line.length
    return true
  }

  /** 整份重写（不是 append）：崩溃时文件里最多是「上一次 flush 的完整内容」 */
  function writeAll(): void {
    try {
      writeFileSync(historyFile, events.map(serialize).join(''))
    } catch {
      /* 写不出来不影响应用 */
    }
  }

  return {
    push,
    launch(info) {
      push({ kind: 'launch', version: info.version, platform: info.platform, isolated: info.isolated })
    },
    error(where, e) {
      // ⚠️ 只取族，**不取 message**（见文件头）
      push({ kind: 'error', family: familyOf(e), where })
    },
    crash(process, reason) {
      push({ kind: 'crash', process, reason: crashReasonOf(reason) })
    },
    count(what, n) {
      push({ kind: 'count', what, n: Math.trunc(n) })
    },
    slow(where, ms) {
      push({ kind: 'slow', where, ms: Math.trunc(ms) })
    },
    orderlyExit() {
      push({ kind: 'exit', orderly: true })
      writeAll()
      try {
        if (existsSync(activeFile)) rmSync(activeFile, { force: true })
      } catch {
        /* 删不掉 ⇒ 下次会误报一次非正常退出。可接受 */
      }
    },
    flush: writeAll,
    previousEvents: () => previous,
    previousExitUnclean,
  }
}

/** 给诊断报告用的：这个文件还在不在、多大（不读内容） */
export function diagFileInfo(dir: string): { exists: boolean; bytes: number } {
  const f = join(dir, 'history.jsonl')
  try {
    return { exists: true, bytes: statSync(f).size }
  } catch {
    return { exists: false, bytes: 0 }
  }
}
