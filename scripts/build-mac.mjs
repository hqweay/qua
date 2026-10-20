/**
 * `pnpm build:mac` 的最后一步：electron-builder 出 `.app`（target=dir）。
 *
 * 三个「本地自用」的取舍，都在这里显式钉住（而不是靠环境变量碰运气）：
 *   1. **不签名**：`mac.identity: null`（在 package.json 的 build 段里）＋ 这里清掉自动发现，
 *      否则 electron-builder 会去钥匙串里翻证书，翻不到就报错。
 *   2. **不公证**：没有 notarize 配置 ⇒ 不碰 Apple ID（代价：首次打开要右键→打开，见 README）。
 *   3. **缓存落在仓内**：见下面 resolveCacheEnv()。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, rmdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../', import.meta.url))

/**
 * 下载缓存落在哪。
 *
 * 默认 `~/Library/Caches/electron{,-builder}`。**本仓的沙箱不允许写 `$HOME/Library/Caches`**
 * （EPERM）⇒ electron-builder 会在下载完 100% 之后死在 `mkdir ~/Library/Caches/electron` 上
 * （最气人的一种失败：钱花了、包没出来）。所以：
 *   - 先探测 `$HOME/Library/Caches` 可不可写；
 *   - 不可写才把孩子的 `HOME` 挪到仓内 `.cache/home`（`os.homedir()` 与 `env-paths` 都读 `HOME`，
 *     所以两个库的默认缓存目录会一起落到仓里，不需要分别找各自的 env 开关）。
 * 普通机器上这一整段是空转。
 */
function resolveCacheEnv() {
  const env = {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    ELECTRON_BUILDER_CACHE: `${root}.cache/electron-builder`,
    electron_config_cache: `${root}.cache/electron`,
  }
  const probe = join(homedir(), 'Library', 'Caches', `qua-write-probe-${process.pid}`)
  try {
    mkdirSync(probe, { recursive: true })
    rmdirSync(probe)
    return { env, home: 'real' }
  } catch {
    const fakeHome = `${root}.cache/home`
    mkdirSync(join(fakeHome, 'Library', 'Caches'), { recursive: true })
    env.HOME = fakeHome
    return { env, home: fakeHome }
  }
}

const { env, home } = resolveCacheEnv()
if (home !== 'real') console.log(`[build:mac] $HOME/Library/Caches 不可写 ⇒ 把缓存与 HOME 挪进仓内：${home}`)

const bin = require.resolve('electron-builder/out/cli/cli.js')

const child = spawn(process.execPath, [bin, '--mac', '--arm64', '--dir', '--publish', 'never'], {
  stdio: 'inherit',
  cwd: root,
  env,
})
child.on('exit', (code, signal) => {
  if (signal) console.error(`[build:mac] 被信号打断：${signal}`)
  process.exit(code ?? 1)
})
