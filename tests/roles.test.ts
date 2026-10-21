/**
 * **角色是「加/减一个机制位」，不是转换**。
 *
 * 页与标签可以兼位：同一个块 `roles: ['page','tag']`，顺序不承载语义。
 * 这里钉住四条：幂等、顺序无关、只动一个角色、去掉最后一个角色后字段消失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { addRole, hasRole, mkBlock, removeRole } from '../src/core/index.ts'

const b = (): Block => mkBlock('一块')

test('加/减角色是幂等的', () => {
  const x = b()
  assert.equal(addRole(x, 'page'), true)
  assert.equal(addRole(x, 'page'), false, '重复加不产生第二个条目')
  assert.deepEqual(x.roles, ['page'])
  assert.equal(removeRole(x, 'page'), true)
  assert.equal(removeRole(x, 'page'), false)
  assert.equal(x.roles, undefined, '去掉最后一个角色后不留空数组')
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
  assert.deepEqual([...a.roles!].sort(), [...c.roles!].sort())
})

test('减一个角色不动别的角色', () => {
  const x = b()
  addRole(x, 'page')
  addRole(x, 'tag')
  assert.equal(removeRole(x, 'tag'), true)
  assert.ok(hasRole(x, 'page'))
  assert.ok(!hasRole(x, 'tag'))
  assert.deepEqual(x.roles, ['page'])
})

test('hints：空块没有名字也能有 page；tag 的名字由调用方先校验', () => {
  const x = b()
  addRole(x, 'page')
  assert.ok(hasRole(x, 'page'))
})
