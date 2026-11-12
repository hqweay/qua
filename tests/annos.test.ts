/**
 * anno 区间锚的契约测试。
 *
 * 每条钉的都是**会静默坏**的地方，不是「顺手覆盖」：
 *   · 前缀/后缀剥离只剥出真正改动的那一小段（局部编辑 O(n) 且精确）；
 *   · 格式操作免疫（写成断言，不是注释 —— 决策里点名要的）；
 *   · 编辑点两侧的区间一个不动、一个平移，相交的交给引文重定位；
 *   · 重定位不缩短 exact、多义按最近裁决、失效返回 null；
 *   · 写字不改 id（id 是引用目标，换 id ＝ 静默杀死引用）；
 *   · 唯一写入口同时维护 annos，空 anno 不留空壳。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  editSpanOf,
  isFormatOnlyEdit,
  mapAnnos,
  relocateAnno,
  shiftAnnos,
  splitAnnos,
} from '../src/core/model/annos.ts'
import {
  clearMarks,
  mkAnno,
  textRuns,
  toggleMark,
  type Anno,
  type Run,
} from '../src/core/model/runs.ts'
import { mkBlock, writeBlockContent } from '../src/core/model/model.ts'

const annoAt = (content: Run[], start: number, end: number): Anno => {
  const a = mkAnno(content, start, end)
  assert.ok(a, '有文本的区间才能物化 anno')
  return a
}

/* ------------------------------------------------------- 前缀/后缀剥离 */

test('editSpanOf：打字/删除只剥出中间那一小段（O(n) 且精确）', () => {
  assert.deepEqual(editSpanOf(textRuns('abcd'), textRuns('abXcd')), { from: 2, to: 2, inserted: 1 })
  assert.deepEqual(editSpanOf(textRuns('abcd'), textRuns('acd')), { from: 1, to: 2, inserted: 0 })
  assert.deepEqual(editSpanOf(textRuns('abcd'), textRuns('ab')), { from: 2, to: 4, inserted: 0 })
})

test('editSpanOf：整块替换退化成一个大区间（交给 quote 重定位）', () => {
  assert.deepEqual(editSpanOf(textRuns('abc'), textRuns('xyz')), { from: 0, to: 3, inserted: 3 })
})

test('editSpanOf：原子各占 1 格，插在原子旁边不会把区间算错', () => {
  const before: Run[] = [...textRuns('ab'), { id: 'r1', t: 'ref', to: 'p1' }, ...textRuns('cd')]
  const after: Run[] = [...textRuns('ab'), { id: 'r1', t: 'ref', to: 'p1' }, ...textRuns('cXd')]
  // 格序：a(0) b(1) ref(2) c(3) X(4) d(5) ⇒ 插入点在 4
  assert.deepEqual(editSpanOf(before, after), { from: 4, to: 4, inserted: 1 })
})

/* ------------------------------------------------------- 格式操作免疫 */

test('格式操作免疫：toggleMark/clearMarks 前后 anno 逐字节相等（断言，不是注释）', () => {
  const content = textRuns('abcdef')
  const annos = [annoAt(content, 1, 3), annoAt(content, 4, 6)]
  const marked = toggleMark(content, { bold: true }, 0, 6)
  const inked = toggleMark(content, { ink: 'red' }, 0, 6)
  const cleared = clearMarks(inked, 0, 6)
  assert.ok(isFormatOnlyEdit(editSpanOf(content, marked)))
  assert.ok(isFormatOnlyEdit(editSpanOf(content, cleared)))
  assert.equal(JSON.stringify(mapAnnos(content, marked, annos)), JSON.stringify(annos))
  assert.equal(JSON.stringify(mapAnnos(content, cleared, annos)), JSON.stringify(annos))
})

/* ------------------------------------------------------- 区间平移/重定位 */

test('mapAnnos：编辑点两侧一个不动、一个整体平移；id 一个不换', () => {
  const before = textRuns('abcdefgh')
  const a1 = annoAt(before, 0, 2)
  const a2 = annoAt(before, 5, 7)
  const after = textRuns('abcdeXYZfgh')
  const out = mapAnnos(before, after, [a1, a2])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0]!.range, { start: 0, end: 2 })
  assert.deepEqual(out[1]!.range, { start: 8, end: 10 })
  assert.equal(out[0]!.id, a1.id)
  assert.equal(out[1]!.id, a2.id)
})

