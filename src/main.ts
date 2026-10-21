/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { addRole, aliasOf, allPropDefs, allTags, childTags, cleanableValues, clearValue, danglingParentIds, declaredFieldIds, declaredFields, ensureFirstBlock, ensureTodayJournal, favoritesContainers, fieldRows, findInForest, findPath, findByAlias, findPropDef, flatten, FEED_INITIAL, FEED_MAX, FEED_STEP, hasRole, isJournal, isQueryBlock, journalDate, journalFeedDays, memberBlocks, membersOf, normalizeAlias, parentTags, prop, propKindOf, propLabel, removeRole, resolveRef, tagMemberIds, todayISO, type Atom, type Block, type CtxKeys } from './core/index.ts'
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
import { applyDockVisibility, applyDockWidth, mountDockSlot } from './ui/dock.ts'
import { DockBlocks } from './ui/dock-blocks.ts'
import { bindDockResize } from './ui/dock-resize.ts'
import { renderBackrefsInto, renderFavoritesInto, type DockContentDeps } from './ui/dock-content.ts'
import { BacklinksView } from './ui/backlinks.ts'
import { PropertiesPanel } from './ui/properties.ts'
import { TagPanel } from './ui/tag-panel.ts'
import { QueryView } from './ui/query-view.ts'
import { createChrome } from './ui/chrome.ts'
import { isReadonlyBlock } from './view/block-dom.ts'
import { createIcon } from './view/icons.ts'
import { createBadge, type BadgeSnapshot } from './ui/badge.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type PanelDeps } from './ui/panels.ts'
import { demoCommands, favoritesCommands, journalCommands, pageCommands, propsCommands, rootsFor, rootsForMany, tagTreeCommands, viewCommands, zoomCommands, type PageDeps } from './app/commands-impl.ts'
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
const bootDays = bootActive && hasRole(bootActive, 'journal') ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
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

/**
 * **导航历史**（中心槽的「当前对象」先后）。与 undo/redo 是两套：
 *   · undo 管**数据**（块树/锚点/原子的快照）；
 *   · 这里管**走到哪**（打开页、点链接、zoom、面包屑都算一次导航）。
 *
 * 左右槽显式钉住、不跟随导航，所以历史只记中心槽的 `activeId`。
 * `lock` 用来区分「用户导航」与「历史本身在回放」——后者不能再入栈。
 */
const nav = { back: [] as string[], forward: [] as string[], lock: false }

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
  const focusId = ed.sel?.aBlock ?? ed.caretBlock()
  const focusBlock = focusId ? findInForest(ws.blocks, focusId) : undefined
  const focusName = focusBlock ? aliasOf(focusBlock).trim() : ''
  const ctx: CtxKeys = {
    ...ed.ctxKeys(),
    blockSelection: ed.hasBlockSelection(),
    blockSelectionCount: ed.blockSelectionCount(),
    paletteOpen: layers.open,
    drawerOpen: layers.drawerOpen(),
    popoverOpen: layers.popoverOpen(),
    // ⚠️ 「页数」只数 `page` 角色（journal 也是一块，但它不是页 —— ）
    pageCount: flatten({ roots: ws.blocks }).filter((b) => hasRole(b, 'page')).length,
    pageTitleEmpty: pageTitle(activeBlock()).trim() === '',
    // 块菜单里的角色开关（只看**当前聚焦块**；顺序无语义，只有「有没有」）
    blockHasPageRole: hasRole(focusBlock, 'page'),
    blockHasTagRole: hasRole(focusBlock, 'tag'),
    blockHasName: focusName !== '',
    // 日记：`journalView` 是**真上下文键**（不是 if），`journalDate` 供前后翻日用
    journalView: hasRole(activeBlock(), 'journal'),
    journalDate: hasRole(activeBlock(), 'journal') ? (prop<string>(activeBlock(), '_date') ?? '') : '',
    // 导航历史是否可走：键位表的 `when` 与命令面板的可用态都读这两个键
    canGoBack: nav.back.length > 0,
    canGoForward: nav.forward.length > 0,
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
  const appEl = $('app')
  applyDockWidth(appEl, 'left', prefs().dock.left.width, prefs().dock.left.open)
  applyDockWidth(appEl, 'right', prefs().dock.right.width, prefs().dock.right.open)
}

/**
 * 读一个 CSS 长度 token（`180px` → 180）。
 *
 * 回退值是**数字**而不是 `'180px'` 字面量（TS 里拼 px 会被门禁拦）；
 * 它只在样式没加载到（测试夹具/首帧）时兜底，正常路径永远读 token。
 */
