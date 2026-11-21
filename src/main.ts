/**
 * 装配层。
 *
 * 这里**没有一处手写的键位分支**：document 上只有一个 dispatcher，它做的事是
 *   `resolveKey(事件, 上下文键)` → `registry.invoke(命令, 参数, 'keymap')`
 * 菜单 / 斜杠 / 划选气泡同样只是 `resolveBindings(kind, ctx)` 的渲染结果；
 * 命令面板不经过绑定表——它枚举命令表本身（键位提示从 keymap 绑定取）。
 */
import './styles.css'
import { buildAdjacency, checkEdge, cloneSubtree, cyclePathLabels, danglingOf, findInForest, flatten, FEED_INITIAL, feedDays, hasLiveChildren, isJournal, journalId, locate, mkBlock, mkJournalBlock, pruneGone, todayISO, type Block, trashOf, withBlockOwnerData, type StoredViewKind, type UndoKind } from './core/index.ts'
import { plainText } from './core/model/runs.ts'
import { BlockStore } from './core/model/store.ts'
import { MemoryKb } from './core/kb/memory.ts'
import { dockKey, openAxisOf, validSurfaceRef } from './core/index.ts'
import type { Op } from './core/kb/types.ts'
import { BlockEditor } from './view/editor/editor.ts'
import { inputSession } from './view/editor/input-session.ts'
import { editorRun } from './view/editor/editor-run.ts'
import { fillBlockText } from './view/editor/block-dom.ts'
import {
  setUserKeys,
} from './core/infra/bindings.ts'
import {
  ALL_COMMANDS,
  Registry,
  type App,
} from './core/commands/index.ts'
import { Layers } from './ui/overlay/layers.ts'
import { DockWindows } from './ui/dock/dock-windows.ts'
import { DockMountCard } from './ui/cards/mount-card.ts'
import { SearchCard } from './ui/cards/search-card.ts'
import { mountDockSlot } from './ui/dock/dock.ts'
import { createIcon } from './view/icons.ts'
import { mountNotePopover, type NotePopoverHandle } from './ui/block-ui/note-popover.ts'
import { type ObjFieldDeps } from './ui/overlay/panels.ts'
import { devCommands, journalCommands, mentionCommands, mountCommands, moveCommands, pageCommands, propsCommands, rootsFor, rootsForMany, belongsToCommands, viewCommands, viewConfigCommands, buildFreshView, zoomCommands } from './app/commands-impl.ts'
import { automationCommands } from './app/commands/automation.ts'
import { createAutomationEngine } from './core/automation/engine.ts'
import type { TxRun } from './app/commands/types.ts'
import { setupPersistence } from './app/wiring/persistence.ts'
import { setupAssets } from './app/wiring/assets.ts'
import { setupBlockProps } from './app/wiring/block-props.ts'
import { setupRetrieval } from './app/wiring/retrieval.ts'
import { setupViewMenus } from './app/wiring/view-menus.ts'
import { createEditorEvents } from './app/wiring/editor-events.ts'
import { setupClipboard } from './app/wiring/clipboard.ts'
import { setupAxis } from './app/wiring/axis.ts'
import { installTooltips } from './ui/overlay/tip.ts'
import { setupSurface } from './app/wiring/surface.ts'
import { setupDocks } from './app/wiring/docks.ts'
import { setupCardMenus } from './app/wiring/dock-menus.ts'
import { setupPanels } from './app/wiring/panels.ts'
import { createClosureStamp } from './app/wiring/closure-stamp.ts'
import { setupAtomPopovers } from './app/wiring/atom-popovers.ts'
import { createRefPeek } from './ui/block-refs/popover.ts'
import { setupFeed } from './app/wiring/feed.ts'
import { installDispatch, setupKeys } from './app/wiring/keys.ts'
import { dispatchKey } from './core/infra/dispatch.ts'
import { setupOwners } from './app/wiring/owners.ts'
import { SearchFace, type SearchFaceDeps } from './ui/search/search-face.ts'
import type { SettingsFaceDeps } from './ui/settings/settings-face.ts'
import { setupChrome } from './app/wiring/chrome.ts'
import { setupPages, type TabInfo } from './app/wiring/pages.ts'
import { setupOutlineFilter, type OutlineFilter } from './app/wiring/outline-filter.ts'
import { renderCenterTabs as paintCenterTabs } from './ui/chrome/center-tabs.ts'
import { setupDiagnostics } from './app/wiring/diagnostics.ts'
import { HANDLERS } from './app/handlers.ts'
// 用户可见文案一律走 t；字典是零依赖叶子，Electron 主进程也 import 同一份
import { t, type MsgId } from './core/infra/msg.ts'
import { ensurePageInTx } from './core/index.ts'
import { seedDock, seedJournalMounts, seedWorkspace } from './core/infra/seed.ts'
import { blankWorkspace } from './core/fixtures/states.ts'
import { createIdbAssetStore } from './core/storage/asset-idb.ts'
import { createIpcAssetStore } from './core/storage/asset-ipc.ts'
import { ensureSeedAssets } from './core/storage/seed-assets.ts'
import { assetViewOf, loadAssetIndex, markAssetMissing, useAssetStore } from './view/asset-views.ts'
import {
} from './core/infra/assets.ts'
import { createIpcAdapter, type LibraryBridge } from './core/storage/ipc-adapter.ts'
import type { FtsCommitSource } from './core/storage/fts-port.ts'
import { createSearchService, type SearchService, type SearchSnapshot } from './app/search/service.ts'
import { FTS_SOURCES, ftsRowKey, type FtsSource } from './core/search/sources.ts'
import { describeHit, type HitView } from './app/search/hits.ts'
import { recentBlocks } from './app/search/recents.ts'
import {
  createDeviceStore,
  createLibrarySettingsPort,
  createLocalStorageAdapter,
  createWorkspaceStore,
  DEVICE_KEY,
  normalizePrefs,
  STORAGE_KEY,
  type Prefs,
  type Workspace,
} from './core/infra/workspace.ts'
import type { DeviceState } from './core/storage/device.ts'
import { WORKSPACE_VERSION } from './core/infra/workspace.ts'
import { createLibraryClient, type LibraryClient, type LibraryReadBridge } from './core/storage/library-client.ts'
import { createMemoryLibraryClient } from './core/storage/memory-client.ts'
import { Workset, worksetClosureIds } from './core/storage/workset.ts'
import type { RawLibraryRows } from './core/storage/db-rows.ts'
import { indexReadsOf, indexWritesOf, type IndexReads } from './core/storage/index-rows.ts'
import { AliasClaimError } from './core/kb/unsupported.ts'
import { deferAliasGate } from './core/kb/alias-gate.ts'
import type { RelationEdge, RelationKind } from './core/relations/relations.ts'
import { loadWorksetBoot, type WorksetBootResult } from './app/boot/workset-boot.ts'
import { finishDocWindows, pendingOf, readFirstWindows, withAncestors } from './app/boot/doc-windows.ts'
import { rebuildDerivedTables } from './app/boot/derived-rebuild.ts'
import { DERIVED_PATH_VERSION } from './core/identity/library.ts'
import { ensureDerivedLoaded } from './app/boot/derived-load.ts'
import { loadCandidateWindow as loadCandidateWindowOf } from './app/boot/query-load.ts'
import type { CandidateLoadStep, CandidateWindowRequest } from './core/storage/library-client.ts'
import { rebuildFtsStreaming } from './app/boot/fts-rebuild.ts'
import { FTS_TOKENIZER_VERSION } from './core/search/tokenizer.ts'
import type { QueryContext, QuerySpec } from './core/query/query.ts'
import type { LoadedWorkspace } from './core/storage/index.ts'

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
const DEV_SURFACE = __QUA_DEV_SURFACE__

/** 页名：**只读投影**（中间没有页标题，页名就是那个块的正文） */
const stateMenuBtn = $('state-menu-btn')


/* ------------------------------------------------------------ 状态 */

/**
 * **存储端口**：装配层是它的唯一持有者。
 * 换后端（内核 SQLite／主进程单写者）只换这一行，上层一行不改。
 *
 * 两个宿主两条路：
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
 * **网页顶栏就是窗口标题栏**：系统那条已隐藏，但原生窗口控件还浮在内容上。
 * 平台由壳同步给出（不是 UA 猜的）：macOS 的红黄绿在左上 ⇒ 顶栏左侧让位；
 * 其它平台的窗口控制在右上 ⇒ 右侧让位。浏览器宿主没有 `qua` ⇒ 两侧都不让。
 */
if (LIBRARY_BRIDGE?.platform) document.body.dataset.platform = LIBRARY_BRIDGE.platform

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
  {
    // 派生关系行（层 2 第一片）：与行写入同一批。workset 在启动段才建——闭包现取，
    // commit 只发生在装载之后
    relationWrites: (ops) => workset?.relationWritesFor(ops) ?? [],
    // 派生位置行（root/path/hidden）：同一批、同一事务。它要读库里的存量段（中点/后继），
    // 所以是异步的——读在 store 的串行队列里，看到的是上一批已落盘的状态。
    // 没有读面的宿主（web 单库）整条不接。
    indexWrites: async (ops) => (indexReads ? indexWritesOf(blocks.index, ops, indexReads) : { writes: [], plans: [] }),
  },
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
 * 读设备偏好同样要 `await`（同一个契约）。它**永远成功**：读不到就用默认值——
 * 偏好不是内容，不该因为一格坏了就打不开 app。
 * 挪到装载之前：工作集装载的闭包要带上槽快捷卡指到的块（设备状态里那几个 id）。
 */
const device = await deviceStore.load()

/**
 * **两条装载路，一份模型**：
 *   · 桌面库**有内容** ⇒ 工作集装载（`catalog` ＋ `doc(今日窗口|active)` ＋ 引用闭包）——
 *     启动只读 Doc＋catalog，读数在会话的 `reads` 里逐面记账；
 *   · 其余（web 单库、还没有内容的库、库读不了）⇒ 字节装载路（web 是注册过的非对称）。
 *
 * store/kb 先于装载建好：它们只依赖一个空森林；装载路把块装进去之后，`ws` 再指到
 * **同一个数组**上（`BlockStore.blocks` 与 `ws.blocks` 共用一份，`syncSections` 靠这个）。
 */
