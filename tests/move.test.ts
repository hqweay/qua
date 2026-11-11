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
  dropInsertSite,
  dropMove,
  dropMoveExternal,
  dropRefused,
  flatten,
  indentMove,
  locate,
  moveStaysInside,
  outdentMove,
  siblingMove,
  type MovePlan,
} from '../src/core/model/tree.ts'
import { DIVIDER_TYPE } from '../src/core/model/types.ts'
import type { Block, Doc } from '../src/core/model/model.ts'

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

/* ---------------------------------------------- ⌥ 拖：在落点插一枚引用（dropInsertSite） */

/**
 * 引用式落点＝同一份判据、少一格「摘掉自己」。
 *
 * 两个下标必须同时钉住：`dropMove` 的是「摘掉自己之后」的口径（移动用），
 * `dropInsertSite` 的是真实列表里的下标（插新块用）。只钉一个，另一处差一格也看不出来。
 */
test('引用式落点：自己排在落点前时不还格 ⇒ 新块落在悬停高亮处，不差一行', () => {
  const doc = fixture()
  // c2 拖到 c3 之前：悬停线在 c2/c3 之间 ⇒ 新块必须在 c2 与 c3 之间（真实下标 2）；
  // 而移动的 plan 摘掉 c2 之后是 1 —— 直接拿它插会落到 c2 上面一格。
  assert.deepEqual(dropMove(doc, 'c2', 'c3', 'before'), { parentId: 'p', index: 1 })
  assert.deepEqual(dropInsertSite(doc, 'c2', 'c3', 'before'), { parentId: 'p', index: 2 })
  // c2 落到 c1 之后：新块紧贴 c1（1），不是 c2 原来那一格之后
  assert.deepEqual(dropInsertSite(doc, 'c2', 'c1', 'after'), { parentId: 'p', index: 1 })
  // 自己排在落点之后 ⇒ 没有要还的格，两处答案一致
  assert.deepEqual(dropMove(doc, 'c3', 'c1', 'after'), { parentId: 'p', index: 1 })
  assert.deepEqual(dropInsertSite(doc, 'c3', 'c1', 'after'), { parentId: 'p', index: 1 })
})

test('引用式落点：inside 与空白处都不摘任何块（空白处＝最后一个根的孩子末尾）', () => {
  const doc = fixture()
  assert.deepEqual(dropInsertSite(doc, 'c2', 'c1', 'inside'), { parentId: 'c1', index: 1 })
  assert.deepEqual(dropInsertSite(doc, 'c2', null, 'after'), { parentId: 'x', index: 1 })
  // 被拖块本身就是 x 的孩子 ⇒ 不还格（新块落在它后面，x 的孩子数从 1 变 2）
  assert.deepEqual(dropMove(doc, 'x1', null, 'after'), { parentId: 'x', index: 0 })
  assert.deepEqual(dropInsertSite(doc, 'x1', null, 'after'), { parentId: 'x', index: 1 })
})

test('引用式落点沿用同一套守卫：自己 / 自己的子树 / 不存在的目标 / 占位型类型', () => {
  const doc = fixture()
  doc.roots[0]!.children.push({ id: 'div', content: [], children: [], created: 0, modified: 0, props: { _type: DIVIDER_TYPE } })
  assert.equal(dropInsertSite(doc, 'c1', 'c1', 'before'), null)
  assert.equal(dropInsertSite(doc, 'c1', 'g1', 'inside'), null, '落点在自己子树里')
  assert.equal(dropInsertSite(doc, 'c1', '没有这一块', 'after'), null)
  assert.equal(dropInsertSite(doc, 'c1', 'div', 'inside'), null, '占位型块容纳不下任何子块')
  assert.deepEqual(dropInsertSite(doc, 'c1', 'div', 'after'), { parentId: 'p', index: 4 }, 'before/after 仍可以')
})

/* --------------------------------------------- 悬停期的可落性预告（dropRefused） */

/**
 * 落手被拒是静默的（守卫返 false，一个块都不动），而悬停已经把提示与高亮许诺出去——
 * 「提示说能落、松手没反应」比一开始就说落不了伤得多。
 * 这里钉住：悬停预告与落手守卫在**同一批格子**上拒绝，两边永不分叉。
 */
