/**
 * **划选气泡的落位探针**（A/B 用，不进 gate）。
 *
 * 它回答的不是「好不好看」，而是三个能被量的东西：
 *   1. 气泡此刻在选区的**哪一侧**（上 / 下 / 压着）；
 *   2. 在那一侧有没有**盖住**选区或越出视口；
 *   3. 展开二级之后，上面两件事**有没有变**。
 *
 * 为什么需要它：`checks/smoke.mjs` 的 T300 里两处方方位断言写的是
 * `barBottom <= selTop`，只在「上方放得下」时成立；fixture 恰好上方有空间，
 * 于是**翻面分支与 clamped 分支从未被验过**。这个探针把那两支补上。
 *
 * 用法：
 *   PROBE_TAG=A node checks/probe-selbar-geom.mjs     # 现状
 *   PROBE_TAG=B node checks/probe-selbar-geom.mjs     # 改后
 * 结果：`shots/ab-float-<TAG>.json` ＋ `shots/ab-float-<TAG>-<case>.png`
 *
 * ⚠️ 纯 JS（.mjs）：TS 语法在这里直接 SyntaxError。改完先 `node --check`。
 * ⚠️ 必须先 `VITE_QUA_TEST=1 pnpm build`（要有 `window.__qua` 测试面）。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { freshPage, launch, resolveBase, shot } from '../scripts/harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const TAG = process.env.PROBE_TAG ?? 'A'
/** 只跑名字里含这段的场景（排查时用，省得每条都等） */
const ONLY = process.env.PROBE_ONLY ?? ''
/**
 * 深色主题。应用的颜色走 `@media (prefers-color-scheme: dark)` ＋ `light-dark()`，
 * 所以模拟的是**系统偏好**，不是 `data-theme`（那个只记账、不切色）。
 */
const DARK = process.env.PROBE_DARK === '1'

const N = 40
const LONG = '这一行是用来测量气泡落位的正文，长度够长才好把选区放在行首或行尾。'

/**
 * 每个场景：视口、目标块滚到视口里的哪个 y、选行首还是行尾、要不要展开二级。
 *
 * ⚠️ `wantTop` 不能取 0：顶栏是 42px 的 absolute 层，正文滚到那底下就被盖住，
 * 鼠标点不到（实测点中的是顶栏，选区建不起来）。**用户真正能选到的最靠上的位置
 * 是顶栏下沿**，那也正是「上方放不下、必然翻面」的位置：
 * 气泡 32（展开后 58）＋ gap 10 ＋ pad 8 > 46 ⇒ 翻面。
 */
const TOP = 46

const CASES = [
  { name: 'top-mid', vp: [1440, 900], wantTop: TOP, at: 'mid', expand: null },
  { name: 'top-head', vp: [1440, 900], wantTop: TOP, at: 'head', expand: null },
  { name: 'top-tail', vp: [1440, 900], wantTop: TOP, at: 'tail', expand: null },
  { name: 'top-expanded-ink', vp: [1440, 900], wantTop: TOP, at: 'mid', expand: 'ink' },
  { name: 'middle-mid', vp: [1440, 900], wantTop: 430, at: 'mid', expand: null },
  { name: 'middle-expanded-bg', vp: [1440, 900], wantTop: 430, at: 'mid', expand: 'bg' },
  { name: 'near-bottom', vp: [1440, 900], wantTop: 830, at: 'mid', expand: null },
  { name: 'near-bottom-expanded', vp: [1440, 900], wantTop: 830, at: 'mid', expand: 'ink' },
  { name: 'short-window', vp: [1440, 360], wantTop: 170, at: 'mid', expand: null },
  { name: 'short-window-top', vp: [1440, 360], wantTop: TOP, at: 'mid', expand: 'ink' },
  { name: 'narrow-380', vp: [380, 700], wantTop: 300, at: 'mid', expand: null },
  { name: 'narrow-380-tail', vp: [380, 700], wantTop: 300, at: 'tail', expand: null },
  { name: 'wide-head', vp: [1440, 900], wantTop: 430, at: 'head', expand: null },
  { name: 'wide-tail', vp: [1440, 900], wantTop: 430, at: 'tail', expand: null },
  /**
   * 缩放两档。浏览器缩放的实质是**CSS 视口变小**（布局仍按 CSS px 算），
   * 所以用 1440×900 的 125% / 150% 等价视口来测，不必真的改 zoom。
   */
  { name: 'zoom125', vp: [1152, 720], wantTop: 340, at: 'mid', expand: null },
  { name: 'zoom150', vp: [960, 600], wantTop: 280, at: 'mid', expand: 'ink' },
]

