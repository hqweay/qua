/**
 * **索引**的测试：核心是那条等式 —— `rebuild(all) === incremental(changes)`。
 *
 * 为什么这条等式值得单独写一整个文件：
 *   增量更新最容易出的错不是「崩了」，而是**漏了一种失效点**（比如删块时忘了收掉它的标签归属），
 *   表现是界面上偶尔少一条反链。那种错不会报错、不会崩，只会让数据慢慢对不上。
 *   ⇒ 用「全量重建」当唯一基准，逼增量路径与它逐字节相等。
 *
 * ⚠️ 两类关系的数据源不同，失效点也不同：
 *   · `incoming`（引用）来自**原子** ⇒ 只有原子变化才重算；
 *   · `tagMembers`（标签成员）来自**块上的 `_tags`** ⇒ 只有块变化才重算。
 *   把两者混在一起，就会得到「改一个标签归属却重建了名字表」这类看不出错、只是慢的路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import type { Change } from '../src/core/storage/port.ts'
import {
  applyChanges,
  fingerprint,
  findJournalDay,
  incomingIds,
  journalIdByDate,
  lookupBlock,
  rebuild,
  tagIdByName,
  tagMemberIdsOf,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

const edge = (id: string, blockId: string, targetId: string, start = 0): Atom =>
  ({ id, kind: 'page', blockId, start, end: start + 1, label: 'x', target: { kind: 'page', id: targetId } }) as Atom

/** 一份小而全的库：页 / 子块 / 标签块 / journal 都在；标签走块上的 `_tags` */
function fixture() {
  const todo = b('t1', 'todo', { props: { _aliases: ['todo'], _lists: ['tag'], _icon: 'lucide:hash' } })
  const design = b('t2', '设计', { props: { _aliases: ['设计'], _lists: ['tag'] } })
  const journal = b('j1', '', { props: { _date: '2026-10-21' }, children: [b('j1a', '今天', { props: { _tags: ['t2'] } })] })
  const p1 = b('p1', '页面一', {
    props: { _aliases: ['页面一'], _lists: ['page'] },
    children: [
      b('a', '甲', { props: { _tags: ['t1'] } }),
      b('b', '乙', { children: [b('b1', '乙的子块', { props: { _tags: ['t1'] } })] }),
    ],
  })
  const p2 = b('p2', '页面二', { props: { _aliases: ['页面二'], _lists: ['page'] }, children: [b('c', '丙')] })
  const forest = [journal, p1, p2, todo, design]
  const atoms: Atom[] = [
    edge('e1', 'c', 'p1'), // 丙 引用 页面一
    edge('e2', 'a', 'p2'), // 甲 也引用 页面二
  ]
  return { forest, atoms }
}

/** 全量重建的指纹（唯一基准） */
const full = (forest: readonly Block[], atoms: readonly Atom[]): string => fingerprint(rebuild(forest, atoms))

/** 一路增量累积出来的指纹 */
function incremental(steps: readonly { changes: Change[]; forest: readonly Block[]; atoms: readonly Atom[] }[]): string {
  const first = steps[0]!
  let idx = rebuild(first.forest, first.atoms)
  for (const s of steps.slice(1)) idx = applyChanges(idx, s.changes, s.forest, s.atoms)
  return fingerprint(idx)
}

const atomsOnly: Change[] = [{ kind: 'atoms', id: '*' }]
const blocksOnly: Change[] = [{ kind: 'blocks', id: '*' }]

/* ------------------------------------------------------------ 基本形状 */

test('rebuild：五张表都建起来（块 / 入向边 / 标签成员 / 名字与日期）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)

  assert.equal(lookupBlock(idx, 'b1')?.text, '乙的子块')
  assert.deepEqual(incomingIds(idx, 'p1').sort(), ['c'], '引用的入向边')
  assert.deepEqual(tagMemberIdsOf(idx, 't1').sort(), ['a', 'b1'], '标签成员来自块上的 `_tags`')
  assert.deepEqual(tagMemberIdsOf(idx, 't2').sort(), ['j1a'])
  assert.equal(tagIdByName(idx, 'todo'), 't1')
  assert.equal(tagIdByName(idx, ' TODO '), 't1', '名字规范化只有一个口径')
  assert.equal(journalIdByDate(idx, '2026-10-21'), 'j1')
})

