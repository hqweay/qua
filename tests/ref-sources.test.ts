/**
 * **引用数徽标与列表的对账契约**。
 *
 * 钉住四件在界面上容易被「看起来差不多」糊过去的事：
 *   ① 次数 ≠ 来源数：同一来源块引两次，徽标 2、列表 1 行且那行标「2 次」；
 *   ② 只读引用三类关系，标签归属／备注不进反链；
 *   ③ `Σ rows.count === total` —— 徽标与列表永远能对上账；
 *   ④ 排序稳定、不改动入参（渲染每次现算，纯函数不能偷改索引里的边）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { RelationEdge } from '../src/core/index.ts'
import { refSourcesOf } from '../src/core/views/ref-sources.ts'

const edge = (from: string, kind: RelationEdge['kind'], count?: number): RelationEdge => ({
  from,
  to: 'host',
  kind,
  ...(count === undefined ? {} : { count }),
})

test('空边表：不画徽标，也没有列表行', () => {
  assert.deepEqual(refSourcesOf([]), { total: 0, sources: 0, rows: [] })
})

test('非引用关系不进反链：标签归属与备注都不算', () => {
  const s = refSourcesOf([
    edge('a', 'inline', 2),
    edge('b', 'belongsTo', 5),
    edge('c', 'annotates', 9),
  ])
  assert.equal(s.total, 2)
  assert.equal(s.sources, 1)
  assert.deepEqual(s.rows[0]?.from, 'a')
})

test('同一来源块引多次：徽标是次数，列表仍是一行', () => {
  const s = refSourcesOf([edge('a', 'inline', 3)])
  assert.equal(s.total, 3)
  assert.equal(s.sources, 1)
  assert.equal(s.rows.length, 1)
  assert.equal(s.rows[0]?.count, 3)
})

test('count 缺省按一处算；多来源按次数降序、同次数按 id 稳定排', () => {
  const s = refSourcesOf([
    edge('b', 'property'),
    edge('a', 'embed'),
    edge('c', 'inline', 3),
  ])
  assert.equal(s.total, 5)
  assert.equal(s.sources, 3)
  assert.deepEqual(s.rows.map((r) => [r.from, r.count]), [['c', 3], ['a', 1], ['b', 1]])
  assert.deepEqual(s.rows[0]?.kinds, ['inline'])
})

test('对账：每来源次数加总恒等于徽标数字', () => {
  const edges = [
    edge('a', 'inline', 2),
    edge('a', 'property'),
    edge('b', 'embed'),
    edge('c', 'inline', 7),
  ]
  const s = refSourcesOf(edges)
  assert.equal(s.rows.reduce((n, r) => n + r.count, 0), s.total)
  assert.equal(s.sources, s.rows.length)
  // 纯函数：不改动调用方给的边
  assert.equal(edges[0]?.count, 2)
  assert.equal(edges.length, 4)
})

test('同一来源跨多种关系：合并成一行，种类都留着', () => {
  const s = refSourcesOf([edge('a', 'inline', 2), edge('a', 'embed')])
  assert.equal(s.sources, 1)
  assert.equal(s.total, 3)
  assert.deepEqual([...(s.rows[0]?.kinds ?? [])].sort(), ['embed', 'inline'])
})
