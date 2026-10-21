/**
 * 块树：只读查询（locate／flatten／pathTo…）与结构操作（split／merge／indent／move…）。
 * 所有操作只改传入的 `Doc`，返回新 id 或布尔；**不碰 DOM、不碰持久化**。
 */

import { uuidv7Hex } from './ids.ts'
import { hasRole, mkBlock, type Block, type Doc, type Located } from './model.ts'
export function locate(doc: Doc, id: string): Located | null {
  const walk = (list: Block[], parent: Block | null): Located | null => {
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!
      if (b.id === id) return { parent, index: i, block: b }
      const inner = walk(b.children, b)
      if (inner) return inner
    }
    return null
  }
  return walk(doc.roots, null)
}

export function siblingsOf(doc: Doc, parent: Block | null): Block[] {
  return parent ? parent.children : doc.roots
}

/** 文档序（深度优先，**含折叠隐藏的块**） */
export function flatten(doc: Doc): Block[] {
  const out: Block[] = []
  const walk = (list: Block[]) => {
    for (const b of list) {
      out.push(b)
      walk(b.children)
    }
  }
  walk(doc.roots)
  return out
}

export interface VisibleRow {
  block: Block
  depth: number
  /** 该块自身处于折叠子树内（不挂 DOM） */
  hidden: boolean
  hasChildren: boolean
}

/**
 * 可见行（渲染用）：折叠块的**子树不产出可见行**，但块自身仍可见。
 * 这是「折叠 = 不挂 DOM」的唯一来源，DOM 节点数因此能真实反映折叠。
 */
export function visibleRows(doc: Doc): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (list: Block[], depth: number, hidden: boolean) => {
    for (const b of list) {
      out.push({ block: b, depth, hidden, hasChildren: b.children.length > 0 })
      walk(b.children, depth + 1, hidden || b.collapsed === true)
    }
  }
  walk(doc.roots, 0, false)
  return out
}

export function depthOf(doc: Doc, id: string): number {
  const path = pathTo(doc, id)
  return path ? path.length - 1 : -1
}

/**
 * 每个可见块的**祖先 id 链**（`index = 层级 k`，0 = 最外层祖先）。
 *
 * 用途：扁平 DOM 的**可点导轨**——深度 d 的行画 d 段线，
 * 每段对应一个祖先，点击就折叠那一层。它替代嵌套子树的 `border-left`：
 * 我们没有 children 容器（66 ），所以线只能按行画段、由段拼成整条。
 *
 * ⚠️ **必须对全量可见行算，不能对虚拟化窗口的 slice 算**：
 *    窗口从中间开始时，slice 的第一行祖先全丢（2026-10-20 调研 的点）。
 *    所以调用方在 `renderAll` / `applyWindow` 入口算一次，渲染单个 slice 时查表。
 *
 * 为什么不判 `hasChildren`：没有子块的块不会出现在任何人的祖先栈里
 * （它的子树没有可见行）⇒ 段天然消失，不需要额外过滤。
 */
export function ancestorsByBlockId(rows: readonly VisibleRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const stack: string[] = []
  for (const r of rows) {
    // 弹掉已经结束的兄弟/祖先：depth 变小 ⇒ 栈只保留前 depth 层
    stack.length = r.depth
    out.set(r.block.id, stack.slice())
    stack[r.depth] = r.block.id
  }
  return out
}

/** 从根到该块（含自身）的路径 */
export function pathTo(doc: Doc, id: string): Block[] | null {
  const walk = (list: Block[], acc: Block[]): Block[] | null => {
    for (const b of list) {
      const next = [...acc, b]
      if (b.id === id) return next
      const inner = walk(b.children, next)
      if (inner) return inner
    }
    return null
  }
  return walk(doc.roots, [])
}

/**
 * 在**整片森林**里找块：`zoom` 之后「当前对象」可能在任意深度，不能只在顶层找。
 *
 * ⚠️ 返回**活引用**（不是拷贝）：调用方若要改，必须走事务（16 ），别原地改。
 * ⚠️ 与 `pathTo(doc, id)` 的分工：那个吃 `Doc`（编辑器装载的子树），这个吃**整片森林**——
 *   zoom 之后 `ed.doc` 只是子树，而「当前对象」要按森林解析。
 */