let ws: Workspace = { version: WORKSPACE_VERSION, blocks: [], activeId: '', savedAt: 0 }
const blocks = new BlockStore(ws.blocks)
const kb = new MemoryKb(blocks)
/**
 * **事件引擎接进写路径**（tx 出口第四口）：数据变了就跑的那一半。
 * 引擎自兜每条规则的错（预检＋捕获），用户的写永远不会被规则失败回滚；
 * 规则失败 v1 落 console（「最近运行」记录另立项）。
 */
const automationEngine = createAutomationEngine({ kb, lookup: kb, onError: ({ ruleId, targetId, error }) => {
  console.warn(`[automation] rule ${ruleId} on ${targetId} failed:`, error)
} })
kb.setReactor((ctx) => automationEngine.react(ctx))
/**
 * **库读端口的窄面**：只把工作集读面（doc/blocks/catalog）交出去——
 * `LibraryBridge` 的 `doc` 是可选格（测试可以造瘦桥），工作集装载只认**三个都在**的桥。
 * 方法经桥转调（保住 `this` 绑定），装配层不直接持有 IPC 函数。
 */
/**
 * **库读端口的窄面**：把桥上的读方法交给 `LibraryClient`。
 *
 * ⚠️ 用**整体转发**而不是逐格条件挑：新读面（identity/candidates/tree/dependents/…）
 * 加进 `LibraryReadBridge` 时，这里漏挑一格 ＝ 该读面静默返回「bridge has no … read」，
 * boot 会把它当装载失败退到只读演示——真机踩过（首帧只读 demo 就是它）。
 * 整体展开不改方法引用（preload 是箭头函数，不依赖 this）；
 * `doc`/`catalog` 在场由上面的守卫保证（cast 的是运行时事实）。
 *
 * web 单库（没有桥）这里先落 `null`：它的内存实现在字节装载完成、整份模型就位之后
 * 才建（`memory-client.ts` 现场编码要读活森林）。
 */
let libraryClient: LibraryClient | null =
  LIBRARY_BRIDGE && LIBRARY_BRIDGE.doc && LIBRARY_BRIDGE.catalog
    ? createLibraryClient({ ...LIBRARY_BRIDGE } as LibraryReadBridge)
    : null
/**
 * **派生位置行的读面**（结构写的中点要夹在库里的存量段之间）。
 *
 * 只有「库里有派生表」的宿主才拿得到（web 单库没有）；缺一条就整体不接，
 * 增量维护整条钩子随之不接线——半套读面会把位置行的哪一半变成另一种答案。
 */
let indexReads: IndexReads | null = libraryClient ? indexReadsOf(libraryClient) : null
let workset: Workset | null = null
/** 工作集装载的结果（`null` ＝ 这次启动没走工作集路） */
let worksetBoot: Extract<WorksetBootResult, { status: 'ok' }> | null = null
let boot: LoadedWorkspace
{
  const info =
    libraryClient && LIBRARY_BRIDGE
      ? ((await LIBRARY_BRIDGE.libraryInfo().catch(() => null)) as { status?: string; hasContent?: boolean } | null)
      : null
  if (info?.status === 'ok' && info.hasContent === true && libraryClient) {
    const ws0 = new Workset(blocks)
    workset = ws0
    const r = await loadWorksetBoot({ client: libraryClient, workset: ws0, feedLimit: FEED_INITIAL })
    if (r.status === 'ok') {
      ws = { version: WORKSPACE_VERSION, blocks: blocks.blocks, activeId: r.catalog.meta.activeId, savedAt: r.catalog.meta.savedAt }
      worksetBoot = r
      boot = { status: 'ok', ws }
    } else if (r.status === 'no-library') {
      boot = { status: 'storage-error', error: new Error('workset boot: no library for this window') }
    } else {
      // 装载失败停在发生的那一层：宁可只读＋一句原因，也不静默回退全库装载
      console.error('[boot] workset load failed:', r.error)
      boot = { status: 'storage-error', error: new Error(`workset boot failed: ${r.error}`) }
    }
  } else if (info?.status === 'ok') {
    // 有库面但还没有内容（新库）：走 seed（整份 genesis），下次启动就是工作集装载
    boot = { status: 'empty' }
  } else if (info && info.status !== 'ok') {
    boot = { status: 'storage-error', error: new Error(`library: ${info.status}`) }
  } else if (LIBRARY_BRIDGE) {
    // 有库面但库信息读不到 ⇒ 只读。**不退回字节装载**：桌面没有「读整库」的路，
    // 「信息读不到」兜底成一次全量装载，正是这套架构要消灭的形状。
    boot = { status: 'storage-error', error: new Error('library info unavailable') }
  } else {
    // 没有库面（web 单库）：字节装载路（小数据全量进内存，注册过的非对称）
    boot = await store.load()
  }
}
if (worksetBoot) kb.setCatalog(worksetBoot.catalog)
/**
 * **派生表可不可信**（引用角标的全库计数闸）：catalog meta 的 derivedState；
 * 后台重建跑完置 ready 时由闭包翻真。false ⇒ 角标退回工作集口径（部分装载下是子集）。
 *
 * **版本也要对得上**：状态只说明两张表铺过，不说明 `path` 还按现行段编码排。
 * 存量库的状态是 `ready`、路径却是坏的（顶层根同段）——那种表在重建完成前
 * 一件都不能信，所以「状态 ready ＋ 版本一致」才算可信。
 */
let derivedReady =
  worksetBoot?.catalog.meta.derivedState === 'ready' &&
  worksetBoot.catalog.meta.derivedPathVersion === DERIVED_PATH_VERSION

/**
 * **派生表的后台重建**（启动后错峰）：表还是 `pending`（迁移来的库没跑过全量），
 * 或 `path` 的编码版本过期（存量库的顶层段曾撞车），就按顶层根逐批重建，
 * 跑完置 ready ＋ 版本——反链/角标这些全库计数消费者等的就是它。
 * **FTS 回填**接在同一个错峰槽里：工作集模式的启动不读全库，新库/分词器升版的库
 * 索引永远停在 pending（⌘K 显式空），按根逐批补建才有 ready 的那天。
 * 两者都逐根一个小事务，与用户输入在同一队列里交错；派生重建先跑完再回填 FTS，
 * 不让两个逐根读者并发抢同一个库。
 */
if (worksetBoot && LIBRARY_BRIDGE) {
  const needDerived =
    worksetBoot.catalog.meta.derivedState !== 'ready' ||
    worksetBoot.catalog.meta.derivedPathVersion !== DERIVED_PATH_VERSION
  const needFts =
    worksetBoot.catalog.meta.ftsState !== 'ready' ||
    worksetBoot.catalog.meta.ftsTokenizer !== FTS_TOKENIZER_VERSION
  if (needDerived || needFts) {
    setTimeout(() => {
      void (async () => {
        if (needDerived) {
          const r = await rebuildDerivedTables({ client: libraryClient!, store })
          if (r.ok) derivedReady = true
          console.info(`[derived] rebuild ${r.ok ? 'done' : 'incomplete'}: ${r.done}/${r.total} roots, failed=${r.failed}`)
        }
        if (needFts) {
          // setTimeout 里才跑：那时 search 已装配完（赋值在本块之后、模块顶层之内）
          const r = await rebuildFtsStreaming({ client: libraryClient!, store, indexer: search!.indexer })
          console.info(`[fts] backfill ${r.ok ? 'done' : 'incomplete'}: ${r.done}/${r.total} roots, failed=${r.failed}`)
        }
      })().catch((e) => console.warn('[boot] backfill failed:', e))
    }, 3000)
  }
}

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
if (!worksetBoot) {
  ws = boot.status === 'ok' ? boot.ws : seedWorkspace()
  // 整库路：这份模型就是库本身（换库语义清掉可能残留的工作集状态）
  blocks.reset(ws.blocks)
  // web 单库的读面：内存全量实现（代价登记见 `memory-client.ts`）。
  // 模型已就位才建——现场编码读的是活森林；消费面只认契约，web 与桌面同一批代码。
  libraryClient = createMemoryLibraryClient({ ws: () => ws, store: blocks })
}
/**
 * **名字归属的按名点查**（创建路径的防重判据）：启动不再读全量地址表，问一个名字查一行。
 * 两个宿主同一个契约——桌面走库的具名读，web 单库的内存读面覆盖整片森林。
 * 没有库面 ⇒ 不装解析器：归属永远 `unchecked`（也就没有任何创建路径能落笔）。
 */
if (libraryClient) {
  const client = libraryClient
  blocks.setAliasResolver(async (norms) => {
    const r = await client.aliasTargets?.(norms)
    if (!r || r.status !== 'ok') throw new Error(`alias-targets: ${r ? (r.status === 'error' ? r.error : r.status) : 'unavailable'}`)
    const out = new Map<string, string>()
    for (const row of r.value) if (!out.has(row.norm)) out.set(row.norm, row.block)
    return out
  })
}
/**
 * 种子库的**设备侧**演示配置：日记面板的演示栏 ＋ 左槽的演示收纳盘（`seedDock`）。
 * 它们住在设备状态里（日记面板是系统视图；槽布局「跟库走」但不属于任何一块）。
 *
 * 只在「这一份库是刚种出来的」时给：旧库作废重 seed 也算一次全新开始，
 * 而两个仓都空着的时候（第一次打开）更该看到那一栏与那只盘。
 */
if (boot.status !== 'ok') {
  device.prefs.journalMounts = seedJournalMounts()
  device.prefs.dock = seedDock()
}

/**
 * **搜索运行时**：桌面库才可能走 FTS；web 没有 SQLite，构造时 `bridge.search` 缺失
 * ⇒ 查询自动走森林扫描（同一套词项，标记为降级）。
 *
 * **索引快照**：工作集路的映射**按块查**，这里只带状态/分词器版本/水位——
 * 状态不是 ready ⇒ 查询面显式降级（不扫描工作集），重建被服务挡住。
 * web 没有快照（映射就是内存森林本身），走森林扫描。
 */
const searchSnapshot: SearchSnapshot | undefined = worksetBoot
  ? {
      map: new Map(),
      state: worksetBoot.catalog.meta.ftsState === 'ready' ? 'ready' : 'pending',
      rowidSeq: worksetBoot.catalog.meta.ftsRowidSeq,
      tokenizer: worksetBoot.catalog.meta.ftsTokenizer,
    }
  : undefined

