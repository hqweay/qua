/**
 * 探针：**虚拟化的滚动联动**（换窗跟随滚动、滚动位置不跳、DOM 有界）。
 *
 * 回答三件事：
 *   ① 打开虚拟化后，一页 N 块的 DOM 只有窗口那几行（不是 N）；
 *   ② 把滚动条往下拖一段 ⇒ 窗口真的跟着换（顶部那一块变了），且 `scrollTop` 不被改写；
 *   ③ 再滚回顶部 ⇒ 窗口回到头，头占位消失。
 *
 * 用法：pnpm build:test && node checks/probe-virtual-scroll.mjs
 * ⚠️ 诊断探针，不进 gate（验收仍以真机手感为准）。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'virt-scroll')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({ args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'], env: cleanEnv })
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua?.quiet?.(true))
await sleep(500)

const ROWS = 300
/** 往**当前正在看的**那一块底下灌 300 行（编辑器只画它的 doc） */
await page.evaluate((rows) => {
  const hex = (n) => n.toString(16).padStart(32, '0')
  const active = window.__qua.snapshot().activeId
  window.__qua.forceForest((forest) => {
    const flat = []
    const walk = (bs) => {
      for (const b of bs) {
        flat.push(b)
        walk(b.children)
      }
    }
    walk(forest)
    const host = flat.find((b) => b.id === active) ?? flat[0]
    if (!host) return
    host.children.length = 0
    for (let i = 0; i < rows; i++) {
      host.children.push({
        id: hex(0xa0000 + i),
        content: [{ t: 'text', v: `第 ${i} 行 / 共 ${rows} 行` }],
        children: [],
        created: 1,
        modified: 1,
        props: {},
      })
    }
  })
}, ROWS)
await sleep(300)

const stats = () => page.evaluate(() => window.__qua.snapshot())
const topBlock = () =>
  page.evaluate(() => {
    const host = document.getElementById('scroll')
    const top = host.getBoundingClientRect().top
    for (const el of document.querySelectorAll('#editor .blk')) {
      if (el.getBoundingClientRect().bottom > top) return el.dataset.blockId ?? ''
    }
    return ''
  })
const scrollTo = (y) =>
  page.evaluate((top) => {
    const host = document.getElementById('scroll')
    host.scrollTop = top
    return host.scrollTop
  }, y)

log(`① 先看不开虚拟化：${ROWS + 1} 行的页全进 DOM`)
const before = await stats()
log(`   blocks=${before.blocks} domBlocks=${before.domBlocks} domNodes=${before.domNodes} virtualize=${before.virtualize}`)

log('\n② 打开虚拟化（radius=5）')
await page.evaluate(() => window.__qua.__editor.setVirtualize(true, 5))
await sleep(200)
const v1 = await stats()
const t1 = await topBlock()
log(`   domBlocks=${v1.domBlocks} domNodes=${v1.domNodes} virtualize=${v1.virtualize} 顶部=${t1}`)

log('\n③ 往下滚 4000px：窗口应当跟着换，scrollTop 不被改写')
const applied = await scrollTo(4000)
await sleep(250)
const v2 = await stats()
const t2 = await topBlock()
const kept = await page.evaluate(() => document.getElementById('scroll').scrollTop)
log(`   请求 scrollTop=${applied} 实际=${kept} domBlocks=${v2.domBlocks} 顶部=${t2}`)

log('\n④ 再滚回顶部')
await scrollTo(0)
await sleep(250)
const v3 = await stats()
const t3 = await topBlock()
const head = await page.evaluate(() => document.querySelector('#editor .ph[data-ph="head"]') !== null)
log(`   domBlocks=${v3.domBlocks} 顶部=${t3} 还有头占位=${head}`)

const pass =
  v1.domBlocks > 0 &&
  v1.domBlocks <= 2 * 5 + 8 &&
  v2.domBlocks > 0 &&
  v2.domBlocks <= 2 * 5 + 8 &&
  t1 !== '' &&
  t2 !== '' &&
  t1 !== t2 &&
  kept === applied &&
  t3 === t1 &&
  head === false
log(`\n${pass ? 'PASS' : 'FAIL'}：DOM 有界=${v1.domBlocks}/${v2.domBlocks} 换窗=${t1}→${t2} scrollTop 保持=${kept === applied} 回顶=${t3 === t1}`)
await app.close()
process.exit(pass ? 0 : 1)
