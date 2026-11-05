/**
 * 输入防抖的状态机：连续输入只提交最后一次；Enter 与清空立刻提交；IME 组合期不提交。
 *
 * 用 Node 的 mock timers 推时间，不真等 140ms。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DebouncedInput } from '../../src/core/infra/debounced-input.ts'

test('连打 5 个字符只提交 1 次（值是最后一个）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  for (const v of ['a', 'ab', 'abc', 'abcd', 'abcde']) d.input(v)
  assert.deepEqual(calls, [])
  t.mock.timers.tick(139)
  assert.deepEqual(calls, [])
  t.mock.timers.tick(1)
  assert.deepEqual(calls, ['abcde'])
  d.dispose()
})

test('Enter（flush）立即提交一次，且之后不再补发', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  d.input('abc')
  d.flush()
  assert.deepEqual(calls, ['abc'])
  t.mock.timers.tick(500)
  assert.deepEqual(calls, ['abc'])
  d.dispose()
})

test('清空立即提交（走「最近更新」不能被防抖拖慢）', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  d.input('abc')
  assert.deepEqual(calls, [])
  d.input('')
  assert.deepEqual(calls, [''])
  t.mock.timers.tick(500)
  assert.deepEqual(calls, [''])
  d.dispose()
})

test('IME 组合期不提交，组合结束合并成一次', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  d.compositionStart()
  d.input('n')
  d.input('ni')
  t.mock.timers.tick(500)
  assert.deepEqual(calls, [])
  d.compositionEnd('你好')
  assert.deepEqual(calls, ['你好'])
  d.dispose()
})

test('组合开始会丢弃已排队的防抖', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  d.input('abc')
  d.compositionStart()
  t.mock.timers.tick(500)
  assert.deepEqual(calls, [])
  d.compositionEnd('abcd')
  assert.deepEqual(calls, ['abcd'])
  d.dispose()
})

test('dispose 摘掉定时器，不留悬挂回调', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls: string[] = []
  const d = new DebouncedInput((v) => calls.push(v), 140)
  d.input('abc')
  d.dispose()
  t.mock.timers.tick(500)
  assert.deepEqual(calls, [])
})
