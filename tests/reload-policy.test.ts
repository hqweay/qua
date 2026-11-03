/**
 * **外部变化之后「要不要／什么时候重载」的状态机**（`view/editor/reload-policy.ts`）。
 *
 * 为什么值得单测：它收的是原先散在编辑器与可编辑块列里的四件事（欠账、防抖合并、
 * 补做排程、指针位）。这四件事一旦漂移都**不报错**——最坏的表现是某个视图停在旧形状，
 * 用户点一下别处才补上。纯状态机可以在没有 DOM 的情况下逐条钉住，比在冒烟里等
 * 一个 200ms 的计时器可靠。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import { ReloadPolicy } from '../src/view/editor/reload-policy.ts'

// 策略用的是浏览器的计时器（与编辑器其它计时代码同源）。单测只给这两个函数，
// 不引 DOM —— 它本身不认识 DOM，也不该为了测试认识。
;(globalThis as unknown as { window: { setTimeout: unknown; clearTimeout: unknown } }).window ??= {
  setTimeout,
  clearTimeout,
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 记下每次重载拿到的 ids（`undefined` ＝ 补做那一趟） */
function recorder(): { calls: (readonly string[] | undefined)[]; reload: (ids?: readonly string[]) => void } {
  const calls: (readonly string[] | undefined)[] = []
  return { calls, reload: (ids) => void calls.push(ids) }
}

test('debounceMs = 0：不冻结时立刻重载，并带上这次动过的块', () => {
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => false, debounceMs: 0, onReload: r.reload, flushMs: 5 })
  p.touch(['a', 'b'])
  assert.deepEqual(r.calls, [['a', 'b']], '同步策略不该排队')
  p.dispose()
})

test('冻结时不重载、只记欠账；解冻后补做一次（补做不带 ids）', () => {
  let frozen = true
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => frozen, debounceMs: 0, onReload: r.reload, flushMs: 5 })
  p.touch(['a'])
  assert.deepEqual(r.calls, [], '冻结期间不能换 DOM')
  p.flush()
  assert.deepEqual(r.calls, [], '仍然冻着，flush 只能把补做往后推')
  frozen = false
  p.flush()
  assert.deepEqual(r.calls, [undefined], '解冻后补做的那一趟只重装，不按 id')
  p.flush()
  assert.equal(r.calls.length, 1, '欠账只补一次')
  p.dispose()
})

test('防抖窗口把连着发生的几次变化合成一次，用最后一次的 ids', async () => {
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => false, debounceMs: 10, onReload: r.reload, flushMs: 5 })
  p.touch(['a'])
  p.touch(['b'])
  p.touch(['c'])
  assert.deepEqual(r.calls, [], '窗口没到之前不该重载')
  await sleep(30)
  assert.deepEqual(r.calls, [['c']], '只重载一次，且是最后一批')
  p.dispose()
})

test('合并窗口到点时已冻上 ⇒ 留成欠账，解冻后补做', async () => {
  let frozen = false
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => frozen, debounceMs: 5, onReload: r.reload, flushMs: 5 })
  p.touch(['a'])
  frozen = true
  await sleep(20)
  assert.deepEqual(r.calls, [], '到点时冻着就不能换 DOM')
  frozen = false
  p.flush()
  assert.deepEqual(r.calls, [undefined], '解冻后那次欠账要补上')
  p.dispose()
})

test('指针按着也算冻结；放开后由补做计时器补上（不能当场做：click 还没派发）', async () => {
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => false, debounceMs: 0, onReload: r.reload, flushMs: 5 })
  p.setPointerDown(true)
  p.touch(['a'])
  assert.deepEqual(r.calls, [], '按下期间不换 DOM')
  p.setPointerDown(false)
  assert.deepEqual(r.calls, [], '放开那一刻也不做：要让 click 先派发')
  await sleep(20)
  assert.deepEqual(r.calls, [undefined], '延迟一拍后补做')
  p.dispose()
})

test('没有欠账时 flush 不做任何事（离开区域≠每次都要重画）', () => {
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => false, debounceMs: 120, onReload: r.reload, flushMs: 5 })
  p.flush()
  assert.deepEqual(r.calls, [])
  p.dispose()
})

test('dispose 之后计时器不再触发', async () => {
  const r = recorder()
  const p = new ReloadPolicy({ frozen: () => false, debounceMs: 5, onReload: r.reload, flushMs: 5 })
  p.touch(['a'])
  p.dispose()
  await sleep(20)
  assert.deepEqual(r.calls, [], '退订之后不该还有回音')
})
