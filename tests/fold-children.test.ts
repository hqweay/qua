import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toggleChildrenCollapsed, toggleCollapsed, visibleRows } from '../src/core/tree.ts'
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
  // a2 是叶子（无子块）⇒ 写不进折叠态：没有子树可藏，块标不该画折叠环
  assert.equal(folded(doc, 'a2'), false)
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
  // 「一半折一半开」要**两个都有子块**的成员才成立（叶子没有可折的东西，见下一条用例）
  const c11 = mk('c11', 'c11')
  const c21 = mk('c21', 'c21')
  const c1 = mk('c1', 'c1', [c11]) // 折着
  const c2 = mk('c2', 'c2', [c21]) // 开着
  const c = mk('c', 'c', [c1, c2])
  const doc: Doc = { roots: [c], folded: { c1: true } }
  assert.equal(toggleChildrenCollapsed(doc, 'c'), true, '组里还有开着的 ⇒ 这次是「折」')
  assert.equal(folded(doc, 'c1'), true)
  assert.equal(folded(doc, 'c2'), true, '整组同向 ⇒ 开着的那一个也被折')
  assert.equal(folded(doc, 'c'), false, '整组判定不该把父块自己算进去')

  // 反向：整组折着时再点一次 ⇒ 全部展开
  assert.equal(toggleChildrenCollapsed(doc, 'c'), false)
  assert.deepEqual(doc.folded, {})
})

test('整组里只有叶子 ⇒ null（没有可折的东西，别白画一屏）', () => {
  const doc = fixture()
  // 把 a1 的子块全去掉 ⇒ a 的子块全是叶子
  find(doc, 'a1').children = []
  assert.equal(toggleChildrenCollapsed(doc, 'a'), null)
  assert.deepEqual(doc.folded, {})
})

test('no children => null (caller must refuse; no undo entry)', () => {
  const doc = fixture()
  assert.equal(toggleChildrenCollapsed(doc, 'a11'), null)
  assert.equal(toggleChildrenCollapsed(doc, 'missing'), null)
})

/**
 * 叶子块**不许被记成折叠**。
 *
 * 事故形状（真机复现）：点一条竖线 ⇒ 折它的直接子块，整组一起写折叠态。
 * 组里那些自己没子块的成员也被写了 `true` —— 它们没有子树可藏，块标却画出折叠环
 * （「这里收着东西」），点开什么都没有；这条记录还会存进设备的折叠表、跟到下一次打开。
 *
 * ⇒ 判据落在**写入口**：折叠态只对「有子块」的块有意义，无子块 ⇒ 写不进去。
 */
test('叶子块写不进折叠态：一组子块里混合有子块/叶子时，只有有子块的那些被折', () => {
  const a11 = mk('a11', 'a11')
  const a12 = mk('a12', 'a12')
  const a13 = mk('a13', 'a13')
  const a1 = mk('a1', 'a1', [a11, a12]) // 有子块
  const a2 = mk('a2', 'a2') // 叶子
  const a3 = mk('a3', 'a3') // 叶子
  const a = mk('a', 'a', [a1, a2, a3])
  const doc: Doc = { roots: [a], folded: {} }

  assert.equal(toggleChildrenCollapsed(doc, 'a'), true)
  assert.equal(folded(doc, 'a1'), true, '有子块的成员应被折')
  assert.equal(folded(doc, 'a2'), false, '叶子不许被记成折叠（它没有子树可藏）')
  assert.equal(folded(doc, 'a3'), false, '同上')
  assert.deepEqual(Object.keys(doc.folded ?? {}), ['a1'], `折叠表里只该有真的有子块的那些：${JSON.stringify(doc.folded)}`)
})

test('无子块：折自己与折子块都不产生折叠态（白画一屏也算错）', () => {
  const doc = fixture()
  assert.equal(toggleCollapsed(doc, 'a11'), false, '叶子没有可折叠的子树 ⇒ 不算一次折叠')
  assert.equal(folded(doc, 'a11'), false)
  assert.deepEqual(doc.folded, {})
  // 有子块的块照常
  assert.equal(toggleCollapsed(doc, 'a1'), true)
  assert.equal(folded(doc, 'a1'), true)
  // 展开永远放行（它是用来「清」的，不该被同一条判断挡住）
  assert.equal(toggleCollapsed(doc, 'a1'), true)
  assert.equal(folded(doc, 'a1'), false)
})

test('折叠表落在文档上：可见行按它算，块自己不受影响', () => {
  const doc = fixture()
  toggleChildrenCollapsed(doc, 'a')
  const hidden = new Map(visibleRows(doc).map((r) => [r.block.id, r.hidden]))
  assert.equal(hidden.get('a1'), false, '折叠块自己仍可见')
  assert.equal(hidden.get('a11'), true, '折叠块的子树不产出可见行')
  assert.equal(hidden.get('a2'), false)
})
