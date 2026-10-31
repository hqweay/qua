/**
 * **正文里的查询体**（inline surface）的纯函数判据。
 *
 * 两件事分开，各有唯一一份答案：
 *   · `hasQueryBody` —— 这一块有没有「结果身体」（只有查询源有；命中不是 children，
 *     所以就地画不会与正文重复）；
 *   · `rowHasInlineViewBody` —— 这一行画不画它：**按源分派**，有身体就画，
 *     段根同此（聚焦后身体仍贴着自己那一行；段尾/窗口根宿主只接 children/items 源，
 *     再建一台就是同一块挂两台）。
 *
 * 高度也要在这里钉：视觉与虚拟化共用 `VIEW_BODY_H`，占位高度少算一档，
 * 长文档的滚动条会系统性偏小（与组件体同一条教训）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasFoldable,
  hasQueryBody,
  isFolded,
  mkBlock,
  toggleCollapsed,
  type VisibleRow,
} from '../src/core/index.ts'
import { VIEW_BODY_GAP, VIEW_BODY_H, rowHasInlineViewBody, visibleRowHeight } from '../src/view/block-dom.ts'

const query = (): ReturnType<typeof mkBlock> => mkBlock('本页的待办', { props: { _query: { where: { any: [] } } } })

const row = (depth: number, block = query()): VisibleRow => ({
  block,
  depth,
  hidden: false,
  hasChildren: false,
})

test('hasQueryBody：只有查询源有结果身体；普通块没有（children 源仍走打开才渲染）', () => {
  assert.equal(hasQueryBody(query()), true)
  assert.equal(hasQueryBody(mkBlock('普通块')), false)
  assert.equal(hasQueryBody(undefined), false)
  assert.equal(hasQueryBody(mkBlock('形状歪的', { props: { _query: { nope: true } } })), false, '判据与 readSpec 同源：读不出条件就不是查询块')
})

test('rowHasInlineViewBody：按源分派——查询块就画，段根同此（不再让位段尾宿主）', () => {
  assert.equal(rowHasInlineViewBody(row(0)), true, '段根也画：聚焦后身体仍贴着自己那一行')
  assert.equal(rowHasInlineViewBody(row(1)), true)
  assert.equal(rowHasInlineViewBody(row(2)), true)
  assert.equal(rowHasInlineViewBody(row(1, mkBlock('普通块'))), false, '只有查询块有身体')
})

test('hasFoldable：子块或查询身体；查询块的身体能折，纯叶子不能', () => {
  const q = query()
  const doc = { roots: [q], folded: {} }
  assert.equal(hasFoldable(q), true, '查询块没有 children，但结果视图是可折的身体')
  assert.equal(toggleCollapsed(doc, q.id), true)
  assert.equal(isFolded(doc, q.id), true, '折的是身体')
  assert.equal(toggleCollapsed(doc, q.id), true)
  assert.equal(isFolded(doc, q.id), false, '再按一次展开')

  const leaf = mkBlock('纯叶子')
  assert.equal(hasFoldable(leaf), false)
  assert.equal(toggleCollapsed({ roots: [leaf], folded: {} }, leaf.id), false, '没有子块也没有身体 ⇒ 不记一个不存在的事实')
})

test('visibleRowHeight：内联查询体按静止档算进占位（视觉与虚拟化同一个数）', () => {
  const q = query()
  assert.equal(
    visibleRowHeight(q, 0, true) - visibleRowHeight(q, 0, false),
    VIEW_BODY_H.rest + VIEW_BODY_GAP,
    '占位必须比纯名字行多出「身体 ＋ 身体与名字之间的缝」',
  )
  assert.ok(VIEW_BODY_H.focus > VIEW_BODY_H.rest, '聚焦档要比静止档高，否则「点开看更多」没有落点')
})
