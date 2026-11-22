/**
 * 英文首屏截图——给英文 README 与演示站用。
 *
 * 与 `screenshot.mjs` 分开：那份按**中文种子文本**定位块（英文种子里没有这些字），
 * 这里只拍「打开就是英文首屏」这一件事，不按文本找块，避免维护两份按语言的定位器。
 * 用法：`QUA_LOCALE=en pnpm build:test && QUA_LOCALE=en node scripts/screenshot-en.mjs`
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { freshPage, launch, resolveBase, shot } from './harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.resolve('./harness.mjs')))
const VIEW = { width: 1440, height: 900 }

if (process.env.QUA_LOCALE !== 'en') throw new Error('set QUA_LOCALE=en to shoot English UI')

const { base, mode, server } = await resolveBase()
const browser = await launch()
await mkdir(SHOTS, { recursive: true })
const written = []

const { ctx, page, errors } = await freshPage(browser, base, { viewport: VIEW })
try {
  await page.evaluate(() => window.__qua.quiet(true))
  await page.evaluate(() => {
    document.querySelectorAll('#badge, #badge-panel, #state-menu-btn, #status').forEach((el) => el.remove())
  })
  await page.waitForTimeout(240)
  const file = `${SHOTS}readme-hero-en.png`
  await shot(page, file)
  written.push('readme-hero-en.png')
  if (errors.length) console.log(`  ⚠ ${errors.join(' | ')}`)
} finally {
  await ctx.close()
}

console.log(`英文截图（${mode}）：${written.join(', ')}`)
await browser.close()
if (server) server.close()
