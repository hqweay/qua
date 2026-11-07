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
  displayNameOf,
  openActionOf,
  sortRecords,
  type BelowFields,
  type Block,
  type BlockStore,
  type OpenAction,
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
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 点卡上的属性行 ⇒ 打开属性面板并聚焦那一栏 */
  inspect: (blockId: string, propId?: string) => void
  /** `ref` 值的显示名（块下属性行用） */
  refLabel?: (targetId: string) => string
}

/** 「未设置」这一列的内部键与分桶口径都住在 `grouping.ts`（表格的分组共用） */
const UNSET = GROUP_UNSET

export class ViewCards {
  readonly root: HTMLElement
  private readonly deps: ViewCardsDeps
  private dragging = ''
  /** 本次 render 的键是不是多值（决定拖拽面：多值键禁拖，写路径只有单值有唯一动作） */
  private multi = false
  /** 这一批记录各自的块下属性行（一次算一批，逐卡只查表） */
  private below: ReadonlyMap<string, BelowFields> = new Map()

  constructor(deps: ViewCardsDeps) {
    this.deps = deps
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
    for (const [id, data] of belowFieldsFor(blocks, this.deps.store.blocks)) next.set(id, data)
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
        buckets.push({ id, raw: undefined, records: [], unset: id === UNSET })
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
        if (b.unset) this.deps.clearValue(blockId, propId)
        else this.deps.setValue(blockId, propId, b.raw)
      })
    }
    return col
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
      for (const tag of r.tags) tags.appendChild(makeTagChipEl(tag.id, displayNameOf(tag)))
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
