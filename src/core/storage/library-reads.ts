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
/** 派生两表（候选面换源用：关系边与物化的位置/可见性） */
const R = DB_TABLES.blockRelation
const I = DB_TABLES.blockIndex
/** 子串索引与正文索引行（rowid 同址；见 `BlockGram` 的表注释） */
const G = DB_TABLES.blockGram
const M = DB_TABLES.blockFtsMap

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
  /**
   * 子树里的地址行。`norm` 与主键一起取：一行的形状只有一份答案
   * （写入侧 `db-rows.ts` 的 `aliasRows` 也是这四格），读回来与写出去不会长出两种行。
   */
  docAliases: `select name, block, pos, norm from ${A} where block in (select value from json_each(?1))`,

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
   * **一窗 Doc**（按派生路径区间的 DFS 前缀）：巨大 Doc 的分段装载单位。
   *
   * 区间是「root 的 path 前缀」：`path >= rootPath` 且 `path < rootPath || '~'`——
   * 段是定宽数字，兄弟的 path 不会以本段的 path 开头，而子代的 path 一定以
   * `rootPath + '/'` 开头（`'/'` < `'~'`）。游标是上一窗最后一条的 path，
   * 所以同一条 SQL 一页页往前推，不用 offset（编辑时不会跳行）。
   *
   * 多带一列 `path`：它是下一窗的游标，`rowsToWorkspace` 不认这列、会忽略它。
   */
  /**
   * **一窗 Doc**：路径区间 ＋ **root 列**双重限定。
   *
   * 只按路径前缀取会信任「顶层根的段值互不相同」；派生表一旦被重建/迁移写坏
   * （所有顶层根同段），一次打开任何页都会把整库读回来。`root` 是每行自己记的
   * 顶层祖先，加了它，窗口在任何索引状态下都不会跨根。
   */
  docWindow: `select ${BLOCK_COLUMNS}, i.path as path from ${B} b join ${I} i on i.block = b.id
    where i.path >= ?1 and i.path < ?2 and i.path > ?3 and i.root = ?5
    order by i.path
    limit ?4`,

  /**
   * 一块的**派生位置**（窗口区间的起点 ＋ 它自己的顶层祖先）。
   *
   * `root` 与 `path` 一起取：被打开的块不一定是顶层（页可以住在别的块下面），
   * 而 `root` 列记的是每行自己的顶层祖先——窗口 SQL 要按它过滤，才覆盖得到这一棵。
   *
   * 没有行 ＝ 派生表还没铺到它（重建未完成／新块）：调用方回退整棵读，不猜。
   */
  indexPathOf: `select path, root from ${I} where block = ?1`,

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
   * **全局身份块**（catalog 的块对象面）：页/标签露面、字段定义、自动化、回收站根。
   *
   * catalog 摘要（§`catalogTags` 等）只回答 id 与名字；选择器、页清单、回收站卡
   * 要的是**块对象**。这一批是「库的身份清单」——体量跟身份数走，不跟块数走
   * （1M 块的库通常几千个身份）。装载后 `kb.pages()/tags()/propDefs()/trash()/automations()`
   * 这些同步全局读在工作集模式下依然正确。
   *
   * ⚠️ **自动化块必须在这一批里**：它物化在顶层、不属于任何视图子树，doc 与闭包装载
   *    永远碰不到它（`_automation` 也不是 `Block` 的列，只住在属性行里）。漏了这一段，
   *    「目录 · 自动化」与命令面板的投影就只看得到恰好被打开过的那几块——多数时候一条都没有。
   *
   * ⚠️ **四段 `union` 而不是一个 `or`**：`OR` 会让 SQLite 放弃各段的索引
   *    （`deleted`／`kind` 的 partial index、`BlockList.list`、`BlockProperty(name,value)`），
   *    退化成全表扫描＋逐行相关子查询；拆成并集后每段各吃自己的索引。
   *    `union`（不是 `union all`）顺带去掉一块既是页又是标签、或已删的自动化这类重复行。
   */
  catalogIdentity: `select ${BLOCK_COLUMNS} from ${B} b where b.deleted is not null
    union
    select ${BLOCK_COLUMNS} from ${B} b where b.kind is not null
    union
    select ${BLOCK_COLUMNS} from ${B} b join ${L} l on l.block = b.id where l.list in ('page','tag')
    union
    select ${BLOCK_COLUMNS} from ${B} b join ${P} p on p.block = b.id where p.name = '_automation'`,

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

  /**
   * **入向关系按目标批查**（引用角标的全库计数；派生表 ready 后才可读）。
   *
   * 只收**此刻在树上可见的来源块**：
   *   · 来源自己没被软删；
   *   · 它的来源根仍是一个活着的顶层块 —— 父块被清除后留下的孤儿子树，
   *     `from_root` 指向一个已经不存在的 id，这些边在内存读面（`relationsTo`）
   *     根本不存在，角标却会照表计数，两个数字就对不上。
   *
   * 判据只读**内容表**（`deleted`／`parent`），不回查 `BlockIndex`：派生索引自己
   * 也可能缺行（新根还没铺上），拿它当可见性会反过来把真边滤掉。
   */
  relationsFor: `select r.to_id, r.from_id, r.kind, r.from_root, r.count from BlockRelation r
    where r.to_id in (select value from json_each(?1))
      and exists (select 1 from ${B} src where src.id = r.from_id and src.deleted is null)
      and exists (select 1 from ${B} root where root.id = r.from_root and root.parent is null and root.deleted is null)`,

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

  /**
   * **顶层根清单**（派生表流式重建的装载单位；含软删根——它们的行也要 hidden=1）。
   *
   * 带 `left` 而不是 `order by rowid`：rowid 是**创建序**，后建的根可以搬到最前面，
   * 而派生路径的顶层段必须按**文档序**（兄弟链）分配。排序在 `readRootIds` 里按链走，
   * 不写成 SQL 的 `order by left`——left 是「前兄弟的 rowid」，它的数值序不等于链序。
   */
  catalogRoots: `select b.id as id, b.left as prev from ${B} b where b.parent is null`,

  /** **FTS 映射按块查**（增量索引不再把整张映射搬进内存）：一块最多几行（每来源一行） */
  ftsMapOf: `select block_id, source, fts_rowid from ${DB_TABLES.blockFtsMap}
    where block_id in (select value from json_each(?1))`,

  /**
   * **子串命中按块查**（`{text}` 的无命中／稀疏一档）。
   *
   * 参数是已经包成短语的 `MATCH` 表达式（`core/search/grams.ts` 产），条数上限由
   * 调用方给：读它的人要的从来不是「一共多少」，而是「有没有、有没有超过一页」。
   * 只认 `content` 来源——子串索引只给正文建行（地址／标签那几行不是「正文」，
   * `{text}` 的判据也只看正文投影）。
   */
  gramMatch: `select m.block_id as block from ${M} m
    join ${G} on ${G}.rowid = m.fts_rowid
    where m.source = 'content' and ${G} match ?1
    limit ?2`,

  /**
   * 子串命中的候选页（按文档序）：命中集不超过一页时，一页就是全部候选。
   * `?1` 是 id JSON 数组；游标条件单独一条 SQL（`OR` 会让 SQLite 放弃 path 索引）。
   */
  idsByPath: `select i.block as id, i.path as path from ${I} i
    where i.hidden is null and i.block in (select value from json_each(?1))
    order by i.path`,
  idsByPathAfter: `select i.block as id, i.path as path from ${I} i
    where i.hidden is null and i.block in (select value from json_each(?1))
      and i.path > ?2
    order by i.path`,

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
   * **按名点查归属**（归一化键 → 块）：创建路径的防重判据。
   *
   * 打字里出现的 `#名字`／`[[名字]]` 在本地工作集里 miss 时，不能当成「库里没有」
   * 去新建：名字可能属于一个还没加载的块，新建就是第二个同名身份。这一条回答
   * 「这个名字已经归谁」——不是全表，只问这一批名字。
   *
   * 参数是**归一化后的名字**（`normalizeAlias`，与写入 `norm` 列的是同一个函数）；
   * `order by block, pos` 让「归一化后撞在一起的历史脏数据」也按同一顺序取第一个
   * （以前在 JS 里建表时就是这条次序）。不过滤 `deleted`：回收站里的名字仍算被占。
   */
  aliasTargets: `select norm, block from ${A}
    where norm in (select value from json_each(?1))
    order by block, pos`,

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

