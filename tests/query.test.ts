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
  OWN_PROPS_PROP,
  tagMemberIds,
  readSpec,
  freezeResult,
  frozenStale,
  droppedFrom,
  resolveFrozen,
  runQuery,
  resolveSelfSpec,
  usesSelf,
  specChanged,
  queryByIndex,
  rebuild,
  BlockStore,
  TASK_STATUS_PROP_ID,
  type QuerySpec,
} from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { plainText, textRuns } from '../src/core/runs.ts'
import { journalDateLabel } from '../src/core/journal.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
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
  // 「提到丙的块」正文里带一枚指向 c 的引用 run（指向边住在源块内容里）
  const d = forest[0]!.children.find((x) => x.id === 'd')!
  d.content.push({ id: 'at1', t: 'ref', to: 'c', label: '丙' })
  return { blocks: [...forest, todo], todo }
}

test('标签按**归属**判定（不扫文本）：正文里写 #todo 不成标签', () => {
  const { blocks, todo } = fixture()
  const flat = blocks.flatMap(function walk(x: Block): Block[] { return [x, ...x.children.flatMap(walk)] })
  assert.equal(hasTag(flat.find((x) => x.id === 'a')!, todo.id), true)
  assert.equal(hasTag(flat.find((x) => x.id === 'c')!, todo.id), false, '丙没打标签')
  // 正文里那几个字还在（`#todo` 只是普通文本），但不产生归属
  assert.equal(plainText(flat.find((x) => x.id === 'c')!.content).includes('标签'), true)
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
  const { blocks } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1', 'e', 'j1b'])
})

test('runQuery：scope 缺省＝subtree —— 只在锚点之下找（含锚点自己）', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks, anchorId: 'p1' })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1'], 'p2 与 journal 不该进来')
})

test('runQuery：scope 缺省（subtree）＋ 锚点不在森林里 ⇒ 退回整片森林（不炸）', () => {
  // 查询块是**游离块**时（例如刚从 seed 里造出来、还没挂进森林）不该静默返回空结果
  const { blocks } = fixture()
  const hits = runQuery({ where: { tag: 'todo' } }, { blocks, anchorId: '不存在' })
  assert.equal(hits.length, 5)
})

test('runQuery：scope=all 时不受锚点限制', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { tag: 'todo' }, scope: 'all' }, { blocks, anchorId: 'p1' })
  assert.equal(hits.length, 5)
})

test('runQuery：ref 条件＝指向边（只认 atom 的 target id）', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { ref: 'c' }, scope: 'all' }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['d'])
})

test('runQuery：**有槽未填**的块按「未完成」命中（与渲染同一个判据）', () => {
  /**
   * 「刚在面板里加上任务状态、还没点过」那一档：槽位在、值不在。
   *
   * 它必须是 `todo` —— 屏幕上画着空心方框（渲染看槽位），查询「未完成」若查不到它，
   * 同一个块就有两种答案。这条与 `props.test.ts` 的 `todoOf` 那条配成一对。
   */
  const fresh: Block = {
    id: 'fresh',
    content: textRuns('刚加上的任务'),
    children: [],
    props: { [OWN_PROPS_PROP]: [TASK_STATUS_PROP_ID], _tags: [] },
  }
  const blocks = [...fixture().blocks, fresh]
  const hits = runQuery({ where: { todo: 'todo' }, scope: 'all' }, { blocks })
  assert.ok(hits.some((h) => h.blockId === 'fresh'), '有槽未填应命中「未完成」')
  assert.ok(!hits.some((h) => h.blockId === 'j1b'), '没有槽的块仍不该命中')
})

