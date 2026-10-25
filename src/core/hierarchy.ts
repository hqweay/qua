/**
 * **归属边**：块之间的虚拟父子关系（子 → 父、有序、多值、DAG）。
 *
 * 与内容树（`children`）的分工不是「两种写法」，是**基数不同**：
 *   · 树父**恰好一个**（结构不变量）——「它在哪」；
 *   · 边父**0..N**（有向无环）——「它归在哪」。
 * 一个多父关系在定义上就不可能是树位置，所以两件事各有一个实现，不存在歧义。
 *
 * 这条边的六条口径（每一条都有一个曾经写错的版本）：
 *   · **不设端点约束**：什么块都能有上级。露面（`_lists` 里的 `page`／`tag`）是可加的也是可减的，
 *     拿它当前置条件会让 `removeList` 追溯性地把已经写好的边变成非法；而级联删边＝
 *     「替你改了内容而你不知道」。候选集合的收窄是**入口**的事，不是模型的判据。
 *   · **只在边图上判环**：树与边各是一张图。「A 在树里是 B 的父、B 在边上是 A 的父」
 *     不是环——归属树只走边图，绕不回来。
 *   · **悬空两态**：上级在回收站（ref 还在森林里，只是不可见）与上级真的没了，是两种状态。
 *     前者不能清理（复活要自愈），后者才能。分成一态就会「一点清理，父复活后接不回来」。
 *   · **删上级不级联**：子块上那条 ref 留着（悬空可见、可清理、撤销免费）。
 *   · **兄弟顺序不落盘**：数组是「子 → 父」，兄弟之间没有位置。面板因此不该提供重排落点。
 *   · **第一个是命名父**（将来只用于建议前缀，不自动改名）。
 *
 * ⚠️ 读一律经 `buildAdjacency`：全库有十几条读路径要问「它的上级是谁／下级是谁」，
 *    每条各自扫一遍森林就是 O(n) × 调用次数。一次建表（O(n+e)）之后，
 *    子项查询与祖先闭包都是表上的走查。
 */
import { hasList, isDeleted, prop, type Block, type BlockList } from './model.ts'
import { walkForest } from './walk.ts'
import { displayNameOf } from './alias.ts'

/**
 * 子块 → 上级的有序 ref 列表（方向 子 → 父）。
 *
 * 名字必须自己说出「这不是位置」：`parent` 会诱使人把它当树位置用，
 * 而端点放开之后 `…Tags` 也是错的（它连页、也连内容块）。
 * 第一个是**命名父**（只用于建议前缀，不自动改名）；兄弟顺序不落盘。
 */
export const BELONGS_TO_PROP = '_belongsTo'

/**
 * 一张森林的**边图邻接表**。
 *
 * 两张表：`byId`（活块表）与 `kids`（边图反向索引）。再加一个 `present`
 * 把「引用指得到谁」与「谁此刻看得见」分开——悬空两态就差这一格。
 */
export interface Adjacency {
  /** 活块（先序；被软删的子树不在里面） */
  readonly blocks: readonly Block[]
  readonly byId: ReadonlyMap<string, Block>
  /** 上级 id → 直接下级 id（先序；**不看露面**，内容块也能是上级） */
  readonly kids: ReadonlyMap<string, readonly string[]>
  /** 森林里**出现过**的 id（含被软删的子树）——解析得到 ≠ 看得见 */
  readonly present: ReadonlySet<string>
}

/** 走森林的那一次遍历（可注入，只为让「只走一遍」可断言） */
export type ForestWalker = typeof walkForest

/**
 * 一遍森林建表。
 *
 * ⚠️ **顶点集合是全部活块**，不是全部标签：端点放开之后，内容块也能当上级，
 *    只拿标签建表会让「内容块 → 标签」这条边的祖先前闭包查不到它，成环检测因此漏判。
 * ⚠️ `includeDeleted` 走一遍而不是走两遍：被删子树里的块只为了回答「这个 ref 解析得到吗」，
 *    它们不进任何读结果。
 */
