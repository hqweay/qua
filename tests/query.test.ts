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
  findTagByName,
  hasTagEdge,
  mkTagBlock,
  normalizeTag,
  tagMemberIds,
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

/**
 * 甲／乙／丁的子孙／另一个／也 —— 这五块带 `#todo` 标签；丙与「今天的记录」不带。
 *
 * ⚠️ 标签现在是**边**（`kind: 'tag'` 的原子），不再是正文里的文本：
 *    正文里写 `#todo` 只是普通文本，成不了边 —— 这正是本轮要消灭的「第二套解析」。
 *    ⇒ 所以 fixture 里块的 text 不带 `#todo`，边单独建在 `atoms` 里。
 */
function fixture() {
  const todo = mkTagBlock('todo')
  const forest: Block[] = [
    b('p1', '页面一', {
      roles: ['page'],
      children: [
        b('a', '甲', { todo: 'todo' }),
        b('b', '乙', { todo: 'done' }),
        b('c', '丙没标签'),
        b('d', '提到丙的块', { children: [b('d1', '甲的子孙', { todo: 'todo' })] }),
      ],
    }),
    b('p2', '页面二', { roles: ['page'], children: [b('e', '另一个', { todo: 'todo' })] }),
    // ⚠️ `j1b` 只有标签、**没有**待办状态：`all[tag, todo]` 那条断言靠它来区分「有标签」与「是待办」
    b('j1', '', { roles: ['journal'], props: { _date: '2026-10-20' }, children: [b('j1a', '今天的记录'), b('j1b', '也')] }),
  ]
  const tagged = ['a', 'b', 'd1', 'e', 'j1b']
  const atoms: Atom[] = tagged.map(
    (blockId, i) =>
      ({
        id: `tg${i}`,
        kind: 'tag',
        blockId,
        start: 0,
        end: 1,
        label: 'todo',
        target: { kind: 'page', id: todo.id },
      }) as Atom,
  )
  atoms.push({
    id: 'at1',
    kind: 'page',
    blockId: 'd',
    start: 2,
    end: 3,
    label: '丙',
    target: { kind: 'page', id: 'c' },
  } as Atom)
  return { blocks: [...forest, todo], atoms, todo }
}

test('标签按**边**判定（不再是正则扫文本）：正文里写 #todo 不成边', () => {
  const { blocks, atoms, todo } = fixture()
  assert.equal(hasTagEdge('a', todo.id, atoms), true)
  assert.equal(hasTagEdge('c', todo.id, atoms), false, '丙没打标签')
  // 正文里那几个字还在（`#todo` 现在只是普通文本），但不产生边
  const c = blocks.flatMap(function flat(x) { return [x, ...x.children.flatMap(flat)] }).find((x) => x.id === 'c')
  assert.equal(c?.text.includes('标签'), true)
  assert.equal(hasTagEdge('c', todo.id, atoms), false)
})

test('normalizeTag：大小写与空白只有一处口径', () => {
  assert.equal(normalizeTag('  TODO '), 'todo')
  assert.equal(normalizeTag('设计'), '设计')
})

test('findTagByName / tagMemberIds：标签的成员＝指向它的 tag 边', () => {
  const { blocks, atoms, todo } = fixture()
  assert.equal(findTagByName(blocks, 'TODO')?.id, todo.id, '按规范化后的名字找')
  assert.deepEqual([...tagMemberIds(todo.id, atoms)].sort(), ['a', 'b', 'd1', 'e', 'j1b'])
  assert.equal(findTagByName(blocks, '不存在的标签'), undefined)
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
  const q = b('q', '查询：带 todo 的', { roles: ['query'] })
  const spec: QuerySpec = { where: { tag: 'todo' }, scope: 'all' }
  const first = refreshSpec(q, spec, { blocks, atoms })
  assert.equal(first.hits.length, 5)
  assert.deepEqual(first.dropped, [])
  assert.deepEqual(readSpec(q), spec, '条件要写进 _query')

  // 摘掉一个标签后刷新：它应当从结果里消失，并被报成 dropped
  //
  // ⚠️ 标签现在是**边**，所以「摘掉标签」＝**删掉那条 tag 原子**（不是改正文里的字）。
  //    这正是本轮改动的落点：以前改文本就能让标签"消失"，那是文本与边不一致的根源。
  // ⚠️ 必须从**同一份** fixture 里删边：再调一次 `fixture()` 会造出一个新的标签块（新 id），
  //    于是所有边都指向一个不在 `blocks` 里的标签 ⇒ 全部被判成 dropped（看着像全丢了）。
  const withoutA = atoms.filter((a) => a.blockId !== 'a')
  const second = refreshSpec(q, spec, { blocks, atoms: withoutA })
  assert.deepEqual(second.dropped, ['a'])
  assert.ok(!second.hits.some((h) => h.blockId === 'a'))
})

test('refreshSpec：subtree 的锚点是查询块所在的容器，不是查询块自己（它是叶子）', () => {
  // 实测踩到：查询块只存条件、不吃结果（A）⇒ 拿它当锚点的话 subtree 里只有它自己，永远 0 条
  const { blocks, atoms } = fixture()
  const q = b('q', '本页的待办', { roles: ['query'], props: { _query: { where: { todo: 'todo' } } } })
  blocks[0]!.children.push(q)
  const { hits } = refreshSpec(q, { where: { todo: 'todo' } }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'd1'], '只看 p1 这一页里的待办')
})

test('resolveFrozen：内容按 id 现读（冻的是成员，不是文字）', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q', { roles: ['query'] })
  refreshSpec(q, { where: { tag: 'todo' }, scope: 'all' }, { blocks, atoms })

  // 改文字：冻结结果不变，但**读出来的是新文字**
  blocks[0]!.children[0]!.text = '甲已改名 #todo'
  const rows = resolveFrozen(readResult(q)!, blocks)
  assert.equal(rows.find((r) => r.block.id === 'a')!.block.text, '甲已改名 #todo', '内容不冻（D5）')
  assert.equal(rows.length, 5, '成员与顺序不冻（D4）')
})

test('resolveFrozen：块被删了就不出；祖先也在结果里时只保留祖先', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q', { roles: ['query'] })
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

  const q = b('q', 'q', { roles: ['query'] })
  refreshSpec(q, a, fixture())
  assert.equal(specChanged(q, b2), false, '写法不同但语义相同 ⇒ 不该触发重算')
  assert.equal(specChanged(q, { where: { tag: 'y' }, scope: 'all' }), true)
})
