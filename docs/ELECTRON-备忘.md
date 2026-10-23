# ELECTRON 备忘 —— 桌面软件（`相` / `Qua`）升格过程中踩到的一切

> 环境：macOS 26.1（build 26A428，`sw_vers` 报 ProductVersion 27.0）、
> arm64、系统 node **v26.7.0**、pnpm 11.8.0、**Electron 44.9.0**（Chromium 152.0.7977.167 / Node 24.22.0 / V8 15.2）。
> 本目录是 Electron 桌面软件（显示名「相」，英文名 Qua）。
>
> 所有「实测」都来自 `pnpm check:electron`（真 Electron、真按键，10/10）与 `pnpm check:bundle`
> （打出来的 `相.app`，4/4）；证据原文在 `.cache/etest/electron-smoke.log`（每次跑覆盖）。
> **凡是当前环境测不出来的，下面都单独标了「未验证」。**

---

## 0. 壳的形状（一句话）

```
electron/main.ts     窗口 / 菜单 / 生命周期 / 数据目录 / port 中转骨架   ← 一行业务逻辑都没有
electron/preload.ts  最小面：kb.shellInfo() + kb.kernel.attach()        ← 页面拿不到 Node
src/**               编辑器、命令表、绑定表、localStorage               ← 全在这里，一个字节没改
```

主进程**没有 import `src/` 里的任何东西**。这条是「主进程不含业务逻辑」架构约束的直接体现，也是桌面壳唯一必须守住的形状。

### 0.1 壳的技术要点

- **`preload` 留好了内核端口骨架**（承「主进程只做端口中转、不含业务」的约束）：将来 `utilityProcess.fork()` 的内核接在
  `main.ts` 的 `attachKernel()`（标了 `TODO(kernel)`），renderer 侧**一行都不用改**。
  现在没有内核 ⇒ 对面是一个明标 `stub: true` 的回声，好让这条通道当场可验证。
- **窗口尺寸/位置记忆**：`<userData>/window-state.json`（400ms 防抖，记 `getNormalBounds()`）。
- **菜单是中文的**，按 macOS 规范：`相 / 文件(关闭窗口 ⌘W) / 编辑 / 视图 / 窗口(最小化 ⌘M)`；
  dev 下多「重新加载 / 开发者工具」，打包后自动消失。
- **数据目录**（**显式钉死，不许出现中文路径**）：
  ```
  ~/Library/Application Support/net.leay.qua/{kb,logs,cache,plugins,backups,tmp}/
  ```
  Electron 默认会拿 `productName`（中文「相」）当目录名 ⇒ 会变成 `~/Library/Application Support/相/`。
  所以 `main.ts` 在 `whenReady` 之前 `app.setName('qua')` ＋ `app.setPath('userData', join(app.getPath('appData'), 'net.leay.qua'))`。
  两份 README（根目录 / `kb/`）说明每个子目录的用途，**只在文件不存在时写**，不覆盖用户改过的内容。
- **首次打开**（没签名没公证，本地自用）：**右键 → 打开 → 打开**；或
  `xattr -dr com.apple.quarantine "<...>/相.app"`。本机自己 build 的产物一般可直接双击。
- **localStorage 仍然是持久化实现**：落在 `<userData>/Local Storage/leveldb/`，跟着 app 走。
  `TODO: 换 DbClient` —— 换的时候**写入通道的形状不变**（一次提交一整份 workspace），
  调用点从 `localStorage.setItem(键, JSON.stringify(ws))` 变成 `ctx.tx.run(...)`，
  见 `src/core/workspace.ts` 顶部注释与 `electron/userdata/kb/README.md`。
- 壳级硬化：`contextIsolation: true` ＋ `nodeIntegration: false` ＋ `sandbox: true`；
  导航与新窗一律禁（外链交给系统浏览器）；单实例锁。

---

## ① Electron 与 Chrome 的行为差异

### 1.1 IME / 中文输入

**结论：在 Electron 里，中文 IME 走的是和 Chrome 同一套 Chromium 输入管线；本仓那套「组合期守卫」在 Electron 下照样成立。**

实测（`E6`，用 CDP 的 `Input.imeSetComposition` / `Input.insertText` 打进**真 Chromium 的输入管线**，
不是手搓 DOM 事件）——目标块文本 `与 ￼ 同源；…`，行内原子锚点 `[2,3)`：

