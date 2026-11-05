import { test } from 'node:test'
import assert from 'node:assert/strict'
import { claimHighlightKey, releaseHighlightKey } from '../../src/ui/search/highlight-key.ts'

/**
 * 高亮 key 的分配。判据不是「名字好看」，而是**同屏多台宿主互不重名**：
 * `CSS.highlights.delete` 是整条删，重名 ⇒ 后关的那一面把别人还在用的高亮清掉，且不报错。
 */
test('同一基名多次领取：第一条用基名，之后派生 -2／-3', () => {
  const a = claimHighlightKey('probe-base')
  const b = claimHighlightKey('probe-base')
  const c = claimHighlightKey('probe-base')
  assert.equal(a, 'probe-base')
  assert.equal(b, 'probe-base-2')
  assert.equal(c, 'probe-base-3')
  assert.equal(new Set([a, b, c]).size, 3, '三台宿主三条 key，不许重名')
  for (const k of [a, b, c]) releaseHighlightKey(k)
})

test('归还之后可以重新领到同一个名字（重开一面不无限涨号）', () => {
  const a = claimHighlightKey('probe-reuse')
  releaseHighlightKey(a)
  const again = claimHighlightKey('probe-reuse')
  assert.equal(again, 'probe-reuse')
  releaseHighlightKey(again)
})

test('不同基名互不影响（tab 与浮层各领各的）', () => {
  const tab = claimHighlightKey('probe-tab')
  const overlay = claimHighlightKey('probe-overlay')
  assert.notEqual(tab, overlay)
  releaseHighlightKey(tab)
  releaseHighlightKey(overlay)
})
