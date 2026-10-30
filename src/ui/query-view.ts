/**
 * **视图宿主**：一个块的「怎么看」这一层。
 *
 * 两种源、一套壳（与 `core/view.ts` 的判据同一处）：
 *
 * | 源 | 抬头 | 正文 |
 * |---|---|---|
 * | **查询块**（有 `_query`） | 名字 ＋ 条数 ＋ 「可能已过期」＋ 刷新 ＋ 视图切换 | 大纲＝一列命中；表格＝同一批命中 |
 * | **children**（普通块，激活了视图） | 条数 ＋ 视图切换 ＋ 新建一行 | 表格（直接子块＝行）；切回大纲就没有这一层 |
 *
 * 口径（为什么长这样）：
 *   · **冻结只属于查询源**：成员与顺序来自 `_queryResult`，只在「刷新」时变（D4）；
 *     内容按 id 现读（改字立即看得见）。children 源是**活的**——子块就是成员，结构变了就是变了。
 *   · **它只出现在「被打开的那一段」**：查询块的命中、普通块的子块，都不在正文里再画一遍
 *     （正文那边由 `Doc.viewRootId` 让位）。
 *   · **视图切换只写 `_activeView`**：不重查、不重装模型；重装一屏是装配层的事（`reloadPage`）。
 *
 * ⚠️ 大纲分支的 DOM 类名（`.queryview-editor` 里一列 `.blk`）是既有断言的契约，不要改。
 */
