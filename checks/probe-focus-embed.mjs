/**
 * 探针：**聚焦一个「查询镜像块」**（把查询块作为露面插到某块下面，再 zoom 进查询块）。
 *
 * 症状：`core.block/focus-block` 抛 `appendChild … contains the parent`。
 * 现场：投影抬头那台嵌套编辑器也有 `.sec`／`.sec-mount`，而段尾挂载区的装配
 * 曾经扫描整棵 `#editor` 里的 `.sec` —— 把挂载区搬进了它自己的子树。
 *
 * 这条探针只做三件事：建查询块 → 在页首插一次露面 → zoom 源块；
 * 断言不抛错，且段尾挂载区挂在**正文自己的段**上。
 * 回归用例是 `checks/smoke.mjs` 的 T229（这条探针不进 gate）。
 *
 * 用法：先 `pnpm exec vite --port 5181 --strictPort`，再
 *   `QUA_DEV_BASE=http://localhost:5181/ node checks/probe-focus-embed.mjs`
 */
import { launch, openPage } from '../scripts/harness.mjs'

const base = process.env.QUA_DEV_BASE ?? 'http://localhost:5181/'
const browser = await launch()
const { page } = await openPage(browser, await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' }), base)
page.on('pageerror', (e) => console.log('[pageerror]', e.stack))

await page.evaluate(() => {
  const orig = Node.prototype.appendChild
  Node.prototype.appendChild = function (child) {
    try {
      return orig.call(this, child)
    } catch (e) {
      const desc = (n) => (n instanceof Element ? `${n.tagName.toLowerCase()}.${n.className}` : String(n?.nodeName))
      const chain = (n) => {
        const arr = []
        for (let x = n; x && arr.length < 14; x = x.parentElement) {
          arr.push(desc(x) + (x.id ? '#' + x.id : '') + (x.dataset?.blockId ? '@' + x.dataset.blockId.slice(-6) : ''))
        }
        return arr.join(' < ')
      }
      console.error('APPEND FAIL\n  parent: ' + chain(this) + '\n  child: ' + chain(child) + '\n  stack: ' + (e instanceof Error ? e.stack : ''))
      throw e
    }
  }
})

const setup = await page.evaluate(() => {
  const q = window.__qua
  const walk = (list) => {
    for (const b of list) {
      if (b.props?._query) return b
      const hit = walk(b.children ?? [])
      if (hit) return hit
    }
    return null
  }
  const query = walk(q.__editor.store.blocks)
  const pageOf = q.pages().find((x) => (x.title ?? '').includes('欢迎使用相'))
  q.invoke('core.page/open', { pageId: pageOf.id })
  const first = q.__editor.doc.roots[0]
  q.invoke('core.embed/insert', { blockId: first.id, targetId: query.id, view: 'mirror' })
  return { queryId: query.id }
})
await page.waitForTimeout(450)

const out = await page.evaluate(async (s) => {
  const q = window.__qua
  const result = q.invoke('core.block/focus-block', { blockId: s.queryId })
  await new Promise((r) => setTimeout(r, 300))
  return {
    result,
    roots: q.__editor.doc.roots.map((b) => b.id),
    topMounts: document.querySelectorAll('#editor > .sec > .sec-mount > section.mount').length,
    mountsInsideMounts: document.querySelectorAll('section.mount section.mount').length,
  }
}, setup)
console.log(JSON.stringify(out, null, 2))
await browser.close()
