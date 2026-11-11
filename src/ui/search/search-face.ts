/**
 * 中心**搜索面**：⌘K 浮层的另一个尺寸（同一份引擎、同一套行说法，不是第二套结果渲染）。
 *
 * 形状是**主从布局**：顶部输入行；左列是**只读的命中列表**（`HitView` 片段/住哪/经由），
 * 右列是**当前选中的那一块**，用 `EditableBlock` 画成真正的块。
 * tab 与 **紧凑尺寸（⌘K 浮层）都可编辑**：两份尺寸仍是**同一台** `PreviewPane`，
 * 只读只是宿主的参数（`faceChrome().previewReadOnly`），不是第二套实现。
 *
 * 为什么不是「整列结果都换成块行」：50 条整块太吵，列表要能扫读；真正要改的只有一块。
 * 为什么不是「每行一台编辑器」：那是 50 个订阅与 50 个重载器，与「一台编辑器 N 个 loader」
 * 相反。所以这里是 **一个 master-detail：左边找、右边改**。
 *
 * 与浮层的分工：浮层是快入口（可编辑，但它不常驻）；这里是常驻 tab——
 * 词随打开带过来一次（**不做 live 双写**：两边各搜各的，改词不互相追）。
 *
 * 四条动作口径：
 *   · **选中**（单击行 / ↑↓）＝ 换右列预览，**不导航**（点一下就走的入口是行尾那颗图标）；
 *   · **打开**（双击行 / 行尾图标 / `⌘↵` / 预览里的块标）＝ 走装配层的打开路由；
 *     修饰键与块打开同一套：`⇧↵`·`⇧+双击`·`⇧+行尾图标`＝右槽窗口，`⌘`＝新 tab；
 *   · **晋升为查询块**＝ 把词写进 `{text}` 条件建一个查询块——搜索从会话状态
 *     晋升成内容（要切片/要常驻时才用），创建走查询块自己的路径，这里不算结果；
 *   · **复制引用**（每行）＝ 与编辑器「复制块引用」同一条命令。
 *
 * 预览（右列）的整组状态**住在 `./preview-pane.ts`**：懒建一台 `EditableBlock`、
 * 跨选中复用、默认折叠、命中高亮、删除后回落、关面时先 `flush()` 再拆。
 * 这一层只回答「选谁」——两列的状态各自有一份生命周期，混在一个类里会长成两套 if。
 *
 * 空态与无结果：
 *   · 词为空 ⇒ **最近更新**（按修改时间直接从模型取，不经过查询引擎——
 *     它是「从哪开始」的入口，不是一次查询）；这一屏**不显示右列**（没有「选中的命中」）；
 *   · 有词无结果 ⇒ **创建入口**（沿引用浮层的先例：同名地址已存在就不给，避免假话），
 *     同样不显示右列。
 */
import { t, type MsgId } from '../../core/infra/msg.ts'
import { DebouncedInput } from '../../core/infra/debounced-input.ts'
import { isDeleted, isOwnEdit, openActionOf, type BlockStore, type OpenAction } from '../../core/index.ts'
import type { KbClient } from '../../core/kb/types.ts'
import type { FtsSource } from '../../core/search/sources.ts'
import type { BlockEditor, Run } from '../../view/editor/editor.ts'
import { renderIcon } from '../../view/icons.ts'
import type { HitView } from '../../app/search/hits.ts'
import type { SearchHit, SearchResult } from '../../app/search/service.ts'
import { pickAfterRemoval, pickSelection, sharedHintOf } from './selection.ts'
import { faceChrome } from './face-chrome.ts'
import { claimHighlightKey } from './highlight-key.ts'
import { PreviewPane } from './preview-pane.ts'

