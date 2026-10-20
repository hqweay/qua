/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { ensureFirstBlock, ensureTodayJournal, favoritesContainers, findInForest, findPath, flatten, FEED_INITIAL, FEED_MAX, FEED_STEP, isJournal, isQueryBlock, journalDate, journalFeedDays, prop, resolveRef, tagMemberIds, todayISO, type Atom, type Block, type CtxKeys } from './core/index.ts'
import { BlockStore } from './core/store.ts'
import { BlockEditor } from './view/editor.ts'
import {
  BINDINGS,
  keyLabel,
  resolveBindings,
} from './core/bindings.ts'
import {
  Registry,
  type App,
  type DemoState,
  type MenuRequest,
  type PanelKind,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type Row } from './ui/layers.ts'
import { dispatchKey, installKeydown, type DispatchEnv } from './core/dispatch.ts'
import { applyDockVisibility, mountDockSlot } from './ui/dock.ts'
import { renderBackrefsInto, renderFavoritesInto, type DockContentDeps } from './ui/dock-content.ts'
import { BacklinksView } from './ui/backlinks.ts'
import { QueryView } from './ui/query-view.ts'
import { createChrome } from './ui/chrome.ts'
import { isReadonlyBlock } from './view/block-dom.ts'
import { createIcon } from './view/icons.ts'
import { createBadge, type BadgeSnapshot } from './ui/badge.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type PanelDeps } from './ui/panels.ts'
import { demoCommands, favoritesCommands, journalCommands, pageCommands, rootsFor, rootsForMany, viewCommands, zoomCommands, type PageDeps } from './app/commands-impl.ts'
import { HANDLERS } from './app/handlers.ts'
import { darkQuery, resolveTheme } from './core/theme.ts'
// 用户可见文案一律走 t；字典是零依赖叶子，Electron 主进程也 import 同一份
import { t } from './core/msg.ts'
import { seedWorkspace } from './core/seed.ts'
import {
  createLocalStorageAdapter,
  createWorkspaceStore,
  STORAGE_KEY,
  WHOLE_LIBRARY_CHANGES,
  type Change,
  type Prefs,
  type ThemeMode,
  type Workspace,
} from './core/workspace.ts'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

/** 页名：**只读投影**（中间没有页标题，页名就是那个块的正文） */
const stateMenuBtn = $('state-menu-btn')


/* ------------------------------------------------------------ 状态 */

/**
 * **存储端口**：装配层是它的唯一持有者。
 * 换后端（内核 SQLite／主进程单写者）只换这一行，上层一行不改。
 */
const store = createWorkspaceStore(createLocalStorageAdapter(STORAGE_KEY))

/**
 * 读盘**是异步的**（71.5 第 2 条：上层不得依赖同步返回）。
 * 入口在文件末尾 `await` —— 模块顶层 await 在 Electron renderer / vite 下都没问题。
 */
const boot = await store.load()
/**
 * 读盘结果分型：
 *   · `empty` / `expired` ⇒ 允许 seed 并落盘；
 *   · `too-new` / `corrupt` / `storage-error` ⇒ **只读演示态**，绝不覆盖原数据。
 *
 * ⚠️ 旧实现是 `loadWorkspace() ?? seedWorkspace()` 后立刻 save：读失败一次就把用户库覆盖了。
 */
const readOnly = boot.status === 'too-new' || boot.status === 'corrupt' || boot.status === 'storage-error'
let ws: Workspace = boot.status === 'ok' ? boot.ws : seedWorkspace()
let bootNotice: string | null = null
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
if (boot.status === 'too-new') bootNotice = t('ui.boot.tooNew', { version: boot.version })
else if (boot.status === 'corrupt') bootNotice = t('ui.boot.corrupt')
else if (boot.status === 'storage-error') bootNotice = t('ui.boot.storageError')
else if (boot.status === 'expired') bootNotice = t('ui.boot.expired', { version: boot.version })
// 开发者日志（英文，不走 msg 字典）：排查「为什么是只读态」时这是唯一的第一手线索
if (readOnly) console.warn('[boot] read-only demo state:', boot.status)

/**
 * 冷启动的**落点**：从没存过 / 旧库作废 ⇒ 进**今日**。
 *
 * ⚠️ **读到的正常库不抢 activeId**（2026-10-20 修）：原先无条件 `ensureTodayJournal` 覆盖
 *   `ws.activeId`，于是「昨天在稀疏态那一页打字 → 关页重开」后落点是今日、那页的字看起来全没了
 *   （盘上有，只是没被打开 = 另一种静默丢数据）。今日只负责**存在**，不负责**抢焦点**。
 * ⚠️ 旧形状的库（升级前没有 journal）也必须能直接进今日——否则用户找不到入口：
 *   2026-10-19 实机复现「旧存储冷启动后左槽没有『今日』、中心槽还停在旧页上」。
 * ⚠️ 这两条**会写模型**（幂等物化），所以要在装配编辑器之前做，且落盘一次。
 */
const activeStillExists = Boolean(findInForest(ws.blocks, ws.activeId))
const todayId = ensureTodayJournal(ws.blocks)
if (boot.status !== 'ok' || !activeStillExists) ws.activeId = todayId
/**
 * **冷启动装哪几段**：日记流＝「今日 ＋ 存在的更早的天」，**装什么按落点的角色分叉**。
 * ⚠️ 原来是「无条件装日记流」：于是任何非 journal 的落点（页 / 稀疏态那种 page 块）都被
 *    `bootDays` 盖住，编辑落进一个「不是任何块的孩子」的数组 ⇒ 写不回森林（已知风险 3）。
 * ⚠️ 两条路径都只用 `rootsFor` 那条规则：journal ⇒ 每段保证有可编辑子块（否则打得开却打不了字）；
 *    别的块 ⇒ 只要**那一个**。
 * ⚠️ 这里就地找落点、不走 `activeBlock()`：后者是后文才声明的（装配阶段的时序）。
 */
const bootActive = findInForest(ws.blocks, ws.activeId) ?? ws.blocks[0]
const bootDays = bootActive?.role === 'journal' ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
for (const day of bootDays) ensureFirstBlock(day.children)
const bootRoots: Block[] = bootDays.length > 0 ? rootsForMany(bootDays) : bootActive ? rootsFor(bootActive) : []

