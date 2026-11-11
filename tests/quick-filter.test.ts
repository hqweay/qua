/**
 * **快速筛选**的模型测试（chips：派生面／查询块／中心大纲共用一份）。
 *
 * 这里钉的是七件在界面上看不出对错的事：
 *   ① 状态按**条件语言的形状**存，投影（`quickFilterNode`）产出的就是合法条件节点；
 *   ② **逆投影**（`chipsOfFilter`）认得出就原样读回来，认不出返回 `null`（不静默画错）；
 *   ③ 判定走**位置事实**：页＝祖先链、标签＝归属边——记录面与大纲行同一份；
 *   ④ **空 chips＝无筛选**：原样返回同一引用，不是「筛了一遍恰好全过」；
 *   ⑤ 加／摘是**纯函数**：没变化返回 `null`，挪列是改手势不是加两颗，入参永不被改；
 *   ⑥ **包含收窄（且）**、**排除连同子树**：记录面与大纲的行遍历同答；
 *   ⑦ 候选与计数来自**未筛**的那一批：去掉一个 chip 不会让候选自己消失。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyQuickFilter,
  chipsOfFilter,
  EMPTY_QUICK_FILTER,
  filterVisibleRows,
  isQueryNode,
  isQuerySpec,
  quickFilterActive,
  quickFilterAdd,
  quickFilterAtomMatches,
  quickFilterCandidates,
  quickFilterDrop,
  quickFilterNode,
  quickFilterVerdict,
  sameQuickFilterAtom,
  type Block,
  type QuickFilterAtom,
  type QuickFilterState,
  type ViewRecord,
  type VisibleRow,
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
/** 标签 chip 存**标签块 id**（与条件语言 `{tag}` 同一条「键是 id」纪律；改名不再失配） */
const tagAtom = (id: string): QuickFilterAtom => ({ tag: id })

/* ------------------------------------------------------------ 判定 */

test('窄谓词：页＝祖先链上有它（不含自己）；标签＝行块的归属边（按 id）', () => {
  const r = row('r1', [PAGE_A, NESTED], [TAG_X])
  assert(quickFilterAtomMatches(pageAtom('a-page'), r), '祖先链上的页要命中')
  // 谓词只认 id（与 {up:{is}} 同构）；「祖先是不是页」由候选收集那一侧把关
  assert(quickFilterAtomMatches(pageAtom('nested'), r), '祖先按 id 判定，不限身份')
  assert(quickFilterAtomMatches(tagAtom('tag-x'), r), '行块带的标签要命中')
  assert(quickFilterAtomMatches(tagAtom('tag-y'), r) === false, '没带的标签不命中')
  assert(quickFilterAtomMatches(tagAtom('别的id'), r) === false, '没带的 id 不命中')
  // 行块自己不是自己的祖先：{up} 与求值器同一条口径（祖先链不含自己）
  assert(quickFilterAtomMatches(pageAtom('r1'), r) === false)
})

test('空 chips＝无筛选：原样返回同一引用，不复制、不筛', () => {
  const rows = [row('r1', [PAGE_A], []), row('r2', [PAGE_B], [])]
  assert(applyQuickFilter(rows, EMPTY_QUICK_FILTER) === rows, '空状态要原样放行')
  assert(quickFilterActive(EMPTY_QUICK_FILTER) === false)
})

test('包含列之间是「且」（再点一颗是收窄）', () => {
  const rows = [
    row('r1', [PAGE_A], [TAG_X]),
    row('r2', [PAGE_A], [TAG_Y]),
    row('r3', [PAGE_B], [TAG_X]),
    row('r4', [PAGE_A], [TAG_X]),
  ]
  const one = applyQuickFilter(rows, { include: [pageAtom('a-page')], remove: [] })
  assert.deepEqual(one.map((r) => r.block.id), ['r1', 'r2', 'r4'], '一颗＝只留命中它的')
  const two = applyQuickFilter(rows, { include: [pageAtom('a-page'), tagAtom('tag-x')], remove: [] })
  assert.deepEqual(two.map((r) => r.block.id), ['r1', 'r4'], '第二颗把前一颗的结果再收窄')
})

test('排除列：命中行藏掉；记录面没有子树，只有行自己', () => {
  const rows = [row('r1', [PAGE_A], [TAG_X]), row('r2', [PAGE_A], [TAG_Y]), row('r3', [PAGE_B], [])]
  const kept = applyQuickFilter(rows, { include: [], remove: [tagAtom('tag-x')] })
  assert.deepEqual(kept.map((r) => r.block.id), ['r2', 'r3'], '只有自己带那个标签的行被藏掉')
})

test('只有排除时其余全留（三态里的 keep，不是 neutral）', () => {
  const r = row('r1', [PAGE_A], [])
  assert.equal(quickFilterVerdict({ include: [], remove: [tagAtom('tag-x')] }, r), 'keep')
})

/* ------------------------------------------------------------ 状态 */

