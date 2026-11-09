/**
 * 触发词（`/`／`#`／`@`）：浮层报什么、抹字、以及选中浮层一行之后的一次性落账。
 *
 * 从 BlockEditor 拆出的协作对象：没有自有状态，全部经 `ed`。判定本身在
 * `core/trigger.ts`（纯函数、被单测逐条钉），这里只负责「模型偏移 ⇄ 投影文本」
 * 的换算与落点的一笔事务。
 */
import {
  createObjRecordInTx,
  detectTrigger,
  ensurePageInTx,
  hasList,
  locate,
  tagIdsOf,
  uuidv7Hex,
  writeBlockContent,
  canDirectEditText,
  type Block,
  type TriggerChar,
  type TriggerHit,
} from '../../core/index.ts'
import { fromProjection, plainText, projectOff, spliceRuns, type RefRun } from '../../core/model/runs.ts'
import { ensureTagInTx, tagLookupOf } from '../../core/kb/ensure-tag.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { AcceptPick, BlockEditor } from './editor.ts'

export class TriggerOps {
  constructor(private readonly ed: BlockEditor) {}

  /**
   * 此刻光标前有没有一个**正在输入的触发词**。
   *
   * 判定落在**投影**（`plainText`）上：触发字符是正文里的字，与格式无关。
   * `from`／`to` 是 plain 偏移：抹字与插原子都在这套坐标里做，
   * 于是「删掉触发词、插入一枚原子」不需要第二套偏移换算。
   */
  triggerAt(id?: string): (Omit<TriggerHit, 'from'> & { from: number; to: number }) | null {
    const bid = id ?? this.ed.sel?.aBlock
    if (!bid) return null
    const loc = locate(this.ed.doc, bid)
    // 只读行（日记日期等）上不该弹：那里连字都敲不进去。判据是「这一行能不能直接编辑」，
    // 不是「正文是不是内容」——查询块的正文是名字，但名字行同样敲得进字、弹得出补全。
    if (!loc || !canDirectEditText(loc.block)) return null
    const off = this.ed.sel?.aBlock === bid ? (this.ed.sel?.aOff ?? 0) : 0
    const text = plainText(loc.block.content).slice(0, projectOff(loc.block.content, off))
    const hit = detectTrigger(text, { composing: this.ed.probe.isComposing })
    if (!hit) return null
    return { ch: hit.ch, query: hit.query, from: fromProjection(loc.block.content, hit.from), to: off }
  }

  /** 上报「在敲什么」（`null` ＝ 这一段已经结束，浮层该关） */
  emitTrigger(id: string): void {
    if (!this.ed.events.triggerQuery) return
    const hit = this.triggerAt(id)
    if (!hit) {
      this.ed.events.triggerQuery(null, new DOMRect())
      return
    }
    this.ed.events.triggerQuery({ ch: hit.ch, query: hit.query }, this.ed.caretRect() ?? new DOMRect())
  }

  /**
   * 把触发词从模型里抹掉（选中命令后调用）。
   *
   * 只在**命令行**上有这一步：命令要落在「触发词原来那一格」，所以得先把它让出来。
   * `#`／`@` 的落点不走这里——它们与插入本身是**同一笔事务**（见 `acceptTrigger`）。
   */
  dropTrigger(id: string): boolean {
    const hit = this.triggerAt(id)
    if (!hit) return false
    // 抹触发词是用户刚在这一行敲下那几个字的逆动作，与打字同档
    this.ed.editBlock(id, hit.from, hit.to, '', 'delete', { directEdit: true })
    this.ed.placeCaret(id, hit.from)
    return true
  }