function cssLength(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

/** 槽宽下限：token `--ui-dock-min` */
const dockMinWidth = (): number => cssLength('--ui-dock-min', 180)

/** 没拖过时的默认宽（与 CSS 的 `--ui-dock-w-*` 同源） */
const dockDefaultWidth = (side: 'left' | 'right'): number =>
  cssLength(`--ui-dock-w-${side}`, side === 'left' ? 236 : 320)

/**
 * 另一侧**当前占的宽度**：关着的槽不占列（与 CSS 的列宽归零一致）。
 * 拖这一侧时要把它扣掉，否则两边都拖宽会把中心槽挤到 0。
 */
function dockOtherWidth(side: 'left' | 'right'): number {
  const other = side === 'left' ? 'right' : 'left'
  const p = prefs().dock[other]
  if (!p.open) return 0
  return typeof p.width === 'number' ? p.width : dockDefaultWidth(other)
}

/** 槽宽上限：中心槽至少留 `--ui-center-min`。 */
function dockMaxWidth(side: 'left' | 'right'): number {
  const min = dockMinWidth()
  const center = cssLength('--ui-center-min', 480)
  return Math.max(min, window.innerWidth - dockOtherWidth(side) - center)
}

// 视口跨过压缩区（839/840）时，inline 宽度要跟着交回 CSS / 重新写回
window.addEventListener('resize', () => applyChrome())

/* ------------------------------------------------------------ 槽内容 */

/**
 * 槽内容依赖：**清单形式**列出装配层交给 UI 的能力，UI 不认识 `ws`／`registry`。
 * 全是读函数（库会被 `loadState` 整体替换，传值会拿到过期快照）。
 */
const dockDeps: DockContentDeps = {
  blocks: () => ws.blocks,
  activeId: () => ws.activeId,
  atoms: () => ws.atoms,
  // 共享索引由 store 缓存（懒重建）⇒ 反链不再每次扫全库 atoms ＋ 遍历森林
  index: () => blocks.index,
  openPage: (id) => void registry.invoke('core.page/open', { pageId: id }, 'menu'),
  newPage: () => void registry.invoke('core.page/new', {}, 'dock'),
  // 收藏容器块：容器就是一个带 `favorites` 角色的普通块
  favoriteContainers: () => favoritesContainers(ws.blocks),
  removeFavorite: (containerId, blockId) =>
    void registry.invoke('core.favorites/remove', { containerId, blockId }, 'dock'),
}

/** 重画两个侧槽（页列表变了、切换了当前页、或反链变了） */
function renderDocks(): void {
  // 先让钉住区处理「清单变了没有」：它只在增删时动 DOM，重画其余卡片不会碰它
  dockPins?.left.render()
  dockPins?.right.render()
  renderFavoritesInto(dockDeps, dockLeft, dockPins ? { persistent: [dockPins.left.card] } : {})
  renderBackrefsInto(dockDeps, dockRight, dockPins ? { persistent: [dockPins.right.card] } : {})
}

/** 钉住区的实例（在槽挂载之后创建；`renderDocks` 早于它就跳过） */
let dockPins: { left: DockBlocks; right: DockBlocks } | null = null

/* ------------------------------------------------------------ 钉住的块 */

/**
 * 钉住的清单是**视图状态**：它只记「要看哪几个块 id」，块本身仍在森林里那一份。
 * 所以撤销/删除块都不需要动这份清单 —— 渲染时按 id 找不到就不画，块回来时它自己回来。
 */
function addPin(side: 'left' | 'right', blockId: string): void {
  if (!findInForest(ws.blocks, blockId)) return
  const slot = prefs().dock[side]
  if (!slot.pins.includes(blockId)) slot.pins.push(blockId)
  if (!slot.open) {
    slot.open = true
    applyChrome()
  }
  renderDocks()
  scheduleSave()
  scheduleBadge()
}

function unpinBlock(side: 'left' | 'right', blockId: string): void {
  const slot = prefs().dock[side]
  const i = slot.pins.indexOf(blockId)
  if (i < 0) return
  slot.pins.splice(i, 1)
  renderDocks()
  scheduleSave()
  scheduleBadge()
}

/** 同一个入口进 / 出（Shift+点块标走它：已钉住则取消） */
function togglePin(side: 'left' | 'right', blockId: string): void {
  if (prefs().dock[side].pins.includes(blockId)) unpinBlock(side, blockId)
  else addPin(side, blockId)
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
  // ⚠️ 必须查**整片森林**：引用的目标可能是嵌套块，只查顶层会让「打开目标」凭空消失
  findBlock: (id) => findInForest(ws.blocks, id),
  // 引用目标可以是任意深度的块 ⇒ 走 zoom 那条命令，而不是只认顶层页的 `core.page/open`
  openBlock: (id) => void registry.invoke('core.block/focus-block', { blockId: id }, 'popover'),
  removeAtom: (id) => void registry.invoke('core.editor/remove-atom', { atomId: id }, 'popover'),
  closePopover: () => layers.closePopover(),
  openPopover: (render, anchor) => layers.openPopover(render, anchor),
  openDrawer: (title, render) => layers.openDrawer(title, render),
}

const showAtomPopover = (a: Atom, rect: DOMRect): void => panelPopover(panelDeps, a, rect)

/**
 * 行内原子的**唯一**点击口径（正文 / 反链 footer / 查询结果共用）。
 *
 * · 左键点 `page` 引用且目标在森林里 ⇒ 直接打开目标块（`focus-block`，嵌套块也能进）；
 * · `⌥` 点击 ⇒ 弹原来的详情浮层（诊断信息、删除引用都还在那里）；
 * · 图片原子 / dangling / 目标缺失 ⇒ 只弹浮层，**不静默失败**。
 *
 * ⚠️ 判断「目标可解析」用 `findInForest`，不是看 `a.state`：状态是快照，
 *    目标可能在这之后被删掉。
 */
const handleAtomClick = (a: Atom, el: HTMLElement, mods: { altKey: boolean }): void => {
  // 引用与标签是**同一种指向边**：左键都直接打开目标，⌥ 才看详情
  const targetId = a.kind === 'page' || a.kind === 'tag' ? a.target?.id : undefined
  if (!mods.altKey && targetId && findInForest(ws.blocks, targetId)) {
    void registry.invoke('core.block/focus-block', { blockId: targetId }, 'editor')
    return
  }
  showAtomPopover(a, el.getBoundingClientRect())
}
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
  // 敲 `#名字` 的成边路径：把那段文字换成边（与上面「光标处插入」是两个动作）
  linkTagRange: (blockId, from, to, label, targetId) => ed.linkTagRange(blockId, from, to, label, targetId),
  activeId: () => ws.activeId,
  setActiveId: (id) => {
    /**
     * **记录导航历史**：只有「真的换了落点」且旧落点还在森林里才记。
     * 历史回放期间 `nav.lock` 为真 ⇒ 不再入栈，否则前进/后退会自己套自己。
     */
    if (!nav.lock && id !== ws.activeId && findInForest(ws.blocks, ws.activeId)) {
      nav.back.push(ws.activeId)
      nav.forward = []
    }
    ws.activeId = id
  },
  loadPage: (roots, marks, atoms) => {
    ed = mainEd
    mainEd.loadPage({ roots }, marks as never, atoms as never)
    renderBacklinks()
    renderQueryView()
    renderProperties()
    renderTagPanel()
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
 * 前进 / 后退：从栈里取一个**仍然存在**的落点，再用「聚焦到此块」那条命令换当前对象。
 *
 * 为什么走命令而不是直接 `setActiveId`：zoom、面包屑、链接点击、历史回放必须是
 * **同一条**换落点路径（刷新列表/标题/面包屑/落盘都在里面）；再写一份就分叉了。
 * ⚠️ 回放期间 `nav.lock` 必须为真，否则 `setActiveId` 会把这次回放又记成一条新历史。
 */
function historyGo(dir: 'back' | 'forward'): boolean {
  const from = dir === 'back' ? nav.back : nav.forward
  const to = dir === 'back' ? nav.forward : nav.back
  while (from.length > 0) {
    const id = from.pop()!
    if (id === ws.activeId) continue
    if (!findInForest(ws.blocks, id)) continue // 目标在历史里被删了：跳过，别把人送到空处
    to.push(ws.activeId)
    nav.lock = true
    try {
      void registry.invoke('core.block/focus-block', { blockId: id }, 'history')
    } finally {
      nav.lock = false
    }
    scheduleBadge()
    return true
  }
  return false
}

/* ------------------------------------------------------------ 属性写入 / 摘标签提示 */

/**
 * 一次属性写入：模型改动 ＋ **一个**撤销快照 ＋ 落盘/重画。
 *
 * ⚠️ `touch(mainEd)` 不会重载正文（属性不改变文字）；其他视图照常收到通知。
 * ⚠️ 新建定义（`blockId === undefined`）改了森林结构 ⇒ 列表也要重画。
 */
function writeProps(blockId: string | undefined, mutate: () => void): void {
  const before = blocks.snap(ed.sel)
  mutate()
  blocks.record(before, 'other', Date.now())
  blocks.invalidateIndex()
  blocks.touch(mainEd, blockId ? [blockId] : undefined)
  scheduleProperties()
  if (!blockId) renderDocks()
  scheduleSave()
  scheduleBadge()
}

/** 显示名：正文（空则短 id） */
function blockName(b: Block): string {
  const s = b.text.trim()
  return s === '' ? shortId(b.id) : s
}

/**
 * 加一个角色（页 / 标签）。
 *
 * 判据：角色是**加/减一个机制位**，不是「在两种东西之间转换」——所以这里只 append，
 * 不抹任何数据。页与标签可兼位：同一个块可以既是页、又能被 `#` 指向。
 */
function addBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || hasRole(b, role)) return false
  // 标签靠地址被找到 ⇒ 没有名字就没有身份（页允许未命名）
  if (role === 'tag' && aliasOf(b).trim() === '') {
    app.toast(t('ui.toast.roleNeedName'), 'warn')
    return false
  }
  writeProps(blockId, () => addRole(b, role))
  app.toast(t(role === 'page' ? 'ui.toast.pageRoleAdded' : 'ui.toast.tagRoleAdded', { name: blockName(b) }))
  return true
}

