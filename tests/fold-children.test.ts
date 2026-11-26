import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bodyVisible,
  isBodyFolded,
  setBodyCollapsed,
  toggleBodyCollapsed,
  toggleChildrenCollapsed,
  toggleCollapsed,
  visibleRows,
} from '../src/core/model/tree.ts'
import type { Block, Doc } from '../src/core/model/model.ts'

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

/**
 * **点父块的线，组里「只有身体」的成员也要一起折**。
 *
 * 事故形状（用户报）：一页里有几个子块，其中一个查询块（它没有 children，
 * 结果是「身体」）；点父块前的竖线 ⇒ 有子块的兄弟折了、查询块那一格不动。
 * 用户看到的是「同一组里有的折了、有的没折」。
 *
 * 根因是**同一个问题有两份答案**：写入口 `writeFold` 判「能不能折」用的是
 * `hasFoldable`（子块 **或** 身体），而这里挑可折成员用的是 `hasLiveChildren`
 * （只认子块）⇒ 身体类成员被静默排除。
 *
 * 判据：可折的成员＝`hasFoldable` 为真的那些；写不写得进去仍归 `writeFold`。
 */
test('点父块的线：只有身体（查询块）的成员也跟着折，与有子块的兄弟同向', () => {
  const withKids = mk('k1', 'k1', [mk('k11', 'k11')])
  const q = mk('q1', 'q1')
  q.props = { _query: { where: { kind: 'any' } } }
  const leaf = mk('l1', 'l1')
  const parent = mk('p', 'p', [withKids, q, leaf])
  const doc: Doc = { roots: [parent], folded: {} }

  assert.equal(toggleChildrenCollapsed(doc, 'p'), true)
  assert.equal(folded(doc, 'k1'), true, '有子块的成员被折')
  assert.equal(folded(doc, 'q1'), true, '只有身体的成员也要折（否则组里一半折一半开）')
  assert.equal(folded(doc, 'l1'), false, '真叶子没有可折的东西，仍写不进去')

  // 可逆：再点一次，整组展回来
  assert.equal(toggleChildrenCollapsed(doc, 'p'), false)
  assert.deepEqual(doc.folded, {})
})

/** 组里只有「有身体」的成员也成立：不能因为「没有子块」就返回 null（那会让线点了没反应） */
test('组里只有查询块（无 children）⇒ 仍然折得动（不是 null）', () => {
  const q1 = mk('q1', 'q1')
  q1.props = { _query: { where: { kind: 'any' } } }
  const q2 = mk('q2', 'q2')
  q2.props = { _query: { where: { kind: 'any' } } }
  const parent = mk('p', 'p', [q1, q2])
  const doc: Doc = { roots: [parent], folded: {} }

  assert.equal(toggleChildrenCollapsed(doc, 'p'), true)
  assert.equal(folded(doc, 'q1'), true)
  assert.equal(folded(doc, 'q2'), true)
})

/* ---------------------------------------- 第二层：只收身体（`bodyFolded`） */

/**
 * 有身体的块下面有**两层**东西（身体 ＋ 子块），一颗位表达不了两个事实。
 * 这一组钉的是「两个位各自只回答一件事」以及行头那颗按钮的动作语义。
 */
test('只收身体：子块照常在上面，整片折叠位一个字节没动', () => {
  const kid = mk('k1', 'k1')
  const code = mk('c1', 'code title', [kid])
  code.props = { _type: 'core/code', _code: 'x = 1' }
  const doc: Doc = { roots: [code], folded: {}, bodyFolded: {} }

  assert.equal(toggleBodyCollapsed(doc, 'c1'), true)
  assert.equal(doc.bodyFolded?.['c1'], true, '身体收起来了')
  assert.equal(folded(doc, 'c1'), false, '子块没被收：整片折叠位不该被写')
  // 子块行仍在可见行里
  const rows = visibleRows(doc).filter((r) => !r.hidden).map((r) => r.block.id)
  assert.deepEqual(rows, ['c1', 'k1'])
})

test('身体已经看不见时再点一次 ⇒ 两个位一起清（不是翻一位）', () => {
  const code = mk('c1', 'code title')
  code.props = { _type: 'core/code', _code: 'x = 1' }
  const doc: Doc = { roots: [code], folded: { c1: true }, bodyFolded: {} }

  // 此刻身体看不见（被 `folded` 藏的）；按钮的语义是「让身体可见」⇒ 清两位
  assert.equal(toggleBodyCollapsed(doc, 'c1'), true)
  assert.equal(folded(doc, 'c1'), false)
  assert.equal(doc.bodyFolded?.['c1'], undefined)
  assert.equal(bodyVisible(doc, 'c1'), true)
})

test('没有身体的块写不进「只收身体」：不记一个不存在的事实', () => {
  const plain = mk('p1', 'just text')
  const doc: Doc = { roots: [plain], folded: {}, bodyFolded: {} }
  assert.equal(setBodyCollapsed(doc, 'p1', true), false)
  assert.equal(doc.bodyFolded?.['p1'], undefined)
  // 展开永远放行（展开是用来清的）
  doc.bodyFolded = { p1: true }
  assert.equal(setBodyCollapsed(doc, 'p1', false), true)
  assert.deepEqual(doc.bodyFolded, {})
})

test('整片收起当然也收起身体：bodyVisible 看两位', () => {
  const q = mk('q1', 'q')
  q.props = { _query: { where: { kind: 'any' } } }
  const doc: Doc = { roots: [q], folded: { q1: true }, bodyFolded: {} }
  assert.equal(bodyVisible(doc, 'q1'), false, 'folded 在场 ⇒ 身体不可见')
  doc.folded = {}
  doc.bodyFolded = { q1: true }
  assert.equal(bodyVisible(doc, 'q1'), false, 'bodyFolded 在场 ⇒ 身体不可见')
  doc.bodyFolded = {}
  assert.equal(bodyVisible(doc, 'q1'), true)
})

test('聚焦根的身体同样豁免；用户显式收它 ⇒ 以这次为准（清豁免位，当场生效）', () => {
  const code = mk('c1', 'code title')
  code.props = { _type: 'core/code', _code: 'x = 1' }
  const doc: Doc = { roots: [code], folded: {}, bodyFolded: { c1: true }, focusRootId: 'c1', focusRootOpen: true }
  assert.equal(isBodyFolded(doc, 'c1'), false, '聚焦期间不生效（表里有位也不收）')
  assert.equal(bodyVisible(doc, 'c1'), true, '所以屏幕上身体是展开的')
  // 用户显式收 ⇒ 与 `writeFold` 同一条口径：以这次为准
  assert.equal(toggleBodyCollapsed(doc, 'c1'), true)
  assert.equal(doc.focusRootOpen, undefined, '豁免位被清掉，这一下才落得下去')
  assert.equal(isBodyFolded(doc, 'c1'), true, '身体当场收起来')
})
