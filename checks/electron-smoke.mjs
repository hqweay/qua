/**
 * `pnpm check:electron` —— **在真 Electron 里**跑一遍（不是浏览器里）。
 *
 * 两件事它做得比人手动点更可靠：
 *   ① 断言（退出码非 0 = 红）；
 *   ② 把**实测原始证据**逐条打到 stdout ——尤其是那四件账在 Electron 下的现状。
 *
 * 需要先 `pnpm build`（本脚本加载的是 `dist/index.html`，不是 vite dev server）。
 *
 * ⚠️ 两个**只在本仓沙箱会话里**需要的开关（不是产品行为）：
 *   - `ELECTRON_RUN_AS_NODE` 必须剥掉：某些 agent 宿主本身也是 Electron，它把这个 env 传给了我们；
 *     带着它 Electron 会退化成纯 Node（`require('electron')` 返回二进制路径）。
 *   - `--no-sandbox --disable-gpu`：某些运行环境的文件沙箱不让 Chromium 的沙箱扩展落地
 *     （`sandbox_extension_issue_file_to_process ... Operation not permitted`），
 *     不加就是 GPU 进程反复崩到 `FATAL: GPU process isn't usable. Goodbye.`。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'etest')
mkdirSync(CACHE, { recursive: true })

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const extraArgs = ['--no-sandbox', '--disable-gpu']

const results = []
const transcript = []
function log(...a) {
  const line = a.join(' ')
  transcript.push(line)
  console.log(line)
}

async function check(name, fn) {
  try {
    const msg = await fn()
    results.push({ name, ok: true, msg: msg ?? '' })
    log(`\x1b[32mPASS\x1b[0m  ${name}`)
    if (msg) log(`      ${msg}`)
  } catch (e) {
    results.push({ name, ok: false, msg: e?.message ?? String(e) })
    log(`\x1b[31mFAIL\x1b[0m  ${name}`)
    log(`      ${e?.stack ?? e}`)
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

let seq = 0
async function launch(label, { userData } = {}) {
  seq += 1
  const dir = userData ?? join(CACHE, `${String(seq).padStart(2, '0')}-${label}`)
  // 自动生成的目录**每次跑都清空**：否则 localStorage 会跨轮串场
  // （第一轮跑出的「中」被第二轮当成「取消后不该有的残留」——踩过一次）
  if (!userData) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const app = await _electron.launch({
    args: [ROOT, `--user-data-dir=${dir}`, ...extraArgs],
    env: cleanEnv,
  })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  await page.waitForFunction(() => Boolean(window.__qua))
  // ⚠️ 当前环境里 `ready-to-show` 不触发、窗口靠 2s 兜底才 show；不等到可见，
  // 后面测 `role=minimize` 会失败（**不可见的窗口在 macOS 上最小化是空操作**）。
  const vis = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const t0 = Date.now()
    while (!w.isVisible() && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100))
    return { visible: w.isVisible(), waitedMs: Date.now() - t0 }
  })
  return { app, page, errors, dir, vis }
}

const dumpMenu = ({ Menu }) => {
  const walk = (items) =>
    items.map((i) => ({
      label: i.label,
      role: i.role ?? null,
      type: i.type,
      // macOS 真正拿去和 NSMenu 对齐的键等价物：role 的默认加速键
      roleAccel: typeof i.getDefaultRoleAccelerator === 'function' ? i.getDefaultRoleAccelerator() : null,
      enabled: i.enabled,
      submenu: i.submenu ? walk(i.submenu.items) : null,
    }))
  return walk(Menu.getApplicationMenu().items)
}

const flatMenu = (menu) => {
  const out = []
  for (const m of menu) {
    out.push(`  [${m.type}] ${m.label}${m.role ? `  role=${m.role}` : ''}`)
    for (const s of m.submenu ?? []) {
      out.push(
        `      · ${s.label}${s.role ? `  role=${s.role}` : ''}` +
          `${s.roleAccel ? `  键等价物=${s.roleAccel}` : ''}${s.enabled === false ? '  (disabled)' : ''}`,
      )
    }
  }
  return out.join('\n')
}

log(`\n真 Electron 冒烟：${ROOT}（dist 产物）\n`)

/* ═══════════════════════════════════════════════════ E1 启动 */

await check('E1 启动：加载 dist 产物、preload 面在位、无页面报错', async () => {
  const { app, page, errors, dir, vis } = await launch('boot')
  const url = page.url()
  const info = await page.evaluate(() => window.kb.shellInfo())
  const surfaces = await page.evaluate(() => ({
    kb: typeof window.kb,
    kernelAttach: typeof window.kb?.kernel?.attach,
    nodeRequire: typeof window.require,
    nodeProcess: typeof window.process,
    // 壳安全：页面里必须看不到 Node
    qua: typeof window.__qua,
  }))
  const userDataHonored = page ? await app.evaluate(({ app: a }) => a.getPath('userData')) : ''
  await app.close()
  log(`      URL=${url}`)
  log(`      shellInfo=${JSON.stringify(info)}`)
  log(`      页面可见面=${JSON.stringify(surfaces)}`)
  log(`      --user-data-dir 生效？ ${userDataHonored}`)
  log(`      启动目录=${dir}`)
  log(`      窗口可见：${JSON.stringify(vis)}（当前环境 ready-to-show 不触发 ⇒ 走 2s 兜底）`)
  assert(url.startsWith('file://') && url.endsWith('/dist/index.html'), `prod 应加载 dist/index.html，实际 ${url}`)
  assert(surfaces.kb === 'object' && surfaces.kernelAttach === 'function', 'preload 没暴露 kb.kernel.attach')
  assert(surfaces.nodeRequire === 'undefined' && surfaces.nodeProcess === 'undefined', '页面里看得到 Node ⇒ contextIsolation/nodeIntegration 配错了')
  assert(surfaces.qua === 'object', 'window.__qua 不在（renderer 没起来）')
  assert(!errors.length, `页面报错：${errors.join(' | ')}`)
  assert(vis.visible === true, '窗口始终不可见（show() 没生效）')
  assert(info.electron?.startsWith('44.'), `electron 版本异常：${info.electron}`)
  assert(userDataHonored === dir, `--user-data-dir 没生效：${userDataHonored} ≠ ${dir}`)
  return `Electron ${info.electron} / Chromium ${info.chrome} / Node ${info.node}；页面里 require=undefined、process=undefined`
})

/* ═══════════════════════════════════════════════════ E2 内核端口骨架 */

