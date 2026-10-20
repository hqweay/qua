import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toggleChildrenCollapsed } from '../src/core/tree.ts'
import type { Block, Doc } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

function fixture(): Doc {
  const a11 = mk('a11', 'a11')
  const a12 = mk('a12', 'a12')
  const a1 = mk('a1', 'a1', [a11, a12])
  const a2 = mk('a2', 'a2')
  const a = mk('a', 'a', [a1, a2])
  return { roots: [a] }
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

test('folds direct children only; the parent itself stays unfolded', () => {
  const doc = fixture()
  assert.equal(toggleChildrenCollapsed(doc, 'a'), true)
  assert.equal(find(doc, 'a').collapsed, undefined)
  assert.equal(find(doc, 'a1').collapsed, true)
  assert.equal(find(doc, 'a2').collapsed, true)
  assert.equal(find(doc, 'a11').collapsed, undefined)
  assert.equal(find(doc, 'a12').collapsed, undefined)
})

test('second call unfolds (toggle) and still leaves the parent unfolded', () => {
  const doc = fixture()
  toggleChildrenCollapsed(doc, 'a')
  assert.equal(toggleChildrenCollapsed(doc, 'a'), false)
  assert.equal(find(doc, 'a').collapsed, undefined)
  assert.equal(find(doc, 'a1').collapsed, false)
  assert.equal(find(doc, 'a2').collapsed, false)
})

test('group intent: a half-folded group folds fully on one click', () => {
  const doc = fixture()
  find(doc, 'a1').collapsed = true
  assert.equal(toggleChildrenCollapsed(doc, 'a'), true)
  assert.equal(find(doc, 'a1').collapsed, true)
  assert.equal(find(doc, 'a2').collapsed, true)
})

test('no children => null (caller must refuse; no undo entry)', () => {
  const doc = fixture()
  assert.equal(toggleChildrenCollapsed(doc, 'a11'), null)
  assert.equal(toggleChildrenCollapsed(doc, 'missing'), null)
})