test('加／摘是纯函数：没变化返回 null；挪列是改手势；入参不被改', () => {
  const start: QuickFilterState = { include: [pageAtom('a-page')], remove: [] }
  const frozen = JSON.stringify(start)
  assert(quickFilterAdd(start, pageAtom('a-page'), 'include') === null, '已在目标列 ⇒ 没有变化')
  assert(quickFilterDrop(start, tagAtom('任务')) === null, '不在任何列 ⇒ 没有变化')
  const moved = quickFilterAdd(start, pageAtom('a-page'), 'remove')
  assert(moved, '在另一列 ⇒ 挪列')
  assert.deepEqual(moved, { include: [], remove: [pageAtom('a-page')] }, '同一颗 chip 只在一列')
  assert.equal(JSON.stringify(start), frozen, '入参状态不被改')
  const dropped = quickFilterDrop({ include: [pageAtom('a-page')], remove: [] }, pageAtom('a-page'))
  assert.deepEqual(dropped, { include: [], remove: [] }, '摘 chip ＝ 删节点')
})

/* ------------------------------------------------------------ 与条件语言互转 */

test('条件投影：形状与判定逐字对应，且是条件语言认得的合法节点', () => {
  assert(quickFilterNode(EMPTY_QUICK_FILTER) === null, '空 chips ＝ 没有条件')
  const one: QuickFilterState = { include: [pageAtom('a-page')], remove: [] }
  assert.deepEqual(quickFilterNode(one), pageAtom('a-page'), '单颗原样就是那个原子')
  const multi: QuickFilterState = { include: [pageAtom('a-page'), tagAtom('任务')], remove: [pageAtom('b-page')] }
  const node = quickFilterNode(multi)
  assert(isQueryNode(node), '投影必须是条件语言认得的节点')
  assert(isQuerySpec({ where: node }), '放进 spec 验形也要过')
  assert.deepEqual(node, {
    all: [
      pageAtom('a-page'),
      tagAtom('任务'),
      // 排除 ＝ 自己命中（「连同子树」是行遍历的画法，不是条件的一部分）
      { not: pageAtom('b-page') },
    ],
  })
})

test('逆投影：认得出的形状原样读回来（往返逐字节相等）', () => {
  const states: QuickFilterState[] = [
    EMPTY_QUICK_FILTER,
    { include: [pageAtom('a-page')], remove: [] },
    { include: [], remove: [tagAtom('任务')] },
    { include: [pageAtom('a-page'), tagAtom('任务')], remove: [pageAtom('b-page'), tagAtom('想法')] },
  ]
  for (const s of states) {
    assert.deepEqual(chipsOfFilter(quickFilterNode(s)), s, `往返要还原：${JSON.stringify(s)}`)
  }
  assert.deepEqual(chipsOfFilter(null), EMPTY_QUICK_FILTER, '没有条件＝空 chips')
})

test('逆投影：认不出的形状返回 null（树里拼的复杂条件不许被画成两颗 chip）', () => {
  assert.equal(chipsOfFilter({ text: '读书' }), null, '按正文的条件不属于 chips 的词表')
  assert.equal(chipsOfFilter({ all: [{ text: 'a' }, pageAtom('a-page')] }), null, '混进一颗认不出的就整份不认')
  assert.equal(
    chipsOfFilter({ not: { any: [pageAtom('a-page'), pageAtom('b-page')] } }),
    null,
    '排除只认单个原子（复合取反不是 chips 的词表）',
  )
})

/* ------------------------------------------------------------ 候选 */

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
  assert(sameQuickFilterAtom(c.tags[0]!.atom, tagAtom('tag-x')), '标签候选的原子是标签块 id')
})

/* ------------------------------------------------------------ 行筛选（大纲） */

const vrow = (id: string, depth: number, hasChildren = false): VisibleRow => ({
  block: b(id, id),
  depth,
  hidden: false,
  hasChildren,
})

test('行筛选：命中行留下、祖先留作上下文、兄弟按需藏', () => {
  // a
  //   a1
  //   a2（命中）
  // b
  const rows = [vrow('a', 0, true), vrow('a1', 1), vrow('a2', 1), vrow('b', 0)]
  const out = filterVisibleRows(rows, (r) => (r.block.id === 'a2' ? 'keep' : 'neutral'))
  assert.deepEqual(out.map((r) => r.block.id), ['a', 'a2'], '命中行与它的祖先留下')
  assert.equal(out[0]!.hasChildren, true, '祖先仍有可见孩子 ⇒ 折叠三角保留')
})

test('行筛选：排除连同子树一起去掉（`drop` 之后的更深行一律不留）', () => {
  const rows = [vrow('a', 0, true), vrow('a1', 1, true), vrow('a1a', 2), vrow('a2', 1), vrow('b', 0)]
  const out = filterVisibleRows(rows, (r) => (r.block.id === 'a1' ? 'drop' : 'keep'))
  assert.deepEqual(out.map((r) => r.block.id), ['a', 'a2', 'b'], 'a1 与它的孩子一起消失，兄弟还在')
})

test('行筛选：子块全被筛掉的行不画折叠三角；force 让正在编辑的那一块永远可见', () => {
  const rows = [vrow('a', 0, true), vrow('a1', 1)]
  const hiddenChild = filterVisibleRows(rows, (r) => (r.block.id === 'a' ? 'keep' : 'neutral'))
  assert.deepEqual(hiddenChild.map((r) => r.block.id), ['a'])
  assert.equal(hiddenChild[0]!.hasChildren, false, '没有可见孩子 ⇒ 三角藏掉（点了没东西可折）')
  const forced = filterVisibleRows(rows, () => 'neutral', new Set(['a1']))
  assert.deepEqual(forced.map((r) => r.block.id), ['a', 'a1'], 'force 的行连同祖先链留下')
})