await check('E2 MessageChannelMain 端口中转骨架：renderer 拿到的 port 能通到主进程', async () => {
  const { app, page } = await launch('kernel-port')
  const roundTrip = await page.evaluate(async () => {
    const link = await window.kb.kernel.attach()
    const got = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('3s 内没收到端口回包')), 3000)
      link.onMessage((data) => {
        clearTimeout(t)
        resolve(data)
      })
      link.post({ id: 1, type: 'kb/ping', payload: { hello: '世界' } })
    })
    return { kind: typeof link, methods: ['post', 'onMessage', 'close'].filter((m) => typeof link[m] === 'function'), got }
  })
  // 再连一次：拿到的是**两条独立通道**（每次 attach 都新开一条）
  const second = await page.evaluate(async () => {
    const p1 = await window.kb.kernel.attach()
    const p2 = await window.kb.kernel.attach()
    return { sameObject: p1 === p2 }
  })
  await app.close()
  log(`      往返=${JSON.stringify(roundTrip)}`)
  log(`      连续 attach=${JSON.stringify(second)}`)
  log(`      通道面方法=${JSON.stringify(roundTrip.methods)}`)
  assert(roundTrip.kind === 'object', `attach() 应返回通道对象，实际 ${roundTrip.kind}`)
  assert(roundTrip.methods.length === 3, `通道面应暴露 post/onMessage/close，实际 ${JSON.stringify(roundTrip.methods)}`)
  assert(roundTrip.got?.stub === true, `回包应带 stub 标记（现在没有内核），实际 ${JSON.stringify(roundTrip.got)}`)
  assert(roundTrip.got?.id === 1, '回包的 id 不对：中转没把消息原样带回来')
  assert(roundTrip.got?.echoedBy === 'main(no-kernel)', `echoedBy 不对：${roundTrip.got?.echoedBy}`)
  return 'attach() → postMessage → 主进程 stub 回声 → renderer；中转与 contextBridge 过 MessagePort 都成立'
})

/* ═══════════════════════════════════════════════════ E3 应用菜单 */

await check('E3 应用菜单：中文、macOS 规范、⌘Q/⌘W/⌘H/⌘M 的键等价物都挂在 role 上', async () => {
  const { app } = await launch('menu')
  const menu = await app.evaluate(dumpMenu)
  await app.close()
  log('      菜单实测（label / role / 键等价物）：')
  log(flatMenu(menu))
  const titles = menu.map((m) => m.label)
  assert(titles[0] === '相', `首个菜单应是应用名，实际 ${titles[0]}`)
  for (const t of ['文件', '编辑', '视图', '窗口']) assert(titles.includes(t), `缺菜单：${t}`)

  const find = (menuLabel, itemLabel) =>
    menu.find((m) => m.label === menuLabel)?.submenu?.find((s) => s.label === itemLabel)
  // ⚠️ Electron 给 role 的默认加速键写的是 `CommandOrControl+*`（跨平台同一张表）；
  // 在 macOS 上 `CommandOrControl` 就解析成 ⌘。这里断言的正是**注册给 NSMenu 的那个键等价物**。
  // ⚠️ Electron 给 role 的默认加速键**写法本身不统一**：多数是 `CommandOrControl+*`，
  // 而 `hide` 直接给 `Command+H`。两种在 macOS 上都解析成 ⌘，所以两边都收。
  const want = [
    ['相', '退出 相', ['CommandOrControl+Q']],
    ['文件', '关闭窗口', ['CommandOrControl+W']],
    ['相', '隐藏 相', ['Command+H', 'CommandOrControl+H']],
    ['窗口', '最小化', ['CommandOrControl+M']],
  ]
  const got = want.map(([m, i, accs]) => {
    const item = find(m, i)
    assert(item, `菜单项不存在：${m} › ${i}`)
    assert(accs.includes(item.roleAccel), `${m} › ${i} 的键等价物应为 ${accs.join(' 或 ')}，实际 ${item.roleAccel}`)
    return `${i} = ${item.roleAccel}`
  })
  return got.join('；')
})

await check('E3b 菜单 role 与它背后的窗口动作（外加一条 Electron 44 的坑）', async () => {
  const { app } = await launch('menu-act')
  const roles = await app.evaluate(({ Menu }) => {
    const pick = (m, i) => Menu.getApplicationMenu().items.find((x) => x.label === m).submenu.items.find((x) => x.label === i)
    return {
      退出: pick('相', '退出 相').role,
      关闭窗口: pick('文件', '关闭窗口').role,
      隐藏: pick('相', '隐藏 相').role,
      最小化: pick('窗口', '最小化').role,
      全选: pick('编辑', '全选').role,
      // undo/redo **必须没有 role**（NSMenu 会抢在 web contents 之前，
      // 让 ⌘Z 走原生文本栈，而那个栈不懂块结构）。这里记成「有没有」交给下面断言。
      撤销role: pick('编辑', '撤销')?.role ?? null,
      重做role: pick('编辑', '重做')?.role ?? null,
    }
  })
  for (const [k, v] of Object.entries(roles)) {
    if (k.endsWith('role')) continue
    assert(v, `「${k}」应该是一个原生 role（否则 macOS 不会替我们做这件事）`)
  }
  assert(roles.撤销role === null && roles.重做role === null, `撤销/重做不该挂在原生 role 上（实测 ${roles.撤销role}/${roles.重做role}）——⌘Z 归 app 的模型栈`)

  // ⚠️ 实测：对**用 role 建出来的**菜单项调 `item.click()` 不会执行 action
  //（Electron 44：role 的动作由原生菜单在选择时执行，JS 侧的 click 是空转）。
  // 所以「动作是否可用」要**分开**验：验证 role 名 + 验证 role 背后那个窗口动作真的有效。
  const viaClick = await app.evaluate(async ({ Menu, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const item = Menu.getApplicationMenu().items.find((m) => m.label === '窗口').submenu.items.find((i) => i.role === 'minimize')
    item.click({}, w, w.webContents)
    item.click() // 两种调用形状都试
    await new Promise((r) => setTimeout(r, 600))
    const r = w.isMinimized()
    w.restore()
    await new Promise((r2) => setTimeout(r2, 600)) // restore 是异步的：不等它做完，紧接着的 minimize 会被吃掉
    return r
  })
  const viaApi = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.minimize()
    await new Promise((r) => setTimeout(r, 900))
    const r = w.isMinimized()
    w.restore()
    await new Promise((r2) => setTimeout(r2, 400))
    return r
  })
  // role=close 背后的动作：关窗后窗口归零，而 app 仍活着（macOS 惯例）
  const closed = await app.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].close()
    await new Promise((r) => setTimeout(r, 700))
    return { windows: BrowserWindow.getAllWindows().length }
  })
  const appAlive = await app.evaluate(({ app: a }) => a.isReady())
  await app.close()
  log(`      菜单项 role：${JSON.stringify(roles)}`)
  log(`      item.click({}, w, wc) / item.click() ⇒ isMinimized=${viaClick}`)
  log(`      w.minimize()（role 背后的动作）⇒ isMinimized=${viaApi}`)
  log(`      w.close()（role=close 背后的动作）⇒ 剩余窗口=${closed.windows}，app 仍存活=${appAlive}`)
  log('      ⚠️ 真实 ⌘Q/⌘W/⌘H/⌘M 的**系统级按键注入**在当前环境不可用：')
  log('         osascript -e \'tell application "System Events" to keystroke "m" using command down\'')
  log('         ⇒ 报错「System Events 遇到一个错误：发生权限违例 (-10004)」（TCC 未授权辅助功能；当前环境不允许弹授权框）')
  log('         所以这四个快捷键的证据是「role 名 + 注册给 NSMenu 的键等价物」（E3），而不是端到端按键。')
  assert(viaApi === true, 'role=minimize 背后的 w.minimize() 应当有效')
  assert(closed.windows === 0, `关窗后不该还有窗口，实际 ${closed.windows}`)
  assert(appAlive === true, 'macOS 上关掉窗口后 app 不该退出')
  return `六个关键项里五个是原生 role（${['退出', '关闭窗口', '隐藏', '最小化', '全选'].map((k) => roles[k]).join('/')}）；撤销/重做**已摘 role**（归 app 模型栈）；role 动作经 w.minimize()/w.close() 验证有效（关窗后窗口 0 个、app 仍活）；**实测 MenuItem.click() 对 role 项空转**；真实 ⌘Q/⌘W/⌘H/⌘M 因 TCC 禁止 System Events 而**无法端到端实测**`
})