| 步骤 | 原子上**左**侧（caret=2） | 原子上**右**侧（caret=3→5） |
|---|---|---|
| 组合中（预编辑 `zhongwen`） | `composing=true`，seq=`start,update`，**模型含预编辑串=true**，DOM 含=true，原子数 3 | 同左 |
| 候选**取消**（清空预编辑） | `composing=false`，模型残留 `zhongwen=false`，**原子锚点仍 `[2,3)`** | 同上，锚点仍 `[4,5)` |
| 提交「中文」 | 块文本 `与 中文￼ 同源；…`，**原子右移 2 格到 `[4,5)`** | 块文本 `与 中文￼中文 同源；…`，**原子纹丝不动 `[4,5)`** |

- `compositionstart / compositionupdate / compositionend` 三个事件**都到 renderer**，`probe.isComposing` 按预期翻转。
- **Esc 取消候选 ⇒ 模型零残留**（`zhongwen` 不留；这条正是「两段式」要的回头账，见 ③④）。
- 原子区间宽度**恒为 1 格**、原子总数不变、DOM 里 `.atom` 元素恒为 1 个。

**⚠️ 一条容易搞错的事实（顺手挖出来的）：DOM 里根本没有 `U+FFFC` 这个字符。**
行内原子在 DOM 里是 `<span class="atom" contenteditable="false">⇢[[标签]]</span>`，
`U+FFFC` **只活在模型文本里**（`src/core/annotations.ts` 的 `ATOM_PLACEHOLDER`）。
所以「IME 在 U+FFFC 两侧连打」在实现层其实是「**在一个 `contenteditable=false` 的 inline 元素两侧连打**」——
这恰恰是 Chromium 的 IME 更容易出问题的那一种布局，而它是通的。

**未验证**：当前环境拿不到 macOS 的系统输入法（无法激活拼音候选窗），
所以**假名/拼音候选窗的 UI 行为、以及真实系统 IME 的 `Esc` 按键**没有端到端跑过。
上面的组合期语义是通过 Chromium 官方的 IME 输入通道（CDP `Input.imeSetComposition`）打的，
**是被测浏览器真在处理组合，不是我们伪造 DOM 事件**；但「候选窗」本身是 OS 画的，不在 renderer 里。

### 1.2 快捷键

| | Chrome（浏览器标签页） | Electron（这个 app） |
|---|---|---|
| `⌘P` | **打印**（浏览器接管） | 本 app 的命令面板（绑定表里 `mod+p`，Electron 里没有打印这个默认动作） |
| `⌘R` / `⇧⌘R` | 刷新 | **dev 才有**（菜单里 `role: reload/forceReload`）；打包后菜单里没有这两项 |
| `⌥⌘I` / `F12` | 无（或打开浏览器 devtools） | 开发者工具；`F12` 还额外挂了 `before-input-event`（不依赖菜单） |
| `⌘+` / `⌘-` / `⌘0` | 浏览器缩放整页 | 同样缩放整页（`webContents.setZoomFactor`）——实测 `zoomFactor=1.5` 时 `innerWidth 1400→933`、`devicePixelRatio=2` |
| `⌘W` | 关标签页 | `role: close` 关窗口（macOS 惯例：窗口关了 app 留在 Dock） |
| `⌘Q` / `⌘H` / `⌘M` | 无 | `role: quit/hide/minimize`，键等价物由 NSMenu 注册 |
| `⌘F` | 浏览器查找栏 | **什么都不发生**（见 ③②） |
| `⌘A` | 全选页面 | **原生全选**（见 ③①），**没有**被本 app 接管 |
| `⌘Z` | 浏览器无所谓 | ⚠️ **菜单里 `role: undo/redo` 和 app 自己的 `⌘Z` 绑定在抢**，见下面 1.2.1 |

#### 1.2.1 一个必须知道的冲突：菜单 `role: undo` vs app 自己的 `⌘Z`

`main.ts` 的「编辑」菜单按 macOS 规范放了 `role: undo/redo`（键等价物 `⌘Z` / `⇧⌘Z`）。
app 的绑定表里**也**有 `core.history/undo`（自己的快照栈）。
在 macOS 上 **NSMenu 的键等价物先于 web contents 处理**，所以：

- 用户按 `⌘Z` 时，**大概率走菜单 role**（= `webContents.undo()`，即 contenteditable 的原生撤销栈），
  而**不是** app 自己的 `core.history/undo`（块树+锚点+原子的快照回滚）。
- 这两个撤销栈是**两套**。原生那个只知道 DOM 文本编辑，不知道块结构/锚点/行内原子。

**这次没有改它**（改「编辑」菜单会牵动「哪一套才算真撤销」这个产品决定，不该由壳来定）。
**留给下一步的必须回答**：要么把「编辑 → 撤销/重做」换成 `click: () => 转发给 renderer 的 core.history/undo`，
要么把 app 的 `⌘Z` 绑定摘掉、认原生那一套。**现在这个状态是「两套撤销栈并存」，属于已知缺陷。**

