/**
 * 剪贴板多味载体的纯逻辑测试。
 *
 * 钉四件事：
 *   ① 载荷经 HTML 注释往返无损（ids / move / anchor）；
 *   ② 注释对外部应用是「不可见的坏内容」——正文 `<div>` 与注释分离，正文里出现
 *      `-->`、`<!--` 之类的字符也撞不破载荷结构（锚文本经百分号编码）；
 *   ③ 不是本应用的 HTML / 载荷损坏 ⇒ 解码为 null（粘贴端落回纯文本路径）；
 *   ④ 形状守卫：ids 必须是非空 id 串（无空白、长度有界），畸形字段一律拒绝。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCopyHtml, refsFromHtml, refsToComment, type ClipboardRefs } from '../src/view/editor/clipboard-flavor.ts'

test('载荷经注释往返无损', () => {
  const refs: ClipboardRefs = { ids: ['a1', 'b2'] }
  const html = buildCopyHtml('第一行\n第二行', refs)
  assert.deepEqual(refsFromHtml(html), refs)
  assert.ok(html.startsWith('<div>第一行</div>'))
})

test('move 与 anchor 字段往返保留；缺省字段不出现', () => {
  const full: ClipboardRefs = { ids: ['x'], move: true, anchor: '划选的几个字' }
  const html = refsToComment(full)
  const back = refsFromHtml(html)
  assert.deepEqual(back, full)

  const bare = refsFromHtml(refsToComment({ ids: ['x'] }))
  assert.deepEqual(bare, { ids: ['x'] })
  assert.equal(bare?.move, undefined)
  assert.equal(bare?.anchor, undefined)
})

test('正文含注释敏感字符也撞不破载荷', () => {
  const html = buildCopyHtml('文本里有 --> 和 <!-- 与中文/符号', { ids: ['id-1'] })
  const back = refsFromHtml(html)
  assert.deepEqual(back, { ids: ['id-1'] })
})

test('别人的 HTML / 损坏的载荷 ⇒ null', () => {
  assert.equal(refsFromHtml(null), null)
  assert.equal(refsFromHtml(''), null)
  assert.equal(refsFromHtml('<div>普通网页</div>'), null)
  assert.equal(refsFromHtml('<!--qua:refs:%22not-json'), null)
  assert.equal(refsFromHtml(refsToComment({ ids: [] } as unknown as ClipboardRefs)), null)
})

test('形状守卫：ids 必须像 id（非空、无空白、有界）', () => {
  const bad = (ids: unknown[]) => refsFromHtml(refsToComment({ ids } as unknown as ClipboardRefs))
  assert.equal(bad(['has space']), null)
  assert.equal(bad([42]), null)
  assert.equal(bad(['']), null)
  assert.equal(bad(['a'.repeat(129)]), null)
  assert.ok(bad(['a'.repeat(128)]))
})
