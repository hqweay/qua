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
  contextKey,
  dayStartMs,
  shiftISO,
  findJournalDay,
  findTagByName,
  declareField,
  hasTag,
  mkPropDef,
  mkTagBlock,
  normalizeTag,
  OWN_PROPS_PROP,
  tagMemberIds,
  readSpec,
  freezeResult,
  frozenStale,
  droppedFrom,
  resolveFrozen,
  resolveRows,
  runQuery,
  resolveSelfSpec,
  resolveTodayBase,
  usesSelf,
  usesRef,
  isQueryNode,
  isQuerySpec,
  specChanged,
  queryByIndex,
  rebuild,
  BlockStore,
  ENGINE_CREATED,
  ENGINE_MODIFIED,
  TASK_STATUS_PROP_ID,
  type QueryNode,
  type QuerySpec,
} from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { journalDateLabel } from '../src/core/identity/journal.ts'

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
  // 待办状态是属性条件 ⇒ 定义块必须在库里（`{prop}` 只认定义块 id 与系统槽白名单）
  const def = mkPropDef('任务状态', 'checkbox', {}, TASK_STATUS_PROP_ID)
  return { blocks: [...forest, todo, def], todo, def }
}

/**
 * 「在某一天下面」：某个祖先既是日记块、日期又等于那一天。
 *
 * 方向（`up`）与条件（`all[role, prop]`）是正交两轴 ⇒ 它可以进 `any`／`not`，
 * 也不改变候选集；天自己不会入选（自己的祖先链里没有自己）。
 */
function dayPath(date: string): QueryNode {
  return { up: { all: [{ role: 'journal' }, { prop: { id: '_date', eq: date } }] } }
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
  const { blocks, todo } = fixture()
  const hits = runQuery({ where: { tag: todo.id } }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1', 'e', 'j1b'])
})

test('runQuery：`{up:{is:$self}}` ＝「这一块之下」（原 scope:subtree 的条件形状）', () => {
  const { blocks, todo } = fixture()
  const hits = runQuery({ where: { all: [{ up: { is: 'p1' } }, { tag: todo.id }] } }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'b', 'd1'], 'p2 与 journal 不该进来')
})

test('runQuery：范围不再是轴——没有方向条件就是整片森林', () => {
  const { blocks, todo } = fixture()
  const hits = runQuery({ where: { tag: todo.id } }, { blocks })
  assert.equal(hits.length, 5)
})

test('runQuery：ref 条件＝指向边（只认 atom 的 target id）', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { ref: 'c' } }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['d'])
})

test('ref 条件按**当前节点的目标**判定：同一份条件里两个目标不串味', () => {
  /**
   * 从前 `QueryEnv.refs` 是整份 `where` 里所有 `{ref}` 目标的**来源并集**：
   * 判定只读那个并集、不看当前节点 ⇒ `{all:[{ref:X},{not:{ref:Y}}]}` 会拿
   * 「引用 X **或** Y 的块」当「引用 X 的块」，结果静默变空。
   */
  const p = b('p', '引用 X')
  p.content.push({ id: 'p1', t: 'ref', to: 'X', label: 'X' })
  const q = b('q', '引用 Y')
  q.content.push({ id: 'q1', t: 'ref', to: 'Y', label: 'Y' })
  const g = b('g', '两者都引用')
  g.content.push({ id: 'g1', t: 'ref', to: 'X', label: 'X' }, { id: 'g2', t: 'ref', to: 'Y', label: 'Y' })
  const blocks = [p, q, g]
  const ids = (where: QueryNode) => runQuery({ where }, { blocks }).map((h) => h.blockId)

  assert.deepEqual(ids({ all: [{ ref: 'X' }, { not: { ref: 'Y' } }] }), ['p'], '引用 X 且不引用 Y')
  assert.deepEqual(ids({ all: [{ ref: 'Y' }, { not: { ref: 'X' } }] }), ['q'], '反过来也对称')
  assert.deepEqual(ids({ any: [{ ref: 'X' }, { ref: 'Y' }] }), ['p', 'q', 'g'], '并集照旧')
  assert.deepEqual(ids({ not: { ref: 'Y' } }), ['p'], '否定只看 Y')
  // 两条求值路径同解（串味的病只在语义层；索引路径共用同一份判定）
  assertSameHits({ where: { all: [{ ref: 'X' }, { not: { ref: 'Y' } }] } }, blocks)
  // 没有 ref 条件 ⇒ 不建表（按需建的口径不变）
  assert.equal(usesRef({ tag: '任意id' }), false)
  assert.equal(usesRef({ up: { ref: 'X' } }), true)
})

test('runQuery：**有槽未填**的块按「未完成」命中（与渲染同一个判据）', () => {
  /**
   * 「刚在面板里加上任务状态、还没点过」那一档：槽位在、值不在。
   *
   * 它必须是「未完成」—— 屏幕上画着空心方框（渲染看的是「有没有这一栏」），
   * 查询若查不到它，同一个块就有两种答案。判据只有一处：`core/props.ts` 的 `readField`
   * （布尔属性声明了就等于 `false`）。这条与 `tests/props.test.ts` 的 `todoOf` 那条配成一对。
   */
  const fresh: Block = {
    id: 'fresh',
    content: textRuns('刚加上的任务'),
    children: [],
    props: { [OWN_PROPS_PROP]: [TASK_STATUS_PROP_ID], _tags: [] },
  }
  // 判 kind 要有定义块：没有它「任务状态」只是一个悬空的槽位（渲染也不画方框）
  const def = mkPropDef('任务状态', 'checkbox', {}, TASK_STATUS_PROP_ID)
  const blocks = [def, ...fixture().blocks, fresh]
  const hits = runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } } }, { blocks })
  assert.ok(hits.some((h) => h.blockId === 'fresh'), '有槽未填应命中「未完成」')
  assert.ok(!hits.some((h) => h.blockId === 'j1b'), '没有这一栏的块仍不该命中')
})

