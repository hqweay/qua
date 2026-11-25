/**
 * 改指计划的契约：按 kind 分派到各自的槽，一笔补丁可撤销。
 *
 * 钉住四件容易被「看起来差不多」糊过去的：
 *   ① 只改命中 kind 的槽，其余槽一个字节不动；
 *   ② 同一块多种 kind 命中 ⇒ 合成一笔补丁（一次撤销的一部分）；
 *   ③ tag 去重保序、正文走 canWriteText 闸、跨类改指拦下；
 *   ④ from===to 是 no-op。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/model/model.ts'
import { textRuns, type RefRun } from '../src/core/model/runs.ts'
import type { RelationEdge } from '../src/core/relations/relations.ts'
import { planRetarget, applyRetargetPlan, type RetargetPlan } from '../src/core/relations/retarget.ts'

const b = (id: string, opts: Partial<Block> = {}): Block => ({
  id,
  content: textRuns('x'),
  children: [],
  created: 1,
  modified: 1,
  ...opts,
})
const ref = (id: string, to: string, extra: Partial<RefRun> = {}): RefRun => ({ id, t: 'ref', to, ...extra })
const edgesOf = (...pairs: [string, string, string, string?][]): RelationEdge[] =>
  pairs.map(([from, to, kind, propId]) => ({ from, to, kind, ...(propId ? { propId } : {}) }))

const TAG = new Set(['tagA', 'tagB'])

function apply(plan: RetargetPlan, blocks: Block[]): void {
  const byId = new Map(blocks.map((x) => [x.id, x]))
  applyRetargetPlan(plan, {
    patch: (id, fn) => fn(byId.get(id)!),
    setProp: (id, name, value) => {
      const x = byId.get(id)!
      x.props = { ...(x.props ?? {}), [name]: value }
    },
    setTags: (id, ids) => {
      const x = byId.get(id)!
      x.props = { ...(x.props ?? {}), _tags: [...ids] }
    },
  })
}

test('inline：只改指向 from 的 run，label 等键保留', () => {
  const src = b('src', {
    content: [...textRuns('前'), ref('r1', 'old', { label: '旧名' }), ...textRuns('后'), ref('r2', 'other')],
  })
  const blocks = [src]
  const plan = planRetarget('old', 'new', {
    edges: edgesOf(['src', 'old', 'inline']),
    find: (id) => blocks.find((x) => x.id === id),
    tagClassIds: TAG,
  })
  assert.equal(plan.total, 1)
  assert.equal(plan.blocked.length, 0)
  apply(plan, blocks)
  const refs = src.content.filter((r) => r.t === 'ref')
  assert.equal(refs[0]!.to, 'new')
  assert.equal(refs[0]!.label, '旧名')
  assert.equal(refs[1]!.to, 'other', '不指向 from 的 run 不动')
})

test('同一块 inline＋property 命中 ⇒ 一笔补丁含两个槽', () => {
  const src = b('src', {
    content: [...textRuns('x'), ref('r1', 'old')],
    props: { author: 'old', other: 'keep' },
  })
  const plan = planRetarget('old', 'new', {
    edges: edgesOf(['src', 'old', 'inline'], ['src', 'old', 'property', 'author']),
    find: (id) => [src].find((x) => x.id === id),
    tagClassIds: TAG,
  })
  assert.equal(plan.patches.length, 1)
  assert.deepEqual([...plan.patches[0]!.kinds].sort(), ['inline', 'property'])
  apply(plan, [src])
  assert.equal(src.content.find((r) => r.t === 'ref')!.to, 'new')
  assert.equal(src.props!.author, 'new')
  assert.equal(src.props!.other, 'keep')
})

test('tag：A→B 去重保序，已带 B 的不重复', () => {
  const src = b('src', { props: { _tags: ['x', 'tagA', 'tagB', 'tagA'] } })
  const plan = planRetarget('tagA', 'tagB', {
    edges: edgesOf(['src', 'tagA', 'tag']),
    find: (id) => [src].find((x) => x.id === id),
    kinds: ['tag'],
    tagClassIds: TAG,
  })
  apply(plan, [src])
  assert.deepEqual(src.props!._tags, ['x', 'tagB'])
})

test('跨类改指：#标签 改到非标签类 ⇒ blocked，正文不写', () => {
  const src = b('src', { content: [...textRuns('前'), ref('r1', 'tagA', { flavor: '#' })] })
  const before = JSON.stringify(src.content)
  const plan = planRetarget('tagA', 'plain', {
    edges: edgesOf(['src', 'tagA', 'tagMention']),
    find: (id) => [src].find((x) => x.id === id),
    tagClassIds: TAG,
  })
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.blocked[0]!.reason, 'cross-kind')
  assert.equal(plan.patches.length, 0)
  apply(plan, [src])
  assert.equal(JSON.stringify(src.content), before)
})

test('只读正文：canWriteText 不通过 ⇒ blocked', () => {
  const journal = b('j', { props: { _date: '2026-01-01' }, content: [...textRuns('x'), ref('r1', 'old')] })
  const plan = planRetarget('old', 'new', {
    edges: edgesOf(['j', 'old', 'inline']),
    find: (id) => [journal].find((x) => x.id === id),
    tagClassIds: TAG,
  })
  assert.equal(plan.blocked.length, 1)
  assert.equal(plan.blocked[0]!.reason, 'readonly-text')
})

test('from===to 是 no-op', () => {
  const plan = planRetarget('old', 'old', {
    edges: edgesOf(['src', 'old', 'inline']),
    find: () => b('src'),
    tagClassIds: TAG,
  })
  assert.deepEqual(plan, { patches: [], blocked: [], total: 0 })
})