test('悬停预告：自己 / 自己的子树 / 占位型 inside / 段根前后，与落手守卫同一批格子拒绝', () => {
  const doc = fixture()
  doc.roots[0]!.children.push({ id: 'div', content: [], children: [], created: 0, modified: 0, props: { _type: DIVIDER_TYPE } })
  // 自己与自己的子树：任何区都拒（拖父块落在展开的子块行上，是最容易踩的手势）
  assert.equal(dropRefused(doc, 'c1', 'c1', 'inside'), true)
  assert.equal(dropRefused(doc, 'c1', 'c1', 'before'), true)
  assert.equal(dropRefused(doc, 'c1', 'g1', 'inside'), true)
  assert.equal(dropRefused(doc, 'c1', 'g1', 'after'), true)
  // 正常格子与占位型的 before/after 不拒
  assert.equal(dropRefused(doc, 'c1', 'c2', 'after'), false)
  assert.equal(dropRefused(doc, 'c2', 'c1', 'inside'), false)
  assert.equal(dropRefused(doc, 'c1', 'div', 'inside'), true, '占位型的 inside：落手本来就不接')
  assert.equal(dropRefused(doc, 'c1', 'div', 'after'), false, '占位型的 after：折算后可落')
  // 段根（装载根 p）：只有 inside 能落；before/after 会造出没有家的兄弟
  assert.equal(dropRefused(doc, 'c1', 'p', 'before'), true)
  assert.equal(dropRefused(doc, 'c1', 'p', 'after'), true)
  assert.equal(dropRefused(doc, 'c1', 'p', 'inside'), false)
  // 空白处：进最后一个根的末尾，可落
  assert.equal(dropRefused(doc, 'c1', null, 'after'), false)
})

test('悬停预告：外部源不归这份判据（落手走跨容器那支，守卫在 dropMoveExternal）', () => {
  const doc = fixture()
  assert.equal(dropRefused(doc, '不在doc里的块', 'c2', 'inside'), false)
  assert.equal(dropRefused(doc, '不在doc里的块', null, 'after'), false)
})

test('悬停预告：目标行不在接住的那份 doc 里 ⇒ 拒（挂载区／镜像岛的地盘不许假许诺）', () => {
  const doc = fixture()
  // 源在 doc 内、目标在别处（镜像行的 id、挂载区里的行）：本 doc 的两支落手都进不去
  assert.equal(dropRefused(doc, 'c1', '别的doc的行', 'inside'), true)
  assert.equal(dropRefused(doc, 'c1', '别的doc的行', 'after'), true)
  // 外部源也一样：目标不在这份 doc，接住的编辑器落手必拒
  assert.equal(dropRefused(doc, '不在doc里的块', '别的doc的行', 'inside'), true)
  // 空白处（targetId null）不在此列：落点走「最后一个根的末尾」
  assert.equal(dropRefused(doc, '不在doc里的块', null, 'after'), false)
})

test('applyMove 自环守卫：目标是自己或自己的后代 ⇒ false，且不摘不改', () => {
  const doc = fixture()
  const snapshot = JSON.stringify(doc.roots)
  assert.equal(applyMove(doc, 'c1', { parentId: 'c1', index: 0 }), false)
  assert.equal(applyMove(doc, 'c1', { parentId: 'g1', index: 0 }), false)
  assert.equal(JSON.stringify(doc.roots), snapshot)
})

/* -------------------------------------------------- 跨容器拖拽（dropMoveExternal） */

/** 窗口卡的 doc：roots 只挂卡根；被拖块不在 doc 里（真实场景里由 store 现取） */
function cardDoc(): { doc: Doc; dragged: Block } {
  const mkb = (id: string, children: Block[] = [], props?: Record<string, unknown>): Block => ({
    id,
    content: [],
    children,
    created: 0,
    modified: 0,
    ...(props ? { props } : {}),
  })
  return {
    doc: { roots: [mkb('card', [mkb('r1'), mkb('r2')])] },
    dragged: mkb('out', [mkb('k1')]),
  }
}

