/**
 * 形状矩阵：**在 app 的编辑容器里手工造块，逐个摘变量，看哪一个让组合断掉。**
 *
 * 已经排除的：DOM 改动（`probe-ime-mutstack.mjs` 0 条）、选区/焦点/吞事件（同上 0 条）、
 * `syncFromDom`/`emitChange`/`syncSel`/`markCaret`（`probe-ime-bisect.mjs` 逐个置空都没救回来）。
 * 所以剩下的是**形状**：`.tx` 里是 `<br>` 还是文本节点、有没有 `data-ph`、宿主有没有 `data-caret`、
 * 宿主是不是嵌套 contenteditable。
 *
 * 用法：node checks/probe-ime-matrix.mjs
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-matrix')
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

/** 在编辑容器里造一个假块并落光标；返回是否断组合 */
async function trial(label, opt) {
  await page.evaluate((o) => {
    document.querySelectorAll('.ime-fake').forEach((e) => e.remove())
    const ed = window.__qua.__editor
    const box = document.createElement('div')
    box.className = 'ime-fake blk'
    box.dataset.depth = '1'
    box.style.setProperty('--depth', '1')
    if (o.hostCE) box.contentEditable = 'true'
    if (o.caret) box.dataset.caret = '1'
    // 真块的 `.tx` 前面有两个 contenteditable=false 的孤岛（rails 导轨 / left 块标）
    if (o.islands) {
      for (const cls of ['rails', 'left']) {
        const isl = document.createElement('span')
        isl.className = cls
        isl.contentEditable = 'false'
        isl.setAttribute('aria-hidden', 'true')
        isl.textContent = ''
        box.appendChild(isl)
      }
    }
    const tx = document.createElement('span')
    tx.className = 'tx'
    if (o.ph) tx.dataset.ph = '空块'
    if (o.br) tx.innerHTML = '<br>'
    else tx.textContent = o.text ?? ''
    box.appendChild(tx)
    ed.container.appendChild(box)
    const r = document.createRange()
    if (o.atEnd && tx.firstChild) { r.setStart(tx.firstChild, (o.text ?? '').length); r.collapse(true) }
    else { r.setStart(tx, 0); r.collapse(true) }
    const s = getSelection()
    s.removeAllRanges()
    s.addRange(r)
    ;(o.hostCE ? box : ed.container).focus()
    window.__ev = []
  }, opt)
  await sleep(200)
  for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await sleep(45)
  }
  await cdp.send('Input.insertText', { text: '你好' })
  await sleep(220)
  const out = await page.evaluate(() => {
    const el = document.querySelector('.ime-fake')
    return { text: el?.querySelector('.tx')?.textContent, starts: window.__ev.filter((e) => e === 'compositionstart').length }
  })
  const clean = out.starts === 1 && out.text === (opt.text ?? '') + '你好'
  log(`  ${clean ? '✅' : '❌'} ${label.padEnd(46)} text=${JSON.stringify(out.text)} compositionstart×${out.starts}`)
  return clean
}

log('\n══════ 形状矩阵（宿主＝编辑容器里的手工块）══════')
await trial('1  <br> ＋ data-ph ＋ data-caret（＝真块形状）', { br: true, ph: true, caret: true })
await trial('2  <br> ＋ data-ph（无 data-caret）', { br: true, ph: true })
await trial('3  <br>（无 data-ph）', { br: true })
await trial('4  <br> ＋ data-ph ＋ 宿主 contenteditable', { br: true, ph: true, caret: true, hostCE: true })
await trial('5  文本节点 abc，光标在开头', { text: 'abc' })
await trial('6  文本节点 abc，光标在末尾', { text: 'abc', atEnd: true })
await trial('7  文本节点 abc ＋ data-ph，光标在开头', { text: 'abc', ph: true })
await trial('8  <br> ＋ data-ph ＋ 前面两个 CE=false 孤岛', { br: true, ph: true, caret: true, islands: true })
await trial('9  <br> ＋ 前面两个 CE=false 孤岛（无 data-ph）', { br: true, caret: true, islands: true })
await trial('A  文本 abc ＋ 前面两个 CE=false 孤岛，光标在开头', { text: 'abc', caret: true, islands: true })

/* 基准：app 里真的空块 */
const target = await page.evaluate(() => {
  const b = window.__qua.blocks().find((x) => x.text && x.text.length > 2)
  return b ? { id: b.id } : null
})
await page.evaluate((id) => { document.querySelectorAll('.ime-fake').forEach((e) => e.remove()); window.__qua.focusBlock(id, 999); window.__ev = [] }, target.id)
await sleep(300)
await page.keyboard.press('Enter')
await sleep(200)
await page.evaluate(() => { window.__ev = [] })
for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
  await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
  await sleep(45)
}
await cdp.send('Input.insertText', { text: '你好' })
await sleep(220)
const base = await page.evaluate(() => {
  const ed = window.__qua.__editor
  const id = ed.caretBlock() ?? ed.sel?.aBlock
  return { text: id ? window.__qua.blocks().find((x) => x.id === id)?.text : null, starts: window.__ev.filter((e) => e === 'compositionstart').length }
})
log(`  ${base.starts === 1 ? '✅' : '❌'} ${'Z 基准：app 里真的空块'.padEnd(46)} text=${JSON.stringify(base.text)} compositionstart×${base.starts}`)

await app.close()
