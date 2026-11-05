/**
 * 搜索面「现在选中哪一条」的两条判据：结果集到达时怎么保/换、删掉一条之后落到谁。
 *
 * 为什么值得单测：这条规则有两个入口（结果集变化、预览里删掉一块后回落），
 * 它们必须给出同一个答案。抄两遍的话，一处改了另一处不会红，只表现为「刷新之后选中跳了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAfterRemoval, pickSelection } from '../../src/ui/search/selection.ts'

test('结果集变化：旧选中还在就保留（刷新不该把用户选的那条换掉）', () => {
  assert.equal(pickSelection(['a', 'b', 'c'], 'b'), 'b')
})

test('结果集变化：旧选中不在了 ⇒ 选第一条（不是选「同位置的下一条」）', () => {
  assert.equal(pickSelection(['a', 'b', 'c'], 'gone'), 'a')
})

test('结果集变化：空结果 ⇒ 没有选中（右列随之收起）', () => {
  assert.equal(pickSelection([], 'a'), '')
})

test('删掉一条：落到**同一位置**的下一条（列表原地塌一行，选中不跳远）', () => {
  assert.equal(pickAfterRemoval(['a', 'b', 'c'], 1), 'b')
})

test('删掉最后一条：落到上一条；一条都不剩 ⇒ 没有选中', () => {
  assert.equal(pickAfterRemoval(['a', 'b'], 2), 'b')
  assert.equal(pickAfterRemoval([], 0), '')
})
