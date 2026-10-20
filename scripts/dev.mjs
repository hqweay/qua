/**
 * `pnpm dev` —— **vite 与 electron 一起起**（自己写，不引 concurrently / vite-plugin-electron 那类脚手架）。
 *
 * 顺序是硬要求：electron 主进程在 `loadURL` 那一刻 vite 必须已经在听，否则首屏白到用户手动刷新。
 * 所以这里**轮询到 5180 真能连上**才 spawn electron，而不是「等 1.5 秒大概好了」。
 *
 * 退出语义：electron 一退，vite 跟着退；Ctrl-C 两个都收掉。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))
const DEV_URL = 'http://127.0.0.1:5180/'

/**
 * ⚠️ 某些运行环境（agent 宿主本身就是 Electron 应用）会给子进程导出
 * `ELECTRON_RUN_AS_NODE=1`。带着它启动任何 Electron 二进制，Electron 会**退化成纯 Node**：
 * `require('electron')` 返回的是那个可执行文件路径字符串而不是 API ⇒ 主进程第一行 `ipcMain.on` 就炸。
 * 这是**环境**的坑（不是代码的），所以在这里统一剥掉，别让它传给孩子进程。
 */
const baseEnv = { ...process.env }
delete baseEnv.ELECTRON_RUN_AS_NODE

const children = []
let shuttingDown = false

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM')
  }
  process.exitCode = code ?? 0
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function run(cmd, args, opts = {}) {
  const c = spawn(cmd, args, { stdio: 'inherit', cwd: root, env: baseEnv, ...opts })
  children.push(c)
  return c
}

/* 1. 先把 electron/*.ts 编译出来（main.ts 改了要重启 pnpm dev，这里不做热重启） */
const build = run(process.execPath, [`${root}scripts/build-electron.mjs`])
build.on('exit', (code) => {
  if (code !== 0) {
    console.error('[dev] electron 侧编译失败，停在这里')
    shutdown(code ?? 1)
    return
  }
  startVite()
})

/* 2. vite */
function startVite() {
  const vite = run(process.execPath, [`${root}node_modules/vite/bin/vite.js`])
  vite.on('exit', (code) => {
    if (!shuttingDown) console.error(`[dev] vite 退出了（code=${code}）`)
    shutdown(code ?? 0)
  })
  waitForServer()
}

/* 3. 轮询到 vite 真的在听，再起 electron */
async function waitForServer() {
  const deadline = Date.now() + 30_000
  for (;;) {
    if (shuttingDown) return
    try {
      const r = await fetch(DEV_URL, { signal: AbortSignal.timeout(800) })
      if (r.ok) break
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) {
      console.error(`[dev] 等了 30s，${DEV_URL} 还是连不上，放弃`)
      shutdown(1)
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  console.log(`\n[dev] vite 已就绪 ⇒ 起 electron（vite 修过的代码热更新，electron/*.ts 改了要重跑 pnpm dev）\n`)
  startElectron()
}

/**
 * 「默认数据目录能不能写」探测。
 *
 * 不能写的时候（本仓的沙箱会话就是这样：`$HOME/Library/Caches`、`$HOME/Library/Application Support`
 * 一律 EPERM），Electron **连自己的 profile 都建不出来**，表现是「起来就退、日志里全是 ENOENT」，
 * 看着像代码坏了。所以这时把 `--user-data-dir` 挪进仓内——**只在探测失败时才动手**，
 * 普通机器上这一整段是空转。产品侧的默认路径不变（仍由 `main.ts` 显式钉成 `net.leay.qua`）。
 */
function ensureWritableUserData() {
  const probe = join(userDataBase(), `qua-dev-probe-${process.pid}`)
  try {
    mkdirSync(probe, { recursive: true })
    rmdirSync(probe)
    return null
  } catch {
    const dir = join(root, '.cache', 'dev-userdata')
    mkdirSync(dir, { recursive: true })
    console.warn(
      `[dev] 默认数据目录不可写（${userDataBase()}）⇒ 本次把 --user-data-dir 指到 ${dir}\n` +
        '      （环境妥协：沙箱会话 / 只读 HOME；产品默认路径不变）',
    )
    return [`--user-data-dir=${dir}`]
  }
}

function userDataBase() {
  return join(homedir(), 'Library', 'Application Support')
}

/**
 * 起了又秒退的情况里，最常见的一种是**本机不允许 Chromium 的沙箱落地**
 * （容器 / CI / 无真实 window server 的会话；日志里是
 * `sandbox initialization failed: Operation not permitted` 然后
 * `FATAL: GPU process isn't usable. Goodbye.`）。
 * 这不是代码问题，所以这里**自动降级重试一次**（`--no-sandbox --disable-gpu`），
 * 并且**只重试一次**、把话说清楚——绝不静默地把沙箱关掉。
 */
let sandboxRetried = false

function startElectron(extraArgs = [...(ensureWritableUserData() ?? [])]) {
  const startedAt = Date.now()
  const child = spawn(require('electron'), [root, ...extraArgs], {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: root,
    env: { ...baseEnv, KB_DEV_SERVER_URL: DEV_URL },
  })
  children.push(child)
  let tail = ''
  child.stdout.on('data', (d) => process.stdout.write(d))
  child.stderr.on('data', (d) => {
    tail = (tail + d).slice(-4000)
    process.stderr.write(d)
  })
  child.on('exit', (code) => {
    // 两个条件都要：① 日志里有沙箱特征 ② **活得很短**。
    // 少了 ②，一台正常机器上「跑了一小时后用户 ⌘Q」也会因为 stderr 里偶然出现过这句话而被重开一次。
    const looksLikeSandbox =
      Date.now() - startedAt < 20_000 && /sandbox initialization failed|GPU process isn't usable/.test(tail)
    if (!sandboxRetried && looksLikeSandbox && !shuttingDown) {
      sandboxRetried = true
      console.warn(
        '\n[dev] 看起来是「本机不允许 Chromium 沙箱落地」⇒ 自动加 --no-sandbox --disable-gpu 重试一次\n' +
          '      （这是**环境**的妥协，不是产品行为；普通 macOS 上不会走到这条路）\n',
      )
      startElectron([...extraArgs, '--no-sandbox', '--disable-gpu'])
      return
    }
    console.log(`[dev] electron 退出了（code=${code}）`)
    shutdown(code ?? 0)
  })
}
