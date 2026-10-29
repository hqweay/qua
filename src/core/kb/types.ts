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
 * 一个块的**块级格补丁**。
 *
 * 结构用 `parent`＋`prev` 表达插入与移动（不另造一个 `insert` 事件：
 * 「它现在在哪」是同一件事的两种说法，两个事件就会有两种真相）。
 *
 * **新块的 genesis 用同一条 op 说全**：`{parent, prev, created, modified, content}`。
 * 属性与 annos 仍各走各的格（`prop`／`anno`）—— 把整袋属性塞进这里，
 * 会让「改一格」变成「写一整袋」，而那是同一个格两种地址的老路。
 */
export type BlockPatch = {
  /** 行内内容整组替换（文本/格式/原子改动都是这一条 op） */
  content?: Run[]
  /** 出生时刻：只在 genesis 里出现一次，此后不许改（可重放的前提） */
  created?: number
  /**
   * 最后一次改动时刻。**与 `content` 并进同一条 op**：一次编辑是一条账，
   * 多一个属性写账本就会翻倍（而「这一次改动」本来就只有一个时刻）。
   */
  modified?: number
  parent?: string | null
  /**
   * **前兄弟的 id**（`null` ＝ 落在父的第一个位置；`parent: null` ＋ `prev: null` ＝ 森林最前）。
   *
   * 为什么不是整数 `index`：`index` 只对「那一刻的兄弟列表」有意义。
   * 同一个 `index=2` 在一个短了一截的列表上会落到另一个位置，而且**不报错**
   * （落点计算里有 `Math.max(0, Math.min(index, len))` 的夹取）。
   * 进了 `op_log` 之后「当时那条 index 指的是哪」就再也补不回来。
   *
   * 为什么不是分数键：单写者 ＋ 链表下没有人需要「插入不重排」，而分数键会在
   * `children` 之外引入第二套序——两层各存一份序，就能静默分叉。
   *
   * ⚠️ **前兄弟已被删／不在本次重放集合**时：落成「父的第一个位置」并在
   * `at` 相同的两条 op 之间按 `(prev, id)` 定序（确定性 tie-break）。
   * 这条兜底是**显式**的：宁可把块放到可预期的位置，也不要静默夹取。
   */
  prev?: string | null
}

/** 一块的存在：在场 / 软删（可恢复） / 清除（身份不复活） */
export type Existence = 'present' | 'deleted' | 'purged'

/**
 * 一条**持久化 op**。
 *
 * `at` 现在写 `Date.now()`，为将来的 HLC／设备标识留位；它**不参与排序**，
 * 消费者不得靠它重建顺序（顺序由 op 序列本身表达）。
 *
 * ## 四个种类，一格一个地址
 *
 * 每个 op 说「**某一个格现在是什么**」，不说「它变了多少」——这是全域性（重放幂等、
 * 撤销可表达、同步可收敛）的前提：只有绝对的格写入才能「应用两次等于一次」。
 *
 * | op | 寻址的格 |
 * |---|---|
 * | `block.upsert{content}` | 这一块的正文（整组 run 序列） |
 * | `block.upsert{created}` | 这一块的出生时刻（只写一次） |
 * | `block.upsert{modified}` | 这一块的改动时刻 |
 * | `block.upsert{parent, prev}` | 这一块的位置（**唯一的相对格**，见 `BlockPatch.prev`） |
 * | `block.exist{state}` | 这一块的存在（三态，见 `Existence`） |
 * | `prop.set` / `prop.delete` | `block:<id>.prop:<name>` 这一格 |
 * | `anno.set` / `anno.delete` | `block:<id>.annos:<aid>` 这一格 |
 *
 * ## 为什么存在是三态、且只有一个词
 *
 * 「软删」与「清除」在内存里是两件事：前者留在原位、可恢复；后者从树上消失、身份不复活。
 * 曾经它们都叫 `block.delete`，于是 `Tx.remove` 与 `diff`（撤销一次插入）发出同一条 op，
 * 而落盘侧只能按软删解释 —— **撤销一次插入再重开，块会从回收站里冒出来**。
 * 一个格只能有一种地址，存在这一格也一样。
 *
 * ## 为什么 `_queryResult` 不进日志
 *
 * 它是「那次查询的冻结结果」，派生值；每次装载重算。写它不发 op，
 * 否则日志会记下一份会过期的缓存，而重放出来的状态与装载出来的不一致。
 *
 * ⚠️ **地址与露面走 `prop`，没有自己的 op 种类**（`_aliases`／`_lists` 各一条整袋值）。
 * 曾经有过 `alias`／`list` 两种「按项增量」的 op，它们与 `prop.set` **指向同一个格**：
 * 日志里同一个格出现两条地址，重放顺序不同结果不同、幂等性也破
 * （`prop.set([a,b])` 后再来一条 `alias.set(a, pos 0)` 会把它覆盖一遍）。
 * ⇒ 一个格只能有一种地址，否则「应用两次等于一次」不成立，而那是撤销与同步的共同前提。
 * 代价：改名从写 1 行变成清 N 行 + 写 N 行——改名是低频动作，别名表是 1–3 项。
 */
export type Op =
  | { e: 'block'; id: string; op: 'upsert'; value: BlockPatch; at: number }
  | { e: 'block'; id: string; op: 'exist'; state: Existence; at: number }
  | { e: 'prop'; block: string; name: string; op: 'set' | 'delete'; value?: unknown; at: number }
  | { e: 'anno'; block: string; id: string; op: 'set' | 'delete'; value?: Anno; at: number }

/** 被写的两类对象：块森林 ＋ 块上的可引用区间 */
export type ChangeKind = 'blocks' | 'annos'

/**
 * 一条**失效通知**：只说「这类对象里的这一条动过」，不带 payload。
 *
 * 索引与视图订阅不该被迫接收大对象（一次打字就会把整块正文推给每个订阅者）；
 * 需要字节的是 `StoragePort`，它只吃 `Op[]`。
 *
 * `id` 两种取值：具体 id（精确到块／区间），或者 `'*'`（整类都可能动过）。
 * `'*'` 现在**只剩一个来源**：零 op 的提交（例如只换了落点）——
 * 那不是「不知道变了什么」，而是「这一批确实什么都没改」。
 * 有 op 的时候永远给具体 id（`changesOf` 从 op 推导）。
 */
export interface Change {
  kind: ChangeKind
  /** 对象 id（块／区间），或 `'*'` ＝ 整类对象都动过 */
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
   * op 是**一条** `block.exist{state:'deleted'}`：子树的不可见是继承来的，后代不各报一条
   * （落库时这也是一行的事：`deleted_at` 写在根行上；恢复才需要把整棵子树接回来，
   * 而它的行一直都在）。
   */
  remove(id: string): void
  /**
   * 恢复一个被删的块：摘掉它身上的删除标记，块**回到原位**（它从未离开过树）。
   *
   * op 是**一条** `block.exist{state:'present'}` —— 与 `remove` 同一个格、同一个词。
   * 恢复的是操作根：整棵子树随它一起重新可见。
   */
  restore(id: string): void

  /**
   * 写一个属性槽。**一格一个地址**：`block:<id>.prop:<name>` 这一格现在的值。
   *
   * （曾有一个 `pos` 参数，只有 `alias`／`list` 那两种「按项增量」的 op 会用到它；
   * 那两种 op 已删——同一个格不许有两种地址。属性行的显示顺序不是模型语义，
   * 不靠 op 传。）
   */
  setProp(id: string, name: string, value: unknown): void
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
