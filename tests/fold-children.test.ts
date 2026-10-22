import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toggleChildrenCollapsed, visibleRows } from '../src/core/tree.ts'
import type { Block, Doc } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

function fixture(): Doc {
  const a11 = mk('a11', 'a11')
  const a12 = mk('a12', 'a12')
  const a1 = mk('a1', 'a1', [a11, a12])
  const a2 = mk('a2', 'a2')
  const a = mk('a', 'a', [a1, a2])
  return { roots: [a], folded: {} }
}

const find = (doc: Doc, id: string): Block => {
  const walk = (list: Block[]): Block | null => {
    for (const b of list) {
      if (b.id === id) return b
      const inner = walk(b.children)
      if (inner) return inner
    }
    return null
  }
  const b = walk(doc.roots)
  assert.ok(b, `fixture missing ${id}`)
  return b
}

/** 折叠态只记「收起的」：查表而不是查块 */
const folded = (doc: Doc, id: string): boolean => doc.folded?.[id] === true

test('folds direct children only; the parent itself stays unfolded', () => {
  const doc = fixture()
  assert.equal(toggleChildrenCollapsed(doc, 'a'), true)
  assert.equal(folded(doc, 'a'), false)
  assert.equal(folded(doc, 'a1'), true)
  assert.equal(folded(doc, 'a2'), true)
  assert.equal(folded(doc, 'a11'), false)
  assert.equal(folded(doc, 'a12'), false)
  // 折叠态**不写到块上**：内容块没有这个槽位
  assert.equal('collapsed' in find(doc, 'a1'), false)
})

test('second call unfolds (toggle) and still leaves the parent unfolded', () => {
  const doc = fixture()
  toggleChildrenCollapsed(doc, 'a')
  assert.equal(toggleChildrenCollapsed(doc, 'a'), false)
  assert.equal(folded(doc, 'a'), false)
  assert.equal(folded(doc, 'a1'), false)
  assert.equal(folded(doc, 'a2'), false)
  // 展开就是从表里删掉，不是写 false：否则「表里有 id 但展开」会变成第三态
  assert.deepEqual(doc.folded, {})
})

test('group intent: a half-folded group folds fully on one click', () => {
  const doc = fixture()
  doc.folded = { a1: true }
  assert.equal(toggleChildrenCollapsed(doc, 'a'), true)
  assert.equal(folded(doc, 'a1'), true)
  assert.equal(folded(doc, 'a2'), true)
})

test('no children => null (caller must refuse; no undo entry)', () => {
  const doc = fixture()
  assert.equal(toggleChildrenCollapsed(doc, 'a11'), null)
  assert.equal(toggleChildrenCollapsed(doc, 'missing'), null)
})

test('折叠表落在文档上：可见行按它算，块自己不受影响', () => {
  const doc = fixture()
  toggleChildrenCollapsed(doc, 'a')
  const hidden = new Map(visibleRows(doc).map((r) => [r.block.id, r.hidden]))
  assert.equal(hidden.get('a1'), false, '折叠块自己仍可见')
  assert.equal(hidden.get('a11'), true, '折叠块的子树不产出可见行')
  assert.equal(hidden.get('a2'), false)
})