test('rebuild：`[[标签块]]` 的**引用**不算标签成员（两张表不能合并）', () => {
  const forest = [
    b('t1', 'todo', { props: { _aliases: ['todo'], _lists: ['tag'] } }),
    b('p', '页面', { props: { _aliases: ['页面'], _lists: ['page'] }, children: [b('a', '甲')] }),
  ]
  const atoms = [edge('e1', 'a', 't1')] // 引用，不是打标签
  const idx = rebuild(forest, atoms)
  assert.deepEqual(incomingIds(idx, 't1'), ['a'], '入向边算它')
  assert.deepEqual(tagMemberIdsOf(idx, 't1'), [], '但成员列表里不该有它')
})

test('rebuild：标签归属不进 `incoming`（它没有边数，只有成员关系）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  assert.deepEqual(incomingIds(idx, 't1'), [], '没人用 `[[todo]]` 引用它 ⇒ 入向边为空')
  assert.deepEqual(tagMemberIdsOf(idx, 't1').sort(), ['a', 'b1'], '但成员列表非空')
})

test('rebuild：标签名按规范化取先序第一个（与 ensureTag 同口径）', () => {
  const forest = [
    b('t1', 'Todo', { props: { _aliases: ['Todo'], _lists: ['tag'] } }),
    b('t2', 'todo', { props: { _aliases: ['todo'], _lists: ['tag'] } }),
  ]
  const idx = rebuild(forest, [])
  assert.equal(tagIdByName(idx, 'todo'), 't1', '同名标签取先序第一个，不随机')
})

test('rebuild：标签的**每一个**别名都进名字表（重复时先序第一个赢）', () => {
  const tagged = b('t1', 'todo', { props: { _aliases: ['todo', '待办', '项目/todo'], _lists: ['tag'] } })
  const idx = rebuild([tagged], [])
  assert.equal(tagIdByName(idx, 'todo'), 't1')
  assert.equal(tagIdByName(idx, ' 待办 '), 't1', '别名也走同一处规范化')
  assert.equal(tagIdByName(idx, '项目/todo'), 't1', '带 / 的全名也是地址')
  assert.equal(tagIdByName(idx, '项目'), undefined, '解析不按叶子猜（显示才取叶子）')
})

test('rebuild：没有别名的「标签」不进名字表（地址是准入条件）', () => {
  const idx = rebuild([b('t1', 'todo', { props: { _lists: ['tag'] } })], [])
  assert.deepEqual([...idx.tags.keys()], [])
})

test('日期索引与 journalDays 同口径：嵌在子树里的一天，两条路给同一个答案', () => {
  // 「索引认得它、日记流看不见」曾是同一个 bug 的两面。这里把两条路摆在一起：
  // 索引（`journalIdByDate`）与扫描（`findJournalDay`）必须同口径 —— 整片森林、先序第一个。
  const forest = [
    b('p1', '页面', {
      props: { _aliases: ['页面'], _lists: ['page'] },
      children: [b('j1', '', { props: { _date: '2026-10-19' } })],
    }),
  ]
  const idx = rebuild(forest, [])
  assert.equal(journalIdByDate(idx, '2026-10-19'), 'j1')
  assert.equal(findJournalDay(forest, '2026-10-19')?.id, 'j1')
})

/* ------------------------------------------------------------ 那条等式 */

test('等式：纯原子变化（引用增删）⇒ 增量与全量逐字节一致', () => {
  const { forest, atoms } = fixture()
  // 第 1 步：多一处引用；第 2 步：删掉一条旧引用
  const added = [...atoms, edge('e5', 'c', 't2')]
  const removed = added.filter((a) => a.id !== 'e1')
  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: atomsOnly, forest, atoms: added },
      { changes: atomsOnly, forest, atoms: removed },
    ]),
    full(forest, removed),
  )
})

