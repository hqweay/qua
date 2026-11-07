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
  clickModsOf,
  fieldTextOf,
  openActionOf,
  sortRecords,
  TITLE_COLUMN,
  type OpenAction,
  type ViewConfig,
  type ViewRecord,
} from '../../core/index.ts'
import type { InlineBlockEditor } from '../block-ui/inline-block-editor.ts'
import { t } from '../../core/infra/msg.ts'
import { assetViewOf } from '../../view/asset-views.ts'
import { bucketize, bucketLabel, orderBuckets, recordsForGrouping, GROUP_UNSET, type GroupBucket } from './grouping.ts'
import { viewNote } from './view-note.ts'

export interface ViewCardsDeps {
  /**
   * **一台按需的就地编辑器**：点卡片上的文字才建，装进**这一张卡里**（不是浮层），
   * 失焦/Enter 提交、Esc 回滚。一次只发生一张卡的编辑，所以是一台而不是每卡一台。
   */
  editor: InlineBlockEditor
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
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick?: (hit: { to: string; runId?: string }, el: HTMLElement, mods: ReturnType<typeof clickModsOf>) => void
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: ReturnType<typeof clickModsOf>) => void
}

/** 一张卡最多显示几个字段（再多就不是「看一眼」而是表格了） */
const MAX_FIELDS = 3

/** 「未设置」这一列的内部键与分桶口径都住在 `grouping.ts`（表格的分组共用） */
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
    // 整片重画会把正在编辑的那张卡的 DOM 换掉：先把这次编辑收尾
    this.deps.editor.commit()
    const view = this.deps.view()
    const layout = cardLayoutOf(view)
    this.root.dataset.layout = layout
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
    const byId = new Map(this.deps.records().map((r) => [r.block.id, r]))
    let lost = false
    for (const el of [...this.root.querySelectorAll<HTMLElement>('.vcard[data-block-id]')]) {
      const id = el.dataset.blockId ?? ''
      if (!wanted.has(id)) continue
      // 正在打字的那张不动：它的值就是用户刚打进去的，重建会把焦点与 IME 串一起丢
      if (this.deps.editor.editingId === id) continue
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
    const r = this.deps.records().find((x) => x.block.id === blockId)
    const el = this.root.querySelector<HTMLElement>(`.vcard[data-block-id="${blockId}"]`)
    if (!r || !el) {
      this.render()
      return
    }
    el.replaceWith(this.card(r, this.cardOpts(view)))
  }

  /** 这一屏卡片的样子（封面／字段／可拖）——两副面孔共用一份 */
  private cardOpts(view: ViewConfig | null): { cover: boolean; fields: readonly string[]; draggable: boolean } {
    return {
      cover: view?.cards?.cover !== 'none',
      fields: (view?.cards?.fields ?? []).filter((k) => k !== TITLE_COLUMN),
      // 只有列布局能拖：拖进某列＝写那格的值，网格里没有落点
      draggable: cardLayoutOf(view) === 'columns' && !this.multi,
    }
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

    /**
     * 标题就是这一块的正文：**点文字就地编辑**（编辑器装在**这一张卡里**，不是浮层）。
     *
     * 修饰键仍是「打开」（Shift＝右槽、⌘＝新页签）：那是块标/行首的同一套手势，
     * 不能因为正文变得可编辑就把这两条路吞掉。点引用/原子先导航，也不进编辑。
     */
    const title = document.createElement('div')
    title.className = 'vcard-title'
    const inner = document.createElement('span')
    inner.className = 'vcard-title-inner ui-ellipsis'
    this.deps.projectTitle(r, inner)
    title.appendChild(inner)
    title.addEventListener('click', (e) => {
      // 已经在编辑这一张：点击属于编辑器自己（选词、点引用由事件表处理）
      if (this.deps.editor.editingId === r.block.id) return
      const target = e.target as HTMLElement | null
      if (!target) return
      const hit = routeCellClick(target)
      if (hit.kind === 'ref' && hit.el && hit.to) {
        e.stopPropagation()
        this.deps.refClick?.({ to: hit.to, ...(hit.runId ? { runId: hit.runId } : {}) }, hit.el, clickModsOf(e))
        return
      }
      if (hit.kind === 'atom' && hit.el && hit.atom) {
        e.stopPropagation()
        this.deps.onAtomClick?.(hit.atom, hit.el, clickModsOf(e))
        return
      }
      if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return
      e.stopPropagation()
      this.deps.editor.edit(r.block.id, title, { x: e.clientX, y: e.clientY })
    })
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

/**
 * 一次点击落在谁身上：引用／原子／其余。
 *
 * 与表格标题格那份判据同形（`block-cell.ts` 的 `handleClick`）：两处各自内联，
 * 是因为表格那台是浮层、这台在流里，生命周期不同；**判据必须一样**——
 * 不一样的那一天，同一个引用在表格里是导航、在卡片里变成给引用改字，而且不报错。
 */
function routeCellClick(target: HTMLElement): { kind: 'ref' | 'atom' | 'none'; el?: HTMLElement; to?: string; runId?: string; atom?: { runId: string; kind: string; hash?: string } } {
  const ref = target.closest<HTMLElement>('[data-ref-to]')
  if (ref?.dataset.refTo) {
    return { kind: 'ref', el: ref, to: ref.dataset.refTo, ...(ref.dataset.atomId ? { runId: ref.dataset.atomId } : {}) }
  }
  const atom = target.closest<HTMLElement>('.atom')
  if (atom?.dataset.atomId) {
    return {
      kind: 'atom',
      el: atom,
      atom: {
        runId: atom.dataset.atomId,
        kind: atom.dataset.atomKind ?? '',
        ...(atom.dataset.assetHash ? { hash: atom.dataset.assetHash } : {}),
      },
    }
  }
  return { kind: 'none' }
}