/* ═══════════════════════════════════════════════════ E4 窗口尺寸/位置记忆 */

await check('E4 窗口尺寸/位置记忆：改了尺寸 → 关窗 → 重开还是那个尺寸', async () => {
  const dir = join(CACHE, '04-bounds')
  const first = await launch('bounds', { userData: dir })
  /**
   * ⚠️ **不要用硬编码的 1000×700 当期望**。
   *
   * 系统会把窗口钳到屏幕可用区域内：在矮屏（CI 的 macOS runner 就是）上
   * `setBounds({y:110, height:700})` 回读到的是 `{y:31, height:677}`。
   * 那时断言「必须是 700」测的不是「记忆功能」，而是「这台机器屏幕够不够高」——
   * 一条与产品无关的红。
   *
   * ⇒ 期望值取**实际设进去之后立刻读到的**那一份：要保的不变量是
   *   「关掉再开，还是刚才那一份」，而不是某一组魔数。
   */
  /**
   * 先把屏幕工作区打出来：窗口被钳到屏幕内时，红的原因在**环境**，
   * 而这条日志让人一眼看出来，不必再猜。
   */
  const env = await first.app.evaluate(({ screen, BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    return {
      workArea: screen.getPrimaryDisplay().workArea,
      displays: screen.getAllDisplays().length,
      before: w.getNormalBounds(),
    }
  })
  log(`      workArea=${JSON.stringify(env.workArea)} displays=${env.displays} 建窗时=${JSON.stringify(env.before)}`)

  /**
   * 挑一个**屏幕装得下**的矩形再设。
   *
   * ⚠️ 写死 `{x:140, y:110, w:1000, h:700}` 在窄屏上会被系统钳内
   *    （CI 的 runner 只有 1024×677 ⇒ 位置被推到 24、高度被压到 677），
   *    于是测的变成「这台机器屏幕够不够大」，而不是「记不记得住」。
   * ⇒ 从工作区里算一个能放下的矩形：位置**不贴边**（这样钳位不会发生），
   *    尺寸留出余量。任何屏幕尺寸下都成立。
   */
  const want = await first.app.evaluate(({ screen }) => {
    const wa = screen.getPrimaryDisplay().workArea
    const width = Math.min(900, Math.max(760, wa.width - 260))
    const height = Math.min(640, Math.max(520, wa.height - 200))
    // 留 100px 边距，保证「不在边界上」⇒ 系统没有理由挪它
    return { x: wa.x + 100, y: wa.y + 100, width, height, wa }
  })
  log(`      目标 bounds=${JSON.stringify({ x: want.x, y: want.y, width: want.width, height: want.height })}`)
  await first.app.evaluate(({ BrowserWindow }, b) => {
    BrowserWindow.getAllWindows()[0].setBounds(b)
  }, { x: want.x, y: want.y, width: want.width, height: want.height })
  await new Promise((r) => setTimeout(r, 900)) // 等落盘的 400ms 防抖
  const bounds1 = await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds())
  await first.app.close()

  const persisted = JSON.parse(readFileSync(join(dir, 'window-state.json'), 'utf8'))
  log(`      window-state.json = ${JSON.stringify(persisted)}`)
  log(`      关机前 getNormalBounds=${JSON.stringify(bounds1)}`)

  const second = await launch('bounds', { userData: dir })
  const bounds2 = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds())
  await second.app.close()
  log(`      重开 getNormalBounds=${JSON.stringify(bounds2)}`)

  assert(
    bounds2.width === bounds1.width && bounds2.height === bounds1.height,
    `重开后尺寸应等于关掉前那一份（${bounds1.width}×${bounds1.height}），实际 ${bounds2.width}×${bounds2.height}`,
  )
  assert(
    bounds2.x === bounds1.x && bounds2.y === bounds1.y,
    `重开后位置应等于关掉前那一份（${bounds1.x},${bounds1.y}），实际 (${bounds2.x},${bounds2.y})`,
  )
  return `${bounds1.width}×${bounds1.height} @ (${bounds1.x},${bounds1.y}) 跨进程重启原样保持；落盘文件 ${join(dir, 'window-state.json')}`
})

/* ═══════════════════════════════════════════════════ E5 真按键：⌘A / ⌘F */