  /**
   * **选中浮层一行之后的落点**：删掉触发词，并把结果落到它原来的位置。
   *
   * 三件事在同一笔事务里（一次撤销就是一次动作）：
   *   ① 抹掉 `#查询词`／`@查询词`；② 需要时建出标签块／记录；③ 插入露面 run 或写归属。
   * 拆开落盘会留下「字删了、标签没建」这种半批，而半批比慢更贵。
   *
   * `ch` 是**打开浮层时那个触发字符**：落点前再检测一次（文本此刻才是事实），
   * 若最近敲下的已经不是它（用户改了主意／挪了光标），就什么都不做而不是猜一个落点。
   *
   * 为什么只有 `tag`／`newObj` 才建标签块：`ref` 指向的目标已经存在（浮层刚列出它），
   * 再 `ensureTag` 一遍等于用名字重新解析一次，反而会把别名/同名页的口径再走一道。
   */
  acceptTrigger(opts: { ch: TriggerChar; pick: AcceptPick }): boolean {
    const hit = this.triggerAt()
    if (!hit || hit.ch !== opts.ch) return false
    const id = this.ed.sel?.aBlock
    const loc = id ? locate(this.ed.doc, id) : null
    if (!id || !loc) return false
    const pick = opts.pick
    this.ed.beginUndoEntry()
    /** 这次是否往树上插了新块（记录）——真插了就整片重画（索引／块数要跟上） */
    let createdBlock = false

    const apply = (tx: Tx, block: Block): boolean => {
      let tagId: string | null = null
      let recordId: string | null = null
      let pageId: string | null = null

      const needTag = pick.kind === 'tag' || pick.kind === 'newTag'
      if (needTag) {
        const tag = ensureTagInTx(tagLookupOf(this.ed.store.blocks), pick.name, tx)
        if (!tag) return false
        tagId = tag.id
      }
      if (pick.kind === 'newObj') {
        /**
         * 新实例的标签由**浮层打开那一刻的 tagId** 给（第二段成员搜索锚定的就是它），
         * 不再按名字重解析：实例名与标签名是两个名字，按名解析会把实例名当成标签名。
         * 打开到按下之间标签可能被摘身份 ⇒ 找不回就整体不做，不猜一个落点。
         */
        const tagBlock = this.ed.store.find(pick.tagId)
        if (!tagBlock || !hasList(tagBlock, 'tag')) return false
        tagId = tagBlock.id
      }

      if (pick.kind === 'newPage') {
        const page = ensurePageInTx(tagLookupOf(this.ed.store.blocks), pick.name, tx)
        if (!page) return false
        pageId = page.id
        // 页落在森林顶层，可能不在当前视图里；整片重画一次，让索引/页数跟上
        createdBlock = true
      }

      /**
       * 记录是**内容块**，住森林顶层（与页块、标签块同一条口径）。它没有地址：
       * 正文就是键入的名字（作描述），身份由「哪条引用指向它」给出。
       */
      if (pick.kind === 'newObj' || (pick.kind === 'newTag' && pick.action === 'instance')) {
        const record = createObjRecordInTx(tx, this.ed.store.blocks, pick.name, tagId!)
        recordId = record.id
        createdBlock = true
      }

      const assign = pick.kind === 'tag' || (pick.kind === 'newTag' && pick.action === 'assign')

      /** 一次落点只插**一枚** run；块标签是归类，不插 run。 */
      let inserted: RefRun[] = []
      if (pick.kind === 'ref') {
        inserted = [
          {
            id: uuidv7Hex(),
            t: 'ref',
            to: pick.to,
            ...(pick.flavor ? { flavor: pick.flavor } : {}),
            label: pick.label,
          },
        ]
      } else if (pick.kind === 'newPage') {
        // 页引用不加 `#` 风味：它是页面，不是标签
        inserted = [{ id: uuidv7Hex(), t: 'ref', to: pageId!, label: pick.name }]
      } else if (pick.kind === 'newObj') {
        inserted = [{ id: uuidv7Hex(), t: 'ref', to: recordId!, flavor: '#', label: pick.name }]
      } else if (pick.kind === 'newTag' && pick.action !== 'assign') {
        const to = pick.action === 'instance' ? recordId! : tagId!
        inserted = [{ id: uuidv7Hex(), t: 'ref', to, flavor: '#', label: pick.name }]
      }

      const next = spliceRuns(block.content, hit.from, hit.to, inserted)
      tx.patch(id, (b) => writeBlockContent(b, next))
      if (assign) tx.setTags(id, [...tagIdsOf(block), tagId!])
      return true
    }

    // 落点改的是「正在打字的这一行」的正文（抹触发词＋插 run），与打字同档
    const ok = this.ed.write((tx) => apply(tx, loc.block), undefined, { directEdit: true })
    if (!ok) return false
    /**
     * 撤销合并窗口的陷阱：打字那笔（`insert`）与这一笔若同 kind 且落在 1200ms 内，
     * 会被并成一步 —— 一次撤销就回到「输入前」，跳过落点那一格。所以这里一律记
     * `other`（不可合并）：落点动作是**显式的一次选择**，不是打字的延续。
     */
    this.ed.finishUndoEntry('other')
    // 插了新块 ⇒ 整片重画（索引／块数要跟上）；只改这一行时仍走单行
    if (createdBlock) this.ed.renderAll()
    else this.ed.renderBlock(id)
    // 光标：插了露面的落在它之后（1 格）；只归类的那一格已经没了，落在原处
    this.ed.placeCaret(id, hit.from + (pick.kind === 'tag' ? 0 : 1))
    this.ed.emitChange(createdBlock ? 'struct' : 'text', [id])
    return true
  }
}
