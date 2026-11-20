/**
 * **派生表的具名写计划**：把「改一片派生化位置」表达成主进程能执行的 SQL。
 *
 * ## 为什么是「计划」而不是行写入
 *
 * 行写入（`RowWrite`）按主键逐行说「这一行现在是什么」，适合渲染器**认识**的行
 * （新块的 index 行、按 id 重铺的属性行）。但有一类改动**渲染器不认识那些行**：
 *
 *   · 重编号把兄弟的段值改了 ⇒ 兄弟的**整棵子树的路径前缀**都要跟着改，
 *     而那些子树可能没装载（渲染器拿不到它们的行）；
 *   · 软删／恢复／移出被删祖先 ⇒ `hidden` 要按「自己或祖先被删」逐行重算，
 *     同样覆盖未装载的子孙。
 *
 * 这些改动的共同形状是「**按前缀／按子树整片改**」，而不是「按 id 逐行改」。
 * 把它们塞进行写入，等于让渲染器为一棵没装载的树编造行——那是一份算错的答案。
 *
 * ## 为什么 SQL 住 core、执行住主进程
 *
 * 与 `library-reads.ts` 同一条：**主进程不认块语义**。`recomputeHidden` 里
 * 「自己或祖先被软删 ⇒ hidden」是派生格的**定义**（`derived-rows.ts` 的口径），
 * 属于块语义，只能由 core 写成 SQL 文本、主进程原样执行。参数只有前缀串、块 id
 * 与一个 0/1 位——没有一条能推导出块语义。
 *
 * ## 与内容行同一个事务
 *
 * 计划随 `CommitBatch.plans` 走，主进程在**同一个事务里、行写入之后**执行：
 * `recomputeHidden` 读的 `Block.deleted` 必须是这批已经落盘的值。
 */
import { DB_TABLES } from '../identity/library.ts'

const I = DB_TABLES.blockIndex
const B = DB_TABLES.block

/**
 * 一条派生写计划。
 *
 * 参数**只有字符串与列值**：没有 id 推导，没有「这一块是什么」。哪些行要改由
 * 渲染器算好（前缀串／块 id），怎么改是纯 SQL。
 */
export type DerivedPlan =
  | {
      /**
       * 把一棵子树的路径前缀整体换掉（移动／整层重编号的一支）。
       *
       * `root` 顺手按「新父的 root，没有父就是自己」重写——移动会换顶层祖先，
       * 重编号不会（两种都得到同一个值，不必调用方分辨）。
       */
      p: 'reindexSubtree'
      /** 库里现存的前缀（被移子树当前位置）；新块没有这一段，用插入行 */
      oldPrefix: string
      newPrefix: string
      /** 新父块 id；`null` ＝ 落在森林顶层 */
      parent: string | null
      /** 子树根块 id（`parent` 为 null 时它就是新的 root） */
      block: string
    }
  | {
      /** 清除：整片删行（子树按前缀走，未装载的子孙也一起删） */
      p: 'dropSubtree'
      prefix: string
    }
  | {
      /**
       * 按「自己或祖先被软删」重算 `hidden`（软删／恢复／移入或移出被删子树）。
       *
       * 逐行算，不是整片翻转：恢复一棵子树时，子树内部**各自被删过**的块
       * 必须保持 `hidden=1`；翻转会把它们一起解封。
       */
      p: 'recomputeHidden'
      block: string
      /** 子树根**之上**的祖先链当前是否 hidden（0/1）；根自己的删除位在 SQL 里读 */
      hiddenAbove: 0 | 1
    }

/**
 * 计划 → SQL。文本里只有表名/列名（来自 `DB_TABLES`）与绑定参数。
 *
 * 参数顺序与 `derivedPlanParams` 逐字对齐——两处必须一起改。
 */
export const DERIVED_PLAN_SQL = {
  /**
   * **前缀匹配用范围谓词，不用 `LIKE`**：SQLite 默认 `LIKE` 大小写不敏感，
   * `path like ?1 || '%'` 吃不到 `idx_BlockIndex_path` 的范围查找，会退化成
   * 整条索引扫描（实测 `EXPLAIN` 是 SCAN）。派生路径只含 `/` 与数字，
   * `prefix <= path < prefix || '~'` 与「前缀」逐条等价（`~` 比路径段的所有字符都大）。
   */
  reindexSubtree: `update ${I}
      set path = ?2 || substr(path, length(?1) + 1),
          root = coalesce((select r.root from ${I} r where r.block = ?3), ?4)
    where path >= ?1 and path < ?1 || '~'`,

  dropSubtree: `delete from ${I} where path >= ?1 and path < ?1 || '~'`,

  recomputeHidden: `with recursive sub(id, h) as (
      select i.block, case when b.deleted is not null or ?2 = 1 then 1 else null end
        from ${I} i join ${B} b on b.id = i.block where i.block = ?1
      union all
      select c.id, case when c.deleted is not null or sub.h = 1 then 1 else null end
        from ${B} c join sub on c.parent = sub.id
    )
    update ${I} set hidden = (select sub.h from sub where sub.id = ${I}.block)
    where block in (select id from sub)`,
} as const

/** 一段路径段：定宽偏置的十进制（与 `derived-rows.ts` 的编码同一形状） */
const PATH_RE = /^(?:\/\d{13})+\/$/

/** 谓词：这条串是不是一条派生路径（前缀也只可能是这个形状） */
export function isDerivedPath(v: unknown): v is string {
  return typeof v === 'string' && PATH_RE.test(v)
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v !== ''
}

/**
 * IPC 参数的形状校验：只认这三种计划、只认它们的参数类型与前缀形状。
 *
 * 不做「这条前缀在库里存不存在」的判断（那要查库，且它不是安全问题）。
 * 校验的意义是「计划只有这三个方向」，不是替代编码层。
 */
export function isDerivedPlan(v: unknown): v is DerivedPlan {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const p = v as Record<string, unknown>
  switch (p.p) {
    case 'reindexSubtree':
      return (
        isDerivedPath(p.oldPrefix) &&
        isDerivedPath(p.newPrefix) &&
        (p.parent === null || isId(p.parent)) &&
        isId(p.block)
      )
    case 'dropSubtree':
      return isDerivedPath(p.prefix)
    case 'recomputeHidden':
      return isId(p.block) && (p.hiddenAbove === 0 || p.hiddenAbove === 1)
    default:
      return false
  }
}

/** 计划 → 绑定参数（顺序与 `DERIVED_PLAN_SQL` 的占位符逐字对齐） */
export function derivedPlanParams(plan: DerivedPlan): (string | number | null)[] {
  switch (plan.p) {
    case 'reindexSubtree':
      return [plan.oldPrefix, plan.newPrefix, plan.parent, plan.block]
    case 'dropSubtree':
      return [plan.prefix]
    case 'recomputeHidden':
      return [plan.block, plan.hiddenAbove]
  }
}
