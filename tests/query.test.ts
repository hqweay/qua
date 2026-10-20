/**
 * 查询求值 ＋ 冻结（/D5/D8）的**纯逻辑**测试。
 *
 * 这里钉的是三件在界面上很难复现的事：
 *   ① 「冻结」冻的是**成员与顺序**，不是内容；
 *   ② 条件变了要能被判出来（D4 的「定义变化 ⇒ 重算」靠它）；
 *   ③ 结果里的父子同时在时只保留父（否则同一块渲染两遍）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import {
  canonicalSpec,
  findJournal,
  hasTag,
  readResult,
  readSpec,
  refreshSpec,
  resolveFrozen,
  runQuery,
  specChanged,
  type QuerySpec,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  text,
  children: [],
  ...extra,
})

/** #TODO 甲 / #TODO 乙 / 完成 / 无关（前两条带 `#todo` 标签） */
function fixture() {
  const blocks: Block[] = [
    b('p1', '页面一', {
      role: 'page',
      children: [
        b('a', '甲 #todo', { todo: 'todo' }),
        b('b', '乙 #todo', { todo: 'done' }),
        b('c', '丙没标签'),
        b('d', '提到丙的块', { children: [b('d1', '甲的子孙 #todo', { todo: 'todo' })] }),
      ],
    }),
    b('p2', '页面二', { role: 'page', children: [b('e', '另一个 #todo', { todo: 'todo' })] }),
    b('j1', '', { role: 'journal', props: { _date: '2026-10-20' }, children: [b('j1a', '今天的记录'), b('j1b', '也 #todo')] }),
  ]
  const atoms: Atom[] = [
    { id: 'at1', kind: 'page', blockId: 'd', start: 2, end: 3, label: '丙', target: { kind: 'page', id: 'c' }, state: 'resolved' } as Atom,
  ]
  return { blocks, atoms }
}

test('hasTag：按词边界匹配，不误伤前缀相同的标签', () => {
  assert.equal(hasTag('甲 #todo', 'todo'), true)
  assert.equal(hasTag('甲 #Todo', 'todo'), true, '大小写只有一个规范化点')
  assert.equal(hasTag('甲 #todos', 'todo'), false, '#todos 不是 #todo')
  assert.equal(hasTag('甲 #todo-x', 'todo'), false)
  assert.equal(hasTag('甲', 'todo'), false)
})

test('runQuery：标签条件只命中带标签的块', () => {
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1', 'e', 'j1b'])
})

test('runQuery：scope 缺省＝subtree —— 只在锚点之下找（含锚点自己）', () => {
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks, atoms, anchorId: 'p1' })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1'], 'p2 与 journal 不该进来')
})

test('runQuery：scope 缺省（subtree）＋ 锚点不在森林里 ⇒ 退回整片森林（不炸）', () => {
  // 查询块是**游离块**时（例如刚从 seed 里造出来、还没挂进森林）不该静默返回空结果
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks, atoms, anchorId: '不存在' })
  assert.equal(hits.length, 5)
})

test('runQuery：scope=all 时不受锚点限制', () => {
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { tag: 'todo' }, scope: 'all' }, { blocks, atoms, anchorId: 'p1' })
  assert.equal(hits.length, 5)
})

test('runQuery：ref 条件＝指向边（只认 atom 的 target id）', () => {
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { ref: 'c' }, scope: 'all' }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['d'])
})

