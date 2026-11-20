/**
 * **行高前缀索引**（`RowHeightIndex`）的判据：前缀和、点更新、坐标反查与朴素累加逐字相同。
 *
 * 它替换的是 `slice().reduce()` 那条 O(N) 路径；一旦边界算错，表现是
 * 「滚动条长度不对 / 换窗落点偏几行」，不报错。所以这里把边界逐格钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RowHeightIndex } from '../src/view/editor/height-index.ts'

const naivePrefix = (hs: readonly number[], n: number): number => hs.slice(0, n).reduce((a, b) => a + b, 0)

const naiveFind = (hs: readonly number[], offset: number): number => {
  let acc = 0
  for (let i = 0; i < hs.length; i++) {
    acc += hs[i]!
    if (acc > offset) return i
  }
  return Math.max(0, hs.length - 1)
}

test('prefix 与朴素累加逐点一致（含 0 / 越界）', () => {
  const hs = [30, 18, 107, 30]
  const idx = new RowHeightIndex(hs)
  for (let n = 0; n <= hs.length; n++) assert.equal(idx.prefix(n), naivePrefix(hs, n), `prefix(${n})`)
  assert.equal(idx.prefix(-5), 0)
  assert.equal(idx.prefix(99), naivePrefix(hs, hs.length))
  assert.equal(idx.count, hs.length)
})

test('set 之后前缀和/总高跟着变，且与朴素结果一致', () => {
  const hs = [30, 18, 107, 30]
  const idx = new RowHeightIndex(hs)
  idx.set(1, 45)
  const next = [30, 45, 107, 30]
  for (let n = 0; n <= next.length; n++) assert.equal(idx.prefix(n), naivePrefix(next, n), `prefix(${n})`)
  assert.equal(idx.total, naivePrefix(next, next.length))
  idx.set(2, 20)
  assert.equal(idx.prefix(3), 30 + 45 + 20)
  // 非有限 / 非正 / 越界都不写
  idx.set(0, 0)
  idx.set(0, Number.NaN)
  idx.set(9, 50)
  assert.equal(idx.get(0), 30)
})

test('find 把高度坐标换成行下标，边界与朴素扫描一致', () => {
  const hs = [10, 20, 30]
  const idx = new RowHeightIndex(hs)
  for (let y = 0; y < 60; y++) assert.equal(idx.find(y), naiveFind(hs, y), `find(${y})`)
  assert.equal(idx.find(-1), 0)
  assert.equal(idx.find(60), 2, '超出总高 ⇒ 最后一行')
  assert.equal(new RowHeightIndex([]).find(0), 0)
})

test('reset 换一批行高（行集合变了）后旧状态不残留', () => {
  const idx = new RowHeightIndex([10, 20, 30])
  idx.set(0, 100)
  idx.reset([5, 5])
  assert.equal(idx.count, 2)
  assert.equal(idx.total, 10)
  assert.equal(idx.get(0), 5)
  assert.equal(idx.prefix(2), 10)
})