> 实测边界说清楚：这条**没有**用真实按键验（TCC 不许注入系统按键，见 ④.6），
> 是从「菜单键等价物注册情况（E3 实测）」＋「macOS 的 NSMenu 优先顺序」推出来的。
> **标为「高度可疑、需人工按键复核」。**

### 1.3 菜单

- 中文菜单**能建**：`相 / 文件 / 编辑 / 视图 / 窗口` 都是自己 `buildFromTemplate` 的（不用 `role: 'appMenu'` 那套英文默认）。
- **首项标题在 macOS 上不由 `label` 决定**：macOS 永远拿 bundle 的 `CFBundleName` 当应用菜单标题。
  所以打包后显示「相」（`Info.plist` 的 `CFBundleName=相`），而**dev 下显示的是「Electron」**（跑的是 Electron 自己的 bundle）——
  这不是 bug，是 dev 与打包的固有差别。
- `role` 的**默认加速键字符串写法不统一**（实测）：多数是 `CommandOrControl+Q/W/M`，
  而 `hide` 直接给 `Command+H`、`hideOthers` 给 `Command+Alt+H`、`pasteAndMatchStyle` 给 `Cmd+Option+Shift+V`。
  在 macOS 上 `CommandOrControl` 就是 ⌘，两种写法都对；但**写断言时别把字符串形状写死**（踩过）。
- **实测坑：对 `role` 建出来的菜单项调 `item.click()` 不会执行任何动作**（Electron 44）。
  `item.click()`、`item.click({}, win, win.webContents)` 都试过，`isMinimized` 纹丝不动；
  而 `win.minimize()` 立刻有效。⇒ **验「菜单动作」不能靠 `item.click()`**，只能靠
  「role 名 + 注册给 NSMenu 的键等价物」（这两样能验）＋「role 背后的窗口 API 有效」（这也验了）。
- 视觉项：dev 模式菜单里多「重新加载 / 强制重新加载 / 开发者工具」三项，打包后自动消失（`buildMenu()` 里按 `DEV_URL` 分支）。

### 1.4 滚动

- Chormium 的滚动本身没差别；**差别在「谁在滚动」这件事上会变**：
  浏览器里可能是 `window` 滚，Electron 的窗口里同样是 `#scroll` 这个内层容器滚，**没变**。
- 实测（`E7`）：窗口 760×560 → 1400×900，`innerWidth` 与 `#editor` 宽度都跟着变，**没有横向溢出**；
  浏览器里那套「滚动容器是谁」的假设在 Electron 下**原样成立**（因为 CSS 没变、`html/body` 也没变）。
- 真正会变的是**滚动条外观**：macOS 的 overlay 滚动条在 app 里默认也是 overlay，
  但「滚动时是否显示滚动条」由「系统设置 → 外观 → 显示滚动条」决定，浏览器与 app 读的是同一个系统设置 ⇒ 无差别。

### 1.5 深色模式（**一个反直觉的负结论**）

- **app 根本不跟随系统**：`grep -rn "prefers-color-scheme" src/` **零命中**；
  主题来自 `prefs().theme`（默认 `light`），由 `applyChrome()` 写 `body[data-theme]`。
  实测强制 `nativeTheme.themeSource='dark'` 后 `body[data-theme]` 仍是 `light`、背景仍是 `rgb(255,255,255)`。
  ⇒ **这是代码事实，不是环境问题。**
- **未验证**：「Electron 里 `prefers-color-scheme` 是否跟随系统」——当前环境**测不出来**：
  `nativeTheme.shouldUseDarkColors` 变成 `true` 了，但**连新开的 `about:blank` 窗口**的
  `matchMedia('(prefers-color-scheme: dark)')` 都还是 `false`（`dark|light = false|true`）。
  对照实验说明是**这个会话拿不到 NSAppearance/窗口服务**，不是 app 的 CSS 挡住了。
  **真机上要人工看一眼**（`nativeTheme.themeSource` 改一下就知道）。
- 结论：**「深色跟随系统」目前连一行实现都没有**（既没有监听，也没有把系统值写进 prefs）。这是待办，不是 bug。

---

## ② 打包踩坑（这一节是血）

### 2.1 Electron 二进制下载

