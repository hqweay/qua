/**
 * Electron 主进程。
 *
 * 承****：主进程**不含业务逻辑**。它只做五件壳的事：
 *   ① 定名字与数据目录（`net.leay.qua` / 六个子目录）
 *   ② 建窗口（含尺寸/位置记忆）
 *   ③ 装 macOS 规范的中文应用菜单
 *   ④ 生命周期（`whenReady` / `activate` / `window-all-closed`）
 *   ⑤ 给内核留一条 MessageChannel 端口通道（`attachKernel`：内核进程与渲染进程的握手入口）
 *
 * 编辑器、命令表、绑定表、localStorage 持久化**全在 renderer（`../src/`）里**，
 * 这个文件一行都不碰它们——它连 `src/` 里的任何东西都没 import。
 */
import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
// 文案字典与 renderer **共用同一份**（`src/core/msg.ts` 是零依赖叶子）。菜单是用户可见文案，
// 所以连「相」都走 t('app.name')，不在这里硬编码。
import { t } from '../src/core/infra/msg'
import { ASSET_SCHEME, isAssetHash } from '../src/core/infra/assets.ts'
import { MANIFEST_FILE, libraryId } from '../src/core/identity/library.ts'
import { loadRegistry } from './library/registry.ts'
import type { OpenFailure } from './library/session.ts'
import { LibraryManager } from './library/windows.ts'

/**
 * 资产协议必须在 `app.ready` **之前**登记特权（登记晚了不生效，且没有报错）。
 *
 * `stream: true`：大图靠流式读取，不把整份字节先读进主进程内存。
 * `secure: true`：它和 `https:` 同级 —— 页面是 `file://`/`localhost` 的安全上下文，
 * 一条非 secure 的自定义协议会被混合内容规则拦掉。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** dev：脚本 `scripts/dev.mjs` 把 vite 的地址塞进来；prod：加载 `dist/index.html` */
const DEV_URL = process.env.KB_DEV_SERVER_URL ?? null

/* ------------------------------------------------------------ 名字与数据目录 */

/** 中文显示名（菜单、About 面板、`.app` 名）—— 走字典，不硬编码 */
const APP_NAME = t('app.name')
/** 英文名：`app.setName()` 用这个（**不进任何文件路径**） */
const APP_SLUG = 'qua'
/** 与 `package.json` 的 `build.appId` **必须一致**；数据目录名用它（全英文，无连字符） */
const APP_ID = 'net.leay.qua'

// ⚠️ 必须在任何 `getPath('userData')` 之前调用
app.setName(APP_SLUG)
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })

/**
 * ⚠️ **必须显式指定 userData**：Electron 默认拿 `productName` 当目录名，
 * 而我们的 `productName` 是中文「相」⇒ 不管的话数据会落在
 * `~/Library/Application Support/相/`（**中文路径**：脚本、日志、备份工具到处是坑）。
 *
 * 例外：命令行显式给了 `--user-data-dir=` 就不覆盖——这是**用户/自检脚本的显式选择**，
 * 壳不该把它悄悄改回去（`checks/electron-smoke.mjs` 就靠它把数据关在仓内，
 * 因为本仓沙箱不允许写 `$HOME/Library/Application Support`）。
 */
const argvUserDataDir = process.argv.find((a) => a.startsWith('--user-data-dir='))
const USER_DATA = argvUserDataDir
  ? argvUserDataDir.slice('--user-data-dir='.length)
  : join(app.getPath('appData'), APP_ID)

app.setPath('userData', USER_DATA)
// 打出来：排障时第一个要问的就是「数据到底落在哪」（也方便自检脚本核对）
console.log(`[shell] userData = ${USER_DATA}${argvUserDataDir ? '（命令行 --user-data-dir 覆盖）' : ''}`)

/** 数据目录布局（承上级定的形状，全英文小写）；`logs` 之外 v1 只占位，见目录内 README */
const DATA_DIRS = ['kb', 'logs', 'cache', 'plugins', 'backups', 'tmp'] as const

