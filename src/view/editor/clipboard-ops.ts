/**
 * 剪贴板：复制／粘贴的三种味道（正文、引用、剪切移动）与粘贴落点。
 *
 * 从 BlockEditor 拆出的协作对象：没有自有状态，全部经 `ed`。复制端定身份、
 * 粘贴端定看法的口径只住这一份。`moveClipboardRun` 的次序账（先摘原位、逆序落位）
 * 与多块拖拽是同一本，但管道不复用：剪切粘贴的源可以跨页——⌘X 在 A 页、⌘V 在 B 页
 * 是主用法 ⇒ 源按整片森林定位，落点仍在本视图。
 */
import {
  bareExternalUrl,
  blankRowKind,
  hasDescendant,
  isDeleted,
  isFolded,
  liveChildren,
  locate,
  mkBlock,
  blockLabel,
  refTokensIn,
  setCollapsed,
  typeDeclOf,
  uuidv7Hex,
  writeBlockContent,
  type Block,
  type Doc,
  type Located,
} from '../../core/index.ts'
import {
  joinRuns,
  plainLen,
  plainText,
  sliceRuns,
  spliceRuns,
  splitRuns,
  textRuns,
  type Run as InlineRun,
} from '../../core/model/runs.ts'
import type { ClipboardRefs } from './clipboard-flavor.ts'
import { linkRunOf } from './insert-ops.ts'
import type { BlockEditor } from './editor.ts'

export class ClipboardOps {
  constructor(private readonly ed: BlockEditor) {}

  /** 粘贴落点：光标处；同块内有区间选中时顺带给出要**替换**的范围（与 Enter 的同块删选区同判据） */
  pasteTarget(): { blockId: string; offset: number; cut: { from: number; to: number } | null } | null {
    const blockId = this.ed.sel?.aBlock ?? this.ed.rows()[0]?.block.id
    if (!blockId) return null
    const s = this.ed.sel
    const cut =
      s && s.aBlock === blockId && s.hBlock === blockId && s.aOff !== s.hOff
        ? { from: Math.min(s.aOff, s.hOff), to: Math.max(s.aOff, s.hOff) }
        : null
    return { blockId, offset: s?.aOff ?? 0, cut }
  }