| 坑 | 现象 | 处理 |
|---|---|---|
| pnpm 11 默认拦 postinstall | `node_modules/electron/dist/` **不存在**，装上了一个空壳；一跑就 `Electron failed to install correctly` | `pnpm-workspace.yaml` 的 `allowBuilds` 里放行 `electron: true`（`electron-winstaller` 是 Windows 用的，明确写 `false`，免得每次 install 被问） |
| 缓存目录不可写（**在沙箱化/Caches 不可写的环境里**） | `EPERM: operation not permitted, mkdir '<HOME>/Library/Caches/electron'` | `electron_config_cache=<仓内路径>`（electron 的 `install.js` 直接读这个 env）。另见 2.2 |
| 国内直连 GitHub | 慢/断 | `.npmrc` 里 `electron_mirror=https://npmmirror.com/mirrors/electron/`（实测 pnpm install 阶段**秒级**成功） |

**下载体量**：`electron-v44.9.0-darwin-arm64.zip` 解包后 `.cache/electron` 约 **128MB**；
最终 `相.app` **291MB**。第一次冷构建（含下载）约 **4~5 分钟**，预热后 **10.7 秒**。

### 2.2 electron-builder：两个真正会把构建打死的坑

**坑 A｜`@electron/get` 版本错配（上游 bug，不是我们的配置）**

```
⨯ Cannot read properties of undefined (reading 'ReadWrite')
  at resolveCacheMode (…/app-builder-lib/out/util/electronGet.js:69)
```

- 根因：`app-builder-lib@26.15.3` 的 `package.json` 声明 `@electron/get: ^3.0.0`，
  但代码里用了**只有 v5 才有的** `ElectronDownloadCacheMode`。
  pnpm 老老实实给它装了 v3 ⇒ `get_1.ElectronDownloadCacheMode` 是 `undefined` ⇒ 读 `.ReadWrite` 炸。
  v3 的导出实测只有 `getHostArch / initializeProxy / downloadArtifact / download`；
  v5.1.0 才有 `ElectronDownloadCacheMode`（值 `{ReadWrite:0, ReadOnly:1, WriteOnly:2, Bypass:3}`）。
- 处理：`pnpm-workspace.yaml` 里**只给这一个包**抬高版本：
  ```yaml
  overrides:
    'app-builder-lib>@electron/get': '^5.1.0'
  ```
  （`electron` 自己本来就依赖 v5，所以这不是「为了绕过而乱抬版本」。将来 electron-builder 修好就该删掉这条。）

**坑 B｜缓存目录写不进去 ⇒ 下载到 100% 之后才死**

```
• downloading label=electron progress=100%
• downloaded  label=electron progress=100%
⨯ EPERM: operation not permitted, mkdir '<HOME>/Library/Caches/electron'
```

最气人的一种失败：钱（带宽+时间）花了、包没出来。
根因是 `@electron/get` 的 Cache 默认落 `envPaths('electron').cache` = `~/Library/Caches/electron`，
`electron-builder` 调它时没传 `cacheRoot`（日志里白纸黑字 `Checking the cache (undefined)`）。

处理（`scripts/build-mac.mjs`）：**先探测 `$HOME/Library/Caches` 能不能写**，
不能写才把孩子的 `HOME` 挪到仓内 `.cache/home`——
`os.homedir()` 和 `env-paths` 都读 `HOME`，所以 electron-builder 与 `@electron/get` 的默认缓存会**一起**落到仓里，
不用去分别找各自的 env 开关。**普通机器上这段是空转**（探测成功就直接用真实 HOME）。

**坑 C｜镜像也会 `fetch failed`（一次，未定论）**

- 冷缓存那次，`.npmrc` 里的 npmmirror 镜像走到 **progress=100%** 之后报 `⨯ fetch failed`（undici 的 TypeError）。
- 绕开 pnpm（因而不带 `npm_config_electron_mirror`）改走 **GitHub 直连，成功**，约 4 分钟。
- **未能确定镜像是不是稳定失败**（很可能是瞬时）。逃生口：把 `.npmrc` 里的 `electron_mirror` 注释掉再 `pnpm build:mac`。

**坑 D｜`ELECTRON_RUN_AS_NODE=1`（**某些 agent 宿主环境特有，但值得记一辈子**）**

部分运行环境（某些 agent 宿主本身就是 Electron 应用）会给子进程导出 `ELECTRON_RUN_AS_NODE=1`。
带着这个 env 启动任何 Electron 二进制，**Electron 会退化成纯 Node**：

```
TypeError: Cannot read properties of undefined (reading 'on')
    at dist-electron/main.cjs:65   ← import_electron.ipcMain.on(...)
```

`require('electron')` 返回的是**可执行文件路径字符串**（不是 API），`process.type === undefined`。
排查方式：`node -e "console.log(require('electron'))"`（在 Electron 里跑）看一眼打印的是对象还是路径。

处理：`scripts/dev.mjs` / 两个 check 脚本**统一 `delete env.ELECTRON_RUN_AS_NODE`**。
（这是**环境**的坑，不是代码的坑——绝不能为此改 `main.ts`。）

