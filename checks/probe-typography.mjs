/**
 * **内容层的排版读数探针**（W4 立项前的测量，不进 gate）。
 *
 * 它不判好坏，只把「节奏」变成数字：字号、行高、行宽（几个字）、相邻块间距、层级步长。
 * 「不现代」在浮层上表现为圆角与影，在正文上表现为**这一步多高、那一档多大**——
 * 后者只能量，不能靠看。
 *
 *   QUA_NO_DEV=1 node checks/probe-typography.mjs
 * 产出 `shots/typo-<tag>.png` ＋ 控制台表格。
 *
 * ⚠️ 纯 JS；先 `VITE_QUA_TEST=1` 构建 dist。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { freshPage, launch, resolveBase, shot } from '../scripts/harness.mjs'

const SHOTS = fileURLToPath(new URL('../shots/', import.meta.url))
const TAG = process.env.PROBE_TAG ?? 'now'

const PARAGRAPH =
  '一切皆块的代价是：屏幕上每一行都在同一个字号上说话，于是「这一句比上一句更重要」只能靠字重和缩进来表达。' +
  '当所有层级都落在同一个尺度上，读者读到的是密度，不是结构。'

const seed = (a) => {
  window.__qua.forceForest((forest) => {
    const at = Date.now()
    forest.length = 0
    forest.push({
      id: 'typo-page',
      content: [{ t: 'text', v: '内容层排版读数' }],
      children: [
        { id: 'typo-p1', content: [{ t: 'text', v: a.para }], children: [], created: at, modified: at },
        {
          id: 'typo-l1',
          content: [{ t: 'text', v: '一个子块，用来量缩进后的行宽' }],
          children: [
            { id: 'typo-l2', content: [{ t: 'text', v: '再深一层，量第二级缩进' }], children: [], created: at, modified: at },
            { id: 'typo-l2b', content: [{ t: 'text', v: '同层的兄弟块，量相邻间距' }], children: [], created: at, modified: at },
          ],
          created: at,
          modified: at,
        },
        { id: 'typo-p2', content: [{ t: 'text', v: '下一个顶层块，量「同类块之间」的间距' }], children: [], created: at, modified: at },
        { id: 'typo-p3', content: [{ t: 'text', v: a.para }], children: [], created: at, modified: at },
      ],
      created: at,
      modified: at,
      props: { _aliases: ['内容层排版读数'], _lists: ['page'] },
    })
  })
}

/** 一行能放几个全角字：量出正文列宽再除以字号 */
const metrics = () => {
  const pick = (sel) => document.querySelector(sel)
  const cs = (el) => (el ? getComputedStyle(el) : null)
  const rect = (el) => (el ? el.getBoundingClientRect() : null)

  const blk = pick('#editor .blk[data-depth="0"]')
  const deep = pick('#editor .blk[data-depth="2"]')
  const p1 = pick('#editor .blk[data-block-id="typo-p1"]')
  const p2 = pick('#editor .blk[data-block-id="typo-p2"]')
  const p3 = pick('#editor .blk[data-block-id="typo-p3"]')
  const l2 = pick('#editor .blk[data-block-id="typo-l2"]')
  const l2b = pick('#editor .blk[data-block-id="typo-l2b"]')
  /* 缩进要量**正文槽**的左边，不是块盒：块盒的 padding-left 里就是缩进 */
  const txOf = (id) => pick(`#editor .blk[data-block-id="${id}"] .tx`)
  const root = pick('#editor')
  const tx = pick('#editor .blk[data-block-id="typo-p1"] .tx')

  const b = cs(blk)
  const d = cs(deep)
  const fs = b ? parseFloat(b.fontSize) : 0
  const lh = b ? parseFloat(b.lineHeight) : 0
  const txW = tx ? rect(tx).width : 0

  return {
    rootVarMeasure: root ? getComputedStyle(document.documentElement).getPropertyValue('--ui-doc-measure').trim() : '',
    顶层: b ? { 字号: b.fontSize, 行高: b.lineHeight, 行盒: Math.round(lh) } : null,
    子层: d ? { 字号: d.fontSize, 行高: d.lineHeight } : null,
    // 全角字宽 ≈ 字号；行宽除以字号＝这一行放几个字
    每行字数: fs && txW ? Math.round(txW / fs) : 0,
    正文列宽: txW ? Math.round(txW) : 0,
    同级间距: p2 && p3 ? Math.round(rect(p3).top - rect(p2).bottom) : null,
    兄弟块行盒: p2 ? Math.round(rect(p2).height) : null,
    深层同级间距: l2 && l2b ? Math.round(rect(l2b).top - rect(l2).bottom) : null,
    缩进一级: txOf('typo-l1') && txOf('typo-p1') ? Math.round(rect(txOf('typo-l1')).left - rect(txOf('typo-p1')).left) : null,
    缩进二级: txOf('typo-l2') && txOf('typo-l1') ? Math.round(rect(txOf('typo-l2')).left - rect(txOf('typo-l1')).left) : null,
    层级步长: b && d ? `${parseFloat(b.fontSize)} → ${parseFloat(d.fontSize)}（比 ${(parseFloat(b.fontSize) / parseFloat(d.fontSize)).toFixed(2)}）` : '',
  }
}

const main = async () => {
  const browser = await launch()
  const { base } = await resolveBase()
  const { ctx, page } = await freshPage(browser, base, { viewport: { width: 1440, height: 900 } })
  await page.evaluate(seed, { para: PARAGRAPH })
  await page.evaluate(() => window.__qua.invoke('core.page/open', { pageId: 'typo-page' }))
  await page.waitForSelector('#editor .blk[data-block-id="typo-p1"]', { timeout: 5000 })
  await page.waitForTimeout(200)

  const m = await page.evaluate(metrics)
  await mkdir(SHOTS, { recursive: true })
  await shot(page, `${SHOTS}typo-${TAG}.png`)
  await browser.close()

  console.log(`排版读数 ${TAG}`)
  for (const [k, v] of Object.entries(m)) console.log(`  ${k.padEnd(10)}${typeof v === 'object' ? JSON.stringify(v) : v}`)
  console.log(`  截图       shots/typo-${TAG}.png`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