export function findInForest(forest: readonly Block[], id: string): Block | undefined {
  for (const b of forest) {
    if (b.id === id) return b
    const inner = findInForest(b.children, id)
    if (inner) return inner
  }
  return undefined
}

/**
 * 把编辑器里的 **N 个 root** 逐项写回森林。
 *
 * 每个 root 都是一个**真实容器**：按 `root.id` 找森林里的活块，写回正文/子树。
 * 与旧的 `syncActivePage`（只认 `roots[0]`）相比，这是「N=1 是特例」收回成通例的那一步。
 *
 * ⚠️ journal 的 `text` 是 `_date` 的只读投影⇒ **不写 text**。
 * ⚠️ `children` 在编辑器里通常就是同一个数组（共享引用）；这里仍显式赋值，
 *    因为结构操作可能替换 roots 里的 children 数组（如拆块/插入）。
 * ⚠️ 找不到的 root（例如已被删除）静默跳过；命令层负责解释「为什么少了」。
 */
export function writeBackRoots(forest: Block[], roots: readonly Block[]): void {
  for (const root of roots) {
    const p = findInForest(forest, root.id)
    if (!p) continue
    if (!hasRole(p, 'journal')) p.text = root.text
    p.todo = root.todo
    p.collapsed = root.collapsed
    p.children = root.children
  }
}

/**
 * 森林里到某块的**路径**（含它自己）：`[根, …, 它]`；找不到返回 null。
 *
 * ⚠️ zoom 的面包屑就是它去掉末尾 —— **派生、不物化、不入库**：
 *   层级本来就来自 `parent` 链（15 E1），不需要再存一份「焦点栈」）。
 */
export function findPath(forest: readonly Block[], id: string): Block[] | null {
  const walk = (list: readonly Block[], acc: Block[]): Block[] | null => {
    for (const b of list) {
      const next = [...acc, b]
      if (b.id === id) return next
      const inner = walk(b.children, next)
      if (inner) return inner
    }
    return null
  }
  return walk(forest, [])
}

/** 上一块（文档序）；返回 null 表示是首块 */
export function prevBlock(doc: Doc, id: string): Block | null {
  const all = flatten(doc)
  const i = all.findIndex((b) => b.id === id)
  return i > 0 ? all[i - 1]! : null
}

export function descendants(b: Block): Block[] {
  const out: Block[] = []
  const walk = (list: Block[]) => {
    for (const x of list) {
      out.push(x)
      walk(x.children)
    }
  }
  walk(b.children)
  return out
}

export function hasDescendant(doc: Doc, ancestorId: string, maybeChildId: string): boolean {
  const a = locate(doc, ancestorId)
  if (!a) return false
  return descendants(a.block).some((b) => b.id === maybeChildId)
}

/** 深拷贝子树，**所有块发新 id**；原子/mark 的 blockId 由调用方按 id 映射重建 */
export function cloneSubtree(b: Block): { block: Block; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  const cp = (x: Block): Block => {
    const id = uuidv7Hex()
    idMap.set(x.id, id)
    return {
      id,
      text: x.text,
      children: x.children.map(cp),
      ...(x.collapsed ? { collapsed: true } : {}),
      ...(x.todo ? { todo: x.todo } : {}),
    }
  }
  return { block: cp(b), idMap }
}

/* --------------------------------------------------------- 结构操作 */

/**
 * Enter 拆块（块中：同级拆）。
 *
 * **左半进新块、插在原块之前（同级）**；原块保留 id、右半、子树与 todo/props，
 * 光标留在原块 0 位。即：视觉上是「左半在上 / 右半在下＋子块」，但**原块是下半**。
 *
 * 为什么不选「右半成首个子块」：那样用户按一次 Enter 会**多出一层缩进**，
 * 而块内换行是很高频的动作，层数的意外增长会累积成难以整理的文档。
 * 页块是例外：页名是身份，不能拆，只能让右半成为首个子块。
 *
 * 唯一的隐式不变量：**子块永远留在原 id**（旧实现把子树搬到了新 id，已修正）。
 *
 * ⚠️ **只用于「光标在块中」**（`offset < 文本长度`）。offset = 0 时自然退化成
 *    「在上方插一个空块」。
 * ⚠️ 它此前**兼任**过「块尾建新块」，且把子树搬给右半；两处都已拆掉。
 */
