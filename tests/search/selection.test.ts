/**
 * 搜索面「现在选中哪一条」与「住哪要不要逐行重复」的两条判据。
 *
 * 为什么值得单测：这两条各有一个**只有真机才看得见**的失效方式——
 *   · 跨列表保留选中 ⇒ 「首条自动选中」静默失效，选中停在上一份列表的那一条上
 *     （它在新的结果里可能排在末尾，屏幕上看起来像「没选中」）；
 *   · 逐行重复同一句「住哪」⇒ 片段被挤成一截，而省下的那几十像素一个字都没多说。
 * 两个都发生在渲染层，单测抓不到 DOM，所以判据必须先收成纯函数再被这里钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAfterRemoval, pickSelection, sharedHintOf } from '../../src/ui/search/selection.ts'

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

test('住哪：整批来自同一处 ⇒ 提进分组标题（行里不再重复）', () => {
  assert.equal(sharedHintOf(['产品设计 · 决策日志', '产品设计 · 决策日志']), '产品设计 · 决策日志')
})

test('住哪：来自不同处 ⇒ 每行各说各的（那才是有用的信息）', () => {
  assert.equal(sharedHintOf(['产品设计 · 决策日志', '输入面笔记']), '')
})

test('住哪：只有一条命中时不提取（没有「公共」可言，标题里重复一次是噪音）', () => {
  assert.equal(sharedHintOf(['产品设计 · 决策日志']), '')
  assert.equal(sharedHintOf([]), '')
})
