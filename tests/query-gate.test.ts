/**
 * **浮层输入框的组合期守卫**（`ui/overlay/query-gate.ts`）。
 *
 * 判据只有两条：
 *   ① 组合期的每一次 `input`（拼音／候选窗更新）都不该触发过滤；
 *   ② 组合结束的那一份值算一次，与随后那个同值 `input` 合并成一次。
 *
 * ⚠️ 这里测的是**纯状态机**，不是真实输入法：真 IME 的中间态序列因平台而异，
 *    单测只能钉「我们承诺的那条规则」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QueryGate } from '../src/ui/overlay/query-gate.ts'

test('普通输入：每个不同的值都放行，同值重复不发', () => {
  const gate = new QueryGate()
  assert.equal(gate.input('a'), true)
  assert.equal(gate.input('a'), false, '同一个词不重复过滤')
  assert.equal(gate.input('ab'), true)
  assert.equal(gate.input(''), true, '清空也是一次真实的查询变化')
})

test('组合期不重过滤；组合结束只发一次（与随后的同值 input 合并）', () => {
  const gate = new QueryGate()
  gate.compositionStart()
  for (const mid of ['n', 'ni', 'nih', 'niha']) {
    assert.equal(gate.input(mid), false, `组合中间态「${mid}」不该过滤`)
  }
  assert.equal(gate.compositionEnd('niha'), true, '候选词落地时才过滤一次')
  assert.equal(gate.input('niha'), false, '随后那次同值 input 不重复')
})

test('组合结束之后回到普通输入状态', () => {
  const gate = new QueryGate()
  gate.compositionStart()
  assert.equal(gate.input('拼'), false)
  assert.equal(gate.compositionEnd('拼音'), true)
  assert.equal(gate.input('拼音x'), true, '组合期已结束，后续输入照常过滤')
})
