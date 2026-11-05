/**
 * 中心表面宿主：派生/工具面的 tab 身体住这里，与 `#scroll`（编辑器）二选一可见。
 *
 * 分工：**哪一个 tab 在前**归 tab 状态层（`wiring/pages`），它经由 `show`/`hide`
 * 说话；这里只管「把当前这张面的身体画出来」，不认识 tab、不认识导航历史
 * （表面是**终点面**：没有「上次看到哪」，关闭即回）。
 *
 * 身体的产地与侧槽**同一份**：派生卡的渲染分支在这里与 `wiring/docks` 各有一个
 * case，但身体构造函数共用（回收站 = `ui/dock-content` 的 `trashCard`）——
 * 两处各造一份渲染器就会出现两种回收站。工具面（搜索）的身体是**有状态的组件**，
 * 只有当前在前的那一份活着；离开就收掉（终点面没有位置恢复），回到词为空的空态。
 */
import { type SurfaceRef } from '../../core/index.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import { trashCard, type DockContentDeps } from '../../ui/dock/dock-content.ts'
import { SearchFace, type SearchFaceDeps } from '../../ui/search/search-face.ts'
import type { Chrome } from '../../ui/chrome/chrome.ts'

export interface SurfaceDeps {
  kb: MemoryKb
  getRegistry: () => Registry
  /** 恢复之后槽里的回收站卡要跟上（同一份数据的两个尺寸） */
  renderDocks: () => void
  getChrome: () => Chrome
  /** 搜索面的依赖（引擎/打开/晋升/复制——全在装配层，面自己不认识 app） */
  searchDeps: () => SearchFaceDeps
}

export function setupSurface(deps: SurfaceDeps) {
  let current: SurfaceRef | null = null
  /** 搜索面实例：只有当前在前时活着；离开就收掉（终点面不保留位置与词） */
  let searchFace: SearchFace | null = null
  /** 从浮层「展开为面板」带过来的词：**随打开带一次**，不做 live 双写 */
  let pendingTerm: string | null = null

  const dockDeps: DockContentDeps = {
    kb: deps.kb,
    restoreBlock: (id) => {
      void deps.getRegistry().invoke('core.block/restore', { blockId: id }, 'dock')
      deps.renderDocks()
      refreshIfShown()
    },
  }

  /** 搜索面：造一台新的（旧的先收掉）；词随打开带一次，不做 live 双写 */
  function buildSearchFace(): SearchFace {
    searchFace?.dispose()
    const face = new SearchFace(deps.searchDeps())
    searchFace = face
    const term = pendingTerm
    pendingTerm = null
    face.setTerm(term ?? '')
    window.setTimeout(() => {
      // 只在它还是当前那一台时抢焦点（可能已经切走/收掉）
      if (face === searchFace) face.focusInput()
    })
    return face
  }

  /** 一张面的身体。派生卡的分支与槽渲染共用构造函数；中心接不住的卡在这里落 null ⇒ 回编辑器，不摆空面。 */
  function buildBody(ref: SurfaceRef): HTMLElement | null {
    if (ref.kind === 'derived') {
      switch (ref.card) {
        case 'trash':
          return trashCard(dockDeps).body
      }
      return null
    }
    // 工具面是**有状态的组件**：它自己 `mount(host)`（见 `render` 的搜索面分支）
    return null
  }

  function render(): void {
    const chrome = deps.getChrome()
    const el = chrome.centerSurfaceEl
    if (!current) {
      searchFace?.dispose()
      searchFace = null
      el.hidden = true
      el.replaceChildren()
      // 外框的「这一面要不要整面滚」由面自己说（搜索面是主从布局，左右各自滚）
      delete el.dataset.face
      chrome.scrollEl.hidden = false
      return
    }
    /**
     * **搜索面**：有状态的组件，根由它自己 `mount(host)`（不是 render 替它 append 一颗身体）。
     * 布局属性（`data-face` / `hidden`）必须**先**落定再挂编辑器——`BlockEditor` 构造时会量 DOM。
     */
    if (current.kind === 'utility' && current.face === 'search') {
      const face = buildSearchFace()
      el.replaceChildren()
      el.dataset.face = current.face
      el.hidden = false
      chrome.scrollEl.hidden = true
      face.mount(el)
      return
    }
    const body = buildBody(current)
    if (!body) {
      // 守卫挡住了不认识的面 ⇒ 回到编辑器（不摆一张空面）
      current = null
      searchFace?.dispose()
      searchFace = null
      render()
      return
    }
    el.replaceChildren(body)
    if (current.kind === 'utility') el.dataset.face = current.face
    else delete el.dataset.face
    el.hidden = false
    chrome.scrollEl.hidden = true
  }

  /**
   * 库变了 ⇒ 当前这张面重画。派生面身体现造最便宜；**搜索面不重跑**——
   * 它的右列是一台真编辑器，每敲一个字都是一次库变化，重跑会重排列表、打断正在输入的那一行。
   * 搜索面的「刷新」是面上的显式动作（`SearchFace.rerun`），不由库变化触发。
   */
  function refreshIfShown(): void {
    if (current === null) return
    if (current.kind === 'utility' && current.face === 'search') return
    render()
  }

  return {
    /** tab 状态层说「现在前面是这张面」（null ＝ 回到块编辑器） */
    show(ref: SurfaceRef | null): void {
      current = ref
      render()
    },
    /** 浮层「展开为面板」把词带过去：在打开命令之前调，进面那一刻消费掉 */
    setPendingTerm(term: string): void {
      pendingTerm = term
    },
    refreshIfShown,
    /** 现在前面是不是一张面（tab 状态层与诊断用） */
    showing(): SurfaceRef | null {
      return current
    },
  }
}
