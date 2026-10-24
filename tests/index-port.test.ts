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
import {
  applyOps,
  fingerprint,
  findJournalDay,
  incomingCount,
  incomingIds,
  journalIdByDate,
  lookupBlock,
  rebuild,
  tagIdByName,
  tagMemberIdsOf,
  type Index,
} from '../src/core/index.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { Tx } from '../src/core/kb/types.ts'

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

/**
 * **op 驱动的等式断言**：在真 `MemoryKb` 上跑一笔 tx，把这批 op 喂给 `applyOps`，
 * 每批之后与「当前库的全量重建」比指纹——两条路径必须逐字节一致。
 */
function txStep(kb: MemoryKb, store: BlockStore, idx: Index, fn: (tx: Tx) => void): Index {
  const r = kb.tx(fn, {})
  const next = applyOps(idx, r.ops, store.blocks, store.atoms)
  assert.equal(
    fingerprint(next),
    fingerprint(rebuild(store.blocks, store.atoms)),
    `这批 op（${r.ops.length} 条）走增量后必须与全量重建逐字节一致`,
  )
  return next
}

/** 从 fixture 起一套真库（BlockStore ＋ MemoryKb ＋ 初始索引） */
function kbFixture() {
  const { forest, atoms } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify(forest)), [], JSON.parse(JSON.stringify(atoms)))
  const kb = new MemoryKb(store)
  return { store, kb, idx: rebuild(store.blocks, store.atoms) }
}

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

/* ------------------------------------------------------------ 那条等式（op 驱动） */

test('等式：改标签名走 tx ⇒ 名字表换主，旧名字不残留', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.setAliases('t1', ['待办'])
  })
  assert.equal(tagIdByName(next, '待办'), 't1')
  assert.equal(tagIdByName(next, 'todo'), undefined, '旧名字必须摘掉（增量最容易漏的就是它）')
})

test('等式：删子树走 tx ⇒ 块/归属/名字/父页一起退场', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.remove('b') // 它带着 b1；a/b1 都打了 #todo ⇒ 成员表要收掉
  })
  assert.equal(lookupBlock(next, 'b'), undefined)
  assert.equal(lookupBlock(next, 'b1'), undefined, '子树里的块不该还在')
  assert.deepEqual(tagMemberIdsOf(next, 't1'), ['a'], 'b1 的归属一起收掉')
})

test('等式：删掉先序认领者后，同名词块接手（heir 规则）', () => {
  const { store, kb, idx } = kbFixture()
  let idx2 = txStep(kb, store, idx, (tx) => {
    tx.insert(b('t3', 'todo', { props: { _aliases: ['todo'], _lists: ['tag'] } }), null, store.blocks.length)
  })
  assert.equal(tagIdByName(idx2, 'todo'), 't1', '先序第一个认领者赢')
  idx2 = txStep(kb, store, idx2, (tx) => {
    tx.remove('t1')
  })
  assert.equal(tagIdByName(idx2, 'todo'), 't3', '认领者退场后名字要有人接手')
  assert.equal(lookupBlock(idx2, 't1'), undefined)
})

test('等式：移动子树走 tx ⇒ pageOf 全子树重打', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.move('b', 'p2', 0)
  })
  assert.equal(lookupBlock(next, 'b1'), store.find('b1'))
  // pageOf 已由等式断言兜底；这里点一句「跟着新顶层走」的可读出口
  assert.equal(next.pageOf.get('b1'), 'p2')
})

test('等式：插入带归属的新块走 tx ⇒ 块/成员/父页一起进场', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.insert(b('fresh', '新块', { props: { _tags: ['t1'] } }), 'p2', 0)
  })
  assert.equal(lookupBlock(next, 'fresh')?.text, '新块')
  assert.deepEqual(tagMemberIdsOf(next, 't1').sort(), ['a', 'b1', 'fresh'])
  assert.equal(next.pageOf.get('fresh'), 'p2')
})

test('等式：改归属走 tx ⇒ 成员表跟着搬（不碰名字表）', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.setTags('a', [])
    tx.setTags('c', ['t1'])
  })
  assert.deepEqual(tagMemberIdsOf(next, 't1').sort(), ['b1', 'c'])
})