// ⚠️ 建目录失败**不能让 app 起不来**（只读盘、权限异常、沙箱……）：能用的功能照样用，
// 只是没有持久化。所以这里是 warn 而不是 throw —— 起不来比存不下严重得多。
try {
  for (const d of DATA_DIRS) mkdirSync(join(USER_DATA, d), { recursive: true })
  // 日志与崩溃转储收进数据目录（默认散在 ~/Library/Logs 下，和「一个目录装走全部状态」冲突）
  app.setPath('logs', join(USER_DATA, 'logs'))
  app.setPath('crashDumps', join(USER_DATA, 'logs', 'crashes'))
} catch (e) {
  console.warn(`[shell] 数据目录建不出来（继续跑，本次不会有持久化）：${USER_DATA} — ${e instanceof Error ? e.message : String(e)}`)
}

// 目录用途说明：**只在缺失时写**，绝不覆盖用户改过的内容
for (const rel of ['README.md', 'kb/README.md']) {
  const dest = join(USER_DATA, rel)
  if (existsSync(dest)) continue
  try {
    writeFileSync(dest, readFileSync(join(app.getAppPath(), 'electron', 'userdata', rel), 'utf8'))
  } catch (e) {
    console.warn(`[shell] 数据目录说明写不进去（不影响使用）：${rel} — ${e instanceof Error ? e.message : String(e)}`)
  }
}

/* ------------------------------------------------------------ 窗口尺寸/位置记忆 */

interface WinState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

const DEFAULT_STATE: WinState = { width: 1180, height: 820 }

const statePath = (): string => join(USER_DATA, 'window-state.json')

function readState(): WinState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as Partial<WinState>
    if (typeof raw?.width !== 'number' || typeof raw?.height !== 'number') return DEFAULT_STATE
    // 只挡住明显荒谬的值；**不在这里做「窗口是否还在某块屏上」的智能判断**（多屏拔线场景留给后续）
    return {
      x: typeof raw.x === 'number' ? raw.x : undefined,
      y: typeof raw.y === 'number' ? raw.y : undefined,
      width: Math.max(720, Math.round(raw.width)),
      height: Math.max(480, Math.round(raw.height)),
      maximized: raw.maximized === true,
    }
  } catch {
    return DEFAULT_STATE // 首次启动 / 文件坏了：都不是错误
  }
}

let stateTimer: NodeJS.Timeout | null = null

function scheduleWriteState(win: BrowserWindow): void {
  if (stateTimer) clearTimeout(stateTimer)
  stateTimer = setTimeout(() => {
    stateTimer = null
    if (win.isDestroyed()) return
    const b = win.getNormalBounds() // 最大化/全屏时记的是「还原后」的尺寸，不是屏幕尺寸
    const next: WinState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: win.isMaximized(),
    }
    try {
      writeFileSync(statePath(), JSON.stringify(next, null, 2))
    } catch (e) {
      console.warn('[shell] 窗口状态写盘失败（不影响使用）', e)
    }
  }, 400)
}

/* ------------------------------------------------------------ 内核端口骨架（attachKernel 的握手通道） */

/**
 * 形状定死：**主进程只做 port 中转，不含业务**。三方拓扑：
 *
 * ```
 *   内核进程（将来 = utilityProcess.fork）        主进程                渲染进程 / preload
 *        port1  ──── adopt ────▶   本文件持有   ──── postMessage ────▶   port2
 *        ▲                                                              │
 *        └──────────────── 用户事务 / 查询走这条 port ──────────────────┘
 * ```
 *
 * **接内核的唯一改动点**：把下面 `attachKernel` 里标了 `TODO(kernel)` 的那段换成注释里写的样子，
 * 然后删掉那段 `stub` 回声。renderer 侧（`preload.ts` 的 `kb.kernel.attach()`）**一行都不用改**。
 */
let kernelPort: Electron.MessagePortMain | null = null

