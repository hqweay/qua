/**
 * 中心**搜索面**：⌘F 浮层的另一个尺寸（同一份引擎、同一套行说法，不是第二套结果渲染）。
 *
 * 形状是**主从布局**：顶部输入行；左列是**只读的命中列表**（`HitView` 片段/住哪/经由），
 * 右列是**当前选中的那一块**，用 `EditableBlock` 画成真正的块、可以直接改。
 *
 * 为什么不是「整列结果都换成块行」：50 条整块太吵，列表要能扫读；真正要改的只有一块。
 * 为什么不是「每行一台编辑器」：那是 50 个订阅与 50 个重载器，与「一台编辑器 N 个 loader」
 * 相反。所以这里是 **一个 master-detail：左边找、右边改**。
 *
 * 与浮层的分工：浮层是一次性快入口（选中即走）；这里是常驻 tab——
 * 词随打开带过来一次（**不做 live 双写**：两边各搜各的，改词不互相追）。
 *
 * 四条动作口径：
 *   · **选中**（单击行 / ↑↓）＝ 换右列预览，**不导航**（点一下就走的入口是行尾那颗图标）；
 *   · **打开**（双击行 / 行尾图标 / `⌘↵` / 预览里的块标）＝ 走装配层的打开路由；
 *   · **晋升为查询块**＝ 把词写进 `{text}` 条件建一个查询块——搜索从会话状态
 *     晋升成内容（要切片/要常驻时才用），创建走查询块自己的路径，这里不算结果；
 *   · **复制引用**（每行）＝ 与编辑器「复制块引用」同一条命令。
 *
 * 预览的口径（照反链卡的先例，不是另发明一套）：
 *   · 一个 `EditableBlock` 实例**跨选中复用**：换选中只换 roots，不重建——重建一次就丢一次
 *     撤销栈与选区；
 *   · `structuralScope:'roots'`：预览根是派生的结果行，不能并进上一行/搬出结果集；
 *     根内部照常编辑（改字、建子块、删子块）；
 *   · **不传 `viewRootId`**：它不是「标题格」，Enter 要能建子块并**看见**它
 *     ⇒ 子块默认折叠，而拆块动作自己会展开（`splitTx` 的 `unfoldBlock`）；
 *   · 编辑走**同一份 `run`**：落盘、索引增量、撤销都在；**绝不重跑搜索**——
 *     重跑会重排列表并打断正在输入的那一行。
 *
 * 空态与无结果：
 *   · 词为空 ⇒ **最近更新**（按修改时间直接从模型取，不经过查询引擎——
 *     它是「从哪开始」的入口，不是一次查询）；这一屏**不显示右列**（没有「选中的命中」）；
 *   · 有词无结果 ⇒ **创建入口**（沿引用浮层的先例：同名地址已存在就不给，避免假话），
 *     同样不显示右列。
 */
import { t, type MsgId } from '../../core/infra/msg.ts'
import { hasFoldable, isDeleted, type BlockStore } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import type { FtsSource } from '../../core/search/sources.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { renderIcon } from '../../view/icons.ts'
import type { HitView } from '../../app/search/hits.ts'
import type { SearchHit, SearchResult } from '../../app/search/service.ts'
import { EditableBlock } from '../block-ui/editable-block.ts'
import { pickAfterRemoval, pickSelection } from './selection.ts'

