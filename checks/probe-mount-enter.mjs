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

/**
 * 在提及的第一行末尾落光标。
 *
 * ⚠️ 必须**真鼠标点击**：挂载区编辑器靠 `focusin` 才被装配层认成「活动编辑器」
 *    （`onFocus` ⇒ `deps.setEd`）。用 `el.focus()` 或手工塞 Range 都不会派发
 *    `focusin`，那一刻 `app.ed` 还是**正文** ⇒ ↵ 会被正文接走（探针踩过）。
 */
const spot = await page.evaluate(() => {
  const ed = document.querySelector('.sec > .sec-mount .mount-editor')
  const tx = ed?.querySelector('.blk .tx')
  if (!tx) return null
  const r = tx.getBoundingClientRect()
  return { x: Math.round(r.right - 3), y: Math.round(r.y + r.height / 2), id: tx.closest('.blk')?.dataset.blockId?.slice(-6) }
})
if (!spot) {
  log('✗ 提及里没有可点的行')
  await app.close()
  process.exit(1)
}
await page.mouse.click(spot.x, spot.y)
await sleep(350)
const focused = await page.evaluate(() => {
  const a = document.activeElement
  return {
    inMount: Boolean(a?.closest('.sec-mount')),
    caretBlock: window.__qua.snapshot().selection?.aBlock?.slice(-6) ?? null,
  }
})
log(`点提及行 ${spot.id}：${JSON.stringify(focused)}`)

const activeBefore = await page.evaluate(() => {
  const a = document.activeElement
  return { tag: a?.tagName, cls: String(a?.className ?? ''), inMount: Boolean(a?.closest('.sec-mount')) }
})
log(`按 ↵ 前焦点：${JSON.stringify(activeBefore)}`)

/**
 * ⌘A 也走**命令层**（`app.ed.selectAll()`），所以它落在哪个编辑宿主里
 * ＝「活动编辑器」到底是谁。打字走事件层，即使活动编辑器错了也能打对——
 * 这正是「能打字、但 ↵ 跑到正文」能同时成立的原因。
 */
await page.keyboard.press('Meta+a')
await sleep(250)
const selHost = await page.evaluate(() => {
  const s = getSelection()
  const n = s?.anchorNode
  const el = n?.nodeType === 3 ? n.parentElement : n
  return {
    inMount: Boolean(el?.closest('.sec-mount')),
    inBody: Boolean(el?.closest('#editor') && !el?.closest('.sec-mount')),
    text: (s?.toString() ?? '').slice(0, 24),
  }
})
log(`⌘A 的选区落在：${JSON.stringify(selHost)}  ⇒ 活动编辑器＝${selHost.inMount ? '挂载区' : '正文'}`)
await page.evaluate(() => getSelection()?.removeAllRanges())
await sleep(150)

await page.keyboard.press('Enter')
await sleep(600)

const dumpMount = () =>
  page.evaluate(() => {
    const mount = document.querySelector('.sec > .sec-mount')
    return Array.from(mount?.querySelectorAll('.mount-editor .blk') ?? []).map((b) => ({
      id: b.dataset.blockId?.slice(-6),
      depth: b.dataset.depth,
      text: b.querySelector('.tx')?.textContent ?? '',
    }))
  })

const after = await page.evaluate((rowsBeforeIds) => {
  const a = document.activeElement
  const mounted = document.querySelector('.sec > .sec-mount .mount-editor')
  return {
    active: {
      id: a?.id || null,
      tag: a?.tagName,
      cls: String(a?.className ?? '').slice(0, 40),
      inMount: Boolean(a?.closest('.sec-mount')),
      isEditor: a?.id === 'editor',
    },
    mountRows: Array.from(mounted?.querySelectorAll('.blk') ?? []).map((b) => ({
      id: b.dataset.blockId?.slice(-6),
      depth: b.dataset.depth,
      text: b.querySelector('.tx')?.textContent ?? '',
    })),
  }
}, [])
log(`\n按 ↵ 后焦点：${JSON.stringify(after.active)}`)
log(`按 ↵ 后挂载区里的行（含 depth）：${JSON.stringify(after.mountRows)}`)

/** 新建的那块在**正文**里在哪：父是谁、能不能看见 */
const inBody = await page.evaluate(() => {
  const out = []
  const walk = (b, parent, d) => {
    out.push({ id: b.id.slice(-6), depth: d, text: (b.content ?? []).map((r) => r.v ?? '').join(''), parent: parent?.slice(-6) ?? null })
    for (const c of b.children ?? []) walk(c, b.id, d + 1)
  }
  for (const r of window.__qua.__editor.doc.roots) walk(r, null, 0)
  const ed = window.__qua.__editor
  const cid = ed.caretBlock() ?? ed.sel?.aBlock
  return {
    caret: cid?.slice(-6) ?? null,
    empties: out.filter((o) => o.text === ''),
    caretVisibleInBody: Boolean(cid && document.querySelector(`#editor .blk[data-block-id="${cid}"]`)),
  }
})
log(`正文里的空块（新建的那块应当在这里）：${JSON.stringify(inBody.empties)}`)
log(`光标块=${inBody.caret}；它在正文 DOM 里可见=${inBody.caretVisibleInBody}`)

/**
 * 新块**真正的父**是谁（从整片森林里查，不靠任一视图的 doc）。
 * 父＝命中块 ⇒ ↵ 被挂载区接了；父＝命中块的父 ⇒ ↵ 被正文接了。
 */
const kinship = await page.evaluate(() => {
  const ed = window.__qua.__editor
  const cid = ed.caretBlock() ?? ed.sel?.aBlock
  const parentOf = new Map()
  for (const r of ed.store.blocks) {
    const walk = (b, p) => {
      parentOf.set(b.id, p)
      for (const c of b.children ?? []) walk(c, b.id)
    }
    walk(r, null)
  }
  const chain = []
  let cur = cid
  while (cur) {
    chain.push(String(cur).slice(-6))
    cur = parentOf.get(cur)
  }
  return { caret: String(cid ?? '').slice(-6), chain }
})
log(`新块的祖先链（自己→根）：${JSON.stringify(kinship.chain)}`)

/** 库里多出来的块挂在哪 */
const tree = await page.evaluate((childId) => {
  const found = window.__qua.blocks().filter((b) => !b.text || b.text === '')
  return found.slice(0, 6).map((b) => ({ id: b.id.slice(-8), text: b.text }))
}, made.childId)
log(`库里的空块（新建的那块应当在这里）：${JSON.stringify(tree)}`)

await app.close()