/** 建一份够长的库：40 个块，每块一行长正文。⚠️ 只收一个参数（Playwright 的限制） */
const seed = (a) => {
  window.__qua.forceForest((forest) => {
    const at = Date.now()
    forest.length = 0
    forest.push({
      id: a.host,
      content: [{ t: 'text', v: '落位探针' }],
      children: Array.from({ length: a.n }, (_, i) => ({
        id: `geom-b${i}`,
        content: [{ t: 'text', v: `${i} ${a.text}` }],
        children: [],
        created: at,
        modified: at,
      })),
      created: at,
      modified: at,
      props: { _aliases: ['落位探针'], _lists: ['page'] },
    })
  })
}

/** 把目标块顶边滚到视口里的 `wantTop` 处，返回实际值。⚠️ 只收一个参数 */
const scrollTo = (a) => {
  const el = document.querySelector(`#editor .blk[data-block-id="${a.id}"]`)
  if (!el) return null
  el.scrollIntoView({ block: 'start' })
  const r0 = el.getBoundingClientRect()
  let sc = el.parentElement
  while (sc) {
    const cs = getComputedStyle(sc)
    if (sc.scrollHeight > sc.clientHeight + 2 && /(auto|scroll)/.test(cs.overflowY)) break
    sc = sc.parentElement
  }
  const target = sc ?? document.scrollingElement
  target.scrollTop += r0.top - a.wantTop
  return el.getBoundingClientRect().top
}

/** 量出块里某段字符的矩形（给鼠标拖选定位用）。⚠️ 只收一个参数 */
const charRect = (a) => {
  const el = document.querySelector(`#editor .blk[data-block-id="${a.id}"]`)
  if (!el) return null
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node = null
  let off = 0
  while (walker.nextNode()) {
    const t = walker.currentNode
    if (acc + t.data.length > a.start) {
      node = t
      off = a.start - acc
      break
    }
    acc += t.data.length
  }
  if (!node) return null
  const r = document.createRange()
  r.setStart(node, off)
  r.setEnd(node, Math.min(off + a.len, node.data.length))
  const b = r.getBoundingClientRect()
  return { left: b.left, right: b.right, midY: b.top + b.height / 2 }
}

const state = () => {
  const bar = document.querySelector('.selbar')
  const sel = document.getSelection()
  const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null
  const b = bar ? bar.getBoundingClientRect() : null
  const btns = [...document.querySelectorAll('.selbar .sel-btn')]
  const first = btns.length > 0 ? btns[0].getBoundingClientRect() : null
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    open: Boolean(bar),
    /** 这颗气泡是不是走了入场动画。刷新重建出来的不该走（否则点色轴会闪一下） */
    enter: bar ? bar.classList.contains('selbar-enter') : null,
    n: btns.length,
    extra: document.querySelectorAll('.selbar-extra').length,
    bar: b && { left: b.left, top: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height },
    /** 主条（按钮那一行）的位置。展开时它不该动——动了就是「点完按钮从手指下跑掉」 */
    row: (() => {
      const el = document.querySelector('.selbar .selbar-row')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom }
    })(),
    sel: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
    btn: first && { w: first.width, h: first.height },
    /**
     * 气泡压在几个块上。翻到下方时**不压选区**（`covered` 为 0），
     * 但它会压住选区下面那一行的正文——那是另一种伤害，要单独量。
     */
    coveredBlocks: (() => {
      if (!b) return 0
      return [...document.querySelectorAll('#editor .blk')].filter((el) => {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return false
        return r.bottom > b.top + 1 && r.top < b.bottom - 1
      }).length
    })(),
  }
}

/** 判「在选区的哪一侧」。三者互斥，重叠优先报 overlap（那是真问题）。 */
const verdictOf = (s) => {
  if (!s.open || !s.bar || !s.sel) return 'no-bar'
  const eps = 1
  if (s.bar.bottom <= s.sel.top + eps) return 'above'
  if (s.bar.top >= s.sel.bottom - eps) return 'below'
  return 'overlap'
}

const overflowOf = (s) => {
  if (!s.bar) return null
  return {
    left: s.bar.left < -0.5,
    right: s.bar.right > s.vw + 0.5,
    top: s.bar.top < -0.5,
    bottom: s.bar.bottom > s.vh + 0.5,
  }
}