**坑 E｜Chromium 沙箱起不来（部分运行环境特有）**

```
sandbox_extension_issue_file_to_process failed …: Operation not permitted
sandbox initialization failed: Operation not permitted
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
```

部分运行环境的文件沙箱不允许 Chromium 的沙箱扩展落地 ⇒ GPU/network 子进程反复崩到 FATAL。
处理：`pnpm dev` **自动降级重试一次**（`--no-sandbox --disable-gpu`），并且把话说明白。
注意这种死法**退出码是 0**，所以判断条件不能只看 exit code（看 stderr 尾部特征）。
**这条绝不能进产品代码**——它是环境妥协，普通 macOS 上根本走不到。

**坑 F｜默认数据目录不可写 ⇒ Electron「起来就退」**

不传 `--user-data-dir` 时，Electron 要建 `~/Library/Application Support/net.leay.qua/`，
此环境下 EPERM ⇒ 连 `SingletonLock` 都建不出来，表现像「代码崩了」。
处理：`scripts/dev.mjs` 里做同样的可写探测，不可写才自动加 `--user-data-dir=<仓内>`。
产品侧的默认路径**不变**。

### 2.3 中文 `productName` 能不能出 `.app`？——**能，但要显式挡住它别漏进路径**

- 实测产物：`release/mac-arm64/相.app`，**291MB**，可执行文件也叫 `相`（`Contents/MacOS/相`）。
- `Info.plist` 实测：
  ```
  CFBundleName           相
  CFBundleDisplayName    相
  CFBundleIdentifier     net.leay.qua
  CFBundleExecutable     相
  CFBundleShortVersionString 0.1.0
  LSApplicationCategoryType  public.app-category.productivity
  ```
- electron-builder 对非 ASCII 路径**没有出问题**（我们用的是 `target: dir`；
  如果改成 `dmg`，`artifactName` 里出现中文要另行留意——**这条没测**）。
- ⚠️ 唯一的坑是**目录名**：Electron 默认拿 `productName` 当 `userData` 目录名 ⇒
  会变成 `~/Library/Application Support/相/`（**中文路径**，脚本/日志/备份工具到处是坑）。
  所以 `main.ts` 在 `whenReady` 之前**显式**：
  ```ts
  app.setName('qua')
  app.setPath('userData', join(app.getPath('appData'), 'net.leay.qua'))
  ```
  **实测落点**（直跑不带 `--user-data-dir`，抢在 mkdir 失败前打出来的）：
  ```
  [shell] userData = <HOME>/Library/Application Support/net.leay.qua
  ```
  **纯 ASCII ✅**。`appId` 用 `net.leay.qua`（**没有连字符**：连字符会让部分打包工具与目录名对不上）。
  打包产物里也验了一遍（`pnpm check:bundle` B2）：`appData/net.leay.qua`，纯 ASCII。

### 2.4 数据目录布局

`<userData>/{kb,logs,cache,plugins,backups,tmp}/`（全英文小写）＋ 两份 README：
- `<userData>/README.md` 说明六个目录各自放什么；
- `<userData>/kb/README.md` 专门说「v1 数据其实在 localStorage 里，落在 `<userData>/Local Storage/leveldb/`」。

这两份 README 是从 **asar 里读出来**写的（`electron/userdata/**`），
**所以最容易被「打包 `files` 白名单漏了一行」悄悄弄坏** ⇒ `pnpm check:bundle` B3 专门钉它。
写入策略是**只在文件不存在时写**，绝不覆盖用户改过的内容。
另外把 `logs` / `crashDumps` 也收进了数据目录（默认它们散在 `~/Library/Logs` 下）。
建目录失败**不致命**（warn 后继续跑，只是本次没有持久化）——起不来比存不下严重得多。

**v1 现状：除 `logs/` 外只有 `kb/` 有明确语义，其余四个是「先把形状占住」。**

### 2.5 首次打开要「右键 → 打开」

我们**没有签名、也没有公证**（`mac.identity: null`，`CSC_IDENTITY_AUTO_DISCOVERY=false`）。这是本地自用的取舍。
从别处拷来的 `.app` 会被 Gatekeeper 拦（「无法验证开发者」）：

- 图形方式：**右键（或 Control-点击）→ 打开 → 打开**（只需一次）；
- 命令行方式：
  ```bash
  xattr -dr com.apple.quarantine "<仓库>/release/mac-arm64/相.app"
  ```
- **本机自己 build 出来的**产物不会被加 quarantine，所以本机上一般直接双击就能开；
  一旦用 AirDrop / 网盘 / 压缩包传到别的机器，就必然要走上头两条之一。

---

