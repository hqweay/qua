/**
 * 探针：动效改造前先量三件事——
 *   ① 今天「看板拖卡」之后，DOM 到底有没有跟着换列（值分组 / 结构分组各一次）；
 *   ② View Transition 的两种作用域在这台机器上的成本与重名行为；
 *   ③ 一次 FLIP（量 rect → 改 DOM → 量 rect → animate）的耗时量级。
 *
 * 只读，不改模型。跑法：QUA_NO_DEV=1 node checks/probe-motion.mjs（先 pnpm build）。
 */
import { launch, freshPage, resolveBase } from '../scripts/harness.mjs'

const log = (...a) => console.error('[probe]', ...a)
const { base, mode, server } = await resolveBase()
const browser = await launch()
const { ctx, page } = await freshPage(browser, base)
await page.evaluate(() => window.__qua.quiet(true))

const caps = await page.evaluate(() => ({
  ua: navigator.userAgent,
  documentStartViewTransition: typeof document.startViewTransition,
  elementStartViewTransition: typeof Element.prototype.startViewTransition,
  viewTransitionName: CSS.supports('view-transition-name: x'),
  viewTransitionClass: CSS.supports('view-transition-class: x'),
  interpolateSize: CSS.supports('interpolate-size: allow-keywords'),
}))

/* ---------------------------------------------------------- 值分组 */

const qid = await page.evaluate(() => {
  const p = window.__qua.pages().find((x) => x.title.includes('欢迎使用相'))
  window.__qua.invoke('core.page/open', { pageId: p.id })
  let found = ''
  const walk = (list) => {
    for (const b of list) {
      if (!found && b.props?._query?.where) found = b.id
      walk(b.children)
    }
  }
  walk(window.__qua.__editor.store.blocks)
  return found
})
await page.evaluate((id) => window.__qua.invoke('core.block/focus-block', { blockId: id }), qid)
await page.waitForTimeout(300)
await page.evaluate(
  (id) =>
    window.__qua.invoke('core.query/set-spec', {
      owner: { kind: 'block', blockId: id },
      spec: { where: { tag: '任务' } },
    }),
  qid,
)
await page.waitForTimeout(350)
await page.evaluate(
  ({ id }) => window.__qua.invoke('core.view/add', { owner: { kind: 'block', blockId: id }, kind: 'cards' }),
  { id: qid },
)
await page.waitForTimeout(350)
const groupId = await page.evaluate(() => window.__qua.propDefs().find((d) => d.kind === 'select')?.id ?? '')
const viewId = await page.evaluate((id) => {
  const v = (window.__qua.__editor.store.find(id)?.props?._views ?? []).find((x) => x.kind === 'cards')
  return v?.id ?? ''
}, qid)
await page.evaluate(
  ({ id, vid, pid }) => window.__qua.invoke('core.view/set-group', { blockId: id, viewId: vid, groupBy: pid }),
  { id: qid, vid: viewId, pid: groupId },
)
await page.waitForTimeout(500)

const board = () =>
  page.evaluate(() => ({
    cols: [...document.querySelectorAll('.vcol')].map((c) => [c.dataset.value ?? '(unset)', c.querySelectorAll('.vcard').length]),
    ids: [...document.querySelectorAll('.vcard[data-block-id]')].map((c) => c.dataset.blockId ?? ''),
  }))

const valueBefore = await board()
const move = await page.evaluate(() => {
  const cols = [...document.querySelectorAll('.vcol')]
  const card = document.querySelector('.vcard[data-block-id]')
  const from = cols.find((c) => c.contains(card))
  const to = cols.find((c) => c !== from && c.dataset.unset !== '1' && c.dataset.value !== '')
  if (!card || !to) return null
  const id = card.dataset.blockId
  const propId = window.__qua.propDefs().find((d) => d.kind === 'select')?.id
  card.dataset.probe = '1'
  window.__qua.invoke('core.props/set-value', { blockId: id, propId, value: to.dataset.value })
  const after = document.querySelector(`.vcard[data-block-id="${id}"]`)
  return { id, sameNode: after?.dataset.probe === '1', col: after?.closest('.vcol')?.dataset.value ?? '' }
})
const valueAfter = await board()

/* ---------------------------------------------------------- View Transition 成本 */

const vt = await page.evaluate(async () => {
  const boardEl = document.querySelector('.vcards')
  const out = {}
  const time = async (fn) => {
    const t0 = performance.now()
    const t = fn()
    await t.ready
    const t1 = performance.now()
    return Math.round(t1 - t0)
  }
  out.document = await time(() => document.startViewTransition(() => {}))
  out.element = boardEl?.startViewTransition
    ? await time(() => boardEl.startViewTransition(() => {}))
    : 'unsupported'
  // 重名（同一块在两个表面同时露脸）会让整次过渡作废 —— 真踩过的形状，先量下来
  const mk = (name) => {
    const el = document.createElement('div')
    el.style.cssText = 'position:fixed;left:0;top:0;width:8px;height:8px'
    el.style.viewTransitionName = name
    document.body.appendChild(el)
    return el
  }
  const a = mk('probe-dup')
  const b = mk('probe-dup')
  try {
    const t = document.startViewTransition(() => {})
    await t.ready
    out.duplicate = 'ready'
  } catch (e) {
    out.duplicate = `${e.name}: ${e.message}`
  }
  a.remove()
  b.remove()
  return out
})

/* ---------------------------------------------------------- FLIP 成本 */

const flipCost = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.vcard')]
  const t0 = performance.now()
  const before = new Map(cards.map((el) => [el.dataset.blockId, el.getBoundingClientRect()]))
  // 故意把第一张挪到最后，制造一个真实位移
  const first = cards[0]
  if (first?.parentElement) first.parentElement.appendChild(first)
  const t1 = performance.now()
  let moved = 0
  for (const el of cards) {
    const a = before.get(el.dataset.blockId)
    const b = el.getBoundingClientRect()
    const dx = a.left - b.left
    const dy = a.top - b.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    moved++
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 200,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
    })
  }
  const t2 = performance.now()
  // 还原
  const parent = first?.parentElement
  if (first && parent && parent.firstElementChild !== first) parent.prepend(first)
  return { capture: +(t1 - t0).toFixed(1), animate: +(t2 - t1).toFixed(1), moved, cards: cards.length }
})

console.log(JSON.stringify({ mode, caps, valueBefore, move, valueAfter, vt, flipCost }, null, 2))
await ctx.close()
await browser.close()
server?.close()
