/**
 * 侧槽装配：**槽＝一列卡片**（窗口 ＋ 派生卡），以及它们的三件视图状态。
 *
 * 这一层只做「按 `cards` 顺序取卡、把状态接到卡上、把用户的动作落成 prefs」：
 *   · 卡片内容由 `DockWindows`（窗口）与 `dock-content`
 *     （归属树／日历／反链／回收站／检视卡）提供；
 *   · 卡壳、收起、单卡、关闭、拖拽由 `ui/dock` 提供；
 *   · 这里不认识块的内容，也不碰 DOM 的具体长相。
 *
 * 四个状态轴**正交**（不要互相推导）：
 *   位置 `cards` ／ 收起 `collapsedCards` ／ 常驻 `pinnedCards` ／ 单卡 `solo[side]`。
 */
import {
  belongsToTree,
  blockLabel,
  buildAdjacency,
  dissolveEmptyTrays,
  dockKey,
  findDock,
  findInForest,
  isCardCollapsed,
  isLeafEntry,
  openActionOf,
  pinDefaultFor,
  pruneEphemeralWindows,
  uuidv7Hex,
  type DerivedCardId,
  type DockEntry,
  type OpenAction,
  type UtilityFaceId,
  type WindowEntryAction,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Workspace, Prefs } from '../../core/infra/workspace.ts'
import type { DockWindows } from '../../ui/dock/dock-windows.ts'
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
} from '../../ui/dock/dock.ts'
import { trashCard, trashScope, type DockContentDeps } from '../../ui/dock/dock-content.ts'
import { SearchCard } from '../../ui/cards/search-card.ts'
import { emptyCardList } from '../../ui/chrome/card-parts.ts'
import type { DockMountCard } from '../../ui/cards/mount-card.ts'
import { calendarCard } from '../../ui/cards/calendar-card.ts'
import { BelongsTree } from '../../ui/cards/belongs-tree.ts'
import { renderIcon } from '../../view/icons.ts'
import { bindDropTarget, setDragCard } from '../../view/dnd.ts'
import { bindWindowDrop } from '../../ui/dock/dock-windows.ts'

export type DocksDeps = {
  kb: MemoryKb
  /** 换库会整体替换 `ws`，不能传值 */
  getWs: () => Workspace
  prefs: () => Prefs
  getRegistry: () => Registry
  applyChrome: () => void
  /**
   * 这一侧槽**此刻**看得见吗（档位轴的 overlay 判据，纯判据在 core）。
   * 「确保开着」按它判：档位强制收起的槽在 prefs 里可能仍标着开，只看 prefs 会早退。
   */
  slotOpen: (side: 'left' | 'right') => boolean
  /** 开进了一个档位强制收起的槽 ⇒ 以用户这次为准（这一侧脱离强制收起） */
  noteSlotChanged: (side: 'left' | 'right') => void
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
  /** 右键卡头：卡片菜单（行与动作归装配入口——它有浮层与命令面；这里只给时机与锚） */
  showCardMenu: (side: 'left' | 'right', key: string, anchor: DOMRect, trigger?: HTMLElement) => void
  /** 右键快捷小卡：改目标／在侧槽展开等动作；与卡头菜单同样是装配层的浮层 */
  showShortcutMenu: (
    side: 'left' | 'right',
    blockId: string,
    anchor: DOMRect,
    trigger?: HTMLElement,
  ) => void
  /** 右键命令小卡：收进新收纳盘等动作；与快捷卡菜单同一条浮层路径 */
  showTileMenu: (side: 'left' | 'right', command: string, anchor: DOMRect, trigger?: HTMLElement) => void
  /** 目标块不在了：点它不能静默没反应，得说一句为什么 */
  toast: (msg: string, kind?: 'ok' | 'warn' | 'info') => void
  /**
   * 后果性操作的确认框（`Layers.confirm`）：回收站清空前的最后一道闸。
   * 浮层原语归装配入口（与 `toast` 同一条理由：三套皮肤一个产地）。
   */
  confirm: (o: {
    title: string
    body: string
    confirmLabel: string
    danger: boolean
    onConfirm: () => void
  }) => void
  /**
   * 挂载区卡的**工厂**：由装配入口在依赖就绪后注入。
   *
   * 为什么是工厂而不是现成实例：卡身那台挂载区的编辑器要接 `viewEvents`／活动编辑器／
   * 写事务，那些在装配入口的初始化顺序里晚于本节的构造；按需建（卡第一次出现时）才拿得到。
   */
  createMountCard: (side: 'left' | 'right') => DockMountCard
  /**
   * 搜索卡（**工具面住进槽**）的工厂：与反链卡同一条理由——编辑器要接活动编辑器、
   * 写事务、事件表，那些在装配顺序里晚于本节；按需建才拿得到。
   */
  createSearchCard: (side: 'left' | 'right') => SearchCard
  /**
   * 打开一个块的唯一路由（左槽行、日历日期共用）。
   *
   * 槽不自己判断「右槽／新 tab」：那套策略只有 `App.openBlock` 一份；这里只转交。
   */
  openBlock: (
    id: string,
    place: import('../../core/index.ts').OpenAction,
    opts?: import('../../core/index.ts').OpenOpts,
  ) => void
}

/** 卡片落点：插到哪一张之前/之后；`null` ＝ 末尾 */
type CardDrop = { targetId: string | null; place: 'before' | 'after' | 'end' }

