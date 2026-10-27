/**
 * 探针：**组合期动 DOM，会不会把预编辑串冻结成正文？**
 *
 * 背景：中文输入法的预编辑串（拼音字母）由浏览器持有，它不是正文。
 * 一旦承载它的 DOM 被换掉或被卸载，浏览器会把这段预编辑**当成已提交文本**
 * 冻结在原位 —— 表现为「打拼音时冒出一个字母，且取消候选也收不回去」。
 *
 * 本探针把这件事拆成四档，逐档给出可判定的证据：
 *   A 基线：组合 → 取消候选（不改 DOM）——应当干净
 *   B 基线：组合 → 提交（不改 DOM）——应当正确
 *   C 组合期重渲染承载块（换掉 `.tx`）——验证「换 DOM」是否足够触发
 *   D 组合期卸载承载块（模拟窗口化挂载）——验证卸载的后果
 *
 * 用法：node checks/probe-ime-dom.mjs
 * ⚠️ 这是诊断探针，**不进 gate**；改动编辑器的事件/渲染路径时手动跑一次。
 * ⚠️ 走的是 CDP `Input.imeSetComposition` / `Input.insertText`，即真 Chromium 的输入管线，
 *    不是手搓 DOM 事件 —— 合成事件测不出这个现象（实测过：合成事件下预编辑不由浏览器持有）。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-probe')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const app = await _electron.launch({
  args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'],
  env: cleanEnv,
})
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua?.quiet?.(true))
await sleep(600)

const cdp = await page.context().newCDPSession(page)

/** 目标块：挑一个正文够长的块，方便在开头落光标 */
const target = await page.evaluate(() => {
  const b = window.__qua.blocks().find((x) => x.text && x.text.length > 2)
  return b ? { id: b.id, text: b.text } : null
})
if (!target) {
  log('✗ 找不到有正文的块')
  await app.close()
  process.exit(1)
}
log(`目标块 ${target.id.slice(-6)}  初始="${target.text}"`)

const snap = () =>
  page.evaluate((bid) => {
    const b = window.__qua.blocks().find((x) => x.id === bid)
    const tx = document.querySelector(`.blk[data-block-id="${bid}"] .tx`)
    const s = document.getSelection()
    return {
      model: b?.text ?? null,
      dom: tx?.textContent ?? null,
      composing: window.__qua.__editor.probe.isComposing,
      sel: s && s.rangeCount ? s.anchorNode?.nodeName : null,
    }
  }, target.id)

/** 每档都从同一个起点开始：光标落在块首，正文复位成原始字符串 */
const reset = async () => {
  await page.evaluate(
    ({ id, text }) => {
      const ed = window.__qua.__editor
      const b = ed.store.find(id)
      // ⚠️ 文本 run 的字段是 `{t:'text', v}`（`plainText` 读 `r.v`），不是 `text`
      //    —— 写错字段会让投影拼出 "undefined"（踩过）。
      b.content = [{ t: 'text', v: text }]
      ed.renderAll()
      window.__qua.focusBlock(id, 0)
    },
    { id: target.id, text: target.text },
  )
  await sleep(150)
}

/* ════════════════ A 基线：组合 → 取消候选 ════════════════ */
log('\n══ A 基线：组合 → 取消候选（不改 DOM）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
const aComposing = await snap()
log('  组合中:', JSON.stringify(aComposing))
await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
await sleep(220)
const aCancel = await snap()
log('  取消后:', JSON.stringify(aCancel))

/* ════════════════ B 基线：组合 → 提交 ════════════════ */
log('\n══ B 基线：组合 → 提交（不改 DOM）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
await cdp.send('Input.insertText', { text: '中' })
await sleep(280)
const bCommit = await snap()
log('  提交后:', JSON.stringify(bCommit))

/* ════════════════ C 组合期重渲染承载块 ════════════════ */
log('\n══ C 组合期重渲染承载块（换掉 .tx）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
log('  组合中:', JSON.stringify(await snap()))
const cRerender = await page.evaluate((bid) => {
  const el = document.querySelector(`.blk[data-block-id="${bid}"]`)
  const tx = el.querySelector('.tx')
  const fresh = tx.cloneNode(true)
  tx.replaceWith(fresh)
  return { sameText: fresh.textContent }
}, target.id)
log('  重渲染:', JSON.stringify(cRerender))
await sleep(220)
log('  重画后:', JSON.stringify(await snap()))
await cdp.send('Input.insertText', { text: '中' })
await sleep(320)
const cFinal = await snap()
log('  提交后:', JSON.stringify(cFinal))

/* ════════════════ D 组合期卸载承载块 ════════════════ */
log('\n══ D 组合期卸载承载块（模拟窗口化挂载）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
log('  组合中:', JSON.stringify(await snap()))
await page.evaluate((bid) => {
  document.querySelector(`.blk[data-block-id="${bid}"]`)?.remove()
}, target.id)
await sleep(220)
log('  卸载后:', JSON.stringify(await snap()))
await cdp.send('Input.insertText', { text: '中' })
await sleep(320)
const dFinal = await snap()
log('  提交后:', JSON.stringify(dFinal))

/* ════════════════ 汇总 ════════════════ */
const verdict = {
  'A 取消后无残留': !/zhong/i.test(aCancel.model ?? ''),
  'B 提交正确': Boolean(bCommit.model?.includes('中')),
  /**
   * ⚠️ C／D 两档**故意绕过编辑器的守卫**（直接 `tx.replaceWith` / `el.remove()`），
   *    它们证明的是**机制**（「换/卸 DOM ⇒ 预编辑串被冻结」），不是「守卫生效」。
   *    ⇒ 这里期望的是 **true**（机制成立）。守卫是否真的挡住了真实入口，
   *      由 `probe-ime-attrib.mjs`（走 `renderBlock`／`store.touch`／`applyWindow`）回答。
   */
  'C 重渲染后残留字母（机制成立）': /zhong/i.test(cFinal.model ?? ''),
  'C 提交后组合态已结束': cFinal.composing === false,
  'D 卸载后残留字母（机制成立）': /zhong/i.test(dFinal.model ?? ''),
  'D 提交后组合态已结束': dFinal.composing === false,
}
log('\n══════ 结论 ══════')
log(JSON.stringify(verdict, null, 2))
log(`\nC（重渲染）="${cFinal.model}"\nD（卸载）  ="${dFinal.model}"`)

await app.close()
