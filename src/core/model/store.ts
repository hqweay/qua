/**
 * **共享 block store**：块（含行内内容与 annos）、undo 只有一份，
 * 多个 `BlockEditor` 视图读同一份数据；编辑任一实例，其他实例经 `apply` 的通知重渲染。
 *
 * 为什么需要它：反链/查询视图和正文会渲染**同一个源块**。如果编辑器各持一份拷贝，
 * 两份可编辑拷贝会分叉。store 让「块」只有一份，视图只是它的投影。
 *
 * 边界：
 *   · store 在 `core/`，**零 DOM**；视图通过 `subscribe` 得到通知。
 *   · undo 是全局的；条目只记这次事务动过的块（前态／后态 ＋ 落点）。
 *     行内内容与 annos 住块上 ⇒ 天然带全它们，没有第二份要拼装。
 *   · **宣布只有一个入口**：`apply(ops)`（事务的出口）。调用方不许自己发通知 ——
 *     否则索引会被无谓作废、订阅者会被通知两次（两者都不报错，只是变慢/抖动）。
 *   · **撤销条目只记这次事务动过的块**（前态／后态 ＋ 落点），不存整片森林；
 *     撤销/重做只对那几块生成 op（`kb/scoped.ts`）。
 */
import { UndoStack, type DeviceUndoStep, type UndoKind } from './undo.ts'
import type { Block } from './model.ts'
import { DELETED_AT_PROP, isDeleted } from './model.ts'
import type { Sel } from './selection.ts'
import { applyOps as patchIndex, blockIdByAlias, indexInsertedSubtrees, lookupBlock, rebuild, type Index } from '../infra/index-port.ts'
import { normalizeAlias } from '../identity/alias.ts'
import { applyOps } from '../kb/diff.ts'
import type { UndoCapture } from '../kb/scoped.ts'
import { scopedOps } from '../kb/scoped.ts'
import type { AliasState, ForestLookup, Op } from '../kb/types.ts'
import { changesOf, structuralOf } from '../kb/changes.ts'
import { walkForest } from './walk.ts'

/** 子树里的每一块（含软删）：淘汰与钉住判据共用「子树」这一条口径 */
function walkSubtree(root: Block, fn: (b: Block) => void): void {
  walkForest([root], (b) => fn(b), { includeDeleted: true })
}

/**
 * 订阅者收到的信号。
 *
 * `ids`（可选）＝**这次动过哪些块**。查询视图靠它判断「结果里的块是不是变了」，
 * 而不是靠「store 被碰过几次」——后者会把「刷新顺带引起的重渲染」也算成过期（实测假阳性）。
 * ⚠️ 拿不到精确 id 的调用方（续用旧的 `touch(this)`）就不传，订阅者必须容忍 `ids === undefined`。
 */
/**
 * 订阅者收到的信号：**谁发起的**、**动过哪些块**、**是不是结构变化**。
 *
 * 第三参（`structural`）由 op 形状推导（`structuralOf`，单一判据）：
 * 正文改动可以「按 id 局部替换」，树变了之后行集合本身变了 ⇒ 要整页重画。
 * 订阅者可省略它（TS 允许多参函数被少参调用）；只有需要区分两类重画的视图用它。
 *
 * ⚠️ 曾经还有第三个参数 `forestReplaced`（「整片森林被换掉了」）：撤销那时
 * `JSON.parse` 换掉整片森林 ⇒ 各视图手里的块对象当场过期，必须靠这个旗标
 * 让它们「按 id 重取、并且不许推迟」。撤销改走 `applyOps`（原地写格、对象身份不变）之后，
 * **没有任何地方需要它了** —— 旗标存在的唯一原因是旧机制的实现细节。
 */
export type StoreSubscriber = (source?: unknown, ids?: readonly string[], structural?: boolean) => void

/**
 * **这一条通知是不是「我」发起的那笔编辑**。
 *
 * `source` 是发起写的那台编辑器（见 `Run` 的口径）。自己发起的编辑，本视图已经画过了；
 * 再整片重载一次只会把正在发生的事打断（光标、组合期、正被按的按钮）。但「欠不欠
 * 一次重装」是另一件事：可编辑块列的成员判定读内容，自己的编辑也会让它过期。
 *
 * ⚠️ 「我没有编辑器」不算「我发起的」：懒建的视图、表格分支下没有大纲时，一条没有
 *    source 的写入（换库）仍是**别人的**变化，该跟。
 * ⚠️ 它只回答这一句，不回答「结果要不要重算」——撤销时 source 正是自己，但条件
 *    真的回滚了；那是调用方按「条件变没变」判的。
 */
