/**
 * 探针：**折行长块的估高 vs 真高** —— 虚拟化占位会不会系统性偏小？
 *
 * 背景：`.blk .tx` 是 `white-space: pre-wrap` 且没有 clamp（`styles/blocks.css`），
 * 所以一条长正文会折行、这一行会变高。但虚拟化的占位估高是
 * `visibleRowHeight = LINE_H(30) + extra + …`（`view/editor/block-dom.ts`），
 * 纯固定值，**不含文本折行数**。
 *
 * ⇒ 假设：长文本块的文档，虚拟化打开后滚动条总高（占位累加）**系统性小于**真实内容高，
 *    滚到底部时落点会偏。
 *
 * 判据（可判定）：
 *   O1 单条折行块：估高 vs 真高 的差
 *   O2 长文档（含折行块）：容器 scrollHeight（虚拟化开） vs 全挂载 scrollHeight
 *   O3 滚到底后，最后一行是否真的可见（落点是否偏）
 *
 * ⚠️ O3 在日记流首屏上会被下滚加载干扰（`appendRoots` 追加根）——读它之前先看 O1／O2。
 *    当前实测 O1／O2 已足以判定，O3 只作辅助。
 *
 * 用法：QUA_NO_DEV=1 node checks/probe-row-height.mjs
 * ⚠️ 诊断探针，不进 gate。
 *
 * ── 2026-11-20 实测结论（本探针的产出）─────────────────────────────
 * 缺口成立，三条读数一致：
 *   · 折行块：真高 **107px** vs 估高 **30px**（`LINE_H`）⇒ 低估 77px
 *   · 文档总高：虚拟化开 **1709** vs 全挂载 **1993** ⇒ 短 284px
 *   · 行高累加总和只差 −4px（短块估高偏**高** 2px，抵掉了长块的亏空）
 *     ⇒ 这个错**不在总量上均匀暴露**：只在「少数几条长块」时局部塌陷，
 *       滚到那一段落点才偏——所以长期没被发现。
 * 根因：`.blk .tx` 是 `white-space: pre-wrap` 且无 clamp（`styles/blocks.css`），
 *       长正文会折行变高；而 `visibleRowHeight` 只算 `LINE_H + extra + 行数`，不含折行数。
 * ⚠️ 探针自身两个坑（都踩过，别重犯）：
 *   ① 直接改 store 不 bump `store.revision` ⇒ `holdRows` 保留旧 DOM，量到的还是短行；
 *   ② 首屏是**日记流**形态，滚动会触发 `appendRoots` 下滚加载（rows 3→6），
 *      要量总高就别滚。
 */
import { launch, freshPage, resolveBase } from '../scripts/harness.mjs'

const log = (...a) => console.log(...a)
const { base, mode } = await resolveBase()
log(`base=${base} (${mode})`)

const browser = await launch()
const { page } = await freshPage(browser, base)

/** 造一条够长的正文（必定折行） */
const LONG = '这是一条很长很长的正文，用来测试折行之后这一行到底有多高。'.repeat(6)

const setup = async () => {
  return page.evaluate((longText) => {
    const ed = window.__qua.__editor
    const ws = window.__qua.snapshot()
    // 找一个有正文的块，把它正文改成长文本，后面再堆一批短块
    const list = window.__qua.blocks()
    const host = list.find((b) => b.text.length > 0) ?? list[0]
    const blk = ed.store.find(host.id)
    blk.content = [{ t: 'text', v: longText }]
    // ⚠️ 直接改 store 不 bump revision ⇒ `holdRows` 的「行上派生物可能是旧的」一票否决
    //    不成立，整屏保留旧 DOM，量到的还是原来的短行（探针第一次就是这么骗了自己）。
    ed.store.revision++
    ed.renderAll()
    return { id: host.id, total: list.length }
  }, LONG)
}

const info = await setup()
log(`\n目标块 ${info.id.slice(-6)}（全文 ${info.total} 块）`)