await check('E5 ⌘A 与 ⌘F 的当前行为（①② 的 Electron 现状）', async () => {
  const { app, page } = await launch('hotkeys')
  await page.evaluate(() => window.__qua.quiet(true))
  const snapBefore = await page.evaluate(() => ({
    ...window.__qua.snapshot(),
    blocks: window.__qua.blocks().length,
    log: window.__qua.commandLog().length,
  }))

  // ⌘F
  await page.evaluate(() => window.__qua.focus())
  const logBeforeF = await page.evaluate(() => window.__qua.commandLog().length)
  await page.keyboard.press('Meta+f')
  await new Promise((r) => setTimeout(r, 250))
  const afterF = await page.evaluate(() => ({
    logDelta: window.__qua.commandLog().length,
    anyFindUI: Boolean(document.querySelector('input[type=search], .find-bar, [class*=find]')),
    domSel: String(document.getSelection()?.toString() ?? ''),
  }))

  // ⌘A
  await page.evaluate(() => window.__qua.focus())
  await page.keyboard.press('Meta+a')
  await new Promise((r) => setTimeout(r, 250))
  const afterA = await page.evaluate(() => {
    const s = window.getSelection()
    const domBlocks = s && s.rangeCount ? [...document.querySelectorAll('.blk')].filter((el) => s.containsNode(el, true)).length : 0
    return {
      rangeCount: s?.rangeCount ?? 0,
      domBlocksSpanned: domBlocks,
      domTextLen: s?.toString().length ?? 0,
      anchorInEditor: Boolean(document.getElementById('editor')?.contains(s?.anchorNode ?? null)),
      // 模型自己持有的选区（块集合选区由模型持有）
      modelSel: window.__qua.snapshot().selection,
      modelStillOneBlock: (() => {
        const m = window.__qua.snapshot().selection
        return m.aBlock === m.hBlock
      })(),
      logDelta: window.__qua.commandLog().length,
    }
  })

  log(`      ⌘F：命令日志增量=${afterF.logDelta}（应当 0＝没有绑定）、出现查找 UI=${afterF.anyFindUI}、DOM 选区="${afterF.domSel}"`)
  log(`      ⌘A：DOM rangeCount=${afterA.rangeCount}、跨 ${afterA.domBlocksSpanned} 个 .blk、DOM 文本长 ${afterA.domTextLen}、锚点在 #editor 内=${afterA.anchorInEditor}`)
  log(`      ⌘A：模型选区=${JSON.stringify(afterA.modelSel)}（仍是单块=${afterA.modelStillOneBlock}）、命令日志增量=${afterA.logDelta}`)
  log(`      起始状态：块数=${snapBefore.blocks}、虚拟化=${snapBefore.virtualize}、已挂 DOM=${snapBefore.domNodes} 节点`)

  // 在**独立的干净实例**里看「⌘A 之后直接打字」会发生什么（这是真正要回答的问题）
  const { app: app2, page: page2 } = await launch('select-all-type')
  await page2.evaluate(() => window.__qua.quiet(true))
  const n0 = await page2.evaluate(() => window.__qua.blocks().length)
  await page2.evaluate(() => window.__qua.focus())
  await page2.keyboard.press('Meta+a')
  await page2.keyboard.type('X')
  await new Promise((r) => setTimeout(r, 300))
  const destroyed = await page2.evaluate(() => ({
    blocks: window.__qua.blocks().length,
    firstTexts: window.__qua.text().slice(0, 3),
    hasStorage: window.__qua.snapshot().hasLocalStorage,
  }))
  // 再来一次：⌘A 之后直接按 **Backspace**（「全选删除」——里最该回答的那个操作）
  await page2.evaluate(() => window.__qua.loadState('seed'))
  const n1 = await page2.evaluate(() => window.__qua.blocks().length)
  await page2.evaluate(() => window.__qua.focus())
  await page2.keyboard.press('Meta+a')
  await page2.keyboard.press('Backspace')
  await new Promise((r) => setTimeout(r, 300))
  const deleted = await page2.evaluate(() => ({
    blocks: window.__qua.blocks().length,
    texts: window.__qua.text(),
    domBlocks: document.querySelectorAll('.blk').length,
  }))
  await app2.close()
  await app.close()
  log(`      ⌘A → 直接打字「X」：块数 ${n0} → ${destroyed.blocks}；前 3 块文本=${JSON.stringify(destroyed.firstTexts)}`)
  const wiped = destroyed.blocks === 1
  log(`      ⇒ ${wiped ? '整篇被替换成一个块（DOM 全选把模型也带走了）' : '只影响被 DOM 选区覆盖的那一块（模型选区仍是单块）'}`)
  log(`      ⌘A → Backspace：块数 ${n1} → ${deleted.blocks}；DOM 里还剩 ${deleted.domBlocks} 个 .blk`)
  log(`      ⌘A → Backspace 后前 3 块文本=${JSON.stringify(deleted.texts.slice(0, 3))}`)
  log(
    `      ⇒ ${deleted.blocks === n1 && deleted.texts.filter((t) => t === '').length === 0 ? '**「全选删除」几乎没生效**：16 块的 DOM 删除被模型丢弃，只剩锚点块被同步' : `模型变成 ${deleted.blocks} 块`}`,
  )

  assert(afterF.logDelta - logBeforeF === 0, '⌘F 不该触发任何命令（本仓没有 find 绑定）')
  assert(afterA.rangeCount >= 1 && afterA.domBlocksSpanned > 1, '⌘A 应当产生跨块的 DOM 选区')
  return `⌘F＝零反应（无绑定、无查找 UI）；⌘A＝原生全选（DOM 跨 ${afterA.domBlocksSpanned} 块 / ${afterA.domTextLen} 字），模型选区不变（仍单块）；紧接打字${
    wiped ? '**整篇被覆盖成 1 块**' : '只动被覆盖的那一块'
  }`
})

/* ═══════════════════════════════════════════════════ E6 中文 IME（composition 通道） */