/**
 * **共享 block store**（下一层）：块/anchors/undo 只有一份；
 * 正文、反链、查询视图都是它的投影。多个 `BlockEditor` 读同一份活块。
 */
const blocks = new BlockStore(ws.blocks, ws.marks, ws.atoms)

const layers = new Layers(() => isMac())
let ed: BlockEditor
/** 中心槽的主编辑器；`ed` 是「当前活动编辑器」（正文或反链 footer） */
let mainEd: BlockEditor
let backlinksView: BacklinksView | null = null
let queryView: QueryView | null = null
/** 当前正文里那个查询块（没有 ⇒ `null`，视图整段隐藏） */
let queryBlock: Block | null = null
let registry: Registry
let saveTimer: number | null = null
let slashOpen = false
let lastSlashQuery = ''
/** 截图/自检时静音 toast（产品行为不变，只是不弹提示） */
let quiet = false

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
/** 短 id：uuidv7 前 12 位是时间戳（同一毫秒创建的块会撞），所以要短就取**尾部随机段** */
const shortId = (id: string): string => id.slice(-6)
const prefs = (): Prefs => ws.prefs
/**
 * 「当前对象」＝ 中心槽持有的那个块（只有中心槽有这个概念）。
 *
 * ⚠️ 它**不只是页**：`journal` 也是中心槽的默认内容；zoom 之后还能是
 *   **任意深度的块**⇒ 必须在**整片森林**里找，不能只看顶层。
 */
const activeBlock = (): Block => findInForest(ws.blocks, ws.activeId) ?? ws.blocks[0]!

/**
 * zoom 的面包屑：**派生**，不入库、不物化（不引入焦点栈）。
 * 路径含「当前对象」自己 ⇒ 去掉末尾就是祖先链。
 */
const activeTrail = (): Block[] => {
  const path = findPath(ws.blocks, ws.activeId)
  return path ? path.slice(0, -1) : []
}
/** 页名 ＝ 页块自己的正文；空则交给调用方做兜底文案 */
const pageTitle = (p: Block): string => p.text
/** 页图标 ＝ 系统属性 `_icon`；空值用 `file`，与 `view/icons.ts` 的角色默认一致 */
const pageIcon = (p: Block): string => prop<string>(p, '_icon') ?? 'lucide:file'

/* ------------------------------------------------------------ 主题档位 */

/** 系统外观：只用来**记账与诊断**，颜色本身由 CSS 决定 —— 不做 JS 切类 */
const resolvedTheme = (): 'light' | 'dark' => resolveTheme(prefs().theme, darkQuery.matches)
/** 启动完成前不碰 DOM 诊断（`ed` 还没建好） */
let booted = false

// **监听系统外观**的缺口）：只同步诊断与按钮文案 ——颜色由 CSS 的
// `@media (prefers-color-scheme: dark)` ＋ `light-dark()` 决定，**这里一行切类都不做**。
darkQuery.addEventListener('change', () => {
  chrome.renderDebugState()
  if (booted) scheduleBadge()
})

/* ------------------------------------------------------------ 键位提示 */

function keyHints(): Map<string, string> {
  const m = new Map<string, string>()
  for (const b of BINDINGS) {
    if (b.kind !== 'keymap' || !b.key) continue
    if (!m.has(b.command)) m.set(b.command, keyLabel(b.key, isMac()))
  }
  return m
}

/* ------------------------------------------------------------ 上下文键 */

/** 编辑器上下文键 ＋ 界面上下文键（同一张 when 用的键空间，：开放、可扩展） */
function uiCtx(): CtxKeys {
  const ctx: CtxKeys = {
    ...ed.ctxKeys(),
    blockSelection: ed.hasBlockSelection(),
    blockSelectionCount: ed.blockSelectionCount(),
    paletteOpen: layers.open,
    drawerOpen: layers.drawerOpen(),
    popoverOpen: layers.popoverOpen(),
    // ⚠️ 「页数」只数 `page` 角色（journal 也是一块，但它不是页 —— ）
    pageCount: ws.blocks.filter((b) => b.role === 'page').length,
    pageTitleEmpty: pageTitle(activeBlock()).trim() === '',
    // 日记：`journalView` 是**真上下文键**（不是 if），`journalDate` 供前后翻日用
    journalView: activeBlock().role === 'journal',
    journalDate: activeBlock().role === 'journal' ? (prop<string>(activeBlock(), '_date') ?? '') : '',
    isMac: isMac(),
  }
  return ctx
}

/* ------------------------------------------------------------ 持久化 */

/**
 * 把编辑器里的模型写回森林（**N 个真实 section**）。
 *
 * 现在块是 **block store 里的活引用**（`rootsFor` 不再拷贝）：正文/子树的编辑直接发生在
 * store 上，多个视图共享同一份。这里只把库级的 marks/atoms 引用对齐（它们也是共享数组）。
 *
 * ⚠️ 真实实现里这里是 Tx/Changes 的提交点；demo 提交的是整份库（见 `WHOLE_LIBRARY_CHANGES`）。
 */
function syncSections(): void {
  ws.marks = blocks.marks
  ws.atoms = blocks.atoms
}

let saveFailureShown = false

/** 保存失败**必须让用户看见**（Electron 里 console 是隐形的）；同一次会话只提示一次，避免刷屏 */
function warnSaveFailed(error: unknown): void {
  if (saveFailureShown) return
  saveFailureShown = true
  const text = t('ui.boot.saveFailed', { message: errText(error) })
  if (!quiet) layers.toast(text, 'warn')
  // 持久告警：toast 会消失，但「这次没写进去」必须一直可见
  chrome.showNotice(text)
}

/**
 * **提交一次**（异步、批次）：经过 `StoragePort`，失败如实返回。
 * 上层只认「这批改动落盘了没有」——不认「整份库写进去了没有」。
 */
function persist(changes: Change[]) {
  if (readOnly) return Promise.resolve({ ok: true as const })
  syncSections()
  ws.savedAt = Date.now()
  return store.commit(ws, changes)
}

/** 编辑期落盘的防抖窗口：连打时只提交最后一批（批次语义见 `StoragePort`） */
const SAVE_DEBOUNCE_MS = 250

