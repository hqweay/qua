/**
 * 探针（web/dev）：分词 worker 在 **dev server** 下能不能起来。
 * 用法：`pnpm exec vite --port 5181 --strictPort`，再 `node checks/probe-fts-worker-dev.mjs`
 */
import { launch, openPage } from '../scripts/harness.mjs'

const base = process.env.QUA_DEV_BASE ?? 'http://localhost:5181/'
const browser = await launch()
const { page } = await openPage(browser, await browser.newContext({ locale: 'zh-CN' }), base)
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text())
})

const out = await page.evaluate(async () => {
  try {
    const m = await import('/src/app/search/tokenizer-client.ts')
    const c = m.createTokenizerClient()
    const r = await c.tokenize([
      { id: 'a', text: '你好世界' },
      { id: 'b', text: '块的全文检索' },
    ])
    c.dispose()
    return { ok: true, rows: [...r.entries()] }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})
console.log(JSON.stringify(out, null, 2))
await browser.close()