/** 输入防抖窗口（ms）：见 `debounce` 字段的取值理由 */
const SEARCH_INPUT_DEBOUNCE_MS = 140

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
  /**
   * 焦点**离开本面**（整面级：面内的输入框 ↔ 预览之间不算离开）：
   * 装配层若正把活动编辑器指着本面，要交回。与 `onFocus` 成对维护，
   * 否则「最后聚焦者胜」会让两个面同屏时活动编辑器停在已经离开的那一面。
   */
  onBlur?: (editor: BlockEditor) => void
  /** 搜索面被拆掉：装配层若正把活动编辑器指着预览，要退回正文 */
  onDispose: (editor: BlockEditor) => void
  /** 预览里编辑了模型：落盘、刷角标、刷 tab 标题；**绝不重跑搜索** */
  onChange: (kind: string) => void
  /** 引擎现取（索引状态会变）：ready ⇒ FTS，否则扫描降级。降级要在面上明说，不装没事 */
  query: (text: string, limit?: number) => Promise<SearchResult>
  /** 行怎么说（与 ⌘K 浮层同一份） */
  describe: (hit: SearchHit, term: string) => HitView | null
  /**
   * 打开一条命中。落点与块打开同一套语言（`openActionOf`）：缺省＝中心，
   * Shift＝右槽窗口，⌘/Ctrl＝新 tab。浮层宿主自己负责先关浮层。
   */
  openBlock: (blockId: string, place?: OpenAction) => void
  /** 晋升为查询块（森林顶层；返回块 id） */
  promote: (term: string) => string
  /** 无结果时的创建入口（页） */
  createPage: (name: string) => void
  copyRef: (blockId: string) => void
  /** 空态的「最近更新」：模型直取，按修改时间倒序 */
  recents: (limit: number) => HitView[]
  /** 刷新之后说一句（移除了几条 / 失败保留旧结果）：与查询视图同一个出口 */
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /**
   * **紧凑形态**（⌘K 浮层）。形态差异只在 `faceChrome()` 里翻译成「哪些件不摆」，
   * 不要散记 `if (compact)`。
   */
  compact?: boolean
  /**
   * 「展开为面板」：把当前词带进常驻的搜索 tab（紧凑形态专属，是否摆由 `faceChrome().expand` 决定）。
   * 装配层负责关浮层、带词、开 tab；组件只上报「用这个词展开」。
   */
  expand?: (term: string) => void
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
  private readonly staleEl: HTMLElement
  private readonly refreshBtn: HTMLButtonElement
  /** 「展开为面板」（只有紧凑形态有；其余形态是 null） */
  private readonly expandBtn: HTMLButtonElement | null
  private readonly bodyEl: HTMLElement
  private readonly listEl: HTMLElement
  /** 右列预览（整组状态归它：见 `./preview-pane.ts`） */
  private readonly pane: PreviewPane
  /** 当前列表对应的块（选中/打开都按 id 说话） */
  private rows: HitView[] = []
  /** 当前选中那一块（右列预览就是它）；空串 ＝ 没有选中 */
  private selectedId = ''
  /**
   * **这一份列表的身份**（`'recents'` 或查询词）。
   *
   * 选中跨列表保留只在**同一份列表**里有意义（刷新时不该把用户选的那条换掉）。
   * 换了词就是另一份列表——把上一份的选中带过来会让「首条自动选中」静默失效
   * （实测：最近更新的第一条恰好也在新结果里 ⇒ 选中停在它身上，而它排在新列表的末尾）。
   */
  private listKey = ''
  /**
   * 这一份列表里「住哪」是不是**全一样**（已提进分组标题）。
   *
   * 局部更新（预览编辑、外部 touch）要沿用同一条判据：否则一改那一行，
   * 它又把刚提走的「住哪」吐回来，行宽当场变窄。
   */
  private sharedHint = ''
  /** 这一份列表是不是「搜索命中」（不是最近更新）：决定分组标题与它的计数 */
  private resultMode = false
  /**
   * **冻结的命中集**：搜出来就不随库变化重算。
   *
   * 它是「结果可能已过期」的判据来源——外部改了其中某块（`ids` 命中）就点亮提示，
   * 但**不重排**；真正移除发生在显式刷新，并说清移除了几条。
   */
  private frozen = new Set<string>()
  /** 上一次查询用的词（刷新要按**它**重跑，不是输入框里可能刚改过的词） */
  private queriedTerm = ''
  /** 异步结果的序号：慢一拍的回复不能盖掉刚打出来的新词 */
  private seq = 0
  private disposed = false
  /**
   * store 订阅：冻结集里的块被外部动过 ⇒ 点亮 stale。
   * 可空：`unmount()` 退订、`mount()` 再订阅，所以它必须能表达「现在没订」。
   */
  private offStore: (() => void) | null = null
  /**
   * 输入防抖：连续输入只查最后一次。
   * 取值 140ms：足够跨过一次键盘连击，又不至于让「停下就想看结果」有体感延迟；
   * 空词与 Enter 不受它影响（见 `DebouncedInput`）。
   */
  private readonly debounce: DebouncedInput

  constructor(deps: SearchFaceDeps) {
    this.deps = deps
    // 形态的**唯一**翻译点：构造器里只读这份结果，不再现读 `deps.compact`
    const chrome = faceChrome(deps.compact === true)
    // 同屏可有多台同类宿主（两个 tab 面/两面 + 第三个宿主）：基名只给第一个，其余派生
    const highlightKey = claimHighlightKey(chrome.highlightKey)
    this.debounce = new DebouncedInput((value) => this.setTerm(value), SEARCH_INPUT_DEBOUNCE_MS)
    this.root = document.createElement('div')
    this.root.className = 'search-face'

    const bar = document.createElement('div')
    bar.className = 'search-face-bar'

    this.input = document.createElement('input')
    this.input.className = 'search-face-input'
    this.input.placeholder = t('ui.search.placeholderBlock')
    this.input.spellcheck = false
    this.input.addEventListener('input', () => this.debounce.input(this.input.value))
    // 输入法组合期不查：每敲一个拼音字母都发一次查询，而那时词还是中间态
    this.input.addEventListener('compositionstart', () => this.debounce.compositionStart())
    this.input.addEventListener('compositionend', () => this.debounce.compositionEnd(this.input.value))
    this.input.addEventListener('keydown', (e) => {
      // Enter 立即查：别让「打完就按回车」看到的是旧列表
      if (e.key === 'Enter') this.debounce.flush()
      // `⌘/Ctrl + ↵` ＝ 在主编辑器打开；`⇧ + ↵` ＝ 右槽窗口打开（两个尺寸同一口径；
      // 输入框的裸 ↵ 由 `bareEnterOpens` 定）。修饰键的落点语言与块打开同一份（`openActionOf`）
      if (e.key === 'Enter' && !e.altKey && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        e.preventDefault()
        this.openSelected(openActionOf(e))
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
        /**
         * 裸 ↵ 只回答**输入框**的落点：`bareEnterOpens` 为真时打开选中那条
         * （不可编辑的紧凑面）；否则把焦点交给右列预览开始编辑。
         * **预览里的 ↵ 不经过这里**——那是编辑器自己的结构动作（拆块/合并）。
         * 只认**当前列表就是这个词的结果**：Enter 会先 flush 防抖，而查询是异步的——
         * 不等它对齐就打开，会打开上一份列表里的旧首条。
         */
        if (chrome.bareEnterOpens) {
          if (this.listKey === this.term()) this.openSelected()
          return
        }
        this.focusPreview()
      }
    })

    /**
     * 「晋升为查询块」是 **tab 专属**：紧凑形态不摆这件（要建内容的那一步属于常驻面）。
     * 判据来自 `faceChrome`，不是这里的 `if (deps.compact)`。
     */
    let promote: HTMLButtonElement | null = null
    if (chrome.promote) {
      promote = document.createElement('button')
      promote.type = 'button'
      promote.className = 'search-face-promote'
      promote.dataset.tip = t('ui.search.promote')
      promote.setAttribute('aria-label', t('ui.search.promote'))
      renderIcon(promote, 'lucide:list-filter', 'list-filter')
      promote.addEventListener('click', () => {
        const q = this.term()
        if (q !== '') this.deps.promote(q)
      })
    }

    /**
     * 「展开为面板」是**紧凑形态专属**：浮层是一次性快入口，要常驻就把词带进 tab。
     * 只在有命中时出现——空词或没搜到东西的词，展开成一个空面板没有意义。
     */
    let expand: HTMLButtonElement | null = null
    if (chrome.expand && deps.expand) {
      expand = document.createElement('button')
      expand.type = 'button'
      expand.className = 'search-face-expand'
      expand.dataset.tip = t('ui.search.expand')
      expand.setAttribute('aria-label', t('ui.search.expand'))
      renderIcon(expand, 'lucide:panel-right', 'panel-right')
      expand.hidden = true
      expand.addEventListener('click', () => {
        const q = this.term()
        if (q !== '') deps.expand?.(q)
      })
    }

    this.modeEl = document.createElement('span')
    this.modeEl.className = 'search-face-mode'
    this.modeEl.hidden = true

    /**
     * 「结果可能已过期」：只是提示，不拦编辑、不重排列表。
     *
     * 为什么必须和刷新按钮一起出现：搜索结果是**冻结**的（库变化不重跑——那会重排
     * 列表、把正在输入的那一行换掉）。冻结而没有刷新出口，就是「列表永远停在搜出来的
     * 那一刻，而用户看不到任何说明」。
     */
    this.staleEl = document.createElement('span')
    this.staleEl.className = 'search-face-stale'
    this.staleEl.hidden = true

    this.refreshBtn = document.createElement('button')
    this.refreshBtn.type = 'button'
    this.refreshBtn.className = 'search-face-refresh'
    // 与查询视图同一个动作、同一句文案（`ui.query.refresh`）——它也需要「看得见」才可发现
    this.refreshBtn.textContent = t('ui.query.refresh')
    this.refreshBtn.addEventListener('click', () => this.refresh())

    bar.append(this.input, this.staleEl, this.refreshBtn)
    if (promote) bar.append(promote)
    if (expand) bar.append(expand)
    bar.append(this.modeEl)
    this.expandBtn = expand

    this.listEl = document.createElement('div')
    this.listEl.className = 'search-face-list'

    this.bodyEl = document.createElement('div')
    this.bodyEl.className = 'search-face-body'

    /**
     * 右列的整组状态交给 `PreviewPane`：这一层只在「选中变了 / 列表换了一份 /
     * 空态变了」时告诉它「选谁、词是什么」。
     *
     * 三个回调刻意都是**读活值**（选中、行、词）而不是拷一份进来：预览要跟的是
     * 左列**此刻**的选中，拷进来的快照会在刷新/摘行之后说谎。
     */
    this.pane = new PreviewPane(this.bodyEl, {
      kb: deps.kb,
      store: deps.store,
      write: deps.write,
      wire: deps.wire,
      targetId: () => this.selectedId,
      onDrop: (id) => this.dropRow(id),
      onEdit: (kind) => {
        // 左行是**快照**，预览是这一块的真相：编辑后只按 id 改那一行，不重排
        this.refreshSelectedRow()
        this.deps.onChange(kind)
      },
      onFocus: (editor) => this.deps.onFocus(editor),
      onDispose: (editor) => this.deps.onDispose(editor),
      returnFocus: () => this.input.focus(),
      // 两面都可编辑；只读与高亮基名都由 `faceChrome` 定（key 已按本次宿主领过）
      readOnly: chrome.previewReadOnly,
      highlightKey,
      noteOf: (id) => {
        const row = this.rows.find((v) => v.blockId === id)
        return row?.source && row.source !== 'content'
          ? t('ui.search.via', { via: t(VIA_KEY[row.source]) })
          : undefined
      },
    })

    this.bodyEl.append(this.listEl, this.pane.root)

    this.root.append(bar, this.bodyEl)

    /**
     * **整面级失焦**（不是预览级）：焦点离开 `.search-face` 才把活动编辑器交回。
     * 面内「输入框 ↔ 预览」来回不算离开——那还是同一面，键位该落在这面的编辑器上。
     */
    this.root.addEventListener('focusout', (e) => {
      const next = e.relatedTarget as Node | null
      if (next && this.root.contains(next)) return
      const editor = this.pane.editor
      if (editor) this.deps.onBlur?.(editor)
    })

    this.subscribeStore()
    this.renderRecents()
  }

  /**
   * **冻结的命中集**：外部改了其中某块 ⇒ 只点亮「结果可能已过期」，不重排。
   *
   * 为什么订阅在这里而不在 `EditableBlock` 里：那一台管的是**右列**（预览装载），
   * 它已经会自己跟上外部变化；这一层管的是**左列**（冻结的结果集）——两件事。
   * 自己的编辑不算外部变化（那一行已经按 id 局部更新过）。
   *
   * 幂等：已订过就返回（`mount()` 每次都会调它，但同一时刻只该有一条）。
   */
  private subscribeStore(): void {
    if (this.offStore) return
    this.offStore = this.deps.store.subscribe((source, ids) => {
      if (this.disposed || this.frozen.size === 0) return
      if (isOwnEdit(source, this.pane.editor)) return
      // 拿不到「动过哪些块」就不点亮：宁可少提示，也不要因为别处重画而误报
      if (!ids || ids.length === 0) return
      const touched = ids.filter((id) => this.frozen.has(id))
      if (touched.length === 0) return
      /**
       * **先按 id 把受影响的行片段改成当前内容，再点亮 stale**。
       *
       * 只点亮不更新会让左右自相矛盾：右列预览是 `EditableBlock`，它自己会跟上外部
       * 变化 ⇒ 屏幕上「预览是新的、左边那一行还是旧的」。片段是**快照**没错，但快照
       * 至少要反映「这一刻这一块是什么」，否则用户会以为改错了地方。
       * 移除仍然只在刷新时发生（那一步会报告条数）。
       */
      for (const id of touched) this.refreshRowSnippet(id)
      this.paintStale()
    })
  }

  /**
   * 挂到给定宿主：**根进文档之后**再装预览编辑器（`BlockEditor` 构造时会量 DOM，
   * 在游离容器上量出来的尺寸/选区是错的）。
   *
   * 幂等：已在同一宿主上就只补一次预览挂载；换宿主则把根搬过去。
   */
  mount(host: HTMLElement): void {
    if (this.disposed) return
    this.subscribeStore()
    if (this.root.parentElement !== host) host.appendChild(this.root)
    this.pane.mount()
  }

  /**
   * **从宿主上摘下来**（不是销毁）：退订、撤掉挂着的输入定时器、拆预览编辑器、
   * 把根从宿主移除。保留词 / 列表 / 选中，再次 `mount()` 能接着用。
   *
   * 幂等：没有宿主时就什么都不做。
   */
  unmount(): void {
    if (this.disposed) return
    // 挂着的防抖会在卸载之后补发一枪（用户已经看不见这一屏了）
    this.debounce.cancel()
    this.pane.unmount()
    this.offStore?.()
    this.offStore = null
    this.root.parentElement?.removeChild(this.root)
  }

  /** 词随打开带过来一次；之后这个 tab 自己管自己的词 */
  setTerm(term: string): void {
    if (this.disposed) return
    // 已经按这个词查了（或别的口径已接手）⇒ 丢掉还挂着的防抖定时器，避免补发一枪
    this.debounce.cancel()
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

  /**
   * **显式刷新**：按上一次查询的词重跑，并说清移除了几条。
   *
   * 为什么按 `queriedTerm` 而不是输入框的当前值：输入框里的词可能已经改了但还没提交
   * （用户只是敲了一半）。刷新承诺的是「把这一份结果按当前库重算」，不是「按新词重搜」。
   *
   * 为什么必须报告移除条数：冻结的结果集里有的块可能已经不匹配了（被改掉、被删掉）。
   * 静默少几条，用户会以为搜索漏了；说一句「有 N 条已不再匹配」才让这件事可解释。
   */
  refresh(): void {
    if (this.disposed) return
    const q = this.queriedTerm
    if (q === '') {
      // 空词（最近更新）不是一次查询：重取一遍就好，没有「移除」可言
      this.renderRecents()
      return
    }
    const before = new Set(this.rows.map((v) => v.blockId))
    const mine = ++this.seq
    void this.deps
      .query(q, 50)
      .then((r) => {
        if (this.disposed || mine !== this.seq) return
        const views = r.hits.map((hit) => this.deps.describe(hit, q)).filter((v): v is HitView => v !== null)
        const after = new Set(views.map((v) => v.blockId))
        const dropped = [...before].filter((id) => !after.has(id)).length
        this.paint(views, t('ui.search.results', { count: views.length }), q)
        this.clearStale()
        if (dropped > 0) this.deps.toast(t('ui.query.dropped', { count: dropped }), 'ok')
      })
      .catch(() => {
        if (this.disposed || mine !== this.seq) return
        // 刷新失败保留旧结果 + 说一句（不静默清空——那会看起来像「搜索全丢了」）
        this.deps.toast(t('ui.query.refreshFailed', { message: t('ui.search.queryFailed') }), 'warn')
      })
  }

  /** 「结果可能已过期」：只是提示，不改列表、不拦编辑 */
  private paintStale(): void {
    this.staleEl.hidden = false
    this.staleEl.textContent = t('ui.query.stale')
  }

  private clearStale(): void {
    this.staleEl.hidden = true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.debounce.dispose()
    this.offStore?.()
    this.offStore = null
    // 右列自己收尾：摘高亮 → 先 flush 最后一笔 → 交回活动编辑器 → 拆（见 `PreviewPane.dispose`）
    this.pane.dispose()
  }

  private term(): string {
    return this.input.value.trim()
  }

  /* ------------------------------------------------------------ 列表 */

  private setRows(views: HitView[], key: string): void {
    this.rows = views
    /**
     * 同一份列表（刷新）⇒ 旧选中还在就保留（刷新不该把用户选的那条换掉）；
     * **换了列表** ⇒ 一律选第一条（首条自动选中是这一屏的初始态）。
     */
    const keep = key === this.listKey ? this.selectedId : ''
    this.listKey = key
    this.selectedId = pickSelection(
      views.map((v) => v.blockId),
      keep,
    )
    this.syncExpand()
  }

  /**
   * 「展开为面板」只在**真的查过一次且这次有命中**时出现。
   *
   * 空词给的是「最近更新」，不是一次查询：它既没有可带过去的词，展开成面板也只是
   * 把同一份最近列表搬个地方。无结果时同理——展开成一个空面板没有意义。
   */
  private syncExpand(): void {
    if (!this.expandBtn) return
    this.expandBtn.hidden = !this.resultMode || this.rows.length === 0
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
    this.pane.sync(this.queriedTerm)
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

  private paint(views: HitView[], header: string | null, key: string): void {
    this.setRows(views, key)
    // 冻结集就是「这一份结果里有哪些块」：外部动过其中任何一块 ⇒ 点亮 stale
    this.frozen = new Set(views.map((v) => v.blockId))
    /**
     * **公共祖先只说一次**。
     *
     * 命中常常整批来自同一页（`住哪` 逐行都是同一句），逐行重复既不携带信息，
     * 又把片段挤成一截（实测左列 299px 里它占 47px、片段只剩 178px）。
     * 判据是「是不是同一个」：全一样 ⇒ 提进分组标题、行里不再重复；
     * 不一样 ⇒ 每行各说各的（那才是有用的信息）。
     */
    const shared = sharedHintOf(views.map((v) => v.hint))
    this.sharedHint = shared
    this.listEl.replaceChildren()
    if (header !== null) this.listEl.appendChild(groupHeader(shared === '' ? header : `${header} · ${shared}`))
    for (const view of views) this.listEl.appendChild(this.row(view, shared !== ''))
    this.renderSelection()
    this.pane.sync(this.queriedTerm)
  }

  /** 空态：最近更新（模型直取；不是一次查询，没有「结果数」可说，也不存在降级） */
  private renderRecents(): void {
    this.modeEl.hidden = true
    this.resultMode = false
    // 最近更新不是一次查询：没有冻结集、没有「移除几条」、也不该有 stale
    this.queriedTerm = ''
    this.frozen = new Set()
    this.clearStale()
    const views = this.deps.recents(20)
    if (views.length === 0) {
      this.setRows([], 'recents')
      this.listEl.replaceChildren()
      this.listEl.appendChild(this.emptyNote(t('ui.search.empty')))
      this.pane.sync(this.queriedTerm)
      return
    }
    this.paint(views, t('ui.search.recents'), 'recents')
  }

  private renderResults(r: SearchResult, q: string): void {
    // 降级要明说：只有索引 ready 才信 FTS；扫描只搜正文（行上也不会有「经由」可标）
    this.modeEl.hidden = r.mode !== 'scan'
    this.modeEl.textContent = t('ui.search.degraded')
    this.resultMode = true
    // 刷新按**这个词**重跑（输入框里可能已经改了半截，那不是刷新要用的词）
    this.queriedTerm = q
    this.clearStale()
    const views = r.hits.map((hit) => this.deps.describe(hit, q)).filter((v): v is HitView => v !== null)
    if (views.length === 0) {
      this.renderNoResults(q)
      return
    }
    this.paint(views, t('ui.search.results', { count: views.length }), q)
  }

  private renderNoResults(q: string): void {
    this.resultMode = true
    this.queriedTerm = q
    this.frozen = new Set()
    this.clearStale()
    this.rows = []
    this.selectedId = ''
    this.listEl.replaceChildren()
    this.listEl.appendChild(this.emptyNote(t('ui.search.empty')))
    this.syncExpand()
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
    this.pane.sync(this.queriedTerm)
  }

  private row(view: HitView, hideHint = false): HTMLElement {
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
    // 双击＝打开（单击预览、双击打开：两个动作各有一个可见出口，行尾那颗图标是打开的入口）。
    // 修饰键跟块打开同一份判据：Shift＝右槽窗口、⌘/Ctrl＝新 tab
    pick.addEventListener('dblclick', (e) => this.deps.openBlock(view.blockId, openActionOf(e)))
    fillRowText(pick, view, hideHint)

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
    go.dataset.tip = t('ui.search.open')
    go.setAttribute('aria-label', t('ui.search.open'))
    renderIcon(go, 'lucide:arrow-up-right', 'arrow-up-right')
    go.addEventListener('click', (e) => {
      e.stopPropagation()
      this.deps.openBlock(view.blockId, openActionOf(e))
    })
    tail.appendChild(go)

    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'search-row-copy'
    copy.dataset.tip = t('ui.search.copyRef')
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

  private openSelected(place?: OpenAction): void {
    if (this.selectedId !== '') this.deps.openBlock(this.selectedId, place)
  }

  /* ------------------------------------------------------------ 右列预览 */

  /** 把某一行从列表里摘掉，并把选中挪到还在的那一条 */
  private dropRow(id: string): void {
    const at = this.rows.findIndex((v) => v.blockId === id)
    if (at >= 0) this.rows.splice(at, 1)
    this.listEl.querySelector(`.search-row[data-search-row="${id}"]`)?.remove()
    if (this.selectedId === id) this.selectedId = pickAfterRemoval(this.rows.map((v) => v.blockId), at)
    this.updateGroupCount()
    this.syncExpand()
    this.renderSelection()
    // 只同步「右列在不在」：装载下一块由调用点（或 `PreviewPane` 自己）继续
    this.pane.setVisible(this.selectedId !== '')
  }

  /** `↵` 把焦点放进右列预览（开始编辑）：光标落在这一块的开头 */
  private focusPreview(): void {
    this.pane.focus()
  }

  /**
   * 预览里编辑之后：用当前块重新说**选中那一行**，只改片段与「住哪」，不重排。
   *
   * 为什么只改一行：列表是冻结的命中集，编辑不该改变结果顺序；左右不一致又会让用户
   * 怀疑「改的是不是同一个块」。词不再命中时**不**在这里移除（那是刷新/stale 的事）。
   */
  private refreshSelectedRow(): void {
    if (this.selectedId === '') return
    this.refreshRowSnippet(this.selectedId)
  }

  /**
   * **按 id 重说一行**（选中行与外部 touch 的行共用这一条）。
   *
   * 三件事按顺序判：块没了 ⇒ 收掉这一行并回落选中；块还在 ⇒ 只换片段文本；
   * 描述不出来（`describe` 给 null）⇒ 什么都不做（宁可少改一行，也不要把行画成空的）。
   */
  private refreshRowSnippet(id: string): void {
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
      this.pane.sync(this.queriedTerm)
      return
    }
    const source = this.rows[at]!.source
    const view = this.deps.describe({ blockId: id, score: 0, ...(source ? { source } : {}) }, this.term())
    if (!view) return
    this.rows[at] = view
    const row = this.listEl.querySelector<HTMLElement>(`.search-row[data-search-row="${id}"]`)
    const pick = row?.querySelector<HTMLElement>('.search-row-select')
    if (pick) fillRowText(pick, view, this.sharedHint !== '')
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
function fillRowText(host: HTMLElement, view: HitView, hideHint = false): void {
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
  // 「住哪」提进分组标题时不在这里重复（同一句话逐行说 N 遍＝没有信息，还挤掉片段）
  if (hideHint) {
    host.replaceChildren(label)
    return
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
