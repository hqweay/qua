/**
 * 探针：**快速筛选的三个面**（查询块 / 中心大纲）与「新建查询默认不查询」。
 *
 * 判据（任何一条不成立都说明这轮改动没落到位）：
 *   ① 新建查询块**一条都不查**：`_query.where = {any:[]}`、结果 0 行、正文说「还没有条件」；
 *   ② 查询块的漏斗写的是**这一张视图的切片**（默认看法 ⇒ `_defaultFilter`），
 *      不是把条件并进 `_query`；清除筛选把它删掉（不留空条件）；
 *   ③ 中心槽顶栏的漏斗筛**当前这一屏的大纲**：包含一颗标签之后只剩命中行与其祖先，
 *      正在编辑的那一块永远可见；清除之后行数回到原样。
 *
 * 用法：QUA_NO_DEV=1 node checks/probe-quick-filter.mjs（先 pnpm build:test）
 * ⚠️ 诊断探针，不进 gate。结论写「实测」。
 */
import { launch, freshPage, resolveBase } from '../scripts/harness.mjs'

const { base, server } = await resolveBase()
const browser = await launch()
const { ctx, page } = await freshPage(browser, base)
await page.evaluate(() => window.__qua.quiet(true))

const fail = (msg) => {
  console.error(`FAIL ${msg}`)
  process.exitCode = 1
}
const ok = (msg) => console.log(`ok   ${msg}`)

/* ① 新建查询块：默认不查询 */
const born = await page.evaluate(() => {
  const q = window.__qua
  const ed = q.__editor
  // 落到今天的第一行（日记天）：空块原地变查询块
  const day = ed.rows()[0].block
  q.focusBlock(ed.rows()[1]?.block.id ?? day.id, 0)
  const id = q.invoke('core.query/insert', { blockId: ed.rows()[1]?.block.id ?? day.id })
  const blk = ed.store.blocks.flatMap(function walk(b) {
    return [b, ...(b.children ?? []).flatMap(walk)]
  }).find((b) => b.props?._query)
  return { id, spec: blk?.props?._query ?? null, bid: blk?.id ?? '' }
})
await page.waitForTimeout(400)
const emptyRows = await page.evaluate(() => ({
  outline: document.querySelectorAll('.queryview-outline .blk').length,
  text: document.querySelector('.queryview [data-empty-text]')?.dataset.emptyText ?? '',
  body: document.querySelector('.queryview [data-empty]')?.dataset.empty ?? '',
  count: document.querySelector('.queryview-count')?.textContent ?? '',
}))
if (JSON.stringify(born.spec?.where) !== '{"any":[]}') fail(`① 新查询块的条件应为 {any:[]}，实际 ${JSON.stringify(born.spec?.where)}`)
else ok('① 新查询块的条件 = {any:[]}')
if (emptyRows.outline !== 0) fail(`① 新查询块应 0 行，实际 ${emptyRows.outline}`)
else ok('① 新查询块 0 行')
if (!emptyRows.text.includes('还没有条件')) fail(`① 空态应说「还没有条件」，实际「${emptyRows.text}」`)
else ok(`① 空态：「${emptyRows.text}」`)
if (emptyRows.count.includes('/') && Number(emptyRows.count.match(/\d+/)?.[0] ?? 0) > 0) {
  fail(`① 抬头不应报全库条数：${emptyRows.count}`)
}

/* ② 查询块的漏斗：写这一张视图的切片（默认看法 ⇒ _defaultFilter） */
const prep = await page.evaluate((bid) => {
  const q = window.__qua
  q.invoke('core.query/set-spec', { owner: { kind: 'block', blockId: bid }, spec: { where: { tag: '任务' } } })
  return true
}, born.bid)
await page.waitForTimeout(500)
const before = await page.evaluate(() => ({
  rows: document.querySelectorAll('.queryview-outline .blk').length,
  hasFunnel: !document.querySelector('.queryview-filter')?.hidden,
  undo: window.__qua.snapshot().undoDepth,
}))
if (!prep || !before.hasFunnel) fail('② 查询块的漏斗应可见')
else ok('② 查询块的漏斗可见')
if (before.rows < 1) fail(`② 前置：{tag:'任务'} 至少要有一行，实际 ${before.rows}`)
else ok(`② 前置：条件查询 ${before.rows} 行`)

