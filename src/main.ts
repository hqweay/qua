/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 划选气泡同样只是 `resolveBindings(kind, ctx)` 的渲染结果；
 * 命令面板不经过绑定表——它枚举命令表本身（键位提示从 keymap 绑定取）。
 */
import './styles.css'
import { addAlias, addList, blockTypeOf, buildAdjacency, checkEdge, cyclePathLabels, DISPLAY_PROP,    claimAlias, danglingOf, declaredFieldIds, displayNameOf,  embedBodyOf, findInForest, flatten, FEED_INITIAL, hasList,  feedDays, hasLiveChildren, isDeleted, isJournal, journalId, listTableOf,  mkBlock, mkJournalBlock, primaryAliasOf, prop,  pruneGone, removeList,  resolveEmbed, setBlockType, tagMemberIds,  todayISO, viewNameOf, readViewSet, readEmbed, isEmbedBlock, OUTLINE_VIEW, sourceOfOwner, storedKindsFor, propDisplayLabels, propKindOf, propLabel, choicesOf, type Block, type QuerySpec, type TriggerChar, type ViewOwnerRef, trashOf, filterOfSpec } from './core/index.ts'
import { plainText } from './core/model/runs.ts'
import { checkExternalUrl, rejectText } from './core/relations/link.ts'
import { BlockStore } from './core/model/store.ts'
import { MemoryKb } from './core/kb/memory.ts'
import { validSurfaceRef } from './core/index.ts'
import type { Op } from './core/kb/types.ts'
import { BlockEditor, type ViewEvents } from './view/editor/editor.ts'
import { inputSession } from './view/editor/input-session.ts'
import { editorRun } from './view/editor/editor-run.ts'
import { fillBlockText } from './view/editor/block-dom.ts'
import {
  resolveBindings,
} from './core/infra/bindings.ts'
import {
  COMMANDS,
  Registry,
  type App,
    type MenuRequest,
} from './core/commands/index.ts'
import { Layers, paletteRows, rowsFromBindings, type PickMods, type Row } from './ui/overlay/layers.ts'
import { createTriggers, memberRows, type MemberTagRef, type TriggerDeps } from './app/retrieval/triggers.ts'
import { openTagChoice } from './app/retrieval/tag-choice.ts'
import { DockWindows } from './ui/dock/dock-windows.ts'
import { BackrefsCard } from './ui/cards/backrefs-card.ts'
import { mountDockSlot } from './ui/dock/dock.ts'
import { createIcon } from './view/icons.ts'
import { mountEmbedBody } from './ui/block-ui/embed-body.ts'
import { renderAliasEditor } from './ui/block-ui/alias-editor.ts'
import { renderLinkComposer, renderNamePrompt, type ObjFieldDeps } from './ui/overlay/panels.ts'
import { devCommands, dropIdentity, journalCommands, mentionCommands, mountCommands, moveCommands, pageCommands, propsCommands, rootsFor, rootsForMany, belongsToCommands, takenWhere, viewCommands, viewConfigCommands, zoomCommands } from './app/commands-impl.ts'
import type { TxRun } from './app/commands/types.ts'
import { setupPersistence } from './app/wiring/persistence.ts'
import { setupAxis } from './app/wiring/axis.ts'
import { setupSurface } from './app/wiring/surface.ts'
import { createRowBodyCache } from './app/wiring/row-bodies.ts'
import { setupDocks } from './app/wiring/docks.ts'
import { setupCardMenus } from './app/wiring/dock-menus.ts'
import { setupPanels } from './app/wiring/panels.ts'
import { setupAtomPopovers } from './app/wiring/atom-popovers.ts'
import { setupFeed } from './app/wiring/feed.ts'
import { installDispatch, setupKeys } from './app/wiring/keys.ts'
import { dispatchKey } from './core/infra/dispatch.ts'
import { setupOwners } from './app/wiring/owners.ts'
import { QueryTree } from './ui/query/query-tree.ts'
import { SearchFace, type SearchFaceDeps } from './ui/search/search-face.ts'
import { setupChrome } from './app/wiring/chrome.ts'
import { setupPages, type TabInfo } from './app/wiring/pages.ts'
import { renderCenterTabs as paintCenterTabs } from './ui/chrome/center-tabs.ts'
import { setupDiagnostics } from './app/wiring/diagnostics.ts'
import { HANDLERS } from './app/handlers.ts'
// 用户可见文案一律走 t；字典是零依赖叶子，Electron 主进程也 import 同一份
import { t } from './core/infra/msg.ts'
import { ensurePageInTx } from './core/index.ts'
import { seedJournalMounts, seedWorkspace } from './core/infra/seed.ts'
import { createIdbAssetStore } from './core/storage/asset-idb.ts'
import { createIpcAssetStore } from './core/storage/asset-ipc.ts'
import { ensureSeedAssets } from './core/storage/seed-assets.ts'
import { assetViewOf, assetsAvailable, loadAssetIndex, markAssetMissing, onAssetChange, primeAsset, useAssetStore } from './view/asset-views.ts'
import {
  IMAGE_MIME_ALLOWLIST,
  MAX_IMAGE_BYTES,
  sniffImageMime,
  type AssetMeta,
} from './core/infra/assets.ts'
import { createIpcAdapter, type LibraryBridge } from './core/storage/ipc-adapter.ts'
import type { FtsCommitSource } from './core/storage/fts-port.ts'
import { createSearchService, type SearchService } from './app/search/service.ts'
import { describeHit, type HitView } from './app/search/hits.ts'
import { recentBlocks } from './app/search/recents.ts'
import {
  createDeviceStore,
  createLibrarySettingsPort,
  createLocalStorageAdapter,
  createWorkspaceStore,
  DEVICE_KEY,
  STORAGE_KEY,
  type Prefs,
  type Workspace,
} from './core/infra/workspace.ts'

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

/**
 * **搜索运行时**在读完库之后才能建（索引状态是库的一部分）；存储门面用 getter
 * 现取它 —— 这样「建 store」与「建搜索」的先后不会变成一条隐式依赖。
 */
let search: SearchService | undefined

/** 存储门面看到的**索引计划**：索引实例还没建好时返回 null（内容照常落盘） */
const ftsSource: FtsCommitSource = {
  plan: (w, ops) => (search ? search.indexer.plan(w, ops) : Promise.resolve(null)),
  onError: () => search?.indexer.onError(),
  /**
   * 整份替换（种子／换库）落盘成功之后**才开始重建**：
   * 索引必须对着已经写进库的那份内容建，否则随后到达的 replace 会把刚建好的表清掉。
   */
  onReplace: () => {
    search?.indexer.onReplace()
    search?.start()
  },
}

const store = createWorkspaceStore(
  LIBRARY_BRIDGE ? createIpcAdapter(LIBRARY_BRIDGE) : createLocalStorageAdapter(STORAGE_KEY),
  ftsSource,
)
/**
 * **设备状态**（偏好）走它自己的键与端口实例：库作废不连累它。
 * 两个端口各自持有一份写队列 —— 它们的字节落在两个键上，没有共同的写入顺序。
 *
 * 归属判据：**引用块 id 或指涉某个库布局的状态跟着库走；纯外观与设备能力留设备。**
 * 桌面宿主有库面 ⇒ 折叠表／dock／露面视图／日记栏由设备 store 顺手写进**库的 settings 表**，
 * 两个库各自一份、互不指涉；web 宿主没有库面（单库演示），全部暂住设备键，行为不变。
 */
const deviceStore = createDeviceStore(
  createLocalStorageAdapter(DEVICE_KEY),
  LIBRARY_BRIDGE?.getSetting ? createLibrarySettingsPort(LIBRARY_BRIDGE) : undefined,
)

/**
 * **资产库**：字节的唯一去处。与内容存储同一条分叉判据（`window.qua` 在不在）：
 *   · Electron：字节住在**库目录的 `assets/`**（主进程写，经 IPC）⇒ 拷库目录＝图一起走；
 *              地址是 `qua-asset://<hash>`，由壳的协议处理器映射到那份文件；
 *   · web：IndexedDB（浏览器没有「用户可选的库目录」这个语义），地址由实现自己管。
 *
 * 为什么在**读库之前**就建好：行内资产是正文的一部分，渲染第一帧就要知道
 * 「这份 hash 在不在、多大」—— 索引必须赶在首次渲染之前拿到。
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
 *
 * 为什么收成一个对象：只读态不是启动时的一锤子事实 —— 用户在调试菜单里
 * 「备份并重建本地库」之后，它必须**当场翻回可写**（否则重建只改了内存，刷新又回到损坏态）。
 * 对象由装配层与持久化层**共持一份**，不存在「两边各记一个 boolean」的第二种答案。
 */
const bootState = {
  readOnly: boot.status === 'too-new' || boot.status === 'corrupt' || boot.status === 'storage-error',
  notice: null as string | null,
}
let ws: Workspace = boot.status === 'ok' ? boot.ws : seedWorkspace()
/**
 * 种子库里那几栏演示查询：它们在**设备状态**里（日记面板是系统视图，不是块）。
 *
 * 只在「这一份库是刚种出来的」时给：旧库作废重 seed 也算一次全新开始，
 * 而两个仓都空着的时候（第一次打开）更该看到那一栏。
 */
if (boot.status !== 'ok') device.prefs.journalMounts = seedJournalMounts()

/**
 * **搜索运行时**：桌面库才可能走 FTS；web 没有 SQLite，构造时 `bridge.search` 缺失
 * ⇒ 查询自动走森林扫描（同一套词项，标记为降级）。
 *
 * 索引状态来自这次装载：状态不是 `ready`／分词器版本不匹配 ⇒ 先扫描，后台重建
 * （重建在 worker 里，不占输入路径）。
 */
search = createSearchService({
  bridge: LIBRARY_BRIDGE,
  forest: () => ws.blocks,
  snapshot: boot.status === 'ok' ? boot.search : undefined,
})

/**
 * **启动顺序**：先把种子资产的字节写进资产库，再拿一次全库索引，最后才渲染。
 *
 * 顺序不能反：索引是「这份 hash 在不在、多大」的同步判据，种子的图必须在它之前入库；
 * 反过来（先取索引再 put）会让默认演示里的图全部显示成 `missing`——
 * 用户看到「资产库坏了」，而实际只是顺序错了。
 *
 * 失败不拦启动：入库失败只影响那一张图（`missing`），取索引失败才整库 `unavailable`。
 */