export function splitBlockBefore(doc: Doc, id: string, offset: number): { kept: string; inserted: string } | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const off = Math.max(0, Math.min(offset, loc.block.text.length))
  const b = mkBlock(loc.block.text.slice(0, off))
  loc.block.text = loc.block.text.slice(off)
  const list = siblingsOf(doc, loc.parent)
  list.splice(loc.index, 0, b)
  return { kept: loc.block.id, inserted: b.id }
}

/**
 * **根块（section root）的 Enter 拆块**。
 *
 * 根块**没有兄弟位**（写回按 root id 走）⇒ 造不出同级，只能退而造子块：
 * **左半留在根里、右半成为首个子块**，光标到子块。子树不动（新子块插在最前）。
 *
 * 与 `splitBlockBefore` 的分工：
 *   · `splitBlockBefore` —— 有父块：左半成**上方同级新块**；
 *   · 本函数 —— 没有父块：左半留根、右半成**首个子块**。
 *
 * ⚠️ 调用方只对**无角色的内容根**（focus/zoom 的普通块）启用；页/日记/收藏的 `text`
 *    是名字/投影，拆它等于静默改名（由 `editor.split` 的「无角色」判据拦住）。
 * ⚠️ `offset <= 0` 返回 null：那会把根文本清空、把整条内容搬进子块。调用方（editor）
 *    在块首/空块仍走「插一个空首子块」，不调用本函数。
 */
export function splitBlockIntoFirstChild(doc: Doc, id: string, offset: number): { kept: string; inserted: string } | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const off = Math.max(0, Math.min(offset, loc.block.text.length))
  if (off <= 0) return null
  const b = mkBlock(loc.block.text.slice(off))
  loc.block.text = loc.block.text.slice(0, off)
  loc.block.collapsed = false
  loc.block.children.unshift(b)
  return { kept: loc.block.id, inserted: b.id }
}

/**
 * **Enter 的落点判定**（2026-10-20 第四次修订）。
 *
 * 纯函数、只读 —— 之所以把它从 `editor.split()` 里提出来：这条规则**翻过两次**
 * （先「一律同级」，实机试过后改回「有子块⇒子块」；再把块中改成同级拆），
 * 必须有单测钉着，否则下次又会被悄悄改掉而门禁全绿。
 *
 * 四支：
 *   · **空块且缩进 ≥ 2 层** ⇒ `outdent`（Enter 退化成反缩进，不建新块）
 *   · **块中**（offset < 文本长度）⇒ `split`（同级拆：左半成上方新块，原块保 id/右半/子树）
 *   · **块尾 ＋ 有子块且展开** ⇒ `child`（**首个子块**，插在现有子块之前）
 *   · **块尾 ＋ 无子块 / 折叠** ⇒ `sibling`（同级空块）
 *
 * ⚠️ **section 根不走本函数**（`editor.split` 先判 `loc.parent === null`）：
 *    无角色的内容根中间拆成首子块；有角色的根仍插空首子块。本函数只判非根块。
 *
 * `outdent` 的判据：文本**长度 0**（空格不算）＋ **父块不是 section 根**
 * （即 `loc.parent` 自己还有父块）。顶层内容块（父 = 页/天根）不能反缩进，仍走 `sibling`/`child`。
 *
 * 规则的四个分支：
 *   · 折叠 ⇒ 同级；
 *   · 空块（有父块）⇒ 反缩进；
 *   · 块中 ⇒ 同级拆（左半在上、原块保右半＋子块）；
 *   · 块尾 ＋ 展开有子块 ⇒ 插首个子块；块尾 ＋ 无子块 ⇒ 同级。
 *
 * ⇒ 「折叠 ⇒ 同级」尤其重要：折叠时子树看不见，再插子块会**插进一个不可见的层**。
 */
export function enterKind(doc: Doc, id: string, offset: number): 'split' | 'child' | 'sibling' | 'outdent' {
  const loc = locate(doc, id)
  if (!loc) return 'sibling'
  if (loc.block.text.length === 0 && canOutdent(doc, loc.parent)) return 'outdent'
  if (offset < loc.block.text.length) return 'split'
  const expandedWithChildren = loc.block.children.length > 0 && !loc.block.collapsed
  return expandedWithChildren ? 'child' : 'sibling'
}

