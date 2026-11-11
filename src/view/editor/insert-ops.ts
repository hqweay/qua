/**
 * 插入：结构插入（正文／待办／分割线／查询／看法／露面）与行内原子插入（引用／外链／资产）。
 *
 * 从 BlockEditor 拆出的协作对象：没有自有状态，全部经 `ed`。「空块原地转」与
 * 「section 根插成首子块」两套判据只住这一份（`insertSiteOf` 管落点、这里只解释意图）。
 * 撤销粒度的口径：用户按的是**一次**插入，同一个动作里造出的多个块共用一个撤销条目。
 */
import {
  DIVIDER_TYPE,
  EMBED_PROP,
  EMBED_TYPE,
  VIEWS_PROP,
  canonicalViews,
  upsertView,
  locate,
  insertSiteOf,
  isBlankPlaceholder,
  mkBlock,
  mkQueryBlock,
  setBlockType,
  isEmbedBlock,
  todoOf,
  TASK_STATUS_PROP_ID,
  TASK_STATUS_TODO_ID,
  TASK_STATUS_DONE_ID,
  declareOwnProp,
  setValue,
  writeBlockContent,
  uuidv7Hex,
  blockLabel,
  dropInsertSite,
  dropMoveExternal,
  descendants,
  hasDescendant,
  type Block,
  type Located,
  type QuerySpec,
  type TodoState,
} from '../../core/index.ts'
import {
  insertRunAt,
  plainLen,
  removeRunById,
  textRuns,
  type AssetRun,
  type LinkRun,
  type RefRun,
  type RunWithId,
} from '../../core/model/runs.ts'
import { ensureTaskStatusInTx } from '../../core/kb/ensure-task.ts'
import type { Tx } from '../../core/kb/types.ts'
import type { BlockEditor } from './editor.ts'

export class InsertOps {
  constructor(private readonly ed: BlockEditor) {}

  /** 整块换成一段纯文本（清除所有格式与原子；命令/测试用） */
  setText(id: string, text: string): void {
    const loc = locate(this.ed.doc, id)
    if (!loc) return
    this.ed.beginUndoEntry()
    const next = textRuns(text)
    this.ed.write((tx) => tx.patch(id, (b) => writeBlockContent(b, next)))
    this.ed.finishUndoEntry('insert')
    this.ed.renderBlock(id)
    this.ed.emitChange('text')
  }