  pasteAt(id: string, offset: number, text: string, cut?: { from: number; to: number } | null): void {
    const loc = locate(this.ed.doc, id)
    if (!loc) return
    // 区间选中＝先删后贴，插入点就是范围起点；两步在**同一笔**内容写里落
    const at = cut ? Math.min(cut.from, cut.to) : offset
    const cutTo = cut ? Math.max(cut.from, cut.to) : offset
    /**
     * 纯 URL 档（在 `((id))` 记号与文本之前）：整段恰好是一条外链 ⇒ 贴成 link 原子，
     * 不落成文字。同块区间选中被替换时，选区文字成为这枚链接的显示文本（选区为空
     * ⇒ 显示地址本身）。判据住 `core`，粘贴端与打开端对协议口径只有一份答案。
     */
    const bare = bareExternalUrl(text)
    if (bare) {
      const anchor = cut ? plainText(sliceRuns(loc.block.content, at, cutTo)).trim() : ''
      this.ed.beginUndoEntry()
      const next = spliceRuns(loc.block.content, at, cutTo, [linkRunOf(bare, anchor)])
      // 与单行粘贴同档（把内容落进这一行）；原子各占 1 格 ⇒ 光标落在原子后面
      this.ed.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)), undefined, { directEdit: true })
      this.ed.finishUndoEntry('insert')
      this.ed.renderAll()
      this.ed.placeCaret(id, at + 1)
      this.ed.emitChange('text')
      return
    }
    const lines = text.split('\n')
    this.ed.beginUndoEntry()
    if (lines.length === 1) {
      const next = spliceRuns(loc.block.content, at, cutTo, this.runsWithRefs(lines[0]!))
      // 单行粘贴与打字同档（把字落进这一行）；多行分支含拆块，归结构路径（下面不标记）
      this.ed.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)), undefined, { directEdit: true })
    } else {
      // 光标处切两半：首行接在左半后面，余下各成新块，**原右半接到最后一块尾部**
      const base = cut ? spliceRuns(loc.block.content, at, cutTo, []) : loc.block.content
      const [head, tail] = splitRuns(base, at)
      const first = joinRuns(head, textRuns(lines[0]!))
      const created: Block[] = []
      for (let i = 1; i < lines.length; i++) created.push(mkBlock(lines[i]!))
      const last = created[created.length - 1]!
      // 这是**刚造出来、还没进树**的新块（上面 `mkBlock` 那批）⇒ 不走内容写入入口，
      // 它的内容随构造一次给定；那里管的是「改写一个已经存在的地址」
      if (tail.length > 0) writeBlockContent(last, joinRuns(last.content, tail))
      const list = loc.parent ? loc.parent.children : this.ed.doc.roots
      /**
       * 落点与 `insertBlockAfter` 同一条规则：section 根没有兄弟位，余下行成为它的**子块**
       * （往 `roots` 里插兄弟就是「看得见、写不回去」的死区）。其余块插在它后面的同级位。
       */
      const parentId = loc.parent ? loc.parent.id : loc.block.id
      const baseIndex = loc.parent ? list.indexOf(loc.block) + 1 : 0
      this.ed.write((tx) => {
        tx.patch(id, (b) => writeBlockContent(b, first))
        created.forEach((c, i) => tx.insert(c, parentId, baseIndex + i))
      })
    }
    this.ed.finishUndoEntry('insert')
    this.ed.renderAll()
    this.ed.placeCaret(id, at + (lines[0]?.length ?? 0))
    this.ed.emitChange('text')
  }

  /**
   * 复制快照：块选区＝最上层根（按序），否则光标所在块。
   * `text` 是随剪贴板走的**正文味**（外部应用贴出的就是它），`ids` 是引用味。
   * 只取当前块不含子树：外部拿到的与屏幕上看到的一致；子树由引用/露面的呈现语义管。
   */
  copySnapshot(): { ids: string[]; text: string } | null {
    if (this.ed.bsel.hasBlockSelection()) {
      const ids = this.ed.bsel.selectedRootIds()
      if (ids.length === 0) return null
      return { ids, text: this.ed.bsel.selectedBlocksText() }
    }
    const id = this.ed.sel?.aBlock ?? this.ed.rows()[0]?.block.id
    if (!id) return null
    const b = locate(this.ed.doc, id)?.block
    if (!b) return null
    return { ids: [id], text: plainText(b.content) }
  }

  /** 划选快照（⌘⇧C 的锚文本）：`selectionSpot` 已把「单块纯文本」的判据收在一处 */
  anchorSnapshot(): { id: string; text: string } | null {
    const spot = this.ed.selectionSpot()
    return spot ? { id: spot.blockId, text: spot.text } : null
  }

  /** 单块的正文味（复制块链接用：软外拿到的是块文本，不是 `((id))` 记号） */
  plainTextOf(id: string): string {
    const b = locate(this.ed.doc, id)?.block ?? this.ed.store.find(id)
    return b ? plainText(b.content) : ''
  }

  /** 造一枚指向 `rid` 的行内引用原子；目标不在（已删/别库）⇒ dangling，照实显示 */
  private refRunTo(rid: string, anchor?: string): InlineRun {
    const t = this.ed.store.find(rid)
    const alive = Boolean(t) && !isDeleted(t!)
    return {
      id: uuidv7Hex(),
      t: 'ref',
      to: alive ? rid : undefined,
      label: t ? blockLabel(t, (id) => this.ed.store.find(id)) : undefined,
      ...(anchor ? { anchor } : {}),
    }
  }

  /**
   * 粘贴文本 → runs 的唯一入口：纯 URL 档在最前，其次 `((id))` 记号（目标不在的
   * 记号照原文留下），都不是 ⇒ 纯文本。文本态与块选区态两条落点共用这一份，
   * 「贴进来的是什么」不该随落点变两副面孔。
   */
  private runsForPaste(text: string): InlineRun[] {
    const bare = bareExternalUrl(text)
    if (bare) return [linkRunOf(bare)]
    return this.runsWithRefs(text)
  }

  /** 正文里的 `((id))` 记号解析成引用 run（目标不在的记号照原文留下） */
  private runsWithRefs(text: string): InlineRun[] {
    const tokens = refTokensIn(text)
    if (tokens.length === 0) return textRuns(text)
    const out: InlineRun[] = []
    let at = 0
    for (const t of tokens) {
      if (t.start > at) out.push(...textRuns(text.slice(at, t.start)))
      const target = this.ed.store.find(t.id)
      if (!target) {
        out.push(...textRuns(text.slice(t.start, t.end)))
      } else {
        // to 指向 anno ⇒ 这一处显示成引文片段，而不是宿主块的名字
        const quote = this.ed.store.index.annos.get(t.id)?.anno.quote?.exact
        out.push({
          id: uuidv7Hex(),
          t: 'ref',
          to: t.id,
          label: blockLabel(target, (id) => this.ed.store.find(id)),
          ...(quote ? { anchor: quote } : {}),
        })
      }
      at = t.end
    }
    if (at < text.length) out.push(...textRuns(text.slice(at)))
    return out
  }

  /**
   * 粘贴一份带引用味的载荷（文本态落点，paste 事件与命令共用）。
   *
   * 剪切味 ⇒ 整组**移动**到落点块的后面（一笔事务，id 不变；标记不消费 ⇒ 可反复贴、
   * 反复移）。引用味 ⇒ 落点处插行内引用原子（带锚文本写 `anchor`，显示名链照旧解析）。
   * 返回 `gone` ＝ 剪切味但源块已都不在 ⇒ 调用方按纯文本降级并给一句实话。
   */
  pasteRefsAt(
    target: { blockId: string; offset: number; cut: { from: number; to: number } | null },
    refs: ClipboardRefs,
  ): 'moved' | 'pasted' | 'gone' | 'refused' {
    if (refs.move) return this.moveClipboardRun(refs.ids, target.blockId, 'after')
    const loc = locate(this.ed.doc, target.blockId)
    if (!loc) return 'gone'
    const runs = refs.ids.map((rid) => this.refRunTo(rid, refs.anchor))
    const at = target.cut ? Math.min(target.cut.from, target.cut.to) : target.offset
    const cutTo = target.cut ? Math.max(target.cut.from, target.cut.to) : target.offset
    this.ed.beginUndoEntry()
    const next = spliceRuns(loc.block.content, at, cutTo, runs)
    // 与单行粘贴同档：把内容落进这一行（directEdit，过内容闸的同一道豁口）
    this.ed.write((tx) => tx.patch(target.blockId, (b) => writeBlockContent(b, next)), undefined, { directEdit: true })
    this.ed.finishUndoEntry('insert')
    this.ed.renderAll()
    this.ed.placeCaret(target.blockId, at + plainText(runs).length)
    this.ed.emitChange('text')
    return 'pasted'
  }

  /**
   * 块选区态的粘贴落点：没有光标，⌘V 的东西作为新块落在选区后面。
   * 剪切味 ⇒ 移动到选区后（源没了 ⇒ 降级为文本）；引用味 ⇒ 每枚引用一块；
   * 纯文本 ⇒ 每行一块（解析走 `runsForPaste`：纯 URL 与 `((id))` 记号与文本态同判据）。
   */
  pasteIntoSelection(refs: ClipboardRefs | null, text: string): 'moved' | 'pasted' | 'gone' | 'refused' {
    const selIds = this.ed.bsel.selectedRootIds()
    const lastId = selIds[selIds.length - 1]
    if (!lastId) return 'gone'
    if (refs?.move) {
      const r = this.moveClipboardRun(refs.ids, lastId, 'after')
      if (r !== 'gone') return r
      // 源已都不在 ⇒ 落到下面的文本分支按正文降级（调用方给实话）
    } else if (refs) {
      return this.insertBlocksAfter(lastId, refs.ids.map((rid) => mkBlock([this.refRunTo(rid, refs.anchor)])))
    }
    return this.insertBlocksAfter(lastId, text.split('\n').map((l) => mkBlock(this.runsForPaste(l))))
  }

  /** 新块插到 `afterId` 后面（同级位；日记根的兄弟位按整片森林算，不是本视图的 roots） */
  private insertBlocksAfter(afterId: string, blocks: Block[]): 'pasted' | 'gone' {
    if (blocks.length === 0) return 'gone'
    const floc = locate({ roots: this.ed.store.blocks }, afterId)
    if (!floc) return 'gone'
    this.ed.beginUndoEntry()
    this.ed.write((tx) => blocks.forEach((b, i) => tx.insert(b, floc.parent?.id ?? null, floc.index + 1 + i)))
    this.ed.structTail()
    this.ed.bsel.paintBlockSel()
    return 'pasted'
  }

  /**
   * 剪贴板移动的核心：把一组块搬到目标块 `zone` 侧，**一笔事务**（undo 一步全回）。
   *
   * 为什么不复用拖拽的 `moveBlocksTo`：那条管道的源必须在本文档里，而剪切粘贴的源
   * 可以在任何页——⌘X 在 A 页、⌘V 在 B 页是主用法。⇒ 源按**整片森林**定位，
   * 落点仍在本视图。同一笔里先在原位 no-op 记下「改前落点」（撤销按 prev 恢复，
   * 不先记会被迁移途中的 prev 污染）、再追加成 run、逆序插回目标位——
   * 这本次序账与多块拖拽是同一本。
   *
   * **落点 = 光标所在的那一行**，由 `blankRowKind` 一份判据给：
   *   · 空行（没正文、可写）是占位 ⇒ 整组占它那一行、它同笔软删让位。否则无论插在
   *     它前面还是后面，都会多留一条空行，看起来就是「块跳过光标一行」；
   *     让位后原光标宿主已不在画面上 ⇒ 光标交给搬来的最后一块的块尾；
   *   · 空行下面挂着子树（容器档）⇒ 让位时把子树按原序交给最后一块接住，
   *     并把这一行原来的折叠态也带过去；屏幕上只变一行，子块的深度与次序不变。
   *     三条例外退回「收首子块、不删这一行」：它带属性、最后一块不许有子块、
   *     搬来的块里有它的子孙（换父会成环）。
   *
   * 派生面（查询结果／镜像）不收结构性粘贴：结果行不是块的位置。
   * 标记是意图不是锁：调用方对同一份剪贴板可以反复调（反复贴＝反复移）。
   */
  private moveClipboardRun(ids: readonly string[], targetId: string, zone: 'before' | 'after'): 'moved' | 'gone' | 'refused' {
    if (this.ed.structuralScope === 'roots') return 'refused'
    const forest: Doc = { roots: this.ed.store.blocks }
    const tgt = locate(forest, targetId)
    if (!tgt) return 'refused'
    const parentId = tgt.parent?.id ?? null
    const live: Array<{ id: string; loc: Located }> = []
    for (const id of [...new Set(ids)]) {
      const b = this.ed.store.find(id)
      if (!b || isDeleted(b)) continue
      const loc = locate(forest, id)
      if (loc) live.push({ id, loc })
    }
    if (live.length === 0) return 'gone'
    // 目标落在被搬的子树里（含目标就是被搬块自己）⇒ 拒：那会造环，与拖拽同一条守卫
    for (const { id } of live) {
      if (id === targetId || hasDescendant(forest, id, targetId)) return 'refused'
    }
    if (parentId !== null) {
      const parent = this.ed.store.find(parentId)
      if (!parent || isDeleted(parent) || typeDeclOf(parent).children === 'none') return 'refused'
    }

    const row = blankRowKind(tgt.block)
    const host = live[live.length - 1]!
    /**
     * 空行让位 ＝ 来的块占它那一行、它同笔软删。容器档额外把子树交给 host 接住，
     * 否则软删这一行会连整棵子树一起藏掉。三条例外退回「收首子块、不删这一行」的
     * 老落点：宁可多留一行，也不静默丢配置／造环。
     */
    const takeOver = row === 'placeholder' || (
      row === 'container'
      && Object.keys(tgt.block.props ?? {}).length === 0
      && typeDeclOf(host.loc.block).children !== 'none'
      && !live.some(({ id }) => hasDescendant(forest, targetId, id))
    )
    const siteParent = takeOver ? parentId : row === 'container' ? targetId : parentId
    // 让位 ⇒ 用它自己的下标；退化到首子块 ⇒ 0；普通块 ⇒ 按 zone 插在前／后
    const at = takeOver ? tgt.index : row === 'container' ? 0 : tgt.index + (zone === 'after' ? 1 : 0)
    // 目标下标之前的本批块会先被摘走 ⇒ 目标下标前移（与多块拖拽同一本账）
    let index = at
    for (const { loc } of live) if (loc.parent?.id === siteParent && loc.index < at) index--
    /** 子块清单要在动手前抓：事务里再 locate 读到的是一棵已经改过的树 */
    const inherited = takeOver && row === 'container' ? liveChildren(tgt.block).map((b) => b.id) : []
    const wasFolded = inherited.length > 0 && isFolded(this.ed.doc, targetId)
    this.ed.beginUndoEntry()
    this.ed.write((tx) => {
      /** 原位软删即可（与库里所有删除同一条路径，撤销一步全回）：空行不留在中间 */
      if (takeOver) tx.remove(targetId)
      /**
       * 接住的子块先在**原位** no-op 记一笔改前落点：不记的话，K1 搬走之后 K2
       * 会把「E 的首位」当成自己的原位，撤销时两块都往首位插 ⇒ 次序翻转。
       * 这条与下面搬动整组时的 no-op 是同一本次序账，不是第二套规则。
       */
      inherited.forEach((kid, i) => tx.move(kid, targetId, i))
      // 再按原序追加到 host 尾部（host 自带的子块在前，两棵子树各自成段）
      for (const kid of inherited) tx.move(kid, host.id, Number.MAX_SAFE_INTEGER)
      for (const { id, loc } of live) if (loc.parent) tx.move(id, loc.parent.id, loc.index)
      for (const { id } of live) tx.move(id, siteParent, Number.MAX_SAFE_INTEGER)
      for (let i = live.length - 1; i >= 0; i--) tx.move(live[i]!.id, siteParent, Math.max(0, index))
      for (const { id } of live) tx.patch(id, (x) => (x.modified = Date.now()))
    })
    // 折叠态跟着子树走：换父不该把用户折起来的子树自动摊开（折叠态不进撤销）
    if (wasFolded) setCollapsed(this.ed.doc, host.id, true)
    const caret = takeOver && !this.ed.bsel.hasBlockSelection()
      ? { id: host.id, off: plainLen(host.loc.block.content) }
      : undefined
    this.ed.structTail(caret)
    this.ed.bsel.paintBlockSel()
    return 'moved'
  }
}