test('等式：块变化（移动 / 删块 / 改名 / 改标签归属）⇒ 增量与全量逐字节一致', () => {
  const { forest, atoms } = fixture()

  // ① 移动：把 `b` 整棵子树从 p1 挪到 p2（归属跟着块走，块表要跟着）
  const moved = JSON.parse(JSON.stringify(forest)) as Block[]
  const p1 = moved.find((x) => x.id === 'p1')!
  const p2 = moved.find((x) => x.id === 'p2')!
  const bi = p1.children.findIndex((x) => x.id === 'b')
  const [bNode] = p1.children.splice(bi, 1)
  p2.children.push(bNode!)

  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: moved, atoms },
    ]),
    full(moved, atoms),
    '块移动后增量应与全量一致',
  )

  // ② 删块：删掉 `b1`（它带着一个标签归属）⇒ 成员表必须一起收掉
  const pruned = JSON.parse(JSON.stringify(moved)) as Block[]
  const bb = pruned.find((x) => x.id === 'p2')!.children.find((x) => x.id === 'b')!
  bb.children = []
  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: pruned, atoms },
    ]),
    full(pruned, atoms),
  )

  // ③ 改名：标签块的主名从 `todo` 改成 `待办` ⇒ 名字表跟着变
  const renamed = JSON.parse(JSON.stringify(forest)) as Block[]
  renamed.find((x) => x.id === 't1')!.props!._aliases = ['待办']
  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: renamed, atoms },
    ]),
    full(renamed, atoms),
  )

  // ④ 改归属：把 `#todo` 从 `a` 挪到 `c` ⇒ 成员表跟着变
  const retagged = JSON.parse(JSON.stringify(forest)) as Block[]
  const host = retagged.find((x) => x.id === 'p1')!.children.find((x) => x.id === 'a')!
  delete host.props!._tags
  retagged.find((x) => x.id === 'p2')!.children.find((x) => x.id === 'c')!.props = { _tags: ['t1'] }
  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: retagged, atoms },
    ]),
    full(retagged, atoms),
  )
})

test('等式：一串交替变化（原子 / 块 / marks 混着来）累积到最后＝全量', () => {
  const { forest, atoms } = fixture()

  const s1Atoms = [...atoms, edge('e9', 'c', 't1')]
  const s2Forest = JSON.parse(JSON.stringify(forest)) as Block[]
  s2Forest.find((x) => x.id === 't1')!.props!._aliases = ['TODO']
  const s3Atoms = s1Atoms.filter((a) => a.id !== 'e1')
  const s4Forest = JSON.parse(JSON.stringify(s2Forest)) as Block[]
  s4Forest.push(b('p3', '页面三', { props: { _aliases: ['页面三'], _lists: ['page'] } }))

  const got = incremental([
    { changes: [], forest, atoms },
    { changes: atomsOnly, forest, atoms: s1Atoms },
    { changes: blocksOnly, forest: s2Forest, atoms: s1Atoms },
    { changes: atomsOnly, forest: s2Forest, atoms: s3Atoms },
    { changes: [{ kind: 'marks', id: '*' }], forest: s2Forest, atoms: s3Atoms }, // marks 不进索引
    { changes: blocksOnly, forest: s4Forest, atoms: s3Atoms },
  ])
  assert.equal(got, full(s4Forest, s3Atoms))
})

test('等式：marks 变化不影响索引（指纹不变）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  const next = applyChanges(idx, [{ kind: 'marks', id: '*' }], forest, atoms)
  assert.equal(fingerprint(next), fingerprint(idx), 'marks 不参与「谁指向谁」')
})

/* ------------------------------------------------------------ 增量的边界 */

test('applyChanges：块动过 ⇒ 整体重建（宁可全量，不要自相矛盾的索引）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  // 假装只报了一个原子的变化，但块其实也变了 ⇒ 实现必须靠 blocks 这一侧兜住
  const mutated = JSON.parse(JSON.stringify(forest)) as Block[]
  mutated.find((x) => x.id === 't1')!.props!._aliases = ['改过的标签名']
  const next = applyChanges(idx, blocksOnly, mutated, atoms)
  assert.equal(fingerprint(next), full(mutated, atoms))
})

test('applyChanges：空 changes ⇒ 原样返回（不是「重建一遍」）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  assert.equal(applyChanges(idx, [], forest, atoms), idx, '没有变化就别重算')
})

