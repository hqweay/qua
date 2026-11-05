import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faceChrome } from '../src/ui/search/face-chrome.ts'

/**
 * 形态只经由 `faceChrome()` 翻译。这一组断言钉住两件事：
 * 紧凑形态收掉了哪些 tab 专属件，以及**预览从不被收**。
 */
test('tab 形态：晋升入口与预览都在', () => {
  const chrome = faceChrome(false)
  assert.equal(chrome.promote, true)
  assert.equal(chrome.preview, true)
})

test('compact 形态：只收 tab 专属的晋升入口，预览必须留着', () => {
  const chrome = faceChrome(true)
  assert.equal(chrome.promote, false, '紧凑形态不摆「晋升为查询块」')
  assert.equal(chrome.preview, true, '藏了预览就等于「点了结果行没反应」')
})
