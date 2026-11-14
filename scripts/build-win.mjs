/**
 * `pnpm build:win` 的最后一步：electron-builder 出 Windows 安装包（NSIS，x64）。
 * target 配置在 package.json 的 build 段里，CLI 不传 `--dir`（它会硬压成只出目录）。
 *
 * 与 `build-mac.mjs` 同一套取舍（两边各写一份而不是共享，因为 CLI 参数与注释都钉在
 * 各自平台）：
 *   1. **不签名**：清掉证书自动发现，没有证书也别去钥匙串/证书库翻。
 *   2. **不发布**：`--publish never`——上传 Release 是流水线最后一个 job 的事。
 *   3. **缓存落在仓内**：见 resolveCacheEnv()。
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
 * 下载缓存落在哪（与 `build-mac.mjs` 同一份逻辑）：
 * 默认 `~/Library/Caches/electron{,-builder}`；不可写就把孩子的 `HOME` 挪到仓内
 * `.cache/home`（`os.homedir()` 与 `env-paths` 都读 `HOME`，两个库一起跟过去）。
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
if (home !== 'real') console.log(`[build:win] 缓存目录不可写 ⇒ 把缓存与 HOME 挪进仓内：${home}`)

const bin = require.resolve('electron-builder/out/cli/cli.js')

const child = spawn(process.execPath, [bin, '--win', '--x64', '--publish', 'never'], {
  stdio: 'inherit',
  cwd: root,
  env,
})
child.on('exit', (code, signal) => {
  if (signal) console.error(`[build:win] 被信号打断：${signal}`)
  process.exit(code ?? 1)
})
