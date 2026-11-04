/**
 * 中心表面宿主：派生/工具面的 tab 身体住这里，与 `#scroll`（编辑器）二选一可见。
 *
 * 分工：**哪一个 tab 在前**归 tab 状态层（`wiring/pages`），它经由 `show`/`hide`
 * 说话；这里只管「把当前这张面的身体画出来」，不认识 tab、不认识导航历史
 * （表面是**终点面**：没有「上次看到哪」，关闭即回）。
 *
 * 身体的产地与侧槽**同一份**：派生卡的渲染分支在这里与 `wiring/docks` 各有一个
 * case，但身体构造函数共用（回收站 = `ui/dock-content` 的 `trashCard`）——
 * 两处各造一份渲染器就会出现两种回收站。
 */
import { type SurfaceRef } from '../../core/index.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import { trashCard, type DockContentDeps } from '../../ui/dock/dock-content.ts'
import type { Chrome } from '../../ui/chrome/chrome.ts'

export interface SurfaceDeps {
  kb: MemoryKb
  getRegistry: () => Registry
  /** 恢复之后槽里的回收站卡要跟上（同一份数据的两个尺寸） */
  renderDocks: () => void
  getChrome: () => Chrome
}

export function setupSurface(deps: SurfaceDeps) {
  let current: SurfaceRef | null = null

  /** 库变了 ⇒ 当前这张面重画（身体是纯派生 DOM，现造最便宜） */
  function refreshIfShown(): void {
    if (current !== null) render()
  }

  const dockDeps: DockContentDeps = {
    kb: deps.kb,
    restoreBlock: (id) => {
      void deps.getRegistry().invoke('core.block/restore', { blockId: id }, 'dock')
      deps.renderDocks()
      refreshIfShown()
    },
  }

  /** 一张面的身体。派生卡的分支与槽渲染共用构造函数；中心接不住的卡在这里落 null ⇒ 回编辑器，不摆空面。 */
  function buildBody(ref: SurfaceRef): HTMLElement | null {
    if (ref.kind === 'derived') {
      switch (ref.card) {
        case 'trash':
          return trashCard(dockDeps).body
      }
    }
    // 工具面的身体随它的目录行一起落地（目录为空 ⇒ 这里到不了）
    return null
  }

  function render(): void {
    const chrome = deps.getChrome()
    const el = chrome.centerSurfaceEl
    if (!current) {
      el.hidden = true
      el.replaceChildren()
      chrome.scrollEl.hidden = false
      return
    }
    const body = buildBody(current)
    if (!body) {
      // 守卫挡住了不认识的面 ⇒ 回到编辑器（不摆一张空面）
      current = null
      render()
      return
    }
    el.replaceChildren(body)
    el.hidden = false
    chrome.scrollEl.hidden = true
  }

  return {
    /** tab 状态层说「现在前面是这张面」（null ＝ 回到块编辑器） */
    show(ref: SurfaceRef | null): void {
      current = ref
      render()
    },
    /** 库变了 ⇒ 当前这张面重画（身体是纯派生 DOM，现造最便宜） */
    refreshIfShown(): void {
      if (current !== null) render()
    },
    /** 现在前面是不是一张面（tab 状态层与诊断用） */
    showing(): SurfaceRef | null {
      return current
    },
  }
}
