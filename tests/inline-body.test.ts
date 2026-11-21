/**
 * **行下身体归谁画**（`view/editor/block-dom.ts` 的 `inlineBodyKind`）的纯判据单测。
 *
 * 为什么这条值得单测：三种身体（查询／children 视图／自动化定义体／属性投影）**共用一个壳**
 * （`.blk-view-body`），所以「这一格归谁」是一份判据。它曾经在三个地方各写一遍
 * （新画的行、保留行接回、折叠三角），保留行那条按**壳**判 ⇒ 标签的属性投影上面又叠了
 * 一台视图宿主，冒出只属于看法视图的「N 项 · 大纲 · 新建一行」抬头；同一处把属性投影
 * 跳过 ⇒ 它的订阅在行重画后静默失联（内容不再跟着 store 刷新）。
 *
 * 这里钉两件事：① 每种块只有一种答案；② **激活看法优先于属性投影**——激活看法时正文的
 * 子块行已经让位（`Doc.viewRootId`），身体若仍画属性投影，两边都落空（实测：给带
 * 「标签属性」的标签建一张表格看法，子块当场消失且表格不出现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock } from '../src/core/index.ts'
import { inlineBodyKind, hasInlineBody } from '../src/view/editor/block-dom.ts'

const tagBlock = (props: Record<string, unknown> = {}): ReturnType<typeof mkBlock> => {
  const b = mkBlock('任务')
  b.props = { _lists: ['tag'], ...props }
  return b
}

const view = (id: string, kind: string): Record<string, unknown> => ({ id, kind })

test('普通叶子块没有行下身体：三种回调都不该被叫', () => {
  assert.equal(inlineBodyKind(mkBlock('一句话')), null)
  assert.equal(hasInlineBody(mkBlock('一句话')), false)
})

test('属性投影：定义块／声明了字段的标签 ⇒ def', () => {
  assert.equal(inlineBodyKind(tagBlock({ _fieldDefs: ['def1'] })), 'def', '带标签属性的标签画属性投影')
  const def = mkBlock('状态')
  def.props = { _kind: 'select' }
  assert.equal(inlineBodyKind(def), 'def', '属性定义块画值配置')
})

test('激活看法优先于属性投影：children 源的看法要能画出来（子块行已让位）', () => {
  const b = tagBlock({ _fieldDefs: ['def1'], _views: [view('v1', 'table')], _activeView: 'v1' })
  assert.equal(inlineBodyKind(b), 'view', '激活看法时身体必须是视图——def 会把子块行与看法一起落空')
  assert.equal(hasInlineBody(b), true)
})

test('没有激活看法就回到属性投影（`_views` 有配置但没激活不算）', () => {
  const b = tagBlock({ _fieldDefs: ['def1'], _views: [view('v1', 'table')] })
  assert.equal(inlineBodyKind(b), 'def')
})

test('查询块 ⇒ view；自动化块 ⇒ automation（优先级最高，不与定义体抢）', () => {
  const q = mkBlock('查询')
  q.props = { _query: { where: { any: [] } } }
  assert.equal(inlineBodyKind(q), 'view')
  const automation = mkBlock('规则')
  automation.props = { _automation: { triggers: [{ kind: 'manual' }] } }
  assert.equal(inlineBodyKind(automation), 'automation')
})
