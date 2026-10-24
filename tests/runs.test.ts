/**
 * run 层的契约测试。
 *
 * 每条测试钉的都是**模型红线**，不是「顺手覆盖」：
 *   · 投影纯（`plainText` 只由 text run 决定；quote.exact 恒为投影子串）；
 *   · 归一化幂等（库里的内容只有一种等价形状）；
 *   · 原子不可分（删旁边的字不吃原子；区间盖住才删，且整枚删）；
 *   · 格式不上 image run（归一化兜底剥掉，形状校验判非法）；
 *   · ref/link 可携带格式（整句加粗不断裂）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearMarks,
  cloneRunsNewIds,
  insertRunAt,
  isAnno,
  isCovered,
  isRun,
  joinRuns,
  locateCursor,
  marksInRange,
  mkAnno,
  normalizeRuns,
  plainLen,
  plainText,
  projectOff,
  projectRange,
  refRunsOf,
  removeRunById,
  runById,
  sameRuns,
  sliceRuns,
  spliceRuns,
  splitRuns,
  textRuns,
  toggleMark,
  type ImageRun,
  type RefRun,
  type Run,
} from '../src/core/runs.ts'

const ref = (to: string, extra: Partial<RefRun> = {}): RefRun => ({
  id: `ref-${to}-${Math.random().toString(36).slice(2, 8)}`,
  t: 'ref',
  to,
  ...extra,
})

const img = (hash: string): ImageRun => ({ id: `img-${hash}`, t: 'image', asset: { hash, state: 'ready' } })

/* ------------------------------------------------------------ 投影 */

test('plainText：只由 text run 决定，ref/link/image 不进投影', () => {
  const c: Run[] = [ ...textRuns('引用'), ref('p1', { label: '目标' }), ...textRuns('与图'), img('h1'), ...textRuns('尾') ]
  assert.equal(plainText(c), '引用与图尾')
  // plain 长度 ＝ 文本字符数 ＋ 原子各 1 格（与 DOM 展示同一坐标系）
  assert.equal(plainLen(c), '引用与图尾'.length + 2)
  assert.equal(plainText([]), '')
  assert.equal(plainText(textRuns('')), '')
})

test('projectRange：quote.exact 恒为 plainText 的子串（原子两侧的区间要先换算坐标）', () => {
  const c: Run[] = [...textRuns('前后'), ref('p1'), ...textRuns('中间'), img('h'), ...textRuns('后面')]
  // plain 坐标 [2,6) ＝ 原子 ＋ 「中间」；投影里它是「中间」
  const q = projectRange(c, 2, 6)
  assert.ok(q)
  assert.equal(q.exact, '中间')
  assert.equal(q.prefix, '前后')
  assert.equal(q.suffix, '后面')
  assert.ok(plainText(c).includes(q.exact))
})

test('projectRange：纯原子选区没有引文（null，不造空快照）', () => {
  const c: Run[] = [...textRuns('前'), ref('p1'), ...textRuns('后')]
  assert.equal(projectRange(c, 1, 2), null)
  assert.equal(mkAnno(c, 1, 2), null)
})

test('projectOff：plain 偏移 → 投影偏移（原子贡献 0）', () => {
  const c: Run[] = [...textRuns('ab'), ref('p'), ...textRuns('cd')]
  assert.equal(projectOff(c, 0), 0)
  assert.equal(projectOff(c, 2), 2)
  // 原子那一格：前缘 2、后缘 3 都映到投影 2
  assert.equal(projectOff(c, 3), 2)
  assert.equal(projectOff(c, 4), 3)
})

test('mkAnno：range 用 plain 坐标、quote 用投影坐标，两层各说各的系', () => {
  const c: Run[] = [...textRuns('一二三'), ref('p'), ...textRuns('四五六')]
  const a = mkAnno(c, 2, 6)!
  assert.ok(a)
  assert.deepEqual(a.range, { start: 2, end: 6 })
  assert.equal(a.quote?.exact, '三四五')
  assert.ok(isAnno(a))
})

/* ---------------------------------------------------------- 归一化 */

test('normalizeRuns：相邻同形 text run 合并、空段清除、marks 去重排序', () => {
  const out = normalizeRuns([
    { t: 'text', v: 'a', marks: ['bold', 'bold', 'italic'] },
    { t: 'text', v: 'b', marks: ['italic', 'bold'] },
    { t: 'text', v: '' },
    { t: 'text', v: 'c' },
  ])
  assert.deepEqual(out, [
    { t: 'text', v: 'ab', marks: ['bold', 'italic'] },
    { t: 'text', v: 'c' },
  ])
})

