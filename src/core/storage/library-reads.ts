/**
 * **只读的库查询计划**：`doc`（一个视图的子树）与 `catalog`（槽要显示的全局身份）。
 *
 * ## 为什么 SQL 住 `core/`
 *
 * 主进程**不认块语义**：它只认表名/列名，执行 core 定义的具名查询。
 * 但「哪些列算页／标签／日记／关系」是块语义，必须住在 `core/`。所以查询计划在这里定义，
 * 主进程拿**具名查询**执行——不是任意 SQL 过 IPC，也不是把语义塞进主进程。
 *
 * ## 为什么是「Doc」而不是「整库」
 *
 * 打开一页/一天时，视图需要的是：root＋它的子树＋祖先链。整库里的其他块不属于这个视图。
 * 这就是工作集装载的单位：**Library 是查询域，Working set 是视图**。
 * 这里只描述「怎么把这一份工作集查出来」，不决定内存里保留多久（那是 BlockStore 的事）。
 *
 * ## 口径
 *
 * - `docSubtree`：从 root id 出发的**整棵子树**（含软删块；可见性由模型层判，不在 SQL 里猜）。
 * - `docProps/docAliases/docLists`：只取子树那些块的附属行（按 block 索引走）。
 * - `docAncestors`：从 root 的 parent 往上的祖先链（不含 root 自己；根没有祖先时为空）。
 * - `catalog*`：默认槽要显示的全局身份摘要；**不含页列表**（页列表是查询视图，按页查）。
 *
 * ⚠️ `json_each(?)` 依赖 SQLite 的 JSON1（node:sqlite 内置，实测可用）。用它是为了
 * 一个参数传任意多个 id，避免 `in (?,?,…)` 的占位符数量与 SQL 缓存随 Doc 大小漂移。
 */
import { DB_TABLES } from '../identity/library.ts'
import type { RawLibraryRows } from './db-rows.ts'

/**
 * 行形状经这一份**再导出**给主进程：`electron/**` 的 import 白名单只认少数 core 模块，
 * 行编码的形状从具名查询这一层走（主进程不该直接摸 `db-rows` 的编码细节）。
 */
export type { RawLibraryRows }

const B = DB_TABLES.block
const P = DB_TABLES.property
const A = DB_TABLES.alias
const L = DB_TABLES.list

/** 子树查询的块列：与 `db-rows.ts` 的装载列逐字一致（编码口径只有一份） */
const BLOCK_COLUMNS = 'b.id, b.content, b.annos, b.parent, b.left, b.created, b.modified, b.deleted, b.display, b.kind, b.date, b.query, b.type'

