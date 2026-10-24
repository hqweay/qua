/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { addAlias, addList, addressesOf,   allTags, blockTypeOf, checkAddParent, cyclePathLabels, DISPLAY_PROP,    claimAlias, danglingParentIds, declaredFieldIds, displayNameOf, ensureFirstBlock, ensureTodayJournal,  findInForest, findByAlias, flatten, FEED_INITIAL, FEED_MAX, FEED_STEP, hasList,  feedDays, isJournal,  normalizeAlias, parentTags, primaryAliasOf, prop,  pruneParentTags, removeList,  setBlockType, tagMemberIds,  type Atom, type Block, type CtxKeys } from './core/index.ts'
import { BlockStore } from './core/store.ts'
import { MemoryKb } from './core/kb/memory.ts'
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
    type MenuRequest,
  type PanelKind,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type Row } from './ui/layers.ts'
import { dispatchKey, installKeydown, type DispatchEnv } from './core/dispatch.ts'
import { DockBlocks } from './ui/dock-blocks.ts'
import { bindDockResize } from './ui/dock-resize.ts'
import { mountDockSlot } from './ui/dock.ts'
import { createIcon } from './view/icons.ts'
import { renderAliasEditor } from './ui/alias-editor.ts'
import { renderFieldsEditor } from './ui/fields-editor.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type PanelDeps } from './ui/panels.ts'
import { devCommands, journalCommands, pageCommands, propsCommands, rootsFor, rootsForMany, tagTreeCommands, takenWhere, viewCommands, zoomCommands } from './app/commands-impl.ts'
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
 */
const store = createWorkspaceStore(createLocalStorageAdapter(STORAGE_KEY))
/**
 * **设备状态**（偏好）走它自己的键与端口实例：换库不带走它，库作废也不连累它。
 * 两个端口各自持有一份写队列 —— 它们的字节落在两个键上，没有共同的写入顺序。
 */
const deviceStore = createDeviceStore(createLocalStorageAdapter(DEVICE_KEY))

/**
 * 读盘**是异步的**（71.5 第 2 条：上层不得依赖同步返回）。
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
 * ⚠️ 空天的首子块在**这里**就地补：冷启动发生在仓库构建之前，走不了事务，
 *    补的块随冷启动后的整库落盘一起进盘——运行时的装载边界才走事务（`materializeEditableRoots`）。
 */
const bootActive = findInForest(ws.blocks, ws.activeId) ?? ws.blocks[0]
const bootDays = bootActive && isJournal(bootActive) ? feedDays(ws.blocks, FEED_INITIAL) : []
for (const day of bootDays) ensureFirstBlock(day.children)
const bootRoots: Block[] = bootDays.length > 0 ? rootsForMany(bootDays) : bootActive ? rootsFor(bootActive) : []

/**
 * **共享 block store**（下一层）：块/anchors/undo 只有一份；
 * 正文、反链、查询视图都是它的投影。多个 `BlockEditor` 读同一份活块。
 */
const blocks = new BlockStore(ws.blocks, ws.marks, ws.atoms)
/**
 * **读入口**：渲染侧的读都该经它取，而不是自己去 `ws.blocks` 里找。
 *
 * 装配层先接上读面，写面（`tx`）仍走原来的写路径；这样换掉「整库在内存」
 * 的实现时，改的是这一个构造参数，而不是每个调用方。
 * ⚠️ **换库（`dev` 换演示数据）不换它**：门面只持有 store 这一个实例，
 *    `reset` 原地换内容 ⇒ 门面读到的永远是当前库（依赖注入才能按值传）。
 */
const kb = new MemoryKb(blocks)

const layers = new Layers(() => isMac())
let ed: BlockEditor
/** 中心槽的主编辑器；`ed` 是「当前活动编辑器」（正文或反链 footer） */
let mainEd: BlockEditor
let registry: Registry
let slashOpen = false
let lastSlashQuery = ''
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

/* ------------------------------------------------------------ 槽内容 */

