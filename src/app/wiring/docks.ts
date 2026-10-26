/**
 * 侧槽装配：**槽＝一列卡片**（窗口 ＋ 派生卡），以及它们的三件视图状态。
 *
 * 这一层只做「按 `cards` 顺序取卡、把状态接到卡上、把用户的动作落成 prefs」：
 *   · 卡片内容由 `DockWindows`（窗口）与 `dock-content`（今日/反链）提供；
 *   · 卡壳、收起、单卡、拖拽由 `ui/dock` 提供；
 *   · 这里不认识块的内容，也不碰 DOM 的具体长相。
 *
 * 三个状态轴**正交**（不要互相推导）：
 *   位置 `cards` ／ 收起 `collapsedCards` ／ 单卡 `solo[side]`。
 */
import {
  belongsToTree,
  blockLabel,
  buildAdjacency,
  findInForest,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Workspace, Prefs } from '../../core/workspace.ts'
import type { DockWindows } from '../../ui/dock-windows.ts'
import {
  buildDockCard,
  decorateDockCard,
  renderDockStack,
  type DockCard,
  type DockCardEntry,
  type DockCardState,
  type DockSlotEls,
} from '../../ui/dock.ts'
import { backrefsCard, todayCard, type DockContentDeps } from '../../ui/dock-content.ts'
import { BelongsTree } from '../../ui/belongs-tree.ts'
import { bindDropTarget, isBlockId, setDragCard } from '../../view/dnd.ts'
import { bindWindowDrop } from '../../ui/dock-windows.ts'

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
   * 这里只在重画时取它、给它补卡壳（收起/单卡/拖拽）。
   */
  inspectCard: () => HTMLElement
}

/** 卡片落点：插到哪一张之前/之后；`null` ＝ 末尾 */
type CardDrop = { targetId: string | null; place: 'before' | 'after' | 'end' }