test('normalizeRuns：幂等（normalize(normalize(x)) 逐字节相等）', () => {
  const x: Run[] = [
    { t: 'text', v: 'a', marks: ['code'] },
    { t: 'text', v: 'b', marks: ['code'] },
    ref('p1'),
    { t: 'text', v: 'c' },
    { t: 'text', v: 'd' },
  ]
  const once = normalizeRuns(x)
  assert.deepEqual(JSON.stringify(normalizeRuns(once)), JSON.stringify(once))
})

test('normalizeRuns：image 的 marks 一律剥掉（红线：格式不上 image run）', () => {
  const bad = { ...img('h1'), marks: ['bold'] } as unknown as Run
  const out = normalizeRuns([bad])
  assert.equal((out[0] as ImageRun).marks, undefined)
})

test('sameRuns：按归一化形态比，「碰过但没改」能被识别', () => {
  const a: Run[] = [{ t: 'text', v: 'x' }, { t: 'text', v: 'y', marks: [] }]
  const b: Run[] = [{ t: 'text', v: 'xy' }]
  assert.ok(sameRuns(a, b))
  assert.ok(!sameRuns(a, [{ t: 'text', v: 'xz' }]))
})

/* ------------------------------------------------------- 原子不可分 */

test('spliceRuns：只删原子旁边的字，原子一个字节不动', () => {
  const c: Run[] = [...textRuns('ab'), ref('p'), ...textRuns('cd')]
  const rid = (c[1] as RefRun).id
  // [1,2) 只盖住「b」那一格：原子在区间外，原样保留
  const out = spliceRuns(c, 1, 2, '')
  assert.deepEqual(plainText(out), 'acd')
  assert.ok(runById(out, rid))
})

test('spliceRuns：区间盖住原子 ⇒ 整枚删（显式删除）；区间之外 ⇒ 保留', () => {
  const c: Run[] = [...textRuns('ab'), ref('p'), ...textRuns('cd')]
  const rid = (c[1] as RefRun).id
  // [1,3) 盖住「b」与原子一格：原子整枚消失，不存在「半个原子」
  const gone = spliceRuns(c, 1, 3, '')
  assert.equal(runById(gone, rid), undefined)
  assert.equal(plainText(gone), 'acd')
  const kept = spliceRuns(c, 0, 2, 'X')
  assert.ok(runById(kept, rid))
  assert.equal(plainText(kept), 'Xcd')
})

test('splitRuns：切点落在原子上 ⇒ 原子归右半；文本截断处 marks 跟着走', () => {
  const c: Run[] = [{ t: 'text', v: 'abcd', marks: ['bold'] }, ref('p'), { t: 'text', v: 'ef' }]
  const [l, r] = splitRuns(c, 2)
  assert.deepEqual(l, [{ t: 'text', v: 'ab', marks: ['bold'] }])
  assert.deepEqual(r, [{ t: 'text', v: 'cd', marks: ['bold'] }, c[1], { t: 'text', v: 'ef' }])
})

test('joinRuns：边界两侧同形 text run 并成一个（合并块）', () => {
  const l = [{ t: 'text', v: 'ab', marks: ['bold'] }] as Run[]
  const r = [{ t: 'text', v: 'cd', marks: ['bold'] }, { t: 'text', v: 'e' }] as Run[]
  assert.deepEqual(joinRuns(l, r), [
    { t: 'text', v: 'abcd', marks: ['bold'] },
    { t: 'text', v: 'e' },
  ])
})

test('insertRunAt / removeRunById：插入与删除都是显式的整枚操作', () => {
  const c: Run[] = textRuns('abc')
  const a = ref('p1')
  const withAtom = insertRunAt(c, 2, a)
  assert.deepEqual(plainText(withAtom), 'abc')
  assert.equal(plainLen(withAtom), 4)
  assert.equal(runById(withAtom, a.id)?.t, 'ref')
  assert.deepEqual(removeRunById(withAtom, a.id), c)
})

/* ------------------------------------------------------- 格式运算 */

test('toggleMark：加格式拆 run、取消格式复原；幂等形态稳定', () => {
  const c = textRuns('abcdef')
  const bold = toggleMark(c, 'bold', 2, 5)
  assert.deepEqual(bold, [
    { t: 'text', v: 'ab' },
    { t: 'text', v: 'cde', marks: ['bold'] },
    { t: 'text', v: 'f' },
  ])
  // 全覆盖 ⇒ 再按一次取消
  assert.deepEqual(toggleMark(bold, 'bold', 2, 5), c)
})

