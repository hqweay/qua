/**
 * 对照实验：**同样的 CDP IME 序列打在裸 contenteditable 上，会不会也断组合？**
 *
 * 背景：`probe-ime-live.mjs` 的 S3/S4（空块里敲拼音）出现**两次 compositionstart**，
 * 第一个字母被冻成正文。要判断这是「app 的锅」还是「CDP/Chromium 在空内容上的固有行为」，
 * 必须有这一档对照——四种起点各打一遍同样的序列：
 *   A 有文本的光标（app 里的正常块）
 *   B 裸 `<div contenteditable>` 里已经有一个文本节点
 *   C 裸 `<div contenteditable><br></div>`（空行）
 *   D 裸 `<div contenteditable>` 里先放一个文本节点、再由 JS 塞一个 `<span>` 占位（模拟 data-ph）
 *
 * 用法：node checks/probe-ime-control.mjs
 * ⚠️ 诊断探针，不进 gate。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-control')
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
await sleep(600)
const cdp = await page.context().newCDPSession(page)

await page.evaluate(() => {
  window.__ev = []
  for (const ty of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    window.addEventListener(ty, (e) => window.__ev.push(`${ty}${e.data !== undefined && e.data !== null ? `(${JSON.stringify(e.data)})` : ''}${e.inputType ? `[${e.inputType}]` : ''}`), { capture: true })
  }
})

async function run(label, setup) {
  await page.evaluate((src) => {
    document.querySelectorAll('.ime-ctrl').forEach((el) => el.remove())
    const box = document.createElement('div')
    box.className = 'ime-ctrl'
    box.style.cssText = 'position:fixed;left:8px;top:8px;z-index:99999;background:#fff;font:16px/1.4 system-ui;padding:8px'
    box.contentEditable = 'true'
    box.id = 'ime-ctrl'
    // eslint-disable-next-line no-new-func
    new Function('box', src)(box)
    document.body.appendChild(box)
    box.focus()
    window.__ev = []
  }, setup)
  await sleep(200)
  for (const s of ['n', 'ni', 'nih', 'niha', 'nihao']) {
    await cdp.send('Input.imeSetComposition', { text: s, selectionStart: s.length, selectionEnd: s.length })
    await sleep(45)
  }
  await cdp.send('Input.insertText', { text: '你好' })
  await sleep(250)
  const out = await page.evaluate(() => ({
    text: document.getElementById('ime-ctrl')?.textContent,
    ev: window.__ev,
  }))
  const starts = out.ev.filter((e) => e.startsWith('compositionstart')).length
  log(`\n${label}`)
  log(`  结果 text=${JSON.stringify(out.text)}   compositionstart 次数=${starts}`)
  log(`  ${out.ev.join(' → ')}`)
  return starts
}

const A = await run('A 裸框 · 已有文本节点', 'box.textContent = "abc"; const r=document.createRange(); r.selectNodeContents(box); r.collapse(false); const s=getSelection(); s.removeAllRanges(); s.addRange(r);')
const B = await run('B 裸框 · 只有 <br>', 'box.innerHTML = "<br>"; const r=document.createRange(); r.setStart(box,0); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r);')
const C = await run('C 裸框 · 空（无子节点）', 'box.innerHTML = ""; box.focus();')
const D = await run('D 裸框 · data-ph 占位（::before）', 'box.innerHTML = "<br>"; box.dataset.ph="空块"; const st=document.createElement("style"); st.textContent=".ime-ctrl[data-ph]::before{content:attr(data-ph);opacity:.4}"; document.head.appendChild(st); const r=document.createRange(); r.setStart(box,0); r.collapse(true); const s=getSelection(); s.removeAllRanges(); s.addRange(r);')

log('\n══════ 结论 ══════')
log(JSON.stringify({ A, B, C, D, 'B/C/D 也出现两次 compositionstart ⇒ 是 Chromium 空内容上的固有行为，不是 app 的锅': (B > 1 || C > 1 || D > 1) }, null, 2))
await app.close()
