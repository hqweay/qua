/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 工具栏 / 命令面板同样只是 `resolveBindings(kind, ctx)` 的渲染结果。
 */
import './styles.css'
import { addAlias, addList, addressesOf, aliasesOf, allPropDefs, allTags, blockTypeOf, checkAddParent, cyclePathLabels, DISPLAY_PROP, listsOf, tagIdsOf, childTags, claimAlias, danglingParentIds, declaredFieldIds, displayNameOf, ensureFirstBlock, ensureTodayJournal, fieldRows, findInForest, findPath, findByAlias, flatten, FEED_INITIAL, FEED_MAX, FEED_STEP, hasList, identityTags, isJournal, journalDate, journalFeedDays, membersOf, mkBlock, normalizeAlias, parentTags, primaryAliasOf, prop, propKindOf, pruneParentTags, removeList, resolveRef, setBlockType, tagMemberIds, todayISO, todoOf, type Atom, type Block, type CtxKeys } from './core/index.ts'
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
  type FixtureName,
  type MenuRequest,
  type PanelKind,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type Row } from './ui/layers.ts'
import { dispatchKey, installKeydown, type DispatchEnv } from './core/dispatch.ts'
import { DockBlocks } from './ui/dock-blocks.ts'
import { bindDockResize } from './ui/dock-resize.ts'
import { isReadonlyBlock } from './view/block-dom.ts'
import { mountDockSlot } from './ui/dock.ts'
import { createIcon } from './view/icons.ts'
import { renderAliasEditor } from './ui/alias-editor.ts'
import { renderFieldsEditor } from './ui/fields-editor.ts'
import { openDrawerFor as panelDrawer, showAtomPopover as panelPopover, type PanelDeps } from './ui/panels.ts'
import { devCommands, journalCommands, pageCommands, propsCommands, rootsFor, rootsForMany, tagTreeCommands, takenWhere, viewCommands, zoomCommands, type PageDeps } from './app/commands-impl.ts'
import { setupPersistence } from './app/wiring/persistence.ts'
import { setupDocks } from './app/wiring/docks.ts'
import { setupPanels } from './app/wiring/panels.ts'
import { setupChrome } from './app/wiring/chrome.ts'
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
const bootDays = bootActive && isJournal(bootActive) ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
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
/**
 * 偏好**不活在库里**（v15 起）：它是这台设备怎么显示（主题／槽宽／钉住的块）。
 * 调用点仍按「拿到一份可改的偏好对象」用它 —— 改完由 `scheduleDeviceSave()` 落盘。
 */
const prefs = (): Prefs => device.prefs
/**
 * 「当前对象」＝ 中心槽持有的那个块（只有中心槽有这个概念）。
 *
 * ⚠️ 它**不只是页**：`journal` 也是中心槽的默认内容；zoom 之后还能是
 *   **任意深度的块**⇒ 必须在**整片森林**里找，不能只看顶层。
 */
const activeBlock = (): Block => kb.get(ws.activeId) ?? kb.roots()[0]!

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
})

