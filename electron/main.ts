/**
 * Electron 主进程。
 *
 * 承****：主进程**不含业务逻辑**。它只做五件壳的事：
 *   ① 定名字与数据目录（`net.leay.qua` / 六个子目录）
 *   ② 建窗口（含尺寸/位置记忆）
 *   ③ 装 macOS 规范的中文应用菜单
 *   ④ 生命周期（`whenReady` / `activate` / `window-all-closed`）
 *   ⑤ 给内核留一条 MessageChannel 端口通道（`attachKernel`，承 44 ／60 B）
 *
 * 编辑器、命令表、绑定表、localStorage 持久化**全在 renderer（`../src/`）里**，
 * 这个文件一行都不碰它们——它连 `src/` 里的任何东西都没 import。
 */
import {
  BrowserWindow,
  Menu,
  MessageChannelMain,
  app,
  ipcMain,
  nativeTheme,
  shell,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// 文案字典与 renderer **共用同一份**（`src/core/msg.ts` 是零依赖叶子）。菜单是用户可见文案，
// 所以连「相」都走 t('app.name')，不在这里硬编码。
import { t } from '../src/core/msg'

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

/* ------------------------------------------------------------ 内核端口骨架（承 44  / 60 B） */

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

let win: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const st = readState()

  const w = new BrowserWindow({
    x: st.x,
    y: st.y,
    width: st.width,
    height: st.height,
    minWidth: 720,
    minHeight: 480,
    title: APP_NAME,
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
  w.on('closed', () => {
    win = null
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

// 单实例：第二次从 Finder 双击只是把已有窗口拉到前面（而不是起第二个 app 抢同一份 localStorage）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(buildMenu())
    win = createWindow()

    app.on('activate', () => {
      // macOS：点 Dock 图标且没有窗口时重开一个
      if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
    })
  })

  app.on('window-all-closed', () => {
    // macOS 惯例是留在 Dock 里（`activate` 再开回来）；其它平台直接退
    if (process.platform !== 'darwin') app.quit()
  })
}