/**
 * 减一个角色。
 *
 * 摘 `tag` 时**提示不阻止**（与删标签同一套形状）：成员与声明会失效，但**值一个字节不动**
 * （落回「本块自有」），打回 tag 角色后声明与成员关系自动恢复。
 */
function removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || !hasRole(b, role)) return false
  const drop = (): void => {
    writeProps(blockId, () => removeRole(b, role))
    app.toast(
      t(role === 'page' ? 'ui.toast.pageRoleRemoved' : 'ui.toast.tagRoleRemoved', { name: blockName(b) }),
      'info',
    )
  }
  if (role === 'tag') {
    const members = tagMemberIds(b.id, blocks.atoms).size
    const declarations = declaredFieldIds(b).length
    if (members > 0 || declarations > 0) {
      layers.openMenu({
        title: t('ui.role.removeTagTitle', { tag: blockName(b), members }),
        rows: [
          {
            id: 'role/remove',
            label: t('ui.role.removeTagContinue'),
            hint: declarations > 0 ? t('ui.role.declarations', { count: declarations }) : '',
            group: 'role/1',
          },
          { id: 'role/cancel', label: t('ui.role.cancel'), group: 'role/2' },
        ],
        anchor: ed.caretRect(),
        searchable: false,
        focusSearch: false,
        onPick: (row) => {
          if (row.id === 'role/remove') drop()
        },
      })
      return true
    }
  }
  drop()
  return true
}

