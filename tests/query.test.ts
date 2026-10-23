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
  findJournalDay,
  findTagByName,
  hasTag,
  mkTagBlock,
  normalizeTag,
  tagMemberIds,
  readResult,
  readSpec,
  refreshSpec,
  resolveFrozen,
  runQuery,
  specChanged,
  TASK_STATUS_PROP_ID,
  type QuerySpec,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  text,
  children: [],
  ...extra,
})

/**
 * 任务状态落在**属性槽**里，键是字段定义块的 id。
 * `true` ＝ 做完了，`false` ＝ 是任务、还没做完；缺失 ＝ 不是任务。
 */
const task = (done: boolean): Pick<Block, 'props'> => ({ props: { [TASK_STATUS_PROP_ID]: done } })

/**
 * 甲／乙／丁的子孙／另一个／也 —— 这五块带 `#todo` 标签；丙与「今天的记录」不带。
 *
 * ⚠️ 标签是**块级归属**（`props._tags`），不是正文里的文本、也不占正方位点：
 *    正文里写 `#todo` 只是普通文本，成不了归属。
 *    ⇒ fixture 里块的 text 不带 `#todo`，归属单独写在块上。
 */
function fixture() {
  const todo = mkTagBlock('todo')
  const tagged = new Set(['a', 'b', 'd1', 'e', 'j1b'])
  const forest: Block[] = [
    b('p1', '页面一', {
      props: { _aliases: ['页面一'], _lists: ['page'] },
      children: [
        b('a', '甲', task(false)),
        b('b', '乙', task(true)),
        b('c', '丙没标签'),
        b('d', '提到丙的块', { children: [b('d1', '甲的子孙', task(false))] }),
      ],
    }),
    b('p2', '页面二', { props: { _aliases: ['页面二'], _lists: ['page'] }, children: [b('e', '另一个', task(false))] }),
    // ⚠️ `j1b` 只有标签、**没有**待办状态：`all[tag, todo]` 那条断言靠它来区分「有标签」与「是待办」
    b('j1', '', { props: { _date: '2026-10-20' }, children: [b('j1a', '今天的记录'), b('j1b', '也')] }),
  ]
  for (const root of forest) {
    for (const block of [root, ...root.children, ...root.children.flatMap((c) => c.children)]) {
      if (tagged.has(block.id)) block.props = { ...(block.props ?? {}), _tags: [todo.id] }
    }
  }
  const atoms: Atom[] = [
    {
      id: 'at1',
      kind: 'page',
      blockId: 'd',
      start: 2,
      end: 3,
      label: '丙',
      target: { kind: 'page', id: 'c' },
    } as Atom,
  ]
  return { blocks: [...forest, todo], atoms, todo }
}

test('标签按**归属**判定（不扫文本）：正文里写 #todo 不成标签', () => {
  const { blocks, todo } = fixture()
  const flat = blocks.flatMap(function walk(x: Block): Block[] { return [x, ...x.children.flatMap(walk)] })
  assert.equal(hasTag(flat.find((x) => x.id === 'a')!, todo.id), true)
  assert.equal(hasTag(flat.find((x) => x.id === 'c')!, todo.id), false, '丙没打标签')
  // 正文里那几个字还在（`#todo` 只是普通文本），但不产生归属
  assert.equal(flat.find((x) => x.id === 'c')?.text.includes('标签'), true)
})

test('normalizeTag：大小写与空白只有一处口径', () => {
  assert.equal(normalizeTag('  TODO '), 'todo')
  assert.equal(normalizeTag('设计'), '设计')
})

test('findTagByName / tagMemberIds：标签的成员＝块上的归属', () => {
  const { blocks, todo } = fixture()
  assert.equal(findTagByName(blocks, 'TODO')?.id, todo.id, '按规范化后的名字找')
  assert.deepEqual([...tagMemberIds(todo.id, blocks)].sort(), ['a', 'b', 'd1', 'e', 'j1b'])
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
  assert.ok(findJournalDay(blocks, '2026-10-20'))
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
  const q = b('q', '查询：带 todo 的')
  const spec: QuerySpec = { where: { tag: 'todo' }, scope: 'all' }
  const first = refreshSpec(q, spec, { blocks, atoms })
  assert.equal(first.hits.length, 5)
  assert.deepEqual(first.dropped, [])
  assert.deepEqual(readSpec(q), spec, '条件要写进 _query')

  // 摘掉一个标签后刷新：它应当从结果里消失，并被报成 dropped
  //
  // ⚠️ 标签是**块级归属**，所以「摘掉标签」＝删掉那一块上的 `_tags`
  //    （不是改正文里的字 —— 改字本来就不该改变归属）。
  // ⚠️ 必须从**同一份** fixture 里改块：再调一次 `fixture()` 会造出一个新的标签块（新 id），
  //    于是所有归属都指向一个不在 `blocks` 里的标签 ⇒ 全部被判成 dropped（看着像全丢了）。
  const flat = (list: Block[]): Block[] => list.flatMap(function walk(x) { return [x, ...x.children.flatMap(walk)] })
  delete flat(blocks).find((x) => x.id === 'a')!.props!._tags
  const second = refreshSpec(q, spec, { blocks, atoms })
  assert.deepEqual(second.dropped, ['a'])
  assert.ok(!second.hits.some((h) => h.blockId === 'a'))
})

