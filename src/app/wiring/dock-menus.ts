/**
 * 侧槽的家什：**卡头菜单、组件画廊、窗口卡依赖、槽宽拖拽**。
 *
 * 这四件此前散在装配入口的尾部（与 setupDocks 的返回值互相咬合：菜单要用
 * cardStateFor/closeCard，而 setupDocks 的卡壳又要回调菜单）。收进这里后
 * 咬合变成显式的 deps 清单——一半来自 `setupDocks` 的返回（状态的家在那边），
 * 一半是装配层的活引用（换库/焦点切换会变的，一律现取，不传值）。
 */
import { blockLabel, centerDerivedOpenable, DERIVED_CARDS, dockKey, findDock, isCardCollapsed, isLeafEntry, UTILITY_FACES, walkForest, type DerivedCardId, type DockEntry, type UtilityFaceId } from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { BlockStore } from '../../core/model/store.ts'
import type { Prefs } from '../../core/infra/workspace.ts'
import type { Run, BlockEditor, ViewEvents } from '../../view/editor/editor.ts'
import { editorRun } from '../../view/editor/editor-run.ts'
import type { DockWindows } from '../../ui/dock/dock-windows.ts'
import type { ViewHost } from '../../ui/query/query-view.ts'
import type { DockCardState, DockSlotEls } from '../../ui/dock/dock.ts'
import { bindDockResize } from '../../ui/dock/dock-resize.ts'
import type { Row, Layers } from '../../ui/overlay/layers.ts'

export interface DockMenusDeps {
  /* —— 来自 setupDocks 的返回（内部状态的家在那边，这里只消费）—— */
  cardStateFor: (side: 'left' | 'right', key: string) => DockCardState
  closeCard: (side: 'left' | 'right', key: string) => void
  windowLabel: (blockId: string) => string
  addTile: (side: 'left' | 'right', command: string) => void
  addDerived: (side: 'left' | 'right', id: DerivedCardId) => void
  addUtility: (side: 'left' | 'right', face: UtilityFaceId) => void
  addShortcut: (side: 'left' | 'right', blockId: string) => boolean
  removeShortcut: (side: 'left' | 'right', blockId: string) => void
  retargetShortcut: (side: 'left' | 'right', from: string, to: string) => boolean
  collapseToShortcut: (side: 'left' | 'right', blockId: string) => boolean
  restoreWindow: (side: 'left' | 'right', blockId: string) => void
  toggleFoldAll: (side: 'left' | 'right') => void
  closeOtherWindows: (side: 'left' | 'right', key: string) => void
  closeAllWindows: (side: 'left' | 'right') => void
  /** 收纳盘的四个动作 ＋ 行内重命名（状态与落盘的家在 setupDocks，这里只给时机与锚） */
  createTrayFromTile: (side: 'left' | 'right', key: string) => boolean
  collectRestIntoTray: (side: 'left' | 'right', trayId: string) => boolean
  dissolveTray: (side: 'left' | 'right', key: string) => boolean
  removeTrayWithCards: (side: 'left' | 'right', key: string) => boolean
  startTrayRename: (side: 'left' | 'right', trayId: string) => void

  /* —— 装配层活引用 —— */
  kb: MemoryKb
  prefs: () => Prefs
  getRegistry: () => Registry
  layers: Layers
  keyHints: () => Map<string, string>
  /** 活动编辑器是 `let`（焦点切换/窗口开关都会重指），一律现取 */
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  getMainEd: () => BlockEditor
  store: BlockStore
  /** 写事务的唯一入口（source 由发起写的那台编辑器自己注入；见 `Run`） */
  run: Run
  wireEditor: (editor: BlockEditor, change: ViewEvents['change'], via: string, inlineViewBodies?: boolean) => void
  mountViewRoot: (
    block: import('../../core/index.ts').Block,
    into: HTMLElement,
    source: () => BlockEditor | undefined,
    surface: 'inline' | 'dock',
  ) => ViewHost | null
  syncSections: () => void
  scheduleSave: () => void
  scheduleBadge: () => void
  applyChrome: () => void
  scheduleDeviceSave: () => void
  toast: (msg: string, kind?: 'ok' | 'warn' | 'info') => void
  dockMinWidth: () => number
  dockMaxWidth: (side: 'left' | 'right') => number
}

