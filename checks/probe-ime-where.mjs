/**
 * 落点矩阵：**把光标放在真块的不同位置，看哪一档断组合。**
 *
 * 前面已经排除：DOM 改动 / 选区 API / 吞事件 / 六个编辑器方法置空 / DOM 形状与 CSS。
 * 现在只剩「**app 里的真块**」与「手工假块」的差别，所以把光标位置当变量扫一遍，
 * 顺便把落点那一刻的 DOM 选区原样打出来，好跟假块对齐。
 *
 * 用法：node checks/probe-ime-where.mjs
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-where')
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
await sleep(700)
const cdp = await page.context().newCDPSession(page)
await page.evaluate(() => {
  window.__ev = []
  for (const ty of ['compositionstart', 'compositionend']) window.addEventListener(ty, (e) => window.__ev.push(ty), { capture: true })
})

const target = await page.evaluate(() => {
  const b = window.__qua.blocks().find((x) => x.text && x.text.length > 2)
  return b ? { id: b.id, text: b.text } : null
})
log(`目标块 …${target.id.slice(-6)}  "${target.text}"`)

const reset = () =>
  page.evaluate(({ id, text }) => {
    const ed = window.__qua.__editor
    const b = ed.store.find(id)
    b.content = [{ t: 'text', v: text }]
    ed.renderAll()
    window.__ev = []
  }, { id: target.id, text: target.text })

async function type() {
  for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await sleep(45)
  }
  await cdp.send('Input.insertText', { text: '你好' })
  await sleep(220)
}

const selSnap = () =>
  page.evaluate(() => {
    const s = getSelection()
    const n = s?.anchorNode
    const el = n?.nodeType === 3 ? n.parentElement : n
    return {
      anchor: n ? (n.nodeType === 3 ? `text("${(n.data ?? '').slice(0, 16)}")` : `${el?.tagName}.${String(el?.className ?? '').split(' ')[0]}`) : null,
      off: s?.anchorOffset,
      txText: el?.closest('.tx')?.textContent ?? null,
      txHtml: el?.closest('.tx')?.innerHTML ?? null,
      active: document.activeElement?.id || document.activeElement?.className,
    }
  })

async function trial(label, off) {
  await reset()
  await page.evaluate(({ id, off }) => window.__qua.focusBlock(id, off), { id: target.id, off })
  await sleep(400)
  const s = await selSnap()
  await type()
  const out = await page.evaluate((id) => ({
    text: window.__qua.blocks().find((x) => x.id === id)?.text,
    starts: window.__ev.filter((e) => e === 'compositionstart').length,
  }), target.id)
  log(`\n  ${out.starts === 1 ? '✅' : '❌'} ${label}  compositionstart×${out.starts}`)
  log(`     落点: ${JSON.stringify(s)}`)
  log(`     结果: ${JSON.stringify(out.text)}`)
}

log('\n══════ 落点矩阵（真块）══════')
await trial('T1 非空块 · 光标在开头(0)', 0)
await trial('T2 非空块 · 光标在 offset 1', 1)
await trial('T3 非空块 · 光标在末尾', target.text.length)

/* T4：把块清空后落光标 */
await page.evaluate(({ id }) => {
  const ed = window.__qua.__editor
  ed.store.find(id).content = []
  ed.renderAll()
  window.__ev = []
}, { id: target.id })
await page.evaluate((id) => window.__qua.focusBlock(id, 0), target.id)
await sleep(400)
const s4 = await selSnap()
await type()
const o4 = await page.evaluate((id) => ({ text: window.__qua.blocks().find((x) => x.id === id)?.text, starts: window.__ev.filter((e) => e === 'compositionstart').length }), target.id)
log(`\n  ${o4.starts === 1 ? '✅' : '❌'} T4 空块（把真块清空后落光标）  compositionstart×${o4.starts}`)
log(`     落点: ${JSON.stringify(s4)}`)
log(`     结果: ${JSON.stringify(o4.text)}`)

await app.close()
