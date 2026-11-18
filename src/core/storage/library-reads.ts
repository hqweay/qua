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
import type { BlockIndexRow } from './derived-rows.ts'

/**
 * 行形状经这一份**再导出**给主进程：`electron/**` 的 import 白名单只认少数 core 模块，
 * 行编码的形状从具名查询这一层走（主进程不该直接摸 `db-rows` 的编码细节）。
 */
export type { RawLibraryRows }
/** 派生位置行的形状（`BlockIndex` 四列；增量维护的读面按它回话） */
export type { BlockIndexRow }

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
   * **一批块 ＋ 它们的全部祖先链**（查询候选的装载单位）。
   *
   * 候选块的判定要看上下文（`{up}` 的祖先链、`_date` 排序贴着的那一天、面包屑），
   * 所以按 id 装候选必须连祖先一起装。祖先链是**一条路径**，不是祖先的兄弟子树
   * ——成本跟「候选数 × 深度」走，不跟库走。
   */
  treeAncestors: `with recursive want(id) as (
      select value from json_each(?1)
      union
      select b.parent from ${B} b join want w on b.id = w.id where b.parent is not null
    )
    select ${BLOCK_COLUMNS} from ${B} b join want w on b.id = w.id`,

  /** 一批块的**直接子级**（`{children:true}` 的判定要看子块在不在，一层就够） */
  treeChildren: `select ${BLOCK_COLUMNS} from ${B} b
    where b.parent in (select value from json_each(?1))`,

  /**
   * **全局身份块**（catalog 的块对象面）：页/标签露面、字段定义、回收站根。
   *
   * catalog 摘要（§`catalogTags` 等）只回答 id 与名字；选择器、页清单、回收站卡
   * 要的是**块对象**。这一批是「库的身份清单」——体量跟身份数走，不跟块数走
   * （1M 块的库通常几千个身份）。装载后 `kb.pages()/tags()/propDefs()/trash()`
   * 这些同步全局读在工作集模式下依然正确。
   */
  catalogIdentity: `select ${BLOCK_COLUMNS} from ${B} b
    where b.deleted is not null
       or b.kind is not null
       or exists (select 1 from ${L} l where l.block = b.id and l.list in ('page','tag'))`,

  /**
   * **依赖方查询**（改名／清除的低频路径）：谁引用了这一块——正文引用、标签成员、
   * 属性值三路分类（与 FTS 重铺的来源分类同一条口径）。全库口径：未装载的依赖方
   * 也要拿到（它们的 FTS 行里住着旧名字）。
   */
  dependentsOf: `select b.id as id, 'content' as kind from ${B} b where b.deleted is null and exists (
      select 1 from json_each(b.content) j
      where json_extract(j.value,'$.t') = 'ref' and json_extract(j.value,'$.to') = ?1
    )
    union all
    select p.block as id, 'tag' as kind from ${P} p where p.name = '_tags' and p.value = ?2
    union all
    select p.block as id, 'prop' as kind from ${P} p
      where p.name not like '\\_%' escape '\\' and p.value = ?2`,

  /** **入向关系按目标批查**（引用角标的全库计数；派生表 ready 后才可读） */
  relationsFor: `select to_id, from_id, kind, from_root, count from BlockRelation
    where to_id in (select value from json_each(?1))`,

  /**
   * **派生位置行按块批查**（`BlockIndex` 的按 id 取数口）。
   *
   * 增量维护要三样东西都从这里取：受影响子树的**库里现存前缀**（移动/清除按它整片改）、
   * 父块的路径前缀与 root/hidden（新子树的行要拼在它下面）、前兄弟的**存量段**
   * （中点必须夹在库里的段之间，不是渲染器现算的 rank）。
   */
  indexByBlock: `select block, root, path, hidden from ${DB_TABLES.blockIndex}
    where block in (select value from json_each(?1))`,

  /**
   * **某个落点的库后继**：`parent` 下 `left = ?` 的那一行（`left` 为 null 时是层首）。
   *
   * 为什么不能只看内存：顶层根在工作集里只装了一部分，新块落到了「内存里前一个根」
   * 的右边，而库里它后面可能还有未装载的根。中点必须夹在**库里的**后继之前。
   * `(parent, left)` 有索引（`idx_Block_parent_left`），成本是一次定位。
   */
  indexFollowing: `select i.block, i.root, i.path, i.hidden from ${DB_TABLES.blockIndex} i
    join ${B} b on b.id = i.block
    where b.parent is ?1 and b.left is ?2
    order by i.path limit 1`,

  /**
   * **一层的全部子块行**（按库里的先序）：整层重编号的取数口。
   *
   * 中点夹不出来（段耗尽）时唯一稳的做法是把这一层按最终顺序重铺段值——那要知道
   * 这一层现在有哪些块、各自的旧前缀。层内块数由「这个父块有几个孩子」决定。
   */
  indexChildren: `select i.block, i.root, i.path, i.hidden from ${DB_TABLES.blockIndex} i
    join ${B} b on b.id = i.block
    where b.parent is ?1
    order by i.path`,

  /** **顶层根清单**（派生表流式重建的装载单位；含软删根——它们的行也要 hidden=1） */
  catalogRoots: `select id from ${B} where parent is null order by rowid`,

  /** **FTS 映射按块查**（增量索引不再把整张映射搬进内存）：一块最多几行（每来源一行） */
  ftsMapOf: `select block_id, source, fts_rowid from ${DB_TABLES.blockFtsMap}
    where block_id in (select value from json_each(?1))`,

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
  /**
   * 库级 meta 里首帧真需要的几格：当前对象、保存时刻，以及 FTS 索引的状态
   * （查询面据此决定「信 FTS 还是显式降级」；映射按块查，不再整表进内存）。
   */
  meta: {
    activeId: string
    savedAt: number
    ftsState: string
    ftsTokenizer: string
    ftsRowidSeq: number
    /** 派生两表的重建状态：非 ready 时读路径不许信（分层闸——重建完成前它们只是半份答案） */
    derivedState: string
  }
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

