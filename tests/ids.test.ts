/**
 * **确定性 id**（`derivedId`）。
 *
 * 契约只有三条，测试名就是那三条：
 *   ① 同一个 `(kind, name)` 永远同一串（跨调用、跨进程都不变 —— 它不读时钟也不掷骰子）；
 *   ② 形状与块 id 同类（`isUuidv7Hex`）；
 *   ③ 不同 `(kind, name)` 不撞 —— 尤其是**同名不同种**（字段定义与标签可以同名）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { derivedId, isUuidv7Hex } from '../src/core/index.ts'
import { journalId } from '../src/core/index.ts'

test('derivedId：同输入同输出（纯函数，不依赖时钟与随机）', () => {
  assert.equal(derivedId('prop', 'core/task-status'), derivedId('prop', 'core/task-status'))
  assert.equal(journalId('2026-10-22'), derivedId('journal', '2026-10-22'))
})

test('derivedId：输出形状与块 id 同类', () => {
  for (const [kind, name] of [
    ['prop', 'core/task-status'],
    ['journal', '2026-10-22'],
    ['tag', '任务'],
  ] as const) {
    assert.ok(isUuidv7Hex(derivedId(kind, name)), `${kind}/${name} 应当通过 isUuidv7Hex`)
  }
})

test('derivedId：kind 参与哈希 —— 同名不同种不撞', () => {
  assert.notEqual(derivedId('prop', '任务'), derivedId('tag', '任务'))
  // 分隔符不能被拼接绕过：`('a','b:c')` 与 `('a:b','c')` 必须是两个 id
  assert.notEqual(derivedId('a', 'b:c'), derivedId('a:b', 'c'))
})

test('derivedId：典型输入两两不撞（含相邻日期）', () => {
  const inputs: [string, string][] = [
    ['prop', 'core/task-status'],
    ['prop', '评分'],
    ['prop', '任务'],
    ['tag', '任务'],
    ['journal', '2026-10-22'],
    ['journal', '2026-10-23'],
    ['journal', '2026-11-22'],
  ]
  const ids = inputs.map(([k, n]) => derivedId(k, n))
  assert.equal(new Set(ids).size, ids.length)
})

test('journalId：同一天同一个 id，不同天不同 id', () => {
  assert.equal(journalId('2026-10-22'), journalId('2026-10-22'))
  assert.notEqual(journalId('2026-10-22'), journalId('2026-10-23'))
  assert.ok(isUuidv7Hex(journalId('2026-10-22')))
})