## ③ 输入面形状的四件账在 Electron 下的现状

> 四件账原文：① `Cmd+A`（实测真实按键只覆盖 39/10000 块 ⇒ 必须自己实现全选）
> ② 自研查找（原生 `Cmd+F` 查不到未挂载内容）③ 自绘选区高亮层 ④ 组合期两段式。
> 下面是**在真 Electron 里**（`pnpm check:electron`）量到的现状，不是推演。

### ① `⌘A`：**完全没接管，而且现在这个状态是「危险地半通」**

- 绑定表里**没有** `mod+a`（`grep` 过），所以 `⌘A` 落给 Chromium 的原生全选：
  - **DOM 侧**：`rangeCount=1`，选区**跨 16 个 `.blk`**（全部挂载的块），DOM 文本 503 字，锚点在 `#editor` 内 ✅
  - **模型侧**：`__qua.snapshot().selection` **仍是单块**（`aBlock/hBlock` 是同一块），命令日志增量 **0**
  ⇒ **DOM 全选了，模型没有**。这正是「块集合选区由模型持有」与浏览器原生之间的缝。
- **接下去打字会发生什么**（`⌘A` → 打 `X`）：16 块 → **16 块**，第 1 块变成 `X`，其余 15 块**文本一个没少**。
  ⇒ 用户以为「全选替换」，实际只替换了锚点所在那一块；**其余 15 块的 DOM 删除被模型丢弃了**。
- **接下去按 Backspace 更糟**（`⌘A` → `Backspace`）：模型仍是 **16 块**（第 1 块变空），
  但 **DOM 里只剩 1 个 `.blk`**。
  ⇒ **视图与模型当场分家**：屏幕上看着「只剩一个空块」，模型里其实还躺着 16 块、15 块有内容。
  下一次任何触发重渲染的动作会把那 15 块「变回来」——对用户就是「删了的东西自己回来了」。
- **结论**：`⌘A` 必须接管（四件账①的判断在 Electron 下**再次成立**，而且这里的样本只有 16 块、
  放大到 1 万块只会更糟）。要回答的问题还是那两个：块集合选区怎么在模型里表达、
  跨 N 块删除怎么走一次事务（现在连删除都还没走命令，是浏览器直接改 DOM）。

### ② `⌘F`：**零反应**（没有绑定，也没有查找 UI）

- 按 `⌘F`：命令日志增量 **0**、`document.querySelector('input[type=search], .find-bar, [class*=find]')` 为 **null**、
  焦点没动，DOM 选区不变。
- 为什么不是「浏览器查找栏」：Electron **没有**内置的 find bar，
  浏览器里 `⌘F` 由浏览器 UI 层接管，在 Electron 里那一层不存在 ⇒ 这个键现在**什么也不做**。
- 所以 ② 的现状比四件账原文更尴尬：不是「原生查找查不到未挂载内容」，而是**连原生查找都没有**。
  要做的不是「适配」，是**从零自研**；而原型本来就还没有查找功能（`README` 的「还不做什么」里已列出）。

### ③ 自绘选区高亮层：**本实现下没能复现，因为当前实现的虚拟化还没有滚动联动**

- 设计好的实验：跨 4 块做 DOM 选区 → 滚到底 → 看被选中的块有没有被卸载。
- 实测结果：滚到底后 **那 4 块仍然挂在 DOM 里**（`stillMounted=[true,true,true,true]`），
  挂载集合 id 与滚动前**逐个相同**（`mounted=17/56` 不变）。
  ⇒ **滚动没有换窗口** —— 这与 `README` 自述的「没有滚动联动」完全一致。
- 所以 ③ 在**这一版实现**里**根本没被触发**：原生高亮还好好地在。
  **这条要等真·滚动联动接进来才会暴露**；在那之前，「自绘高亮」不是当前的必要工作。
- 顺带确证了一条机制：只要承载选区的 DOM 节点被卸载，`Selection` 对象本身还在（也没抛错），
  但**没有像素可画**——所以真到那天，自绘是唯一出路。

### ④ 组合期两段式：**复现了，而且丢得很具体**

- 组合中（预编辑 `zhongwen` 已进模型）把承载块**滚出虚拟窗口**：
  - 目标块 `还挂着=false`（DOM 节点连同预编辑串一起没了），`mounted=17/56`，`composing` **仍然是 true**，
    模型里带预编辑串的块 = **1**。
- 然后提交「中文」：
  - 目标块（组合开始时 caret 所在的那块）文本 = **`""`** —— **提交的字没进它**；
  - 提交的「中文」落在**另外一块**上（id 尾 6 位 `6411f0`）；
  - 预编辑串 `zhongwen` **不在模型里了**（`preeditLeft=[]`）。
