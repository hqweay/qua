/**
 * **库的读端口**（`LibraryClient` 的第一片）：`doc`／`catalog` 两个具名查询。
 *
 * ## 为什么需要这一层
 *
 * 读的语义住 `core/storage/library-reads.ts`（具名 SQL），执行住主进程（`node:sqlite`），
 * 而调用方（装配层／将来的工作集）不该知道 IPC 通道名与回复外壳。这一层就是那两件事之间
 * 的唯一接线：**转发 ＋ 把回复判成可用的值**。
 *
 * ## 为什么失败要显式分型，不当成「空」
 *
 * `doc()` 返回 `{ rows: { blocks: [] } }` 与「这个窗口没有库」在类型上必须能分开：
 * 前者会让调用方以为「这一页真的是空的」，后者是「读不了」。同理，坏回复不能解包成
 * `undefined` 再让上层 `.blocks` 抛在别处 —— 错误要停在发生的那一层，并带上通道名。
 *
 * ## 边界
 *
 * 主进程仍然只认表名/列名：这个端口只发 `roots` 参数，不发 SQL。新增读面时先加
 * `library-reads.ts` 的具名查询与主进程执行分支，再在这里加一格——三处各写一份 SQL
 * 就是「同一件事有多个答案」。
 */
import type { CandidatePlan, LibraryCatalog, LibraryDocRows, RawLibraryRows } from './library-reads.ts'

/** 桥面：桌面由 preload 提供；web 宿主根本没有库面（`undefined`） */
export interface LibraryReadBridge {
  /** 一个／多个 root 的子树＋祖先链（参数是 root id 列表，不是 SQL） */
  doc(roots: readonly string[]): Promise<unknown>
  /** 一批块自己的行（**不带子树**；引用目标/标签/定义按 id 装一块） */
  blocks?(ids: readonly string[]): Promise<unknown>
  /** 查询候选 id（计划 JSON 由 core 编译，主进程只执行 SQL） */
  candidates?(plan: unknown): Promise<unknown>
  /** 候选装载：块＋全部祖先链（可选一层子级） */
  tree?(ids: readonly string[], withChildren: boolean): Promise<unknown>
  /** 槽要显示的全局身份摘要（日记／标签／字段定义／地址表／回收站根） */
  catalog(): Promise<unknown>
}

/**
 * 读结果。`no-library`／`bad-args` 是**可预期的环境态**；`error` 是查询失败；
 * `ok` 才带值。三态分开是为了让调用方不必用 `undefined` 猜。
 */
export type LibraryReadResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'no-library' }
  | { status: 'bad-args' }
  | { status: 'error'; error: string }

export interface LibraryClient {
  doc(roots: readonly string[]): Promise<LibraryReadResult<LibraryDocRows>>
  /** 查询候选 id（计划是超集；matcher 仍是判定来源）。失败分型与 doc 同一条 */
  candidates(plan: CandidatePlan): Promise<LibraryReadResult<string[]>>
  /** 候选装载：块＋全部祖先链（可选一层子级） */
  tree(ids: readonly string[], withChildren: boolean): Promise<LibraryReadResult<RawLibraryRows>>
  /**
   * 装一批**不带子树**的块。闭包可能超过单次 IPC 的上限（主进程 512）⇒
   * 这里按片切开发；任何一片失败都让整次失败（不返回半批——调用方要的是
   * 「这批目标都可读」，半批会让引用一半能解析一半不能）。
   */
  blocks(ids: readonly string[]): Promise<LibraryReadResult<RawLibraryRows>>
  catalog(): Promise<LibraryReadResult<LibraryCatalog>>
}