/**
 * 空块 Enter 能否反缩进（不建新块、只退一层）。
 *
 * **父块自己还有父块**才允许：顶层内容块（父 = 页/天/zoom 根）反缩进会离开当前 section
 * （写回按 root id 走 ⇒ 那个块没有家），必须拦住。
 */
function canOutdent(doc: Doc, parent: Block | null): boolean {
  if (!parent) return false
  const parentLoc = locate(doc, parent.id)
  return Boolean(parentLoc?.parent)
}

/**
 * **在 id 之后插入一个同级空块**（块尾 Enter 的 `sibling` 分支）。
 *
 * 与 `splitBlockBefore` 的分工（这条边界是 立的）：
 *   · `splitBlockBefore` —— 光标在块**中**，右半非空 ⇒ **同级拆**（左半成上方新块）；
 *   · 本函数 —— 光标在块**尾**且**无子块（或已折叠）** ⇒ 建一个**同级**空块（建）。
 *
 * ⚠️ 它**不判断**该不该建同级——那是 `enterKind()` 的事。本函数只管「插」。
 * ⚠️ 子树**原地不动**：同级新块插在兄弟列表里，不碰 `children`。
 */
export function insertSiblingAfter(doc: Doc, id: string): Block | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const b = mkBlock('')
  const list = siblingsOf(doc, loc.parent)
  list.splice(loc.index + 1, 0, b)
  return b
}

/** 把 id 块的口径插成它的**首个子块**的 `child` 分支 */
export function insertFirstChild(doc: Doc, id: string): Block | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const b = mkBlock('')
  loc.block.collapsed = false
  loc.block.children.unshift(b)
  return b
}

/** Backspace 合并：把 id 块并入前一块（**前一块保留 id**） */export function mergeIntoPrev(doc: Doc, id: string): { kept: string; removed: string; at: number } | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const prev = prevBlock(doc, id)
  if (!prev) return null
  const at = prev.text.length
  prev.children.push(...loc.block.children)
  prev.text = prev.text + loc.block.text
  const list = siblingsOf(doc, loc.parent)
  list.splice(loc.index, 1)
  return { kept: prev.id, removed: id, at }
}

/**
 * Backspace 的另一种分支：块尾删到空 → 变普通块；已经是普通空块且非首块 → 合并。
 * 返回被删的块（`removed`），调用方据此决定光标落点。
 */
export function mergePrevShallow(doc: Doc, id: string): string | null {
  const r = mergeIntoPrev(doc, id)
  return r ? r.kept : null
}

/** 跨行替换：把 [fromId..toId]（文档序闭区间）替换为 lines；**替换区首块继承首块 id** */
export function replaceBlockRange(doc: Doc, fromId: string, toId: string, lines: string[]): string[] {
  const all = flatten(doc)
  const i = all.findIndex((b) => b.id === fromId)
  const j = all.findIndex((b) => b.id === toId)
  if (i < 0 || j < 0 || j < i) return []
  const first = all[i]!
  const firstLoc = locate(doc, first.id)!
  const list = siblingsOf(doc, firstLoc.parent)
  const idx = firstLoc.index
  const removed = new Set<Block>()
  for (let k = i; k <= j; k++) {
    const loc = locate(doc, all[k]!.id)
    if (loc && siblingsOf(doc, loc.parent) === list) removed.add(loc.block)
  }
  const kept = lines.map((t, n) => (n === 0 ? ((first.text = t), first) : mkBlock(t)))
  list.splice(idx, removed.size || j - i + 1, ...kept)
  return kept.map((b) => b.id)
}

/** 缩进：变前兄弟的最后一个孩子（tab） */
export function indentBlock(doc: Doc, id: string): boolean {
  const loc = locate(doc, id)
  if (!loc || loc.index === 0) return false
  const list = siblingsOf(doc, loc.parent)
  const prev = list[loc.index - 1]!
  list.splice(loc.index, 1)
  prev.children.push(loc.block)
  prev.collapsed = false
  return true
}

/** 取消缩进：变父的下一个兄弟（shift+tab） */
export function outdentBlock(doc: Doc, id: string): boolean {
  const loc = locate(doc, id)
  if (!loc || !loc.parent) return false
  const parentLoc = locate(doc, loc.parent.id)
  if (!parentLoc) return false
  const parentList = siblingsOf(doc, parentLoc.parent)
  const kids = loc.parent.children
  kids.splice(loc.index, 1)
  parentList.splice(parentLoc.index + 1, 0, loc.block)
  return true
}

