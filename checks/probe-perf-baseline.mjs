/**
 * 探针：**每键与滚动的数据准备成本**（50k / 100k 行）。
 *
 * 为什么需要它：虚拟化只保证 DOM 有界。真正要回答的是「一次输入 / 一次换窗
 * 处理了多少行、走了几遍树」——这些数只能从计数器读（`window.__qua.perf`），
 * 看 DOM 数看不出来。
 *
 * 输出（每个规模一组）：
 *   · 一次按键：flatten / visibleRows / locate / rows() 的调用次数；
 *   · 按键墙钟 p50 / p95（在页面内用 keydown capture → input bubble 计时）；
 *   · 滚动换窗：applyWindow 调用次数、处理行数、内部耗时 p95；
 *     以及每步 scrollTop 的墙钟 p95（含浏览器的两帧，只作量级参考）。
 *
 * 用法：pnpm build:test && node checks/probe-perf-baseline.mjs [50000 100000]
 * ⚠️ 诊断探针，不进 gate（它建的是合成大库，不是产品路径）。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'perf-baseline')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0)
const SIZES = sizes.length > 0 ? sizes : [50000, 100000]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 分位数（最近秩；样本少也比 min/max 有信息） */
function pct(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return Number(sorted[i].toFixed(2))
}

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

const app = await _electron.launch({ args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'], env: cleanEnv })
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua?.quiet?.(true))
await sleep(500)

/** 虚拟化先开：种子库一落地就只挂窗口那几十行，否则首帧会把整库塞进 DOM */
await page.evaluate(() => window.__qua.setVirtualize(true, 12))
await sleep(300)

/** 在当前活动页底下灌 N 行（与虚拟化探针同一条种子法，编辑器只画它的 doc） */
async function seed(n) {
  const t0 = Date.now()
  await page.evaluate((rows) => {
    const hex = (i) => i.toString(16).padStart(32, '0')
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
          id: hex(0xa000000 + i),
          content: [{ t: 'text', v: `第 ${i} 行 / 共 ${rows} 行` }],
          children: [],
          created: 1,
          modified: 1,
          props: {},
        })
      }
    })
  }, n)
  // 等到这一屏的行数真的到位（不调 snapshot：它每次 flatten 整库，大库上很贵）
  await page.waitForFunction((want) => window.__qua.__editor.rows().length >= want, n, { timeout: 180000, polling: 500 })
  await sleep(800)
  return Date.now() - t0
}

async function firstEditableId() {
  return page.evaluate(() => {
    // 优先挑一个普通子行（depth=1），避免把页头的特殊分支当输入面
    const tx = document.querySelector('#editor .blk[data-depth="1"] .tx:not([data-readonly])')
      ?? document.querySelector('#editor .blk .tx:not([data-readonly])')
    return tx?.closest('.blk')?.dataset.blockId ?? ''
  })
}

/** 页面内的按键计时：keydown（capture，最先）→ input（window bubble，最后） */
async function installTypingProbe() {
  await page.evaluate(() => {
    window.__perfSamples = []
    window.__perfKey = 0
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key.length === 1) window.__perfKey = performance.now()
      },
      true,
    )
    window.addEventListener(
      'input',
      () => {
        if (window.__perfKey > 0) {
          window.__perfSamples.push(performance.now() - window.__perfKey)
          window.__perfKey = 0
        }
      },
      false,
    )
  })
}