test('runQuery：journal 条件取那天的**子块**，不含只读日期行本身', () => {
  const { blocks } = fixture()
  assert.ok(findJournalDay(blocks, '2026-10-20'))
  // ⚠️ 一个 node 只能是一种形态：写成 `{ journal, all: [] }` 会被 `'all' in node` 先命中（恒真）
  const hits = runQuery({ where: { journal: '2026-10-20' }, scope: 'all' }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1a', 'j1b'], '日期行 j1 不该在结果里')
})

test('runQuery：role 成员条件把**天当结果**（不触发「journal 不当结果」的排除规则）', () => {
  const { blocks } = fixture()
  // 排除规则只挂在范围条件（env.journalDate）上：role 命中的恰恰是日期行自己
  const hits = runQuery({ where: { role: 'journal' }, scope: 'all' }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1'])
  // 嵌在组合里的 role 是普通谓词，逐块判定，结果同形
  const inAny = runQuery({ where: { any: [{ role: 'journal' }] }, scope: 'all' }, { blocks })
  assert.deepEqual(inAny.map((h) => h.blockId), ['j1'])
})

test('runQuery：sort 按 spec 排序（先排序后 limit），稳定 ＋ 缺槽最后', () => {
  const mk = (id: string, v?: unknown): Block => ({
    id,
    content: textRuns(id),
    children: [],
    ...(v === undefined ? {} : { props: { k: v } }),
  })
  // b 与 e 同值：稳定排序必须保留森林先序（b 在前）；d 缺槽：排最后（与方向无关）
  const forest = [mk('a', '2026-01-03'), mk('b', '2026-01-01'), mk('c', '2026-01-02'), mk('d'), mk('e', '2026-01-01')]
  const spec = (sort: QuerySpec['sort'], limit?: number): QuerySpec => ({
    where: { text: '' },
    scope: 'all',
    ...(sort ? { sort } : {}),
    ...(limit === undefined ? {} : { limit }),
  })
  const ids = (hits: { blockId: string }[]): string[] => hits.map((h) => h.blockId)
  assert.deepEqual(ids(runQuery(spec([{ by: 'k', dir: 'desc' }]), { blocks: forest })), [
    'a',
    'c',
    'b',
    'e',
    'd',
  ])
  assert.deepEqual(ids(runQuery(spec([{ by: 'k', dir: 'asc' }]), { blocks: forest })), [
    'b',
    'e',
    'c',
    'a',
    'd',
  ])
  // 「取最新的 3 天」＝先按 _date 降序、再 limit —— 截断在排序之后才对
  assert.deepEqual(ids(runQuery(spec([{ by: 'k', dir: 'desc' }], 2), { blocks: forest })), ['a', 'c'])
})

test('canonicalSpec：role 条件与 sort 键要能存活下来（否则存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = {
    where: { role: 'journal' },
    scope: 'all',
    sort: [{ by: '_date', dir: 'desc' }],
    limit: 3,
  }
  assert.deepEqual(canonicalSpec(spec), spec)
  assert.equal(
    JSON.stringify(canonicalSpec(spec)),
    '{"where":{"role":"journal"},"scope":"all","sort":[{"by":"_date","dir":"desc"}],"limit":3}',
    '键序固定（where → scope → sort → limit）',
  )
})

test('runQuery：all / any / not 组合', () => {
  const { blocks } = fixture()
  const todoOnly = runQuery({ where: { all: [{ tag: 'todo' }, { todo: 'todo' }] }, scope: 'all' }, { blocks })
  // ⚠️ `j1b` 只有标签、没有待办状态 ⇒ 不该命中 `all[tag, todo]`
  assert.deepEqual(todoOnly.map((h) => h.blockId), ['a', 'd1', 'e'])

  const notTag = runQuery({ where: { not: { tag: 'todo' } }, scope: 'all' }, { blocks })
  assert.ok(!notTag.some((h) => h.blockId === 'a'))
  assert.ok(notTag.some((h) => h.blockId === 'c'))

  const either = runQuery({ where: { any: [{ ref: 'c' }, { todo: 'done' }] }, scope: 'all' }, { blocks })
  assert.deepEqual(either.map((h) => h.blockId), ['b', 'd'])
})

test('runQuery：limit 截断；结果顺序＝森林先序（可复现）', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { tag: 'todo' }, scope: 'all', limit: 2 }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b'])
})

/**
 * 求值与冻结都经**读门面**（`kb.query` 走索引、`kb.pathOf` 现读）：
 * 测试里用同一份 fixture 造一个门面，调用方形状与生产一致。
 */
function kbOf(blocks: Block[]): { kb: MemoryKb; store: BlockStore } {
  const store = new BlockStore(blocks)
  return { kb: new MemoryKb(store), store }
}

