/**
 * **接库门面**的形状：一个读入口（`KbClient`）、一个写入口（`tx`），以及两边分家的
 * `Op`（承载持久化）与 `Change`（只做失效通知）。
 *
 * 为什么先立形状再接 SQLite：现在的写路径直接改内存、落盘是整份 JSON，
 * 一旦适配器按这个形状写死，「整库 payload ＋ 直接改内存」就会被固化成契约，
 * 后面换成 SQLite 只能重写调用方。先把**读写入口**与**变更形状**立起来，
 * 换实现就只是在 `KbClient` 背后换一个类。
 *
 * 三条口径（与模型层的三条判据同源）：
 *   · 读面**不实现业务派生**：属性行、gutter 行、查询、反链仍是 `core/` 的纯函数，
 *     `MemoryKb` 只是把「整片森林」这个到处传的隐式参数收进自己；
 *   · 写面**只产出 op**：`tx` 成功才给 `{ ops, changes }`，失败整批回滚、不落半批；
 *   · 结构**不许靠 diff 猜**：`patch` 只看正文与属性，子树变化一律要求显式
 *     `insert`／`move`／`remove`——diff 猜出来的结构 op 会漏掉「删了哪些后代」这类事实。
 *
 * ⚠️ 本文件只有类型与常量，零运行时依赖、零 DOM。
 */
import type { BackrefBlock, BackrefSource } from '../backrefs.ts'
import type { GutterField, FieldRow } from '../props.ts'
import type { QueryHit, QuerySpec } from '../query.ts'
import type { Block, BlockList } from '../model.ts'
import type { Anno, Run } from '../runs.ts'

/* ------------------------------------------------------------ 存储槽位 */

/**
 * 属性名的**键空间**分两段：`_` 开头是系统槽（由模型代码解释），
 * 否则是「字段定义块的块 id」。
 *
 * 落库时这两段各走各的路（系统槽升值／升列，字段值走属性行），
 * 所以写入口要能**看见**这个区别，调用方才不必各自判断。
 * 这是写面的事——读面只回答「这块有哪些行」。
 */
export const SYSTEM_PROP_PREFIX = '_' as const

export function isSystemProp(name: string): boolean {
  return name.startsWith(SYSTEM_PROP_PREFIX)
}

/* ------------------------------------------------------------ 写面 */

/**
 * 一个块的**增量补丁**。
 *
 * 结构用 `parent`＋`index` 表达插入与移动（不另造一个 `insert` 事件：
 * 「它现在在哪」是同一件事的两种说法，两个事件就会有两种真相）。
 */
export type BlockPatch = {
  /** 行内内容整组替换（文本/格式/原子改动都是这一条 op） */
  content?: Run[]
  /**
   * 最后一次改动时刻。**必须与 `content` 并进同一条 op**：一次编辑是一条账，
   * 多一个属性写账本就会翻倍（而「这一次改动」本来就只有一个时刻）。
   */
  modified?: number
  parent?: string | null
  index?: number
  props?: Record<string, unknown>
}

/**
 * 一条**持久化 op**。
 *
 * `at` 现在写 `Date.now()`，为将来的 HLC／设备标识留位；它**不参与排序**，
 * 消费者不得靠它重建顺序（顺序由 op 序列本身表达）。
 */
export type Op =
  | { e: 'block'; id: string; op: 'upsert'; value: BlockPatch; at: number }
  | { e: 'block'; id: string; op: 'delete'; at: number }
  | { e: 'prop'; block: string; name: string; op: 'set' | 'delete'; value?: unknown; pos?: number; at: number }
  | { e: 'alias'; block: string; name: string; op: 'set' | 'delete'; pos?: number; at: number }
  | { e: 'list'; block: string; list: BlockList; op: 'set' | 'delete'; at: number }
  | { e: 'anno'; block: string; id: string; op: 'set' | 'delete'; value?: Anno; at: number }

/**
 * 一条**失效通知**：只说「这类对象里的这一条动过」，不带 payload。
 *
 * 索引与视图订阅不该被迫接收大对象（一次打字就会把整块正文推给每个订阅者）；
 * 需要字节的是 `StoragePort`，它只吃 `Op[]`。
 */
export interface Change {
  kind: 'blocks' | 'annos'
  id: string
}

/** `tx` 的调用选项：目前只有「谁发起的」（见 `KbClient.tx`） */
export interface TxOpts {
  source?: unknown
}

/** 一次事务的产出。失败时**什么都不返回**（没有「半批」这种形状） */
export interface TxResult {
  ops: Op[]
  changes: Change[]
}

/**
 * 事务句柄：**唯一**的模型写入口。
 *
 * 每个方法都只声明「发生了什么」，不回答「怎么落」——回落由 `KbClient` 的实现决定
 * （先是内存 ``＋ op 累积，之后是 SQLite）。这也让「失败整批回滚」只有一个落点。
 */
export interface Tx {
  /** 单块 patch（迁移期覆盖现有的 `write(id, mutate)`）：只允许动正文与属性 */
  patch(id: string, fn: (b: Block) => void): void