test('fingerprint：与插入顺序无关（否则会假报不一致）', () => {
  const a = b('x', 'X', { props: { _aliases: ['X'], _lists: ['page'] }, children: [b('y', 'Y')] })
  const c = b('z', 'Z', { props: { _aliases: ['Z'], _lists: ['page'] } })
  const fwd = rebuild([a, c], [edge('e1', 'y', 'x'), edge('e2', 'y', 'z')])
  const rev = rebuild([c, a], [edge('e2', 'y', 'z'), edge('e1', 'y', 'x')])
  assert.equal(fingerprint(fwd), fingerprint(rev))
})

/* ------------------------------------------------------------ 接进共享 store */

/**
 * 索引真正被用起来的地方是 `BlockStore`：`find` 从「遍历森林」换成「查表」。
 *
 * ⚠️ 这里钉的是**失效时机**——索引错不会崩，只会静默读到旧数据，
 *    所以「改完必须能读到新值」要逐个路径验。
 */
test('store.find：走索引，且结构变化后能查到新块', async () => {
  const { BlockStore } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))

  assert.equal(store.find('b1')?.text, '乙的子块')
  assert.equal(store.find('不存在'), undefined)

  // 加一块 + 通知 ⇒ 索引失效重建 ⇒ 查得到
  const fresh = b('new', '新块')
  store.blocks.find((x) => x.id === 'p2')!.children.push(fresh)
  store.touch()
  assert.equal(store.find('new')?.text, '新块', '结构变化后新块要能被查到')
})

test('store.find：挖掉一块 + 通知 ⇒ 查不到了（不是留着旧条目）', async () => {
  const { BlockStore } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))
  assert.equal(store.find('b1')?.text, '乙的子块')

  const p1 = store.blocks.find((x) => x.id === 'p1')!
  const bNode = p1.children.find((x) => x.id === 'b')!
  bNode.children = []
  store.touch()
  assert.equal(store.find('b1'), undefined, '删掉的块不该还能查到')
})

test('store.index：块是**活引用**（改名不用重建就可见），但名字表要重建', async () => {
  const { BlockStore } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))

  // ① 活引用：拿到的那块就是 store 里那块 ⇒ 改别名立刻可见（不需要重建）
  const block = store.find('t1')!
  block.props = { ...(block.props ?? {}), _aliases: ['待办'] }
  assert.deepEqual(store.find('t1')?.props?._aliases, ['待办'], '块是活引用，不是拷贝')

  // ② 但**名字表**是快照 ⇒ 不重建就还停在旧名字上
  assert.equal(tagIdByName(store.index, 'todo'), 't1', '未重建时名字表仍是旧的')

  // ③ 走一次 touch（＝任何一个真实的改动出口）⇒ 名字表跟着变
  store.touch()
  assert.equal(tagIdByName(store.index, '待办'), 't1')
  assert.equal(tagIdByName(store.index, 'todo'), undefined, '旧名字不该残留')
})

test('backrefsOf：count 是**边数**（同一块引用两次算两条），不是块数', async () => {
  const { backrefsOf } = await import('../src/core/index.ts')
  const p1 = b('p1', '页面一', { props: { _aliases: ['页面一'], _lists: ['page'] }, children: [b('a', '甲'), b('a2', '甲2')] })
  const p2 = b('p2', '页面二', { props: { _aliases: ['页面二'], _lists: ['page'] }, children: [b('c', '丙')] })
  const forest = [p1, p2]
  // `a` 里引用 p2 **两次**，`a2` 里引用一次 ⇒ p1 这一页共 3 处
  const atoms = [edge('e1', 'a', 'p2', 0), edge('e2', 'a', 'p2', 2), edge('e3', 'a2', 'p2', 0)]
  const out = backrefsOf({ blocks: forest, atoms, targetId: 'p2' })
  assert.equal(out.length, 1, '同一页聚合成一条')
  assert.equal(out[0]!.pageId, 'p1')
  assert.equal(out[0]!.count, 3, '三处引用 ⇒ count 3（用 Set 会压成 2）')
})

