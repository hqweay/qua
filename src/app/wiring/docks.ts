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
  isWidgetBlock,
  widgetSlotHeightOf,
} from '../../core/index.ts'
import { t } from '../../core/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Workspace, Prefs } from '../../core/workspace.ts'
import type { DockWindows } from '../../ui/dock-windows.ts'
import {
  buildDockCard,
  buildDockTile,
  decorateDockCard,
  renderDockStack,
  type DockCard,
  type DockCardEntry,
  type DockCardState,
  type DockSlotEls,
  type DockTile,
} from '../../ui/dock.ts'
import { backrefsCard, todayCard, trashCard, type DockContentDeps } from '../../ui/dock-content.ts'
import { calendarCard } from '../../ui/calendar-card.ts'
import { widgetBody, widgetTitle, type WidgetDeps } from '../../ui/dock-widgets.ts'
import { BelongsTree } from '../../ui/belongs-tree.ts'
import { applyWidgetHeights } from '../../view/block-dom.ts'
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
  /** 集合卡的块选择器（锚在「选择块」按钮上） */
  pickBlock: (collectionId: string, anchor: DOMRect) => void
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
    /**
     * 回收站的「恢复」走命令面：撤销、落盘、索引失效三条路径只有一处入口。
     * 写完补一次重画——回收站卡不是编辑器，没有自己的 change 事件。
     */
    restoreBlock: (id) => {
      void deps.getRegistry().invoke('core.block/restore', { blockId: id }, 'dock')
      renderDocks()
    },
  }

  /**
   * 组件卡的宿主能力：读门面、打开、以及「加/摘引用」两条写路径。
   * 写走命令面；写完在这里补一次重画（集合卡不是编辑器，没有自己的 change 事件）。
   */
  const widgetDeps: WidgetDeps = {
    kb,
    activeId: () => deps.getWs().activeId,
    open: (id) => dockDeps.openPage(id),
    openInDock: (id) => openWindow('right', id),
    addItem: (collectionId, blockId) => {
      void deps.getRegistry().invoke('core.collection/add', { collectionId, blockId }, 'dock')
      renderDocks()
    },
    removeItem: (collectionId, blockId) => {
      void deps.getRegistry().invoke('core.collection/remove', { collectionId, blockId }, 'dock')
      renderDocks()
    },
    moveItem: (collectionId, blockId, to) => {
      void deps.getRegistry().invoke('core.collection/move', { collectionId, blockId, to }, 'dock')
      renderDocks()
    },
    pickBlock: (collectionId, anchor) => deps.pickBlock(collectionId, anchor),
    untitledLabel: t('ui.page.untitled'),
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
    /**
     * 窗口管理器只收**内容块**：组件块（类型声明了 widget）由下面的 renderer 画，
     * 不能再建一个 `BlockEditor` —— 那会得到一张「窗口卡」和一张「组件卡」抢同一个 id。
     */
    const contentIds = cards.filter((id) => {
      if (!isBlockId(id)) return false
      return !isWidgetBlock(deps.kb.get(id))
    })
    const winCards = windows ? windows[side].sync(contentIds) : new Map<string, HTMLElement>()
    const entries: DockCardEntry[] = []
    for (const id of cards) {
      // ⚠️ 先认 `cmd:` 再认块 id：`isBlockId` 的类型守卫把 else 分支收成 `never`，
      //    反过来写会让 `id.startsWith` 在类型层报错（运行时其实没事）。
      if (id.startsWith('cmd:')) {
        entries.push({ id, el: actionTile(side, id), size: 'small' })
        continue
      }
      if (isBlockId(id)) {
        const block = deps.kb.get(id)
        if (block && isWidgetBlock(block)) {
          const body = widgetBody(block, widgetDeps)
          const el = buildDockCard(
            {
              id,
              title: widgetTitle(block),
              body,
              draggable: true,
              close: { title: t('ui.dock.closeWidget'), onClick: () => closeWindow(side, id) },
            },
            cardStateFor(side, id),
          )
          el.dataset.widget = '1'
          /**
           * **卡的两个高度**：静止（`rest`）与被聚焦（`focus`）。
           *
           * 与正文里的组件体读同一份声明、同一个数值表（`applyWidgetHeights`）：
           * 「同一张卡在槽里和正文里长得不一样高」会让人以为是两份配置。
           * 切档同样是纯 CSS（`:focus-within`）——卡里一有焦点就长开，焦点离开就收回。
           * ⚠️ 高度挂在**卡根**上（自定义属性向下继承，`.dock-card-body` 自己读）：
           *    挂在内容元素上，卡壳那一层读不到。
           */
          applyWidgetHeights(el, widgetSlotHeightOf(block))
          entries.push({ id, el, size: 'large' })
          continue
        }
        const el = winCards.get(id)
        if (el) entries.push({ id, el, size: 'large' })
        continue
      }
      const card = derivedCard(side, id)
      if (card) entries.push({ ...card, size: 'large' })
    }
    renderDockStack(slot.stack, entries, t('ui.dock.empty'), deps.prefs().dock.solo[side])
  }

  /**
   * 小卡：`cmd:<命令名>` → 44px 动作格。
   *
   * 命令不可用（产品构建裁掉、插件卸载）时**保留位置**，画成占位格：
   * 从 cards 里删掉会让整排 reflow，用户会以为自己的布局丢了。
   */
  function actionTile(side: 'left' | 'right', id: string): HTMLElement {
    const name = id.slice('cmd:'.length)
    const decl = deps.getRegistry().decl(name)
    const ok = Boolean(decl?.tile) && decl?.hidden !== true
    const tile: DockTile = {
      id,
      title: ok ? decl!.title : t('ui.dock.tileMissing'),
      icon: ok ? decl!.tile!.icon : 'lucide:circle-help',
      missing: !ok,
      close: { title: t('ui.dock.removeTile'), onClick: () => removeTile(side, id) },
      onClick: () => {
        if (ok) void deps.getRegistry().invoke(name, {}, 'tile')
      },
      onDragStart: (e) => setDragCard(e.dataTransfer, id),
    }
    return buildDockTile(tile)
  }

  /** 添加快捷：只接受带 `tile` 元数据的命令；插在已有小卡之后，小卡聚成一排 */
  function addTile(side: 'left' | 'right', command: string): void {
    const decl = deps.getRegistry().decl(command)
    if (!decl?.tile || decl.hidden) return
    const dock = deps.prefs().dock
    const id = `cmd:${command}`
    if (dock[side].cards.includes(id)) return
    const lastTile = dock[side].cards.reduce((at, card, i) => (card.startsWith('cmd:') ? i : at), -1)
    dock[side].cards.splice(lastTile + 1, 0, id)
    if (!dock[side].open) {
      dock[side].open = true
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 移出小卡：只动 cards，不碰命令本身 */
  function removeTile(side: 'left' | 'right', id: string): void {
    const dock = deps.prefs().dock
    const at = dock[side].cards.indexOf(id)
    if (at < 0) return
    dock[side].cards.splice(at, 1)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
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
            : id === 'trash'
              ? trashCard(dockDeps)
              : id === 'calendar'
                ? calendarCard({ kb, openDate: (date) => void deps.getRegistry().invoke('core.journal/today', { date }, 'dock') })
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
      for (const el of Array.from(stack.querySelectorAll<HTMLElement>(':scope > .dock-card, :scope > .dock-tile'))) {
        delete el.dataset.dropBefore
        delete el.dataset.dropAfter
      }
    }
  }

  /**
   * 指针落在哪个 Widget 的哪一侧。
   *
   * 流里小卡横排、大卡整行，不能用单纯的 Y 中点：取**离指针最近的 Widget**，
   * 同一行看 X、跨行看 Y。这样小卡可以左右换位，大卡可以上下换位。
   */
  function cardDrop(e: DragEvent, stack: HTMLElement): CardDrop {
    const items = Array.from(
      stack.querySelectorAll<HTMLElement>(':scope > .dock-card, :scope > .dock-tile'),
    ).filter((el) => !el.hidden)
    if (items.length === 0) return { targetId: null, place: 'end' }

    let best: { el: HTMLElement; d: number } | null = null
    for (const el of items) {
      const r = el.getBoundingClientRect()
      const dx = e.clientX - (r.left + r.width / 2)
      const dy = e.clientY - (r.top + r.height / 2)
      const d = dx * dx + dy * dy
      if (!best || d < best.d) best = { el, d }
    }
    const r = best!.el.getBoundingClientRect()
    const sameRow = e.clientY >= r.top && e.clientY <= r.bottom
    const before = sameRow ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2
    return { targetId: best!.el.dataset.cardId ?? null, place: before ? 'before' : 'after' }
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

  /**
   * 把一张**派生卡**加回槽（`calendar`／`belongs`／`backrefs`／`trash`／`journal`）。
   *
   * 为什么它必须存在：派生卡没有「关闭」按钮（关掉就没有再加回来的入口，
   * 那是一个单向陷阱）——它们的入口只在「添加组件」画廊里。
   * ⚠️ 与 `addTile` 分开：小卡是 `cmd:<命令>`，派生卡是固定 id，两者落进 `cards`
   *    的形状不同，混成一个会让「加回来的是哪一种」取决于字符串前缀。
   */
  function addDerived(side: 'left' | 'right', id: string): void {
    const dock = deps.prefs().dock
    if (dock[side].cards.includes(id)) return
    dock[side].cards.push(id)
    if (!dock[side].open) {
      dock[side].open = true
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  return {
    renderDocks,
    openWindow,
    closeWindow,
    addTile,
    addDerived,
    /** 卡片状态/标题给窗口管理器用（窗口卡由它自己建） */
    cardStateFor,
    windowLabel,
    /**
     * 正文里的组件体要的宿主能力（与槽里的卡**同一份** `widgetDeps`）。
     *
     * 为什么不另建一份：正文里的组件与槽里的卡是**同一个组件的两个露面**，
     * 「加一条引用」这类动作写的是同一格 `_items`。两份 deps 会长出两套「写完重画谁」，
     * 于是「在正文里加一条，槽里的卡没跟上」。
     */
    widgetDeps: (): WidgetDeps => widgetDeps,
    /** 窗口管理器由装配入口在槽挂载之后创建，再交回给这一节 */
    setWindows: (next: { left: DockWindows; right: DockWindows }) => {
      windows = next
    },
  }
}