await check('E6 中文 IME：行内原子两侧组合输入、候选取消、提交后原子只漂 1 格不丢', async () => {
  const { app, page } = await launch('ime')
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(() => window.__qua.quiet(true))

  // ⚠️ `atoms()` 是**库级**的，`blocks()` 是**当前页子树**：
  // 冷启动落在今日 journal，而假数据的原子长在第一页 ⇒ 先显式打开那一页。
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
  const atom = await page.evaluate(() => window.__qua.atoms()[0])
  assert(atom, '假数据里应能找到行内原子')
  const blockId = atom.blockId
  const text0 = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id)?.text, blockId)
  assert(typeof text0 === 'string', `原子所属块应已装进编辑器：${blockId}`)
  log(`      目标块 ${blockId.slice(-6)}：初始文本="${text0}"`)
  log(`      原子 kind=${atom.kind} 初始锚点=[${atom.start},${atom.end})`)

  /**
   * 一次「连打中文」：组合 → 取消 → 再组合 → 提交。
   * `side` 决定光标落在原子的左边还是右边；断言**全部相对当次组合前的原子位置**。
   */
  async function composeAt(side) {
    const before = await page.evaluate((id) => {
      const a = window.__qua.atoms().find((x) => x.blockId === id)
      const b = window.__qua.blocks().find((x) => x.id === id)
      return { atomStart: a.start, atomEnd: a.end, atomCount: window.__qua.atoms().length, text: b.text }
    }, blockId)
    const off = side === 'left' ? before.atomStart : before.atomEnd
    await page.evaluate(({ id, o }) => window.__qua.focusBlock(id, o), { id: blockId, o: off })
    const caret = await page.evaluate(() => {
      const s = document.getSelection()
      const tx = s?.anchorNode?.parentElement?.closest?.('.tx')
      return { anchorOffset: s?.anchorOffset ?? -1, textBefore: tx ? tx.textContent.slice(0, s.anchorOffset) : '' }
    })

    // ① 组合开始：拼音串进预编辑区，**未提交**
    await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
    await new Promise((r) => setTimeout(r, 200))
    const composing = await page.evaluate((id) => ({
      isComposing: window.__qua.snapshot().composing,
      seq: window.__qua.__editor.probe.compositionSeq.slice(-2).join(','),
      // 组合期的预编辑串**已经进了模型**（这是「两段式」要处理的现实）
      modelHasPreedit: window.__qua.blocks().some((b) => b.text.includes('zhongwen')),
      domHasPreedit: (document.querySelector(`.blk[data-block-id="${id}"] .tx`)?.textContent ?? '').includes('zhongwen'),
      atoms: window.__qua.atoms().length,
    }), blockId)

    // ② 候选**取消**（Esc 的语义：清空预编辑，什么都不该落进模型）
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await new Promise((r) => setTimeout(r, 200))
    const cancelled = await page.evaluate((id) => {
      const a = window.__qua.atoms().find((x) => x.blockId === id)
      const b = window.__qua.blocks().find((x) => x.id === id)
      return {
        isComposing: window.__qua.snapshot().composing,
        textHasPreeditAnywhere: window.__qua.blocks().some((b2) => b2.text.includes('zhongwen')),
        blockText: b.text,
        atomStart: a.start,
        atomEnd: a.end,
        atomCount: window.__qua.atoms().length,
      }
    }, blockId)

    // ③ 提交候选（真 IME 提交走的就是 insertText 这条路）
    await cdp.send('Input.insertText', { text: '中文' })
    await new Promise((r) => setTimeout(r, 250))
    const committed = await page.evaluate((id) => {
      const a = window.__qua.atoms().find((x) => x.blockId === id)
      const b = window.__qua.blocks().find((x) => x.id === id)
      return {
        blockText: b.text,
        atomStart: a.start,
        atomEnd: a.end,
        atomCount: window.__qua.atoms().length,
        isComposing: window.__qua.snapshot().composing,
        // 行内原子在 DOM 里是 `<span class="atom" contenteditable="false">`（占 1 格的是那个 span），
        // 在模型里是序列里不可分的一枚 ⇒ 两侧都没有替身字符可查。
        domAtomEls: document.querySelectorAll(`.blk[data-block-id="${id}"] .tx .atom`).length,
        domTextHasFffc: (document.querySelector(`.blk[data-block-id="${id}"] .tx`)?.textContent ?? '').includes('\uFFFC'),
        // 序列投影：文本段与原子各自落在哪一段（断言不用认识 run 形状）
        runKinds: window.__qua.__editor.store.find(id).content.map((r) => r.t),
        modelTextHasFffc: window.__qua.__editor.store
          .find(id)
          .content.some((r) => r.t === 'text' && r.v.includes('\uFFFC')),
      }
    }, blockId)

    log(`      ── 原子${side === 'left' ? '**左**' : '**右**'}侧连打（caret off=${off}，插入前文本尾="${caret.textBefore.slice(-6)}"）`)
    log(`         组合中：composing=${composing.isComposing} seq[末2]=${composing.seq} 模型含预编辑串=${composing.modelHasPreedit} DOM 含=${composing.domHasPreedit} 原子数=${composing.atoms}`)
    log(`         取消后：composing=${cancelled.isComposing} 模型残留 zhongwen=${cancelled.textHasPreeditAnywhere} 块文本="${cancelled.blockText}" 原子锚点=[${cancelled.atomStart},${cancelled.atomEnd})`)
    log(`         提交后：块文本="${committed.blockText}" 原子锚点=[${committed.atomStart},${committed.atomEnd}) DOM 里 .atom 元素=${committed.domAtomEls} 序列=${JSON.stringify(committed.runKinds)} 原子总数=${committed.atomCount} composing=${committed.isComposing}`)
    return { before, caret, composing, cancelled, committed }
  }

  const left = await composeAt('left')
  const right = await composeAt('right')
  const finalText = await page.evaluate((id) => window.__qua.blocks().find((b) => b.id === id).text, blockId)
  await app.close()

  assert(left.composing.seq.includes('start'), `没有 compositionstart（seq=${left.composing.seq}）`)
  assert(left.composing.isComposing === true, '组合期 probe.isComposing 应为 true（键位绑定靠它让路）')
  assert(left.composing.modelHasPreedit === true, '组合期的预编辑串应当已经进了模型（这本就是现状）')
  assert(!left.cancelled.textHasPreeditAnywhere, `候选取消后模型里不该留预编辑串：${left.cancelled.blockText}`)
  assert(
    left.cancelled.atomStart === left.before.atomStart,
    `候选取消后原子一个格都不该动：[${left.before.atomStart},${left.before.atomEnd}) → [${left.cancelled.atomStart},${left.cancelled.atomEnd})`,
  )

  // 左侧插入：原子整体右移 1 格，宽度恒为 1
  assert(left.committed.atomStart === left.before.atomStart + 2, `左侧提交「中文」后原子应从 ${left.before.atomStart} 右移到 +2，实际 ${left.committed.atomStart}`)
  assert(left.committed.atomEnd - left.committed.atomStart === 1, '原子区间宽度必须恒为 1 格')
  // 右侧插入：原子**完全不动**
  assert(
    right.committed.atomStart === right.before.atomStart && right.committed.atomEnd === right.before.atomEnd,
    `右侧提交后原子不该动：[${right.before.atomStart},${right.before.atomEnd}) → [${right.committed.atomStart},${right.committed.atomEnd})`,
  )
  assert(left.committed.atomCount === left.before.atomCount && right.committed.atomCount === right.before.atomCount, '原子总数变了')
  assert(left.committed.domAtomEls === 1 && right.committed.domAtomEls === 1, `DOM 里 .atom 元素应恒为 1 个：左 ${left.committed.domAtomEls} / 右 ${right.committed.domAtomEls}`)
  assert(
    !left.committed.domTextHasFffc && !left.committed.modelTextHasFffc && !right.committed.modelTextHasFffc,
    '两侧都不该有替身字符：原子由 DOM 元素承载、模型里是一枚 run，没有字符代表它',
  )
  // 序列投影：两段中文各自是一段 text run，原子夹在中间、自己是一枚
  assert(
    JSON.stringify(left.committed.runKinds) === JSON.stringify(['text', 'ref', 'text']) &&
      JSON.stringify(right.committed.runKinds) === JSON.stringify(['text', 'ref', 'text']),
    `提交后序列应是「文本段 ＋ 原子 ＋ 文本段」：左 ${JSON.stringify(left.committed.runKinds)} / 右 ${JSON.stringify(right.committed.runKinds)}`,
  )
  // 投影文本里原子不进字（它是节点，不是字符）⇒ 两段中文直接相邻
  assert(
    /^与 中文中文 同源/.test(finalText),
    `两侧提交后投影文本应是「与 中文中文 同源…」（两段中文直接相邻，原子不进投影）：${finalText}`,
  )

  return `原子[${atom.start},${atom.end}) 两侧各连打「中文」：compositionstart/update/end 都到 renderer；**候选取消（清空预编辑）后模型零残留、原子零位移**；左侧提交⇒原子右移 2 格，右侧提交⇒原子纹丝不动，宽度恒为 1 格、DOM 里恒 1 个 .atom span、序列仍是「文本段＋原子＋文本段」（两侧都没有替身字符）、总数不变`
})