test('跨容器拖拽 inside / 空白处：落进孩子末尾；空白处进最后一个根（与 doc 内同口径）', () => {
  const { doc, dragged } = cardDoc()
  assert.deepEqual(dropMoveExternal(doc, dragged, 'card', 'inside'), { parentId: 'card', index: 2 })
  assert.deepEqual(dropMoveExternal(doc, dragged, 'r1', 'inside'), { parentId: 'r1', index: 0 })
  assert.deepEqual(dropMoveExternal(doc, dragged, null, 'after'), { parentId: 'card', index: 2 })
})

test('跨容器拖拽 before/after：外部位移没有 shift（被拖块不在目标列表里）', () => {
  const { doc, dragged } = cardDoc()
  assert.deepEqual(dropMoveExternal(doc, dragged, 'r2', 'before'), { parentId: 'card', index: 1 })
  assert.deepEqual(dropMoveExternal(doc, dragged, 'r2', 'after'), { parentId: 'card', index: 2 })
})

test('跨容器拖拽拒绝：拖到自己 / 目标在自己的子树里 / 目标不在 doc', () => {
  // 「卡根＝被拖块的子块」是真会发生的：卡正显示着被拖块的后代。
  // 自环守卫走 store 现取的那份子树，doc 级查不到这条边。
  const mkb = (id: string, children: Block[] = []): Block => ({ id, content: [], children, created: 0, modified: 0 })
  const inner = mkb('c', [mkb('c1')])
  const doc: Doc = { roots: [inner] }
  const dragged = mkb('out', [inner])
  assert.equal(dropMoveExternal(doc, dragged, 'out', 'inside'), null, '拖到自己')
  assert.equal(dropMoveExternal(doc, dragged, 'c', 'inside'), null, '目标在被拖块的子树里 ⇒ 自环')
  assert.equal(dropMoveExternal(doc, dragged, 'c1', 'after'), null, '同上，before/after 也一样')
  const plain = cardDoc()
  assert.equal(dropMoveExternal(plain.doc, plain.dragged, '没有这一块', 'after'), null)
})

test('跨容器拖拽：目标是 doc 根（卡根）⇒ before/after 折算成「进它里面」——它没有兄弟位', () => {
  const { doc, dragged } = cardDoc()
  assert.deepEqual(dropMoveExternal(doc, dragged, 'card', 'before'), { parentId: 'card', index: 2 })
  assert.deepEqual(dropMoveExternal(doc, dragged, 'card', 'after'), { parentId: 'card', index: 2 })
  assert.deepEqual(dropMoveExternal(doc, dragged, 'card', 'inside'), { parentId: 'card', index: 2 })
})

test('跨容器拖拽：目标是不许有子块的类型 ⇒ inside 拒绝，before/after 仍可以', () => {
  const mkb = (id: string, children: Block[] = [], props?: Record<string, unknown>): Block => ({
    id,
    content: [],
    children,
    created: 0,
    modified: 0,
    ...(props ? { props } : {}),
  })
  const doc: Doc = { roots: [mkb('card', [mkb('div', [], { _type: DIVIDER_TYPE })])] }
  const dragged = mkb('out')
  assert.equal(dropMoveExternal(doc, dragged, 'div', 'inside'), null)
  assert.deepEqual(dropMoveExternal(doc, dragged, 'div', 'after'), { parentId: 'card', index: 1 })
})

test('结果集/镜像的根不能搬：根不换位，深一层只在根子树内反缩进', () => {
  const doc = fixture()
  const rootPlan = siblingMove(doc, 'p', 1)
  assert.ok(rootPlan)
  assert.equal(moveStaysInside(doc, 'p', rootPlan), false, '根换位 = 改变结果集')

  const c2Plan = indentMove(doc, 'c2')
  assert.ok(c2Plan)
  assert.equal(moveStaysInside(doc, 'c2', c2Plan), true, '子树内缩进')

  const g1Plan = outdentMove(doc, 'g1')
  assert.ok(g1Plan)
  assert.equal(moveStaysInside(doc, 'g1', g1Plan), true, '深一层反缩进仍落在根子树内')

  assert.equal(outdentMove(doc, 'c1'), null, '一级子块反缩进会离开根子树 ⇒ 它自己就没有落点')
  assert.equal(moveStaysInside(doc, 'c1', { parentId: 'outside', index: 0 }), false, '落点不在窗口里')
})
