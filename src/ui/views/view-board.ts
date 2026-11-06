/**
 * **看板**：按某一列的**单值**分组成列，卡片是一行记录。
 *
 * 两条判据：
 *   · **拖卡＝写属性，不是 re-parent**。看板画的是一批记录（命中／子块／引用），
 *     它们的父子关系与这一列无关；把卡拖到另一列只该改「这一格的值」。
 *     改结构的入口只有一个（大纲里的缩进），不会因为换个看法就多出一个。
 *   · **空列与「未设置」都在**。空列让「把这个状态的东西挪走」有落点；
 *     「未设置」那一列让「还没填」的东西看得见 —— 藏起来等于告诉用户「这些不存在」。
 */
import { fieldTextOf, openActionOf, type BlockStore, type OpenAction, type ViewConfig, type ViewRecord } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import { bucketize, bucketLabel, orderBuckets, recordsForGrouping, GROUP_UNSET, type GroupBucket } from './grouping.ts'
import { viewNote } from './view-note.ts'

export interface ViewBoardDeps {
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  fieldLabel: (id: string) => string
  /** 写一格属性（拖卡落点） */
  setValue: (blockId: string, propId: string, value: unknown) => void
  clearValue: (blockId: string, propId: string) => void
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 这一列可选的值（`select` 的选项块 id → 名字；没有选项的属性给空表＝按现出现的值分组） */
  choices: (propId: string) => readonly { id: string; label: string }[]
  /** 字段基数解析：多值字段不进卡片分组（拖卡写值没有唯一动作） */
  cardinalityOf?: (propId: string) => 'one' | 'many'
}

/**
 * 「未设置」这一列的内部键与分桶口径都住在 `grouping.ts`（列表／表格的分组共用）。
 *
 * 分组键带**类型前缀**：`true`／`"true"`／`1` 是不同的值，合成一个会把它们混成一列，
 * 而拖回去写哪种类型就没有答案了。空串**不是**「未设置」（它是一个合法值）。
 */
const UNSET = GROUP_UNSET

export class ViewBoard {
  readonly root: HTMLElement
  private readonly deps: ViewBoardDeps
  private dragging = ''
  /** 本次 render 的键是不是多值（决定拖拽面：多值键禁拖，写路径只有单值有唯一动作） */
  private multi = false

  constructor(deps: ViewBoardDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vb'
  }

  dispose(): void {}

  render(): void {
    const view = this.deps.view()
    const key = view?.groupBy ?? ''
    this.root.replaceChildren()
    if (key === '') {
      this.root.appendChild(viewNote(t('ui.board.needsGroup')))
      return
    }
    /**
     * **多值键不进卡片分组**：卡片列的拖卡＝「写那格的值」，多值下没有唯一动作
     * （加一个还是换一个？别的组里那张卡怎么办）。分组下拉也不提供多值候选——
     * 配置里存着的多值键（从列表切过来）在这里如实说明，而不是静默 fan-out。
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
    if (view?.board?.showEmpty === true || buckets.length > 0) {
      for (const id of order) {
        if (buckets.some((b) => b.id === id)) continue
        buckets.push({ id, raw: undefined, records: [], unset: id === UNSET })
      }
    }

    for (const b of orderBuckets(buckets, order)) {
      this.root.appendChild(this.column(b, key))
    }
  }

  private column(b: GroupBucket, propId: string): HTMLElement {
    const id = b.id
    const col = document.createElement('div')
    col.className = 'vb-col'
    col.dataset.value = id === UNSET ? '' : id
    if (id === UNSET) col.dataset.unset = '1'

    const head = document.createElement('div')
    head.className = 'vb-col-head'
    const name = document.createElement('span')
    name.className = 'vb-col-name ui-ellipsis'
    name.textContent = bucketLabel(b, propId, { choices: (pid) => this.deps.choices(pid) })
    const count = document.createElement('span')
    count.className = 'vb-col-count'
    count.textContent = String(b.records.length)
    head.append(name, count)
    col.appendChild(head)

    const list = document.createElement('div')
    list.className = 'vb-cards'
    for (const r of b.records) list.appendChild(this.card(r))
    col.appendChild(list)

    /**
     * 落点：整列接卡。`dragover` 必须 `preventDefault` 才有 `drop` ——
     * 少了它浏览器会把这次拖动当成「没有落点」，而用户看到的是「拖过去弹回去」。
     * ⚠️ 多值键**不接拖**：把卡拖进某组是「写那格的值」，多值下没有唯一动作
     * （加一个还是换一个？别的组里那张卡怎么办）——改归属走属性编辑器的显式动作。
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

  private card(r: ViewRecord): HTMLElement {
    const card = document.createElement('div')
    card.className = 'vb-card'
    card.dataset.blockId = r.block.id
    // 多值键的卡不拖：它同属多组，拖去某列的「写值」没有唯一动作（见 render 的注）
    card.draggable = !this.multi
    const view = this.deps.view()
    const fields = (view?.board?.cardFields ?? []).slice(0, 3)

    const title = document.createElement('div')
    title.className = 'vb-card-title ui-ellipsis'
    this.deps.projectTitle(r, title)
    card.appendChild(title)

    for (const key of fields) {
      const text = fieldTextOf(r, key)
      if (text === '') continue
      const row = document.createElement('div')
      row.className = 'vb-card-field ui-ellipsis'
      row.textContent = text
      card.appendChild(row)
    }

    card.addEventListener('dragstart', (e) => {
      this.dragging = r.block.id
      e.dataTransfer?.setData('text/plain', r.block.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    card.addEventListener('dragend', () => {
      this.dragging = ''
    })
    card.addEventListener('click', (e) => this.deps.openBlock(r.block.id, openActionOf(e)))
    return card
  }
}