const { chrome, editorEl, applyChrome, resolvedTheme, dockMinWidth, dockMaxWidth, badge, scheduleBadge, markBooted } = setupChrome({
  prefs,
  bootNotice,
  shortId,
  uiCtx,
  activeBlock,
  pageTitle,
  $,
  getWs: () => ws,
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  domStats,
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
 * **装载边界的可编辑保证**：被装进中心编辑器的 journal 天至少要有一个子块——
 * 日期行只读，没有子块就没有可落光标的地方（「打得开却打不了字」）。
 *
 * 这是**写库**，不是渲染兜底：渲染兜底会让「看到的块」与「库里的块」分叉，
 * 补的块经事务真的进库（一条 `insert`，op 里报它自己的落点）。
 * 所有装载入口共用这一个落点（`loadPage`／日记流增量／演示换库）；
 * 「新建」一类造数据的路径不走这里——它们在创建时就该把子块带上（同一笔插入）。
 * 冷启动在仓库构建之前、走不了事务，仍由模型层归一（`ensureFirstBlock`）。
 */
function materializeEditableRoots(roots: readonly Block[]): void {
  for (const r of roots) {
    if (isJournal(r) && r.children.length === 0) run((tx) => tx.insert(mkBlock(''), r.id, 0), mainEd)
  }
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
    const before = blocks.snap(ed.sel)
    const r = txRun(fn, mainEd)
    if (r.ops.length > 0) blocks.record(before, 'other', Date.now())
    for (const id of new Set(r.changes.filter((c) => c.kind === 'blocks').map((c) => c.id))) repaintBlock(id)
    scheduleSave()
    scheduleBadge()
    return r
  },
  removeBlock: (id) => {
    // 删页：整棵子树原位标记（软删）。走 `run` 是为了产出 op —— 命令层只声明「删这块」，
    // 打标记由事务那一份实现负责（一条 op，只落操作根）。
    run((tx) => tx.remove(id), mainEd)
  },
  insertBlock: (block, parentId, index) => {
    // 与 `removeBlock` 对称的结构写入口：插一棵子树（含自带的首子块），
    // op 由事务产出——每个后代报它们自己的 parent/index，换库后行行有落点。
    run((tx) => tx.insert(block, parentId, index), mainEd)
  },
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
    // 装载边界：空 journal 天在这里补首子块（经事务、一条 op）——
    // 所有「打开」命令共用的唯一归一落点，`rootsFor`／命令层只选择、不写库
    materializeEditableRoots(roots)
    // 换页/换焦点对象：上一条「聚焦块」不再成立，等 focusFirstBlock 重新设上
    forgetFocusedBlock()
    ed = mainEd
    // 正文视图的折叠态是**设备**那份；取当前视图持有的那一份（`device.folded` 只在落盘时同步，可能落后一步）
    mainEd.loadPage({ roots, folded: mainEd.doc.folded }, marks as never, atoms as never)
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
 * 一次属性写入：模型改动（**经 `tx`**）＋ **一个**撤销快照 ＋ 落盘/重画。
 *
 * 写模型不再自己 `touch`/`invalidateIndex`：`kb.tx` 已经做了这两件事（索引按 op 修补），
 * 而且带着 `source: mainEd` 一起做——发起者收不到自己的通知，别的视图收得到。
 * 这里只负责 tx 管不到的两件装配层的事：**撤销快照**与**攒 op 等落盘**。
 */
function writeProps(blockId: string, mutate: () => void): void {
  const before = blocks.snap(ed.sel)
  run((tx) => tx.patch(blockId, mutate), mainEd)
  blocks.record(before, 'other', Date.now())
  scheduleProperties()
  scheduleSave()
  scheduleBadge()
}

/**
 * 重画一个块所在的行（当前活动编辑器里的；不在视图里的块是 no-op）。
 *
 * ⚠️ 别名头、标签 chip、显示模式都在这行自己的 DOM 里 —— 少了这一步，
 *    改完要等下一次整页重渲染才看得见（用户读到的是「点了没反应」）。
 * `writeBlockProps`（单块属性写）与命令层事务收尾（`PageDeps.run`／`PropsDeps.run`）共用。
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
 * 一次「改块自己的属性 ＋ 重画这一行」。
 *
 * ⚠️ 不能只调 `writeProps`：`mainEd` 是 `touch` 的发起者，**收不到自己的通知** ——
 *    见 `repaintBlock`。
 */
function writeBlockProps(blockId: string, mutate: () => void): void {
  writeProps(blockId, mutate)
  repaintBlock(blockId)
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
      const feed = isJournal(p) ? journalFeedDays(ws.blocks, todayISO(), FEED_INITIAL) : []
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
 * ⚠️ 写操作走 `writeBlockProps`：别名头就在这一行的 DOM 里，写完必须重画它。
 */
const openAliasEditor = (blockId: string, rect: DOMRect | null): void => {
  if (!findInForest(ws.blocks, blockId)) return
  layers.openPopover(
    (host) =>
      renderAliasEditor(host, {
        kb,
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
        kb,
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

const { renderBacklinks, renderProperties, renderTagPanel, renderQueryView, scheduleProperties, forgetFocusedBlock } = setupPanels({
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
    scheduleDeviceSave()
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
  badgePanel: (open: boolean) => {
    // 角标的开合是**设备状态**（下次冷启动按它恢复），不是库的内容
    prefs().badgeOpen = open
    badge.toggle(open)
    scheduleDeviceSave()
  },
  /**
   * 自检用：清掉落盘的那一份（**只清存储，不动当前内存库**）。
   * 演示状态切换不再调它：`loadState` 换库后会经由 `scheduleSave` 覆盖写，
   * 「先清后写」在异步批次下会多一次无谓的写序（曾是同步全量 save 时代的口径）。
   */
  clearStorage: () => void store.clear(),
  /**
   * 自检用：**最近一次事务**产出的 op（诊断面板不用它，只为「一次动作几条 op」留证据）。
   * 只读副本：调用方改数组不该影响这里记着的那一份。
   */
  lastOps: () => getLastOps(),
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