async function measureTyping(blockId) {
  await page.evaluate((id) => window.__qua.focusBlock(id, 0), blockId)
  await sleep(200)
  await installTypingProbe()
  const rows = await page.evaluate(() => window.__qua.__editor.rows().length)
  /**
   * 先清零再敲：计数从 0 起算，读完直接就是这 25 键的总账。
   * （`perfReset` 会把 store 的 `rebuildCount` 一起清零，所以这里不做前后相减。）
   */
  await page.evaluate(() => window.__qua.perfReset())
  await page.keyboard.type('a'.repeat(25), { delay: 40 })
  await sleep(300)
  const after = await page.evaluate(() => window.__qua.perf())
  const samples = await page.evaluate(() => window.__perfSamples.slice())
  const changeCalls = Math.max(1, after.editor.changeCalls)
  const per25 = {
    flatten: after.tree.flattenCalls,
    visibleRows: after.tree.visibleRowsCalls,
    locate: after.tree.locateCalls,
    pathTo: after.tree.pathToCalls,
    rowsCalls: after.editor.rowsCalls,
    renderBlock: after.render.renderBlockCalls,
    renderRowsRendered: after.render.renderRowsRendered,
    storeRebuild: after.store.rebuildCount,
  }
  /** 通知回调里的墙钟（ms/次）：`docks` 回答「每键是不是还在重排侧槽」 */
  const changeMsPerCall = Number((after.editor.changeMs / changeCalls).toFixed(2))
  const docksMsPerCall = Number((after.editor.docksMs / changeCalls).toFixed(2))
  /**
   * 单键的调用栈采样：回答「这 28 遍 flatten 是谁走的」。
   * 单独敲一键再读，避免 25 键把采样窗口撑满。
   */
  await page.evaluate(() => {
    window.__qua.perfReset()
    window.__qua.perfCaptureFlatten(120)
  })
  await page.keyboard.type('b', { delay: 20 })
  await sleep(250)
  const one = await page.evaluate(() => window.__qua.perf())
  const stackCounts = new Map()
  for (const s of one.flattenStacks ?? []) {
    const key = s.split('\n').slice(0, 4).join(' ← ')
    stackCounts.set(key, (stackCounts.get(key) ?? 0) + 1)
  }
  return {
    rows,
    per25,
    changeMsPerCall,
    docksMsPerCall,
    samples,
    oneKey: {
      flatten: one.tree.flattenCalls,
      visibleRows: one.tree.visibleRowsCalls,
      locate: one.tree.locateCalls,
      rowsCalls: one.editor.rowsCalls,
      renderBlock: one.render.renderBlockCalls,
    },
    flattenStacks: [...stackCounts].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }
}

/** 页面内滚一步并等两帧（换窗的调度在 rAF 里） */
async function scrollStep(top) {
  return page.evaluate(async (y) => {
    const host = document.getElementById('scroll')
    const t0 = performance.now()
    host.scrollTop = y
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return performance.now() - t0
  }, top)
}

async function measureScroll(total) {
  // 回顶部，让窗口从第一段开始
  await page.evaluate(() => {
    document.getElementById('scroll').scrollTop = 0
  })
  await sleep(400)
  const walls = []
  const winCalls = []
  const winRows = []
  const winMs = []
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const top = Math.floor((total * 0.7 * i) / steps)
    const before = await page.evaluate(() => window.__qua.perf())
    const wall = await scrollStep(top)
    await sleep(120)
    const after = await page.evaluate(() => window.__qua.perf())
    walls.push(wall)
    winCalls.push(after.render.applyWindowCalls - before.render.applyWindowCalls)
    winRows.push(after.render.applyWindowRows - before.render.applyWindowRows)
    winMs.push(after.render.applyWindowMs - before.render.applyWindowMs)
  }
  return {
    steps,
    scrollWallMs: { p50: pct(walls, 50), p95: pct(walls, 95) },
    applyWindow: {
      calls: winCalls.reduce((a, b) => a + b, 0),
      rowsProcessed: winRows.reduce((a, b) => a + b, 0),
      msPerCallP95: pct(winMs.filter((n) => n > 0), 95),
      msTotal: Number(winMs.reduce((a, b) => a + b, 0).toFixed(2)),
    },
  }
}

const reports = []
try {
  for (const n of SIZES) {
    const loadMs = await seed(n)
    const total = await page.evaluate(() => window.__qua.__editor.rows().length)
    const dom = await page.evaluate(() => window.__qua.snapshot().domBlocks)
    const id = await firstEditableId()
    const typing = await measureTyping(id)
    const scroll = await measureScroll(total)
    reports.push({
      rows: n,
      renderedRows: total,
      domBlocks: dom,
      seedAndReloadMs: loadMs,
      typing: {
        samples: typing.samples.length,
        p50Ms: pct(typing.samples, 50),
        p95Ms: pct(typing.samples, 95),
        per25: typing.per25,
        perKey: Object.fromEntries(
          Object.entries(typing.per25).map(([k, v]) => [k, Number((v / Math.max(1, typing.samples.length)).toFixed(2))]),
        ),
        oneKey: typing.oneKey,
        changeMsPerCall: typing.changeMsPerCall,
        docksMsPerCall: typing.docksMsPerCall,
        flattenStacks: typing.flattenStacks,
      },
      scroll,
    })
    console.log(`\n=== ${n} 行 ===`)
    console.log(JSON.stringify(reports[reports.length - 1], null, 2))
  }
} finally {
  await app.close()
}

console.log('\n汇总（JSON）：')
console.log(JSON.stringify(reports, null, 2))
