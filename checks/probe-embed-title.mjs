/**
 * 探针：**投影抬头常驻编辑**的样子与几何（真 Electron 截图）。
 *
 * 用户问：镜像查询块的标题能不能直接展示就能编辑？这一档拍下改前改后的样子，
 * 并量三件肉眼判不准的事：
 *   ① 抬头里的正文起点是否与「条数」那一格同一条基线（不是被块的 gutter 顶出去）；
 *   ② 抬头里没有块标、没有多余缩进（`padding-left: 0` 生效）；
 *   ③ 空名字时显示占位句「未命名查询」，一有字就消失。
 *
 * 用法：pnpm build:electron 后 `node checks/probe-embed-title.mjs`
 * ⚠️ 诊断探针，不进 gate。结论要写「实测」。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'embed-title')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

const app = await _electron.launch({ args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'], env })
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua?.quiet?.(true))
await sleep(900)

/** 建一个查询块，然后在它所在页里露面一次（投影） */
const fx = await page.evaluate(() => {
  const q = window.__qua
  const inv = (n, a = {}) => q.invoke(n, a)
  const p = q.pages().find((x) => (x.title ?? '').includes('产品设计')) ?? q.pages()[0]
  inv('core.page/open', { pageId: p.id })
  const root = q.__editor.doc.roots[0]
  const stub = root.children[0]
  q.focusBlock(stub.id, 0)
  inv('core.editor/insert-block', { text: '放一个查询露面' })
  const host = q.__editor.sel.aBlock
  inv('core.query/create', { name: '本页待办', spec: { where: { kind: 'atom', atom: 'any' } }, parentId: root.id })
  // 查询块现在是 host 自己（原地转）还是插在后面：按实际找
  const find = (l, f) => {
    for (const b of l) {
      if (f(b)) return b
      const r = find(b.children ?? [], f)
      if (r) return r
    }
    return null
  }
  const qb = find(q.__editor.doc.roots, (b) => b.props?._query)
  return { page: p.id, host, qid: qb?.id ?? '', qname: qb?.text ?? '' }
})
log('fixture:', JSON.stringify(fx))

/** 在源所在页里放一次露面，指向这个查询块 */
await page.evaluate(({ host, qid }) => {
  window.__qua.invoke('core.embed/insert', { blockId: host, targetId: qid, view: 'mirror' })
}, fx)
await sleep(500)

const geom = await page.evaluate(() => {
  const title = document.querySelector('.queryview[data-surface="embed"] .queryview-title')
  const count = title?.parentElement?.querySelector('.queryview-count')
  const tx = title?.querySelector('.tx')
  const blk = title?.querySelector('.blk')
  const left = blk?.querySelector('.left')
  const r = (el) => (el ? el.getBoundingClientRect().toJSON() : null)
  return {
    titleText: title?.textContent ?? '',
    placeholder: tx?.dataset.ph ?? '',
    titleRect: r(title),
    txRect: r(tx),
    countRect: r(count),
    leftDisplay: left ? getComputedStyle(left).display : 'none',
    blkPadLeft: blk ? getComputedStyle(blk).paddingLeft : '',
    blkMinH: blk ? getComputedStyle(blk).minHeight : '',
    titleFont: title ? getComputedStyle(title).font : '',
    txFont: tx ? getComputedStyle(tx).font : '',
  }
})
log('几何:', JSON.stringify(geom, null, 2))

/** 空名字：占位句（把源的名字清掉，抬头那一行应当变成「未命名查询」） */
/**
 * ⚠️ 查询块的正文**只能由「直接打字」写**（`canWriteText` 挡住程序化整段替换，
 *    见 `core/kb/diff.ts` 的 `directEdit` 那一条）——所以这里走真实按键，不调 `editBlock`。
 */
await page.locator('.queryview[data-surface="embed"] .queryview-title .tx').click()
await page.keyboard.press('ControlOrMeta+a')
await page.keyboard.press('Backspace')
await sleep(400)
const emptyGeom = await page.evaluate(() => {
  const title = document.querySelector('.queryview[data-surface="embed"] .queryview-title')
  const tx = title?.querySelector('.tx')
  return { text: title?.textContent ?? '', ph: tx?.dataset.ph ?? '', hidden: title?.hidden ?? true }
})
log('空名字:', JSON.stringify(emptyGeom))
/**
 * 失焦之后再看一眼：占位符是 `data-ph` 的 `::before`，而「光标所在行不显示占位」
 * 是一条既有口径（`.blk[data-caret='1'] .tx[data-ph]::before { content: none }`）。
 * ⇒ 空名字**且没人在这**时才是「未命名查询」那句话该出现的时候。
 */
await page.evaluate(() => window.__qua.focusBlock(window.__qua.__editor.doc.roots[0].id, 0))
await sleep(350)
const blurred = await page.evaluate(() => {
  const title = document.querySelector('.queryview[data-surface="embed"] .queryview-title')
  const tx = title?.querySelector('.tx')
  const before = tx ? getComputedStyle(tx, '::before').content : ''
  return { text: title?.textContent ?? '', ph: tx?.dataset.ph ?? '', before, caret: tx?.closest('.blk')?.dataset.caret ?? '' }
})
log('失焦后:', JSON.stringify(blurred))
const box = await page.evaluate(() => {
  const row = document.querySelector('.blk[data-embed="1"]')
  const r = row?.getBoundingClientRect()
  return r ? { x: Math.max(0, r.left - 20), y: Math.max(0, r.top - 20), width: Math.min(1000, r.width + 40), height: Math.min(400, r.height + 40) } : null
})
if (box) await page.screenshot({ path: join(ROOT, 'shots', 'probe-embed-title-empty.png'), clip: box })
log('截图: shots/probe-embed-title-empty.png')

await page.screenshot({ path: join(ROOT, 'shots', 'probe-embed-title.png'), clip: { x: 0, y: 0, width: 1200, height: 700 } })
log('截图: shots/probe-embed-title.png')
await app.close()
