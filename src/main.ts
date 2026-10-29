/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { addAlias, addList, addressesOf,   allTags, blockTypeOf, buildAdjacency, checkEdge, cyclePathLabels, DISPLAY_PROP,    claimAlias, danglingOf, declaredFieldIds, displayNameOf,  findInForest, findByAlias, flatten, collectionItems, FEED_INITIAL, FEED_MAX, FEED_STEP, hasList,  feedDays, isJournal,  journalId, mkBlock, mkJournalBlock, normalizeAlias, parentsOf, primaryAliasOf, prop,  pruneGone, removeList,  setBlockType, tagMemberIds,  todayISO, type Block, type CtxKeys, type TriggerChar } from './core/index.ts'
import { plainText, type RunWithId } from './core/runs.ts'
import { checkExternalUrl, rejectText } from './core/link.ts'
import { BlockStore } from './core/store.ts'
import { MemoryKb } from './core/kb/memory.ts'
import type { Op } from './core/kb/types.ts'
import { BlockEditor, type ViewEvents } from './view/editor.ts'
import {
  BINDINGS,
  keyLabel,
  resolveBindings,
} from './core/bindings.ts'
import {
  COMMANDS,
  Registry,
  type App,
    type MenuRequest,
  type PanelKind,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type PickMods, type Row } from './ui/layers.ts'