/** 同一标签在本次运行期间已经答过「保留」⇒ 不再追问（避免提示疲劳） */
const cleanupAlwaysKeep = new Set<string>()

/**
 * 摘标签「要不要清理它带来的值」的提示。
 *
 * `removeEdge`：
 *   · 非空 ＝ 边还没删（显式删除命令）⇒ 删边与清值共用**一次撤销**；
 *   · `null` ＝ 边已经被删掉了（正文里退格删掉了 `#标签`）⇒ 只清值，删边那一步已在撤销栈里。
 */
function promptCleanup(
  host: Block,
  tag: Block,
  cleanable: string[],
  removeEdge: ((beforeRemove?: () => void) => void) | null,
  anchorId?: string,
): void {
  const labels = cleanable
    .map((pid) => {
      const def = findPropDef(ws.blocks, pid)
      return def ? propLabel(def) : shortId(pid)
    })
    .join('、')
  const anchorEl = anchorId ? document.querySelector(`.atom[data-atom-id="${anchorId}"]`) : null
  const anchor = anchorEl instanceof HTMLElement ? anchorEl.getBoundingClientRect() : null
  layers.openMenu({
    rows: [
      { id: 'cleanup/keep', label: t('ui.tagCleanup.keep'), hint: t('ui.tagCleanup.keepHint'), group: 'cleanup/1' },
      { id: 'cleanup/clean', label: t('ui.tagCleanup.clean'), hint: t('ui.tagCleanup.cleanHint', { fields: labels }), group: 'cleanup/2' },
      { id: 'cleanup/always', label: t('ui.tagCleanup.alwaysKeep'), group: 'cleanup/3' },
    ],
    anchor,
    title: t('ui.tagCleanup.title', { tag: tag.text }),
    searchable: false,
    focusSearch: false,
    onPick: (row) => {
      if (row.id === 'cleanup/always') {
        cleanupAlwaysKeep.add(tag.id)
        removeEdge?.()
        return
      }
      if (row.id === 'cleanup/clean') {
        const drop = (): void => {
          for (const pid of cleanable) clearValue(host, pid)
        }
        // 回调在快照之后、改模型之前 ⇒ 「删边 ＋ 清值」⌘Z 一次复原
        if (removeEdge) removeEdge(drop)
        else writeProps(host.id, drop)
        return
      }
      removeEdge?.()
    },
  })
}