export function setupCardMenus(deps: DockMenusDeps) {
  /**
   * 卡头右键菜单：**这张卡**的动作（折叠／只看／常驻／置顶／在正文打开）＋
   * 这一槽的批量动作（关闭其他/全部窗口、收起/展开全部）。
   *
   * 动态菜单：行按这张卡此刻的状态现画（与「视图…」菜单同一条纪律——
   * 菜单项是数据现画的，选中之后写路径仍走命令面／装配层的同一处入口）。
   * 关闭类动作只数**窗口卡**：派生卡／组件卡／命令小卡是家具，有自己的 ✕。
   */
  const showCardMenu = (side: 'left' | 'right', key: string, anchor: DOMRect, trigger?: HTMLElement): void => {
    const st = deps.cardStateFor(side, key)
    const dock = deps.prefs().dock
    // 「按 key 找条目」只有一份（findDock）：盘头菜单的条目也从这里来
    const found = findDock(dock[side].cards, key)
    const entry: DockEntry | null = found ? found.list[found.index]! : null
    const tray = entry?.kind === 'tray' ? entry : null
    const b = entry?.kind === 'block' ? deps.kb.get(entry.block) : undefined
    const isWindow = entry?.kind === 'block'
    const blockId = b?.id ?? ''
    const windows = dock[side].cards.filter((e) => e.kind === 'block')
    const anyExpanded = dock[side].cards.some((e) => !isCardCollapsed(dock, side, dockKey(e)))
    /** 「把其余小卡收进来」给不给：这一槽顶层还裸着几张 */
    const bareTiles = dock[side].cards.filter((e) => isLeafEntry(e)).length
    /**
     * 这张卡能不能「在中心打开」（同一份内容在中心的一次露面，卡留在槽里）。
     *
     * 块窗口有「在正文中打开」（同一条语义的既有名字）；派生卡只有中心接得住的
     * 才给行——其余的中心身体还没有，给了就是「点了没反应」的入口。
     */
    const centerOpenable =
      entry?.kind === 'block' ||
      entry?.kind === 'utility' ||
      (entry?.kind === 'derived' && centerDerivedOpenable(entry.card))
    const rows: Row[] = [
      { id: 'toggle', label: st.collapsed ? t('ui.dock.expandCard') : t('ui.dock.collapseCard') },
      { id: 'solo', label: st.solo ? t('ui.dock.unsoloCard') : t('ui.dock.soloCard') },
      ...(isWindow
        ? [
            { id: 'pin', label: st.pinned ? t('ui.dock.unpinCard') : t('ui.dock.pinCard') },
            { id: 'top', label: t('cmd.dock.topWindow') },
            { id: 'focus', label: t('ui.dock.focusInEditor') },
            { id: 'collapseToShortcut', label: t('ui.dock.collapseToShortcut') },
          ]
        : []),
      ...(tray
        ? [
            { id: 'trayRename', label: t('ui.dock.trayRename') },
            { id: 'trayCollect', label: t('ui.dock.trayCollect'), disabled: bareTiles === 0 },
            { id: 'trayMoveOut', label: t('ui.dock.trayMoveOut') },
          ]
        : []),
      ...(centerOpenable && !isWindow ? [{ id: 'center', label: t('cmd.surface.open') }] : []),
      ...(centerOpenable ? [{ id: 'openFull', label: t('ui.dock.openFull') }] : []),
      { id: 'closeOthers', label: t('ui.dock.closeOtherWindows'), disabled: windows.length <= 1 },
      { id: 'closeAll', label: t('ui.dock.closeAllWindows'), disabled: windows.length === 0 },
      { id: 'foldAll', label: anyExpanded ? t('ui.dock.foldAll') : t('ui.dock.unfoldAll') },
    ]
    /** 派生/工具卡的「在中心打开」：条目里存的是目录 id，这里翻成命令参数 */
    const openSurface = (): void => {
      if (entry?.kind === 'utility') void deps.getRegistry().invoke('core.surface/open', { kind: 'utility', id: entry.face }, 'dock')
      else if (entry?.kind === 'derived') void deps.getRegistry().invoke('core.surface/open', { kind: 'derived', id: entry.card }, 'dock')
    }
    deps.layers.openMenu({
      rows,
      anchor,
      // 同一颗卡头再右键一次＝收起（toggle）
      ...(trigger ? { trigger } : {}),
      searchable: false,
      emptyText: t('ui.dock.tileGalleryEmpty'),
      onPick: (row) => {
        switch (row.id) {
          case 'toggle':
            st.onToggleCollapse()
            return
          case 'solo':
            st.onToggleSolo()
            return
          case 'pin':
            st.onTogglePin?.()
            return
          case 'top':
            void deps.getRegistry().invoke('core.dock/top-window', { blockId }, 'dock')
            return
          case 'focus':
            void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'dock')
            return
          case 'collapseToShortcut':
            deps.collapseToShortcut(side, blockId)
            return
          case 'trayRename':
            if (tray) deps.startTrayRename(side, tray.id)
            return
          case 'trayCollect':
            if (tray) deps.collectRestIntoTray(side, tray.id)
            return
          case 'trayMoveOut':
            deps.removeTrayWithCards(side, key)
            return
          case 'center':
            openSurface()
            return
          case 'openFull':
            // 全屏是**同一份内容换个大点的落点**：中心先打开（块窗口走既有导航），再落档位
            if (entry?.kind === 'block') void deps.getRegistry().invoke('core.block/focus-block', { blockId }, 'dock')
            else openSurface()
            void deps.getRegistry().invoke('core.view/axis-to', { mode: 'full' }, 'dock')
            return
          case 'closeOthers':
            deps.closeOtherWindows(side, key)
            return
          case 'closeAll':
            deps.closeAllWindows(side)
            return
          case 'foldAll':
            deps.toggleFoldAll(side)
            return
        }
      },
    })
  }

  /**
   * 「选一个块」：快捷卡指向谁。
   *
   * 行由森林现算（不缓存）——块改名、软删、恢复都该当场反映在候选里。
   * 搜索交给浮层自己，不写第二套过滤；上限只是别让一次打开就摊平一万行。
   */
  const pickShortcutBlock = (onPick: (blockId: string) => void): void => {
    const rows: Row[] = []
    walkForest(deps.store.blocks, (b) => {
      if (rows.length >= 300) return false
      rows.push({ id: `shortcut-block/${b.id}`, label: blockLabel(b), icon: 'lucide:list-tree' })
    })
    deps.layers.openMenu({
      rows,
      anchor: null,
      title: t('ui.dock.pickShortcutTitle'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.dock.pickShortcutEmpty'),
      onPick: (row) => {
        const id = row.id.startsWith('shortcut-block/') ? row.id.slice('shortcut-block/'.length) : ''
        if (id === '' || !deps.kb.get(id)) return
        onPick(id)
      },
    })
  }

  /**
   * 快捷小卡右键：只给「这一颗」的动作。
   *
   * 没有「展开为窗口／转大卡」那一行：小卡只占 44px，删掉它是净亏；
   * 「在侧槽展开」只**加**一张窗口卡，这颗快捷留在原地。
   * 顶层裸排的才给「收进新收纳盘」——盘只从内容里长出来，盘里的成员没有第二个盘可进。
   */
  const showShortcutMenu = (
    side: 'left' | 'right',
    blockId: string,
    anchor: DOMRect,
    trigger?: HTMLElement,
  ): void => {
    const alive = deps.kb.get(blockId) !== undefined
    const key = dockKey({ kind: 'shortcut', block: blockId })
    const topLevel = deps.prefs().dock[side].cards.some((e) => dockKey(e) === key)
    const rows: Row[] = [
      ...(topLevel ? [{ id: 'trayNew', label: t('ui.dock.trayCreate') }] : []),
      { id: 'retarget', label: t('ui.dock.retargetShortcut') },
      ...(alive ? [{ id: 'restore', label: t('ui.dock.restoreWindow'), hint: t('ui.dock.shortcutShiftHint') }] : []),
      { id: 'remove', label: t('ui.dock.removeShortcutMenu') },
    ]
    deps.layers.openMenu({
      rows,
      anchor,
      ...(trigger ? { trigger } : {}),
      searchable: false,
      onPick: (row) => {
        switch (row.id) {
          case 'trayNew':
            deps.createTrayFromTile(side, key)
            return
          case 'retarget':
            pickShortcutBlock((to) => {
              if (!deps.retargetShortcut(side, blockId, to)) deps.toast(t('ui.dock.shortcutExists'), 'info')
            })
            return
          case 'restore':
            deps.restoreWindow(side, blockId)
            return
          case 'remove':
            deps.removeShortcut(side, blockId)
            return
        }
      },
    })
  }

  /**
   * 命令小卡右键：命令小卡此前没有菜单（移出是 hover 常驻的 ✕），
   * 收纳盘给了它第一个右键动作——收进新收纳盘。同样只在顶层裸排时给。
   */
  const showTileMenu = (side: 'left' | 'right', command: string, anchor: DOMRect, trigger?: HTMLElement): void => {
    const key = dockKey({ kind: 'cmd', command })
    const topLevel = deps.prefs().dock[side].cards.some((e) => dockKey(e) === key)
    if (!topLevel) return
    deps.layers.openMenu({
      rows: [{ id: 'trayNew', label: t('ui.dock.trayCreate') }],
      anchor,
      ...(trigger ? { trigger } : {}),
      searchable: false,
      onPick: (row) => {
        if (row.id === 'trayNew') deps.createTrayFromTile(side, key)
      },
    })
  }

  /**
   * 「添加组件」画廊：复用命令面板的列表/搜索/键盘。
   *
   * 两类条目共用一张列表：
   *   · 带 `tile` 的命令 → `cmd:<命令名>` 小卡；
   *   · 派生卡（目录在 `core/views/dock.ts` 的 `DERIVED_CARDS`）。
   * 命令是**策展过的**集合（不是所有命令）。
   */
  const showWidgetGallery = (side: 'left' | 'right', trigger?: HTMLElement): void => {
    const cards = deps.prefs().dock[side].cards
    const taken = new Set(cards.filter((e) => e.kind === 'cmd').map(dockKey))
    /**
     * **派生卡的目录**在 core 的 `DERIVED_CARDS`（与渲染分支同一份）：
     * 这里只把它翻成画廊行。派生卡和「带 `tile` 的命令」并列在同一张画廊里，
     * 是因为它们的 ✕ 只摘露面、**加回来只有这一处入口**。
     *
     * 行 id 带一个画廊内部的 `derived:` 前缀——它**不进 `cards`**（那里存的是 `DockEntry`），
     * 只是「这一行选中的是派生卡」的本地标记；前缀到条目 id 的映射放在 `derivedRows` 里，
     * `onPick` 查表，不靠字符串切分。
     */
    const derivedRows = new Map<string, DerivedCardId>()
    /**
     * 工具面卡（现只有搜索）与派生卡同列一张画廊：✕ 只摘露面，加回来只有这一处入口
     * （防「单向陷阱」的同一套判据）。前缀映射与派生卡同理——`utility:` 不进 `cards`。
     */
    const utilityRows = new Map<string, UtilityFaceId>()
    const rows: Row[] = [
      /**
       * 快捷卡的「加回来」入口：✕ 只摘一次露面，画廊里必须永远能再选一个块。
       * 与命令小卡同列一张画廊，但选中的是块 id，不是命令名 ⇒ 单独一行、单独一个 onPick 分支。
       */
      {
        id: 'shortcut:pick',
        label: t('ui.dock.pickShortcut'),
        hint: '',
        icon: 'lucide:arrow-up-right',
        group: `palette/${t('menu.cat.widget')}`,
        keyHint: undefined,
      },
      ...deps
        .getRegistry()
        .list()
        .filter((d) => d.tile && !d.hidden && !taken.has(`cmd:${d.name}`))
        .map((d) => ({
          id: d.name,
          label: d.title,
          hint: d.name,
          icon: d.tile!.icon,
          group: `palette/${d.category}`,
          command: d.name,
          keyHint: deps.keyHints().get(d.name),
        })),
      ...UTILITY_FACES.filter((d) => d.slot === true && !cards.some((e) => e.kind === 'utility' && e.face === d.id)).map((d) => {
        const id = `utility:${d.id}`
        utilityRows.set(id, d.id)
        return {
          id,
          label: t(d.label),
          hint: '',
          icon: d.icon,
          group: `palette/${t('menu.cat.widget')}`,
          keyHint: undefined,
        }
      }),
      ...DERIVED_CARDS.filter((d) => !cards.some((e) => e.kind === 'derived' && e.card === d.id)).map((d) => {
        const id = `derived:${d.id}`
        derivedRows.set(id, d.id)
        return {
          id,
          label: t(d.label),
          // 检视卡的主体是「这一屏唯一的那一块」：多根屏上加进来也看不见 —— 先说清为什么
          hint: d.id === 'inspect' && deps.getEd().doc.roots.length !== 1 ? t('ui.dock.inspectNoSubject') : '',
          icon: d.icon,
          group: `palette/${t('menu.cat.widget')}`,
          keyHint: undefined,
        }
      }),
    ].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
    deps.layers.openMenu({
      rows,
      anchor: null,
      // 同一颗「＋」再点一次＝收起（toggle）
      ...(trigger ? { trigger } : {}),
      title: t('ui.dock.tileGallery'),
      searchable: true,
      focusSearch: true,
      placeholder: t('ui.palette.placeholder'),
      emptyText: t('ui.dock.tileGalleryEmpty'),
      onPick: (row) => {
        if (row.id === 'shortcut:pick') {
          pickShortcutBlock((id) => {
            deps.addShortcut(side, id)
          })
          return
        }
        const utility = utilityRows.get(row.id)
        if (utility) {
          deps.addUtility(side, utility)
          return
        }
        const derived = derivedRows.get(row.id)
        if (derived) {
          deps.addDerived(side, derived)
          /**
           * 检视卡在多根屏上是**按主体收起**的（这一屏没有「一个东西」可言）：加进来
           * 也不会出现在槽里。不弹一句，用户看到的就是「点了添加，什么都没有」——
           * 加卡这个动作本身必须是诚实的。
           */
          if (derived === 'inspect' && deps.getEd().doc.roots.length !== 1) deps.toast(t('ui.dock.inspectAdded'), 'info')
          return
        }
        if (row.command) deps.addTile(side, row.command)
      },
    })
  }

  /**
   * 窗口：每个侧槽一个管理器，按块 id 建一张卡（卡里是**真实块**的编辑器，共享 store）。
   *
   * 依赖一律是读函数（库会被整体替换，传值会拿到过期快照）。
   */
  const dockWindowsDeps = (side: 'left' | 'right'): ConstructorParameters<typeof DockWindows>[0] => ({
    store: deps.store,
    /**
     * source 由**发起写的那台窗口编辑器**自己注入（见 `Run`）——不是「活动编辑器」：
     * 从正文拖块进卡的落手不经过焦点，活动编辑器还在正文，拿它当 source 会让
     * 正文把这次通知当成自己写的，跳过重画。
     */
    write: editorRun(deps.run, () => deps.getEd()),
    kb: deps.kb,
    label: deps.windowLabel,
    onClose: (blockId) => deps.closeCard(side, blockId),
    /**
     * 窗口编辑器也接**整份** `viewEvents`（与挂载区/查询结果同一条口径）。
     *
     * ⚠️ 必须整份接上：只手接几支（change/块标/右槽/引用）的做法漏接不报错——
     * 右键块菜单、`#`·`@` 补全、撞名提示这些在窗口里点了就是没反应。
     */
    wire: (editor, change) => deps.wireEditor(editor, change, 'dock', true),
    /**
     * 窗口里也是「正文」：根块是视图宿主就画它的源视图；行内的查询块也画结果。
     * 与中心同一条规则，只是容器换了 —— 不是第二种窗口语义。
     */
    mountViewRoot: (block, into, source) => deps.mountViewRoot(block, into, source, 'dock'),
    onFocus: (editor) => {
      deps.setEd(editor)
      deps.scheduleBadge()
    },
    /** 窗口被拆掉时，别让活动编辑器指着一个已经 dispose 的编辑器 */
    onDispose: (editor) => {
      if (deps.getEd() !== editor) return
      deps.setEd(deps.getMainEd())
      deps.scheduleBadge()
    },
    // 窗口内编辑：只落盘与刷角标，**不重画槽**（重画会打断这一行的输入）
    onChange: () => {
      deps.syncSections()
      deps.scheduleSave()
      deps.scheduleBadge()
    },
    cardState: (blockId) => deps.cardStateFor(side, blockId),
  })

  /** 手柄宽度：起拖取**当前渲染宽度**（存的是 null 时也不能让槽先跳一下） */
  const bindResize = (side: 'left' | 'right', slot: DockSlotEls): void => {
    bindDockResize({
      side,
      handle: slot.resizeEl,
      width: () => slot.root.getBoundingClientRect().width,
      min: deps.dockMinWidth,
      max: () => deps.dockMaxWidth(side),
      onResize: (width) => {
        deps.prefs().dock[side].width = width
        deps.applyChrome()
        deps.scheduleDeviceSave()
      },
      onReset: () => {
        deps.prefs().dock[side].width = null
        deps.applyChrome()
        deps.scheduleDeviceSave()
      },
    })
  }

  return { showCardMenu, showShortcutMenu, showTileMenu, showWidgetGallery, dockWindowsDeps, bindResize }
}