function attachKernel(renderer: WebContents): void {
  const { port1, port2 } = new MessageChannelMain()

  // 一次只留一条内核通道：重连时显式关掉旧的，避免「僵尸端口」上还挂着监听器
  kernelPort?.close()
  kernelPort = port1

  // TODO(kernel) 将来在这里 fork 内核进程，并把 port1 交给它：
  //   const kernel = utilityProcess.fork(join(__dirname, 'kernel.cjs'), [], { serviceName: 'kb-kernel' })
  //   kernel.postMessage({ type: 'kb/kernel/adopt' }, [port1])   // port1 转移给内核进程，主进程随即失去它
  //   kernelPort = null                                          // 主进程此后**只转发、不解释**
  // 现在还没有内核 ⇒ port1 留在主进程里，只做一个**明标 stub 的回声**，好让这条通道当场可验证。
  port1.on('message', (e) => {
    const data = e.data as { id?: unknown; type?: unknown }
    port1.postMessage({
      id: data?.id ?? null,
      type: `${String(data?.type ?? '?')}/stub-echo`,
      stub: true,
      echoedBy: 'main(no-kernel)',
    })
  })
  port1.start()

  // 发给 renderer。第三参数是**转移列表**：port2 转过去之后主进程这一端就不再持有它。
  renderer.postMessage('kb:kernel/port', null, [port2])
}

ipcMain.on('kb:kernel/attach', (e) => {
  attachKernel(e.sender)
})

/* ------------------------------------------------------------ 壳信息（不是业务：只是版本/平台/路径） */

ipcMain.handle('kb:shell/info', () => ({
  name: APP_NAME,
  slug: APP_SLUG,
  appId: APP_ID,
  appVersion: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  v8: process.versions.v8,
  platform: process.platform,
  arch: process.arch,
  isDev: Boolean(DEV_URL),
  /** 让自检/排障能**一眼看到数据到底落在哪**（本项是「不许出现中文路径」的直接证据） */
  userData: app.getPath('userData'),
  logs: app.getPath('logs'),
  locale: app.getLocale(),
  dataDirs: DATA_DIRS,
}))

/* ------------------------------------------------------------ 窗口 */

/**
 * 库根：`~/Documents/Qua/`。测试用 `--qua-data-dir=` 覆盖，
 * 与 `--user-data-dir=` **分开**——后者是 Electron 的 app 数据（缓存/日志），
 * 前者是**用户的库**。混成一个的话自检脚本会把测试库写进用户文档目录。
 *
 * ⚠️ **但给了 `--user-data-dir=` 时，库根必须跟着它走**（除非显式再给 `--qua-data-dir=`）。
 *    理由：`--user-data-dir` 是「这次运行与用户的真实数据隔离」的显式声明（自检脚本全靠它），
 *    而库根是**用户数据里最重要的那一份**。不跟着走的话，跑一次冒烟就会在
 *    `~/Documents/Qua` 里建出库来——实测真踩到过（第一次接多库时把测试库写进了用户文档目录）。
 */
const argvDataDir = process.argv.find((a) => a.startsWith('--qua-data-dir='))
const QUA_DATA_ROOT = argvDataDir
  ? argvDataDir.slice('--qua-data-dir='.length)
  : argvUserDataDir
    ? join(USER_DATA, 'qua-data')
    : join(app.getPath('documents'), 'Qua')
console.log(
  `[shell] qua data root = ${QUA_DATA_ROOT}` +
    `${argvDataDir ? '（命令行 --qua-data-dir 覆盖）' : argvUserDataDir ? '（跟随 --user-data-dir，与用户库隔离）' : ''}`,
)

const REGISTRY_IO = { file: join(QUA_DATA_ROOT, 'app.json'), reposDir: join(QUA_DATA_ROOT, 'repos') }

/**
 * **隔离模式**：命令行显式给了数据目录（`--user-data-dir`／`--qua-data-dir`）。
 * 自检脚本全靠它把测试库关在与用户数据隔离的地方——这类运行**必须无人值守**，
 * 首次启动不弹「选库」对话框（原生对话框会挂死冒烟），保持「自动建默认库」的旧路径。
 */