const runCase = async (browser, base, c) => {
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: c.vp[0], height: c.vp[1] } })
  if (DARK) {
    await page.emulateMedia({ colorScheme: 'dark' })
    // 重载一次，让首屏就按深色取色（`light-dark()` 在首帧解析，热切会留下半截旧色）
    await page.reload({ waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(window.__qua), undefined, { timeout: 15000 })
  }
  const out = { case: c.name, vp: c.vp, wantTop: c.wantTop, at: c.at, expand: c.expand }

  await page.evaluate(seed, { host: 'geom-page', n: N, text: LONG })
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: 'geom-page' }))
  await page.waitForSelector('#editor .blk[data-block-id="geom-b0"]', { timeout: 5000 })

  // 挑块：顶部用 b0、底部用最后一个、其余用中段
  const id = c.wantTop <= 20 ? 'geom-b0' : c.wantTop >= 800 ? `geom-b${N - 1}` : `geom-b${Math.floor(N / 2)}`

  const textLen = `${id.slice(-2)} ${LONG}`.length
  const start = c.at === 'head' ? 2 : c.at === 'tail' ? textLen - 6 : Math.floor(textLen / 2)
  /**
   * 顺序与时序都是刻意的：**先落光标 → 再滚 → 最后用真鼠标拖选**。
   *
   * `focusBlock` 会把光标滚进视野（实测把块顶边从 4 顶到 117），所以先滚会被它顶回去；
   * 而**键盘划选**同样会把光标滚回视野（shift+← 每按一次都可能触发）。
   * 鼠标拖选在视口内完成，不触发「把光标滚进视野」⇒ 选区停在滚好的位置上。
   *
   * 气泡在**画出来那一刻**按当时的选区矩形落位，之后不再跟滚动重排
   * （`layers.ts:733` 的 scroll reflow 只服务 popover）——所以必须让最后一次滚动
   * 发生在气泡出生之前，否则量到的是「气泡留在原地、选区跑掉」的旧位置。
   */
  await page.evaluate((a) => window.__qua.focusBlock(a.id, a.caret), { id, caret: start + 1 })
  out.actualTop = await page.evaluate(scrollTo, { id, wantTop: c.wantTop })
  const rect = await page.evaluate(charRect, { id, start, len: 4 })
  if (!rect) throw new Error('量不到字符矩形：正文节点可能不在预期位置')
  out.charRect = rect

  /** 命中诊断：点在谁身上。顶栏/侧槽盖住正文时，这里能立刻看出来，不必猜。 */
  const hit = await page.evaluate(
    (p) => {
      const el = document.elementFromPoint(p.x, p.y)
      return { tag: el ? el.tagName : null, cls: el ? String(el.className) : null, inEditor: Boolean(el && el.closest('#editor')) }
    },
    { x: rect.left + 1, y: rect.midY },
  )
  out.hit = hit

  /**
   * **直接写 DOM Range，不用鼠标拖选。**
   *
   * 拖选在这套编辑器上不可靠：滚过之后正文被虚拟化回收重建，量到的字符矩形与按下时的
   * 节点不是同一个（实测 `selText` 为空、气泡不出现）。而这个探针要验的是**落位**，
   * 不是手势——手势由 `checks/smoke.mjs` 的用例覆盖，这里只要一个真实的选区矩形。
   * 写 Range 之后浏览器照常发 `selectionchange`，装配层据此画气泡，走的是同一条路。
   */
  await page.evaluate((a) => {
    const el = document.querySelector(`#editor .blk[data-block-id="${a.id}"]`)
    if (!el) throw new Error('找不到目标块')
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let acc = 0
    let node = null
    let off = 0
    while (walker.nextNode()) {
      const t = walker.currentNode
      if (acc + t.data.length > a.start) {
        node = t
        off = a.start - acc
        break
      }
      acc += t.data.length
    }
    if (!node) throw new Error('找不到目标字符')
    const r = document.createRange()
    r.setStart(node, off)
    r.setEnd(node, Math.min(off + a.len, node.data.length))
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(r)
  }, { id, start, len: 4 })
  await page.waitForFunction(() => document.querySelectorAll('.selbar').length === 1, null, { timeout: 3000 }).catch(async () => {
    const diag = await page.evaluate(() => ({
      selText: String(document.getSelection() || '').slice(0, 40),
      selRects: (() => {
        const s = document.getSelection()
        if (!s || s.rangeCount === 0) return null
        const r = s.getRangeAt(0).getBoundingClientRect()
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width) }
      })(),
      scrollY: Math.round(window.scrollY),
      vh: window.innerHeight,
      vw: window.innerWidth,
    }))
    throw new Error(`气泡没出现｜hit=${JSON.stringify(hit)} charRect=${JSON.stringify(rect)} diag=${JSON.stringify(diag)}`)
  })

  if (c.expand) {
    const hit = await page.evaluate((axis) => {
      const el = document.querySelector(`.selbar .sel-btn[data-axis="${axis}"]`)
      if (!el) return false
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
      return true
    }, c.expand)
    if (hit) await page.waitForSelector(`.selbar-extra[data-axis="${c.expand}"]`, { timeout: 3000 })  }

  const s = await page.evaluate(state)
  out.state = s
  out.verdict = verdictOf(s)
  out.overflow = overflowOf(s)
  out.coveredPx = out.verdict === 'overlap' && s.bar && s.sel ? Math.max(0, Math.min(s.bar.bottom, s.sel.bottom) - Math.max(s.bar.top, s.sel.top)) : 0

  await mkdir(SHOTS, { recursive: true })
  /* ⚠️ 报告里只记**相对路径**：绝对路径会把本机目录写进产物，公开包边界机检会拦 */
  const page1 = `ab-float-${TAG}-${c.name}.png`
  await shot(page, `${SHOTS}${page1}`)
  out.shot = `shots/${page1}`
  /**
   * 再来一张**只截气泡**的细节图：整页截图缩到 1080 宽之后，按钮里的字形、
   * 内描边的深浅、色点环的粗细都看不出来了。裁剪到气泡外扩 18px，2 倍像素。
   */
  if (s.bar) {
    const pad = 18
    const x = Math.max(0, s.bar.left - pad)
    const y = Math.max(0, s.bar.top - pad)
    const w = Math.min(s.vw - x, s.bar.w + pad * 2)
    const h = Math.min(s.vh - y, s.bar.h + pad * 2)
    const page2 = `ab-float-${TAG}-${c.name}-zoom.png`
    await shot(page, `${SHOTS}${page2}`, { clip: { x, y, width: w, height: h } })
    out.zoom = `shots/${page2}`
  }
  await ctx.close()
  return out
}

