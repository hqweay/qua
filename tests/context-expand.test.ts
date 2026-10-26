/**
 * **上下文展开**的纯逻辑断言（反链／查询两个面板共用）。
 *
 * 这里钉的是「点一级发生了什么」：根换成了谁、哪些命中被去重、
 * 嵌套展开只渲染最外层、逐层收起时内层还在、折叠的路径被打开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandContexts, unfoldForContext, type ContextBase } from '../src/core/context-expand.ts'
import { findPath } from '../src/core/tree.ts'
import type { Block } from '../src/core/model.ts'

const mk = (id: string, children: Block[] = []): Block => ({ id, content: [], children, created: 0, modified: 0 })

const a1 = mk('a1')
const a = mk('a', [a1])
const b1 = mk('b1')
const b = mk('b', [b1])
const p = mk('p', [a, b])
const forest = [p]
const pathOf = (id: string): readonly Block[] => findPath(forest, id) ?? []

/** 两条最外层命中：p/a/a1 与 p/b/b1 */
const base: ContextBase = {
  roots: [a1, b1],
  contexts: new Map([
    ['a1', [p, a]],
    ['b1', [p, b]],
  ]),
}

const ids = (bs: readonly Block[]): string[] => bs.map((x) => x.id)

test('展开一级：根从命中行换成它的父；命中的兄弟不会混进来', () => {
  const plan = expandContexts(base, new Set(['a']), pathOf)
  assert.deepEqual(ids(plan.roots), ['a', 'b1'], 'a 覆盖 a1；b1 仍是自己的根')
  assert.deepEqual(ids(plan.contexts.get('a') ?? []), ['p'], '上下文根的祖先链只剩 p')
  assert.deepEqual([...plan.contextRoots], ['a'])
  assert.deepEqual(plan.covers.get('a'), ['a1'])
  assert.equal(plan.focusId, null, '没有 focusHint 就不滚')
})

test('滚动落点：点原始命中 → 它自己；点上下文根 → 它覆盖的第一条命中', () => {
  assert.equal(expandContexts(base, new Set(['a']), pathOf, 'a1').focusId, 'a1')
  assert.equal(expandContexts(base, new Set(['a']), pathOf, 'a').focusId, 'a1')
})

test('展开到页根：两个命中都收进同一棵子树，根只出现一次', () => {
  const plan = expandContexts(base, new Set(['p']), pathOf)
  assert.deepEqual(ids(plan.roots), ['p'])
  assert.deepEqual(plan.covers.get('p'), ['a1', 'b1'])
  assert.deepEqual(ids(plan.contexts.get('p') ?? []), [], '页根没有更上层的面包屑')
  assert.equal(expandContexts(base, new Set(['p']), pathOf, 'p').focusId, 'a1', '点根时滚到第一条被覆盖的命中')
})

test('嵌套展开只渲染最外层；内层留在栈里（收起外层时再浮出来）', () => {
  const plan = expandContexts(base, new Set(['a', 'p']), pathOf)
  assert.deepEqual(ids(plan.roots), ['p'])
  assert.deepEqual([...plan.expanded].sort(), ['a', 'p'], '内层必须还在，供逐层退回')

  const afterCollapse = expandContexts(base, new Set([...plan.expanded].filter((x) => x !== 'p')), pathOf)
  assert.deepEqual(ids(afterCollapse.roots), ['a', 'b1'], '收掉 p 之后回到 a 那一层')
})

test('两个分支各自展开：互不影响，各留一个上下文根', () => {
  const plan = expandContexts(base, new Set(['a', 'b']), pathOf)
  assert.deepEqual(ids(plan.roots), ['a', 'b'])
  assert.deepEqual(plan.covers.get('a'), ['a1'])
  assert.deepEqual(plan.covers.get('b'), ['b1'])
})

test('过期的展开 id 被剪掉：不再出现在任何命中的祖先链里 ⇒ 当作没展开', () => {
  const onlyA: ContextBase = { roots: [a1], contexts: new Map([['a1', [p, a]]]) }
  const plan = expandContexts(onlyA, new Set(['b']), pathOf)
  assert.deepEqual(ids(plan.roots), ['a1'])
  assert.equal(plan.expanded.size, 0)
})

test('展开出来的路径要真的打开：折叠的上下文根与中间祖先被清掉，命中行自己的折叠保留', () => {
  const next = unfoldForContext({ p: true, a: true, a1: true }, new Map([['p', ['a1']]]), pathOf)
  assert.deepEqual(next, { a1: true })
  assert.equal(unfoldForContext(undefined, new Map(), pathOf), undefined, '没有展开就不动折叠表')
})