const ISOLATED = argvUserDataDir !== undefined || argvDataDir !== undefined

// 无库时的兜底窗口：`bootLibraries()` 总会开一个库，这个变量留给「将来加欢迎页」

/**
 * 建一扇库窗口。`libraryId` 交给 renderer 走 `qua.libraryInfo()` 取（不从 URL 传：
 * URL 会被用户/插件看见，而库身份该由主进程按 sender 路由）。
 */
function createWindow(_libraryId?: string, title?: string): BrowserWindow {
  const st = readState()

  /**
   * 系统标题栏交给网页顶栏接管。
   *
   * · macOS：`hidden` 只撤掉那条标题栏，红黄绿仍是**原生控件**浮在内容左上角；
   *   `trafficLightPosition` 把它按到我们 42px 顶栏的竖中线上。不用 `frame: false`
   *   加自绘按钮：那会丢掉原生的最大化/全屏语义与无障碍，还要自己处理悬停态。
   * · 其它平台：`hidden` 会连最小化/最大化/关闭一起去掉 ⇒ 必须用
   *   `titleBarOverlay` 把它们找回来，高度与网页顶栏同高；右侧安全区由 CSS 让出。
   */
  const windowChrome =
    process.platform === 'darwin'
      ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 12, y: 15 } }
      : { titleBarStyle: 'hidden' as const, titleBarOverlay: { height: 42 } }

  const w = new BrowserWindow({
    ...windowChrome,
    /**
     * ⚠️ **`width/height` 是内容区尺寸，而 `getNormalBounds()` 返回整窗尺寸**。
     *    有系统标题栏时两者差一条标题栏（macOS 曾实测 23px）：落盘用后者、
     *    建窗给前者 ⇒ 每重启一次高度就少一条（看起来像「窗口记不住大小」）。
     *    标题栏隐藏后 macOS 上两者相等，但**校正仍要留**：它保证读与写
     *    永远说同一套坐标，将来平台或标题栏样式再换也不会漂。
     * ⇒ 建完窗立刻用 `setBounds` 校正成**整窗**口径。
     */
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 720,
    minHeight: 480,
    title: title ?? APP_NAME,
    show: false,
    // 窗口底色：**主进程拿不到 CSS token**，只能在这里给。跟随系统外观 ⇒ 暗色系统上
    // 不会先闪一帧白（首帧前的底色由 shell 决定，首帧之后由 styles.css 的 color-scheme 接管）。
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // —— 壳安全三件套：默认值也对，但**显式写出来**，改的人必须是有意的 ——
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true,
    },
  })

  /**
   * **把尺寸校正成整窗口径**（与 `getNormalBounds()` 同一套坐标）。
   *
   * 构造参数里的 `width/height` 是**内容区**，而 `getNormalBounds()` 是**整窗** ——
   * 有标题栏时不校正就是「写下去 700、读回来 677」，每重启少一条（macOS 曾实测 23px）。
   * 现在标题栏隐藏了，两者在 macOS 上相等，这条仍是**口径保证**而非补偿量。
   * ⚠️ `setBounds` 是整体替换：位置也要一起给，否则会被重置。
   */
  const b0 = w.getBounds()
  w.setBounds({
    x: typeof st.x === 'number' ? st.x : b0.x,
    y: typeof st.y === 'number' ? st.y : b0.y,
    width: st.width,
    height: st.height,
  })

  if (DEV_URL) {
    void w.loadURL(DEV_URL)
    w.webContents.openDevTools({ mode: 'detach' })
  } else {
    void w.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  }

  // 「先藏后显」：等首帧画完再显示，避免白屏一闪。
  //
  // ⚠️ 但**只挂 `ready-to-show` 是不够的**：实测在拿不到真实 window server 的环境里
  // （本仓沙箱就是：GPU 进程起不来、窗口始终 `isVisible() === false`），
  // `ready-to-show` **一次都不触发** ⇒ 窗口永远不显示，而 `minimize()` 之类的角色动作
  // 也会因为「窗口不可见」静默失效。所以补一条**定时兜底**，并把走的是哪条路打出来。
  let shown = false
  const showWindow = (why: string): void => {
    if (shown || w.isDestroyed()) return
    shown = true
    if (st.maximized) w.maximize()
    w.show()
    if (why !== 'ready-to-show') console.warn(`[shell] 窗口靠兜底显示（${why}）：ready-to-show 没来`)
  }
  w.once('ready-to-show', () => showWindow('ready-to-show'))
  // 这个标签只进 console.warn（开发者日志），所以用 ASCII —— 别让它变成「用户文案」的漏网之鱼
  const showFallback = setTimeout(() => showWindow('2s-fallback'), 2000)
  w.on('closed', () => clearTimeout(showFallback))

  w.on('resize', () => scheduleWriteState(w))
  w.on('move', () => scheduleWriteState(w))
  w.on('close', () => {
    if (stateTimer) clearTimeout(stateTimer)
    scheduleWriteState(w)
  })

  // —— 壳级硬化：这个 app 只有**一个**页面，任何导航/开新窗都不是它该做的事 ——
  w.webContents.setWindowOpenHandler(({ url }) => {
    // 外链交给系统浏览器，绝不在 app 里开新窗（否则就是一个没有菜单的裸 Chromium）
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  w.webContents.on('will-navigate', (e, url) => {
    const devOk = DEV_URL && url.startsWith(DEV_URL)
    const fileOk = !DEV_URL && url.startsWith('file://')
    if (!devOk && !fileOk) {
      e.preventDefault()
      if (/^https?:/.test(url)) void shell.openExternal(url)
    }
  })

  // 之外再给一个「不依赖菜单」的 devtools 开关（菜单里也有 role=toggleDevTools）
  w.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') w.webContents.toggleDevTools()
  })

  return w
}

