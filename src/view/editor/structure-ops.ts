/**
 * 结构操作：拆块（Enter）／合并（Backspace）／缩进与反缩进／换位／多块拖拽落点／
 * 复制／软删／回收站恢复／可写容器补空格。
 *
 * 从 BlockEditor 拆出的协作对象：没有自有状态，全部经 `ed`。落点全部由
 * `core` 的 `*Move` 纯函数算（一个真相），这里只决定**谁来写**与**怎么收尾**
 * （`structTail` 管光标与重画）；每条「撤销一次全回」的纪律跟着方法走。
 */
import {
  cloneSubtree,
  enterKind,
  flatten,
  hasDescendant,
  hasIdentity,
  hasLiveChildren,
  indentMove,
  isJournal,
  isQueryBlock,
  locate,
  mergeIntoPrevPlan,
  mkBlock,
  moveStaysInside,
  normSel,
  outdentMove,
  prevPlaceholder,
  siblingMove,
  siblingsOf,
  splitPropsForEnter,
  trashOf,
  typeDeclOf,
  unfoldBlock,
  writeBlockContent,
  type MovePlan,
} from '../../core/index.ts'
import { plainLen, spliceRuns, splitRuns } from '../../core/model/runs.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { BlockEditor } from './editor.ts'

export class StructOps {
  constructor(private readonly ed: BlockEditor) {}

  split(id: string, offset: number): void {
    /**
     * **编辑边界**：Enter 就是离开这一行 ⇒ 先把这次正文改动当改名交出去。
     * 拒绝时正文已回滚，拆点要收回到新正文长度之内（否则会按旧长度切开一行短文本）。
     */
    this.ed.commitEdit(id)
    this.ed.beginUndoEntry()
    const loc = locate(this.ed.doc, id)
    if (!loc) return
    /**
     * **同块选区 + Enter = 先删选区，再在选区起点拆**（只做无角色的普通内容块；
     * 跨块选区与页名等身份块仍走原行为）。删除与拆分在**同一笔**里落。
     */
    const sel = this.ed.sel
    const cut =
      loc.parent !== null && !hasIdentity(loc.block) && sel && sel.aBlock === id && sel.hBlock === id && sel.aOff !== sel.hOff
        ? { from: Math.min(sel.aOff, sel.hOff), to: Math.max(sel.aOff, sel.hOff) }
        : null

    const out = this.ed.write((tx) => this.splitTx(tx, id, offset, cut))
    if (!out) return
    this.ed.structTail(out.caret ?? null)
  }