  /**
   * 在 id 之后插一个块（`/` 命令与测试用）。
   *
   * ⚠️ **任意 section 根**（页／天／查询记录）要插成它的子块，不能插成 `roots[n]`：
   * 视图层没有「根级同级」这个真实位置，插进去的块没有家。
   *    视觉上二者也等价：根行是这一段的第一个可编辑/标题行，它「之后」就是第一个子块。
   */
  /**
   * 在当前块后面插入一个块（`/` 菜单的「正文块」「待办」）。
   *
   * **插入点本身是空块时，改它，而不是在它下面再造一个**：
   * 用户在一行空白里打 `/` 选「待办」，想要的是「这一行变成待办」，
   * 而不是「多出一个待办、原来那个空行还留在上面」。
   *
   * ⚠️ 「空块」的判据是**正文为空且没有子块**：有子块的块不能被改掉类型/值 ——
   *    那会让子树挂在一个用户没打算改的块下面。
   * ⚠️ 待办这一支还要看**已经有值没有**：已经是任务的空块（读出「待办」＝
   *    是任务但没做完）不该被「/待办」翻回未完成 —— 那是改值，不是插入。
   *    这一条与 `toggleTodo` 分工：那个是**切换**，这个是**插入**。
   */
  insertBlockAfter(id: string, text: string, todo?: TodoState): string | null {
    const loc = locate(this.ed.doc, id)
    if (!loc) return null
    this.ed.beginUndoEntry()
    const blank = isBlankPlaceholder(loc.block)
    if (blank && text === '') {
      /**
       * 空块 ＋ 无正文：
       *   · 「正文块」⇒ 这一行**本来就是**一个正文块，意图已经满足：不动模型、
       *     不记撤销，把光标落回它自己（返回它的 id，而不是 `null` ——
       *     `null` 的意思是「这里放不下一个块」，与「已经就是这样」是两件事）。
       *   · 「待办」⇒ 原地变成任务（但已有任务状态值时不覆盖，见上）。
       */
      if (!todo) {
        this.ed.placeCaret(loc.block.id, 0)
        return loc.block.id
      }
      if (todoOf(loc.block, this.ed.fieldTable()) !== undefined) return null
      // 只落一个属性值、不动结构 ⇒ 一笔事务里正好 1 条 `prop.set`（定义块缺了就同批补上）。
      // 自有槽同批登记：这一栏「在」不能只靠值撑着（见 toggleTodo 的注释）
      this.ed.write((tx) => {
        ensureTaskStatusInTx(this.ed.store.blocks, tx)
        tx.patch(loc.block.id, (b) => {
          declareOwnProp(b, TASK_STATUS_PROP_ID)
          setValue(b, TASK_STATUS_PROP_ID, todo === 'done' ? TASK_STATUS_DONE_ID : TASK_STATUS_TODO_ID)
        })
      })
      this.ed.structTail({ id: loc.block.id, off: 0 }, [loc.block.id])
      return loc.block.id
    }
    const b = mkBlock(text)
    // 待办不是块的字段，是**任务状态属性**的一个值：这里落值，不落「块的种类」。
    // 自有槽跟值一起登记（见 toggleTodo）：清空值行还在，「待办」这个身份不靠值独撑
    if (todo) {
      declareOwnProp(b, TASK_STATUS_PROP_ID)
      b.props = { ...(b.props ?? {}), [TASK_STATUS_PROP_ID]: todo === 'done' ? TASK_STATUS_DONE_ID : TASK_STATUS_TODO_ID }
    }
    /**
     * **落点只由 `tx.insert` 算**（它按整片森林取兄弟列表）。
     * 这里不能再顺手 `splice`/`unshift` 一下：那样同一件事就有两个计算者，
     * 而树的身份只有一份 —— 谁先算、谁后算，读者无从判断。
     *
     * section 根（页／天／查询记录）没有兄弟位，插成它的**首个子块**：
     * 视觉上「根行之后」就是第一个子块，写回也按 root id 走。
     *
     * 事务里**只**开结构那一笔：`b` 自带的待办值不另发属性 op ——
     * `insert` 已经为每个新块报了 `{parent,index}`，属性会随整块落库，
     * 再补一条 `prop.set` 就是同一件事记两遍。
     *
     * 声明「不许有子块」的根在这里容纳不下一个新块：直接返回 `false`，
     * 事务里什么都没写 ⇒ 没有任何 op。
     */
    const site = insertSiteOf(loc, { blank: false })
    if (!site || site.kind === 'replace') return null
    const at = site.kind === 'first-child' ? { parentId: site.parentId, index: 0 } : site
    const ok = this.ed.write((tx) => {
      // 新块自带待办值 ⇒ 定义块得同批在（与切换待办同一条判据）
      if (todo) ensureTaskStatusInTx(this.ed.store.blocks, tx)
      tx.insert(b, at.parentId, at.index)
      return true
    })
    if (!ok) return null
    this.ed.structTail({ id: b.id, off: 0 })
    return b.id
  }