test('mapAnnos：与编辑区间相交 ⇒ 交给 quote 重定位到新位置', () => {
  const before = textRuns('红句子在这里')
  const a = annoAt(before, 0, 3)
  const after = textRuns('前面加了很多字，红句子在这里')
  const out = mapAnnos(before, after, [a])
  assert.equal(out[0]!.id, a.id)
  assert.equal(out[0]!.quote?.exact, '红句子')
  assert.deepEqual(out[0]!.range, { start: 8, end: 11 })
})

test('mapAnnos：引文彻底消失 ⇒ 保留旧 range 与 quote 漂着（不删条、不换 id）', () => {
  const before = textRuns('红句子在这里')
  const a = annoAt(before, 0, 3)
  const out = mapAnnos(before, textRuns('完全不一样的字'), [a])
  assert.equal(out.length, 1)
  assert.equal(out[0]!.id, a.id)
  assert.deepEqual(out[0]!.range, a.range)
  assert.equal(out[0]!.quote?.exact, '红句子')
})

/* ------------------------------------------------------- 重定位口径 */

test('relocateAnno：多义命中按「上下文吻合 + 离原位置最近」裁决', () => {
  const content = textRuns('同名甲句，中间一段，同名乙句')
  const a: Anno = {
    id: 'fixed-id',
    range: { start: 15, end: 19 },
    quote: { exact: '同名', prefix: '', suffix: '' },
  }
  const got = relocateAnno(content, a)
  assert.ok(got)
  assert.equal(got.id, 'fixed-id')
  assert.deepEqual(got.range, { start: 10, end: 12 })
})

test('relocateAnno：不缩短 exact（exact 不再完整出现即失效，不制造假阳性）', () => {
  const a: Anno = { id: 'x', range: { start: 0, end: 3 }, quote: { exact: '红句子', prefix: '', suffix: '' } }
  assert.equal(relocateAnno(textRuns('只剩半句红'), a), null)
})

test('relocateAnno：没有 quote 的 anno 不臆造位置', () => {
  const a: Anno = { id: 'x', range: { start: 0, end: 3 } }
  assert.equal(relocateAnno(textRuns('红句子在这里'), a), null)
})

/* ------------------------------------------------------- 合并 / 拆块 */

test('shiftAnnos / splitAnnos：合并平移、拆块两侧各归各块且 id 不换', () => {
  const a: Anno = { id: 'a', range: { start: 2, end: 5 } }
  const b: Anno = { id: 'b', range: { start: 7, end: 9 } }
  assert.deepEqual(shiftAnnos([a], 4), [{ id: 'a', range: { start: 6, end: 9 } }])
  const parts = splitAnnos([a, b], 6)
  assert.deepEqual(parts.left, [{ id: 'a', range: { start: 2, end: 5 } }])
  assert.deepEqual(parts.right, [{ id: 'b', range: { start: 1, end: 3 } }])
})

test('splitAnnos：跨切点的那条留在原块，不拆成两条（拆就要换新 id）', () => {
  const a: Anno = { id: 'a', range: { start: 3, end: 8 } }
  const parts = splitAnnos([a], 5)
  assert.equal(parts.left.length, 0)
  assert.equal(parts.right.length, 1)
  assert.equal(parts.right[0]!.id, 'a')
  assert.deepEqual(parts.right[0]!.range, { start: 0, end: 3 })
})

/* ------------------------------------------------------- 唯一写入口 */

test('writeBlockContent：写内容同时维护 annos（29 个调用点一处都不用改）', () => {
  const b = mkBlock(textRuns('abcdef'))
  const a = annoAt(b.content, 4, 6)
  b.annos = [a]
  writeBlockContent(b, textRuns('abXcdef'))
  assert.equal(b.annos?.length, 1)
  assert.equal(b.annos![0]!.id, a.id)
  assert.deepEqual(b.annos![0]!.range, { start: 5, end: 7 })
})

test('writeBlockContent：没有 anno 时不留空数组（形状口径）', () => {
  const b = mkBlock(textRuns('abc'))
  writeBlockContent(b, textRuns('abcd'))
  assert.equal(b.annos, undefined)
})
