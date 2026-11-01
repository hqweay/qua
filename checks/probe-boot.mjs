import { launch } from '../scripts/harness.mjs'
const base = process.env.PROBE_BASE ?? 'http://localhost:5181/'
const browser = await launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('console', (m) => console.log('[console]', m.type(), m.text()))
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(base, { waitUntil: 'load' })
await page.waitForTimeout(3000)
console.log('__qua?', await page.evaluate(() => Boolean(window.__qua)))
console.log('body:', (await page.evaluate(() => document.body.innerText)).slice(0, 500))
await page.screenshot({ path: '/tmp/probe-boot.png' })
await browser.close()
