/**
 * **四种布局里能脱离 DOM 验的那一半**：日历的月网格、日期取值、以及「一格的纯文本」。
 *
 * 其余（拖卡、SVG 连线、窄宽降级）只能靠真浏览器验 —— 它们错起来是「看着不对」，
 * 而这里的错法是**静默的**：网格少一格、日期解析不到、`select` 的值显示成一串 hex。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CREATED_COLUMN,
  fieldTextOf,
  mkBlock,
  sortRecords,
  TAGS_COLUMN,
  TITLE_COLUMN,
  type Block,
  type ViewRecord,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'
import { dateOf, monthCells } from '../src/ui/view-calendar.ts'

const rec = (b: Block, values: Record<string, unknown> = {}): ViewRecord => ({
  block: b,
  path: [],
  title: '标题',
  tags: [],
  values,
})

test('monthCells：六格恒定的 42 天，覆盖整月且含前后补白', () => {
  const cells = monthCells('2026-10')
  assert.equal(cells.length, 6, '月网格固定 6 行（长短月都对齐，翻月时高度不跳）')
  assert.ok(cells.every((w) => w.length === 7), '每行 7 天')
  const flat = cells.flat()
  assert.equal(flat.length, 42)
  assert.ok(flat.includes('2026-10-01'), '这个月的一号在网格里')
  assert.ok(flat.includes('2026-10-31'), '这个月的最后一天也在')
  // 周一开头：第一格的星期一是 9-28（2026-10-01 是周四）
  assert.equal(flat[0], '2026-09-28')
  assert.equal(new Date(`${flat[0]}T00:00:00`).getDay(), 1, '第一格是周一')
})

test('monthCells：跨年也对（12 月 → 次年 1 月的补白）', () => {
  const flat = monthCells('2026-12').flat()
  assert.ok(flat.includes('2026-12-01'))
  assert.ok(flat.some((d) => d.startsWith('2027-01')), '12 月的网格尾部会伸进次年 1 月')
})

test('dateOf：只认 `YYYY-MM-DD` 形状；没有／不是日期 ⇒ 空串（落到「没有日期的」那一列）', () => {
  const b = mkBlock('x')
  assert.equal(dateOf(rec(b, { d: '2026-10-05' }), 'd'), '2026-10-05')
  // 带时间的 ISO 串取前 10 位（导出／自建数据常见）
  assert.equal(dateOf(rec(b, { d: '2026-10-05T12:00:00Z' }), 'd'), '2026-10-05')
  assert.equal(dateOf(rec(b, { d: '不是日期' }), 'd'), '')
  assert.equal(dateOf(rec(b, {}), 'd'), '')
  assert.equal(dateOf(rec(b, { d: 20261005 }), 'd'), '')
})

test('dateOf：`_date` 是系统槽 ⇒ 从块的属性袋读，不要求进 `values`', () => {
  const day = { ...mkBlock(''), props: { _date: '2026-10-26' } }
  assert.equal(dateOf(rec(day), '_date'), '2026-10-26')
})

test('fieldTextOf：标题／标签／子块数／时刻各按各的口径，值不是字符串也能显示', () => {
  const b = { ...mkBlock('这是一条'), children: [mkBlock('a'), mkBlock('b')], created: Date.parse('2026-10-01T10:00:00+08:00') }
  const tag = { ...mkBlock('任务'), props: {} }
  const r: ViewRecord = { block: b, path: [], title: '这是一条', tags: [tag], values: { n: 3, arr: ['甲', '乙'], obj: { k: 1 } } }
  assert.equal(fieldTextOf(r, TITLE_COLUMN), '这是一条')
  assert.equal(fieldTextOf(r, TAGS_COLUMN), '任务')
  assert.equal(fieldTextOf(r, 'children'), '2')
  assert.equal(fieldTextOf(r, 'n'), '3')
  assert.equal(fieldTextOf(r, 'arr'), '甲 乙')
  assert.equal(fieldTextOf(r, 'obj'), '{"k":1}', '对象退化成 JSON 也不许空白')
  assert.ok(fieldTextOf(r, CREATED_COLUMN).length > 0, '时刻列给本地日期')
  assert.equal(fieldTextOf(r, '没有这一槽'), '')
})

test('fieldTextOf：`resolve` 给「值是块 id」的列一次解析机会；解析不到就原样显示', () => {
  const r = rec(mkBlock('x'), { sel: 'choice-1' })
  assert.equal(fieldTextOf(r, 'sel', (v) => (v === 'choice-1' ? '进行中' : null)), '进行中')
  // 解析不到（选项被删）⇒ 原样显示：数据不静默消失
  assert.equal(fieldTextOf(r, 'sel', () => null), 'choice-1')
})

test('看板分组的次序：按值分组时保持「第一次出现」的顺序（稳定）', () => {
  // 分组本身在渲染器里；这里钉的是它的输入契约：`sortRecords` 不改变来源顺序
  const rows = [rec(mkBlock('a'), { g: 'x' }), rec(mkBlock('b'), { g: 'y' }), rec(mkBlock('c'), { g: 'x' })]
  assert.deepEqual(
    sortRecords(rows, undefined).map((r) => r.block.id),
    rows.map((r) => r.block.id),
  )
})
