/**
 * 生成应用图标 `build/icon.icns`。
 *
 * 一份 SVG 源渲染成 1024px PNG，再由 macOS 自带的 `sips` ＋ `iconutil` 切出全套尺寸。
 * 依赖：`playwright-core`（已在依赖里）＋ 系统 Chrome（`QUA_CHROME` 可指定）。
 * 换图标＝改下面的 SVG，重跑一遍；产物直接进 `build/`，被 electron-builder 的 `mac.icon` 读走。
 *
 *   node scripts/make-icon.mjs
 */
import { chromium } from 'playwright-core'
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const outDir = join(root, 'build')
const chrome =
  process.env.QUA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const SVG = `\
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <!-- macOS 图标画布留出系统级圆角余量；底色墨黑，字用纸色——黑白两态都站得住 -->
  <rect width="1024" height="1024" rx="224" fill="#211E19"/>
  <rect x="24" y="24" width="976" height="976" rx="204" fill="none" stroke="#F2EDE3" stroke-opacity="0.14" stroke-width="4"/>
  <text x="512" y="512" text-anchor="middle" dominant-baseline="central"
        font-family="Songti SC, STSong, serif" font-size="560" fill="#F2EDE3">相</text>
</svg>
`

// macOS icns 要求的全套尺寸（@2x 是 hidpi 变体，同一张源缩放）
const SIZES = [16, 32, 64, 128, 256, 512, 1024]

for (const p of [chrome]) {
  try {
    accessSync(p, constants.X_OK)
  } catch {
    console.error(`找不到 Chrome：${p}（用 QUA_CHROME 指一个）`)
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
const tmp = mkdtempSync(join(tmpdir(), 'qua-icon-'))
const iconset = join(tmp, 'icon.iconset')
mkdirSync(iconset)

try {
  const browser = await chromium.launch({ executablePath: chrome, headless: true })
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(`<body style="margin:0">${SVG}</body>`)
  await page.screenshot({ path: join(tmp, 'icon-1024.png') })
  await browser.close()

  // iconset 的命名规则：icon_<w>x<w>.png 与 icon_<w>x<w>@2x.png（@2x 的实际像素是 w*2）
  for (const s of SIZES) {
    for (const [name, px] of [
      [`icon_${s}x${s}.png`, s],
      [`icon_${s}x${s}@2x.png`, s * 2],
    ]) {
      if (px > 1024) continue
      execFileSync('sips', ['-z', String(px), String(px), join(tmp, 'icon-1024.png'), '--out', join(iconset, name)], { stdio: 'pipe' })
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(outDir, 'icon.icns')])
  console.log(`已生成 ${join(outDir, 'icon.icns')}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
