/**
 * `pnpm check:bundle` —— 验**打出来的那个 `.app`**（不是 `dist/`，也不是 dev server）。
 *
 * 它多验三件只有打包后才会踩到的事：
 *   ① `app.getPath('userData')` 落在哪（必须是 `…/net.leay.qua`，**不能是中文路径**）；
 *   ② 六个数据子目录 + 目录说明真的被建出来/写出来了；
 *      —— 说明文件是从 **asar 里**读出来的，这条最容易被「打包时忘了 files 白名单」悄悄弄坏；
 *   ③ preload 的壳面与 MessageChannel 端口中转在 asar 里照样通。
 *
 * 用法：先 `pnpm build:mac`，再 `pnpm check:bundle`。
 */
import { _electron } from 'playwright-core'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP = join(ROOT, 'release', 'mac-arm64', '相.app')
const EXE = join(APP, 'Contents', 'MacOS', '相')
const DATA = join(ROOT, '.cache', 'bundle-userdata')
const DATA_DIRS = ['kb', 'logs', 'cache', 'plugins', 'backups', 'tmp']

const results = []
function log(...a) {
  console.log(a.join(' '))
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

log(`\n打包产物冒烟：${APP}\n`)

assert(existsSync(EXE), `找不到可执行文件：${EXE}（先跑 pnpm build:mac）`)

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
rmSync(DATA, { recursive: true, force: true })
mkdirSync(DATA, { recursive: true })

let app
try {
  app = await _electron.launch({
    executablePath: EXE,
    // 打包后的 app 不吃 args[0]=app 路径；只传开关。
    // 沙箱会话里 $HOME 不可写 ⇒ 把 userData 指到仓内（也顺带证明 --user-data-dir 仍然优先）。
    args: [`--user-data-dir=${DATA}`, '--no-sandbox', '--disable-gpu'],
    env: cleanEnv,
  })
} catch (e) {
  log(`\x1b[31mFATAL\x1b[0m 打包产物起不来：${e?.message ?? e}`)
  process.exit(1)
}

const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`)
})
await page.waitForFunction(() => Boolean(window.__demo))

await check('B1 打包产物能启动、加载 asar 里的页面、无报错', async () => {
  const url = page.url()
  const info = await page.evaluate(() => window.kb.shellInfo())
  log(`      URL=${url}`)
  log(`      shellInfo=${JSON.stringify(info)}`)
  assert(url.includes('app.asar') || url.includes('/dist/index.html'), `URL 不像打包产物：${url}`)
  assert(info.name === '相', `显示名应为「相」，实际 ${info.name}`)
  assert(info.slug === 'qua', `英文名应为 qua，实际 ${info.slug}`)
  assert(info.appId === 'net.leay.qua', `appId 应为 net.leay.qua，实际 ${info.appId}`)
  assert(info.isDev === false, '打包产物不该认为自己跑在 dev 里')
  assert(!errors.length, `页面报错：${errors.join(' | ')}`)
  return `Electron ${info.electron} / Chromium ${info.chrome}；name=${info.name}，appId=${info.appId}`
})

await check('B2 userData＝appData/net.leay.qua（纯 ASCII），且 --user-data-dir 仍然优先', async () => {
  const info = await page.evaluate(() => window.kb.shellInfo())
  // `app.getPath('appData')` 不受 userData 覆盖影响 ⇒ 能算出「不覆盖时会落在哪」
  const appData = await app.evaluate(({ app: a }) => a.getPath('appData'))
  const defaultUserData = join(appData, 'net.leay.qua')
  const isAscii = (s) => /^[\x20-\x7E]+$/.test(s)
  log(`      appData（不受覆盖影响）        = ${appData}`)
  log(`      ⇒ 默认 userData（不传开关时）  = ${defaultUserData}`)
  log(`      本次实际 userData（传了开关）  = ${info.userData}`)
  log(`      默认路径纯 ASCII=${isAscii(defaultUserData)}；实际路径纯 ASCII=${isAscii(info.userData)}`)
  assert(defaultUserData.endsWith('/net.leay.qua'), `默认 userData 结尾应为 /net.leay.qua：${defaultUserData}`)
  assert(isAscii(defaultUserData), `默认 userData 出现非 ASCII（中文 productName 漏进路径）：${defaultUserData}`)
  assert(info.userData === DATA, `--user-data-dir 应优先于显式 setPath：${info.userData} ≠ ${DATA}`)
  return `默认＝${defaultUserData}（**纯 ASCII**）；命令行 --user-data-dir 仍然优先（自检就靠它把数据关在仓内）`
})

await check('B3 六个数据子目录 + 目录说明都落地了（说明是从 asar 里读出来拷的）', async () => {
  const missing = DATA_DIRS.filter((d) => !existsSync(join(DATA, d)))
  const rootReadme = existsSync(join(DATA, 'README.md'))
  const kbReadme = existsSync(join(DATA, 'kb', 'README.md'))
  log(`      目录：${DATA_DIRS.map((d) => `${d}${existsSync(join(DATA, d)) ? '✓' : '✗'}`).join(' ')}`)
  log(`      README.md=${rootReadme}  kb/README.md=${kbReadme}`)
  if (rootReadme) log(`      README 首行 = ${readFileSync(join(DATA, 'README.md'), 'utf8').split('\n')[0]}`)
  assert(!missing.length, `缺目录：${missing.join(',')}`)
  assert(rootReadme && kbReadme, 'asar 里的目录说明没被拷出来（检查 build.files 是否漏了 electron/userdata/**）')
  return `${DATA_DIRS.length} 个目录齐；README.md / kb/README.md 均从 asar 读出并写入（**纯 ASCII 路径**）`
})

await check('B4 preload 面 + MessageChannelMain 端口骨架在 asar 里照样通', async () => {
  const surfaces = await page.evaluate(() => ({
    kb: typeof window.kb,
    attach: typeof window.kb?.kernel?.attach,
    nodeRequire: typeof window.require,
    nodeProcess: typeof window.process,
  }))
  const got = await page.evaluate(async () => {
    const link = await window.kb.kernel.attach()
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('3s 没回包')), 3000)
      link.onMessage((d) => {
        clearTimeout(t)
        resolve(d)
      })
      link.post({ id: 7, type: 'kb/ping' })
    })
  })
  log(`      页面可见面=${JSON.stringify(surfaces)}`)
  log(`      端口往返=${JSON.stringify(got)}`)
  assert(surfaces.nodeRequire === 'undefined' && surfaces.nodeProcess === 'undefined', '打包后页面里看得到 Node ⇒ 壳安全配错了')
  assert(got?.stub === true && got?.id === 7, `端口中转没通：${JSON.stringify(got)}`)
  return '页面无 Node；attach() → postMessage → 主进程 stub 回声 往返成功'
})

await app.close()

const passed = results.filter((r) => r.ok).length
log(`\n${passed}/${results.length} 通过\n`)
for (const r of results.filter((x) => !x.ok)) log(`  FAIL ${r.name}：${r.msg}`)
process.exit(passed === results.length ? 0 : 1)
