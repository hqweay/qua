/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { addAlias, addList, addressesOf, aliasesOf, allPropDefs, allTags, blockTypeOf, DISPLAY_PROP, listsOf, tagIdsOf, tagsOf, childTags, claimAlias, danglingParentIds, declaredFieldIds, declaredFields, displayNameOf, ensureFirstBlock, ensureTodayJournal, fieldRows, findInForest, findPath, findByAlias, flatten, FEED_INITIAL, FEED_MAX, FEED_STEP, hasList, identityTags, isJournal, isQueryBlock, journalDate, journalFeedDays, memberBlocks, membersOf, normalizeAlias, parentTags, primaryAliasOf, prop, propKindOf, removeList, resolveRef, setBlockType, tagMemberIds, todayISO, todoOf, type Atom, type Block, type CtxKeys } from './core/index.ts'
import { BlockStore } from './core/store.ts'
import { BlockEditor } from './view/editor.ts'
import {
  BINDINGS,
  keyLabel,
  resolveBindings,
} from './core/bindings.ts'
import {
  COMMANDS,
  Registry,
  type App,
  type FixtureName,
  type MenuRequest,
  type PanelKind,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type Row } from './ui/layers.ts'
import { dispatchKey, installKeydown, type DispatchEnv } from './core/dispatch.ts'
import { applyDockVisibility, applyDockWidth, mountDockSlot } from './ui/dock.ts'
import { DockBlocks } from './ui/dock-blocks.ts'
import { bindDockResize } from './ui/dock-resize.ts'
import { renderBackrefsInto, renderTodayInto, type DockContentDeps } from './ui/dock-content.ts'
import { BacklinksView } from './ui/backlinks.ts'
import { PropertiesPanel } from './ui/properties.ts'
import { TagPanel } from './ui/tag-panel.ts'
import { QueryView } from './ui/query-view.ts'
import { createChrome } from './ui/chrome.ts'
import { isReadonlyBlock } from './view/block-dom.ts'
import { createIcon } from './view/icons.ts'
import { createBadge, type BadgeSnapshot } from './ui/badge.ts'
import { renderAliasEditor } from './ui/alias-editor.ts'
import { renderFieldsEditor } from './ui/fields-editor.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type PanelDeps } from './ui/panels.ts'
import { devCommands, journalCommands, pageCommands, propsCommands, rootsFor, rootsForMany, tagTreeCommands, takenWhere, viewCommands, zoomCommands, type PageDeps } from './app/commands-impl.ts'
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

/**
 * **测试面开不开**：dev server 恒开；构建产物只在显式带 `VITE_QUA_TEST=1` 时开。
 *
 * 判据是「这一份构建是给谁用的」，不是「现在能不能调试」：
 *   · 用户手上那份（`pnpm build` / `build:mac`）里不该存在能**清库**的入口 ——
 *     接上真库之后，一条 `dev.workspace/reset` 就是一次数据事故；
 *   · 验收（`check` / `check:dock` / `check:electron` / `shots`）读的是 `window.__qua`
 *     与夹具命令，所以它们跑的那份构建要带 flag。
 */
const DEV_SURFACE = import.meta.env.DEV || __QUA_TEST__

/** 开发命令的前缀：声明表里只有这几条是「只在测试面存在」的 */
const DEV_COMMAND_PREFIX = 'dev.'

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
if (readOnly) console.warn('[boot] read-only prototype state:', boot.status)

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
const bootDays = bootActive && isJournal(bootActive) ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
for (const day of bootDays) ensureFirstBlock(day.children)
const bootRoots: Block[] = bootDays.length > 0 ? rootsForMany(bootDays) : bootActive ? rootsFor(bootActive) : []

/**
 * **共享 block store**（下一层）：块/anchors/undo 只有一份；
 * 正文、反链、查询视图都是它的投影。多个 `BlockEditor` 读同一份活块。
 */
const blocks = new BlockStore(ws.blocks, ws.marks, ws.atoms, ws.trash)

const layers = new Layers(() => isMac())
let ed: BlockEditor
/** 中心槽的主编辑器；`ed` 是「当前活动编辑器」（正文或反链 footer） */
let mainEd: BlockEditor
let backlinksView: BacklinksView | null = null
let queryView: QueryView | null = null
/** 当前正文里那个查询块（没有 ⇒ `null`，视图整段隐藏） */
let queryBlock: Block | null = null
/**
 * **属性区最近一次画过的聚焦块**。
 *
 * 焦点落到面板自己的输入框、ref 选择浮层，或面板重绘让焦点暂时回到 body 时，
 * 活动编辑器已经不再「有光标」；没有记住的 id，面板就会在改到一半时消失。
 * 只有真的点到编辑区之外（pointerdown / 窗口失焦 / 换页）才清空。
 */