test('runQuery：路径条件（up）取那天的**子块**，不含只读日期行本身', () => {
  const { blocks } = fixture()
  assert.ok(findJournalDay(blocks, '2026-10-20'))
  // 「在某一天下面」是纯谓词：某个祖先既是日记块、日期又等于那一天
  const hits = runQuery({ where: dayPath('2026-10-20') }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1a', 'j1b'], '日期行 j1 不该在结果里')
})

test('runQuery：role 成员条件把**天当结果**（不触发「journal 不当结果」的排除规则）', () => {
  const { blocks } = fixture()
  // 排除规则只挂在范围条件（env.journalDate）上：role 命中的恰恰是日期行自己
  const hits = runQuery({ where: { role: 'journal' } }, { blocks })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1'])
  // 嵌在组合里的 role 是普通谓词，逐块判定，结果同形
  const inAny = runQuery({ where: { any: [{ role: 'journal' }] } }, { blocks })
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
    sort: [{ by: '_date', dir: 'desc' }],
    limit: 3,
  }
  assert.deepEqual(canonicalSpec(spec), spec)
  assert.equal(
    JSON.stringify(canonicalSpec(spec)),
    '{"where":{"role":"journal"},"sort":[{"by":"_date","dir":"desc"}],"limit":3}',
    '键序固定（where → sort → limit）',
  )
})

test('runQuery：all / any / not 组合', () => {
  const { blocks, todo } = fixture()
  const openTask = { prop: { id: TASK_STATUS_PROP_ID, eq: false } } as const
  const todoOnly = runQuery({ where: { all: [{ tag: todo.id }, openTask] } }, { blocks })
  // ⚠️ `j1b` 只有标签、**这一栏也没人声明** ⇒ 不该命中 `all[tag, 未完成]`
  assert.deepEqual(todoOnly.map((h) => h.blockId), ['a', 'd1', 'e'])

  const notTag = runQuery({ where: { not: { tag: todo.id } } }, { blocks })
  assert.ok(!notTag.some((h) => h.blockId === 'a'))
  assert.ok(notTag.some((h) => h.blockId === 'c'))

  const either = runQuery(
    { where: { any: [{ ref: 'c' }, { prop: { id: TASK_STATUS_PROP_ID, eq: true } }] } },
    { blocks },
  )
  assert.deepEqual(either.map((h) => h.blockId), ['b', 'd'])
})

test('runQuery：limit 截断；结果顺序＝森林先序（可复现）', () => {
  const { blocks, todo } = fixture()
  const hits = runQuery({ where: { tag: todo.id }, limit: 2 }, { blocks })
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
  const { blocks, todo } = fixture()
  assertSameHits({ where: { tag: todo.id } }, blocks)
  assertSameHits({ where: { tag: todo.id } }, blocks, { anchorId: 'p1' })
  assertSameHits({ where: { ref: 'c' } }, blocks)
  assertSameHits({ where: dayPath('2026-10-20') }, blocks)
  assertSameHits({ where: { all: [{ tag: todo.id }, { prop: { id: TASK_STATUS_PROP_ID, eq: false } }] } }, blocks)
  assertSameHits({ where: { text: '丙' } }, blocks)
  assertSameHits({ where: { tag: todo.id }, limit: 2 }, blocks)
  // 成员条件（索引路径查日期表收窄候选）＋ 排序轴
  assertSameHits({ where: { role: 'journal' } }, blocks)
  assertSameHits({ where: { role: 'journal' }, sort: [{ by: '_date', dir: 'desc' }] }, blocks)
})

test('freezeResult：求值**不写块**（结果按表面实例冻结，不进库、不进撤销）', () => {
  const { blocks, todo } = fixture()
  const { kb } = kbOf(blocks)
  const q = b('q', '查询：带 todo 的')
  const spec: QuerySpec = { where: { tag: todo.id } }
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
  const { blocks, todo } = fixture()
  const { kb } = kbOf(blocks)
  const a: QuerySpec = { where: { tag: todo.id } }
  const frozen = freezeResult(a, kb, {})
  assert.equal(frozenStale(frozen, a, {}), false, '同样的条件与上下文 ⇒ 不重算')
  const b2: QuerySpec = { where: { tag: todo.id }, limit: 2 }
  assert.equal(frozenStale(frozen, b2, {}), true, '条件变了 ⇒ 重算')
  assert.equal(frozenStale(frozen, a, { excludeIds: ['a'] }), true, '上下文（剔除谁）变了 ⇒ 重算')
  assert.equal(frozenStale(null, a, {}), true, '还没有冻结过 ⇒ 算一次')
  // 切片住在视图上：条件串一模一样，换了一张视图也必须重算
  assert.equal(frozenStale(frozen, a, {}, ''), false, '默认看法与冻结时同一视图位')
  assert.equal(frozenStale(frozen, a, {}, 'v2'), true, '换视图 ⇒ 重算（哪怕条件串相同）')
  assert.equal(freezeResult(a, kb, {}, 'v1').viewKey, 'v1', '冻结结果记着自己属于哪张视图')
})

test('求值的上下文：范围住在条件里（`{up:{is}}`），上下文只管 `$self` 指谁', () => {
  // 实测踩到：查询块只存条件、不吃结果（A）⇒ 拿它当锚点的话 subtree 里只有它自己，永远 0 条
  const { blocks } = fixture()
  const { kb } = kbOf(blocks)
  const hits = freezeResult(
    { where: { all: [{ up: { is: '$self' } }, { prop: { id: TASK_STATUS_PROP_ID, eq: false } }] } },
    kb,
    { selfId: 'p1' },
  ).hits
  assert.deepEqual(hits.map((h) => h.blockId), ['a', 'd1'], '只看 p1 这一页里的待办')
  const all = freezeResult({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } } }, kb, { selfId: 'p1' }).hits
  assert.ok(all.length > hits.length, '没有方向条件时是全库')
})

test('resolveFrozen：内容按 id 现读（冻的是成员，不是文字）', () => {
  const { blocks, todo } = fixture()
  const { kb } = kbOf(blocks)
  const frozen = freezeResult({ where: { tag: todo.id } }, kb, {})

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
  const frozen = freezeResult({ where: { text: '提到' } }, kb, {})
  const rows = resolveFrozen(frozen.hits, (id) => kb.pathOf(id))
  assert.deepEqual(rows.map((r) => r.block.id), ['d'], '子块由父块的子树渲染，不重复出一条')

  // 删掉结果里的块 ⇒ 该行消失（pathOf 解析不到 ⇒ 空数组 ⇒ 这一行不出）
  const without = blocks.map((p) => ({ ...p, children: p.children.filter((c) => c.id !== 'd') }))
  const { kb: kb2 } = kbOf(without)
  assert.deepEqual(resolveFrozen(frozen.hits, (id) => kb2.pathOf(id)), [])
})

