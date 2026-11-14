/**
 * 生成应用图标：`build/icon.icns`（mac）＋ `build/icon.ico`（Windows）＋ `build/icon.png`（512px，预览用）。
 *
 * 一份 SVG 源渲染成 1024px PNG，再由 macOS 自带的 `sips` ＋ `iconutil` 切出全套尺寸。
 * ico 在这里**自己装容器**（PNG 内嵌 ICO，Vista 起官方支持）：electron-builder 的
 * PNG→ico 转换工具是 CJS 写的，而本仓根是 `"type": "module"`——它被拉起来就死在
 * `require is not defined`（实测）。给足现成的 ico，那条路径根本不会跑。
 * 依赖：`playwright-core`（已在依赖里）＋ 系统 Chrome（`QUA_CHROME` 可指定）。
 * 换图标＝改下面的 SVG，重跑一遍；产物直接进 `build/`，被 electron-builder 的 `mac.icon`
 * 与 `win.icon` 读走。
 *
 *   node scripts/make-icon.mjs
 */
import { chromium } from 'playwright-core'
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  // ICO：各尺寸 PNG 内嵌进一个 ICO 容器。目录项 16 字节 ＋ 头 6 字节，尺寸 256 写 0（规范如此）
  const ICO_SIZES = [16, 32, 48, 64, 128, 256]
  const pngs = ICO_SIZES.map((s) => {
    const p = join(tmp, `ico-${s}.png`)
    execFileSync('sips', ['-z', String(s), String(s), join(tmp, 'icon-1024.png'), '--out', p], { stdio: 'pipe' })
    return { size: s, data: readFileSync(p) }
  })
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(pngs.length, 4)
  const entries = Buffer.alloc(16 * pngs.length)
  let offset = header.length + entries.length
  pngs.forEach((p, i) => {
    const e = entries.subarray(i * 16, i * 16 + 16)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 0)
    e.writeUInt8(p.size >= 256 ? 0 : p.size, 1)
    e.writeUInt8(0, 2) // 调色板色数：PNG 内嵌不用
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bitCount
    e.writeUInt32LE(p.data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += p.data.length
  })
  writeFileSync(join(outDir, 'icon.ico'), Buffer.concat([header, entries, ...pngs.map((p) => p.data)]))

  // 512px PNG：预览与文档引用用（打包已不再依赖它，ico 自己装好了）
  execFileSync('sips', ['-z', '512', '512', join(tmp, 'icon-1024.png'), '--out', join(outDir, 'icon.png')], { stdio: 'pipe' })
  console.log(`已生成 ${join(outDir, 'icon.icns')} / ${join(outDir, 'icon.ico')} / ${join(outDir, 'icon.png')}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
