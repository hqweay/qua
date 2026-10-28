/**
 * **查询视图块**。
 *
 * 它不是「查询面板组件」，而是一个 **view block**——
 * source = `_query` 条件，view = outline，结果是一列**真实块**（活引用）。
 * placement：被**打开的那一个查询块**自己那一段的段尾槽里（与块底的挂载区同一个槽，在它上面）。
 *
 * 三条口径与代码的对应：
 *
 * | 口径 | 在代码里长这样 |
 * |---|---|
 * | **冻结成员与顺序** | 列表来自 `props._queryResult`；**不订阅** store 的变化来重排 |
 * | **内容不冻** | 每次渲染把冻结的 id 翻译成**当前活块**（`resolveFrozen`），改字立即变 |
 * | **刷新是显式动作** | 抬头一个按钮；刷新失败**保留旧结果** ＋ 提示，不静默清空 |
 *
 * ⚠️ 它不是「可编辑视图 / 实时视图」二选一：它**可编辑**，稳定性靠冻结而不是靠只读。
 * ⚠️ 视图状态（滚动、折叠展开态）不进库；滚动位置由外层编辑器自己保。
 */
import {
  displayNameOf,
  expandContexts,
  resolveFrozen,
  readResult,
  refreshSpec,
  readSpec,
  unfoldForContext,
  usesSelf,
  type Block,
  type BlockStore,
} from '../core/index.ts'
import type { KbClient } from '../core/kb/types.ts'
import { t } from '../core/msg.ts'
import { BlockEditor, type Run } from '../view/editor.ts'

export interface QueryViewDeps {
  store: BlockStore
  /** 读门面：求值走 `kb.query`（索引），冻结结果按 id 现读（`kb.pathOf`） */
  kb: KbClient
  /** 写入事务入口：执行者在装配层，这里只原样转给编辑器（见 `Run`） */
  write?: Run
  /** 查询块本身（活引用）：读 `_query`／写 `_queryResult` */
  block: () => Block
  /** 刷新后要落盘（结果集入 KB） */
  onChange: () => void
  /** 获得焦点时装配层把「活动编辑器」切过来 */
  onFocus: () => void
  /** 接上与正文同一套编辑器事件（见 `MountAreaDeps.wire`） */
  wire: (editor: BlockEditor, change: (kind: string) => void) => void
  /** 提示（刷新失败、丢了几条） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export interface QueryViewEls {
  root: HTMLElement
  editor: HTMLElement
  title: HTMLElement
  count: HTMLElement
  refresh: HTMLButtonElement
  /** 「结果可能已过期」标记：只提示、不改列表（自动移除会让人正在读的那行凭空消失） */
  stale?: HTMLElement
}

/**
 * 自建 DOM。
 *
 * 为什么不再从静态模板里 `getElementById` 取：查询视图现在只出现在**某一段**里
 * （被打开的那个查询块自己的段），一个静态节点没法同时属于「页脚」和「段内」。
 * 组件自己造自己那几格，装配层只负责把它放进那一段。
 */
export function createQueryViewEls(): QueryViewEls {
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
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'queryview-refresh'
  head.append(title, count, stale, refresh)

  const editor = document.createElement('div')
  editor.className = 'queryview-editor'
  editor.spellcheck = false

  root.append(head, editor)
  return { root, editor, title, count, refresh, stale }
}

export class QueryView {
  readonly editor: BlockEditor
  private readonly els: QueryViewEls
  private readonly deps: QueryViewDeps
  /**
   * 上次刷新之后**有没有别的视图碰过 store**（点亮 stale，但**不重排**，D4）。
   * ⚠️ 用一个自增版本号而不是布尔：刷新过程中 `onChange` 会连带触发同步（`touch`），
   *    布尔量会被自己那次改动点回来（实测：刷新完 stale 还亮着）。
   */
  /**
   * 「结果可能已过期」的判据：**当前结果里的块被改动过**。
   *
   * ⚠️ 别用「store 被 touch 过几次」来判（那是第一版做法，实测假阳性）：点刷新时
   *    `loadPage()` 会让别的视图重渲染并 `touch()`，这些抖动跟「结果过期」毫无关系。
   *    真正会让人怀疑「这条还该在吗」的，是**结果里的块自己变了**（改字、改 todo、被删）。
   */
  private staleIds = new Set<string>()
  /** 上下文展开栈（祖先 id）；刷新时清空，外部编辑重画时保留 */
  private expanded = new Set<string>()
  /** 上次渲染的「上下文根 → 覆盖的命中行」：收起一层时滚回那一行 */
  private covers: ReadonlyMap<string, readonly string[]> = new Map()

