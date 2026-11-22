/**
 * 探针：种子里两块**新能力样本**在真浏览器里真的成立吗。
 *
 *   ① 「候选功能」＝普通容器块上的表格看法：打开「每周复盘」，那一行下面应当是表格
 *      （`.view-table` 一类），抬头那颗「看法」按钮写着「表格」；
 *   ② 圈住父块的事件自动化：在它下面新建一行，出生即被打上「功能」标签
 *      （行尾 chip 出现，且模型里 `_tags` 有那条边）。
 *
 * 用法：`pnpm build:test` 后 `node checks/probe-seed-view-auto.mjs`
 * ⚠️ 诊断探针，不进 gate。
 */
import { freshPage, launch, resolveBase } from '../scripts/harness.mjs'

const { base, mode, server } = await resolveBase()
console.log(`base: ${base} (${mode})`)
const browser = await launch()
const { ctx, page } = await freshPage(browser, base)
await page.waitForTimeout(600)

const out = await page.evaluate(async () => {
  const q = window.__qua
  q.quiet(true)
  const pageId = q.pages().find((p) => (p.title ?? '') === '每周复盘')?.id ?? ''
  if (pageId) await q.invoke('core.page/open', { pageId })
  return { pageId, pages: q.pages().map((p) => p.title) }
})
console.log('pages:', JSON.stringify(out.pages))
if (!out.pageId) throw new Error('种子里没有「每周复盘」页')
await page.waitForTimeout(700)

/** ① 表格看法：找那一行，读它下面的身体 */
const view = await page.evaluate(() => {
  const q = window.__qua
  const all = q.allBlocks()
  const backlog = all.find((b) => b.text.trim() === '候选功能')
  const row = backlog ? document.querySelector(`[data-block-id="${backlog.id}"]`) : null
  const box = row?.closest('.blk') ?? row
  return {
    id: backlog?.id ?? '',
    html: box ? box.outerHTML.slice(0, 1600) : '',
    hasTable: Boolean(box?.querySelector('table, .vt-row, [data-view-body-for]')),
    viewBtn: box?.querySelector('.qv-view-current .qv-view-current-label')?.textContent ?? '',
    rows: box ? box.querySelectorAll('.vt-row, tbody tr').length : 0,
  }
})
console.log('① 候选功能:', JSON.stringify({ id: view.id, hasTable: view.hasTable, viewBtn: view.viewBtn, rows: view.rows }, null, 1))

/** ② 自动化：在「候选功能」下新建一行，看它有没有被打上「功能」标签 */
const auto = await page.evaluate(async () => {
  const q = window.__qua
  const inv = (n, a = {}) => q.invoke(n, a)
  const backlog = q.allBlocks().find((b) => b.text.trim() === '候选功能')
  if (!backlog) return { err: 'no backlog' }
  const before = q.allBlocks().length
  await inv('core.tree/insert-child', { parentId: backlog.id, text: '探针新建的一行' })
  await new Promise((r) => setTimeout(r, 400))
  const fresh = q.allBlocks().find((b) => b.text.trim() === '探针新建的一行')
  const tag = q.allBlocks().find((b) => b.lists?.includes('tag') && (b.aliases?.[0] ?? b.text) === '功能')
  return {
    created: Boolean(fresh),
    added: q.allBlocks().length - before,
    tagId: tag?.id ?? '',
    freshTags: fresh ? q.__editor.store.find(fresh.id)?.props?._tags ?? [] : [],
    freshText: fresh?.text ?? '',
  }
})
console.log('② 自动化:', JSON.stringify(auto, null, 1))

await ctx.close()
await browser.close()
server?.close()