/**
 * 删一个行内原子；**摘标签时**若它带来的字段在块上有值，先问一次「保留 / 清理」。
 *
 * R1–R4：
 *   · 只在**真有值**时问（字段全空 ⇒ 静默摘掉，绝大多数「打错了」不该被打扰）；
 *   · 默认**保留**（值落到「本块自有」）；
 *   · 清理只清「该标签声明 ∩ 块上有值 ∩ 剩余标签都不声明」，且与删边共用**一次撤销**。
 */
function removeAtomWithCleanup(atomId: string): void {
  const atom = blocks.atoms.find((a) => a.id === atomId)
  const host = atom ? findInForest(ws.blocks, atom.blockId) : undefined
  const tag = atom?.kind === 'tag' && atom.target ? findInForest(ws.blocks, atom.target.id) : undefined
  const cleanable = host && tag ? cleanableValues(host, tag, ws.blocks, blocks.atoms) : []
  if (!host || !tag || cleanable.length === 0 || cleanupAlwaysKeep.has(tag.id)) {
    ed.removeAtom(atomId)
    return
  }
  promptCleanup(host, tag, cleanable, (beforeRemove) => ed.removeAtom(atomId, beforeRemove), atomId)
}

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
  ...propsCommands({
    blocks: () => ws.blocks,
    write: writeProps,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...tagTreeCommands({
    blocks: () => ws.blocks,
    write: writeProps,
    toast: (text, kind) => app.toast(text, kind),
    shortId: (id) => shortId(id),
  }),
  removeAtom: (atomId) => removeAtomWithCleanup(atomId),

  /**
   * 标签选择器：**显示层级**（`#演员 · 属于 #人物、#艺术家`）。
   *
   * 这是「`#` 补全」当前的产品形态：从列表选一个已有标签插边（正文里敲 `#` 自动成边仍未做）。
   * 层级只帮人认位置，不参与消歧（地址唯一）。
   */
  showTagPicker: () => {
    const tags = allTags(ws.blocks)
      .slice()
      .sort((a, b) => a.text.localeCompare(b.text))
    let query = ''
    /**
     * 列表随输入重建：没有完全同名的标签时，第一行是**新建**。
     * 名字命中一个已有页（还没有 tag 角色）时，文案会说明「复用它」——
     * 这就是「让一个页兼作标签」的入口（同名必同一块）。
     */
    const buildRows = (): Row[] => {
      const q = query.trim()
      const want = normalizeAlias(q)
      const rows: Row[] = tags
        .filter((tag) => want === '' || normalizeAlias(tag.text).includes(want))
        .map((tag) => {
          const parents = parentTags(tag, ws.blocks)
          return {
            id: `tagpick/${tag.id}`,
            label: `#${tag.text}`,
            hint:
              parents.length > 0
                ? t('ui.tagPicker.hierarchy', { parents: parents.map((p) => `#${p.text}`).join('、') })
                : '',
            icon: 'lucide:hash',
            group: 'tagpick/1',
          }
        })
      if (q !== '' && !tags.some((tag) => normalizeAlias(tag.text) === want)) {
        const page = findByAlias(ws.blocks, q, (b) => hasRole(b, 'page') && !hasRole(b, 'tag'))
        rows.unshift({
          id: 'tagpick/new',
          label: page ? t('ui.tagPicker.reusePage', { name: q }) : t('ui.tagPicker.create', { name: q }),
          hint: page ? t('ui.tagPicker.reuseHint') : '',
          icon: 'lucide:hash',
          group: 'tagpick/0',
        })
      }
      return rows
    }
    layers.openMenu({
      rows: buildRows(),
      anchor: ed.caretRect(),
      title: t('ui.tagPicker.title'),
      searchable: true,
      focusSearch: true,
      emptyText: t('ui.tagPicker.typeToCreate'),
      onQuery: (q) => {
        query = q
        layers.setRows(buildRows())
      },
      onPick: (row) => {
        if (row.id === 'tagpick/new') {
          app.insertTag(query.trim())
          return
        }
        const tag = tags.find((x) => `tagpick/${x.id}` === row.id)
        if (tag) void registry.invoke('core.editor/insert-tag', { tag: tag.text }, 'menu', uiCtx())
      },
    })
  },

  addBlockRole: (blockId, role) => addBlockRole(blockId, role),
  removeBlockRole: (blockId, role) => removeBlockRole(blockId, role),

  // 导航历史（中心槽走到哪）；与 undo/redo 的模型快照栈无关
  historyBack: () => historyGo('back'),
  historyForward: () => historyGo('forward'),

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
      // 换库 ⇒ 旧落点全部失效；历史留着只会把用户送到「上一份演示数据」的 id
      nav.back = []
      nav.forward = []
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
      // ⚠️ 装载口径必须与**冷启动**同一条规则（那里是 `bootDays ? rootsForMany(bootDays) : rootsFor(bootActive)`）：
      //    落点是日记 ⇒ 装**日记流**（今日在顶＋存在的更早的天），别的块 ⇒ 只装它自己。
      //    原来这里只有 `rootsFor(p)`，于是「载入假数据」后日记流消失、只剩今天一段。
      const feed = hasRole(p, 'journal') ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
      for (const day of feed) ensureFirstBlock(day.children)
      const roots = feed.length > 0 ? rootsForMany(feed) : rootsFor(p)
      // ⚠️ 光标必须落在**第一个可编辑的行**上（日记流的第一段是只读日期行）。
      //    原来固定 `roots[0]`，于是载入假数据后光标停在日期行、第一行看着「没有名字」。
      const caret = firstEditableRoot(roots[0])
      mainEd.loadPage({ roots }, ws.marks, ws.atoms, { blockId: caret?.id ?? '', off: 0 })
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
  /**
   * 敲出 `#名字` ⇒ 落成一条边（**84.7 点名要补的那条接缝**）。
   *
   * ⚠️ 必须走命令面而不是直接 `ensureTag`：`ensureTag` 会写森林，
   *    命令面负责「写森林 ＋ 插原子 ＋ 刷新列表 ＋ 落盘」这一整串，
   *    绕过它就会出现「标签块建了但左槽没显示」这类半截状态。
   */
  onHashTag: (name, blockId, from, to) => void app.insertTag(name, { blockId, from, to }),
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
    // 正文里退格删掉 `#标签` 也是「摘标签」：边已经没了，但有值时仍要问一次清理
    const tagAtom = atoms.find((a) => a.kind === 'tag' && a.target)
    if (!tagAtom?.target) return
    const host = findInForest(ws.blocks, tagAtom.blockId)
    const tag = findInForest(ws.blocks, tagAtom.target.id)
    const cleanable = host && tag ? cleanableValues(host, tag, ws.blocks, blocks.atoms) : []
    if (host && tag && cleanable.length > 0 && !cleanupAlwaysKeep.has(tag.id)) {
      promptCleanup(host, tag, cleanable, null)
    }
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
  atomClick: (a, el, mods) => handleAtomClick(a, el, mods),
  // **左键点块标 ＝ 聚焦/zoom**。与面包屑那一格同一条命令，
  // 所以「点块标进去」与「点面包屑出来」共用一套语义，没有第二种入口。
  focusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'editor'),
  // Shift+点块标 ⇒ 钉到右槽（同一个入口可逆：已钉住则取消）
  openInDock: (blockId) => togglePin('right', blockId),
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
      scheduleProperties()
    },
    onFocusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'backlinks'),
    onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
    onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
  },
)