search = createSearchService({
  bridge: LIBRARY_BRIDGE,
  forest: () => ws.blocks,
  snapshot: searchSnapshot,
  isPartial: () => blocks.partial,
  // 命中块按 id 连祖先链装进工作集（⌘K 的结果呈现要块对象）
  loadBlocks: async (ids) => {
    if (!libraryClient || !workset || ids.length === 0) return
    const loadedBefore = new Set(ids.filter((id) => blocks.isLoaded(id)))
    const r = await libraryClient.tree(ids, false)
    if (r.status === 'ok') {
      workset.loadBlocks(r.value, true)
      // 只给「这次才装进来的」块涂未知：已经在内存里的可能已读过子树，别让它白补读
      workset.markChildrenUnknown(blockRowIds(r.value).filter((id) => !loadedBefore.has(id)))
    } else console.warn('[search] hit load failed:', r.status === 'error' ? r.error : r.status)
  },
  // 依赖方走全库（改名/清除的低频路径）：未装载依赖块的 FTS 行也住着旧名字
  dependentsOf: async (id) => {
    if (!libraryClient) return { content: [], tag: [], prop: [] }
    const r = await libraryClient.dependents(id)
    if (r.status !== 'ok') throw new Error(r.status === 'error' ? r.error : r.status)
    return r.value
  },
  // 增量索引的现有 rowid 按块查（不再把整张映射搬进内存）
  ftsMapOf: async (ids) => {
    if (!libraryClient) return new Map()
    const r = await libraryClient.ftsMap(ids)
    if (r.status !== 'ok') throw new Error(r.status === 'error' ? r.error : r.status)
    const out = new Map<string, number>()
    for (const row of r.value) {
      if (typeof row.source !== 'string' || !(FTS_SOURCES as readonly string[]).includes(row.source)) continue
      out.set(ftsRowKey(row.block_id, row.source as FtsSource), Number(row.fts_rowid))
    }
    return out
  },
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

// **巨大页**：首窗之后还有余下（`pending` 非空）⇒ 内容会在首帧后继续长出来。
// 这句提示在解释「为什么下面是空的、呆会儿又有」——冻结的那一档已经没有了
if (worksetBoot && worksetBoot.pending.length > 0) bootState.notice = t('ui.boot.largeDoc')

/** 槽快捷卡指到的块 id（设备状态里那几个）：它们不在任何 Doc 里，但首帧要显示名字 */
function dockShortcutIds(device: DeviceState): string[] {
  const out: string[] = []
  for (const side of ['left', 'right'] as const) {
    for (const card of device.prefs.dock[side].cards) {
      if (card.kind === 'shortcut') out.push(card.block)
      else if (card.kind === 'tray') for (const member of card.cards) if (member.kind === 'shortcut') out.push(member.block)
    }
  }
  return out
}

/** 槽里窗口卡指向的块：重开时要把它们的**子树**装齐，卡里才不是只有根行 */
function dockWindowIds(device: DeviceState): string[] {
  const out = new Set<string>()
  for (const side of ['left', 'right'] as const) {
    for (const card of device.prefs.dock[side].cards) if (card.kind === 'block') out.add(card.block)
  }
  return [...out]
}

const pendingDocs = new Map<string, Promise<void>>()

/**
 * **按 id 装一批块进工作集**（导航装载的唯一咽喉）。
 *
 * 工作集装载下「`kb.get` 拿不到」只说明没装；打开/聚焦一个未装载的目标必须
 * 先装再继续——把未加载当不存在去新建（或静默丢弃点击）都是事故。同一批 id 的
 * 并发装载只发一次 IPC；装载进来的根钉住（它马上要成为某个视图的当前对象）。
 * 整库模式下所有块都在内存里，直接 `then()`。
 *
 * **巨大 Doc 不再一次读完**：首窗落地就交（`then`），余下的窗口在首帧后接着装，
 * 装完投影一次并重画一次（窗口与投影口径见 `app/boot/doc-windows.ts`）。
 */
function ensureDocsLoaded(ids: readonly string[], then: () => void): void {
  if (!libraryClient || !workset) {
    then()
    return
  }
  /**
   * **「没装载」与「装的是裸块」都要补**：按 id 的预取（身份块／引用目标／候选闭包）
   * 只给块自己的行，`children` 是空的——直接拿来打开，正文就只有根行。
   * 判据是 `childrenKnown`，不是 `children.length === 0`（真叶子不能被当成没装）。
   */
  const missing = [...new Set(ids)].filter((id) => kb.needsDoc(id))
  if (missing.length === 0) {
    then()
    return
  }
  const key = [...missing].sort().join(',')
  const inflight = pendingDocs.get(key)
  if (inflight) {
    void inflight.then(then)
    return
  }
  const run = loadDocs(missing, then).finally(() => pendingDocs.delete(key))
  pendingDocs.set(key, run)
}

/**
 * 装载主体：首窗落地即 `onFirst`，余下窗口读完后投影并重画。
 *
 * 窗口读不可用（实现没提供这条读面）或某一 root 没有派生路径（索引未铺到它）
 * ⇒ **整批退回整棵读**：降级不是另一种语义。
 */
async function loadDocs(ids: readonly string[], onFirst: () => void): Promise<void> {
  const client = libraryClient!
  const ws = workset!
  const windows = await readFirstWindows(client, ids)
  if (windows) {
    for (const w of windows) {
      ws.loadDoc(withAncestors(w), w.rootIds)
      ws.pin(w.rootIds)
      // 一窗读完 ⇒ 这棵子树的 children 全在身上；还有下一窗的根只是先序前缀，标未知，
      // 由 `finishDocWindows` 读到最后一窗后转成已知
      // 根自己也算「这一窗读过的块」：窗口可以只装根、不含任何后代（叶子），
      // 漏了它会让 needsDoc 永远为真，打开入口在「再装一次」上死循环。
      if (w.next === null) ws.markChildrenKnown([...w.rootIds, ...blockRowIds(w.rows)])
      else ws.markChildrenUnknown(w.rootIds)
    }
    onFirst()
    if (await finishDocWindows(client, ws, pendingOf(windows))) repaintAfterGrow()
    return
  }
  const r = await client.doc(ids)
  if (r.status === 'ok') {
    ws.loadDoc(withAncestors(r.value), r.value.rootIds)
    ws.pin(r.value.rootIds)
    // 整棵读：子树里的每一块 children 都齐了（祖先链只补名字，不算）；根同样要算进去
    ws.markChildrenKnown([...r.value.rootIds, ...blockRowIds(r.value.rows)])
  } else {
    console.warn('[workset] doc load failed:', r.status === 'error' ? r.error : r.status)
  }
  onFirst()
}

/** 一批装载行里的块 id（标记「children 已读全」的单位） */
function blockRowIds(rows: RawLibraryRows): string[] {
  const out: string[] = []
  for (const r of rows.blocks) if (typeof r.id === 'string') out.push(r.id)
  return out
}

/**
 * 背景补装完的那一次重画：新装进来的子块必须出现在已经画好的树里。
 *
 * 让过输入法组合期（`deferWhileComposing`）：用户正在这一行打字时换 DOM 会把
 * 预编辑串弄坏；那种情况下内容在下一次重画时出现。
 */
function repaintAfterGrow(): void {
  if (typeof ed === 'undefined' || !ed || ed.deferWhileComposing()) return
  ed.reloadFromStore()
}

/**
 * **候选流分页**（查询层的装配侧）：取**一页**候选装进工作集。
 *
 * 分页在库里按文档先序（`BlockIndex.path` 的 keyset），单位是**候选**——判定仍在渲染层，
 * 所以调用方每取一页就重新求值，直到「命中够一屏」或「到底」。有 `sort` 的条件必须
 * 取到底（全局排序需要全集），这条口径留在调用方（它才知道排序）。
 *
 * 一次只问一页 ⇒ 传输上限（一次 id 列表 ≤ 512）永远碰不到；旧的一次性装载在宽候选上
 * 会整批 `bad-args`，查询于是对用户静默少行。
 *
 * ⚠️ **整库模式（没有工作集）不装这条**：视图宿主拿到它就把「已取候选」当求值域，
 * 而整库上每页装载早退 ⇒ 域永远是空集 ⇒ 全部命中被滤掉（「刷新后 0 条」实测）。
 * 整库的求值天然完整，视图宿主没有这条反而走对（`domain()` 回 undefined）。
 */
const loadCandidateWindow = workset
  ? (
      spec: QuerySpec,
      ctx: QueryContext,
      host: Block | undefined,
      req: CandidateWindowRequest,
      withChildren?: boolean,
    ): Promise<CandidateLoadStep> =>
      loadCandidateWindowOf({ client: libraryClient, workset, store: blocks }, spec, ctx, host, req, withChildren)
  : undefined

/**
 * 冷启动的**落点**与**物化**。两条装载路的判据来源不同：
 *   · **工作集**：存在性由 catalog 回答（全库的日期表）——「未加载」不当「不存在」，
 *     物化只写操作根（op 自带值/位置）；
 *   · **整库**：在森林里现找（旧行为，web／种子路径）。
 *
 * ⚠️ **读到的正常库不抢 activeId**（2026-10-20 修）：今日只负责**存在**，不负责**抢焦点**。
 * ⚠️ 这一步**会写模型**（幂等物化），所以要在装配编辑器之前做，且落盘一次。
 */
const todayId = journalId(todayISO())
const bootOps: Op[] = []
let bootRoots: Block[] = []
if (worksetBoot && libraryClient) {
  // 这一支的前提就是 workset 已建好（worksetBoot 只在装载成功分支与 workset 一起赋值）
  const bootWorkset = workset!
  // —— 引用闭包预取 ——
  // active 指向的日记天在窗口外时也要在内存里（当前对象/标题要它）
  const activeJournalOutside = worksetBoot.catalog.journals.some(
    (j) => j.id === ws.activeId && worksetBoot.mode === 'feed' && !worksetBoot.rootIds.includes(ws.activeId),
  )
  const closureIds = worksetClosureIds(blocks.blocks, [
    ...dockShortcutIds(device),
    ...(activeJournalOutside ? [ws.activeId] : []),
  ])
  const missing = closureIds.filter((id) => !blocks.isLoaded(id))
  if (missing.length > 0) {
    const r = await libraryClient.blocks(missing)
    if (r.status === 'ok') {
      bootWorkset.loadBlocks(r.value)
      bootWorkset.markChildrenUnknown(blockRowIds(r.value))
    } else console.warn('[boot] closure prefetch failed:', r.status === 'error' ? r.error : r.status)
  }
  // —— pin：首帧闭包全部钉住 ——
  // 引用目标/标签/定义被淘汰会让首帧渲染拿到过期副本；预算淘汰从导航装载开始才有意义
  bootWorkset.pin([...bootWorkset.loadedIds()])
  // —— 物化（作用域写） ——
  const hadToday = worksetBoot.today.exists
  const todayTomb = worksetBoot.today.deleted
  const days = worksetBoot.mode === 'feed' ? [...worksetBoot.roots] : []
  if (!hadToday || todayTomb || days.some((d) => !hasLiveChildren(d))) {
    const r = kb.tx((tx) => {
      if (!hadToday) {
        // 删过就复活原块（同 id、同位置），不要新建第二个今天
        if (todayTomb) tx.restore(todayId)
        else tx.insert(mkJournalBlock(todayISO()), null, 0)
      }
      for (const day of days) {
        if (!hasLiveChildren(day)) tx.insert(mkBlock(''), day.id, 0)
      }
    })
    bootOps.push(...r.ops)
  }
  // 物化之后今天一定在场（新建/复活）；窗口里没有它就放到最前（feed 的语义）
  const todayBlock = blocks.find(todayId)
  if (worksetBoot.mode === 'feed' && todayBlock && !days.some((d) => d.id === todayId)) days.unshift(todayBlock)
  const activeStillExists = worksetBoot.mode === 'page' ? blocks.find(ws.activeId) !== undefined : true
  if (boot.status !== 'ok' || !activeStillExists) ws.activeId = todayId
  bootRoots = worksetBoot.mode === 'page' ? worksetBoot.roots : days.length > 0 ? rootsForMany(days) : []
} else {
  const activeStillExists = Boolean(findInForest(ws.blocks, ws.activeId))
  const hadToday = Boolean(findInForest(ws.blocks, todayId))
  /**
   * 今天的块可能是**软删**状态（用户删过这一天）。它还在数组原位（id 由日期确定性派生），
   * 所以冷启动不能 `insert` 一个新的：那会得到两个同 id 的块，之后按 id 的读只看得到先序第一个。
   */
  const todayTomb = trashOf(ws.blocks).some((b) => b.id === todayId)
  /**
   * **冷启动物化走事务**：今日块、空天首子块都是真实编辑，
   * 所以它们有 op（`bootOps`）—— 落盘与重放看到的是同一件事。
   *
   * ⚠️ 「有没有子块」判 `hasLiveChildren`：删除是原位软删，块还挂在 `children` 里，
   *    用长度判会让「删空过的天」每次冷启动都补不回来。
   */
  const bootFeed = feedDays(ws.blocks, FEED_INITIAL)
  if (!hadToday || todayTomb || bootFeed.some((d) => !hasLiveChildren(d))) {
    const r = kb.tx((tx) => {
      if (!hadToday) {
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
   * ⚠️ 两条路径都只用 `rootsFor` 那条规则：journal ⇒ 每段保证有可编辑子块；
   *    别的块 ⇒ 只要**那一个**。
   */
  const bootActive = findInForest(ws.blocks, ws.activeId) ?? ws.blocks[0]
  const bootDays = bootActive && isJournal(bootActive) ? feedDays(ws.blocks, FEED_INITIAL) : []
  bootRoots = bootDays.length > 0 ? rootsForMany(bootDays) : bootActive ? rootsFor(bootActive) : []
}

/**
 * **首帧读面探针（仅开发构建）**：工作集装载打印真机读数与主进程记的读行数。
 *
 * 验收看两个数：`loaded`（工作集块数＝Doc 闭包）与 `doc/catalog/blocks` 的行数
 * （这次首帧到底搬了多少行进渲染层——读面只有具名几条，没有「整库」一格可读）。
 * `bootOps` 非空 ⇒ 这一轮刚物化了今日/空天首子块，那些行要等首笔落盘才在库里（照常打印）。
 */
if (DEV_SURFACE && LIBRARY_BRIDGE && worksetBoot) {
  const bootCounts = worksetBoot.counts
  void LIBRARY_BRIDGE.libraryInfo()
    .then((raw) => {
      const reads = (raw as { reads?: Record<string, number> } | null)?.reads
      console.info(
        `[perf] boot working set: mode=${worksetBoot!.mode} roots=${bootRoots.length} loaded=${blocks.loadedCount} ` +
          `doc=${bootCounts.docReads}/${bootCounts.docRows} catalog=${bootCounts.catalogRows} ` +
          `identity=${bootCounts.identityRows} ` +
          `session doc=${reads?.doc ?? '?'}/${reads?.docRows ?? '?'} catalog=${reads?.catalog ?? '?'} blocks=${reads?.blocks ?? '?'}/${reads?.blockRows ?? '?'}`,
      )
    })
    .catch(() => console.warn('[perf] boot read probe: libraryInfo failed'))
}

const layers = new Layers(() => isMac())
let ed: BlockEditor
/** 中心槽的主编辑器；`ed` 是「当前活动编辑器」（正文或反链 footer） */
let mainEd: BlockEditor
/** **这一屏的筛选**（顶栏漏斗）：按当前对象分格的会话状态；编辑器造好之后才装配 */
let outlineFilter: OutlineFilter | null = null
let registry: Registry
/** 截图/自检时静音 toast（产品行为不变，只是不弹提示） */
let quiet = false

const isMac = (): boolean => /Mac|iPhone|iPad/.test(navigator.platform)
/** 短 id：uuidv7 前 12 位是时间戳（同一毫秒创建的块会撞），所以要短就取**尾部随机段** */
const shortId = (id: string): string => id.slice(-6)
/** 引用解析用（呈现摘要现算名字）：main 里的呈现面共用这一只箭头 */
const kbGet = (id: string) => kb.get(id)
/**
 * 偏好**不活在库里**（v15 起）：它是这台设备怎么显示（主题／槽宽／钉住的块）。
 * 调用点仍按「拿到一份可改的偏好对象」用它 —— 改完由 `scheduleDeviceSave()` 落盘。
 */
const prefs = (): Prefs => device.prefs

/* ------------------------------------------------------------ 键位提示 */

// 用户改过的键位启动即注入（读时生效；之后每次改动由设置面的写回调再注入）
setUserKeys(prefs().keys)

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
const { renderDocks, openWindow, closeCard, addTile, addDerived, addUtility, addShortcut, removeShortcut, retargetShortcut, collapseToShortcut, restoreWindow, cardStateFor, windowLabel, setWindows, toggleFoldAll, topWindow, closeOtherWindows, closeAllWindows, createTrayFromTile, collectRestIntoTray, dissolveTray, removeTrayWithCards, startTrayRename } = setupDocks({
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
  showCardMenu: (side, key, anchor, trigger) => menus.showCardMenu(side, key, anchor, trigger),
  showShortcutMenu: (side, blockId, anchor, trigger) => menus.showShortcutMenu(side, blockId, anchor, trigger),
  showTileMenu: (side, command, anchor, trigger) => menus.showTileMenu(side, command, anchor, trigger),
  toast: (msg, kind) => app.toast(msg, kind),
  confirm: (o) => layers.confirm(o),
  /**
   * 挂载区卡：**与正文块底那台挂载区同一台组件**（宿主＝当前对象，随导航换一次装载）。
   *
   * 懒建：卡第一次出现时才建实例。工厂本身在装配早期传入，但真正调用发生在
   * 首次重画——那时 `panels`／`cardStateFor`／`closeCard` 都已就位（`panels` 的
   * 工厂造的是中心段尾那台的兄弟实例：同一份判据，另一份表面 spec）。
   */
  createMountCard: (side) =>
    new DockMountCard({
      target: () => ws.activeId,
      createArea: (target) => panels.createDockMountArea(target),
      state: () => cardStateFor(side, 'mount'),
      onClose: () => closeCard(side, 'mount'),
      // 活动编辑器正指着卡里那台时退回正文：摘卡之后键位不能指着一台已卸事件的编辑器
      onDispose: (editor) => {
        if (ed !== editor) return
        ed = mainEd
        scheduleBadge()
      },
    }),
  /**
   * 搜索卡（**工具面住进槽**）：与 ⌘K 浮层、中心 tab 是同一份 `SearchFace`。
   * 依赖经 `searchFaceDeps()` 现取（引擎/打开/晋升/复制都在装配层）；卡壳状态与关闭
   * 归槽那套（与派生卡同型）。
   */
  createSearchCard: (side) =>
    new SearchCard({
      faceDeps: searchFaceDeps,
      // 扁平 key 由 `dockKey` 一份地算（DOM 属性、收起表、关闭目标同一份身份）
      id: dockKey({ kind: 'utility', face: 'search' }),
      title: t('ui.surface.search'),
      state: () => cardStateFor(side, dockKey({ kind: 'utility', face: 'search' })),
      onClose: () => closeCard(side, dockKey({ kind: 'utility', face: 'search' })),
    }),
  // 左槽行／日历日期的「打开」都经这一条；具体落点策略只在 App.openBlock 一份
  openBlock: (id, place, opts) => app.openBlock(id, place, opts),
  // 窗口卡里是那一块的真实编辑器：裸块先补子树，否则卡里只有根行
  ensureDoc: (ids, then) => ensureDocsLoaded(ids, then),
})

const { chrome, editorEl, applyChrome, paintTopbarNav, resolvedTheme, dockMinWidth, dockMaxWidth, badge, scheduleBadge, markBooted } = setupChrome({
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
 * `ed` 是装配层的单槽，而两面（tab 搜索面 / ⌘K 浮层）可以同屏：每面各持一份槽，
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
  /** 搜索面无结果时的创建入口（公开形状与判据见 `searchFaceDeps` 里 `createPage` 的注释） */
  const createPageIn = (name: string): void => {
    // 归属还没问过库 ⇒ 问一次再重放（闸的语义见 `core/kb/alias-gate.ts`）
    if (deferAliasGate(kb, name, () => createPageIn(name))) return
    let id = ''
    try {
      id = pageDeps.run((tx) => ensurePageInTx(kb, name, tx)?.id ?? '').result
    } catch (e) {
      // 名字被一个未装载的块占着 ⇒ 不新建；说一句实话（搜索面的「创建」入口）
      if (e instanceof AliasClaimError) {
        app.toast(t('ui.toast.aliasUnloaded'), 'warn')
        return
      }
      throw e
    }
    if (id !== '') app.openBlock(id, 'center')
  }

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
    // 引擎现取：索引状态会变（ready 才信 FTS，否则扫描降级——面自己把降级说明白）。
    // 工作集模式下「扫描」由服务挡成显式空（不扫工作集给假结果）
    query: (text, limit) => (search ?? { query: async () => ({ hits: [], mode: 'scan' as const }) }).query(text, limit),
    // 行怎么说与 ⌘K 浮层同一份
    describe: (hit, term) => describeHit(kb, hit, term),
    openBlock: (id, place) => app.openBlock(id, place ?? 'center'),
    // 晋升：把词写进 {text} 条件建查询块（与手建同一份创建路径，落森林顶层，一笔回滚）
    promote: (term) => app.createQuery(term, { where: { text: term } }),
    // 无结果的创建入口：找到或创建页（与引用浮层同一条创建路径），建好当场打开
    createPage: createPageIn,
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
/** 设置面的依赖（同搜索面的道理：`run`／`scheduleDeviceSave` 晚于本节 ⇒ 闭包现取） */
const settingsFaceDeps = (): SettingsFaceDeps => ({
  prefs,
  invoke: (name, args) => {
    void registry.invoke(name, args, 'settings')
  },
  commandTitle: (name) => registry.decl(name)?.title ?? name,
  /**
   * 键位覆盖的**唯一写点**：进 prefs（落盘）＋ 注入绑定层（读时生效）。
   * 注入和保存必须同时发生——只存不注入，改完的键位要重启才认。
   */
  patchKeys: (next) => {
    prefs().keys = next
    setUserKeys(next)
    scheduleDeviceSave()
  },
  toast: (text, kind) => app.toast(text, kind),
})

const surface = setupSurface({
  kb,
  getRegistry: () => registry,
  renderDocks: () => renderDocks(),
  getChrome: () => chrome,
  searchDeps: searchFaceDeps,
  settingsDeps: settingsFaceDeps,
  confirm: (o) => layers.confirm(o),
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

const {
  triggers,
  triggerState,
  showMenu,
  openTrigger,
  refreshSelectionBar,
  showSelectionRefPicker,
  toggleColorAxis,
} = setupRetrieval({
  ws,
  kb,
  layers,
  uiCtx,
  keyHints,
  prefs,
  getEd: () => ed,
  isMac,
  // registry 与面板晚于本片装配：闭包现取
  getRegistry: () => registry,
  getPanels: () => panels,
  scheduleDeviceSave,
})

const {
  writeProps,
  repaintBlock,
  blockName,
  addBlockRole,
  setBlockColor,
  setBlockIcon,
  removeBlockRole,
  applyBlockType,
  refLabelOf,
  propsLineModeOf,
  openPropsLineMenu,
} = setupBlockProps({
  ws,
  blocks,
  kb,
  kbGet,
  // 类方法脱手调用会丢 this（openMenu 第一行读 this.open 就炸）——包一层闭包保住绑定
  openMenu: (o) => layers.openMenu(o),
  prefs,
  txRun,
  scheduleSave,
  scheduleBadge,
  // 面板与 App 门面都晚于本片装配：闭包现取，调用期才解引用
  scheduleProperties: () => panels.scheduleProperties(),
  getEd: () => ed,
  getMainEd: () => mainEd,
  toast: (text, kind) => app.toast(text, kind),
  openBlockConfig: (id, opts) => app.openBlockConfig(id, opts),
  setPropsLineMode: (id, mode) => app.setPropsLineMode(id, mode),
  shortId,
})

const assets = setupAssets({
  assetStore,
  getEd: () => ed,
  // 面板与角标都晚于本片装配：闭包现取（订阅回调只在运行期触发）
  scheduleProperties: () => panels.scheduleProperties(),
  scheduleBadge: () => scheduleBadge(),
  toast: (text, kind) => app.toast(text, kind),
  blocks,
  repaintBlock,
})


/**
 * 打开的是盘上已有的库 ⇒ 现在就检查索引；种子／换库那条路要等第一笔 replace
 * 落盘（`onReplace`）之后才重建，否则会先给一份还没写进库的森林建索引。
 * （工作集模式下「重建/扫描都不做」的门在服务里：`SearchDeps.isPartial`。）
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

/* ------------------------------------------------ 浮层（装配在 wiring/atom-popovers） */

/**
 * 实例字段卡需要的读写能力（`setupPanels` 之后才有 `pickRef`，所以先留变量）。
 * ⚠️ 值只写记录块：`setValue` 收的是 recordId，浮层拿不到宿主块。
 */
let objFieldDeps: ObjFieldDeps | undefined
let popovers: ReturnType<typeof setupAtomPopovers>

/** 行内原子浮层/右键菜单/露面点击的唯一口径；deps 全是活引用（app/registry/ws 都晚于此处初始化） */
popovers = setupAtomPopovers({
  uiCtx,
  isMac,
  shortId,
  getRegistry: () => registry,
  getActiveBlock: () => activeBlock(),
  getMainEd: () => mainEd,
  getWs: () => ws,
  openBlockRoute: (id, place) => app.openBlock(id, place),
  openNotePopover: (sig) => app.openNotePopover(sig),
  layers,
  getEd: () => ed,
  toast: (msg, kind) => app.toast(msg, kind),
  showMenu,
  objFieldDeps: () => objFieldDeps,
})

/**
 * **引用数徽标的 hover 浮层**：浮层里是第三个表面（同一台 `MountArea`），
 * 块行行尾与引用栏抬头两枚 chip 都由它的全局委托命中，不逐枚绑事件。
 *
 * 点 chip 走 `openAtBar`：**先 zoom 到被引用块**，因为底部挂载区是按段根建的，
 * 不换宿主的话那一栏显示的是整页的反链、答非所问；zoom 之后宿主才是这一块，
 * 此刻激活 `d-refs` 才是「谁引用了它」。
 */
const refPeek = createRefPeek({
  createArea: (target) => panels.createRefPeekArea(target),
  openAtBar: (id) => {
    void registry.invoke('core.block/focus-block', { blockId: id }, 'ref-badge')
    // 等 zoom 落定一帧：新段的挂载区实例由 renderMounts() 建好再激活
    requestAnimationFrame(() => {
      panels.activateRefsFor(id)
      document.querySelector<HTMLElement>('#editor .sec-mount')?.scrollIntoView({ block: 'start' })
    })
  },
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

const { pageDeps, activeBlock, activeTrail, pageTitle, nav, historyGo, firstEditableRoot, materializeEditableRoots, initTabs, resetTabs, listTabs, activateTab, openInNewTab, openSurfaceTab, newTab, closeTab, nextTab, prevTab, canGoBack, canGoForward, refreshTabs } = setupPages({
  kb,
  blocks,
  loadDocThen: ensureDocsLoaded,
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
  // ⌥+点日期：先物化那一天，再把属性面板钉上去（不改中心）
  openPropertiesDrawer: (id) => app.openPropertiesDrawer(id),
  onTabsChanged: (tabs) => {
    renderCenterTabs(tabs)
    // 顶栏的前进/后退跟着导航历史置灰；`emitTabs()` 在每次导航与切 tab 时都发
    paintTopbarNav(canGoBack(), canGoForward())
    // 表面 tab 开着时库会变（恢复/删除走别处）：身体跟着重画，与槽里的同一张卡同拍
    surface.refreshIfShown()
  },
  onSurface: (ref) => {
    surface.show(ref)
    // 表面让位/回来都会改变「这一屏」是什么：漏斗的可见性跟着换
    outlineFilter?.render()
  },
  onLoaded: () => outlineFilter?.render(),
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
    /*
     * 「全部页签」集合：顶栏放得下的直接点，放不下的从这里纵览／切换。
     * 同一个块只许有一张 tab（状态层按视图去重）⇒ 名字天然能区分，不必编号。
     */
    openList: (trigger) => {
      const tabs = listTabs()
      layers.openMenu({
        rows: tabs.map((tab) => ({
          id: tab.id,
          label: tab.title,
          hint: tab.active ? t('ui.tabs.current') : '',
          icon: tab.title.endsWith(t('ui.tabs.feed')) ? 'lucide:calendar' : 'lucide:file',
          group: t('ui.tabs.group'),
        })),
        anchor: null,
        trigger,
        title: t('ui.tabs.all', { n: tabs.length }),
        searchable: true,
        focusSearch: false,
        placeholder: t('ui.tabs.search'),
        onPick: (row) => {
          activateTab(row.id)
        },
      })
    },
  }, chrome.centerTabAddEl, chrome.centerTabListEl)
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
  recordDevice: (step) => {
    blocks.recordDevice(step)
  },
  onChange: () => {
    panels?.renderMounts()
    panels?.renderProperties()
    scheduleSave()
    scheduleBadge()
  },
})

const clipboard = setupClipboard({
  toast: (text, kind) => app.toast(text, kind),
  getEd: () => ed,
})

const viewMenus = setupViewMenus({
  ws,
  blocks,
  kb,
  kbGet,
  owners,
  layers,
  uiCtx,
  getEd: () => ed,
  getRegistry: () => registry,
  getPanels: () => panels,
  getApp: () => app,
  shortId,
  getPageDeps: () => pageDeps,
  toast: (text, kind) => app.toast(text, kind),
  blockName,
})

const { viewEvents, wireViewEditor } = createEditorEvents({
  getRegistry: () => registry,
  layers,
  blocks,
  run,
  kb,
  kbGet,
  assets,
  clipboard,
  showMenu,
  triggerState,
  openPropsLineMenu,
  propsLineModeOf,
  refLabelOf,
  repaintBlock,
  viewMenus,
  getPopovers: () => popovers,
  refPeek,
  shortId,
  focusSourceInMain,
  getApp: () => app,
  setEd: (e) => {
    ed = e
  },
  loadDocThen: (ids, then) => ensureDocsLoaded(ids, then),
  openTrigger,
  refreshSelectionBar,
  triggers,
  getPanels: () => panels,
})

const app: App = {
  get ed() {
    return ed
  },
  showSelectionRefPicker,
  toggleColorAxis,

  /**
   * **备注浮窗**：锚在被备注文本旁的可编辑浮层（手势落点判据：写作面在原地，不跳收集清单）。
   * 锚用**函数形态**（实时取矩形：滚动/重排跟着走，锚没了自动关——layers 的既有口径）；
   * 关闭即提交——`onClose` 是所有关闭出口（外点/Esc/顶掉）的汇合点：先 flush 推 DOM→模型，
   * 空备注连块回收（不留空壳；锚留宿主、读侧判活不画），有内容即完成（Esc 不丢字）。
   */
  openNotePopover: (sig) => {
    // noteId 省略（右键菜单只有锚坐标）⇒ 按 annotates 边反查备注块
    const noteId =
      sig.noteId ??
      kb.relationsTo(sig.blockId).find((e) => e.kind === 'annotates' && e.propId === sig.annoId)?.from
    if (!noteId) return
    const note = blocks.find(noteId)
    if (!note) return
    const host = blocks.find(sig.blockId)
    const quote = host?.annos?.find((a) => a.id === sig.annoId)?.quote?.exact ?? ''
    let handle: NotePopoverHandle | null = null
    layers.openPopover(
      (into) => {
        handle = mountNotePopover({
          into,
          store: blocks,
          write: editorRun(run, () => mainEd),
          wire: (ed2, change) => wireViewEditor(ed2, change, 'note-popover'),
          onFocus: (next) => {
            ed = next
          },
          onChange: () => {
            scheduleSave()
          },
          block: () => blocks.find(noteId),
          quote,
          onOpenInSidebar: () => {
            // 像打开普通块一样：右槽把备注块当当前对象装载（Shift-点引用同一条 openBlock 路）
            app.openBlock(noteId, 'dock')
            layers.closePopover()
          },
          placeholder: t('ui.note.placeholder'),
        })
        // 焦点落进备注行：浮窗已挂进文档（render 返回后 openPopover 才 append）⇒ 推迟一帧再落
        requestAnimationFrame(() => {
          const ed2 = handle?.editor()
          if (ed2) {
            ed2.container.focus()
            ed2.placeCaret(noteId, 0)
          }
        })
      },
      () => mainEd.annoRect(sig.blockId, sig.annoId),
      () => {
        handle?.flush()
        const after = blocks.find(noteId)
        if (after && plainText(after.content) === '') run((tx) => tx.remove(noteId))
        handle?.dispose()
        handle = null
      },
    )
  },

  /**
   * **一步撤销**（命令分组 API 的历史语义）：组内所有写入共用一个撤销条目。
   * 原子性归 `Tx`；这里只分组历史。分组内的嵌套由 `beginUndoGroup` 显式授权。
   */
  runGroup: <T>(fn: () => T, kind: UndoKind = 'other'): T => {
    ed.beginUndoGroup()
    try {
      return fn()
    } finally {
      ed.endUndoGroup(kind)
    }
  },

  /**
   * **回收站清空**：purge 不进撤销栈（不可逆是口径），所以它与撤销/重做同形——
   * 建 op → 原地应用 → `store.apply` 宣布 → op 交落盘队列。撤销捕获那条路一步都不碰。
   */
  purgeTrash: (ids) => {
    const ops = kb.purgeTrash(ids)
    if (ops.length === 0) return 0
    addOps(ops)
    scheduleSave()
    return ops.length
  },

  /**
   * **查询块的就地落点**（`core.query/insert` / 斜杠「插入查询块」）。
   *
   * 为什么住在这里、不在视图命令那一组：落点要问**编辑器**（这一行空不空、在哪个兄弟位），
   * 插完还要把光标落到新留的空块上——视图命令只读写拥有者上的两个属性，碰不到这些。
   * 判据与「插入其他块」共用一套（空块原地转、否则插到下一行）。
   */
  insertQueryBlock: (blockId) => ed.insert.insertQueryAfter(blockId) ?? '',

  /**
   * **斜杠「插入看法」的落点**（`core.view/insert` 带 `kind` 的那一支）。
   *
   * 配置在**插入前**建好（`buildFreshView`：与视图菜单共一份 kind 兜底与默认名），
   * 经 `withBlockOwnerData` 规范化成**初始 props** 随整块落库——结构与配置同一笔事务、
   * 一次撤销；写语义仍只有 ViewOwnerStore 一份（这里只造新块的出生 props，与
   * `mkQueryBlock` 同形，不碰已有块的配置）。
   */
  insertViewBlock: (blockId, kindRaw) => {
    const view = buildFreshView(kb, { kind: 'children', blockId: '' }, kindRaw as StoredViewKind)
    if (!view) return ''
    const ownerProps = withBlockOwnerData(undefined, { views: [view], activeView: view.id })
    // 所有 children 源看法都就地画身体（`rowHasInlineViewBody`），插完留在原地即见
    return ed.insert.insertViewAfter(blockId, ownerProps) ?? ''
  },

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
    // 「写在父块、显示在子块」的声明（`_childProps`）要能把受影响的孩子一起重画
    repaintBlocks: (ids) => {
      for (const id of ids) repaintBlock(id)
    },
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
  }),
  ...mentionCommands({
    kb,
    run: runTx,
    toast: (text, kind) => app.toast(text, kind),
    // 选区从**活动编辑器**现取：正文/挂载区/侧槽都可能发起划选
    selection: () => ed.selectionSpot(),
    refreshList: () => renderDocks(),
    // 新建的普通块落在这一屏的宿主旁边；活动编辑器可能是挂载区/侧槽里的那一台
    refreshEditor: () => ed.reloadFromStore(),
    placeCaret: (blockId, offset) => ed.placeCaret(blockId, offset),
  }),
  ...viewConfigCommands({
    kb,
    owners,
    run: runTx,
    reloadPage: () => pageDeps.reloadPage(),
    rerenderEditor: () => mainEd.reloadFromStore(),
    rootIds: () => pageDeps.rootIds(),
    /**
     * 这个拥有者的视图身体此刻有没有被某个表面画着（正文内联体／段尾宿主／侧槽窗口／挂载区）。
     * 有 ⇒ 切视图/改配置是就地重画，不换屏、不动光标；块与 local tab 共用这一格。
     * ⚠️ 引用后建的 `panels`：这里只存函数，真正调用都在装配之后。
     */
    viewShown: (owner) => panels?.viewShown(owner) ?? false,
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
  openInDock: (id, side, solo) => openWindow(side === 'left' ? 'left' : 'right', id, 'view', undefined, solo),
  /**
   * **所有「点一下就打开」的入口共用这一条路由**（`action` 由 `openActionOf` 算）。
   *
   * 它不新增导航语义，只把六档动作组合起来：
   *   · inspect  → `openPropertiesDrawer`（看这一块自己的第二层；不改中心、不动槽、不入历史）
   *   · dock     → `openInDock`（不换中心、不入历史；`dockSolo` 同一落点，另外进入单卡）
   *   · tab      → `openInNewTab`（`tabWide` 同一落点，另外一次性进宽屏）
   *   · center   → 内容面 `zoomTo`（聚焦）；导航面 `openPage`（不抢焦点）
   *
   * ⚠️ `inspect` 放在最前：它是**目标自己的面**，不是「去哪」，先分流掉才不会落进导航。
   */
  openBlock: (id, action = 'center', opts) => {
    // 工作集装载下「点一个未加载（或只装了裸块）的目标」＝先装子树再打开
    // （不丢点击、不把未加载当不存在，也不把「子树还没装」当成「真的没有子块」）
    if (kb.needsDoc(id)) {
      ensureDocsLoaded([id], () => app.openBlock(id, action, opts))
      return
    }
    if (action === 'inspect') {
      app.openPropertiesDrawer(id)
      return
    }
    if (action === 'dock' || action === 'dockSolo') {
      app.openInDock(id, 'right', action === 'dockSolo')
      return
    }
    if (action === 'tab' || action === 'tabWide') {
      const opened = app.openInNewTab(id, opts?.feed === true)
      // 一次性进档只在「真的打开／切过去」时发生；档位住窗口，不跟 tab 走（布局归窗口、内容归 tab）
      const axis = openAxisOf(action)
      if (opened && axis) app.axisTo(axis)
      return
    }
    if (opts?.center === 'keep') app.openPage(id)
    else app.zoomTo(id, opts?.feed, opts?.restore)
  },
  topWindow: (id) => topWindow(id),
  /** 「加到快捷」：缺省左槽；块菜单／命令面不认识侧槽，落点由装配层给 */
  addShortcut: (id, side) => addShortcut(side === 'right' ? 'right' : 'left', id),

  /**
   * **块菜单里的「视图…」**：大纲 ＋ 这个块已有的视图 ＋「新建」（两种表）＋（结构映射表时）排序。
   *
   * 为什么是**动态菜单**而不是几条静态绑定：绑定表是静态的，而「这个块有哪些视图」
   * 是数据。菜单项由 `_views` 现画，选中之后仍走命令面（`core.view/*`）——
   * 于是撤销、落盘、审计只有一条路（与「菜单由绑定表渲染」同一条纪律的延伸）。
   */
  /* —— 视图/查询/配置菜单族住 `wiring/view-menus.ts`：spread 同一组方法 —— */
  ...viewMenus,

  /* ---- 行内资产：入口（粘贴/选文件）与异步入库 ---- */
  /**
   * 选文件：隐藏的 `<input type=file>`。Electron 与 web 同一个入口——
   * 原生对话框只在主进程有，而这条路浏览器里也能走通，没必要分两套。
   */
  pickImage: () => assets.pickImageViaFileInput(),
  pickAssetValue: (onPick) => assets.pickAssetValue(onPick),
  insertAssetBlob: (blob, label, point) => assets.insertAssetBlob(blob, label, point),

  /**
   * **打开外链**：协议白名单一过，就把地址交给壳。
   *
   * Electron 下 `window.open('_blank')` 被 `setWindowOpenHandler` 接住并转成
   * `shell.openExternal`（那份判据在 `electron/main.ts`，与主进程同侧，是信任边界上的那一道）；
   * web 下就是浏览器的新标签。两处都不在 app 里开一个裸窗口。
   */
  openExternal: (url) => assets.openExternalUrl(url),

  addBlockRole: (blockId, role) => addBlockRole(blockId, role),
  removeBlockRole: (blockId, role) => removeBlockRole(blockId, role),
  setBlockColor: (blockId, color) => setBlockColor(blockId, color),
  setBlockIcon: (blockId, icon) => setBlockIcon(blockId, icon),
  openBlockConfig: (blockId, opts) => panels.openBlockConfig(blockId, opts),
  openPropertiesDrawer: (blockId, focusPropId) => panels.openPropertiesDrawer(blockId, focusPropId),
  setBlockType: (blockId, typeId) => applyBlockType(blockId, typeId),
  /**
   * 块级删除：在正文里 ⇒ 编辑器的结构删除（装载根收尾、留空位）；
   * 不在正文里（记录面／派生栏）⇒ 库级软删。身份块不走这里，各有自己的命令。
   */
  deleteBlock: (blockId) => {
    if (!findInForest(ws.blocks, blockId)) return false
    if (locate(ed.doc, blockId)) return ed.struct.remove(blockId)
    /**
     * 不在正文里（记录面）：走 `pageDeps.run`（**带撤销条目**），不是
     * `pageDeps.removeBlock`——后者是身份删除用的裸结构写（回收站兜底、不进 ⌘Z），
     * 而「删一条记录」必须能一次撤销回来。
     */
    pageDeps.run((tx) => tx.remove(blockId))
    return true
  },
  /** 复制一块到它自己后面；正文里沿用编辑器（落点结构判据），记录面走库级插入。 */
  duplicateBlock: (blockId) => {
    if (locate(ed.doc, blockId)) return ed.struct.duplicate(blockId)
    const loc = locate({ roots: ws.blocks }, blockId)
    if (!loc) return null
    const { block } = cloneSubtree(loc.block)
    pageDeps.run((tx) => tx.insert(block, loc.parent?.id ?? null, loc.index + 1))
    return block.id
  },
  /**
   * 切换待办：判据在 `core/props/closure.ts`，编辑器只负责事务与重画。
   * 编辑器的方法已能寻址「不在本视图 doc 里」的块（`locateAny`）。
   */
  toggleClosure: (blockId, propId) => ed.toggleClosure(blockId, propId),
  clearClosure: (blockId) => ed.clearClosure(blockId),

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
    /*
     * 密度改的是**行高**：只重排窗口（`applyWindow`），不重装文档——
     * `reloadFromStore` 会按 store 重建 roots，把正在阅读的位置与选区一起丢掉。
     */
    refreshLayout: () => ed.applyWindow(),
    scheduleBadge,
    toast: (text, kind) => app.toast(text, kind),
  }),

  // 档位轴：进/退一档；状态住窗口，不写偏好
  axisStep: (dir) => axis.step(dir),
  axisTo: (mode) => axis.to(mode),

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
   * 全文检索（⌘K）：输入正文关键词，结果是**块**，右列是选中那块的真块预览。
   *
   * 宿主就是常驻搜索面本身（`compact` 形态）：同一份组件、同一台预览，不是第二套结果渲染。
   * 浮层只负责「快入口」的形状——可编辑但不常驻，要常驻就把词展开进 tab。
   *
   * `place` ＝ 挂载形态（与块打开同一套落点语言）：缺省＝浮层；`dock` ＝ 搜索卡
   * 住进右槽（槽家具，✕ 摘掉、画廊加回来）；`tab` ＝ 中心 tab。三种挂载是同一份
   * `SearchFace`，落点只回答「去哪」，词不随入口走（浮层的词只经「展开」带过去）。
   */
  openSearch: (place) => {
    if (!search) return
    // 第一次打开搜索时把索引排上（启动期不抢 CPU；用户按下 ⌘K 是最可靠的「现在可以建」信号）
    search.start()
    if (place === 'dock') {
      addUtility('right', 'search')
      return
    }
    if (place === 'tab' || place === 'tabWide') {
      app.openSurface({ kind: 'utility', id: 'search' })
      // 与块打开同一份判据：⌘⇧ 打开搜索面也顺手进宽屏（一次性，不写 prefs）
      const axis = place && openAxisOf(place)
      if (axis) app.axisTo(axis)
      return
    }
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
          // 选中即走：先关浮层（拆面、还焦点），再走装配层的打开路由（落点随修饰键）
          openBlock: (id, place) => {
            layers.closePopover()
            app.openBlock(id, place ?? 'center')
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
    triggerState.triggerCh = null
    layers.closeAll()
  },
  showPanel: (kind) => popovers.openDrawerFor(kind),
  /* —— 剪贴板五件住 `wiring/clipboard.ts`：多味载体与会话账的产地 —— */
  ...clipboard,

  // 结构动作落在中心编辑器上：焦点可能在一面镜像的岛里，而露面块在正文里
  insertEmbed: (at, targetId, view) => mainEd.insert.insertEmbedAfter(at, targetId, view),
  /** 改一次露面选的视图（看法住在源块的命名视图上，这里只动指针） */
  setEmbedView: (blockId, view) => {
    owners.setBindingView({ kind: 'embed', blockId }, view)
    return true
  },
  expandAtomToEmbed: (atomId, view) => mainEd.insert.expandAtomToEmbed(atomId, view),
  removeEmbed: (blockId) => {
    const ok = mainEd.insert.removeEmbed(blockId)
    // 焦点原本在那一面镜像里：它的宿主已经被摘掉，活动编辑器退回中心
    if (ok && ed !== mainEd && !ed.container.isConnected) ed = mainEd
    return ok
  },

  /* ---- 自动化（命令块）：core runner 管事务与原子性；这里收尾记账／重画／提示 ---- */
  ...automationCommands({
    kb,
    // 装配层 runTx：op 进落盘队列、撤销记账（一次运行＝一步撤销）、按 changes 重画
    tx: (fn) => runTx(fn),
    // 批量共用一个撤销条目（每块仍是独立事务，失败互不牵连）
    runGroup: (fn) => app.runGroup(fn, 'other'),
    repaintBlocks: (ids) => {
      for (const id of ids) repaintBlock(id)
    },
    openBlock: (id) => app.zoomTo(id),
    toast: (text, kind) => app.toast(text, kind),
  }),

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
      const backupKey = await backupBeforeReplace('ui.toast.resetBackupFailed')
      if (backupKey === false) return
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

  /**
   * **恢复空库**：清成「只有今天一行」，没有演示内容。
   *
   * 与 `resetWorkspace` 共用「先备份、失败就中止」这条前半段；差别在后半段：
   *   · 换的是 `blankWorkspace()`（今天 ＋ 一个空子块），不是演示种子；
   *   · **每库的视图状态一起回默认**（槽布局／日记栏／派生栏看法／折叠态）——
   *     它们跟着库走，而换库之后旧块 id 在新内容里不存在，留着只会指向空气。
   *   · 不补种子资产：空库里没有图可引用，补进来只是给下一次打开留一堆孤儿字节
   *     （代价登记：旧资产的**字节**没有删，只在库清空后变成不可达的孤儿；
   *      清理要走「导入／修复」那条入口，不在这个调试动作里顺手做）。
   */
  blankWorkspace: () => {
    void (async () => {
      const backupKey = await backupBeforeReplace('ui.toast.blankBackupFailed')
      if (backupKey === false) return
      // 换内容之前先把每库视图状态回默认：`swapWorkspace` 只清折叠态，槽与日记栏不会自己回去
      device.prefs.dock = normalizePrefs({}).dock
      device.prefs.journalMounts = []
      device.prefs.mountViews = {}
      // 只换内存：写入交给 forceReplaceNow（它才知道「这一次是整份替换」）
      swapWorkspace(blankWorkspace(), false)
      const r = await forceReplaceNow()
      if (!r.ok) {
        app.toast(t('ui.toast.blankFailed', { message: errText(r.error) }), 'warn')
        return
      }
      bootState.notice = null
      chrome.showNotice(null)
      scheduleDeviceSave()
      chrome.renderDebugState()
      app.toast(
        backupKey ? t('ui.toast.blankDone', { key: backupKey }) : t('ui.toast.blankDoneNoBackup'),
        backupKey ? 'ok' : 'warn',
      )
    })()
  },
}

/**
 * 显式重置的公共前半段：**先把在途写入落干净，再备份原始字节**。
 *
 * 顺序是判据的一部分：落盘有 250ms 防抖，队列里可能还有没发出去的编辑；
 * 不 flush 就备份，拿到的是一份「少了最后一句」的快照，而这次备份看起来还成功了。
 *
 * 返回 `false` ＝ 备份失败，调用方**必须中止**（不做没有备份的覆盖）；
 * `null` ＝ 这个后端没有备份能力（web 之外的宿主实现了它，不该静默当成成功）。
 */
async function backupBeforeReplace(failMsg: MsgId): Promise<string | null | false> {
  try {
    saveNow()
    await store.settle()
    return await store.backup()
  } catch (e) {
    app.toast(t(failMsg, { message: errText(e) }), 'warn')
    return false
  }
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
/* ------------------------------------------------------------ 编辑器装配 */

// ⚠️ 首屏就要把**当前页的 marks/atoms** 一起装进编辑器：少了它们，已存的行内原子
// 会被当成「未知原子」渲染成 dangling（持久化后重开最明显）。
ed = new BlockEditor({
  container: editorEl,
  // 工作集装载：触发链落点按名字复用未装载的目标（先装再落，不建重复身份）
  ensureLoaded: ensureDocsLoaded,
  // 引用角标的全库计数：派生表 ready 才查（未 ready 回 null ⇒ 退回工作集口径）
  relationsFor: async (ids) => {
    if (!libraryClient || !derivedReady) return null
    const r = await libraryClient.relations(ids)
    if (r.status !== 'ok') throw new Error(r.status === 'error' ? r.error : r.status)
    if (!r.value.ready) return null
    const map = new Map<string, RelationEdge[]>()
    for (const row of r.value.rows) {
      const list = map.get(row.to_id) ?? []
      list.push({
        from: row.from_id,
        to: row.to_id,
        kind: row.kind as RelationKind,
        ...(row.count !== null && row.count !== undefined ? { count: row.count } : {}),
      })
      map.set(row.to_id, list)
    }
    return map
  },
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
 * **启动时首窗之后还没读完的 Doc**：首帧已经画完才把它们续上。
 *
 * 启动路径与导航共用同一套窗口（`app/boot/doc-windows.ts`）：active 恰好是一篇
 * 巨大页时，首窗落地即可交互，余下的在后台长出来——启动不再停在「读完整篇」上。
 */
if (worksetBoot && worksetBoot.pending.length > 0 && libraryClient && workset) {
  const bootPending = worksetBoot.pending
  void (async () => {
    if (await finishDocWindows(libraryClient, workset, bootPending)) repaintAfterGrow()
  })()
}
/**
 * **这一屏的筛选**（顶栏那颗漏斗）：同一份判定/面板，喂给**大纲的行遍历**。
 * 装在主编辑器上，只此一家——里层编辑器（查询结果／挂载区／镜像）不吃这一层。
 */
outlineFilter = setupOutlineFilter({
  chrome: () => chrome,
  kb,
  activeId: () => ws.activeId,
  editor: () => mainEd,
  surfaceShown: () => surface.showing() !== null,
})
outlineFilter.install()
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

let panels: ReturnType<typeof setupPanels>

/**
 * 投影的任务完成态：一个注入点管所有表面（表格／大纲表格／卡片／日历／导图）。
 * 字段表随写作废、懒重建，见 `app/wiring/closure-stamp.ts`。
 */
const stampClosure = createClosureStamp(blocks)

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

/**
 * 侧槽的重画同样**去抖**：正文每敲一个字都会 `change`，而槽里的卡（检视、反链、
 * 快捷标题）只有「名字/成员变了」才需要重画。每次通知都整叠重排两个槽，在长文档上
 * 是每键十几毫秒的主要来源——60ms 与属性面板、tab 标题同档，用户看不出来。
 */
let docksTimer: number | null = null
function scheduleDocks(): void {
  if (docksTimer !== null) window.clearTimeout(docksTimer)
  docksTimer = window.setTimeout(() => {
    docksTimer = null
    renderDocks()
  }, 60)
}

ed.events = viewEvents(
  () => mainEd,
  (kind) => {
    const t0 = performance.now()
    syncSections()
    scheduleSave()
    chrome.renderEmptyHint(activeBlock().children)
    const t1 = performance.now()
    scheduleDocks() // 块数/名字变了要更新（去抖：不在每键的通知里整叠重排）
    const t2 = performance.now()
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
    // 诊断计数器（探针读；产品逻辑不读）：回答「每键的通知回调里侧槽占多少」
    mainEd.perfProbe.changeCalls++
    mainEd.perfProbe.changeMs += performance.now() - t0
    mainEd.perfProbe.docksMs += t2 - t1
  },
  'editor',
  // 正文这一台把查询结果画在自己行下；里层编辑器（`wireViewEditor`）默认不挂
  true,
)
// 启动时的第一张 tab ＝ 已经装载好的这一屏；tab 条从这里开始画
initTabs()
/**
 * **⌥-click 被备注的文本 ⇒ 就地浮窗**（⌥＝「这一处的东西展开一层」，与引用的
 * 「⌥ 看详情」同族）。边由 annoId 反查备注块；写作面与创建同一条——浮窗，
 * 「在侧栏打开」是浮窗上的显式跳板，不是这里的默认落点。
 */
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


let diag: ReturnType<typeof setupDiagnostics>
const {
  renderMounts,
  createDockMountArea,
  renderProperties,
  scheduleProperties,
  pickRefValue,
  pickChoiceValue,
  pickTagValue,
  tagLabel,
  openPropertiesDrawer,
  openBlockConfig,
  mountBlockView,
  mountEmbedView,
  viewShown,
  propDeps,
  createRefPeekArea,
  activateRefsFor,
  recordRecentColor,
} = setupPanels({
  blocks,
  kb,
  app,
  layers,
  owners,
  loadCandidateWindow,
  /**
   * **派生栏的候选装载**（反链/备注/成员/同类/提及/谁在用）：与查询视图同一条管道。
   * 读库归这里（装配层），视图只报「哪一格的哪个来源」。
   */
  ensureDerivedLoaded: (host, source, withChildren) =>
    ensureDerivedLoaded({ client: libraryClient, workset, store: blocks }, host, source, withChildren),
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
  project: (b, into) => {
    fillBlockText(into, b, (id) => blocks.find(id), assetViewOf, markAssetMissing)
    // 投影也要看得出「关闭了」：判据与大纲同一份（`closureOf`），住在装配层的唯一投影入口
    stampClosure(b, into)
  },
  atomClick: (atom, el, mods) => popovers.handleAtomClick(atom, el, mods, 'table'),
  // 挂载区/查询结果接的是**同一份**事件表（差别只在「装载谁」）
  wireEditor: (editor, change, via, inlineViewBodies) => wireViewEditor(editor, change, via, inlineViewBodies),
  getWs: () => ws,
  getEd: () => ed,
  setEd: (next) => {
    ed = next
  },
  getMainEd: () => mainEd,
  getRegistry: () => registry,
  writeBlock: writeProps,
  repaintBlock,
  getChrome: () => chrome,
  openBlock: (blockId, place) => app.openBlock(blockId, place),
})
panels = {
  renderMounts,
  createDockMountArea,
  renderProperties,
  scheduleProperties,
  pickRefValue,
  pickChoiceValue,
  pickTagValue,
  tagLabel,
  openPropertiesDrawer,
  openBlockConfig,
  mountBlockView,
  mountEmbedView,
  viewShown,
  propDeps,
  createRefPeekArea,
  activateRefsFor,
  recordRecentColor,
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
  pickChoice: pickChoiceValue,
  pickAsset: (onPick) => app.pickAssetValue(onPick),
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
  //
  // 「在不在里面」按**按下那一刻的路径**判，不按 target 现查：
  // 编辑器自己的 mousedown 会当场重排 DOM（折叠三角、导轨——按下即重画整屏），
  // 正被按的那一行在事件还在冒泡时就已经换成了新 DOM。此刻 target 是**游离节点**，
  // 对它判 contains 恒为 false ⇒「按在浮层里」被误判成「点到了外面」，浮层当场关闭。
  // composedPath 在派发那一刻就定死，不随中途换 DOM 变。
  for (const node of e.composedPath()) {
    if (node instanceof Node && layers.popoverContains(node)) return
  }
  if ((target as HTMLElement).closest?.('.atom')) return
  // 按在触发元素上不算「点到外面」：同触发器再点一次＝toggle，判据在 `openPopover`
  if (layers.popoverTriggerContains(target)) return
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
  else panels.openBlockConfig(blockId, { anchor: action })
})

window.addEventListener('beforeunload', () => {
  saveNow()
  saveDeviceNow()
})

/* ------------------------------------------------------------ 启动 */

registry = new Registry(
  app,
  HANDLERS,
  // dev.* 的声明与处理器都在各自文件里按编译期判据分叉（见 handlers.ts 与
  // decls.ts 的注释）：产品构建里 ALL_COMMANDS 就是基表、dev 处理器被摇出
  // 产物——这里只管把装配面那一份交出去，不再自己过滤一遍。
  ALL_COMMANDS,
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
  stateMenuBtn.dataset.tip = t('ui.debug.title')
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
  addUtility,
  addShortcut,
  removeShortcut,
  retargetShortcut,
  collapseToShortcut,
  restoreWindow,
  toggleFoldAll,
  closeOtherWindows,
  closeAllWindows,
  createTrayFromTile,
  collectRestIntoTray,
  dissolveTray,
  removeTrayWithCards,
  startTrayRename,
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
  collapseLabel: t('ui.dock.toggleLeft'),
  foldAllLabel: t('ui.dock.foldAll'),
  resizeLabel: t('ui.dock.resize'),
  onAdd: (add) => menus.showWidgetGallery('left', add),
  onCollapse: () => registry.invoke('core.dock/toggle-left', {}, 'dock'),
  onFoldAll: () => toggleFoldAll('left'),
})
const dockRight = mountDockSlot($('dock-right'), {
  side: 'right',
  title: t('ui.dock.rightTitle'),
  addLabel: t('ui.dock.addTile'),
  collapseLabel: t('ui.dock.toggleRight'),
  foldAllLabel: t('ui.dock.foldAll'),
  resizeLabel: t('ui.dock.resize'),
  onAdd: (add) => menus.showWidgetGallery('right', add),
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
  store,
  kb,
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
installTooltips()
applyChrome()
chrome.renderDebugState()
renderDocks()
// 常驻窗口卡：首帧只按 id 拿到块（裸块）时先补子树，装完重画一次卡身
{
  const ids = dockWindowIds(device)
  if (ids.length > 0) ensureDocsLoaded(ids, () => renderDocks())
}
chrome.renderTitle(activeBlock(), activeTrail())
chrome.renderEmptyHint(activeBlock().children)
if (prefs().virtualize) mainEd.setVirtualize(true, prefs().radius)
if (prefs().badgeOpen) badge.toggle(true)
badge.update()

/* ------------------------------------------------- 日记流下滚加载（wiring/feed） */

/**
 * **日记流下滚的取天**：窗口宽度 `limit`、已装载的不重复给，返回降序的天块。
 * 「哪几天存在」由 catalog/索引的日期表回答（全库），未装载的经 `ensureDocsLoaded`
 * 装进来再交编辑器——工作集模式下滚动装载的不是「内存里碰巧有的天」。
 */
async function loadOlderFeedDays(limit: number, loaded: ReadonlySet<string>): Promise<Block[]> {
  const ids = kb
    .journalDates()
    .filter((dt) => dt <= todayISO())
    .slice(-limit)
    .reverse()
    .map(journalId)
    .filter((id) => !loaded.has(id))
  if (ids.length === 0) return []
  return await new Promise<Block[]>((resolve) => {
    ensureDocsLoaded(ids, () => {
      resolve(ids.map((id) => kb.get(id)).filter((b): b is Block => b !== undefined))
    })
  })
}

setupFeed({
  blankAreaEl: chrome.blankAreaEl,
  markBooted,
  getMainEd: () => mainEd,
  activeBlock,
  loadOlder: loadOlderFeedDays,
  materialize: materializeEditableRoots,
})
