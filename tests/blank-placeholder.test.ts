/**
 * 「空块占位」的判据：插入／搬入时该让它让位，还是把它当成一块真正的兄弟。
 *
 * 钉住的是「⌘X → 在空块里 ⌘V」那条手感的根据：空内容、无活子块、正文可写，
 * 三个条件缺一不可；身份块（日记／字段定义）与有原子的块都不算占位。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DELETED_AT_PROP, blankRowKind, isBlankPlaceholder, mkBlock } from '../src/core/index.ts'

test('空内容且可写 ⇒ 占位', () => {
  assert.equal(isBlankPlaceholder(mkBlock('')), true)
})

test('有正文／有行内原子 ⇒ 不是占位', () => {
  assert.equal(isBlankPlaceholder(mkBlock('一行字')), false)
  const atom = mkBlock('')
  atom.content = [{ id: 'a1', t: 'ref', to: 'b2' }]
  assert.equal(isBlankPlaceholder(atom), false)
})

test('活子块挡住占位；子块全软删仍算占位', () => {
  const withChild = mkBlock('')
  withChild.children.push(mkBlock('子块'))
  assert.equal(isBlankPlaceholder(withChild), false)

  const withDeletedChild = mkBlock('')
  const gone = mkBlock('已删')
  gone.props = { [DELETED_AT_PROP]: 1 }
  withDeletedChild.children.push(gone)
  assert.equal(isBlankPlaceholder(withDeletedChild), true)
})

test('身份块没有可写正文 ⇒ 不是占位（不能被搬来的块顶掉）', () => {
  const day = mkBlock('')
  day.props = { _date: '2026-11-11' }
  assert.equal(isBlankPlaceholder(day), false)
  const def = mkBlock('')
  def.props = { _kind: 'select' }
  assert.equal(isBlankPlaceholder(def), false)
})

test('空行的两档落点：占位／容器都让位；有正文或只读正文走兄弟位', () => {
  const leaf = mkBlock('')
  assert.equal(blankRowKind(leaf), 'placeholder')

  const container = mkBlock('')
  container.children.push(mkBlock('原有子块'))
  // 折叠态不再改落点：来的块占的是这一行，不是插进子层
  assert.equal(blankRowKind(container), 'container')

  const withText = mkBlock('有正文的父块')
  withText.children.push(mkBlock('子块'))
  assert.equal(blankRowKind(withText), null)

  const identity = mkBlock('')
  identity.props = { _date: '2026-11-11' }
  identity.children.push(mkBlock('子块'))
  assert.equal(blankRowKind(identity), null)
})
