/**
 * **正文里的查询体**（inline surface）的纯函数判据。
 *
 * 两件事分开，各有唯一一份答案：
 *   · `hasQueryBody` —— 这一块有没有「结果身体」（只有查询源有；命中不是 children，
 *     所以就地画不会与正文重复）；
 *   · `hasInlineBody` ／ `rowHasInlineViewBody` —— 这一行画不画它：**按源分派**，
 *     有身体就画，段根同此（聚焦后身体仍贴着自己那一行；段尾/窗口根宿主只接
 *     children/items 源，再建一台就是同一块挂两台）。
 *
 * 高度也要在这里钉：身体是**自然高**（紧凑性归折叠），占位只在虚拟化档用
 * `VIEW_BODY_H` 估「一份普通查询结果」的典型高 —— 这一条钉的是「带身体的行
 * 占位必须比纯名字行多算一截」，不是「身体被封顶在多少」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hasFoldable,
  hasQueryBody,
  isEmbedBlock,
  isFolded,
  mkBlock,
  toggleCollapsed,
  type VisibleRow,
} from '../src/core/index.ts'
import { VIEW_BODY_GAP, VIEW_BODY_H, VIEW_BODY_INSET, hasInlineBody, rowHasInlineViewBody, visibleRowHeight } from '../src/view/editor/block-dom.ts'

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

test('hasInlineBody：定义块画值配置；标签声明非空才画；页的声明不投影', () => {
  const def = mkBlock('状态', { props: { _kind: 'select' } })
  assert.equal(hasInlineBody(def), true, '定义拿掉只剩名字 ⇒ 名字下面画定义（值配置）')
  assert.equal(hasInlineBody(mkBlock('普通块')), false)

  const tagWith = mkBlock('任务', { props: { _lists: ['tag'], _fieldDefs: ['p1'] } })
  assert.equal(hasInlineBody(tagWith), true, '有声明的标签：画字段声明')
  assert.equal(hasInlineBody(mkBlock('空标签', { props: { _lists: ['tag'] } })), false, '声明非空才画')
  assert.equal(
    hasInlineBody(mkBlock('页', { props: { _lists: ['page'], _fieldDefs: ['p1'] } })),
    false,
    '页的声明没有消费方，画出来是一个写进去却不生效的入口（与 declareField 同一条判据）',
  )
})

test('hasFoldable：子块或身体（查询结果／露面）；纯叶子不能', () => {
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

  const embed = mkBlock('', { props: { _embed: { block: q.id, view: '' } } })
  assert.equal(isEmbedBlock(embed), true)
  assert.equal(hasFoldable(embed), true, '露面行下面有一格身体（镜像的子树或投影的结果视图）⇒ 写入口不把它当叶子')
})

test('visibleRowHeight：带身体的行占位多算「典型身体高 ＋ 缝」（虚拟化档的估算）', () => {
  const q = query()
  assert.equal(
    visibleRowHeight(q, 0, true) - visibleRowHeight(q, 0, false),
    VIEW_BODY_H + VIEW_BODY_GAP + VIEW_BODY_INSET,
    '占位必须比纯名字行多出「估算身体高 ＋ 身体与名字之间的缝 ＋ 身体与下一行之间的底缝」',
  )
  assert.ok(VIEW_BODY_H > 0, '估算是正数：身体行至少要给出一行的量')
  /**
   * 底缝是**真几何**的一部分（`styles/blocks.css` 里那条共享规则的 `margin-block-end`），
   * 不是估算的余量：少算它，带身体的行越多、长文档的滚动条就偏得越多。
   */
  assert.ok(VIEW_BODY_INSET > 0, '底缝是正数：身体的面与下一行的面之间必须有缝')
})
