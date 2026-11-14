/**
 * 探针：**点父块前的竖线，查询块（无 children、有身体）会不会一起折？**
 *
 * 用户报：一页里有几个子块，其中一个是查询块；点父块的竖线 ⇒ 有子块的兄弟折了、
 * 查询块那一格不动 —— 屏幕上就是「同一组里有的折了、有的没折」。
 *
 * 这一档把「折前 / 折后 / 再折一次」三个读数打出来，用来定位与复验。
 * 判据三条：查询块的面板收、兄弟同时折、再点可逆；投影行同此（折面板、名字留着）。
 *
 * 用法：QUA_NO_DEV=1 node checks/probe-rail-query.mjs（先 pnpm build:test）
 * ⚠️ 诊断探针，不进 gate。结论写「实测」。
 */
import { launch, freshPage, resolveBase } from '../scripts/harness.mjs'

const { base, server } = await resolveBase()
const browser = await launch()
const { ctx, page } = await freshPage(browser, base)
await page.evaluate(() => window.__qua.quiet(true))

const info = await page.evaluate(() => {
  const q = window.__qua
  const p = q.pages().find((x) => (x.title ?? '').includes('欢迎使用相'))
  q.invoke('core.page/open', { pageId: p.id })
  const find = (l) => {
    for (const b of l) {
      if (b.props?._query) return b
      const r = find(b.children ?? [])
      if (r) return r
    }
    return null
  }
  const qb = find(q.__editor.store.blocks)
  // 找它的父块（在 editor doc 里）
  const rows = q.__editor.rows()
  const idx = rows.findIndex((r) => r.block.id === qb.id)
  return {
    qid: qb.id,
    qtext: qb.text,
    depth: rows[idx]?.depth,
    parent: idx > 0 ? rows.slice(0, idx).reverse().find((r) => r.depth === rows[idx].depth - 1)?.block.id ?? '' : '',
    parentText: idx > 0 ? rows.slice(0, idx).reverse().find((r) => r.depth === rows[idx].depth - 1)?.block.text ?? '' : '',
    parentChildren: (() => {
      const rows2 = q.__editor.rows()
      const pi = rows2.findIndex((r) => r.block.id === (idx > 0 ? rows.slice(0, idx).reverse().find((r) => r.depth === rows[idx].depth - 1)?.block.id : ''))
      if (pi < 0) return []
      const d = rows2[pi].depth
      const out = []
      for (let i = pi + 1; i < rows2.length; i++) {
        if (rows2[i].depth <= d) break
        if (rows2[i].depth === d + 1) out.push({ id: rows2[i].block.id, text: rows2[i].block.text, hasQuery: Boolean(rows2[i].block.props?._query), hasChildren: rows2[i].block.children.length })
      }
      return out
    })(),
  }
})
console.log('info:', JSON.stringify(info, null, 2))

if (info.parent) {
  const before = await page.evaluate(({ qid, pid }) => {
    const row = document.querySelector(`.blk[data-block-id="${qid}"]`)
    const body = row?.querySelector(':scope > .blk-view-body')
    const prow = document.querySelector(`.blk[data-block-id="${pid}"]`)
    const vis = (el) => Boolean(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0)
    return {
      qBody: vis(body), qFolded: body?.dataset.folded === '1', qCollapsed: row?.dataset.collapsed === '1',
      pRail: Boolean(prow?.querySelector(':scope > .rail-self')),
    }
  }, { qid: info.qid, pid: info.parent })
  console.log('before:', JSON.stringify(before))
  const clicked = await page.evaluate((pid) => {
    const prow = document.querySelector(`.blk[data-block-id="${pid}"]`)
    const rail = prow?.querySelector(':scope > .rail-self')
    if (!rail) return false
    rail.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    return true
  }, info.parent)
  console.log('clicked:', clicked)
  await page.waitForTimeout(400)
  const after = await page.evaluate(({ qid }) => {
    const row = document.querySelector(`.blk[data-block-id="${qid}"]`)
    const body = row?.querySelector(':scope > .blk-view-body')
    const vis = (el) => Boolean(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0)
    return { qBody: vis(body), qFolded: body?.dataset.folded === '1', qCollapsed: row?.dataset.collapsed === '1' }
  }, { qid: info.qid })
  console.log('after:', JSON.stringify(after))

  // 再点同一条线：应当全部展回来（可逆）
  await page.evaluate((pid) => {
    const prow = document.querySelector(`.blk[data-block-id="${pid}"]`)
    prow?.querySelector(':scope > .rail-self')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  }, info.parent)
  await page.waitForTimeout(400)
  const back = await page.evaluate(({ qid }) => {
    const row = document.querySelector(`.blk[data-block-id="${qid}"]`)
    const body = row?.querySelector(':scope > .blk-view-body')
    const vis = (el) => Boolean(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0)
    return { qBody: vis(body), qFolded: body?.dataset.folded === '1', qCollapsed: row?.dataset.collapsed === '1' }
  }, { qid: info.qid })
  console.log('back:', JSON.stringify(back))
}
/**
 * **投影行（露面的查询块）**：父块折叠时它的面板也要一起折。
 * 投影没有 `_query`，靠 `_embed` 才是「有身体」——`hasFoldable` 认它（`isEmbedBlock`）。
 */
const proj = await page.evaluate(() => {
  const q = window.__qua
  const rows = q.__editor.rows()
  const host = rows.find((r) => r.depth === 1)?.block
  if (!host) return null
  const find = (l) => {
    for (const b of l) {
      if (b.props?._query) return b
      const r = find(b.children ?? [])
      if (r) return r
    }
    return null
  }
  const target = find(q.__editor.store.blocks)
  if (!target) return null
  q.invoke('core.embed/insert', { blockId: host.id, targetId: target.id, view: 'mirror' })
  return { host: host.id, target: target.id }
})
console.log('投影 fixture:', JSON.stringify(proj))
await page.waitForTimeout(500)
if (proj) {
  const pstate = () => page.evaluate(() => {
    const row = document.querySelector('.blk[data-embed="1"]')
    const body = row?.querySelector(':scope > .blk-embed-body')
    const vis = (el) => Boolean(el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0)
    return {
      embedId: row?.dataset.blockId ?? '',
      panel: vis(body?.querySelector('.embed-panel')),
      title: vis(body?.querySelector('.embed-title-row')),
      folded: body?.dataset.folded === '1',
      collapsed: row?.dataset.collapsed === '1',
    }
  })
  const hostId = await page.evaluate(() => document.querySelector('.blk[data-embed="1"]')?.dataset.blockId ?? '')
  const parentOfHost = await page.evaluate((id) => {
    const rows = window.__qua.__editor.rows()
    const i = rows.findIndex((r) => r.block.id === id)
    for (let k = i - 1; k >= 0; k--) if (rows[k].depth === rows[i].depth - 1) return rows[k].block.id
    return ''
  }, hostId)
  console.log('投影 before:', JSON.stringify(await pstate()), 'parent=', parentOfHost)
  if (parentOfHost) {
    await page.evaluate((pid) => {
      const prow = document.querySelector(`.blk[data-block-id="${pid}"]`)
      prow?.querySelector(':scope > .rail-self')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    }, parentOfHost)
    await page.waitForTimeout(400)
    console.log('投影 after:', JSON.stringify(await pstate()))
  }
}

await ctx.close()
await browser.close()
server?.close?.()