test('runQuery：journal 条件取那天的**子块**，不含只读日期行本身', () => {
  const { blocks, atoms } = fixture()
  assert.ok(findJournal(blocks, '2026-10-20'))
  // ⚠️ 一个 node 只能是一种形态：写成 `{ journal, all: [] }` 会被 `'all' in node` 先命中（恒真）
  const hits = runQuery({ where: { journal: '2026-10-20' }, scope: 'all' }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1a', 'j1b'], '日期行 j1 不该在结果里')
})

test('runQuery：all / any / not 组合', () => {
  const { blocks, atoms } = fixture()
  const todoOnly = runQuery({ where: { all: [{ tag: 'todo' }, { todo: 'todo' }] }, scope: 'all' }, { blocks, atoms })
  // ⚠️ `j1b` 只有标签、没有待办状态 ⇒ 不该命中 `all[tag, todo]`
  assert.deepEqual(todoOnly.map((h) => h.blockId), ['a', 'd1', 'e'])

  const notTag = runQuery({ where: { not: { tag: 'todo' } }, scope: 'all' }, { blocks, atoms })
  assert.ok(!notTag.some((h) => h.blockId === 'a'))
  assert.ok(notTag.some((h) => h.blockId === 'c'))

  const either = runQuery({ where: { any: [{ ref: 'c' }, { todo: 'done' }] }, scope: 'all' }, { blocks, atoms })
  assert.deepEqual(either.map((h) => h.blockId), ['b', 'd'])
})

test('runQuery：limit 截断；结果顺序＝森林先序（可复现）', () => {
  const { blocks, atoms } = fixture()
  const hits = runQuery({ where: { tag: 'todo' }, scope: 'all', limit: 2 }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b'])
})

test('refreshSpec：把条件与结果写回块上；丢掉的不再匹配的块要能报出来', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', '查询：带 todo 的', { role: 'query' })
  const spec: QuerySpec = { where: { tag: 'todo' }, scope: 'all' }
  const first = refreshSpec(q, spec, { blocks, atoms })
  assert.equal(first.hits.length, 5)
  assert.deepEqual(first.dropped, [])
  assert.deepEqual(readSpec(q), spec, '条件要写进 _query')

  // 摘掉一个标签后刷新：它应当从结果里消失，并被报成 dropped
  blocks[0]!.children[0]!.text = '甲（标签没了）'
  const second = refreshSpec(q, spec, { blocks, atoms })
  assert.deepEqual(second.dropped, ['a'])
  assert.ok(!second.hits.some((h) => h.blockId === 'a'))
})

test('refreshSpec：subtree 的锚点是查询块所在的容器，不是查询块自己（它是叶子）', () => {
  // 实测踩到：查询块只存条件、不吃结果（A）⇒ 拿它当锚点的话 subtree 里只有它自己，永远 0 条
  const { blocks, atoms } = fixture()
  const q = b('q', '本页的待办', { role: 'query', props: { _query: { where: { todo: 'todo' } } } })
  blocks[0]!.children.push(q)
  const { hits } = refreshSpec(q, { where: { todo: 'todo' } }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'd1'], '只看 p1 这一页里的待办')
})

test('resolveFrozen：内容按 id 现读（冻的是成员，不是文字）', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q', { role: 'query' })
  refreshSpec(q, { where: { tag: 'todo' }, scope: 'all' }, { blocks, atoms })

  // 改文字：冻结结果不变，但**读出来的是新文字**
  blocks[0]!.children[0]!.text = '甲已改名 #todo'
  const rows = resolveFrozen(readResult(q)!, blocks)
  assert.equal(rows.find((r) => r.block.id === 'a')!.block.text, '甲已改名 #todo', '内容不冻（D5）')
  assert.equal(rows.length, 5, '成员与顺序不冻（D4）')
})

test('resolveFrozen：块被删了就不出；祖先也在结果里时只保留祖先', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q', { role: 'query' })
  // d 与 d1 都命中标签吗？d 不含标签 ⇒ 用 text 条件让父子同时命中
  refreshSpec(q, { where: { text: '提到' }, scope: 'all' }, { blocks, atoms })
  const rows = resolveFrozen(readResult(q)!, blocks)
  assert.deepEqual(rows.map((r) => r.block.id), ['d'], '子块由父块的子树渲染，不重复出一条')

  // 删掉结果里的块 ⇒ 该行消失（不是显示成空行）
  const without = blocks.map((p) => ({ ...p, children: p.children.filter((c) => c.id !== 'd') }))
  assert.deepEqual(resolveFrozen(readResult(q)!, without), [])
})

test('canonicalSpec：键序固定 ⇒ 同一条件的不同写法判为「没变」', () => {
  const a: QuerySpec = { where: { all: [{ tag: 'x' }, { todo: 'todo' }] }, scope: 'all' }
  const b2: QuerySpec = { scope: 'all', where: { all: [{ tag: 'x' }, { todo: 'todo' }] } } as QuerySpec
  assert.equal(JSON.stringify(canonicalSpec(a)), JSON.stringify(canonicalSpec(b2)))

  const q = b('q', 'q', { role: 'query' })
  refreshSpec(q, a, fixture())
  assert.equal(specChanged(q, b2), false, '写法不同但语义相同 ⇒ 不该触发重算')
  assert.equal(specChanged(q, { where: { tag: 'y' }, scope: 'all' }), true)
})