let propsBlockId: string | null = null
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
 *
 * ⚠️ **同一个 id 可以有两种形态**：今天的 journal 既可能以「日记流入口」打开，
 *    也可能以「只看这一天」聚焦。历史只存 id 会把两者压成一种（回退后 feed 消失），
 *    所以每一项都带 `feed` 这个视图形态。
 */
type NavPoint = { id: string; feed: boolean }
const nav = { back: [] as NavPoint[], forward: [] as NavPoint[], lock: false }

/** 当前中心视图是不是「日记流入口」（多段且全是 journal） */
function isFeedView(): boolean {
  if (!mainEd) return false
  const roots = mainEd.doc.roots
  return roots.length > 1 && roots.every((b) => isJournal(b))
}

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
/** 页名 ＝ 主别名叶子（没有名字才回落到描述）；空则交给调用方做兜底文案 */
const pageTitle = (p: Block): string => displayNameOf(p)
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
  const focusName = focusBlock ? primaryAliasOf(focusBlock).trim() : ''
  const ctx: CtxKeys = {
    ...ed.ctxKeys(),
    blockSelection: ed.hasBlockSelection(),
    blockSelectionCount: ed.blockSelectionCount(),
    paletteOpen: layers.open,
    drawerOpen: layers.drawerOpen(),
    popoverOpen: layers.popoverOpen(),
    // ⚠️ 「页数」只数 `page` 列表（journal 也是一块，但它不是页 —— ）
    pageCount: flatten({ roots: ws.blocks }).filter((b) => hasList(b, 'page')).length,
    pageTitleEmpty: pageTitle(activeBlock()).trim() === '',
    // 块菜单里的露面开关（只看**当前聚焦块**；顺序无语义，只有「在不在」）
    blockHasPageRole: hasList(focusBlock, 'page'),
    blockHasTagRole: hasList(focusBlock, 'tag'),
    blockHasName: focusName !== '',
    // 日记：`journalView` 是**真上下文键**（不是 if），`journalDate` 供前后翻日用
    journalView: isJournal(activeBlock()),
    journalDate: isJournal(activeBlock()) ? (prop<string>(activeBlock(), '_date') ?? '') : '',
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
  // 回收站也是库级的共享数组：换库/复位后落盘要写的是 store 那一份，
  // 否则删掉的块只活在内存里，重开就真没了
  ws.trash = blocks.trash
  /**
   * 折叠态是**库的视图状态**，所以它和 marks/atoms 一样从视图写回库：
   * 编辑器持的是 `doc.folded`（视图那份），落盘要的是 `ws.folded`（库那份）。
   * ⚠️ 编辑器还没装配时（读盘后的首次落盘）没有可写回的来源，保留 `ws.folded` 原值。
   */
  if (mainEd) ws.folded = mainEd.doc.folded ?? {}
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
}