  /**
   * 在 `id` **上方**插一个空正文块（⌘⇧↵），返回新块 id。
   *
   * 与 `insertBlockAfter` 同一套判据，只有落点方向不同：
   *   · 空块 ⇒ 意图已经满足：不动模型、不记撤销，光标落回它自己块首；
   *   · section 根没有「上方兄弟位」⇒ 退化为它的首个子块（判据在 `insertSiteOf` 的
   *     `before` 注释里，不在编辑器里另判一份）；
   *   · 其余 ⇒ 插在**上一个兄弟位**，新块成为当前块的前一个同级。
   *
   * 落点只由 `insertSiteOf` ＋ `tx.insert` 算（理由同 `insertBlockAfter`：树的身份只有一份）。
   */
  insertBlockBefore(id: string): string | null {
    const loc = locate(this.ed.doc, id)
    if (!loc) return null
    this.ed.beginUndoEntry()
    const blank = isBlankPlaceholder(loc.block)
    if (blank) {
      this.ed.placeCaret(loc.block.id, 0)
      return loc.block.id
    }
    const site = insertSiteOf(loc, { blank: false, dir: 'before' })
    if (!site || site.kind !== 'before' && site.kind !== 'first-child') return null
    const at = site.kind === 'first-child' ? { parentId: site.parentId, index: 0 } : site
    const b = mkBlock('')
    const ok = this.ed.write((tx) => {
      tx.insert(b, at.parentId, at.index)
      return true
    })
    if (!ok) return null
    this.ed.structTail({ id: b.id, off: 0 })
    return b.id
  }

  /**
   * 插入一个**分割线**：它是「没有正文的块」。
   *
   * 为什么它不是 `insertBlockAfter`：这类块的 `.tx` 里没有可写正文，插进去之后
   * 用户会看到「多了一行，但光标消失了」。所以插入动作自己负责在下面留一个空块当落点
   * （判据与形状见 `insertTypedAfter`）。
   */
  insertDividerAfter(id: string): boolean {
    return this.insertTypedAfter(id, DIVIDER_TYPE) !== null
  }

  /**
   * 建一个**查询块**（`/查询` 的唯一落点），返回它的 id。
   *
   * 落点与「插入其他块」同一套，判据是**这一行本身空不空**：
   *   · 空块 ⇒ **原地变成**查询块（不多出一行空行）—— 用户在一行空白里要一个查询，
   *     要的就是那一行变成查询，而不是「多一个查询、原来那行还留在上面」；
   *   · 有正文 ⇒ 在它**后面**新建同级块。section 根没有兄弟位，插成它的首个子块
   *     （与 `insertBlockAfter` 同一条规则：视觉上「根行之后」就是第一个子块）。
   *
   * 查询块没有可写的正文（`canWriteText` 为假）⇒ 两种落点都要在它**后面**留一个空块当光标位，
   * 否则插完光标悬空、下一句话没处落。
   *
   * 条件种子按**新查询块的容器**给（`$self` 解析成它所在的那一层）：
   * 有容器 ⇒「这一处下面」；没有（森林顶层）⇒ 全库。
   */
  insertQueryAfter(id?: string): string | null {
    /**
     * 缺省落点是**光标所在块**，不是「当前打开的那一屏」（`ws.activeId`）。
     *
     * 两者在日记流里一定不同：activeId 是**第一个**根（那一天的段头），光标却在最后一天的
     * 某一行 ⇒ 按 activeId 建会把查询扔到整个流的顶部。这条口径与其它「插块」命令同源
     * （`curBlock` 也是先取光标、再退回首行）。
     */
    const target = id !== undefined && id !== '' ? id : (this.ed.caretBlock() ?? this.ed.rows()[0]?.block.id ?? '')
    if (target === '') return null
    const loc = locate(this.ed.doc, target) ?? locate({ roots: this.ed.store.blocks }, target)
    if (!loc) return null
    this.ed.beginUndoEntry()
    const parentId = loc.parent?.id ?? null
    /**
     * **新查询一条都不查**（空条件 ＝ 永不命中）：先给条件，结果才会出现。
     *
     * 曾经在这里按「落点有没有父块」给 `{up:{is:'$self'}}`（＝这一页之下）——那是
     * 「顺手先看看这一页」的便利，代价是**新建即出现一大批行**，用户读成「它自己
     * 在乱查」；而条件该由用户给（条件树／筛选都就位了）。落点仍按 `insertSiteOf` 判。
     */
    const seed: QuerySpec = { where: { any: [] } }
    const blank = isBlankPlaceholder(loc.block)
    const query = mkQueryBlock({ name: '', spec: seed, icon: 'lucide:list-filter' })
    const empty = mkBlock('')

    /**
     * 空块：**原地改**（正文本来就是空的，一个字节都不丢），只在后面补一个落点。
     * 已有的属性（标签之类）留着 —— 换成查询不等于把它们删掉。
     */
    if (blank) {
      const ok = this.ed.write((tx) => {
        tx.patch(loc.block.id, (b) => {
          b.props = { ...(b.props ?? {}), ...(query.props ?? {}) }
          b.modified = Date.now()
        })
        tx.insert(empty, parentId, loc.index + 1)
        return true
      })
      if (!ok) return null
      this.ed.structTail({ id: empty.id, off: 0 }, [loc.block.id, empty.id])
      return loc.block.id
    }

    const site = insertSiteOf(loc, { blank: false })
    if (!site || site.kind === 'replace') return null
    const at = site.kind === 'first-child' ? { parentId: site.parentId, index: 0 } : { parentId: site.parentId, index: site.index }
    const ok = this.ed.write((tx) => {
      tx.insert(query, at.parentId, at.index)
      tx.insert(empty, at.parentId, at.index + 1)
      return true
    })
    if (!ok) return null
    this.ed.structTail({ id: empty.id, off: 0 }, [query.id, empty.id])
    return query.id
  }