/* ------------------------------------------------------------ 查询候选计划 */

/**
 * **候选计划**（JSON 可序列化）：查询条件 → 「哪些块**可能**命中」的 SQL 形状。
 *
 * 计划是**超集**（⊇ 真命中）：matcher 仍是判定的唯一来源，SQL 只负责把候选从
 * 全库收窄到「值得装载的那一批」。收窄不了的形状（`not`／`mark`／`link`）给
 * `visible`（全部可见块）——正确性优先，成本随命中面走，这是已登记的代价。
 *
 * 计划由 `query-candidates.ts` 从条件树编译；这里只有「计划 → SQL」的投影，
 * 与具名查询同一层（主进程执行，不解释块语义）。
 */
export type CandidatePlan =
  | { k: 'none' }
  | { k: 'visible' }
  | { k: 'ids'; ids: string[] }
  | { k: 'tags'; ids: string[] }
  | { k: 'list'; list: 'page' | 'tag' }
  | { k: 'journal' }
  | { k: 'note' }
  | { k: 'ref'; to?: string }
  | { k: 'prop'; name: string }
  | { k: 'kind' }
  | { k: 'aliased' }
  | { k: 'tagged' }
  | { k: 'journalDay'; date: string }
  | { k: 'parents' }
  | { k: 'text'; needle: string; nonempty?: boolean }
  | { k: 'descendantsOf'; plan: CandidatePlan }
  | { k: 'ancestorsOf'; plan: CandidatePlan }
  | { k: 'near'; plan: CandidatePlan }
  | { k: 'all'; plans: CandidatePlan[] }
  | { k: 'any'; plans: CandidatePlan[] }

