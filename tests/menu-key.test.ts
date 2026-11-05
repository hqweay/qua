/**
 * **浮层菜单的按键分派**：哪一击归菜单、哪一击归输入法。
 *
 * 钉在纯判断上，而不是在 `document` 的捕获处理器上：后者离不开 DOM，
 * 而这条判断本身就是「组合期不管、其余按菜单语义」——正是要守的那条口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { menuKeyAction } from '../src/ui/overlay/menu-key.ts'

test('输入法组词期：`↵` 归输入法，不当作「选中这一行」', () => {
  assert.equal(menuKeyAction({ key: 'Enter', isComposing: true }), 'ignore', '组合期 ↵ 是在确认候选')
  assert.equal(menuKeyAction({ key: 'Enter', isComposing: false }), 'pick', '组合结束后的 ↵ 才执行')
})

test('组合期一律不接：方向键与 Esc 也不接管', () => {
  for (const key of ['ArrowDown', 'ArrowUp', 'Escape', 'Tab', 'a']) {
    assert.equal(menuKeyAction({ key, isComposing: true }), 'ignore', `组合期的 ${key} 不该被菜单吃掉`)
  }
})

test('不组合时：菜单自己的四个键一支不差', () => {
  assert.equal(menuKeyAction({ key: 'ArrowDown' }), 'down')
  assert.equal(menuKeyAction({ key: 'ArrowUp' }), 'up')
  assert.equal(menuKeyAction({ key: 'Escape' }), 'close')
  assert.equal(menuKeyAction({ key: 'Tab' }), 'tab-next')
  assert.equal(menuKeyAction({ key: 'Tab', shiftKey: true }), 'tab-prev')
})

test('认不出的键放过去：菜单不开时不抢键，开着也不吃', () => {
  assert.equal(menuKeyAction({ key: 'a' }), 'pass')
  assert.equal(menuKeyAction({ key: 'Backspace' }), 'pass')
})
