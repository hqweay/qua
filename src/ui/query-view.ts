/**
 * **查询视图块**。
 *
 * 它和 `backlinks.ts` 是同一类东西：不是「查询面板组件」，而是一个 **view block**——
 * source = `_query` 条件，view = outline，结果是一列**真实块**（活引用）。
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
import { displayNameOf, resolveFrozen, readResult, refreshSpec, readSpec, type Atom, type Block, type BlockStore } from '../core/index.ts'
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
  /** 点结果块的块标：聚焦/zoom 到它（中心槽换内容）；由装配层注入 */
  onFocusBlock: (blockId: string) => void
  /** 点行内原子：与正文同一条逻辑（左键打开、⌥ 详情、解析不到仍弹详情） */
  onAtomClick?: (atom: Atom, el: HTMLElement, mods: { altKey: boolean }) => void
  /** 提示（刷新失败、丢了几条） */
  toast?: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export interface QueryViewEls {
  root: HTMLElement
  editor: HTMLElement
  title: HTMLElement
  count: HTMLElement
  refresh: HTMLButtonElement
  /** 「结果可能已过期」标记（D6 的兜底，见 待定-日记流 #1） */
  stale?: HTMLElement
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
      doc: { roots: [], folded: {}, trash: deps.store.trash },
    })
    this.editor.events = {
      change: (kind) => {
        if (kind === 'load') return
        // 视图内编辑：内容立即生效（D5），但要落盘；成员不动（D4）
        this.deps.onChange()
      },
      focusBlock: (blockId) => this.deps.onFocusBlock(blockId),
      atomClick: (atom, el, mods) => this.deps.onAtomClick?.(atom, el, mods),
    }

    // ⚠️ 这里**只**点亮 stale，不重排列表（D4 的「不自动重算」）。
    // ⚠️ 拿得到「动过哪些块」就精确判断；拿不到（`ids === undefined`，例如结构操作）就先不点亮——
    //    宁可少提示，也不要因为「刷新顺带的重渲染」误报「结果已过期」（实测过这种假阳性）。
    this.deps.store.subscribe((source, ids) => {
      if (source === this.editor) return
      if (ids && ids.length > 0) this.noteTouched(ids)
    })
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
    const { dropped } = refreshSpec(b, spec, this.deps.kb)
    if (dropped.length > 0) this.deps.toast?.(t('ui.query.dropped', { count: dropped.length }), 'info')
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
  render(): void {
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
      // 空结果是**状态**不是错误：保留抬头（含刷新按钮），正文给一句实话
      this.els.editor.replaceChildren()
      // 空结果也保留本视图的折叠态：它记的是「哪些行收着」，不是「这次有几行」
      this.editor.loadPage({ roots: [], folded: this.editor.doc.folded, trash: this.deps.store.trash }, this.deps.store.marks, this.deps.store.atoms)
      this.els.editor.dataset.empty = '1'
      return
    }
    delete this.els.editor.dataset.empty
    // 只装「最外层命中」：子树由编辑器自己展开（D8：带 breadcrumb 的上下文在行首另行标注）
    this.editor.loadPage(
      { roots: rows.map((r) => r.block), folded: this.editor.doc.folded, trash: this.deps.store.trash },
      this.deps.store.marks,
      this.deps.store.atoms,
    )
  }

  private renderEmpty(text: string): void {
    this.els.root.hidden = false
    this.els.editor.replaceChildren()
    this.els.editor.dataset.empty = '1'
    this.els.title.textContent = text
    this.els.count.textContent = ''
  }
}