export interface SearchFaceDeps {
  kb: KbClient
  /** 共享 store：预览按 id 现读**活块**（搜索结果只是一批 id，不是块的拷贝） */
  store: BlockStore
  /** 写入事务入口（与正文同一个 `run`，见 `Run`） */
  write: Run
  /** 与正文**同一份**编辑器事件表（右键块菜单 / `#`·`@` / 引用跳转 / 粘贴…） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 预览获得焦点：装配层把「活动编辑器」切过来（键位走命令层，认的是它） */
  onFocus: (editor: BlockEditor) => void
  /** 搜索面被拆掉：装配层若正把活动编辑器指着预览，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 预览里编辑了模型：落盘、刷角标、刷 tab 标题；**绝不重跑搜索** */
  onChange: (kind: string) => void
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
  private readonly bodyEl: HTMLElement
  private readonly listEl: HTMLElement
  /** 右列（滚动容器；编辑器宿主是它里面那一格） */
  private readonly previewEl: HTMLElement
  private readonly previewHost: HTMLElement
  /** 当前列表对应的块（选中/打开都按 id 说话） */
  private rows: HitView[] = []
  /** 当前选中那一块（右列预览就是它）；空串 ＝ 没有选中 */
  private selectedId = ''
  /** 结果行元素按 id 复用：编辑预览后**只改选中那一行**，不重排 */
  private preview: EditableBlock | null = null
  /** 已经种过「默认折叠」的块（用户展开过的不再种第二次） */
  private readonly seededFold = new Set<string>()
  /** root 接进文档之后才建编辑器（`BlockEditor` 构造时会量 DOM） */
  private mounted = false
  /** 这一份列表是不是「搜索命中」（不是最近更新）：决定分组标题与它的计数 */
  private resultMode = false
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
      // `⌘/Ctrl + ↵` ＝ 在主编辑器打开（两个尺寸的差异：浮层是裸 ↵ 打开）
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        this.openSelected()
        return
      }
      // 其余只认**裸键**：修饰键组合归命令层的键位表——这里抢了的话，
      // 在面上按「进一档」这类带修饰的组合会变成「打开第一行结果」（真踩过）。
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.move(e.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // ↵ ＝ 把焦点放进右列预览（开始编辑）；「打开」在 ⌘↵ 与行尾图标上
        this.focusPreview()
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

    this.previewEl = document.createElement('div')
    this.previewEl.className = 'search-face-preview'
    // 宿主（可编辑容器）与滚动容器分开：`EditableBlock` 会把宿主装进它自己的岛根，
    // 再让调用方把**岛根**接进布局 —— 若把同一颗元素既当宿主又当岛根的父节点，就是自环。
    this.previewHost = document.createElement('div')
    this.previewHost.className = 'search-face-preview-editor'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'search-face-body'
    this.bodyEl.dataset.preview = '0'
    this.bodyEl.append(this.listEl, this.previewEl)

    this.root.append(bar, this.bodyEl)

    this.renderRecents()
  }

  /**
   * **root 接进文档之后**再装预览编辑器。
   *
   * `BlockEditor` 构造时就会渲染并量 DOM；在游离容器上量出来的尺寸/选区是错的
   * （`surface.ts` 是先造身体、随后才 `replaceChildren`）。
   */
  mount(): void {
    if (this.mounted || this.disposed) return
    this.mounted = true
    this.syncPreview()
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

  /**
   * 库变了 ⇒ 重跑当前词。
   *
   * ⚠️ 装配层**不再**在库变化时调它（`surface.refreshIfShown`）：预览里每敲一个字都是一次
   * 库变化，重跑会把列表重排、把正在输入的那一行换掉。这里的 `rerun` 只留给显式动作。
   */
  rerun(): void {
    if (this.disposed) return
    this.setTerm(this.input.value)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const ed = this.preview?.ed
    if (ed) this.deps.onDispose(ed)
    this.preview?.dispose()
    this.preview = null
  }

  private term(): string {
    return this.input.value.trim()
  }

  /* ------------------------------------------------------------ 列表 */

  private setRows(views: HitView[]): void {
    this.rows = views
    // 结果集变了：旧选中还在就保留，不在就选第一条；空结果 ⇒ 没有选中
    this.selectedId = pickSelection(
      views.map((v) => v.blockId),
      this.selectedId,
    )
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return
    const at = Math.max(
      0,
      this.rows.findIndex((v) => v.blockId === this.selectedId),
    )
    const next = (at + delta + this.rows.length) % this.rows.length
    this.select(this.rows[next]!.blockId)
  }

  private select(blockId: string): void {
    if (blockId === this.selectedId) {
      this.renderSelection()
      return
    }
    this.selectedId = blockId
    this.renderSelection()
    this.syncPreview()
  }

  /** 选中态是**一个属性**（`data-selected`）：列表与预览的对应关系只有这一份 */
  private renderSelection(): void {
    let at: HTMLElement | null = null
    for (const el of this.listEl.querySelectorAll<HTMLElement>('.search-row')) {
      if (el.dataset.searchRow === this.selectedId) {
        el.dataset.selected = '1'
        at = el
      } else {
        delete el.dataset.selected
      }
    }
    at?.scrollIntoView({ block: 'nearest' })
  }

  private paint(views: HitView[], header: string | null): void {
    this.setRows(views)
    this.listEl.replaceChildren()
    if (header !== null) this.listEl.appendChild(groupHeader(header))
    for (const view of views) this.listEl.appendChild(this.row(view))
    this.renderSelection()
    this.syncPreview()
  }

  /** 空态：最近更新（模型直取；不是一次查询，没有「结果数」可说，也不存在降级） */
  private renderRecents(): void {
    this.modeEl.hidden = true
    this.resultMode = false
    const views = this.deps.recents(20)
    if (views.length === 0) {
      this.setRows([])
      this.listEl.replaceChildren()
      this.listEl.appendChild(this.emptyNote(t('ui.search.empty')))
      this.syncPreview()
      return
    }
    this.paint(views, t('ui.search.recents'))
  }

  private renderResults(r: SearchResult, q: string): void {
    // 降级要明说：只有索引 ready 才信 FTS；扫描只搜正文（行上也不会有「经由」可标）
    this.modeEl.hidden = r.mode !== 'scan'
    this.modeEl.textContent = t('ui.search.degraded')
    this.resultMode = true
    const views = r.hits.map((hit) => this.deps.describe(hit, q)).filter((v): v is HitView => v !== null)
    if (views.length === 0) {
      this.renderNoResults(q)
      return
    }
    this.paint(views, t('ui.search.results', { count: views.length }))
  }

  private renderNoResults(q: string): void {
    this.resultMode = true
    this.rows = []
    this.selectedId = ''
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
    this.syncPreview()
  }

  private row(view: HitView): HTMLElement {
    const row = document.createElement('div')
    row.className = 'search-row'
    // 读数契约：冒烟与探针按这个属性取「搜索面里有哪些结果」
    row.dataset.searchRow = view.blockId

    const pick = document.createElement('button')
    pick.type = 'button'
    pick.className = 'search-row-select'
    // 按下不挪焦点：行只回答「选谁」，输入框要继续接 ↑↓（否则点一下行，方向键就失效）
    pick.addEventListener('mousedown', (e) => e.preventDefault())
    pick.addEventListener('click', () => this.select(view.blockId))
    // 双击＝打开（单击预览、双击打开：两个动作各有一个可见出口，行尾那颗图标是打开的入口）
    pick.addEventListener('dblclick', () => this.deps.openBlock(view.blockId))
    fillRowText(pick, view)

    const tail = document.createElement('span')
    tail.className = 'search-row-tail'
    // 经由只标**非正文**的命中：正文是默认来路，逐行写「经由正文」是噪音
    if (view.source && view.source !== 'content') {
      const via = document.createElement('span')
      via.className = 'search-row-via'
      via.textContent = t('ui.search.via', { via: t(VIA_KEY[view.source]) })
      tail.appendChild(via)
    }
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'search-row-goto'
    go.title = t('ui.search.open')
    go.setAttribute('aria-label', t('ui.search.open'))
    renderIcon(go, 'lucide:arrow-up-right', 'arrow-up-right')
    go.addEventListener('click', (e) => {
      e.stopPropagation()
      this.deps.openBlock(view.blockId)
    })
    tail.appendChild(go)

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

    row.append(pick, tail)
    return row
  }

  private openSelected(): void {
    if (this.selectedId !== '') this.deps.openBlock(this.selectedId)
  }

  /* ------------------------------------------------------------ 右列预览 */

  /** 这一屏该不该有右列：没有命中（空词/无结果）就没有「选中的那一条」 */
  private previewWanted(): boolean {
    return this.term() !== '' && this.selectedId !== ''
  }

  private syncPreview(): void {
    const want = this.previewWanted()
    this.bodyEl.dataset.preview = want ? '1' : '0'
    if (!want) {
      // 收起时把预览清空：隐藏的编辑器不该继续挂着上一块（也不该继续被外部变化重载）
      const ed = this.preview?.ed
      if (ed) {
        if (ed.doc.roots.length > 0) ed.loadPage({ roots: [], folded: ed.doc.folded })
        // 焦点还留在被隐藏的那一列 ⇒ 交回输入框（焦点不能停在一个看不见的容器里）
        if (ed.ownFocus()) this.input.focus()
      }
      return
    }
    // 还没接进文档 ⇒ 等 `mount()`；在游离容器上建编辑器会量错尺寸
    if (!this.mounted) return
    this.loadPreview(this.ensurePreviewEditor())
  }

  /** 懒建：第一次有选中项时才建这一台（空结果不该建实例） */
  private ensurePreviewEditor(): BlockEditor {
    if (!this.preview) {
      this.preview = new EditableBlock({
        host: this.previewHost,
        store: this.deps.store,
        write: this.deps.write,
        load: (ed) => {
          if (ed) this.loadPreview(ed)
        },
        // 预览的根是派生的结果行：不能并进上一行/搬出结果集；根内部照常编辑
        structuralScope: 'roots',
        wire: this.deps.wire,
        onChange: (kind) => {
          // 左行是**快照**，预览是这一块的真相：编辑后只按 id 改那一行，不重排
          this.refreshSelectedRow()
          this.deps.onChange(kind)
        },
        onFocus: (editor) => this.deps.onFocus(editor),
      })
      this.previewEl.appendChild(this.preview.root)
    }
    return this.preview.ed ?? this.preview.ensureEditor()
  }

  /**
   * 装什么：**选中的那一块**（按 id 现读活块），面包屑给祖先链。
   *
   * ⚠️ 折叠表**每次从 `ed.doc.folded` 重读**：`writeFold` 每次都换一个新对象，
   *    长期持有一份旧引用会让「用户展开过」在下次装载时丢掉。
   */
  private loadPreview(ed: BlockEditor): void {
    if (!this.previewWanted()) {
      if (ed.doc.roots.length > 0) ed.loadPage({ roots: [], folded: ed.doc.folded })
      return
    }
    const block = this.deps.kb.get(this.selectedId)
    /**
     * 选中的块已经**软删/真没了** ⇒ 回落。
     *
     * 判据含软删：删除是原位标记，`kb.get` 照样取得到它——只看「取不取得到」会让
     * 预览继续画一个已经被删的块（「删了还在这儿」）。回落只走一次（下一块不会是它）。
     */
    if (!block || isDeleted(block)) {
      this.dropRow(this.selectedId)
      if (!this.previewWanted()) {
        ed.loadPage({ roots: [], folded: ed.doc.folded })
        return
      }
      const next = this.deps.kb.get(this.selectedId)
      if (!next) return
      this.paintPreview(ed, next)
      return
    }
    this.paintPreview(ed, block)
  }

  /** 装载一块进预览：子块默认折叠、面包屑给祖先链 */
  private paintPreview(ed: BlockEditor, block: import('../../core/index.ts').Block): void {
    const folded = { ...(ed.doc.folded ?? {}) }
    // 子块默认折叠：防「一屏 50 条大树」。只在这一块**第一次被选中**时种一次——
    // 用户展开过的不再种回去（Enter 拆出来的子块因此看得见）
    if (!this.seededFold.has(block.id)) {
      this.seededFold.add(block.id)
      if (hasFoldable(block)) folded[block.id] = true
    }
    const path = this.deps.kb.pathOf(block.id)
    const contexts = path.length > 1 ? new Map([[block.id, path.slice(0, -1)]]) : undefined
    ed.loadPage({ roots: [block], ...(contexts ? { contexts } : {}), folded })
    // 换内容即回顶部（切换选中不继承上一块的滚动位置）
    this.previewEl.scrollTop = 0
  }

  /** 把某一行从列表里摘掉，并把选中挪到还在的那一条 */
  private dropRow(id: string): void {
    const at = this.rows.findIndex((v) => v.blockId === id)
    if (at >= 0) this.rows.splice(at, 1)
    this.listEl.querySelector(`.search-row[data-search-row="${id}"]`)?.remove()
    if (this.selectedId === id) this.selectedId = pickAfterRemoval(this.rows.map((v) => v.blockId), at)
    this.updateGroupCount()
    this.renderSelection()
    this.bodyEl.dataset.preview = this.previewWanted() ? '1' : '0'
  }

  /** `↵` 把焦点放进右列预览（开始编辑）：光标落在这一块的开头 */
  private focusPreview(): void {
    const ed = this.preview?.ed
    if (!ed || !this.previewWanted()) return
    ed.container.focus()
    if (this.selectedId !== '') ed.placeCaret(this.selectedId, 0)
  }

  /**
   * 预览里编辑之后：用当前块重新说这一行，**只改选中那一行的片段与「住哪」，不重排**。
   *
   * 为什么只改一行：列表是冻结的命中集，编辑不该改变结果顺序；左右不一致又会让用户
   * 怀疑「改的是不是同一个块」。词不再命中时**不**在这里移除（那是刷新/stale 的事）。
   */
  private refreshSelectedRow(): void {
    const id = this.selectedId
    if (id === '') return
    const at = this.rows.findIndex((v) => v.blockId === id)
    if (at < 0) return
    const block = this.deps.kb.get(id)
    /**
     * 块真的没了（删除/清除）⇒ 按 id 移除这一行并选下一条，预览跟着换。
     *
     * ⚠️ 判据要含**软删**：`kb.get` 对回收站里的块照样返回（它还在树上的原位），
     *    只看「取不取得到」会让「删掉之后预览还画着它」看起来像没删。
     */
    if (!block || isDeleted(block)) {
      this.dropRow(id)
      this.syncPreview()
      return
    }
    const source = this.rows[at]!.source
    const view = this.deps.describe({ blockId: id, score: 0, ...(source ? { source } : {}) }, this.term())
    if (!view) return
    this.rows[at] = view
    const row = this.listEl.querySelector<HTMLElement>(`.search-row[data-search-row="${id}"]`)
    const pick = row?.querySelector<HTMLElement>('.search-row-select')
    if (pick) fillRowText(pick, view)
  }

  private updateGroupCount(): void {
    if (!this.resultMode) return
    const head = this.listEl.querySelector<HTMLElement>('.search-face-group')
    if (head) head.textContent = t('ui.search.results', { count: this.rows.length })
  }

  private emptyNote(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'search-face-note'
    el.textContent = text
    return el
  }
}

/** 一行里「命中片段 ＋ 住哪」：初次画与编辑后的局部更新共用这一份 */
function fillRowText(host: HTMLElement, view: HitView): void {
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
  host.replaceChildren(label, hint)
}

function groupHeader(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'search-face-group'
  el.textContent = text
  return el
}
