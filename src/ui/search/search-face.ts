/**
 * 中心**搜索面**：⌘F 浮层的另一个尺寸（同一份引擎、同一套行说法，不是第二套结果渲染）。
 *
 * 与浮层的分工：浮层是一次性快入口（选中即走）；这里是常驻 tab——
 * 词随打开带过来一次（**不做 live 双写**：两边各搜各的，改词不互相追）。
 *
 * 三条动作口径：
 *   · **打开**（点行 / ↵）＝ 唯一的导航入口，走装配层的打开路由；
 *   · **晋升为查询块**＝ 把词写进 `{text}` 条件建一个查询块——搜索从会话状态
 *     晋升成内容（要切片/要常驻时才用），创建走查询块自己的路径，这里不算结果；
 *   · **复制引用**（每行）＝ 与编辑器「复制块引用」同一条命令。
 *
 * 空态与无结果：
 *   · 词为空 ⇒ **最近更新**（按修改时间直接从模型取，不经过查询引擎——
 *     它是「从哪开始」的入口，不是一次查询）；
 *   · 有词无结果 ⇒ **创建入口**（沿引用浮层的先例：同名地址已存在就不给，避免假话）。
 */
import { t, type MsgId } from '../../core/infra/msg.ts'
import type { KbClient } from '../../core/kb/types.ts'
import type { FtsSource } from '../../core/search/sources.ts'
import { renderIcon } from '../../view/icons.ts'
import type { HitView } from '../../app/search/hits.ts'
import type { SearchHit, SearchResult } from '../../app/search/service.ts'

export interface SearchFaceDeps {
  kb: KbClient
  /** 引擎现取（索引状态会变）：ready ⇒ FTS，否则扫描降级。降级要在面上明说，不装没事 */
  query: (text: string, limit?: number) => Promise<SearchResult>
  /** 行怎么说（与 ⌘F 浮层同一份） */
  describe: (hit: SearchHit, term: string) => HitView | null
  openBlock: (blockId: string) => void
  /** 晋升为查询块（森林顶层；返回块 id） */
  promote: (term: string) => string
  /** 无结果时的创建入口（页） */
  createPage: (name: string) => void
  copyRef: (blockId: string) => void
  /** 空态的「最近更新」：模型直取，按修改时间倒序 */
  recents: (limit: number) => HitView[]
}

const VIA_KEY: Record<FtsSource, MsgId> = {
  content: 'ui.search.via.content',
  alias: 'ui.search.via.alias',
  tag: 'ui.search.via.tag',
  prop: 'ui.search.via.prop',
  link: 'ui.search.via.link',
}

export class SearchFace {
  readonly root: HTMLElement
  private readonly deps: SearchFaceDeps
  private readonly input: HTMLInputElement
  private readonly modeEl: HTMLElement
  private readonly listEl: HTMLElement
  /** 当前列表对应的块（↵ 开「活动行」；没有行 ⇒ 不动） */
  private rows: HitView[] = []
  private active = 0
  /** 异步结果的序号：慢一拍的回复不能盖掉刚打出来的新词 */
  private seq = 0
  private disposed = false

