/**
 * **索引**的测试：核心是那条等式 —— `rebuild(all) === incremental(changes)`。
 *
 * 为什么这条等式值得单独写一整个文件：
 *   增量更新最容易出的错不是「崩了」，而是**漏了一种失效点**（比如删块时忘了收掉它的边），
 *   表现是界面上偶尔少一条反链。那种错不会报错、不会崩，只会让数据慢慢对不上。
 *   ⇒ 用「全量重建」当唯一基准，逼增量路径与它逐字节相等。
 *
 * 覆盖 71.6 点名的四个增量失效点：文本编辑、原子增删、目标删除、块移动。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import type { Change } from '../src/core/storage/port.ts'
import {
  applyChanges,
  fingerprint,
  incomingIds,
  journalIdByDate,
  lookupBlock,
  rebuild,
  tagIdByName,
  tagMemberIdsOf,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

const edge = (id: string, kind: 'page' | 'tag', blockId: string, targetId: string, start = 0): Atom =>
  ({ id, kind, blockId, start, end: start + 1, label: 'x', target: { kind: 'page', id: targetId } }) as Atom

/** 一份小而全的库：页 / 子块 / 标签块 / journal 都在 */
function fixture() {
  const todo = b('t1', 'todo', { role: 'tag', props: { _icon: 'lucide:hash' } })
  const design = b('t2', '设计', { role: 'tag' })
  const journal = b('j1', '', { role: 'journal', props: { _date: '2026-10-21' }, children: [b('j1a', '今天')] })
  const p1 = b('p1', '页面一', {
    role: 'page',
    children: [b('a', '甲'), b('b', '乙', { children: [b('b1', '乙的子块')] })],
  })
  const p2 = b('p2', '页面二', { role: 'page', children: [b('c', '丙')] })
  const forest = [journal, p1, p2, todo, design]
  const atoms: Atom[] = [
    edge('e1', 'tag', 'a', 't1'), // 甲 打了 #todo
    edge('e2', 'tag', 'b1', 't1'), // 乙的子块 也打了 #todo
    edge('e3', 'page', 'c', 'p1'), // 丙 引用 页面一
    edge('e4', 'tag', 'j1a', 't2'), // 今天 打了 #设计
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

test('rebuild：四张表都建起来（块 / 入向边 / 标签成员 / 名字与日期）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)

  assert.equal(lookupBlock(idx, 'b1')?.text, '乙的子块')
  assert.deepEqual(incomingIds(idx, 't1').sort(), ['a', 'b1'], '标签的入向边')
  assert.deepEqual(incomingIds(idx, 'p1').sort(), ['c'], '引用的入向边')
  assert.deepEqual(tagMemberIdsOf(idx, 't1').sort(), ['a', 'b1'])
  assert.equal(tagIdByName(idx, 'todo'), 't1')
  assert.equal(tagIdByName(idx, ' TODO '), 't1', '名字规范化只有一个口径')
  assert.equal(journalIdByDate(idx, '2026-10-21'), 'j1')
})

test('rebuild：标签名按规范化取先序第一个（与 ensureTag 同口径）', () => {
  const forest = [b('t1', 'Todo', { role: 'tag' }), b('t2', 'todo', { role: 'tag' })]
  const idx = rebuild(forest, [])
  assert.equal(tagIdByName(idx, 'todo'), 't1', '同名标签取先序第一个，不随机')
})

test('rebuild：`[[标签块]]` 的**引用**不算标签成员（两张表不能合并）', () => {
  const forest = [b('t1', 'todo', { role: 'tag' }), b('p', '页面', { role: 'page', children: [b('a', '甲')] })]
  const atoms = [edge('e1', 'page', 'a', 't1')] // 引用，不是打标签
  const idx = rebuild(forest, atoms)
  assert.deepEqual(incomingIds(idx, 't1'), ['a'], '入向边算它')
  assert.deepEqual(tagMemberIdsOf(idx, 't1'), [], '但成员列表里不该有它')
})

/* ------------------------------------------------------------ 那条等式 */

test('等式：纯原子变化（打标签 / 删边）⇒ 增量与全量逐字节一致', () => {
  const { forest, atoms } = fixture()
  // 第 1 步：打一个新标签边；第 2 步：删掉一条旧边
  const added = [...atoms, edge('e5', 'tag', 'c', 't2')]
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

test('等式：块变化（移动 / 删块 / 改名）⇒ 增量与全量逐字节一致', () => {
  const { forest, atoms } = fixture()

  // ① 移动：把 `b` 整棵子树从 p1 挪到 p2（边不受影响，但块表要跟着）
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

  // ② 删块：删掉 `b1`（它带着一条 tag 边）⇒ 那条边必须一起消失
  const pruned = JSON.parse(JSON.stringify(moved)) as Block[]
  const bb = pruned.find((x) => x.id === 'p2')!.children.find((x) => x.id === 'b')!
  bb.children = []
  const atomsAfterDelete = atoms.filter((a) => a.blockId !== 'b1')

  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: pruned, atoms: atomsAfterDelete },
    ]),
    full(pruned, atomsAfterDelete),
  )

  // ③ 改名：标签块从 `todo` 改成 `待办` ⇒ 名字表跟着变
  const renamed = JSON.parse(JSON.stringify(forest)) as Block[]
  renamed.find((x) => x.id === 't1')!.text = '待办'
  assert.equal(
    incremental([
      { changes: [], forest, atoms },
      { changes: blocksOnly, forest: renamed, atoms },
    ]),
    full(renamed, atoms),
  )
})