/** 两种求值路径的**等式**：同一份库，纯函数与索引必须给出同一批命中（同一顺序） */
function assertSameHits(spec: QuerySpec, blocks: Block[], opts: { anchorId?: string; selfId?: string } = {}): void {
  const fromForest = runQuery(spec, { blocks, anchorId: opts.anchorId, selfId: opts.selfId })
  const fromIndex = queryByIndex(rebuild(blocks), blocks, spec, opts)
  assert.deepEqual(fromIndex, fromForest)
}

test('索引路径与纯函数路径同解（ref/tag/journal 查表，判定与顺序共用一份）', () => {
  const { blocks } = fixture()
  assertSameHits({ where: { tag: 'todo' } }, blocks)
  assertSameHits({ where: { tag: 'todo' }, scope: 'all' }, blocks, { anchorId: 'p1' })
  assertSameHits({ where: { ref: 'c' }, scope: 'all' }, blocks)
  assertSameHits({ where: { journal: '2026-10-20' }, scope: 'all' }, blocks)
  assertSameHits({ where: { all: [{ tag: 'todo' }, { todo: 'todo' }] }, scope: 'all' }, blocks)
  assertSameHits({ where: { text: '丙' }, scope: 'all' }, blocks)
  assertSameHits({ where: { tag: 'todo' }, scope: 'all', limit: 2 }, blocks)
  // 成员条件（索引路径查日期表收窄候选）＋ 排序轴
  assertSameHits({ where: { role: 'journal' }, scope: 'all' }, blocks)
  assertSameHits({ where: { role: 'journal' }, scope: 'all', sort: [{ by: '_date', dir: 'desc' }] }, blocks)
})

test('freezeResult：求值**不写块**（结果按表面实例冻结，不进库、不进撤销）', () => {
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  const q = b('q', '查询：带 todo 的')
  const spec: QuerySpec = { where: { tag: 'todo' }, scope: 'all' }
  const frozen = freezeResult(spec, kb, {})
  assert.equal(frozen.hits.length, 5)
  assert.equal(readSpec(q), null, '冻结一个结果不该写条件（条件由构建器写）')
  assert.equal(Object.keys(q.props ?? {}).length, 0, '块上一个字节都没多出来')

  // 摘掉一个标签后重算：它应当从结果里消失，并被报成 dropped
  //
  // ⚠️ 标签是**块级归属**，所以「摘掉标签」＝删掉那一块上的 `_tags`
  //    （不是改正文里的字 —— 改字本来就不该改变归属）。
  // 走真实写路径（事务）：索引随 op 修补 —— 不直写、也不显式作废索引。
  const flat = (list: Block[]): Block[] => list.flatMap(function walk(x) { return [x, ...x.children.flatMap(walk)] })
  const member = flat(blocks).find((x) => x.id === 'a')!
  kb.tx((tx) => tx.setTags(member.id, []))
  const after = freezeResult(spec, kb, {})
  assert.deepEqual(droppedFrom(frozen.hits, after.hits), ['a'], '那一条要能被报出来')
  assert.ok(!after.hits.some((h) => h.blockId === 'a'))
})

test('冻结的判据：条件变了／上下文变了就要重算（不会出现「旧条件 ＋ 新结果」）', () => {
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  const a: QuerySpec = { where: { tag: 'todo' }, scope: 'all' }
  const frozen = freezeResult(a, kb, {})
  assert.equal(frozenStale(frozen, a, {}), false, '同样的条件与上下文 ⇒ 不重算')
  const b2: QuerySpec = { where: { tag: 'todo' }, scope: 'all', limit: 2 }
  assert.equal(frozenStale(frozen, b2, {}), true, '条件变了 ⇒ 重算')
  assert.equal(frozenStale(frozen, a, { excludeIds: ['a'] }), true, '上下文（剔除谁）变了 ⇒ 重算')
  assert.equal(frozenStale(null, a, {}), true, '还没有冻结过 ⇒ 算一次')
})