  /**
   * **一次回车 ＝ 一笔事务**：同块选区删除、结构拆分共用这一笔。
   *
   * 为什么必须同笔：拆开落盘会得到「内容直写、结构进 op」两份来源 —— 半批比慢更贵。
   *
   * 拆分＝内容按 plain 偏移切两半：格式随切片走、原子的归属按切点自然分家，
   * 没有「锚点搬家」这一步——它们本来就在内容里。
   *
   * ⚠️ 事务里不再 `splice`：落点全部交给 `tx.insert`／`tx.move`（按整片森林取兄弟列表）。
   */
  private splitTx(
    tx: Tx,
    id: string,
    offset: number,
    cut: { from: number; to: number } | null,
  ): { caret: { id: string; off: number } | null } | null {
    const blk = this.ed.store.find(id)
    if (!blk) return null
    // 同块选区先删：只在**内存**里切掉，切点收回到选区起点——
    // 删与拆最终只落**一次**内容写入（两次 patch 会把同一件事记成两段碎账）
    let content = blk.content
    if (cut) {
      const from = Math.max(0, Math.min(cut.from, plainLen(content)))
      const to = Math.max(from, Math.min(cut.to, plainLen(content)))
      content = spliceRuns(content, from, to, '')
      offset = from
    }
    offset = Math.min(offset, plainLen(content))

    const loc = locate(this.ed.doc, id)
    if (!loc) return null

    // 段根没有兄弟位（写回按 root id 走）⇒ 右半成首个子块；有身份的根只插空子块
    if (loc.parent === null) {
      if (!hasIdentity(loc.block) && offset > 0 && offset < plainLen(content)) {
        const [left, right] = splitRuns(content, offset)
        tx.patch(id, (b) => writeBlockContent(b, left))
        const rightBlock = mkBlock(right)
        tx.insert(rightBlock, id, 0)
        unfoldBlock(this.ed.doc, id)
        return { caret: { id: rightBlock.id, off: 0 } }
      }
      const child = mkBlock('')
      unfoldBlock(this.ed.doc, id)
      tx.insert(child, id, 0)
      return { caret: { id: child.id, off: 0 } }
    }

    // 段根已在上面 return ⇒ 这里一定在某个父块下面
    const parent = loc.parent
    const kind = cut ? 'split' : enterKind(this.ed.doc, id, offset)

    if (kind === 'outdent') {
      // 空块 Enter ⇒ 反缩进：不建新块（与这笔里的转换同一笔）
      const plan = outdentMove(this.ed.doc, id)
      if (!plan) return { caret: null }
      tx.move(id, plan.parentId, plan.index)
      return { caret: { id, off: 0 } }
    }

    if (kind === 'child') {
      const b = mkBlock('')
      unfoldBlock(this.ed.doc, id)
      tx.insert(b, id, 0)
      return { caret: { id: b.id, off: 0 } }
    }

    if (kind === 'sibling') {
      const b = mkBlock('')
      tx.insert(b, parent.id, loc.index + 1)
      return { caret: { id: b.id, off: 0 } }
    }

    // 块中 ⇒ 同级拆：左半进**上方新块**；原块保 id、右半、子树。
    // **值属性随前半走**（判据在 core 的 `splitPropsForEnter`）：任务标记这类
    // 属性说的是前半那句话，下半是续文，不继承。
    const [left, right] = splitRuns(content, offset)
    const { moved, kept } = splitPropsForEnter(loc.block.props)
    const leftBlock = mkBlock(left, moved ? { props: moved } : {})
    tx.insert(leftBlock, parent.id, loc.index)
    tx.patch(id, (b) => {
      writeBlockContent(b, right)
      b.props = kept
    })
    return { caret: { id: !cut && offset === 0 ? leftBlock.id : id, off: 0 } }
  }

  mergeBack(id: string): void {
    const all = flatten(this.ed.doc)
    const i = all.findIndex((b) => b.id === id)
    if (i <= 0) return
    this.ed.beginUndoEntry()
    /**
     * 先问「前一块是不是一条没有正文的占位线」：那种情况下这次退格的含义是
     * **删掉它**，而不是「把字并进去」（它没有字可并）。
     * 两支互斥，所以顺序不影响别的块：合并路径只在两边都有正文时成立。
     */
    const placeholder = prevPlaceholder(this.ed.doc, id)
    if (placeholder) {
      this.ed.write((tx) => tx.remove(placeholder.removed))
      this.ed.structTail({ id, off: 0 })
      return
    }
    const plan = mergeIntoPrevPlan(this.ed.doc, id)
    if (!plan) return
    /**
     * 内容拼接在 core 层完成（`joinRuns`：边界两侧同形段合并、原子原样排队）。
     * 被并块的字现在排在前一块内容的**末尾** ⇒ 光标落在粘接点 `plan.at`。
     */
    this.ed.write((tx) => {
      tx.patch(plan.kept, (b) => writeBlockContent(b, plan.content))
      // 子块跟着并进前一块：每块一条 move（各自报自己的 parent/index）
      plan.children.forEach((kid, n) => tx.move(kid, plan.kept, plan.kidsAt + n))
      // 被并块的内容已搬进前一块 ⇒ 空壳**清空**：删除是原位标记，壳还留在树上，
      // 留着内容就是库里有两份同一句话（恢复出来就是重复块）
      tx.patch(plan.removed, (b) => writeBlockContent(b, []))
      tx.remove(plan.removed)
    })
    this.ed.structTail({ id: plan.kept, off: plan.at })
  }