  /**
   * 斜杠「插入看法」的落点：建（或空块原地转）一个**预配看法**的容器块，返回它的 id。
   *
   * 落点与 `insertQueryAfter` 同一条判据（空块原地转／有正文插兄弟，`insertSiteOf` 收口）。
   * 看法配置作为**初始 props** 随整块落库（`mkQueryBlock` 同形）：调用方经
   * `withBlockOwnerData` 规范化后传入，本方法不解释它的内容——这样视图配置的写
   * 仍然只有 `ViewOwnerStore` 一份语义，这里只是搭车。
   *
   * 与查询块的两处不同：
   *   · 容器块**有可写正文**（那一行就是它的名字）⇒ 光标落进块自己，不留尾部空块；
   *   · 空块原地转时也不新增落点块——那一行原地变成容器，光标留在原地。
   */
  insertViewAfter(id?: string, ownerProps?: Record<string, unknown>): string | null {
    const target = id !== undefined && id !== '' ? id : (this.ed.caretBlock() ?? this.ed.rows()[0]?.block.id ?? '')
    if (target === '') return null
    const loc = locate(this.ed.doc, target) ?? locate({ roots: this.ed.store.blocks }, target)
    if (!loc) return null
    this.ed.beginUndoEntry()

    const blank = isBlankPlaceholder(loc.block)
    if (blank) {
      const ok = this.ed.write((tx) => {
        tx.patch(loc.block.id, (b) => {
          b.props = { ...(b.props ?? {}), ...(ownerProps ?? {}) }
          b.modified = Date.now()
        })
        return true
      })
      if (!ok) return null
      this.ed.structTail(null, [loc.block.id])
      return loc.block.id
    }

    const site = insertSiteOf(loc, { blank: false })
    if (!site || site.kind === 'replace') return null
    const at = site.kind === 'first-child' ? { parentId: site.parentId, index: 0 } : { parentId: site.parentId, index: site.index }
    const view = mkBlock('', ownerProps ? { props: ownerProps } : {})
    const ok = this.ed.write((tx) => {
      tx.insert(view, at.parentId, at.index)
      return true
    })
    if (!ok) return null
    this.ed.structTail({ id: view.id, off: 0 }, [view.id])
    return view.id
  }

