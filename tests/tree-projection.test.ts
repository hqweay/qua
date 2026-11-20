/**
 * **树投影的批级判据**（渲染热路径的等价性钉）。
 *
 * 两件事：
 *   ① `hasSingleLiveBlock` 与 `flatten(doc).length === 1` 同一口径（逐行判便宜的替代）；
 *   ② `RowDerive` 只是「一批共用一次扫库」，**结果必须与不传时逐字相同**。
 *
 * 前一条防「优化后口径漂了」；后一条防「缓存了一份不等于现算的东西」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  belowFieldsFor,
  declareField,
  flatten,
  gutterFieldsFor,
  hasSingleLiveBlock,
  mkBlock,
  mkPropDef,
  mkTagBlock,
  rowDeriveOf,
  setValue,
  type Block,
  type Doc,
} from '../src/core/index.ts'

const mk = (id: string, children: Block[] = [], props: Block['props'] = {}): Block => {
  const b = mkBlock(id, { props })
  b.id = id
  b.children = children
  return b
}

const doc = (roots: Block[]): Doc => ({ roots })

test('① 单块判据与 flatten 同口径（活根数 × 活孩子 × 软删子树）', () => {
  const deleted = (b: Block): Block => {
    b.props = { ...(b.props ?? {}), _deletedAt: 1 }
    return b
  }

  const cases: { name: string; roots: Block[] }[] = [
    { name: '空森林', roots: [] },
    { name: '一个孤块', roots: [mk('a')] },
    { name: '一块带活孩子', roots: [mk('a', [mk('a1')])] },
    { name: '两个活根', roots: [mk('a'), mk('b')] },
    { name: '一个活根 ＋ 软删根', roots: [mk('a'), deleted(mk('b'))] },
    { name: '活根 ＋ 软删孩子', roots: [mk('a', [deleted(mk('a1'))])] },
    { name: '活根 ＋ 软删孩子底下有活孙', roots: [mk('a', [deleted(mk('a1', [mk('a11')]))])] },
    { name: '全部软删', roots: [deleted(mk('a')), deleted(mk('b'))] },
  ]

  for (const c of cases) {
    const d = doc(c.roots)
    assert.equal(
      hasSingleLiveBlock(d),
      flatten(d).length === 1,
      `${c.name}：单块判据必须与 flatten 一致`,
    )
  }
})

test('② RowDerive 共用扫库结果，派生值与逐次现算逐字相同', () => {
  const def = mkPropDef('评分', 'number', { _uiPosition: 'block-left' })
  const tagB = mkTagBlock('书')
  assert.equal(declareField(tagB, def.id), true)
  const b = mk('b', [], { _tags: [tagB.id] })
  setValue(b, def.id, 5)
  const forest = [def, tagB, b]

  const derive = rowDeriveOf(forest)

  assert.deepEqual(
    gutterFieldsFor([b], forest, derive),
    gutterFieldsFor([b], forest),
    'gutter：带 derive 与不带 derive 必须相同',
  )
  assert.deepEqual(
    belowFieldsFor([b], forest, undefined, undefined, {}, derive),
    belowFieldsFor([b], forest),
    '块下属性行：带 derive 与不带 derive 必须相同',
  )
})