function saveNow(): void {
  if (readOnly) return
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  void persist(WHOLE_LIBRARY_CHANGES).then((saved) => {
    if (!saved.ok) warnSaveFailed(saved.error)
  })
}

function scheduleSave(): void {
  if (readOnly) return
  syncSections()
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(saveNow, SAVE_DEBOUNCE_MS)
}

/**
 * `beforeunload` 里**等不到 Promise**（71.5：等待点由调用方决定）。
 * 所以把仓库生命周期的两个真实等待点接上：页面隐藏时 `settle()`；
 * 卸载前把待提交的那批**立刻发出去**（适配器内部是同步 `setItem`，发出即落盘）。
 */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    saveNow()
    void store.settle()
  }
})
window.addEventListener('pagehide', () => saveNow())

/* ------------------------------------------------------------ 渲染 */


/**
 * 把偏好写进 `body[data-*]`：主题档位、三槽开关。
 *
 * ⚠️ 这里**只写属性，不改 DOM 形状**（门禁 5：换肤前后 `data-depth` 序列一致）。
 * ⚠️ `data-theme` 记的是**档位**（system/light/dark），不是解析后的亮暗 —— 颜色由 CSS 取。
 * ⚠️ **不再有 `data-skin`**：内建只有一种样式，观感调 token 即可。
 */
function applyChrome(): void {
  document.body.dataset.theme = prefs().theme
  document.body.dataset.themeMode = prefs().theme
  applyDockVisibility({ left: prefs().dock.left.open, right: prefs().dock.right.open })
}

/* ------------------------------------------------------------ 槽内容 */

/**
 * 槽内容依赖：**清单形式**列出装配层交给 UI 的能力，UI 不认识 `ws`／`registry`。
 * 全是读函数（库会被 `loadState` 整体替换，传值会拿到过期快照）。
 */
const dockDeps: DockContentDeps = {
  blocks: () => ws.blocks,
  activeId: () => ws.activeId,
  atoms: () => ws.atoms,
  openPage: (id) => void registry.invoke('core.page/open', { pageId: id }, 'menu'),
  newPage: () => void registry.invoke('core.page/new', {}, 'dock'),
  // 收藏容器块：容器就是一个带 `favorites` 角色的普通块
  favoriteContainers: () => favoritesContainers(ws.blocks),
  removeFavorite: (containerId, blockId) =>
    void registry.invoke('core.favorites/remove', { containerId, blockId }, 'dock'),
}

/** 重画两个侧槽（页列表变了、切换了当前页、或反链变了） */
function renderDocks(): void {
  renderFavoritesInto(dockDeps, dockLeft)
  renderBackrefsInto(dockDeps, dockRight)
}

/* ------------------------------------------------------------ chrome 组件 */

/**
 * 中心槽的 chrome（页名 + 空态提示 + 编辑器挂载点）。
 * ⚠️ **组件自持 DOM**：这之后 `main.ts` 里不再出现那些元素的 `getElementById`。
 * ⚠️ 皮肤/主题那两个开关**不在这里**（2026-10-20 撤出顶栏，挪进调试菜单）。
 */
const chrome = createChrome((blockId) => {
  // 面包屑一格 ＝「聚焦到这个祖先」：与 zoom in **同一个命令**，只是目标不同
  registry.invoke('core.block/focus-block', { blockId }, 'chrome')
})

const editorEl = chrome.editorEl

// 读盘异常 / 首屏保存失败：持久告警常驻，不随 toast 消失
if (bootNotice) chrome.showNotice(bootNotice)

/* ------------------------------------------------------------ 角标（诊断面） */

const badge = createBadge({
  shortId,
  snapshot: (): BadgeSnapshot => {
    const page = activeBlock()
    return {
      ...domStats(),
      mounted: mainEd.mounted.size,
      virtualize: mainEd.virtualize,
      radius: mainEd.radius,
      theme: prefs().theme,
      composing: mainEd.probe.isComposing,
      compositionSeq: mainEd.probe.compositionSeq,
      selection: mainEd.sel,
      blockSelection: mainEd.hasBlockSelection(),
      blockSelectionCount: mainEd.blockSelectionCount(),
      marks: mainEd.marks.length,
      atoms: mainEd.atoms.length,
      undoDepth: mainEd.undo.depth(),
      redoDepth: mainEd.undo.redoDepth(),
      lastCommand: registry.last,
      pageTitle: pageTitle(page),
      pageCount: ws.blocks.length,
      storageKB: JSON.stringify(ws).length / 1024,
      savedAt: ws.savedAt,
      ctx: uiCtx(),
      keyTrace: mainEd.probe.keyTrace,
    }
  },
})

const scheduleBadge = badge.schedule

/* ------------------------------------------------------------ 浮层渲染 */

function rowsForSlash(query: string): Row[] {
  return rowsFromBindings(resolveBindings('slash', uiCtx(), { query }), keyHints(), { showKeywords: true })
}

/**
 * 划选气泡：**选区存在就在它上方浮一排格式按钮，选区塌了就消失**。
 *
 * 这是「顶部工具栏」的替代品（2026-10-19）。为什么改成这样：
 *   · 中性现代的口径是 chrome 极弱 —— 一排常驻按钮是**最重**的 chrome；
 *   · 加粗/高亮这类命令**只对选区有意义**（光标态按下去没有任何效果），
 *     常驻等于长期摆着几个点不动的按钮；把「有没有选区」做成**唯一开关**，
 *     可用性靠 `when` 表达（承 §1.3：「这次怎么显示」归查询/绑定，不是给块加字段）。
 *
 * ⚠️ 气泡**不进 `layers.open`**（那是菜单/命令面板的模态状态）：它在的时候用户还能打字，
 *    Esc 也不该关它 —— 关它的唯一条件是「选区没了」。
 */
function refreshSelectionBar(): void {
  const ctx = uiCtx()
  const rows = rowsFromBindings(resolveBindings('selection', ctx), keyHints())
  const rect = ed.selectionRect()
  // 气泡开着时不要被「菜单打开」这类状态误关：选区还在就该在
  if (rows.length === 0 || !rect) {
    layers.closeSelectionBar()
    return
  }
  const activeMarks = new Set(ed.marksAtSel().map((m) => m.type))
  layers.openSelectionBar({
    rows,
    anchor: rect,
    activeMarks,
    onPick: (row) => {
      if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'selection', ctx)
      // 命令改了格式 ⇒ 气泡的**按压态**要跟着变（高亮那颗该亮起来）。
      // 不重刷的话，点完加粗按钮看不出"已经加粗了"。
      refreshSelectionBar()
    },
  })
}

