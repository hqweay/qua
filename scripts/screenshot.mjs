/**
 * `pnpm shots` —— 用 **playwright-core ＋ 系统 Chrome** 给原型拍图，存 `shots/`。
 *
 * 两条口径：
 *   · **一张图只讲一件事**：README 里的每张图都在回答一个具体问题（块长什么样、
 *     一个块能换几种看法、露面与源的关系…）。讲不清的图不如不放。
 *   · **拍出来的必须是真的**：每个场景都从**全新的假数据库**开始，用真命令面造出
 *     要拍的状态（`window.__qua.invoke`），不 P 图、不写死 DOM。
 *
 * ⚠️ 测试面的调试件（右下角角标、调试按钮）在演示产品里不存在，
 *    所以按产品构图把它们摘掉——它们不是这个应用的一部分。
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

/** 把角标、调试按钮、状态栏这几件**测试面专属**的家具摘掉（产品构建里本来就没有） */
const asProduct = () =>
  document.querySelectorAll('#badge, #badge-panel, #state-menu-btn, #status').forEach((el) => el.remove())

async function scene(name, fn, opts = {}) {
  const { ctx, page, errors } = await freshPage(browser, base, { viewport: VIEW })
  try {
    await page.evaluate(() => window.__qua.quiet(true))
    if (opts.state) await page.evaluate((s) => window.__qua.loadState(s), opts.state)
    if (opts.theme) await page.evaluate((t) => window.__qua.setTheme(t), opts.theme)
    if (opts.product !== false) await page.evaluate(asProduct)
    if (opts.page !== undefined) {
      await page.evaluate(
        (i) => window.__qua.invoke('core.page/open', { pageId: window.__qua.pages()[i].id }),
        opts.page,
      )
    }
    await fn(page)
    await page.waitForTimeout(180)
    const file = `${SHOTS}${name}.png`
    await shot(page, file)
    written.push(`${name}.png`)
    if (errors.length) console.log(`  ⚠ ${name}: ${errors.join(' | ')}`)
  } finally {
    await ctx.close()
  }
}

/** 按标题前缀打开一页（种子库里那几页的名字是判据，改种子要连带改这里） */
const openPage = (page, prefix) =>
  page.evaluate((p) => {
    const hit = window.__qua.pages().find((x) => (x.title ?? '').startsWith(p))
    if (!hit) throw new Error(`no page like ${p}`)
    window.__qua.invoke('core.page/open', { pageId: hit.id })
  }, prefix)

const blockByText = (page, text) =>
  page.evaluate((s) => {
    const b = window.__qua.blocks().find((x) => x.text.startsWith(s))
    if (!b) throw new Error(`no block like ${s}`)
    return b.id
  }, text)

console.log(`\n截图：${base}（${mode}）\n`)

/* ------------------------------------------------------------- 首屏 */

// 头图：默认落点（今日日记流）。这一屏就是产品导览——主张、地址、行内图片、
// 引用与悬空引用、标签、待办两态，全都是可拆可改的真内容。
await scene(
  'readme-hero',
  async (p) => {
    const id = await blockByText(p, '相 / Qua 是一个块级大纲笔记')
    await p.evaluate((bid) => window.__qua.focusBlock(bid, 2), id)
  },
  { theme: 'light' },
)

// 一张有内容的页：页头别名、行内引用、四种区间格式、待办、标签 chip、页底查询与引用栏。
await scene(
  'readme-page',
  async (p) => {
    await openPage(p, '产品设计')
    await p.waitForTimeout(120)
    const id = await blockByText(p, '行内图片也走这一层')
    await p.evaluate((bid) => window.__qua.focusBlock(bid, 0), id)
  },
  { theme: 'light' },
)

/* --------------------------------------------------------- 控件与浮层 */

await scene('overlay-命令面板', async (p) => {
  await p.evaluate(() => window.__qua.focus())
  await p.evaluate(() => window.__qua.openPalette())
  await p.locator('.layer-input').fill('视图')
})