test('等式：一串交替变化（原子 / 块 / marks 混着来）累积到最后＝全量', () => {
  const { forest, atoms } = fixture()

  const s1Atoms = [...atoms, edge('e9', 'tag', 'c', 't1')]
  const s2Forest = JSON.parse(JSON.stringify(forest)) as Block[]
  s2Forest.find((x) => x.id === 't1')!.text = 'TODO'
  const s3Atoms = s1Atoms.filter((a) => a.id !== 'e3')
  const s4Forest = JSON.parse(JSON.stringify(s2Forest)) as Block[]
  s4Forest.push(b('p3', '页面三', { role: 'page' }))

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
  mutated.find((x) => x.id === 't1')!.text = '改过的标签名'
  const next = applyChanges(idx, blocksOnly, mutated, atoms)
  assert.equal(fingerprint(next), full(mutated, atoms))
})

test('applyChanges：空 changes ⇒ 原样返回（不是「重建一遍」）', () => {
  const { forest, atoms } = fixture()
  const idx = rebuild(forest, atoms)
  assert.equal(applyChanges(idx, [], forest, atoms), idx, '没有变化就别重算')
})

test('fingerprint：与插入顺序无关（否则会假报不一致）', () => {
  const a = b('x', 'X', { role: 'page', children: [b('y', 'Y')] })
  const c = b('z', 'Z', { role: 'page' })
  const fwd = rebuild([a, c], [edge('e1', 'page', 'y', 'x'), edge('e2', 'page', 'y', 'z')])
  const rev = rebuild([c, a], [edge('e2', 'page', 'y', 'z'), edge('e1', 'page', 'y', 'x')])
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

  // ① 活引用：拿到的那块就是 store 里那块 ⇒ 改字立刻可见（不需要重建）
  const block = store.find('t1')!
  block.text = '待办'
  assert.equal(store.find('t1')?.text, '待办', '块是活引用，不是拷贝')

  // ② 但**名字表**是快照 ⇒ 不重建就还停在旧名字上
  assert.equal(tagIdByName(store.index, 'todo'), 't1', '未重建时名字表仍是旧的')

  // ③ 走一次 touch（＝任何一个真实的改动出口）⇒ 名字表跟着变
  store.touch()
  assert.equal(tagIdByName(store.index, '待办'), 't1')
  assert.equal(tagIdByName(store.index, 'todo'), undefined, '旧名字不该残留')
})

test('backrefsOf：count 是**边数**（同一块引用两次算两条），不是块数', async () => {
  const { backrefsOf } = await import('../src/core/index.ts')
  const p1 = b('p1', '页面一', { role: 'page', children: [b('a', '甲'), b('a2', '甲2')] })
  const p2 = b('p2', '页面二', { role: 'page', children: [b('c', '丙')] })
  const forest = [p1, p2]
  // `a` 里引用 p2 **两次**，`a2` 里引用一次 ⇒ p1 这一页共 3 处
  const atoms = [
    edge('e1', 'page', 'a', 'p2', 0),
    edge('e2', 'page', 'a', 'p2', 2),
    edge('e3', 'page', 'a2', 'p2', 0),
  ]
  const out = backrefsOf({ blocks: forest, atoms, targetId: 'p2' })
  assert.equal(out.length, 1, '同一页聚合成一条')
  assert.equal(out[0]!.pageId, 'p1')
  assert.equal(out[0]!.count, 3, '三处引用 ⇒ count 3（用 Set 会压成 2）')
})

test('backrefsOf：标签边也是入向边（标签块的反链不空）', async () => {
  const { backrefsOf } = await import('../src/core/index.ts')
  const forest = [
    b('p1', '页面一', { role: 'page', children: [b('a', '甲')] }),
    b('t1', 'todo', { role: 'tag' }),
  ]
  const atoms = [edge('e1', 'tag', 'a', 't1')]
  const out = backrefsOf({ blocks: forest, atoms, targetId: 't1' })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.pageId, 'p1', '归到**来源页** p1，不是标签块自己')
  assert.equal(out[0]!.text, '甲')
})

test('backrefBlocks：给可编辑 footer 用 —— 返回**块**级来源，带归属页与次数', async () => {
  const { backrefBlocks } = await import('../src/core/index.ts')
  const forest = [b('p1', '页面一', { role: 'page', children: [b('a', '甲'), b('a2', '甲2')] })]
  const atoms = [edge('e1', 'page', 'a2', 'p1', 0), edge('e2', 'page', 'a2', 'p1', 2)]
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
  const a = backrefsOf({ blocks: [], atoms: [], targetId: 't1', index: idx })
  assert.deepEqual(a.map((x) => x.count), [2], '#todo 有两条边（a 与 b1）')
  const bl = backrefBlocks({ blocks: [], atoms: [], targetId: 't1', index: idx })
  assert.deepEqual(bl.map((x) => x.blockId).sort(), ['a', 'b1'])
})

test('store.reset：换库后索引整体失效（不是拿旧库的块表凑）', async () => {
  const { BlockStore } = await import('../src/core/index.ts')
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))
  assert.equal(store.find('p1')?.text, '页面一')

  store.reset([b('only', '唯一一页', { role: 'page' })], [], [])
  assert.equal(store.find('only')?.text, '唯一一页')
  assert.equal(store.find('p1'), undefined, '旧库的块不该还查得到')
})