function showMenu(req: MenuRequest): void {
  const ctx = req.ctx ?? uiCtx()
  if (req.kind === 'palette') {
    const rows = paletteRows(registry.list(), keyHints())
    layers.openMenu({
      rows,
      anchor: null,
      title: req.title ?? t('menu.title.palettePlain'),
      searchable: true,
      focusSearch: true,
      placeholder: t('ui.palette.placeholder'),
      emptyText: t('ui.palette.empty'),
      onPick: (row) => {
        if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'palette', ctx)
      },
    })
    return
  }
  if (req.kind === 'menu') {
    const rows = rowsFromBindings(resolveBindings('menu', ctx, { prefix: req.prefix }), keyHints())
    layers.openMenu({
      rows,
      anchor: req.anchor,
      title: req.title,
      searchable: false,
      focusSearch: false,
      onPick: (row) => {
        req.before?.()
        if (req.onPick) req.onPick(row, row.command ? registry.decl(row.command) : undefined)
        else if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'menu', ctx)
      },
    })
    return
  }
  if (req.kind === 'slash') {
    slashOpen = true
    lastSlashQuery = req.query ?? ''
    layers.openMenu({
      rows: rowsForSlash(lastSlashQuery),
      anchor: req.anchor,
      title: req.title ?? t('menu.title.slashFilter'),
      searchable: false,
      focusSearch: false,
      emptyText: t('ui.slash.empty'),
      onPick: (row) => {
        const id = ed.caretBlock()
        if (id) ed.dropSlashQuery(id)
        slashOpen = false
        if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'slash', uiCtx())
      },
      onClose: () => {
        slashOpen = false
      },
    })
  }
}

/* ------------------------------------------------------------ 浮层（转发到 ui/panels） */

/**
 * 面板依赖：这里是**唯一**把 `ws`/`ed`/`registry` 交给 UI 组件的地方。
 * ⚠️ 这样 UI 组件不需要认识这些具体对象，装配层也不必知道面板里画什么。
 */
const panelDeps: PanelDeps = {
  ctx: () => uiCtx(),
  isMac: () => isMac(),
  shortId,
  decl: (name) => registry.decl(name),
  page: () => activeBlock(),
  roots: () => mainEd.doc.roots,
  marks: () => mainEd.marks,
  atoms: () => mainEd.atoms,
  findBlock: (id) => ws.blocks.find((p) => p.id === id),
  openPage: (id) => void registry.invoke('core.page/open', { pageId: id }, 'menu'),
  removeAtom: (id) => void registry.invoke('core.editor/remove-atom', { atomId: id }, 'popover'),
  closePopover: () => layers.closePopover(),
  openPopover: (render, anchor) => layers.openPopover(render, anchor),
  openDrawer: (title, render) => layers.openDrawer(title, render),
}

const showAtomPopover = (a: Atom, rect: DOMRect): void => panelPopover(panelDeps, a, rect)
const openDrawerFor = (kind: PanelKind): void => panelDrawer(panelDeps, kind)

/* ------------------------------------------------------------ 键位派发（接线） */

/**
 * 派发的环境。**这里只有接线，没有逻辑**（逻辑在 `dispatch.ts`）。
 * `trace` 写回编辑器的探针队列 ——那是「按键命中追踪」诊断的数据源（59 ）。
 */
const dispatchEnv: DispatchEnv = {
  ctx: uiCtx,
  isMac,
  invoke: (name, args, ctx) => registry.invoke(name, args, 'keymap', ctx).handled,
  layerOpen: () => layers.open,
  trace: (tr) => {
    if (!ed.probe.traced) return
    ed.probe.keyTrace.push(tr)
    if (ed.probe.keyTrace.length > 40) ed.probe.keyTrace.shift()
    scheduleBadge()
  },
}

installKeydown(dispatchEnv, { editorEl })

/* ------------------------------------------------------------ App 的工厂依赖 */

/**
 * **第一个可编辑的行**：journal 的首行是**只读日期**（`contenteditable=false`），
 * 不能接光标 ⇒ 取它的第一个子块。页 / 被 zoom 的块没这个问题：那一行就是页名／正文本身。
 *
 * ⚠️ 为什么抽成一处：冷启动落点、回今日、翻日、zoom 用的是**同一条**规则；
 *    写两份就会立刻分叉（2026-10-20 实际发生过：末尾的「首屏落光标」那段还在指首行，
 *    把 `focusFirstBlock` 设好的光标又覆盖回只读日期行）。
 */
function firstEditableRoot(first: Block | undefined): Block | null {
  if (!first) return null
  return isReadonlyBlock(first) ? (first.children[0] ?? null) : first
}

/**
 * 页与日记**共用同一份依赖**（`PageDeps`）：两者都是「一块 ＋ 一棵子树」，
 * 只是角色不同 ——各给一套依赖就会立刻出现两条分叉的实现路径（要消灭的正是这个）。
 *
 * ⚠️ 依赖一律是**读函数**而不是值：库会被 `loadState` 整体替换，传值会拿到过期快照。
 */
