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
import type { Atom, Mark } from '../annotations.ts'
import type { BackrefSource } from '../backrefs.ts'
import type { GutterField, FieldRow } from '../props.ts'
import type { QueryHit, QuerySpec } from '../query.ts'
import type { Block, BlockList } from '../model.ts'

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
 * 「它现在在哪」是同一件事的两种说法，两个事件就会有两种真相）；
 * `deleted` 表示整棵子树级联删除（落库用递归 CTE）。
 */
export type BlockPatch = {
  text?: string
  parent?: string | null
  index?: number
  props?: Record<string, unknown>
  deleted?: boolean
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
  | { e: 'anno'; block: string; id: string; op: 'set' | 'delete'; value?: Mark | Atom; at: number }

/**
 * 一条**失效通知**：只说「这类对象里的这一条动过」，不带 payload。
 *
 * 索引与视图订阅不该被迫接收大对象（一次打字就会把整块正文推给每个订阅者）；
 * 需要字节的是 `StoragePort`，它只吃 `Op[]`。
 */
export interface Change {
  kind: 'blocks' | 'marks' | 'atoms'
  id: string
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
   * 删除整棵子树：从树上摘下来、打删除标记、放进回收站。
   *
   * 阶段 1 的回收站仍是「摘出来的一列子树」；等块上有了原位删除标记，
   * 这里退化成一次属性写入，op 形状不变。
   */
  remove(id: string): void

  /** 写一个属性槽（`pos` ＝ 显示顺序，给「有行未填」的槽位用） */
  setProp(id: string, name: string, value: unknown, pos?: number): void
  clearProp(id: string, name: string): void

  setAliases(id: string, aliases: readonly string[]): void
  setLists(id: string, lists: readonly BlockList[]): void
  setTags(id: string, tagIds: readonly string[]): void

  /** 整块锚点替换（阶段 1 仍按块分组；只换这一块的，别的块原样） */
  setAnnotations(id: string, marks: readonly Mark[], atoms: readonly Atom[]): void
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

  annotationsOf(id: string): { marks: readonly Mark[]; atoms: readonly Atom[] }

  query(spec: QuerySpec, opts?: { scopeId?: string }): QueryHit[]
  backlinksOf(id: string): readonly BackrefSource[]

  /** 写入口：成功返回 `{ ops, changes }`；抛错 ⇒ 整批回滚并重抛（不返回半批） */
  tx<R>(fn: (tx: Tx) => R): { ops: Op[]; changes: Change[]; result: R }
}