export function isOwnEdit(source: unknown, mine: unknown): boolean {
  return mine != null && source === mine
}

/**
 * **工作集状态**：这一份 store 里到底装了库的多少。
 *
 * | 模式 | `blocks` | `isLoaded` | 谁在用 |
 * |---|---|---|---|
 * | 整库（旧路径／web） | 整片森林 | 索引里有它就算 | 浏览器单库、种子库、换库 |
 * | 工作集（桌面启动） | 当前视图闭包 | `loaded` 集合里有它才算 | 首帧之后的所有桌面读 |
 *
 * 为什么把「有没有加载」放在 store 而不是另造一层：多个视图共享**同一份块对象**
 * （I3）。如果工作集是第二个对象表，同一个 id 就会有两个对象；把 loaded 挂在
 * 唯一持有块对象的 store 上，`find` 与 `isLoaded` 天然回答同一个问题。
 *
 * ⚠️ 部分模式下 `blocks` **不是库**：顶层只代表「这些块的父没被装载」。
 * 任何把 `roots()` 当「库的页清单／顶层身份」的读都必须换实现，不能在这里猜。
 */
export type WorksetState = {
  /** `null` ＝ 整库在内存（旧路径）；非 null ＝ 已加载块 id 集合 */
  loaded: Set<string> | null
  /** 不可淘汰的块（打开着的视图、它们引用的身份块与祖先链） */
  pinned: Set<string>
  /** 装载顺序（LRU 淘汰的读数；`find` 命中会刷新） */
  order: Map<string, number>
  tick: number
  /**
   * **children 还不全的块**（按 id 预取进来的裸块：标签、定义、引用目标、身份块）。
   *
   * 与 `loaded` 分开：`loaded` 只回答「有没有这一块」，不回答「它的子树读全了没有」。
   * 裸块与真叶子在形状上一样（`children: []`），于是「打开一个只有一行的空页」和
   * 「打开一个子树还没装的页」分不开——前者是内容，后者是bug。打开导航前据这一格
   * 补一次子树读（`childrenKnown`），否则正文只有根行、直到别处的装载把它凑齐。
   *
   * 只有工作集模式有意义；整库模式恒为「知道」。
   */
  childrenUnknown: Set<string>
}

export class BlockStore {
  blocks: Block[]
  undoStack = new UndoStack()
  /**
   * **森林被整片换过没有**（只有 `reset` ＝ 换库会置它）。
   *
   * 为什么需要它：增量落盘按 op 走，而换库**不产生 op** —— 它把森林整个换成另一份。
   * 落盘层据此判「这批必须整份写」，而不是靠「这批 op 是空的」去猜
   * （那会把「只是换了个落点」也当成整库重写）。
   */
  private replaced = 0
  /**
   * **模型修订号**：每次真改动（`apply` 带着非空 ops／`reset`）单调加一。
   *
   * 为什么渲染层需要它：行的派生物（块标图标、关闭态标记、chips、块下属性行……）
   * 都是**构造期**写进行元素上的，「同构重装」这类保留旧元素的快路必须先回答
   * 「这行画下之后模型动过没有」——按块逐个对账等于把渲染重做一遍，一个全局
   * 修订号是唯一便宜的答案。渲染在 stamp 时读它，保留时对它。
   */
  revision = 0
  /**
   * **结构修订号**：只随「树形／存在」变化推进（`block.upsert` 带 parent/prev、
   * `block.exist`、换库），**内容与属性的写入不推**。
   *
   * 为什么不能复用 `revision`：`revision` 每键都变，拿它当行投影的缓存键等于
   * 每键都失效。可见行只由「谁是活的、谁的孩子」＋折叠态决定——内容改一个字
   * 不改变行集合，却会推 `revision`。这两个问题的失效条件分开，缓存才有意义。
   */
  structureRevision = 0
  /**
   * **属性修订号**：任何 `prop.set` 都推（身份/字段声明/选项表这些「派生表的形状」
   * 可能跟着变）。内容与结构各有自己的键，这一格只回答「行派生的扫库结果还能不能复用」。
   * 低频：打字不产生 prop op。
   */
  propsRevision = 0
  private subs = new Set<StoreSubscriber>()
  /**
   * **派生索引**（懒重建）：`null` ＝ 已失效，下次访问时从当前 `blocks` 重算一遍。
   *
   * 为什么挂在 store 上：它是**共享数据**的唯一持有者，多个视图读同一份；
   * 索引挂在别处就会出现「两个视图拿着不同代的索引」。
   * 为什么是懒的：一次渲染里会问很多次「这个 id 是哪块」，重建一次摊到所有查询上；
   * 每次改动都立刻重建则把成本提前到了**输入路径**上（打字时卡）。
   */
  private idx: Index | null = null
  /**
   * **诊断计数**（只增、不清零；给「成本不随体量增长」这类断言一个可判定的读数）。
   *
   * 为什么要它：这类退化（索引被作废后整库重建、订阅者被通知两次）**不报错**，
   * 界面只是慢一点；没有读数就只能靠推理，而推理验不出「修复是否真的生效」。
   */
  readonly probe = { rebuildCount: 0, notifyCount: 0 }
  /**
   * **工作集读数**（只增、不清零）：给「首帧到底装了多少、淘汰过没有」一个可判定的数。
   * `loaded`／`pinned` 是当前值，不是累计值。
   */
  readonly worksetProbe = { merges: 0, evictions: 0, loaded: 0, pinned: 0 }
  private workset: WorksetState = { loaded: null, pinned: new Set(), order: new Map(), tick: 0, childrenUnknown: new Set() }