/**
 * **一窗 Doc**：与整棵读同一形状，外加下一页的游标。
 *
 * `next === null` ＝ 这一窗就是全部（小 Doc 与整棵读逐字相同）；否则调用方拿它
 * 继续要下一窗，直到 `null`。游标对调用方是不透明的（形态由实现定）。
 */
export type LibraryDocWindow = LibraryDocRows & { next: string | null }

export type CatalogJournal = { id: string; date: string; deleted: number | null }
export type CatalogTag = { id: string; name: string }
export type CatalogPropDef = { id: string; kind: string; name: string | null }
export type CatalogTrashRoot = { id: string; deleted: number }
/** 一条「这个名字归谁」的行：`norm` 是归一化后的键（查询参数与它同一个派生函数） */
export type AliasTarget = { norm: string; block: string }

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
    /** 派生路径的编码版本（`DERIVED_PATH_VERSION`）：与当前不符 ⇒ path 不可按文档序用 */
    derivedPathVersion: string
  }
  journals: CatalogJournal[]
  tags: CatalogTag[]
  propDefs: CatalogPropDef[]
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
 * 全库收窄到「值得装载的那一批」。收窄不了的形状（`not`／方向原子／`prop exists:false`）
 * 给 `visible`（全部可见块）——正确性优先，成本随命中面走，这是已登记的代价。
 *
 * 计划由 `query-candidates.ts` 从条件树编译；这里只有「计划 → SQL」的投影，
 * 与具名查询同一层（主进程执行，不解释块语义）。
 */