/** 与相邻兄弟交换（mod+shift+↑/↓） */
export function moveSibling(doc: Doc, id: string, delta: -1 | 1): boolean {
  const loc = locate(doc, id)
  if (!loc) return false
  const list = siblingsOf(doc, loc.parent)
  const to = loc.index + delta
  if (to < 0 || to >= list.length) return false
  const [b] = list.splice(loc.index, 1)
  list.splice(to, 0, b!)
  return true
}

/** 复制块（含子树）：返回新块 id */
export function duplicateBlock(doc: Doc, id: string): string | null {
  const loc = locate(doc, id)
  if (!loc) return null
  const { block } = cloneSubtree(loc.block)
  siblingsOf(doc, loc.parent).splice(loc.index + 1, 0, block)
  return block.id
}

/** 删除块（含子树） */
export function removeBlock(doc: Doc, id: string): boolean {
  const loc = locate(doc, id)
  if (!loc) return false
  siblingsOf(doc, loc.parent).splice(loc.index, 1)
  return true
}

/** 拖拽挂载：把 id 挂到 target 的 before/after/inside（自带循环守卫） */
export function moveBlockTo(doc: Doc, id: string, targetId: string, pos: 'before' | 'after' | 'inside'): boolean {
  if (id === targetId) return false
  if (hasDescendant(doc, id, targetId)) return false
  const loc = locate(doc, id)
  const tgt = locate(doc, targetId)
  if (!loc || !tgt) return false
  siblingsOf(doc, loc.parent).splice(loc.index, 1)
  const tgt2 = locate(doc, targetId)!
  if (pos === 'inside') {
    tgt2.block.children.push(loc.block)
    tgt2.block.collapsed = false
  } else {
    const list = siblingsOf(doc, tgt2.parent)
    const at = pos === 'before' ? locate(doc, targetId)!.index : locate(doc, targetId)!.index + 1
    list.splice(at, 0, loc.block)
  }
  return true
}

export function setCollapsed(doc: Doc, id: string, v: boolean): boolean {
  const loc = locate(doc, id)
  if (!loc) return false
  loc.block.collapsed = v
  return true
}

export function toggleCollapsed(doc: Doc, id: string): boolean {
  const loc = locate(doc, id)
  if (!loc) return false
  loc.block.collapsed = !loc.block.collapsed
  return true
}

/**
 * **折 / 展一个块的全部直接子块**（调研 ；对的修订）。
 *
 * 与 `toggleCollapsed` 的分工（这条边界是「点线 ≠ 点三角」的落点）：
 *   · `toggleCollapsed`        —— 折**该块自己**（折叠三角、`mod+.`）；
 *   · `toggleChildrenCollapsed` —— 折它的**直接子块**（点导轨段；**不递归、不动自己**）。
 *
 * 判据（为什么默认折「直接子块」而不是「自己」）：
 *   · **折子块，父块自己不折** ⇒ 父块的导轨段仍画在那些「已折叠但仍可见」的子块行上，
 *     同一 x 再点命中**同一个目标**，「再点展开」才成立；
 *   · 折自己则会让指向它的段随宿主行一起消失，同位置换成别的祖先 ⇒ 点第二下变成折别人。
 *   · 「折整棵子树」（递归）留作 `⌥+点线`，不占默认语义。
 *
 * ⚠️ **判定必须按整组**：一组里只要还有开着的，这次就是「折」。
 *    逐个取反会让「一半折一半开」的组点一次之后仍是半折半开。
 *
 * @returns 本次意图：`true` ＝ 折了，`false` ＝ 展了；**无子块 ⇒ `null`**（调用方据此拒绝）
 */
export function toggleChildrenCollapsed(doc: Doc, id: string): boolean | null {
  const loc = locate(doc, id)
  if (!loc || loc.block.children.length === 0) return null
  const anyOpen = loc.block.children.some((c) => c.collapsed !== true)
  for (const c of loc.block.children) c.collapsed = anyOpen
  return anyOpen
}

/* ------------------------------------------- 文本变更 → 区间粘性映射 */