  constructor(blocks: Block[]) {
    this.blocks = blocks
  }

  subscribe(fn: StoreSubscriber): () => void {
    this.subs.add(fn)
    return () => this.subs.delete(fn)
  }

  /**
   * 通知其他视图：源视图自己已经渲染过；`source` 不参与重渲染。
   * `ids` ＝ 这次动过的块（可选）；`structural` ＝ 树的形状变没变（都从 op 推导，
   * 见 `StoreSubscriber` 的说明）。
   *
   * ⚠️ **不是公开的宣布入口**：调用方不许自己宣布模型变了。
   * 唯一的宣布者是一次事务的出口（`Kb.apply`），因为只有它知道「变了哪几格」。
   * 自己宣布 ⇒ 索引会被无谓作废、订阅者会被通知两次（真踩过：打字每键两次全视图重载）。
   */
  private notify(source?: unknown, ids?: readonly string[], structural?: boolean): void {
    this.probe.notifyCount++
    for (const fn of this.subs) fn(source, ids, structural)
  }

  /**
   * **状态转移的唯一入口**：把一批 op 应用到当前森林，并**同时**做三件事 ——
   * 按 op 增量修补索引、通知订阅者、记诊断计数。
   *
   * 为什么收成一个：这三件事是同一个事实（「模型变成了这样」）的三个投影。
   * 分成两个入口（`applyOps` ＋ `touch`）时，第二个会把第一个的成果当场作废
   * （`touch` 无条件 `invalidateIndex`）—— 而那正是打字路径上每次按键都在发生的事。
   *
   * `ids` **从 op 推导**（`changesOf`）：调用方不再另外传一份「这次动过谁」，
   * 于是「索引修补的集合」与「视图重画的集合」结构上不可能分叉。
   *
   * ⚠️ 索引是**增量修补**，不是整库作废：一批 op 之后与全量重建逐字节一致
   * （`tests/index-port.test.ts` 的等式断言钉住）。
   */
  apply(ops: readonly Op[], source?: unknown): void {
    if (ops.length > 0) this.revision++
    const structural = structuralOf(ops)
    if (structural) this.structureRevision++
    if (ops.some((o) => o.e === 'prop')) this.propsRevision++
    patchIndex(this.index, ops, this.blocks)
    const ids = [...new Set(changesOf(ops).map((c) => c.id))]
    this.notify(source, ids, structural)
  }

  /** 索引（**懒重建**）。任何改动之后第一次访问会重算一次，之后所有查询共用。 */
  get index(): Index {
    this.idx ??= (this.probe.rebuildCount++, rebuild(this.blocks))
    return this.idx
  }

  /** 按 id 找块（当前工作集；zoom 后当前对象可能在任意深度）—— 走索引，O(1) */
  find(id: string): Block | undefined {
    const b = lookupBlock(this.index, id)
    // 命中就刷新 LRU：淘汰该先淘汰「更久没被读到」的那一批
    if (b !== undefined && this.workset.loaded !== null) this.touch(id)
    return b
  }

  /* ------------------------------------------------------------ 工作集 */

  /**
   * **这一份 store 是不是只装了一个工作集**。
   *
   * 判据只有一个：`loaded` 不为 null。读侧据此决定「读不到就是未加载，不是不存在」，
   * 不能靠「blocks 少」去猜——小库的工作集与整库在形状上完全一样。
   */
  get partial(): boolean {
    return this.workset.loaded !== null
  }

  /** 工作集里有多少块（整库模式返回索引里的全部块，含软删） */
  get loadedCount(): number {
    return this.workset.loaded?.size ?? this.index.all.size
  }