/** 量：这一行的真实高 vs 估高（估高从 render 协作对象取） */
const measure = () =>
  page.evaluate((id) => {
    const ed = window.__qua.__editor
    const el = document.querySelector(`.blk[data-block-id="${id}"]`)
    const tx = el?.querySelector('.tx')
    const realRow = el ? Math.round(el.getBoundingClientRect().height) : null
    const realTx = tx ? Math.round(tx.getBoundingClientRect().height) : null
    // 估高：走渲染层同一份算法
    const rows = ed.rows()
    const r = rows.find((x) => x.block.id === id)
    const est = r ? ed.render.rowHeight(r, undefined) : null
    return { realRow, realTx, est, lineH: 30 }
  }, info.id)

log('\n══ O1 单条折行块：估高 vs 真高 ══')
const o1 = await measure()
log(' ', JSON.stringify(o1))
if (o1.realRow !== null && o1.est !== null) {
  const diff = o1.realRow - o1.est
  log(`  真高 ${o1.realRow} − 估高 ${o1.est} = ${diff > 0 ? '+' : ''}${diff}px`)
  log(`  ⇒ ${diff > 2 ? '⚠️ 低估（占位会偏小）' : '✓ 估高基本准确'}`)
}

/** O2：虚拟化开 / 关 两种档位的 scrollHeight 对比 */
const scrollInfo = () =>
  page.evaluate(() => {
    const area = document.querySelector('#scroll') ?? document.querySelector('.blank-area') ?? document.body
    return { scrollHeight: Math.round(area.scrollHeight), clientHeight: Math.round(area.clientHeight), scrollTop: Math.round(area.scrollTop) }
  })

log('\n══ O2 长文档总高：虚拟化开 vs 关 ══')
await page.evaluate(() => window.__qua.setVirtualize?.(false))
await page.waitForTimeout(400)
const offInfo = await scrollInfo()
log('  虚拟化关:', JSON.stringify(offInfo))

await page.evaluate(() => window.__qua.setVirtualize?.(true, 12))
await page.waitForTimeout(500)
const onInfo = await scrollInfo()
log('  虚拟化开:', JSON.stringify(onInfo))

const delta = onInfo.scrollHeight - offInfo.scrollHeight
log(`  差 ${delta > 0 ? '+' : ''}${delta}px（开 − 关）`)
log(`  ⇒ ${Math.abs(delta) > 20 ? '⚠️ 两档总高不一致（占位估高与真高不符）' : '✓ 两档一致'}`)

/** O3：滚到底，最后一行是否可见 */
log('\n══ O3 滚到底：最后一行可见吗 ══')
await page.evaluate(() => {
  const area = document.querySelector('#scroll') ?? document.querySelector('.blank-area')
  if (area) area.scrollTop = area.scrollHeight
})
await page.waitForTimeout(600)
const bottom = await page.evaluate(() => {
  const ed = window.__qua.__editor
  const rows = ed.rows()
  const last = rows[rows.length - 1]
  const el = document.querySelector(`.blk[data-block-id="${last.block.id}"]`)
  const area = document.querySelector('#scroll') ?? document.querySelector('.blank-area')
  const box = area?.getBoundingClientRect()
  const rect = el?.getBoundingClientRect()
  return {
    lastMounted: Boolean(el),
    visible: Boolean(rect && box && rect.bottom <= box.bottom + 2 && rect.top >= box.top - 2),
    lastTop: rect ? Math.round(rect.top) : null,
    areaBottom: box ? Math.round(box.bottom) : null,
    scrollTop: area ? Math.round(area.scrollTop) : null,
    maxScroll: area ? Math.round(area.scrollHeight - area.clientHeight) : null,
  }
})
log(' ', JSON.stringify(bottom))
log(`  ⇒ ${bottom.visible ? '✓ 最后一行可见' : '⚠️ 滚到底后最后一行不可见（落点偏）'}`)

await browser.close()
