/**
 * 日记流的选择口径：它是查询视图的**临时实例**——「哪些天、什么序、取几段」
 * 由一份 QuerySpec 字面量（`FEED_SPEC`）回答，与查询块共用同一份评估（`evaluateQuery`）。
 *
 * 这里钉的是三件在界面上很难复现的事：
 *   · 产品口径——今日在顶（`_date` 降序）、**不造空天**、非日记不混入；
 *   · 「库里有哪些天」的唯一口径仍是 `journalDays` —— spec 求值与它等价；
 *   · 两条求值路径的**等式**：纯函数内核（`feedDays`）＝索引路径（`queryByIndex`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEED_SPEC, feedDays, findById, journalDate, journalDays, queryByIndex, rebuild } from '../src/core/index.ts'
import type { Block } from '../src/core/model.ts'

const j = (date: string, children: Block[] = []): Block => ({
  id: `j-${date}`,
  text: '',
  children,
  props: { _date: date },
})
const p = (id: string, text: string, children: Block[] = []): Block => ({ id, text, children })
const dates = (days: Block[]): string[] => days.map((b) => String(b.props?._date))
/** 全量取（避开 limit 干扰）：比 FEED_INITIAL 大得多 */
const ALL = 99

test('日记流：今日在顶、按 _date 降序、非 journal 不混入', () => {
  const blocks = [j('2026-10-18'), j('2026-10-20'), j('2026-10-19'), p('p1', 'page')]
  assert.deepEqual(dates(feedDays(blocks, ALL)), ['2026-10-20', '2026-10-19', '2026-10-18'])
})

test('日记流：不按日历生造空天', () => {
  // 10-19 / 10-18 没写过 ⇒ 流里直接跳到 10-17
  const blocks = [j('2026-10-20'), j('2026-10-17')]
  assert.deepEqual(dates(feedDays(blocks, ALL)), ['2026-10-20', '2026-10-17'])
})

test('日记流：limit 生效（降序下 limit 变宽＝向更旧追加，无需 offset）', () => {
  const blocks = [j('2026-10-20'), j('2026-10-19'), j('2026-10-18'), p('p1', 'page')]
  assert.deepEqual(dates(feedDays(blocks, 2)), ['2026-10-20', '2026-10-19'])
  assert.deepEqual(feedDays(blocks, 0), [])
})

test('日记流：走整片森林 —— 嵌在页子树里的 journal 也进流（与日期索引同口径）', () => {
  const nested = j('2026-10-19')
  const blocks = [j('2026-10-20'), p('p1', 'page', [nested])]
  assert.deepEqual(dates(feedDays(blocks, ALL)), ['2026-10-20', '2026-10-19'])
})

test('日记流：嵌在**另一天**下面的天只出现一次（候选收窄不产生重复命中）', () => {
  // 一天可以嵌进另一天的子树（位置不设守卫，靠软删兜底）；求值不许把它报两遍
  const blocks = [j('2026-10-20', [j('2026-10-19')])]
  assert.deepEqual(dates(feedDays(blocks, ALL)), ['2026-10-20', '2026-10-19'])
})

test('日记流：同一天有多个块 ⇒ 取先序第一个（与「库里有哪些天」同一口径）', () => {
  const first = j('2026-10-20')
  const dup = { ...j('2026-10-20'), id: 'j-dup' }
  const blocks = [p('p1', 'page'), first, dup]
  assert.deepEqual(dates(feedDays(blocks, ALL)), ['2026-10-20'])
})

test('等式：spec 求值（纯）＝ spec 求值（索引）＝ journalDays 按序', () => {
  const blocks = [j('2026-10-18'), p('p1', 'page', [j('2026-10-16')]), j('2026-10-20'), j('2026-10-19')]
  const expected = [...journalDays(blocks)].sort((a, b) => journalDate(b).localeCompare(journalDate(a)))
  assert.deepEqual(dates(feedDays(blocks, ALL)), dates(expected))
  const spec = { ...FEED_SPEC, limit: ALL }
  const fromIndex = queryByIndex(rebuild(blocks, []), blocks, spec)
    .map((h) => findById(blocks, h.blockId))
    .filter((b): b is Block => b !== undefined)
  assert.deepEqual(dates(fromIndex), dates(expected), '索引路径查日期表，结果必须与纯路径一致')
})

test('等式：FEED_SPEC 本身求出来的就是日记流（范围条件不掺进来）', () => {
  // role 成员条件把**天当结果**：日期行自己入选；`journal: date` 范围条件才把天当容器
  const blocks = [j('2026-10-20', [p('x', '今天的正文')]), j('2026-10-19')]
  assert.deepEqual(feedDays(blocks, ALL), [blocks[0], blocks[1]])
})