/** 重画两个侧槽（页列表变了、切换了当前页、或反链变了） */
function renderDocks(): void {
  // 先让钉住区处理「清单变了没有」：它只在增删时动 DOM，重画其余卡片不会碰它
  dockPins?.left.render()
  dockPins?.right.render()
  renderTodayInto(dockDeps, dockLeft, dockPins ? { persistent: [dockPins.left.card] } : {})
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
  const targetId = a.kind === 'page' ? a.target?.id : undefined
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
  trash: () => blocks.trash,
  // 打标签的落点：**当前光标那一块**（正文 vs 反链 footer 会切换 ⇒ 每次现取活动编辑器）
  caretBlockId: () => ed.caretBlock() ?? ed.rows()[0]?.block.id ?? null,
  /**
   * 写块属性走装配层这一条路：撤销快照、索引失效、通知其他视图、落盘都在这里。
   *
   * ⚠️ 写完还要**重画这一行**：属性写入默认不碰正文（属性不改文字），
   *    但标签归属的呈现就在正文里（行尾 chip）⇒ 少了这一步，chip 要等下一次重渲染才出现。
   */
  write: (blockId, mutate) => {
    writeBlockProps(blockId, mutate)
  },
  activeId: () => ws.activeId,
  setActiveId: (id, view) => {
    /**
     * **记录导航历史**：只有「真的换了落点（或视图形态）」且旧落点还在森林里才记。
     * 历史回放期间 `nav.lock` 为真 ⇒ 不再入栈，否则前进/后退会自己套自己。
     */
    const feed = view?.feed === true
    const sameView = feed === isFeedView()
    if (!nav.lock && (id !== ws.activeId || !sameView) && findInForest(ws.blocks, ws.activeId)) {
      nav.back.push({ id: ws.activeId, feed: isFeedView() })
      nav.forward = []
    }
    ws.activeId = id
  },
  rootIds: () => mainEd.doc.roots.map((b) => b.id),
  loadPage: (roots, marks, atoms) => {
    // 换页/换焦点对象：上一条「聚焦块」不再成立，等 focusFirstBlock 重新设上
    propsBlockId = null
    ed = mainEd
    // 正文视图的折叠态是**库级**那份；取当前视图持有的那一份（`ws.folded` 只在落盘时同步，可能落后一步）
    mainEd.loadPage({ roots, folded: mainEd.doc.folded, trash: blocks.trash }, marks as never, atoms as never)
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
    const point = from.pop()!
    const feed = isFeedView()
    // 同 id 但形态不同（feed ↔ 单日）也是一次真实导航，不能跳过
    if (point.id === ws.activeId && point.feed === feed) continue
    if (!findInForest(ws.blocks, point.id)) continue // 目标在历史里被删了：跳过，别把人送到空处
    to.push({ id: ws.activeId, feed })
    nav.lock = true
    try {
      void registry.invoke('core.block/focus-block', { blockId: point.id, feed: point.feed }, 'history')
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

/**
 * 一次「改块自己的属性 ＋ 重画这一行」。
 *
 * ⚠️ 不能只调 `writeProps`：`mainEd` 是 `touch` 的发起者，**收不到自己的通知**，
 *    而别名头、标签 chip、显示模式都在这行自己的 DOM 里 —— 少了这一步，
 *    改完要等下一次整页重渲染才看得见（用户读到的是「点了没反应」）。
 */
function writeBlockProps(blockId: string, mutate: () => void): void {
  writeProps(blockId, mutate)
  mainEd.renderBlock(blockId)
  // 名字/显示模式变了 ⇒ 本视图里引用它的 chip（在**别的块**的 `.tx` 里）也要换字
  mainEd.renderRefSources(blockId)
  if (ed !== mainEd) {
    ed.renderBlock(blockId)
    ed.renderRefSources(blockId)
  }
}

/** 显示名：主名叶子 > 正文（空则短 id） */
function blockName(b: Block): string {
  return displayNameOf(b).trim() || shortId(b.id)
}

/**
 * 把一个块加进某个列表（页 / 标签）。
 *
 * 判据：列表是**露面**，不是「在两种东西之间转换」——所以这里只 append，
 * 不抹任何数据。页与标签可兼位：同一个块可以既是页、又能被 `#` 指向。
 *
 * ⚠️ **不变量：在列表里 ⇒ 至少有一个名字。** 加列表前没有地址时必须先补一个：
 *    · 正文非空 ⇒ 用它当主名（正文此刻还是用户写下的描述，语义上就是他想叫的名字）；
 *    · 正文为空 ⇒ 页生成 `未命名-<shortid>`；标签拒绝（没有名字的标签没有身份）。
 * ⚠️ **补名字就是占地址**，所以先查重：页与标签共用同一个地址空间，
 *    两个块共用一个地址 ⇒ 永远只能找到一个，另一个再也引用不到。
 *    撞车时**拒绝，一个字节都不写**——与改名同一套口径，只是入口不同。
 */
function addBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || hasList(b, role)) return false
  let name = primaryAliasOf(b).trim()
  if (name === '') {
    const text = b.text.trim()
    if (text !== '') {
      name = text
    } else if (role === 'tag') {
      app.toast(t('ui.toast.roleNeedName'), 'warn')
      return false
    } else {
      name = t('ui.page.untitledAlias', { id: b.id.slice(-6) })
    }
    const claim = claimAlias(ws.blocks, b, name, true)
    if (!claim.ok) {
      app.toast(t('ui.toast.nameTaken', { name, where: takenWhere(claim.conflict) }), 'warn')
      return false
    }
  }
  writeProps(blockId, () => {
    if (primaryAliasOf(b).trim() === '') addAlias(b, name)
    addList(b, role)
    // 第一次获得身份 ⇒ 行头默认显示名字；用户显式设过的显示模式不动
    if (prop(b, DISPLAY_PROP) === undefined) b.props = { ...(b.props ?? {}), [DISPLAY_PROP]: 'alias' }
  })
  app.toast(t(role === 'page' ? 'ui.toast.pageRoleAdded' : 'ui.toast.tagRoleAdded', { name: blockName(b) }))
  return true
}

/**
 * 把一个块从某个列表里摘掉。
 *
 * 摘 `tag` 时**提示不阻止**（与删标签同一套形状）：成员与声明会失效，但**值一个字节不动**
 * （落回「本块自有」），重新加进 `tag` 列表后声明与成员关系自动恢复。
 * ⚠️ 名字不跟着删：地址是身份，去掉露面不等于抹掉它是谁（要删名字走别名编辑器）。
 */
function removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || !hasList(b, role)) return false
  const drop = (): void => {
    writeProps(blockId, () => removeList(b, role))
    app.toast(
      t(role === 'page' ? 'ui.toast.pageRoleRemoved' : 'ui.toast.tagRoleRemoved', { name: blockName(b) }),
      'info',
    )
  }
  if (role === 'tag') {
    const members = tagMemberIds(b.id, ws.blocks).size
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

/**
 * 写块的类型（`_type`）。
 *
 * 一次属性写入就够：类型值住在块的属性袋里，撤销、落盘、重画都走同一条路。
 * 幂等检查放在写之前 —— 否则「设成它已经是的东西」也会占掉一格撤销。
 */
function applyBlockType(blockId: string, typeId: string): boolean {
  const b = findInForest(ws.blocks, blockId)
  if (!b || blockTypeOf(b) === typeId) return false
  writeProps(blockId, () => setBlockType(b, typeId))
  return true
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
  removeAtom: (atomId) => ed.removeAtom(atomId),

  /**
   * 标签选择器：**显示层级**（`#演员 · 属于 #人物、#艺术家`）。
   *
   * 这是「`#` 补全」当前的产品形态：从列表选一个已有标签插边（正文里敲 `#` 自动成边仍未做）。
   * 层级只帮人认位置，不参与消歧（地址唯一）。
   */
  showTagPicker: () => {
    const tags = allTags(ws.blocks)
      .slice()
      // 排序用**主地址**（全名、规范化）而不是显示叶子：`A/B` 与 `C/B` 的叶子相同，
      // 按叶子排会让两行看起来没有稳定顺序。
      .sort((a, b) => (addressesOf(a)[0] ?? blockName(a)).localeCompare(addressesOf(b)[0] ?? blockName(b)))
    let query = ''
    /**
     * 列表随输入重建：没有完全同名的标签时，第一行是**新建**。
     * 名字命中一个已有页（还没有 tag 露面）时，文案会说明「复用它」——
     * 这就是「让一个页兼作标签」的入口（同名必同一块）。
     *
     * ⚠️ 匹配走**全部地址**（`addressesOf`），不是只看主名叶子：块可以有多个别名，
     *    只比主名会让「第二个名字」在补全里找不到自己。
     */
    const buildRows = (): Row[] => {
      const q = query.trim()
      const want = normalizeAlias(q)
      const rows: Row[] = tags
        .filter(
          (tag) =>
            want === '' ||
            normalizeAlias(blockName(tag)).includes(want) ||
            addressesOf(tag).some((a) => a.includes(want)),
        )
        .map((tag) => {
          const parents = parentTags(tag, ws.blocks)
          return {
            id: `tagpick/${tag.id}`,
            label: `#${blockName(tag)}`,
            hint:
              parents.length > 0
                ? t('ui.tagPicker.hierarchy', { parents: parents.map((p) => `#${blockName(p)}`).join('、') })
                : '',
            icon: 'lucide:hash',
            group: 'tagpick/1',
          }
        })
      if (q !== '' && !tags.some((tag) => addressesOf(tag).includes(want))) {
        const page = findByAlias(ws.blocks, q, (b) => hasList(b, 'page') && !hasList(b, 'tag'))
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
        // 插入的是**地址**（全名）：`insertTag` 走 findByAlias，叶子在 `A/B` 上解析不到。
        if (tag) void registry.invoke('core.editor/insert-tag', { tag: primaryAliasOf(tag) || blockName(tag) }, 'menu', uiCtx())
      },
    })
  },

  addBlockRole: (blockId, role) => addBlockRole(blockId, role),
  removeBlockRole: (blockId, role) => removeBlockRole(blockId, role),
  openAliasEditor: (blockId) => openAliasEditor(blockId, ed.caretRect()),
  openFieldsEditor: (blockId) => openFieldsEditor(blockId, ed.caretRect()),
  setBlockType: (blockId, typeId) => applyBlockType(blockId, typeId),

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

  ...devCommands({
    replaceWorkspace: (next) => {
      ws = next
      // 换库 ⇒ 旧落点全部失效；历史留着只会把用户送到「上一份演示数据」的 id
      nav.back = []
      nav.forward = []
      const p = activeBlock()
      // ⚠️ 先解析 `p` 再 `blocks.reset`：`activeBlock()` 读的是**森林**（`ws.activeId`），
      //    重置之后再算就只剩「`ws.blocks[0]`」这条兜底，`sparse` 的 activeId 一旦不是首块就取错。
      blocks.reset(next.blocks, next.marks, next.atoms, next.trash)
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
      const feed = isJournal(p) ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
      for (const day of feed) ensureFirstBlock(day.children)
      const roots = feed.length > 0 ? rootsForMany(feed) : rootsFor(p)
      // ⚠️ 光标必须落在**第一个可编辑的行**上（日记流的第一段是只读日期行）。
      //    原来固定 `roots[0]`，于是载入假数据后光标停在日期行、第一行看着「没有名字」。
      const caret = firstEditableRoot(roots[0])
      mainEd.loadPage({ roots, folded: ws.folded, trash: blocks.trash }, ws.marks, ws.atoms, { blockId: caret?.id ?? '', off: 0 })
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

/* ------------------------------------------------------ 行头：别名 / 字段 */

/**
 * 行头的两个入口（`block-dom` 只写 `data-alias-action`，这里用事件委托打开）。
 *
 * ⚠️ 不把「打开浮层」写进 `view/`：渲染层不认识 app，也不该向上调用；
 *    委托在装配层，`view/` 只负责把动作标出来。
 * ⚠️ 写操作走 `writeBlockProps`：别名头就在这一行的 DOM 里，写完必须重画它。
 */
const openAliasEditor = (blockId: string, rect: DOMRect | null): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openPopover(
    (host) =>
      renderAliasEditor(host, {
        forest: () => ws.blocks,
        block: () => findInForest(ws.blocks, blockId),
        write: (mutate) => writeBlockProps(blockId, mutate),
        close: () => layers.closePopover(),
        toast: (text, kind) => app.toast(text, kind),
      }),
    rect,
  )
}

const openFieldsEditor = (blockId: string, _rect: DOMRect | null): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openDrawer(
    t('ui.alias.fieldsTitle'),
    (host) =>
      renderFieldsEditor(host, {
        forest: () => ws.blocks,
        block: () => findInForest(ws.blocks, blockId),
        write: (mutate) => writeBlockProps(blockId, mutate),
        close: () => layers.closeDrawer(),
        toast: (text, kind) => app.toast(text, kind),
      }),
  )
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
  doc: { roots: bootRoots, folded: ws.folded, trash: blocks.trash },
  marks: ws.marks,
  atoms: ws.atoms,
})
mainEd = ed
renderQueryView()
// 焦点在正文 → 活动编辑器＝正文；焦点在反链 footer 时由 BacklinksView 切过去
editorEl.addEventListener('focusin', () => {
  ed = mainEd
  scheduleProperties()
})

ed.events = {
  change: () => {
    syncSections()
    scheduleSave()
    chrome.renderEmptyHint(activeBlock().children)
    renderDocks() // 块数变了要更新
    scheduleBadge()
  },
  /**
   * **编辑边界上撞名**：正文已经被编辑器回滚成改名前那个值，这里只负责说一句为什么。
   * 拒绝发生在用户离开这一行的那一刻，途中没有可以放确认框的位置 —— 提示是唯一的出口。
   */
  editRejected: (name, conflict) => {
    app.toast(t('ui.toast.nameTaken', { name, where: takenWhere(conflict) }), 'warn')
  },
  atomsLost: (atoms) => {
    app.toast(t('ui.toast.atomsLost', { labels: atoms.map((a) => a.label).join('、') }), 'warn')
  },
  // 划选气泡（顶部工具栏作废后的落点）：选区一变就重算「该不该在、装哪几颗」
  selChange: () => {
    refreshSelectionBar()
    scheduleProperties()
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
 * 属性区画在**当前聚焦块**上（活动编辑器里光标所在的那一块）。
 *
 * 为什么不跟「当前对象」：看一个内容块自己的属性不必先 zoom 进来；点哪一块就改哪一块，
 * 移开焦点（点到编辑区之外、窗口失焦）就收起。焦点落在本区自己的控件或 ref 选择浮层里时
 * 继续用记住的那一块 —— 否则改到一半面板会自己消失。
 *
 * ⚠️ 冷启动不抢焦点：没有任何块处于聚焦态时本区保持 `hidden`，不留一条空白。
 */
function lastFocusedBlock(): Block | null {
  // 窗口已经不在前台 ⇒ 没有「聚焦块」可言；否则失焦前的 activeElement 还会让我们假装有焦点
  if (!document.hasFocus()) return null
  const active = document.activeElement
  if (active && ed.container.contains(active)) {
    const caret = ed.caretBlock()
    if (!caret) return null
    const live = findInForest(ws.blocks, caret)
    if (!live) return null
    propsBlockId = live.id
    return live
  }
  // 焦点在别的**可聚焦控件**上（Tab 到槽按钮、调试开关…）⇒ 已经没有聚焦块。
  // `body` 不算：面板重绘会把焦点暂时交回 body，那不是用户离开。
  if (active && active !== document.body && active !== document.documentElement) {
    const kept = chrome.propertiesEl.contains(active) || layers.contains(active)
    if (!kept) return null
  }
  // 焦点在面板/浮层/重绘后的 body：沿用上一次编辑器里真正落过的块
  return propsBlockId ? (findInForest(ws.blocks, propsBlockId) ?? null) : null
}

const propertiesPanel = new PropertiesPanel(
  {
    root: chrome.propertiesEl,
    title: chrome.propertiesTitleEl,
    body: chrome.propertiesBodyEl,
    add: chrome.propertiesAddEl,
  },
  {
    target: () => lastFocusedBlock(),
    rows: (b) => fieldRows(b, ws.blocks),
    // 标签（分类归属）与标签属性（字段声明）是两件事：这一行走 `props._tags`
    tags: (b) => tagsOf(b, ws.blocks),
    // 挂/摘之后**面板自己重画**：这一行显示的就是刚改的那份 `_tags`，
    // 等下一次选区变化才刷会让「加完没反应」
    addTag: (b, name) => {
      void registry.invoke('core.tags/add', { blockId: b.id, name }, 'ui')
      propertiesPanel.render()
    },
    removeTag: (b, tagId) => {
      void registry.invoke('core.tags/remove', { blockId: b.id, tagId }, 'ui')
      propertiesPanel.render()
    },
    defs: () => allPropDefs(ws.blocks),
    declared: (b) => declaredFields(b, ws.blocks),
    shortId: (id) => shortId(id),
    setValue: (b, propId, value) => void registry.invoke('core.props/set-value', { blockId: b.id, propId, value }, 'ui'),
    clearValue: (b, propId) => void registry.invoke('core.props/clear-value', { blockId: b.id, propId }, 'ui'),
    addField: (b, propId) => void registry.invoke('core.props/add-field', { blockId: b.id, propId }, 'ui'),
    undeclare: (b, propId) => void registry.invoke('core.props/undeclare', { blockId: b.id, propId }, 'ui'),
    createDef: (b, label, kind) => void registry.invoke('core.props/create-def', { blockId: b.id, label, kind }, 'ui'),
    /**
     * **`ref` 值的选择器**：从整片森林里挑一块。
     *
     * 复用 `layers.openMenu`（与命令面板 / 标签选择器同一个浮层），
     * 所以键盘、搜索、空态的行为不用再写一份。
     * 列表给「页 → 它的块」两级，页名与块正文都能搜到。
     *
     * ⚠️ 标题用**显示名**（主名叶子 > 正文）：引用要叫「它的名字」，
     *    不是「它的描述」。描述仍留在 `hint`／后续的块行里。
     */
    pickRef: (owner, _propId, current, onPick) => {
      const rows: Row[] = []
      for (const b of flatten({ roots: ws.blocks })) {
        // 自己不能指向自己：那会造出一个立刻成环的引用
        if (b.id === owner.id) continue
        const title = displayNameOf(b).trim()
        rows.push({
          id: `ref/${b.id}`,
          label: title === '' ? t('ui.page.untitled') : title,
          hint: hasList(b, 'page') ? t('ui.props.refIsPage') : t('ui.props.refIsBlock'),
          icon: hasList(b, 'page') ? 'lucide:file' : 'lucide:square',
          group: hasList(b, 'page') ? 'ref/1-page' : 'ref/2-block',
          // 当前值做个标记：不然选过一次之后看不出来「现在是哪个」
          keyHint: b.id === current ? t('ui.props.refCurrent') : undefined,
        })
      }
      layers.openMenu({
        rows,
        anchor: ed.caretRect(),
        title: t('ui.props.pickRef'),
        searchable: true,
        focusSearch: true,
        emptyText: t('ui.props.refEmpty'),
        onPick: (row) => {
          const id = String(row.id).slice('ref/'.length)
          onPick(id)
          // 选择器关掉之后属性区要立刻显示新值（不等下一次 store 通知）
          scheduleProperties()
        },
      })
    },
    refLabel: (targetId) => {
      const b = findInForest(ws.blocks, targetId)
      if (!b) return t('ui.props.refMissing', { id: shortId(targetId) })
      const name = displayNameOf(b).trim()
      return name === '' ? shortId(b.id) : name
    },
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

/**
 * **面板跟着「聚焦块」重算**，三条触发各自对应一种「焦点去哪了」：
 *   · `selectionchange`：在编辑器里点/敲/方向键移动光标；
 *   · `focusin`：点进编辑器（还没形成选区的那一刻）；
 *   · `pointerdown`（捕获）：点到了编辑区之外 ⇒ 收起。
 *
 * ⚠️ `selectionchange` 只在活动编辑器里处理：属性区自己的输入框也会产生选区变化，
 *    跟着重绘会把正在输入的控件整块换掉。
 * ⚠️ 点面板自己或浮层里（含 ref 选择器）不算「出去了」——否则点开选择器的那一下就把面板关了。
 */
document.addEventListener('selectionchange', () => {
  if (ed.container.contains(document.activeElement)) scheduleProperties()
})
document.addEventListener('focusin', (e) => {
  if (e.target instanceof Node && ed.container.contains(e.target)) scheduleProperties()
})
document.addEventListener('focusout', (e) => {
  const next = e.relatedTarget
  if (next instanceof Node) {
    if (ed.container.contains(next)) return
    if (chrome.propertiesEl.contains(next) || layers.contains(next)) return
  }
  // 焦点落到 body（面板重绘）时下面那条会沿用记住的块；落到别的控件则会收起
  scheduleProperties()
})
document.addEventListener(
  'pointerdown',
  (e) => {
    const node = e.target as Node | null
    if (!node) return
    if (ed.container.contains(node)) return
    if (chrome.propertiesEl.contains(node)) return
    if ((node as HTMLElement).closest?.('.blk')) return
    if (layers.contains(node)) return
    propsBlockId = null
    scheduleProperties()
  },
  true,
)
window.addEventListener('blur', () => {
  propsBlockId = null
  scheduleProperties()
})

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
      return hasList(b, 'tag') ? b : undefined
    },
    parents: (t) => parentTags(t, ws.blocks),
    dangling: (t) => danglingParentIds(t, ws.blocks),
    children: (t) => childTags(t, ws.blocks),
    members: (t) => memberBlocks(t.id, ws.blocks),
    isPage: (t) => hasList(t, 'page'),
    togglePage: (tagId) => {
      const b = findInForest(ws.blocks, tagId)
      if (!b) return
      void registry.invoke(hasList(b, 'page') ? 'core.block/unpage' : 'core.block/as-page', { blockId: tagId }, 'tagpanel')
    },
    shortId: (id) => shortId(id),
    addParent: (tagId, name) => {
      const parent = findByAlias(ws.blocks, name, (b) => hasList(b, 'tag'))
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
  ]
  /**
   * 演示状态那几行**只在测试面存在**：它们换的是整份库（并立刻落盘）。
   * 产品构建里那一行根本没注册，摆出来点下去只会得到「命令未注册」—— 不如不摆。
   */
  if (DEV_SURFACE) {
    rows.push(
      // 演示状态
      { id: 'seed', label: t('ui.stateMenu.seed'), hint: t('ui.stateMenu.seedHint'), icon: 'lucide:book-open', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'seed' } },
      // 冷启动：看「第一次打开 app」那一屏到底长什么样（不用清 localStorage 再刷新）
      { id: 'boot', label: t('ui.stateMenu.boot'), hint: t('ui.stateMenu.bootHint'), icon: 'lucide:sunrise', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'boot' } },
      { id: 'degraded', label: t('ui.state.degraded'), hint: t('ui.stateMenu.degradedHint'), icon: 'lucide:triangle-alert', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'degraded' } },
      { id: 'sparse', label: t('ui.state.sparse'), hint: t('ui.stateMenu.sparseHint'), icon: 'lucide:square-dashed', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'sparse' } },
      { id: 'empty', label: t('ui.state.empty'), hint: t('ui.stateMenu.emptyHint'), icon: 'lucide:square', group: 'dbg/2-state', command: 'dev.fixture/load', args: { state: 'empty' } },
    )
  }
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
  if (!layers.popoverOpen()) return
  // 气泡自己的控件（别名编辑器、引用详情里的按钮）不算「点到外面」——
  // 否则 mousedown 就把宿主节点摘掉，后续 click 根本落不到按钮上。
  if (layers.popoverContains(target)) return
  if ((target as HTMLElement).closest?.('.atom')) return
  layers.closePopover()
})