test('toggleMark：区间盖住 ref ⇒ ref 整枚携带格式（整句加粗不断裂）；image 永不携带', () => {
  const r = ref('p1')
  const im = img('h')
  const c: Run[] = [...textRuns('ab'), r, im, ...textRuns('cd')]
  const bold = toggleMark(c, 'bold', 0, plainLen(c))
  const gotRef = bold.find((x): x is RefRun => x.t === 'ref')!
  const gotImg = bold.find((x): x is ImageRun => x.t === 'image')!
  assert.deepEqual(gotRef.marks, ['bold'])
  assert.equal(gotImg.marks, undefined)
  // 区间里有 image ⇒ 永远判「未全覆盖」⇒ toggle 恒走「加」的一支（image 自己仍不动）
  assert.ok(!isCovered(c, 'bold', 0, plainLen(c)))
})

test('isCovered：部分覆盖 ⇒ false（再按一次是补齐，不是取消）', () => {
  const c = [
    { t: 'text', v: 'ab', marks: ['bold'] },
    { t: 'text', v: 'cd' },
  ] as Run[]
  assert.ok(!isCovered(c, 'bold', 0, 4))
  assert.ok(isCovered(c, 'bold', 0, 2))
})

test('clearMarks：一次清掉全部格式；文本边界拆段', () => {
  const c = toggleMark(toggleMark(textRuns('abcdef'), 'bold', 0, 6), 'italic', 2, 4)
  assert.deepEqual(clearMarks(c, 1, 5), [
    { t: 'text', v: 'a', marks: ['bold'] },
    { t: 'text', v: 'bcde' },
    { t: 'text', v: 'f', marks: ['bold'] },
  ])
})

test('marksInRange：区间上出现过的格式（气泡按压态）', () => {
  const c = [
    { t: 'text', v: 'ab', marks: ['bold'] },
    { t: 'text', v: 'cd', marks: ['bold', 'italic'] },
  ] as Run[]
  assert.deepEqual(marksInRange(c, 0, 4), ['bold', 'italic'])
  assert.deepEqual(marksInRange(c, 0, 2), ['bold'])
})

/* --------------------------------------------------------- 定位 */

test('locateCursor：plain 偏移 → run 游标（派生量，含原子边界）', () => {
  const c: Run[] = [...textRuns('ab'), ref('p'), ...textRuns('cd')]
  assert.deepEqual(locateCursor(c, 0), { index: 0, inner: 0 })
  assert.deepEqual(locateCursor(c, 1), { index: 0, inner: 1 })
  // 原子前缘（inner 0）与后缘（落到下一个 run 的 0）
  assert.deepEqual(locateCursor(c, 2), { index: 1, inner: 0 })
  assert.deepEqual(locateCursor(c, 3), { index: 2, inner: 0 })
  assert.deepEqual(locateCursor(c, 5), { index: 2, inner: 2 })
  assert.deepEqual(locateCursor([], 3), { index: 0, inner: 0 })
})

/* ----------------------------------------------------- 原子与复制 */

test('refRunsOf：按出现序提取引用 run（边提取的唯一入口）', () => {
  const a = ref('p1', { flavor: '#' })
  const b = ref('p2')
  const c: Run[] = [...textRuns('x'), b, ...textRuns('y'), a]
  assert.deepEqual(refRunsOf(c), [b, a])
})

test('cloneRunsNewIds：内容等价、原子全换新 id（复制 ≠ 共享身份）', () => {
  const a = ref('p1')
  const c: Run[] = [...textRuns('ab', ['bold']), a, img('h')]
  const cp = cloneRunsNewIds(c)
  assert.equal(plainText(cp), 'ab')
  const cpRef = cp.find((x): x is RefRun => x.t === 'ref')!
  assert.notEqual(cpRef.id, a.id)
  assert.equal(cpRef.to, 'p1')
})

/* ------------------------------------------------------ 形状校验 */

test('isRun / isAnno：合法形状放行、非法形状拦下（image 带 marks 判非法）', () => {
  assert.ok(isRun({ t: 'text', v: 'x' }))
  assert.ok(isRun({ t: 'text', v: 'x', marks: ['bold'] }))
  assert.ok(!isRun({ t: 'text', v: 'x', marks: ['wow'] }))
  assert.ok(isRun(ref('p', { label: '名' })))
  assert.ok(!isRun({ t: 'ref', to: 1 }))
  assert.ok(isRun({ id: 'l', t: 'link', v: '字', url: 'https://x' }))
  assert.ok(isRun(img('h')))
  assert.ok(!isRun({ ...img('h'), marks: ['bold'] }))
  assert.ok(!isRun({ id: 'a', t: 'anno' }))
  assert.ok(isAnno({ id: 'x', range: { start: 0, end: 2 } }))
  assert.ok(isAnno({ id: 'x', range: { start: 0, end: 2 }, quote: { exact: 'a', prefix: '', suffix: '' } }))
  assert.ok(!isAnno({ id: 'x' }))
})
