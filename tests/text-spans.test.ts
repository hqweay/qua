import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textSpansOf } from '../src/core/query/text-spans.ts'

/**
 * 查询词的落点必须是 **plain 偏移**：原子整枚算 1 格，chip/引用的显示名不算正文。
 *
 * 为什么这一组重要：搜索面预览的高亮与「滚到第一处命中」都只认这串偏移
 * （`paintHits` 把它当 plain 坐标）。拿 `indexOf` 的投影位置直接当偏移，
 * 在有原子的块上会整体错位——不报错，只表现为「高亮画在旁边几个字上」。
 */
const atom = { t: 'ref', id: 'r1', to: 't1', label: '目标丙', flavor: '#' } as const

test('无原子：偏移就是字符位置', () => {
  const c = [{ t: 'text', v: '前段命中词后段' }] as const
  assert.deepEqual(textSpansOf(c, '命中词'), [{ start: 2, end: 5 }])
})

test('原子在命中词之前：偏移要补上原子的那一格', () => {
  const c = [{ t: 'text', v: '前段' }, atom, { t: 'text', v: '命中词' }] as const
  // 投影是「前段命中词」，命中词在投影 2；plain 是 2 ＋ 原子 1 = 3
  assert.deepEqual(textSpansOf(c, '命中词'), [{ start: 3, end: 6 }])
})

test('chip 的显示名不算正文：只按正文匹配，不进投影', () => {
  const c = [atom, { t: 'text', v: '目标丙' }] as const
  // 正文就是「目标丙」这三个字（chip 里的名字不重复计入），命中只落正文那一处
  assert.deepEqual(textSpansOf(c, '目标丙'), [{ start: 1, end: 4 }])
})

test('跨原子：投影里连着的词，plain 区间要把原子包进来', () => {
  const c = [{ t: 'text', v: '开' }, atom, { t: 'text', v: '任务单' }] as const
  // 投影「开任务单」整体命中 ⇒ plain 0..5（含中间那一格原子）
  assert.deepEqual(textSpansOf(c, '开任务单'), [{ start: 0, end: 5 }])
})

test('大小写不敏感、同一词多处命中按出现序', () => {
  const c = [{ t: 'text', v: 'Zeta 与 zeta 都算' }] as const
  assert.deepEqual(textSpansOf(c, 'zeta'), [
    { start: 0, end: 4 },
    { start: 7, end: 11 },
  ])
})

test('空白拆词：每个词各自找，结果按起点排序', () => {
  const c = [{ t: 'text', v: '乙在前，甲在后' }] as const
  assert.deepEqual(textSpansOf(c, '甲 乙'), [
    { start: 0, end: 1 },
    { start: 4, end: 5 },
  ])
})

test('空词 / 空格：没有落点', () => {
  const c = [{ t: 'text', v: '随便写点什么' }] as const
  assert.deepEqual(textSpansOf(c, ''), [])
  assert.deepEqual(textSpansOf(c, '   '), [])
})