test('求值的上下文：`scopeId` 是锚点，缺省＝整片森林（不靠 selfId 顺带）', () => {
  // 实测踩到：查询块只存条件、不吃结果（A）⇒ 拿它当锚点的话 subtree 里只有它自己，永远 0 条
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  const hits = freezeResult({ where: { todo: 'todo' } }, kb, { scopeId: 'p1' }).hits
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'd1'], '只看 p1 这一页里的待办')
  const all = freezeResult({ where: { todo: 'todo' }, scope: 'all' }, kb, { scopeId: 'p1' }).hits
  assert.ok(all.length > hits.length, '`scope:"all"` 时不收窄')
})

test('resolveFrozen：内容按 id 现读（冻的是成员，不是文字）', () => {
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  const frozen = freezeResult({ where: { tag: 'todo' }, scope: 'all' }, kb, {})

  // 改文字：冻结结果不变，但**读出来的是新文字**
  blocks[0]!.children[0]!.text = '甲已改名 #todo'
  const rows = resolveFrozen(frozen.hits, (id) => kb.pathOf(id))
  assert.equal(rows.find((r) => r.block.id === 'a')!.block.text, '甲已改名 #todo', '内容不冻（D5）')
  assert.equal(rows.length, 5, '成员与顺序不冻（D4）')
})

test('resolveFrozen：块被删了就不出；祖先也在结果里时只保留祖先', () => {
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  // d 与 d1 都命中文本条件 ⇒ 父子同时命中
  const frozen = freezeResult({ where: { text: '提到' }, scope: 'all' }, kb, {})
  const rows = resolveFrozen(frozen.hits, (id) => kb.pathOf(id))
  assert.deepEqual(rows.map((r) => r.block.id), ['d'], '子块由父块的子树渲染，不重复出一条')

  // 删掉结果里的块 ⇒ 该行消失（pathOf 解析不到 ⇒ 空数组 ⇒ 这一行不出）
  const without = blocks.map((p) => ({ ...p, children: p.children.filter((c) => c.id !== 'd') }))
  const { kb: kb2 } = kbOf(without)
  assert.deepEqual(resolveFrozen(frozen.hits, (id) => kb2.pathOf(id)), [])
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
    runQuery({ where: { prop: { id: 'task', eq: true } }, scope: 'all' }, { blocks: forest }).map((h) => h.blockId),
    ['a'],
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: false } }, scope: 'all' }, { blocks: forest }).map((h) => h.blockId),
    ['b'],
    '属性不存在（c）不许被当成 false',
  )
  // `eq: undefined` 也匹配不到任何块：`c` 根本没有这一槽（不存在 ≠ 等于 undefined）
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: undefined } }, scope: 'all' }, { blocks: forest }).map((h) => h.blockId),
    [],
  )
})

test('canonicalSpec：属性条件要能存活下来（否则存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = { where: { prop: { id: 'p1', eq: 'x' } }, scope: 'all' }
  assert.deepEqual(canonicalSpec(spec), { where: { prop: { id: 'p1', eq: 'x' } }, scope: 'all' })
  // 嵌套也要带上：属性条件常与标签条件组合
  const nested: QuerySpec = { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } }
  assert.deepEqual(canonicalSpec(nested), { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } })

  // `specChanged` 只在块**已经有条件**时才有意义（条件由构建器写，冻结不写）
  const q = b('q', 'q', { props: { _query: canonicalSpec(spec) } })
  assert.equal(specChanged(q, spec), false, '同一条件（canonical 之后）不该自认「变了」')
  assert.equal(specChanged(b('bare', '没有条件'), spec), true, '还没有条件 ⇒ 算变了')
})

test('canonicalSpec：键序固定 ⇒ 同一条件的不同写法判为「没变」', () => {
  const a: QuerySpec = { where: { all: [{ tag: 'x' }, { todo: 'todo' }] }, scope: 'all' }
  const b2: QuerySpec = { scope: 'all', where: { all: [{ tag: 'x' }, { todo: 'todo' }] } } as QuerySpec
  assert.equal(JSON.stringify(canonicalSpec(a)), JSON.stringify(canonicalSpec(b2)))

  const q = b('q', 'q', { props: { _query: canonicalSpec(a) } })
  assert.equal(specChanged(q, b2), false, '写法不同但语义相同 ⇒ 不该触发重算')
  assert.equal(specChanged(q, { where: { tag: 'y' }, scope: 'all' }), true)
})