  /** Backspace：块首合并到上一块；否则交给原生删除 */
  backspaceAtCaret(): boolean {
    const s = this.ed.sel
    if (!s) return false
    const r = normSel(this.ed.doc, s)
    if (r.startBlock !== r.endBlock) return false
    if (s.aOff !== 0 || s.hOff !== 0) return false
    /**
     * **根块的行首退格没有「上一块」**：`doc.roots` 是这一屏的边界，不是整片森林。
     * 放它进 `mergeBack` 会让「第 2 个结果行」并进「第 1 个结果行的最后一个后代」——
     * 跨结果行合并，正文被搬到另一棵子树里，而用户只按了一次退格。
     *
     * 判据是「这一块在**本视图**里是不是根」，不是「它在森林里有没有上一块」：
     * 镜像的源块、查询命中、feed 里第二天，都在本视图里是根，退格只该吃掉。
     */
    const loc = locate(this.ed.doc, s.aBlock)
    if (!loc || loc.parent === null) return true
    const all = flatten(this.ed.doc)
    const i = all.findIndex((x) => x.id === s.aBlock)
    /**
     * **块首但没有上一块可并（首块）⇒ 这次退格没有语义，必须吃掉它。**
     *
     * 放给浏览器会出真事故：原生删除看不见「块」这个单位，它只看见一串内联元素，
     * 于是会把 gutter（`.left`）和正文（`.tx`）当成两个可删的节点整段摘掉——
     * 那一行从此**没有可落光标的地方**，用户看到的是「把这块删空之后再也打不进字」
     * （光标还在编辑器里、选区也还在，就是字进不去）。
     * ⇒ 判据是「这一下有没有事可做」：有事就自己做，没事就吞掉，绝不交给浏览器。
     */
    if (i <= 0) return true
    this.mergeBack(s.aBlock)
    return true
  }

  indent(id: string): void {
    const plan = indentMove(this.ed.doc, id)
    this.structuralMove(id, plan, { unfoldId: plan?.parentId ?? null })
  }

  outdent(id: string): void {
    this.structuralMove(id, outdentMove(this.ed.doc, id))
  }

  /**
   * 批量缩进（块选区 Tab）：文档序逐块落进**各自当时**的前兄弟——
   * 连续选区里后一块的前兄弟会随前一块搬走而变成同一个目标，整段选区自然
   * 保持原有次序一起进同一层。一笔撤销；section 根与前兄弟不可收留的块跳过。
   *
   * ⚠️ **落点先算好再动手**（与批量删除同一条纪律）：写路径里的树要过事务，
   * 边写边 locate 读到哪棵树是没保证的；全部落点从**同一份快照**推出、
   * 前一块的最终位置喂给后一块（它的前兄弟刚搬走 ⇒ 跟着进同一层），一笔事务落。
   */
  indentMany(ids: readonly string[]): boolean {
    const snap = this.ed.doc
    /** 前一个兄弟位在本批里已经搬走的块 → 它的最终落点（后一块跟着进同一层） */
    const movedPrev = new Map<string, { parentId: string; index: number }>()
    /** 同一目标层本批已追加几个（前兄弟没搬的块落在快照长度之后，按这个顺延） */
    const appendedTo = new Map<string, number>()
    const plans: { id: string; parentId: string; index: number }[] = []
    let firstTarget: string | null = null
    for (const id of ids) {
      const loc = locate(snap, id)
      if (!loc || loc.parent === null) continue
      const prev = siblingsOf(snap, loc.parent)[loc.index - 1] ?? null
      const chained = prev ? movedPrev.get(prev.id) : undefined
      const plan = chained
        ? { parentId: chained.parentId, index: chained.index + 1 }
        : indentMove(snap, id)
      if (!plan || plan.parentId === null || !this.scopeAllowsMove(id, plan)) continue
      const index = chained ? plan.index : plan.index + (appendedTo.get(plan.parentId) ?? 0)
      if (plans.length === 0) firstTarget = plan.parentId
      plans.push({ id, parentId: plan.parentId, index })
      movedPrev.set(id, { parentId: plan.parentId, index })
      appendedTo.set(plan.parentId, (appendedTo.get(plan.parentId) ?? 0) + 1)
    }
    if (plans.length === 0) return false
    this.ed.beginUndoEntry()
    /**
     * ⚠️ **改前落点要专门记**。撤销恢复走 `prev`（前兄弟 id），而实移会改掉后面
     * 块的 prev：先移 A，B 的「改前落点」就被记成 mid-batch 的（prev 全坍缩到
     * 同一个目标层），撤销按 prev 恢复时次序整个倒掉（实测 [A,B,C] → [C,B,A]）。
     * ⇒ 实移前先给每块做一次**原位 move**（no-op，位置不变），让捕获里记下的
     *   「改前落点」是真·批前落点；撤销按状态序逐块 prev 恢复，次序自然对。
     */
    for (const p of plans) {
      const cur = locate(snap, p.id)
      if (cur) this.ed.write((tx) => tx.move(p.id, cur.parent?.id ?? null, cur.index))
    }
    for (const p of plans) {
      this.ed.write((tx) => {
        tx.move(p.id, p.parentId, p.index)
        tx.patch(p.id, (x) => (x.modified = Date.now()))
      })
    }
    // 刚搬进去的那一层必须看得见（与单块缩进同一条纪律）
    if (firstTarget) unfoldBlock(this.ed.doc, firstTarget)
    this.ed.structTail()
    return true
  }