test('backrefsOf：标签归属**不是**入向边（标签的成员走自己的读法）', async () => {
  const { backrefsOf } = await import('../src/core/index.ts')
  const forest = [
    b('p1', '页面一', {
      props: { _aliases: ['页面一'], _lists: ['page'] },
      children: [b('a', '甲', { props: { _tags: ['t1'] } })],
    }),
    b('t1', 'todo', { props: { _aliases: ['todo'], _lists: ['tag'] } }),
  ]
  const out = backrefsOf({ blocks: forest, atoms: [], targetId: 't1' })
  assert.deepEqual(out, [], '没有 `[[todo]]` 引用 ⇒ 反链为空；成员列表在 tag 面板里')
})

test('backrefBlocks：给可编辑 footer 用 —— 返回**块**级来源，带归属页与次数', async () => {
  const { backrefBlocks } = await import('../src/core/index.ts')
  const forest = [
    b('p1', '页面一', {
      props: { _aliases: ['页面一'], _lists: ['page'] },
      children: [b('a', '甲'), b('a2', '甲2')],
    }),
  ]
  const atoms = [edge('e1', 'a2', 'p1', 0), edge('e2', 'a2', 'p1', 2)]
  const out = backrefBlocks({ blocks: forest, atoms, targetId: 'p1' })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.blockId, 'a2', '返回源**块**，不是页')
  assert.equal(out[0]!.pageId, 'p1')
  assert.equal(out[0]!.count, 2)
})

test('backrefsOf/backrefBlocks：传了 index 就不依赖 blocks/atoms 参数（查表）', async () => {
  const { backrefsOf, backrefBlocks } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  // 故意传空数组：只要 index 有效，结果就必须与全量一致（证明真的在查表）
  const a = backrefsOf({ blocks: [], atoms: [], targetId: 'p2', index: idx })
  assert.deepEqual(a.map((x) => x.count), [1], 'p2 被引用一次')
  const bl = backrefBlocks({ blocks: [], atoms: [], targetId: 'p2', index: idx })
  assert.deepEqual(bl.map((x) => x.blockId), ['a'])
})

test('store.reset：换库后索引整体失效（不是拿旧库的块表凑）', async () => {
  const { BlockStore } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))
  assert.equal(store.find('p1')?.text, '页面一')

  store.reset([b('only', '唯一一页', { props: { _aliases: ['唯一一页'], _lists: ['page'] } })], [], [])
  assert.equal(store.find('only')?.text, '唯一一页')
  assert.equal(store.find('p1'), undefined, '旧库的块不该还查得到')
})

/* ------------------------------------------------------------ 按块粒度（Tx/Changes） */

/**
 * 这一步的意义：`Change.id` 从「整类」细化到「具体 id」。
 *
 * ⚠️ 最危险的失败不是崩，而是**修补得不全**——界面上偶尔少一条反链、偶尔查得到已删的块。
 *   所以每条断言都拿**全量重建**当基准，要求逐字节一致。
 */
test('按块粒度：改一块 ⇒ 增量与全量逐字节一致（含删块后归属一起收掉）', async () => {
  const core = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = core.rebuild(forest, atoms)

  // ① 改一块的别名（标签块改名 ⇒ 名字表要跟着换）
  const renamed = JSON.parse(JSON.stringify(forest)) as Block[]
  renamed.find((x) => x.id === 't1')!.props!._aliases = ['待办']
  const next = core.applyChanges(idx, [{ kind: 'blocks', id: 't1' }], renamed, atoms)
  assert.equal(core.fingerprint(next), core.fingerprint(core.rebuild(renamed, atoms)), '改名后索引要跟上')
  assert.equal(core.tagIdByName(next, '待办'), 't1')
  assert.equal(core.tagIdByName(next, 'todo'), undefined, '旧名字不该残留')

  // ② 删掉一块（连它的标签归属一起消失）
  const pruned = JSON.parse(JSON.stringify(forest)) as Block[]
  pruned.find((x) => x.id === 'p1')!.children = []
  const afterDelete = core.applyChanges(next, [{ kind: 'blocks', id: 'a' }, { kind: 'blocks', id: 'b1' }], pruned, atoms)
  assert.equal(core.fingerprint(afterDelete), core.fingerprint(core.rebuild(pruned, atoms)), '删块后归属要一起收掉')
  assert.equal(core.lookupBlock(afterDelete, 'a'), undefined)
  assert.equal(core.lookupBlock(afterDelete, 'b1'), undefined, '跟着子树一起没的块不该还在')
})