await scene('overlay-块菜单', async (p) => {
  await p.evaluate(() => {
    // 块标左键 = 聚焦；菜单在**右键**
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

/* --------------------------------------------------------- 一个块几种看法 */

/**
 * **同一个查询，七种看法**。条件只有一条（`#任务`），成员始终是那四块；
 * 看法只决定怎么画——这一组图要说明的正是「换看法不重查」。
 */
const taskPage = async (p, kinds) => {
  // 「还没做完的」：`{prop:{eq:false}}` 与「不是任务」是两件事（勾选框没有「未填」态），
  // 所以条件写成「是任务 ＋ 任务状态 ＝ 否」两条都要。那张表/看板的分组列因此只有一个值。
  const TASK_STATUS = await p.evaluate(() => window.__qua.propDefs()[0].id)
  await p.evaluate((propId) =>
    window.__qua.invoke('core.query/create', {
      name: '任务总览',
      spec: { where: { all: [{ tag: '任务' }, { prop: { id: propId, eq: false } }] }, scope: 'all' },
    }),
    TASK_STATUS,
  )
  const id = await p.evaluate(() => String(window.__qua.snapshot().activeId))
  await p.waitForTimeout(120)
  for (const kind of kinds) {
    await p.evaluate(
      ([owner, k]) => window.__qua.invoke('core.view/add', { owner, kind: k }),
      [{ kind: 'block', blockId: id }, kind],
    )
  }
  // 整屏打开的查询默认摊开条件树；图里让它收成一条 chip，结果区占满一屏
  await p.evaluate(() => document.querySelectorAll('[data-qt="close"]').forEach((b) => b.click()))
  await p.waitForTimeout(150)
}

await scene(
  'view-表格',
  async (p) => {
    await taskPage(p, ['table'])
    await p.waitForTimeout(150)
  },
  { theme: 'light' },
)

await scene(
  'view-看板',
  async (p) => {
    await taskPage(p, ['board'])
    await p.waitForTimeout(150)
  },
  { theme: 'light' },
)

// 条件树展开时的样子：一行一条、读成一句话，且/或 ＋ 每层一个「非」。
await scene(
  'query-条件树',
  async (p) => {
    await openPage(p, '产品设计')
    await p.waitForTimeout(150)
    const id = await blockByText(p, '本页的待办')
    await p.evaluate((bid) => window.__qua.invoke('core.block/focus-block', { blockId: bid }), id)
    await p.waitForTimeout(300)
    // 行内体的条件默认收成一条 chip：点它就地在抬头下摊开（整屏查询则是默认展开的）
    await p.evaluate(() => {
      const chip = [...document.querySelectorAll('[data-query-chip="summary"]')].find((el) => el.offsetHeight > 0)
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await p.waitForTimeout(200)
  },
  { theme: 'light' },
)

/* ------------------------------------------------- 同一块在两处：露面与窗口 */

// 露面：把一页以「大纲表格」摆进另一页的正文里。空心块标说的就是
// 「这一行的身体不是一份独立内容」——同一块，两个位置，一处编辑两处同步。
await scene(
  'embed-大纲表格',
  async (p) => {
    await openPage(p, '输入面笔记')
    await p.waitForTimeout(150)
    const at = await blockByText(p, '一行里塞满行内原子')
    const target = await p.evaluate(() => window.__qua.pages().find((x) => (x.title ?? '').startsWith('产品设计')).id)
    await p.evaluate(
      ([blockId, targetId]) =>
        window.__qua.invoke('core.embed/insert', { blockId, targetId, view: 'table' }),
      [at, target],
    )
    await p.waitForTimeout(200)
    await p.evaluate(() => window.__qua.invoke('core.dock/toggle-right', {}))
    await p.waitForTimeout(150)
    await p.evaluate(() => {
      const b = window.__qua.blocks().find((x) => x.text.startsWith('一行里塞满行内原子'))
      window.__qua.focusBlock(b.id, 0)
    })
    await p.waitForTimeout(150)
  },
  { theme: 'light' },
)

// 侧槽窗口：打开一个块＝槽里多一张钉住的窗口卡，卡里是同一份内容，能直接改。
// 右边那一列是槽的家当：窗口卡 ＋ 检视卡 ＋ 反链 ＋ 回收站（一张卡回答一个问题）。
await scene(
  'dock-窗口卡',
  async (p) => {
    await openPage(p, '产品设计')
    await p.waitForTimeout(150)
    const sub = await blockByText(p, '交付层：槽里只有块')
    await p.evaluate((bid) => window.__qua.invoke('core.dock/open-block', { blockId: bid, side: 'right' }), sub)
    await p.waitForTimeout(200)
    const line = await blockByText(p, '组件第二处就抽出来')
    await p.evaluate((bid) => window.__qua.focusBlock(bid, 0), line)
    await p.waitForTimeout(150)
  },
  { theme: 'light' },
)

/* ------------------------------------------------------------- 主题 */

await scene('theme-暗色', async () => {}, { theme: 'dark' })

/* ------------------------------------------------------- 状态与降级 */

await scene('state-空态', async () => {}, { state: 'empty' })
await scene('state-稀疏态', async () => {}, { state: 'sparse' })
await scene('state-降级态', async () => {}, { state: 'degraded' })

/* ------------------------------------------------- 编辑器真的在打字 */

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

await browser.close()
if (server) server.close()
console.log(`共 ${written.length} 张：${written.join('、')}\n`)