  /**
   * 批量反缩进（块选区 Shift+Tab）：同一父块的块都插到「父的下一个兄弟位」，
   * 后处理的块按已有几个顺延一格，原有次序保持。一笔撤销。
   */
  outdentMany(ids: readonly string[]): boolean {
    const snap = this.ed.doc
    /** 同一落点层（某个父的下一个兄弟位）本批已占几个 */
    const appendedTo = new Map<string, number>()
    const plans: { id: string; parentId: string; index: number }[] = []
    for (const id of ids) {
      const loc = locate(snap, id)
      if (!loc || loc.parent === null) continue
      const plan = outdentMove(snap, id)
      if (!plan || plan.parentId === null || !this.scopeAllowsMove(id, plan)) continue
      const index = plan.index + (appendedTo.get(plan.parentId) ?? 0)
      plans.push({ id, parentId: plan.parentId, index })
      appendedTo.set(plan.parentId, (appendedTo.get(plan.parentId) ?? 0) + 1)
    }
    if (plans.length === 0) return false
    this.ed.beginUndoEntry()
    // 同 indentMany：实移前先原位 no-op 记下真·改前落点（理由见那边）
    for (const p of plans) {
      const cur = locate(snap, p.id)
      if (cur) this.ed.write((tx) => tx.move(p.id, cur.parent?.id ?? null, cur.index))
    }
    for (const p of plans) {
      this.ed.write((tx) => {
        tx.move(p.id, p.parentId, p.index)
        tx.patch(p.id, (x) => (x.modified = Date.now()))
      })
    }
    this.ed.structTail()
    return true
  }

  move(id: string, delta: -1 | 1): void {
    this.structuralMove(id, siblingMove(this.ed.doc, id, delta))
  }

  /**
   * 这一笔结构移动的落点还在不在本视图的可寻址范围内。
   *
   * `structuralScope === 'document'` 时全放行（正文/页的真实位置）。
   * `'roots'`（查询结果、镜像）时由 `moveStaysInside` 回答：根不搬、落点不出窗口。
   */
  private scopeAllowsMove(id: string, plan: MovePlan): boolean {
    if (this.ed.structuralScope !== 'roots') return true
    return moveStaysInside(this.ed.doc, id, plan)
  }

  /**
   * 结构移动的**统一落点管道**（缩进 / 反缩进 / 上下换位 / 拖拽）。
   *
   * 落点由 `core/tree.ts` 的 `*Move` 算（一个真相），这里只决定**谁来写**：
   * 注入事务入口时走 `tx.move` —— 一次移动就是一条 `block.upsert{parent,index}`；
   * 没有事务入口时才直改活块（迁移期兜底）。
   *
   * ⚠️ 折叠态不跟着进事务：那是「这一行此刻收着」，不是内容（与 `unfoldBlock` 同源）。
   *    缩进进去 / 拖进去之后必须展开，否则块被折在一个看不见的层里。
   * ⚠️ 事务里**只**开移动那一笔：`applyMove` 与 `tx.move` 是同一件事实的两种落地，
   *    都写一次就等于同一件事记两遍。
   */
  /** 拖拽协作对象的统一落手也走这里；签名不动，只是不再私有 */
  structuralMove(
    id: string,
    plan: MovePlan | null,
    o: { unfoldId?: string | null; caretAt?: { id: string; off: number } } = {},
  ): void {
    if (!plan) return
    if (!this.scopeAllowsMove(id, plan)) return
    this.ed.beginUndoEntry()
    this.ed.write((tx) => {
      tx.move(id, plan.parentId, plan.index)
      // 结构换位置也是一次改动：时刻若只跟着正文走，块会被搬到别处、时间停在原处
      tx.patch(id, (x) => (x.modified = Date.now()))
    })
    if (o.unfoldId) unfoldBlock(this.ed.doc, o.unfoldId)
    this.ed.structTail(o.caretAt ?? (this.ed.sel ? { id: this.ed.sel.aBlock, off: this.ed.sel.aOff } : null))
  }

