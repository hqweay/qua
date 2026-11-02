/**
 * 页装配：「当前对象」一族、导航历史、装载边界与页/日记共用的依赖面。
 *
 * `ws`／`ed`／`mainEd` 都会被整体替换或切换，一律经 getter 现取；
 * 面板分片晚于本节装配，重画入口经 `getPanels` 延迟取用。
 */
import {
  activeView,
  blockLabel,
  displayNameOf,
  FEED_INITIAL,
  FEED_SPEC,
  findInForest,
  findPath,
  hasLiveChildren,
  isEmbedBlock,
  isJournal,
  journalId,
  liveChildren,
  mkBlock,
  prop,
  todayISO,
  type Block,
  type Doc,
  type SecLayout,
  type ShellCol,
} from '../../core/index.ts'
import { t } from '../../core/infra/msg.ts'
import type { Registry } from '../../core/commands/index.ts'
import type { MemoryKb } from '../../core/kb/memory.ts'
import type { Tx, Change, Op } from '../../core/kb/types.ts'
import type { BlockStore } from '../../core/model/store.ts'
import type { Prefs, Workspace } from '../../core/infra/workspace.ts'
import type { Layers } from '../../ui/layers.ts'
import type { Chrome } from '../../ui/chrome.ts'
import { isReadonlyBlock } from '../../view/block-dom.ts'
import type { BlockEditor, ViewState } from '../../view/editor.ts'
import { rootsFor, rootsForMany } from '../commands/roots.ts'
import type { PageDeps } from '../commands-impl.ts'

export type PagesDeps = {
  kb: MemoryKb
  blocks: BlockStore
  txRun: <R>(fn: (tx: Tx) => R, source?: unknown) => { ops: Op[]; changes: Change[]; result: R }
  run: <R>(fn: (tx: Tx) => R, source?: unknown) => R
  syncSections: () => void
  saveNow: () => void
  scheduleSave: () => void
  scheduleBadge: () => void
  repaintBlock: (blockId: string) => void
  /**
   * 改块自己的属性（**必然连带重画这一行**）。见实现处：那一步不是可选项。
   */
  writeProps: (blockId: string, mutate: () => void) => void
  renderDocks: () => void
  editorEl: HTMLElement
  layers: Layers
  uiCtx: () => import('../../core/index.ts').CtxKeys
  /** app 门面晚于本节装配；提示经 getter 现取 */
  getApp: () => { toast: (text: string, kind?: 'info' | 'warn' | 'ok') => void }
  /** 面板分片晚于本节装配：装载边界的重画经 getter 现取 */
  getPanels: () => {
    renderMounts: () => void
    renderProperties: () => void
  }
  getWs: () => Workspace
  getEd: () => BlockEditor
  setEd: (ed: BlockEditor) => void
  getMainEd: () => BlockEditor
  getRegistry: () => Registry
  getChrome: () => Chrome
  /** 槽开关是设备偏好：`openDock` 要先看它，已开就不再触发一次变更 */
  prefs: () => Prefs
  /** 把某张派生卡放回槽（关掉之后「看属性」还能把它放回来）；由装配层接到 `addDerived` */
  ensureDockCard: (side: 'left' | 'right', id: 'inspect' | 'belongs' | 'backrefs' | 'trash' | 'calendar') => void
  /** 在右槽打开一个块（日记的 Shift+点日期要用；不换中心、不入历史） */
  openInDock: (id: string) => void
  /** tab 条是 UI：状态变化时把「有哪些 tab／哪个活跃／叫什么」交给装配层重画 */
  onTabsChanged?: (tabs: readonly TabInfo[]) => void
}

/** 一条 tab 的显示信息（UI 只读，不改 tab 状态） */
export type TabInfo = { id: string; title: string; active: boolean }

