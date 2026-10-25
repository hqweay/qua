/**
 * 侧槽装配：槽内容依赖、重画与钉住清单。
 *
 * 槽实例（mountDockSlot）与钉住区组件（DockBlocks）在装配入口的启动段才创建：
 * 这里只经 deps 现取，不持有它们。
 */
import { belongsToTree, buildAdjacency, findInForest } from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Workspace, Prefs } from '../../core/workspace.ts'
import type { DockBlocks } from '../../ui/dock-blocks.ts'
import type { DockSlotEls } from '../../ui/dock.ts'
import { renderBackrefsInto, renderTodayInto, type DockContentDeps } from '../../ui/dock-content.ts'
import { BelongsTree } from '../../ui/belongs-tree.ts'

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
  /**
   * 检视卡本身（右槽里的常驻节点）。
   *
   * 装配顺序决定的：面板分片晚于这一节，卡片在那边创建并挂进堆叠；
   * 这里只在重画时把它列为 `persistent`，免得 `renderDockStack` 把它当垃圾清掉。
   */
  inspectCard: () => HTMLElement
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

  /**
   * **右槽**：反链面板 ＋ 检视卡。
   *
   * 检视卡是**常驻节点**（`persistent`）：它里面是表单，重画整槽会换掉正在输入的控件。
   * 于是重画顺序是「钉住区 → 检视卡 → 反链卡」，常驻的排在前面（槽是纵向堆叠，
   * 位置稳定是认路的一部分）。
   */
  /**
   * **归属树面板**（左槽）：页 / 标签两面，同一个摊平函数。
   *
   * 面是视图状态、住在组件实例里；每次整槽重画都重新取一行行 —— 根集合随露面变，
   * 缓存一处就会出现「补了露面，位置还是原来那个」。
   */
  const belongsTree = new BelongsTree({
    rows: (face) => belongsToTree(buildAdjacency(deps.getWs().blocks), face),
    activeId: () => deps.getWs().activeId,
    open: (id) => dockDeps.openPage(id),
    untitled: t('ui.page.untitled'),
    refresh: () => renderDocks(),
    link: (childId, parentId) => {
      void deps.getRegistry().invoke('core.belongs-to/add', { childId, parentId }, 'dock')
    },
  })

  function renderDocks(): void {
    const { left: dockLeft, right: dockRight } = deps.getSlots()
    // 先让钉住区处理「清单变了没有」：它只在增删时动 DOM，重画其余卡片不会碰它
    dockPins?.left.render()
    dockPins?.right.render()
    // 归属树排在今日上面：导航在上、时间在下（同一条判据：先认位置，再看今天）
    renderTodayInto(dockDeps, dockLeft, {
      cards: [belongsTree.card()],
      ...(dockPins ? { persistent: [dockPins.left.card] } : {}),
    })
    const persistentRight = dockPins ? [dockPins.right.card, deps.inspectCard()] : [deps.inspectCard()]
    renderBackrefsInto(dockDeps, dockRight, { persistent: persistentRight })
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