test('refreshSpec：subtree 的锚点是查询块所在的容器，不是查询块自己（它是叶子）', () => {
  // 实测踩到：查询块只存条件、不吃结果（A）⇒ 拿它当锚点的话 subtree 里只有它自己，永远 0 条
  const { blocks, atoms } = fixture()
  const q = b('q', '本页的待办', { props: { _query: { where: { todo: 'todo' } } } })
  blocks[0]!.children.push(q)
  const { hits } = refreshSpec(q, { where: { todo: 'todo' } }, { blocks, atoms })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'd1'], '只看 p1 这一页里的待办')
})

test('resolveFrozen：内容按 id 现读（冻的是成员，不是文字）', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q')
  refreshSpec(q, { where: { tag: 'todo' }, scope: 'all' }, { blocks, atoms })

  // 改文字：冻结结果不变，但**读出来的是新文字**
  blocks[0]!.children[0]!.text = '甲已改名 #todo'
  const rows = resolveFrozen(readResult(q)!, blocks)
  assert.equal(rows.find((r) => r.block.id === 'a')!.block.text, '甲已改名 #todo', '内容不冻（D5）')
  assert.equal(rows.length, 5, '成员与顺序不冻（D4）')
})

test('resolveFrozen：块被删了就不出；祖先也在结果里时只保留祖先', () => {
  const { blocks, atoms } = fixture()
  const q = b('q', 'q')
  // d 与 d1 都命中标签吗？d 不含标签 ⇒ 用 text 条件让父子同时命中
  refreshSpec(q, { where: { text: '提到' }, scope: 'all' }, { blocks, atoms })
  const rows = resolveFrozen(readResult(q)!, blocks)
  assert.deepEqual(rows.map((r) => r.block.id), ['d'], '子块由父块的子树渲染，不重复出一条')

  // 删掉结果里的块 ⇒ 该行消失（不是显示成空行）
  const without = blocks.map((p) => ({ ...p, children: p.children.filter((c) => c.id !== 'd') }))
  assert.deepEqual(resolveFrozen(readResult(q)!, without), [])
})

test('runQuery：属性条件按 propId 取值、Object.is 比较（未填与 false 分得开）', () => {
  const props = {
    a: { task: true },
    b: { task: false },
    c: {},
  }
  const forest: Block[] = Object.entries(props).map(([id, p]) => b(id, id, { props: p }))
  const atoms: Atom[] = []
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: true } }, scope: 'all' }, { blocks: forest, atoms }).map((h) => h.blockId),
    ['a'],
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: false } }, scope: 'all' }, { blocks: forest, atoms }).map((h) => h.blockId),
    ['b'],
    '属性不存在（c）不许被当成 false',
  )
  // `eq: undefined` 也匹配不到任何块：`c` 根本没有这一槽（不存在 ≠ 等于 undefined）
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: undefined } }, scope: 'all' }, { blocks: forest, atoms }).map((h) => h.blockId),
    [],
  )
})

test('canonicalSpec：属性条件要能存活下来（否则存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = { where: { prop: { id: 'p1', eq: 'x' } }, scope: 'all' }
  assert.deepEqual(canonicalSpec(spec), { where: { prop: { id: 'p1', eq: 'x' } }, scope: 'all' })
  // 嵌套也要带上：属性条件常与标签条件组合
  const nested: QuerySpec = { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } }
  assert.deepEqual(canonicalSpec(nested), { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } })

  const q = b('q', 'q')
  refreshSpec(q, spec, fixture())
  assert.equal(specChanged(q, spec), false, '同一条件刷新后不该自认「变了」')
})

test('canonicalSpec：键序固定 ⇒ 同一条件的不同写法判为「没变」', () => {
  const a: QuerySpec = { where: { all: [{ tag: 'x' }, { todo: 'todo' }] }, scope: 'all' }
  const b2: QuerySpec = { scope: 'all', where: { all: [{ tag: 'x' }, { todo: 'todo' }] } } as QuerySpec
  assert.equal(JSON.stringify(canonicalSpec(a)), JSON.stringify(canonicalSpec(b2)))

  const q = b('q', 'q')
  refreshSpec(q, a, fixture())
  assert.equal(specChanged(q, b2), false, '写法不同但语义相同 ⇒ 不该触发重算')
  assert.equal(specChanged(q, { where: { tag: 'y' }, scope: 'all' }), true)
})