await page.locator('.queryview-filter').first().click()
await page.waitForTimeout(250)
const panel = await page.evaluate(() => ({
  open: !document.querySelector('.queryview-filterpanel')?.hidden,
  tags: [...document.querySelectorAll('.queryview-filterpanel .quick-filter-tags .quick-filter-chip')].map((e) => e.textContent),
}))
if (!panel.open) fail('② 漏斗点开之后面板应展开')
else ok(`② 面板候选：标签 ${JSON.stringify(panel.tags)}`)

// 包含 '任务'（所有结果都带）⇒ 行数不变，但切片要写进 _defaultFilter
const tagChip = page.locator('.queryview-filterpanel .quick-filter-tags .quick-filter-chip').filter({ hasText: '任务' }).first()
await tagChip.click()
await page.waitForTimeout(400)
const afterInclude = await page.evaluate((bid) => {
  const find = (list) => {
    for (const b of list) {
      if (b.id === bid) return b
      const hit = find(b.children ?? [])
      if (hit) return hit
    }
    return null
  }
  const blk = find(window.__qua.__editor.store.blocks)
  return {
    filter: blk?.props?._defaultFilter ?? null,
    base: blk?.props?._query?.where ?? null,
    rows: document.querySelectorAll('.queryview-outline .blk').length,
    active: document.querySelector('.queryview-filter')?.dataset.active ?? '',
    undo: window.__qua.snapshot().undoDepth,
  }
}, born.bid)
if (!afterInclude.filter) fail('② 包含一颗 chip 之后应写 `_defaultFilter`')
else ok('② 写入 _defaultFilter: ' + JSON.stringify(afterInclude.filter))
if (JSON.stringify(afterInclude.base) !== '{"tag":"任务"}') fail(`② 基础条件不许被 chip 改：${JSON.stringify(afterInclude.base)}`)
else ok('② 基础条件未被 chip 改动（只写切片）')
if (afterInclude.active !== '1') fail('② 漏斗应显示「已筛」态')
else ok('② 漏斗显示已筛态')
if (afterInclude.undo <= before.undo) fail(`② 写切片应是一条可撤销的写（undo ${before.undo}→${afterInclude.undo}）`)
else ok(`② 写切片进了撤销栈（${before.undo}→${afterInclude.undo}）`)

// Shift+点同一颗 ⇒ 挪到排除：'任务' 全排掉 ⇒ 0 行
await tagChip.click({ modifiers: ['Shift'] })
await page.waitForTimeout(450)
const afterRemove = await page.evaluate(() => ({
  rows: document.querySelectorAll('.queryview-outline .blk').length,
  filter: JSON.stringify(document.querySelector('.queryview-filter')?.dataset.active ?? ''),
}))
if (afterRemove.rows !== 0) fail(`② 排除之后应 0 行，实际 ${afterRemove.rows}`)
else ok('② 排除命中 ⇒ 结果清空（判定生效）')

// 清除筛选：回原样、_defaultFilter 删掉
await page.locator('.queryview-filterpanel .quick-filter-clear').click()
await page.waitForTimeout(450)
const cleared = await page.evaluate((bid) => {
  const find = (list) => {
    for (const b of list) {
      if (b.id === bid) return b
      const hit = find(b.children ?? [])
      if (hit) return hit
    }
    return null
  }
  const blk = find(window.__qua.__editor.store.blocks)
  return {
    filter: blk?.props?._defaultFilter ?? null,
    rows: document.querySelectorAll('.queryview-outline .blk').length,
    active: document.querySelector('.queryview-filter')?.dataset.active ?? '',
  }
}, born.bid)
if (cleared.filter !== null) fail(`② 清除筛选应删掉那一格：${JSON.stringify(cleared.filter)}`)
else ok('② 清除筛选删掉了 `_defaultFilter`')
if (cleared.rows !== before.rows) fail(`② 清除之后行数应回到 ${before.rows}，实际 ${cleared.rows}`)
else ok(`② 清除之后回到 ${cleared.rows} 行`)
if (cleared.active === '1') fail('② 清除之后漏斗应回到未筛态')