  /**
   * **这块在不在内存里**（与「在不在库里」是两件事）。
   *
   * 整库模式：索引里有它就算加载（含软删——撤销/修复要按 id 找回被删块）。
   * 工作集模式：只有 `loaded` 集合里的才算。未加载的块**没有对象**，
   * 不造占位块：占位块会让同一个 id 出现第二份对象（I3）。
   */
  isLoaded(id: string): boolean {
    if (this.workset.loaded !== null) return this.workset.loaded.has(id)
    return this.index.all.has(id)
  }

  /**
   * 这一块的 **children 读全了没有**（整库模式恒真）。
   *
   * 只有工作集模式会返回假：按 id 预取的裸块（身份块／引用目标／候选闭包）
   * `children` 是空的，但那不是「它没有子块」。打开导航前必须补读，否则正文只有根行。
   */
  childrenKnown(id: string): boolean {
    return this.workset.loaded === null ? true : !this.workset.childrenUnknown.has(id)
  }

  /** 标记这批块的 children 还没读（裸块装载之后） */
  markChildrenUnknown(ids: Iterable<string>): void {
    if (this.workset.loaded === null) return
    for (const id of ids) this.workset.childrenUnknown.add(id)
  }

  /** 标记这批块的 children 已经读全（子树读之后） */
  markChildrenKnown(ids: Iterable<string>): void {
    if (this.workset.loaded === null) return
    for (const id of ids) this.workset.childrenUnknown.delete(id)
  }

  /**
   * 钉住一批块：淘汰不许动它们。
   *
   * 钉的是**对象所在的子树**：视图打开着的根、它引用的身份块、以及为面包屑加载的
   * 祖先链都要钉，否则一次淘汰会让正在显示的视图拿到过期副本（I3）。
   */
  pin(ids: Iterable<string>): void {
    for (const id of ids) this.workset.pinned.add(id)
    this.worksetProbe.pinned = this.workset.pinned.size
  }

  unpin(ids: Iterable<string>): void {
    for (const id of ids) this.workset.pinned.delete(id)
    this.worksetProbe.pinned = this.workset.pinned.size
  }

  isPinned(id: string): boolean {
    return this.workset.pinned.has(id)
  }

  /**
   * **换工作集的根**（装载器算好之后交给 store）。
   *
   * 两个口径由调用方保证、这里只执行：
   *   · `roots` 里的块对象必须是**已经共享的那一个**（已在工作集里的 id 不许换对象）；
   *   · `ids` 是这次装完后的全部已加载 id（含工作集里的软删块）。
   *
   * 为什么原地 `splice` 而不是换数组：`ws.blocks` 与 store 共用同一个数组
   * （装配层的 `syncSections` 直接搬引用）。换数组会让装配层手里的那份当场过期，
   * 下一次读就可能读到旧的根集合。
   *
   * 不通知订阅者：装载是**读**，不是一次编辑。把新载入的页画出来是装载方的事；
   * 这里通知只会让其它视图白重画一遍（还可能把它们的选区/折叠打断）。
   */
  /**
   * ⚠️ **整份换**（O(已装)）：生产装载路径已改走 `adoptLoaded` 的增量一格；
   * 这一格留给「把工作集整个换掉」的形状（测试夹具、将来换库）。
   */
  setWorkset(roots: Block[], ids: ReadonlySet<string>): void {
    this.blocks.splice(0, this.blocks.length, ...roots)
    const previous = this.workset.loaded
    this.workset.loaded = new Set(ids)
    // 整份换进来的那批按「形状完整」对待（测试夹具／将来换库）
    this.workset.childrenUnknown = new Set()
    // 只给**新装进来的**块盖装载时刻：否则每次再装一页都会把所有块刷成“刚用过”，LRU 失真
    for (const id of ids) if (!previous?.has(id)) this.touch(id)
    this.worksetProbe.merges++
    this.worksetProbe.loaded = ids.size
    this.discardIndex()
  }

  /* ------------------------------------------------------------ 装载的增量路径 */

  /**
   * **装载也走增量**（与编辑同一条索引路径）：把新装进来的块并入已加载集合，
   * 并按 op 修补索引——**不作废索引**。
   *
   * 为什么不能继续用 `setWorkset`：它整份换 `loaded`（O(已装)）再 `discardIndex`（下次
   * 访问整份 `rebuild`，也是 O(已装））。分窗装载一个万级块的单篇时，每窗一次 O(已装)
   * 就是 O(N²)：实测 10 万块分 50 窗要 31 秒，而一次装完只要 0.39 秒。
   */
  adoptLoaded(ids: Iterable<string>): void {
    if (this.workset.loaded === null) this.workset.loaded = new Set()
    const loaded = this.workset.loaded
    for (const id of ids) {
      if (loaded.has(id)) continue
      loaded.add(id)
      this.touch(id)
    }
    this.worksetProbe.merges++
    this.worksetProbe.loaded = loaded.size
  }

