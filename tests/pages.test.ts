/**
 * **页块**的构造与「按名字找到或创建」。
 *
 * 这里钉住两条容易分叉的口径：
 *   · 空页必须自带一个可编辑的首子块（页名行是名字，不是写正文的地方）；
 *   · 同名地址优先复用、只补 `page` 露面 —— 不建第二个同名块（地址全局唯一）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensurePageDirect, hasList, mkPageBlock, mkTagBlock } from '../src/core/index.ts'

test('mkPageBlock：名字进地址、带 page 露面与一个可写的空首子块', () => {
  const p = mkPageBlock('甲')
  assert.deepEqual(p.props?._aliases, ['甲'])
  assert.deepEqual(p.props?._lists, ['page'])
  assert.equal(p.children.length, 1)
  assert.equal(p.children[0]?.content.length, 0)
})

test('mkPageBlock：空名字仍有地址（未命名-短 id），不落非法形状', () => {
  const p = mkPageBlock()
  const name = p.props?._aliases?.[0] ?? ''
  assert.match(name, /^未命名-/)
  assert.ok(name.length > 4)
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