import {
  activeView,
  childrenRecords,
  defaultColumns,
  displayNameOf,
  expandContexts,
  isQueryBlock,
  listTableOf,
  readResult,
  readSpec,
  readViews,
  refreshSpec,
  resolveRows,
  resolveFrozen,
  sourceOf,
  unfoldForContext,
  usesSelf,
  viewsBroken,
  viewNameOf,
  type Block,
  type BlockStore,
  type ViewConfig,
  type ViewRecord,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { BlockEditor, type Run } from '../view/editor.ts'
import { BlockCell } from './block-cell.ts'
import { EditableBlock } from './editable-block.ts'
import { ViewListTable } from './view-list-table.ts'
import { ViewTable } from './view-table.ts'

export interface ViewHostDeps {
  store: BlockStore
  /** 读门面：求值走 `kb.query`（索引），现读按 id（`kb.get`／`kb.pathOf`） */
  kb: KbClient
  /** 写入事务入口：执行者在装配层（见 `Run`） */
  write: Run
  /** 宿主块（活引用）：读 `_query`／`_views`，写回也按它的 id */
  block: () => Block
  /** 发生写入之后要落盘 / 重画别的视图 */
  onChange: () => void
  /** 焦点进来 ⇒ 装配层把「活动编辑器」切过来（键位走命令层） */
  onFocus: (editor: BlockEditor) => void
  /** 接上与正文同一套事件（引用跳转、右键菜单、`#` 补全） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 提示（刷新失败、丢了几条、配置坏了） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 命令面（切视图、排序、增删行、写一格的属性都走它：撤销/落盘只有一条路） */
  invoke: (name: string, args: Record<string, unknown>) => void
  /** 标题列的投影（run/marks/引用/图片）——由装配层注入，`ui` 不拿整片森林 */
  project: (block: Block, into: HTMLElement) => void
  /** 点标题里的引用/原子（与正文同一条口径） */
  refClick: (hit: { to: string; runId?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  onAtomClick?: (atom: { runId: string; kind: string; hash?: string }, el: HTMLElement, mods: { altKey: boolean; shiftKey: boolean }) => void
  /** 打开一块（行首块标 / 紧凑列表） */
  openBlock: (blockId: string) => void
  /** `ref` 值的选择器（与属性区同一份） */
  pickRef?: (owner: Block, propId: string, current: string, onPick: (targetId: string) => void, anchor?: DOMRect) => void
  refLabel?: (targetId: string) => string
}

export interface ViewHostEls {
  root: HTMLElement
  title: HTMLElement
  count: HTMLElement
  /** 视图切换器（大纲 ＋ 已有视图 ＋ 加一个表格） */
  views: HTMLElement
  refresh: HTMLButtonElement
  newRow: HTMLButtonElement
  /** 「结果可能已过期」标记：只提示、不改列表（自动移除会让人正在读的那行凭空消失） */
  stale: HTMLElement
  /** 大纲分支（查询源的命中列表；类名是既有断言的契约） */
  editor: HTMLElement
  /** 表格分支 */
  table: HTMLElement
}

/**
 * 自建 DOM：视图宿主只出现在**某一段**里（被打开的那个块自己那一段），
 * 一个静态模板节点没法同时属于多段 —— 组件自己造自己那几格。
 */
export function createViewHostEls(): ViewHostEls {
  const root = document.createElement('section')
  root.className = 'queryview'
  root.hidden = true

  const head = document.createElement('div')
  head.className = 'queryview-head'
  const title = document.createElement('span')
  title.className = 'queryview-title'
  const count = document.createElement('span')
  count.className = 'queryview-count'
  const stale = document.createElement('span')
  stale.className = 'queryview-stale'
  stale.hidden = true
  const views = document.createElement('div')
  views.className = 'queryview-views'
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'queryview-refresh'
  const newRow = document.createElement('button')
  newRow.type = 'button'
  newRow.className = 'queryview-newrow'
  newRow.hidden = true
  head.append(title, count, stale, views, refresh, newRow)

  const body = document.createElement('div')
  body.className = 'queryview-body'
  /**
   * 大纲分支的**槽**（不是编辑宿主本身）。
   *
   * 为什么要多一层：`EditableBlock` 会把宿主节点**搬进**自己的岛根里
   * （`contenteditable=false` 的断链节点）。若把 `.queryview-editor` 直接当宿主，
   * 它就会被搬离这个槽 —— 再想把岛根放回槽里就是「把父节点塞进自己的孩子」
   * （浏览器直接抛 `appendChild … contains the parent`）。
   */
  const editor = document.createElement('div')
  editor.className = 'queryview-outline'
  editor.hidden = true
  const table = document.createElement('div')
  table.className = 'queryview-table'
  table.hidden = true
  body.append(editor, table)

  root.append(head, body)
  return { root, title, count, views, refresh, newRow, stale, editor, table }
}

export class ViewHost {
  private readonly els: ViewHostEls
  private readonly deps: ViewHostDeps
  /** 大纲分支（懒建：切到表格时 dispose，切回来重建 —— 不藏一台还在订阅的编辑器） */
  private outline: EditableBlock | null = null
  /** 表格分支 */
  private table: ViewTable | null = null
  /** 结构映射表分支（行＝子块、格＝位置的另一种「怎么看」） */
  private listTable: ViewListTable | null = null
  /** 这一屏现在画的是谁：`outline` 或激活视图的 id（变了才换分支） */
  private mode = ''
  private readonly cell: BlockCell
  /** 查询视图自己的 stale 订阅（只点亮提示、不重排——冻结成员是 D4） */
  private readonly offStale: () => void
  private staleIds = new Set<string>()
  /** 上下文展开栈（祖先 id）；刷新时清空，外部编辑重画时保留 */
  private expanded = new Set<string>()
  /** 上次渲染的「上下文根 → 覆盖的命中行」：收起一层时滚回那一行 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()
  /** 配置坏了只提示一次（每次装载都弹一遍会盖住用户正在做的事） */
  private warned = false

  constructor(els: ViewHostEls, deps: ViewHostDeps) {
    this.els = els
    this.deps = deps
    this.els.refresh.textContent = t('ui.query.refresh')
    this.els.refresh.addEventListener('click', () => this.refresh())
    this.els.newRow.textContent = t('ui.view.newRow')
    this.els.newRow.title = t('ui.view.newRowTitle')
    this.els.newRow.addEventListener('click', () => this.deps.invoke('core.view/new-row', { blockId: this.deps.block().id }))
    this.cell = new BlockCell({
      store: deps.store,
      write: deps.write,
      wire: (ed, change) => deps.wire(ed, change),
      onFocus: (ed) => deps.onFocus(ed),
      onChange: () => deps.onChange(),
      project: (b, into) => deps.project(b, into),
      refClick: (hit, el, mods) => deps.refClick(hit, el, mods),
      ...(deps.onAtomClick ? { onAtomClick: deps.onAtomClick } : {}),
      openBlock: (id) => deps.openBlock(id),
    })

    // ⚠️ 只点亮 stale，不重排列表（D4 的「不自动重算」）。
    // 拿不到「动过哪些块」就先不点亮：宁可少提示，也不要因为刷新顺带的重渲染误报。
    this.offStale = deps.store.subscribe((source, ids) => {
      if (source === this.outline?.ed) return
      if (ids && ids.length > 0) {
        this.noteTouched(ids)
        // children 源是活的：子块的正文/属性变了，那一行要跟着变（按 blockId 局部修补）
        if (this.table) this.table.sync(ids)
        if (this.listTable) this.listTable.render(ids)
      }
    })
  }

  /** 视图宿主的根（装配层把它放进那一段的段尾槽） */
  get root(): HTMLElement {
    return this.els.root
  }

  /** 大纲分支的编辑器（没有就在；表格分支下是 `null`） */
  get editor(): BlockEditor | null {
    return this.outline?.ed ?? null
  }

  dispose(): void {
    this.offStale()
    this.outline?.dispose()
    this.outline = null
    this.table?.dispose()
    this.table = null
    this.listTable?.dispose()
    this.listTable = null
    this.cell.dispose()
  }

  /**
   * 首次装载（或宿主换了）：冻结一次（查询源）／直接画（children 源）。
   *
   * 「没有冻结结果就求值一次」与「点刷新」走**同一个函数**，避免出现两套口径。
   */
  mount(): void {
    this.staleIds.clear()
    this.warned = false
    const b = this.deps.block()
    if (isQueryBlock(b) && !readSpec(b)) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    if (isQueryBlock(b) && !readResult(b)) {
      this.freeze()
      return
    }
    this.sync(true)
  }

  /**
   * 装配层在每次装载之后叫一次：**画法变了就换分支**（`_activeView` 被命令改过），
   * 没变就只把数据对齐（不整表重排 —— 那是「滚动一下整表重建」的来源）。
   */
  sync(force = false): void {
    const b = this.deps.block()
    const view = activeView(b)
    const mode = view ? `${view.kind}:${view.id}` : 'outline'
    if (this.warned === false && viewsBroken(b)) {
      this.warned = true
      this.deps.toast?.(t('ui.view.broken'), 'warn')
    }
    if (force || mode !== this.mode) {
      this.mode = mode
      this.paintChrome(b, view)
      if (!view) {
        this.showOutline()
        this.render()
      } else {
        this.showTable(view)
      }
      return
    }
    this.paintChrome(b, view)
    if (view?.kind === 'list-table') this.listTable?.render()
    else if (view) this.table?.sync()
    else this.render()
  }

  /** 刷新按钮：重算成员与顺序（D6：失败保留旧结果） */
  refresh(): void {
    this.els.refresh.disabled = true
    try {
      this.freeze()
      this.deps.toast?.(t('ui.query.refreshed', { count: this.rowCount() }), 'ok')
    } catch (e) {
      // 保留旧结果 + 明确告知（不静默清空）
      this.deps.toast?.(t('ui.query.refreshFailed', { message: e instanceof Error ? e.message : String(e) }), 'warn')
    } finally {
      this.els.refresh.disabled = false
    }
  }

  private rowCount(): number {
    const b = this.deps.block()
    if (sourceOf(b).kind === 'query') return (readResult(b) ?? []).length
    // 结构映射表的行＝活着的直接子块（软删的不算一行），与渲染器同一份派生
    if (activeView(b)?.kind === 'list-table') return listTableOf(b.id, this.deps.kb).rows.length
    return this.deps.kb.children(b.id).length
  }

  private freeze(): void {
    const b = this.deps.block()
    const spec = readSpec(b)
    if (!spec) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    /**
     * **写回必须走事务**：冻结结果与条件都是模型改动，直改活块不会产出 op
     * ⇒ 落盘时这一笔被静默跳过（条件变了、库里还是旧的）。
     */
    const dropped = this.deps.write((tx) => {
      let out: string[] = []
      tx.patch(b.id, (x) => {
        out = refreshSpec(x, spec, this.deps.kb).dropped
      })
      return out
    })
    if (dropped.length > 0) this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
    // 刷新＝成员与顺序都换了：上一轮的上下文展开没有依据，从头来
    this.expanded = new Set()
    this.covers = new Map()
    this.staleIds.clear()
    this.deps.onChange()
    this.sync(true)
  }

  /* ---------------------------------------------------------- 抬头 */

  private paintChrome(b: Block, view: ViewConfig | null): void {
    this.els.root.hidden = false
    const query = sourceOf(b).kind === 'query'
    const name = displayNameOf(b).trim()
    /**
     * 查询源保留名字（它自己就是这张视图的标题）；
     * children 源的根行就在上面，抬头再写一遍同一句就是重复。
     */
    this.els.title.hidden = !query
    this.els.title.textContent = query ? (name === '' ? t('ui.query.untitled') : name) : ''
    const n = this.rowCount()
    this.els.count.textContent = query ? t('ui.query.count', { count: n }) : t('ui.view.count', { count: n })
    this.els.refresh.hidden = !query
    this.els.newRow.hidden = query
    this.paintStale()
    this.paintViews(b, view)
  }

  /**
   * 视图切换：**已保存的视图 ＋ 大纲 ＋ 「＋」**。
   *
   * 为什么不是「每种 kind 一个按钮」：一个块可以有**多个**同 kind 的视图（各自列/序不同），
   * 按 kind 放按钮就表达不了「第 2 张表」。这里列的是这个块自己的视图实例。
   */
  private paintViews(b: Block, view: ViewConfig | null): void {
    const box = this.els.views
    box.replaceChildren()
    if (sourceOf(b).kind !== 'query' && b.children.length === 0 && !view) {
      // 叶子块没有可摊开的东西：不给入口（点了只会看到空表）
      box.hidden = true
      return
    }
    box.hidden = false
    const btn = (label: string, active: boolean, onClick: () => void): HTMLButtonElement => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'qv-view-btn'
      if (active) el.dataset.active = '1'
      el.textContent = label
      el.addEventListener('click', onClick)
      return el
    }
    box.appendChild(btn(t('ui.view.outline'), view === null, () => this.deps.invoke('core.view/set-active', { blockId: b.id, viewId: '' })))
    for (const v of readViewsOf(b)) {
      box.appendChild(
        btn(viewNameOf(v, (k) => t(`ui.view.kind.${k}`)), view?.id === v.id, () =>
          this.deps.invoke('core.view/set-active', { blockId: b.id, viewId: v.id }),
        ),
      )
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'qv-view-btn qv-view-add'
    add.title = t('ui.view.addView')
    add.textContent = '＋'
    /**
     * 不再是「一键加平表」：切换器旁边那颗 `＋` 现在是**新建视图的入口**，
     * 与块菜单里的「视图…」同一个菜单（两种表都从那里建，入口只有一份）。
     */
    add.addEventListener('click', () => this.deps.invoke('core.view/menu', { blockId: b.id }))
    box.appendChild(add)
  }

  /* ---------------------------------------------------------- 分支 */

  private showOutline(): void {
    this.table?.dispose()
    this.table = null
    this.listTable?.dispose()
    this.listTable = null
    this.els.table.hidden = true
    this.els.table.replaceChildren()
    this.els.editor.hidden = false
    if (!this.outline) {
      const host = document.createElement('div')
      host.className = 'queryview-editor'
      host.spellcheck = false
      this.outline = new EditableBlock({
        host,
        store: this.deps.store,
        write: this.deps.write,
        // 冻结范围＝整片视图：焦点落在刷新/视图按钮上时，重画抬头会把正被按的那颗换掉
        area: this.els.root,
        load: () => this.render(),
        wire: (editor, change) => this.deps.wire(editor, change),
        onChange: () => this.deps.onChange(),
        onFocus: (editor) => this.deps.onFocus(editor),
        onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
        onContextBack: (rootId) => this.collapse(rootId),
      })
      this.outline.ensureEditor()
      this.els.editor.appendChild(this.outline.root)
    }
  }

  /** 大纲分支的编辑宿主（空态文案挂在它身上：`.queryview-editor[data-empty]`） */
  private get outlineHost(): HTMLElement | null {
    return this.outline?.host ?? null
  }

  private showTable(view: ViewConfig): void {
    this.outline?.dispose()
    this.outline = null
    this.els.editor.hidden = true
    this.els.editor.replaceChildren()
    /**
     * 两条渲染器：表格（行＝记录、列＝属性）与结构映射表（行＝一级子块、列＝位置）。
     * 它们**不共用**布局：平表有固定行高与窗口化，结构映射表按内容排、不吃窗口化那套。
     * 所以按 kind 各建各的实例，切走就 dispose（不藏一台还在订阅的）。
     */
    const want = view.kind === 'table' ? 'table' : view.kind === 'list-table' ? 'list' : 'none'
    if (want !== 'table') {
      this.table?.dispose()
      this.table = null
    }
    if (want !== 'list') {
      this.listTable?.dispose()
      this.listTable = null
    }
    this.els.table.hidden = false
    if (want === 'none') {
      // 类型与数据形状先就位，渲染器随后（看板/画廊/日历/导图）；这里给一句实话而不是空屏
      this.els.table.replaceChildren()
      const p = document.createElement('p')
      p.className = 'tv-unsupported'
      p.textContent = t('ui.view.unsupported')
      this.els.table.appendChild(p)
      return
    }
    if (want === 'list') {
      if (!this.listTable) {
        this.listTable = new ViewListTable({
          store: this.deps.store,
          host: () => this.deps.block(),
          view: () => activeView(this.deps.block()) ?? view,
          kb: this.deps.kb,
          cell: this.cell,
          openBlock: (id) => this.deps.openBlock(id),
          deleteRow: (rowId) => this.deps.invoke('core.view/delete-row', { rowId }),
        })
        this.els.table.replaceChildren(this.listTable.root)
      }
      this.listTable.render()
      return
    }
    if (!this.table) {
      this.table = new ViewTable({
        store: this.deps.store,
        host: () => this.deps.block(),
        view: () => activeView(this.deps.block()) ?? view,
        records: () => this.records(),
        defs: () => this.deps.kb.propDefs(),
        defaults: () => defaultColumns(this.deps.block().id, this.deps.kb),
        setValue: (blockId, propId, value) => this.deps.invoke('core.props/set-value', { blockId, propId, value }),
        clearValue: (blockId, propId) => this.deps.invoke('core.props/clear-value', { blockId, propId }),
        sort: (by, dir) => this.deps.invoke('core.view/set-sort', { blockId: this.deps.block().id, by, dir }),
        insertRow: () => this.deps.invoke('core.view/new-row', { blockId: this.deps.block().id }),
        deleteRow: (rowId) => this.deps.invoke('core.view/delete-row', { rowId }),
        openBlock: (id) => this.deps.openBlock(id),
        cell: this.cell,
        ...(this.deps.pickRef ? { pickRef: this.deps.pickRef } : {}),
        ...(this.deps.refLabel ? { refLabel: this.deps.refLabel } : {}),
      })
      this.els.table.replaceChildren(this.table.root)
    }
    this.table.render()
  }

  /** 行（派生）：查询源＝命中（不折叠祖先）；children 源＝直接子块 */
  private records(): ViewRecord[] {
    const b = this.deps.block()
    if (sourceOf(b).kind === 'query') {
      const frozen = readResult(b) ?? []
      return resolveRows(frozen, this.deps.kb, { excludeId: b.id })
    }
    return childrenRecords(b.id, this.deps.kb)
  }

  /* ---------------------------------------------------------- 大纲分支：查询结果 */

  /** 抬头上的「结果可能已过期」：只是提示，不改列表（D4） */
  private paintStale(): void {
    const dirty = this.staleIds.size > 0
    this.els.stale.hidden = !dirty
    if (dirty) this.els.stale.textContent = t('ui.query.stale')
  }

  /**
   * 外部告诉视图「这些块变了」⇒ 若其中有当前结果里的成员，点亮「结果可能已过期」。
   *
   * ⚠️ 只点亮、**不重排**（D4）；真正移除发生在刷新时，并会 toast 说清移除了几条。
   */
  noteTouched(ids: readonly string[]): void {
    const b = this.deps.block()
    if (sourceOf(b).kind !== 'query') return
    const frozen = readResult(b) ?? []
    const inResult = new Set(frozen.map((h) => h.blockId))
    let hit = false
    for (const id of ids) {
      if (inResult.has(id)) {
        this.staleIds.add(id)
        hit = true
      }
    }
    if (hit) this.paintStale()
  }

  /** 按冻结结果渲染**当前活块**（D5：内容不冻） */
  private render(focusHint?: string): void {
    const b = this.deps.block()
    // children 源没有大纲分支（关掉视图就没有这一层了）
    if (sourceOf(b).kind !== 'query') return
    this.paintStale()
    const frozen = readResult(b)
    if (!frozen) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    const rows = resolveFrozen(frozen, (id) => this.deps.kb.pathOf(id))
    this.els.root.hidden = false
    this.els.count.textContent = t('ui.query.count', { count: rows.length })
    if (rows.length === 0) {
      // 空结果里没有可展开的东西：收起栈也一起清掉
      this.expanded = new Set()
      this.covers = new Map()
      // 空结果是**状态**不是错误：保留抬头（含刷新按钮），正文给一句实话。
      const spec = readSpec(b)
      const why = spec && usesSelf(spec.where) ? t('ui.mount.needsHost') : t('ui.query.empty')
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.outline?.ed?.loadPage({ roots: [], folded: this.outline.ed.doc.folded })
      const host = this.outlineHost
      if (host) {
        host.dataset.empty = '1'
        host.dataset.emptyText = why
      }
      return
    }
    if (this.outlineHost) delete this.outlineHost.dataset.empty
    // 只装「最外层命中」：子树由编辑器自己展开，命中块的祖先链作为行首面包屑。
    const contexts = new Map<string, readonly Block[]>()
    for (const r of rows) if (r.path.length > 0) contexts.set(r.block.id, r.path)
    const plan = expandContexts(
      { roots: rows.map((r) => r.block), contexts },
      this.expanded,
      (id) => this.deps.kb.pathOf(id),
      focusHint,
    )
    this.expanded = plan.expanded
    this.covers = plan.covers
    const folded = unfoldForContext(this.outline?.ed?.doc.folded ?? {}, plan.covers, (id) => this.deps.kb.pathOf(id))
    this.outline?.ed?.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) this.outline?.ed?.reveal(plan.focusId)
  }

  /** 普通点面包屑：把祖先装成这一栏的根（中心／历史不动） */
  private expand(ancestorId: string, rowId: string): void {
    if (!ancestorId) return
    this.expanded.add(ancestorId)
    this.render(rowId || undefined)
  }

  /** 收起一层：内层还留在栈里，下一次渲染会浮出来 */
  private collapse(rootId: string): void {
    if (!this.expanded.delete(rootId)) return
    this.render(this.covers.get(rootId)?.[0])
  }

  private renderEmpty(text: string): void {
    this.expanded = new Set()
    this.covers = new Map()
    this.els.root.hidden = false
    this.els.title.hidden = false
    this.els.title.textContent = text
    this.els.count.textContent = ''
    this.els.editor.hidden = false
    const host = this.outlineHost
    if (host) {
      host.dataset.empty = '1'
      host.dataset.emptyText = text
    }
  }
}

/** 这一块的视图列表（只读投影；写路径在命令层） */
function readViewsOf(b: Block): ViewConfig[] {
  return readViews(b)
}
