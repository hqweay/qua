/**
 * **角色是「加/减一个机制位」，不是转换**。
 *
 * 页与标签可以兼位：同一个块同时带 `page` 与 `tag`，顺序不承载语义。
 * 这里钉住五条：幂等、顺序无关、只动一个角色、去掉最后一个角色后字段消失，
 * 以及**身份不等于角色**——日记／字段定义／查询视图的身份由数据推出。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  addRole,
  canWriteText,
  hasIdentity,
  hasRole,
  identityTags,
  isJournalBlock,
  isPropDefBlock,
  isQueryBlock,
  mkBlock,
  removeRole,
  rolesOf,
} from '../src/core/index.ts'

const b = (): Block => mkBlock('一块')

test('加/减角色是幂等的', () => {
  const x = b()
  assert.equal(addRole(x, 'page'), true)
  assert.equal(addRole(x, 'page'), false, '重复加不产生第二个条目')
  assert.deepEqual(x.props?._roles, ['page'])
  assert.equal(removeRole(x, 'page'), true)
  assert.equal(removeRole(x, 'page'), false)
  assert.equal(x.props, undefined, '去掉最后一个角色后不留空数组、也不留空属性袋')
})

test('顺序不承载语义：先页后标签与先标签后页等价', () => {
  const a = b()
  const c = b()
  addRole(a, 'page')
  addRole(a, 'tag')
  addRole(c, 'tag')
  addRole(c, 'page')
  assert.ok(hasRole(a, 'page') && hasRole(a, 'tag'))
  assert.ok(hasRole(c, 'page') && hasRole(c, 'tag'))
  assert.deepEqual(rolesOf(a).sort(), rolesOf(c).sort())
})

test('减一个角色不动别的角色', () => {
  const x = b()
  addRole(x, 'page')
  addRole(x, 'tag')
  assert.equal(removeRole(x, 'tag'), true)
  assert.ok(hasRole(x, 'page'))
  assert.ok(!hasRole(x, 'tag'))
  assert.deepEqual(x.props?._roles, ['page'])
})

test('hints：空块没有名字也能有 page；tag 的名字由调用方先校验', () => {
  const x = b()
  addRole(x, 'page')
  assert.ok(hasRole(x, 'page'))
})

test('日记／字段定义／查询视图的身份由数据推出，不存角色值', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  const def: Block = { id: 'd', text: '截止日', children: [], props: { _kind: 'date' } }
  const query: Block = { id: 'q', text: '待办', children: [], props: { _query: { where: { todo: 'todo' } } } }

  assert.ok(isJournalBlock(day))
  assert.ok(isPropDefBlock(def))
  assert.ok(isQueryBlock(query))
  assert.deepEqual(rolesOf(day), [], '日记没有角色值：日期就是全部答案')
  assert.deepEqual(rolesOf(def), [])
  assert.deepEqual(rolesOf(query), [])

  for (const x of [day, def, query]) assert.ok(hasIdentity(x), '这三个都是身份块：正文是名字或投影')
  assert.ok(hasIdentity(undefined) === false)
})

test('身份判据看数据而不看角色值：有角色但没日期不算日记', () => {
  const empty: Block = { id: 'x', text: '', children: [], props: { _date: '' } }
  assert.equal(isJournalBlock(empty), false, '空日期不是一天')
  assert.equal(hasIdentity(empty), false)

  // 形状歪掉的 `_query` 也不是查询块（判据与读条件同源）
  const badQuery: Block = { id: 'y', text: 'x', children: [], props: { _query: { scope: 'all' } } }
  assert.equal(isQueryBlock(badQuery), false)
})

test('canWriteText 与 hasIdentity 同源：身份块的正文是名字，不是内容', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  const def: Block = { id: 'd', text: '截止日', children: [], props: { _kind: 'date' } }
  const tag = b()
  addRole(tag, 'tag')

  for (const x of [day, def, tag]) {
    assert.equal(canWriteText(x), false)
    assert.ok(hasIdentity(x))
  }
})

test('identityTags：给外观与诊断面的名字集合是现算的，不落盘', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  assert.deepEqual(identityTags(day), ['journal'])
  assert.equal(day.props?._roles, undefined, '标记不许写回块')

  const page = b()
  addRole(page, 'page')
  page.props = { ...page.props, _date: '2026-10-22' }
  assert.deepEqual(identityTags(page), ['page', 'journal'], '兼位时角色与派生身份并存')
})