/** 回复外壳的形状（主进程只回这几个 status；其余一律按坏回复处理） */
interface ReadReply {
  status?: unknown
  doc?: unknown
  catalog?: unknown
  rows?: unknown
  error?: unknown
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isArrayOf(v: unknown, each: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.every(each)
}

/**
 * 回复能不能当 `LibraryDocRows` 用。
 *
 * 只校验**结构**（四张表是数组、祖先链与 rootIds 是数组），不逐行校验列：
 * 逐行校验是 `rowsToWorkspace` 的事，这里多写一份只会让两处判据漂。校验的意义是
 * 「坏回复在这里停下来」，不是替代编码层。
 */
function isDocRows(v: unknown): v is LibraryDocRows {
  if (!isRecord(v)) return false
  const rows = v.rows
  if (!isRecord(rows)) return false
  return (
    Array.isArray(rows.blocks) &&
    Array.isArray(rows.props) &&
    Array.isArray(rows.aliases) &&
    Array.isArray(rows.lists) &&
    isRecord(rows.meta) &&
    Array.isArray(v.ancestors) &&
    isArrayOf(v.rootIds, (x) => typeof x === 'string')
  )
}

/** 回复能不能当 `LibraryCatalog` 用（meta ＋ 五张表的数组） */
function isCatalog(v: unknown): v is LibraryCatalog {
  return (
    isRecord(v) &&
    isRecord(v.meta) &&
    Array.isArray(v.journals) &&
    Array.isArray(v.tags) &&
    Array.isArray(v.propDefs) &&
    Array.isArray(v.aliases) &&
    Array.isArray(v.trash)
  )
}

/** 回复能不能当一批块行用（四张表的数组；meta 由装载方补） */
function isBlockRows(v: unknown): v is RawLibraryRows {
  return (
    isRecord(v) &&
    Array.isArray(v.blocks) &&
    Array.isArray(v.props) &&
    Array.isArray(v.aliases) &&
    Array.isArray(v.lists)
  )
}

/** 通道名只用于错误信息：出问题时能一眼知道是哪一个读面坏了 */
function clientError(channel: string, detail: string): LibraryReadResult<never> {
  return { status: 'error', error: `${channel}: ${detail}` }
}

function replyStatus(r: unknown): ReadReply {
  return isRecord(r) ? (r as ReadReply) : {}
}

/** 单次 `blocks` 的分片上限：与主进程 handler 的形状校验同一条（`isRootList` 的 512） */
const BLOCKS_CHUNK = 512

function createClient(bridge: LibraryReadBridge): LibraryClient {
  return {
    async doc(roots) {
      let raw: unknown
      try {
        raw = await bridge.doc(roots)
      } catch (e) {
        return clientError('library/doc', e instanceof Error ? e.message : String(e))
      }
      const r = replyStatus(raw)
      if (r.status === 'no-library') return { status: 'no-library' }
      if (r.status === 'bad-args') return { status: 'bad-args' }
      if (r.status === 'error') return clientError('library/doc', String(r.error ?? 'unknown'))
      if (r.status !== 'ok') return clientError('library/doc', `bad reply status: ${String(r.status)}`)
      if (!isDocRows(r.doc)) return clientError('library/doc', 'bad reply shape')
      return { status: 'ok', value: r.doc }
    },

    async candidates(plan) {
      if (!bridge.candidates) return clientError('library/candidates', 'bridge has no candidates read')
      let raw: unknown
      try {
        raw = await bridge.candidates(plan)
      } catch (e) {
        return clientError('library/candidates', e instanceof Error ? e.message : String(e))
      }
      const r = replyStatus(raw)
      if (r.status === 'no-library') return { status: 'no-library' }
      if (r.status === 'bad-args') return { status: 'bad-args' }
      if (r.status === 'error') return clientError('library/candidates', String(r.error ?? 'unknown'))
      if (r.status !== 'ok') return clientError('library/candidates', `bad reply status: ${String(r.status)}`)
      const reply = r as { ids?: unknown }
      if (!Array.isArray(reply.ids) || !reply.ids.every((x) => typeof x === 'string')) {
        return clientError('library/candidates', 'bad reply shape')
      }
      return { status: 'ok', value: reply.ids }
    },

    async tree(ids, withChildren) {
      if (!bridge.tree) return clientError('library/tree', 'bridge has no tree read')
      const uniq = [...new Set(ids.filter((x) => typeof x === 'string' && x !== ''))]
      if (uniq.length === 0) {
        return { status: 'ok', value: { blocks: [], props: [], aliases: [], lists: [], meta: {} } }
      }
      let raw: unknown
      try {
        raw = await bridge.tree(uniq, withChildren)
      } catch (e) {
        return clientError('library/tree', e instanceof Error ? e.message : String(e))
      }
      const r = replyStatus(raw)
      if (r.status === 'no-library') return { status: 'no-library' }
      if (r.status === 'bad-args') return { status: 'bad-args' }
      if (r.status === 'error') return clientError('library/tree', String(r.error ?? 'unknown'))
      if (r.status !== 'ok') return clientError('library/tree', `bad reply status: ${String(r.status)}`)
      if (!isBlockRows(r.rows)) return clientError('library/tree', 'bad reply shape')
      return { status: 'ok', value: r.rows as RawLibraryRows }
    },

    async blocks(ids) {
      if (!bridge.blocks) return clientError('library/blocks', 'bridge has no blocks read')
      const uniq = [...new Set(ids.filter((x) => typeof x === 'string' && x !== ''))]
      if (uniq.length === 0) {
        return { status: 'ok', value: { blocks: [], props: [], aliases: [], lists: [], meta: {} } }
      }
      const out: RawLibraryRows = { blocks: [], props: [], aliases: [], lists: [], meta: {} }
      for (let i = 0; i < uniq.length; i += BLOCKS_CHUNK) {
        const chunk = uniq.slice(i, i + BLOCKS_CHUNK)
        let raw: unknown
        try {
          raw = await bridge.blocks(chunk)
        } catch (e) {
          return clientError('library/blocks', e instanceof Error ? e.message : String(e))
        }
        const r = replyStatus(raw)
        if (r.status === 'no-library') return { status: 'no-library' }
        if (r.status === 'bad-args') return { status: 'bad-args' }
        if (r.status === 'error') return clientError('library/blocks', String(r.error ?? 'unknown'))
        if (r.status !== 'ok') return clientError('library/blocks', `bad reply status: ${String(r.status)}`)
        if (!isBlockRows(r.rows)) return clientError('library/blocks', 'bad reply shape')
        out.blocks.push(...(r.rows as RawLibraryRows).blocks)
        out.props.push(...(r.rows as RawLibraryRows).props)
        out.aliases.push(...(r.rows as RawLibraryRows).aliases)
        out.lists.push(...(r.rows as RawLibraryRows).lists)
        Object.assign(out.meta, (r.rows as RawLibraryRows).meta)
      }
      return { status: 'ok', value: out }
    },

    async catalog() {
      let raw: unknown
      try {
        raw = await bridge.catalog()
      } catch (e) {
        return clientError('library/catalog', e instanceof Error ? e.message : String(e))
      }
      const r = replyStatus(raw)
      if (r.status === 'no-library') return { status: 'no-library' }
      if (r.status === 'error') return clientError('library/catalog', String(r.error ?? 'unknown'))
      if (r.status !== 'ok') return clientError('library/catalog', `bad reply status: ${String(r.status)}`)
      if (!isCatalog(r.catalog)) return clientError('library/catalog', 'bad reply shape')
      return { status: 'ok', value: r.catalog }
    },
  }
}

/**
 * 桌面宿主：桥来自 `window.qua`（preload 的两个具名通道）。
 *
 * `roots` 原样转发、不改写：调用方给的是「要装哪几个视图根」，这个决定属于装配层，
 * 不属于传输层。主进程只做参数形状校验（数量与字符串）。
 */
export function createLibraryClient(bridge: LibraryReadBridge): LibraryClient {
  return createClient(bridge)
}