test('结果基数：父子同时命中时 hits=2、大纲折叠成 1、记录视图仍是 2（抬头主数字用 hits）', () => {
  const parent = b('p', '共同词', { children: [b('c', '共同词')] })
  const { kb } = kbOf([parent])
  const frozen = freezeResult({ where: { text: '共同词' } }, kb, {})

  assert.equal(frozen.hits.length, 2, '命中是两条（父与子各一条）')
  assert.equal(resolveFrozen(frozen.hits, (id) => kb.pathOf(id)).length, 1, '大纲只画顶层（同一块不该出现两遍）')
  assert.equal(resolveRows(frozen.hits, kb).length, 2, '记录视图每条命中一行')

  /**
   * 抬头的主数字必须与**冻结结果**同源：大纲里写 1、表格里写 2 的话，
   * 同一个查询在同一块上会显示两个数。折叠程度另给一句次要文案。
   */
  const topLevel = resolveFrozen(frozen.hits, (id) => kb.pathOf(id)).length
  assert.notEqual(topLevel, frozen.hits.length, '这一例必须真的折叠（否则断言没有验到东西）')
})

test('runQuery：属性条件按 propId 取值、Object.is 比较（未填与 false 分得开）', () => {
  // 属性条件只认定义块 id（见下面的「守卫」用例）⇒ fixture 得先把定义放进去
  const def = mkPropDef('任务', 'checkbox', {}, 'task')
  const props = {
    a: { task: true },
    b: { task: false },
    c: {},
  }
  const forest: Block[] = [def, ...Object.entries(props).map(([id, p]) => b(id, id, { props: p }))]
  const atoms: Atom[] = []
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: true } } }, { blocks: forest }).map((h) => h.blockId),
    ['a'],
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: false } } }, { blocks: forest }).map((h) => h.blockId),
    ['b'],
    '属性不存在（c）不许被当成 false',
  )
  // `eq: undefined` 也匹配不到任何块：`c` 根本没有这一槽（不存在 ≠ 等于 undefined）
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'task', eq: undefined } } }, { blocks: forest }).map((h) => h.blockId),
    [],
  )
})

test('canonicalSpec：属性条件要能存活下来（否则存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = { where: { prop: { id: 'p1', eq: 'x' } } }
  assert.deepEqual(canonicalSpec(spec), { where: { prop: { id: 'p1', eq: 'x' } } })
  // 嵌套也要带上：属性条件常与标签条件组合
  const nested: QuerySpec = { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } }
  assert.deepEqual(canonicalSpec(nested), { where: { all: [{ tag: '任务' }, { not: { prop: { id: 'p1', eq: true } } }] } })

  // `specChanged` 只在块**已经有条件**时才有意义（条件由构建器写，冻结不写）
  const q = b('q', 'q', { props: { _query: canonicalSpec(spec) } })
  assert.equal(specChanged(q, spec), false, '同一条件（canonical 之后）不该自认「变了」')
  assert.equal(specChanged(b('bare', '没有条件'), spec), true, '还没有条件 ⇒ 算变了')
})

