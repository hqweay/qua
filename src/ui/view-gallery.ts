/**
 * **画廊**：一格一张卡的网格，封面取这张卡**正文里的第一张图**。
 *
 * 两条判据：
 *   · 封面是**派生的**（`AssetRun` 的 hash → 地址）：卡片不存「我选了哪张图」。
 *     换封面＝把那枚图挪到正文最前（或删掉它），不引入第二份配置。
 *   · **没有图也要有格子**：给它一个占位（首字／图标），否则「这张卡没图」
 *     看起来像「这张卡坏了」——而它只是还没配图。
 */
import { TITLE_COLUMN, fieldTextOf, sortRecords, type BlockStore, type ViewConfig, type ViewRecord } from '../core/index.ts'
import { t } from '../core/msg.ts'
import { assetViewOf } from '../view/asset-views.ts'

export interface ViewGalleryDeps {
  store: BlockStore
  records: () => ViewRecord[]
  view: () => ViewConfig | null
  projectTitle: (record: ViewRecord, into: HTMLElement) => void
  openBlock: (blockId: string) => void
}

/** 一张卡最多显示几个字段（再多就不是「看一眼」而是表格了） */
const MAX_FIELDS = 3

export class ViewGallery {
  readonly root: HTMLElement
  private readonly deps: ViewGalleryDeps

  constructor(deps: ViewGalleryDeps) {
    this.deps = deps
    this.root = document.createElement('section')
    this.root.className = 'vg'
  }

  dispose(): void {}

  render(): void {
    const view = this.deps.view()
    const size = view?.gallery?.size ?? 'm'
    this.root.dataset.size = size
    const records = sortRecords(this.deps.records(), view?.table?.sort)
    this.root.replaceChildren()
    if (records.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'tv-unsupported'
      empty.textContent = t('ui.list.empty')
      this.root.appendChild(empty)
      return
    }
    for (const r of records) this.root.appendChild(this.card(r, view))
  }

  private card(r: ViewRecord, view: ViewConfig | null): HTMLElement {
    const card = document.createElement('article')
    card.className = 'vg-card'
    card.dataset.blockId = r.block.id

    const cover = document.createElement('div')
    cover.className = 'vg-cover'
    const hash = view?.gallery?.cover === 'none' ? '' : firstAssetOf(r)
    if (hash !== '') {
      const img = document.createElement('img')
      img.className = 'vg-cover-img'
      img.alt = ''
      img.src = assetViewOf(hash).url ?? ''
      // 文件没了不是「这张卡坏了」：留一个占位，别让格子塌掉
      img.addEventListener('error', () => {
        img.remove()
        cover.dataset.state = 'missing'
        cover.textContent = t('ui.gallery.noCover')
      })
      cover.appendChild(img)
    } else {
      cover.dataset.state = 'none'
      const mark = document.createElement('span')
      mark.className = 'vg-cover-mark'
      mark.textContent = (r.title || t('ui.page.untitled')).slice(0, 1)
      cover.appendChild(mark)
    }
    card.appendChild(cover)

    const title = document.createElement('div')
    title.className = 'vg-card-title ui-ellipsis'
    this.deps.projectTitle(r, title)
    card.appendChild(title)

    const fields = (view?.gallery?.cardFields ?? []).filter((k) => k !== TITLE_COLUMN).slice(0, MAX_FIELDS)
    for (const key of fields) {
      const text = fieldTextOf(r, key)
      if (text === '') continue
      const row = document.createElement('div')
      row.className = 'vg-card-field ui-ellipsis'
      row.textContent = text
      card.appendChild(row)
    }

    card.addEventListener('click', () => this.deps.openBlock(r.block.id))
    return card
  }
}

/** 这张卡正文里的**第一枚**资产 run（封面是派生的：不存「我选了哪张」） */
function firstAssetOf(r: ViewRecord): string {
  for (const run of r.block.content) if (run.t === 'asset') return run.asset
  return ''
}