  /**
   * **多块拖拽**：把一组最上层根作为一个**连续的 run** 落到目标处。
   *
   * 为什么不能逐块算 `dropMove` 再挨个落：
   * 每次移动都会从原列表摘掉一块、再插进目标位；同一列表里「后一块」的最终下标
   * 会被前面已经搬走的块改变（实测把 `[B,C]` 拖回 `D` 前面会得到 `[A,B,D,C]`）。
   * ⇒ 先确认「这一组最终落在目标父的哪个下标」，再做两段写：
   *   ① 全部追加到目标父末尾（文档序，先得到一个有序的 run）；
   *   ② 从后往前把每块插到 `index`（逆序插入 ⇒ 正是在 index 处拼回原序）。
   * 两段在同一条事务里，一次 ⌘Z 全回。
   *
   * 目标落在被拖子树里（含自己）⇒ 不移动：那会造环，和单块拖拽同一条守卫。
   * 派生面（查询结果／镜像）的根不在块选区里（选区只收 depth > 0），但落点仍要走
   * `structuralScope === 'roots'` 的同一道门：不能把块搬到本文档之外。
   */
  moveBlocksTo(ids: readonly string[], targetId: string | null, zone: 'before' | 'after' | 'inside'): boolean {
    const roots = [...new Set(ids)].filter((id) => locate(this.ed.doc, id)?.parent !== null)
    if (roots.length === 0) return false
    const snap = this.ed.doc
    const locOf = new Map(roots.map((id) => [id, locate(snap, id)] as const))
    if (locOf.size === 0) return false
    // 目标不能落在被拖的子树里（含选中的块自己）
    if (targetId !== null) {
      for (const id of roots) {
        if (id === targetId || hasDescendant(snap, id, targetId)) return false
      }
    }
    /** 目标父里，本批有几块**直接**子块（它们会先被摘走再追加回来） */
    const directChildren = (parentId: string): number => {
      let n = 0
      for (const loc of locOf.values()) if (loc?.parent?.id === parentId) n++
      return n
    }
    /** 目标父里、下标在 `at` 之前的本批块数（它们摘走后目标下标要前移） */
    const beforeAt = (parentId: string, at: number): number => {
      let n = 0
      for (const loc of locOf.values()) if (loc?.parent?.id === parentId && loc.index < at) n++
      return n
    }

    let parentId: string
    let index: number
    if (targetId === null) {
      const root = snap.roots[snap.roots.length - 1]
      if (!root || typeDeclOf(root).children === 'none') return false
      parentId = root.id
      index = root.children.length - directChildren(parentId)
    } else {
      const tgt = locate(snap, targetId)
      if (!tgt) return false
      if (zone === 'inside') {
        if (typeDeclOf(tgt.block).children === 'none') return false
        parentId = tgt.block.id
        index = tgt.block.children.length - directChildren(parentId)
      } else {
        if (!tgt.parent) return false
        parentId = tgt.parent.id
        index = tgt.index + (zone === 'after' ? 1 : 0) - beforeAt(parentId, tgt.index)
      }
    }
    // 目标父不能在被拖的子树里（与「目标落在被拖子树里」是同一件事的另一侧）
    for (const id of roots) if (id === parentId || hasDescendant(snap, id, parentId)) return false
    // 派生面：根不搬、落点必须在本文档里（与单块 `moveStaysInside` 同一条门）
    if (this.ed.structuralScope === 'roots' && !locate(snap, parentId)) return false

    this.ed.beginUndoEntry()
    this.ed.write((tx) => {
      /**
       * **改前落点要先记**：撤销按「前兄弟 id」恢复，而随后的实移会把后面块的 prev 改掉。
       * 先在原位做一次 no-op move（位置不变），让捕获记下真·批前落点；否则撤销会
       * 按迁移途中的 prev 恢复，次序整个倒过来（实测 [A,B,C] → [C,B,A]）。
       */
      for (const id of roots) {
        const loc = locOf.get(id)
        const parent = loc?.parent?.id
        if (parent) tx.move(id, parent, loc!.index)
      }
      // ① 先按文档序追加到目标父末尾，得到一个有序的 run
      for (const id of roots) tx.move(id, parentId, Number.MAX_SAFE_INTEGER)
      // ② 从后往前插到 index：每次插到同一位置，后插的会排到前面，逆序拼回原序
      for (let i = roots.length - 1; i >= 0; i--) tx.move(roots[i]!, parentId, Math.max(0, index))
      for (const id of roots) tx.patch(id, (x) => (x.modified = Date.now()))
    })
    if (zone === 'inside' && targetId) unfoldBlock(this.ed.doc, targetId)
    this.ed.structTail()
    this.ed.bsel.paintBlockSel()
    return true
  }

