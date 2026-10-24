/**
 * 侧槽装配：槽内容依赖、重画与钉住清单。
 *
 * 槽实例（mountDockSlot）与钉住区组件（DockBlocks）在装配入口的启动段才创建：
 * 这里只经 deps 现取，不持有它们。
 */
import { findInForest } from '../../core/index.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Workspace, Prefs } from '../../core/workspace.ts'
import type { DockBlocks } from '../../ui/dock-blocks.ts'
import type { DockSlotEls } from '../../ui/dock.ts'
import { renderBackrefsInto, renderTodayInto, type DockContentDeps } from '../../ui/dock-content.ts'

export type DocksDeps = {
  kb: MemoryKb
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  prefs: () => Prefs
  getRegistry: () => Registry
  applyChrome: () => void
  scheduleDeviceSave: () => void
  scheduleBadge: () => void
  /** 两个侧槽在启动段才挂载；重画时现取 */
  getSlots: () => { left: DockSlotEls; right: DockSlotEls }
}

export function setupDocks(deps: DocksDeps) {
  const { kb } = deps

  /**
   * 槽内容依赖：**清单形式**列出装配层交给 UI 的能力，UI 不认识 `ws`／`registry`。
   * 全是读函数（库会被 `loadState` 整体替换，传值会拿到过期快照）。
   */
  const dockDeps: DockContentDeps = {
    kb,
    activeId: () => deps.getWs().activeId,
    // 共享索引由 store 缓存（懒重建）⇒ 反链不再每次扫全库 atoms ＋ 遍历森林
    openPage: (id) => void deps.getRegistry().invoke('core.page/open', { pageId: id }, 'menu'),
    newPage: () => void deps.getRegistry().invoke('core.page/new', {}, 'dock'),
  }

  /** 重画两个侧槽（页列表变了、切换了当前页、或反链变了） */
  function renderDocks(): void {
    const { left: dockLeft, right: dockRight } = deps.getSlots()
    // 先让钉住区处理「清单变了没有」：它只在增删时动 DOM，重画其余卡片不会碰它
    dockPins?.left.render()
    dockPins?.right.render()
    renderTodayInto(dockDeps, dockLeft, dockPins ? { persistent: [dockPins.left.card] } : {})
    renderBackrefsInto(dockDeps, dockRight, dockPins ? { persistent: [dockPins.right.card] } : {})
  }

  /** 钉住区的实例（在槽挂载之后创建；`renderDocks` 早于它就跳过） */
  let dockPins: { left: DockBlocks; right: DockBlocks } | null = null

  /**
   * 钉住的清单是**视图状态**：它只记「要看哪几个块 id」，块本身仍在森林里那一份。
   * 所以撤销/删除块都不需要动这份清单 —— 渲染时按 id 找不到就不画，块回来时它自己回来。
   */
  function addPin(side: 'left' | 'right', blockId: string): void {
    if (!findInForest(deps.getWs().blocks, blockId)) return
    const slot = deps.prefs().dock[side]
    if (!slot.pins.includes(blockId)) slot.pins.push(blockId)
    if (!slot.open) {
      slot.open = true
      deps.applyChrome()
    }
    renderDocks()
    // 钉住的清单是**设备状态**（`qua.device`），不是库的内容
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  function unpinBlock(side: 'left' | 'right', blockId: string): void {
    const slot = deps.prefs().dock[side]
    const i = slot.pins.indexOf(blockId)
    if (i < 0) return
    slot.pins.splice(i, 1)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 同一个入口进 / 出（Shift+点块标走它：已钉住则取消） */
  function togglePin(side: 'left' | 'right', blockId: string): void {
    if (deps.prefs().dock[side].pins.includes(blockId)) unpinBlock(side, blockId)
    else addPin(side, blockId)
  }

  return {
    renderDocks,
    addPin,
    unpinBlock,
    togglePin,
    /** 钉住区组件由装配入口在槽挂载之后创建，再交回给这一节 */
    setPins: (pins: { left: DockBlocks; right: DockBlocks }) => {
      dockPins = pins
    },
  }
}
