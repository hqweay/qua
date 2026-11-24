/**
 * 档位轴的纯判据：一根轴两档、进档循环、退档到底不动、槽的可见性是「prefs ∧ 档位没强制收起 ∧ 用户没放开过」。
 *
 * overlay 口径的可执行版本：进入不写 prefs ⇒ 退出的还原是**自动**的（判据退回读 prefs），
 * 不需要快照。用户在档位期间动过的那一侧以他为准（`released` 记「动过」，值读 prefs）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AXIS_MODES, axisStep, axisSlotOpen, isAxisActive, isAxisMode } from '../src/core/views/axis.ts'

const dock = (left: boolean, right: boolean) => ({ left: { open: left }, right: { open: right } })

test('档位轴两档有序：常规 → 宽屏', () => {
  assert.deepEqual(AXIS_MODES, ['normal', 'wide'])
})

test('沿轴进一档：常规→宽屏→常规，两档循环', () => {
  assert.equal(axisStep('normal', 1), 'wide')
  assert.equal(axisStep('wide', 1), 'normal', '宽屏再进回常规，不是死键')
})

test('沿轴退一档：宽屏→常规，到底不动（Esc 不循环）', () => {
  assert.equal(axisStep('wide', -1), 'normal')
  assert.equal(axisStep('normal', -1), null, '常规档没有更低的档：Esc 让给关浮层／清块选区')
})

test('常规档不在轴上：Esc 的 when 键不命中', () => {
  assert.equal(isAxisActive('normal'), false)
  assert.equal(isAxisActive('wide'), true)
})

test('未知档位值不被认（档位只认闭集；已撤的 full 不再认）', () => {
  assert.equal(isAxisMode('wide'), true)
  assert.equal(isAxisMode('full'), false)
  assert.equal(isAxisMode('fullscreen'), false)
  assert.equal(isAxisMode(42), false)
})

test('常规档：槽的可见性就是 prefs（档位不参与）', () => {
  const d = dock(true, false)
  const released = { left: false, right: false }
  assert.equal(axisSlotOpen(d, 'normal', released, 'left'), true)
  assert.equal(axisSlotOpen(d, 'normal', released, 'right'), false)
})

test('宽屏强制收起双槽：prefs 里开着的也不露面', () => {
  const d = dock(true, true)
  const released = { left: false, right: false }
  assert.equal(axisSlotOpen(d, 'wide', released, 'left'), false)
  assert.equal(axisSlotOpen(d, 'wide', released, 'right'), false)
})

test('用户在档位期间开过的那一侧以他为准（released ＋ prefs 开 ⇒ 露面）', () => {
  const d = dock(true, true)
  assert.equal(axisSlotOpen(d, 'wide', { left: true, right: false }, 'left'), true)
  // 同一档里另一侧没动过 ⇒ 仍被强制收起：两档轴不会长出「半宽半藏」的组合怪态
  assert.equal(axisSlotOpen(d, 'wide', { left: true, right: false }, 'right'), false)
})

test('用户在档位期间收起的侧不因 released 露面（可见值读 prefs，不另存）', () => {
  const d = dock(false, true)
  // 他动过左侧（released），动的是「收起」：prefs 已写 false ⇒ 仍收着
  assert.equal(axisSlotOpen(d, 'wide', { left: true, right: false }, 'left'), false)
})

test('退出还原是自动的：回到常规档，prefs 原样（不需要快照）', () => {
  // 进入前手动收过的槽（left=false），档位退出后原样收着
  const d = dock(false, true)
  const released = { left: true, right: true } // 档位期间的释放表还在（装配层退档时才清）
  assert.equal(axisSlotOpen(d, 'normal', released, 'left'), false)
  assert.equal(axisSlotOpen(d, 'normal', released, 'right'), true)
})