test('canonicalSpec：键序固定 ⇒ 同一条件的不同写法判为「没变」', () => {
  const a: QuerySpec = { where: { all: [{ tag: 'x' }, { prop: { id: 'p1', eq: false } }] } }
  const b2: QuerySpec = {
    where: { all: [{ tag: 'x' }, { prop: { id: 'p1', eq: false } }] },
  } as QuerySpec
  assert.equal(JSON.stringify(canonicalSpec(a)), JSON.stringify(canonicalSpec(b2)))

  const q = b('q', 'q', { props: { _query: canonicalSpec(a) } })
  assert.equal(specChanged(q, b2), false, '写法不同但语义相同 ⇒ 不该触发重算')
  assert.equal(specChanged(q, { where: { tag: 'y' } }), true)
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

test('系统槽条件逐项问模型判据：`_date` 空串不算日记、`_tags` 只认活着的标签、引擎属性读块字段', () => {
  /**
   * 这一条钉的是「同一个问题只能有一个答案」：从前 `{prop}` 的 `exists` 判
   * **`props` 里有没有这个键**，而屏幕（`isJournalBlock`／`hasTag`）读的是模型判据。
   * 于是 `_date: ''` 的块「屏幕上是普通块、查询说是日记」。
   * 现在系统槽逐项走 `readField` 里的同一个读法（`core/props.ts` 的 `readSystemField`）。
   */
  const tag = mkTagBlock('甲')
  const dead = mkTagBlock('已归档')
  dead.props = { ...(dead.props ?? {}), _deletedAt: 1 }
  const now = 1_700_000_000_000
  const blank = b('blank', '', { props: { _date: '' }, created: now, modified: now })
  const day = b('day', '', { props: { _date: '2026-10-20' }, created: now + 1000, modified: now + 2000 })
  const tagged = b('tagged', '带标签', { props: { _tags: [tag.id] }, created: now, modified: now })
  const orphan = b('orphan', '只挂着已删标签', { props: { _tags: [dead.id] }, created: now, modified: now })
  const named = b('named', '有地址', { props: { _aliases: ['页面一'] }, created: now, modified: now })
  const plain = b('plain', '普通一行', { created: now, modified: now })
  const def = mkPropDef('日期', 'date')
  // 引擎属性的时间窗要可控：定义/标签块的时间戳由工厂现取（远大于下面的基准），钉成同一档
  def.created = now
  def.modified = now
  tag.created = now
  tag.modified = now
  dead.created = now
  dead.modified = now
  const blocks = [blank, day, tagged, orphan, named, plain, def, tag, dead]
  const ids = (where: QueryNode) => runQuery({ where }, { blocks }).map((h) => h.blockId)

  // `_date`：存在性 == `isJournalBlock`（空串不算），值就是那一格
  assert.deepEqual(ids({ prop: { id: '_date', exists: true } }), ['day'])
  assert.deepEqual(ids({ prop: { id: '_date', eq: '2026-10-20' } }), ['day'])

  // `_kind`：定义块的唯一判据（`mkPropDef` 的 `_kind`），标签块不算
  assert.deepEqual(ids({ prop: { id: '_kind', exists: true } }), [def.id])

  // `_tags`：「有标签」＝有一个**画得出来**的标签（悬空归属不画 ⇒ 也不算）
  assert.deepEqual(ids({ prop: { id: '_tags', exists: true } }), ['tagged'])
  assert.deepEqual(ids({ prop: { id: '_tags', eq: tag.id } }), ['tagged'], '多值按包含判')

  // `_aliases`：地址数组；`eq` 收名字（标签块自己也有地址）
  assert.deepEqual(ids({ prop: { id: '_aliases', exists: true } }), ['named', tag.id])
  assert.deepEqual(ids({ prop: { id: '_aliases', eq: '页面一' } }), ['named'])

  // 引擎属性：值在块顶层字段，不在 `props` 里；必填 ⇒ `exists:false` 恒空
  assert.deepEqual(ids({ prop: { id: ENGINE_CREATED, gt: now } }), ['day'])
  assert.deepEqual(ids({ prop: { id: ENGINE_MODIFIED, gte: now + 2000 } }), ['day'])
  assert.deepEqual(ids({ prop: { id: ENGINE_CREATED, exists: false } }), [])

  // 两条求值路径同解（系统槽的读法住在 `readField`，索引路径共用同一份判定）
  const systemSpecs: QuerySpec[] = [
    { where: { prop: { id: '_date', exists: true } } },
    { where: { prop: { id: '_tags', eq: tag.id } } },
    { where: { prop: { id: ENGINE_CREATED, gt: now } } },
  ]
  for (const spec of systemSpecs) assertSameHits(spec, blocks)
})

test('`{prop}` 的 id 有守卫：只认属性定义块 ＋ 系统槽白名单，不认的 id 一个块都不命中', () => {
  /**
   * 从前 `{prop}` 不看 id 是不是定义块：`{prop:{id:'拼错了', exists:false}}` 会命中**全库**
   * （「这块没有这一栏」对不存在的属性恒真）——一条写错的条件看起来像「条件成立」。
   * 现在的口径：不认的 id 不命中任何块；条件树里那行显示「属性已删除」。
   */
  const def = mkPropDef('截止日', 'date', {}, 'due')
  const filled = b('a', '填了', { props: { due: '2026-12-01' }, created: 1, modified: 1 })
  const plain = b('p', '普通一行', { created: 1, modified: 1 })
  const blocks = [def, filled, plain]
  const ids = (where: QueryNode) => runQuery({ where }, { blocks }).map((h) => h.blockId)

  assert.deepEqual(ids({ prop: { id: 'due', eq: '2026-12-01' } }), ['a'], '定义块 id 照常问')
  assert.deepEqual(ids({ prop: { id: 'no-such-prop', exists: false } }), [], '拼错的 id 不静默命中全库')
  assert.deepEqual(ids({ prop: { id: 'no-such-prop', exists: true } }), [])
  // 系统槽白名单照常（它们不是定义块，但不该被守卫挡掉）
  assert.deepEqual(ids({ prop: { id: '_aliases', exists: true } }), [], '这几个块都没有地址')
  assertSameHits({ where: { prop: { id: 'no-such-prop', exists: false } } }, blocks)

  // 定义块进了回收站 ⇒ 与构建器下拉同源（下拉里也没有它）⇒ 条件不再命中任何块
  const trashed = blocks.map((x) => (x.id === def.id ? { ...x, props: { ...(x.props ?? {}), _deletedAt: 2 } } : x))
  assert.deepEqual(
    runQuery({ where: { prop: { id: 'due', exists: false } } }, { blocks: trashed }).map((h) => h.blockId),
    [],
    '定义不在了 ⇒ 不命中任何块（不做「没有这一栏 ⇒ 全库」的猜测）',
  )
})


test('exists：问「有没有这一槽」，与 eq 是两件事；同时给时按 exists（不猜）', () => {
  // `{prop}` 只认定义块 id ⇒ 先放定义（判的是「有没有这一栏」，不是「props 里有没有键」）
  const def = mkPropDef('任务状态', 'checkbox', {}, TASK_STATUS_PROP_ID)
  const filled = b('a', '填了 false', task(false))
  const empty = b('b', '没这一槽')
  const blocks = [def, filled, empty]
  // 定义块自己也没有这一栏（它不是任务），断言里只关心内容块
  const ids = (where: QueryNode) =>
    runQuery({ where }, { blocks })
      .map((h) => h.blockId)
      .filter((id) => id !== def.id)

  assert.deepEqual(ids({ prop: { id: TASK_STATUS_PROP_ID, exists: true } }), ['a'])
  assert.deepEqual(ids({ prop: { id: TASK_STATUS_PROP_ID, exists: false } }), ['b'])
  // `eq: undefined` 不等于「没有这一槽」：先问有没有，再比值
  assert.deepEqual(runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: undefined } } }, { blocks }), [])
  // 两种形态互斥；同时写按 exists 判（形状写歪时给出可预期的一种答案，而不是靠键序）
  const both = { prop: { id: TASK_STATUS_PROP_ID, exists: false, eq: false } } as unknown as QuerySpec['where']
  assert.deepEqual(ids(both), ['b'])
})

test('三态全部落在 `{prop}` 上：有槽没填、靠标签声明、显式 false 都是「未完成」', () => {
  /**
   * 一块「屏幕上是空心方框」的待办有三种存法，它们必须是同一个答案：
   *   · `_ownProps` 有槽、没有值（面板「加一条属性」）；
   *   · 标签声明了这一栏、块上什么都没写（`#任务` 的成员）；
   *   · 值显式是 `false`。
   *
   * 判据只有一处（`core/props.ts` 的 `readField`：布尔属性声明了就等于 `false`），
   * 所以三条**单节点**条件就够：`eq:false` / `eq:true` / `exists:false`。
   */
  const def = mkPropDef('任务状态', 'checkbox', {}, TASK_STATUS_PROP_ID)
  const tag = mkTagBlock('任务')
  declareField(tag, TASK_STATUS_PROP_ID)
  const untouched = b('u', '有槽没填', { props: { [OWN_PROPS_PROP]: [TASK_STATUS_PROP_ID] } })
  const tagged = b('t', '靠标签声明', { props: { _tags: [tag.id] } })
  const falseVal = b('f', '点了没做', task(false))
  const done = b('d', '做完了', task(true))
  const plain = b('p', '不是任务')
  const blocks = [def, tag, untouched, tagged, falseVal, done, plain]
  /** 定义块与标签块自己也没有这一栏：问「不是任务」时会出现，断言里排除掉 */
  const notDef = (ids: string[]) => ids.filter((id) => id !== def.id && id !== tag.id)

  assert.deepEqual(
    runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } } }, { blocks }).map((h) => h.blockId),
    ['u', 't', 'f'],
    '「未完成」＝ 这一栏在、值不是 true（三种存法一个答案）',
  )
  assert.deepEqual(
    runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, eq: true } } }, { blocks }).map((h) => h.blockId),
    ['d'],
    '「已完成」＝ 值 true',
  )
  assert.deepEqual(
    notDef(
      runQuery({ where: { prop: { id: TASK_STATUS_PROP_ID, exists: false } } }, { blocks }).map(
        (h) => h.blockId,
      ),
    ),
    ['p'],
    '「不是任务」＝ 这一栏不在（有槽没填、靠标签声明都在，所以都不算）',
  )
  // 两条求值路径同解：索引路径也要认「标签声明」这一半（它只换了环境怎么来）
  const open: QuerySpec = { where: { prop: { id: TASK_STATUS_PROP_ID, eq: false } } }
  assert.deepEqual(queryByIndex(rebuild(blocks), blocks, open, {}).map((h) => h.blockId), ['u', 't', 'f'])
})