  /**
   * 插入一块**没有正文的块**（分割线／露面块），返回它的 id（原地改类型时就是 `id` 自己）。
   *
   * 分两支，判据是**插入点本身是不是一个空块**：
   *   · 空块 ⇒ 它**原地变成**这个类型（不新建）—— 用户在一行空白里要一个分隔线，
   *     得到的就是那一行变成分隔线，而不是分隔线 + 多出来的空行；
   *   · 有内容 ⇒ 在它下面**新建**，并留一个空块给光标。
   *
   * ⚠️ 改类型那一支**不新建块**，所以撤销一次就回到「那行还是空白」。
   * ⚠️ 新建那一支**两个块共用一个撤销条目**：用户按的是一次「插入」，
   *    撤销一次该回到按下之前，而不是先撤光标再撤组件。
   *
   * `decorate` 在同一次事务里给新块补属性（露面的指针、看法）——分开写会变成两条 op、
   * 两次撤销，而用户按的是一次「插入」。
   *
   * @param typeId 目标类型（必须声明 `text:'readonly'`；可写的类型不该走这条路）
   */
  private insertTypedAfter(
    id: string,
    typeId: string,
    decorate?: (b: Block) => void,
    prepare?: (tx: Tx, loc: Located) => void,
  ): string | null {
    /**
     * 定位**先看本视图，再退回整片森林**：命令带的是块 id，而当前活动编辑器可能是
     * 一面镜像的岛（它的 `doc.roots` 只有源那一棵）。只看本视图会让「在镜像里展开引用」
     * 这类动作找不到宿主块——不报错，只是没反应。
     */
    const loc = locate(this.ed.doc, id) ?? locate({ roots: this.ed.store.blocks }, id)
    if (!loc) return null
    this.ed.beginUndoEntry()

    /**
     * 空块 ⇒ 原地变类型。
     * 判据要**两块都空**：正文为空、且没有子块。有子块的块不能变成组件 ——
     * 那会把子树藏进一行摘要后面（组件块不许有子块，子块看不见）。
     */
    if (isBlankPlaceholder(loc.block)) {
      // 原地改类型是一次属性写入：`_type` 一条 op，撤销一次回到「那行还是空白」。
      // 改类型也算一次改动 ⇒ 时刻并进同一笔（第二条 op）。
      this.ed.write((tx) => {
        prepare?.(tx, loc)
        tx.patch(loc.block.id, (b) => {
          setBlockType(b, typeId)
          decorate?.(b)
          b.modified = Date.now()
        })
      })
      this.ed.structTail(null, [loc.block.id])
      return loc.block.id
    }

    const widget = mkBlock('')
    setBlockType(widget, typeId)
    decorate?.(widget)
    const empty = mkBlock('')
    // 两个块共用一笔（用户按的是一次「插入」）；落点与 `insertNear` 同一条规则：
    // section 根没有兄弟位，插成它的首两个子块
    const site = insertSiteOf(loc, { blank: false })
    if (!site || site.kind === 'replace') return null
    const at = site.kind === 'first-child' ? { parentId: site.parentId, index: 0 } : site
    const ok = this.ed.write((tx) => {
      prepare?.(tx, loc)
      tx.insert(widget, at.parentId, at.index)
      tx.insert(empty, at.parentId, at.index + 1)
      return true
    })
    if (!ok) return null
    this.ed.structTail({ id: empty.id, off: 0 })
    return widget.id
  }

  /**
   * 在 `id` 下面插入一次**露面**（镜像／大纲表格），返回露面块的 id。
   *
   * 露面块只存**一根指针**（`_embed = { block, view }`）—— 看法住在**源块**的命名视图上。
   * 曾经露面块自己带一份 `_views`，于是同一批块在正文、面板、中心各露一次就得到三份
   * 各自演化的列与排序。现在两种需求都有唯一出口：
   *   · `mirror` ⇒ `view: ''`（跟随源块自己的默认看法，源改默认这里跟着改）；
   *   · `table`  ⇒ 在源块上**建一张命名视图**并指向它（要给这一次露面一个特别看法，
   *     做法就是在源上建一张视图，而不是在露面块上另存一份）。
   */
  insertEmbedAfter(id: string, targetId: string, view: 'mirror' | 'table' = 'mirror'): string | null {
    /**
     * ⚠️ **不要**在这里判 `targetId === id`：那是最常见的一种用法——「在我这一块下面
     * 再放一份这一块的镜像」。目标是自己不等于「露面指向自己」：露面块的 id 是新发的，
     * 自指只可能来自坏数据（由 `resolveEmbed` 的 `self` 态兜）。
     */
    const viewId = view === 'table' ? `v-${uuidv7Hex().slice(0, 16)}` : ''
    return this.insertTypedAfter(
      id,
      EMBED_TYPE,
      (b) => {
        b.props = { ...(b.props ?? {}), [EMBED_PROP]: { block: targetId, view: viewId } }
      },
      // 建的那张视图写在**源**上，与插露面块同一笔（不留「有指针没视图」的半截）
      viewId
        ? (tx) =>
            tx.patch(targetId, (t) => {
              const views = canonicalViews(t.props?.[VIEWS_PROP], { kind: 'children', blockId: targetId })
              t.props = { ...(t.props ?? {}), [VIEWS_PROP]: upsertView(views, { id: viewId, kind: 'list-table' }) }
            })
        : undefined,
    )
  }