  constructor(deps: SearchFaceDeps) {
    this.deps = deps
    this.root = document.createElement('div')
    this.root.className = 'search-face'

    const bar = document.createElement('div')
    bar.className = 'search-face-bar'

    this.input = document.createElement('input')
    this.input.className = 'search-face-input'
    this.input.placeholder = t('ui.search.placeholderBlock')
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.setTerm(this.input.value))
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.move(e.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        this.openActive()
      }
    })

    const promote = document.createElement('button')
    promote.type = 'button'
    promote.className = 'search-face-promote'
    promote.title = t('ui.search.promote')
    promote.setAttribute('aria-label', t('ui.search.promote'))
    renderIcon(promote, 'lucide:list-filter', 'list-filter')
    promote.addEventListener('click', () => {
      const q = this.term()
      if (q !== '') this.deps.promote(q)
    })

    this.modeEl = document.createElement('span')
    this.modeEl.className = 'search-face-mode'
    this.modeEl.hidden = true

    bar.append(this.input, promote, this.modeEl)
    this.listEl = document.createElement('div')
    this.listEl.className = 'search-face-list'
    this.root.append(bar, this.listEl)

    this.renderRecents()
  }

  /** 词随打开带过来一次；之后这个 tab 自己管自己的词 */
  setTerm(term: string): void {
    if (this.disposed) return
    if (this.input.value !== term) this.input.value = term
    const q = term.trim()
    const mine = ++this.seq
    if (q === '') {
      this.renderRecents()
      return
    }
    void this.deps
      .query(q, 50)
      .then((r) => {
        if (this.disposed || mine !== this.seq) return
        this.renderResults(r, q)
      })
      .catch(() => {
        if (this.disposed || mine !== this.seq) return
        this.renderNoResults(q)
      })
  }

  focusInput(): void {
    this.input.focus()
  }

  /** 库变了 ⇒ 重跑当前词（结果随库变）；词为空就重取最近更新 */
  rerun(): void {
    if (this.disposed) return
    this.setTerm(this.input.value)
  }

  dispose(): void {
    this.disposed = true
  }

  private term(): string {
    return this.input.value.trim()
  }

  private setRows(views: HitView[]): void {
    this.rows = views
    this.active = 0
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return
    this.active = (this.active + delta + this.rows.length) % this.rows.length
    this.renderActive()
  }

  private renderActive(): void {
    this.listEl.querySelectorAll<HTMLElement>('.search-row').forEach((el, i) => {
      if (i === this.active) el.dataset.active = '1'
      else delete el.dataset.active
    })
    const at = this.listEl.querySelectorAll<HTMLElement>('.search-row')[this.active]
    at?.scrollIntoView({ block: 'nearest' })
  }

  /** 空态：最近更新（模型直取；不是一次查询，没有「结果数」可说，也不存在降级） */
  private renderRecents(): void {
    this.modeEl.hidden = true
    const views = this.deps.recents(20)
    this.setRows(views)
    this.listEl.replaceChildren()
    this.listEl.appendChild(groupHeader(t('ui.search.recents')))
    if (views.length === 0) {
      this.listEl.appendChild(this.emptyNote(t('ui.search.empty')))
      return
    }
    for (const view of views) this.listEl.appendChild(this.row(view))
    this.renderActive()
  }

  private renderResults(r: SearchResult, q: string): void {
    // 降级要明说：只有索引 ready 才信 FTS；扫描只搜正文（行上也不会有「经由」可标）
    this.modeEl.hidden = r.mode !== 'scan'
    this.modeEl.textContent = t('ui.search.degraded')
    this.listEl.replaceChildren()
    const views = r.hits.map((hit) => this.deps.describe(hit, q)).filter((v): v is HitView => v !== null)
    this.setRows(views)
    if (views.length === 0) {
      this.renderNoResults(q)
      return
    }
    this.listEl.appendChild(groupHeader(t('ui.search.results', { count: views.length })))
    for (const view of views) this.listEl.appendChild(this.row(view))
    this.renderActive()
  }

  private renderNoResults(q: string): void {
    this.rows = []
    this.listEl.replaceChildren()
    this.listEl.appendChild(this.emptyNote(t('ui.search.empty')))
    // 创建入口沿引用浮层的先例：同名地址已经存在 ⇒ 不给（建第二个同名块是假话）
    const exists = this.deps.kb.resolveAlias(q)
    if (!exists) {
      const create = document.createElement('button')
      create.type = 'button'
      create.className = 'search-face-create'
      create.textContent = t('ui.search.createPage', { name: q })
      create.addEventListener('click', () => this.deps.createPage(q))
      this.listEl.appendChild(create)
    }
  }

  private row(view: HitView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'search-row'
    // 读数契约：冒烟与探针按这个属性取「搜索面里有哪些结果」
    row.dataset.searchRow = view.blockId

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'search-row-open'
    open.title = t('ui.search.open')
    const label = document.createElement('span')
    label.className = 'search-row-text ui-ellipsis'
    for (const p of view.parts) {
      if (p.mark === true) {
        const mark = document.createElement('mark')
        mark.textContent = p.text
        label.appendChild(mark)
      } else {
        label.appendChild(document.createTextNode(p.text))
      }
    }
    const hint = document.createElement('span')
    hint.className = 'search-row-hint ui-ellipsis'
    hint.textContent = view.hint
    open.append(label, hint)
    open.addEventListener('click', () => this.deps.openBlock(view.blockId))

    const tail = document.createElement('span')
    tail.className = 'search-row-tail'
    // 经由只标**非正文**的命中：正文是默认来路，逐行写「经由正文」是噪音
    if (view.source && view.source !== 'content') {
      const via = document.createElement('span')
      via.className = 'search-row-via'
      via.textContent = t('ui.search.via', { via: t(VIA_KEY[view.source]) })
      tail.appendChild(via)
    }
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'search-row-copy'
    copy.title = t('ui.search.copyRef')
    copy.setAttribute('aria-label', t('ui.search.copyRef'))
    renderIcon(copy, 'lucide:link', 'link')
    copy.addEventListener('click', (e) => {
      e.stopPropagation()
      this.deps.copyRef(view.blockId)
    })
    tail.appendChild(copy)

    row.append(open, tail)
    return row
  }

  private openActive(): void {
    const view = this.rows[this.active]
    if (view) this.deps.openBlock(view.blockId)
  }

  private emptyNote(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'search-face-note'
    el.textContent = text
    return el
  }
}

function groupHeader(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'search-face-group'
  el.textContent = text
  return el
}
