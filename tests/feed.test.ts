/**
 * ：日记流的选择口径 ＋ N 个 root 的写回。
 *
 * 这两条都是「视图/装配层依赖的 core 纯函数」，值得单测：
 *   · `journalFeedDays` 决定「哪些天在流里、什么序」——**不造空天**是产品口径；
 *   · `writeBackRoots` 决定「编辑器的 N 个 section 怎么落回森林」——journal 不写 text 是不变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { journalFeedDays, findJournalDay } from '../src/core/journal.ts'
import { writeBackRoots } from '../src/core/tree.ts'
import type { Block } from '../src/core/model.ts'

const j = (date: string, children: Block[] = []): Block => ({
  id: `j-${date}`,
  text: '',
  children,
  props: { _date: date },
})
const p = (id: string, text: string, children: Block[] = []): Block => ({ id, text, children })
const dates = (days: Block[]): string[] => days.map((b) => String(b.props?._date))

test('75 日记流：今日在顶、按 _date 降序、只取 <= anchor', () => {
  const blocks = [j('2026-10-18'), j('2026-10-20'), j('2026-10-19'), p('p1', 'page')]
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-20')), ['2026-10-20', '2026-10-19', '2026-10-18'])
  // anchor 是过去某天 ⇒ 比它晚的天不进来（单日/回看锚点）
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-19')), ['2026-10-19', '2026-10-18'])
})

test('75 日记流：不按日历生造空天', () => {
  // 10-19 / 10-18 没写过 ⇒ 流里直接跳到 10-17
  const blocks = [j('2026-10-20'), j('2026-10-17')]
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-20')), ['2026-10-20', '2026-10-17'])
})

test('75 日记流：limit 生效；非 journal 不混入', () => {
  const blocks = [j('2026-10-20'), j('2026-10-19'), j('2026-10-18'), p('p1', 'page')]
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-20', 2)), ['2026-10-20', '2026-10-19'])
  assert.deepEqual(journalFeedDays(blocks, '2026-10-20', 0), [])
})

test('75 日记流：走整片森林 —— 嵌在子树里的 journal 也进流（与日期索引同口径）', () => {
  // 「索引认得它、日记流看不见」曾让同一天有两个答案：索引与引用解析走整片森林，
  // 流只看顶层。两条路必须同口径，直到「身份块必须在顶层」在入口处被拦住。
  const nested = j('2026-10-19')
  const blocks = [j('2026-10-20'), p('p1', 'page', [nested])]
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-20')), ['2026-10-20', '2026-10-19'])
  assert.equal(findJournalDay(blocks, '2026-10-19')?.id, 'j-2026-10-19')
})

test('75 日记流：同一天有多个块 ⇒ 取先序第一个（与日期索引一致）', () => {
  const first = j('2026-10-20')
  const dup = { ...j('2026-10-20'), id: 'j-dup' }
  const blocks = [p('p1', 'page'), first, dup]
  assert.deepEqual(dates(journalFeedDays(blocks, '2026-10-20')), ['2026-10-20'])
  assert.equal(findJournalDay(blocks, '2026-10-20')?.id, 'j-2026-10-20')
})

test('75 writeBackRoots：按 root id 逐项写回；journal 不写 text', () => {
  const page = p('p', 'old')
  const journal = j('2026-10-20', [p('old-child', 'old')])
  const forest = [page, journal]

  // 编辑器里是浅拷贝（rootsForMany 的形状）
  const roots = forest.map((b) => ({ ...b }))
  roots[0]!.text = 'new'
  roots[0]!.children = [p('page-child', 'x')]
  roots[1]!.text = '不该写进 journal 的正文'
  roots[1]!.children = [p('journal-child', 'y')]

  writeBackRoots(forest, roots)

  assert.equal(page.text, 'new')
  assert.equal(page.children[0]!.id, 'page-child')
  assert.equal(journal.text, '') // `_date` 的只读投影，不写 text
  assert.equal(journal.children[0]!.id, 'journal-child')
})

test('75 writeBackRoots：找不到的 root 静默跳过（命令层解释「为什么少了」）', () => {
  const page = p('p', 'old')
  const forest = [page]
  const ghost: Block = { id: 'ghost', text: 'x', children: [] }
  writeBackRoots(forest, [ghost])
  assert.equal(page.text, 'old')
})