const main = async () => {
  const browser = await launch()
  const { base, mode } = await resolveBase()
  console.log(`落位探针 ${TAG}｜base=${base} (${mode})\n`)

  const rows = []
  for (const c of CASES) {
    if (ONLY && !c.name.includes(ONLY)) continue
    process.stderr.write(`· ${c.name} … `)
    try {
      const r = await runCase(browser, base, c)
      rows.push(r)
      process.stderr.write(`${r.verdict}\n`)
    } catch (err) {
      const msg = String(err && err.message ? err.message : err)
      rows.push({ case: c.name, error: msg })
      process.stderr.write(`ERROR ${msg}\n`)
    }
  }
  await browser.close()

  const pad = (v, n) => String(v ?? '').padEnd(n)
  console.log(`${pad('case', 24)}${pad('n', 4)}${pad('barW×H', 12)}${pad('btn', 9)}${pad('verdict', 9)}${pad('covered', 8)}${pad('onBlocks', 9)}${pad('enter', 7)}overflow`)
  for (const r of rows) {
    if (r.error) {
      console.log(`${pad(r.case, 24)}ERROR ${r.error}`)
      continue
    }
    const s = r.state
    const ov = r.overflow
    const ovs = ov ? [ov.left && 'L', ov.right && 'R', ov.top && 'T', ov.bottom && 'B'].filter(Boolean).join('') || '-' : '-'
    console.log(
      `${pad(r.case, 24)}${pad(s.n, 4)}${pad(`${Math.round(s.bar.w)}×${Math.round(s.bar.h)}`, 12)}${pad(s.btn ? `${Math.round(s.btn.w)}×${Math.round(s.btn.h)}` : '-', 9)}${pad(r.verdict, 9)}${pad(Math.round(r.coveredPx), 8)}${pad(s.coveredBlocks, 9)}${pad(s.enter ? 'yes' : 'no', 7)}${ovs}`,
    )
  }

  await writeFile(`${SHOTS}ab-float-${TAG}.json`, JSON.stringify(rows, null, 2))
  console.log(`\n明细：shots/ab-float-${TAG}.json`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