/** 页面/日记/zoom 装载后重查 footer 反链（target = activeId） */
function renderBacklinks(): void {
  backlinksView?.render()
}

renderBacklinks()

/* ------------------------------------------------------------ 属性区 */

/**
 * 属性区画在**当前对象**上（页 / 日记 / 标签 / 被 zoom 的块）。
 *
 * ⚠️ 不跟光标走：跟光标会让面板随点击忽隐忽现（布局跳），而「属性属于你正在看的那个东西」
 *    是更稳定的心智模型。要看一个内容块自己的属性 ⇒ 点它的块标 zoom 进来（此时它＝当前对象）。
 * 任何块都能直接有属性 —— 不要求先打标签；标签只让「可用字段」多出来。
 */
const propertiesPanel = new PropertiesPanel(
  {
    root: chrome.propertiesEl,
    title: chrome.propertiesTitleEl,
    body: chrome.propertiesBodyEl,
    add: chrome.propertiesAddEl,
  },
  {
    target: () => activeBlock(),
    rows: (b) => fieldRows(b, ws.blocks, blocks.atoms),
    defs: () => allPropDefs(ws.blocks),
    declared: (b) => declaredFields(b, ws.blocks),
    shortId: (id) => shortId(id),
    setValue: (b, propId, value) => void registry.invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
    clearValue: (b, propId) => void registry.invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
    addField: (b, propId) => void registry.invoke('core.props/add-field', { blockId: b.id, propId }, 'ui'),
    undeclare: (b, propId) => void registry.invoke('core.props/undeclare', { blockId: b.id, propId }, 'ui'),
    createDef: (b, label, kind) => void registry.invoke('core.props/create-def', { blockId: b.id, label, kind }, 'ui'),
    toast: (text, kind) => app.toast(text, kind),
  },
)