- ⇒ **现状**：组合期被卸载 ⇒ 提交落点漂移（落到别的块）；预编辑串本身没留残渣，但**用户敲的字去了不该去的地方**。
  这就是四件账④说的「两段式」必须存在的理由：**预编辑/已提交必须分两个状态**，
  卸载时要么把预编辑挂起、要么禁止卸载正在组合的块。
  当前实现只做到了 `compositionend` 后补渲染（`src/view/editor.ts`），**没有处理「组合中块被卸载」**。

---

## ④ Electron 壳特有的坑

### 4.1 `contextIsolation` / `nodeIntegration` / `sandbox`

- 三件套的取法：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true`（**显式写出来**，不是靠默认值）。
- 实测（打包产物里也验了）：页面里 `typeof window.require === 'undefined'`、`typeof window.process === 'undefined'` ✅
- preload 里**不暴露 `ipcRenderer` 本体**，只暴露两个函数（`kb.shellInfo()` / `kb.kernel.attach()`）。

### 4.2 ⚠️ **`MessagePort` 过不了 `contextBridge`**（这次最有价值的一条）

按「主进程只做端口中转、不含业务」的约束，preload 里把主进程 `MessageChannelMain` 的 port 转给页面，最直觉的写法是
`exposeInMainWorld('kb', { kernel: { attach: () => Promise<MessagePort> } })`。**实测不行**：

```
page.evaluate: TypeError: port.postMessage is not a function
```

- 原因：`contextBridge` 搬运对象时**只带自有属性**，`MessagePort.prototype.postMessage/close` 这些**原型方法不会被带过去**
  （`port.onmessage = fn` 反而是能赋上的，所以故障表现很隐蔽：看着像拿到了 port，一 `postMessage` 才炸）。
- 处理（`electron/preload.ts`）：**不把 port 交给页面**，用一层闭包把它包成普通函数再暴露：
  ```ts
  interface KernelLink { post(msg): void; onMessage(cb): void; close(): void }
  ```
  普通函数是 `contextBridge` 的舒适区，实测**往返成功**：
  `{"id":7,"type":"kb/ping/stub-echo","stub":true,"echoedBy":"main(no-kernel)"}`（dev 与打包产物都验过）。
- 顺带的好处：页面拿不到 transferable 通道本体，只能通过这两个函数说话，**面更小**。

### 4.3 内核端口骨架（承「主进程只做端口中转、不含业务」）

```
内核进程（将来 = utilityProcess.fork）      主进程                渲染进程 / preload
     port1  ──── adopt ────▶   attachKernel 持有  ──── postMessage ────▶  port2 → KernelLink
     ▲                                                                        │
     └────────────────── 用户事务 / 查询走这条 port ──────────────────────────┘
```

- **接内核的唯一改动点**在 `electron/main.ts` 的 `attachKernel()`，标了 `TODO(kernel)`：
  把 `port1` 用 `kernel.postMessage({type:'kb/kernel/adopt'}, [port1])` 交给 `utilityProcess.fork()` 出来的内核，
  然后删掉那段**明标 `stub: true`** 的回声。**renderer 侧一行都不用改。**
- 「主进程只做 port 中转，不含业务」这条形状**现在就是这样**：它不解析消息、不回答业务、只是在没有内核时回声一句
  `kb/ping/stub-echo`，好让这条通道当场可验证。

### 4.4 CSP：**现在没有，这是已知缺口**

- 现状：`index.html` 里**没有** CSP meta；主进程也**没有**用 `session.webRequest.onHeadersReceived` 注入 CSP。
- 为什么没顺手加：
  1. dev 模式要跑 vite 的 HMR（websocket + 动态 import），一份严格 CSP 很容易把 dev 打瘸；
  2. 生产是 `file://` 加载，**没有响应头**，只能在 `index.html` 里加 meta——
     而那份 HTML 同时也是浏览器版 `pnpm check` 的载体（浏览器冒烟跑的就是它），**加错会一起弄红**；
  3. 这个 app 只加载**自己的**本地资源，`webSecurity` / `contextIsolation` / `sandbox` 都在，
     且导航与新窗都被禁（见 4.5），风险面本来就窄。
- **该加的形状**（下一步，别忘）：生产构建时注入
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'`
  （`style-src` 的 `'unsafe-inline'` 是因为本仓有内联样式写入；`connect-src 'none'` 对纯本地 app 是合适的）。
  dev 与 prod 用不同策略，别共用一份。

### 4.5 导航与新窗：一律关掉