test('readSpec：读不出的条件返回 null（旧库里已删的原子不许静默变成空集）', () => {
  /**
   * 条件语言的形状会变（`{todo}` 原子就是这样退场的）。旧字节里留着它时，
   * 求值器只能「不命中」——那看起来和「确实没有结果」一模一样，没有任何线索。
   * 读条件时验形，界面才能说一句「这条条件读不出来」。
   */
  const legacy = b('q', '旧查询', { props: { _query: { where: { todo: 'todo' } } } })
  assert.equal(readSpec(legacy), null)
  assert.equal(specChanged(legacy, { where: { tag: 'x' } }), true, '读不出来 ⇒ 当成「变了」，不让冻结沿用旧结果')
  // 认得形状的照常读出来
  const ok = b('q2', '新查询', { props: { _query: { where: { prop: { id: 'p', eq: false } } } } })
  assert.deepEqual(readSpec(ok), { where: { prop: { id: 'p', eq: false } } })
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
  return { blocks: [j, host, same, pointing, inline, literal, tag], host, j, same, pointing, inline, literal, tag }
}

test('U3 同一个带 $self 的 spec：纯路径与索引路径结果相等', () => {
  const { blocks, host, j } = selfFixture()
  assertSameHits({ where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] } }, blocks, {
    selfId: j.id,
  })
  assertSameHits({ where: { tag: '$self' } }, blocks, { selfId: host.id })
  assertSameHits({ where: dayPath('$self') }, blocks, { selfId: j.id })
  assertSameHits({ where: { ref: '$self' } }, blocks, { selfId: j.id })
})

test('U4 selfId 缺省 ＋ spec 含 $self ⇒ 空结果（不退回全库）', () => {
  const { blocks, tag } = selfFixture()
  // 若「解析不了」退化成「条件被忽略」，这里会返回整库
  assert.deepEqual(runQuery({ where: { ref: '$self' } }, { blocks }), [])
  assert.deepEqual(runQuery({ where: { text: '$self' } }, { blocks }), [])
  assert.deepEqual(runQuery({ where: dayPath('$self') }, { blocks }), [])
  // 不含 `$self` 的条件不受影响：没有宿主也照常求值
  assert.equal(runQuery({ where: { tag: tag.id } }, { blocks }).length, 2)
})

test('U5 {tag:$self} 命中同标签的块；「不含宿主自己」是 `excludeIds` 的事', () => {
  const { blocks, host, same } = selfFixture()
  const spec: QuerySpec = { where: { tag: '$self' } }
  const hits = runQuery(spec, { blocks, selfId: host.id, excludeIds: [host.id] })
  assert.deepEqual(hits.map((h) => h.blockId), [same.id], '同类含宿主就只是噪声：它是位置的性质')
  // 只解析 `$self`、不剔除 ⇒ 宿主也在（两件独立的事，各由自己的参数说）
  assert.deepEqual(
    runQuery(spec, { blocks, selfId: host.id }).map((h) => h.blockId),
    [host.id, same.id],
  )
})

test('U6 路径条件里的 $self 等价于写死那一天的日期', () => {
  const { blocks, j } = selfFixture()
  const viaSelf = runQuery({ where: dayPath('$self') }, { blocks, selfId: j.id })
  const literal = runQuery({ where: dayPath('2026-10-26') }, { blocks })
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
  const notRef = runQuery({ where: { not: { ref: '$self' } } }, { blocks, selfId: j.id }).map((h) => h.blockId)
  assert.equal(notRef.includes(inline.id), true, '行内 `#名` 不产生指向边 ⇒ 不被 not-ref 排除')
  assert.equal(notRef.includes(pointing.id), false, '真引用我的块被排除（它在引用那一栏）')

  // ② 提及＝文本里有 ＋ 没指向我
  const mentions = { where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] } }
  const hits = runQuery(mentions, { blocks, selfId: j.id })
  assert.deepEqual(hits.map((h) => h.blockId), [literal.id])
  assert.equal(hits.map((h) => h.blockId).includes(inline.id), false, '`#名` 的 label 不在文本段里，不构成文本提及')
})
test('U6c 宿主的可读文本为空 ⇒ 提及是空集（空串不能当值去比）', () => {
  const { blocks } = selfFixture()
  const bare = b('bare', '   ')
  const withBare = [...blocks, bare]
  assert.deepEqual(runQuery({ where: { text: '$self' } }, { blocks: withBare, selfId: bare.id }), [])
})

test('U6d 宿主没有日期 ⇒ 路径里的 $self 是空集（不是「全部日记」）', () => {
  const { blocks, host } = selfFixture()
  assert.deepEqual(runQuery({ where: dayPath('$self') }, { blocks, selfId: host.id }), [])
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
  const { blocks, host, same, tag } = selfFixture()
  const spec: QuerySpec = { where: { tag: tag.id } }
  // 「带项目标签的块」按条件本该含宿主；挂载区的位置性质把它剔掉
  assert.deepEqual(runQuery(spec, { blocks, excludeIds: [host.id] }).map((h) => h.blockId), ['s1'])
  // ⚠️ 只给 selfId 时**不再**顺带剔除：`$self` 的解析与「结果剔除谁」是两条独立规则
  assert.deepEqual(runQuery(spec, { blocks, selfId: host.id }).map((h) => h.blockId), [host.id, same.id])
})

/* ------------------------------------------------------------ 方向原子（is／up／down／near） */

/**
 * 两天各有一批子块 ＋ 一个不在任何一天的块 ＋ 一条三层链。
 *
 * 这组数据同时覆盖四件事：`up` 能区分两天（旧范围原子只认第一个）、
 * `down` 能沿子树走、`near` 是三者之并、`is` 不改变候选集。
 */
function pathFixture() {
  const forest: Block[] = [
    b('j1', '', {
      props: { _date: '2026-10-20' },
      children: [b('j1a', '甲那天的记录'), b('j1b', '甲那天的第二条')],
    }),
    b('j2', '', { props: { _date: '2026-10-21' }, children: [b('j2a', '乙那天的记录')] }),
    b('loose', '不在任何一天'),
    b('deep1', '深层一', { children: [b('deep2', '深层二', { children: [b('deep3', '深层目标')] })] }),
  ]
  return { blocks: forest }
}

