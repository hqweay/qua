/**
 * 探针：**在我们自己的代码里，组合期有没有被走到「换 DOM」那一步？**
 *
 * `probe-ime-dom.mjs` 证明的是机制（组合期换 DOM ⇒ 预编辑串被冻结成正文）。
 * 本探针回答归因：编辑器**自己的入口**里，哪几条会在组合期换掉承载块。
 *
 * 做法：给渲染入口挂**只记录、不改变行为**的观测，再用真 IME 通道打一遍，
 * 把「render 调用的时刻」与「当时的 composing」并排打出来。
 *
 * 用法：node checks/probe-ime-attrib.mjs
 * ⚠️ 诊断探针，不进 gate。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-attrib')
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

/* ── 挂观测：只记录，不改行为 ─────────────────────────── */
await page.evaluate(() => {
  const ed = window.__qua.__editor
  window.__trace = []
  const rec = (what, extra) =>
    window.__trace.push({ what, composing: ed.probe.isComposing, ...extra })
  for (const name of ['renderBlock', 'renderAll', 'applyWindow', 'reclaimCaret', 'restoreSel', 'flushPendingReload']) {
    if (typeof ed[name] !== 'function') continue
    const orig = ed[name].bind(ed)
    ed[name] = (...args) => {
      const r = orig(...args)
      rec(name, { returned: typeof r === 'boolean' ? r : undefined })
      return r
    }
  }
  const c = ed.container
  for (const t of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
    c.addEventListener(
      t,
      (e) =>
        window.__trace.push({
          what: 'evt:' + t,
          isComposing: e.isComposing ?? null,
          inputType: e.inputType ?? null,
          data: e.data ?? null,
        }),
      true,
    )
  }
})

const target = await page.evaluate(() => {
  const b = window.__qua.blocks().find((x) => x.text && x.text.length > 2)
  return b ? { id: b.id, text: b.text } : null
})
log(`目标块 ${target.id.slice(-6)}  初始="${target.text}"`)

const snap = () =>
  page.evaluate(
    (bid) => ({
      model: window.__qua.blocks().find((x) => x.id === bid)?.text ?? null,
      composing: window.__qua.__editor.probe.isComposing,
    }),
    target.id,
  )

const takeTrace = () =>
  page.evaluate(() => {
    const v = window.__trace.slice()
    window.__trace = []
    return v
  })

const reset = async () => {
  await page.evaluate(
    ({ id, text }) => {
      const ed = window.__qua.__editor
      // ⚠️ 文本 run 的字段是 `{t:'text', v}`（`plainText` 读 `r.v`），不是 `text`
      ed.store.find(id).content = [{ t: 'text', v: text }]
      ed.renderAll()
      window.__qua.focusBlock(id, 0)
    },
    { id: target.id, text: target.text },
  )
  await sleep(150)
  await takeTrace()
}

/* ════════════ 场景 1：正常组合 → 提交（对照） ════════════ */
log('\n══ 场景 1：组合 → 提交（对照）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
await cdp.send('Input.insertText', { text: '中' })
await sleep(380)
const t1 = await takeTrace()
for (const e of t1) log('  ', JSON.stringify(e))
const s1 = await snap()
log('  结果:', JSON.stringify(s1))

/* ════════════ 场景 2：组合 → 取消候选 ════════════ */
log('\n══ 场景 2：组合 → 取消候选 ══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
await sleep(380)
const t2 = await takeTrace()
for (const e of t2) log('  ', JSON.stringify(e))
const s2 = await snap()
log('  结果:', JSON.stringify(s2))

/* ════════════ 场景 3：组合中「别处写入同一块」⇒ store.touch ════════════ */
log('\n══ 场景 3：组合中 store.touch（别处改了同一块）══')
await reset()
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
log('  组合中:', JSON.stringify(await snap()))
await page.evaluate((bid) => window.__qua.forceForest(() => {}), target.id)
await sleep(260)
log('  touch 后:', JSON.stringify(await snap()))
await cdp.send('Input.insertText', { text: '中' })
await sleep(380)
const t3 = await takeTrace()
for (const e of t3) log('  ', JSON.stringify(e))
const s3 = await snap()
log('  结果:', JSON.stringify(s3))

/* ════════════ 场景 4：组合中 applyWindow（窗口化挂载） ════════════ */
log('\n══ 场景 4：组合中 applyWindow ══')
await reset()
const virt = await page.evaluate(() => window.__qua.__editor.virtualize)
await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
await sleep(220)
const applied = await page.evaluate((bid) => {
  const ed = window.__qua.__editor
  const before = document.querySelector(`.blk[data-block-id="${bid}"]`)
  ed.applyWindow()
  const after = document.querySelector(`.blk[data-block-id="${bid}"]`)
  // ⚠️ 判据是**同一个元素还在不在**，不是「有没有一个同 id 的元素」：
  //    窗口重算会把承载块摘掉再按窗口重新挂一个**新的** —— 后者正是打断 IME 的那一下。
  return { sameElement: before === after, existed: Boolean(after) }
}, target.id)
log(`  virtualize=${virt}  applyWindow 后同一元素还在=${applied.sameElement}（存在=${applied.existed}）`)
await sleep(260)
await cdp.send('Input.insertText', { text: '中' })
await sleep(380)
const t4 = await takeTrace()
for (const e of t4) log('  ', JSON.stringify(e))
const s4 = await snap()
log('  结果:', JSON.stringify(s4))

/* ════════════ 汇总 ════════════ */
log('\n══════ 归因汇总 ══════')
const composingRenders = (tr) => tr.filter((e) => e.composing === true && /^render/.test(e.what)).map((e) => e.what)
log(`场景1 组合期发生重渲染: ${JSON.stringify(composingRenders(t1))}  结果=${JSON.stringify(s1)}`)
log(`场景2 取消后残留字母: ${/zhong/i.test(s2.model ?? '')}  结果=${JSON.stringify(s2)}`)
log(`场景3 组合期发生重渲染: ${JSON.stringify(composingRenders(t3))}  结果=${JSON.stringify(s3)}`)
log(`场景4 virtualize=${virt}  组合期发生重渲染: ${JSON.stringify(composingRenders(t4))}  结果=${JSON.stringify(s4)}`)

await app.close()