  /**
   * **把一枚行内引用就地展开成露面块**：摘掉那一枚原子，在它所在块的下面插一块。
   *
   * 为什么是「下面」而不是「在文字中间劈开」：劈开要把 marks／annos／子块归属按三条规则
   * 各算一次（拆块那条路径），而这一步的用户意图只是「这一处引用要摊开看」——
   * 摊开的东西放在这句话下面，是能一眼验证的落点；劈错一次却要撤销两回。
   *
   * 一次动作一笔事务：摘原子与插露面块共用一个撤销条目（用户按的是一次「展开」）。
   */
  expandAtomToEmbed(atomId: string, view: 'mirror' | 'table' = 'mirror'): string | null {
    const hit = this.ed.findRun(atomId)
    if (!hit || hit.run.t !== 'ref' || !hit.run.to) return null
    const hostId = hit.block.id
    const targetId = hit.run.to
    const viewId = view === 'table' ? `v-${uuidv7Hex().slice(0, 16)}` : ''
    return this.insertTypedAfter(
      hostId,
      EMBED_TYPE,
      (b) => {
        b.props = { ...(b.props ?? {}), [EMBED_PROP]: { block: targetId, view: viewId } }
      },
      (tx) => {
        tx.patch(hostId, (b) => writeBlockContent(b, removeRunById(b.content, atomId)))
        if (viewId) {
          tx.patch(targetId, (t) => {
            const views = canonicalViews(t.props?.[VIEWS_PROP], { kind: 'children', blockId: targetId })
            t.props = { ...(t.props ?? {}), [VIEWS_PROP]: upsertView(views, { id: viewId, kind: 'list-table' }) }
          })
        }
      },
    )
  }

  /**
   * 移除一次露面（只删露面块；源与其它露面不动）。
   *
   * ⚠️ 走**整片森林**定位，不走 `this.doc`：命令可能从一面镜像里发起（活动编辑器是岛），
   *    而要被摘掉的露面块在另一个视图里。按 `doc` 找会「找不到 ⇒ 什么都不做」。
   *    删除仍然是一笔事务（产 op、能撤销），只是不再有「补一块落点」那套窗口语义——
   *    露面块从不是装载根。
   */
  removeEmbed(hostId: string): boolean {
    const b = this.ed.store.find(hostId)
    if (!b || !isEmbedBlock(b)) return false
    this.ed.beginUndoEntry()
    this.ed.write((tx) => tx.remove(hostId))
    this.ed.structTail()
    return true
  }

  /**
   * 在**当前光标**处插一枚原子 run（引用／外链共用；资产的落点是显式捕获的，走下面那一条）。
   * @returns 新 run 的 id；此刻没有可落的块 ⇒ `null`
   */
  private insertRun(run: RunWithId): string | null {
    const id = this.ed.sel?.aBlock ?? this.ed.rows()[0]?.block.id
    if (!id) return null
    const loc = locate(this.ed.doc, id)
    if (!loc) return null
    const off = this.ed.sel?.aOff ?? 0
    this.ed.beginUndoEntry()
    const next = insertRunAt(loc.block.content, off, run)
    this.ed.commitContent(id, next, 'other', off + 1)
    return run.id
  }