import { createTriggers } from './app/retrieval/triggers.ts'
import { dispatchKey, installKeydown, type DispatchEnv } from './core/dispatch.ts'
import { DockWindows } from './ui/dock-windows.ts'
import { bindDockResize } from './ui/dock-resize.ts'
import { mountDockSlot } from './ui/dock.ts'
import { createIcon } from './view/icons.ts'
import { widgetBodyInDoc } from './ui/dock-widgets.ts'
import { renderAliasEditor } from './ui/alias-editor.ts'
import { renderFieldsEditor } from './ui/fields-editor.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, renderLinkComposer, type ObjFieldDeps, type PanelDeps } from './ui/panels.ts'
import { openImageLightbox } from './ui/lightbox.ts'
import type { RefClickHit, RefClickMods } from './view/editor-events.ts'
import { collectionCommands, devCommands, journalCommands, mountCommands, moveCommands, pageCommands, propsCommands, rootsFor, rootsForMany, belongsToCommands, takenWhere, viewCommands, zoomCommands } from './app/commands-impl.ts'
import type { TxRun } from './app/commands/types.ts'
import { setupPersistence } from './app/wiring/persistence.ts'
import { setupDocks } from './app/wiring/docks.ts'
import { setupPanels } from './app/wiring/panels.ts'
import { setupChrome } from './app/wiring/chrome.ts'
import { setupPages } from './app/wiring/pages.ts'
import { setupDiagnostics } from './app/wiring/diagnostics.ts'
import { HANDLERS } from './app/handlers.ts'
// 用户可见文案一律走 t；字典是零依赖叶子，Electron 主进程也 import 同一份
import { t } from './core/msg.ts'
import { seedWorkspace } from './core/seed.ts'
import { createIdbAssetStore } from './core/storage/asset-idb.ts'
import { createIpcAssetStore } from './core/storage/asset-ipc.ts'
import { ensureSeedAssets } from './core/storage/seed-assets.ts'
import { assetMetaOf, assetViewOf, assetsAvailable, loadAssetKeys, onAssetReady, primeAsset, useAssetStore } from './view/asset-views.ts'
import type { AssetView } from './core/assets.ts'
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  sniffImageMime,
  type AssetMeta,
} from './core/assets.ts'
import { createIpcAdapter, type LibraryBridge } from './core/storage/ipc-adapter.ts'
import {
  createDeviceStore,
  createLocalStorageAdapter,
  createWorkspaceStore,
  DEVICE_KEY,
  STORAGE_KEY,
  type Prefs,
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
 *
 * 两个宿主两条路（115 D13）：
 *   · Electron：库在**主进程**（`node:sqlite`），字节经 IPC；一个窗口一个库。
 *   · web：单窗口单库，仍是 localStorage（浏览器没有用户可选目录的同等语义）。
 * 判据是 `window.qua` 在不在（preload 暴露的库面），**不是** `userAgent`——
 * 后者会被插件/代理改写，而 preload 面是壳给的事实。
 */
const LIBRARY_BRIDGE: LibraryBridge | null =
  typeof window !== 'undefined' && typeof (window as unknown as { qua?: LibraryBridge }).qua === 'object'
    ? (window as unknown as { qua: LibraryBridge }).qua
    : null

const store = createWorkspaceStore(
  LIBRARY_BRIDGE ? createIpcAdapter(LIBRARY_BRIDGE) : createLocalStorageAdapter(STORAGE_KEY),
)
/**
 * **设备状态**（偏好）走它自己的键与端口实例：换库不带走它，库作废也不连累它。
 * 两个端口各自持有一份写队列 —— 它们的字节落在两个键上，没有共同的写入顺序。
 */
const deviceStore = createDeviceStore(createLocalStorageAdapter(DEVICE_KEY))

/**
 * **资产库**：字节的唯一去处。与内容存储同一条分叉判据（`window.qua` 在不在）：
 *   · Electron：字节住在**库目录的 `assets/`**（主进程写，经 IPC）⇒ 拷库目录＝图一起走；
 *   · web：IndexedDB（浏览器没有「用户可选的库目录」这个语义）。
 *
 * 为什么在**读库之前**就建好：行内资产是正文的一部分，渲染第一帧就要知道
 * 「这份 hash 在不在」——`keys()` 必须赶在首次渲染之前拿到。
 * ⚠️ 资产库打不开不是启动失败：整个库标成 `unavailable`，应用照常开，
 *    已有图显示「资产库不可用」而不是一片空白（见 `view/asset-views.ts`）。
 */
const assetStore = LIBRARY_BRIDGE ? createIpcAssetStore(LIBRARY_BRIDGE) : createIdbAssetStore()
useAssetStore(assetStore)

/**
 * 读盘**是异步的**：上层不得依赖同步返回（写队列与读盘共用一条契约）。
 * 入口在文件末尾 `await` —— 模块顶层 await 在 Electron renderer / vite 下都没问题。
 */
const boot = await store.load()
/**
 * 读设备偏好同样要 `await`（同一个契约）。它**永远成功**：读不到就用默认值——
 * 偏好不是内容，不该因为一格坏了就打不开 app。
 */
const device = await deviceStore.load()
/**
 * 读盘结果分型：
 *   · `empty` / `expired` ⇒ 允许 seed 并落盘；
 *   · `too-new` / `corrupt` / `storage-error` ⇒ **只读演示态**，绝不覆盖原数据。
 *
 * ⚠️ 旧实现是 `loadWorkspace() ?? seedWorkspace()` 后立刻 save：读失败一次就把用户库覆盖了。
 */
const readOnly = boot.status === 'too-new' || boot.status === 'corrupt' || boot.status === 'storage-error'
let ws: Workspace = boot.status === 'ok' ? boot.ws : seedWorkspace()

/**
 * **启动顺序**：先把种子资产的字节写进资产库，再拿一次全库 key，最后才渲染。
 *
 * 顺序不能反：`keys()` 是「这份 hash 在不在」的同步判据，种子的图必须在它之前入库；
 * 反过来（先 keys 再 put）会让默认演示里的图全部显示成 `missing`——
 * 用户看到「资产库坏了」，而实际只是顺序错了。
 *
 * 失败不拦启动：入库失败只影响那一张图（`missing`），`keys()` 失败才整库 `unavailable`。
 */
if (!readOnly) await ensureSeedAssets(assetStore)
await loadAssetKeys()

/**
 * 边图邻接表（**现建一次、当次用完**）。
 *
 * 不缓存成「源点集合」：根的判据是「本树内没有可见父」，父一变（加减露面、
 * 软删、恢复）根集合就得跟着变。缓存一处就是「给 A 加了页露面，A 在归属树里还是原位」。
 * 同一次动作里要问好几遍的调用方自己 `const adj = adjacency()` 一次传下去。
 */
const adjacency = () => buildAdjacency(ws.blocks)
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
const hadToday = Boolean(findInForest(ws.blocks, journalId(todayISO())))
const todayId = journalId(todayISO())

/**
 * **共享 block store**（下一层）：块/anchors/undo 只有一份；
 * 正文、反链、查询视图都是它的投影。多个 `BlockEditor` 读同一份活块。
 *
 * ⚠️ 它必须早于冷启动物化：今日块与空天首子块现在走 `kb.tx`（有 op，可重放），
 *    不再是「事务之外补一块，落盘时整份兜底」。
 */
const blocks = new BlockStore(ws.blocks)
/**
 * **读入口**：渲染侧的读都该经它取，而不是自己去 `ws.blocks` 里找。
 *
 * 装配层先接上读面；换掉「整库在内存」的实现时，改的是这一个构造参数，
 * 而不是每个调用方。
 * ⚠️ **换库（`dev` 换演示数据）不换它**：门面只持有 store 这一个实例，
 *    `reset` 原地换内容 ⇒ 门面读到的永远是当前库（依赖注入才能按值传）。
 */
const kb = new MemoryKb(blocks)

/**
 * **冷启动物化走事务**：今日块、空天首子块都是真实编辑，
 * 所以它们有 op（`bootOps`）—— 落盘与重放看到的是同一件事。
 *
 * 没有这一步时，这两块只在内存里「凭空出现」，第一笔落盘要靠 `ensure` 整块补；
 * 日志里则完全缺了它们，`replay(log)` 永远对不上装载出来的库。
 */
const bootOps: Op[] = []
const bootFeed = feedDays(ws.blocks, FEED_INITIAL)
if (!hadToday || bootFeed.some((d) => d.children.length === 0)) {
  const r = kb.tx((tx) => {
    if (!hadToday) tx.insert(mkJournalBlock(todayISO()), null, 0)
    for (const day of feedDays(ws.blocks, FEED_INITIAL)) {
      if (day.children.length === 0) tx.insert(mkBlock(''), day.id, 0)
    }
  })
  bootOps.push(...r.ops)
}
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
const bootDays = bootActive && isJournal(bootActive) ? feedDays(ws.blocks, FEED_INITIAL) : []
const bootRoots: Block[] = bootDays.length > 0 ? rootsForMany(bootDays) : bootActive ? rootsFor(bootActive) : []

const layers = new Layers(() => isMac())
let ed: BlockEditor
/** 中心槽的主编辑器；`ed` 是「当前活动编辑器」（正文或反链 footer） */
let mainEd: BlockEditor
let registry: Registry
/** 现在开着的是哪个触发字符的浮层（`null` ＝ 没开）；`lastQuery` 是上次列的查询词 */
let triggerCh: TriggerChar | null = null
let lastQuery = ''
/** 截图/自检时静音 toast（产品行为不变，只是不弹提示） */
let quiet = false

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
/** 短 id：uuidv7 前 12 位是时间戳（同一毫秒创建的块会撞），所以要短就取**尾部随机段** */
const shortId = (id: string): string => id.slice(-6)
/**
 * 偏好**不活在库里**（v15 起）：它是这台设备怎么显示（主题／槽宽／钉住的块）。
 * 调用点仍按「拿到一份可改的偏好对象」用它 —— 改完由 `scheduleDeviceSave()` 落盘。
 */
const prefs = (): Prefs => device.prefs

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

/* ------------------------------------------------------------ 槽内容 */

const { renderDocks, openWindow, closeCard, addTile, addDerived, cardStateFor, windowLabel, setWindows, widgetDeps: dockWidgetDeps } = setupDocks({
  kb,
  prefs,
  applyChrome: () => applyChrome(),
  getWs: () => ws,
  getRegistry: () => registry,
  scheduleDeviceSave: () => scheduleDeviceSave(),
  scheduleBadge: () => scheduleBadge(),
  getSlots: () => ({ left: dockLeft, right: dockRight }),
  // 检视卡在面板分片里创建并挂进右槽堆叠；这里只在重画时取它（它必须已经在文档里）
  inspectCard: () => chrome.inspectCardEl,
  pickBlock: (collectionId, anchor) => showCollectionPicker(collectionId, anchor),
})

const { chrome, editorEl, applyChrome, resolvedTheme, dockMinWidth, dockMaxWidth, badge, scheduleBadge, markBooted } = setupChrome({
  prefs,
  bootNotice,
  shortId,
  uiCtx,
  getActiveBlock: () => activeBlock(),
  getPageTitle: (p) => pageTitle(p),
  getDomStats: () => diag.domStats(),
  $,
  getWs: () => ws,
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  openInDock: (blockId) => openWindow('right', blockId),
})

/**
 * 持久化装配：库与设备两个写队列、防抖、事务收尾都收在这一节。
 * 它在 chrome 之后装配（保存失败要挂常驻告警），而持久化的函数没有更早的顶层调用
 * ——全是运行时触发，挪到这里是安全的。
 */
const {
  syncSections,
  saveNow,
  scheduleSave,
  saveDeviceNow,
  scheduleDeviceSave,
  txRun,
  run,
  getLastOps,
  clearPendingOps,
  addOps,
} = setupPersistence({
  store,
  deviceStore,
  device,
  blocks,
  kb,
  readOnly,
  /**
   * **内存这份与盘上那份是同一份吗**。判据是「读到过」：
   * 从盘上读来的 ⇒ 盘上已有内容，第一笔照常增量；否则（种子／旧库作废）⇒
   * 第一笔要写 genesis（`diff([], 模型)`），行与日志一起从零开始。
   */
  loadedFromDisk: boot.status === 'ok',
  bootOps,
  errText,
  layers,
  getWs: () => ws,
  getMainEd: () => mainEd,
  getChrome: () => chrome,
  isQuiet: () => quiet,
})

/* ------------------------------------------------------------ 关闭握手（Electron 库面） */

/**
 * 主进程关窗之前会发 `qua:flush`，这里把待落盘的那批**立刻发出去**再回 ack。
 *
 * 为什么必须有这条：落盘是 250ms 防抖，关窗那一刻可能还有一笔没发。
 * 不接这条的话主进程只能等满 1.5s 超时——「关窗变慢」是症状，真问题是那一笔可能丢。
 */
LIBRARY_BRIDGE?.onFlush?.(async () => {
  saveNow()
  saveDeviceNow()
  await store.settle()
  await deviceStore.settle()
})

/* ------------------------------------------------------------ 浮层渲染 */

/**
 * **触发表**：`/` 命令源 · `#` 标签源 · `@` 页块源。
 *
 * 三个触发字符共用**一个**浮层组件（`layers.openMenu`），差别只在「列什么行」；
 * 「选中之后做什么」由下面 `pickRow` 按行的 `pick` 决定——浮层不认识插入语义。
 *
 * ⚠️ 森林是**现取**的（`() => ws.blocks`）：换库之后这里必须看到新库。
 * ⚠️ `#` 有三枚徽标（`↵`／`⌥↵`／`⇧↵`）：三种落点由按键区分，不由行区分。
 */
const triggers = createTriggers({
  forest: () => ws.blocks,
  ctx: uiCtx,
  keyHints,
  shortcutHint: `↵ ${isMac() ? '⌥↵' : 'Alt+↵'} ${isMac() ? '⇧↵' : 'Shift+↵'}`,
  // `@` 候选排除「正在打字的这一块」：它自己的正文含着查询词，点它＝引用自己
  selfBlockId: () => ed.caretBlock() ?? ed.sel?.aBlock ?? null,
})

/**
 * 划选气泡：**选区存在就在它上方浮一排格式按钮，选区塌了就消失**。
 *
 * 这是「顶部工具栏」的替代品（2026-10-19）。为什么改成这样：
 *   · 中性现代的口径是 chrome 极弱 —— 一排常驻按钮是**最重**的 chrome；
 *   · 加粗/高亮这类命令**只对选区有意义**（光标态按下去没有任何效果），
 *     常驻等于长期摆着几个点不动的按钮；把「有没有选区」做成**唯一开关**，
 *     可用性靠 `when` 表达（「这次怎么显示」归查询或绑定，不是给块加字段）。
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
  const activeMarks = new Set(ed.marksAtSel())
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

/**
 * **打开检索浮层**（三个触发字符共用这一个入口）。
 *
 * 行为与原来的斜杠菜单同形：不抢焦点（`focusSearch:false`）、`searchable:false`
 * ——打字继续进 `.tx`，`triggerQuery` 每次上报就来 `setRows`。
 */
function openTrigger(ch: TriggerChar, query: string, anchor: DOMRect | null, title?: string): void {
  const trigger = triggers.get(ch)
  if (!trigger) return
  triggerCh = ch
  lastQuery = query
  layers.openMenu({
    rows: trigger.source(query),
    anchor,
    title: title ?? trigger.title,
    searchable: false,
    focusSearch: false,
    emptyText: trigger.emptyText,
    // ⚠️ `ch` 走闭包而不是读全局：`closeMenu` 会在 `onPick` 之前回调 `onClose` 把状态清掉，
    //    读全局就会读到「已经没开着了」，于是这次选中什么都不做（真实踩过）。
    onPick: (row, mods) => pickRow(ch, row, mods),
    onClose: () => {
      triggerCh = null
    },
  })
}

/**
 * **选中之后做什么**：浮层只报「选中了谁 ＋ 按了什么键」，落点在这里决定。
 *
 * 这条分叉是拍板过的：同一条 `#名` 行按 `↵` 是「插进正文」（`ref` 露面，不写归属），
 * 按 `⌥↵` 是「归到本块」（写 `_tags`，正文里那串字消失、行尾出 chip）。
 * 让按键去区分插法，而不是让同一行有两种「长得一样、按下去不一样」的入口 ——
 * 行的身份已经决定它是不是标签类；按键只在这个范围内换结果。
 *
 * ⚠️ `⌘Enter` 已归「切换待办」，所以这里**不用** ⌘／Ctrl 做归类。
 */
function pickRow(ch: TriggerChar, row: Row, mods: PickMods): void {
  const pick = row.pick
  // 浮层已关：从这里往后「现在开着的是谁」一律清掉（同一笔动作只发生一次）
  triggerCh = null
  if (!pick) return

  // 命令行：先把 `/查询词` 让出来，再走命令 —— 命令自己决定落在哪一格（与原来同形）
  if (pick.kind === 'command') {
    const id = ed.caretBlock()
    if (id) ed.dropTrigger(id)
    if (pick.command) registry.invoke(pick.command, (pick.args as Record<string, unknown>) ?? {}, 'slash', uiCtx())
    return
  }

  if (pick.kind === 'page' || pick.kind === 'block') {
    ed.acceptTrigger({ ch, pick: { kind: 'ref', to: pick.id, label: pick.name } })
    return
  }

  // `@` 无同名页：当场建页（或复用同名地址）并在原位插引用；同一笔事务
  if (pick.kind === 'newPage') {
    ed.acceptTrigger({ ch, pick: { kind: 'newPage', name: pick.name } })
    return
  }

  /**
   * `#` 的三种落点**只看按键**，不看选中的是哪一栏：
   *   · `⇧↵` ⇒ 为这个标签建一条落在今天的新实例（不管当前行是类还是已有实例）；
   *   · `⌥↵` ⇒ 把标签归到本块（写宿主 `_tags`，行尾出 chip）；
   *   · `↵`   ⇒ 行内标签：实例行引用那条记录、标签类行引用类块。
   *
   * 新建标签行也是这样：行只是**目标**（名字还不存在），三种键各给一个落点；
   * 标签块在同一笔事务里建出来（`acceptTrigger` 的 `newTag` 分支）。
   */
  if (pick.kind === 'newTag') {
    const action = mods.shiftKey ? 'instance' : mods.altKey ? 'assign' : 'inline'
    ed.acceptTrigger({ ch, pick: { kind: 'newTag', name: pick.name, action } })
    return
  }

  const tagName = pick.kind === 'instance' ? pick.tag : pick.kind === 'tag' ? pick.name : ''
  if (ch === '#' && tagName !== '') {
    if (mods.shiftKey) {
      ed.acceptTrigger({ ch, pick: { kind: 'newObj', name: tagName } })
      return
    }
    if (mods.altKey) {
      ed.acceptTrigger({ ch, pick: { kind: 'tag', name: tagName } })
      return
    }
  }

  /**
   * 实例一条记录 ＝ 提及「这个标签的一次出现」：与 `@` 的引用同一个落点，
   * 只多一个 `flavor:'#'` 的显示风味。选中的是哪条记录由浮层那一行给出。
   */
  if (pick.kind === 'instance') {
    ed.acceptTrigger({ ch, pick: { kind: 'ref', to: pick.id, label: pick.name, flavor: '#' } })
    return
  }

  if (pick.kind === 'tag') {
    ed.acceptTrigger({ ch, pick: { kind: 'ref', to: pick.id, label: pick.name, flavor: '#' } })
  }
}

function showMenu(req: MenuRequest): void {
  const ctx = req.ctx ?? uiCtx()
  /**
   * 别的菜单取代检索浮层时把状态清掉：`openMenu` 换掉旧浮层不会回调 `onClose`，
   * 留着 `triggerCh` 会让下一次按键去改一个已经不在的浮层。
   */
  triggerCh = null
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
  if (req.kind === 'slash') openTrigger('/', req.query ?? '', req.anchor, req.title ?? t('menu.title.slashFilter'))
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
  // ⚠️ 必须查**整片森林**：引用的目标可能是嵌套块，只查顶层会让「打开目标」凭空消失
  findBlock: (id) => findInForest(ws.blocks, id),
  // 引用目标可以是任意深度的块 ⇒ 走 zoom 那条命令，而不是只认顶层页的 `core.page/open`
  openBlock: (id) => void registry.invoke('core.block/focus-block', { blockId: id }, 'popover'),
  // Shift+点「打开目标」＝在右槽打开一张窗口（中心不换）
  openInDock: (id) => openWindow('right', id),
  /**
   * **锚文本**：写进这一枚 run（一条事务 ⇒ 一次撤销）。
   * 走命令而不是直接调编辑器，是为了让 HTTP／CLI 面也能改它，且撤销与落盘照旧。
   */
  setAnchor: (runId, text) => void registry.invoke('core.editor/set-anchor', { atomId: runId, text }, 'popover'),
  /**
   * **打开外链**：与点正文里那一枚走**同一条命令**（`core.link/open`）。
   * 两处入口不会分叉成「一个能开、一个不能开」。
   */
  openLink: (id) => void registry.invoke('core.link/open', { atomId: id }, 'popover'),
  removeAtom: (id) => void registry.invoke('core.editor/remove-atom', { atomId: id }, 'popover'),
  closePopover: () => layers.closePopover(),
  openPopover: (render, anchor) => layers.openPopover(render, anchor),
  openDrawer: (title, render) => layers.openDrawer(title, render),
}

/**
 * 实例字段卡需要的读写能力（`setupPanels` 之后才有 `pickRef`，所以先留变量）。
 * ⚠️ 值只写记录块：`setValue` 收的是 recordId，浮层拿不到宿主块。
 */
let objFieldDeps: ObjFieldDeps | undefined

/**
 * 浮层的锚点：**取矩形的函数**，不是快照。
 *
 * 为什么：浮层要跟着锚点走。桌面端拖窗口边、滚动正文都是日常动作，而一个矩形快照
 * 记不住自己指向谁 —— 滚动 300px 之后锚点早已跑开、浮层留在原地（实测相距 308px），
 * 且不报错。传函数则每次重算都对着当前那处。
 *
 * `el.isConnected === false` ⇒ 返回 `null`，浮层自己会关掉（指向不存在的东西比没有更糟）。
 */
const anchorOf = (el: HTMLElement) => () => (el.isConnected ? el.getBoundingClientRect() : null)

const showAtomPopover = (a: RunWithId, anchor: DOMRect | null | (() => DOMRect | null)): void =>
  panelPopover(panelDeps, a, anchor, objFieldDeps)

/**
 * 一枚 run 的**当前模型对象**（点击时 DOM 上只有 id，载荷要现查）。
 *
 * 为什么不从 DOM 反推：DOM 上只有显示用的快照（hash、label），
 * 而「删这一枚」需要 run id 与它所在块的模型对象；查不到就说明它已经被删了。
 */
function findRunOrNull(runId: string): RunWithId | null {
  return ed.findRun(runId)?.run ?? null
}

/**
 * **资产详情浮层**（`⌥` 点击 / 缺失与不可用时的默认动作）。
 *
 * 与图片 lightbox 分开：lightbox 只回答「这张图长什么样」，
 * 这里回答「这份字节是什么、在不在、能不能删掉这一枚」。
 * 两者都会出现在同一枚原子上，但**不该合成一个**：缺失的图没有大图可看。
 */
function showAssetDetails(runId: string, _hash: string, el: HTMLElement): void {
  const run = findRunOrNull(runId)
  if (run?.t === 'asset') {
    showAtomPopover(run, anchorOf(el))
    return
  }
  // 模型里已经没有了（刚被删）：不弹一个操作不了的空浮层
  app.toast(t('ui.asset.runGone'), 'warn')
}

/**
 * 打开 lightbox。副标题是「尺寸 · 字节 · hash 短码」——
 * 三样都能帮人确认「这是我以为的那张图」。
 */
function openLightbox(hash: string, view: AssetView, el: HTMLElement): void {
  const run = findRunOrNull(el.dataset.atomId ?? '')
  const meta = assetMetaOf(hash)
  const label = (run?.t === 'asset' ? run.label : undefined) ?? t('ui.asset.unnamed')
  const dims = view.w && view.h ? `${view.w}×${view.h}` : meta?.w && meta.h ? `${meta.w}×${meta.h}` : ''
  const size = meta ? formatBytes(meta.size) : ''
  const parts = [dims, size, hash.slice(0, 8)].filter((x) => x !== '')
  openImageLightbox({ url: view.url ?? '', label, subtitle: parts.join(' · ') })
}

/** 字节数的人话形式（详情浮层与 lightbox 共用一份，免得两处各算一套） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * **「指向某块的露面」被点**的唯一口径（正文 / 反链 footer / 查询结果 / 标签成员 /
 * 侧槽窗口 / 属性区，全部共用）。
 *
 * · 左键 ⇒ 打开目标块（`focus-block`，嵌套块也能进）；
 * · **Shift+左键** ⇒ 同一个「打开」，换到右槽（一张窗口）；中心不换、历史不记；
 * · `⌥` 点击 ⇒ 弹详情浮层（诊断信息、删除引用都还在那里）；
 * · 图片 / 外链 / dangling / 目标缺失 ⇒ 只弹浮层，**不静默失败**。
 *
 * ⚠️ 判据是 `ref.run` 有没有，不是「这是不是原子」：详情浮层要一枚 run 才有内容可看可删。
 *    块级标签 chip 与属性区的标签名只有归属、没有 run —— 对它们 `⌥` 不构成第二件事，
 *    所以退回左键那一种（而不是「按了没反应」）。
 * ⚠️ 判断「目标可解析」用 `findInForest`，不是看解析状态：状态是快照，
 *    目标可能在这之后被删掉。
 * ⚠️ `el` 只是浮层的**锚点**，可省：没有 run 的露面（chip／属性区）永远不弹浮层。
 */
function handleRefClick(ref: RefClickHit, mods: RefClickMods, el?: HTMLElement): void {
  const target = ref.to !== '' && findInForest(ws.blocks, ref.to) ? ref.to : undefined
  if (target && (!mods.altKey || !ref.run)) {
    if (mods.shiftKey) openWindow('right', target)
    else void registry.invoke('core.block/focus-block', { blockId: target }, 'editor')
    return
  }
  if (ref.run && el) showAtomPopover(ref.run, anchorOf(el))
  /**
   * 剩下的两种情形都不做事，且都不假装成功：
   *   · 没有 run（chip／属性区）且目标不在了 ⇒ 没有可弹的内容；
   *   · 有 run 但没给锚点 ⇒ 调用方明确表示不弹浮层。
   */
}
const openDrawerFor = (kind: PanelKind): void => panelDrawer(panelDeps, kind)

/* ------------------------------------------------------------ 键位派发（接线） */

/**
 * 派发的环境。**这里只有接线，没有逻辑**（逻辑在 `dispatch.ts`）。
 * `trace` 写回编辑器的探针队列 ——那是「按键命中追踪」诊断的数据源。
 */
const dispatchEnv: DispatchEnv = {
  ctx: uiCtx,
  isMac,
  invoke: (name, args, ctx) => registry.invoke(name, args, 'keymap', ctx).handled,
  layerOpen: () => layers.anyOpen(),
  trace: (tr) => {
    if (!ed.probe.traced) return
    ed.probe.keyTrace.push(tr)
    if (ed.probe.keyTrace.length > 40) ed.probe.keyTrace.shift()
    scheduleBadge()
  },
}

installKeydown(dispatchEnv, { editorEl })

const { pageDeps, activeBlock, activeTrail, pageTitle, nav, historyGo, firstEditableRoot, materializeEditableRoots } = setupPages({
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
  getApp: () => app,
  getPanels: () => panels,
  getWs: () => ws,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  getChrome: () => chrome,
  prefs: () => prefs(),
  // 「看属性」承诺的是内容而不是一列空槽：卡被关掉之后由这一条放回来
  ensureDockCard: (side, id) => addDerived(side, id),
})
/* ------------------------------------------------------------ 属性写入 / 摘标签提示 */

/**
 * 一次「改块自己的属性」，**连带重画这一行**。
 *
 * 为什么重画是它的一部分，而不是调用方各自记得：这块的属性里有一族是**外观的输入** ——
 * `_aliases` / `_lists`（别名头与身份图标）、`_type`（类型外观）、
 * 以及 gutter 标记（待办方框、标签身份）所用的那些 prop。写完之后那一行的 DOM
 * 就已经过期了，而 `mainEd` 是 `tx` 的发起者、**收不到自己的通知**
 * （`store.touch(source)` 不回调发起者）—— 所以「写模型」与「重画这一行」
 * 必须同时发生，否则屏幕上留着一个旧样子，直到别的动作把那一行重画。
 *
 * ⚠️ 早先这里只有写、重画靠调用方各自补：`writeBlockProps` 补了，
 *    而属性命令那条路径（面板「添加块属性」）没补 —— 于是给块挂上「任务状态」之后，
 *    模型里已经有了、右侧卡里也有了，**块左边的待办方框却不出现**。
 *    加属性看似「只是一条数据的改动」，但它同时是这一行外观的输入。
 */
function writeProps(blockId: string, mutate: () => void): void {
  const before = blocks.snap(ed.sel)
  run((tx) => tx.patch(blockId, mutate), mainEd)
  blocks.record(before, 'other', Date.now())
  // 行自己：别名头 / 身份图标 / 类型外观 / gutter 标记都在这一行的 DOM 里
  repaintBlock(blockId)
  // 右槽的检视卡：属性行与「来源」都变了
  scheduleProperties()
  scheduleSave()
  scheduleBadge()
}

/**
 * 重画一个块所在的行（当前活动编辑器里的；不在视图里的块是 no-op）。
 *
 * ⚠️ 别名头、标签 chip、显示模式都在这行自己的 DOM 里 —— 少了这一步，
 *    改完要等下一次整页重渲染才看得见（用户读到的是「点了没反应」）。
 * 调用方：`writeProps`（每次写属性之后）与命令层的事务收尾（`PageDeps.run`／`PropsDeps.run`）。
 */
function repaintBlock(blockId: string): void {
  mainEd.renderBlock(blockId)
  // 名字/显示模式变了 ⇒ 本视图里引用它的 chip（在**别的块**的 `.tx` 里）也要换字
  mainEd.renderRefSources(blockId)
  if (ed !== mainEd) {
    ed.renderBlock(blockId)
    ed.renderRefSources(blockId)
  }
}

/**
 * 名称保留的理由（供日后 grep 到这里的调用方）：**不再有**「只写、不重画」的变体。
 *
 * 曾经有两个名字：`writeProps`（只写）与 `writeBlockProps`（写 ＋ 重画）。
 * 两次名字并存，第一次就选错了 —— 属性命令那条路径注入的是前者，
 * 于是「加属性」不刷新那一行。现在只有一个名字，且它**必然重画**：
 * 「改这一块的属性」与「这一行的样子变了」是同一件事的两面。
 */

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
    const text = plainText(b.content).trim()
    if (text !== '') {
      name = text
    } else if (role === 'tag') {
      // 标签的价值就是名字（`#未命名-abc` 没有意义），但拒绝不该是死路：
      // 起名是下一步，所以直接把别名编辑器打开、把光标放进输入框。
      app.toast(t('ui.toast.roleNeedName'), 'warn')
      app.openAliasEditor(b.id, true)
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
 * 命令层的事务入口：装配层补撤销快照（零 op 不记），并把**改到的那几行**当场重画。
 *
 * 为什么在装配层：撤销快照与「重画哪一行」都需要 `ed`／`blocks`／`repaintBlock`，
 * 而命令层只声明「发生了什么」。
 */
const runTx: TxRun = (fn) => {
  const before = blocks.snap(ed.sel)
  const r = txRun(fn, mainEd)
  if (r.ops.length > 0) blocks.record(before, 'other', Date.now())
  for (const id of new Set(r.changes.filter((c) => c.kind === 'blocks').map((c) => c.id))) repaintBlock(id)
  scheduleProperties()
  scheduleSave()
  scheduleBadge()
  return r
}

/**
 * **行内资产的入库路径**（粘贴 / 选文件共用）。
 *
 * 三步的顺序不能换（「字节先落、引用后落」）：
 *   ① 校验字节（嗅 MIME、allowlist、上限）——不合格就一句明确文案，**不写 run**；
 *   ② `assetStore.put` 入库（算 hash、去重、读尺寸）；
 *   ③ 按**捕获到的落点**插 run（块被删/越界 ⇒ no-op）。
 *
 * 为什么校验在入库之前：`put` 会把字节写进库。先入库再校验等于让不合格的字节占了地方
 * （还拿到一个 hash），而 v1 没有 GC——那些字节会一直躺着。
 *
 * 失败一律走 toast，不静默：用户刚按了粘贴/选了文件，「什么都没发生」是最糟的反馈。
 */
async function insertAssetBlob(
  blob: Blob,
  label: string,
  point?: { blockId: string; offset: number },
): Promise<boolean> {
  const where = point ?? ed.caretPoint()
  if (!where) {
    app.toast(t('ui.asset.needCaret'), 'warn')
    return false
  }
  if (!assetsAvailable()) {
    app.toast(t('ui.asset.storeUnavailable'), 'warn')
    return false
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    app.toast(t('ui.asset.tooLarge', { mb: String(Math.round(MAX_IMAGE_BYTES / (1024 * 1024))) }), 'warn')
    return false
  }
  let meta: AssetMeta
  try {
    // 嗅探要在 put 之前判：不让不合格的字节先进库（v1 没有 GC）
    const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer())
    if (!sniffImageMime(head)) {
      app.toast(t('ui.asset.unsupported'), 'warn')
      return false
    }
    meta = await assetStore.put(blob)
  } catch (e) {
    // 解码失败（createImageBitmap 读不出尺寸）与配额/权限失败都走这里
    console.warn('[assets] put failed:', e)
    app.toast(t('ui.asset.putFailed'), 'warn')
    return false
  }
  // 入库成功 ⇒ 立刻登记，新 run 的首帧就能画出图（不用等下一次启动的 keys()）
  primeAsset(meta)
  const runId = ed.insertAssetAt(where.blockId, where.offset, meta.hash, {
    label,
    ...(meta.w !== undefined ? { w: meta.w } : {}),
    ...(meta.h !== undefined ? { h: meta.h } : {}),
  })
  if (!runId) {
    // 块在入库期间被删 / 光标越界：字节已经落库（孤儿，无害），引用不落
    app.toast(t('ui.asset.caretGone'), 'warn')
    return false
  }
  return true
}

/**
 * 选文件入口：临时 `<input type=file>`。
 *
 * 为什么临时建而不是常驻一个：这个元素只在这一刻有意义，常驻会让 `index.html`
 * 多一个谁都不认识的空控件；用完即摘（连同它的 change 监听）。
 */
function pickImageViaFileInput(): void {
  const point = ed.caretPoint()
  if (!point) {
    app.toast(t('ui.asset.needCaret'), 'warn')
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = IMAGE_MIME_ALLOWLIST.join(',')
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void insertAssetBlob(file, file.name, point)
    input.remove()
  })
  // 取消选择不派发 change：用 cancel 事件把临时节点收掉（新浏览器都有；没有也不泄漏，只是留一个游离节点）
  input.addEventListener('cancel', () => input.remove())
  input.click()
}

