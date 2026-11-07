/**
 * 探针：结构分组（一级子块）的拖卡落点是不是**同步**换列。
 * 这决定 FLIP 能不能直接包住「写命令」这一步（写完当帧就有新 DOM）。
 *
 * 只读，不改模型。跑法：QUA_NO_DEV=1 node checks/probe-motion-struct.mjs
 */
import { launch, freshPage, resolveBase } from '../scripts/harness.mjs'

const { base, mode, server } = await resolveBase()
const browser = await launch()
const { ctx, page } = await freshPage(browser, base)
await page.evaluate(() => window.__qua.quiet(true))

const fx = await page.evaluate(() => {
  const q = window.__qua
  const inv = (name, args = {}) => q.invoke(name, args)
  const focus = (id) => q.focusBlock(id, 0)
  const sel = () => q.__editor.sel?.aBlock ?? ''
  inv('core.page/new')
  const root = q.__editor.doc.roots[0].id
  const stub = q.__editor.doc.roots[0].children[0].id
  inv('core.editor/insert-block', { text: '名称' })
  const r1 = sel()
  inv('core.editor/insert-block', { text: '价格' })
  const r2 = sel()
  focus(stub)
  inv('core.editor/delete-block')
  focus(r1)
  inv('core.editor/insert-block', { text: '键盘' })
  const c11 = sel()
  inv('core.editor/indent-block')
  focus(r2)
  inv('core.editor/insert-block', { text: '399' })
  const c21 = sel()
  inv('core.editor/indent-block')
  return { root, rows: [r1, r2], cells: { c11, c21 } }
})

await page.evaluate((rid) => window.__qua.invoke('core.view/add', { blockId: rid, kind: 'cards' }), fx.root)
await page.waitForTimeout(400)
const viewId = await page.evaluate((rid) => {
  const v = (window.__qua.__editor.store.find(rid)?.props?._views ?? []).find((x) => x.kind === 'cards')
  return v?.id ?? ''
}, fx.root)
await page.evaluate(
  ({ rid, vid }) => window.__qua.invoke('core.view/set-group', { blockId: rid, viewId: vid, groupBy: '', structure: true }),
  { rid: fx.root, vid: viewId },
)
await page.waitForTimeout(500)

const state = () =>
  page.evaluate(() => ({
    layout: document.querySelector('.vcards')?.dataset.layout ?? '',
    cols: [...document.querySelectorAll('.vcol[data-group-block-id]')].map((c) => ({
      group: c.dataset.groupBlockId,
      cards: [...c.querySelectorAll('.vcard[data-block-id]')].map((x) => x.dataset.blockId),
    })),
  }))

const before = await state()
const sync = await page.evaluate(
  ({ card, col }) => {
    const t0 = performance.now()
    const grip = document.querySelector(`.vcard[data-block-id="${card}"] .vcard-grip`)
    const target = document.querySelectorAll('.vcol[data-group-block-id]')[col]
    const dt = new DataTransfer()
    const ev = (type) => new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })
    grip.dispatchEvent(ev('dragstart'))
    target.dispatchEvent(ev('dragover'))
    target.dispatchEvent(ev('drop'))
    grip.dispatchEvent(ev('dragend'))
    const t1 = performance.now()
    const now = [...document.querySelectorAll('.vcol[data-group-block-id]')].map((c) => [
      c.dataset.groupBlockId,
      [...c.querySelectorAll('.vcard[data-block-id]')].map((x) => x.dataset.blockId),
    ])
    return { ms: +(t1 - t0).toFixed(2), now }
  },
  { card: fx.cells.c11, col: 1 },
)
const after = await state()

console.log(JSON.stringify({ mode, fx, before, sync, after }, null, 2))
await ctx.close()
await browser.close()
server?.close()