/* ═══════════════════════════════════════════════════ E7 窗口缩放 / 深色模式 */

await check('E7 窗口缩放：改窗口尺寸，renderer 的布局跟着变（不是只改窗口壳）', async () => {
  const { app, page } = await launch('resize')
  const setSize = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, s) => {
      BrowserWindow.getAllWindows()[0].setSize(s.width, s.height)
    }, { width, height })
    await new Promise((r) => setTimeout(r, 400))
    return page.evaluate(() => ({
      inner: [window.innerWidth, window.innerHeight],
      editorW: document.getElementById('editor')?.getBoundingClientRect().width ?? 0,
      overflows: document.documentElement.scrollWidth > window.innerWidth,
    }))
  }
  const small = await setSize(760, 560)
  const big = await setSize(1400, 900)
  const zoom = await page.evaluate(() => {
    const web = window.__qua.__registry ? null : null
    return { dpr: window.devicePixelRatio }
  })
  // ⌘+ / ⌘- 缩放（Chromium 的 zoomFactor）——Electron 里由「视图」菜单的 role 管
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5))
  await new Promise((r) => setTimeout(r, 200))
  const zoomed = await page.evaluate(() => ({ inner: window.innerWidth, fontPx: getComputedStyle(document.body).fontSize }))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
  await app.close()
  log(`      760×560 → innerWidth=${small.inner[0]} 编辑器宽=${Math.round(small.editorW)} 横向溢出=${small.overflows}`)
  log(`      1400×900 → innerWidth=${big.inner[0]} 编辑器宽=${Math.round(big.editorW)} 横向溢出=${big.overflows}`)
  log(`      zoomFactor 1.5 → innerWidth=${zoomed.inner}（CSS px 变少＝页面被放大）fontSize=${zoomed.fontPx}，dpr=${zoom.dpr}`)
  assert(small.editorW < big.editorW, '窗口变宽时编辑器宽度应变宽（布局没跟着窗口走）')
  assert(!small.overflows && !big.overflows, '窗口缩放后出现横向溢出')
  return `760→1400 宽：innerWidth ${small.inner[0]}→${big.inner[0]}，编辑器宽 ${Math.round(small.editorW)}→${Math.round(big.editorW)}，无横向溢出；zoomFactor 1.5 时 CSS px 变少（页面真被放大）`
})

await check('E8 深色模式：三档主题的代码事实（并提供当前环境的环境限制证据）', async () => {
  const { app, page } = await launch('theme')
  const read = () =>
    page.evaluate(() => ({
      mediaDark: matchMedia('(prefers-color-scheme: dark)').matches,
      bodyTheme: document.body.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      colorScheme: getComputedStyle(document.body).colorScheme,
    }))
  const native0 = await app.evaluate(({ nativeTheme }) => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
  }))
  const before = await read()
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark'
  })
  await new Promise((r) => setTimeout(r, 600))
  const native1 = await app.evaluate(({ nativeTheme }) => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    themeSource: nativeTheme.themeSource,
  }))
  const after = await read()
  // 关键对照：**新建一个纯净 about:blank 窗口**再看媒体查询。
  // 如果连它都不跟，说明是「当前环境环境拿不到 NSAppearance」而不是「app 的 CSS 挡住了」。
  const blank = await app.evaluate(async ({ BrowserWindow }) => {
    const w = new BrowserWindow({ show: true, webPreferences: { contextIsolation: true } })
    await w.loadURL('data:text/html,<html><body>probe</body></html>')
    const r = await w.webContents.executeJavaScript(
      `matchMedia('(prefers-color-scheme: dark)').matches + '|' + matchMedia('(prefers-color-scheme: light)').matches`,
    )
    w.destroy()
    return r
  })
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'system'
  })
  await app.close()

  log(`      系统原生：${JSON.stringify(native0)} → 强制 dark：${JSON.stringify(native1)}`)
  log(`      renderer（本 app 页面）：跟随前 ${JSON.stringify(before)}`)
  log(`      renderer（本 app 页面）：强制 dark 后 ${JSON.stringify(after)}`)
  log(`      对照：新建 about:blank 窗口在 shouldUseDarkColors=true 时 dark|light = ${blank}`)
  log(`      源码事实：三档主题（跟随系统/亮/暗）—— src/main.ts 里有 prefers-color-scheme 的 matchMedia 监听，`)
  log(`               styles.css 用 color-scheme + light-dark() 取值，index.html 有首屏内联 color-scheme 兜底；`)
  log(`               body[data-theme] 记的是**档位**（默认 system），不是解析后的亮暗`)

  // 代码事实：body[data-theme] 记的是档位（不是解析结果）⇒ 系统外观变化不该改它。
  // 「跟随系统真的变色」在当前环境测不出来（下面就是证据）⇒ 由 checks/smoke.mjs 的 emulateMedia 覆盖。
  assert(after.bodyTheme === before.bodyTheme, `body[data-theme] 是档位，不该被系统外观改动：${before.bodyTheme} → ${after.bodyTheme}`)
  const envSupportsMediaQuery = blank.startsWith('true')
  return (
    `**档位不变色，颜色交给 CSS**（body[data-theme] 记档位：${after.bodyTheme}；监听与 light-dark() 都在源码里）。` +
    `另外：当前环境环境下 nativeTheme 变更**也没能传到 renderer 的媒体查询**（shouldUseDarkColors=${native1.shouldUseDarkColors} 而新建 about:blank 窗口仍报 dark|light=${blank}）⇒ ` +
    `「Electron 里 prefers-color-scheme 是否跟随系统」这一条${envSupportsMediaQuery ? '在当前环境成立' : '**当前环境测不出来，需真机复核**'}`
  )
})

/* ═══════════════════════════════════════════════════ E9  ③④ */