  duplicate(id: string): string | null {
    const loc = locate(this.ed.doc, id)
    if (!loc) return null
    /**
     * 结果集/镜像的根是派生的：复制根会插到窗口顶上（`parentId: null`），
     * 那是一个刷新就消失的位置。根要复制，走源位置。
     */
    if (this.ed.structuralScope === 'roots' && loc.parent === null) return null
    this.ed.beginUndoEntry()
    // 克隆自带内容（原子已换新 id——复制的是内容不是身份），没有第二份锚点要搬
    const { block } = cloneSubtree(loc.block)
    this.ed.write((tx) => tx.insert(block, loc.parent?.id ?? null, loc.index + 1))
    this.ed.structTail({ id: block.id, off: 0 })
    return block.id
  }

  /**
   * 从回收站恢复一块：它回原位（`Tx.restore`），整棵子树一起重新可见。
   *
   * 为什么走编辑器而不是模型层的裸 `kb.tx`：**写入口只有一个**（`this.write` 里带着
   * 撤销条目与落盘排期）。绕过去的话，这次恢复不进撤销栈、也不触发落盘——
   * 用户按 ⌘Z 撤不回来，关掉应用还会丢。
   */
  restoreFromTrash(id: string): boolean {
    this.ed.beginUndoEntry()
    /**
     * 恢复的是**被删的那个操作根**；它的祖先若也被删了，它仍然不可见
     * （不可见是继承来的）⇒ 这种情况如实返回 `false`，由调用方给文案。
     *
     * ⚠️ 查它必须**含被删块**：`findInForest` 走可见遍历，看不见已删的块
     *    （实测踩到：用它查，恢复永远返回 false）。所以用 `trashOf` 的那一份清单。
     */
    const inTrash = trashOf(this.ed.store.blocks).some((b) => b.id === id)
    if (!inTrash) return false
    this.ed.write((tx) => {
      tx.restore(id)
    })
    this.ed.structTail()
    return true
  }

