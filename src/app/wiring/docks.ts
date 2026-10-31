/**
 * 侧槽装配：**槽＝一列卡片**（窗口 ＋ 派生卡），以及它们的三件视图状态。
 *
 * 这一层只做「按 `cards` 顺序取卡、把状态接到卡上、把用户的动作落成 prefs」：
 *   · 卡片内容由 `DockWindows`（窗口）、`widgetBody`（组件）与 `dock-content`
 *     （归属树／日历／反链／回收站／检视卡）提供；
 *   · 卡壳、收起、单卡、关闭、拖拽由 `ui/dock` 提供；
 *   · 这里不认识块的内容，也不碰 DOM 的具体长相。
 *
 * 三个状态轴**正交**（不要互相推导）：
 *   位置 `cards` ／ 收起 `collapsedCards` ／ 单卡 `solo[side]`。
 */
import {
  belongsToTree,
  blockLabel,
  buildAdjacency,
  dockKey,
  findInForest,
  isWidgetBlock,
  widgetSlotHeightOf,
  type DerivedCardId,
  type DockEntry,
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
import { backrefsCard, trashCard, type DockContentDeps } from '../../ui/dock-content.ts'
import { calendarCard } from '../../ui/calendar-card.ts'
import { widgetBody, widgetTitle, type WidgetDeps } from '../../ui/dock-widgets.ts'
import { BelongsTree } from '../../ui/belongs-tree.ts'
import { applyWidgetHeights } from '../../view/block-dom.ts'
import { bindDropTarget, setDragCard } from '../../view/dnd.ts'
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
    const entry: DockEntry = { kind: 'block', block: blockId }
    const key = dockKey(entry)
    const oi = dock[other].cards.findIndex((e) => dockKey(e) === key)
    if (oi >= 0) {
      dock[other].cards.splice(oi, 1)
      if (dock.solo[other] === key) dock.solo[other] = null
    }
    if (!dock[side].cards.some((e) => dockKey(e) === key)) {
      const at = lastWindowIndex(dock[side].cards)
      dock[side].cards.splice(at + 1, 0, entry)
    }
    if (!dock[side].open) {
      dock[side].open = true
      deps.applyChrome()
    }
    if (dock.solo[side] !== null && dock.solo[side] !== key) dock.solo[side] = null
    renderDocks()
    reveal(side, blockId)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 关掉**一张卡**：窗口卡、组件卡、派生卡同一条路——只从 `cards` 里摘掉这一次露面。
   *
   * 三者的差别只在内容从哪来（块 / 组件 / 宿主现算），「关掉」的语义是同一个：
   * 这块数据还在库里，只是这一槽不再显示它。所以不叫 `closeWindow`。
   */
  function closeCard(side: 'left' | 'right', key: string): void {
    const dock = deps.prefs().dock
    const i = dock[side].cards.findIndex((e) => dockKey(e) === key)
    if (i < 0) return
    dock[side].cards.splice(i, 1)
    if (dock.solo[side] === key) dock.solo[side] = null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 最后一个块窗口的下标；没有窗口 ⇒ -1（新窗口插到槽顶） */
  function lastWindowIndex(cards: readonly DockEntry[]): number {
    for (let i = cards.length - 1; i >= 0; i--) if (cards[i]!.kind === 'block') return i
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
    ensureTileCols()
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
    const contentIds = cards.flatMap((e) =>
      e.kind === 'block' && !isWidgetBlock(deps.kb.get(e.block)) ? [e.block] : [],
    )
    const winCards = windows ? windows[side].sync(contentIds) : new Map<string, HTMLElement>()
    const entries: DockCardEntry[] = []
    for (const card of cards) {
      // 种类由 `kind` 说，不由字符串形状猜：改 id 生成方案也不会让某种卡整片消失
      const key = dockKey(card)
      if (card.kind === 'cmd') {
        entries.push({ id: key, el: actionTile(side, card.command), size: 'small' })
        continue
      }
      if (card.kind === 'derived') {
        entries.push({ ...derivedCard(side, card.card), size: 'large' })
        continue
      }
      const block = deps.kb.get(card.block)
      if (block && isWidgetBlock(block)) {
        const body = widgetBody(block, widgetDeps)
        const el = buildDockCard(
          {
            id: key,
            title: widgetTitle(block),
            body,
            draggable: true,
            close: { title: t('ui.dock.closeWidget'), onClick: () => closeCard(side, key) },
          },
          cardStateFor(side, key),
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
        entries.push({ id: key, el, size: 'large' })
        continue
      }
      const el = winCards.get(card.block)
      if (el) entries.push({ id: key, el, size: 'large' })
    }
    renderDockStack(slot.stack, entries, t('ui.dock.empty'), deps.prefs().dock.solo[side])
    syncTileCols(slot.stack)
  }

  /**
   * 小卡那一行分几列 ＝ **min(这一行放得下几列, 实际有几张小卡)**。
   *
   * 为什么必须由这一层算（CSS 两条路都不对）：
   *   · `repeat(auto-fill, …)` 的列数只看可用宽度 ⇒ 张数少于列数时末尾多出一条空轨，
   *     小卡排到 4/5 处就停、右边留一条缝（槽 270px：5 列 4 张，右缘差 53px）；
   *   · `flex: 1` 均分不知道换行 ⇒ 换行后的末行只剩一张时会被拉成一整条动作带
   *     （槽 180px 时 4 张 → 3＋1，第 4 张变成整宽）。
   *
   * 只有同时知道「张数」与「宽度」才能既铺满、又不在换行时拉伸——这两件事渲染层都有。
   * 换行后的末行**保持与上面一行同样的格宽**，右边自然留白：那是一个「换行了的网格」，
   * 不是「没摆正」。
   */
  function syncTileCols(stack: HTMLElement): void {
    const tiles = stack.querySelectorAll(':scope > .dock-tile').length
    if (tiles === 0) {
      stack.style.removeProperty('--dock-tile-cols')
      return
    }
    const cs = getComputedStyle(stack)
    const inner = stack.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const gap = parseFloat(cs.columnGap) || 0
    const min = parseFloat(cs.getPropertyValue('--ui-tile-min')) || 44
    const capacity = Math.max(1, Math.floor((inner + gap) / (min + gap)))
    const next = String(Math.min(capacity, tiles))
    // 只在真的变了时才写：ResizeObserver 会观察到「行数变化 ⇒ 高度变化」，别自激
    if (stack.style.getPropertyValue('--dock-tile-cols') !== next) stack.style.setProperty('--dock-tile-cols', next)
  }

  /**
   * 槽宽变了（拖手柄／窗口缩放／开合对侧）⇒ 一行能放几列也变了。
   *
   * 观察的是**槽自己的宽度**而不是 window：压缩区间里侧槽锁在下限、拖手柄只改这一列，
   * window 的 resize 监听在这些情况下要么不触发、要么要先自己算一遍谁变了。
   */
  let tileColsBound = false
  function ensureTileCols(): void {
    if (tileColsBound) return
    const { left, right } = deps.getSlots()
    if (!left?.stack || !right?.stack) return
    tileColsBound = true
    const ro = new ResizeObserver(() => {
      syncTileCols(left.stack)
      syncTileCols(right.stack)
    })
    ro.observe(left.stack)
    ro.observe(right.stack)
  }

  /**
   * 小卡：一条命令 → 44px 动作格。
   *
   * 命令不可用（产品构建裁掉、插件卸载）时**保留位置**，画成占位格：
   * 从 cards 里删掉会让整排 reflow，用户会以为自己的布局丢了。
   */
  function actionTile(side: 'left' | 'right', command: string): HTMLElement {
    const id = dockKey({ kind: 'cmd', command })
    const decl = deps.getRegistry().decl(command)
    const ok = Boolean(decl?.tile) && decl?.hidden !== true
    const tile: DockTile = {
      id,
      title: ok ? decl!.title : t('ui.dock.tileMissing'),
      icon: ok ? decl!.tile!.icon : 'lucide:circle-help',
      missing: !ok,
      close: { title: t('ui.dock.removeTile'), onClick: () => removeTile(side, command) },
      onClick: () => {
        if (ok) void deps.getRegistry().invoke(command, {}, 'tile')
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
    const entry: DockEntry = { kind: 'cmd', command }
    const key = dockKey(entry)
    if (dock[side].cards.some((e) => dockKey(e) === key)) return
    const lastTile = dock[side].cards.reduce((at, card, i) => (card.kind === 'cmd' ? i : at), -1)
    dock[side].cards.splice(lastTile + 1, 0, entry)
    if (!dock[side].open) {
      dock[side].open = true
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 移出小卡：只动 cards，不碰命令本身 */
  function removeTile(side: 'left' | 'right', command: string): void {
    const dock = deps.prefs().dock
    const key = dockKey({ kind: 'cmd', command })
    const at = dock[side].cards.findIndex((e) => dockKey(e) === key)
    if (at < 0) return
    dock[side].cards.splice(at, 1)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 派生卡也能关：**关掉只是从 `cards` 里摘掉这一个露面**，模型一个字节都不动。
   *
   * 早先它没有 ✕，理由是「关掉就没有再加回来的入口，是单向陷阱」——那个理由在
   * 「添加组件」画廊能列派生卡（`addDerived`）之后就不成立了。回程既然存在，
   * 就该给去程；否则「我不想看归属树」只能靠拖走或换个槽，而那是另一件事。
   */
  function derivedCard(side: 'left' | 'right', card: DerivedCardId): DockCardEntry {
    const close = { title: t('ui.dock.closeCard'), onClick: () => closeCard(side, card) }
    // 卡的 id／状态键／关闭目标都取 `card` 本身，不从 spec 再读一遍：
    // 三处各读一个字段，一旦某个 spec 的 id 与目录不一致，就是「点 × 关错卡」。
    const finish = (spec: DockCard): DockCardEntry => ({
      id: card,
      el: buildDockCard({ ...spec, id: card, close }, cardStateFor(side, card)),
    })
    // 穷举：`DERIVED_CARDS` 加一张、这里没接 ⇒ 编译期红（早先是三元链，漏了只是「点了没反应」）
    switch (card) {
      case 'inspect': {
        const el = deps.inspectCard()
        decorateDockCard(el, { id: card, title: '', body: el, close }, cardStateFor(side, card))
        return { id: card, el }
      }
      case 'belongs':
        return finish(belongsTree.card())
      case 'backrefs':
        return finish(backrefsCard(dockDeps))
      case 'trash':
        return finish(trashCard(dockDeps))
      case 'calendar':
        return finish(
          calendarCard({
            kb,
            openDate: (date) => void deps.getRegistry().invoke('core.journal/today', { date }, 'dock'),
          }),
        )
    }
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

  function findSide(key: string): 'left' | 'right' | null {
    const dock = deps.prefs().dock
    if (dock.left.cards.some((e) => dockKey(e) === key)) return 'left'
    if (dock.right.cards.some((e) => dockKey(e) === key)) return 'right'
    return null
  }

  /**
   * 移动一张卡（槽内排序或跨槽）。
   *
   * 先摘再找落点：同一槽里往后拖时，目标下标会因为自己先被摘掉而左移一格。
   * 拖拽载荷里是**扁平 key**（`data-card-id`），不是条目本身 ⇒ 按 key 找条目再搬。
   */
  function moveCard(from: 'left' | 'right', to: 'left' | 'right', key: string, at: CardDrop): void {
    if (at.targetId === key) return
    const dock = deps.prefs().dock
    const src = dock[from].cards
    const dst = dock[to].cards
    const i = src.findIndex((e) => dockKey(e) === key)
    if (i < 0) return
    if (from !== to && dst.some((e) => dockKey(e) === key)) return
    const entry = src[i]!
    src.splice(i, 1)

    let index = dst.length
    if (at.targetId) {
      const ti = dst.findIndex((e) => dockKey(e) === at.targetId)
      if (ti >= 0) index = at.place === 'before' ? ti : ti + 1
    }
    dst.splice(index, 0, entry)

    if (dock.solo[from] === key) dock.solo[from] = null
    if (dock.solo[to] !== null && dock.solo[to] !== key) dock.solo[to] = null
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
   * 把一张**派生卡**加回槽（`calendar`／`belongs`／`backrefs`／`trash`／`inspect`）。
   *
   * 为什么它必须存在：派生卡的 ✕ 只是把卡从 `cards` 里摘掉（与窗口卡同一条路），
   * 摘掉之后**加回来只有这一处入口**——「添加组件」画廊。没有它，✕ 就是单向陷阱。
   * ⚠️ 与 `addTile` 分开：两者落进 `cards` 的 `kind` 不同，混成一个会让
   *    「加回来的是哪一种」取决于字符串前缀。
   */
  function addDerived(side: 'left' | 'right', card: DerivedCardId): void {
    const dock = deps.prefs().dock
    const entry: DockEntry = { kind: 'derived', card }
    const key = dockKey(entry)
    if (dock[side].cards.some((e) => dockKey(e) === key)) return
    dock[side].cards.push(entry)
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
    closeCard,
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