/* ③ 中心槽顶栏的漏斗：筛当前这一屏的大纲 */
const pageOpen = await page.evaluate(() => {
  const q = window.__qua
  const p = q.pages().find((x) => (x.title ?? '').includes('欢迎使用相'))
  if (!p) return null
  q.invoke('core.page/open', { pageId: p.id })
  return { id: p.id, title: p.title }
})
await page.waitForTimeout(500)
if (!pageOpen) fail('③ 找不到种子页「欢迎使用相」')
const center = await page.evaluate(() => ({
  visible: !document.querySelector('#center-filter')?.hidden,
  rows: document.querySelectorAll('#editor .blk').length,
}))
if (!center.visible) fail('③ 中心顶栏的漏斗应可见')
else ok('③ 中心顶栏的漏斗可见')
if (center.rows < 3) fail(`③ 前置：这一页应有多行，实际 ${center.rows}`)
else ok(`③ 前置：这一页 ${center.rows} 行`)

// 光标落在第一条带「任务」的行上（验证 force：正在编辑的块永远可见）
await page.evaluate(() => {
  const ed = window.__qua.__editor
  const walk = (b) => {
    if ((b.props?._tags ?? []).length > 0) return b
    for (const c of b.children ?? []) {
      const hit = walk(c)
      if (hit) return hit
    }
    return null
  }
  const hit = walk(ed.doc.roots[0])
  if (hit) window.__qua.focusBlock(hit.id, 0)
})
await page.locator('#center-filter').click()
await page.waitForTimeout(250)
const centerPanel = await page.evaluate(() => ({
  open: !document.querySelector('#center-filter-panel')?.hidden,
  tags: [...document.querySelectorAll('#center-filter-panel .quick-filter-tags .quick-filter-chip')].map((e) => e.textContent),
}))
if (!centerPanel.open) fail('③ 中心漏斗点开之后面板应展开')
else ok(`③ 中心面板候选：标签 ${JSON.stringify(centerPanel.tags)}`)

const chipCount = await page.locator('#center-filter-panel .quick-filter-tags .quick-filter-chip').count()
if (chipCount === 0) fail('③ 中心面板应有标签候选')
else {
  await page.locator('#center-filter-panel .quick-filter-tags .quick-filter-chip').first().click()
  await page.waitForTimeout(450)
  const filtered = await page.evaluate(() => {
    const ed = window.__qua.__editor
    const rows = ed.rows()
    return {
      rows: rows.length,
      noHiddenCaret: rows.some((r) => (ed.caretBlock() ?? '') === r.block.id),
      dom: document.querySelectorAll('#editor .blk').length,
      active: document.querySelector('#center-filter')?.dataset.active ?? '',
    }
  })
  if (filtered.rows >= center.rows) fail(`③ 包含一颗之后行数应减少：${center.rows}→${filtered.rows}`)
  else ok(`③ 包含之后 ${center.rows}→${filtered.rows} 行（DOM ${filtered.dom}）`)
  if (!filtered.noHiddenCaret) fail('③ 正在编辑的那一块不许被筛掉')
  else ok('③ 正在编辑的那一块仍可见')
  if (filtered.active !== '1') fail('③ 中心漏斗应显示已筛态')
  else ok('③ 中心漏斗显示已筛态')

  await page.locator('#center-filter-panel .quick-filter-clear').click()
  await page.waitForTimeout(450)
  const restored = await page.evaluate(() => ({
    rows: document.querySelectorAll('#editor .blk').length,
    active: document.querySelector('#center-filter')?.dataset.active ?? '',
    panel: !document.querySelector('#center-filter-panel')?.hidden,
  }))
  if (restored.rows !== center.rows) fail(`③ 清除之后应回到 ${center.rows} 行，实际 ${restored.rows}`)
  else ok(`③ 清除之后回到 ${restored.rows} 行`)
  if (restored.active === '1') fail('③ 清除之后漏斗应回到未筛态')
}

await ctx.close()
await browser.close()
server?.close?.()
console.log(process.exitCode ? '\n有断言没通过（见上）' : '\n全部通过')