export function setupPages(deps: PagesDeps) {
  const {
    kb,
    blocks,
    txRun,
    run,
    syncSections,
    saveNow,
    scheduleSave,
    scheduleBadge,
    repaintBlock,
    writeProps,
    renderDocks,
    editorEl,
    layers,
    uiCtx,
  } = deps

  /**
   * **导航历史**（中心槽的「当前对象」先后）。与 undo/redo 是两套：
   *   · undo 管**数据**（块树/锚点/原子的快照）；
   *   · 这里管**走到哪**（打开页、点链接、zoom、面包屑都算一次导航）。
   *
   * **每个 tab 一份历史**；`nav` 是当前 tab 的那一份（tab 切换时重新指向）。
   * 左右槽显式钉住、不跟随导航，所以历史只记中心槽的 `activeId`。
   * `lock` 用来区分「用户导航」与「历史本身在回放」——后者不能再入栈。
   *
   * ⚠️ **同一个 id 可以有两种形态**：今天的 journal 既可能以「日记流入口」打开，
   *    也可能以「只看这一天」聚焦。历史只存 id 会把两者压成一种（回退后 feed 消失），
   *    所以每一项都带 `feed` 这个视图形态。
   * ⚠️ **每一项还带离开那一刻的 `ViewState`**：历史回放要回到当时的位置，
   *    不能读「这个视图现在的最新位置」——那会把旧历史点污染成最后一次访问的位置。
   */
  type NavPoint = { id: string; feed: boolean; state?: ViewState }
  type TabNav = { back: NavPoint[]; forward: NavPoint[] }
  /**
   * **一个 tab ＝ 一份保存的视图**（不是一台并行编辑器）：
   * `doc` 是装载单位（roots／folded／contexts／expandedRoots／viewRootId），
   * `state` 是位置（视口锚＋选区），`viewStates` 是「在这个 tab 里访问过的视图 →
   * 离开时最后的位置」，`nav` 是这个 tab 自己的前进/后退。
   */
  type TabState = {
    id: string
    activeId: string
    feed: boolean
    doc: Doc
    shells: readonly ShellCol[]
    layout: SecLayout
    state: ViewState
    viewStates: Map<string, ViewState>
    nav: TabNav
  }
  const emptyViewState = (): ViewState => ({ scroll: null, sel: null })
  const tabs: TabState[] = []
  let activeTabId = ''
  let tabsReady = false
  let tabSeq = 0
  /**
   * 一次性恢复请求：`setActiveId` 把「这次是返回」落在这里，`loadRoots` 取走即清。
   * 不放进公开命令参数——`ViewState` 是视图内部状态，外部调用者不该构造它。
   */
  let pendingRestore: { state: ViewState; focus: boolean; fallbackCaret: boolean } | null = null
  /** `pendingRestore` 是历史快照（优先于「视图最后位置」）；由 `loadRoots` 消费 */
  let pendingFromHistory = false
  /** 本次装载已经恢复了位置 ⇒ 跳过调用方随后的 `focusFirstBlock`（否则会先闪到顶部） */
  let skipNextFocus = false
  const nav: { back: NavPoint[]; forward: NavPoint[]; lock: boolean } = { back: [], forward: [], lock: false }

  const viewKey = (id: string, feed: boolean, viewRootId?: string): string =>
    `${feed ? 'feed' : 'block'}:${id}:${viewRootId && viewRootId !== '' ? viewRootId : 'outline'}`
  /** 这个块当前激活的非大纲视图根 id（没有就 ''）；与 `loadRoots` 的派生规则同源 */
  const activeViewRootId = (id: string): string => {
    const b = kb.get(id)
    return b && activeView(b) && !isEmbedBlock(b) ? b.id : ''
  }
  const currentTab = (): TabState | undefined => tabs.find((x) => x.id === activeTabId)

  const tabTitle = (tab: TabState): string => {
    const b = kb.get(tab.activeId)
    const base = b ? blockLabel(b) : t('ui.page.untitled')
    return tab.feed ? `${base} · ${t('ui.tabs.feed')}` : base
  }
  const listTabs = (): TabInfo[] =>
    tabs.map((tab) => ({ id: tab.id, title: tabTitle(tab), active: tab.id === activeTabId }))
  const emitTabs = (): void => {
    deps.onTabsChanged?.(listTabs())
  }
  function syncNav(): void {
    const tab = currentTab()
    if (!tab) return
    nav.back = tab.nav.back
    nav.forward = tab.nav.forward
  }

  /** 当前中心视图是不是「日记流入口」（多段且全是 journal） */
  function isFeedView(): boolean {
    const mainEd = deps.getMainEd()
    if (!mainEd) return false
    const roots = mainEd.doc.roots
    return roots.length > 1 && roots.every((b) => isJournal(b))
  }

  /** 第一个 tab 用启动时已经装载好的那台编辑器；之后由 tab 条/命令新建。 */
  function initTabs(): void {
    if (tabsReady) return
    const mainEd = deps.getMainEd()
    if (!mainEd) return
    tabsReady = true
    const tab: TabState = {
      id: `tab-${++tabSeq}`,
      activeId: deps.getWs().activeId || (mainEd.doc.roots[0]?.id ?? ''),
      feed: isFeedView(),
      doc: mainEd.doc,
      shells: mainEd.shellCols,
      layout: mainEd.layout,
      state: mainEd.captureViewState(),
      viewStates: new Map(),
      nav: { back: [], forward: [] },
    }
    tabs.push(tab)
    activeTabId = tab.id
    syncNav()
    emitTabs()
  }

  /** 保存当前 tab 的 Doc／shells／layout／位置；导航与切 tab 共用这一处 */
  function captureActive(): ViewState | null {
    const mainEd = deps.getMainEd()
    const tab = currentTab()
    if (!mainEd || !tab) return null
    const state = mainEd.captureViewState()
    tab.doc = mainEd.doc
    tab.shells = mainEd.shellCols
    tab.layout = mainEd.layout
    tab.state = state
    tab.viewStates.set(viewKey(tab.activeId, tab.feed, mainEd.doc.viewRootId), state)
    return state
  }

  /** 一个目标视图的装载单位（新 tab 用；与 `loadRoots` 同一条派生规则） */
  function makeTab(id: string, feed: boolean): TabState | null {
    const b = kb.get(id)
    if (!b) return null
    const mainEd = deps.getMainEd()
    const feedDays =
      feed && isJournal(b)
        ? kb
            .query({ ...FEED_SPEC, limit: FEED_INITIAL })
            .map((h) => kb.get(h.blockId))
            .filter((x): x is Block => x !== undefined)
        : []
    const roots = feed && isJournal(b) ? rootsForMany(feedDays) : rootsFor(b)
    materializeEditableRoots(roots)
    const only = roots.length === 1 ? roots[0] : undefined
    const viewRootId = only && activeView(only) && !isEmbedBlock(only) ? only.id : ''
    const doc: Doc = {
      roots,
      // 每个 tab 自己的一份折叠表：共用一个对象会让一个 tab 的折叠串到另一个 tab
      folded: { ...mainEd.doc.folded },
      ...(viewRootId ? { viewRootId } : {}),
    }
    return {
      id: `tab-${++tabSeq}`,
      activeId: id,
      feed,
      doc,
      shells: [],
      layout: feed ? deps.prefs().feedLayout : 'column',
      state: emptyViewState(),
      viewStates: new Map(),
      nav: { back: [], forward: [] },
    }
  }

  /** 把一份 tab 装载进中心编辑器（切 tab 与新 tab 共用） */
  function loadTab(tab: TabState): void {
    const mainEd = deps.getMainEd()
    deps.setEd(mainEd)
    deps.getWs().activeId = tab.activeId
    mainEd.loadPage(tab.doc)
    mainEd.setLayout(tab.layout)
    if (tab.shells.length > 0) mainEd.setShells(tab.shells)
    mainEd.restoreViewState(tab.state, { focus: true, fallbackCaret: true })
    tab.doc = mainEd.doc
    const { renderMounts, renderProperties } = deps.getPanels()
    renderMounts()
    renderProperties()
    deps.getChrome().renderTitle(activeBlock(), activeTrail())
    deps.renderDocks()
    deps.scheduleSave()
    deps.scheduleBadge()
    syncNav()
    emitTabs()
  }

  function activateTab(id: string): boolean {
    initTabs()
    if (id === activeTabId) return false
    const tab = tabs.find((x) => x.id === id)
    if (!tab) return false
    captureActive()
    activeTabId = tab.id
    syncNav()
    loadTab(tab)
    return true
  }

  /** 新 tab 打开一个目标视图；同一个视图已经开着就切过去（一个视图只开一张 tab） */
  function openInNewTab(id: string, feed = false): boolean {
    initTabs()
    const existing = tabs.find((tab) => tab.activeId === id && tab.feed === feed)
    if (existing) return activateTab(existing.id)
    const tab = makeTab(id, feed)
    if (!tab) return false
    captureActive()
    tabs.push(tab)
    activeTabId = tab.id
    syncNav()
    loadTab(tab)
    return true
  }

  function newTab(): boolean {
    initTabs()
    const today = journalId(todayISO())
    const todayBlock = kb.get(today)
    const targetId = todayBlock ? today : (currentTab()?.activeId ?? '')
    const targetFeed = todayBlock ? true : Boolean(currentTab()?.feed)
    if (!targetId) return false
    // `+` 总是开一张新 tab（浏览器同一条直觉）；⌘+点击才按视图去重
    const tab = makeTab(targetId, targetFeed)
    if (!tab) return false
    captureActive()
    tabs.push(tab)
    activeTabId = tab.id
    syncNav()
    loadTab(tab)
    return true
  }

  function closeTab(id?: string): boolean {
    initTabs()
    const target = id ?? activeTabId
    const idx = tabs.findIndex((x) => x.id === target)
    if (idx < 0) return false
    const wasActive = target === activeTabId
    tabs.splice(idx, 1)
    if (tabs.length === 0) {
      activeTabId = ''
      const today = journalId(todayISO())
      const tab = makeTab(kb.get(today) ? today : deps.getWs().activeId, Boolean(kb.get(today)))
      if (!tab) {
        emitTabs()
        return false
      }
      tabs.push(tab)
      activeTabId = tab.id
      syncNav()
      loadTab(tab)
      return true
    }
    if (wasActive) {
      const next = tabs[Math.min(idx, tabs.length - 1)]!
      activeTabId = ''
      activateTab(next.id)
    } else {
      emitTabs()
    }
    return true
  }

  function cycleTab(dir: -1 | 1): boolean {
    initTabs()
    if (tabs.length < 2) return false
    const at = tabs.findIndex((x) => x.id === activeTabId)
    if (at < 0) return false
    const next = tabs[(at + dir + tabs.length) % tabs.length]!
    return activateTab(next.id)
  }

  function resetTabs(): void {
    tabs.length = 0
    activeTabId = ''
    tabsReady = false
    tabSeq = 0
    pendingRestore = null
    pendingFromHistory = false
    skipNextFocus = false
    nav.back = []
    nav.forward = []
    nav.lock = false
    emitTabs()
  }


  /**
   * 「当前对象」＝ 中心槽持有的那个块（只有中心槽有这个概念）。
   *
   * ⚠️ 它**不只是页**：`journal` 也是中心槽的默认内容；zoom 之后还能是
   *   **任意深度的块**⇒ 必须在**整片森林**里找，不能只看顶层。
   */
  const activeBlock = (): Block => kb.get(deps.getWs().activeId) ?? kb.roots()[0]!

  /**
   * zoom 的面包屑：**派生**，不入库、不物化（不引入焦点栈）。
   * 路径含「当前对象」自己 ⇒ 去掉末尾就是祖先链。
   */
  const activeTrail = (): Block[] => {
    const path = findPath(deps.getWs().blocks, deps.getWs().activeId)
    return path ? path.slice(0, -1) : []
  }
  /** 页名 ＝ 主别名叶子（没有名字才回落到描述）；空则交给调用方做兜底文案 */
  const pageTitle = (p: Block): string => displayNameOf(p)
  /** 页图标 ＝ 系统属性 `_icon`；空值用 `file`，与 `view/icons.ts` 的角色默认一致 */
  const pageIcon = (p: Block): string => prop<string>(p, '_icon') ?? 'lucide:file'

  /**
   * **第一个可编辑的行**：journal 的首行是**只读日期**（`contenteditable=false`），
   * 不能接光标 ⇒ 取它的第一个子块。页 / 被 zoom 的块没这个问题：那一行就是页名／正文本身。
   *
   * ⚠️ 为什么抽成一处：冷启动落点、回今日、翻日、zoom 用的是**同一条**规则；
   *    写两份就会立刻分叉（实际发生过：末尾的「首屏落光标」那段还在指首行，
   *    把 `focusFirstBlock` 设好的光标又覆盖回只读日期行）。
   */
  function firstEditableRoot(first: Block | undefined): Block | null {
    if (!first) return null
    return isReadonlyBlock(first) ? (liveChildren(first)[0] ?? null) : first
  }

  /**
   * **装载边界的可编辑保证**：被装进中心编辑器的 journal 天至少要有一个**看得见**的子块——
   * 日期行只读，没有子块就没有可落光标的地方（「打得开却打不了字」）。
   *
   * 这是**写库**，不是渲染兜底：渲染兜底会让「看到的块」与「库里的块」分叉，
   * 补的块经事务真的进库（一条 `insert`，op 里报它自己的落点）。
   * 所有装载入口共用这一个落点（`loadPage`／日记流增量／演示换库）。
   *
   * ⚠️ 判据是 `hasLiveChildren`，不是 `children.length`：删除是原位软删，块还挂在
   *    `children` 里 ⇒ 用长度判，删空过的天**永远**补不回来（打开一次也补不回来）。
   *    运行时的另一半（删除那一刻就补）在编辑器写入口，见 `BlockEditor` 的落笔格守卫。
   */
  function materializeEditableRoots(roots: readonly Block[]): void {
    for (const r of roots) {
      const mainEd = deps.getMainEd()
      if (isJournal(r) && !hasLiveChildren(r)) run((tx) => tx.insert(mkBlock(''), r.id, 0), mainEd)
    }
  }

  /**
   * 装载一屏（打开页/聚焦/翻日/切视图共用这一个落点）。
   *
   * **视图让位**：单根块若有激活的非大纲视图，正文只画这一行 —— children 由段尾的视图宿主画。
   * 判据从模型派生（`activeView`），不额外存一份「当前是不是表格」：
   * 存了就要在切视图/切页/换库三处同时维护，漏一处就是同一批子块画两遍（或一遍都不画）。
   */
  function loadRoots(roots: Block[]): void {
    const mainEd = deps.getMainEd()
    const tab = currentTab()
    // 装载边界：空 journal 天在这里补首子块（经事务、一条 op）——
    // 所有「打开」命令共用的唯一归一落点，`rootsFor`／命令层只选择、不写库
    materializeEditableRoots(roots)
    const { renderMounts, renderProperties } = deps.getPanels()
    deps.setEd(mainEd)
    const only = roots.length === 1 ? roots[0] : undefined
    const viewRootId = only && activeView(only) && !isEmbedBlock(only) ? only.id : ''
    // 折叠态是**视图**的一份：当前 tab 的那份（拿不到 tab 时退回编辑器手上的那份）
    const folded = tab ? { ...tab.doc.folded } : mainEd.doc.folded
    mainEd.loadPage({ roots, folded, ...(viewRootId ? { viewRootId } : {}) })
    if (tab) tab.doc = mainEd.doc
    // 装载之后才建挂载区：它按**段根**建实例，而段是 `loadPage` 造出来的
    renderMounts()
    renderProperties()
    /**
     * **返回类导航**在这里恢复位置：`pendingRestore` 由 `setActiveId`／`historyGo`
     * 在装载前放下，这里取走即清。恢复过就跳过调用方随后的 `focusFirstBlock`——
     * 否则会先闪到顶部再跳回，用户看到的是「回顶部了一下」。
     */
    const restore = pendingRestore
    pendingRestore = null
    pendingFromHistory = false
    if (restore) {
      mainEd.restoreViewState(restore.state, { focus: restore.focus, fallbackCaret: restore.fallbackCaret })
      skipNextFocus = true
      // 调用方若接着调 `focusFirstBlock`（同一条命令同步路径），它会看到这一拍；
      // 若没有调（左槽打开页），这一拍后清掉，别让标记留到下一次无关的聚焦。
      queueMicrotask(() => {
        skipNextFocus = false
      })
    } else {
      skipNextFocus = false
    }
    emitTabs()
  }

  /**
   * 页与日记**共用同一份依赖**（`PageDeps`）：两者都是「一块 ＋ 一棵子树」，
   * 只是角色不同 ——各给一套依赖就会立刻出现两条分叉的实现路径（要消灭的正是这个）。
   *
   * ⚠️ 依赖一律是**读函数**而不是值：库会被 `loadState` 整体替换，传值会拿到过期快照。
   */
  const pageDeps: PageDeps = {
    kb,
    // 命令层开事务：装配层补撤销快照（零 op 的事务不记——没写东西就没有可撤销的），
    // 并重画这批改动碰到的行（标签 chip／别名头住在一行自己的 DOM 里，等整页重渲染就晚了）
    run: (fn) => {
      const before = blocks.snap(deps.getEd().sel)
      const r = txRun(fn, deps.getMainEd())
      if (r.ops.length > 0) blocks.record(before, 'other', Date.now())
      for (const id of new Set(r.changes.filter((c) => c.kind === 'blocks').map((c) => c.id))) repaintBlock(id)
      scheduleSave()
      scheduleBadge()
      return r
    },
    removeBlock: (id) => {
      // 删页：整棵子树原位标记（软删）。走 `run` 是为了产出 op —— 命令层只声明「删这块」，
      // 打标记由事务那一份实现负责（一条 op，只落操作根）。
      run((tx) => tx.remove(id), deps.getMainEd())
    },
    insertBlock: (block, parentId, index) => {
      // 与 `removeBlock` 对称的结构写入口：插一棵子树（含自带的首子块），
      // op 由事务产出——每个后代报它们自己的 parent/index，换库后行行有落点。
      run((tx) => tx.insert(block, parentId, index), deps.getMainEd())
    },
    moveBlock: (blockId, parentId, index) => {
      /**
       * 一次移动 = **一条** `block.upsert{parent,index}`（`tx.move` 就是这么发的）。
       * 拆成「先删后插」会让 ⌘Z 只回一半，也会让指向这块的引用在中间那一刻指向空。
       *
       * ⚠️ 走 `pageDeps.run`（**带撤销快照**），不是注入的 `deps.run`：
       *    后者只跑事务、不记快照 ⇒ 移动能成功但 ⌘Z 撤不回来。
       *    「搬了回不去」比「搬错了」更糟，而它不会报错，只在用户按 ⌘Z 时显形。
       */
      pageDeps.run((tx) => tx.move(blockId, parentId, index))
    },
    // 打标签的落点：**当前光标那一块**（正文 vs 反链 footer 会切换 ⇒ 每次现取活动编辑器）
    caretBlockId: () => deps.getEd().caretBlock() ?? deps.getEd().rows()[0]?.block.id ?? null,
    /**
     * 写块属性走装配层这一条路：撤销快照、索引失效、通知其他视图、重画这一行、落盘
     * 都在 `writeProps` 那一处。这里只做转发。
     *
     * ⚠️ **不要再包一层补重画**：重画是「改这一块的属性」的固有部分（那一行的
     *    别名头、身份图标、gutter 标记都由 props 派生），不是某个调用方记得要加的一步。
     *    上面那样包过一次，属性命令那条路径就漏了，表现为「加了属性、模型有了、屏幕没变」。
     */
    write: writeProps,
    activeId: () => deps.getWs().activeId,
    setActiveId: (id, view) => {
      /**
       * **记录导航历史**：只有「真的换了落点（或视图形态）」且旧落点还在森林里才记。
       * 历史回放期间 `nav.lock` 为真 ⇒ 不再入栈，否则前进/后退会自己套自己。
       *
       * 位置状态在这里捕获（旧视图还在屏幕上）：
       *   · 历史点存**快照**（回放时要回到离开那一刻）；
       *   · 当前 tab 的 `viewStates` 也存一份（直接返回时用它最后一次的位置）。
       */
      initTabs()
      const tab = currentTab()
      const feed = view?.feed === true
      const ws = deps.getWs()
      const fromId = tab?.activeId ?? ws.activeId
      const fromFeed = tab?.feed ?? isFeedView()
      const sameView = feed === fromFeed
      if (!nav.lock && tab && (id !== fromId || !sameView) && findInForest(ws.blocks, fromId)) {
        const state = captureActive() ?? emptyViewState()
        nav.back.push({ id: fromId, feed: fromFeed, state })
        nav.forward = []
      }
      /**
       * 恢复意图：
       *   · `'saved'` ＝ 回到这个视图的最后位置（面包屑／左槽页／翻日）；
       *   · `'none'`  ＝ 明确从顶部开始（新建页）；
       *   · 省略       ＝ 不动 `pendingRestore`（历史回放已经放好了快照）。
       */
      if (view?.restore === 'saved' && tab) {
        if (!pendingFromHistory) {
          const saved = tab.viewStates.get(viewKey(id, feed, activeViewRootId(id)))
          pendingRestore = saved
            ? { state: saved, focus: view.focusRestore !== false, fallbackCaret: view.fallbackCaret === true }
            : null
        }
      } else if (view?.restore === 'none') {
        if (!pendingFromHistory) pendingRestore = null
      }
      if (tab) {
        tab.activeId = id
        tab.feed = feed
      }
      ws.activeId = id
      emitTabs()
    },
    rootIds: () => deps.getMainEd().doc.roots.map((b) => b.id),
    // 日记流装载的视图配置：偏好只读（写入走 core.journal/feed-layout），编辑器由装配层持有
    feedLayoutPref: () => deps.prefs().feedLayout,
    applyLayout: (mode) => {
      deps.getMainEd().setLayout(mode)
    },
    setShells: (cols) => {
      deps.getMainEd().setShells(cols)
    },
    focusDay: (date) => {
      const mainEd = deps.getMainEd()
      const target = firstEditableRoot(mainEd.doc.roots.find((b) => b.id === journalId(date)))
      editorEl.focus()
      if (target) mainEd.placeCaret(target.id, 0)
    },
    loadPage: (roots) => {
      loadRoots(roots)
    },
    /**
     * 重装当前这一屏（根不变）。
     *
     * 用途：切视图之后**装载形状**变了 —— 有激活视图时正文只画根行、children 交给视图宿主，
     * 切回大纲又要把子树放回正文。走同一条 `loadRoots` 才不会出现「两种重装」。
     */
    reloadPage: () => {
      loadRoots(deps.getMainEd().doc.roots.slice())
    },
    flush: () => {
      syncSections()
      saveNow()
    },
    saveNow,
    scheduleSave,
    refreshList: () => renderDocks(),
    refreshTitle: () => deps.getChrome().renderTitle(activeBlock(), activeTrail()),
    focusFirstBlock: () => {
      /**
       * 本次装载已经恢复了位置 ⇒ 不要再把光标放回首块（那会先闪到顶部，
       * 并且把「只滚没点」的返回变成「光标被拽到页首」）。
       */
      if (skipNextFocus) {
        skipNextFocus = false
        return
      }
      const mainEd = deps.getMainEd()
      /**
       * 首行是**当前对象自己**（页／日记／被聚焦块都是正文第一行）。
       *
       * ⚠️ 但 **journal 的首行是只读日期**⇒ 光标落到它的**第一个子块**。
       *    否则「回今日」后光标停在一个不可编辑的行上，用户以为打不了字。
       *    page / 被 zoom 的块没这个问题：那一行就是可编辑的页名／正文本身。
       * ⚠️ **先 focus 再 placeCaret**：反过来的话 `focus()` 会把光标重置到容器开头
       *    （Contenteditable 的默认行为），实测表现为「光标停在只读的日期行上」。
       */
      const first = mainEd.doc.roots[0]
      if (!first) return
      const target = firstEditableRoot(first)
      editorEl.focus()
      if (target) mainEd.placeCaret(target.id, 0)
    },
    openInDock: (id) => deps.openInDock(id),
    openInNewTab: (id, feed) => openInNewTab(id, feed),
    focusBlock: (blockId, offset = 0) => {
      const mainEd = deps.getMainEd()
      deps.setEd(mainEd)
      // 换块聚焦先结掉上一块的编辑期（与 `app.focusBlock` 同一条判据）
      const prev = mainEd.sel?.aBlock ?? mainEd.caretBlock()
      if (prev && prev !== blockId) mainEd.commitEdit(prev)
      editorEl.focus()
      mainEd.placeCaret(blockId, offset)
    },
    /**
     * 确保侧槽开着：已经开着就什么都不做（**不写 prefs**，也就不会把
     * 「没变化」记成一次设备变更）。
     *
     * 走命令而不是直接改 `prefs`：开槽要连带 `applyChrome`（列宽/边框/可见性）
     * 与设备落盘，那是 `core.dock/toggle-*` 那一份的职责，这里再写一遍就会分叉。
     */
    openDock: (side) => {
      if (deps.prefs().dock[side].open) return
      void deps.getRegistry().invoke(side === 'left' ? 'core.dock/toggle-left' : 'core.dock/toggle-right', {}, 'view')
      deps.scheduleBadge()
    },
    ensureDockCard: (side, id) => deps.ensureDockCard(side, id),
    toast: (text, kind) => deps.getApp().toast(text, kind),
    openRefPicker: (rows, onPick, title) =>
      layers.openMenu({
        rows,
        anchor: deps.getEd().caretRect(),
        title: title ?? t('menu.title.refPicker'),
        searchable: true,
        focusSearch: true,
        emptyText: t('ui.refPicker.empty'),
        onPick:
          onPick ??
          ((row) => {
            /**
             * 行自带 `command` ＋ `args` 就分发那条命令；没带 `command` 的行
             * （页/标签引用候选）按引用插入这条走。分发而不是在调用方手写插入：
             * 命令路径里有撤销快照与重排，手写的那份只写模型不画 —— 「点了没反应」。
             */
            const args = (row.args ?? {}) as Record<string, unknown>
            deps
              .getRegistry()
              .invoke(row.command ?? 'core.editor/insert-page-ref', args, 'menu', uiCtx())
          }),
      }),
    pageTitle,
    pageIcon,
  }

  /**
   * 前进 / 后退：从栈里取一个**仍然存在**的落点，再用「聚焦到此块」那条命令换当前对象。
   *
   * 为什么走命令而不是直接 `setActiveId`：zoom、面包屑、链接点击、历史回放必须是
   * **同一条**换落点路径（刷新列表/标题/面包屑/落盘都在里面）；再写一份就分叉了。
   * ⚠️ 回放期间 `nav.lock` 必须为真，否则 `setActiveId` 会把这次回放又记成一条新历史。
   */
  function historyGo(dir: 'back' | 'forward'): boolean {
    initTabs()
    const tab = currentTab()
    if (!tab) return false
    const from = dir === 'back' ? nav.back : nav.forward
    const to = dir === 'back' ? nav.forward : nav.back
    while (from.length > 0) {
      const point = from.pop()!
      const feed = tab.feed
      // 同 id 但形态不同（feed ↔ 单日）也是一次真实导航，不能跳过
      if (point.id === tab.activeId && point.feed === feed) continue
      if (!findInForest(deps.getWs().blocks, point.id)) continue // 目标在历史里被删了：跳过，别把人送到空处
      const state = captureActive() ?? emptyViewState()
      to.push({ id: tab.activeId, feed, state })
      /**
       * 历史点带回离开那一刻的 `state`：
       *   · 有选区 ⇒ 回放时把焦点与光标一起交回正文；
       *   · 只是浏览（`sel === null`）⇒ 只回视口，不凭空造光标，也不抢焦点。
       * 没有 `state` 的旧历史点退回旧行为（`focusFirstBlock`）。
       */
      pendingRestore = point.state
        ? { state: point.state, focus: Boolean(point.state.sel), fallbackCaret: false }
        : null
      pendingFromHistory = true
      nav.lock = true
      try {
        void deps.getRegistry().invoke('core.block/focus-block', { blockId: point.id, feed: point.feed }, 'history')
      } finally {
        nav.lock = false
        // 目标无效／命令早退时没有 loadRoots 消费它：别把「历史恢复」的意图留给下一次导航
        if (pendingFromHistory) {
          pendingFromHistory = false
          pendingRestore = null
        }
      }
      scheduleBadge()
      return true
    }
    return false
  }

  return {
    pageDeps,
    activeBlock,
    activeTrail,
    pageTitle,
    nav,
    historyGo,
    firstEditableRoot,
    materializeEditableRoots,
    // —— tab（装配层画 tab 条、命令层开/关/切换）——
    initTabs,
    resetTabs,
    listTabs,
    activateTab,
    openInNewTab,
    newTab,
    closeTab,
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    canGoBack: () => nav.back.length > 0,
    canGoForward: () => nav.forward.length > 0,
    /** 块改名/切换后 tab 标题要跟上（装配层的 change 钩子调它） */
    refreshTabs: emitTabs,
  }
}