/* ------------------------------------------------------------ 应用菜单（中文，macOS 规范） */

function buildMenu(): Menu {
  /** 只有 dev 才出现的条目：打包后不该有人靠 ⌘R / ⌥⌘I 进来 */
  const devItems: MenuItemConstructorOptions[] = DEV_URL
    ? [
        {
          label: t('menu.bar.view'),
          submenu: [
            { role: 'reload', label: t('menu.item.reload') },
            { role: 'forceReload', label: t('menu.item.forceReload') },
            { role: 'toggleDevTools', label: t('menu.item.devTools') },
            { type: 'separator' },
            { role: 'resetZoom', label: t('menu.item.actualSize') },
            { role: 'zoomIn', label: t('menu.item.zoomIn') },
            { role: 'zoomOut', label: t('menu.item.zoomOut') },
            { type: 'separator' },
            { role: 'togglefullscreen', label: t('menu.item.fullscreen') },
          ],
        },
      ]
    : [
        {
          label: t('menu.bar.view'),
          submenu: [
            { role: 'resetZoom', label: t('menu.item.actualSize') },
            { role: 'zoomIn', label: t('menu.item.zoomIn') },
            { role: 'zoomOut', label: t('menu.item.zoomOut') },
            { type: 'separator' },
            { role: 'togglefullscreen', label: t('menu.item.fullscreen') },
          ],
        },
      ]

  const template: MenuItemConstructorOptions[] = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: t('menu.item.about', { app: APP_NAME }) },
        { type: 'separator' },
        { role: 'services', label: t('menu.item.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.item.hide', { app: APP_NAME }) },
        { role: 'hideOthers', label: t('menu.item.hideOthers') },
        { role: 'unhide', label: t('menu.item.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.item.quit', { app: APP_NAME }) },
      ],
    },
    {
      // 这是个只有「关闭窗口」的文档型应用：⌘W 必须有归宿（macOS 惯例在「文件」里）
      label: t('menu.bar.file'),
      submenu: [{ role: 'close', label: t('menu.item.closeWindow') }],
    },
    {
      /**
       * 库的入口：一库一窗（切库＝开另一扇窗／聚焦已有），所以这里只有壳的动作
       * ——开库与建库，没有「在当前窗口换内容」这种语义可给。
       * 「最近的库」是**构建时快照**：注册表一变就得重建整份菜单（见 manager 的 onRegistryChanged）。
       */
      label: t('menu.bar.library'),
      submenu: [
        {
          id: 'library-recent',
          label: t('menu.item.recentLibraries'),
          submenu: loadRegistry(REGISTRY_IO).registry.libraries.map((l) => ({
            id: `library-open-${l.id}`,
            label: l.name,
            click: () => {
              const r = manager.open(l.id)
              if (r.status === 'failed') console.warn('[library] menu open failed', r.failure)
            },
          })),
        },
        { type: 'separator' },
        {
          id: 'library-open',
          label: t('menu.item.openLibrary'),
          accelerator: 'CommandOrControl+O',
          click: () => {
            void promptOpenLibrary().then((r) => {
              if (r.status === 'failed') failBox(r.failure)
            })
          },
        },
        {
          id: 'library-new',
          label: t('menu.item.newLibrary'),
          // 键位住在菜单数据里（与 renderer 的键位表同一条纪律：不写在 handler 的按键分支上）。
          // 「最近的库」挂不了键：菜单加速键只能落在可点击的条目上，子菜单项会被忽略。
          accelerator: 'CommandOrControl+Shift+N',
          click: () => {
            void promptCreateLibrary().then((r) => {
              if (r.status === 'failed') failBox(r.failure)
            })
          },
        },
      ],
    },
    {
      label: t('menu.bar.edit'),
      submenu: [
        // ⚠️ **不放 `{ role: 'undo' }` / `{ role: 'redo' }`**：
        //    macOS 的快捷键是 NSMenu 先于 web contents 处理的，留着 role 就等于让 ⌘Z 走原生文本撤销栈，
        //    而那个栈不懂块结构（拆块/缩进/原子都会被打散）。⌘Z / ⇧⌘Z 现在由 renderer 的
        //    绑定表 → `core.history/undo|redo` → `view.ts` 的模型快照栈接管。
        //    代价（诚实登记）：菜单栏「编辑」里不再显示撤销/重做两项。
        { role: 'cut', label: t('menu.item.cut') },
        { role: 'copy', label: t('menu.item.copy') },
        { role: 'paste', label: t('menu.item.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.item.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.item.delete') },
        { role: 'selectAll', label: t('menu.item.selectAll') },
      ],
    },
    ...devItems,
    {
      label: t('menu.bar.window'),
      submenu: [
        { role: 'minimize', label: t('menu.item.minimize') },
        { role: 'zoom', label: t('menu.item.zoom') },
        { type: 'separator' },
        { role: 'front', label: t('menu.item.front') },
      ],
    },
  ]

  return Menu.buildFromTemplate(template)
}