const pageDeps: PageDeps = {
  blocks: () => ws.blocks,
  // ⚠️ 每次取**当前**活动编辑器（正文 vs 反链 footer 会切换）⇒ 标签打在用户正在编辑的那一行
  insertAtom: (kind, opts) => ed.insertAtom(kind, opts),
  activeId: () => ws.activeId,
  setActiveId: (id) => {
    ws.activeId = id
  },
  loadPage: (roots, marks, atoms) => {
    ed = mainEd
    mainEd.loadPage({ roots }, marks as never, atoms as never)
    renderBacklinks()
    renderQueryView()
  },
  marks: () => ws.marks,
  atoms: () => ws.atoms,
  flush: () => {
    syncSections()
    saveNow()
  },
  saveNow,
  scheduleSave,
  refreshList: () => renderDocks(),
  refreshTitle: () => chrome.renderTitle(activeBlock(), activeTrail()),
  focusFirstBlock: () => {
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
  toast: (text, kind) => app.toast(text, kind),
  openRefPicker: (rows) =>
    layers.openMenu({
      rows,
      anchor: ed.caretRect(),
      title: t('menu.title.refPicker'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.refPicker.empty'),
      onPick: (row) => {
        registry.invoke('core.editor/insert-page-ref', { pageId: (row.args as { pageId: string }).pageId }, 'menu', uiCtx())
      },
    }),
  pageTitle,
  pageIcon,
}

/* ------------------------------------------------------------ App */

/**
 * `App` 门面：**四个工厂拼装**（页／日记／视图／演示），加上浮层与提示这几件装配层专有的能力。
 *
 * ⚠️ 这里仍然是**唯一**拼装点：本文件持有 `ws`／`ed`／`registry`，工厂只拿到「能做什么」。
 */
const app: App = {
  get ed() {
    return ed
  },

  ...pageCommands(pageDeps),
  // 日记与页共用同一份依赖（今日是落点，不是特例代码路径）
  ...journalCommands(pageDeps),
  ...zoomCommands(pageDeps),
  ...favoritesCommands(pageDeps),

  ...viewCommands({
    prefs: () => prefs(),
    applyChrome,
    renderDebugState: () => chrome.renderDebugState(),
    scheduleSave,
    scheduleBadge,
    toast: (text, kind) => app.toast(text, kind),
  }),

  ...demoCommands({
    replaceWorkspace: (next) => {
      ws = next
      const p = activeBlock()
      // ⚠️ 先解析 `p` 再 `blocks.reset`：`activeBlock()` 读的是**森林**（`ws.activeId`），
      //    重置之后再算就只剩「`ws.blocks[0]`」这条兜底，`sparse` 的 activeId 一旦不是首块就取错。
      blocks.reset(next.blocks, next.marks, next.atoms)
      ed = mainEd
      applyChrome()
      chrome.renderDebugState()
      renderDocks()
      chrome.renderTitle(activeBlock(), activeTrail())
      // 演示状态**不强制跳今日**（那是冷启动的行为）：用这个库自己的 activeId，
      // 否则切到「空态 / 稀疏态 / 降级态」时会看不到那几个状态本身。
      // ⚠️ 装载口径必须与 `openPage` 同一条规则（`rootsFor(p)`，见 commands-impl）。
      //    原来写的是 `ensureFirstBlock(p.children)`：普通页把子块装成 roots ⇒ 编辑落在
      //    「不是任何块的孩子」的数组里，写不回森林（已知风险 3）；空态页没有子块 ⇒ 编辑器空着。
      //    journal 需要「至少一个可编辑行」时由 `rootsFor` 自己补，这里不再分叉。
      const roots = rootsFor(p)
      mainEd.loadPage({ roots }, ws.marks, ws.atoms, { blockId: roots[0]?.id ?? '', off: 0 })
      renderBacklinks()
      renderQueryView()
      chrome.renderEmptyHint(activeBlock().children)
      saveNow()
      scheduleBadge()
    },
    prefs: () => prefs(),
    setVirtualize: (on, radius) => mainEd.setVirtualize(on, radius),
    scheduleSave,
    scheduleBadge,
    toast: (text, kind) => app.toast(text, kind),
    probeComposing: () => {
      const before = registry.log.length
      const fake = {
        key: 'Enter',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: () => {},
        stopPropagation: () => {},
        target: null,
        isComposing: true,
      } as unknown as KeyboardEvent
      ed.probe.isComposing = true
      ed.probe.compositionSeq.push('start')
      dispatchKey(fake, dispatchEnv) // 组合期：键位绑定自动不命中
      ed.probe.isComposing = false
      ed.probe.compositionSeq.push('end')
      return registry.log.length - before
    },
    compositionSeq: () => ed.probe.compositionSeq,
  }),

  /* ---- 浮层与提示（装配层专有）---- */
  toast: (text, kind = 'info') => {
    if (!quiet) layers.toast(text, kind)
  },
  showMenu,
  showPopover: (render, anchor) => layers.openPopover(render, anchor),
  closeLayers: () => {
    slashOpen = false
    layers.closeAll()
  },
  showPanel: (kind) => openDrawerFor(kind),
  copy: (text, label) => {
    void navigator.clipboard?.writeText(text).then(
      () => app.toast(label ?? t('ui.toast.copied')),
      () => app.toast(t('err.clipboardFailed'), 'warn'),
    )
  },
}

/** DOM 统计（角标与诊断面板的证据源） */
function domStats(): { blocks: number; domBlocks: number; domNodes: number } {
  return {
    blocks: flatten(mainEd.doc).length,
    domBlocks: editorEl.querySelectorAll('.blk').length,
    domNodes: editorEl.querySelectorAll('*').length,
  }
}

/* ------------------------------------------------------------ 编辑器装配 */

// ⚠️ 首屏就要把**当前页的 marks/atoms** 一起装进编辑器：少了它们，已存的行内原子
// 会被当成「未知原子」渲染成 dangling（持久化后重开最明显）。
ed = new BlockEditor({
  container: editorEl,
  // 「点空白建块」的监听面 = #doc：只监听 editorEl 的话，点它下方气口不触发
  blankArea: chrome.blankAreaEl,
  // 共享 store：块是活引用；marks/atoms/undo 也是共享的
  store: blocks,
  doc: { roots: bootRoots },
  marks: ws.marks,
  atoms: ws.atoms,
})
mainEd = ed
renderQueryView()
// 焦点在正文 → 活动编辑器＝正文；焦点在反链 footer 时由 BacklinksView 切过去
editorEl.addEventListener('focusin', () => {
  ed = mainEd
})

ed.events = {
  change: () => {
    syncSections()
    scheduleSave()
    chrome.renderEmptyHint(activeBlock().children)
    renderDocks() // 块数变了要更新
    scheduleBadge()
  },
  atomsLost: (atoms) => {
    app.toast(t('ui.toast.atomsLost', { labels: atoms.map((a) => a.label).join('、') }), 'warn')
  },
  // 划选气泡（顶部工具栏作废后的落点）：选区一变就重算「该不该在、装哪几颗」
  selChange: () => {
    refreshSelectionBar()
  },
  slashQuery: (q, rect) => {
    if (q === null) {
      if (slashOpen) {
        slashOpen = false
        layers.closeMenu()
      }
      return
    }
    if (slashOpen && layers.open) {
      if (q !== lastSlashQuery) {
        lastSlashQuery = q
        layers.setRows(rowsForSlash(q))
      }
      return
    }
    showMenu({ kind: 'slash', anchor: rect, query: q })
  },
  atomClick: (a, el) => showAtomPopover(a, el.getBoundingClientRect()),
  // **左键点块标 ＝ 聚焦/zoom**。与面包屑那一格同一条命令，
  // 所以「点块标进去」与「点面包屑出来」共用一套语义，没有第二种入口。
  focusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'editor'),
  blockMenu: (blockId, rect) => {
    // 命中**已选中的块**（且多块）⇒ 多块菜单；否则清块选区，走原单块菜单
    if (ed.inBlockSelection(blockId) && ed.blockSelectionCount() > 1) {
      showMenu({ kind: 'menu', prefix: 'blockSel/', anchor: rect, title: t('menu.title.blockSel') })
      return
    }
    ed.clearBlockSelection()
    ed.sel = { aBlock: blockId, aOff: ed.sel?.aBlock === blockId ? (ed.sel?.aOff ?? 0) : 0, hBlock: blockId, hOff: ed.sel?.aBlock === blockId ? (ed.sel?.hOff ?? 0) : 0 }
    showMenu({ kind: 'menu', prefix: 'block/', anchor: rect, title: t('menu.title.block') })
  },
}

/**
 * **反链 view block**（footer 版， 下一层）：挂的是共享 store 的活块，
 * 所以这里可以原地编辑；右槽以后挂同一个 view。
 */
backlinksView = new BacklinksView(
  {
    root: chrome.backlinksEl,
    editor: chrome.backlinksEditorEl,
    title: chrome.backlinksTitleEl,
    count: chrome.backlinksCountEl,
    refresh: chrome.backlinksRefreshEl,
  },
  {
    store: blocks,
    blocks: () => ws.blocks,
    targetId: () => ws.activeId,
    onChange: () => {
      syncSections()
      scheduleSave()
      scheduleBadge()
    },
    onFocus: () => {
      if (backlinksView) ed = backlinksView.editor
    },
    onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
  },
)

/** 页面/日记/zoom 装载后重查 footer 反链（target = activeId） */
function renderBacklinks(): void {
  backlinksView?.render()
}

renderBacklinks()

/**
 * **查询视图**（–D6）：挂在「当前正文里那个查询块」下面。
 *
 * 口径（承 A：**查询块＝数据侧**，不吃结果）：
 *   · 查询块自己只是大纲里的一行（正文＝它的名字，`_query` 里是条件）；
 *   · 结果是**外源渲染**，跟在它后面、**不 re-parent**（A/A）⇒ 刷新只改 `_queryResult`；
 *   · 正文里没有查询块 ⇒ 整段隐藏（不留死抬头）。
 */
queryView = new QueryView(
  {
    root: chrome.queryViewEl,
    editor: chrome.queryViewEditorEl,
    title: chrome.queryViewTitleEl,
    count: chrome.queryViewCountEl,
    refresh: chrome.queryViewRefreshEl,
    stale: chrome.queryViewStaleEl,
  },
  {
    store: blocks,
    blocks: () => ws.blocks,
    block: () => queryBlock ?? activeBlock(),
    onChange: () => {
      syncSections()
      scheduleSave()
      scheduleBadge()
    },
    onFocus: () => {
      if (queryView) ed = queryView.editor
    },
    toast: (text, kind) => app.toast(text, kind),
  },
)

/**
 * 找出**当前这一段**里的查询块并装载。
 *
 * ⚠️ 只认 `doc.roots` 那一层（及它的直接子块）：查询块是「这张页面里的一个块」，
 *    不是全库搜索结果——否则打开任意页都会突然冒出一个别处的查询视图。
 * ⚠️ 视图实例复用：换查询块时 `mount()` 重新冻结，不重建编辑器（否则 undo/选区全丢）。
 */
function renderQueryView(): void {
  if (!queryView) return
  const inRoots = mainEd.doc.roots.flatMap((r) => [r, ...r.children])
  const q = inRoots.find((b) => isQueryBlock(b))
  if (!q) {
    queryBlock = null
    chrome.queryViewEl.hidden = true
    return
  }
  const changed = queryBlock?.id !== q.id
  queryBlock = q
  chrome.queryViewEl.hidden = false
  if (changed) queryView.mount()
  else queryView.render()
}

/* ------------------------------------------------------------ 菜单的菜单 */

/**
 * 调试菜单：**正式软件不暴露的开关都在这里**（2026-10-20）。
 *
 * 原先甲乙丙／明暗是顶栏常驻按钮；正式软件不需要它们常驻，挪进调试菜单。
 * ⇒ 挪进这里。判据：**它是诊断面，不是产品面** —— 与右下角的角标同一性质
 * （`ui/badge.ts` 的注释已经写明「将来应当整体降级成一个可关的诊断插件」）。
 *
 * ⚠️ 入口按钮原先在 `index.html` 里带 `hidden` 且**没有任何代码取消它** ⇒ 是个死入口。
 *    现在让它默认可见，否则这些开关搬进来也点不到。
 * ⚠️ 命令仍然经 `registry.invoke`（不是直改 `prefs()`）：主题是真命令，
 * 走命令面才能撤销/审计/被机器接口调到（命令是唯一写入口，UI 只是它的一个调用者）。
 * ⚠️ **皮肤三行已删**：内建只有一种样式，`core.view/set-skin` 整条命令撤掉。
 */
stateMenuBtn.addEventListener('click', () => {
  const th = prefs().theme
  // 当前档位用图标位的 `check`（不用 hint：hint 会被推到行最右，离标签太远，读不出"这是勾选"）
  const pick = (on: boolean, icon: string): string => (on ? 'lucide:check' : icon)
  // ⚠️ 这两类的 hint 一律给**空串**：渲染器的兜底是「没有 hint ⇒ 显示命令名」，
  //    调试菜单里列 `core.view/set-theme` 只会挡视线（那是诊断信息，不是给用户看的）。
  const rows: Row[] = [
    { id: 'theme-system', label: t('ui.theme.mode.system'), hint: '', icon: pick(th === 'system', 'lucide:monitor'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'system' } },
    { id: 'theme-light', label: t('ui.theme.mode.light'), hint: '', icon: pick(th === 'light', 'lucide:sun'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'light' } },
    { id: 'theme-dark', label: t('ui.theme.mode.dark'), hint: '', icon: pick(th === 'dark', 'lucide:moon'), group: 'dbg/1-theme', command: 'core.view/set-theme', args: { mode: 'dark' } },
    // 演示状态
    { id: 'seed', label: t('ui.stateMenu.seed'), hint: t('ui.stateMenu.seedHint'), icon: 'lucide:book-open', group: 'dbg/2-state', command: 'core.demo/load-state', args: { state: 'seed' } },
    { id: 'degraded', label: t('ui.state.degraded'), hint: t('ui.stateMenu.degradedHint'), icon: 'lucide:triangle-alert', group: 'dbg/2-state', command: 'core.demo/load-state', args: { state: 'degraded' } },
    { id: 'sparse', label: t('ui.state.sparse'), hint: t('ui.stateMenu.sparseHint'), icon: 'lucide:square-dashed', group: 'dbg/2-state', command: 'core.demo/load-state', args: { state: 'sparse' } },
    { id: 'empty', label: t('ui.state.empty'), hint: t('ui.stateMenu.emptyHint'), icon: 'lucide:square', group: 'dbg/2-state', command: 'core.demo/load-state', args: { state: 'empty' } },
  ]
  layers.openMenu({
    rows,
    anchor: stateMenuBtn.getBoundingClientRect(),
    title: t('menu.title.debugMenu'),
    searchable: false,
    focusSearch: false,
    onPick: (row) => {
      if (row.command) registry.invoke(row.command, (row.args as Record<string, unknown>) ?? {}, 'menu', uiCtx())
    },
  })
})



document.addEventListener('mousedown', (e) => {
  const target = e.target as Node
  if (layers.popoverOpen() && !(target as HTMLElement).closest?.('.atom')) layers.closePopover()
})

window.addEventListener('beforeunload', () => saveNow())

/* ------------------------------------------------------------ 启动 */

registry = new Registry(app, HANDLERS)

// 让「块菜单」这类命令也能从面板/键盘走到
ed.events.mounted = () => scheduleBadge()

/** `index.html` 里只剩空壳：用户可见文案一律在启动时从字典灌进去 */
function paintStaticCopy(): void {
  document.title = t('app.title')
  // 三槽的抬头（槽里没有「我的库」这类导航外壳，标题只是槽自身的 chrome）
  stateMenuBtn.title = t('ui.debug.title')
  // 图标 ＋ 文案：图标走 view/icons.ts，按钮本身仍是一个普通 button（不是块）
  stateMenuBtn.replaceChildren(
    createIcon('sliders-horizontal', 'sm'),
    document.createTextNode(` ${t('ui.debug.button')}`),
  )
  // 调试入口默认可见：它是**死代码修好后的落点**（皮肤/主题/演示状态全靠它才点得到）
  stateMenuBtn.hidden = false
}

/**
 * 两条侧槽：**第 1 期右槽没有内容**（不加空侧栏 ⇒ 右槽默认不渲染）。
 * 左槽装的是「收藏容器块」，内容由 `renderDocks()` 填。
 */
const dockLeft = mountDockSlot($('dock-left'), {
  title: t('ui.dock.leftTitle'),
  collapseLabel: t('ui.dock.collapseLeft'),
  icon: 'lucide:chevron-left',
  onCollapse: () => registry.invoke('core.dock/toggle-left', {}, 'dock'),
})
const dockRight = mountDockSlot($('dock-right'), {
  title: t('ui.dock.rightTitle'),
  collapseLabel: t('ui.dock.collapseRight'),
  icon: 'lucide:chevron-right',
  onCollapse: () => registry.invoke('core.dock/toggle-right', {}, 'dock'),
})

paintStaticCopy()
applyChrome()
chrome.renderDebugState()
renderDocks()
chrome.renderTitle(activeBlock(), activeTrail())
chrome.renderEmptyHint(activeBlock().children)
if (prefs().virtualize) mainEd.setVirtualize(true, prefs().radius)
if (prefs().badgeOpen) badge.toggle(true)
badge.update()

/* ------------------------------------------------- 日记流下滚加载（P2） */

/**
 * 滚到接近底部 ⇒ 追加 `FEED_STEP` 天**存在的**更早日记；不造空天，上限 `FEED_MAX`。
 * 只对**日记流**生效（roots 全是 journal 且 >1）；单日页不加载。
 *
 * ⚠️ 视图状态（加载到第几屏）不入库；这里用「已加载的 root id 集合」判断，避免索引漂移。
 * ⚠️ `appendRoots` 会重建 DOM；调用期间用 `appending` 挡住重入的 scroll 事件。
 */
function appendMoreFeed(): boolean {
  const roots = mainEd.doc.roots
  if (roots.length <= 1 || !roots.every((r) => r.role === 'journal')) return false
  const active = activeBlock()
  if (!isJournal(active)) return false
  if (roots.length >= FEED_MAX) return false
  const loaded = new Set(roots.map((r) => r.id))
  const limit = Math.min(roots.length + FEED_STEP, FEED_MAX)
  const more = journalFeedDays(ws.blocks, journalDate(active), limit)
    .filter((d) => !loaded.has(d.id))
    .slice(0, limit - roots.length)
  if (more.length === 0) return false
  for (const day of more) ensureFirstBlock(day.children)
  mainEd.appendRoots(rootsForMany(more))
  return true
}

{
  let appending = false
  chrome.blankAreaEl.addEventListener(
    'scroll',
    () => {
      if (appending) return
      const el = chrome.blankAreaEl
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 120) return
      appending = true
      try {
        appendMoreFeed()
      } finally {
        appending = false
      }
    },
    { passive: true },
  )
}

