/**
 * **浮层族（② 小型菜单 / popover）的并置探针**（W2 用，不进 gate）。
 *
 * 量三件事：改了没有（边框宽度 / 有没有影 / 圆角）、有没有变小或错位、裁一张细节图。
 * 与 `probe-selbar-geom.mjs` 分工：那个管落位与翻面，这个管「面子」。
 *
 *   PROBE_TAG=before node checks/probe-float-family.mjs
 *   PROBE_TAG=after  node checks/probe-float-family.mjs
 *
 * ⚠️ 纯 JS。改完 `node --check`。⚠️ 先 `VITE_QUA_TEST=1` 构建 dist，跑时 `QUA_NO_DEV=1`。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { freshPage, launch, resolveBase, shot } from '../scripts/harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const TAG = process.env.PROBE_TAG ?? 'before'

const seed = (a) => {
  window.__qua.forceForest((forest) => {
    const at = Date.now()
    forest.length = 0
    forest.push({
      id: a.host,
      content: [{ t: 'text', v: '浮层族探针' }],
      children: Array.from({ length: 6 }, (_, i) => ({
        id: `fl-b${i}`,
        content: [{ t: 'text', v: `${i} 菜单与浮层的面子：边框、影、圆角、分组` }],
        children: [],
        created: at,
        modified: at,
      })).concat([{ id: 'fl-empty', content: [], children: [], created: at, modified: at }]),
      created: at,
      modified: at,
      props: { _aliases: ['浮层族探针'], _lists: ['page'] },
    })
  })
}

/** 量 `.layer`（菜单）与 `.popover` 的「面子」参数 */
const face = (sel) => {
  const el = document.querySelector(sel)
  if (!el) return null
  const cs = getComputedStyle(el)
  const r = el.getBoundingClientRect()
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    left: Math.round(r.left),
    top: Math.round(r.top),
    border: cs.borderTopWidth,
    radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 46) + '…',
    bg: cs.backgroundColor,
  }
}

const run = async (browser, base) => {
  const out = []
  const cases = [
    {
      name: 'block-menu',
      open: async (page) => {
        await page.evaluate(() => {
          const el = document.querySelector('.blk .handle')
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 260, clientY: 200 }))
        })
        await page.waitForSelector('.layer', { timeout: 3000 })
      },
      sel: '.layer',
    },
    {
      name: 'palette',
      open: async (page) => {
        await page.keyboard.press('Meta+p')
        await page.waitForSelector('.layer', { timeout: 3000 })
      },
      sel: '.layer',
    },
    {
      name: 'slash',
      open: async (page) => {
        // 斜杠只在**空行**行首出菜单：落在正文中间打 `/` 是普通字符
        await page.evaluate(() => window.__qua.focusBlock('fl-empty', 0))
        await page.keyboard.type('/')
        await page.waitForSelector('.layer', { timeout: 3000 })
      },
      sel: '.layer',
    },
    {
      name: 'badge',
      // 常驻的状态徽标：不打开任何菜单，只要它在页面上
      open: async () => {},
      sel: '#badge',
    },
  ]

  for (const c of cases) {
    const { ctx, page } = await freshPage(browser, base)
    try {
      await page.evaluate(seed, { host: 'fl-page' })
      await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: 'fl-page' }))
      await page.waitForSelector('#editor .blk[data-block-id="fl-b0"]', { timeout: 5000 })
      await c.open(page)
      const f = await page.evaluate(face, c.sel)
      out.push({ case: c.name, face: f })
      await mkdir(SHOTS, { recursive: true })
      await shot(page, `${SHOTS}fl-${TAG}-${c.name}.png`)
      if (f) {
        const pad = 20
        const x = Math.max(0, f.left - pad)
        const y = Math.max(0, f.top - pad)
        await shot(page, `${SHOTS}fl-${TAG}-${c.name}-zoom.png`, {
          clip: { x, y, width: Math.min(1440 - x, f.w + pad * 2), height: Math.min(900 - y, f.h + pad * 2) },
        })
      }
      console.log(`${c.name} ok`)
    } catch (err) {
      out.push({ case: c.name, face: null, error: String(err && err.message ? err.message : err) })
      console.log(`${c.name} ERROR ${err && err.message ? err.message.split('\n')[0] : err}`)
    } finally {
      await ctx.close()
    }
  }
  return out
}

const main = async () => {
  const browser = await launch()
  const { base } = await resolveBase()
  const rows = await run(browser, base)
  await browser.close()
  console.log(`浮层族 ${TAG}`)
  for (const r of rows) {
    const f = r.face
    if (!f) {
      console.log(`${r.case.padEnd(14)} MISSING`)
      continue
    }
    console.log(
      `${r.case.padEnd(14)}${String(f.w).padStart(5)}×${String(f.h).padEnd(5)} 边框=${f.border.padEnd(4)} 圆角=${f.radius.padEnd(6)} 影=${f.shadow}`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
