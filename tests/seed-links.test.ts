/**
 * **种子里的外链**（首屏导览那三个地址）与 DSL 的 `[名字](地址)`。
 *
 * 为什么值得钉：首屏是唯一一处「用户不用点菜单就能看见外链长什么样」的地方。
 * 它要是写成纯文本，新功能在演示里就等于不存在；它要是写错了地址，演示会变成
 * 「链接坏了」——所以这里同时钉**有**（确实解析成 link run）与**不造**（坏地址退回纯文本）。
 *
 * ⚠️ 还有一条容易忘的副作用，写在断言里当规定：**link 不进 `plainText` 投影**
 *    （原子本来就不是文本流的一部分）。所以「地址」这三个字之后的网址不再出现在
 *    搜索/导出/引文里——这是模型口径，不是这次改动弄丢的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseInline, seedWorkspace } from '../src/core/seed.ts'
import { plainText, walkForest, checkExternalUrl, type Run } from '../src/core/index.ts'

const CANONICAL = [
  'https://github.com/hqweay/qua',
  'https://qua.leay.net/',
  'https://qua.leay.net/arch.html',
]

test('首屏的三个地址是真 link run：名字留空 ⇒ 显示地址本身，地址过白名单', () => {
  const ws = seedWorkspace()
  const links: Extract<Run, { t: 'link' }>[] = []
  for (const b of ws.blocks) {
    walkForest([b], (x) => {
      for (const r of x.content) if (r.t === 'link') links.push(r)
      return true
    })
  }
  assert.ok(links.length >= 3, `种子里应至少有三枚外链，实际 ${links.length}`)

  for (const url of CANONICAL) {
    const hit = links.filter((l) => l.url === url)
    assert.ok(hit.length > 0, `首屏应有一枚指向 ${url} 的外链`)
    // `[](地址)` 的名字留空 ⇒ `v` 落地址本身（`v` 是内容，永远不许是空串）
    for (const l of hit) assert.equal(l.v, url, `显示名留空时应显示地址本身：${JSON.stringify(l)}`)
  }
  for (const l of links) {
    assert.equal(checkExternalUrl(l.url).ok, true, `种子里不该有打不开的地址：${l.url}`)
    assert.ok(l.v.length > 0, `外链的显示文本不许是空：${JSON.stringify(l)}`)
  }
})

test('DSL：`[名字](地址)` 的名字进 `v`、地址进 `url`（两个键，不是一个）', () => {
  const { runs } = parseInline('看 [架构图](https://qua.leay.net/arch.html) 这一张')
  const link = runs.find((r) => r.t === 'link')
  assert.ok(link && link.t === 'link', `应解析出一枚外链：${JSON.stringify(runs)}`)
  assert.equal(link.v, '架构图')
  assert.equal(link.url, 'https://qua.leay.net/arch.html')
  // 它是一枚**原子**：占 1 格，前后文本各自成段
  assert.equal(runs.filter((r) => r.t === 'text').length, 2)
})

test('DSL：白名单外的地址退回纯文本（宁可点不动，也不造一枚打不开的链接）', () => {
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd']) {
    const { runs } = parseInline(`[点我](${bad})`)
    assert.equal(runs.some((r) => r.t === 'link'), false, `不该为 ${bad} 造外链：${JSON.stringify(runs)}`)
    // 原文留着，读者看得见「这里本来想放个链接」——静默吞掉比点不动更糟
    assert.ok(plainText(runs).includes(bad), `原文应原样留下：${plainText(runs)}`)
  }
})

test('外链不进 `plainText` 投影（原子不是文本流的一部分）', () => {
  const { runs } = parseInline('地址 [](https://qua.leay.net/)')
  assert.equal(plainText(runs), '地址 ', '投影只取 text run；地址住在 `url` 上')
})
