/**
 * `pnpm shots` —— 用 **playwright-core ＋ 系统 Chrome** 给 demo 拍图，存 `demo/shots/`。
 *
 * ⚠️ 2026-10-20：**三皮肤已删**，原先的「三套风格各一张」改为
 *    「唯一样式 × 亮/暗各一张」。外观的其余差异由外部主题包验证。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { freshPage, launch, resolveBase, shot } from './harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const VIEW = { width: 1440, height: 900 }

const { base, mode, server } = await resolveBase()
const browser = await launch()
await mkdir(SHOTS, { recursive: true })
const written = []

async function scene(name, fn, opts = {}) {
  const { ctx, page, errors } = await freshPage(browser, base, { viewport: VIEW })
  try {
    await page.evaluate(() => window.__qua.quiet(true))
    if (opts.state) await page.evaluate((s) => window.__qua.loadState(s), opts.state)
    if (opts.theme) await page.evaluate((t) => window.__qua.setTheme(t), opts.theme)
    if (opts.page !== undefined) await page.evaluate((i) => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[i].id }), opts.page)
    await fn(page)
    await page.waitForTimeout(160)
    const file = `${SHOTS}${name}.png`
    await shot(page, file)
    written.push(`${name}.png`)
    if (errors.length) console.log(`  ⚠ ${name}: ${errors.join(' | ')}`)
  } finally {
    await ctx.close()
  }
}

console.log(`\n截图：${base}（${mode}）\n`)

/* ---- 唯一样式（同一份内容、同一个视口） ---- */
await scene('默认-亮', async (p) => {
  await p.evaluate(() => window.__qua.focus())
}, { theme: 'light' })

/* ---- 亮/暗 ---- */
await scene('默认-暗', async () => {}, { theme: 'dark' })

/* ---- 浮层四件套 ---- */
await scene('overlay-命令面板', async (p) => {
  await p.evaluate(() => window.__qua.focus())
  await p.keyboard.press('Meta+p')
  await p.locator('.layer-input').fill('块')
})

await scene('overlay-块菜单', async (p) => {
  await p.evaluate(() => {
    // ：块标左键 = 聚焦；菜单在**右键**
    const el = document.querySelectorAll('.blk .marker')[1]
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
})

await scene('overlay-斜杠菜单', async (p) => {
  await p.evaluate(() => {
    const bs = window.__qua.blocks()
    window.__qua.focusBlock(bs[bs.length - 1].id, 0)
  })
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.keyboard.type('/')
})

await scene('overlay-引用信息气泡', async (p) => {
  await p.evaluate(() => {
    const el = document.querySelector('.atom-page')
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
})

await scene('badge-状态角标展开', async (p) => {
  await p.evaluate(() => window.__qua.badgePanel(true))
})

await scene('panel-绑定表', async (p) => {
  await p.evaluate(() => window.__qua.openPanel('bindings'))
})

await scene('panel-上下文键', async (p) => {
  await p.evaluate(() => window.__qua.openPanel('context'))
})

/* ---- 三个演示状态 ---- */
await scene('state-空态', async () => {}, { state: 'empty' })
await scene('state-稀疏态', async () => {}, { state: 'sparse' })
await scene('state-降级态', async () => {}, { state: 'degraded' })

/* ---- 「真的在编辑」的证据图：真按键拆块＋缩进＋加粗 ---- */
await scene('proof-真实编辑', async (p) => {
  await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.blk')]
    const pick = rows.find((r) => Number(r.dataset.depth) === 2) ?? rows[3]
    window.__qua.focusBlock(pick.dataset.blockId, 2)
  })
  await p.keyboard.press('Enter')
  await p.keyboard.type('现场敲出来的一个新块，然后 ⌘B 加粗')
  await p.keyboard.press('Shift+Home')
  await p.keyboard.press('Meta+b')
})

/* ---- 虚拟化对比 ---- */
await scene('state-虚拟化-on', async (p) => {
  await p.evaluate(() => window.__qua.setVirtualize(true, 3))
  await p.evaluate(() => window.__qua.badgePanel(true))
})

/* ---- README 头图：一张「有内容」的页（查询块 ＋ 引用 ＋ 待办 ＋ 四种区间格式） ---- */
await scene('readme-hero', async (p) => {
  await p.evaluate(() => {
    const pages = window.__qua.pages()
    const i = pages.findIndex((x) => (x.title ?? '').includes('产品设计'))
    window.__qua.invoke('core.page/open', { pageId: pages[i].id })
    window.__qua.focusBlock(window.__qua.blocks()[0].id, 0)
  })
}, { theme: 'light' })

await browser.close()
if (server) server.close()
console.log(`共 ${written.length} 张：${written.join('、')}\n`)