/* ------------------------------------------------------------ 生命周期 */

/**
 * 库管理器：一库一窗、会话、IPC 路由。
 *
 * 为什么在 `whenReady` 之前建：`installIpc()` 必须在任何窗口加载之前装好
 * （renderer 一加载就会问 `qua:library/info`）。
 */
const manager = new LibraryManager({
  io: REGISTRY_IO,
  createWindow: (libraryId, title) => createWindow(libraryId, title),
  readBounds: readState,
  writeBounds: (w) => scheduleWriteState(w),
  /**
   * 注册表一变就重建菜单：「最近的库」是构建时快照，不重建就永远停在启动那一刻。
   * ⚠️ 延一拍再重建——重建可能发生在菜单条目的 click 处理里，当场换掉 NSMenu 不安全。
   */
  onRegistryChanged: () => setTimeout(() => Menu.setApplicationMenu(buildMenu()), 0),
})

manager.installIpc()

/* ------------------------------------------------------------ 选库（首次启动 / 菜单） */

/** 打开/建库失败都弹这一句：给原因，不给「什么都没发生」 */
function failureText(f: OpenFailure): string {
  switch (f.reason) {
    case 'not-a-library':
      return t('library.fail.notALibrary')
    case 'bad-manifest':
      return t('library.fail.badManifest')
    case 'identity-conflict':
      return t('library.fail.identityConflict')
    case 'too-new':
      return t('library.fail.tooNew', { version: String(f.version) })
    case 'corrupt':
      return t('library.fail.corrupt')
    case 'migrate-failed':
      return t('library.fail.migrateFailed', { detail: f.detail })
    case 'io':
      return t('library.fail.io', { detail: f.detail })
  }
}

