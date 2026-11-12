/**
 * run 层的契约测试。
 *
 * 每条测试钉的都是**模型红线**，不是「顺手覆盖」：
 *   · 投影纯（`plainText` 只由 text run 决定；quote.exact 恒为投影子串）；
 *   · 归一化幂等（库里的内容只有一种等价形状）；
 *   · 原子不可分（删旁边的字不吃原子；区间盖住才删，且整枚删）；
 *   · 格式不上 image run（归一化兜底剥掉，形状校验判非法）；
 *   · ref/link 可携带格式（整句加粗不断裂）；
 *   · marks 是映射：值轴互斥是结构性的，键序固定（sameRuns 不白发空写）。
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
  runAtCell,
  runById,
  sameRuns,
  sliceRuns,
  spliceRuns,
  splitRuns,
  textRuns,
  toggleMark,
  type AssetRun,
  type MarkPatch,
  type RefRun,
  type Run,
} from '../src/core/model/runs.ts'

const ref = (to: string, extra: Partial<RefRun> = {}): RefRun => ({
  id: `ref-${to}-${Math.random().toString(36).slice(2, 8)}`,
  t: 'ref',
  to,
  ...extra,
})

const asset = (hash: string): AssetRun => ({ id: `asset-${hash}`, t: 'asset', asset: hash, label: 'sample.png' })

/* ------------------------------------------------------------ 投影 */

test('plainText：只由 text run 决定，ref/link/image 不进投影', () => {
  const c: Run[] = [ ...textRuns('引用'), ref('p1', { label: '目标' }), ...textRuns('与图'), asset('h1'), ...textRuns('尾') ]
  assert.equal(plainText(c), '引用与图尾')
  // plain 长度 ＝ 文本字符数 ＋ 原子各 1 格（与 DOM 展示同一坐标系）
  assert.equal(plainLen(c), '引用与图尾'.length + 2)
  assert.equal(plainText([]), '')
  assert.equal(plainText(textRuns('')), '')
})