const hitIds = (spec: QuerySpec, blocks: Block[], opts: { selfId?: string } = {}): string[] =>
  runQuery(spec, { blocks, ...opts }).map((h) => h.blockId)

test('A1 路径条件可组合：any 里两天各一支，两天的子块都在', () => {
  const { blocks } = pathFixture()
  assert.deepEqual(hitIds({ where: { any: [dayPath('2026-10-20'), dayPath('2026-10-21')] } }, blocks), [
    'j1a',
    'j1b',
    'j2a',
  ])
})

test('A2 any 里路径与别的条件并集（路径不再吞掉其它分支）', () => {
  const { blocks } = pathFixture()
  assert.deepEqual(hitIds({ where: { any: [dayPath('2026-10-20'), { text: '不在任何一天' }] } }, blocks), [
    'j1a',
    'j1b',
    'loose',
  ])
})

test('A3 not 路径：非空，且不含那一天的子块', () => {
  const { blocks } = pathFixture()
  const ids = hitIds({ where: { not: dayPath('2026-10-20') } }, blocks)
  assert.ok(ids.length > 0, '否定条件不该是空集')
  assert.equal(ids.includes('j1a'), false)
  assert.equal(ids.includes('j1b'), false)
  assert.ok(ids.includes('loose'))
  assert.ok(ids.includes('j2a'))
})

test('A4 新形状与旧 journal 语义逐条相等：命中那天的子块、日期行自己不在结果里', () => {
  const { blocks } = pathFixture()
  const day = findJournalDay(blocks, '2026-10-20')
  assert.ok(day)
  const expected = day.children.map((c) => c.id)
  assert.deepEqual(hitIds({ where: dayPath('2026-10-20') }, blocks), expected)
  assert.equal(expected.includes('j1'), false)
})

test('A5 {down} 命中「子树里有它」的祖先，不含自己', () => {
  const { blocks } = pathFixture()
  assert.deepEqual(hitIds({ where: { down: { text: '深层目标' } } }, blocks), ['deep1', 'deep2'])
})

test('A6 {near} ＝ 自己 ∪ 祖先 ∪ 子孙（三处都命中同一条件）', () => {
  const { blocks } = pathFixture()
  const c: QueryNode = { text: '深层二' }
  const all = hitIds({ where: { text: '' } }, blocks)
  const up = new Set(hitIds({ where: { up: c } }, blocks))
  const down = new Set(hitIds({ where: { down: c } }, blocks))
  const self = new Set(hitIds({ where: c }, blocks))
  assert.deepEqual(new Set([...up, ...down, ...self]), new Set(['deep1', 'deep2', 'deep3']), '三支都要有命中')
  assert.deepEqual(
    hitIds({ where: { near: c } }, blocks),
    all.filter((id) => up.has(id) || down.has(id) || self.has(id)),
    'near 是三者之并，顺序仍按森林先序',
  )
})

test('方向 × 组合：五个场景由一格方向 ＋ 且/或覆盖（「同一处满足整组」≠「各条各找一处」）', () => {
  /**
   * 外部条件面板的五项（上级匹配所有／任一、下级匹配所有／任一、链条中匹配）
   * 在语言里只是「方向 × 组合」两轴：3 × 2 ＝ 6 格，第五、六格免费。
   *
   * 关键语义分叉：`{up:{all:[A,B]}}` 要求**同一个**上级同时满足 A∧B；
   * `{all:[{up:A},{up:B}]}` 只要求祖先链里 A、B **各有一处**（可以是不同块）。
   */
  const c = b('c', 'C')
  const p2 = b('p2', 'B', { children: [c] })
  const p1 = b('p1', 'A', { children: [p2] })
  const blocks = [p1]
  const ids = (where: QueryNode) => runQuery({ where }, { blocks }).map((h) => h.blockId)

  assert.deepEqual(ids({ up: { all: [{ text: 'A' }, { text: 'B' }] } }), [], '同一处满足整组：没有')
  assert.deepEqual(ids({ all: [{ up: { text: 'A' } }, { up: { text: 'B' } }] }), ['c'], '各条各找一处：c')
  assert.deepEqual(ids({ any: [{ up: { text: 'A' } }, { up: { text: 'B' } }] }), ['p2', 'c'], '上级匹配任一')
  assert.deepEqual(ids({ down: { text: 'C' } }), ['p1', 'p2'], '下级匹配（不含自己）')
  assert.deepEqual(ids({ near: { text: 'A' } }), ['p1', 'p2', 'c'], '链条含自己')
  assert.deepEqual(ids({ up: { text: 'A' } }), ['p2', 'c'], '上级不含自己')
  // 两条求值路径同解（方向判定共用一份）
  assertSameHits({ where: { near: { text: 'A' } } }, blocks)
  assertSameHits({ where: { down: { text: 'C' } } }, blocks)
})

test('A7 方向原子可嵌套：{up:{down:…}} 有结果且不重复', () => {
  /**
   * ⚠️ 必须让「某个祖先」与「直接父块」给出不同答案，否则这条断言在
   * 「只看直接父块」的实现下也是绿的（反向验证会抓不住）。
   *
   *   gp
   *     parent
   *       b        ← b 的直接父块子树里没有 X，但祖父的子树里有
   *     other
   *       x（X）   ← X 在 b 的叔伯分支里
   */
  const blocks: Block[] = [
    b('gp', '祖父', {
      children: [
        b('parent', '父', { children: [b('b', '孙')] }),
        b('other', '旁支', { children: [b('x', '深层目标')] }),
      ],
    }),
  ]
  const ids = hitIds({ where: { up: { down: { text: '深层目标' } } } }, blocks)
  assert.deepEqual(ids, ['parent', 'b', 'other', 'x'])
  assert.equal(new Set(ids).size, ids.length, '同一块只许出现一次')
})

test('A8 any 里路径条件换顺序结果不变（不再「只取第一个日期」）', () => {
  const { blocks } = pathFixture()
  const a = hitIds({ where: { any: [dayPath('2026-10-20'), dayPath('2026-10-21')] } }, blocks)
  const swapped = hitIds({ where: { any: [dayPath('2026-10-21'), dayPath('2026-10-20')] } }, blocks)
  assert.deepEqual(a, swapped)
  assert.deepEqual(a, ['j1a', 'j1b', 'j2a'])
})