test('等式：引用改向走 tx ⇒ 旧边摘掉、新边算上（簿记要记得旧指向）', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    // e1 原来指向 p1（源块 c）⇒ 同一条引用改成指向 p2
    tx.setAnnotations('c', [], [edge('e1', 'c', 'p2')])
  })
  assert.deepEqual(incomingIds(next, 'p1'), [], '旧指向必须摘干净')
  assert.equal(incomingCount(next, 'p2', 'c'), 1, '新指向算上')
  assert.equal(incomingCount(next, 'p2', 'a'), 1, '别人的边不受影响')
})

test('等式：删引用走 tx ⇒ 边退场（delete op 带着旧值）', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.setAnnotations('c', [], [])
  })
  assert.deepEqual(incomingIds(next, 'p1'), [])
})

test('等式：纯正文补丁走 tx ⇒ 五张表都不动（结构没有变）', () => {
  const { store, kb, idx } = kbFixture()
  const before = { blocks: idx.blocks, incoming: idx.incoming, tags: idx.tags, journals: idx.journals, pageOf: idx.pageOf }
  const next = txStep(kb, store, idx, (tx) => {
    tx.patch('a', (x) => {
      x.text = '甲改了字'
    })
  })
  assert.equal(next.blocks, before.blocks)
  assert.equal(next.incoming, before.incoming)
  assert.equal(next.tags, before.tags)
  assert.equal(next.journals, before.journals)
  assert.equal(next.pageOf, before.pageOf)
})

test('等式：一串混合 tx 累积（改名/移动/插入/引用/删除）⇒ 每步都与全量一致', () => {
  const { store, kb, idx } = kbFixture()
  let cur = idx
  cur = txStep(kb, store, cur, (tx) => {
    tx.setAliases('t1', ['待办'])
  })
  cur = txStep(kb, store, cur, (tx) => {
    tx.move('b', 'p2', 0)
  })
  cur = txStep(kb, store, cur, (tx) => {
    tx.insert(b('p3', '页面三', { props: { _aliases: ['页面三'], _lists: ['page'] } }), null, store.blocks.length)
  })
  cur = txStep(kb, store, cur, (tx) => {
    tx.setAnnotations('c', [], [edge('e9', 'c', 'p3')])
  })
  cur = txStep(kb, store, cur, (tx) => {
    tx.remove('p1')
  })
  assert.equal(
    fingerprint(cur),
    fingerprint(rebuild(store.blocks, store.atoms)),
    '一连串 tx 之后增量仍与全量逐字节一致',
  )
})

test('applyOps：空 op ⇒ 原样返回（不是「重建一遍」）', () => {
  const { store, idx } = kbFixture()
  assert.equal(applyOps(idx, [], store.blocks, store.atoms), idx, '没有变化就别重算')
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

/* ------------------------------------------------------------ op 流的边界 */

/**
 * op 是**事实陈述**，不是「必须可执行」的指令：流里出现一个既不在索引、也不在森林的 id
 * （比如同一批里先删后又被上游去重漏掉的），跳过它即可——等式断言会抓任何因此的分叉。
 */
test('applyOps：流里引用不存在的块 ⇒ 跳过该 op（索引不退化也不报错）', () => {
  const { store, idx } = kbFixture()
  const next = applyOps(
    idx,
    [
      { e: 'block', id: '不存在的块', op: 'delete', at: 1 },
      { e: 'prop', block: '也不存在', name: '_tags', op: 'set', value: [], at: 2 },
    ],
    store.blocks,
    store.atoms,
  )
  assert.equal(fingerprint(next), fingerprint(idx), '无效 op 不该改变任何东西')
  assert.equal(next, idx, '没有可修补的东西就别换对象')
})

test('applyOps：只有引用边变化 ⇒ 其它四张表是同一个引用（真的没被重建）', () => {
  const { store, kb, idx } = kbFixture()
  const next = txStep(kb, store, idx, (tx) => {
    tx.setAnnotations('c', [], [...store.atoms.filter((a) => a.blockId === 'c'), edge('e7', 'c', 't2')])
  })
  assert.equal(next.blocks, idx.blocks, '块表原样保留（活引用不换）')
  assert.equal(next.tags, idx.tags, '名字表原样保留')
  assert.equal(next.pageOf, idx.pageOf, '父页表原样保留')
  assert.equal(next.tagMembers, idx.tagMembers, '标签成员来自块 ⇒ 锚点变了不用重算')
  assert.deepEqual(incomingIds(next, 't2'), ['c'], '新边要算进来')
})