test('projectRange：quote.exact 恒为 plainText 的子串（原子两侧的区间要先换算坐标）', () => {
  const c: Run[] = [...textRuns('前后'), ref('p1'), ...textRuns('中间'), asset('h'), ...textRuns('后面')]
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

test('normalizeRuns：相邻同形 text run 合并、空段清除、marks 按固定键序重建', () => {
  const out = normalizeRuns([
    { t: 'text', v: 'a', marks: { italic: true, bold: true } },
    { t: 'text', v: 'b', marks: { bold: true, italic: true } },
    { t: 'text', v: '' },
    { t: 'text', v: 'c' },
  ])
  assert.deepEqual(out, [
    { t: 'text', v: 'ab', marks: { bold: true, italic: true } },
    { t: 'text', v: 'c' },
  ])
  // deepEqual 不看键序；键序是 sameRuns 的前提，得单独钉住
  assert.equal(JSON.stringify(out[0]!.marks), '{"bold":true,"italic":true}')
})

test('normalizeRuns：幂等（normalize(normalize(x)) 逐字节相等）', () => {
  const x: Run[] = [
    { t: 'text', v: 'a', marks: { code: true } },
    { t: 'text', v: 'b', marks: { code: true } },
    ref('p1'),
    { t: 'text', v: 'c' },
    { t: 'text', v: 'd' },
  ]
  const once = normalizeRuns(x)
  assert.deepEqual(JSON.stringify(normalizeRuns(once)), JSON.stringify(once))
})

test('normalizeRuns：资产的 marks 一律剥掉（红线：格式不上资产 run）', () => {
  const bad = { ...asset('h1'), marks: { bold: true } } as unknown as Run
  const out = normalizeRuns([bad])
  assert.equal((out[0] as AssetRun).marks, undefined)
})

test('sameRuns：按归一化形态比，「碰过但没改」能被识别', () => {
  const a: Run[] = [{ t: 'text', v: 'x' }, { t: 'text', v: 'y', marks: {} }]
  const b: Run[] = [{ t: 'text', v: 'xy' }]
  assert.ok(sameRuns(a, b))
  assert.ok(!sameRuns(a, [{ t: 'text', v: 'xz' }]))
})

/* --------------------------------------- 映射形状：互斥与固定键序 */

test('映射形状：不同插入序的等价 marks 归一成同一份字节（sameRuns 不白发空写）', () => {
  const a = normalizeRuns([{ t: 'text', v: 'x', marks: { ink: 'red', bold: true, bg: 'blue' } }])
  const b = normalizeRuns([{ t: 'text', v: 'x', marks: { bg: 'blue', ink: 'red', bold: true } }])
  assert.equal(JSON.stringify(a), JSON.stringify(b))
  assert.equal(JSON.stringify(a[0]!), '{"t":"text","v":"x","marks":{"bold":true,"ink":"red","bg":"blue"}}')
  assert.ok(sameRuns(a, b))
})

test('映射形状：值轴互斥是结构性的（ink 换色只剩一个值，写不出两个色）', () => {
  const c = textRuns('abcdef')
  const red = toggleMark(c, { ink: 'red' }, 0, 6)
  assert.deepEqual(red, [{ t: 'text', v: 'abcdef', marks: { ink: 'red' } }])
  const blue = toggleMark(red, { ink: 'blue' }, 0, 6)
  assert.deepEqual(blue, [{ t: 'text', v: 'abcdef', marks: { ink: 'blue' } }])
  // 再按同一个色 ⇒ 取消（toggle 手感）
  assert.deepEqual(toggleMark(blue, { ink: 'blue' }, 0, 6), c)
})

test('映射形状：highlight 与 bg:yellow 的双黄冲突写不出来（⌘E 就是设 bg:yellow）', () => {
  const c = toggleMark(textRuns('abc'), { bg: 'yellow' }, 0, 3)
  assert.deepEqual(c, [{ t: 'text', v: 'abc', marks: { bg: 'yellow' } }])
  assert.ok(isCovered(c, { bg: 'yellow' }, 0, 3))
  assert.deepEqual(toggleMark(c, { bg: 'yellow' }, 0, 3), textRuns('abc'))
})

test('四种新格式：underline/strike/ink/bg 能叠加，清格式连颜色一起清', () => {
  let c = textRuns('abcdef')
  for (const patch of [{ underline: true }, { strike: true }, { ink: 'green' }, { bg: 'violet' }] as MarkPatch[]) {
    c = toggleMark(c, patch, 0, 6)
  }
  assert.deepEqual(c, [{
    t: 'text', v: 'abcdef',
    marks: { underline: true, strike: true, ink: 'green', bg: 'violet' },
  }])
  assert.ok(isCovered(c, { ink: 'green' }, 0, 6))
  assert.deepEqual(clearMarks(c, 0, 6), textRuns('abcdef'))
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
  const c: Run[] = [{ t: 'text', v: 'abcd', marks: { bold: true } }, ref('p'), { t: 'text', v: 'ef' }]
  const [l, r] = splitRuns(c, 2)
  assert.deepEqual(l, [{ t: 'text', v: 'ab', marks: { bold: true } }])
  assert.deepEqual(r, [{ t: 'text', v: 'cd', marks: { bold: true } }, c[1], { t: 'text', v: 'ef' }])
})

test('joinRuns：边界两侧同形 text run 并成一个（合并块）', () => {
  const l = [{ t: 'text', v: 'ab', marks: { bold: true } }] as Run[]
  const r = [{ t: 'text', v: 'cd', marks: { bold: true } }, { t: 'text', v: 'e' }] as Run[]
  assert.deepEqual(joinRuns(l, r), [
    { t: 'text', v: 'abcd', marks: { bold: true } },
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
  const bold = toggleMark(c, { bold: true }, 2, 5)
  assert.deepEqual(bold, [
    { t: 'text', v: 'ab' },
    { t: 'text', v: 'cde', marks: { bold: true } },
    { t: 'text', v: 'f' },
  ])
  // 全覆盖 ⇒ 再按一次取消
  assert.deepEqual(toggleMark(bold, { bold: true }, 2, 5), c)
})

test('toggleMark：区间盖住 ref ⇒ ref 整枚携带格式（整句加粗不断裂）；资产永不携带', () => {
  const r = ref('p1')
  const im = asset('h')
  const c: Run[] = [...textRuns('ab'), r, im, ...textRuns('cd')]
  const bold = toggleMark(c, { bold: true }, 0, plainLen(c))
  const gotRef = bold.find((x): x is RefRun => x.t === 'ref')!
  const gotImg = bold.find((x): x is AssetRun => x.t === 'asset')!
  assert.deepEqual(gotRef.marks, { bold: true })
  assert.equal(gotImg.marks, undefined)
  // 区间里有资产 ⇒ 永远判「未全覆盖」⇒ toggle 恒走「加」的一支（资产自己仍不动）
  assert.ok(!isCovered(c, { bold: true }, 0, plainLen(c)))
})

test('isCovered：部分覆盖 ⇒ false（再按一次是补齐，不是取消）', () => {
  const c = [
    { t: 'text', v: 'ab', marks: { bold: true } },
    { t: 'text', v: 'cd' },
  ] as Run[]
  assert.ok(!isCovered(c, { bold: true }, 0, 4))
  assert.ok(isCovered(c, { bold: true }, 0, 2))
})

test('clearMarks：一次清掉全部格式；文本边界拆段', () => {
  const c = toggleMark(toggleMark(textRuns('abcdef'), { bold: true }, 0, 6), { italic: true }, 2, 4)
  assert.deepEqual(clearMarks(c, 1, 5), [
    { t: 'text', v: 'a', marks: { bold: true } },
    { t: 'text', v: 'bcde' },
    { t: 'text', v: 'f', marks: { bold: true } },
  ])
})

test('marksInRange：区间上出现过的格式（气泡按压态）', () => {
  const c = [
    { t: 'text', v: 'ab', marks: { bold: true } },
    { t: 'text', v: 'cd', marks: { bold: true, italic: true } },
  ] as Run[]
  assert.deepEqual(marksInRange(c, 0, 4), ['bold', 'italic'])
  assert.deepEqual(marksInRange(c, 0, 2), ['bold'])
})

test('marksInRange：值轴报 `键:槽` 描述符（色板按压态认得出是哪个色）', () => {
  const c = [
    { t: 'text', v: 'ab', marks: { ink: 'red' } },
    { t: 'text', v: 'cd', marks: { bg: 'yellow', bold: true } },
  ] as Run[]
  assert.deepEqual(marksInRange(c, 0, 4), ['bg:yellow', 'bold', 'ink:red'])
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
  const c: Run[] = [...textRuns('ab', { bold: true }), a, asset('h')]
  const cp = cloneRunsNewIds(c)
  assert.equal(plainText(cp), 'ab')
  const cpRef = cp.find((x): x is RefRun => x.t === 'ref')!
  assert.notEqual(cpRef.id, a.id)
  assert.equal(cpRef.to, 'p1')
})

/* ------------------------------------------------------ 形状校验 */

test('isRun / isAnno：合法形状放行、非法形状拦下（资产带 marks / 带字节 / 把 state 落盘都判非法）', () => {
  assert.ok(isRun({ t: 'text', v: 'x' }))
  assert.ok(isRun({ t: 'text', v: 'x', marks: { bold: true } }))
  assert.ok(!isRun({ t: 'text', v: 'x', marks: ['wow'] }), '旧数组形状必须判非法')
  assert.ok(isRun(ref('p', { label: '名' })))
  assert.ok(!isRun({ t: 'ref', to: 1 }))
  assert.ok(isRun({ id: 'l', t: 'link', v: '字', url: 'https://x' }))
  assert.ok(isRun(asset('h')))
  assert.ok(isRun({ id: 'a', t: 'asset', asset: 'h', label: '名' }))
  assert.ok(!isRun({ id: 'a', t: 'asset', asset: 'h', w: 4, h: 3 }), '尺寸是那份字节的属性（索引回答），不进 run')
  assert.ok(!isRun({ ...asset('h'), marks: { bold: true } }), '资产不带格式')
  assert.ok(!isRun({ ...asset('h'), bytes: 'AAAA' }), '字节不进正文')
  assert.ok(!isRun({ ...asset('h'), state: 'ready' }), 'state 是派生值，不落盘')
  assert.ok(!isRun({ id: 'a', t: 'asset' }), '缺地址不是合法资产')
  assert.ok(!isRun({ id: 'a', t: 'asset', asset: { hash: 'h' } }), '旧形状（asset 是对象）必须判非法')
  assert.ok(!isRun({ id: 'a', t: 'image', asset: { hash: 'h', state: 'ready' } }), '旧种类名必须判非法')
  assert.ok(!isRun({ id: 'a', t: 'anno' }))
  assert.ok(isAnno({ id: 'x', range: { start: 0, end: 2 } }))
  assert.ok(isAnno({ id: 'x', range: { start: 0, end: 2 }, quote: { exact: 'a', prefix: '', suffix: '' } }))
  assert.ok(!isAnno({ id: 'x' }))
})

test('isRun：marks 是「key 表 × 每 key 一个值判据」，不是扁平字符串白名单', () => {
  assert.ok(isRun({ t: 'text', v: 'x', marks: { ink: 'red', bg: 'blue' } }))
  assert.ok(isRun({ t: 'text', v: 'x', marks: { underline: true, strike: true } }))
  assert.ok(!isRun({ t: 'text', v: 'x', marks: { bold: 'yes' } }), '布尔轴只认 true')
  assert.ok(!isRun({ t: 'text', v: 'x', marks: { bold: false } }))
  assert.ok(!isRun({ t: 'text', v: 'x', marks: { ink: 'chartreuse' } }), '非法槽名')
  assert.ok(!isRun({ t: 'text', v: 'x', marks: { bg: 42 } }))
  assert.ok(!isRun({ t: 'text', v: 'x', marks: { ink: 'red', ink2: 'blue' } }), '未知键')
  assert.ok(!isRun({ t: 'text', v: 'x', marks: ['bold'] }), '数组不是映射')
})

/**
 * **锚文本（`RefRun.anchor`）是「一处显示内容」，不是身份。**
 *
 * 三条负向断言：
 *   ① 它不进投影（`plainText` 只由 text run 决定 ⇒ 搜索/导出/引文都看不到它）；
 *   ② 它不进引文快照（`quote.exact` 恒为投影的子串，锚文本改了引文不变）；
 *   ③ 它是**可选**键（写空串＝删键 ⇒ 库里只有一种形状）。
 * 三条一起才撑得住「改名传播仍然只靠解析」——否则 anchor 就是第二份身份。
 */
test('anchor：不进投影、不改引文、写空＝删键（锚文本不是第二份身份）', () => {
  const a = ref('p1', { label: '目标', anchor: '这一处叫别的' })
  const c: Run[] = [...textRuns('前'), a, ...textRuns('后')]
  // ① 投影：原子整体贡献 0，anchor 更不进（它连「原子」这一格都不占）
  assert.equal(plainText(c), '前后')
  assert.equal(plainLen(c), 3)
  // ② 引文快照：坐标是投影，anchor 无论多长都不参与
  const q = projectRange(c, 0, 3)
  assert.ok(q)
  assert.equal(q.exact, '前后')
  // ③ 归一化不替它补空值：写了就有，没写就没有（`''` 不被当成合法值留下）
  assert.equal((normalizeRuns(c).find((x): x is RefRun => x.t === 'ref')!).anchor, '这一处叫别的')
  assert.equal('anchor' in (normalizeRuns([ref('p1')])[0] as RefRun), false)
})

test('isRun：ref 认 `anchor?: string`（缺席放行、字符串放行、其它类型判非法）', () => {
  assert.ok(isRun(ref('p1', { anchor: '锚' })), '有合法锚文本 ⇒ 合法')
  assert.ok(isRun(ref('p1')), '没有这一格 ⇒ 合法（可选字段）')
  assert.ok(!isRun({ ...ref('p1'), anchor: 42 }), '非字符串 ⇒ 非法')
  assert.ok(!isRun({ ...ref('p1'), anchor: null }), 'null ⇒ 非法')
})

test('资产 run：plainText 贡献 0、plain 占 1 格、永不带 marks（三条一起才叫「行内原子」）', () => {
  const a = asset('deadbeef')
  const c: Run[] = [...textRuns('前'), a, ...textRuns('后')]
  assert.equal(plainText(c), '前后')
  assert.equal(plainLen(c), 3)
  // 归一化之后仍然没有 marks（即使被区间格式盖过）
  const bold = toggleMark(c, { bold: true }, 0, plainLen(c))
  assert.equal((bold.find((x): x is AssetRun => x.t === 'asset')!).marks, undefined)
})

test('runAtCell：plain 格位 → 占格的 run（删除键接管判据）', () => {
  // 「引用」(0-1) · ref(2) · 「与图」(3-4) · asset(5) · 「尾」(6)
  const c: Run[] = [...textRuns('引用'), ref('p1', { label: '目标' }), ...textRuns('与图'), asset('h1'), ...textRuns('尾')]
  assert.equal((runAtCell(c, 0) as { t: string }).t, 'text', '文本格 ⇒ 所在的 text run')
  assert.equal((runAtCell(c, 2) as { t: string }).t, 'ref', '原子格 ⇒ 那枚原子')
  assert.equal((runAtCell(c, 5) as { t: string }).t, 'asset')
  assert.equal((runAtCell(c, 6) as { t: string }).t, 'text', '末文本格')
  assert.equal(runAtCell(c, 7), null, '越界（总长之后）⇒ null')
  assert.equal(runAtCell(c, -1), null, '负格位 ⇒ null')
  // 空内容没有格
  assert.equal(runAtCell([], 0), null)
})