  /**
   * **本笔事务新插进来的子树**入册：它们本来就在内存里、形状完整（`children` 就是
   * 构造时给的那棵），所以「这一块要不要补装载」对它们只有一个答案——不用。
   *
   * 不入册的后果不是性能而是**行为**：`needsDoc` 会把「刚建出来的块」报成未装载，
   * 于是所有「建完就打开」的入口都去库里补读一次，而这时这一次写还躺在落盘防抖窗口里
   * （250ms）⇒ 读回空 ⇒ 打开闸按「没读到」中止（`whenDocLoaded`），屏幕毫无反应。
   * 整库模式（web／种子库）不走这条路，所以这个洞只在真库的部分装载面出现。
   *
   * 整库模式（`loaded === null`）什么都不做：那里 `isLoaded` 问的是索引。
   */
  markCreated(ids: Iterable<string>): void {
    const loaded = this.workset.loaded
    if (loaded === null) return
    for (const id of ids) {
      loaded.add(id)
      // 新子树的形状就是手上这一份：不欠子树读（欠了的话打开时正文只有根行）
      this.workset.childrenUnknown.delete(id)
      this.touch(id)
    }
    this.worksetProbe.loaded = loaded.size
  }

  /**
   * 装载路径的索引修补：`roots` 是这一批**挂进树里的片段根**（父可能已装载或为顶层）。
   *
   * 走 `patchIndex` 与编辑同一条路（`indexSubtree` 会把整棵新片段收进去），所以
   * 「装载出来的索引」与「整份重建」逐字节一致——`tests/index-port.test.ts` 的等式
   * 已经钉住这条；装载只是换了个调用方。
   */
  indexLoaded(entries: readonly { block: Block; parent: string | null }[]): void {
    indexInsertedSubtrees(this.index, entries, this.blocks)
  }

  /** 已装载块的对象（含软删块）；没装载 ⇒ `undefined`。装载路径用它保留对象身份 */
  loadedObject(id: string): Block | undefined {
    return this.index.all.get(id)
  }

  /** 这块在索引里吗（装载路径据此判断「新」与「换位置」） */
  isIndexed(id: string): boolean {
    return this.index.all.has(id)
  }

  /** 这块在树上此刻的父 id（`null` = 顶层；`undefined` = 索引里没有它） */
  parentIdInTree(id: string): string | null | undefined {
    return this.index.parentOfAll.get(id)
  }

  /** 从当前位置（父的 children 或森林顶层）摘下来；找不到就什么都不做 */
  detachFromTree(id: string, parentId: string | null): void {
    const block = this.index.all.get(id)
    if (!block) return
    const holder = parentId === null ? this.blocks : (this.index.all.get(parentId)?.children ?? null)
    if (!holder) return
    const at = holder.indexOf(block)
    if (at >= 0) holder.splice(at, 1)
  }

  /**
   * **按内存预算淘汰**未钉住的块，返回淘汰了多少块。
   *
   * 只在工作集模式下有作用；整库模式返回 0（旧路径的预算不在这里）。
   * 淘汰单位是**整棵子树**：摘一个父块却不摘子块，会留下「父不在、子还在顶层」的
   * 半截树；留下一个到处都在按 id 读的孤儿比少几块更糟。
   *
   * 顺序按 LRU（`order`）：最久没被 `find`/装载碰过的先走。钉住的块即使最旧也不走。
   */
  trimWorkset(budget: number): number {
    const loaded = this.workset.loaded
    if (loaded === null || loaded.size <= budget) return 0
    /**
     * 收集候选：子树里**没有**被钉住的块。父块被摘时子块一起走，所以候选表里
     * 只需要「可以整棵摘掉」的那些；按 LRU 排，逐个摘到预算内。
     */
    const parentOf = new Map<string, Block | null>()
    const listOf = new Map<string, Block[]>()
    walkForest(
      this.blocks,
      (b, ctx) => {
        parentOf.set(b.id, ctx.parent)
        listOf.set(b.id, ctx.parent ? ctx.parent.children : this.blocks)
      },
      { includeDeleted: true },
    )
    const candidates = [...loaded].filter((id) => this.workset.pinned.size === 0 || !this.hasPinnedInSubtree(id))
    candidates.sort((a, b) => (this.workset.order.get(a) ?? 0) - (this.workset.order.get(b) ?? 0))
    let evicted = 0
    for (const id of candidates) {
      if (loaded.size <= budget) break
      if (!loaded.has(id)) continue // 已经被父块的淘汰带走
      const b = this.index.all.get(id)
      const list = listOf.get(id)
      if (!b || !list) continue
      // 父块还留着（没被摘）才算一次真实摘除；父已摘 ⇒ 这块已经随之上路
      if (parentOf.get(id) && !loaded.has(parentOf.get(id)!.id)) continue
      list.splice(list.indexOf(b), 1)
      let n = 0
      walkSubtree(b, (node) => {
        if (loaded.delete(node.id)) n++
      })
      evicted += n
    }
    if (evicted > 0) {
      // 淘汰掉的块不再有「children 全不全」这件事；留着会让将来重装它时跳过子树读
      for (const id of this.workset.childrenUnknown) if (!loaded.has(id)) this.workset.childrenUnknown.delete(id)
      this.worksetProbe.evictions++
      this.worksetProbe.loaded = loaded.size
      this.discardIndex()
    }
    return evicted
  }

