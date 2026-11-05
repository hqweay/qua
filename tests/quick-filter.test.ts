/**
 * **快速筛选**的模型测试（派生面 chips：反链卡／引用栏／提及栏）。
 *
 * 这里钉的是五件在界面上看不出对错的事：
 *   ① 状态按**条件语言的形状**存，投影（`quickFilterNode`）产出的就是合法条件节点；
 *   ② 判定走**窄谓词**：页＝祖先链、标签＝归属边——读的是记录里已有的位置事实；
 *   ③ **空 chips＝无筛选**：原样返回同一引用，不是「筛了一遍恰好全过」；
 *   ④ 加／摘是**纯函数**：没变化返回 `null`，挪列是改手势不是加两颗，入参永不被改；
 *   ⑤ 候选与计数来自**结果集本身**：只有带页露面的祖先作页候选，计数＝命中行数。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyQuickFilter,
  EMPTY_QUICK_FILTER,
  isQueryNode,
  isQuerySpec,
  quickFilterAdd,
  quickFilterAtomMatches,
  quickFilterCandidates,
  quickFilterDrop,
  quickFilterNode,
  sameQuickFilterAtom,
  type Block,
  type QuickFilterAtom,
  type QuickFilterState,
  type ViewRecord,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

/** 一行记录：`path` 是祖先链（根→父，不含自己），`tags` 是行块的标签边 */
const row = (id: string, path: Block[], tags: Block[], text = `行 ${id}`): ViewRecord => ({
  block: b(id, text),
  path,
  title: text,
  tags,
  values: {},
})

const PAGE_A = b('a-page', '甲页', { props: { _aliases: ['甲页'], _lists: ['page'] } })
const PAGE_B = b('b-page', '乙页', { props: { _aliases: ['乙页'], _lists: ['page'] } })
const NESTED = b('nested', '普通祖先')
const TAG_X = b('tag-x', '任务', { props: { _aliases: ['任务'], _lists: ['tag'] } })
const TAG_Y = b('tag-y', '想法', { props: { _aliases: ['想法'], _lists: ['tag'] } })

const pageAtom = (id: string): QuickFilterAtom => ({ up: { is: id } })
const tagAtom = (id: string): QuickFilterAtom => ({ tag: id })

test('窄谓词：页＝祖先链上有它（不含自己）；标签＝行块的归属边', () => {
  const r = row('r1', [PAGE_A, NESTED], [TAG_X])
  assert(quickFilterAtomMatches(pageAtom('a-page'), r), '祖先链上的页要命中')
  // 谓词只认 id（与 {up:{is}} 同构）；「祖先是不是页」由候选收集那一侧把关
  assert(quickFilterAtomMatches(pageAtom('nested'), r), '祖先按 id 判定，不限身份')
  assert(quickFilterAtomMatches(tagAtom('tag-x'), r), '行块带的标签要命中')
  assert(quickFilterAtomMatches(tagAtom('tag-y'), r) === false, '没带的标签不命中')
  // 行块自己不是自己的祖先：{up} 与求值器同一条口径（祖先链不含自己）
  assert(quickFilterAtomMatches(pageAtom('r1'), r) === false)
})

test('空 chips＝无筛选：原样返回同一引用，不复制、不筛', () => {
  const rows = [row('r1', [PAGE_A], []), row('r2', [PAGE_B], [])]
  assert(applyQuickFilter(rows, EMPTY_QUICK_FILTER) === rows, '空状态要原样放行')
})

test('包含列之间是「或」：任一命中即保留', () => {
  const rows = [row('r1', [PAGE_A], []), row('r2', [PAGE_B], []), row('r3', [NESTED], [])]
  const kept = applyQuickFilter(rows, { include: [pageAtom('a-page'), pageAtom('b-page')], remove: [] })
  assert.deepEqual(kept.map((r) => r.block.id), ['r1', 'r2'], '两颗包含 chip 并集保留，其余藏掉')
})

test('排除列之间是「或」：任一命中即藏掉；两列同时有值时先并后藏', () => {
  const rows = [
    row('r1', [PAGE_A], [TAG_X]),
    row('r2', [PAGE_A], [TAG_Y]),
    row('r3', [PAGE_B], [TAG_X]),
  ]
  const kept = applyQuickFilter(rows, { include: [pageAtom('a-page')], remove: [tagAtom('tag-x')] })
  assert.deepEqual(kept.map((r) => r.block.id), ['r2'], '排除列从包含结果里再藏掉命中行')
})

test('加／摘是纯函数：没变化返回 null；挪列是改手势；入参不被改', () => {
  const start: QuickFilterState = { include: [pageAtom('a-page')], remove: [] }
  const frozen = JSON.stringify(start)
  assert(quickFilterAdd(start, pageAtom('a-page'), 'include') === null, '已在目标列 ⇒ 没有变化')
  assert(quickFilterDrop(start, tagAtom('tag-x')) === null, '不在任何列 ⇒ 没有变化')
  const moved = quickFilterAdd(start, pageAtom('a-page'), 'remove')
  assert(moved, '在另一列 ⇒ 挪列')
  assert.deepEqual(moved, { include: [], remove: [pageAtom('a-page')] }, '同一颗 chip 只在一列')
  assert.equal(JSON.stringify(start), frozen, '入参状态不被改')
  const dropped = quickFilterDrop({ include: [pageAtom('a-page')], remove: [] }, pageAtom('a-page'))
  assert.deepEqual(dropped, { include: [], remove: [] }, '摘 chip ＝ 删节点')
})

test('条件投影：形状与判定逐字对应，且是条件语言认得的合法节点', () => {
  assert(quickFilterNode(EMPTY_QUICK_FILTER) === null, '空 chips ＝ 没有条件')
  const one: QuickFilterState = { include: [pageAtom('a-page')], remove: [] }
  assert.deepEqual(quickFilterNode(one), pageAtom('a-page'), '单颗原样就是那个原子')
  const multi: QuickFilterState = { include: [pageAtom('a-page'), tagAtom('tag-x')], remove: [pageAtom('b-page')] }
  const node = quickFilterNode(multi)
  assert(isQueryNode(node), '投影必须是条件语言认得的节点')
  assert(isQuerySpec({ where: node }), '放进 spec 验形也要过')
  assert.deepEqual(node, { all: [{ any: [pageAtom('a-page'), tagAtom('tag-x')] }, { not: pageAtom('b-page') }] })
})

test('候选：页候选只收带页露面的祖先；标签候选收行块的标签；计数＝命中行数', () => {
  const rows = [
    row('r1', [PAGE_A, NESTED], [TAG_X, TAG_Y]),
    row('r2', [PAGE_A], [TAG_X]),
    row('r3', [NESTED], []),
  ]
  const c = quickFilterCandidates(rows)
  assert.deepEqual(
    c.pages.map((p) => [p.label, p.count]),
    [['甲页', 2]],
    '普通祖先不作页候选；计数＝祖先链上有这页的行数',
  )
  assert.deepEqual(
    c.tags.map((p) => [p.label, p.count]),
    [
      ['任务', 2],
      ['想法', 1],
    ],
    '标签计数＝带着这条边的行数；按计数降序、同数按先出现序',
  )
  const kept = applyQuickFilter(rows, { include: [c.pages[0]!.atom], remove: [] })
  assert.equal(kept.length, 2, '候选自带的原子就是判定用的那颗 chip')
  assert(sameQuickFilterAtom(c.pages[0]!.atom, pageAtom('a-page')), '页候选的原子形状是 {up:{is}}')
})