/* ------------------------------------------------- 属性条件是通用路径 */

test('属性条件问得到身份位：类型／日期／定义种类都是 props 里的槽', () => {
  const divider: Block = b('v', '', { props: { _type: 'core/divider' } })
  const day: Block = b('j', '', { props: { _date: '2026-10-20' } })
  const def: Block = b('d', '截止日', { props: { _kind: 'date' } })
  const plain = b('p', '普通一行')
  const blocks = [divider, day, def, plain]

  assert.deepEqual(
    runQuery({ where: { prop: { id: '_type', eq: 'core/divider' } } }, { blocks }).map((h) => h.blockId),
    ['v'],
    '类型不需要专用条件键：它就是 `_type` 这一槽',
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: '_date', eq: '2026-10-20' } } }, { blocks }).map((h) => h.blockId),
    ['j'],
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: '_kind', eq: 'date' } } }, { blocks }).map((h) => h.blockId),
    ['d'],
  )
  assert.deepEqual(runQuery({ where: { prop: { id: '_kind', exists: true } } }, { blocks }).map((h) => h.blockId), ['d'])
})

test('exists：问「有没有这一槽」，与 eq 是两件事；同时给时按 exists（不猜）', () => {
  const filled = b('a', '填了 false', task(false))
  const empty = b('b', '没这一槽')
  const blocks = [filled, empty]

  assert.deepEqual(runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, exists: true } } }, { blocks }).map((h) => h.blockId), ['a'])
  assert.deepEqual(runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, exists: false } } }, { blocks }).map((h) => h.blockId), ['b'])
  // `eq: undefined` 不等于「没有这一槽」：先问有没有，再比值
  assert.deepEqual(runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: undefined } } }, { blocks }), [])
  // 两种形态互斥；同时写按 exists 判（形状写歪时给出可预期的一种答案，而不是靠键序）
  const both = { prop: { id: TASK_STATUS_PROP_ID, exists: false, eq: false } } as unknown as QuerySpec['where']
  assert.deepEqual(runQuery({ where: both }, { blocks }).map((h) => h.blockId), ['b'])
})

test('`{todo}` 不是 `{prop}` 的语法糖：三态里「有槽未填」只有它命中', () => {
  /**
   * 空心方框（槽位在、值没填）在屏幕上是「待办 · 没做完」，所以它必须被「未完成」查到。
   * 这条同时是**不删 `{todo}`** 的理由：
   *   · `{prop:{eq:false}}` 只命中「点了但没做」的那种（漏掉空方框）；
   *   · `{prop:{exists:false}}` 把「不是任务」与「空方框」混成一个。
   * 两个条件的组合也拼不出来（「声明过但没值」不是属性值能表达的）。
   */
  const untouched = b('u', '空方框', { props: { [OWN_PROPS_PROP]: [TASK_STATUS_PROP_ID] } })
  const falseVal = b('f', '点了没做', task(false))
  const done = b('d', '做完了', task(true))
  const blocks = [untouched, falseVal, done]

  assert.deepEqual(runQuery({ where: { todo: 'todo' }, scope: 'all' }, { blocks }).map((h) => h.blockId), ['u', 'f'])
  assert.deepEqual(
    runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } }, scope: 'all' }, { blocks }).map((h) => h.blockId),
    ['f'],
    '属性条件漏掉空方框 —— 这就是 `{todo}` 存在的理由',
  )
  assert.deepEqual(runQuery({ where: { todo: 'done' }, scope: 'all' }, { blocks }).map((h) => h.blockId), ['d'])
  assert.deepEqual(runQuery({ where: { todo: 'none' }, scope: 'all' }, { blocks }).map((h) => h.blockId), [])
})

test('canonicalSpec：`exists` 要能存活下来（漏了这一支 = 存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = { where: { prop: { id: '_kind', exists: true } } }
  assert.deepEqual(canonicalSpec(spec), spec)
  assert.equal(JSON.stringify(canonicalSpec(spec)), '{"where":{"prop":{"id":"_kind","exists":true}}}')
  // 两种形态原样带走：不补默认值（补了 `eq` 与 `exists` 的两种写法就不再等价）
  const eqSpec: QuerySpec = { where: { prop: { id: '_kind', eq: 'date' } } }
  assert.equal(JSON.stringify(canonicalSpec(eqSpec)), '{"where":{"prop":{"id":"_kind","eq":"date"}}}')
})