  private touch(id: string): void {
    this.workset.order.set(id, ++this.workset.tick)
  }

  private hasPinnedInSubtree(id: string): boolean {
    const root = this.index.all.get(id)
    if (!root) return false
    let pinned = false
    walkSubtree(root, (b) => {
      if (this.workset.pinned.has(b.id)) pinned = true
    })
    return pinned
  }

  /* ------------------------------------------------------------ catalog（工作集外的全库身份摘要） */

  /**
   * **catalog 摘要**：全库的日记日期（由装载器喂进来，整库模式也可以喂）。
   *
   * 为什么挂在 store 上：创建路径的防重判据（`#名字` 归谁、这一天在不在）是
   * **全局**问题，而工作集只有当前视图的闭包。store 是编辑器、命令、读门面
   * 共同持有的唯一对象——把摘要放这里，三层都不必各自传一份。
   */
  private catalogJournals: { id: string; date: string; deleted: number | null }[] | null = null

  setCatalog(catalog: { journals: readonly { id: string; date: string; deleted: number | null }[] } | null): void {
    this.catalogJournals = catalog === null ? null : [...catalog.journals]
  }

  /* ------------------------------------------------------------ 按 id 补装载（工作集全局能力） */

  /**
   * **「这块还没装载，先装再重放」的宿主能力**，与 `prepareAlias` 同级：
   * 名字被未装载块占有时，`#`／`@` 落点与引用修复要复用那一块，不能按名字新建。
   * 正文、窗口、挂载区、查询视图共用这一台 store ⇒ 所有编辑器都读同一格；
   * 早先它只是正文编辑器的私有选项，非正文表面遇到未装载别名会直接拒建。
   * 没有 loader（整库模式）时直接回调——所有块本来就在内存里。
   */
  private docLoader: ((ids: readonly string[], then: () => void) => void) | null = null

  setDocLoader(fn: ((ids: readonly string[], then: () => void) => void) | null): void {
    this.docLoader = fn
  }

  ensureLoaded(ids: readonly string[], then: () => void): void {
    if (ids.length === 0 || !this.docLoader) {
      then()
      return
    }
    this.docLoader(ids, then)
  }

  /* ------------------------------------------------------------ 地址归属（全局，按名点查） */

  /**
   * **「这个名字归谁」的两半**：内存里已知的 ＋ 去库里问过的。
   *
   * 为什么不再在启动时读全表：那张表随库线性长（大方量库上是启动的大头），而问它的
   * 只有创建路径的防重判据——一次点查就够。问到的答案在这次打开期间**是定论**：
   * 要改一个未装载块的名字，必须先把它装载进来，而装载过的块由（永远新鲜的）索引
   * 先回答；新造出来的块也当场进索引。所以这里没有失效问题，只有一个「问过没有」。
   */
  private aliasFacts = new Map<string, string | null>()
  private aliasResolver: ((norms: readonly string[]) => Promise<ReadonlyMap<string, string>>) | null = null

  /** 喂「按名点查」的库面（桌面＝IPC 具名读，web＝内存全森林）；没有它 ⇒ 永远 `unchecked` */
  setAliasResolver(fn: ((norms: readonly string[]) => Promise<ReadonlyMap<string, string>>) | null): void {
    this.aliasResolver = fn
    this.aliasFacts.clear()
  }