export function buildAdjacency(forest: readonly Block[], walk: ForestWalker = walkForest): Adjacency {
  const blocks: Block[] = []
  const byId = new Map<string, Block>()
  const present = new Set<string>()
  const kids = new Map<string, string[]>()
  const dead = new Set<string>()
  walk(
    forest,
    (b, ctx) => {
      present.add(b.id)
      // 删除标记只写在操作根上，后代是继承来的 ⇒ 自己顺一遍父链，不靠每个块各打一个标记
      if (isDeleted(b) || (ctx.parent !== null && dead.has(ctx.parent.id))) {
        dead.add(b.id)
        return
      }
      blocks.push(b)
      byId.set(b.id, b)
      for (const parentId of parentIdsOf(b)) {
        const list = kids.get(parentId)
        if (list) list.push(b.id)
        else kids.set(parentId, [b.id])
      }
    },
    { includeDeleted: true },
  )
  return { blocks, byId, kids, present }
}

/** 直接上级 id（有序；**不校验存活**——ref 是事实，解析是读的事） */
export function parentIdsOf(b: Block): string[] {
  const raw = prop<unknown>(b, BELONGS_TO_PROP)
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/** 直接上级（活引用；悬挂的不返回） */
export function parentsOf(b: Block, adj: Adjacency): Block[] {
  const out: Block[] = []
  for (const id of parentIdsOf(b)) {
    const p = adj.byId.get(id)
    if (p) out.push(p)
  }
  return out
}

/** 直接下级（反向读同一条边；先序，稳定） */
export function childrenIn(id: string, adj: Adjacency): Block[] {
  const ids = adj.kids.get(id) ?? []
  const out: Block[] = []
  for (const kid of ids) {
    const b = adj.byId.get(kid)
    if (b) out.push(b)
  }
  return out
}

/**
 * 上级闭包（**不含自己**）。
 *
 * 菱形：`#A` 归在 `#B`、`#C` 下，而 `#B`、`#C` 都归在 `#D` 下 ⇒ `{B, C, D}`（D 只一次）。
 * 环：读时用 visited 兜底防死循环，但写入路径已经拒绝成环。
 */
export function ancestorIds(id: string, adj: Adjacency): Set<string> {
  const out = new Set<string>()
  const self = adj.byId.get(id)
  if (!self) return out
  const queue = [...parentIdsOf(self)]
  while (queue.length > 0) {
    const next = queue.shift()!
    if (out.has(next)) continue
    out.add(next)
    const b = adj.byId.get(next)
    if (b) for (const p of parentIdsOf(b)) if (!out.has(p)) queue.push(p)
  }
  return out
}

/** 下级闭包（**含自己**）——「算作」的成员从这里来 */
export function descendantIds(id: string, adj: Adjacency): Set<string> {
  const out = new Set<string>([id])
  const queue = [id]
  while (queue.length > 0) {
    const at = queue.shift()!
    for (const kid of adj.kids.get(at) ?? []) {
      if (out.has(kid)) continue
      out.add(kid)
      queue.push(kid)
    }
  }
  return out
}

/** 悬空的两种状态：上级在回收站（可复活）／上级真的没了（可清理） */
export interface Dangling {
  /** ref 指得到，但那一块（或它的祖先）被软删了——**不能清**，复活要自愈 */
  revivable: string[]
  /** 森林里根本没有这个 id——能清，也只能清这些 */
  gone: string[]
}

/**
 * 这条边此刻悬成什么样（状态派生，不落盘）。
 *
 * ⚠️ 两态必须分开：一态会让「清掉回收站里的上级」与「上级复活后边自动接回」互相打架。
 */
export function danglingOf(b: Block, adj: Adjacency): Dangling {
  const revivable: string[] = []
  const gone: string[] = []
  for (const id of parentIdsOf(b)) {
    if (adj.byId.has(id)) continue
    if (adj.present.has(id)) revivable.push(id)
    else gone.push(id)
  }
  return { revivable, gone }
}

/**
 * 清掉**真没了**的上级引用，返回清了几条。
 *
 * ⚠️ 回收站里的那些一条不动（`danglingOf().revivable`）：它们解析得到，
 *    只是此刻不可见；清掉就等于把「上级复活后自动接回」这条承诺撕了。
 */
export function pruneGone(b: Block, adj: Adjacency): number {
  const ids = parentIdsOf(b)
  const alive = ids.filter((id) => adj.byId.has(id) || adj.present.has(id))
  if (alive.length === ids.length) return 0
  b.props = { ...(b.props ?? {}), [BELONGS_TO_PROP]: alive }
  return ids.length - alive.length
}

/** 加一条边（**不检查**）：只动子块这一个块，写路径由此能放进一笔事务 */
export function appendEdge(child: Block, parent: Block): void {
  child.props = { ...(child.props ?? {}), [BELONGS_TO_PROP]: [...parentIdsOf(child), parent.id] }
}

/** 删一条边（只动子块这一侧） */
export function removeEdge(child: Block, parentId: string): boolean {
  const ids = parentIdsOf(child)
  if (!ids.includes(parentId)) return false
  child.props = { ...(child.props ?? {}), [BELONGS_TO_PROP]: ids.filter((id) => id !== parentId) }
  return true
}

export type CheckEdgeResult =
  | { ok: true }
  | { ok: false; reason: 'self' | 'duplicate' | 'cycle'; path?: string[] }

/**
 * **只检查**能不能加这条边（不写模型）。
 *
 * 与 `appendEdge` 分开，是为了让「被拒绝的写入」连一次撤销快照都不产生。
 */
export function checkEdge(child: Block, parent: Block, adj: Adjacency): CheckEdgeResult {
  if (child.id === parent.id) return { ok: false, reason: 'self' }
  // ⚠️ 不查「parent 是不是标签/页」：露面是可加可减的，拿它当前置条件会让
  // `removeList` 追溯性地把已经写好的边变成非法。收窄候选是入口的事（见文件头）。
  if (parentIdsOf(child).includes(parent.id)) return { ok: false, reason: 'duplicate' }
  // 把 parent 的上级闭包算出来：里面若有 child ⇒ 添这条边会成环
  const anc = ancestorIds(parent.id, adj)
  if (anc.has(child.id)) {
    const path = [child.id, parent.id, ...anc].filter((id, i, arr) => arr.indexOf(id) === i)
    return { ok: false, reason: 'cycle', path }
  }
  return { ok: true }
}

/** 环路径的显示文本（用名字；有 `tag` 露面才加 `#`，否则一个普通块被叫成标签） */
export function cyclePathLabels(path: readonly string[], adj: Adjacency, shortId: (id: string) => string): string[] {
  return path.map((id) => {
    const b = adj.byId.get(id)
    if (!b) return shortId(id)
    // 显示名走主名叶子：标签的正文是描述，名字在 `_aliases` 里
    const name = displayNameOf(b) || shortId(id)
    return hasList(b, 'tag') ? `#${name}` : name
  })
}

/* ------------------------------------------------------------ 归属树（读法） */

/** 归属树的一行：块 ＋ 缩进层级 */
export interface BelongsRow {
  block: Block
  depth: number
}

/**
 * **归属树摊平**：只含带 `face` 露面的块，根按「**本树内**没有可见父」重算。
 *
 * 为什么根要重算，而不是取「模型里没有父」的块：
 * 页 P 挂在标签 T 下、T 没有上级 ⇒ 若根只取模型源点，页的归属树里既没有 T（不是页）
 * 也走不到 P（P 有父），**P 从这棵树里彻底消失**。数据失踪比少画一条线严重得多。
 * 重算之后 P 是根，T 不出现：两个节点都还在自己那棵树里，只是「P 归在 T 下」这条边
 * 在两棵树里都不画 —— 它的正主是属性区的「属于」那一行。
 *
 * 代价（每次读都要走，不能缓存成源点集合）：父被筛掉 ⇒ 子升级为根。
 * 给 A 补上 `page` 露面之后，A 在归属树里的位置当场就变。
 *
 * ⚠️ 多父 ⇒ 同一块可能出现多次（DAG 本来就有多个答案）；路径环由 `path` 兜底，
 *    写入侧已经拒绝成环，这里的 visited 只是读时不死的保险。
 */
export function belongsToTree(adj: Adjacency, face: BlockList): BelongsRow[] {
  const inTree = (b: Block | undefined): b is Block => b !== undefined && hasList(b, face)
  const nodes = adj.blocks.filter((b) => hasList(b, face))
  const rows: BelongsRow[] = []
  // 有**任意一个**本树内的可见父 ⇒ 不是根（多父也只需要一个父把它挂起来）
  const roots = nodes.filter((b) => !parentsOf(b, adj).some(inTree))
  const down = (b: Block, depth: number, path: Set<string>): void => {
    rows.push({ block: b, depth })
    path.add(b.id)
    for (const kid of childrenIn(b.id, adj)) {
      if (!inTree(kid) || path.has(kid.id)) continue
      down(kid, depth + 1, path)
    }
    path.delete(b.id)
  }
  for (const r of roots) down(r, 0, new Set())
  return rows
}
