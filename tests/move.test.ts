/**
 * **结构移动的落点只有一份**（缩进／反缩进／上下换位／拖拽）。
 *
 * 为什么值得单测：这些落点此前各写一遍 `splice`，同列表内「摘掉自己之后下标差一格」
 * 这条差异在每个入口都各算一次 —— 四条入口就有四个答案，而用户看到的只有一种。
 * 现在四条入口都返回 `MovePlan`，`applyMove`（直写）与 `tx.move`（事务）按**同一口径**插：
 * `index` 是**摘掉自己之后**的最终下标。
 *
 * 另钉一条行为修正：块在**装载根的直接子层**（页/天的一级子块）时反缩进没有落点 ——
 * 窗口的 `roots` 不是森林的根，插进去的块刷新就消失（看着像移动成功）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyMove,
  dropMove,
  flatten,
  indentMove,
  locate,
  outdentMove,
  siblingMove,
  type MovePlan,
} from '../src/core/tree.ts'
import type { Block, Doc } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

/** `p`（装载根）→ c1(g1) / c2 / c3；`x` 是另一个根（空白处拖拽落到它里面） */
function fixture(): Doc {
  const p = mk('p', '页', [mk('c1', '一', [mk('g1', '一·一')]), mk('c2', '二'), mk('c3', '三')])
  const x = mk('x', '另一段', [mk('x1', '另一段·一')])
  return { roots: [p, x] }
}

/** 落点必须与「真的挪过去之后的位置」一致：plan 是唯一的真相 */
function moved(doc: Doc, id: string, plan: MovePlan | null): { parentId: string | null; index: number } | null {
  if (!plan) return null
  assert.equal(applyMove(doc, id, plan), true)
  const loc = locate(doc, id)
  assert.ok(loc)
  return { parentId: loc.parent?.id ?? null, index: loc.index }
}

test('缩进的落点：前兄弟的最后一个孩子（append），直写之后位置与 plan 一致', () => {
  const doc = fixture()
  const plan = indentMove(doc, 'c2')
  assert.deepEqual(plan, { parentId: 'c1', index: 1 }, 'c1 已有一个孩子 ⇒ 落点是 1')
  assert.deepEqual(moved(doc, 'c2', plan), plan)
  assert.equal(locate(doc, 'c2')!.parent!.id, 'c1')
  assert.equal(flatten(doc).find((b) => b.id === 'c2')!.text, '二', '搬的是整块，正文不丢')
})

test('缩进没有落点：首块（没有前兄弟）', () => {
  const doc = fixture()
  assert.equal(indentMove(doc, 'c1'), null)
  assert.deepEqual(doc.roots[0]!.children.map((b) => b.id), ['c1', 'c2', 'c3'], '拒绝 ⇒ 位置不动')
})

test('反缩进的落点：变父的下一个兄弟；子树跟着走', () => {
  const doc = fixture()
  const plan = outdentMove(doc, 'g1')
  assert.deepEqual(plan, { parentId: 'p', index: 1 }, 'c1 的下标 0 ⇒ 落点 1（在 c1 之后）')
  assert.deepEqual(moved(doc, 'g1', plan), plan)
  assert.deepEqual(locate(doc, 'c1')!.block.children, [], '原父不再挂着它')
})

test('反缩进没有落点：块本身是装载根，或父块就是装载根（窗口 roots 不是森林的根）', () => {
  const doc = fixture()
  assert.equal(outdentMove(doc, 'p'), null, '根块没有父块')
  assert.equal(outdentMove(doc, 'c2'), null, '父块（p）是装载根 ⇒ 写不回去的位置不造')
  assert.equal(locate(doc, 'c2')!.parent!.id, 'p', '拒绝 ⇒ 位置不动')
})

test('上下换位：同层相邻兄弟；到边界拒绝', () => {
  const doc = fixture()
  const down = siblingMove(doc, 'c2', 1)
  assert.deepEqual(down, { parentId: 'p', index: 2 })
  assert.deepEqual(moved(doc, 'c2', down), down)
  assert.deepEqual(doc.roots[0]!.children.map((b) => b.id), ['c1', 'c3', 'c2'])

  assert.equal(siblingMove(doc, 'c1', -1), null, '首块不能再上移')
  assert.deepEqual(siblingMove(doc, 'p', 1), { parentId: null, index: 1 }, '根层也能换位（doc.roots 里）')
})

test('拖拽 before/after：同列表里「自己排在目标前面」时下标要减一（摘掉自己后目标前移）', () => {
  const doc = fixture()
  // c1 拖到 c3 之前：摘掉 c1 ⇒ [c2,c3]，c3 的下标变成 1 ⇒ 落点 1
  const before = dropMove(doc, 'c1', 'c3', 'before')
  assert.deepEqual(before, { parentId: 'p', index: 1 })
  assert.deepEqual(moved(doc, 'c1', before), before)
  assert.deepEqual(doc.roots[0]!.children.map((b) => b.id), ['c2', 'c1', 'c3'], '应落在 c3 之前')
})

test('拖拽 after：落点在目标之后；跨列表不受 shift 影响', () => {
  const doc = fixture()
  const after = dropMove(doc, 'c1', 'c3', 'after')
  assert.deepEqual(after, { parentId: 'p', index: 2 }, '摘掉 c1 后 c3 是 1 ⇒ after 是 2')
  assert.deepEqual(moved(doc, 'c1', after), after)
  assert.deepEqual(doc.roots[0]!.children.map((b) => b.id), ['c2', 'c3', 'c1'])

  const cross = dropMove(doc, 'g1', 'x', 'inside')
  assert.deepEqual(cross, { parentId: 'x', index: 1 })
  assert.deepEqual(moved(doc, 'g1', cross), cross)
})

test('拖拽 inside / 空白处：落在孩子末尾；空白处进最后一个根', () => {
  const doc = fixture()
  assert.deepEqual(dropMove(doc, 'c2', 'c1', 'inside'), { parentId: 'c1', index: 1 })
  assert.deepEqual(dropMove(doc, 'c2', null, 'after'), { parentId: 'x', index: 1 })
  // 已经在最后一个根里面 ⇒ 摘掉自己之后是「原本的末尾」
  assert.deepEqual(dropMove(doc, 'x1', null, 'after'), { parentId: 'x', index: 0 })
})

test('拖拽拒绝：拖到自己身上 / 拖进自己的子树 / 目标不存在', () => {
  const doc = fixture()
  assert.equal(dropMove(doc, 'c1', 'c1', 'before'), null)
  assert.equal(dropMove(doc, 'c1', 'g1', 'inside'), null, 'g1 在 c1 的子树里 ⇒ 会造出自环')
  assert.equal(dropMove(doc, 'c1', '没有这一块', 'after'), null)
  assert.deepEqual(
    flatten(doc).map((b) => b.id),
    ['p', 'c1', 'g1', 'c2', 'c3', 'x', 'x1'],
    '拒绝时整棵树原样',
  )
})

test('applyMove 自环守卫：目标是自己或自己的后代 ⇒ false，且不摘不改', () => {
  const doc = fixture()
  const snapshot = JSON.stringify(doc.roots)
  assert.equal(applyMove(doc, 'c1', { parentId: 'c1', index: 0 }), false)
  assert.equal(applyMove(doc, 'c1', { parentId: 'g1', index: 0 }), false)
  assert.equal(JSON.stringify(doc.roots), snapshot)
})
