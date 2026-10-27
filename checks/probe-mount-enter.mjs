/**
 * 探针：**在块底挂载区的「提及」里按 ↵，到底发生了什么？**
 *
 * 用户报：在今天的日记下写了一个子块 `- 2026年10月27日周二`，它出现在今天的「提及」里；
 * 在提及里按 ↵ ⇒ 块是建出来了，但**光标从提及跳到了正文**。
 *
 * 这一档把这件事按时间记下来：
 *   ① 建出这样一个子块，确认它真的进了「提及」；
 *   ② 在提及里落光标、按 ↵；
 *   ③ 看：焦点落哪个编辑宿主、新块挂在哪、提及里还剩几行。
 *
 * 用法：node checks/probe-mount-enter.mjs
 * ⚠️ 诊断探针，不进 gate。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'mount-enter')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const app = await _electron.launch({ args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'], env: cleanEnv })
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua?.quiet?.(true))
await sleep(900)

/** 找到今天（第一段）那个日记根块，以及它的 `.sec-mount` */
const sec = await page.evaluate(() => {
  const secs = Array.from(document.querySelectorAll('.sec'))
  for (const s of secs) {
    const mount = s.querySelector(':scope > .sec-mount')
    const first = s.querySelector(':scope > .blk')
    if (mount && first) return { head: first.textContent?.slice(0, 40) ?? '', hasMount: true }
  }
  return null
})
log(`第一段：head=${JSON.stringify(sec?.head)}  有挂载槽=${sec?.hasMount}`)

/**
 * 在本节头块下加一个子块，正文＝**头块的可读文本**（日记是日期投影，`.tx` 里没有，
 * 要用 `displayTextOf` 那一口径）。带上这段字才会命中「提及」的条件（`text: '$self'`）。
 */
const made = await page.evaluate(() => {
  const s = document.querySelector('.sec')
  const first = s.querySelector(':scope > .blk')
  const headId = first?.dataset.blockId
  const ed = window.__qua.__editor
  const parent = ed.store.find(headId)
  // 日记的可读文本＝日期标签（`core/alias.ts` 的 displayTextOf 那一支）
  const d = parent?.props?._date
  // 日记的可读标签＝「2026年10月28日周二」这种（`journalDateLabel` 的口径）
  const label = (iso) => {
    const [y, m, dd] = String(iso).split('-').map(Number)
    if (!y || !m || !dd) return String(iso ?? '')
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date(y, m - 1, dd))
  }
  const headText = typeof d === 'string' ? label(d) : (document.querySelector(`.blk[data-block-id="${headId}"] .tx`)?.textContent ?? '')
  const child = { id: 'probe-child-' + Math.random().toString(16).slice(2), content: [{ t: 'text', v: headText }], children: [], created: Date.now(), modified: Date.now() }
  parent.children.push(child)
  ed.store.invalidateIndex()
  ed.renderAll()
  return { headId, headText, childId: child.id, isJournal: Boolean(d) }
})
log(`建的子块 …${made.childId.slice(-8)}  正文="${made.headText}"  （宿主是日记=${made.isJournal}）`)
await sleep(400)

/** 切到「提及」栏 */
const tabInfo = await page.evaluate(() => {
  const mount = document.querySelector('.sec > .sec-mount')
  const tabs = Array.from(mount?.querySelectorAll('.mount-tab') ?? []).map((b) => b.textContent)
  const m = mount?.querySelector('.mount-tab[data-tab="mentions"]')
  m?.click()
  return tabs
})
log(`挂载区 tab：${JSON.stringify(tabInfo)}`)
await sleep(500)

const rowsBefore = await page.evaluate(() => {
  const ed = document.querySelector('.sec > .sec-mount .mount-editor')
  return Array.from(ed?.querySelectorAll('.blk') ?? []).map((b) => ({
    id: b.dataset.blockId?.slice(-8),
    text: b.querySelector('.tx')?.textContent ?? '',
  }))
})
log(`提及里的行（按 ↵ 之前）：${JSON.stringify(rowsBefore)}`)

/** 在提及的第一行末尾落光标 */
const focused = await page.evaluate(() => {
  const ed = document.querySelector('.sec > .sec-mount .mount-editor')
  const blk = ed?.querySelector('.blk')
  if (!blk) return null
  const tx = blk.querySelector('.tx')
  const r = document.createRange()
  r.selectNodeContents(tx)
  r.collapse(false)
  const s = getSelection()
  s.removeAllRanges()
  s.addRange(r)
  ed.focus?.()
  return { id: blk.dataset.blockId?.slice(-8), text: tx?.textContent }
})
log(`落光标到提及行：${JSON.stringify(focused)}`)
await sleep(300)

const activeBefore = await page.evaluate(() => {
  const a = document.activeElement
  return { tag: a?.tagName, cls: String(a?.className ?? ''), inMount: Boolean(a?.closest('.sec-mount')) }
})
log(`按 ↵ 前焦点：${JSON.stringify(activeBefore)}`)

await page.keyboard.press('Enter')
await sleep(600)

const after = await page.evaluate(() => {
  const a = document.activeElement
  const mount = document.querySelector('.sec > .sec-mount')
  return {
    active: { tag: a?.tagName, cls: String(a?.className ?? ''), inMount: Boolean(a?.closest('.sec-mount')) },
    mountRows: Array.from(mount?.querySelectorAll('.mount-editor .blk') ?? []).map((b) => ({ id: b.dataset.blockId?.slice(-8), text: b.querySelector('.tx')?.textContent ?? '' })),
  }
})
log(`\n按 ↵ 后焦点：${JSON.stringify(after.active)}`)
log(`按 ↵ 后提及里的行：${JSON.stringify(after.mountRows)}`)

/** 库里多出来的块挂在哪 */
const tree = await page.evaluate((childId) => {
  const found = window.__qua.blocks().filter((b) => !b.text || b.text === '')
  return found.slice(0, 6).map((b) => ({ id: b.id.slice(-8), text: b.text }))
}, made.childId)
log(`库里的空块（新建的那块应当在这里）：${JSON.stringify(tree)}`)

await app.close()
