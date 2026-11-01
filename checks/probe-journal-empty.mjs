/**
 * 探针：journal 天把子块全删掉之后，还能不能新建。
 * 只读事实，不入断言表；跑 `node checks/probe-journal-empty.mjs`（需要一个带测试面的 dev server）。
 */
import { launch, freshPage, MOD } from '../scripts/harness.mjs'

const base = process.env.PROBE_BASE ?? 'http://localhost:5181/'
const DAY = process.env.PROBE_DAY ?? '2026-01-15'
const browser = await launch()
const { page } = await freshPage(browser, base, { dsf: 1 })
await page.waitForTimeout(400)

const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#editor .blk')].map((el) => ({
      id: (el.dataset.blockId ?? '(no-id)').slice(-6),
      depth: el.dataset.depth,
      role: el.dataset.role ?? '',
      ph: el.querySelector('.tx')?.dataset.ph ?? '',
      text: (el.querySelector('.tx')?.textContent ?? '').slice(0, 10),
      px: Math.round(el.getBoundingClientRect().y),
    })),
  )

const state = () =>
  page.evaluate(() => {
    const bs = window.__qua.blocks()
    const js = bs.filter((b) => b.roles?.includes('journal'))
    return {
      journals: js.map((j) => ({ id: j.id.slice(-6), children: j.children })),
      visible: bs.length,
      sel: window.__qua.ctxKeys?.().selection ?? null,
      focus: document.activeElement?.className ?? String(document.activeElement?.tagName),
    }
  })

const openDay = async (date) => {
  await page.evaluate((d) => window.__qua.invoke('core.journal/today', { date: d }), date)
  await page.waitForTimeout(250)
}

console.log('== 冷启动 ==', JSON.stringify(await state()))

// 打开一个还没写过的新天（单日）：装载边界应补一个空首子块
await openDay(DAY)
console.log('== 打开空天（单日） ==')
console.log(await rows(), JSON.stringify(await state()))
await page.screenshot({ path: '/tmp/probe-j1.png' })

// 删掉那唯一一个子块
const child = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#editor .blk')].find((e) => e.dataset.role !== 'journal')
  const r = el.getBoundingClientRect()
  return { x: r.x + 60, y: r.y + r.height / 2 }
})
await page.mouse.click(child.x, child.y)
await page.waitForTimeout(120)
await page.keyboard.press(`${MOD}+Shift+Backspace`)
await page.waitForTimeout(250)
console.log('== 删掉唯一子块之后 ==')
console.log(await rows(), JSON.stringify(await state()))
await page.screenshot({ path: '/tmp/probe-j2.png' })

// 点日期行下面的空白
const head = await page.evaluate(() => {
  const el = [...document.querySelectorAll('#editor .blk')].find((e) => e.dataset.role === 'journal')
  const r = el.getBoundingClientRect()
  return { x: r.x + 300, y: Math.round(r.bottom + 14) }
})
await page.mouse.click(head.x, head.y)
await page.waitForTimeout(250)
console.log('== 点日期下面空白之后 ==')
console.log(await rows(), JSON.stringify(await state()))
await page.screenshot({ path: '/tmp/probe-j3.png' })

// 重新打开这一天：装载边界会不会补
await openDay(DAY)
console.log('== 重新打开同一天之后 ==')
console.log(await rows(), JSON.stringify(await state()))

// 点空白
await page.mouse.click(head.x, head.y)
await page.waitForTimeout(250)
console.log('== 重开后再点空白 ==')
console.log(await rows(), JSON.stringify(await state()))

await browser.close()