export type CandidatePlan =
  | { k: 'none' }
  | { k: 'visible' }
  | { k: 'ids'; ids: string[] }
  /**
   * 标签成员（matcher 的 `{tag}` 是**整份 where 的并集**）。
   *
   * `expand` 只由编译器给（块语义）：**全部分支都是 `desc:true`** 时为真（要连子标签成员）；
   * 有任一分支不带 `desc` 时为假（只取直接成员）——两者混在一起时给 `true`（超集）。
   */
  /**
   * 标签成员并集（matcher 读的是整份 where 的并集）。
   *
   * `expand`／`allDesc` 都只由编译器给（块语义）：**任一**分支要子标签 ⇒ 候选必须展开；
   * **全部**分支都要子标签 ⇒ 展开支才可能「精确」（见 `planIsExact`）。
   */
  | { k: 'tags'; ids: string[]; expand: boolean; allDesc: boolean }
  | { k: 'list'; list: 'page' | 'tag' }
  | { k: 'journal' }
  | { k: 'note' }
  | { k: 'ref'; to?: string; kinds: string[] }
  | { k: 'prop'; name: string }
  | { k: 'kind' }
  /**
   * **有 `_query`（查询视图块）**——`b.query` 是 `_query` 升出来的列。
   *
   * ⚠️ 这是 matcher 的**真超集**：`_query` 的读侧刻意不判 corrupt（旧条件读不出是
   * 设计的降级态），所以「列非空但 props 里读不出条件」的块合法存在。⇒ 它**不进**
   * `planIsExact` 的精确集（否则否定差集会从合法超集里挖掉命中行）。
   */
  | { k: 'query' }
  | { k: 'aliased' }
  | { k: 'tagged' }
  | { k: 'journalDay'; date: string }
  | { k: 'parents' }
  | { k: 'text'; needle: string; nonempty?: boolean }
  /**
   * **正文里有一段 run 的 marks 盖住 `marks`**（子集匹配，与 matcher 同一条判据）。
   *
   * `marks` 由编译器按 `normMarks` 归一过：键只有已知的格式轴，布尔轴是 `true`，
   * 值轴是槽名／hex 字面。空对象＝「有任何带格式的 run」（与 matcher 的循环同解）。
   *
   * 为什么这一条能进 SQL：判定是**单个 run 内部**的键值比较，SQL 用 `json_each`
   * 逐 run 问同一组键即可，不需要跨 run 聚合（跨 run 才是「红字 ＋ 加粗」误配的来源）。
   */
  | { k: 'mark'; marks: Record<string, true | string> }
  /**
   * **正文里有外链 run**。`url` 只用于「此计划不精确」的判定，**不参与 SQL**：
   * SQLite 的 `lower()` 只折 ASCII，JS 的 `toLowerCase()` 折 Unicode（带点的土耳其大写
   * `İ`、开尔文符号这类逐码位不同），在 SQL 里按 url 窄化会**漏掉 matcher 认的命中**。
   * ⇒ SQL 只收窄到「有外链」，url 比对留给 matcher（超集契约不许猜）。
   */
  | { k: 'link'; url?: string }
  | { k: 'descendantsOf'; plan: CandidatePlan }
  | { k: 'ancestorsOf'; plan: CandidatePlan }
  | { k: 'near'; plan: CandidatePlan }
  | { k: 'all'; plans: CandidatePlan[] }
  | { k: 'any'; plans: CandidatePlan[] }
  /**
   * **否定**：可见块减去子计划。只有当子计划**精确**时才真的减（`planIsExact`）——
   * 否则退化成 `visible`（超集契约不允许拿一个会漏行的差集当候选）。
   */
  | { k: 'notIn'; plan: CandidatePlan }