- `setWindowOpenHandler`：`deny`，并且 `http(s)` 外链交给 `shell.openExternal`（否则会开出一个**没有菜单的裸 Chromium**）。
- `will-navigate`：只允许 dev server 前缀（dev）或 `file://`（prod），其它 `preventDefault`。
- 单实例锁 `requestSingleInstanceLock()`：防止从 Finder 双击两次起了两个 app 抢同一份 localStorage。
  第二次双击走 `second-instance`，把已有窗口 `restore + focus`。

### 4.6 devtools

- dev：`openDevTools({ mode: 'detach' })`，菜单里也有 `role: toggleDevTools`（`⌥⌘I`）。
- 打包后：菜单里**没有** devtools 项，但 `F12` 的 `before-input-event` 仍然挂着——
  **这是个口子**：本地自用无妨，真发布前应该要么去掉、要么跟着 `isDev` 一起关掉。
- **本机实测**：`⌥⌘I` 之类的**真实系统按键注入不可用**——
  `osascript -e 'tell application "System Events" to keystroke "m" using command down'`
  报 `System Events 遇到一个错误：发生权限违例 (-10004)`（TCC 没给辅助功能权限，当前环境也不允许弹授权框）。
  ⇒ **`⌘Q` / `⌘W` / `⌘H` / `⌘M` 这四个没有做端到端按键实测**，
  证据只有「role 名 + 注册给 NSMenu 的键等价物（E3 实测）」＋「role 背后的窗口动作有效（`w.minimize()`/`w.close()` 实测）」。
  **请人工在真机上按一遍这四个键复核。**

### 4.7 其他零碎

- **`ready-to-show` 不来的可能性是真的**：在此环境下窗口曾长时间 `isVisible() === false`（GPU 起不来 ⇒ 首帧不绘制）。
  现在的写法是 `ready-to-show` + **2 秒定时兜底**，并且走兜底时 `console.warn` 说出来（不静默）。
  这也解释了另一个现象：**不可见的窗口在 macOS 上 `minimize()` 是空操作**（排查时踩过）。
- `--user-data-dir` 是**用户显式选择**，`main.ts` 不会用 `app.setPath` 覆盖它（自检脚本靠这条把数据关在仓内）。
- 窗口尺寸/位置记忆落在 `<userData>/window-state.json`，400ms 防抖、记的是 `getNormalBounds()`
  （最大化/全屏时记「还原后」的尺寸，而不是屏幕尺寸）。实测跨进程重启保持 `1000×700 @ (140,110)`。
- `nativeTheme` 与 `backgroundColor`：窗口底色写死 `#ffffff`（页面默认亮色），避免冷启动闪黑。

---

## ⑤ 怎么跑（三行）

```bash
cd qua
pnpm i                    # 装依赖（electron 的 postinstall 会下 ~128MB 二进制）
pnpm dev                  # vite + electron 一起起
pnpm build:mac            # ⇒ release/mac-arm64/相.app
pnpm check                # 16/16（真 Chrome 冒烟）—— 一个不变量都没少
pnpm check:electron       # 10/10（真 Electron 冒烟，含上面 ③ 的全部实测）
pnpm check:bundle         # 4/4（验打出来的 相.app）
```

`pnpm dev` 会**自己**处理两件环境破事（默认数据目录不可写、Chromium 沙箱起不来），并**打印出来**；
普通 macOS 上这两段都是空转。

## ⑥ 明确没做 / 没验（别当成做过了）

- **没做**：SQLite、`utilityProcess` 内核、插件宿主、CM6 第二实例、虚拟化滚动联动（这是另外几条线）。
- **没做**：签名与公证（本地自用）；DMG 目标（只出了 `.app`，`target: dir`）。
- **没做**：CSP（缺口见 4.4）；「编辑 → 撤销/重做」与 app 自己的 `⌘Z` 的冲突（见 1.2.1）；
  深色跟随系统（见 1.5）；`⌘A` 接管与自研查找（四件账①②）。
- **没验**：真实**系统输入法**（拼音候选窗）的端到端；`⌘Q/⌘W/⌘H/⌘M` 的真实按键（TCC 挡住，见 4.6）；
  `prefers-color-scheme` 是否跟随系统（当前环境测不出，见 1.5）；
  `dmg` 目标下中文 `artifactName` 是否有坑（见 2.3）；
  **在别的 macOS 版本/别的机器上首次打开**（Gatekeeper 拦截的实际表现）。
- **存档（顺带发现，不属于本次范围）**：`localStorage` 的键是 `qua.workspace`（`src/core/workspace.ts`），
  **改名时故意没动它**——换键等于把已有数据静默丢掉。它在 Chromium profile 里，位置：
  `<userData>/Local Storage/leveldb/`。将来换 DbClient 时一并处理。
