/**
 * 验收脚手架：`playwright-core` 驱动**系统 Chrome**（不下载浏览器，与 同法）。
 *
 * 优先连已经跑着的 `http://127.0.0.1:5180`（README 里那条 `pnpm dev`）；
 * 连不上就自己起一个静态服务托管 `dist/`（所以 `pnpm shots` 前先 `pnpm build`）。
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

/**
 * 用哪个 Chrome 跑冒烟。
 *
 * 为什么不写死一个路径：门禁（`pnpm gate`）不该只在这台机器上跑得起来。
 *   ⇒ 平台默认值 ＋ `QUA_CHROME` 覆盖（谁的机器上都能指到自己那份浏览器）。
 *   ⇒ CI 在 Linux 上跑，那里的 Chrome 由 runner 预装；macOS 上才是 `.app` 里那一份。
 */
function chromePath() {
  if (process.env.QUA_CHROME) return process.env.QUA_CHROME
  return process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.env.CHROME_BIN ?? '/usr/bin/google-chrome'
}

export const CHROME = chromePath()
const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** 静态服务：端口用 0（由系统挑空闲端口），并监听 error —— 否则端口被占时会静默挂住 */
function startStatic(root, port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x')
      let p = normalize(join(root, decodeURIComponent(url.pathname)))
      if (!p.startsWith(root)) {
        res.writeHead(403).end()
        return
      }
      let s = null
      try {
        s = await stat(p)
      } catch {
        s = null
      }
      if (s && s.isDirectory()) p = join(p, 'index.html')
      else if (!s && !extname(p)) p = join(p, 'index.html')
      let body
      try {
        body = await readFile(p)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' })
      res.end(body)
    } catch (e) {
      res.writeHead(500).end(String(e))
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

export async function resolveBase() {
  /**
   * ⚠️ **`QUA_NO_DEV=1` 强制走 `dist`**：并行车道（`git worktree`）里跑验收时，
   * 5180 上那个 dev server 往往属于**另一棵树**，连上去测的是别人的代码（真踩过：
   * 新加的 DOM 元素在页面里根本不存在，而报错看起来像「构建没生效」）。
   */
  const dev = 'http://127.0.0.1:5180/'
  if (!process.env.QUA_NO_DEV) {
    try {
      const r = await fetch(dev, { signal: AbortSignal.timeout(1200) })
      if (r.ok) return { base: dev, mode: 'dev(5180)', server: null }
    } catch {
      /* 没跑 dev server */
    }
  }
  try {
    await stat(join(DIST, 'index.html'))
  } catch {
    throw new Error('既没连上 5180，也没有 dist/：先 `pnpm dev` 或 `pnpm build`')
  }
  const server = await startStatic(DIST, 0)
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}/`, mode: `dist(:${port} 静态)`, server }
}

/**
 * 「⌘」在按键字符串里怎么写。
 *
 * 为什么不能写死 `Meta+`：`mod` 在本项目里是**按平台解析**的（`bindings.ts` 的 `eventKeyId`）
 *   —— macOS 上 `mod` ＝ ⌘（Meta），其它平台上是 Ctrl。
 * ⇒ 冒烟若写死 `Meta+`，在 Linux CI 上就会敲出**没有绑定**的组合键，表现为一整片
 *   「命令没生效」的假失败（看着像功能坏了，其实是敲错了键）。
 */
export const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

/**
 * 把 `'mod+shift+a'` 这样的**绑定表写法**翻成 Playwright 认的按键串。
 *
 * 为什么要多此一举：绑定表（`bindings.ts`）里的键位是**应用口径**
 * （`mod` 按平台解析、修饰键小写），而 `page.keyboard.press` 吃的是
 * **Playwright 口径**（`Meta`/`Control`/`Shift`/`Alt` 首字母大写、没有 `mod`）。
 * 两边各写一份就会分叉 —— 将来在 Linux CI 上改了平台默认值，
 * 冒烟里那二十来处写死的 `Meta+` 不会跟着变（那是**假绿**的温床）。
 */
const PW_MOD = { shift: 'Shift', alt: 'Alt', ctrl: 'Control', meta: 'Meta' }

export function key(k) {
  return k
    .split('+')
    .map((part) => {
      if (part === 'mod') return MOD
      return PW_MOD[part.toLowerCase()] ?? part
    })
    .join('+')
}

export async function launch() {
  return chromium.launch({ executablePath: CHROME, headless: true })
}

/** 每个场景一个干净 context ⇒ localStorage 为空 ⇒ 每次都是全新的假数据库 */
export async function freshPage(browser, base, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: opts.dsf ?? 2, locale: 'zh-CN' })
  return openPage(browser, ctx, base)
}

/**
 * 在**已存在的 context** 里开一页并等装配完成。
 *
 * `freshPage` 每次都新建 context（localStorage 干净）；要测「关掉重开」「同一个库换个后端」
 * 这类**跨页面生命周期**的事，就得复用同一份存储。
 */
export async function openPage(browser, ctx, base) {
  const page = await ctx.newPage()
  const errors = []
  // `QUA_TRACE_BOOT=1` ⇒ 把页面 console 原样打出来（排查「只读态是真是假」时用）
  page.on('console', (m) => {
    if (process.env.QUA_TRACE_BOOT) console.log(`[page] ${m.text()}`)
    if (m.type() === 'error') errors.push(`console: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  await page.goto(base, { waitUntil: 'load' })
  await page.waitForFunction(() => Boolean(window.__demo))
  return { browser, ctx, page, errors }
}

/**
 * **真的**关掉这一页，再从「关页后 context 里剩下的存储」复原同一份库并重开。
 *
 * 用来验收「关页那一刻有没有把待提交的那批发出去」。三条都是实测踩出来的：
 *   1. `page.reload()` 不算关闭（同一次文档生命周期的往返）；
 *   2. `ctx.close()` + `freshPage` 是**换了空库**（新 context 不共享 localStorage）；
 *   3. **不能在同一 context 里直接 `newPage()`**：实测那一页会看到**上一个文档的 storage 投影**
 *      （回看 `storageState()` 里已经是信封的新值，新页却读到 `null`），据此断言会得出完全错误的结论。
 *      ⇒ 用 `storageState()` 快照重建一个 context，才是「用户关掉再打开」看到的库。
 */
export async function reopenPage(browser, ctx, base, page) {
  // runBeforeUnload: true ⇒ 走真实的「页面关闭」流程（pagehide / beforeunload 会真的发出来）
  await page.close({ runBeforeUnload: true })
  await new Promise((r) => setTimeout(r, 120))
  const state = await ctx.storageState()
  await ctx.close()
  const next = await browser.newContext({ storageState: state })
  return openPage(browser, next, base)
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

export async function shot(page, file, opts = {}) {
  await page.screenshot({ path: file, fullPage: false, ...opts })
  return file
}