  /**
   * 在光标处插一枚引用 run（页引用／行内标签共用；标签带 `flavor:'#'`）。
   * 返回 run id。
   *
   * ⚠️ **不写 `anchor`**：锚文本是用户事后显式改的那一处名字，插入路径
   *    一律不带它（否则「这一处显示什么」就有了两个书写入口，且其中一个无人负责同步）。
   */
  insertRef(opts: { to: string; label: string; flavor?: '#' }): string | null {
    return this.insertRun(refRunOf(opts.to, opts.label, opts.flavor))
  }

  /**
   * **⌥ 拖的落手**：在拖拽落点插一组引用块（每个被拖块一枚 `RefRun`），原块不动。
   *
   * 与 `insertRef` 分工：那个往**已有正文**的光标位插一枚 run；这个造**新块**——
   * 拖拽自带显式的三区落点，`insertSiteOf`（回答「没给落点时插哪」）不适用。
   * 两者共用的是「一枚引用长什么样」：`RefRun`，`to`＝源块 id，`label`＝命名快照
   * （显示名一律现算，这里只给源进回收站之后的兜底）。
   *
   * 落点复用 `dropInsertSite`：与普通拖的 `dropMove` 是同一份判据，只少「摘掉自己」那一格
   * ⇒ 悬停高亮画在哪，引用就落在哪；不另写第二套三区规则。
   *
   * **不补空块**：补位纪律属于「没有可写正文的块」（分割线／查询／露面）。
   * 这里插的是普通可写块，光标落到最后一枚的引用之后即可。
   *
   * **源不必在这一份 doc 里**：引用只需要「指向谁 ＋ 显示什么」，侧槽卡／挂载区／
   * 别的露面拖来的块都能落成引用（普通拖在这一格走 `dropMoveExternal`）。
   * 两种来源各用自己那一份落点判据——它们本来就是「同一件事的两个版本」：
   * 源在 doc 内用 `dropInsertSite`（与 `dropMove` 同一份，只少「摘掉自己」那格）；
   * 源在外用 `dropMoveExternal`（外部位移本来就没有「摘掉自己」那格）。
   *
   * 整组多选：N 块各一枚引用，同笔事务 ⇒ 一次撤销全回。
   */
  insertRefDrop(ids: readonly string[], targetId: string | null, zone: 'before' | 'after' | 'inside'): boolean {
    const doc = this.ed.doc
    const find = (id: string) => this.ed.store.find(id)
    const roots = [...new Set(ids)]
    if (roots.length === 0) return false
    const locOf = new Map(roots.map((id) => [id, locate(doc, id)] as const))
    const external = roots.filter((id) => !locOf.get(id) && find(id))
    const internal = roots.filter((id) => Boolean(locOf.get(id)))
    // 有既不在 doc 里、store 里也查不到的 id ⇒ 不是一次有效拖拽
    if (internal.length + external.length !== roots.length) return false
    // 一次拖拽只有一个来源（侧槽卡／挂载区／正文），不会混着来
    if (external.length > 0 && internal.length > 0) return false
    const fromOutside = external.length > 0
    /** 段根（页／天／查询记录）没有兄弟位：日记流是真实日期序、查询结果集是视图序 */
    if (roots.some((id) => locOf.get(id)?.parent === null)) return false
    if (targetId !== null) {
      const tgt = locate(doc, targetId)
      if (!tgt) return false
      // doc 内的目标也是段根时，before/after 会给它造一个没有家的兄弟；
      // 外部位移没有这个问题（`dropMoveExternal` 自己把 before/after 折成 inside）
      if (!fromOutside && tgt.parent === null && zone !== 'inside') return false
      // 落点不能落在被拖的子树里（含被拖块自己）——与单块拖拽同一条守卫
      for (const id of roots) {
        if (id === targetId) return false
        const isInside = fromOutside ? descendants(find(id)!).some((b) => b.id === targetId) : hasDescendant(doc, id, targetId)
        if (isInside) return false
      }
    }
    const first = roots[0]!
    const site = fromOutside
      ? dropMoveExternal(doc, find(first)!, targetId, zone)
      : dropInsertSite(doc, first, targetId, zone)
    if (!site) return false
    // 派生面（查询结果／镜像）：落点必须还在本文档里（与 `moveStaysInside` 同一条门）
    if (this.ed.structuralScope === 'roots' && (site.parentId === null || !locate(doc, site.parentId))) return false

    const made = roots.map((id) => {
      const src = find(id)
      return mkBlock([refRunOf(id, src ? blockLabel(src, find) : '')])
    })
    this.ed.beginUndoEntry()
    this.ed.write((tx) => {
      made.forEach((b, i) => tx.insert(b, site.parentId, site.index + i))
    })
    const last = made[made.length - 1]!
    this.ed.structTail({ id: last.id, off: plainLen(last.content) })
    this.ed.bsel.paintBlockSel()
    return true
  }