/** IPC 参数的形状校验（只验容器；值是绑定参数，不进 SQL 文本） */
export function isCandidatePlan(v: unknown, depth = 0): v is CandidatePlan {
  if (!isRecord(v) || depth > 32) return false
  switch (v.k) {
    case 'none':
    case 'visible':
    case 'kind':
    case 'aliased':
    case 'tagged':
    case 'parents':
      return true
    case 'ids':
    case 'tags':
      return Array.isArray(v.ids) && v.ids.every((x) => typeof x === 'string')
    case 'list':
      return v.list === 'page' || v.list === 'tag'
    case 'journal':
    case 'note':
      return true
    case 'ref':
      return v.to === undefined || typeof v.to === 'string'
    case 'prop':
      return typeof v.name === 'string' && v.name !== ''
    case 'journalDay':
      return typeof v.date === 'string' && v.date !== ''
    case 'text':
      return typeof v.needle === 'string' && (v.nonempty === undefined || v.nonempty === true)
    case 'descendantsOf':
    case 'ancestorsOf':
    case 'near':
      return isCandidatePlan(v.plan, depth + 1)
    case 'all':
    case 'any':
      return Array.isArray(v.plans) && v.plans.every((p) => isCandidatePlan(p, depth + 1))
    default:
      return false
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * 计划 → SQL。参数一律匿名 `?`、按文本出现顺序绑定（嵌套计划的参数先深后浅拼在后面）。
 *
 * 计划是超集 ⇒ 这里的 SQL **宁可多给**：`instr`／值比较这类窄化都不做
 * （值在行里是 JSON 编码，按编码值窄会漏掉跨行拼接的命中），交给 matcher 判。
 */
export function candidatePlanSql(plan: CandidatePlan): { sql: string; params: (string | number)[] } {
  const wrap = (inner: string, params: (string | number)[]): { sql: string; params: (string | number)[] } => ({ sql: inner, params })
  switch (plan.k) {
    case 'none':
      return wrap('select null as id where 0', [])
    case 'visible':
      return wrap(`select id from ${B} where deleted is null`, [])
    case 'ids':
      // json_each 吃 JSON 文本（与 docSubtree 同一条绑定口径）
      return wrap('select value as id from json_each(?)', [JSON.stringify(plan.ids)])
    case 'tags':
      // 标签成员并集（matcher 的 `{tag}` 语义就是并集）；子标签沿树展开（`desc:true` 也被覆盖）
      return wrap(
        `with tags(id) as (
          select value from json_each(?)
          union
          select c.id from ${B} c join tags t on c.parent = t.id join ${L} l on l.block = c.id and l.list = 'tag'
        )
        select distinct p.block as id from ${P} p join tags on p.name = '_tags' and p.value = '"' || tags.id || '"'`,
        [JSON.stringify(plan.ids)],
      )
    case 'list':
      return wrap(
        `select l.block as id from ${L} l join ${B} b on b.id = l.block where l.list = ? and b.deleted is null`,
        [plan.list],
      )
    case 'journal':
      return wrap(`select id from ${B} where date is not null and deleted is null`, [])
    case 'note':
      return wrap(
        `select p.block as id from ${P} p join ${B} b on b.id = p.block and b.deleted is null where p.name = '_annotates'`,
        [],
      )
    case 'ref':
      return plan.to === undefined
        ? wrap(
            `select b.id as id from ${B} b where b.deleted is null and exists (
              select 1 from json_each(b.content) j where json_extract(j.value,'$.t') = 'ref'
            )`,
            [],
          )
        : wrap(
            `select b.id as id from ${B} b where b.deleted is null and exists (
              select 1 from json_each(b.content) j
              where json_extract(j.value,'$.t') = 'ref' and json_extract(j.value,'$.to') = ?
            )`,
            [plan.to],
          )
    case 'prop':
      // 「有这一栏」＝ 值 ∪ 自有槽 ∪ 标签声明（matcher 的 readField 三来源）——
      // 只给「有值行」的块会漏掉标签声明进场的成员，候选就不再是超集
      return wrap(
        `select p.block as id from ${P} p join ${B} b on b.id = p.block and b.deleted is null where p.name = ?
        union
        select p.block as id from ${P} p join ${B} b on b.id = p.block and b.deleted is null
          where p.name = '_ownProps' and p.value = ?
        union
        select m.block as id from ${P} m join ${B} b on b.id = m.block and b.deleted is null
          where m.name = '_tags' and m.value in (
            select '"' || d.block || '"' from ${P} d where d.name = '_fieldDefs' and d.value = ?
          )`,
        [plan.name, `"${plan.name}"`, `"${plan.name}"`],
      )
    case 'kind':
      return wrap(`select id from ${B} where kind is not null and deleted is null`, [])
    case 'aliased':
      return wrap(
        `select distinct a.block as id from ${A} a join ${B} b on b.id = a.block and b.deleted is null`,
        [],
      )
    case 'tagged':
      return wrap(
        `select distinct p.block as id from ${P} p join ${B} b on b.id = p.block and b.deleted is null where p.name = '_tags'`,
        [],
      )
    case 'journalDay':
      return wrap(`select id from ${B} where date = ? and deleted is null`, [plan.date])
    case 'parents':
      return wrap(
        `select distinct b.parent as id from ${B} b where b.parent is not null and b.deleted is null`,
        [],
      )
    case 'text':
      return plan.nonempty === true
        ? wrap(
            `select b.id as id from ${B} b where b.deleted is null and exists (
              select 1 from json_each(b.content) j
              where json_extract(j.value,'$.t') = 'text' and trim(json_extract(j.value,'$.v')) <> ''
            )`,
            [],
          )
        : wrap(
            `select b.id as id from ${B} b where b.deleted is null and exists (
              select 1 from (
                select group_concat(json_extract(j.value,'$.v'), '') as txt
                from json_each(b.content) j where json_extract(j.value,'$.t') = 'text'
              ) where instr(txt, ?) > 0
            )`,
            [plan.needle],
          )
    case 'descendantsOf': {
      const inner = candidatePlanSql(plan.plan)
      return wrap(
        `with m(id) as (${inner.sql}), sub(id) as (
          select id from m union select c.id from ${B} c join sub s on c.parent = s.id
        )
        select id from sub`,
        inner.params,
      )
    }
    case 'ancestorsOf': {
      const inner = candidatePlanSql(plan.plan)
      return wrap(
        `with m(id) as (${inner.sql}), anc(id) as (
          select id from m union select b.parent from ${B} b join anc a on b.id = a.id where b.parent is not null
        )
        select id from anc`,
        inner.params,
      )
    }
    case 'near': {
      const inner = candidatePlanSql(plan.plan)
      return wrap(
        `with m(id) as (${inner.sql}), all_(id) as (
          select id from m
          union select b.parent from ${B} b join all_ a on b.id = a.id where b.parent is not null
          union select c.id from ${B} c join all_ a on c.parent = a.id
        )
        select id from all_`,
        inner.params,
      )
    }
    case 'all': {
      if (plan.plans.length === 0) return candidatePlanSql({ k: 'visible' })
      const parts = plan.plans.map(candidatePlanSql)
      return wrap(
        parts.map((p) => `select id from (${p.sql})`).join(' intersect '),
        parts.flatMap((p) => p.params),
      )
    }
    case 'any': {
      if (plan.plans.length === 0) return candidatePlanSql({ k: 'none' })
      const parts = plan.plans.map(candidatePlanSql)
      return wrap(
        parts.map((p) => `select id from (${p.sql})`).join(' union '),
        parts.flatMap((p) => p.params),
      )
    }
  }
}