  constructor(els: QueryViewEls, deps: QueryViewDeps) {
    this.els = els
    this.deps = deps
    this.els.refresh.textContent = t('ui.query.refresh')
    this.els.refresh.addEventListener('click', () => this.refresh())
    this.els.editor.addEventListener('focusin', () => this.deps.onFocus())

    this.editor = new BlockEditor({
      container: els.editor,
      // 记录视图：没有「视图级同级」；点空白/删段根都不该发生
      blankArea: els.editor,
      allowBlankCreate: false,
      allowRootRemove: false,
      store: deps.store,
      write: deps.write,
      // 折叠态是视图私有的（理由同反链）
      doc: { roots: [], folded: {} },
      // 面包屑：普通点＝就地展开；展开根行首的「收起上下文」＝逐层退回
      onExpandContext: (ancestorId, rowId) => this.expand(ancestorId, rowId),
      onContextBack: (rootId) => this.collapse(rootId),
    })
    this.deps.wire(this.editor, (kind) => {
      if (kind === 'load') return
      // 视图内编辑：内容立即生效（D5），但要落盘；成员不动（D4）
      this.deps.onChange()
    })

    // ⚠️ 这里**只**点亮 stale，不重排列表（D4 的「不自动重算」）。
    // ⚠️ 拿得到「动过哪些块」就精确判断；拿不到（`ids === undefined`，例如结构操作）就先不点亮——
    //    宁可少提示，也不要因为「刷新顺带的重渲染」误报「结果已过期」（实测过这种假阳性）。
    this.deps.store.subscribe((source, ids) => {
      if (source === this.editor) return
      if (ids && ids.length > 0) this.noteTouched(ids)
    })
  }

  /** 查询视图的根（装配层把它放进某一段；查询视图没有静态模板节点了） */
  get root(): HTMLElement {
    return this.els.root
  }

  /** 首次装载（或查询块换了）：**冻结**一次结果，然后渲染 */
  mount(): void {
    this.staleIds.clear()
    const b = this.deps.block()
    const spec = readSpec(b)
    if (!spec) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    // 没有冻结结果 ⇒ 这是新查询：求值一次（与刷新同一个函数，避免两套口径）
    if (!readResult(b)) this.freeze()
    else this.render()
  }

  /** 刷新按钮：重算成员与顺序（D6：失败保留旧结果） */
  refresh(): void {
    this.els.refresh.disabled = true
    try {
      this.freeze()
      this.deps.toast?.(t('ui.query.refreshed', { count: this.editor.doc.roots.length }), 'ok')
    } catch (e) {
      // 保留旧结果 + 明确告知（不静默清空）
      this.deps.toast?.(t('ui.query.refreshFailed', { message: e instanceof Error ? e.message : String(e) }), 'warn')
    } finally {
      this.els.refresh.disabled = false
    }
  }

  private freeze(): void {
    const b = this.deps.block()
    const spec = readSpec(b)
    if (!spec) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    /**
     * **写回要走事务**（`deps.write`）：冻结结果与条件都是模型改动，
     * 直改活块不会产出 op ⇒ 落盘时这一笔被静默跳过（条件变了、库里还是旧的）。
     * 没有事务入口（只读视图/测试）时才直改。
     */
    const run = this.deps.write
    let dropped: string[] = []
    if (run) {
      dropped = run((tx) => {
        let out: string[] = []
        tx.patch(b.id, (x) => {
          out = refreshSpec(x, spec, this.deps.kb).dropped
        })
        return out
      })
    } else {
      dropped = refreshSpec(b, spec, this.deps.kb).dropped
    }
    if (dropped.length > 0) this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
    // 刷新＝成员与顺序都换了：上一轮的上下文展开没有依据，从头来
    this.expanded = new Set()
    this.covers = new Map()
    this.staleIds.clear()
    this.deps.onChange()
    this.render()
  }

  /** 抬头上的「结果可能已过期」：只是提示，不改列表（D4） */
  private paintStale(): void {
    if (!this.els.stale) return
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
    const frozen = readResult(this.deps.block()) ?? []
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
  render(focusHint?: string): void {
    this.paintStale()
    const b = this.deps.block()
    const frozen = readResult(b)
    if (!frozen) {
      this.renderEmpty(t('ui.query.noSpec'))
      return
    }
    const rows = resolveFrozen(frozen, (id) => this.deps.kb.pathOf(id))
    this.els.root.hidden = false
    const name = displayNameOf(b).trim()
    this.els.title.textContent = name === '' ? t('ui.query.untitled') : name
    this.els.count.textContent = t('ui.query.count', { count: rows.length })
    if (rows.length === 0) {
      // 空结果里没有可展开的东西：收起栈也一起清掉
      this.expanded = new Set()
      this.covers = new Map()
      // 空结果是**状态**不是错误：保留抬头（含刷新按钮），正文给一句实话。
      // ⚠️ 「条件里有 `$self` 但没有宿主」是**另一种空**：不解释一句，用户会以为条件写错了。
      //    这里的空态文案就是那条解释的落点（单独打开一个相对查询时看到它）。
      const spec = readSpec(b)
      const why = spec && usesSelf(spec.where) ? t('ui.mount.needsHost') : t('ui.query.empty')
      this.els.editor.replaceChildren()
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.editor.loadPage({ roots: [], folded: this.editor.doc.folded })
      this.els.editor.dataset.empty = '1'
      this.els.editor.dataset.emptyText = why
      return
    }
    delete this.els.editor.dataset.empty
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
    const folded = unfoldForContext(this.editor.doc.folded, plan.covers, (id) => this.deps.kb.pathOf(id))
    this.editor.loadPage({ roots: plan.roots, folded, contexts: plan.contexts, expandedRoots: plan.contextRoots })
    if (plan.focusId) this.editor.reveal(plan.focusId)
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
    this.els.editor.replaceChildren()
    this.els.editor.dataset.empty = '1'
    this.els.editor.dataset.emptyText = text
    this.els.title.textContent = text
    this.els.count.textContent = ''
  }
}