export function setupDocks(deps: DocksDeps) {
  const { kb } = deps
  /** 窗口管理器在槽挂载之后创建；重画早于它就跳过窗口、只画派生卡 */
  let windows: { left: DockWindows; right: DockWindows } | null = null
  /**
   * 挂载区卡**每个槽一份**（同一张卡可以同时出现在两槽）。
   *
   * 懒建：只有 `cards` 里有它时才建；从 `cards` 里摘掉就 dispose —— 一台 contenteditable
   * 留在后台跟着每次编辑重查，是白付的账。
   */
  const mountCards = new Map<'left' | 'right', DockMountCard>()

  function ensureMountCard(side: 'left' | 'right'): DockMountCard {
    let inst = mountCards.get(side)
    if (!inst) {
      inst = deps.createMountCard(side)
      mountCards.set(side, inst)
    }
    return inst
  }

  /** 这一槽没有挂载区卡了 ⇒ 把它的编辑器收掉（订阅、编辑器、卡壳一起） */
  function dropMountCard(side: 'left' | 'right'): void {
    const inst = mountCards.get(side)
    if (!inst) return
    inst.dispose()
    mountCards.delete(side)
  }

  /**
   * 搜索卡**每个槽一份**（同一张面可以同时出现在两槽）：懒建、摘卡 dispose，
   * 判据与反链卡同一份——带输入框/编辑器的卡不能每次重画重建。
   */
  const searchCards = new Map<'left' | 'right', SearchCard>()

  function ensureSearch(side: 'left' | 'right'): SearchCard {
    let inst = searchCards.get(side)
    if (!inst) {
      inst = deps.createSearchCard(side)
      searchCards.set(side, inst)
    }
    return inst
  }

  /** 这一槽没有搜索卡了 ⇒ 把面收掉（订阅、预览编辑器、卡壳一起） */
  function dropSearch(side: 'left' | 'right'): void {
    const inst = searchCards.get(side)
    if (!inst) return
    inst.dispose()
    searchCards.delete(side)
  }

  /**
   * 槽内容依赖：**清单形式**列出装配层交给 UI 的能力，UI 不认识 `ws`／`registry`。
   * 全是读函数（库会被 `loadState` 整体替换，传值会拿到过期快照）。
   */
  const dockDeps: DockContentDeps = {
    kb,
    /**
     * 回收站的「恢复」走命令面：撤销、落盘、索引失效三条路径只有一处入口。
     * 写完补一次重画——回收站卡不是编辑器，没有自己的 change 事件。
     */
    restoreBlock: (id) => {
      void deps.getRegistry().invoke('core.block/restore', { blockId: id }, 'dock')
      renderDocks()
    },
    /** 清空同样走命令面（`core.trash/purge`）；purge 自己会宣布，重画跟着订阅走，但补一次不贵也不抖 */
    purgeTrash: (ids) => {
      void deps.getRegistry().invoke('core.trash/purge', { ids: ids.join(',') }, 'dock')
      renderDocks()
    },
    onTrashScope: (s) => {
      trashScope.set(s)
      renderDocks()
    },
    confirm: (o) => deps.confirm(o),
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
    open: (id, place) => deps.openBlock(id, place ?? 'center', { center: 'keep' }),
    find: (id) => kb.get(id),
    refresh: () => renderDocks(),
    link: (childId, parentId) => {
      void deps.getRegistry().invoke('core.belongs-to/add', { childId, parentId }, 'dock')
    },
  })

  /* ------------------------------------------------------------ 状态 */

  function cardStateFor(side: 'left' | 'right', id: string): DockCardState {
    const dock = deps.prefs().dock
    return {
      // 收起状态只有一份判据（单卡目标那一张此刻展开）；见 `isCardCollapsed`
      collapsed: isCardCollapsed(dock, side, id),
      solo: dock.solo[side] === id,
      pinned: dock.pinnedCards[id] === true,
      onToggleCollapse: () => toggleCollapse(id),
      onToggleSolo: () => toggleSolo(side, id),
      onTogglePin: () => togglePin(id),
      onHeadMenu: (anchor, trigger) => deps.showCardMenu(side, id, anchor, trigger),
      onDragStart: (e) => setDragCard(e.dataTransfer, id),
    }
  }

  function toggleCollapse(id: string): void {
    const dock = deps.prefs().dock
    /**
     * **取反的是「屏幕上这一张现在收着没有」，不是落盘那一位。**
     *
     * 两者在单卡期间会分叉：收着的卡成了单卡目标时，渲染层豁免它（此刻展开）。
     * 按落盘值取反 ⇒ 用户点「收起」，反而把键删掉变成展开（一次点了没反应）。
     *
     * 所以判据用 `isCardCollapsed`（唯一一份）；收起时顺带**退出单卡** ——
     * 不退出去的话，单卡那一层会把这次收起再豁免掉。
     */
    const side = dock.solo.left === id ? 'left' : dock.solo.right === id ? 'right' : null
    const visibleFolded = isCardCollapsed(dock, side ?? 'left', id)
    if (visibleFolded) delete dock.collapsedCards[id]
    else dock.collapsedCards[id] = true
    if (!visibleFolded && side) dock.solo[side] = null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 常驻开关：pin 是卡上自己的一位（全局 key），跨槽移动后跟着卡走 */
  function togglePin(id: string): void {
    const dock = deps.prefs().dock
    if (dock.pinnedCards[id]) delete dock.pinnedCards[id]
    else dock.pinnedCards[id] = true
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 收起这一槽的**所有卡**（再点＝展开所有）。
   *
   * 折叠全部与单卡不能同时成立（「只看一张」和「都收起来」是矛盾态），所以收起时退出单卡。
   * 只动本槽卡片的键：`collapsedCards` 是全局表，别槽的收起状态不受牵连。
   * 小卡没有 body，收起对它没有可见效果——键写了也无妨，展开时一并清掉。
   */
  function toggleFoldAll(side: 'left' | 'right'): void {
    const dock = deps.prefs().dock
    const keys = dock[side].cards.map(dockKey)
    const anyExpanded = dock[side].cards.some((e) => !isCardCollapsed(dock, side, dockKey(e)))
    if (anyExpanded) {
      for (const k of keys) dock.collapsedCards[k] = true
      dock.solo[side] = null
    } else {
      for (const k of keys) delete dock.collapsedCards[k]
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 单卡＝「只看这张卡」：槽里只剩它一张（同槽其它卡隐藏）。
   *
   * **收着的卡进单卡时，这一张此刻展开** —— 否则「看」落空（槽里只剩一颗头）。
   * 但这个展开是**叠在渲染上的一层**，不写 `collapsedCards`：退出单卡自动回到收着，
   * 不需要记「solo 前收没收」的第三态（与中心「聚焦即展开」同一条判据）。
   *
   * 用户在单卡期间**自己收起它** ⇒ 以这次为准（写进 `collapsedCards`，渲染时
   * 单卡那一层看到「用户要收」就让位），退出单卡后也保持收着。
   */
  function toggleSolo(side: 'left' | 'right', id: string): void {
    const dock = deps.prefs().dock
    const entering = dock.solo[side] !== id
    dock.solo[side] = entering ? id : null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /* ------------------------------------------------------------ 窗口 */

  /**
   * 在右槽打开一个块：**确保打开并定位**，不是 toggle。
   *
   * 同一个块全局最多一个窗口：已在另一侧 ⇒ 移过来（状态按 id 跟着走，pin 也在内）；
   * 已在本侧 ⇒ 不改顺序，只滚到它。
   * 打开会把这一侧的单卡退出——单卡是「只看一张」，加一张与它矛盾。
   *
   * pin 的缺省由**进入动作**决定（`pinDefaultFor`）：拖进来＝钉住（常驻），
   * 打开来看＝重启即清。组件块是家具，两种入口都常驻。
   */
  function openWindow(side: 'left' | 'right', blockId: string, action: WindowEntryAction = 'view', at?: CardDrop): void {
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
      // 拖到某张卡旁 ⇒ 插它前/后（与 `moveCard` 同一落点口径）；没给位置 ⇒ 追加到窗口组末尾
      let index = lastWindowIndex(dock[side].cards) + 1
      if (at?.targetId) {
        const ti = dock[side].cards.findIndex((e) => dockKey(e) === at.targetId)
        if (ti >= 0) index = at.place === 'before' ? ti : ti + 1
      }
      dock[side].cards.splice(index, 0, entry)
    }
    if (pinDefaultFor(action)) dock.pinnedCards[key] = true
    if (!deps.slotOpen(side)) {
      dock[side].open = true
      deps.noteSlotChanged(side)
      deps.applyChrome()
    }
    if (dock.solo[side] !== null && dock.solo[side] !== key) dock.solo[side] = null
    renderDocks()
    reveal(side, blockId)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 关掉**一张卡**：窗口卡、派生卡同一条路——只从 `cards` 里摘掉这一次露面。
   *
   * 「按 key 找条目」只有一份（`findDock`）：条目住顶层还是住某只盘里，这里不用关心。
   * 盘的 ✕ 不走这里（盘头的 ✕ 是**解散**，见 `dissolveTray`）。
   */
  function closeCard(side: 'left' | 'right', key: string): void {
    const dock = deps.prefs().dock
    const found = findDock(dock[side].cards, key)
    if (!found) return
    found.list.splice(found.index, 1)
    if (dock.solo[side] === key) dock.solo[side] = null
    // pin 是「这一次露面」的属性：关掉就结束。留着的话，下次用「打开来看」重开
    // 会因为旧 pin 位还在而违背进入动作的缺省（拖入才常驻）。
    delete dock.pinnedCards[key]
    dissolveIfEmpty(side)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 写出即解散：这一槽里空掉的盘就地摘除（**容器是内容的推论**，0 件就没有容器），
   * 并清掉收起／单卡表里指向它们的键。只在写路径上跑——读路径不悄悄删。
   */
  function dissolveIfEmpty(side: 'left' | 'right'): void {
    const dock = deps.prefs().dock
    for (const k of dissolveEmptyTrays(dock[side].cards)) {
      delete dock.collapsedCards[k]
      if (dock.solo[side] === k) dock.solo[side] = null
    }
  }

  /**
   * 关掉**这一槽的窗口卡**（「关闭其他窗口」＝除一张之外，kind 是 block 的都是窗口：
   * 组件块也是 block 条目，但它有渲染器、算家具——这里用一个判据分清）。
   *
   * 为什么只动窗口：派生卡／组件卡／命令小卡是槽的家具（重启也保留的那部分），
   * 「关掉窗口」的心智是「清掉打开来看的东西」，不该把布局一并清掉。
   * 家具要关，每张卡自己的 ✕ 就是入口。
   */
  function isWindowEntry(side: 'left' | 'right', key: string): boolean {
    const entry = deps.prefs().dock[side].cards.find((e) => dockKey(e) === key)
    return entry?.kind === 'block'
  }

  /** 单摘一批：清 solo／pin／收起键，与 closeCard 同一条路，但一次可以摘多张 */
  function removeWindows(side: 'left' | 'right', keep: string | null): number {
    const dock = deps.prefs().dock
    const before = dock[side].cards.length
    const removed: string[] = []
    dock[side].cards = dock[side].cards.filter((e) => {
      const k = dockKey(e)
      if (e.kind !== 'block') return true
      if (k === keep) return true
      removed.push(k)
      return false
    })
    if (dock[side].cards.length === before) return 0
    if (dock.solo[side] !== null && !dock[side].cards.some((e) => dockKey(e) === dock.solo[side])) {
      dock.solo[side] = null
    }
    for (const k of removed) {
      delete dock.pinnedCards[k]
      delete dock.collapsedCards[k]
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return before - dock[side].cards.length
  }

  /** 关闭其他窗口（保留 `key` 这一张；家具不受影响） */
  function closeOtherWindows(side: 'left' | 'right', key: string): boolean {
    if (!isWindowEntry(side, key)) return false
    return removeWindows(side, key) > 0
  }

  /** 关闭全部窗口（这一槽的；家具不受影响） */
  function closeAllWindows(side: 'left' | 'right'): boolean {
    return removeWindows(side, null) > 0
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

  /**
   * 启动清理（每个启动段只跑一次）：非 pin 的块窗口卡不留到这一轮。
   *
   * 判据在 `pruneEphemeralWindows`（core 纯函数）。
   * 顺手清掉指向被清卡的 solo 与收起键——留着的都是不再指任何东西的垃圾。
   * 挂在首次重画上而不是装配体里：装配早于持久化段，那里拿不到保存入口；
   * 首次重画时依赖都已就位，清完当场落盘。清过了就不再动（幂等）。
   */
  let pruned = false
  function pruneOnBoot(): void {
    if (pruned) return
    pruned = true
    const dock = deps.prefs().dock
    const removed = new Set<string>()
    for (const side of ['left', 'right'] as const) {
      const before = dock[side].cards
      const after = pruneEphemeralWindows(before, dock.pinnedCards)
      if (after.length === before.length) continue
      for (const e of before) if (!after.includes(e)) removed.add(dockKey(e))
      dock[side].cards = after
    }
    // 空盘不落盘：启动清理是写路径的一段，顺手把旧字节里残留的空盘解散
    for (const side of ['left', 'right'] as const) {
      for (const k of dissolveEmptyTrays(dock[side].cards)) removed.add(k)
    }
    if (removed.size === 0) return
    for (const side of ['left', 'right'] as const) {
      if (dock.solo[side] !== null && removed.has(dock.solo[side]!)) dock.solo[side] = null
    }
    for (const k of removed) delete dock.collapsedCards[k]
    deps.scheduleDeviceSave()
  }

  function renderDocks(): void {
    pruneOnBoot()
    ensureCardDrops()
    ensureTileCols()
    const { left, right } = deps.getSlots()
    renderSlot('left', left)
    renderSlot('right', right)
    syncFoldAllButton('left')
    syncFoldAllButton('right')
  }

  /**
   * 槽头「收起所有／展开所有」的图标随状态翻面：有展开的卡 ⇒ 收起全部，全收着 ⇒ 展开全部。
   * 单卡下其它卡是隐藏的不是收起的——此时仍然是「收起全部」（点它顺带退出单卡）。
   */
  function syncFoldAllButton(side: 'left' | 'right'): void {
    const dock = deps.prefs().dock
    const anyExpanded = dock[side].cards.some((e) => !isCardCollapsed(dock, side, dockKey(e)))
    const el = deps.getSlots()[side].foldAllEl
    const icon = anyExpanded ? 'lucide:chevrons-down-up' : 'lucide:chevrons-up-down'
    if (el.dataset.icon !== icon) renderIcon(el, icon, 'chevrons-down-up')
    el.title = anyExpanded ? t('ui.dock.foldAll') : t('ui.dock.unfoldAll')
    el.setAttribute('aria-label', el.title)
  }

  function renderSlot(side: 'left' | 'right', slot: DockSlotEls): void {
    const cards = deps.prefs().dock[side].cards
    const contentIds = cards.flatMap((e) => (e.kind === 'block' ? [e.block] : []))
    const winCards = windows ? windows[side].sync(contentIds) : new Map<string, HTMLElement>()
    const entries: DockCardEntry[] = []
    /** 这一槽里有没有挂载区卡／搜索卡（没有就把它们那台编辑器收掉） */
    let hasMountCard = false
    let hasSearch = false
    for (const card of cards) {
      // 种类由 `kind` 说，不由字符串形状猜：改 id 生成方案也不会让某种卡整片消失
      const key = dockKey(card)
      if (card.kind === 'cmd') {
        entries.push({ id: key, el: actionTile(side, card.command), size: 'small' })
        continue
      }
      if (card.kind === 'shortcut') {
        // 目标块被删也照画这一格：位置稳定优先于可用性过滤（置灰由 tile 自己说）
        entries.push({ id: key, el: shortcutTile(side, card.block), size: 'small' })
        continue
      }
      if (card.kind === 'derived') {
        /**
         * 挂载区卡是**持久卡壳**（里面有一台 contenteditable）：每次重画只 `sync`，
         * 不重建元素。其余派生卡是纯派生 DOM，照旧每次现造。
         */
        if (card.card === 'mount') {
          hasMountCard = true
          entries.push({ id: key, el: ensureMountCard(side).sync(), size: 'large' })
          continue
        }
        entries.push({ ...derivedCard(side, card.card), size: 'large' })
        continue
      }
      if (card.kind === 'utility') {
        // 工具面住进槽：与反链卡同型的持久卡（里面有输入框/编辑器）；渲染穷举在 faceCard 里
        const el = faceCard(side, card.face)
        if (el) {
          if (card.face === 'search') hasSearch = true
          entries.push({ id: key, el, size: 'large' })
        }
        continue
      }
      if (card.kind === 'tray') {
        // 空盘不画（写出已解散；旧字节里读来的空盘在这里不露面，等第一次写把它带走）
        if (card.cards.length === 0) continue
        entries.push(trayCard(side, card))
        continue
      }
      const el = winCards.get(card.block)
      if (el) entries.push({ id: key, el, size: 'large' })
    }
    if (!hasMountCard) dropMountCard(side)
    if (!hasSearch) dropSearch(side)
    renderDockStack(slot.stack, entries, t('ui.dock.empty'), deps.prefs().dock.solo[side])
    syncTileCols(slot.stack)
    syncTrayBands(slot.stack)
  }

  /**
   * 收纳盘＝**一张卡，body 换成小卡排**：不新增外壳、不新增第二种排版。
   *
   * 卡头 `[chevron] 名字 [n] [单卡] [✕]`，三颗按钮与普通卡同列（A24 继续成立）；
   * 未命名的盘，名字位显示「n 张小卡」。✕ 的语义是**解散**——只摘把手，
   * 小卡留在原位（关容器不许带走成员），所以 close 给的是 `dissolveTray`。
   * 盘的收起复用 `collapsedCards`（键是 `tray:<id>`）与 `isCardCollapsed` 唯一判据，
   * 不新增收起表。
   */
  function trayCard(side: 'left' | 'right', tray: Extract<DockEntry, { kind: 'tray' }>): DockCardEntry {
    const key = dockKey(tray)
    const band = document.createElement('div')
    band.className = 'dock-tray-body'
    // 成员复用同一对小卡产地：点击／右键／移出／拖拽的所有行为白拿——
    // 移出走 `closeCard`（findDock 找得到盘内的它），拖拽载荷就是它自己的 key
    for (const member of tray.cards) {
      if (member.kind === 'cmd') band.appendChild(actionTile(side, member.command))
      else if (member.kind === 'shortcut') band.appendChild(shortcutTile(side, member.block))
    }
    const named = tray.title !== undefined && tray.title !== ''
    const el = buildDockCard(
      {
        id: key,
        title: named ? tray.title! : t('ui.dock.trayCount', { count: tray.cards.length }),
        ...(named ? { count: String(tray.cards.length) } : {}),
        body: band,
        close: { title: t('ui.dock.trayDissolve'), onClick: () => dissolveTray(side, key) },
        /**
         * 未命名的盘静置**闭嘴**：展开时成员就摆在 body 里，「n 张小卡」报的是
         * 看得见的信息——按「静置文字只报正文看不出的上下文」的判据只剩 grip。
         * 盘名是用户起给这一组的、body 里没有的字 ⇒ 命名的盘静置留守。
         * 收起后成员看不见了 ⇒ 收起态全键与标题常驻（壳的统一规则，见 §7）。
         */
        ...(named ? {} : { quietHead: true }),
      },
      cardStateFor(side, key),
    )
    bindTrayDrops(side, tray.id, el)
    return { id: key, el, size: 'large' }
  }

  /** 盘的 body 也是同一条网格流：列数同一份函数，只是换成盘的内容盒来算（A18 的新口径） */
  function syncTrayBands(stack: HTMLElement): void {
    for (const band of stack.querySelectorAll<HTMLElement>(':scope .dock-tray-body')) syncTileCols(band)
  }

  /**
   * 一张**工具面卡**的身体。目录（`UTILITY_FACES`）加一个 id、这里没接 ⇒ 编译期红
   * （与派生卡的 `derivedCard` 同一条穷举纪律）。
   */
  function faceCard(side: 'left' | 'right', face: UtilityFaceId): HTMLElement | null {
    switch (face) {
      case 'search':
        return ensureSearch(side).sync()
      case 'settings':
        // 设置不进槽：没有「钉着看设置」的场景，它只住中心（画廊也不给添加行）
        return null
    }
  }

  /**
   * 小卡那一行分几列 ＝ **min(这一行放得下几列, 实际有几张小卡)** —— 每行都铺满：
   * 一张占满整行、两张两格铺满、超过容量换行（末行按同样的格宽留白）。
   * 2026-11-11 拍板：张数少于容量时**铺满优先**——孤张占满整行是想要的观感
   * （「留一条缝」曾更早被否）；曾试验的格宽上限因此被否。
   *
   * 为什么必须由这一层算（CSS 两条路都不对）：
   *   · `repeat(auto-fill, …)` 的列数只看可用宽度 ⇒ 张数少于列数时末尾多出一条空轨，
   *     小卡排到 4/5 处就停、右边留一条缝（槽 270px：5 列 4 张，右缘差 53px）；
   *   · `flex: 1` 均分不知道换行 ⇒ 末行换行行为不可控、且无「铺满」可言。
   *
   * **0 张也要写**：栈里还住着跨列大卡，轨道数不能退回 CSS 兜底（remove 让兜底接管
   * 曾把 4 条轨道的下限之和 194px 顶过 168 的槽宽，每张大卡被裁掉 14px——实测）。
   * min(容量, 0) 经 Math.max(1, …) 收敛到 1，按构造不会超容器。
   */
  function syncTileCols(stack: HTMLElement): void {
    const tiles = stack.querySelectorAll(':scope > .dock-tile').length
    const cs = getComputedStyle(stack)
    const inner = stack.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    const gap = parseFloat(cs.columnGap) || 0
    const min = parseFloat(cs.getPropertyValue('--ui-tile-min')) || 44
    const capacity = Math.max(1, Math.floor((inner + gap) / (min + gap)))
    const next = String(Math.max(1, Math.min(capacity, tiles)))
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
      syncTrayBands(left.stack)
      syncTileCols(right.stack)
      syncTrayBands(right.stack)
    })
    ro.observe(left.stack)
    ro.observe(right.stack)
  }

  /**
   * 小卡：一条命令 → 44px 动作格。
   *
   * 命令不可用（产品构建裁掉、插件卸载）时**保留位置**，画成占位格：
   * 从 cards 里删掉会让整排 reflow，用户会以为自己的布局丢了。
   *
   * 修饰键跟随块打开的同一套落点语言（`openActionOf`）：普通＝原样调用；
   * Shift/⌘＝把落点作为 `place` 参数随调用传出去——命令认不认是它自己的事
   * （搜索认：Shift＝搜索卡住进右槽、⌘＝中心 tab）；不认 `place` 的命令照旧。
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
      disabled: !ok,
      close: { title: t('ui.dock.removeTile'), onClick: () => removeTile(side, command) },
      onClick: (e) => {
        if (!ok) return
        const place: OpenAction = openActionOf(e)
        void deps.getRegistry().invoke(command, place === 'center' ? {} : { place }, 'tile')
      },
      // 命令小卡的右键只给「收进新收纳盘」——已在盘里的成员没有第二个盘可进；
      // 移出仍是 ✕（hover 常驻的那颗），不给菜单留第二份
      ...(deps.prefs().dock[side].cards.some((e) => dockKey(e) === id)
        ? { onMenu: (anchor: DOMRect, trigger?: HTMLElement) => deps.showTileMenu(side, command, anchor, trigger) }
        : {}),
      onDragStart: (e) => setDragCard(e.dataTransfer, id),
    }
    return buildDockTile(tile)
  }

  /**
   * 快捷小卡：指向一个块的常驻入口。
   *
   * 与命令小卡共用 44px 壳与同一排网格，但点击语义不同：命令小卡是「调用一条命令」，
   * 快捷小卡是「打开一个块」，所以走 `App.openBlock` 唯一那条路由——
   * Shift＝右槽开窗、⌘＝新 tab、⌥＝属性抽屉、无修饰＝中心，修饰键口径不用重写一遍。
   *
   * 名字每次重画现算：块改标题这颗卡跟着变，删了就置灰但不挪位置。
   * 不存名字快照，也就没有「名字与目标块对不上」那一种坏状态。
   */
  function shortcutTile(side: 'left' | 'right', blockId: string): HTMLElement {
    const id = dockKey({ kind: 'shortcut', block: blockId })
    const target = kb.get(blockId)
    const label = target ? blockLabel(target, (id) => kb.get(id)) : t('ui.dock.shortcutMissing')
    const tile: DockTile = {
      id,
      title: label,
      icon: target ? 'lucide:arrow-up-right' : 'lucide:circle-help',
      ...(target ? { glyph: label.slice(0, 2) } : {}),
      missing: !target,
      close: { title: t('ui.dock.removeShortcut'), onClick: () => removeShortcut(side, blockId) },
      onClick: (e) => {
        if (!target) {
          deps.toast(t('ui.dock.shortcutDangling'), 'warn')
          return
        }
        deps.openBlock(blockId, openActionOf(e))
      },
      onMenu: (anchor, trigger) => deps.showShortcutMenu(side, blockId, anchor, trigger),
      onDragStart: (e) => setDragCard(e.dataTransfer, id),
    }
    return buildDockTile(tile)
  }

  /** 只改 `cards`：这一槽（含盘里）已有这一颗就不再加；返回这次是否真的新增 */
  function insertShortcut(side: 'left' | 'right', blockId: string): boolean {
    const cards = deps.prefs().dock[side].cards
    const entry: DockEntry = { kind: 'shortcut', block: blockId }
    const key = dockKey(entry)
    // 「按 key 找条目」只有一份：盘里已经有了也不再放第二颗（同一槽内 key 唯一）
    if (findDock(cards, key)) return false
    // 小卡聚成一排：命令小卡与快捷小卡同属这一排，新的一颗接在最后一张**顶层**小卡之后
    const lastTile = cards.reduce((at, card, i) => (card.kind === 'cmd' || card.kind === 'shortcut' ? i : at), -1)
    cards.splice(lastTile + 1, 0, entry)
    return true
  }

  /**
   * 确保这一槽有一颗指向该块的快捷卡（已存在就只滚到它，不产生第二颗）。
   * 目标块不在库里就不加：一个指向空处的入口没有意义。
   */
  function addShortcut(side: 'left' | 'right', blockId: string): boolean {
    if (!kb.get(blockId)) return false
    const key = dockKey({ kind: 'shortcut', block: blockId })
    insertShortcut(side, blockId)
    if (!deps.slotOpen(side)) {
      deps.prefs().dock[side].open = true
      deps.noteSlotChanged(side)
      deps.applyChrome()
    }
    renderDocks()
    reveal(side, key)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /** 移出快捷卡：只摘这一次露面，块本身一个字节不动 */
  function removeShortcut(side: 'left' | 'right', blockId: string): void {
    closeCard(side, dockKey({ kind: 'shortcut', block: blockId }))
  }

  /** 换目标：位置与顺序不变，只把这一格指向另一块（盘里的快捷卡同样换得到） */
  function retargetShortcut(side: 'left' | 'right', from: string, to: string): boolean {
    if (!kb.get(to)) return false
    const cards = deps.prefs().dock[side].cards
    const found = findDock(cards, dockKey({ kind: 'shortcut', block: from }))
    if (!found) return false
    const key = dockKey({ kind: 'shortcut', block: to })
    if (findDock(cards, key)) return false
    found.list[found.index] = { kind: 'shortcut', block: to }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /**
   * 收成快捷：关掉这一槽的那张窗口卡，并在**同槽**留一颗指向同一块的快捷。
   *
   * 单向动作，没有对称的「小卡转大卡」：快捷卡留着只占 44px，删掉它是净亏；
   * 想摊开看用 Shift+点（或菜单里的「在侧槽展开」）加开一张窗口即可。
   * 摘窗口与加快捷在**一次写**里做完，只重画一次。
   */
  function collapseToShortcut(side: 'left' | 'right', blockId: string): boolean {
    const dock = deps.prefs().dock
    const winKey = dockKey({ kind: 'block', block: blockId })
    const at = dock[side].cards.findIndex((e) => dockKey(e) === winKey)
    if (at < 0) return false
    dock[side].cards.splice(at, 1)
    if (dock.solo[side] === winKey) dock.solo[side] = null
    delete dock.pinnedCards[winKey]
    delete dock.collapsedCards[winKey]
    /**
     * 「这块已经有快捷了吗」问的是**两侧**（含盘里的）：另一侧留着一颗时，
     * 收成不该顺手再造第二颗。左右各放一颗仍然允许，但那是用户主动加的，
     * 不是一次「收成」的副产物。
     */
    const shortcutKey = dockKey({ kind: 'shortcut', block: blockId })
    const hasAnyShortcut = (['left', 'right'] as const).some((s) => findDock(dock[s].cards, shortcutKey) !== null)
    if (!hasAnyShortcut) insertShortcut(side, blockId)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /**
   * 「在侧槽展开」：只**加回**一张窗口卡，快捷卡留在原地。
   *
   * 这不是「转回去」——收成之后的状态是「只有快捷」，展开之后是「两者都有」，
   * 不回到「只有窗口」，所以两条露面各自生灭，没有状态要搬。
   */
  function restoreWindow(side: 'left' | 'right', blockId: string): void {
    openWindow(side, blockId, 'view')
  }

  /** 添加快捷：只接受带 `tile` 元数据的命令；插在已有小卡之后，小卡聚成一排 */
  function addTile(side: 'left' | 'right', command: string): void {
    const decl = deps.getRegistry().decl(command)
    if (!decl?.tile || decl.hidden) return
    const dock = deps.prefs().dock
    const entry: DockEntry = { kind: 'cmd', command }
    const key = dockKey(entry)
    if (findDock(dock[side].cards, key)) return
    // 快捷小卡也在这一排：命令小卡插在最后一张**顶层**小卡之后，别把它插到快捷卡前面
    const lastTile = dock[side].cards.reduce((at, card, i) => (card.kind === 'cmd' || card.kind === 'shortcut' ? i : at), -1)
    dock[side].cards.splice(lastTile + 1, 0, entry)
    if (!deps.slotOpen(side)) {
      dock[side].open = true
      deps.noteSlotChanged(side)
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 移出小卡：只动 cards，不碰命令本身（盘里的同样走这一条） */
  function removeTile(side: 'left' | 'right', command: string): void {
    closeCard(side, dockKey({ kind: 'cmd', command }))
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
    // 派生卡全部 quiet：正文自己报得出名字（月历、树、清单），卡头静置不再报第二遍
    const finish = (spec: DockCard): DockCardEntry => ({
      id: card,
      el: buildDockCard({ ...spec, id: card, close, quietHead: true }, cardStateFor(side, card)),
    })
    // 穷举：`DERIVED_CARDS` 加一张、这里没接 ⇒ 编译期红（早先是三元链，漏了只是「点了没反应」）
    switch (card) {
      case 'inspect': {
        const el = deps.inspectCard()
        decorateDockCard(el, { id: card, title: '', body: el, close, quietHead: true }, cardStateFor(side, card))
        return { id: card, el }
      }
      case 'belongs':
        return finish(belongsTree.card())
      case 'mount':
        /**
         * 正常路径在 `renderSlot` 里被**持久实例**接管（`ensureMountCard`）；
         * 走到这里只可能是装配早期（实例还没建出来的那一瞬）——
         * 给一张空壳，下一次重画就有内容，不在这里再造第二台挂载区。
         */
        return finish({
          id: 'mount',
          title: t('ui.dock.mount'),
          body: emptyCardList(t('ui.mount.empty.refs')),
        })
      case 'trash':
        return finish(trashCard(dockDeps))
      case 'calendar':
        return finish(
          calendarCard({
            kb,
            openDate: (date, place) =>
              void deps.getRegistry().invoke('core.journal/open', { date, place: place ?? 'center' }, 'dock'),
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
    for (const side of ['left', 'right'] as const) {
      const slot = deps.getSlots()[side]
      /**
       * 落点是嵌套的（槽根 → 卡片堆栈 → 卡片正文区），内层亮起时外层不会自己收：
       * `dragleave` 的「还在自己容器里就不算离开」判定会把外层的高亮留在原地，
       * 于是「卡片指示线」和「正文三区线」会同时亮。捕获期统一清一次，
       * 谁在内层谁重画——三份高亮因此互斥。
       *
       * ⚠️ 必须先于下面的落点绑定注册：事件落在槽根自己时，目标阶段按注册顺序跑，
       *    后清会把绑定刚标上的高亮擦掉。
       */
      slot.root.addEventListener(
        'dragover',
        () => {
          delete slot.root.dataset.dropPin
          clearCardDropMarks()
        },
        true,
      )
      bindCardStack(slot.stack, side)
    }
    // 拖进来＝钉住（pin 缺省常驻）；Shift+点／命令打开＝看一眼（不 pin，重启即清）
    bindWindowDrop(left.root, (id) => deps.kb.get(id) !== undefined, (id) => openWindow('left', id, 'drop'))
    bindWindowDrop(right.root, (id) => deps.kb.get(id) !== undefined, (id) => openWindow('right', id, 'drop'))
  }

  /**
   * 盘的三个落点（落点都在**每次重画现建的**卡上，绑定随卡生灭，不需要解绑）：
   *   · 盘头 ＝ 收进去（追加到盘末；收起态 body 不在，落点自然只剩盘头）；
   *   · 盘内格前后 ＝ 盘内排序（与裸排同一份 cardDrop、同一条规则）；
   *   · 槽里两张卡之间 ＝ 移出来（走槽 stack 既有的落点，见 `bindCardStack`）。
   * 盘只收叶子：窗口类条目在 accept 处就拒掉（它们上提是**读路径**的兜底，不是通路）。
   */
  function bindTrayDrops(side: 'left' | 'right', trayId: string, cardEl: HTMLElement): void {
    const trayKey = dockKey({ kind: 'tray', id: trayId, cards: [] })
    const head = cardEl.querySelector<HTMLElement>(':scope > .dock-card-head')
    const band = cardEl.querySelector<HTMLElement>(':scope > .dock-card-body > .dock-tray-body')
    if (!head || !band) return
    const leafDrag = (key: string): boolean => {
      const src = findSide(key)
      if (!src) return false
      const found = findDock(deps.prefs().dock[src].cards, key)
      const entry = found ? found.list[found.index]! : null
      return entry !== null && isLeafEntry(entry)
    }
    bindDropTarget(head, {
      kind: 'card',
      effect: 'move',
      targetId: () => trayKey,
      accept: (id) => id !== trayKey && leafDrag(id),
      hint: () => t('ui.dock.trayDropIn'),
      mark: () => {
        head.dataset.dropInto = '1'
      },
      unmark: clearCardDropMarks,
      onDrop: (id) => {
        const src = findSide(id)
        if (src) moveCard(src, side, id, { targetId: null, place: 'end' }, trayId)
      },
    })
    bindDropTarget(band, {
      kind: 'card',
      effect: 'move',
      targetId: () => trayKey,
      accept: (id) => leafDrag(id),
      hint: () => t('ui.dnd.moveCard'),
      mark: (id, e) => markCardAt(band, id, e),
      unmark: clearCardDropMarks,
      onDrop: (id, _target, e) => {
        const src = findSide(id)
        if (src) moveCard(src, side, id, cardDrop(e, band), trayId)
      },
    })
  }

  function bindCardStack(stack: HTMLElement, side: 'left' | 'right'): void {
    bindDropTarget(stack, {
      kind: 'card',
      effect: 'move',
      targetId: () => null,
      accept: (id) => findSide(id) !== null,
      hint: () => t('ui.dnd.moveCard'),
      mark: (id, e) => markCardAt(stack, id, e),
      unmark: clearCardDropMarks,
      onDrop: (id, _target, e) => {
        const from = findSide(id)
        if (!from) return
        // 落点在槽里两张卡之间＝移出来：源条目哪怕住在盘里，findDock 也找得到——
        // **落点决定容器**，没有「先出盘再排序」这种两段式
        moveCard(from, side, id, cardDrop(e, stack))
      },
    })
    // 块载荷拖到卡片之间 ⇒ 在那张卡旁边开一张窗口卡。落在卡片**正文区**是另一层
    // 落点（编辑器三区，内层赢）：含义是移进那张卡的子树，两种含义靠悬停提示区分。
    bindDropTarget(stack, {
      kind: 'block',
      effect: 'copy',
      targetId: () => null,
      accept: (id) => deps.kb.get(id) !== undefined,
      hint: () => t('ui.dnd.pin'),
      mark: (id, e) => markCardAt(stack, id, e),
      unmark: clearCardDropMarks,
      onDrop: (id, _target, e) => openWindow(side, id, 'drop', cardDrop(e, stack)),
    })
  }

  /** 落点标记要跨两层容器清（槽直系 ＋ 盘 body ＋ 盘头的「收进去」） */
  function clearCardDropMarks(): void {
    for (const side of ['left', 'right'] as const) {
      const stack = deps.getSlots()[side].stack
      delete stack.dataset.dropEnd
      for (const el of Array.from(stack.querySelectorAll<HTMLElement>(':scope > .dock-card, :scope > .dock-tile'))) {
        delete el.dataset.dropBefore
        delete el.dataset.dropAfter
      }
      for (const head of Array.from(stack.querySelectorAll<HTMLElement>('.dock-card-head[data-drop-into]'))) {
        delete head.dataset.dropInto
      }
      for (const band of Array.from(stack.querySelectorAll<HTMLElement>('.dock-tray-body'))) {
        delete band.dataset.dropEnd
        for (const el of Array.from(band.querySelectorAll<HTMLElement>(':scope > .dock-tile'))) {
          delete el.dataset.dropBefore
          delete el.dataset.dropAfter
        }
      }
    }
  }

  /**
   * 指针落在哪个 Widget 的哪一侧（**对一个容器**：槽的直系卡，或盘 body 里的成员格）。
   *
   * 流里小卡横排、大卡整行，不能用单纯的 Y 中点：取**离指针最近的 Widget**，
   * 同一行看 X、跨行看 Y。这样小卡可以左右换位，大卡可以上下换位。
   * 盘内排序与槽内排序走的就是这同一份函数——只是容器换成 band（A18 的新口径）。
   */
  function cardDrop(e: DragEvent, container: HTMLElement): CardDrop {
    const items = Array.from(
      container.querySelectorAll<HTMLElement>(':scope > .dock-card, :scope > .dock-tile'),
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

  /** 两种载荷共用的落点指示（对 container）：离指针最近的那张卡，前/后各亮一条线（拖到自己那格不亮） */
  function markCardAt(container: HTMLElement, draggedKey: string, e: DragEvent): void {
    clearCardDropMarks()
    const at = cardDrop(e, container)
    if (at.targetId && at.targetId !== draggedKey) {
      const el = container.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(at.targetId)}"]`)
      if (el) el.dataset[at.place === 'before' ? 'dropBefore' : 'dropAfter'] = '1'
    } else if (!at.targetId) container.dataset.dropEnd = '1'
  }

  function findSide(key: string): 'left' | 'right' | null {
    const dock = deps.prefs().dock
    if (findDock(dock.left.cards, key)) return 'left'
    if (findDock(dock.right.cards, key)) return 'right'
    return null
  }

  /**
   * 移动一张卡（槽内排序、跨槽、移出盘、盘内排序都是这一个动作）。
   *
   * 源头按 key 找（`findDock`：顶层或盘内都找得到）；目的地由 `dstTrayId` 说——
   * `null` ＝ 顶层列表，给了 ＝ 那只盘的成员列表（**落点决定容器**，没有「进入盘模式」这种状态）。
   * 先摘再找落点：同一份列表里往后拖时，目标下标会因为自己先被摘掉而左移一格。
   * 拖拽载荷里是**扁平 key**（`data-card-id`），不是条目本身 ⇒ 按 key 找条目再搬。
   */
  function moveCard(
    from: 'left' | 'right',
    to: 'left' | 'right',
    key: string,
    at: CardDrop,
    dstTrayId: string | null = null,
  ): void {
    if (at.targetId === key) return
    const dock = deps.prefs().dock
    const src = findDock(dock[from].cards, key)
    if (!src) return
    const entry = src.list[src.index]!
    let dst: DockEntry[]
    if (dstTrayId !== null) {
      const trayFound = findDock(dock[to].cards, dockKey({ kind: 'tray', id: dstTrayId, cards: [] }))
      const tray = trayFound ? trayFound.list[trayFound.index]! : null
      // 盘只收叶子（容器只收叶子，读路径的摊平／上提是兜底不是通路）
      if (!tray || tray.kind !== 'tray' || !isLeafEntry(entry)) return
      dst = tray.cards
    } else {
      dst = dock[to].cards
    }
    if (src.list !== dst && dst.some((e) => dockKey(e) === key)) return
    src.list.splice(src.index, 1)

    let index = dst.length
    if (at.targetId) {
      const ti = dst.findIndex((e) => dockKey(e) === at.targetId)
      if (ti >= 0) index = at.place === 'before' ? ti : ti + 1
    }
    dst.splice(index, 0, entry)

    if (dock.solo[from] === key) dock.solo[from] = null
    if (dock.solo[to] !== null && dock.solo[to] !== key) dock.solo[to] = null
    if (!deps.slotOpen(to)) {
      dock[to].open = true
      deps.noteSlotChanged(to)
      deps.applyChrome()
    }
    // 源头若是盘，搬走最后一张成员后它就空了 ⇒ 写出即解散
    dissolveIfEmpty(from)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /** 卡头标题：窗口显示块的**路径**（父 > 父），不重复正文 */
  function windowLabel(id: string): string {
    const path = kb.pathOf(id)
    if (path.length === 0) return ''
    return path.map((b) => blockLabel(b, (id) => kb.get(id))).join(' / ')
  }

  /**
   * 把一个块已打开的窗口**移到它那一槽窗口组的最前**（「置顶」）。
   *
   * 置顶是一个动作不是状态：位置住在 `cards` 的序里，pin（常驻）是另一位，两者正交。
   * 窗口组从第一张块卡算起——命令小卡聚在前面，置顶不该把一张窗口插进小卡那一排。
   * 目标没有开着的窗口 ⇒ false（命令面板里这条对当前块不可用）。
   */
  function topWindow(blockId: string): boolean {
    const side = findSide(dockKey({ kind: 'block', block: blockId }))
    if (!side) return false
    const dock = deps.prefs().dock
    const cards = dock[side].cards
    const i = cards.findIndex((e) => e.kind === 'block' && e.block === blockId)
    if (i < 0) return false
    const firstWindow = cards.findIndex((e) => e.kind === 'block')
    const entry = cards.splice(i, 1)[0]!
    cards.splice(firstWindow < 0 ? cards.length : firstWindow, 0, entry)
    renderDocks()
    reveal(side, blockId)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
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
    if (!deps.slotOpen(side)) {
      dock[side].open = true
      deps.noteSlotChanged(side)
      deps.applyChrome()
    }
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /**
   * 把一张**工具面卡**加进槽（现只有搜索）。
   *
   * 与 `addDerived` 分开：两者落进 `cards` 的 `kind` 不同，混成一个会让
   * 「加回来的是哪一种」取决于字符串前缀（与上面同一条理由）。
   * 加进的是**右槽还是调用方指定的槽**由调用方说——修饰键只回答「去哪」。
   */
  function addUtility(side: 'left' | 'right', face: UtilityFaceId): void {
    const dock = deps.prefs().dock
    const entry: DockEntry = { kind: 'utility', face }
    const key = dockKey(entry)
    if (dock[side].cards.some((e) => dockKey(e) === key)) {
      // 已在槽里：把它滚到眼前（与窗口卡的「打开来看」同一条口径，不再 push 第二张）
      reveal(side, key)
      return
    }
    dock[side].cards.push(entry)
    if (!deps.slotOpen(side)) {
      dock[side].open = true
      deps.noteSlotChanged(side)
      deps.applyChrome()
    }
    renderDocks()
    reveal(side, key)
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
  }

  /* ------------------------------------------------------------ 收纳盘 */

  /**
   * 建盘：**容器从内容里长出来**——盘插在那张小卡原来的位置，顺序感不变。
   * 不存在空盘：建盘的唯一入口就是「把这一张收进去」。
   */
  function createTrayFromTile(side: 'left' | 'right', key: string): boolean {
    const cards = deps.prefs().dock[side].cards
    const i = cards.findIndex((e) => dockKey(e) === key)
    if (i < 0) return false
    const entry = cards[i]!
    if (!isLeafEntry(entry)) return false
    cards.splice(i, 1)
    cards.splice(i, 0, { kind: 'tray', id: uuidv7Hex(), cards: [entry] })
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /** 一次收完：把这一槽顶层还裸着的小卡全部收进这只盘（盘内已有的顺序不动） */
  function collectRestIntoTray(side: 'left' | 'right', trayId: string): boolean {
    const cards = deps.prefs().dock[side].cards
    const tray = cards.find((e) => e.kind === 'tray' && e.id === trayId)
    if (!tray || tray.kind !== 'tray') return false
    const rest = cards.filter((e) => isLeafEntry(e))
    if (rest.length === 0) return false
    tray.cards.push(...rest)
    for (const e of rest) cards.splice(cards.indexOf(e), 1)
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /**
   * ✕＝**解散**：只摘把手，小卡留在原位（数量与顺序都不变）——关容器不许带走成员。
   * 盘头菜单里的「连同小卡移出」才是唯一后果性动作（✕ 不该是破坏性按钮）。
   */
  function dissolveTray(side: 'left' | 'right', key: string): boolean {
    const dock = deps.prefs().dock
    const i = dock[side].cards.findIndex((e) => dockKey(e) === key)
    if (i < 0) return false
    const tray = dock[side].cards[i]!
    if (tray.kind !== 'tray') return false
    dock[side].cards.splice(i, 1, ...tray.cards)
    delete dock.collapsedCards[key]
    if (dock.solo[side] === key) dock.solo[side] = null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /** 连同小卡移出：把这一只盘和它装的小卡一起从槽里摘掉 */
  function removeTrayWithCards(side: 'left' | 'right', key: string): boolean {
    const dock = deps.prefs().dock
    const i = dock[side].cards.findIndex((e) => dockKey(e) === key)
    if (i < 0) return false
    const tray = dock[side].cards[i]!
    if (tray.kind !== 'tray') return false
    dock[side].cards.splice(i, 1)
    delete dock.collapsedCards[key]
    if (dock.solo[side] === key) dock.solo[side] = null
    renderDocks()
    deps.scheduleDeviceSave()
    deps.scheduleBadge()
    return true
  }

  /**
   * 重命名的**行内输入**：把盘头的标题位换成一只输入框，Enter／失灵点别处＝提交，
   * Esc＝取消（重画恢复原样）。点盘头仍然是开合——输入框吞掉自己的点击与按键，
   * 不让「改名打到一半」变成一次折叠。空串＝回到未命名（卡头显示「n 张小卡」）。
   */
  function startTrayRename(side: 'left' | 'right', trayId: string): void {
    const key = dockKey({ kind: 'tray', id: trayId, cards: [] })
    const tray = deps.prefs().dock[side].cards.find((e) => e.kind === 'tray' && e.id === trayId)
    if (!tray || tray.kind !== 'tray') return
    const stack = deps.getSlots()[side].stack
    const titleEl = stack.querySelector<HTMLElement>(
      `.dock-card[data-card-id="${CSS.escape(key)}"] > .dock-card-head > .dock-card-title`,
    )
    if (!titleEl) return
    const input = document.createElement('input')
    input.className = 'dock-tray-rename'
    input.value = tray.title ?? ''
    input.placeholder = t('ui.dock.trayRenamePlaceholder')
    input.spellcheck = false
    let done = false
    const commit = () => {
      if (done) return
      done = true
      renameTray(side, trayId, input.value)
    }
    const cancel = () => {
      if (done) return
      done = true
      renderDocks()
    }
    input.addEventListener('click', (e) => e.stopPropagation())
    input.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') commit()
      else if (e.key === 'Escape') cancel()
    })
    input.addEventListener('blur', commit)
    titleEl.replaceWith(input)
    input.focus()
    input.select()
  }

  /** 重命名落盘：只改 title，key 不动（改名、换槽、收起都不换 key） */
  function renameTray(side: 'left' | 'right', trayId: string, title: string): void {
    const tray = deps.prefs().dock[side].cards.find((e) => e.kind === 'tray' && e.id === trayId)
    if (!tray || tray.kind !== 'tray') return
    const name = title.trim()
    if (name === '') delete tray.title
    else tray.title = name
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
    addUtility,
    addShortcut,
    removeShortcut,
    retargetShortcut,
    collapseToShortcut,
    restoreWindow,
    toggleFoldAll,
    topWindow,
    closeOtherWindows,
    closeAllWindows,
    /** 收纳盘：建盘（从一张顶层小卡长出来）／一次收完／解散／连同移出／行内重命名 */
    createTrayFromTile,
    collectRestIntoTray,
    dissolveTray,
    removeTrayWithCards,
    startTrayRename,
    /** 卡头状态/标题给窗口管理器用（窗口卡由它自己建） */
    cardStateFor,
    windowLabel,
    /** 窗口管理器由装配入口在槽挂载之后创建，再交回给这一节 */
    setWindows: (next: { left: DockWindows; right: DockWindows }) => {
      windows = next
    },
  }
}
