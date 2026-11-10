/**
 * **卡片**：一批记录、一张卡；容器由**分组键**决定——不分组＝网格（画廊），分组＝列（看板）。
 *
 * 三条判据：
 *   · **卡片的身体就是那一块**（正文 runs ＋ 块下属性行 ＋ 可选封面）。两副面孔各写一份的
 *     下场是「看板上加了属性、画廊里没有」，而两边读的是同一份模型（不是两张字段表）。
 *   · **拖卡＝写属性，不是 re-parent**。列布局画的是一批记录（命中／子块），它们的父子关系
 *     与这一列无关；把卡拖到另一列只该改「这一格的值」。改结构的入口只有一个（大纲里的缩进）。
 *   · **空列与「未设置」都在**。空列让「把这个状态的东西挪走」有落点；
 *     「未设置」那一列让「还没填」的东西看得见 —— 藏起来等于告诉用户「这些不存在」。
 *
 * ⚠️ 布局是从 `groupBy` 派生的（`cardLayoutOf`），不另存一格：存了就会允许
 *    「分组了但排成网格」这种没有消费者的组合，也会让「下拉选了分组、屏幕没变成列」再度发生。
 */
import {
  belowFieldsFor,
  cardLayoutOf,
  clickModsOf,
  blockLabel,
  groupsByStructure,
  openActionOf,
  sortRecords,
  type BelowFields,
  type Block,
  type FindBlock,
  type BlockStore,
  type OpenAction,
  type StructureGroup,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import type { SurfaceEditor } from '../block-ui/surface-editor.ts'
import { renderPropsLine } from '../block-ui/props-line.ts'
import { makeTagChipEl } from '../../view/editor/block-dom.ts'
import { t } from '../../core/infra/msg.ts'
import { assetViewOf } from '../../view/asset-views.ts'
import { bucketize, bucketLabel, orderBuckets, recordsForGrouping, GROUP_UNSET, type GroupBucket } from './grouping.ts'
import { viewNote } from './view-note.ts'
import { flip } from '../motion.ts'

export interface ViewCardsDeps {
  /**
   * **一台按需的就地编辑器**（与表格标题格同一台）：点卡片上的文字才建，
   * 装进**这一张卡里**（不是浮层），失焦/Enter 提交、Esc 回滚。
   */
  cell: SurfaceEditor
  /** 读门面：块下属性行要整片森林（`belowFieldsFor` 一次算一批） */
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  /** 这一列可选的值（`select` 的选项块 id → 名字；没有选项的属性给空表＝按现出现的值分组） */
  choices: (propId: string) => readonly { id: string; label: string }[]
  /** 字段基数解析：多值字段不做列分组（拖卡写值没有唯一动作） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
  /** 写一格属性（拖卡落点） */
  setValue: (blockId: string, propId: string, value: unknown) => void
  clearValue: (blockId: string, propId: string) => void
  /**
   * **结构分组**（`groupByStructure`）：组＝容器的直接子块、记录＝组里的直接子块。
   * 只有 children 源有；按值分组时这份是空的（渲染器不读）。
   */
  structureGroups: () => readonly StructureGroup[]
  /** 拖卡进另一组＝把那块搬到组下面（结构事务，不是写值） */
  moveInto: (blockId: string, groupBlockId: string) => void
  /** 给一组加一张卡＝在组块末尾插一个子块（与大纲里 ↵＋Tab 同一条写路径） */
  insertCard: (groupBlockId: string) => void
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 点卡上的属性行 ⇒ 打开属性面板并聚焦那一栏 */
  inspect: (blockId: string, propId?: string) => void
  /** `ref` 值的显示名（块下属性行用） */
  refLabel?: (targetId: string) => string
}

/** 「未设置」这一列的内部键与分桶口径都住在 `grouping.ts`（表格的分组共用） */
const UNSET = GROUP_UNSET

export class ViewCards {
  /** 引用解析用（呈现摘要现算名字）：组名与标签 chip 共用这一只箭头 */
  private readonly kbFind: FindBlock
  readonly root: HTMLElement
  private readonly deps: ViewCardsDeps
  private dragging = ''
  /** 本次 render 的键是不是多值（决定拖拽面：多值键禁拖，写路径只有单值有唯一动作） */
  private multi = false
  /** 这一批记录各自的块下属性行（一次算一批，逐卡只查表） */
  private below: ReadonlyMap<string, BelowFields> = new Map()
  /** 结构分组的形状签名（组 id ＋ 每组的卡 id）：变了才整片重画 */
  private structureShape = ''

  constructor(deps: ViewCardsDeps) {
    this.deps = deps
    this.kbFind = (id) => deps.store.find(id)
    this.root = document.createElement('section')
    this.root.className = 'vcards'
  }

  dispose(): void {}

  render(): void {
    // 整片重画会把正在编辑的那张卡的 DOM 换掉：先把这次编辑收尾
    this.deps.cell.commit()
    const view = this.deps.view()
    const layout = cardLayoutOf(view)
    this.root.dataset.layout = layout
    this.refreshBelow(this.deps.records().map((r) => r.block))
    this.root.replaceChildren()
    if (layout === 'columns') this.renderColumns(view)
    else this.renderGrid(view)
  }

  /**
   * **局部修补**（外部改了某几块）：只重画受影响的那几张卡。
   *
   * 整片重画会摘掉正在编辑那张卡的锚点（那台浮层是贴在一格上的），
   * 也会把滚动位置与 hover 一起丢掉 —— 与表格的 `patchRow` 同一条口径。
   * 记录掉出结果集时退回整片重画：分桶计数与列成员都得重算。
   */
  sync(ids: readonly string[]): void {
    if (ids.length === 0) return
    const view = this.deps.view()
    if (cardLayoutOf(view) !== this.root.dataset.layout) {
      this.render()
      return
    }
    const wanted = new Set(ids)
    /**
     * 结构分组：组块自己变了（改名）或结构变了（增删组／卡）⇒ 整片重画。
     * 卡的**内容**变化仍走下面的局部修补（那是高频路径）。
     */
    if (groupsByStructure(view)) {
      const groups = this.deps.structureGroups()
      if (groups.some((g) => wanted.has(g.block.id)) || this.structureShapeOf(groups) !== this.structureShape) {
        this.render()
        return
      }
    }
    /**
     * 值分组：改的那块**换了桶**（拖卡写值、面板改值）⇒ 整片重画。
     * 局部修补只会把卡**原地**换掉——列成员与计数不会跟着走，「值改了、
     * 卡还留在旧列」就是这条缝。内容变化（高频路径）仍走下面的就地修补。
     */
    const key = view?.groupBy ?? ''
    if (cardLayoutOf(view) === 'columns' && key !== '') {
      const o = {
        choices: (pid: string) => this.deps.choices(pid),
        groupOrder: view?.groupOrder,
        ...(this.deps.cardinalityOf ? { cardinalityOf: this.deps.cardinalityOf } : {}),
      }
      const colOf = new Map<string, string>()
      for (const b of bucketize(this.deps.records(), key, o).buckets) {
        for (const r of b.records) colOf.set(r.block.id, b.id)
      }
      const moved = [...wanted].some((id) => {
        // 正在打字的那张不判换列：它的桶要等编辑结束（afterEdit）再算
        if (this.deps.cell.editingId === id) return false
        const el = this.root.querySelector<HTMLElement>(`.vcard[data-block-id="${id}"]`)
        if (!el) return false
        const col = el.closest<HTMLElement>('.vcol')
        const cur = col?.dataset.unset === '1' ? UNSET : (col?.dataset.value ?? '')
        return (colOf.get(id) ?? UNSET) !== cur
      })
      if (moved) {
        this.render()
        return
      }
    }
    this.refreshBelow(ids.map((id) => this.deps.store.find(id)).filter((b): b is Block => b !== undefined))
    const byId = new Map(this.deps.records().map((r) => [r.block.id, r]))
    let lost = false
    for (const el of [...this.root.querySelectorAll<HTMLElement>('.vcard[data-block-id]')]) {
      const id = el.dataset.blockId ?? ''
      if (!wanted.has(id)) continue
      // 正在打字的那张不动：它的值就是用户刚打进去的，重建会把焦点与 IME 串一起丢
      if (this.deps.cell.editingId === id) continue
      const r = byId.get(id)
      if (!r) {
        lost = true
        break
      }
      el.replaceWith(this.card(r, this.cardOpts(view)))
    }
    if (lost) this.render()
  }

  /**
   * 一次就地编辑结束：**只重画那一张**（整片重排会丢滚动与 hover，也会把刚提交的卡换掉）。
   * 记录掉出结果集时退回整片重画（分桶与计数都得重算）。
   */
  afterEdit(blockId: string): void {
    const view = this.deps.view()
    this.refreshBelow([this.deps.store.find(blockId)].filter((b): b is Block => b !== undefined))
    const r = this.deps.records().find((x) => x.block.id === blockId)
    const el = this.root.querySelector<HTMLElement>(`.vcard[data-block-id="${blockId}"]`)
    if (!r || !el) {
      this.render()
      return
    }
    el.replaceWith(this.card(r, this.cardOpts(view)))
  }

  /** 这一屏卡片的样子（封面／可拖）——两副面孔共用一份 */
  private cardOpts(view: ViewConfig | null): { cover: boolean; draggable: boolean } {
    return {
      cover: view?.cards?.cover !== 'none',
      // 只有列布局能拖：拖进某列＝写那格的值，网格里没有落点
      draggable: cardLayoutOf(view) === 'columns' && !this.multi,
    }
  }

  /** 块下属性行：**一批一次**（`belowFieldsFor` 会扫森林，逐卡各算一次是量级错误） */
  private refreshBelow(blocks: readonly Block[]): void {
    if (blocks.length === 0) return
    const next = new Map(this.below)
    // 卡片与大纲同一口径：记录的模型父块声明了 `_childProps` ⇒ 卡上也显示（显示跟数据走）
    const parentOf = (id: string): Block | null => {
      const pid = this.deps.store.index.parentOf.get(id) ?? null
      return pid ? (this.deps.store.find(pid) ?? null) : null
    }
    for (const [id, data] of belowFieldsFor(blocks, this.deps.store.blocks, parentOf, this.deps.store.index.blocks))
      next.set(id, data)
    // 掉出结果集的块不再留着（卡片重画时就不会去找它）
    for (const id of [...next.keys()]) {
      if (!this.deps.store.find(id)) next.delete(id)
    }
    this.below = next
  }

  /**
   * 网格（画廊）：一格一张卡。
   *
   * 封面是**派生的**（正文第一张图），卡片不存「我选了哪张」；没有图也给一个首字位 ——
   * 「这张卡没图」不该看起来像「这张卡坏了」。
   */
  private renderGrid(view: ViewConfig | null): void {
    this.root.dataset.size = view?.cards?.size ?? 'm'
    const records = sortRecords(this.deps.records(), view?.table?.sort)
    if (records.length === 0) {
      this.root.appendChild(viewNote(t('ui.cards.empty')))
      return
    }
    const o = this.cardOpts(view)
    for (const r of records) this.root.appendChild(this.card(r, o))
  }

  /** 列（看板）：按分组键把记录摆进「一个值一列」 */
  private renderColumns(view: ViewConfig | null): void {
    if (groupsByStructure(view)) {
      this.renderStructureColumns(view)
      return
    }
    const key = view?.groupBy ?? ''
    /**
     * **多值键不进列分组**：列的拖卡＝「写那格的值」，多值下没有唯一动作
     * （加一个还是换一个？别的组里那张卡怎么办）。分组下拉也不提供多值候选——
     * 配置里存着的多值键（从别处带过来）在这里如实说明，而不是静默 fan-out。
     */
    const o = {
      choices: (propId: string) => this.deps.choices(propId),
      groupOrder: view?.groupOrder,
      ...(this.deps.cardinalityOf ? { cardinalityOf: this.deps.cardinalityOf } : {}),
    }
    const { multi } = bucketize(this.deps.records(), key, o)
    if (multi) {
      this.multi = true
      this.root.appendChild(viewNote(t('ui.board.noMultiGroup')))
      return
    }
    this.multi = false

    const records = recordsForGrouping(this.deps.records(), view)
    const { buckets, order } = bucketize(records, key, o)
    if (view?.cards?.showEmpty === true || buckets.length > 0) {
      for (const id of order) {
        if (buckets.some((b) => b.id === id)) continue
        // 空列也是「一个值一组」：raw 要给回原始值，列头才叫得出名字、
        // 拖卡写回才落的是那个值（写 undefined 等于把这格毁掉）
        buckets.push({ id, raw: id.startsWith('s:') ? id.slice(2) : undefined, records: [], unset: id === UNSET })
      }
    }

    for (const b of orderBuckets(buckets, order)) {
      this.root.appendChild(this.column(b, key, this.cardOpts(view)))
    }
  }

  private column(b: GroupBucket, propId: string, card: { cover: boolean }): HTMLElement {
    const id = b.id
    const col = document.createElement('div')
    col.className = 'vcol'
    col.dataset.value = id === UNSET ? '' : id
    if (id === UNSET) col.dataset.unset = '1'

    const head = document.createElement('div')
    head.className = 'vcol-head'
    const name = document.createElement('span')
    name.className = 'vcol-name ui-ellipsis'
    name.textContent = bucketLabel(b, propId, { choices: (pid) => this.deps.choices(pid) })
    const count = document.createElement('span')
    count.className = 'vcol-count'
    count.textContent = String(b.records.length)
    head.append(name, count)
    col.appendChild(head)

    const list = document.createElement('div')
    list.className = 'vcol-cards'
    for (const r of b.records) list.appendChild(this.card(r, { ...card, draggable: !this.multi }))
    col.appendChild(list)

    /**
     * 落点：整列接卡。`dragover` 必须 `preventDefault` 才有 `drop` ——
     * 少了它浏览器会把这次拖动当成「没有落点」，而用户看到的是「拖过去弹回去」。
     * ⚠️ 多值键**不接拖**：把卡拖进某组是「写那格的值」，多值下没有唯一动作。
     */
    if (!this.multi) {
      col.addEventListener('dragover', (e) => {
        if (this.dragging === '') return
        e.preventDefault()
        col.dataset.dropTarget = '1'
      })
      col.addEventListener('dragleave', () => {
        delete col.dataset.dropTarget
      })
      col.addEventListener('drop', (e) => {
        delete col.dataset.dropTarget
        if (this.dragging === '') return
        e.preventDefault()
        const blockId = this.dragging
        this.dragging = ''
        // 拖卡落点＝「同一个东西换位置」：让位动画包住这一次写（命令面改值不走这里＝瞬移）
        flip(
          this.root,
          '.vcard[data-block-id]',
          (el) => el.dataset.blockId ?? '',
          () => {
            if (b.unset) this.deps.clearValue(blockId, propId)
            else this.deps.setValue(blockId, propId, b.raw)
          },
          { priority: blockId },
        )
      })
    }
    return col
  }

  /**
   * **按一级子块分组**：组＝容器的直接子块（真实块），记录＝它的直接子块。
   *
   * 与按值分组的三处差别是语义，不是样式：
   *   · 组**有身份** —— 组名读那一块、点开就是那一块；没有合成键、没有「未设置」；
   *   · 拖卡＝**换父**（结构事务），不是写那格的值；
   *   · 空组保留：它就是一个真实子块，还能拖卡进去。
   */
  private renderStructureColumns(view: ViewConfig | null): void {
    // 结构分组永远单值：拖拽面全开
    this.multi = false
    const groups = this.deps.structureGroups()
    this.structureShape = this.structureShapeOf(groups)
    if (groups.length === 0) {
      this.root.appendChild(viewNote(t('ui.cards.noGroups')))
      return
    }
    const o = this.cardOpts(view)
    for (const g of groups) this.root.appendChild(this.structureColumn(g, o))
  }

  private structureColumn(g: StructureGroup, card: { cover: boolean }): HTMLElement {
    const col = document.createElement('div')
    col.className = 'vcol'
    // 组＝一个真实子块：用它的块 id（不是 `groupBy` 的合成值键）
    col.dataset.groupBlockId = g.block.id

    const head = document.createElement('div')
    head.className = 'vcol-head'
    const name = document.createElement('button')
    name.type = 'button'
    name.className = 'vcol-name ui-ellipsis'
    name.textContent = blockLabel(g.block, this.kbFind)
    name.title = t('ui.cards.openGroup')
    name.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.deps.openBlock(g.block.id, openActionOf(e))
    })
    const count = document.createElement('span')
    count.className = 'vcol-count'
    count.textContent = String(g.records.length)

    /**
     * 「加一张卡」：与结构映射表表头的 ＋ 同一条写路径（在组块末尾插一个子块）。
     * 常显、透明度压低——它是这一列唯一「能让它长大」的动作。
     */
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'vcol-add'
    add.title = t('ui.cards.addCardTitle')
    add.setAttribute('aria-label', t('ui.cards.addCard'))
    add.textContent = '＋'
    add.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      // 先结束正在进行的编辑：否则改动时刻会落在一个马上重排的块上
      this.deps.cell.commit()
      this.deps.insertCard(g.block.id)
    })
    head.append(name, count, add)
    col.appendChild(head)

    const list = document.createElement('div')
    list.className = 'vcol-cards'
    for (const r of g.records) list.appendChild(this.card(r, { ...card, draggable: true }))
    col.appendChild(list)

    /**
     * 落点：整列接卡。拖进来＝把卡**搬**到这一组下面（结构写、一次撤销），
     * 不是改属性值——组的身份是块，不是某个字段的取值。
     */
    col.addEventListener('dragover', (e) => {
      if (this.dragging === '') return
      e.preventDefault()
      col.dataset.dropTarget = '1'
    })
    col.addEventListener('dragleave', () => {
      delete col.dataset.dropTarget
    })
    col.addEventListener('drop', (e) => {
      delete col.dataset.dropTarget
      if (this.dragging === '') return
      e.preventDefault()
      const blockId = this.dragging
      this.dragging = ''
      // 换父落点与写值落点同一条原语：让位动画只挂在手势上
      flip(this.root, '.vcard[data-block-id]', (el) => el.dataset.blockId ?? '', () => this.deps.moveInto(blockId, g.block.id), {
        priority: blockId,
      })
    })
    return col
  }

  /** 结构分组的形状签名：组 id ＋ 每组的卡 id（变了才整片重画） */
  private structureShapeOf(groups: readonly StructureGroup[] = this.deps.structureGroups()): string {
    return groups.map((g) => `${g.block.id}:${g.records.map((r) => r.block.id).join(',')}`).join('|')
  }


  private card(r: ViewRecord, o: { cover: boolean; draggable: boolean }): HTMLElement {
    const card = document.createElement('article')
    card.className = 'vcard'
    card.dataset.blockId = r.block.id

    // 封面是**派生**的：有图才有横幅，没图就不占位（不拿首字充数）
    if (o.cover) {
      const cover = this.cover(r)
      if (cover) card.appendChild(cover)
    }

    /**
     * **卡片的身体就是这一块的投影**：正文（run）＋ 块下属性行（有值的、未上 gutter 的）。
     *
     * 编辑时整格换成编辑器 —— 编辑器自己会画同一块与同一行属性，所以「所见即所编」，
     * 属性也顺手可改；不再有「卡片专用字段列表」这第二份格式。
     */
    const body = document.createElement('div')
    body.className = 'vcard-body'
    this.deps.cell.render(r.block, body)
    /**
     * 卡片的**元信息**贴在卡底：标签 chips ＋ 属性行。
     *
     * 分组两件都不存在时整块不画（空着比画一条空行好）；有它们时贴在底部，
     * 标题与元信息之间的留白看起来是「一张卡」而不是「没写完的格子」。
     */
    const meta = document.createElement('div')
    meta.className = 'vcard-meta'
    if (r.tags.length > 0) {
      const tags = document.createElement('div')
      tags.className = 'vcard-tags'
      for (const tag of r.tags) tags.appendChild(makeTagChipEl(tag.id, blockLabel(tag, this.kbFind)))
      meta.appendChild(tags)
    }
    const below = this.below.get(r.block.id)
    if (below) {
      const line = document.createElement('div')
      line.className = 'vcard-props blk-props-line'
      renderPropsLine(r.block.id, below, line, {
        inspect: (id, propId) => this.deps.inspect(id, propId),
        refLabel: (id) => this.deps.refLabel?.(id) ?? id.slice(-6),
      })
      meta.appendChild(line)
    }
    if (meta.childNodes.length > 0) body.appendChild(meta)
    body.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      if (!target) return
      /**
       * **已经在编辑这一张**：点击属于编辑器自己（放光标、选词、点引用）。
       * ⚠️ 必须 `stopPropagation`：否则冒泡到卡片那一层会被当成「点卡片」——
       *    用户看到的是「点第二下就跳到那一块去了」（真踩过）。
       */
      if (this.deps.cell.editingId === r.block.id) {
        e.stopPropagation()
        return
      }
      // 属性行自己开面板（那是它的点击语义），不进编辑；卡片那一层也认这一格、不会打开块
      if (target.closest('.blk-props-line')) return
      // 修饰键仍是「打开」（Shift＝右槽、⌘＝新页签）：不因为正文可编辑就吞掉
      if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
      e.stopPropagation()
      this.deps.cell.handleClick(r.block.id, target, clickModsOf(e), { x: e.clientX, y: e.clientY }, body)
    })
    card.appendChild(body)

    if (o.draggable) card.appendChild(this.grip(r))

    card.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null
      // 属性行 / 拖拽手柄不触发「打开这一块」
      if (target?.closest('.blk-props-line, .vcard-grip')) return
      this.deps.openBlock(r.block.id, openActionOf(e))
    })
    return card
  }

  /**
   * **拖拽手柄**：卡身现在是编辑器，从卡身拖会变成选字；拖卡只能从这里发起
   * （与列布局的「拖卡＝写那格的值」是同一条路）。
   */
  private grip(r: ViewRecord): HTMLElement {
    const grip = document.createElement('div')
    grip.className = 'vcard-grip'
    grip.draggable = true
    grip.dataset.dragFor = r.block.id
    grip.title = t('ui.cards.drag')
    grip.setAttribute('aria-label', t('ui.cards.drag'))
    grip.textContent = '⠿'
    grip.addEventListener('dragstart', (e) => {
      this.dragging = r.block.id
      e.dataTransfer?.setData('text/plain', r.block.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    grip.addEventListener('dragend', () => {
      this.dragging = ''
    })
    // 手柄点击不该被当成「点卡片打开」
    grip.addEventListener('click', (e) => e.stopPropagation())
    return grip
  }

  /**
   * 封面：这一块正文里的**第一枚图**。
   *
   * **没有图就没有封面位**——不拿首字占位充数：一个 4:3 的空框会让「一张文字卡」
   * 看起来像「一张坏掉的图卡」。文件丢了也不留框（移除元素，卡片回到文字卡的形状）。
   */
  private cover(r: ViewRecord): HTMLElement | null {
    const hash = firstAssetOf(r)
    if (hash === '') return null
    const box = document.createElement('div')
    box.className = 'vcard-cover'
    const img = document.createElement('img')
    img.className = 'vcard-cover-img'
    img.alt = ''
    img.src = assetViewOf(hash).url ?? ''
    img.addEventListener('error', () => box.remove())
    box.appendChild(img)
    return box
  }
}

/** 这张卡正文里的**第一枚**资产 run（封面是派生的：不存「我选了哪张」） */
function firstAssetOf(r: ViewRecord): string {
  for (const run of r.block.content) if (run.t === 'asset') return run.asset
  return ''
}