  /**
   * **这个名字此刻的归属**：三态。
   *
   * - `owned`：有人认领（索引里的活块，或库里查到的、可能未装载的块）；
   * - `absent`：**问过了**，库里没有——新建是安全的；
   * - `unchecked`：内存里没有、也没问过——**建块前必须先 `prepareAlias`**。
   *
   * `absent` 与 `unchecked` 必须分开：把「还没问」当作「没有」，就是造出第二个同名身份。
   */
  aliasState(name: string): AliasState {
    const local = blockIdByAlias(this.index, name)
    if (local !== undefined) return { kind: 'owned', id: local, loaded: this.isLoaded(local) }
    const norm = normalizeAlias(name)
    if (norm === '') return { kind: 'absent' }
    const fact = this.aliasFacts.get(norm)
    /**
     * **事实只对「未装载的块」有发言权**：装载过的块由索引回答（它是活的）。
     * 走到这里而事实指向一个**已装载**的块 ⇒ 那块已经把这个名字让出去了（改名／软删），
     * 事实过期 ⇒ 弃掉它、按「还不知道」处理（下次问库时会有新答案）。
     */
    if (fact !== undefined) {
      if (fact === null) return { kind: 'absent' }
      if (!this.isLoaded(fact)) return { kind: 'owned', id: fact, loaded: false }
      this.aliasFacts.delete(norm)
    }
    /**
     * 整库模式（索引覆盖全库）⇒ 查不到就是真的没有；只有工作集模式才存在「还没问」。
     * 这条判据与 `partial` 同源，不能靠「库小」去猜。
     */
    if (!this.partial) return { kind: 'absent' }
    return { kind: 'unchecked' }
  }

  /**
   * **去库里核定这一批名字**，把它变成这次打开期间的事实。没有解析器（整库模式）：无事可做，
   * 因为整库模式的索引就是全库。失败**不**记成「没有」——留成 `unchecked`，让调用方拒建。
   */
  async prepareAlias(names: readonly string[]): Promise<void> {
    const pending = [...new Set(names.map((n) => normalizeAlias(n)).filter((n) => n !== ''))].filter(
      (n) => !this.aliasFacts.has(n),
    )
    if (pending.length === 0 || this.aliasResolver === null) return
    let found: ReadonlyMap<string, string>
    try {
      found = await this.aliasResolver(pending)
    } catch (e) {
      // 问不到 ≠ 没有：留成 `unchecked`（调用方据此拒建），下一次再问
      console.warn('[alias] lookup failed:', e)
      return
    }
    for (const norm of pending) this.aliasFacts.set(norm, found.get(norm) ?? null)
  }

  /**
   * **这个名字现在归谁**（只回答 id）。索引优先（它反映已装载块的最新名字），
   * 其次是这次打开期间**问过**的库答案；`unchecked` 仍返回 `undefined`——调用方要
   * 区分「没有」与「还没问」就改用 `aliasState`。
   */
  aliasTargetId(name: string): string | undefined {
    const local = blockIdByAlias(this.index, name)
    if (local !== undefined) return local
    const norm = normalizeAlias(name)
    return this.aliasFacts.get(norm) ?? undefined
  }

  /** 这一天在库里的记录（含软删）；catalog 在场回答全库，不在场走含软删的索引块表 */
  journalRecord(date: string): { id: string; deleted: number | null } | undefined {
    if (this.catalogJournals) {
      const hit = this.catalogJournals.find((j) => j.date === date)
      return hit ? { id: hit.id, deleted: hit.deleted } : undefined
    }
    for (const b of this.index.all.values()) {
      if (b.props?.['_date'] === date) {
        return { id: b.id, deleted: isDeleted(b) ? Number(b.props?.[DELETED_AT_PROP] ?? 0) : null }
      }
    }
    return undefined
  }

  /** 全部可见日记天（升序）；catalog 在场回答全库（工作集只有当前窗口） */
  journalDates(): readonly string[] {
    if (this.catalogJournals) {
      return [...new Set(this.catalogJournals.filter((j) => j.deleted === null).map((j) => j.date))].sort()
    }
    return [...this.index.journals.keys()].sort()
  }

  /**
   * **撤销的读面**：按 id 找块，**看得见被软删的块**（`Index.all`）。
   *
   * 为什么不复用 `find`：`index.blocks` 是可见集，软删的块在退场时就摘掉了；
   * 撤销一次删除要按 id 找回它（否则会被当成「不存在」而走 genesis，落点又没记）。
   * 返回的对象绑定**这一次**取到的索引：只用于紧接着的一批 op（同一棵树上同步跑）。
   */
  undoLookup(): ForestLookup {
    const idx = this.index
    return {
      get: (id) => idx.all.get(id),
      parentOf: (id) => idx.parentOfAll.get(id) ?? null,
    }
  }

  /**
   * **整片森林被换掉**之后丢掉索引（下次访问整库重建）。
   *
   * 与 `apply` 的区别：`apply` 有一批 op 可依，所以只做增量修补；
   * 这里对象全换了，没有 op 可依 ⇒ 只能整库重建。
   * 今天只有 `reset`（换库）会走到这里 —— 撤销改走 `diff` + `applyOps` 之后，
   * 对象身份不变，不再需要整库重建。
   */
  discardIndex(): void {
    this.idx = null
  }