/** IPC 参数的形状校验（只验容器；值是绑定参数，不进 SQL 文本） */
export function isCandidatePlan(v: unknown, depth = 0): v is CandidatePlan {
  if (!isRecord(v) || depth > 32) return false
  switch (v.k) {
    case 'none':
    case 'visible':
    case 'kind':
    case 'query':
    case 'aliased':
    case 'tagged':
    case 'parents':
      return true
    case 'mark':
      return isMarkMap(v.marks)
    case 'link':
      return v.url === undefined || (typeof v.url === 'string' && v.url !== '')
    case 'ids':
      return Array.isArray(v.ids) && v.ids.every((x) => typeof x === 'string')
    case 'tags':
      return (
        Array.isArray(v.ids) &&
        v.ids.every((x) => typeof x === 'string') &&
        typeof v.expand === 'boolean' &&
        typeof v.allDesc === 'boolean'
      )
    case 'list':
      return v.list === 'page' || v.list === 'tag'
    case 'journal':
    case 'note':
      return true
    case 'ref':
      // kinds 进计划而不是留一个默认：`{ref:{kind:'embed'}}` 与 `{ref: X}` 的候选面不同，
      // 而「哪些 kind 算引用」是块语义，只能由编译器给（SQL 只绑定参数）
      return (
        (v.to === undefined || typeof v.to === 'string') &&
        Array.isArray(v.kinds) &&
        v.kinds.length > 0 &&
        v.kinds.every((x) => typeof x === 'string' && x !== '')
      )
    case 'prop':
      return typeof v.name === 'string' && v.name !== ''
    case 'journalDay':
      return typeof v.date === 'string' && v.date !== ''
    case 'text':
      return typeof v.needle === 'string' && (v.nonempty === undefined || v.nonempty === true)
    case 'descendantsOf':
    case 'ancestorsOf':
    case 'near':
    case 'notIn':
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
 * marks 的**线上形状**：键是格式轴（拼进 `$.marks.<轴>` 的路径），值是布尔轴的 `true`
 * 或值轴的槽名／hex 字面。
 *
 * 这里只做**字符集**校验：轴名由编译器按 `normMarks` 过滤（未知轴在计划里就消失），
 * 与 `ids`／`tags` 一样，边界只验容器形状、不复述块的格式表——那张表是块语义。
 */
function isMarkMap(v: unknown): v is Record<string, true | string> {
  if (!isRecord(v)) return false
  const entries = Object.entries(v)
  if (entries.length > 8) return false
  return entries.every(([k, x]) => /^[A-Za-z]+$/.test(k) && (x === true || (typeof x === 'string' && x !== '')))
}

/**
 * `{mark}` 的**行本地谓词**（对 `alias.content` 逐 run 问）。
 *
 * 候选计划与分页查询共用这一份：两处若各写一段，等价性就只能靠人去比对 SQL 文本。
 * 轴路径与值一律**绑定参数**（`json_extract(x, ?)`），键名不进 SQL 文本。
 */
function markPredicate(alias: string, want: Record<string, true | string>): { sql: string; params: (string | number)[] } {
  const params: (string | number)[] = []
  const axes = Object.keys(want).map((k) => {
    params.push(`$.marks.${k}`, want[k] === true ? 1 : (want[k] as string))
    return `json_extract(j.value, ?) = ?`
  })
  // 空 marks ＝「有任何带格式的 run」：matcher 对未指定的轴不参与判定，但要求 run 有 marks
  const cond = axes.length === 0 ? `json_extract(j.value, '$.marks') is not null` : axes.join(' and ')
  return {
    sql: `exists (select 1 from json_each(${alias}.content) j
      where json_extract(j.value, '$.t') <> 'asset' and ${cond})`,
    params,
  }
}

/**
 * `{link}` 的**行本地谓词**：只问「有没有外链 run」，url 不在 SQL 里比（见 `link` 类型的注释）。
 * 要与 `markPredicate` 分开写：matcher 对 link 的判定是「`t:'link'` ＋ url 归一化 contains」，
 * 对 marks 是「run.marks 覆盖 want」——两条判据不是同一个形状的两种拼法。
 */
function linkPredicate(alias: string): string {
  return `exists (select 1 from json_each(${alias}.content) j where json_extract(j.value, '$.t') = 'link')`
}

/**
 * `{prop … exists}` 的**行本地谓词**：三条来源各问一次（与 `candidatePlanSql` 的三支同集）。
 *
 * 只在计划「稠密」时才用它（见 `PageSqlOpts.dense`）：稀疏集合上沿路径序扫到凑够一页
 * 比物化一份小计划贵两个数量级（1M 实测 0.1% 密度：5.7ms → 183ms/页）。
 */
function propExistsPredicate(name: string): { sql: string; params: (string | number)[] } {
  return {
    sql: `(exists (select 1 from ${P} p where p.block = b.id and p.name = ?)
        or exists (select 1 from ${P} p where p.block = b.id and p.name = '_ownProps' and p.value = ?)
        or exists (select 1 from ${P} m where m.block = b.id and m.name = '_tags' and m.value in (
             select '"' || d.block || '"' from ${P} d where d.name = '_fieldDefs' and d.value = ?)))`,
    params: [name, `"${name}"`, `"${name}"`],
  }
}

/** `{tagged}` 的行本地谓词：一条露面行（`BlockList` 的 PK 是 `(block, list)`，逐块是索引探针） */
function taggedPredicate(): string {
  return `exists (select 1 from ${L} l where l.block = b.id)`
}

/** `{aliased}` 的行本地谓词：一条地址行（`block` 有索引） */
function aliasedPredicate(): string {
  return `exists (select 1 from ${A} a where a.block = b.id)`
}

/**
 * `{text}` 的**行本地谓词**：text run 的投影里包含这一串（与 matcher 的
 * `plainText(content).includes(needle)` 同解：只取 `t:'text'` 的 run，按序拼）。
 * 两条形态（含某串／有正文）共用这一份，避免「候选 SQL」与「分页 SQL」各写一遍。
 */
function textPredicateOf(
  alias: string,
  plan: { needle: string; nonempty?: boolean },
): { sql: string; params: (string | number)[] } {
  if (plan.nonempty === true) {
    return {
      sql: `exists (select 1 from json_each(${alias}.content) j
        where json_extract(j.value,'$.t') = 'text' and trim(json_extract(j.value,'$.v')) <> '')`,
      params: [],
    }
  }
  return {
    sql: `exists (select 1 from (
        select group_concat(json_extract(j.value,'$.v'), '') as txt
        from json_each(${alias}.content) j where json_extract(j.value,'$.t') = 'text'
      ) where instr(txt, ?) > 0)`,
    params: [plan.needle],
  }
}

/**
 * 正文串 → 子串索引的 `MATCH` 表达式；`null` ＝ 这张索引答不了，调用方退回整库扫。
 *
 * 三条边界，缺一条就会**静默丢结果**（索引是候选：漏给就是漏行）：
 *
 *   · **至少三个码点**：trigram 把正文拆成三字滑窗，两个字的串进不了索引。按码点
 *     数而不是 `String.length`：一个表情符号是两个 UTF-16 单元、一个码点，按 length
 *     判会把两码点当三码点，`MATCH` 恒不命中。
 *   · **至少一个非空白字符**：正文投影为空白的块不产索引行（与词级索引同一条
 *     「空文本不产行」）。而「全是空白」的块只可能命中「全是空白」的串——那一档
 *     退回整库扫，索引不替它担保。
 *   · **整串当短语**：`"…"` 里的一切都是字面量（引号自己加倍），于是它恰好是
 *     「连续子串」而不是「这些词都出现」。
 *
 * 大小写／变音符：trigram 默认做 ASCII 大小写折叠，比 matcher 的逐字符比较**宽**
 * ——候选宁可多给。正因如此它只能当候选，不能拿去当否定的减数。
 */
export function gramQueryOf(needle: string): string | null {
  if ([...needle].length < 3) return null
  if (needle.trim() === '') return null
  return `"${needle.replaceAll('"', '""')}"`
}

/**
 * 计划里**必须成立**的正文串（`all` 链上的 `text` 节点）。
 *
 * 只有落在合取链上的条件才是「每条命中都得满足」：析取项的判定是「任一成立」，
 * 差集的减数根本不描述命中。拿这两种当筛选条件会**漏行**——而子串索引的快路
 * 正是以「命中 ⊆ 这份命中的超集」为前提的。
 *
 * 与 `pushdownOf` 同一条遍历口径（只下潜 `all`）：两处判据必须认同一批节点，
 * 否则「能下推的谓词」与「能短路的条件」会给出两套答案。
 */
export function necessaryTextNeedles(plan: CandidatePlan): string[] {
  if (plan.k === 'text') return plan.nonempty === true ? [] : [plan.needle]
  if (plan.k === 'all') return plan.plans.flatMap(necessaryTextNeedles)
  return []
}

/**
 * 一页候选的 SQL 选项。
 *
 * `dense` 是**执行侧**才有的知识（取计划前 N 行要多久／有多少行）：索引驱动的子计划
 * 只有在结果集超过一页时才值得下推。缺省（不传）＝不猜，一律走 `in (plan)`——
 * 与这一档出现之前的行为逐条相同。
 */
export interface PageSqlOpts {
  derived?: boolean
  dense?: (plan: CandidatePlan) => boolean
}

/**
 * **能下推进页查询的部分**：返回「必要条件谓词」＋「剩下的计划」＋「谓词要不要 Block 表」。
 *
 * 判据是单调的：`all` 的每个子条件都是整体成立的必要条件 ⇒ 把子条件里能写成
 * **行本地谓词**的那些 AND 进页查询，剩下的仍交给 `in (plan)`——两者合起来仍与整份
 * 计划同集（只是让 path 序能提前停，不必每页把整份计划物化一遍）。
 *
 * 两处「谓词」的来源：
 * - `mark`／`link`：读正文（要 `Block b`）；
 * - `notIn`（子计划精确时）：`i.block not in (<子计划>)`，只读 `BlockIndex i`。
 *   `all` 里出现 `{not: …}` 就是这个形状（`{tag:X}` 且不是某一块）。
 *
 * `any` 的析取项不是必要条件；方向原子／`near` 的集合是递归闭包，写不成行本地谓词。
 *
 * **下推只收「内容谓词」**（`text`／`mark`／`link`）：它们的计划形态本来就要扫一遍正文，
 * 下推只可能赢。`prop`／`tagged`／`aliased` 这类**索引驱动**的计划要看**基数**：
 * 计划形态的成本跟结果集大小走，下推按「扫到凑够一页」计价 —— 稠密时下推碾压
 * （1M、20% 密度：278ms → 1.2ms/页），稀疏时反过来（0.1%：5.7ms → 183ms/页）。
 * 所以这三支只在 `opts.dense(plan)` 说「超过一页」时才下推；判据由执行侧给
 * （它才拿得到「取前 N 行要多久」），这一层只做选择。
 */
function pushdownOf(plan: CandidatePlan, opts: PageSqlOpts): {
  preds: { sql: string; params: (string | number)[] }[]
  rest: CandidatePlan | null
  needsBlock: boolean
} {
  if (plan.k === 'mark') return { preds: [markPredicate('b', plan.marks)], rest: null, needsBlock: true }
  if (plan.k === 'link') return { preds: [{ sql: linkPredicate('b'), params: [] }], rest: null, needsBlock: true }
  if (plan.k === 'prop' && opts.dense?.(plan) === true) {
    return { preds: [propExistsPredicate(plan.name)], rest: null, needsBlock: true }
  }
  if (plan.k === 'tagged' && opts.dense?.(plan) === true) {
    return { preds: [{ sql: taggedPredicate(), params: [] }], rest: null, needsBlock: true }
  }
  if (plan.k === 'aliased' && opts.dense?.(plan) === true) {
    return { preds: [{ sql: aliasedPredicate(), params: [] }], rest: null, needsBlock: true }
  }
  /**
   * `text` 也下推：它的谓词本来就是**单块内部**的投影比较。计划形态要为「所有命中」
   * 扫一遍全库才出第一页；下推后沿 path 序扫、凑够一页就停——常见串从 1.7s/页降到
   * 亚毫秒，**没有命中的串仍是整库扫**（那一档不变，见决策档的代价表）。
   */
  if (plan.k === 'text') {
    return { preds: [textPredicateOf('b', plan)], rest: null, needsBlock: true }
  }
  if (plan.k === 'notIn') {
    // 不精确的子计划不能减（与 `candidatePlanSql` 同一条守卫）——那就整份退回去走 `in (plan)`
    if (!planIsExact(plan.plan, true)) return { preds: [], rest: plan, needsBlock: false }
    const inner = candidatePlanSql(plan.plan, { derived: true })
    return {
      preds: [{ sql: `i.block not in (${inner.sql})`, params: inner.params }],
      rest: null,
      needsBlock: false,
    }
  }
  if (plan.k === 'all') {
    const preds: { sql: string; params: (string | number)[] }[] = []
    const rest: CandidatePlan[] = []
    let needsBlock = false
    for (const p of plan.plans) {
      const part = pushdownOf(p, opts)
      preds.push(...part.preds)
      needsBlock = needsBlock || part.needsBlock
      if (part.rest !== null) rest.push(part.rest)
    }
    return { preds, rest: rest.length === 0 ? null : rest.length === 1 ? rest[0]! : { k: 'all', plans: rest }, needsBlock }
  }
  return { preds: [], rest: plan, needsBlock: false }
}

/**
 * 计划 → SQL。参数一律匿名 `?`、按文本出现顺序绑定（嵌套计划的参数先深后浅拼在后面）。
 *
 * 计划是超集 ⇒ 这里的 SQL **宁可多给**：`instr`／值比较这类窄化都不做
 * （值在行里是 JSON 编码，按编码值窄会漏掉跨行拼接的命中），交给 matcher 判。
 *
 * `opts.derived` ＝ **派生两表可信**（`derived_state === 'ready'`）。它只决定「收窄得多准」，
 * 不决定语义——两种模式都必须 ⊇ 真命中：
 *
 *   · 可信：`ref` 读 `BlockRelation`（行内／属性／嵌入三类边都在这张表里；旧的 content
 *     扫描只认行内 run，**不是超集**——属性指向与嵌入的源块会被静默丢掉），可见性读
 *     物化的 `BlockIndex.hidden`（逐行的「自己或祖先被删」）。
 *   · 不可信：`ref` 退回 `visible`（宽，但真）；可见性退回根上的 `deleted` 位
 *     （软删页的后代仍算候选，多给不少给）。
 */
export function candidatePlanSql(
  plan: CandidatePlan,
  opts: { derived?: boolean } = {},
): { sql: string; params: (string | number)[] } {
  const derived = opts.derived === true
  const wrap = (inner: string, params: (string | number)[]): { sql: string; params: (string | number)[] } => ({ sql: inner, params })
  /** 「这一块可见」：可信时问物化的 hidden，否则问根上的 deleted 位（超集：软删页的后代也算） */
  const visible = (alias: string): string =>
    derived ? `exists (select 1 from ${I} v where v.block = ${alias}.id and v.hidden is null)` : `${alias}.deleted is null`
  switch (plan.k) {
    case 'none':
      return wrap('select null as id where 0', [])
    case 'visible':
      return derived
        ? wrap(`select block as id from ${I} where hidden is null`, [])
        : wrap(`select id from ${B} where deleted is null`, [])
    case 'ids':
      // json_each 吃 JSON 文本（与 docSubtree 同一条绑定口径）
      return wrap('select value as id from json_each(?)', [JSON.stringify(plan.ids)])
    case 'tags':
      /**
       * 标签成员并集（matcher 的 `{tag}` 读的就是**整份 where 的并集**）。
       *
       * `expand` 决定子标签是否展开：matcher 不带 `desc` 时**只认直接成员**
       * （`tagMemberIds` / `hasTag`），带上 `desc` 才沿标签树取闭包（`membersOf`）。
       * 旧版无条件展开 ⇒ 直接成员的查询会多装一批子标签成员（超集、不丢行，但白装），
       * 而且那份多出来的集合让「否定」没法安全地减（`planIsExact`）。
       */
      return plan.expand
        ? wrap(
            `with recursive tags(id) as (
              select value from json_each(?)
              union
              select p.block from ${P} p join tags t on p.name = '_belongsTo' and p.value = '"' || t.id || '"'
            )
            select distinct m.block as id from ${P} m
              join tags on m.name = '_tags' and m.value = '"' || tags.id || '"'
              join ${L} l on l.block = tags.id and l.list = 'tag'
              join ${B} b on b.id = m.block and ${visible('b')}`,
            [JSON.stringify(plan.ids)],
          )
        : wrap(
            `select distinct m.block as id from ${P} m
              join ${B} b on b.id = m.block and ${visible('b')}
             where m.name = '_tags'
               and m.value in (
                 select '"' || l.block || '"' from ${L} l
                  where l.list = 'tag' and l.block in (select value from json_each(?))
               )`,
            [JSON.stringify(plan.ids)],
          )
    case 'list':
      return wrap(
        `select l.block as id from ${L} l join ${B} b on b.id = l.block where l.list = ? and ${visible('b')}`,
        [plan.list],
      )
    case 'journal':
      return wrap(`select b.id as id from ${B} b where b.date is not null and ${visible('b')}`, [])
    case 'note':
      return wrap(
        `select p.block as id from ${P} p join ${B} b on b.id = p.block and ${visible('b')} where p.name = '_annotates'`,
        [],
      )
    case 'ref': {
      if (!derived) return candidatePlanSql({ k: 'visible' }, opts)
      const kinds = JSON.stringify(plan.kinds)
      return plan.to === undefined
        ? wrap(
            `select distinct r.from_id as id from ${R} r
              where r.kind in (select value from json_each(?))`,
            [kinds],
          )
        : wrap(
            `select distinct r.from_id as id from ${R} r
              where r.to_id = ? and r.kind in (select value from json_each(?))`,
            [plan.to, kinds],
          )
    }
    case 'prop':
      // 「有这一栏」＝ 值 ∪ 自有槽 ∪ 标签声明（matcher 的 readField 三来源）——
      // 只给「有值行」的块会漏掉标签声明进场的成员，候选就不再是超集。
      // 三支用 `union all`：消费方是 `in`／`not in`（天然去重）与「取前 N 行」的
      // 基数探针；去重版会让探针把整份计划排一遍（1M 实测 154ms → 0.04ms）。
      return wrap(
        `select p.block as id from ${P} p join ${B} b on b.id = p.block and ${visible('b')} where p.name = ?
        union all
        select p.block as id from ${P} p join ${B} b on b.id = p.block and ${visible('b')}
          where p.name = '_ownProps' and p.value = ?
        union all
        select m.block as id from ${P} m join ${B} b on b.id = m.block and ${visible('b')}
          where m.name = '_tags' and m.value in (
            select '"' || d.block || '"' from ${P} d where d.name = '_fieldDefs' and d.value = ?
          )`,
        [plan.name, `"${plan.name}"`, `"${plan.name}"`],
      )
    case 'kind':
      return wrap(`select b.id as id from ${B} b where b.kind is not null and ${visible('b')}`, [])
    case 'query':
      return wrap(`select b.id as id from ${B} b where b.query is not null and ${visible('b')}`, [])
    case 'aliased':
      return wrap(
        `select distinct a.block as id from ${A} a join ${B} b on b.id = a.block and ${visible('b')}`,
        [],
      )
    case 'tagged':
      return wrap(
        `select distinct p.block as id from ${P} p join ${B} b on b.id = p.block and ${visible('b')} where p.name = '_tags'`,
        [],
      )
    case 'journalDay':
      return wrap(`select b.id as id from ${B} b where b.date = ? and ${visible('b')}`, [plan.date])
    case 'parents':
      return wrap(
        `select distinct b.parent as id from ${B} b where b.parent is not null and ${visible('b')}`,
        [],
      )
    case 'text': {
      const p = textPredicateOf('b', plan)
      return wrap(`select b.id as id from ${B} b where ${visible('b')} and ${p.sql}`, p.params)
    }
    case 'mark': {
      const p = markPredicate('b', plan.marks)
      return wrap(`select b.id as id from ${B} b where ${visible('b')} and ${p.sql}`, p.params)
    }
    case 'link':
      return wrap(`select b.id as id from ${B} b where ${visible('b')} and ${linkPredicate('b')}`, [])
    case 'descendantsOf': {
      const inner = candidatePlanSql(plan.plan, opts)
      return wrap(
        `with m(id) as (${inner.sql}), sub(id) as (
          select id from m union select c.id from ${B} c join sub s on c.parent = s.id
        )
        select id from sub`,
        inner.params,
      )
    }
    case 'ancestorsOf': {
      const inner = candidatePlanSql(plan.plan, opts)
      return wrap(
        `with m(id) as (${inner.sql}), anc(id) as (
          select id from m union select b.parent from ${B} b join anc a on b.id = a.id where b.parent is not null
        )
        select id from anc`,
        inner.params,
      )
    }
    case 'near': {
      const inner = candidatePlanSql(plan.plan, opts)
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
      if (plan.plans.length === 0) return candidatePlanSql({ k: 'visible' }, opts)
      const parts = plan.plans.map((p) => candidatePlanSql(p, opts))
      return wrap(
        parts.map((p) => `select id from (${p.sql})`).join(' intersect '),
        parts.flatMap((p) => p.params),
      )
    }
    case 'any': {
      if (plan.plans.length === 0) return candidatePlanSql({ k: 'none' }, opts)
      const parts = plan.plans.map((p) => candidatePlanSql(p, opts))
      return wrap(
        parts.map((p) => `select id from (${p.sql})`).join(' union '),
        parts.flatMap((p) => p.params),
      )
    }
    case 'notIn': {
      /**
       * **只有子计划精确时才真的减**：差集必须保证「被减掉的都是真命中」，
       * 否则会从一个合法超集里挖掉命中行（那正是候选契约禁区）。
       * 不精确 ⇒ 退化成 `visible`（宽但真）。
       */
      if (!planIsExact(plan.plan, derived)) return candidatePlanSql({ k: 'visible' }, opts)
      const inner = candidatePlanSql(plan.plan, opts)
      const all = candidatePlanSql({ k: 'visible' }, opts)
      return wrap(`select id from (${all.sql}) except select id from (${inner.sql})`, [
        ...all.params,
        ...inner.params,
      ])
    }
  }
}

/**
 * **这份计划是否精确**（不多给**可见**块）：判定集 ≡ matcher 的命中集。
 *
 * 只用于「否定的差集」——差集拿一份会漏行的集合去减，就会从合法超集里挖掉命中。
 * 所以这张表**只收能证明的**：能给出「多出来的只可能是不可见块」的才收；
 * 凡是「额外给出的块可能是可见的」一律不收（保守 ⇒ 只影响收窄幅度，不影响正确性）。
 */
function planIsExact(plan: CandidatePlan, derived: boolean): boolean {
  switch (plan.k) {
    // 「是什么」在列/露面/地址上就是判定本身，matcher 与 SQL 问的是同一格
    case 'none':
    case 'ids':
    case 'list':
    case 'journal':
    case 'journalDay':
    case 'note':
    case 'kind':
    case 'aliased':
      return true
    /**
     * ⚠️ **`visible` 不算精确**，哪怕它的集合（可见块）本身就是判定域。
     *
     * 它是「这个形状收窄不了」的**落点**（`prop exists:false`／`text:''`／不认识的 prop id），
     * 这时节点的命中集是全可见块的一个**子集**：计划 ⊋ 命中。
     * 拿它去当差集的减数，会把这些块从「否定」的候选里挖掉——它们恰恰可能命中否定。
     * （`{not:{prop:{id:X, exists:false}}}` 的候选因此是 `visible`，不是空集。）
     */
    case 'visible':
      return false
    /**
     * 直接成员＝matcher 的口径（`tagMemberIds`）。展开支现在也同解：下级标签按 `_belongsTo`
     * 递归（与 `descendantTagIds` 同一条边）、成员只收带 `tag` 露面的下级——由
     * `query-candidates` 的「候选 == 命中」断言钉住（≥3 层、含一个不在上级内容树里的下级）。
     */
    case 'tags':
      return plan.expand ? plan.allDesc : true
    // 「谁是来源」两边同源（关系边）；但不可信时它退化成 `visible`，那就不精确
    case 'ref':
      return derived
    // 「有子级」判可见子块；不可信时（软删页的后代）会多给可见块
    case 'parents':
      return derived
    // 方向原子都**含自己/含兄弟子树**那一半（`up` 含被点名的块、`near` 含兄弟子树）⇒ 多给可见块
    case 'descendantsOf':
    case 'ancestorsOf':
    case 'near':
      return false
    /**
     * 值比较（`prop`）与正文（`text`）的 SQL 都是超集，不是判定。
     *
     * `query` 同理，而且多一层理由：`_query` 的读侧**刻意不判 corrupt**（旧条件读不出
     * 是设计的降级态），所以「列非空但 props 里读不出条件」的块合法存在 ⇒ 列非空 ⊋
     * `isQueryBlock`。拿它去减，会把那些块从否定查询的候选里挖掉。
     */
    case 'prop':
    case 'text':
    case 'query':
    /**
     * **`tagged` 不能当差集的减数**：候选问「有没有 `_tags` 这一行」，matcher 问
     * 「有没有**活**标签」。死标签 id 是合法状态（删标签不摘引用），所以「行在、
     * 标签全死」的块会被候选选中、却不被 matcher 命中——拿它做 `except` 就把这类块
     * 从「没有活标签」的结果里挖掉了。退化成 `visible`：宽，但真。
     */
    case 'tagged':
      return false
    /**
     * 逐 run 问同一组键值：与 matcher 的判定集同集（可见性两处同源）⇒ 可信时精确。
     * 不可信时可见性退回根上的 `deleted` 位（软删页的后代仍算候选）——多给的是可见块 ⇒ 不精确。
     */
    case 'mark':
      return derived
    // 「有外链」同解；带 url 时 SQL 不比 url（见 `link` 类型的注释）⇒ 只能当超集，不能拿去减
    case 'link':
      return derived && plan.url === undefined
    // 组合：交集/并集在「成员都精确」时精确；差集按构造精确（只在精确时才生效）
    case 'all':
    case 'any':
      return plan.plans.every((p) => planIsExact(p, derived))
    case 'notIn':
      return planIsExact(plan.plan, derived)
  }
}

/* ------------------------------------------------------------ 候选流（分页） */

/** 一页候选的绑定：游标是**上一页最后一条的 path**（keyset，不用 offset） */
export interface CandidatePageQuery {
  /** `null` ＝ 从头（第一页）；否则只取 `path` 严格大于它的 */
  after: string | null
  /** 本页最多取多少条候选（调用方保证 ≥ 1） */
  limit: number
}

/** 一页候选：`next` ＝ 下一页的游标；`null` ＝ 已经到底 */
export interface CandidatePage {
  ids: string[]
  next: string | null
}

/**
 * **计划 → 一页候选的 SQL**（按文档先序的 keyset 分页）。
 *
 * 为什么是 keyset 不是 `offset`：候选集是**超集**、判定在 matcher——分页的单位必须是
 * 「候选流」而不是「结果集」，而流的顺序只有一条稳定判据：`BlockIndex.path`
 * （同一棵有序树的先序）。`offset` 在库被编辑时会跳行或重行，`path > ?` 不会。
 *
 * `opts.derived === false`（派生表不可信）⇒ **一页装完**：没有可信的 path 就没有稳定
 * 游标，返回同一形状（`next: null`）而不是另造一套语义——宽，但真。
 */
export function candidatePageSql(
  plan: CandidatePlan,
  page: CandidatePageQuery,
  opts: PageSqlOpts = {},
): { sql: string; params: (string | number | null)[] } {
  if (opts.derived !== true) {
    const all = candidatePlanSql(plan, { derived: false })
    return { sql: all.sql, params: all.params }
  }
  /**
   * **分页从「路径序扫描」出发，不从「物化候选集」出发。**
   *
   * `i.block in (plan)` 每页都会把整份计划重新物化一遍；对 `visible` 这种「就是外层条件
   * 本身」的计划，那等于每页扫一遍全库再逐个回表排序（1M 实测 495ms/页）。三条直路：
   *
   * - **visible**：页要的就是「可见块按 path 序取 400」——直接走 `idx_BlockIndex_path`；
   * - **行本地谓词**（`mark`／`link`／`notIn`）：把谓词写进 WHERE，凑够一页就停。
   *   谓词与 `candidatePlanSql` 是**同一个 helper** 生成的，不另写一份判据；
   * - 其余（`any`／方向原子／不精确的否定）仍走 `in (plan)`——它们的成本与改动前相同。
   *
   * `all` 里能下推的子条件 AND 进来、剩下的仍走 `in (plan)`（见 `pushdownOf`）。
   */
  /**
   * 不精确的否定在 SQL 里本来就退化成可见集（`candidatePlanSql` 的同一条守卫）——
   * 分页时也走同一条直路，否则「收窄不了」会以「每页物化一份全库」的形式付两次钱。
   */
  const effective: CandidatePlan = plan.k === 'notIn' && !planIsExact(plan.plan, true) ? { k: 'visible' } : plan
  if (effective.k === 'visible') {
    return {
      sql: `select i.block as id, i.path as path
        from ${I} i
       where i.hidden is null
         ${page.after === null ? '' : 'and i.path > ?'}
       order by i.path
       limit ?`,
      params: [...(page.after === null ? [] : [page.after]), page.limit],
    }
  }
  const push = pushdownOf(effective, opts)
  if (push.preds.length > 0) {
    const rest = push.rest === null ? null : candidatePlanSql(push.rest, { derived: true })
    return {
      sql: `select i.block as id, i.path as path
        from ${I} i${push.needsBlock ? ` join ${B} b on b.id = i.block` : ''}
       where i.hidden is null
         ${page.after === null ? '' : 'and i.path > ?'}
         ${rest === null ? '' : `and i.block in (${rest.sql})`}
         ${push.preds.map((p) => `and ${p.sql}`).join(' ')}
       order by i.path
       limit ?`,
      params: [
        ...(page.after === null ? [] : [page.after]),
        ...(rest === null ? [] : rest.params),
        ...push.preds.flatMap((p) => p.params),
        page.limit,
      ],
    }
  }
  const inner = candidatePlanSql(plan, { derived: true })
  /**
   * 游标条件按有无**分别写**，不写成 `(? is null or path > ?)`：OR 会让 SQLite 放弃
   * `idx_BlockIndex_path` 的区间扫描，退化成整表扫 + 排序 —— 那正好抵消分页的意义。
   */
  const after = page.after
  return {
    sql: `select i.block as id, i.path as path
      from ${I} i
     where i.hidden is null
       ${after === null ? '' : 'and i.path > ?'}
       and i.block in (${inner.sql})
     order by i.path
     limit ?`,
    // 文本里的顺序：游标（可无）→ 计划参数 → 本页条数
    params: [...(after === null ? [] : [after]), ...inner.params, page.limit],
  }
}