/**
 * **把地址交给系统浏览器**（`App.openExternal` 的实现）。
 *
 * 为什么这里只调 `window.open`：壳已经在那头等着了——`electron/main.ts` 的
 * `setWindowOpenHandler` 把 `_blank` 拦下来转成 `shell.openExternal`，只放行 http(s)；
 * web 下就是一次普通的新标签。渲染层因此不需要知道「我现在跑在哪个宿主里」。
 *
 * ⚠️ 白名单一律走 `core/link.ts`：**与主进程那一份取值相同**（`/^https?:/`）。
 *    两处分叉的表现是「界面上看着能开、点下去毫无反应」，而它不报错。
 *
 * @returns 真的发出去了才 `true`（被拦下时已经给了文案，调用方不必再说一遍）
 */
function openExternalUrl(raw: string): boolean {
  const chk = checkExternalUrl(raw)
  if (!chk.ok) {
    app.toast(rejectText(chk), 'warn')
    return false
  }
  window.open(chk.url, '_blank', 'noopener,noreferrer')
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
  ...moveCommands(pageDeps),
  ...mountCommands({
    kb,
    write: writeProps,
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...collectionCommands({
    kb,
    write: writeProps,
    run: runTx,
  }),
  ...propsCommands({
    kb,
    write: writeProps,
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...belongsToCommands({
    kb,
    // 成环检查要算祖先闭包（全库读）：判据只有 core 一份，森林由装配层收进闭包
    checkAdd: (child, parent) => checkEdge(child, parent, adjacency()),
    cycleLabels: (path) => cyclePathLabels(path, adjacency(), (id) => shortId(id)),
    danglingOf: (child) => danglingOf(child, adjacency()),
    pruneGone: (child) => pruneGone(child, adjacency()),
    /**
     * 边一改，左槽的归属树要当场变：那条树就是这条边的摊平。
     * （属性区自己会重画；槽由装配层排，所以在这里补一次。）
     */
    write: (id, fn) => {
      writeProps(id, fn)
      renderDocks()
    },
    toast: (text, kind) => app.toast(text, kind),
    shortId: (id) => shortId(id),
  }),
  removeAtom: (runId) => ed.removeRun(runId),
  openInDock: (id, side) => openWindow(side === 'left' ? 'left' : 'right', id),

  /* ---- 行内资产：入口（粘贴/选文件）与异步入库 ---- */
  /**
   * 选文件：隐藏的 `<input type=file>`。Electron 与 web 同一个入口——
   * 原生对话框只在主进程有，而这条路浏览器里也能走通，没必要分两套。
   */
  pickImage: () => pickImageViaFileInput(),
  insertAssetBlob: (blob, label, point) => insertAssetBlob(blob, label, point),

  /**
   * **打开外链**：协议白名单一过，就把地址交给壳。
   *
   * Electron 下 `window.open('_blank')` 被 `setWindowOpenHandler` 接住并转成
   * `shell.openExternal`（那份判据在 `electron/main.ts`，与主进程同侧，是信任边界上的那一道）；
   * web 下就是浏览器的新标签。两处都不在 app 里开一个裸窗口。
   */
  openExternal: (url) => openExternalUrl(url),

  /**
   * **插入外链的输入框**（斜杠菜单／⌘K ⇒ 命令不带 `url` ⇒ 走这里）。
   *
   * 与「选图片」同一条理由：要跟用户要**一句话**，而命令 handler 不许碰 DOM。
   */
  showLinkComposer: () => {
    layers.openPopover(
      (host) =>
        renderLinkComposer(host, {
          // 仍然走命令面：插入是写动作，撤销/落盘/审计都在那条路上
          insert: (url, text) => {
            layers.closePopover()
            void registry.invoke('core.editor/insert-link', { url, text }, 'popover', uiCtx())
          },
          toast: (text, kind) => app.toast(text, kind),
        }),
      ed.caretRect(),
    )
  },

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
          const parents = parentsOf(tag, adjacency())
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
  openAliasEditor: (blockId, autofocus) => openAliasEditor(blockId, ed.caretRect(), autofocus),
  openFieldsEditor: (blockId) => openFieldsEditor(blockId, null),
  setBlockType: (blockId, typeId) => applyBlockType(blockId, typeId),

  // 导航历史（中心槽走到哪）；与 undo/redo 的模型快照栈无关
  historyBack: () => historyGo('back'),
  historyForward: () => historyGo('forward'),

  ...viewCommands({
    prefs: () => prefs(),
    applyChrome,
    renderDebugState: () => chrome.renderDebugState(),
    scheduleDeviceSave,
    scheduleBadge,
    toast: (text, kind) => app.toast(text, kind),
  }),

  ...devCommands({
    replaceWorkspace: (next) => {
      ws = next
      // 换库 ⇒ 旧落点全部失效；历史留着只会把用户送到「上一份演示数据」的 id
      nav.back = []
      nav.forward = []
      /**
       * **旧库的 op 不能落到新库**：它们说的是「旧库里那块长这样」，带过河就是脏写。
       * 换库本来就是「整体换一份」，落盘会按整类提交（新库的 op 从零开始攒）。
       */
      clearPendingOps()
      /**
       * ⚠️ 换库的次序：**先换 store 的内容，再取 `p`**。
       *
       * `kb`／`blocks` 是同一个 store 实例（`reset` 原地换内容，门面不用换）；
       * 此刻 store 里仍是上一份库，只换 `ws` 不换内容的话，
       * `activeBlock()` 就会在**旧库**里找新库的 `activeId`：找不到便落到 `kb.roots()[0]`
       * 这条兜底上，拿回**旧库首块**再装进新库的视图（表现为「重开后字丢了」）。
       * 反过来，`p` 也不能早于这一步 —— 换了库却还拿旧落点，等于把旧块装进新库。
       */
      /**
       * **折叠态不能带过河**：旧库的块 id 在新库里不存在（或指到另一块），
       * 留着只会让新库的行莫名其妙地折起来 ⇒ 换库即清空（设备那侧的偏好则保留）。
       */
      device.folded = {}
      scheduleDeviceSave()
      blocks.reset(next.blocks)
      const p = activeBlock()
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
      const feed = isJournal(p) ? feedDays(ws.blocks, FEED_INITIAL) : []
      const roots = feed.length > 0 ? rootsForMany(feed) : rootsFor(p)
      // 装载边界同一条归一：空 journal 天经事务补首子块（演示换库也是一次「打开」）
      materializeEditableRoots(roots)
      // ⚠️ 光标必须落在**第一个可编辑的行**上（日记流的第一段是只读日期行）。
      //    原来固定 `roots[0]`，于是载入假数据后光标停在日期行、第一行看着「没有名字」。
      const caret = firstEditableRoot(roots[0])
      mainEd.loadPage({ roots, folded: device.folded }, { blockId: caret?.id ?? '', off: 0 })
      renderMounts()
      chrome.renderEmptyHint(activeBlock().children)
      saveNow()
      scheduleBadge()
    },
    prefs: () => prefs(),
    setVirtualize: (on, radius) => {
      // 虚拟化档位是**设备状态**：下次冷启动按它恢复（`applyChrome` 之后的启动段读它）
      prefs().virtualize = on
      prefs().radius = radius
      mainEd.setVirtualize(on, radius)
    },
    scheduleDeviceSave,
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
    triggerCh = null
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
 * ⚠️ 写操作走 `writeProps`：它自带「重画这一行」——别名头就在这一行的 DOM 里。
 */
/**
 * @param anchor 可以是**那颗按钮**（浮层跟着它走），也可以是一个矩形（没有稳定元素时，
 *   例如命令面按光标位置打开）。两者都收，是因为调用者确实有这两种情形。
 */
const openAliasEditor = (blockId: string, anchor: HTMLElement | DOMRect | null, autofocus = false): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openPopover(
    (host) =>
      renderAliasEditor(host, {
        kb,
        block: () => findInForest(ws.blocks, blockId),
        write: (mutate) => writeProps(blockId, mutate),
        close: () => layers.closePopover(),
        toast: (text, kind) => app.toast(text, kind),
        autofocus,
      }),
    // 元素锚点会跟着那一颗按钮走（行随重渲染被换掉时由 `anchorOf` 兜住「不在了」）
    anchor === null ? null : anchor instanceof HTMLElement ? anchorOf(anchor) : anchor,
  )
}

/**
 * 字段声明抽屉。**不用锚点**：抽屉贴着窗口右缘整高铺开，锚点对它没有意义
 * （它不是「指向某一处」的浮层，是一个面板）。所以这里收 `_anchor` 只为签名一致。
 */
const openFieldsEditor = (blockId: string, _anchor: HTMLElement | null): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openDrawer(
    t('ui.alias.fieldsTitle'),
    (host) =>
      renderFieldsEditor(host, {
        kb,
        block: () => findInForest(ws.blocks, blockId),
        write: (mutate) => writeProps(blockId, mutate),
        close: () => layers.closeDrawer(),
        toast: (text, kind) => app.toast(text, kind),
      }),
  )
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
  // 折叠态是**设备**那份（`qua.device`）：换机器就是另一份，换库时由 `replaceWorkspace` 清空
  doc: { roots: bootRoots, folded: device.folded },
  /**
   * 写入事务入口。`mainEd` 是 `let`（焦点切到别的编辑器时它会变），所以这里
   * **现取**当前实例当 source，而不是把此刻的值焊进闭包。
   */
  write: (fn) => run(fn, mainEd),
})
mainEd = ed
/**
 * 焦点在正文 → 活动编辑器＝正文；焦点在里层编辑岛时由那一层自己切
 * （挂载区的 `onFocus`／右槽窗口的 `onFocus`）。
 *
 * ⚠️ **`focusin` 会冒泡，所以这里必须让位**：挂载区／组件体的 DOM 都**嵌在 `#editor` 里**，
 *    里层的 `focusin` 先跑（把 `ed` 切成挂载区），冒泡到这儿再无条件改回正文 ⇒
 *    里层那一次等于没发生，`ed` 永远停在正文。
 *
 *    后果只在**命令层**上现身：打字走事件层（各编辑器自己把 `input` 绑在自己的 container 上），
 *    所以在挂载区里打字一直是对的；而 ↵／⌘A／Tab 这些走 `app.ed` 的键位会被**正文**接走。
 *    实测（`checks/probe-mount-enter.mjs`）：在「提及」里按 ↵ ⇒ 新块建在**命中块的后面**
 *    （兄弟，不是子块）⇒ 它不满足这一栏的查询条件 ⇒ **用户在原地看不见自己刚建的东西**，
 *    而光标被甩到正文。点上 ⌘A 也能看出活动编辑器仍是正文。
 */
editorEl.addEventListener('focusin', () => {
  if (!mainEd.ownFocus()) return
  ed = mainEd
})

/**
 * **一台视图编辑器的完整事件表**：正文、挂载区、查询结果**共用这一份**。
 *
 * 为什么收成一个函数：这些编辑器是同一种东西（`BlockEditor` ＋ 一份 roots），
 * 差别只在「装载谁」。三处各接一半 ⇒ 面板里点引用不跳、右键没有块菜单、「#」不弹补全，
 * 而这些漏接都不报错。改一处就该三处一起变。
 *
 * `change` 由调用方给：各自要刷的集合不同（正文还要刷空态提示与侧槽卡片）。
 * `editor` 传一个取值函数而不是实例：`ed` 是 `let`（焦点切走时会变）。
 */
function viewEvents(editor: () => BlockEditor, change: ViewEvents['change'], via: string): ViewEvents {
  const active = () => editor()
  return {
    change,
    /**
     * **编辑边界上撞名**：正文已经被编辑器回滚成改名前那个值，这里只负责说一句为什么。
     * 拒绝发生在用户离开这一行的那一刻，途中没有可以放确认框的位置 —— 提示是唯一的出口。
     */
    editRejected: (name, conflict) => {
      app.toast(t('ui.toast.nameTaken', { name, where: takenWhere(conflict) }), 'warn')
    },
    // 划选气泡（顶部工具栏作废后的落点）：选区一变就重算「该不该在、装哪几颗」
    selChange: () => {
      refreshSelectionBar()
    },
    /**
     * 编辑器报「此刻在敲什么」：同一个触发字符继续打字就只换行（浮层不重建、不抢焦点），
     * 换成另一个字符（或从关闭状态敲下）才重新打开。
     */
    triggerQuery: (hit, rect) => {
      if (hit === null) {
        if (triggerCh) {
          triggerCh = null
          layers.closeMenu()
        }
        return
      }
      const trigger = triggers.get(hit.ch)
      if (!trigger) return
      if (triggerCh === hit.ch && layers.open) {
        if (hit.query !== lastQuery) {
          lastQuery = hit.query
          layers.setRows(trigger.source(hit.query))
        }
        return
      }
      openTrigger(hit.ch, hit.query, rect)
    },
    refClick: (ref, mods, el) => handleRefClick(ref, mods, el),
    /**
     * **资产此刻的样子**：所有编辑器实例共用这一个函数，于是同一张图在
     * 正文／挂载区／查询结果／侧槽里长得一样（同一份答案，不是四份实现）。
     * 字节缺失 ⇒ `missing`，资产库打不开 ⇒ `unavailable`；两者都不抛错、不空白。
     */
    assetView: assetViewOf,
    /**
     * 非引用的行内对象被点：图片默认开 lightbox，`⌥` 才看详情；
     * 缺失/不可用**不开空 lightbox**，直接给详情（那里面说清为什么没有图）。
     */
    onAtomClick: (atom, el, mods) => {
      if (atom.kind === 'link') {
        /**
         * 外链：**左键＝打开**，⌥ ＝ 看详情（与图片同款分工：默认动作 / 详情）。
         * 打开走命令 ⇒ 协议白名单、对外接口、将来的审计都在一条路上。
         */
        if (!mods.altKey) {
          void registry.invoke('core.link/open', { atomId: atom.runId }, via)
          return
        }
        showAtomPopover(findRunOrNull(atom.runId) ?? ({ id: atom.runId, t: 'ref' } as RunWithId), anchorOf(el))
        return
      }
      if (atom.kind !== 'asset' || !atom.hash) {
        // 将来别的行内对象：先给详情（它们的「打开」还没做，别假装做了）
        if (atom.runId) showAtomPopover(findRunOrNull(atom.runId) ?? ({ id: atom.runId, t: 'ref' } as RunWithId), anchorOf(el))
        return
      }
      const view = assetViewOf(atom.hash)
      if (!mods.altKey && view.state === 'ready' && (view.mime ?? '').startsWith('image/')) {
        openLightbox(atom.hash, view, el)
        return
      }
      showAssetDetails(atom.runId, atom.hash, el)
    },
    /**
     * 粘贴图片：落点在事件里已经捕获，这里只管校验 → 入库 → 插 run。
     * 失败一律有文案（用户刚按了粘贴，「什么都没发生」是最糟的反馈）。
     */
    onPasteImage: async (file, point) => {
      await app.insertAssetBlob(file, file.name || t('ui.asset.pastedName'), point ?? undefined)
    },
    /** 拖入文件：v1 不做，但必须给一句明确的话（而不是「拖进来什么都没发生」） */
    onDropFilesRejected: () => app.toast(t('ui.asset.dropUnsupported'), 'warn'),
    /**
     * 正文里的组件体（`ui/dock-widgets.ts` 画，`view` 只留契约）。
     *
     * ⚠️ `find` 传的是共享 store 的那一个：摘要要数「还有几条活着」，
     *    而集合里的块可能在当前视图之外（另一页／另一天），只有整片森林答得出来。
     * ⚠️ 这里**不判**静止档是摘要还是完整 UI —— 那是类型声明的事，判据与画法
     *    一起住在 `widgetBodyInDoc`。装配层只递「宿主能力」。
     */
    widgetBody: (block, find, mode) => widgetBodyInDoc(block, find, dockWidgetDeps(), mode),
    // 复盘空天格子里落笔：编辑器只报日期，物化那一天（幂等）与重装载归命令层
    shellWrite: (date) => void app.journalShellWrite(date),
    // **左键点块标 ＝ 聚焦/zoom**。与面包屑那一格同一条命令，
    // 所以「点块标进去」与「点面包屑出来」共用一套语义，没有第二种入口。
    focusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, via),
    // Shift+点块标 ⇒ 在右槽打开一个窗口（已在别处则移过去；已在本侧则定位）
    openInDock: (blockId) => openWindow('right', blockId),
    blockMenu: (blockId, rect) => {
      const ed = active()
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
}

/**
 * **给任何一台视图编辑器接上与正文同一套事件**（`viewEvents` 是唯一一份）。
 *
 * 挂载区、查询结果、侧槽窗口都走它——事件表按落点挑几支的接法漏接不报错
 * （右键没菜单、`#` 不弹补全、撞名没提示），所以这里不存在「挑几支」的分支。
 */
function wireViewEditor(editor: BlockEditor, change: ViewEvents['change'], via: string): void {
  editor.events = viewEvents(() => editor, change, via)
}

ed.events = viewEvents(
  () => mainEd,
  () => {
    syncSections()
    scheduleSave()
    chrome.renderEmptyHint(activeBlock().children)
    renderDocks() // 块数变了要更新
    scheduleBadge()
  },
  'editor',
)
/**
 * **撤销/重做产出的 op** 并进待落盘队列。
 *
 * 撤销现在与一次普通编辑走同一条路（`diff` → op → 增量写盘），
 * 所以它需要的只是「把 op 交出来」，不再需要「整库重写」那条旁路。
 */
ed.events.undoOps = (ops) => {
  addOps(ops)
  scheduleSave()
}

/**
 * **字节到达时重画引用了它的那几行**。
 *
 * 为什么需要这一步：渲染是同步纯函数（`fillBlockText`），它拿不到还停在 IndexedDB 里的
 * 字节。第一帧画的是「文件占位」，字节取到、对象 URL 建好之后必须有人把那一行换掉——
 * 否则图永远停在一个占位上，而用户以为图坏了。
 *
 * 只重画**引用了这个 hash 的块**（不是 `renderAll`）：重排整页会打断正在输入的那一行。
 */
onAssetReady((hash) => {
  const hit = new Set<string>()
  for (const b of flatten({ roots: blocks.blocks })) {
    if (b.content.some((r) => r.t === 'asset' && r.asset === hash)) hit.add(b.id)
  }
  for (const id of hit) repaintBlock(id)
  // 重画换了节点（文件占位 → 真图）⇒ 角标里的 DOM 读数是**派生量**，也要跟着排一次刷新。
  // 漏了这一行的症状：首屏图是最先出现的东西，角标却会停在占位那一帧的数上，直到下一次交互。
  scheduleBadge()
})

let panels: ReturnType<typeof setupPanels>
let diag: ReturnType<typeof setupDiagnostics>
const { renderMounts, renderProperties, scheduleProperties, pickRefValue } = setupPanels({
  blocks,
  kb,
  app,
  layers,
  shortId,
  activeBlock,
  run,
  syncSections,
  scheduleSave,
  scheduleBadge,
  refClick: handleRefClick,
  // 挂载区/查询结果接的是**同一份**事件表（差别只在「装载谁」）
  wireEditor: (editor, change, via) => wireViewEditor(editor, change, via),
  getWs: () => ws,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  getChrome: () => chrome,
  openInDock: (blockId) => openWindow('right', blockId),
})
panels = {
  renderMounts,
  renderProperties,
  scheduleProperties,
  pickRefValue,
}

/**
 * 行内实例的字段卡：只读写**记录块**的 props。
 *
 * `pickRefValue` 来自面板装配（候选集合与属性区共用一份）；
 * 值的写入走同两条属性命令，随后由 `writeProps` 重画行与属性区。
 */
objFieldDeps = {
  rows: (recordId) => kb.fieldsOf(recordId),
  setValue: (recordId, propId, value) =>
    void registry.invoke('core.props/set-value', { blockId: recordId, propId, value }, 'popover'),
  clearValue: (recordId, propId) =>
    void registry.invoke('core.props/clear-value', { blockId: recordId, propId }, 'popover'),
  pickRef: pickRefValue,
  refLabel: (targetId) => {
    const b = kb.get(targetId)
    return b ? blockName(b) : t('ui.props.refMissing', { id: shortId(targetId) })
  },
}

document.addEventListener('mousedown', (e) => {
  const target = e.target as Node
  if (!layers.popoverOpen()) return
  // 气泡自己的控件（别名编辑器、引用详情里的按钮）不算「点到外面」——
  // 否则 mousedown 就把宿主节点摘掉，后续 click 根本落不到按钮上。
  if (layers.popoverContains(target)) return
  if ((target as HTMLElement).closest?.('.atom')) return
  // 从浮层里打开的引用选择器（`.layer`）不算「点到外面」：选完还要回浮层继续改
  if ((target as HTMLElement).closest?.('.layer')) return
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
  if (action.dataset.aliasAction === 'fields') openFieldsEditor(blockId, action)
  else openAliasEditor(blockId, action)
})

window.addEventListener('beforeunload', () => {
  saveNow()
  saveDeviceNow()
})

/* ------------------------------------------------------------ 启动 */

registry = new Registry(
  app,
  HANDLERS,
  // 产品构建只去掉 `dev.` 开头那几条**声明**；处理器表原样注入 ——
  // 没有声明的命令从命令面板、斜杠菜单里就看不见，`invoke` 也仍是唯一入口。
  DEV_SURFACE ? COMMANDS : COMMANDS.filter((d) => !d.name.startsWith(DEV_COMMAND_PREFIX)),
)

// 让「块菜单」这类命令也能从面板/键盘走到
ed.events.mounted = () => {
  scheduleBadge()
  // 段是每次渲染新建的：挂载区按段根建实例，重挂之后要把实例搬进新的空槽
  // （虚拟化滚出窗口再滚回来也走这一条，所以实例必须复用、不能重建）
  renderMounts()
}

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
 * 「添加组件」画廊：复用命令面板的列表/搜索/键盘。
 *
 * 两类条目共用一张列表：
 *   · 带 `tile` 的命令 → `cmd:<命令名>` 小卡；
 *   · 「新建收藏」→ 一个 `core/collection-widget` 块，建完直接开进这一槽。
 * 命令是**策展过的**集合（不是所有命令）；集合则是一个真正的组件块。
 */
function showWidgetGallery(side: 'left' | 'right'): void {
  const cards = prefs().dock[side].cards
  const taken = new Set(cards.filter((id) => id.startsWith('cmd:')))
  /**
   * **派生卡的目录**：固定 id ＋ 标题 ＋ 图标 ＋ 一个显式的 `derived` 标记。
   *
   * 为什么它们要和「带 `tile` 的命令」并列在同一张画廊里：派生卡**没有关闭按钮**
   * （关掉就没有再加回来的入口），所以「加回来」必须有一个地方。
   * 不带 `derived` 标记的话，`onPick` 只能靠「id 里有没有点号」去猜它是命令还是卡片 ——
   * 那是用字符串形状代替类型，而猜错的表现是「点了没反应」。
   */
  const DERIVED: { id: string; label: string; icon: string }[] = [
    { id: 'calendar', label: t('ui.cal.title'), icon: 'lucide:calendar' },
    { id: 'belongs', label: t('ui.belongs.treeTitle'), icon: 'lucide:list-tree' },
    { id: 'inspect', label: t('ui.dock.inspect'), icon: 'lucide:sliders-horizontal' },
    { id: 'backrefs', label: t('ui.dock.backRefs'), icon: 'lucide:corner-up-left' },
    { id: 'trash', label: t('ui.dock.trash'), icon: 'lucide:trash-2' },
  ]
  const rows: Row[] = [
    ...registry
      .list()
      .filter((d) => d.tile && !d.hidden && !taken.has(`cmd:${d.name}`))
      .map((d) => ({
        id: d.name,
        label: d.title,
        hint: d.name,
        icon: d.tile!.icon,
        group: `palette/${d.category}`,
        command: d.name,
        keyHint: keyHints().get(d.name),
      })),
    ...DERIVED.filter((d) => !cards.includes(d.id)).map((d) => ({
      id: `derived:${d.id}`,
      label: d.label,
      hint: '',
      icon: d.icon,
      group: `palette/${t('menu.cat.widget')}`,
      keyHint: undefined,
    })),
    {
      id: 'new-collection',
      label: t('ui.widget.newCollection'),
      hint: '',
      icon: 'lucide:list-tree',
      group: `palette/${t('menu.cat.widget')}`,
      keyHint: undefined,
    },
  ].sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label))
  layers.openMenu({
    rows,
    anchor: null,
    title: t('ui.dock.tileGallery'),
    searchable: true,
    focusSearch: true,
    placeholder: t('ui.palette.placeholder'),
    emptyText: t('ui.dock.tileGalleryEmpty'),
    onPick: (row) => {
      if (row.id === 'new-collection') {
        void registry.invoke('core.collection/create', { side }, 'dock')
        return
      }
      // `derived:` 前缀是**画廊内部的判据**，不进 `cards`（那里存的是裸 id）
      if (row.id.startsWith('derived:')) {
        addDerived(side, row.id.slice('derived:'.length))
        return
      }
      if (row.command) addTile(side, row.command)
    },
  })
}

/**
 * 集合卡的块选择器：列出还没在收藏里的块，选中即加一条引用。
 * 复用命令面板的列表/搜索/键盘；锚在「选择块」按钮上。
 */
function showCollectionPicker(collectionId: string, anchor: DOMRect): void {
  const collection = findInForest(ws.blocks, collectionId)
  const taken = new Set(collectionItems(collection))
  const rows: Row[] = flatten({ roots: ws.blocks })
    .filter((b) => b.id !== collectionId && !taken.has(b.id))
    .map((b) => ({
      id: b.id,
      label: displayNameOf(b).trim() || plainText(b.content).trim() || t('ui.page.untitled'),
      hint: shortId(b.id),
      icon: prop<string>(b, '_icon') ?? 'lucide:file',
      group: `palette/${t('menu.cat.page')}`,
    }))
  layers.openMenu({
    rows,
    anchor,
    title: t('ui.widget.pickBlock'),
    searchable: true,
    focusSearch: true,
    placeholder: t('ui.palette.placeholder'),
    emptyText: t('ui.widget.pickBlockEmpty'),
    onPick: (row) => {
      void registry.invoke('core.collection/add', { collectionId, blockId: row.id }, 'dock')
      renderDocks()
    },
  })
}

const dockLeft = mountDockSlot($('dock-left'), {
  side: 'left',
  title: t('ui.dock.leftTitle'),
  addLabel: t('ui.dock.addTile'),
  collapseLabel: t('ui.dock.collapseLeft'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-left',
  onAdd: () => showWidgetGallery('left'),
  onCollapse: () => registry.invoke('core.dock/toggle-left', {}, 'dock'),
})
const dockRight = mountDockSlot($('dock-right'), {
  side: 'right',
  title: t('ui.dock.rightTitle'),
  addLabel: t('ui.dock.addTile'),
  collapseLabel: t('ui.dock.collapseRight'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-right',
  onAdd: () => showWidgetGallery('right'),
  onCollapse: () => registry.invoke('core.dock/toggle-right', {}, 'dock'),
})

/**
 * 窗口：每个侧槽一个管理器，按块 id 建一张卡（卡里是**真实块**的编辑器，共享 store）。
 *
 * 依赖一律是读函数（库会被整体替换，传值会拿到过期快照）。
 */
const dockWindowsDeps = (side: 'left' | 'right'): ConstructorParameters<typeof DockWindows>[0] => ({
  store: blocks,
  /**
   * 窗口里的编辑器按**块**各一个实例，组件不把它们吐出来；但点进窗口里编辑时
   * `onFocus` 会把 `ed` 切到那一个。所以取「当前活动编辑器」，
   * 只有在焦点不在任何窗口里时才会落到别处 —— 那种情况下窗口里也不会有人正在写。
   */
  write: (fn) => run(fn, ed),
  kb,
  label: windowLabel,
  onClose: (blockId) => closeCard(side, blockId),
  /**
   * 窗口编辑器也接**整份** `viewEvents`（与挂载区/查询结果同一条口径）。
   *
   * ⚠️ 必须整份接上：只手接几支（change/块标/右槽/引用）的做法漏接不报错——
   * 右键块菜单、`#`·`@` 补全、撞名提示这些在窗口里点了就是没反应。
   */
  wire: (editor, change) => wireViewEditor(editor, change, 'dock'),
  onFocus: (editor) => {
    ed = editor
    scheduleBadge()
  },
  /** 窗口被拆掉时，别让 `ed` 指着一个已经 dispose 的编辑器 */
  onDispose: (editor) => {
    if (ed !== editor) return
    ed = mainEd
    scheduleBadge()
  },
  // 窗口内编辑：只落盘与刷角标，**不重画槽**（重画会打断这一行的输入）
  onChange: () => {
    syncSections()
    scheduleSave()
    scheduleBadge()
  },
  cardState: (blockId) => cardStateFor(side, blockId),
})

setWindows({
  left: new DockWindows(dockWindowsDeps('left')),
  right: new DockWindows(dockWindowsDeps('right')),
})

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
      scheduleDeviceSave()
    },
    onReset: () => {
      prefs().dock[side].width = null
      applyChrome()
      scheduleDeviceSave()
    },
  })
}
bindResize('left', dockLeft)
bindResize('right', dockRight)
diag = setupDiagnostics({
  DEV_SURFACE,
  store,
  boot,
  readOnly,
  bootNotice,
  prefs,
  resolvedTheme,
  applyChrome,
  chrome,
  badge,
  scheduleDeviceSave,
  scheduleBadge,
  getLastOps,
  registry,
  app,
  layers,
  editorEl,
  shortId,
  activeBlock,
  pageTitle,
  nav,
  uiCtx,
  showMenu,
  openDrawerFor,
  firstEditableRoot,
  stateMenuBtn,
  getWs: () => ws,
  getMainEd: () => mainEd,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  setQuiet: (v) => {
    quiet = v
  },
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
  /**
   * ⚠️ **组合期不追加**（与 `appendRoots` 的守卫同一条理由）：这里必须在 `materializeEditableRoots`
   *    **之前**返回——那一步会物化根并改模型，而渲染会被 `appendRoots` 推迟，两者就分叉了。
   *    推迟到组合结束：用户下一次滚到底会再触发一次。
   */
  if (mainEd.probe.isComposing) return false
  // 增量加载只在单列流成立：横排／网格的段数由打开它的入口定死，「往下滚」不是「要更旧的天」
  if (mainEd.layout !== 'column') return false
  if (roots.length <= 1 || !roots.every((r) => isJournal(r))) return false
  const active = activeBlock()
  if (!isJournal(active)) return false
  if (roots.length >= FEED_MAX) return false
  const loaded = new Set(roots.map((r) => r.id))
  const limit = Math.min(roots.length + FEED_STEP, FEED_MAX)
  const more = feedDays(ws.blocks, limit)
    .filter((d) => !loaded.has(d.id))
    .slice(0, limit - roots.length)
  if (more.length === 0) return false
  materializeEditableRoots(more)
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

markBooted()

// 首屏填满：如果 3 天还撑不满视口（短日记），补到能滚为止 —— 否则「下滚加载」没有触发条件。
// 教训：初始只装 1 条连第一屏都撑不满，用户不会去「加载更多」。
requestAnimationFrame(() => {
  for (let i = 0; i < 6; i++) {
    const el = chrome.blankAreaEl
    if (el.scrollHeight > el.clientHeight + 8) break
    if (!appendMoreFeed()) break
  }
})
