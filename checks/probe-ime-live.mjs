/**
 * 探针：**真 app 里敲拼音，第一个字母为什么会被落下？**
 *
 * 与 `probe-ime-dom.mjs` 的分工：那个证明**机制**（组合期换 DOM ⇒ 预编辑串冻结成正文）；
 * 这个回答**守卫生没生效**——它在真 app 里敲一串拼音，并把下面几件事同时记下来：
 *   · 事件顺序（`keydown` / `compositionstart` / `beforeinput` / `input` / `compositionend`）；
 *   · 每个事件那一刻**承载块与插入点的身份**（DOM 节点被换过没有，一眼看得出）；
 *   · `MutationObserver` 抓到的**每一次 DOM 改动**（含 characterData）。
 *
 * 三档场景：
 *   S1 落光标后**等 500ms 再敲**（一切已 settle）——应当干净
 *   S2 落光标后**立刻敲**（模拟「光标刚跳过来就打字」）
 *   S3 **按 ↵ 建块后立刻敲**（模拟用户报的那条：从提及跳到正文后马上打拼音）
 *   S4 **按 ↵ 建块后等 500ms 再敲**（把「立刻」这个变量摘掉）
 *
 * 用法：node checks/probe-ime-live.mjs
 * ⚠️ 诊断探针，**不进 gate**。需要先 `pnpm build:test && pnpm build:electron`。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'ime-live')
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
await sleep(800)
const cdp = await page.context().newCDPSession(page)

/* ───────── 埋点 ───────── */
await page.evaluate(() => {
  const q = window.__qua
  const ed = q.__editor
  window.__log = []
  window.__muts = []

  /** 给 DOM 节点发一个稳定编号：换没换过一眼看得出 */
  const uid = new WeakMap()
  let n = 0
  const idOf = (x) => {
    if (!x) return null
    if (!uid.has(x)) uid.set(x, `#${++n}`)
    return uid.get(x)
  }
  window.__idOf = idOf

  /** 组合期**谁动过选区/焦点** —— 程序化挪光标会打断输入法，这是最可能的凶手 */
  window.__sel = []
  const trace = (fn) => function (...args) {
    try {
      window.__sel.push({
        t: Math.round(performance.now()),
        composing: ed.probe.isComposing,
        fn,
        stack: (new Error().stack || '').split('\n').slice(2, 8).map((s) => s.trim().replace(/^at /, '')).join('  ←  '),
      })
    } catch {
      /* 埋点自己不许影响被测行为 */
    }
    return fn.apply(this, args)
  }
  for (const name of ['setBaseAndExtent', 'collapse', 'collapseToStart', 'collapseToEnd', 'removeAllRanges', 'extend', 'selectAllChildren']) {
    const proto = Selection.prototype
    if (typeof proto[name] === 'function') proto[name] = trace(proto[name])
  }
  for (const name of ['setStart', 'setEnd', 'setStartBefore', 'setStartAfter', 'setEndBefore', 'setEndAfter']) {
    const proto = Range.prototype
    if (typeof proto[name] === 'function') proto[name] = trace(proto[name])
  }
  HTMLElement.prototype.focus = trace(HTMLElement.prototype.focus)

  const state = () => {
    const s = document.getSelection()
    const anchor = s?.anchorNode ?? null
    const tx = anchor instanceof Node ? (anchor.nodeType === 3 ? anchor.parentElement : anchor)?.closest?.('.tx') : null
    const blk = tx?.closest('.blk') ?? null
    const ae = document.activeElement
    return {
      t: Math.round(performance.now()),
      composing: ed.probe.isComposing,
      tx: idOf(tx),
      txText: tx?.textContent ?? null,
      anchor: idOf(anchor),
      anchorOff: s?.anchorOffset ?? null,
      blk: blk?.dataset.blockId?.slice(-6) ?? null,
      active: ae ? `${ae.tagName}${ae.className ? '.' + String(ae.className).split(' ')[0] : ''}` : null,
    }
  }
  const types = [
    'keydown', 'keyup', 'beforeinput', 'input',
    'compositionstart', 'compositionupdate', 'compositionend',
    'focusin', 'focusout',
  ]
  for (const ty of types) {
    window.addEventListener(ty, (e) => {
      window.__log.push({
        ...state(),
        ev: ty,
        key: e.key ?? null,
        inputType: e.inputType ?? null,
        data: e.data ?? null,
        isComposing: e.isComposing ?? null,
      })
    }, { capture: true })
  }

  const brief = (node) => {
    if (!node) return '?'
    if (node.nodeType === 3) return `text(${JSON.stringify(node.data?.slice(0, 24))})`
    const el = /** @type {Element} */ (node)
    const cls = typeof el.className === 'string' ? el.className.split(' ')[0] : ''
    return `${el.tagName}${cls ? '.' + cls : ''}${el.dataset?.blockId ? `[${el.dataset.blockId.slice(-6)}]` : ''}`
  }
  new MutationObserver((records) => {
    for (const r of records) {
      window.__muts.push({
        ...state(),
        type: r.type,
        target: brief(r.target),
        added: [...r.addedNodes].map(brief).join(','),
        removed: [...r.removedNodes].map(brief).join(','),
      })
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['data-ph', 'data-caret', 'data-empty', 'contenteditable', 'style', 'class'],
  })
})

const target = await page.evaluate(() => {
  const b = window.__qua.blocks().find((x) => x.text && x.text.length > 2)
  return b ? { id: b.id, text: b.text } : null
})
if (!target) {
  log('✗ 找不到有正文的块')
  await app.close()
  process.exit(1)
}
log(`目标块 …${target.id.slice(-6)}  初始="${target.text}"`)

const reset = async () => {
  await page.evaluate(({ id, text }) => {
    const ed = window.__qua.__editor
    const b = ed.store.find(id)
    b.content = [{ t: 'text', v: text }]
    ed.renderAll()
    window.__log = []
    window.__muts = []
    window.__sel = []
  }, { id: target.id, text: target.text })
}

const snap = () =>
  page.evaluate((bid) => {
    const b = window.__qua.blocks().find((x) => x.id === bid)
    const tx = document.querySelector(`.blk[data-block-id="${bid}"] .tx`)
    return { model: b?.text ?? null, dom: tx?.textContent ?? null, composing: window.__qua.__editor.probe.isComposing }
  }, target.id)

const caretText = () =>
  page.evaluate(() => {
    const ed = window.__qua.__editor
    const id = ed.caretBlock() ?? ed.sel?.aBlock ?? null
    const b = id ? window.__qua.blocks().find((x) => x.id === id) : null
    return { caret: id?.slice(-6) ?? null, text: b?.text ?? null }
  })

async function dump(label) {
  const { ev, muts } = await page.evaluate(() => ({ ev: window.__log, muts: window.__muts }))
  log(`\n  ── 事件序列（${label}）──`)
  for (const e of ev) {
    log(
      `   ${String(e.t).padStart(6)}ms ${e.ev.padEnd(17)} cmp=${String(e.composing).padEnd(5)}` +
        ` tx=${String(e.tx).padEnd(4)} "${(e.txText ?? '').slice(-14)}" anchor=${String(e.anchor).padEnd(4)}` +
        `${e.inputType ? ` ${e.inputType}` : ''}${e.data !== null && e.data !== undefined ? ` data=${JSON.stringify(e.data)}` : ''}` +
        `${e.key ? ` key=${JSON.stringify(e.key)}` : ''}`,
    )
  }
  const sel = await page.evaluate(() => window.__sel)
  const selBad = sel.filter((s) => s.composing)
  log(`  ── 组合期动过选区/焦点：${selBad.length} 次 ──`)
  for (const s of selBad) log(`   ⚠️${String(s.t).padStart(6)}ms ${s.fn}\n      ${s.stack}`)
  // 噪音：dock-stack / dock-card / dock-tile 是诊断面板在自刷；那个裸 DIV 是底部状态条
  const noise = (m) => /dock-(stack|card|tile)/.test(m.target) || (m.target === 'DIV' && /composing/.test(`${m.added}${m.removed}`))
  const keep = muts.filter((m) => !noise(m))
  log(`  ── DOM 改动 ${keep.length} 条（滤掉诊断面板自刷 ${muts.length - keep.length} 条；组合期 ${keep.filter((m) => m.composing).length} 条）──`)
  for (const m of keep) {
    const mark = m.composing ? '⚠️' : '  '
    log(`   ${mark}${String(m.t).padStart(6)}ms ${m.type.padEnd(13)} target=${m.target}${m.removed ? ` -[${m.removed}]` : ''}${m.added ? ` +[${m.added}]` : ''}`)
  }
  return muts.filter((m) => m.composing).length
}

async function typePinyin(pinyin, commit) {
  for (let i = 1; i <= pinyin.length; i++) {
    await cdp.send('Input.imeSetComposition', { text: pinyin.slice(0, i), selectionStart: i, selectionEnd: i })
    await sleep(45)
  }
  await cdp.send('Input.insertText', { text: commit })
  await sleep(250)
}

const results = {}

/* ══════════ S1 等 500ms 再敲 ══════════ */
log('\n════════ S1：落光标 → 等 500ms → 敲 nihao ════════')
await reset()
await page.evaluate((id) => window.__qua.focusBlock(id, 999), target.id)
await sleep(500)
await typePinyin('nihao', '你好')
results.S1 = (await snap()).model
await dump('S1')

/* ══════════ S2 立刻敲 ══════════ */
log('\n════════ S2：落光标 → 立刻敲 nihao ════════')
await reset()
await page.evaluate((id) => window.__qua.focusBlock(id, 999), target.id)
await sleep(30)
await typePinyin('nihao', '你好')
results.S2 = (await snap()).model
await dump('S2')

/* ══════════ S3 ↵ 建块后立刻敲 ══════════ */
log('\n════════ S3：落光标 → ↵ 建块 → 立刻敲 nihao ════════')
await reset()
await page.evaluate((id) => window.__qua.focusBlock(id, 999), target.id)
await sleep(300)
await page.keyboard.press('Enter')
await sleep(30)
await typePinyin('nihao', '你好')
results.S3 = (await caretText()).text
await dump('S3')

/* ══════════ S4 ↵ 建块后等 500ms 再敲 ══════════ */
log('\n════════ S4：落光标 → ↵ 建块 → 等 500ms → 敲 nihao ════════')
await reset()
await page.evaluate((id) => window.__qua.focusBlock(id, 999), target.id)
await sleep(300)
await page.keyboard.press('Enter')
await sleep(500)
await typePinyin('nihao', '你好')
results.S4 = (await caretText()).text
await dump('S4')

log('\n════════ 汇总 ════════')
for (const [k, v] of Object.entries(results)) log(`  ${k}: ${JSON.stringify(v)}`)
const ok = (v) => v === '你好' || v === `${target.text}你好`
log(JSON.stringify({ S1: ok(results.S1), S2: ok(results.S2), S3: ok(results.S3), S4: ok(results.S4) }, null, 2))

await app.close()
