/**
 * 探针：点左槽「回到今日」命令小卡之后，中心是不是空了。
 *
 * 不进 gate。跑法：`QUA_NO_DEV=1 node checks/probe-today-blank.mjs`
 */
import { freshPage, launch, resolveBase, MOD } from '../scripts/harness.mjs'

const { base, mode, server } = await resolveBase()
const browser = await launch()
console.log(`base=${base} mode=${mode}`)

const state = (page) =>
  page.evaluate(() => {
    const q = window.__qua
    const roots = q.__editor.doc.roots.map((b) => ({
      id: b.id.slice(-6),
      date: b.props?._date ?? '',
      children: b.children.length,
      text: (b.content ?? []).map((r) => r.text ?? '').join('').slice(0, 20),
    }))
    return {
      activeId: q.snapshot().activeId?.slice?.(-6) ?? '',
      feed: q.snapshot().feed,
      roots,
      rows: document.querySelectorAll('#editor .blk').length,
      title: document.querySelector('.tab.active, .tab[data-active="1"], #tabs .active')?.textContent?.trim() ?? '',
      editorText: (document.querySelector('#editor')?.textContent ?? '').trim().slice(0, 120),
    }
  })

const { ctx, page, errors } = await freshPage(browser, base)
await page.evaluate(() => window.__qua.quiet(true))
await page.waitForTimeout(250)
const tile = '#dock-left-stack > .dock-tile[data-card-id="cmd:core.journal/today"] .dock-tile-main'
const tileCount = await page.locator(tile).count()
console.log('① 冷启动', JSON.stringify(await state(page)), 'cmd小卡数=', tileCount)

await page.locator(tile).click()
await page.waitForTimeout(400)
console.log('② 点「回到今日」小卡', JSON.stringify(await state(page)))

await page.evaluate(() => window.__qua.invoke('core.journal/today'))
await page.waitForTimeout(400)
console.log('③ 命令 core.journal/today（无参）', JSON.stringify(await state(page)))

await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
await page.waitForTimeout(400)
console.log('④ 命令 core.journal/today（空对象）', JSON.stringify(await state(page)))

await page.keyboard.press(`${MOD}+t`)
await page.waitForTimeout(400)
console.log('⑤ 键位 mod+t', JSON.stringify(await state(page)))

// 从别的页点回来：换一个当前对象再回今日
await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[0].id }))
await page.waitForTimeout(300)
console.log('⑥ 先打开一页', JSON.stringify(await state(page)))
await page.locator(tile).click()
await page.waitForTimeout(400)
console.log('⑦ 从页点「回到今日」小卡', JSON.stringify(await state(page)))

// 未来天：引用日期会把还没到的天提前物化出来（日历卡上 25/26 那种圆点）
for (const d of ['2026-11-25', '2026-11-26', '2026-12-01']) {
  await page.evaluate((dt) => window.__qua.invoke('core.journal/today', { date: dt }), d)
  await page.waitForTimeout(120)
}
console.log('⑧ 物化三个未来天后', JSON.stringify(await state(page)))
await page.locator(tile).click()
await page.waitForTimeout(400)
console.log('⑨ 物化未来天后点「回到今日」', JSON.stringify(await state(page)))
await page.evaluate(() => window.__qua.invoke('core.journal/today', {}))
await page.waitForTimeout(400)
console.log('⑩ 物化未来天后直接跑命令', JSON.stringify(await state(page)))

console.log('页面错误', JSON.stringify(errors))
await ctx.close()
await browser.close()
server?.close()