  /**
   * 删一块。**返回值回答「真的删了」**：两条守卫（有身份的装载根／`allowRootRemove`
   * 关掉的实例）会静默拒绝——调用方要拿这个值决定 toast 说不说「已删除」，
   * 不然就是「提示删了、其实没删」（露面岛的源行上真踩过：菜单在源上、
   * 源是有身份的根 ⇒ 拒绝，toast 照发）。
   */
  remove(id: string): boolean {
    const loc = locate(this.ed.doc, id)
    if (!loc) return false
    /**
     * **有身份的根块不许从编辑器删**（QB-001）——**查询块例外**。
     *
     * 为什么按身份而不是按「是不是根」判：正文的根既可能是
     *   · 一个**有身份的容器**（页／日记／反链）—— 它是视图的装载单位，
     *     `doc.roots[0]` 就是森林里那块本身；删它要走命令面（`core.page/delete` 那一路，
     *     带「至少留一页」与换邻页）。删掉它只 splice 视图的话，库里那块还在
     * ⇒ 刷新就回来（「删了又复活」比报错更糟）。
     *   · 也可能是一个**普通内容块**（zoom 进来的某一块）—— 没有身份语义，
     *     删掉就是删掉这块内容，应当放行。
     *   · **查询块根**：晋升出来的查询是内容，又没有自己的删除命令面——
     *     也按内容放行（整棵软删、⌘Z 可回）。
     *
     * ⚠️ `allowRootRemove: false` 是另一条更严的线（实例显式关掉才生效），只服务
     *    **绑定单一块的岛**：侧槽窗口（根是钉住的锚块，删掉窗口就没有对象——
     *    收尾是关闭不是删除）与卡片格（岛与块 id 绑定，提交假定块存在）。
     *    其余面默认放行：行的删除＝软删真块，面按 store 重算收尾。
     */
    if (loc.parent === null && hasIdentity(loc.block) && !isQueryBlock(loc.block)) return false
    if (loc.parent === null && !this.ed.allowRootRemove) return false
    this.ed.beginUndoEntry()
    const idx = flatten(this.ed.doc).findIndex((b) => b.id === id)
    const wasRoot = loc.parent === null
    /**
     * **窗口里只剩这一块**时，删掉之后必须补一块可编辑的空块，否则编辑器没有落点。
     *
     * 补的那块要**真的落进森林**（插在原来那块的位置），不能只塞进 `doc.roots`：
     * 窗口 roots 不是森林的根，塞进去会得到一个刷新就消失的块。所以它与删除同一笔事务。
     *
     * ⚠️ UI 的三个删除入口都带 `!blockIsRoot` ⇒ 正常操作删不到装载根，这一支只服务 API/测试。
     */
    const fill = wasRoot && this.ed.rootRemoveFill && this.ed.doc.roots.length === 1 ? mkBlock('') : null
    const forestLoc = fill ? locate({ roots: this.ed.store.blocks }, id) : null
    this.ed.write((tx) => {
      tx.remove(id)
      if (fill && forestLoc) tx.insert(fill, forestLoc.parent?.id ?? null, forestLoc.index)
    })
    // 森林那边已由事务改完；窗口 roots 是**装载单位**，要跟着换掉（它不在事务里）
    if (wasRoot && fill && forestLoc) {
      this.ed.doc.roots.splice(0, this.ed.doc.roots.length, fill)
      this.ed.viewRootIds = [fill.id]
    } else if (wasRoot) {
      this.ed.doc.roots.splice(this.ed.doc.roots.indexOf(loc.block), 1)
      this.ed.viewRootIds = this.ed.viewRootIds.filter((x) => x !== id)
    }
    const after = flatten(this.ed.doc)
    // 关 fill 的实例删空了段（页签删最后一页）：没有落点可给，视图层会回落激活页
    if (after.length > 0) this.ed.structTail({ id: after[Math.min(idx, after.length - 1)]!.id, off: 0 })
    return true
  }

  /**
   * **可写容器至少留一格**（在写出口归一，不挂在某个删除入口上）。
   *
   * journal 的日期行是只读的：一天一旦没有**看得见**的子块，屏幕上就没有任何能落光标
   * 的地方（「打得开却打不了字」），而删除恰恰能造出这个状态——删掉的是块，活下来的
   * 是一天。所以任何一次写之后，装载进来的 journal 段若没有活着的子块，就在**同一笔**
   * 事务里补一个空块：与那次删除同一条撤销，`⌘Z` 一次回到删之前。
   *
   * 为什么在写出口而不是删除入口：删除不止一条路（删块／跨块删／合并／以后新增的路径），
   * 逐个补必然漏一处，而漏了不报错——只是那个入口又变回「点了没反应」。
   * 这里只有一个漏斗；开销与**装载窗口的段数**成正比（每段一次 `some()`，命中即短路），
   * 与库体量无关。
   */
  keepWritableSlots(tx: Tx): void {
    for (const r of this.ed.doc.roots) {
      if (!isJournal(r) || hasLiveChildren(r)) continue
      tx.insert(mkBlock(''), r.id, 0)
    }
  }
}