function renderProperties(): void {
  propertiesPanel.render()
}

/** 属性区跟着选块走；合并短时间内的多次改动（打字时不必每键重画面板） */
let propertyTimer: number | null = null
function scheduleProperties(): void {
  if (propertyTimer !== null) window.clearTimeout(propertyTimer)
  propertyTimer = window.setTimeout(() => {
    propertyTimer = null
    renderProperties()
  }, 60)
}
blocks.subscribe(() => scheduleProperties())
renderProperties()

/* ------------------------------------------------------------ 标签页 footer（属于 / 包含 / 成员） */

const tagPanel = new TagPanel(
  {
    root: chrome.tagPanelEl,
    title: chrome.tagPanelTitleEl,
    pageToggle: chrome.tagPanelPageEl,
    relations: chrome.tagPanelRelationsEl,
    membersTitle: chrome.tagPanelMembersTitleEl,
    membersCount: chrome.tagPanelMembersCountEl,
    membersEmpty: chrome.tagPanelMembersEmptyEl,
    membersEditor: chrome.tagPanelMembersEditorEl,
  },
  {
    store: blocks,
    blocks: () => ws.blocks,
    tag: () => {
      const b = activeBlock()
      return hasRole(b, 'tag') ? b : undefined
    },
    parents: (t) => parentTags(t, ws.blocks),
    dangling: (t) => danglingParentIds(t, ws.blocks),
    children: (t) => childTags(t, ws.blocks),
    members: (t) => memberBlocks(t.id, ws.blocks, blocks.atoms),
    isPage: (t) => hasRole(t, 'page'),
    togglePage: (tagId) => {
      const b = findInForest(ws.blocks, tagId)
      if (!b) return
      void registry.invoke(hasRole(b, 'page') ? 'core.block/unpage' : 'core.block/as-page', { blockId: tagId }, 'tagpanel')
    },
    shortId: (id) => shortId(id),
    addParent: (tagId, name) => {
      const parent = findByAlias(ws.blocks, name, (b) => hasRole(b, 'tag'))
      if (!parent) {
        app.toast(t('ui.tagpanel.notFound', { name }), 'warn')
        return
      }
      void registry.invoke('core.tags/add-parent', { childId: tagId, parentId: parent.id }, 'ui')
    },
    removeParent: (tagId, parentId) =>
      void registry.invoke('core.tags/remove-parent', { childId: tagId, parentId }, 'ui'),
    pruneParents: (tagId) => void registry.invoke('core.tags/prune-parents', { childId: tagId }, 'ui'),
    onChange: () => {
      scheduleSave()
      scheduleBadge()
      scheduleProperties()
    },
    onFocus: () => {
      ed = tagPanel.editor
      scheduleProperties()
    },
    onFocusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'tagpanel'),
    onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
    onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
  },
)

function renderTagPanel(): void {
  tagPanel.render()
}
renderTagPanel()

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
      scheduleProperties()
    },
    onFocusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'query'),
    onAtomClick: (a, el, mods) => handleAtomClick(a, el, mods),
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
    // 冷启动：看「第一次打开 app」那一屏到底长什么样（不用清 localStorage 再刷新）
    { id: 'boot', label: t('ui.stateMenu.boot'), hint: t('ui.stateMenu.bootHint'), icon: 'lucide:sunrise', group: 'dbg/2-state', command: 'core.demo/load-state', args: { state: 'boot' } },
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
  side: 'left',
  title: t('ui.dock.leftTitle'),
  collapseLabel: t('ui.dock.collapseLeft'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-left',
  onCollapse: () => registry.invoke('core.dock/toggle-left', {}, 'dock'),
})
const dockRight = mountDockSlot($('dock-right'), {
  side: 'right',
  title: t('ui.dock.rightTitle'),
  collapseLabel: t('ui.dock.collapseRight'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-right',
  onCollapse: () => registry.invoke('core.dock/toggle-right', {}, 'dock'),
})

/**
 * 钉住区：每个侧槽一个实例，里面是**真实块**的编辑器（共享 store）。
 *
 * 依赖一律是读函数（库会被整体替换，传值会拿到过期快照）。
 */
const dockBlocksDeps = (side: 'left' | 'right', slot: typeof dockLeft): ConstructorParameters<typeof DockBlocks>[0] => ({
  side,
  slot,
  store: blocks,
  blocks: () => ws.blocks,
  pins: () => prefs().dock[side].pins,
  pin: (blockId) => addPin(side, blockId),
  unpin: (blockId) => unpinBlock(side, blockId),
  onFocus: (editor) => {
    ed = editor
    scheduleBadge()
  },
  // 槽内编辑：只落盘与刷角标，**不重画槽**（重画会打断这一行的输入）
  onChange: () => {
    syncSections()
    scheduleSave()
    scheduleBadge()
  },
  onFocusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, 'dock'),
  onOpenInDock: (blockId) => togglePin('right', blockId),
  onAtomsLost: (labels) => app.toast(t('ui.toast.atomsLost', { labels: labels.join('、') }), 'warn'),
})