if (!bootState.readOnly) await ensureSeedAssets(assetStore)
await loadAssetIndex()

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
// 开发构建里把恢复入口指出来：没有这句，用户只知道「去开发者工具备份」，不知道菜单里已经能一键做
if (boot.status === 'corrupt' && DEV_SURFACE) bootNotice += t('ui.boot.corruptDevHint')
bootState.notice = bootNotice
// 开发者日志（英文，不走 msg 字典）：排查「为什么是只读态」时这是唯一的第一手线索
if (bootState.readOnly) console.warn('[boot] read-only prototype state:', boot.status)

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
const todayId = journalId(todayISO())
const hadToday = Boolean(findInForest(ws.blocks, todayId))
/**
 * 今天的块可能是**软删**状态（用户删过这一天）。它还在数组原位（id 由日期确定性派生），
 * 所以冷启动不能 `insert` 一个新的：那会得到两个同 id 的块，之后按 id 的读只看得到先序第一个。
 */
const todayTomb = trashOf(ws.blocks).some((b) => b.id === todayId)

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
 *
 * ⚠️ 「有没有子块」判 `hasLiveChildren`：删除是原位软删，块还挂在 `children` 里，
 *    用长度判会让「删空过的天」每次冷启动都补不回来。
 */
const bootOps: Op[] = []
const bootFeed = feedDays(ws.blocks, FEED_INITIAL)
if (!hadToday || todayTomb || bootFeed.some((d) => !hasLiveChildren(d))) {
  const r = kb.tx((tx) => {
    if (!hadToday) {
      // 删过就复活原块（同 id、同位置），不要新建第二个今天
      if (todayTomb) tx.restore(todayId)
      else tx.insert(mkJournalBlock(todayISO()), null, 0)
    }
    for (const day of feedDays(ws.blocks, FEED_INITIAL)) {
      if (!hasLiveChildren(day)) tx.insert(mkBlock(''), day.id, 0)
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
/** `#` 第二段（成员搜索）锚定的标签；null ＝ 不在第二段。开着的浮层由 `openMemberStage` 管 */
let stageTag: MemberTagRef | null = null
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

/** 提示表与上下文键收在 wiring/keys；pages 分片的四件晚于此处 ⇒ getter，运行时现取 */
const { keyHints, uiCtx } = setupKeys({
  getEd: () => ed,
  getWs: () => ws,
  layers,
  isMac,
  pageTitle: (b) => pageTitle(b),
  activeBlock: () => activeBlock(),
  canGoBack: () => canGoBack(),
  canGoForward: () => canGoForward(),
  axisActive: () => axis.mode() !== 'normal',
})

/* ------------------------------------------------------------ 槽内容 */

/** 卡头菜单／画廊／窗口卡依赖／槽宽拖拽的家什；赋值在 panels/app 之后（见那一节的注释） */
let menus: ReturnType<typeof setupCardMenus>
const { renderDocks, openWindow, closeCard, addTile, addDerived, cardStateFor, windowLabel, setWindows, toggleFoldAll, topWindow, closeOtherWindows, closeAllWindows } = setupDocks({
  kb,
  prefs,
  applyChrome: () => applyChrome(),
  /** 槽**此刻**看得见吗与「以他为准」的释放：都归档位轴那份判据 */
  slotOpen: (side) => axis.slotOpen(side),
  noteSlotChanged: (side) => axis.noteSlotChanged(side),
  getWs: () => ws,
  getRegistry: () => registry,
  scheduleDeviceSave: () => scheduleDeviceSave(),
  scheduleBadge: () => scheduleBadge(),
  getSlots: () => ({ left: dockLeft, right: dockRight }),
  // 检视卡在面板分片里创建并挂进右槽堆叠；这里只在重画时取它（它必须已经在文档里）
  inspectCard: () => chrome.inspectCardEl,
  showCardMenu: (side, key, anchor) => menus.showCardMenu(side, key, anchor),
  /**
   * 反链卡：**一列真实的可编辑块**（与正文「引用」栏同一种东西），不是一列摘要行。
   *
   * 懒建：卡第一次出现时才建实例。工厂本身在装配早期传入，但真正调用发生在
   * 首次重画——那时 `run`／`cardStateFor`／`closeCard` 都已就位。
   */
  createBackrefsCard: (side) =>
    new BackrefsCard({
      store: blocks,
      kb,
      write: editorRun(run, () => ed),
      target: () => ws.activeId,
      wire: (editor, change) => wireViewEditor(editor, change, 'dock', true),
      onFocus: (editor) => {
        ed = editor
        scheduleBadge()
      },
      onDispose: (editor) => {
        if (ed !== editor) return
        ed = mainEd
        scheduleBadge()
      },
      // 卡内编辑：只落盘与刷角标，**不重画槽**（重画会打断这一行的输入）
      onChange: () => {
        syncSections()
        scheduleSave()
        scheduleBadge()
      },
      state: () => cardStateFor(side, 'backrefs'),
      onClose: () => closeCard(side, 'backrefs'),
      // 快速筛选的弹层外壳（chips 的内容与状态都在卡自己手里）
      openPopover: (render, anchor) => layers.openPopover(render, anchor),
    }),
  // 左槽行／日历日期的「打开」都经这一条；具体落点策略只在 App.openBlock 一份
  openBlock: (id, place, opts) => app.openBlock(id, place, opts),
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
  axisSlotOpen: (side) => axis.slotOpen(side),
  openBlock: (blockId, place) => app.openBlock(blockId, place, { restore: 'saved' }),
})

/**
 * 档位轴（常规→宽屏→全屏）：状态只住窗口、不写 prefs。
 * 装配在 chrome 之后（换档要经它重画），早于一切运行时调用（槽可见性判据都问它）。
 */
const axis = setupAxis({
  prefs,
  applyChrome: () => applyChrome(),
  scheduleBadge: () => scheduleBadge(),
})

/**
 * 一个搜索面**自己那份**「活动编辑器」槽。
 *
 * `ed` 是装配层的单槽，而两面（tab 搜索面 / ⌘P 浮层）可以同屏：每面各持一份槽，
 * `onFocus` 才不会被对方顶掉；`onDispose` 只在「活动编辑器还是我这台」时回落，
 * 否则关浮层会把 tab 面正指着的那台抢回正文。
 * `fallback` 是这一面打开那一刻的活动编辑器——关面后回落到它原来所在的位置。
 */
const faceEditorSlot = (): {
  onFocus: (editor: BlockEditor) => void
  onBlur: (editor: BlockEditor) => void
  onDispose: (editor: BlockEditor) => void
  /** 写入事务的目标：本面自己指向的那台（没有就回落） */
  target: () => BlockEditor
} => {
  const fallback = ed
  let owned: BlockEditor | null = null
  const fallbackAlive = (): BlockEditor => (fallback.container.isConnected ? fallback : mainEd)
  const release = (editor: BlockEditor): void => {
    if (owned !== editor) return
    owned = null
    if (ed !== editor) return
    ed = fallbackAlive()
    scheduleBadge()
  }
  return {
    onFocus: (editor) => {
      owned = editor
      ed = editor
      scheduleBadge()
    },
    // 焦点离开这一面：活动编辑器交回打开前那台（另一面若接了焦点，它自己的 onFocus 马上会覆盖）
    onBlur: release,
    onDispose: (editor) => {
      release(editor)
    },
    target: () => owned ?? fallbackAlive(),
  }
}

/**
 * 搜索面的依赖：tab 宿主与诊断探针共用同一个产地。
 *
 * 这些依赖用闭包/取值函数——`run`／`scheduleSave` 在本节之后才装配（见文件顺序），
 * 调用发生在用户打开搜索面时，不是装配时。
 */
const searchFaceDeps = (): SearchFaceDeps => {
  const slot = faceEditorSlot()
  return {
    kb,
    /**
     * 预览是一台**真编辑器**：它读同一份 store、走同一个写入口、接同一份事件表
     * （右键块菜单 / `#`·`@` 补全 / 引用跳转 / 撞名提示都在里面）。
     * 这些依赖用闭包/取值函数——`run`／`scheduleSave` 在本节之后才装配（见文件顺序）。
     */
    store: blocks,
    write: editorRun(run, slot.target),
    /**
     * `inlineViewBodies=true`：预览画的是**这一块的真实位置**（用户在这里改它），
     * 所以查询块要像正文那样把结果画在自己行下。不传的话，搜到查询块点开只看见
     * 一行名字、看不到结果，也不会有折叠三角（`bodyFoldable` 要求 `viewBody` 在场）。
     */
    wire: (editor, change) => wireViewEditor(editor, change, 'surface', true),
    onFocus: slot.onFocus,
    onBlur: slot.onBlur,
    onDispose: slot.onDispose,
    // 预览里编辑：落盘、刷角标与 tab 标题。**不重跑搜索**（重跑会重排列表、打断这一行的输入）
    onChange: () => {
      syncSections()
      scheduleSave()
      scheduleTabs()
      scheduleBadge()
    },
    // 引擎现取：索引状态会变（ready 才信 FTS，否则扫描降级——面自己把降级说明白）
    query: (text, limit) => (search ?? { query: async () => ({ hits: [], mode: 'scan' as const }) }).query(text, limit),
    // 行怎么说与 ⌘P 浮层同一份
    describe: (hit, term) => describeHit(kb, hit, term),
    openBlock: (id) => app.openBlock(id, 'center'),
    // 晋升：把词写进 {text} 条件建查询块（与手建同一份创建路径，落森林顶层，一笔回滚）
    promote: (term) => app.createQuery(term, { where: { text: term } }),
    // 无结果的创建入口：找到或创建页（与引用浮层同一条创建路径），建好当场打开
    createPage: (name) => {
      const r = pageDeps.run((tx) => ensurePageInTx({ resolveAlias: (n) => kb.resolveAlias(n), roots: () => kb.roots() }, name, tx)?.id ?? '')
      if (r.result !== '') app.openBlock(r.result, 'center')
    },
    copyRef: (id) => {
      void registry.invoke('core.editor/copy-block-ref', { blockId: id }, 'surface')
    },
    // 刷新之后说一句（移除了几条 / 失败保留旧结果）：与查询视图同一个出口
    toast: (text, kind) => app.toast(text, kind),
    // 空态「最近更新」：模型直取（修改时间倒序），不经过查询引擎。
    // 只取前 N 块再投影（不先对整片森林排序）：结果与「全量排序后 slice」逐条相同
    recents: (limit) =>
      recentBlocks({ roots: ws.blocks }, limit)
        .map((b) => describeHit(kb, { blockId: b.id, score: 0 }, ''))
        .filter((v): v is HitView => v !== null),
  }
}

/**
 * 中心表面宿主：派生/工具面的 tab 身体住这里（与编辑器二选一可见）。
 * 装配在 chrome 之后（要它的宿主元素）、pages 之前（tab 状态层要经由它切表面）。
 */
const surface = setupSurface({
  kb,
  getRegistry: () => registry,
  renderDocks: () => renderDocks(),
  getChrome: () => chrome,
  searchDeps: searchFaceDeps,
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
  forceReplaceNow,
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
  bootState,
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

/**
 * 打开的是盘上已有的库 ⇒ 现在就检查索引；种子／换库那条路要等第一笔 replace
 * 落盘（`onReplace`）之后才重建，否则会先给一份还没写进库的森林建索引。
 */
if (boot.status === 'ok') search.start()

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
const triggerDeps: TriggerDeps = {
  forest: () => ws.blocks,
  ctx: uiCtx,
  keyHints,
  shortcutHint: `↵ ${isMac() ? '⌥↵' : 'Alt+↵'} ${isMac() ? '⇧↵' : 'Shift+↵'}`,
  // `@` 候选排除「正在打字的这一块」：它自己的正文含着查询词，点它＝引用自己
  selfBlockId: () => ed.caretBlock() ?? ed.sel?.aBlock ?? null,
}

const triggers = createTriggers(triggerDeps)

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
 * **`#` 的第二段：成员搜索**（⇧↵ 选中一个标签后进入）。
 *
 * 与第一段（`openTrigger`）的分工：第一段的查询词是**块内文本**（打字继续进 `.tx`），
 * 第二段的查询词住**浮层自己的输入框**（`focusSearch`＋`onQuery`）——`#` 触发词不能含空格，
 * 「标签名 ＋ 成员搜索」没法共用同一段正文；也不该共用：第二段是**浮层的状态**，
 * 关掉就回到打字（块内 `#玩具` 原样保留，触发判据还活着，继续打字自动重开第一段）。
 *
 * 落点仍走 `pickRow` ⇒ `acceptTrigger` 同一笔事务：抹掉 `#玩具`、（需要时）建记录、插露面。
 */
function openMemberStage(tag: MemberTagRef): void {
  stageTag = tag
  triggerCh = null
  layers.openMenu({
    rows: memberRows(tag, '', triggerDeps),
    anchor: ed.caretRect(),
    title: t('ui.retrieval.memberTitle', { name: tag.name }),
    searchable: true,
    focusSearch: true,
    emptyText: t('ui.retrieval.memberEmpty'),
    onPick: (row, mods) => {
      stageTag = null
      pickRow('#', row, mods)
    },
    onQuery: (q) => layers.setRows(memberRows(tag, q, triggerDeps)),
    onClose: () => {
      stageTag = null
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
   *   · `⇧↵` ⇒ **进入成员搜索**（第二段浮层：该标签的成员 ＋「新建实例『输入文本』」）；
   *     「立即建一条实例」由第二段的新建行覆盖，名字终于由输入文本给；
   *   · `⌥↵` ⇒ 把标签归到本块（写宿主 `_tags`，行尾出 chip）；
   *   · `↵`   ⇒ 行内标签：实例行引用那条记录、标签类行引用类块。
   *
   * 新建标签行是例外：`⇧↵` 仍就地建标签＋建**同名**实例——
   * 那条路上名字就是用户打的字，没有「标签名冒充实例名」的分叉。
   */
  if (pick.kind === 'newTag') {
    const action = mods.shiftKey ? 'instance' : mods.altKey ? 'assign' : 'inline'
    ed.acceptTrigger({ ch, pick: { kind: 'newTag', name: pick.name, action } })
    return
  }

  if (ch === '#' && mods.shiftKey && (pick.kind === 'tag' || pick.kind === 'instance')) {
    openMemberStage(pick.kind === 'tag' ? { tagId: pick.id, name: pick.name } : { tagId: pick.tagId, name: pick.tag })
    return
  }

  const tagName = pick.kind === 'instance' ? pick.tag : pick.kind === 'tag' ? pick.name : ''
  if (ch === '#' && tagName !== '' && mods.altKey) {
    ed.acceptTrigger({ ch, pick: { kind: 'tag', name: tagName } })
    return
  }

  /**
   * 第二段的新建实例行：名字＝用户在浮层里输入的文本，标签＝第二段锚定的那一个。
   * （tagId 直用、失效不做——判据在 `acceptTrigger`，这里只传话。）
   */
  if (pick.kind === 'newObj') {
    if (!pick.tagId) return
    ed.acceptTrigger({ ch, pick: { kind: 'newObj', name: pick.name, tagId: pick.tagId } })
    return
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
    const rows = [
      ...rowsFromBindings(resolveBindings('menu', ctx, { prefix: req.prefix }), keyHints()),
      ...(req.extraRows ?? []),
    ]
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

/* ------------------------------------------------ 浮层（装配在 wiring/atom-popovers） */

/**
 * 实例字段卡需要的读写能力（`setupPanels` 之后才有 `pickRef`，所以先留变量）。
 * ⚠️ 值只写记录块：`setValue` 收的是 recordId，浮层拿不到宿主块。
 */
let objFieldDeps: ObjFieldDeps | undefined
let popovers: ReturnType<typeof setupAtomPopovers>

/** 行内对象浮层/右键菜单/露面点击的唯一口径；deps 全是活引用（app/registry/ws 都晚于此处初始化） */
popovers = setupAtomPopovers({
  uiCtx,
  isMac,
  shortId,
  getRegistry: () => registry,
  getActiveBlock: () => activeBlock(),
  getMainEd: () => mainEd,
  getWs: () => ws,
  openBlockRoute: (id, place) => app.openBlock(id, place),
  layers,
  getEd: () => ed,
  toast: (msg, kind) => app.toast(msg, kind),
  showMenu,
  objFieldDeps: () => objFieldDeps,
})


/* ------------------------------------------------------------ 键位派发（接线） */

/** 按键派发的接线在 wiring/keys（逻辑在 core/infra/dispatch）；trace 写回探针队列 */
const dispatchEnv = installDispatch({
  uiCtx,
  isMac,
  getEd: () => ed,
  getRegistry: () => registry,
  layers,
  scheduleBadge,
  editorEl,
})

const { pageDeps, activeBlock, activeTrail, pageTitle, nav, historyGo, firstEditableRoot, materializeEditableRoots, initTabs, resetTabs, activateTab, openInNewTab, openSurfaceTab, newTab, closeTab, nextTab, prevTab, canGoBack, canGoForward, refreshTabs } = setupPages({
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
  dockOpen: (side) => axis.slotOpen(side),
  // 「看属性」承诺的是内容而不是一列空槽：卡被关掉之后由这一条放回来
  ensureDockCard: (side, id) => addDerived(side, id),
  openInDock: (id) => openWindow('right', id),
  onTabsChanged: (tabs) => {
    renderCenterTabs(tabs)
    // 表面 tab 开着时库会变（恢复/删除走别处）：身体跟着重画，与槽里的同一张卡同拍
    surface.refreshIfShown()
  },
  onSurface: (ref) => surface.show(ref),
})

/**
 * 中心槽的 tab 条：状态在 `pages`，这里只把只读列表画出来。
 * 切 tab / 关闭 / 新建都走同一条 `pages` 入口，UI 不自己改状态。
 */
function renderCenterTabs(tabs: readonly TabInfo[]): void {
  paintCenterTabs(chrome.centerTabsEl, tabs, {
    activate: (id) => {
      activateTab(id)
    },
    close: (id) => {
      closeTab(id)
    },
    create: () => {
      newTab()
    },
  })
}
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
  const sel = ed.sel
  const r = txRun((tx) => tx.patch(blockId, mutate), mainEd)
  blocks.record(r.undo, sel, 'other', Date.now())
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
 * 命令层的事务入口：装配层补撤销条目（零 op 不记），并把**改到的那几行**当场重画。
 *
 * 为什么在装配层：撤销条目与「重画哪一行」都需要 `ed`／`blocks`／`repaintBlock`，
 * 而命令层只声明「发生了什么」。
 */
const runTx: TxRun = (fn) => {
  const sel = ed.sel
  const r = txRun(fn, mainEd)
  if (r.ops.length > 0) blocks.record(r.undo, sel, 'other', Date.now())
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
  // 入库成功 ⇒ 立刻登记，新 run 的首帧就能画出图（不用等下一次启动的索引）
  primeAsset(meta)
  // 尺寸不进 run：它是那份字节的属性，从索引里读（见 `AssetRun`）
  const runId = ed.insertAssetAt(where.blockId, where.offset, meta.hash, { label })
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
 * **换库的唯一落地点**：内容 + 落点 + 各视图重画。
 *
 * `save` 分两档，因为「换演示数据」与「从坏库恢复」对写入时机的要求相反：
 *   · 演示状态切换：换完立刻按正常写路径落盘（`true`）；
 *   · 恢复：现在还不能写 —— 必须先备份原始字节，再由 `forceReplaceNow()` 显式整份替换（`false`）。
 *
 * ⚠️ 换库的次序：**先换 store 的内容，再取 `p`**。
 *
 * `kb`／`blocks` 是同一个 store 实例（`reset` 原地换内容，门面不用换）；
 * 此刻 store 里仍是上一份库，只换 `ws` 不换内容的话，
 * `activeBlock()` 就会在**旧库**里找新库的 `activeId`：找不到便落到 `kb.roots()[0]`
 * 这条兜底上，拿回**旧库首块**再装进新库的视图（表现为「重开后字丢了」）。
 * 反过来，`p` 也不能早于这一步 —— 换了库却还拿旧落点，等于把旧块装进新库。
 */
function swapWorkspace(next: Workspace, save: boolean): void {
  ws = next
  // 换库 ⇒ 旧落点全部失效；tab/历史留着只会把用户送到「上一份演示数据」的 id
  resetTabs()
  /**
   * **旧库的 op 不能落到新库**：它们说的是「旧库里那块长这样」，带过河就是脏写。
   * 换库本来就是「整体换一份」，落盘会按整类提交（新库的 op 从零开始攒）。
   */
  clearPendingOps()
  /**
   * **折叠态跟库走**（库的 settings 表）：换演示数据＝把这份库的内容整体换掉，
   * 旧内容的块 id 在新内容里不存在（或指到另一块）⇒ 内存清空并照常落盘，
   * 新内容从全展开开始。桌面版「切到另一个库」是另一扇窗、各读各的 settings，不经过这里；
   * 这里只有同一库的演示切换。
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
  initTabs()
  if (save) saveNow()
  scheduleBadge()
}

/**
 * `App` 门面：**四个工厂拼装**（页／日记／视图／演示），加上浮层与提示这几件装配层专有的能力。
 *
 * ⚠️ 这里仍然是**唯一**拼装点：本文件持有 `ws`／`ed`／`registry`，工厂只拿到「能做什么」。
 */
/**
 * **同会话里「刚才复制的是哪一块」**：`copy` 事件报告，`粘贴为…` 用。
 *
 * 为什么不放剪贴板：自定义 MIME 在 Chromium 的 copy 事件里写不进去（实测读回只有
 * text/plain + text/html）；改纯文本又会让外部应用看到协议串。文本对得上才用，
 * 对不上就退回纯文本——宁可给一句实话，也不插错块。
 */
let copiedClip: { ids: string[]; text: string } | null = null

/**
 * **视图配置的唯一接缝**（`ViewOwnerStore`）。
 *
 * 为什么在装配层：写要进事务（否则不产 op ⇒ 落盘时这一笔被静默跳过），
 * 而日记那一半是设备状态 —— 它在 `core` 里根本没有写入口。
 *
 * ⚠️ `onChange` 引用**后建的** `panels`：这里只是把一个函数存下来，
 *    真正调用都在模块初始化之后（TDZ 不会撞上）。
 */
const owners = setupOwners({
  kb,
  run: (fn) => runTx(fn).result,
  prefs: () => prefs(),
  scheduleDeviceSave: () => scheduleDeviceSave(),
  scheduleSave: () => scheduleSave(),
  onChange: () => {
    panels?.renderMounts()
    panels?.renderProperties()
    scheduleSave()
    scheduleBadge()
  },
})

/**
 * **露面的「视图…」菜单**：编辑的是**这一次露面的指针**（`_embed.view`），不是源块的配置。
 *
 * 三格直译 `core/embed.ts` 的三个取值：
 *   · **跟随源**（`''`）—— 源换默认看法，这里跟着换；菜单上写明「当前：表格」，
 *     否则它和「固定为大纲」在界面上分不出差别；
 *   · **固定为大纲**（`'outline'`）—— 源换看法时这一处不变；
 *   · **源上的某张命名视图**（视图 id）—— 要「这一次特别一点」就建一张命名视图并指过去。
 *
 * ⚠️ 露面块**没有自己的 `_views`**：写进它身上没有任何读路径会看到（`isViewRoot` 排除露面块），
 *    那就是「点了没生效」。所以同一个「视图…」入口在露面块上必须走这里。
 */
function openEmbedViewMenu(host: Block): void {
  const ref = readEmbed(host)
  const target = ref ? blocks.find(ref.block) : undefined
  if (!ref || !target) return
  const data = owners.read({ kind: 'block', blockId: target.id })
  const active = data ? readViewSet(data).active : null
  const curLabel = active ? viewNameOf(active, (k) => t(`ui.view.kind.${k}`)) : t('ui.view.outline')
  const rows: Row[] = [
    {
      id: 'embed/follow',
      label: t('ui.embed.followSource', { name: curLabel }),
      icon: 'lucide:link',
      ...(ref.view === '' ? { keyHint: t('ui.view.current') } : {}),
    },
    {
      id: 'embed/outline',
      label: t('ui.embed.pinOutline'),
      icon: 'lucide:list',
      ...(ref.view === OUTLINE_VIEW ? { keyHint: t('ui.view.current') } : {}),
    },
  ]
  for (const v of data?.views ?? []) {
    rows.push({
      id: `embed/view/${v.id}`,
      label: viewNameOf(v, (k) => t(`ui.view.kind.${k}`)),
      icon: v.kind === 'list-table' ? 'lucide:table-properties' : 'lucide:table',
      group: 'embed/views',
      ...(ref.view === v.id ? { keyHint: t('ui.view.current') } : {}),
    })
  }
  rows.push({ id: 'embed/new', label: t('ui.embed.newView'), icon: 'lucide:plus', group: 'embed/9-new' })
  rows.push({ id: 'embed/open', label: t('ui.embed.openSource'), icon: 'lucide:external-link', group: 'embed/9-new' })
  layers.openMenu({
    rows,
    anchor: app.ed.blockEl(host.id)?.getBoundingClientRect() ?? null,
    title: t('menu.label.views'),
    searchable: false,
    onPick: (row) => {
      const id = String(row.id)
      if (id === 'embed/follow') void registry.invoke('core.embed/set-view', { blockId: host.id, view: '' }, 'menu')
      else if (id === 'embed/outline') void registry.invoke('core.embed/set-view', { blockId: host.id, view: OUTLINE_VIEW }, 'menu')
      else if (id.startsWith('embed/view/'))
        void registry.invoke('core.embed/set-view', { blockId: host.id, view: id.slice('embed/view/'.length) }, 'menu')
      // 「在源上新建视图…」打开的是**源**的那一份菜单：建完它会成为源的默认看法，
      // 跟随态的露面当场跟着换；要钉住就再从本菜单选一次（一张视图只有一份配置）。
      else if (id === 'embed/new') app.openViewMenu({ kind: 'block', blockId: target.id })
      else if (id === 'embed/open') void registry.invoke('core.block/focus-block', { blockId: target.id }, 'menu')
    },
  })
}

/**
 * **条件树弹层**（唯一一份）：基础条件（`core.query/set-spec`）与
 * 视图切片（`core.view/set-filter`）共用同一台组件，只是 `spec` 的来源与落点不同。
 */
function openSpecPopover(opts: {
  owner: ViewOwnerRef
  anchor: DOMRect | null
  spec: () => QuerySpec
  showOptions?: boolean
  onApply: (spec: QuerySpec) => void
}): void {
  const hostId =
    opts.owner.kind === 'block'
      ? opts.owner.blockId
      : opts.owner.host.kind === 'block'
        ? opts.owner.host.blockId
        : ''
  const hostBlock = hostId === '' ? undefined : kb.get(hostId)
  layers.openPopover((box) => {
    const tree = new QueryTree(box, {
      spec: opts.spec,
      fields: () => {
        const labels = propDisplayLabels(kb.roots())
        return kb.propDefs().map((d) => ({ id: d.id, label: labels.get(d.id) ?? propLabel(d), kind: propKindOf(d) }))
      },
      /**
       * `select` 的选项：**定义块的直接子块，全量、排除软删**。
       * 不按某一块的可选范围收窄（`choicesForDef`）—— 查询是跨块的，
       * 同一个属性在不同块上「此刻能选什么」可以不一样。
       * `_tags` 不是定义：它按标签归属分组时的「选项」＝ 全部标签块（组名用显示名）。
       */
      choices: (propId) => {
        if (propId === '_tags') return kb.tags().map((t) => ({ id: t.id, label: displayNameOf(t).trim() || shortId(t.id) }))
        const def = kb.get(propId)
        if (!def || propKindOf(def) !== 'select') return []
        return choicesOf(def).map((c) => ({ id: c.id, label: displayNameOf(c).trim() || shortId(c.id) }))
      },
      ...(hostBlock ? { owner: hostBlock } : {}),
      pickRef: (b, propId, current, onPick, rect) => pickRefValue(b, propId, current, onPick, rect),
      refLabel: (targetId) => {
        const target = kb.get(targetId)
        return target
          ? displayNameOf(target).trim() || shortId(target.id)
          : t('ui.props.refMissing', { id: shortId(targetId) })
      },
      apply: opts.onApply,
      close: () => layers.closePopover(),
      inline: false,
      ...(opts.showOptions === false ? { showOptions: false } : {}),
    })
    tree.render(true)
  }, opts.anchor)
}

const app: App = {
  get ed() {
    return ed
  },

  /**
   * **查询块的就地落点**（`core.query/insert` / 斜杠「插入查询块」）。
   *
   * 为什么住在这里、不在视图命令那一组：落点要问**编辑器**（这一行空不空、在哪个兄弟位），
   * 插完还要把光标落到新留的空块上——视图命令只读写拥有者上的两个属性，碰不到这些。
   * 判据与「插入其他块」共用一套（空块原地转、否则插到下一行）。
   */
  insertQueryBlock: (blockId) => ed.insertQueryAfter(blockId) ?? '',

  ...pageCommands(pageDeps),
  // 日记与页共用同一份依赖（今日是落点，不是特例代码路径）
  ...journalCommands(pageDeps),
  ...zoomCommands(pageDeps),
  ...moveCommands(pageDeps),
  ...mountCommands({
    kb,
    owners,
    run: runTx,
    activeId: () => ws.activeId,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...propsCommands({
    kb,
    write: writeProps,
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...mentionCommands({
    kb,
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...viewConfigCommands({
    kb,
    owners,
    run: runTx,
    reloadPage: () => pageDeps.reloadPage(),
    rootIds: () => pageDeps.rootIds(),
    /**
     * 这一块的视图身体此刻有没有被某个表面画着（正文内联体／段尾宿主／侧槽窗口／挂载区）。
     * 有 ⇒ 切视图是就地重画，不换屏、不动光标。
     * ⚠️ 引用后建的 `panels`：这里只存函数，真正调用都在装配之后。
     */
    viewShown: (blockId) => panels?.viewShown(blockId) ?? false,
    activeId: () => ws.activeId,
    // 换屏走导航那条路（会记历史、刷标题、把光标放到新屏第一行），不另写一份装载
    openBlock: (id) => app.zoomTo(id),
    // 新建内容对象之后左槽要看得见它（页列表就在那一列里）
    refreshList: () => renderDocks(),
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
  /**
   * **所有「点一下就打开」的入口共用这一条路由**（`place` 由 `openPlaceOf` 算）。
   *
   * 它不新增导航语义，只把已有三种落点组合起来：
   *   · dock  → `openInDock`（不换中心、不入历史）
   *   · tab   → `openInNewTab`
   *   · center→ 内容面 `zoomTo`（聚焦）；导航面 `openPage`（不抢焦点）
   */
  openBlock: (id, place = 'center', opts) => {
    if (place === 'dock') {
      app.openInDock(id, 'right')
      return
    }
    if (place === 'tab') {
      app.openInNewTab(id, opts?.feed === true)
      return
    }
    if (opts?.center === 'keep') app.openPage(id)
    else app.zoomTo(id, opts?.feed, opts?.restore)
  },
  topWindow: (id) => topWindow(id),

  /**
   * **块菜单里的「视图…」**：大纲 ＋ 这个块已有的视图 ＋「新建」（两种表）＋（结构映射表时）排序。
   *
   * 为什么是**动态菜单**而不是几条静态绑定：绑定表是静态的，而「这个块有哪些视图」
   * 是数据。菜单项由 `_views` 现画，选中之后仍走命令面（`core.view/*`）——
   * 于是撤销、落盘、审计只有一条路（与「菜单由绑定表渲染」同一条纪律的延伸）。
   */
  openViewMenu: (owner, dropdownAnchor) => {
    /**
     * **露面块不拥有视图配置**：`_embed = { block, view }` 只有一格选择。
     * 同一个「视图…」入口在露面块上编辑的是**那根指针**（跟随源／大纲／源的命名视图）——
     * 写它的 `_views` 不会被任何读路径看到（`isViewRoot` 排除露面块），那就是「点了没生效」。
     */
    if (owner.kind === 'block') {
      const embed = blocks.find(owner.blockId)
      if (embed && isEmbedBlock(embed)) {
        openEmbedViewMenu(embed)
        return
      }
    }
    const data = owners.read(owner)
    if (!data) return
    const host = owner.kind === 'block' ? blocks.find(owner.blockId) : undefined
    const source = sourceOfOwner(owner, data, host)
    const active = readViewSet(data).active
    const defaultLabel = t('ui.view.outline')
    const rows: Row[] = [
      {
        id: 'view//outline',
        label: defaultLabel,
        icon: 'lucide:list',
        ...(active ? {} : { keyHint: t('ui.view.current') }),
      },
    ]
    for (const v of data.views) {
      rows.push({
        id: `view//${v.id}`,
        label: viewNameOf(v, (k) => t(`ui.view.kind.${k}`)),
        icon: v.kind === 'list-table' ? 'lucide:table-properties' : 'lucide:table',
        ...(v.filter ? { hint: t('ui.view.slice') } : {}),
        ...(active?.id === v.id ? { keyHint: t('ui.view.current') } : {}),
      })
    }
    /**
     * **当前视图的管理**：改名／切片／删除都住在这份菜单里。
     *
     * 不另造一个「视图设置」面板：这三件事都是那一张视图的配置，
     * 用户已经在「视图…」里看见了它，入口就该在同一处。
     */
    if (active) {
      rows.push({ id: 'view/rename', label: t('ui.view.rename'), icon: 'lucide:pencil', group: 'view/7-manage' })
      if (source.kind === 'query') {
        rows.push({
          id: 'view/slice',
          label: active.filter ? t('ui.view.sliceEdit') : t('ui.view.sliceAdd'),
          icon: 'lucide:filter',
          group: 'view/7-manage',
        })
        if (active.filter) {
          rows.push({ id: 'view/slice-clear', label: t('ui.view.sliceClear'), icon: 'lucide:filter-x', group: 'view/7-manage' })
        }
      }
      rows.push({ id: 'view/remove', label: t('ui.view.remove'), icon: 'lucide:trash-2', group: 'view/7-manage' })
    }
    /**
     * **结构映射表的排序**：第一行就是表头（容器的直接子块），所以排序入口按**列**列出来，
     * 名字取那一块的显示名。排序只改显示序（行＝每列各取第 j 项的位置元组），
     * `children` 顺序一个字节不动。
     */
    if (active?.kind === 'list-table' && source.kind === 'children') {
      const table = listTableOf(source.blockId, kb)
      const cur = active.listTable?.sort
      table.columns.forEach((col, i) => {
        const on = cur?.col === i ? cur.dir : ''
        const name = displayNameOf(col).trim()
        rows.push({
          id: `view/sort/${i}/${on}`,
          label:
            name === ''
              ? t('ui.view.sortByColumnN', { n: String(i + 1) })
              : t('ui.view.sortByColumn', { name }),
          icon: 'lucide:arrow-up-down',
          group: 'view/8-sort',
          ...(on ? { keyHint: on === 'desc' ? t('ui.view.sortDesc') : t('ui.view.sortAsc') } : {}),
        })
      })
    }
    /**
     * **能建哪几种**（表只有 `STORED_KINDS_BY_SOURCE` 一张）：
     * 查询源没有结构映射表与导图 —— 命中集合不是树，没有「第 k 个孩子」可对齐。
     */
    const ICON: Record<string, string> = {
      table: 'lucide:table',
      'list-table': 'lucide:table-properties',
      list: 'lucide:list',
      board: 'lucide:columns-3',
      gallery: 'lucide:layout-grid',
      calendar: 'lucide:calendar',
      mindmap: 'lucide:git-fork',
    }
    for (const kind of storedKindsFor(source)) {
      rows.push({
        id: `view/add/${kind}`,
        // 建的行一律「新建 X」：裸 kind 名读起来像「切过去」，点下去却是建——
        // 重复视图就是这么攒出来的。上方「已有视图」各叫各的名字（建时就给了默认名）。
        label:
          kind === 'table'
            ? t('ui.view.addTable')
            : kind === 'list-table'
              ? t('ui.view.addListTable')
              : t('ui.view.addKind', { kind: t(`ui.view.kind.${kind}` as 'ui.view.kind.table') }),
        icon: ICON[kind] ?? 'lucide:square',
        group: 'view/9-add',
      })
    }
    /**
     * 下拉（来自抬头那颗「当前看法」按钮）自带锚点；块菜单那条入口没有，
     * 退回「聚焦块的块标」——两条路打开的是同一份菜单。
     */
    const anchor =
      dropdownAnchor ??
      (owner.kind === 'block' ? (app.ed.blockEl(owner.blockId)?.getBoundingClientRect() ?? null) : null)
    layers.openMenu({
      rows,
      anchor,
      ...(dropdownAnchor ? { width: 260 } : {}),
      title: t('menu.label.views'),
      searchable: false,
      onPick: (row) => {
        const id = String(row.id)
        if (id === 'view//outline') void registry.invoke('core.view/set-active', { owner, viewId: '' }, 'menu')
        else if (id.startsWith('view//')) void registry.invoke('core.view/set-active', { owner, viewId: id.slice('view//'.length) }, 'menu')
        else if (id.startsWith('view/sort/')) {
          const [, , col, dir] = id.split('/')
          // 升 → 降 → 取消（与平表表头同一套三次点击）
          const next = dir === '' ? 'asc' : dir === 'asc' ? 'desc' : ''
          void registry.invoke('core.view/set-sort', { owner, viewId: active?.id ?? '', by: col, dir: next }, 'menu')
        } else if (id === 'view/rename' && active) {
          // 名字是这一张视图的配置：就在同一份菜单里改，走命令面落盘／可撤销
          layers.openPopover(
            (box) =>
              renderNamePrompt(box, {
                title: t('ui.view.renameTitle'),
                value: active.name ?? '',
                placeholder: t('ui.view.renamePlaceholder'),
                submitText: t('ui.view.renameApply'),
                cancelText: t('ui.view.renameCancel'),
                onSubmit: (name) => {
                  layers.closePopover()
                  void registry.invoke('core.view/rename', { owner, name }, 'menu')
                },
                onCancel: () => layers.closePopover(),
              }),
            anchor,
          )
        } else if (id === 'view/slice' && active) {
          app.openViewSlice(owner, active.id, anchor)
        } else if (id === 'view/slice-clear' && active) {
          void registry.invoke('core.view/set-filter', { owner, viewId: active.id, filter: null }, 'menu')
        } else if (id === 'view/remove' && active) {
          void registry.invoke('core.view/remove', { owner, viewId: active.id }, 'menu')
        } else if (id.startsWith('view/add/')) void registry.invoke('core.view/add', { owner, kind: id.slice('view/add/'.length) }, 'menu')
      },
    })
  },

  /**
   * **切片构建器**：与「视图… → 编辑切片…」同一台浮层（抬头切片 chip 也走这里）。
   *
   * 切片没有「默认看法」那一份配置：`spec` 每次现读，视图被删了就退回空树；
   * 点「应用」才写一次，空树收成 `null` ⇒ `withFilter` 删键。
   */
  openViewSlice: (owner, viewId, sliceAnchor) => {
    openSpecPopover({
      owner,
      anchor: sliceAnchor ?? null,
      spec: () => ({ where: owners.read(owner)?.views.find((v) => v.id === viewId)?.filter ?? { any: [] } }),
      showOptions: false,
      onApply: (spec) => {
        void registry.invoke('core.view/set-filter', { owner, viewId, filter: filterOfSpec(spec) }, 'menu')
        layers.closePopover()
      },
    })
  },

  /**
   * **条件树（弹层版）**：内联树之外的第二个入口（命令面／投影窗口）。
   *
   * 它和正文里那棵树是**同一个组件**，不是第二套表单——草稿改在本地、点「应用」才写一次，
   * 边打字边写会把 ⌘Z 变成「一个字一步」。
   */
  openQueryBuilder: (owner) => {
    const data = owners.read(owner)
    if (!data?.query) {
      app.toast(t('ui.query.noSpec'), 'warn')
      return
    }
    const anchor =
      owner.kind === 'block' ? (app.ed.blockEl(owner.blockId)?.getBoundingClientRect() ?? null) : app.ed.caretRect()
    openSpecPopover({
      owner,
      anchor,
      spec: () => owners.read(owner)?.query ?? { where: { any: [] } },
      onApply: (spec) => {
        void registry.invoke('core.query/set-spec', { owner, spec }, 'builder')
        layers.closePopover()
      },
    })
  },

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
   *
   * 候选与浮层都交给 `app/retrieval/tag-choice.ts`：标签表与边图邻接表在**打开这一刻**
   * 建一次，输入只做本地过滤（不再每行重建一遍邻接表）。
   */
  showTagPicker: () => {
    openTagChoice({
      layers,
      forest: ws.blocks,
      anchor: ed.caretRect(),
      title: t('ui.tagPicker.title'),
      emptyText: t('ui.tagPicker.typeToCreate'),
      onPick: (pick) => {
        if (pick.kind === 'create') {
          app.insertTag(pick.name)
          return
        }
        // 插入的是**地址**（全名）：`insertTag` 走 findByAlias，叶子在 `A/B` 上解析不到。
        void registry.invoke('core.editor/insert-tag', { tag: pick.name }, 'menu', uiCtx())
      },
    })
  },

  addBlockRole: (blockId, role) => addBlockRole(blockId, role),
  removeBlockRole: (blockId, role) => removeBlockRole(blockId, role),
  /**
   * 删除标签块。与「取消标签」是**两条轴**：取消只摘 `tag` 露面位（块与内容都还在），
   * 删除连块带子树一起软删（回收站可恢复）。
   *
   * **不要求「先把引用摘干净」**：归属是一格标签 id，目标不在了读路径直接跳过
   * （`resolveTagIds`），恢复标签时旧归属自动接回 —— 这是软删 ＋ 同地址复活的一部分。
   * 但**用着它的时候要明说**：删完这些块上的标签会消失（与「取消标签」同一份确认形状），
   * 否则用户只会看到一堆 chip 一起没了。
   */
  deleteTag: (blockId) => {
    const b = findInForest(ws.blocks, blockId)
    if (!b || !hasList(b, 'tag')) return false
    const members = tagMemberIds(b.id, ws.blocks).size
    const declarations = declaredFieldIds(b).length
    const drop = (): boolean => {
      dropIdentity(pageDeps, b.id)
      app.toast(t('ui.toast.tagDeleted'))
      return true
    }
    if (members === 0 && declarations === 0) return drop()
    layers.openMenu({
      title: t('ui.role.deleteTagTitle', { tag: blockName(b), members }),
      rows: [
        {
          id: 'role/delete',
          label: t('ui.role.deleteTagContinue'),
          hint: declarations > 0 ? t('ui.role.declarations', { count: declarations }) : '',
          group: 'role/1',
        },
        { id: 'role/cancel', label: t('ui.role.cancel'), group: 'role/2' },
      ],
      anchor: ed.caretRect(),
      searchable: false,
      focusSearch: false,
      onPick: (row) => {
        if (row.id === 'role/delete') drop()
      },
    })
    return true
  },
  openAliasEditor: (blockId, autofocus) => openAliasEditor(blockId, ed.caretRect(), autofocus),
  openPropertiesDrawer: (blockId) => panels.openPropertiesDrawer(blockId),
  setBlockType: (blockId, typeId) => applyBlockType(blockId, typeId),

  // 导航历史（中心槽走到哪）；与 undo/redo 的撤销栈无关
  historyBack: () => historyGo('back'),
  historyForward: () => historyGo('forward'),

  // tab：一个 tab 一份保存的视图（Doc + 位置 + 自己的历史）
  openInNewTab: (id, feed) => openInNewTab(id, feed),
  // 表面 tab（派生/工具面）：目录守卫在这里，状态层不再验第二遍
  openSurface: (ref) => {
    const valid = validSurfaceRef(ref)
    if (!valid) return false
    return openSurfaceTab(valid)
  },
  newTab: () => newTab(),
  closeTab: (id) => closeTab(id),
  nextTab: () => nextTab(),
  prevTab: () => prevTab(),

  ...viewCommands({
    prefs: () => prefs(),
    applyChrome,
    axisSlotOpen: (side) => axis.slotOpen(side),
    noteSlotChanged: (side) => axis.noteSlotChanged(side),
    renderDebugState: () => chrome.renderDebugState(),
    scheduleDeviceSave,
    scheduleBadge,
    toast: (text, kind) => app.toast(text, kind),
  }),

  // 档位轴：进/退一档；状态住窗口，不写偏好
  axisStep: (dir) => axis.step(dir),

  ...devCommands({
    replaceWorkspace: (next) => swapWorkspace(next, true),
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
  /**
   * 全文检索（⌘P）：输入正文关键词，结果是**块**，右列是选中那块的真块预览。
   *
   * 宿主就是常驻搜索面本身（`compact` 形态）：同一份组件、同一台预览，不是第二套结果渲染。
   * 浮层只负责「快入口」的形状——可编辑但不常驻，要常驻就把词展开进 tab。
   */
  openSearch: () => {
    if (!search) return
    // 第一次打开搜索时把索引排上（启动期不抢 CPU；用户按下 ⌘P 是最可靠的「现在可以建」信号）
    search.start()
    const deps = searchFaceDeps()
    const built: { face: SearchFace | null; box: HTMLElement | null } = { face: null, box: null }
    let onFocusIn: ((e: FocusEvent) => void) | null = null
    layers.openPopover(
      (host) => {
        built.box = host
        host.classList.add('search-overlay')
        built.face = new SearchFace({
          ...deps,
          compact: true,
          // 选中即走：先关浮层（拆面、还焦点），再走装配层的打开路由
          openBlock: (id) => {
            layers.closePopover()
            app.openBlock(id, 'center')
          },
          createPage: (name) => {
            layers.closePopover()
            deps.createPage(name)
          },
          // 展开：把词带进常驻 tab（先关浮层，否则两层各搜各的、还同屏遮着）
          expand: (term) => {
            layers.closePopover()
            surface.setPendingTerm(term)
            app.openSurface({ kind: 'utility', id: 'search' })
          },
        })
      },
      null,
      () => {
        if (onFocusIn) document.removeEventListener('focusin', onFocusIn, true)
        onFocusIn = null
        built.face?.dispose()
        built.face = null
        built.box = null
      },
    )
    /**
     * 渲染回调跑在 append 之前（游离树里建编辑器会量错尺寸/选区），
     * 所以挂载与聚焦要等浮层进文档之后。宽高由 `.search-overlay` 显式定死，
     * `placePopover` 在内容进树之前也已经量得准。
     */
    if (built.face !== null && built.box !== null) {
      built.face.mount(built.box)
      built.face.focusInput()
      const { box } = built
      /**
       * **焦点不许逃出浮层**：`layerOpen()` 只停命令派发，挡不住 Tab／点击把焦点
       * 交给覆盖层之外——那之后按键会落到底下的编辑器上（用户看不到，却在改正文）。
       *
       * ⚠️ 判据不是「在不在 `box` 内」：块菜单、`#` 标签选择器这些**派生覆盖层**
       * 挂在 `body`（`.layer` / `.selbar`），焦点一进去就把搜索浮层关掉——
       * 用户只是点了个菜单，整个搜索面却消失了。所以放行本浮层的派生覆盖层。
       */
      onFocusIn = (e) => {
        const target = e.target as Node | null
        if (!target) return
        if (box.contains(target)) return
        if (target instanceof Element && target.closest('.layer, .selbar')) return
        layers.closePopover()
      }
      document.addEventListener('focusin', onFocusIn, true)
    }
  },
  toast: (text, kind = 'info') => {
    if (!quiet) layers.toast(text, kind)
  },
  showMenu,
  showPopover: (render, anchor) => layers.openPopover(render, anchor),
  closeLayers: () => {
    triggerCh = null
    layers.closeAll()
  },
  showPanel: (kind) => popovers.openDrawerFor(kind),
  copy: (text, label) => {
    void navigator.clipboard?.writeText(text).then(
      () => app.toast(label ?? t('ui.toast.copied')),
      () => app.toast(t('err.clipboardFailed'), 'warn'),
    )
  },
  /**
   * 读剪贴板文本：命令层不直接碰浏览器全局（与 `copy` 对称）。
   *
   * **同会话里复制过一块时**，把那段文本对一遍：对得上就补回 `((id))`，
   * 「粘贴为…」不必要求用户先点「复制为块引用」。对不上（在别处复制过）就只给纯文本，
   * 命令层会给一句「剪贴板里没有这一库的块」——不猜、不插错块。
   */
  readText: async () => {
    const text = (await navigator.clipboard?.readText?.().catch(() => '')) ?? ''
    if (text === '') return ''
    if (copiedClip && copiedClip.text === text) return copiedClip.ids.map((id) => `((${id}))`).join('\n')
    return text
  },
  // 结构动作落在中心编辑器上：焦点可能在一面镜像的岛里，而露面块在正文里
  insertEmbed: (at, targetId, view) => mainEd.insertEmbedAfter(at, targetId, view),
  /** 改一次露面选的视图（看法住在源块的命名视图上，这里只动指针） */
  setEmbedView: (blockId, view) => {
    owners.setBindingView({ kind: 'embed', blockId }, view)
    return true
  },
  expandAtomToEmbed: (atomId, view) => mainEd.expandAtomToEmbed(atomId, view),
  removeEmbed: (blockId) => {
    const ok = mainEd.removeEmbed(blockId)
    // 焦点原本在那一面镜像里：它的宿主已经被摘掉，活动编辑器退回中心
    if (ok && ed !== mainEd && !ed.container.isConnected) ed = mainEd
    return ok
  },

  /**
   * **备份并重建本地库**（只读态下唯一的出路）。
   *
   * 顺序不能反：**先备份原始字节，再换内容**。反过来的话，正常可写态下
   * `swapWorkspace(..., true)` 会先把新种子写进盘里，备份拿到的就是种子 ——
   * 用户真正要抢救的那份字节已经没了，而且这次备份看起来还成功了。
   * 备份失败（配额满 / 隐私模式）⇒ **直接放弃**，不做「没有备份的覆盖」。
   *
   * 成功后要做三件收尾：告警收起、种子资产补齐（只读启动时跳过了这一步）、
   * 诊断面回到可写态（`forceReplaceNow` 翻的就是 `bootState.readOnly`）。
   */
  resetWorkspace: () => {
    void (async () => {
      let backupKey: string | null = null
      try {
        backupKey = await store.backup()
      } catch (e) {
        app.toast(t('ui.toast.resetBackupFailed', { message: errText(e) }), 'warn')
        return
      }
      // 只换内存：写入交给 forceReplaceNow（它才知道「这一次是整份替换」）
      swapWorkspace(seedWorkspace(), false)
      const r = await forceReplaceNow()
      if (!r.ok) {
        app.toast(t('ui.toast.resetFailed', { message: errText(r.error) }), 'warn')
        return
      }
      bootState.notice = null
      chrome.showNotice(null)
      // 只读启动时跳过了种子资产；重建之后补上，否则演示库里的图全是 missing
      await ensureSeedAssets(assetStore)
      await loadAssetIndex()
      chrome.renderDebugState()
      app.toast(
        backupKey ? t('ui.toast.resetDone', { key: backupKey }) : t('ui.toast.resetDoneNoBackup'),
        backupKey ? 'ok' : 'warn',
      )
    })()
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
    anchor === null ? null : anchor instanceof HTMLElement ? popovers.anchorOf(anchor) : anchor,
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
  /**
   * 折叠态是**设备**那份（`qua.device`）：换机器就是另一份，换库时由 `replaceWorkspace` 清空。
   * 中心是**聚焦面**：装载只剩一个根时，它自己的折叠在这一屏不生效（聚焦即展开）。
   */
  doc: { roots: bootRoots, folded: device.folded },
  focusSurface: true,
  /**
   * 写入事务入口。source 由**编辑器自己**注入（见 `Run`）；`mainEd` 只是兜底
   * （编辑器外的直写，比如迁移期）。
   */
  write: editorRun(run, () => mainEd),
})
mainEd = ed
/**
 * 焦点在正文 → 活动编辑器＝正文；焦点在里层编辑岛时由那一层自己切
 * （挂载区的 `onFocus`／右槽窗口的 `onFocus`）。
 *
 * ⚠️ **`focusin` 会冒泡，所以这里必须让位**：挂载区／露面体的 DOM 都**嵌在 `#editor` 里**，
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
  inputSession.start(mainEd)
})

/**
 * **结构动作之后的可见性兜底**（`ViewEvents.focusSource` 的唯一实现，所有编辑器共用）：
 * 光标落在了发起视图看不见的块上 ⇒ 送到能被看见的地方。
 *
 * 判据是**按块**的，不按表面分叉：主编辑器里看得见 ⇒ 焦点回源位置（不走
 * `core.block/focus-block`——那会 zoom，把用户从当前屏带走）；看不见但块还活着 ⇒
 * 走同一条打开路由把真实位置开到中心，再把光标放过去。块已经没了（删掉）⇒ 不做任何事。
 *
 * ⚠️ 重入护栏：打开路由自己也会装载编辑器，装载路径上可能再触发一次兜底——
 * 放开就是无限循环。护栏只拦「这一层」的重入，不拦正常的一次跳转。
 */
let seekingSource = false
function focusSourceInMain(blockId: string): void {
  if (seekingSource) return
  seekingSource = true
  try {
    if (flatten(mainEd.doc).some((b) => b.id === blockId) && mainEd.blockEl(blockId)) {
      // 换块聚焦是一次编辑边界（先交上一块再落光标），与诊断口的 focusBlock 同一条纪律
      const prev = mainEd.sel?.aBlock
      if (prev && prev !== blockId) mainEd.commitEdit(prev)
      editorEl.focus()
      mainEd.placeCaret(blockId, 0)
      mainEd.blockEl(blockId)?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (!blocks.find(blockId)) return
    app.openBlock(blockId, 'center')
    mainEd.placeCaret(blockId, 0)
  } finally {
    seekingSource = false
  }
}

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
function viewEvents(
  editor: () => BlockEditor,
  change: ViewEvents['change'],
  via: string,
  /** 这一面是不是「块的真实位置」（正文/侧槽窗口）：只有它把查询结果画在自己行下 */
  inlineViewBodies = false,
): ViewEvents {
  const active = () => editor()
  /**
   * **行身体的实例缓存**（一台编辑器一份）：外来编辑会让整屏行重建，
   * 行内查询体不能随之销毁重建 —— 冻结/stale/滚动都要跨重画活下来。
   * 判据与实现见 `app/wiring/row-bodies.ts`。
   */
  const viewBodies = createRowBodyCache((block, into) => {
    const vh = panels.mountBlockView(block, into, active, 'inline')
    return { root: vh.root, dispose: () => { vh.dispose(); vh.root.remove() } }
  })
  /**
   * **露面身体的实例缓存**（与查询体同一条判据）：镜像的岛编辑器里住着这份装载
   * **自己的折叠表**（视图实例态），投影的 ViewHost 有订阅与冻结结果——
   * 行重画时重建一次就丢一次。缓存键是**「此刻该挂什么身体」的指纹**
   * （指针状态 ＋ 种类 ＋ 指针值）：行重画而判据没变 ⇒ 同一把钥匙 ⇒ 身体整棵搬过去；
   * 改指针、判据翻转（镜像 ⇄ 投影、跟随源换看法）、源被删（身体要换成一句实话）
   * ⇒ 新钥匙 ⇒ 按缓存的延后一拍语义拆旧挂新。
   */
  const embedBodyCache = createRowBodyCache(
    (block, into) => {
      const holder = document.createElement('div')
      holder.className = 'blk-embed-holder'
      into.appendChild(holder)
      const dispose = mountEmbedBody(block, holder, {
        store: blocks,
        run,
        wire: (ed2, change2) => wireViewEditor(ed2, change2, via),
        onFocus: (next) => {
          ed = next
        },
        onChange: (kind) => change?.(kind as 'text' | 'struct' | 'view' | 'load'),
        // 投影＝同一台 ViewHost（surface 'embed'），绑定的是**这一次露面**
        mountView: (hostBlock, target, el, titleInto) => {
          const vh = panels.mountEmbedView(hostBlock, target, el, active, titleInto)
          return () => {
            vh.dispose()
            vh.root.remove()
          }
        },
        // 判据翻转（镜像 ⇄ 投影）只能靠重画那一行：身体是这一行的 DOM
        repaint: (id) => repaintBlock(id),
        invoke: (name, args, v) => void registry.invoke(name, args, v ?? via),
      })
      return { root: holder, dispose }
    },
    (block) => {
      const find = (id: string) => blocks.find(id)
      const pointer = readEmbed(block)
      const target = pointer ? find(pointer.block) : undefined
      const status = resolveEmbed(block, find).status
      return [
        block.id,
        status,
        target && isDeleted(target) ? 'deleted' : '',
        embedBodyOf(block, find),
        pointer?.view ?? '',
      ].join(':')
    },
  )
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
      // 第二段（成员搜索）开着：行由浮层自己的输入框驱动，编辑器这边的上报一律忽略
      //（此刻焦点在浮层，正文不该有输入；这条守卫防的是浮层被阶段一的状态机夺走）
      if (stageTag) return
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
    refClick: (ref, mods, el) => popovers.handleRefClick(ref, mods, el),
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
    onAtomClick: (atom, el, mods) => popovers.handleAtomClick(atom, el, mods, via),
    /** 右键一枚行内对象：引用改锚文本、标签摘归属、图看详情——三类身份三组动作 */
    atomMenu: (hit, el, rect) => popovers.handleAtomMenu(hit, el, rect),
    onCopy: (ids, text) => {
      copiedClip = { ids: [...ids], text }
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
     * **正文里的露面身体**（镜像／投影）：同一套分派在正文、挂载区、侧槽里都走这里
     * （实例缓存见上方 `embedBodyCache`——身体跨行重画活下来）。
     *
     * 身体里是另一台编辑器或一张表 ⇒ 返回卸载函数（外层换 DOM 之前必须调用）。
     * `onFocus` 把「活动编辑器」切到里层：键位走命令层，认的是当前这一台。
     */
    embedBody: (block, into) => embedBodyCache(block, into),
    /**
     * **正文里的查询体**：与段尾宿主同一台 `ViewHost`，只是贴在查询块那一行下面。
     *
     * 只给「块的真实位置」这两种表面（正文、右槽窗口）：里层编辑器
     * （挂载区／露面的镜像／查询结果自己）不挂这条 —— 那一层画的是**结果行**，
     * 不是结果行自己的位置。深度 1 由**有没有这个回调**在构造上固定，
     * 不是运行时用 visited 集合拦。
     */
    ...(inlineViewBodies
      ? {
          viewBody: (block: Block, into: HTMLElement) => viewBodies(block, into),
        }
      : {}),
    // 复盘空天格子里落笔：中心＝物化并回到这一屏；Shift/⌘＝同一天开右槽/新 tab
    shellWrite: (date, place) => {
      if (place && place !== 'center') void app.openJournal(date, place)
      else void app.journalShellWrite(date)
    },
    // **左键点块标 ＝ 聚焦/zoom**。与面包屑那一格同一条命令，
    // 所以「点块标进去」与「点面包屑出来」共用一套语义，没有第二种入口。
    focusBlock: (blockId) => void registry.invoke('core.block/focus-block', { blockId }, via),
    /**
     * 点导轨段不再走命令层：折叠表是**每台编辑器一份**的视图实例态，
     * 镜像岛与源同屏时走「活动编辑器」就会点了镜像的线、折了源——
     * 编辑器桥直调行所属的那一台（见 `editor.ts` 的桥注释）。
     * `core.editor/toggle-children-collapse` 仍是命令面（面板／键位），作用于聚焦编辑器。
     */
    // 块标／面包屑的打开：落点（Shift＝右槽，⌘/Ctrl＝新 tab，普通＝中心）由唯一路由分流
    openBlock: (blockId, place) => app.openBlock(blockId, place),
    // 结构动作后光标不可见的兜底：所有编辑器共用同一份实现（判据在 focusSourceInMain）
    focusSource: (blockId) => focusSourceInMain(blockId),
    blockMenu: (blockId, rect, appearanceHost) => {
      const ed = active()
      // 命中**已选中的块**（且多块）⇒ 多块菜单；否则清块选区，走原单块菜单
      if (ed.bsel.inBlockSelection(blockId) && ed.bsel.blockSelectionCount() > 1) {
        showMenu({ kind: 'menu', prefix: 'blockSel/', anchor: rect, title: t('menu.title.blockSel') })
        return
      }
      ed.bsel.clearBlockSelection()
      /**
       * **真光标放进目标块**，而不是只把模型选区指过去：块菜单的命令落点是
       * 「当前光标块」（`curBlock` ⇒ `caretBlock()` ⇒ `sel.aBlock`），而菜单关闭时
       * 焦点归还会把打开前快照的 DOM 选区还原回来、选区同步跟着把 `sel` 冲回
       * 原光标块 —— 只写模型的那次赋值活不到命令执行。光标真的落在目标块上，
       * 快照与归还就都围着它转，菜单项无论怎么触发都打在同一块上。
       */
      ed.placeCaret(blockId, ed.sel?.aBlock === blockId ? (ed.sel?.aOff ?? 0) : 0)
      showMenu({
        kind: 'menu',
        prefix: 'block/',
        anchor: rect,
        title: t('menu.title.block'),
        // 右键落在露面行上（投影行的绑源块标／镜像岛里的源行）：菜单开在源上，
        // 附「移除这次露面」——露面块 id 只有打开这一刻才知道，走现算追加项
        ...(appearanceHost
          ? {
              extraRows: [
                {
                  id: 'appearance-remove',
                  label: t('ui.embed.remove'),
                  hint: t('ui.embed.removeHint'),
                  command: 'core.embed/remove',
                  args: { blockId: appearanceHost },
                },
              ],
            }
          : {}),
      })
    },
  }
}

/**
 * **给任何一台视图编辑器接上与正文同一套事件**（`viewEvents` 是唯一一份）。
 *
 * 挂载区、查询结果、侧槽窗口都走它——事件表按落点挑几支的接法漏接不报错
 * （右键没菜单、`#` 不弹补全、撞名没提示），所以这里不存在「挑几支」的分支。
 */
function wireViewEditor(
  editor: BlockEditor,
  change: ViewEvents['change'],
  via: string,
  /** 这个表面是不是「正文」：只有正文与右槽窗口渲染块的行内结果 */
  inlineViewBodies = false,
): void {
  editor.events = viewEvents(() => editor, change, via, inlineViewBodies)
}

let panels: ReturnType<typeof setupPanels>

/**
 * tab 标题的刷新是**去抖**的：正文每敲一个字都会 `change`，而 tab 条重建会
 * 把 hover/焦点从上面摘掉。只有标题真的变了才值得重画，60ms 的延迟用户看不出来。
 */
let tabsTimer: number | null = null
function scheduleTabs(): void {
  if (tabsTimer !== null) window.clearTimeout(tabsTimer)
  tabsTimer = window.setTimeout(() => {
    tabsTimer = null
    refreshTabs()
  }, 60)
}

ed.events = viewEvents(
  () => mainEd,
  (kind) => {
    syncSections()
    scheduleSave()
    chrome.renderEmptyHint(activeBlock().children)
    renderDocks() // 块数变了要更新
    scheduleTabs()
    scheduleBadge()
    /**
     * **结构变化要重排段与视图宿主**。
     *
     * 撤销/重做改的是模型（例如「上一步正在切视图」），而「这一屏长什么样」是**派生**的：
     * 只有重新排一次段，视图宿主才会跟着长出来或摘掉。少这一句的表现是
     * 「⌘Z 之后模型已经回到表格，屏幕还停在大纲」，不报错。
     */
    if (kind === 'struct') panels?.renderMounts()
  },
  'editor',
  // 正文这一台把查询结果画在自己行下；里层编辑器（`wireViewEditor`）默认不挂
  true,
)
// 启动时的第一张 tab ＝ 已经装载好的这一屏；tab 条从这里开始画
initTabs()
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
 * **某个资产地址变了（就绪 / 判定缺失）时，重画引用了它的那几行**。
 *
 * 桌面版地址是常量，这一段平时不会响；浏览器端字节从 IndexedDB 读出来才会有一次
 * 「地址就绪」，以及 `<img>` 报错时的「判定缺失」。
 *
 * 只重画**引用了这个 hash 的块**（不是 `renderAll`）：重排整页会打断正在输入的那一行。
 */
onAssetChange((hash) => {
  const hit = new Set<string>()
  for (const b of flatten({ roots: blocks.blocks })) {
    if (b.content.some((r) => r.t === 'asset' && r.asset === hash)) hit.add(b.id)
  }
  for (const id of hit) repaintBlock(id)
  // 重画换了节点（文件占位 → 真图）⇒ 角标里的 DOM 读数是**派生量**，也要跟着排一次刷新。
  // 漏了这一行的症状：首屏图是最先出现的东西，角标却会停在占位那一帧的数上，直到下一次交互。
  scheduleBadge()
})

let diag: ReturnType<typeof setupDiagnostics>
const {
  renderMounts,
  renderProperties,
  scheduleProperties,
  pickRefValue,
  openPropertiesDrawer,
  mountBlockView,
  mountEmbedView,
  viewShown,
} = setupPanels({
  blocks,
  kb,
  app,
  layers,
  owners,
  journalMounts: () => prefs().journalMounts,
  prefs,
  scheduleDeviceSave: () => scheduleDeviceSave(),
  shortId,
  activeBlock,
  run,
  syncSections,
  scheduleSave,
  scheduleBadge,
  refClick: popovers.handleRefClick,
  // 表格标题列画的是**块的样子**：投影与正文同一条路（run/marks/引用/图片）
  project: (b, into) => fillBlockText(into, b, (id) => blocks.find(id), assetViewOf, markAssetMissing),
  atomClick: (atom, el, mods) => popovers.handleAtomClick(atom, el, mods, 'table'),
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
  openBlock: (blockId, place) => app.openBlock(blockId, place),
})
panels = {
  renderMounts,
  renderProperties,
  scheduleProperties,
  pickRefValue,
  openPropertiesDrawer,
  mountBlockView,
  mountEmbedView,
  viewShown,
}
/**
 * **首帧要在事件表与画法都就位之后重画一次**。
 *
 * 编辑器在构造时就画了第一帧（`doc: bootRoots`），而 `events` 与 `panels` 都是
 * 构造之后才赋上去的：露面体、查询内联体这些**由装配层提供的画法**
 * 在那一帧里是缺的。缺了不会报错，只会画成「坏了」——而且**不会自己好**，
 * 因为重画要等下一次模型变化。
 *
 * 为什么放在 `panels` 之后：`viewBody` 要拿 `panels.mountBlockView`；早于它，
 * 这一行只能先记一笔「欠一次重画」，那就是同一件事的第二个补丁。
 * `renderAll` 会重建 `.sec` 空槽，所以紧接一次 `renderMounts()` 把挂载区重新挂回去
 * （实例仍在 `mountInstances` 里，不重建编辑器，撤销栈与选区都不丢）。
 */
ed.renderAll()
renderMounts()

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
  tagName: (id) => {
    const b = kb.get(id)
    return b ? blockName(b) : id.slice(-6)
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
 * 抽屉的外点关闭，判据是**「离开了抽屉所属的上下文」**，不是「点在了外面」：
 *
 * · 点**正文上下文**（`#doc`：块行、气口、挂载区、查询视图，以及从正文点出来的
 *   气泡/划选条/toast）＝还在与抽屉同一件事里——模糊点击也安全，不关；
 * · 点**别的表面**（槽卡、槽头、抬头 chrome）＝明确的离开动作 ⇒ 收起。
 *   抽屉挡着的那一侧不该靠猜心思收回，但「去了别的表面」不是猜的。
 * · 抽屉自己与从它弹出的菜单/选择器（`.layer`）不算外面。
 *
 * ⚠️ 不 preventDefault／不 stopPropagation：mousedown 的其它链路（折叠、拖拽、
 *    toggle 按钮）照常走——入口按钮在正文里，这里不关、随后的 click 才轮到 toggle。
 */
document.addEventListener('mousedown', (e) => {
  const el = e.target as HTMLElement
  if (!layers.drawerOpen()) return
  if (el.closest?.('.drawer') || el.closest?.('.layer')) return
  if (el.closest?.('#doc') || el.closest?.('.popover') || el.closest?.('.selbar') || el.closest?.('.toasts')) return
  layers.closeDrawer()
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
  if (action.dataset.aliasAction === 'props') panels.openPropertiesDrawer(blockId)
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
 * 侧槽的家什（卡头菜单／组件画廊／窗口卡依赖／槽宽拖拽）收在 `wiring/dock-menus.ts`。
 * 这里只装配：deps 一半来自 setupDocks 的返回（状态的家在那边），一半是装配层活引用。
 * 赋值晚于 panels/app 的初始化；更早的引用（setupDocks 的回调、槽的 onAdd）都是
 * 箭头闭包，点击时才取 `menus`。
 */
menus = setupCardMenus({
  cardStateFor,
  closeCard,
  windowLabel,
  addTile,
  addDerived,
  toggleFoldAll,
  closeOtherWindows,
  closeAllWindows,
  kb,
  prefs,
  getRegistry: () => registry,
  layers,
  keyHints,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  getMainEd: () => mainEd,
  store: blocks,
  run,
  wireEditor: wireViewEditor,
  mountViewRoot: panels.mountBlockView,
  syncSections,
  scheduleSave,
  scheduleBadge,
  applyChrome,
  scheduleDeviceSave,
  toast: (msg, kind) => app.toast(msg, kind),
  dockMinWidth,
  dockMaxWidth,
})

const dockLeft = mountDockSlot($('dock-left'), {
  side: 'left',
  title: t('ui.dock.leftTitle'),
  addLabel: t('ui.dock.addTile'),
  collapseLabel: t('ui.dock.collapseLeft'),
  foldAllLabel: t('ui.dock.foldAll'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-left',
  onAdd: () => menus.showWidgetGallery('left'),
  onCollapse: () => registry.invoke('core.dock/toggle-left', {}, 'dock'),
  onFoldAll: () => toggleFoldAll('left'),
})
const dockRight = mountDockSlot($('dock-right'), {
  side: 'right',
  title: t('ui.dock.rightTitle'),
  addLabel: t('ui.dock.addTile'),
  collapseLabel: t('ui.dock.collapseRight'),
  foldAllLabel: t('ui.dock.foldAll'),
  resizeLabel: t('ui.dock.resize'),
  icon: 'lucide:chevron-right',
  onAdd: () => menus.showWidgetGallery('right'),
  onCollapse: () => registry.invoke('core.dock/toggle-right', {}, 'dock'),
  onFoldAll: () => toggleFoldAll('right'),
})

setWindows({
  left: new DockWindows(menus.dockWindowsDeps('left')),
  right: new DockWindows(menus.dockWindowsDeps('right')),
})

menus.bindResize('left', dockLeft)
menus.bindResize('right', dockRight)
diag = setupDiagnostics({
  DEV_SURFACE,
  store,
  boot,
  getReadOnly: () => bootState.readOnly,
  getBootNotice: () => bootState.notice,
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
  openDrawerFor: popovers.openDrawerFor,
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
  getSearch: () => search,
  /** 自检探针与 tab 宿主同一个产地（见 `searchFaceDeps`） */
  searchFaceDeps,
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

/* ------------------------------------------------- 日记流下滚加载（wiring/feed） */

setupFeed({
  blankAreaEl: chrome.blankAreaEl,
  markBooted,
  getMainEd: () => mainEd,
  getWs: () => ws,
  activeBlock,
  materialize: materializeEditableRoots,
})