export function setupDocks(deps: DocksDeps) {
  const { kb } = deps
  /** 窗口管理器在槽挂载之后创建；重画早于它就跳过窗口、只画派生卡 */
  let windows: { left: DockWindows; right: DockWindows } | null = null

  /**
   * 槽内容依赖：**清单形式**列出装配层交给 UI 的能力，UI 不认识 `ws`／`registry`。
   * 全是读函数（库会被 `loadState` 整体替换，传值会拿到过期快照）。
   */
  const dockDeps: DockContentDeps = {
    kb,
    activeId: () => deps.getWs().activeId,
    // 共享索引由 store 缓存（懒重建）⇒ 反链不再每次扫全库 atoms ＋ 遍历森林
    openPage: (id) => void deps.getRegistry().invoke('core.page/open', { pageId: id }, 'menu'),
    openInDock: (id) => openWindow('right', id),
  }

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
    openInDock: (id) => openWindow('right', id),
    untitled: t('ui.page.untitled'),
    refresh: () => renderDocks(),
    link: (childId, parentId) => {
      void deps.getRegistry().invoke('core.belongs-to/add', { childId, parentId }, 'dock')
    },
  })

  /* ------------------------------------------------------------ 状态 */

  function cardStateFor(side: 'left' | 'right', id: string): DockCardState {
    const dock = deps.prefs().dock
    return {
      collapsed: dock.collapsedCards[id] === true,
      solo: dock.solo[side] === id,
      onToggleCollapse: () => toggleCollapse(id),
      onToggleSolo: () => toggleSolo(side, id),
      onDragStart: (e) => setDragCard(e.dataTransfer, id),
    }
  }

  function toggleCollapse(id: string): void {
    const dock = deps.prefs().dock
    if (dock.collapsedCards[id]) delete dock.collapsedCards[id]
    else dock.collapsedCards[id] = true
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  function toggleSolo(side: 'left' | 'right', id: string): void {
    const dock = deps.prefs().dock
    dock.solo[side] = dock.solo[side] === id ? null : id
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /* ------------------------------------------------------------ 窗口 */

  /**
   * 在右槽打开一个块：**确保打开并定位**，不是 toggle。
   *
   * 同一个块全局最多一个窗口：已在另一侧 ⇒ 移过来（状态按 id 跟着走）；
   * 已在本侧 ⇒ 不改顺序，只滚到它。
   * 打开会把这一侧的单卡退出——单卡是「只看一张」，加一张与它矛盾。
   */
  function openWindow(side: 'left' | 'right', blockId: string): void {
    if (!findInForest(deps.getWs().blocks, blockId)) return
    const dock = deps.prefs().dock
    const other = side === 'left' ? 'right' : 'left'
    const oi = dock[other].cards.indexOf(blockId)
    if (oi >= 0) {
      dock[other].cards.splice(oi, 1)
      if (dock.solo[other] === blockId) dock.solo[other] = null
    }
    if (!dock[side].cards.includes(blockId)) {
      const at = lastWindowIndex(dock[side].cards)
      dock[side].cards.splice(at + 1, 0, blockId)
    }
    if (!dock[side].open) {
      dock[side].open = true
      deps.applyChrome()
    }
    if (dock.solo[side] !== null && dock.solo[side] !== blockId) dock.solo[side] = null
    renderDocks()
    reveal(side, blockId)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  function closeWindow(side: 'left' | 'right', blockId: string): void {
    const dock = deps.prefs().dock
    const i = dock[side].cards.indexOf(blockId)
    if (i < 0) return
    dock[side].cards.splice(i, 1)
    if (dock.solo[side] === blockId) dock.solo[side] = null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 最后一个块窗口的下标；没有窗口 ⇒ -1（新窗口插到槽顶） */
  function lastWindowIndex(cards: readonly string[]): number {
    for (let i = cards.length - 1; i >= 0; i--) if (isBlockId(cards[i]!)) return i
    return -1
  }

  /** 滚到新窗口并短暂描边：Shift+点/拖进来之后必须「看得见」 */
  function reveal(side: 'left' | 'right', blockId: string): void {
    const stack = deps.getSlots()[side].stack
    const el = stack.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(blockId)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    el.dataset.flash = '1'
    window.setTimeout(() => delete el.dataset.flash, 600)
  }

  /* ------------------------------------------------------------ 重画 */

  function renderDocks(): void {
    ensureCardDrops()
    const { left, right } = deps.getSlots()
    renderSlot('left', left)
    renderSlot('right', right)
  }

  function renderSlot(side: 'left' | 'right', slot: DockSlotEls): void {
    const cards = deps.prefs().dock[side].cards
    // 窗口先按清单同步（建/拆编辑器）；缺块的 id 不进 entries，但留在 cards 里（撤销回来时复位）
    const winCards = windows ? windows[side].sync(cards.filter((id) => isBlockId(id))) : new Map<string, HTMLElement>()
    const entries: DockCardEntry[] = []
    for (const id of cards) {
      if (isBlockId(id)) {
        const el = winCards.get(id)
        if (el) entries.push({ id, el })
        continue
      }
      const card = derivedCard(side, id)
      if (card) entries.push(card)
    }
    renderDockStack(slot.stack, entries, t('ui.dock.empty'), deps.prefs().dock.solo[side])
  }

  function derivedCard(side: 'left' | 'right', id: string): DockCardEntry | null {
    if (id === 'inspect') {
      const el = deps.inspectCard()
      decorateDockCard(el, { id, title: '', body: el }, cardStateFor(side, id))
      return { id, el }
    }
    const spec: DockCard | null =
      id === 'belongs'
        ? belongsTree.card()
        : id === 'journal'
          ? todayCard(dockDeps)
          : id === 'backrefs'
            ? backrefsCard(dockDeps)
            : null
    if (!spec) return null
    return { id: spec.id, el: buildDockCard(spec, cardStateFor(side, spec.id)) }
  }

  /* ------------------------------------------------------------ 卡片拖拽 */

  let dropsBound = false
  function ensureCardDrops(): void {
    if (dropsBound) return
    const { left, right } = deps.getSlots()
    if (!left?.stack || !right?.stack) return
    dropsBound = true
    bindWindowDrop(left.root, (id) => deps.kb.get(id) !== undefined, (id) => openWindow('left', id))
    bindWindowDrop(right.root, (id) => deps.kb.get(id) !== undefined, (id) => openWindow('right', id))
    bindCardStack(left.stack, 'left')
    bindCardStack(right.stack, 'right')
  }

  function bindCardStack(stack: HTMLElement, side: 'left' | 'right'): void {
    bindDropTarget(stack, {
      kind: 'card',
      effect: 'move',
      targetId: () => null,
      accept: (id) => findSide(id) !== null,
      hint: () => t('ui.dnd.moveCard'),
      mark: (id, e) => {
        clearCardDropMarks()
        const at = cardDrop(e, stack)
        if (at.targetId && at.targetId !== id) {
          const el = stack.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(at.targetId)}"]`)
          if (el) el.dataset[at.place === 'before' ? 'dropBefore' : 'dropAfter'] = '1'
        } else if (!at.targetId) stack.dataset.dropEnd = '1'
      },
      unmark: clearCardDropMarks,
      onDrop: (id, _target, e) => {
        const from = findSide(id)
        if (!from) return
        moveCard(from, side, id, cardDrop(e, stack))
      },
    })
  }

  function clearCardDropMarks(): void {
    for (const side of ['left', 'right'] as const) {
      const stack = deps.getSlots()[side].stack
      delete stack.dataset.dropEnd
      for (const el of Array.from(stack.querySelectorAll<HTMLElement>(':scope > .dock-card'))) {
        delete el.dataset.dropBefore
        delete el.dataset.dropAfter
      }
    }
  }

  /** 指针落在哪张卡的上半/下半；落在所有卡之下 ⇒ 末尾 */
  function cardDrop(e: DragEvent, stack: HTMLElement): CardDrop {
    const cards = Array.from(stack.querySelectorAll<HTMLElement>(':scope > .dock-card')).filter((el) => !el.hidden)
    for (const el of cards) {
      const r = el.getBoundingClientRect()
      if (e.clientY < r.top + r.height / 2) {
        return { targetId: el.dataset.cardId ?? null, place: 'before' }
      }
    }
    return { targetId: null, place: 'end' }
  }

  function findSide(id: string): 'left' | 'right' | null {
    const dock = deps.prefs().dock
    if (dock.left.cards.includes(id)) return 'left'
    if (dock.right.cards.includes(id)) return 'right'
    return null
  }

  /**
   * 移动一张卡（槽内排序或跨槽）。
   *
   * 先摘再找落点：同一槽里往后拖时，目标下标会因为自己先被摘掉而左移一格。
   */
  function moveCard(from: 'left' | 'right', to: 'left' | 'right', id: string, at: CardDrop): void {
    if (at.targetId === id) return
    const dock = deps.prefs().dock
    const src = dock[from].cards
    const dst = dock[to].cards
    const i = src.indexOf(id)
    if (i < 0) return
    if (from !== to && dst.includes(id)) return
    src.splice(i, 1)

    let index = dst.length
    if (at.targetId) {
      const ti = dst.indexOf(at.targetId)
      if (ti >= 0) index = at.place === 'before' ? ti : ti + 1
    }
    dst.splice(index, 0, id)

    if (dock.solo[from] === id) dock.solo[from] = null
    if (dock.solo[to] !== null && dock.solo[to] !== id) dock.solo[to] = null
    if (!dock[to].open) {
      dock[to].open = true
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 卡头标题：窗口显示块的**路径**（父 > 父），不重复正文 */
  function windowLabel(id: string): string {
    const path = kb.pathOf(id)
    if (path.length === 0) return ''
    return path.map(blockLabel).join(' / ')
  }

  return {
    renderDocks,
    openWindow,
    closeWindow,
    /** 卡片状态/标题给窗口管理器用（窗口卡由它自己建） */
    cardStateFor,
    windowLabel,
    /** 窗口管理器由装配入口在槽挂载之后创建，再交回给这一节 */
    setWindows: (next: { left: DockWindows; right: DockWindows }) => {
      windows = next
    },
  }
}
