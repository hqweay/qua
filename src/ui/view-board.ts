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
import { fieldTextOf, sortRecords, type BlockStore, type ViewConfig, type ViewRecord } from '../core/index.ts'
import { t } from '../core/msg.ts'

export interface ViewBoardDeps {
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  fieldLabel: (id: string) => string
  /** 写一格属性（拖卡落点） */
  setValue: (blockId: string, propId: string, value: unknown) => void
  clearValue: (blockId: string, propId: string) => void
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string) => void
  /** 这一列可选的值（`select` 的选项块 id → 名字；没有选项的属性给空表＝按现出现的值分组） */
  choices: (propId: string) => readonly { id: string; label: string }[]
}

/**
 * 「未设置」这一列的内部键。
 *
 * 分组键带**类型前缀**：`true`／`"true"`／`1` 是不同的值，合成一个会把它们混成一列，
 * 而拖回去写哪种类型就没有答案了。空串**不是**「未设置」（它是一个合法值）。
 */
const UNSET = '\u0000unset'

const keyOfValue = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return UNSET
  if (typeof v === 'string') return `s:${v}`
  if (typeof v === 'number') return `n:${v}`
  if (typeof v === 'boolean') return `b:${v}`
  return `j:${JSON.stringify(v)}`
}

export class ViewBoard {
  readonly root: HTMLElement
  private readonly deps: ViewBoardDeps
  private dragging = ''

  constructor(deps: ViewBoardDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vb'
  }

  dispose(): void {}

  render(): void {
    const view = this.deps.view()
    const key = view?.board?.groupBy ?? ''
    this.root.replaceChildren()
    if (key === '') {
      const hint = document.createElement('p')
      hint.className = 'tv-unsupported'
      hint.textContent = t('ui.board.needsGroup')
      this.root.appendChild(hint)
      return
    }

    const records = sortRecords(this.deps.records(), view?.table?.sort)
    const declared = this.deps.choices(key)
    /** 列的次序：声明过的选项按它的顺序；没声明过的按**第一次出现**的顺序；「未设置」永远最后 */
    const order: string[] = declared.map((c) => `s:${c.id}`)
    const buckets = new Map<string, ViewRecord[]>()
    /** 分组键 → 原始值（拖卡回去要写回**同类型**的那个值） */
    const rawOf = new Map<string, unknown>()
    for (const r of records) {
      const raw = r.values[key]
      const id = keyOfValue(raw)
      if (!buckets.has(id)) {
        buckets.set(id, [])
        rawOf.set(id, raw)
        if (id !== UNSET && !order.includes(id)) order.push(id)
      }
      buckets.get(id)!.push(r)
    }
    if (view?.board?.showEmpty === true || buckets.size > 0) {
      for (const id of order) if (!buckets.has(id)) buckets.set(id, [])
      if (!buckets.has(UNSET)) buckets.set(UNSET, [])
    }
    order.push(UNSET)

    for (const id of order) {
      const items = buckets.get(id)
      if (!items) continue
      this.root.appendChild(this.column(id, items, key, rawOf.get(id)))
    }
  }

  private column(id: string, items: readonly ViewRecord[], propId: string, raw: unknown): HTMLElement {
    const col = document.createElement('div')
    col.className = 'vb-col'
    col.dataset.value = id === UNSET ? '' : id
    if (id === UNSET) col.dataset.unset = '1'

    const head = document.createElement('div')
    head.className = 'vb-col-head'
    const name = document.createElement('span')
    name.className = 'vb-col-name ui-ellipsis'
    /**
     * 列头文案：`select` 的值是**选项块 id**，得翻译成它的名字；
     * 其余属性（文本／数字／日期）的值本身就是列名。
     */
    const label =
      id === UNSET
        ? t('ui.board.unset')
        : (this.deps.choices(propId).find((c) => c.id === `s:${raw}`)?.label ?? String(raw))
    name.textContent = label
    const count = document.createElement('span')
    count.className = 'vb-col-count'
    count.textContent = String(items.length)
    head.append(name, count)
    col.appendChild(head)

    const list = document.createElement('div')
    list.className = 'vb-cards'
    for (const r of items) list.appendChild(this.card(r))
    col.appendChild(list)

    /**
     * 落点：整列接卡。`dragover` 必须 `preventDefault` 才有 `drop` ——
     * 少了它浏览器会把这次拖动当成「没有落点」，而用户看到的是「拖过去弹回去」。
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
      if (id === UNSET) this.deps.clearValue(blockId, propId)
      else this.deps.setValue(blockId, propId, raw)
    })
    return col
  }

  private card(r: ViewRecord): HTMLElement {
    const card = document.createElement('div')
    card.className = 'vb-card'
    card.dataset.blockId = r.block.id
    card.draggable = true
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
    card.addEventListener('click', () => this.deps.openBlock(r.block.id))
    return card
  }
}
