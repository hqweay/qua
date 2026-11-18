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
import type { Op } from '../kb/types.ts'
import type { Sel } from './selection.ts'
import { applyOps as patchIndex, lookupBlock, rebuild, type Index } from '../infra/index-port.ts'
import { applyOps } from '../kb/diff.ts'
import type { UndoCapture } from '../kb/scoped.ts'
import { scopedOps } from '../kb/scoped.ts'
import type { ForestLookup } from '../kb/types.ts'
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
  private workset: WorksetState = { loaded: null, pinned: new Set(), order: new Map(), tick: 0 }

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
    patchIndex(this.index, ops, this.blocks)
    const ids = [...new Set(changesOf(ops).map((c) => c.id))]
    this.notify(source, ids, structuralOf(ops))
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
  setWorkset(roots: Block[], ids: ReadonlySet<string>): void {
    this.blocks.splice(0, this.blocks.length, ...roots)
    const previous = this.workset.loaded
    this.workset.loaded = new Set(ids)
    // 只给**新装进来的**块盖装载时刻：否则每次再装一页都会把所有块刷成“刚用过”，LRU 失真
    for (const id of ids) if (!previous?.has(id)) this.touch(id)
    this.worksetProbe.merges++
    this.worksetProbe.loaded = ids.size
    this.discardIndex()
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
    this.blocks = blocks
    /**
     * **换库回到整库模式**：`reset` 的输入是一份完整模型（种子／演示状态），
     * 它没有「未加载」这部分语义。工作集模式下的 pin/loaded 若留着，会把整库
     * 里不在旧工作集的块判成「未加载」——那正是两份模型会打架的地方。
     */
    this.workset = { loaded: null, pinned: new Set(), order: new Map(), tick: 0 }
    this.worksetProbe.loaded = 0
    this.worksetProbe.pinned = 0
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
    const ops = scopedOps(lookup, entry.before, { directEdit: entry.directEdit })
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
    const ops = scopedOps(lookup, entry.after, { directEdit: entry.directEdit })
    applyOps(this.blocks, ops, lookup)
    this.apply(ops, source)
    entry.device?.redo()
    return { ops, sel: redoSel }
  }
}