booted = true

// 首屏填满：如果 3 天还撑不满视口（短日记），补到能滚为止 —— 否则「下滚加载」没有触发条件。
// 教训：初始只装 1 条连第一屏都撑不满，用户不会去「加载更多」。
requestAnimationFrame(() => {
  for (let i = 0; i < 6; i++) {
    const el = chrome.blankAreaEl
    if (el.scrollHeight > el.clientHeight + 8) break
    if (!appendMoreFeed()) break
  }
})

/* ------------------------------------------------------------ 给截图脚本/检查台的口子 */

const api = {
  snapshot() {
    const st = domStats()
    return {
      ...st,
      mounted: mainEd.mounted.size,
      marks: mainEd.marks.length,
      atoms: mainEd.atoms.length,
      theme: prefs().theme,
      resolvedTheme: resolvedTheme(),
      themeMode: prefs().theme,
      composing: mainEd.probe.isComposing,
      virtualize: mainEd.virtualize,
      activePage: pageTitle(activeBlock()),
      // ⚠️ 「页数」＝ `page` 角色的块数（journal 不算页）；顶层块总数另给 `topBlocks`
      pageCount: ws.blocks.filter((b) => b.role === 'page').length,
      topBlocks: ws.blocks.length,
      totalBlocks: flatten({ roots: ws.blocks }).length,
      journalDate: isJournal(activeBlock()) ? journalDate(activeBlock()) : '',
      undoDepth: mainEd.undo.depth(),
      redoDepth: mainEd.undo.redoDepth(),
      lastCommand: registry.last,
      selection: mainEd.sel,
      blockSelection: mainEd.hasBlockSelection(),
      blockSelectionCount: mainEd.blockSelectionCount(),
      hasLocalStorage: boot.status !== 'storage-error',
      readOnly,
      bootNotice,
      storageKind: store.kind,
    }
  },
  text() {
    return flatten(mainEd.doc).map((b) => b.text)
  },
  /**
   * **整片森林**（区别于 `blocks()`：那个只给当前视图装载的子树）。
   * 标签块挂在森林根上、不在当前页里 ⇒ 查「标签存不存在」必须用这个。
   */
  allBlocks() {
    return ws.blocks.map((b) => ({ id: b.id, text: b.text, role: b.role ?? null }))
  },
  /** 打了某个标签的块 id（标签的成员列表＝标签块的入向边） */
  tagMembers(tagId: string) {
    return [...tagMemberIds(tagId, mainEd.atoms)]
  },
  /** 删掉一个行内原子（**连同它占的那一格** ⇒ 那条边就没了） */
  removeAtom(atomId: string) {
    mainEd.removeAtom(atomId)
  },
  blocks() {
    return flatten(mainEd.doc).map((b) => ({
      id: b.id,
      text: b.text,
      todo: b.todo ?? null,
      collapsed: b.collapsed ?? false,
      children: b.children.length,
      // 角色进诊断面（journal 行是只读日期，测试要能把它挑出来）
      role: b.role ?? null,
    }))
  },
  marks() {
    return mainEd.marks.map((m) => ({ type: m.type, blockId: m.blockId, start: m.start, end: m.end }))
  },
  /**
   * ⚠️ `label` 与 `state` 这里给的是**解析后的**结果（不是落盘的快照）：
   *   探针要能回答「现在显示的是什么」，否则断言就只是在复读过期的 `atom.label`。
   */
  atoms() {
    return mainEd.atoms.map((a) => {
      const v = resolveRef((id) => mainEd.store.find(id), a)
      return { id: a.id, kind: a.kind, label: v.label, rawLabel: a.label, blockId: a.blockId, start: a.start, end: a.end, state: v.state, target: a.target ?? null }
    })
  },
  shortId: (id: string) => shortId(id),
  ctxKeys: () => uiCtx(),
  pages: () => app.listPages(),
  invoke: (name: string, args: Record<string, unknown> = {}, via = 'api') => registry.invoke(name, args, via, uiCtx()),
  commandLog: () => registry.log.map((l) => l.name),
  quiet: (v: boolean) => {
    quiet = v
  },
  setTheme: (mode: ThemeMode) => {
    prefs().theme = mode
    applyChrome()
    chrome.renderDebugState()
    scheduleSave()
    scheduleBadge()
  },
  loadState: (s: DemoState) => registry.invoke('core.demo/load-state', { state: s }, 'api'),
  focusBlock: (blockId: string, off = 0) => {
    ed = mainEd
    editorEl.focus()
    mainEd.placeCaret(blockId, off)
  },
  /**
   * 只把焦点给编辑器，**不动光标**。
   * ⚠️ 先 focus 再还原模型选区：`focus()` 在「此前没有焦点」时会把光标重置到容器开头
   *    （Contenteditable 默认行为）——boot 之后光标原本在正文首块，一 focus 就跳回只读的
   *    日期行，连带把 ⌘A 的全选范围也缩到那一行（2026-10-20 electron E5 实测）。
   */
  focus: () => {
    ed = mainEd
    const keep = mainEd.sel
    editorEl.focus()
    if (keep) mainEd.placeCaret(keep.aBlock, keep.aOff)
  },
  openPalette: () => registry.invoke('core.command-palette/show', {}, 'api'),
  openBlockMenu: (blockId: string) => {
    const el = ed.blockEl(blockId)
    showMenu({ kind: 'menu', prefix: 'block/', anchor: el?.getBoundingClientRect() ?? null, title: t('menu.title.block'), ctx: uiCtx() })
  },
  openSlash: () => showMenu({ kind: 'slash', anchor: ed.caretRect(), query: '' }),
  themeMode: () => prefs().theme,
  resolvedTheme: () => resolvedTheme(),
  openPanel: (kind: PanelKind) => openDrawerFor(kind),
  setVirtualize: (on: boolean, radius = 12) => app.setVirtualize(on, radius),
  badgePanel: (open: boolean) => badge.toggle(open),
  /**
   * 自检用：清掉落盘的那一份（**只清存储，不动当前内存库**）。
   * 演示状态切换不再调它：`loadState` 换库后会经由 `scheduleSave` 覆盖写，
   * 「先清后写」在异步批次下会多一次无谓的写序（曾是同步全量 save 时代的口径）。
   */
  clearStorage: () => void store.clear(),
  __editor: mainEd,
  __registry: registry,
  __layers: layers,
}

declare global {
  interface Window {
    __demo: typeof api
  }
}
window.__demo = api

// 首屏把光标放进**第一个可编辑的行**：打开就能敲（journal 首行是只读日期 ⇒ 跳过它）
{
  const target = firstEditableRoot(mainEd.doc.roots[0])
  if (target) mainEd.placeCaret(target.id, 0)
}
