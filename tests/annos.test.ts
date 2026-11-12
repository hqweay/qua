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
import { applyOps, fingerprint, incomingIds, lookupBlock, rebuild, type Index } from '../src/core/index.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { Tx } from '../src/core/kb/types.ts'

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

/* ------------------------------------------------------- 索引等式 */

function annoFixture() {
  const host = mkBlock(textRuns('红句子在这里'))
  const a = annoAt(host.content, 0, 3)
  host.annos = [a]
  const runs: Run[] = [...textRuns('见'), { id: 'r1', t: 'ref', to: a.id, anchor: '红句子' }]
  const source = mkBlock(runs)
  return { forest: [host, source], a, host, source }
}

/** 与 index-port 同一条范式：每批 op 走增量后必须与全量重建逐字节一致 */
function txStep(kb: MemoryKb, store: BlockStore, idx: Index, fn: (tx: Tx) => void): Index {
  const r = kb.tx(fn, {})
  const next = applyOps(idx, r.ops, store.blocks)
  assert.equal(fingerprint(next), fingerprint(rebuild(store.blocks)), 'anno 表的增量必须与全量重建逐字节一致')
  return next
}

test('索引：anno 反查表全量建表；引用指向 anno 时边归到宿主块', () => {
  const { forest, a, host, source } = annoFixture()
  const idx = rebuild(forest)
  assert.equal(idx.annos.get(a.id)?.hostId, host.id)
  assert.equal(lookupBlock(idx, a.id)?.id, host.id)
  assert.deepEqual(incomingIds(idx, host.id), [source.id])
})

test('索引：anno 表全量 == 增量（setAnnos 改区间、清空）', () => {
  const { forest, a, host } = annoFixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)))
  const kb = new MemoryKb(store)
  let idx = rebuild(store.blocks)
  assert.ok(idx.annos.has(a.id))
  idx = txStep(kb, store, idx, (tx) => tx.setAnnos(host.id, [{ ...a, range: { start: 2, end: 5 } }]))
  assert.equal(idx.annos.get(a.id)?.anno.range.start, 2)
  idx = txStep(kb, store, idx, (tx) => tx.setAnnos(host.id, []))
  assert.equal(idx.annos.has(a.id), false)
  assert.equal(lookupBlock(idx, a.id), undefined)
})

test('索引：删宿主块 ⇒ anno 反查表摘干净（引用变 dangling）', () => {
  const { forest, a, host } = annoFixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)))
  const kb = new MemoryKb(store)
  const idx = rebuild(store.blocks)
  const next = txStep(kb, store, idx, (tx) => tx.remove(host.id))
  assert.equal(next.annos.has(a.id), false)
})