function failBox(f: OpenFailure): void {
  void dialog.showMessageBox({ type: 'error', title: APP_NAME, message: failureText(f) })
}

type PickResult = { status: 'ok' } | { status: 'canceled' } | { status: 'failed'; failure: OpenFailure }

/**
 * 新建库：**保存对话框一次给齐「位置 ＋ 名字」**，返回的路径就是库目录。
 * （设计稿是「选父目录 → 建子目录」；保存对话框是同一件事的原生形状，还自带名字输入。）
 * 选中的位置已经是一个库 ⇒ 幂等：打开它，不建第二份。
 */
async function promptCreateLibrary(): Promise<PickResult> {
  const r = await dialog.showSaveDialog({
    title: t('library.pick.newTitle'),
    defaultPath: join(QUA_DATA_ROOT, t('library.defaultName')),
    nameFieldLabel: t('library.pick.nameLabel'),
    buttonLabel: t('library.pick.createButton'),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  })
  if (r.canceled || !r.filePath) return { status: 'canceled' }
  const dir = r.filePath
  if (existsSync(join(dir, MANIFEST_FILE))) {
    const opened = manager.openAt(dir)
    return opened.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: opened.failure }
  }
  const created = manager.create(libraryId(), basename(dir), dir)
  return created.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: created.failure }
}

/** 打开已有库：选目录 → 主进程按 manifest 判身份（不是库／副本／过新都在那一层拒绝） */
async function promptOpenLibrary(): Promise<PickResult> {
  const r = await dialog.showOpenDialog({
    title: t('library.pick.openTitle'),
    buttonLabel: t('library.pick.openButton'),
    properties: ['openDirectory'],
  })
  if (r.canceled || r.filePaths.length === 0) return { status: 'canceled' }
  const opened = manager.openAt(r.filePaths[0]!)
  return opened.status === 'ok' ? { status: 'ok' } : { status: 'failed', failure: opened.failure }
}

/**
 * **首次启动选库**（注册表里一个库都没有）：新建，或打开已有的库文件夹。
 *
 * 为什么是原生对话框而不是欢迎页：库还没建出来之前**没有渲染面可挂**——
 * 欢迎页是一整块独立 UI（P4-D 的活），而「选个文件夹」原生对话框就是全部所需。
 * 选完之前不开任何库窗口；用户取消到退出为止，绝不悄悄往文档目录撒一个默认库。
 * 失败（不是库／副本／过新）说清原因后回到选择——循环的出口只有「开成了」和「退出」。
 */
async function chooseFirstLibrary(): Promise<void> {
  for (;;) {
    const pick = await dialog.showMessageBox({
      type: 'question',
      message: t('library.firstRun.message'),
      detail: t('library.firstRun.detail'),
      buttons: [t('library.firstRun.new'), t('library.firstRun.open'), t('library.firstRun.quit')],
      defaultId: 0,
      cancelId: 2,
    })
    if (pick.response === 2) {
      app.quit()
      return
    }
    const r = pick.response === 0 ? await promptCreateLibrary() : await promptOpenLibrary()
    if (r.status === 'ok') return
    if (r.status === 'canceled') continue
    failBox(r.failure)
  }
}