  /** 插入一棵子树（`block` 自带 children）；`index` 超出范围按末尾处理 */
  insert(block: Block, parentId: string | null, index: number): void
  /** 移动整棵子树（**自己不能移进自己的子树**） */
  move(id: string, parentId: string | null, index: number): void
  /**
   * 删除整棵子树：**原位软删** —— 块带着子树留在树上的原位，打上删除标记；
   * 之后的遍历（读门面的每一条读）都看不见它。
   *
   * op 只落**操作根**一条 `block.delete`：子树的不可见是继承来的，后代不各报一条
   * （落库时这也是一行的事：`deleted_at` 写在根行上；恢复才需要把整棵子树接回来，
   * 而它的行一直都在）。
   */
  remove(id: string): void
  /**
   * 恢复一个被删的块：摘掉它身上的删除标记，块**回到原位**（它从未离开过树）。
   *
   * op 是一条 `block.upsert{parent,index}`——「它回来了、还在这个位置」。
   * 恢复的是操作根：整棵子树随它一起重新可见。
   */
  restore(id: string): void

  /** 写一个属性槽（`pos` ＝ 显示顺序，给「有行未填」的槽位用） */
  setProp(id: string, name: string, value: unknown, pos?: number): void
  clearProp(id: string, name: string): void

  setAliases(id: string, aliases: readonly string[]): void
  setLists(id: string, lists: readonly BlockList[]): void
  setTags(id: string, tagIds: readonly string[]): void

  /**
   * 整块可引用区间替换（只换这一块的，别的块原样）。
   *
   * annos 是**按需物化**的：没有「被引用的区间」就没有 anno，这一格保持空。
   * 空数组 ⇒ 摘掉这一块的全部 annos（属性袋不留空壳的同一条纪律）。
   */
  setAnnos(id: string, annos: readonly Anno[]): void
}

/* ------------------------------------------------------------ 读面 */

/** 一条「有名块」：页／标签列表这种小集合才用；大库时改走 `query` */
export interface PathEntry {
  name: string
  block: Block
}

/**
 * 渲染侧唯一读入口。
 *
 * 判据：**方法只按 id 或子树取，不泄漏「整库在内存」**。
 * 阶段 1 的实现可以整库缓存，但调用方写不出来「遍历全库」——
 * 否则懒加载（P5）那天要改遍每个调用方。
 */
export interface KbClient {
  get(id: string): Block | undefined
  children(id: string): readonly Block[]
  roots(): readonly Block[]
  parentOf(id: string): Block | undefined
  /** 从根到它（含自身）——面包屑；找不到是空数组 */
  pathOf(id: string): readonly Block[]

  /** 按地址找块（先序第一个命中，比较口径只在 `core/alias.ts` 里有一份） */
  resolveAlias(name: string): Block | undefined
  allPaths(): readonly PathEntry[]

  fieldsOf(id: string): readonly FieldRow[]
  gutterFieldsOf(ids: readonly string[]): Map<string, GutterField[]>
  tagsOf(id: string): readonly Block[]

  /** 库里全部属性定义（面板的「添加已有属性」用；顺序就是先序） */
  propDefs(): readonly Block[]
  /** 这个页/标签**声明**的字段（不是值）——声明解析不到的定义跳过 */
  declaredFieldsOf(id: string): readonly Block[]

  /** 库里的页（带 `page` 露面的块，先序；journal 不是页）；页清单是小集合，大库时改走 `query` */
  pages(): readonly Block[]
  /** 库里的标签块（先序）；标签清单是小集合，大库时改走 `query` */
  tags(): readonly Block[]
  /**
   * 回收站（**派生**）：库里所有带删除标记的块（被删子树的操作根，先序）。
   * 没有第二个存放处——这个清单每次从森林现算，恢复经 `Tx.restore` 回原位。
   */
  trash(): readonly Block[]
  /** 这个名字现在归哪个**标签块**（找不到 ≠ 没有同名块——同名地址可能被普通块占着） */
  findTag(name: string): Block | undefined
  /** 某天的 journal 块（一天一个；没有这一天 ⇒ `undefined`） */
  journalDay(date: string): Block | undefined

  /** 这一块当前的可引用区间（通常为空——anno 只在被引用时存在） */
  annosOf(id: string): readonly Anno[]

  query(spec: QuerySpec, opts?: { scopeId?: string; selfId?: string }): QueryHit[]
  backlinksOf(id: string): readonly BackrefSource[]
  /** 引用发生处的**块**（不是按页聚合）——反链 view block 的行；同一块多处引用各算一条 */
  backrefBlocksOf(id: string): readonly BackrefBlock[]

  /**
   * 写入口：成功返回 `{ ops, changes }`；抛错 ⇒ 整批回滚并重抛（不返回半批）。
   *
   * `opts.source` 是**发起这次写入的视图**，原样转给 `store.touch`（订阅者靠它跳过自己）。
   * 让调用方在事务里声明「我是谁」，比让每个调用点自己再 `touch` 一次安全：
   * 两次 `touch` 会让别的视图白渲染一遍，漏掉一次就让它们停在旧数据上。
   */
  tx<R>(fn: (tx: Tx) => R, opts?: TxOpts): { ops: Op[]; changes: Change[]; result: R }
}