/**
 * 行头两个入口的**唯一**委托点：`block-dom` 只写 `data-alias-action`。
 * 放在 document 上是因为别名头会随整行重渲染被换掉，绑在按钮上会绑到已经死掉的节点。
 */
document.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-alias-action]')
  if (!action) return
  const row = action.closest<HTMLElement>('.blk[data-block-id]')
  const blockId = row?.dataset.blockId
  if (!blockId) return
  const rect = action.getBoundingClientRect()
  if (action.dataset.aliasAction === 'fields') openFieldsEditor(blockId, rect)
  else openAliasEditor(blockId, rect)
})

window.addEventListener('beforeunload', () => saveNow())

/* ------------------------------------------------------------ 启动 */

registry = new Registry(
  app,
  HANDLERS,
  // 产品构建只去掉 `dev.` 开头那几条**声明**；处理器表原样注入 ——
  // 没有声明的命令从命令面板、斜杠菜单里就看不见，`invoke` 也仍是唯一入口。
  DEV_SURFACE ? COMMANDS : COMMANDS.filter((d) => !d.name.startsWith(DEV_COMMAND_PREFIX)),
)

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
 * 两条侧槽：左槽放今日与钉住的块，右槽放反链；内容由 `renderDocks()` 填。
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
    scheduleProperties()
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
  if (roots.length <= 1 || !roots.every((r) => isJournal(r))) return false
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
      pageCount: flatten({ roots: ws.blocks }).filter((b) => hasList(b, 'page')).length,
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
      nav: { back: nav.back.map((p) => p.id), forward: nav.forward.map((p) => p.id), canGoBack: nav.back.length > 0, canGoForward: nav.forward.length > 0 },
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
    return ws.blocks.map((b) => ({
      id: b.id,
      text: b.text,
      roles: identityTags(b),
      // 地址与露面是两套语义，诊断面要能分别读（`roles` 只给外观认的身份种类）
      aliases: aliasesOf(b),
      lists: listsOf(b),
      display: prop<string>(b, DISPLAY_PROP) ?? null,
    }))
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
    return fieldRows(b, ws.blocks).map((r) => ({
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
    return [...membersOf(tagId, ws.blocks)]
  },
  /** 打了某个标签的块 id（标签的成员列表＝标签块的入向边） */
  tagMembers(tagId: string) {
    return [...tagMemberIds(tagId, ws.blocks)]
  },
  /** 删掉一个行内原子（**连同它占的那一格** ⇒ 那条边就没了） */
  removeAtom(atomId: string) {
    mainEd.removeAtom(atomId)
  },
  blocks() {
    return flatten(mainEd.doc).map((b) => ({
      id: b.id,
      text: b.text,
      todo: todoOf(b) ?? null,
      // 诊断面的字段名保持 `collapsed`（冒烟按它断言）；值现在来自折叠表
      collapsed: mainEd.doc.folded?.[b.id] === true,
      children: b.children.length,
      // 角色进诊断面（journal 行是只读日期，测试要能把它挑出来）
      roles: identityTags(b),
      // 标签归属也进诊断面：它是块级字段，DOM 里只剩渲染出来的 chip
      tags: tagIdsOf(b),
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
  loadState: (s: FixtureName) => registry.invoke('dev.fixture/load', { state: s }, 'api'),
  focusBlock: (blockId: string, off = 0) => {
    ed = mainEd
    editorEl.focus()
    mainEd.placeCaret(blockId, off)
  },
  /**
   * 把焦点给编辑器：有模型选区就还原它，没有就落到第一个可编辑行。
   *
   * ⚠️ **先 focus 再 placeCaret**：`focus()` 在「此前没有焦点」时会把光标重置到容器开头
   *    （Contenteditable 默认行为）——不补一次 placeCaret，光标会停在只读的日期行上，
   *    连带把 ⌘A 的全选范围也缩到那一行。
   * ⚠️ 冷启动**不**走这里：打开 app 时没有任何块处于聚焦态；这是一个显式动作的入口。
   */
  focus: () => {
    ed = mainEd
    const keep = mainEd.sel
    editorEl.focus()
    if (keep) {
      mainEd.placeCaret(keep.aBlock, keep.aOff)
      return
    }
    const target = firstEditableRoot(mainEd.doc.roots[0])
    if (target) mainEd.placeCaret(target.id, 0)
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
    /** 只在测试面存在（`DEV_SURFACE`）；产品构建里这个键根本不会被赋值 */
    __qua: typeof api
  }
}
// ⚠️ 只在测试面挂上去：诊断口能直接调 `invoke`（含换库、清存储），
//    接上真库之后留在产品构建里＝把「一键清掉真实数据」放在用户的 F12 里。
if (DEV_SURFACE) window.__qua = api
