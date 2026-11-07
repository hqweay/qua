/**
 * **卡片**：一批记录、一张卡；容器由**分组键**决定——不分组＝网格（画廊），分组＝列（看板）。
 *
 * 三条判据：
 *   · **卡片只有一份**（标题 ＋ 至多 3 个字段 ＋ 可选封面）。两副面孔各写一份的下场是
 *     「看板上加了字段、画廊里没有」，而两边都读同一份 `cards` 配置只是碰巧一致。
 *   · **拖卡＝写属性，不是 re-parent**。列布局画的是一批记录（命中／子块），它们的父子关系
 *     与这一列无关；把卡拖到另一列只该改「这一格的值」。改结构的入口只有一个（大纲里的缩进）。
 *   · **空列与「未设置」都在**。空列让「把这个状态的东西挪走」有落点；
 *     「未设置」那一列让「还没填」的东西看得见 —— 藏起来等于告诉用户「这些不存在」。
 *
 * ⚠️ 布局是从 `groupBy` 派生的（`cardLayoutOf`），不另存一格：存了就会允许
 *    「分组了但排成网格」这种没有消费者的组合，也会让「下拉选了分组、屏幕没变成列」再度发生。
 */
import {
  cardLayoutOf,
  fieldTextOf,
  openActionOf,
  sortRecords,
  TITLE_COLUMN,
  type OpenAction,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { assetViewOf } from '../../view/asset-views.ts'
import { bucketize, bucketLabel, orderBuckets, recordsForGrouping, GROUP_UNSET, type GroupBucket } from './grouping.ts'
import { viewNote } from './view-note.ts'

export interface ViewCardsDeps {
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  /** 这一列可选的值（`select` 的选项块 id → 名字；没有选项的属性给空表＝按现出现的值分组） */
  choices: (propId: string) => readonly { id: string; label: string }[]
  /** 字段基数解析：多值字段不做列分组（拖卡写值没有唯一动作） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
  /** 写一格属性（拖卡落点） */
  setValue: (blockId: string, propId: string, value: unknown) => void
  clearValue: (blockId: string, propId: string) => void
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string, place?: OpenAction) => void
}

/** 一张卡最多显示几个字段（再多就不是「看一眼」而是表格了） */
const MAX_FIELDS = 3

/** 「未设置」这一列的内部键与分桶口径都住在 `grouping.ts`（列表／表格的分组共用） */
const UNSET = GROUP_UNSET

export class ViewCards {
  readonly root: HTMLElement
  private readonly deps: ViewCardsDeps
  private dragging = ''
  /** 本次 render 的键是不是多值（决定拖拽面：多值键禁拖，写路径只有单值有唯一动作） */
  private multi = false

  constructor(deps: ViewCardsDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vcards'
  }

  dispose(): void {}

  render(): void {
    const view = this.deps.view()
    const layout = cardLayoutOf(view)
    this.root.dataset.layout = layout
    this.root.replaceChildren()
    if (layout === 'columns') this.renderColumns(view)
    else this.renderGrid(view)
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
      this.root.appendChild(viewNote(t('ui.list.empty')))
      return
    }
    const cover = view?.cards?.cover !== 'none'
    const fields = (view?.cards?.fields ?? []).filter((k) => k !== TITLE_COLUMN)
    for (const r of records) this.root.appendChild(this.card(r, { cover, fields, draggable: false }))
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

    const cover = view?.cards?.cover !== 'none'
    const fields = (view?.cards?.fields ?? []).filter((k) => k !== TITLE_COLUMN)
    for (const b of orderBuckets(buckets, order)) {
      this.root.appendChild(this.column(b, key, { cover, fields }))
    }
  }

  private column(b: GroupBucket, propId: string, card: { cover: boolean; fields: readonly string[] }): HTMLElement {
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

  private card(
    r: ViewRecord,
    o: { cover: boolean; fields: readonly string[]; draggable: boolean },
  ): HTMLElement {
    const card = document.createElement('article')
    card.className = 'vcard'
    card.dataset.blockId = r.block.id
    // 多值键的卡不拖：它同属多组，拖去某列的「写值」没有唯一动作（见 renderColumns 的注）
    card.draggable = o.draggable

    if (o.cover) card.appendChild(this.cover(r))

    const title = document.createElement('div')
    title.className = 'vcard-title ui-ellipsis'
    this.deps.projectTitle(r, title)
    card.appendChild(title)

    for (const key of o.fields.slice(0, MAX_FIELDS)) {
      const text = fieldTextOf(r, key)
      if (text === '') continue
      const row = document.createElement('div')
      row.className = 'vcard-field ui-ellipsis'
      row.textContent = text
      card.appendChild(row)
    }

    if (o.draggable) {
      card.addEventListener('dragstart', (e) => {
        this.dragging = r.block.id
        e.dataTransfer?.setData('text/plain', r.block.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      })
      card.addEventListener('dragend', () => {
        this.dragging = ''
      })
    }
    card.addEventListener('click', (e) => this.deps.openBlock(r.block.id, openActionOf(e)))
    return card
  }

  /** 封面位：有图放图，没图放首字（缺文件也留位，别让格子塌掉） */
  private cover(r: ViewRecord): HTMLElement {
    const box = document.createElement('div')
    box.className = 'vcard-cover'
    const hash = firstAssetOf(r)
    if (hash === '') {
      box.dataset.state = 'none'
      const mark = document.createElement('span')
      mark.className = 'vcard-cover-mark'
      mark.textContent = (r.title || t('ui.page.untitled')).slice(0, 1)
      box.appendChild(mark)
      return box
    }
    const img = document.createElement('img')
    img.className = 'vcard-cover-img'
    img.alt = ''
    img.src = assetViewOf(hash).url ?? ''
    img.addEventListener('error', () => {
      img.remove()
      box.dataset.state = 'missing'
      box.textContent = t('ui.gallery.noCover')
    })
    box.appendChild(img)
    return box
  }
}

/** 这张卡正文里的**第一枚**资产 run（封面是派生的：不存「我选了哪张」） */
function firstAssetOf(r: ViewRecord): string {
  for (const run of r.block.content) if (run.t === 'asset') return run.asset
  return ''
}