/* ------------------------------------------------------------ `$self`（相对条件） */

/**
 * 一份带「宿主侧面」的森林：一天的日记（`_date`）＋ 两个带同标签的块 ＋ 一个引用那天的块
 * ＋ 一个正文里写 `#<日期名>` 的块（行内标签是**露面**，不是指向边）。
 *
 * 这几块的差别正是「提及」要分清的三种东西：指向我（算）、同标签（另算）、
 * 正文里写着同一个字符串（`{text}` 算，但 `#名` 那种露面不算指向）。
 */
function selfFixture() {
  const tag = mkTagBlock('项目')
  const j = b('j1', '', {
    props: { _date: '2026-10-26' },
    children: [b('j1a', '今天的记录'), b('j1b', '今天的第二行')],
  })
  const host = b('h', '宿主块', { props: { _tags: [tag.id] } })
  const same = b('s1', '同标签的另一块', { props: { _tags: [tag.id] } })
  // 指向日记块：正文里一枚 flavor 缺省的引用 run
  const pointing = b('r1', '引用那一天')
  pointing.content.push({ id: 'r1a', t: 'ref', to: 'j1', label: '那天' })
  // 正文里写一个 `#` 行内标签，指的那天和宿主同一天：它是露面（flavor '#'），**不是**指向边
  const inline = b('r2', '写在正文里的 ')
  inline.content.push({ id: 'r2a', t: 'ref', to: 'j1', label: journalDateLabel('2026-10-26'), flavor: '#' })
  // 正文里**真的写着**宿主的可读文本（`{text}` 吃的是文本段，不是原子标签）
  const literal = b('r3', `今天记了一笔：${journalDateLabel('2026-10-26')}`)
  return { blocks: [j, host, same, pointing, inline, literal, tag], host, j, same, pointing, inline, literal }
}

test('U3 同一个带 $self 的 spec：纯路径与索引路径结果相等', () => {
  const { blocks, host, j } = selfFixture()
  assertSameHits({ where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] }, scope: 'all' }, blocks, {
    selfId: j.id,
  })
  assertSameHits({ where: { tag: '$self' }, scope: 'all' }, blocks, { selfId: host.id })
  assertSameHits({ where: { journal: '$self' }, scope: 'all' }, blocks, { selfId: j.id })
  assertSameHits({ where: { ref: '$self' }, scope: 'all' }, blocks, { selfId: j.id })
})

test('U4 selfId 缺省 ＋ spec 含 $self ⇒ 空结果（不退回全库）', () => {
  const { blocks } = selfFixture()
  // 若「解析不了」退化成「条件被忽略」，这里会返回整库
  assert.deepEqual(runQuery({ where: { ref: '$self' }, scope: 'all' }, { blocks }), [])
  assert.deepEqual(runQuery({ where: { text: '$self' }, scope: 'all' }, { blocks }), [])
  assert.deepEqual(runQuery({ where: { journal: '$self' }, scope: 'all' }, { blocks }), [])
  // 不含 `$self` 的条件不受影响：没有宿主也照常求值
  assert.equal(runQuery({ where: { tag: '项目' }, scope: 'all' }, { blocks }).length, 2)
})

test('U5 {tag:$self} 命中同标签的块；「不含宿主自己」是 `excludeIds` 的事', () => {
  const { blocks, host, same } = selfFixture()
  const spec: QuerySpec = { where: { tag: '$self' }, scope: 'all' }
  const hits = runQuery(spec, { blocks, selfId: host.id, excludeIds: [host.id] })
  assert.deepEqual(hits.map((h) => h.blockId), [same.id], '同类含宿主就只是噪声：它是位置的性质')
  // 只解析 `$self`、不剔除 ⇒ 宿主也在（两件独立的事，各由自己的参数说）
  assert.deepEqual(
    runQuery(spec, { blocks, selfId: host.id }).map((h) => h.blockId),
    [host.id, same.id],
  )
})

