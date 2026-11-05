import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faceChrome } from '../src/ui/search/face-chrome.ts'

/**
 * 形态只经由 `faceChrome()` 翻译。这一组断言钉住三件事：
 * 紧凑形态收掉了哪些 tab 专属件、**预览从不被收**，以及两面同屏时各用哪条高亮 key。
 */
test('tab 形态：晋升入口与可编辑预览都在', () => {
  const chrome = faceChrome(false)
  assert.equal(chrome.promote, true)
  assert.equal(chrome.preview, true)
  assert.equal(chrome.expand, false, '「展开为面板」是浮层专属')
  assert.equal(chrome.bareEnterOpens, false, 'tab 的裸 ↵ 是进右列预览')
  assert.equal(chrome.previewReadOnly, false)
  assert.equal(chrome.highlightKey, 'search-match', 'tab 沿用既有断言钉住的那条 key')
})

test('compact 形态：只收 tab 专属的晋升入口，预览必须留着且可编辑', () => {
  const chrome = faceChrome(true)
  assert.equal(chrome.promote, false, '紧凑形态不摆「晋升为查询块」')
  assert.equal(chrome.preview, true, '藏了预览就等于「点了结果行没反应」')
  assert.equal(chrome.expand, true, '浮层要把词带去常驻面')
  assert.equal(chrome.bareEnterOpens, false, '浮层输入框的 ↵ 是进预览，不是打开块')
  assert.equal(chrome.previewReadOnly, false, '浮层预览可编辑（与 tab 同一台预览）')
  assert.equal(chrome.highlightKey, 'search-match-overlay', '两面同屏必须各有基名')
})

test('两面同屏：高亮 key 不重名', () => {
  const tab = faceChrome(false)
  const compact = faceChrome(true)
  assert.notEqual(tab.highlightKey, compact.highlightKey)
})