test('A9 canonicalSpec：四个新原子逐支存活（漏一支＝存进 _query 就被丢掉）', () => {
  const spec: QuerySpec = {
    where: {
      all: [
        { is: 'x' },
        { up: { text: '甲' } },
        { down: { tag: 'tag-x' } },
        { near: { not: { ref: 'r' } } },
      ],
    },
  }
  assert.deepEqual(canonicalSpec(spec), spec)
  assert.equal(
    JSON.stringify(canonicalSpec({ where: { up: { tag: 'x' } } })),
    '{"where":{"up":{"tag":"x"}}}',
    '方向原子要原样带走，不能落成别的支',
  )
})

test('A10 isQueryNode：四个新原子验形通过、畸形拒绝；旧 journal 原子已不合法', () => {
  assert.equal(isQueryNode({ is: 'x' }), true)
  assert.equal(isQueryNode({ is: '' }), false, '空 id 永远命中不了，读出来就是坏条件')
  assert.equal(isQueryNode({ is: 1 }), false)
  assert.equal(isQueryNode({ up: { text: 'x' } }), true)
  assert.equal(isQueryNode({ up: 'x' }), false)
  assert.equal(isQueryNode({ down: { tag: 'x' } }), true)
  assert.equal(isQueryNode({ down: [] }), false)
  assert.equal(isQueryNode({ near: { not: { ref: 'x' } } }), true)
  assert.equal(isQueryNode({ near: null }), false)
  assert.equal(isQueryNode({ journal: '2026-10-20' }), false, '退场的范围原子不许被当成合法条件')
})

test('A11 索引路径与纯函数路径同解：方向原子也逐条相等', () => {
  const { blocks } = pathFixture()
  assertSameHits({ where: { any: [dayPath('2026-10-20'), dayPath('2026-10-21')] } }, blocks)
  assertSameHits({ where: { not: dayPath('2026-10-20') } }, blocks)
  assertSameHits({ where: { down: { text: '深层目标' } } }, blocks)
  assertSameHits({ where: { near: { text: '深层二' } } }, blocks)
  assertSameHits({ where: { up: { down: { text: '深层目标' } } } }, blocks)
  assertSameHits({ where: { is: 'deep2' } }, blocks)
})

test('A12 {down} 一次求值是线性的：深度 5 的 1000 块 < 200ms（粗守卫），深链上每块只走一次（精判据）', () => {
  const spec: QuerySpec = { where: { down: { text: '深层目标' } } }
  /** 门禁并发会让单次抖动 ⇒ 先热一次，再取三次里最好的一次 */
  const bestOf3 = (blocks: Block[]): number => {
    runQuery(spec, { blocks })
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now()
      runQuery(spec, { blocks })
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }

  // ① 计划里的形状：1000 块、深度 5
  const shallow: Block[] = []
  for (let i = 0; i < 200; i++) {
    let node = b(`l${i}-5`, '深层目标')
    for (let d = 4; d >= 1; d--) node = b(`l${i}-${d}`, '链', { children: [node] })
    shallow.push(node)
  }
  const shallowMs = bestOf3(shallow)
  /**
   * 墙钟只做**粗守卫**：线性（~1ms）与「逐候选重走子树」的 O(n²)（百 ms 级）之间隔着两个数量级，
   * 200ms 的阈值分辨得开；但墙钟受并发门禁／别的 agent 影响会抖（实测 5ms 的阈值在负载下炸成
   * 474ms），所以「每块只走一次」这条**精判据**由下面②的读次数断言钉——它数的是访问次数，与负载无关。
   */
  assert.ok(shallowMs < 200, `1000 块深度 5 的 {down} 求值应 < 200ms（粗守卫），实测 ${shallowMs.toFixed(2)}ms`)

  /**
   * ② 真正暴露「逐候选各走一遍子树」的形状：一条 1000 深的链。
   *
   * 不能只看耗时 —— 候选遍历本身就要为每条命中拷一次祖先路径，深链上那是 O(n²)，
   * 会把 `down` 的实现代价盖住。这里数**读了几次子块表与正文**：
   * 记忆化实现每块各一次；逐候选重走子树会读 O(n²) 次。
   */
  let childReads = 0
  let textReads = 0
  let deep = b('c-999', '深层目标')
  Object.defineProperty(deep, 'content', {
    get: () => {
      textReads += 1
      return textRuns('深层目标')
    },
  })
  for (let i = 998; i >= 0; i--) {
    const child = deep
    const kids = [child]
    deep = b(`c-${i}`, '链')
    Object.defineProperty(deep, 'children', {
      get: () => {
        childReads += 1
        return kids
      },
    })
    Object.defineProperty(deep, 'content', {
      get: () => {
        textReads += 1
        return textRuns('链')
      },
    })
  }
  runQuery(spec, { blocks: [deep] })
  assert.ok(childReads <= 5000, `子块表被读了 ${childReads} 次（逐候选重走子树会是 O(n²)）`)
  assert.ok(textReads <= 5000, `正文条件被读了 ${textReads} 次（每块只该判一次）`)
})

test('runQuery：保留键能排序——created/modified 是块字段，refCount 是关系事实，random 按种子确定', () => {
  const mk = (id: string, created: number, modified = created, refs: readonly string[] = []): Block => ({
    id,
    content: refs.map((to) => ({ t: 'ref', to })),
    children: [],
    created,
    modified,
  })
  // a 被引用两次、b 一次、c 零次；created/modified 各不相同（可断言确定序）
  const forest = [mk('a', 300), mk('b', 100), mk('c', 200), mk('r1', 1, 1, ['a', 'b']), mk('r2', 2, 2, ['a'])]
  const spec = (sort: NonNullable<QuerySpec['sort']>): QuerySpec => ({ where: { text: '' }, sort })
  const ids = (hits: { blockId: string }[]): string[] => hits.map((h) => h.blockId)
  const all = ids(runQuery(spec([{ by: 'created', dir: 'asc' }]), { blocks: forest }))
  assert.deepEqual(all.filter((x) => ['a', 'b', 'c'].includes(x)), ['b', 'c', 'a'], 'created 升序＝块字段')
  const byRefs = ids(runQuery(spec([{ by: 'refCount', dir: 'desc' }]), { blocks: forest }))
  assert.deepEqual(byRefs.filter((x) => ['a', 'b', 'c'].includes(x)), ['a', 'b', 'c'], 'refCount 降序＝被引用几次')
  const byModified = ids(runQuery(spec([{ by: 'modified', dir: 'desc' }]), { blocks: forest }))
  assert.deepEqual(byModified.filter((x) => ['a', 'b', 'c'].includes(x)), ['a', 'c', 'b'], 'modified 降序')
  // random：同一种子同一序（冻结契约的一部分——「随机抽 N 条」要回访得回来）
  const rand = ids(runQuery(spec([{ by: 'random', dir: 'asc', seed: 42 }]), { blocks: forest }))
  const randAgain = ids(runQuery(spec([{ by: 'random', dir: 'asc', seed: 42 }]), { blocks: forest }))
  assert.deepEqual(rand, randAgain, '同一种子同一序')
})