/**
 * `qua-asset://<hash>` → 那份字节。
 *
 * 这一小段是整个资产方案里**唯一**需要「字节从哪来」的地方：渲染层只写一个字符串，
 * 其余全在这里。于是「取字节 → 建对象 URL → 什么时候回收」这套生命周期不存在了。
 *
 * - 地址就是内容，所以它可以 **immutable 缓存**：同一个 hash 永远同一份字节。
 * - 找不到 ⇒ 404。渲染层据此把那枚原子标成 `missing`（不是空白，也不是崩溃）。
 */
async function serveAsset(request: Request): Promise<Response> {
  const hash = new URL(request.url).hostname
  if (!isAssetHash(hash)) return new Response(null, { status: 400 })
  const hit = manager.assetFileOf(hash)
  if (!hit) return new Response(null, { status: 404 })
  try {
    const file = await net.fetch(pathToFileURL(hit.path).toString())
    if (!file.ok) return new Response(null, { status: 404 })
    return new Response(file.body, {
      status: 200,
      headers: { 'content-type': hit.mime, 'cache-control': 'public, max-age=31536000, immutable' },
    })
  } catch {
    // 文件被删 / 没有权限：对渲染层就是「这份资产不在了」，不是壳坏了
    return new Response(null, { status: 404 })
  }
}

/**
 * 启动落点：`lastOpenedId` 能开就开它；否则开列表里第一个库；
 * 一个库都没有时——隔离模式自动建默认库，**真实用户给选择**（新建 / 打开已有）。
 *
 * 为什么隔离模式不同：`--user-data-dir`／`--qua-data-dir` 是「与用户数据隔离」的显式声明
 * （自检脚本全靠它），这类运行必须无人值守——原生对话框会挂死冒烟（E11 钉着这条自动建库路径）。
 * 真实用户的第一次启动**不再悄悄建库**：库落在哪是用户要拍板的事。
 */
function bootLibraries(): void {
  const loaded = loadRegistry(REGISTRY_IO)
  const last = loaded.registry.lastOpenedId
  if (last) {
    const r = manager.open(last)
    if (r.status === 'ok') return
    console.warn('[library] lastOpenedId failed to open, falling back', r.failure)
  }
  const first = loaded.registry.libraries[0]
  if (first) {
    const r = manager.open(first.id)
    if (r.status === 'ok') return
    console.warn('[library] first library failed to open', r.failure)
  }
  if (ISOLATED) {
    const id = libraryId()
    const r = manager.create(id, t('library.defaultName'))
    if (r.status === 'failed') console.error('[library] failed to create default library', r.failure)
    return
  }
  void chooseFirstLibrary()
}

// 单实例：第二次从 Finder 双击只是把已有窗口拉到前面（而不是起第二个 app 抢同一份库）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // v1：聚焦最后聚焦的那扇窗口（恢复「上次全部窗口」后置）
    const wins = BrowserWindow.getAllWindows()
    const w = wins[wins.length - 1]
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu())
    protocol.handle(ASSET_SCHEME, serveAsset)
    bootLibraries()

    app.on('activate', () => {
      // macOS：点 Dock 图标且没有窗口时重开最后库
      if (BrowserWindow.getAllWindows().length === 0) bootLibraries()
    })
  })

  /**
   * 退出前等所有库 settle。
   *
   * ⚠️ 这里是 `preventDefault` 的**第二处**（第一处是每个窗口的 `close`）：
   * 不挡的话 app 会直接退，renderer 那 250ms 防抖里最后一批就丢了。
   * 挡了之后由 `quitAll()` 逐个走握手，走完再真退。
   */
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    e.preventDefault()
    quitting = true
    void manager.quitAll().then(() => app.quit())
  })

  app.on('window-all-closed', () => {
    // macOS 惯例是留在 Dock 里（`activate` 再开回来）；其它平台直接退
    if (process.platform !== 'darwin') app.quit()
  })
}