export const LIBRARY_READS = {
  /** 一个／多个 root 的整棵子树（含软删；root 的 parent 不在集合里，建模型时会成为顶层） */
  docSubtree: `with recursive sub(id) as (
      select value from json_each(?1)
      union
      select b.id from ${B} b join sub s on b.parent = s.id
    )
    select ${BLOCK_COLUMNS} from ${B} b join sub s on b.id = s.id`,

  /**
   * **一批块自己的行**（不带子树）：引用目标、标签、字段定义、槽快捷卡这些
   * 「按 id 装一块」的读面。
   *
   * 与 `docSubtree` 分开：这些目标可能是一整张大页，装它的子树会把工作集从
   * 「当前视图闭包」变成「引用目标的整棵树」，首帧成本跟着被引用的页大小走。
   */
  blocksByIds: `select ${BLOCK_COLUMNS} from ${B} b where b.id in (select value from json_each(?1))`,

  /** 子树里的属性行（一格一行；顺序由 pos 表达） */
  docProps: `select block, name, pos, multi, value from ${P} where block in (select value from json_each(?1))`,

  /** 子树里的地址行（pos 有序，首个是主名） */
  docAliases: `select name, block, pos from ${A} where block in (select value from json_each(?1))`,

  /** 子树里的露面行（page／tag） */
  docLists: `select block, list from ${L} where block in (select value from json_each(?1))`,

  /** root 的祖先链（从 parent 往上；不含 root 自己） */
  docAncestors: `with recursive anc(id) as (
      select parent from ${B} where id = ?1 and parent is not null
      union
      select b.parent from ${B} b join anc a on b.id = a.id where b.parent is not null
    )
    select ${BLOCK_COLUMNS} from ${B} b join anc a on b.id = a.id`,

  /**
   * 日记日期（槽的日历／日记流窗口）。
   *
   * **含软删天**：`_date` 派生身份，删掉的一天仍是「这一天存在过」的块；
   * 打开它要走「恢复同一块」而不是新建（新建会得到同 id 的第二块）。
   * 过滤可见性由调用方判（feed 只取 `deleted === null`）。
   */
  catalogJournals: `select id, date, deleted from ${B} where date is not null order by date desc`,

  /** 标签（id ＋ 主名）：`#` 补全与标签 chip 的显示名 */
  catalogTags: `select b.id as id, a.name as name from ${L} l
    join ${B} b on b.id = l.block
    join ${A} a on a.block = b.id and a.pos = 0
    where l.list = 'tag' and b.deleted is null
    order by a.name`,

  /** 字段定义（id ＋ kind ＋ 主名）：属性面与查询构建器的候选 */
  catalogPropDefs: `select b.id as id, b.kind as kind, a.name as name from ${B} b
    left join ${A} a on a.block = b.id and a.pos = 0
    where b.kind is not null and b.deleted is null
    order by a.name`,

  /**
   * **全量地址表**（name → block）：创建路径的防重判据。
   *
   * 打字里出现的 `#名字`／`[[名字]]` 在本地工作集里 miss 时，不能当成「库里没有」
   * 去新建：名字可能属于一个还没加载的块，新建就是第二个同名身份。这张表回答
   * 「这个名字已经归谁」，与 `Index.aliases` 同一口径（全局唯一；重复只可能来自
   * 历史脏数据，取任一都指向同一个名字空间）。
   */
  catalogAliases: `select name, block from ${A} order by block, pos`,

  /**
   * 回收站：被软删的操作根（子孙不各写标记，所以这里就是整座回收站）。
   *
   * `order by deleted desc` 是为了让部分索引 `idx_Block_deleted` 既做过滤又做排序；
   * 只写 `order by id` 时 SQLite 会选主键索引全表扫（1M 行里捞 100 行，实测 87ms）。
   */
  catalogTrash: `select id, deleted from ${B} where deleted is not null order by deleted desc, id`,
} as const

export type LibraryReadName = keyof typeof LIBRARY_READS

/** 与 `rowsToWorkspace` 同一形状的子树行；`meta` 为空时 activeId/savedAt 由调用方补 */
export type LibraryDocRows = {
  rows: RawLibraryRows
  /** root 的祖先链（原始 Block 行；只用于路径/面包屑，不是第二条子树） */
  ancestors: Record<string, unknown>[]
  rootIds: string[]
}

export type CatalogJournal = { id: string; date: string; deleted: number | null }
export type CatalogTag = { id: string; name: string }
export type CatalogPropDef = { id: string; kind: string; name: string | null }
export type CatalogTrashRoot = { id: string; deleted: number }
export type CatalogAlias = { name: string; block: string }

/** 槽的全局身份摘要；页列表刻意不在这里（它是查询视图，按页查） */
export type LibraryCatalog = {
  /** 库级 meta 里首帧真需要的两格（当前对象与保存时刻） */
  meta: { activeId: string; savedAt: number }
  journals: CatalogJournal[]
  tags: CatalogTag[]
  propDefs: CatalogPropDef[]
  aliases: CatalogAlias[]
  trash: CatalogTrashRoot[]
}

/**
 * 查询计划的名字白名单。
 *
 * 主进程只接受这些名字（＋参数），不接受任意 SQL；名字与 SQL 的对应只此一份。
 * 新增加载面时，先在这里加一条具名查询，再加主进程的执行分支——两边不会各写一份 SQL。
 */
export function isLibraryReadName(v: unknown): v is LibraryReadName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LIBRARY_READS, v)
}
