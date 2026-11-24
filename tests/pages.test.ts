/**
 * **页块**的构造与「按名字找到或创建」。
 *
 * 这里钉住三条容易分叉的口径：
 *   · 名字同时落进地址与正文（与「把带字的块标成页」同形），并自带一个可编辑的首子块；
 *   · 没有名字时不往正文里塞占位名；
 *   · 同名地址优先复用、只补 `page` 露面 —— 不建第二个同名块（地址全局唯一）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensurePageDirect, hasList, mkBlock, mkPageBlock, mkTagBlock, nearestPageInChain, plainText } from '../src/core/index.ts'

test('mkPageBlock：名字同时进地址与正文、带 page 露面与一个可写的空首子块', () => {
  const p = mkPageBlock('甲')
  assert.deepEqual(p.props?._aliases, ['甲'])
  assert.deepEqual(p.props?._lists, ['page'])
  assert.equal(plainText(p.content), '甲')
  assert.equal(p.children.length, 1)
  assert.equal(p.children[0]?.content.length, 0)
})

test('mkPageBlock：空名字仍有地址（未命名-短 id），正文留空', () => {
  const p = mkPageBlock()
  const name = p.props?._aliases?.[0] ?? ''
  assert.match(name, /^未命名-/)
  assert.ok(name.length > 4)
  assert.equal(plainText(p.content), '')
})

test('ensurePageDirect：同名标签 ⇒ 复用它并补 page 露面，不建第二个块', () => {
  const tag = mkTagBlock('兼位')
  const forest = [tag]
  const got = ensurePageDirect(forest, '兼位')
  assert.equal(got?.id, tag.id)
  assert.equal(forest.length, 1)
  assert.ok(hasList(tag, 'tag'))
  assert.ok(hasList(tag, 'page'))
})

test('ensurePageDirect：没有同名地址 ⇒ 建一个新页（落森林顶层）', () => {
  const forest: ReturnType<typeof mkPageBlock>[] = []
  const got = ensurePageDirect(forest, '新页')
  assert.ok(got)
  assert.equal(forest.length, 1)
  assert.equal(got?.id, forest[0]?.id)
  assert.ok(hasList(got!, 'page'))
})

test('ensurePageDirect：空名字不建块', () => {
  const forest: ReturnType<typeof mkPageBlock>[] = []
  assert.equal(ensurePageDirect(forest, '   '), null)
  assert.equal(forest.length, 0)
})

test('nearestPageInChain：自己是页就是自己；最近的页赢（嵌套时贴着自己的优先）', () => {
  const outer = mkPageBlock('外')
  const inner = mkPageBlock('内')
  const row = mkBlock('行')
  assert.equal(nearestPageInChain(outer, [])?.id, outer.id, '页块自己住自己下面')
  assert.equal(nearestPageInChain(row, [outer, inner])?.id, inner.id)
})

test('nearestPageInChain：链上没有页 ⇒ 落顶层根；链为空 ⇒ undefined', () => {
  const root = mkBlock('根')
  const row = mkBlock('行')
  assert.equal(nearestPageInChain(row, [root])?.id, root.id, '分组永远有落点，不出现「未设置」')
  assert.equal(nearestPageInChain(row, []), undefined)
})