await check('E9 虚拟化下选区投影与组合期两段式的 Electron 现状', async () => {
  const { app, page } = await launch('bl3')
  await page.evaluate(() => window.__qua.quiet(true))
  // 造足够多的块，好让虚拟化真的卸载东西
  await page.evaluate(() => {
    const ed = window.__qua.__editor
    const first = window.__qua.blocks()[0].id
    window.__qua.focusBlock(first, 0)
    for (let i = 0; i < 40; i++) window.__qua.invoke('core.editor/split-block')
  })
  /**
   * ④ 需要一个**有正文的可写行**：`split-block` 造出来的都是空块，而空块没有 `.tx` 文本节点
   *    （只有 `<br>` 占位），在它上面 `imeSetComposition` 进不去组合期。
   *    所以先往第一行里写一段字 —— 它同时也保证这行是「用户真能打字」的那种行。
   */
  await page.evaluate(() => {
    const id = window.__qua.blocks().find((b) => b.text === '')?.id
    if (id) window.__qua.invoke('core.editor/insert-block', { type: 'paragraph', text: '可写正文行，用来测组合期' })
  })
  await new Promise((r) => setTimeout(r, 200))
  // 诊断：这时哪些行是可写且已挂载的（④ 的目标就从这里挑）
  log(`      ④ 候选可写行：${JSON.stringify(await page.evaluate(() => {
    const out = []
    for (const b of window.__qua.blocks()) {
      const tx = document.querySelector(`.blk[data-block-id="${b.id}"] .tx`)
      if (!tx) continue
      out.push({ id: b.id.slice(-6), text: b.text.slice(0, 12), ce: Boolean(tx.isContentEditable), ro: tx.dataset.readonly ?? null })
    }
    return out.slice(0, 8)
  }))}`)
  const n = await page.evaluate(() => window.__qua.blocks().length)
  await page.evaluate(() => window.__qua.setVirtualize(true, 8))
  await new Promise((r) => setTimeout(r, 300))
  const virt = await page.evaluate(() => window.__qua.snapshot())

  // ③ 跨块 DOM 选区 ⇒ 滚走 ⇒ 节点被卸载 ⇒ 选区投影还在不在？
  await page.evaluate(() => {
    const ids = window.__qua.blocks().map((b) => b.id)
    window.__qua.focusBlock(ids[0], 0)
  })
  await page.evaluate(() => {
    const blks = document.querySelectorAll('.blk')
    const s = document.getSelection()
    s.removeAllRanges()
    const r = document.createRange()
    r.setStart(blks[0].querySelector('.tx').firstChild ?? blks[0].querySelector('.tx'), 0)
    const last = blks[Math.min(3, blks.length - 1)]
    r.setEnd(last.querySelector('.tx'), 1)
    s.addRange(r)
  })
  const selInfo0 = await page.evaluate(() => {
    const s = document.getSelection()
    const spanned = [...document.querySelectorAll('.blk')].filter((el) => s.containsNode(el, true))
    return {
      text: s.toString().slice(0, 40),
      textLen: s.toString().length,
      span: spanned.length,
      spannedIds: spanned.map((el) => el.dataset.blockId),
      selElsConnected: [s.anchorNode, s.focusNode].map((n) => (n ? document.contains(n) : null)),
    }
  })
  // 滚到底，让那些块被卸载
  await page.evaluate(() => {
    const sc = document.getElementById('scroll')
    sc.scrollTop = sc.scrollHeight
  })
  await new Promise((r) => setTimeout(r, 400))
  const selInfo1 = await page.evaluate((ids) => {
    const s = document.getSelection()
    const stillMounted = ids.map((id) => Boolean(document.querySelector(`.blk[data-block-id="${id}"]`)))
    return {
      rangeCount: s.rangeCount,
      text: s.toString().slice(0, 40),
      textLen: s.toString().length,
      stillMountedCount: stillMounted.filter(Boolean).length,
      stillMounted,
      anchorConnected: s.anchorNode ? document.contains(s.anchorNode) : null,
      anchorElBlock: s.anchorNode?.parentElement?.closest?.('.blk')?.dataset.blockId ?? null,
      mounted: window.__qua.snapshot().mounted,
      totalBlocks: window.__qua.blocks().length,
      mountedIds: [...document.querySelectorAll('.blk')].map((el) => el.dataset.blockId),
    }
  }, selInfo0.spannedIds)

  // ④ 组合期把块滚出窗口（卸载）再提交
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(() => {
    const sc = document.getElementById('scroll')
    sc.scrollTop = 0
  })
  await new Promise((r) => setTimeout(r, 300))
  /**
   * ⚠️ 目标必须是**可写**的一行：`blocks()[0]` 是只读的日记头（`isJournal` ⇒ `.tx` 不可编辑），
   *    在它上面 `imeSetComposition` **根本进不去组合期** —— 那样这一档测的就不是
   *    「组合期被卸载」，而是「普通滚动加载」（真踩过：断言看着在跑，其实没在测它声称的东西）。
   *    判据用 `isContentEditable`（计算后），不是 `contenteditable` 属性（子块不带那个属性）。
   */
  const targetId = await page.evaluate(() => {
    for (const b of window.__qua.blocks()) {
      if (!b.text || b.text.length < 3) continue
      const tx = document.querySelector(`.blk[data-block-id="${b.id}"] .tx`)
      if (tx?.isContentEditable && tx.dataset.readonly !== '1') return b.id
    }
    return null
  })
  assert(targetId, '找不到可写的一行来测组合期卸载')
  /**
   * 落光标：**先真点一下把焦点给到窗口**，再用 `focusBlock` 精确落到目标块。
   * ⚠️ 不能只靠点击坐标：虚拟化下行的位置随窗口变，点到的可能是**旁边那一行**
   *    （实测：点下去 `caretBlock` 是另一个 id，于是「提交落点漂移」是探针自己造成的假红）。
   */
  const box = await page.evaluate((id) => {
    const el = document.querySelector(`.blk[data-block-id="${id}"] .tx`)
    const r = el.getBoundingClientRect()
    return { x: r.left + 8, y: r.top + r.height / 2 }
  }, targetId)
  await page.mouse.click(box.x, box.y)
  await new Promise((r) => setTimeout(r, 150))
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), targetId)
  await new Promise((r) => setTimeout(r, 150))
  const caret0 = await page.evaluate(() => {
    const s = document.getSelection()
    return s?.anchorNode?.parentElement?.closest?.('.blk')?.dataset.blockId ?? null
  })
  assert(caret0 === targetId, `前置：光标没落到目标块（期望 ${targetId.slice(-6)}，实际 ${caret0?.slice(-6)}）`)
  await cdp.send('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 })
  await new Promise((r) => setTimeout(r, 250))
  const midCompose = await page.evaluate(() => {
    const s = document.getSelection()
    return {
      isComposing: window.__qua.snapshot().composing,
      seq: window.__qua.__editor.probe.compositionSeq.join(','),
      caretBlock: s?.anchorNode?.parentElement?.closest?.('.blk')?.dataset.blockId?.slice(-6) ?? null,
    }
  })
  assert(midCompose.isComposing === true, `前置：组合期没进得去（${JSON.stringify(midCompose)}），本轮断言无效`)
  // 组合中把它滚出窗口 ⇒ 该块应被卸载（DOM 节点连同预编辑串一起没了）
  await page.evaluate(() => {
    const sc = document.getElementById('scroll')
    sc.scrollTop = sc.scrollHeight
  })
  await new Promise((r) => setTimeout(r, 500))
  const afterScroll = await page.evaluate((id) => {
    const el = document.querySelector(`.blk[data-block-id="${id}"]`)
    return {
      stillMounted: Boolean(el),
      mountedCount: window.__qua.snapshot().mounted,
      isComposing: window.__qua.snapshot().composing,
      blocksWithPreedit: window.__qua.text().filter((t) => t.includes('zhongwen')).length,
    }
  }, targetId)
  await cdp.send('Input.insertText', { text: '中文' })
  await new Promise((r) => setTimeout(r, 400))
  const afterCommit = await page.evaluate(
    ({ id, preedit }) => {
      const b = window.__qua.blocks().find((x) => x.id === id)
      const all = window.__qua.blocks()
      const hit = all.filter((x) => x.text.includes('中文'))
      return {
        isComposing: window.__qua.snapshot().composing,
        targetText: b?.text ?? '(块没了)',
        targetSurvived: Boolean(b),
        committedCount: hit.length,
        committedAt: hit.map((x) => ({ id: x.id.slice(-6), text: x.text.slice(0, 24) })),
        // 预编辑串（zhongwen）有没有留在模型里 ——这是「两段式」的那条回头账
        preeditLeft: all.filter((x) => x.text.includes(preedit)).map((x) => ({ id: x.id.slice(-6), text: x.text.slice(0, 24) })),
        totalBlocks: all.length,
        composingSeq: window.__qua.__editor.probe.compositionSeq.join(','),
      }
    },
    { id: targetId, preedit: 'zhongwen' },
  )
  await app.close()

  log(`      造块后：块数=${n}，虚拟化开（radius 8）后 mounted=${virt.mounted}`)
  log(`      ③ 跨块选区：滚走前 跨 ${selInfo0.span} 块（id 尾 6 位 ${selInfo0.spannedIds.map((i) => i.slice(-6)).join(',')}）、文本 ${selInfo0.textLen} 字`)
  log(`      ③ 滚到底后：rangeCount=${selInfo1.rangeCount} 文本 ${selInfo1.textLen} 字；被选中的 ${selInfo0.spannedIds.length} 块里**还挂着 ${selInfo1.stillMountedCount} 块**（${JSON.stringify(selInfo1.stillMounted)}）`)
  log(`      ③ 滚到底后 mounted=${selInfo1.mounted}/${selInfo1.totalBlocks}；挂载集合 id 尾 6 位=${selInfo1.mountedIds.map((i) => i.slice(-6)).join(',')}`)
  if (selInfo1.stillMountedCount === selInfo0.spannedIds.length) {
    log('      ③ ⇒ **没能复现**：demo 这一版虚拟化在滚动后**没有把被选中的块卸载**（那 4 块还在 DOM 里）')
    log('         —— 也就是说「滚走 ⇒ 选区投影消失」在本实现下**根本没被触发**；原生高亮还在。这条要等真·滚动联动接进来才会暴露。')
  } else {
    log('      ③ ⇒ 复现：被选中的块被卸载 ⇒ 它们上面的原生高亮**随 DOM 一起消失**（Selection 对象还在，但没有像素可画）⇒ 必须自绘选区高亮层')
  }
  log(`      ④ 组合中：${JSON.stringify(midCompose)}`)
  log(`      ④ 滚出窗口后：目标块还挂着=${afterScroll.stillMounted} mounted=${afterScroll.mountedCount} composing=${afterScroll.isComposing} 模型里带预编辑串的块=${afterScroll.blocksWithPreedit}`)
  log(`      ④ 提交后：目标块文本="${afterCommit.targetText}"（块还在=${afterCommit.targetSurvived}，共 ${afterCommit.totalBlocks} 块）`)
  log(`      ④ 提交的「中文」落在 ${afterCommit.committedCount} 块上：${JSON.stringify(afterCommit.committedAt)}`)
  log(`      ④ 预编辑串 zhongwen 还留在模型里：${JSON.stringify(afterCommit.preeditLeft)}`)
  /**
   * 这一档钉的是**组合期的卸载守卫**（`deferWhileComposing`）：
   *   · 组合中把承载块滚出窗口 ⇒ 块**仍挂载**（不许换/卸 DOM）；
   *   · 提交后文本落在**目标块自己**身上（不是漂到别的块）；
   *   · 预编辑串不留在模型里（提交取代了它）；
   *   · `composing` 收尾复位。
   * 反证：守卫去掉后这三条会一起红（`stillMounted=false`、落点漂移、`composing` 卡住）。
   */
  assert(afterScroll.stillMounted === true,
    `组合期承载块被卸载了（stillMounted=${afterScroll.stillMounted}）——守卫没生效`)
  assert(afterCommit.isComposing === false, `组合结束后 composing 没复位：${afterCommit.isComposing}`)
  assert(afterCommit.committedAt.length === 1 && afterCommit.committedAt[0].id === targetId.slice(-6),
    `提交落点漂移：期望落在 ${targetId.slice(-6)}，实际 ${JSON.stringify(afterCommit.committedAt)}`)
  assert(afterCommit.preeditLeft.length === 0,
    `预编辑串残留在模型里：${JSON.stringify(afterCommit.preeditLeft)}`)
  assert(virt.mounted < n, `虚拟化没卸载东西：mounted=${virt.mounted} 块数=${n}`)
  return `③ 本实现下**没能复现**投影消失（被选中的 ${selInfo0.spannedIds.length} 块滚动后仍挂着 ${selInfo1.stillMountedCount} 块）；④ 组合期滚动**未卸载**承载块（守卫生效）⇒ 提交落在目标块、无残留预编辑串、composing 已复位`
})

/* ═══════════════════════════════════════════════════ 汇总 */

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} 通过\n`)
for (const r of results.filter((x) => !x.ok)) log(`  FAIL ${r.name}：${r.msg}`)

writeFileSync(join(CACHE, 'electron-smoke.log'), transcript.join('\n') + '\n')
console.log(`证据全文：${join(CACHE, 'electron-smoke.log')}`)

process.exit(passed === results.length ? 0 : 1)