/* ------------------------------------------------------------ C 批：相对日期（`{today}` 原子 ＋ 宿主锚） */

test('相对日期：同一份 spec 换一个基准日，结果就换一批（没固化成字面量）', () => {
  const { blocks } = fixture()
  // j1 的 `_date` 是 2026-10-20；「今天」由调用方注入，不在这里读时钟
  const spec: QuerySpec = { where: { today: { offset: 0 } } }
  assert.deepEqual(runQuery(spec, { blocks, today: '2026-10-20' }).map((h) => h.blockId), ['j1'])
  assert.deepEqual(runQuery(spec, { blocks, today: '2026-10-21' }), [], '隔天同一个「今天」不再是那一天')
  // 偏移走本地日历：基准 10-21 往回一天就是 10-20
  assert.deepEqual(runQuery({ where: { today: { offset: -1 } } }, { blocks, today: '2026-10-21' }).map((h) => h.blockId), ['j1'])
  // 非日记块没有 `_date`：正文再像日期也不命中
  assert.deepEqual(runQuery({ where: { today: { offset: 0 } } }, { blocks, today: '2026-10-20' }).map((h) => h.blockId), ['j1'])
})

test('相对日期：没有基准就不命中（不偷偷接时钟）', () => {
  const { blocks } = fixture()
  assert.deepEqual(runQuery({ where: { today: { offset: 0 } } }, { blocks }), [])
})

test('相对日期包进方向原子：`{up:{today}}` ＝ 那一天之下的块', () => {
  const { blocks } = fixture()
  const hits = runQuery({ where: { up: { today: { offset: 0 } } } }, { blocks, today: '2026-10-20' })
  assert.deepEqual(hits.map((h) => h.blockId), ['j1a', 'j1b'])
  assert.equal(hits.some((h) => h.blockId === 'j1'), false, '天自己不会入选（up 不含自己）')
})

test('相对日期：两条求值路径同解', () => {
  const { blocks } = fixture()
  const spec: QuerySpec = { where: { up: { today: { offset: 0 } } } }
  assert.deepEqual(queryByIndex(rebuild(blocks), blocks, spec, { today: '2026-10-20' }), runQuery(spec, { blocks, today: '2026-10-20' }))
})

test('锚：resolveTodayBase 三态（宿主那一天／宿主没日期退回系统今天／没锚）', () => {
  const anchored: QuerySpec = { where: { today: { offset: 0 } }, todayFrom: 'host' }
  assert.equal(resolveTodayBase(anchored, '2026-10-20', '2026-11-07'), '2026-10-20')
  assert.equal(resolveTodayBase(anchored, undefined, '2026-11-07'), '2026-11-07', '宿主没有日期 ⇒ 缺省语义（系统今天），不是空集')
  assert.equal(resolveTodayBase({ where: { today: { offset: 0 } } }, '2026-10-20', '2026-11-07'), '2026-11-07', '没锚 ＝ 系统今天')
})

test('冻结键把基准日算进去：跨天之后冻结结果算过期', () => {
  assert.notEqual(contextKey({ selfId: 'x', today: '2026-11-07' }), contextKey({ selfId: 'x' }))
  assert.equal(contextKey({ selfId: 'x' }), contextKey({ selfId: 'x', today: undefined }), '没有相对日期的查询不带这一格')
})

test('isQueryNode / canonical / isQuerySpec：today 原子与 todayFrom 锚', () => {
  assert.equal(isQueryNode({ today: { offset: 0 } }), true)
  assert.equal(isQueryNode({ today: { offset: -3 } }), true)
  assert.equal(isQueryNode({ today: { offset: 'x' } }), false)
  assert.equal(isQueryNode({ today: {} }), false)
  assert.equal(isQueryNode({ today: null }), false)
  assert.deepEqual(canonicalSpec({ where: { today: { offset: 2 } } }), { where: { today: { offset: 2 } } })
  assert.deepEqual(
    JSON.parse(JSON.stringify(canonicalSpec({ where: { today: { offset: 0 } }, todayFrom: 'host' }))),
    { where: { today: { offset: 0 } }, todayFrom: 'host' },
  )
  assert.equal(isQuerySpec({ where: { today: { offset: 0 } }, todayFrom: 'nope' }), false, '锚只有一种取值')
})

test('role 条件按值分发：page 问「露面里有没有 page」，未知值不命中', () => {
  const { blocks } = fixture()
  const spec: QuerySpec = { where: { role: 'page' } }
  assert.deepEqual(runQuery(spec, { blocks }).map((h) => h.blockId), ['p1', 'p2'], '页 = _lists 里 page 的块')
  assert.deepEqual(queryByIndex(rebuild(blocks), blocks, spec, {}), runQuery(spec, { blocks }), '两条路径同解')
  // 日记天与标签块不是页；{is:$self} 之类不受影响
  const unknown = { where: { role: 'nope' } } as unknown as QuerySpec
  assert.deepEqual(runQuery(unknown, { blocks }), [], '未知 role 不命中（不抛，形状宽容、语义拒绝）')
})

test('相对时间窗：{rel:{days}} 对 env.today 现算（存表达式，隔天自然换窗）', () => {
  const at = Date.now()
  const mk = (id: string, modified: number) => ({
    id, content: [], children: [], created: at, modified, props: { _type: 'note' },
  })
  // 三个修改时刻：10-20／11-01／11-11（本地零点 +1ms）
  const blocks = [mk('a', dayStartMs('2026-10-20') + 1), mk('b', dayStartMs('2026-11-01') + 1), mk('c', dayStartMs('2026-11-11') + 1)]
  const spec: QuerySpec = { where: { prop: { id: 'core/modified', gte: { rel: { days: -7 } } } } }
  // 基准 11-12：窗口自 11-05 起 ⇒ 只有 c
  assert.deepEqual(runQuery(spec, { blocks, today: '2026-11-12' }).map((h) => h.blockId), ['c'])
  // 同一份条件换个基准日 ⇒ 窗口跟着挪（表达式没有被固化）：基准 11-06 ⇒ 窗口自 10-30 起
  assert.deepEqual(runQuery(spec, { blocks, today: '2026-11-06' }).map((h) => h.blockId), ['b', 'c'])
  // 没有基准 ⇒ 不命中（不猜今天）
  assert.deepEqual(runQuery(spec, { blocks }), [])
})