test('U6 {journal:$self} 等价于写死那一天的日期', () => {
  const { blocks, j } = selfFixture()
  const viaSelf = runQuery({ where: { journal: '$self' }, scope: 'all' }, { blocks, selfId: j.id })
  const literal = runQuery({ where: { journal: '2026-10-26' }, scope: 'all' }, { blocks })
  assert.deepEqual(viaSelf, literal)
  assert.deepEqual(viaSelf.map((h) => h.blockId), ['j1a', 'j1b'])
})

/**
 * 提及 ＝「正文里有我这串字」且「没有指向我的边」。
 *
 * 边界有两条，都钉在这儿：
 *   ① **行内 `#名` 是露面，不是指向边**（`flavor:'#'` 不进 `incoming`）⇒ `not {ref}` 不排除它；
 *   ② `{text}` 吃的是**文本段**，原子（引用／`#名`）上的 label 不进 `plainText` ⇒
 *      只有「真的把这串字写在正文里」的块才算提及。
 * 于是两栏不重叠：引用我的块在「引用」里，写着我的名字的块在「提及」里。
 */
test('U6b 提及的边界：`#名` 是露面不是边（不被 not-ref 排除）；真引用我的块不算提及', () => {
  const { blocks, j, pointing, inline, literal } = selfFixture()
  // ① 只否指向边：行内 `#` 的那块还在，真引用我的那块被排除
  const notRef = runQuery({ where: { not: { ref: '$self' } }, scope: 'all' }, { blocks, selfId: j.id }).map((h) => h.blockId)
  assert.equal(notRef.includes(inline.id), true, '行内 `#名` 不产生指向边 ⇒ 不被 not-ref 排除')
  assert.equal(notRef.includes(pointing.id), false, '真引用我的块被排除（它在引用那一栏）')

  // ② 提及＝文本里有 ＋ 没指向我
  const mentions = { where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] }, scope: 'all' as const }
  const hits = runQuery(mentions, { blocks, selfId: j.id })
  assert.deepEqual(hits.map((h) => h.blockId), [literal.id])
  assert.equal(hits.map((h) => h.blockId).includes(inline.id), false, '`#名` 的 label 不在文本段里，不构成文本提及')
})
test('U6c 宿主的可读文本为空 ⇒ 提及是空集（空串不能当值去比）', () => {
  const { blocks } = selfFixture()
  const bare = b('bare', '   ')
  const withBare = [...blocks, bare]
  assert.deepEqual(runQuery({ where: { text: '$self' }, scope: 'all' }, { blocks: withBare, selfId: bare.id }), [])
})

test('U6d 宿主没有日期 ⇒ {journal:$self} 是空集（不是「全部日记」）', () => {
  const { blocks, host } = selfFixture()
  assert.deepEqual(runQuery({ where: { journal: '$self' }, scope: 'all' }, { blocks, selfId: host.id }), [])
})

test('resolveSelfSpec：不改入参，且嵌套组合里的 $self 也解析', () => {
  const { blocks, host } = selfFixture()
  const spec: QuerySpec = { where: { all: [{ any: [{ tag: '$self' }, { ref: '$self' }] }, { not: { text: '无' } }] } }
  const before = JSON.stringify(spec)
  const out = resolveSelfSpec(spec, host, blocks)
  assert.equal(JSON.stringify(spec), before, '解析是纯函数：原 spec 一个字节不动')
  assert.equal(usesSelf(out.where), false)
})

test('宿主自己不进结果：靠 `excludeIds`，**不靠** `selfId` 顺带（两件事分开了）', () => {
  const { blocks, host, same } = selfFixture()
  const spec: QuerySpec = { where: { tag: '项目' }, scope: 'all' }
  // 「带项目标签的块」按条件本该含宿主；挂载区的位置性质把它剔掉
  assert.deepEqual(runQuery(spec, { blocks, excludeIds: [host.id] }).map((h) => h.blockId), ['s1'])
  // ⚠️ 只给 selfId 时**不再**顺带剔除：`$self` 的解析与「结果剔除谁」是两条独立规则
  assert.deepEqual(runQuery(spec, { blocks, selfId: host.id }).map((h) => h.blockId), [host.id, same.id])
})