  /**
   * 在光标处插一枚外链 run（`core.editor/insert-link` 的落点）。
   *
   * `text` 省略 ⇒ 显示**地址本身**：`LinkRun.v` 是内容而不是提示占位，
   * 留空会让这一枚 link 显示成一片空白（用户看不出那里有个 link）。
   *
   * ⚠️ url 的合法性由调用方用 `core/link.ts` 的 `checkExternalUrl` 判过：
   *    编辑器只管形状，协议的取舍不属于它。
   */
  insertLink(opts: { url: string; text?: string }): string | null {
    const text = (opts.text ?? '').trim()
    const run: LinkRun = { id: uuidv7Hex(), t: 'link', v: text === '' ? opts.url : text, url: opts.url }
    return this.insertRun(run)
  }

  /**
   * 在**给定落点**插一枚资产 run。
   *
   * 为什么落点要显式给、而不是「插到当前光标」：入库是异步的（算 hash、写字节、读尺寸），
   * 这期间光标会动、块甚至会被删。正确的顺序是**先捕获 `{blockId, offset}`**，
   * 字节落库成功后再按捕获点插 —— 按当前光标插会把图插到用户后来移到的地方。
   *
   * @returns 新 run 的 id；块不在了或 offset 越界 ⇒ `null`（一个字节都不写，不静默插到别处）
   */
  insertAssetAt(blockId: string, offset: number, asset: string, snap?: { label?: string }): string | null {
    const loc = locate(this.ed.doc, blockId)
    if (!loc) return null
    const len = plainLen(loc.block.content)
    if (offset < 0 || offset > len) return null
    this.ed.beginUndoEntry()
    const run: AssetRun = {
      id: uuidv7Hex(),
      t: 'asset',
      asset,
      ...(snap?.label ? { label: snap.label } : {}),
    }
    const next = insertRunAt(loc.block.content, offset, run)
    this.ed.commitContent(blockId, next, 'other', offset + 1)
    return run.id
  }

  /** 在当前光标处插一枚资产 run（落点捕获的便捷版；入口应当用 `insertAssetAt`）。 */
  insertAsset(asset: string, snap?: { label?: string }): string | null {
    const id = this.ed.sel?.aBlock ?? this.ed.rows()[0]?.block.id
    if (!id) return null
    return this.insertAssetAt(id, this.ed.sel?.aOff ?? 0, asset, snap)
  }

  /** 当前光标落点（粘贴/选文件时**先捕获**它，入库回来按它插） */
  caretPoint(): { blockId: string; offset: number } | null {
    const blockId = this.ed.sel?.aBlock ?? this.ed.rows()[0]?.block.id
    if (!blockId) return null
    return { blockId, offset: this.ed.sel?.aOff ?? 0 }
  }
}

/**
 * 一枚引用 run 的形状（两条插入路径共用：光标位插入 / 拖拽落点插块）。
 *
 * 为什么收成一个函数：形状写两遍，`flavor`／`anchor` 这类字段的口径迟早有一处漏掉，
 * 而漏掉的表现是「同一个引用在两处长得不一样」。
 *
 * ⚠️ **不写 `anchor`**：锚文本是用户事后显式改的那一处名字，插入路径一律不带它
 *    （否则「这一处显示什么」就有了两个书写入口，且其中一个无人负责同步）。
 */
function refRunOf(to: string, label: string, flavor?: '#'): RefRun {
  return { id: uuidv7Hex(), t: 'ref', to, ...(flavor ? { flavor } : {}), label }
}