test('按块粒度：`*` 仍然触发全量（保守声明不能被当成「没变」）', async () => {
  const core = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = core.rebuild(forest, atoms)
  const mutated = JSON.parse(JSON.stringify(forest)) as Block[]
  mutated.push(b('extra', '后来加的页', { props: { _aliases: ['后来加的页'], _lists: ['page'] } }))
  const next = core.applyChanges(idx, [{ kind: 'blocks', id: '*' }], mutated, atoms)
  assert.equal(core.fingerprint(next), core.fingerprint(core.rebuild(mutated, atoms)), '整类声明 ⇒ 全量重建')
  assert.equal(core.lookupBlock(next, 'extra')?.text, '后来加的页')
})

/**
 * 真实收益所在：**只改原子**时（多一处引用 / 删一处引用）不重建块表与名字表。
 *
 * 打字改的是文本 ⇒ 报 `blocks` ⇒ 走全量（见上面「为什么不按块修补」）；
 * 但挂/摘一处引用只动 `atoms` ⇒ 那三张表完全不该被碰，
 * 而 `tagMembers` 的数据源在块上 ⇒ 同样原样带过去。
 */
test('按块粒度：只有 atoms 变化 ⇒ 块表/名字表/父页表/成员表**同一个引用**（真的没被重建）', async () => {
  const core = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = core.rebuild(forest, atoms)
  const added = [...atoms, edge('e7', 'c', 't2')]
  const next = core.applyChanges(idx, [{ kind: 'atoms', id: 'e7' }], forest, added)

  assert.equal(next.blocks, idx.blocks, '块表原样保留（活引用不换）')
  assert.equal(next.tags, idx.tags, '名字表原样保留')
  assert.equal(next.pageOf, idx.pageOf, '父页表原样保留')
  assert.equal(next.tagMembers, idx.tagMembers, '标签成员来自块 ⇒ 原子变了不用重算')
  // 但入向边是新的，且内容正确
  assert.notEqual(next.incoming, idx.incoming, '入向边必须重算')
  assert.deepEqual(core.incomingIds(next, 't2'), ['c'], '新边要算进来')
  assert.equal(core.fingerprint(next), core.fingerprint(core.rebuild(forest, added)), '结果仍与全量一致')
})

test('按块粒度：一次报多块（跨两棵子树）⇒ 两边都重算，且与全量一致', async () => {
  const core = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = core.rebuild(forest, atoms)

  const mutated = JSON.parse(JSON.stringify(forest)) as Block[]
  const p2 = mutated.find((x) => x.id === 'p2')!
  const c = p2.children.find((x) => x.id === 'c')!
  c.text = '丙改过了'
  mutated.find((x) => x.id === 't2')!.props!._aliases = ['设计改过了']

  const next = core.applyChanges(idx, [{ kind: 'blocks', id: 'c' }, { kind: 'blocks', id: 't2' }], mutated, atoms)
  assert.equal(core.fingerprint(next), core.fingerprint(core.rebuild(mutated, atoms)))
  assert.equal(core.lookupBlock(next, 'c')?.text, '丙改过了')
  assert.equal(core.tagIdByName(next, '设计改过了'), 't2')
})

test('按块粒度：报了一个已经不存在的 id ⇒ 退化为全量（不留半新的索引）', async () => {
  const core = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const idx = core.rebuild(forest, atoms)

  // 块真的被删了，但改动只点名了它 ⇒ 找不到路径 ⇒ 必须全量
  const pruned = JSON.parse(JSON.stringify(forest)) as Block[]
  const p1 = pruned.find((x) => x.id === 'p1')!
  p1.children = p1.children.filter((x) => x.id !== 'b')

  const next = core.applyChanges(idx, [{ kind: 'blocks', id: 'b' }], pruned, atoms)
  assert.equal(core.fingerprint(next), core.fingerprint(core.rebuild(pruned, atoms)))
  assert.equal(core.lookupBlock(next, 'b1'), undefined, '跟着子树一起没的块不该还在')
})
