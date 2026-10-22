/**
 * **地址**（页名 / 标签名共用名字空间）。
 *
 * 验收口径（86.6 第 2 步）：`#设计` ／ `# 设计 ` ／ `[[设计]]` 是**同一个块**。
 * 这一条只能靠「查找只走一个规范化入口」保证，所以这里逐个入口点一遍。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  addressOf,
  aliasOf,
  findByAlias,
  hasRole,
  isAddressable,
  mkBlock,
  ensureTag,
  findTagByName,
  normalizeAlias,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

test('规范化只有一处：去空白 + 大小写折叠，且不改写正文', () => {
  assert.equal(normalizeAlias('  设计 '), '设计')
  assert.equal(normalizeAlias('Design'), 'design')
  const x = b('x', ' Design ', { props: { _roles: ['page'] } })
  assert.equal(addressOf(x), 'design')
  assert.equal(x.text, ' Design ', '规范化只用于比较，不写回正文')
})

test('地址＝显式 _alias 优先，否则回落到正文', () => {
  assert.equal(aliasOf(b('x', '正文', { props: { _roles: ['page'] } })), '正文')
  const withAlias = b('y', '正文', { props: { _roles: ['page'], _alias: '地址' } })
  assert.equal(aliasOf(withAlias), '地址')
  assert.equal(addressOf(withAlias), '地址')
})

test('页与标签共用地址空间：# 设计 与 #设计 是同一个标签', () => {
  const forest: Block[] = []
  // 入参是**标签名**（不带 #）：`#` 是呈现时加的装饰，不是名字的一部分
  const first = ensureTag(forest, ' 设计 ')
  assert.equal(first.created, true)
  assert.ok(first.block)
  assert.equal(first.block!.text, '设计', '存的是 trim 后的名字，不是带空白的输入')

  const second = ensureTag(forest, '设计')
  assert.equal(second.created, false)
  assert.equal(second.block!.id, first.block!.id)
  assert.equal(forest.length, 1, '同名不建第二块')
})

test('同名页块已存在 ⇒ 复用它并加 tag 角色（D10：不建第二个同名块）', () => {
  const page = b('p', '设计', { props: { _roles: ['page'] } })
  const forest = [page]
  const r = ensureTag(forest, ' 设计 ')
  assert.equal(r.reused, true)
  assert.equal(r.created, false)
  assert.equal(r.block!.id, 'p')
  assert.equal(forest.length, 1)
  assert.ok(hasRole(page, 'page') && hasRole(page, 'tag'), '兼位：原角色不丢，新角色加上')
})

test('findByAlias / findTagByName 都走同一个规范化（[[ 设计 ]] 与 #设计 命中同一块）', () => {
  const forest: Block[] = [b('p', '设计', { props: { _roles: ['page'] } })]
  const tag = ensureTag(forest, '设计').block!
  assert.equal(findByAlias(forest, ' 设计 ')!.id, tag.id)
  assert.equal(findTagByName(forest, ' 设计 ')!.id, tag.id, '标签查找也只认这一处规范化')
})

test('地址空间只收页与标签：schema（字段定义）与普通块没有地址', () => {
  const schema = b('d', '设计', { props: { _roles: ['schema'] } })
  const plain = b('n', '设计')
  assert.equal(isAddressable(schema), false)
  assert.equal(isAddressable(plain), false)
  const forest = [schema, plain]
  assert.equal(findByAlias(forest, '设计'), undefined)
})

test('空名字不是地址（找不到东西，也不建块）', () => {
  const forest: Block[] = []
  assert.equal(findByAlias(forest, '   '), undefined)
  const r = ensureTag(forest, '   ')
  assert.equal(r.block, null)
  assert.equal(forest.length, 0)
})