  /**
   * 整体换库：换数组引用，清 undo，通知所有视图（source 不传）。
   *
   * ⚠️ 这是**今天唯一**还会「整片换掉森林」的路径 —— 而它天然跨库，不产 op 是对的
   *    （`op_log` 记的是「这个库里发生了什么」，换库不是这个库里的一次编辑）。
   *    撤销/重做曾走同一条路（`JSON.parse` + `splice`），现在改走 `diff`+`applyOps`。
   */
  reset(blocks: Block[]): void {
    this.replaced++
    this.revision++
    // 整片森林换掉 = 最强的一次结构变化（行集合的前提全变了）
    this.structureRevision++
    this.propsRevision++
    this.blocks = blocks
    /**
     * **换库回到整库模式**：`reset` 的输入是一份完整模型（种子／演示状态），
     * 它没有「未加载」这部分语义。工作集模式下的 pin/loaded 若留着，会把整库
     * 里不在旧工作集的块判成「未加载」——那正是两份模型会打架的地方。
     */
    this.workset = { loaded: null, pinned: new Set(), order: new Map(), tick: 0, childrenUnknown: new Set() }
    this.worksetProbe.loaded = 0
    this.worksetProbe.pinned = 0
    /** 名字归属的答案只属于上一份库：换库必须连它一起清 */
    this.aliasFacts.clear()
    this.discardIndex()
    this.undoStack.clear()
    this.notify()
  }

  /**
   * **森林被整片换掉的次数**（只有 `reset` ＝ 换库会让它加一）。
   *
   * 为什么是**计数**而不是标志：标志需要在消费后清零（否则第二次换库检测不到），
   * 而那会引入一个「谁负责清零」的协议。计数天然是「比上一次的值」，不需要协议。
   *
   * 为什么不看「这批 op 是空的」：换落点（`setActiveId`）也是零 op，
   * 而它只需要写 `meta` 两格。把两者混成一件事，每次翻页都要整库重写一遍。
   */
  get swapCount(): number {
    return this.replaced
  }

  /** 记一笔撤销：捕获来自事务出口（`capture === null` ＝ 这次动作没写过）。 */
  record(
    capture: UndoCapture | null,
    sel: Sel | null,
    kind: UndoKind,
    at: number,
    opts: { standalone?: boolean } = {},
  ): boolean {
    return this.undoStack.record(capture, sel, kind, at, opts)
  }

  /** 记一笔**设备步**（不碰块的配置改动，如日记宿主的挂载栏）：栈只存闭包，调用在 undo/redo。 */
  recordDevice(step: DeviceUndoStep): boolean {
    return this.undoStack.recordDevice(step)
  }

  /**
   * 撤销一步：**只对条目里那几块**生成 op（不再有整库快照与整库 diff）。
   *
   * 三条口径没变，只是作用域变了：
   *   · **状态仍是唯一真相**：`scopedOps` 回答「这几块该长成什么样」；op 是绝对值，
   *     不是「怎么退回去」的指令；
   *   · **未动块的对象身份不变**（`applyOps` 原地写格）⇒ 索引按 op 修补；
   *   · `at` 从目标侧派生 ⇒ 同一次撤销重放两次字节相同。
   *
   * @returns `{ ops, sel }`：`ops` 交给装配层落盘；`sel` 让发起者自己恢复选区。
   */
  undo(source: unknown, sel: Sel | null): { ops: Op[]; sel: Sel | null } | null {
    const entry = this.undoStack.undo(sel)
    if (!entry) return null
    const lookup = this.undoLookup()
    const ops = scopedOps(lookup, entry.before)
    applyOps(this.blocks, ops, lookup)
    this.apply(ops, source)
    // 设备步：块侧零 op，回滚的是装配层在记录时交给栈的那份配置
    entry.device?.undo()
    return { ops, sel: entry.sel }
  }

  /** 重做一步；同 `undo`，目标侧换成条目的 `after` */
  redo(source: unknown, _sel: Sel | null): { ops: Op[]; sel: Sel | null } | null {
    /** 撤销那一刻的选区由栈在 `undo()` 时记下；没有就退回改动前的选区 */
    const entry = this.undoStack.redo()
    if (!entry) return null
    const redoSel = entry.redoSel ?? entry.sel
    delete entry.redoSel
    const lookup = this.undoLookup()
    const ops = scopedOps(lookup, entry.after)
    applyOps(this.blocks, ops, lookup)
    this.apply(ops, source)
    entry.device?.redo()
    return { ops, sel: redoSel }
  }
}