dockPins = {
  left: new DockBlocks(dockBlocksDeps('left', dockLeft)),
  right: new DockBlocks(dockBlocksDeps('right', dockRight)),
}

/** 手柄宽度：起拖取**当前渲染宽度**（存的是 null 时也不能让槽先跳一下） */
const bindResize = (side: 'left' | 'right', slot: typeof dockLeft): void => {
  bindDockResize({
    side,
    handle: slot.resizeEl,
    width: () => slot.root.getBoundingClientRect().width,
    min: dockMinWidth,
    max: () => dockMaxWidth(side),
    onResize: (width) => {
      prefs().dock[side].width = width
      applyChrome()
      scheduleSave()
    },
    onReset: () => {
      prefs().dock[side].width = null
      applyChrome()
      scheduleSave()
    },
  })
}
bindResize('left', dockLeft)
bindResize('right', dockRight)

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
  if (roots.length <= 1 || !roots.every((r) => hasRole(r, 'journal'))) return false
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
      // 导航历史断言要认「当前对象」本身（页名可能重复/为空）
      activeId: ws.activeId,
      // ⚠️ 「页数」＝ `page` 角色的块数（journal 不算页）；顶层块总数另给 `topBlocks`
      pageCount: flatten({ roots: ws.blocks }).filter((b) => hasRole(b, 'page')).length,
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
      /**
       * 三槽的设备状态（**诊断面**）：钉住清单与宽度都在 prefs 里，
       * 断言要能区分「落盘了没有」与「页面里渲染了没有」。
       */
      dock: {
        left: { open: prefs().dock.left.open, width: prefs().dock.left.width, pins: [...prefs().dock.left.pins] },
        right: { open: prefs().dock.right.open, width: prefs().dock.right.width, pins: [...prefs().dock.right.pins] },
      },
      // 导航历史（不是 undo 栈）：给断言看「能退到哪 / 能进到哪」
      nav: { back: [...nav.back], forward: [...nav.forward], canGoBack: nav.back.length > 0, canGoForward: nav.forward.length > 0 },
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
    return ws.blocks.map((b) => ({ id: b.id, text: b.text, roles: b.roles ?? [] }))
  },
  /** 字段定义（诊断面）：id ＝ propId、正文 ＝ label、谁声明了它 */
  propDefs() {
    return allPropDefs(ws.blocks).map((d) => ({
      id: d.id,
      label: d.text,
      kind: propKindOf(d),
      declaredBy: allTags(ws.blocks).filter((t) => declaredFieldIds(t).includes(d.id)).map((t) => t.id),
    }))
  },
  /** 一个块的属性区（**派生**：声明 ∪ 自有；同一 propId 只一行） */
  fields(blockId: string) {
    const b = findInForest(ws.blocks, blockId)
    if (!b) return []
    return fieldRows(b, ws.blocks, blocks.atoms).map((r) => ({
      propId: r.propId,
      label: r.label,
      kind: r.kind,
      value: r.value ?? null,
      filled: r.filled,
      sources: r.sources.map((s) => s.id),
    }))
  },
  /** 标签的直接父/子/失效父（诊断面；同一条边两个读法） */
  tagParents(tagId: string) {
    const b = findInForest(ws.blocks, tagId)
    return b ? parentTags(b, ws.blocks).map((x) => x.id) : []
  },
  tagChildren(tagId: string) {
    const b = findInForest(ws.blocks, tagId)
    return b ? childTags(b, ws.blocks).map((x) => x.id) : []
  },
  tagDanglingParents(tagId: string) {
    const b = findInForest(ws.blocks, tagId)
    return b ? danglingParentIds(b, ws.blocks) : []
  },
  /** 成员（**含算作**：自己的成员 ∪ 后代标签的成员） */
  tagMembersDeep(tagId: string) {
    return [...membersOf(tagId, ws.blocks, blocks.atoms)]
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
      roles: b.roles ?? [],
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
    // `id` 也要给：DOM 上的 `data-atom-id` 是它，诊断面没有 id 就只能靠位置猜
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