const { renderDocks, addPin, unpinBlock, togglePin, setPins } = setupDocks({
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
} = setupPersistence({
  store,
  deviceStore,
  device,
  blocks,
  kb,
  readOnly,
  errText,
  layers,
  getWs: () => ws,
  getMainEd: () => mainEd,
  getChrome: () => chrome,
  isQuiet: () => quiet,
})

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
 * `trace` 写回编辑器的探针队列 ——那是「按键命中追踪」诊断的数据源。
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
    kb,
    write: writeProps,
    // 命令层开事务（新建定义＋声明是同一笔）：装配层补撤销快照，零 op 不记；
    // 声明改到的那一行要当场重画（gutter 字段住在一行自己的 DOM 里）
    run: (fn) => {
      const before = blocks.snap(ed.sel)
      const r = txRun(fn, mainEd)
      if (r.ops.length > 0) blocks.record(before, 'other', Date.now())
      for (const id of new Set(r.changes.filter((c) => c.kind === 'blocks').map((c) => c.id))) repaintBlock(id)
      scheduleProperties()
      scheduleSave()
      scheduleBadge()
      return r
    },
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...tagTreeCommands({
    kb,
    // 成环检查要算祖先闭包（全库读）：判据只有 core 一份，森林由装配层收进闭包
    checkAdd: (child, parent) => checkAddParent(child, parent, ws.blocks),
    cycleLabels: (path) => cyclePathLabels(path, ws.blocks, (id) => shortId(id)),
    danglingOf: (tag) => danglingParentIds(tag, ws.blocks),
    pruneDangling: (tag) => pruneParentTags(tag, ws.blocks),
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
      blocks.reset(next.blocks, next.marks, next.atoms)
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
      mainEd.loadPage({ roots, folded: device.folded }, ws.marks, ws.atoms, { blockId: caret?.id ?? '', off: 0 })
      renderBacklinks()
      renderQueryView()
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
 * ⚠️ 写操作走 `writeProps`：它自带「重画这一行」——别名头就在这一行的 DOM 里。
 */
const openAliasEditor = (blockId: string, rect: DOMRect | null): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openPopover(
    (host) =>
      renderAliasEditor(host, {
        kb,
        block: () => findInForest(ws.blocks, blockId),
        write: (mutate) => writeProps(blockId, mutate),
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
  marks: ws.marks,
  atoms: ws.atoms,
  /**
   * 写入事务入口。`mainEd` 是 `let`（焦点切到别的编辑器时它会变），所以这里
   * **现取**当前实例当 source，而不是把此刻的值焊进闭包。
   */
  write: (fn) => run(fn, mainEd),
})
mainEd = ed
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
  // 复盘空天格子里落笔：编辑器只报日期，物化那一天（幂等）与重装载归命令层
  shellWrite: (date) => void app.journalShellWrite(date),
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

let panels: ReturnType<typeof setupPanels>
let diag: ReturnType<typeof setupDiagnostics>
const { renderBacklinks, renderProperties, renderTagPanel, renderQueryView, scheduleProperties } = setupPanels({
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
  handleAtomClick,
  getWs: () => ws,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  getChrome: () => chrome,
})
panels = {
  renderBacklinks,
  renderProperties,
  renderTagPanel,
  renderQueryView,
  scheduleProperties,
}

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
  /**
   * 槽里的编辑器按**块**各一个实例，组件不把它们吐出来；但点进槽里编辑时
   * `onFocus` 会把 `ed` 切到那一个（`DockBlocks` 的焦点负责这件事）。
   * 所以取「当前活动编辑器」，只有在「焦点不在任何槽内编辑器」时才会落到别处 ——
   * 而那种情况下槽里也不会有人正在写。
   */
  write: (fn) => run(fn, ed),
  kb,
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

setPins({
  left: new DockBlocks(dockBlocksDeps('left', dockLeft)),
  right: new DockBlocks(dockBlocksDeps('right', dockRight)),
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
