/**
 * **接库门面**（`KbClient` 读 ＋ `tx` 写）的验收。
 *
 * 判据是设计稿 §5 那句：**改一块 ＝ 一条 op**，且 `Op`（承载持久化）与 `Change`
 * （只做失效通知）分家。所以这里断言的几乎都是 op 序列的**精确形状**，
 * 而不是「内存里最后变成了什么」——最后变成什么，现有的 core 单测已经钉住了。
 *
 * ⚠️ 最好的一条是「patch 改 children 必须抛错」：结构若靠 diff 猜，
 *    删掉的整棵后代不会出现在 op 里，落库之后数据就少一截，而且**不报错**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block, Mark, Op } from '../src/core/index.ts'
import { BlockStore, mkBlock, mkPropDef, mkTagBlock } from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { seedWorkspace } from '../src/core/seed.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

/**
 * 一份小而全的库，手造（不依赖 DOM，也不依赖夹具的规模）：
 *   p1 页 ── c1 ── g1
 *        └─ c2
 *   t1 标签块；x1 带 t1 归属、有一处引用 p2 的原子与一段粗体
 */
function fixture(atoms: Atom[] = [], marks: Mark[] = []) {
  const t1 = mkTagBlock('todo')
  t1.id = 't1'
  const p1 = b('p1', '页面一', {
    props: { _aliases: ['页面一'], _lists: ['page'] },
    children: [b('c1', '一', { children: [b('g1', '一·一')] }), b('c2', '二', { props: { _tags: ['t1'] } })],
  })
  const p2 = b('p2', '页面二', { props: { _aliases: ['页面二'], _lists: ['page'] } })
  const store = new BlockStore([p1, p2, t1], marks, atoms, [])
  // 固定的时钟：`at` 可断言，也不会让「同一毫秒内两次写」变成抖动源
  const kb = new MemoryKb(store, { now: () => 1000 })
  return { store, kb, p1, p2, t1 }
}

const ref = (id: string, blockId: string, targetId: string): Atom => ({
  id,
  kind: 'page',
  blockId,
  start: 0,
  end: 1,
  label: '旧名',
  target: { kind: 'page', id: targetId },
})

/** 只取 op 的「语义面」（去掉 `at`），断言才是关于形状而不是关于时钟 */
const bare = (ops: readonly Op[]): unknown[] =>
  ops.map((o) => {
    const { at: _at, ...rest } = o as Op & { at?: number }
    return rest
  })

/* ------------------------------------------------------------ 读面 */

test('读面：get/children/roots/parentOf 按 id 取，不暴露整库', () => {
  const { kb } = fixture()
  assert.equal(kb.get('c1')?.text, '一')
  assert.deepEqual(kb.children('c1').map((x) => x.id), ['g1'])
  assert.deepEqual(kb.roots().map((x) => x.id), ['p1', 'p2', 't1'])
  assert.equal(kb.parentOf('g1')?.id, 'c1')
  assert.equal(kb.parentOf('p1'), undefined)
  assert.deepEqual(kb.pathOf('g1').map((x) => x.id), ['p1', 'c1', 'g1'])
})

test('读面：resolveAlias 走同一套规范化（大小写与空白不影响）', () => {
  const { kb, p1 } = fixture()
  assert.equal(kb.resolveAlias('页面一'), p1)
  assert.equal(kb.resolveAlias('  页面一  '), p1)
  assert.equal(kb.resolveAlias('没有这个'), undefined)
})

test('读面：fieldsOf 是「标签属性 ∪ 块属性」的派生，只转调 core', () => {
  const def = mkPropDef('评分', 'number')
  const tag = mkTagBlock('书')
  tag.id = 'tag1'
  tag.props = { ...tag.props, _fieldDefs: [def.id] }
  const target = b('x1', '一本', { props: { _tags: ['tag1'] } })
  const store = new BlockStore([def, tag, target])
  const kb = new MemoryKb(store)
  assert.deepEqual(kb.fieldsOf('x1').map((r) => r.propId), [def.id])
  assert.equal(kb.fieldsOf('x1')[0]?.filled, false, '没填值是「待填」，不是「没有这一行」')
  assert.deepEqual(kb.fieldsOf('不存在'), [])
})

test('读面：tagsOf 返回标签块活引用（删了标签块 ⇒ 那一格跳过，不造假目标）', () => {
  const { kb } = fixture()
  assert.deepEqual(kb.tagsOf('c2').map((t) => t.id), ['t1'])
  assert.deepEqual(kb.tagsOf('c1'), [])
})

test('读面：annotationsOf 只给这一块的 mark/atom', () => {
  const atoms = [ref('a1', 'p1', 'p2'), ref('a2', 'p2', 'p1')]
  const marks: Mark[] = [{ id: 'm1', type: 'bold', blockId: 'p1', start: 0, end: 2 }]
  const { kb } = fixture(atoms, marks)
  assert.deepEqual(kb.annotationsOf('p1').atoms.map((a) => a.id), ['a1'])
  assert.deepEqual(kb.annotationsOf('p1').marks.map((m) => m.id), ['m1'])
  assert.deepEqual(kb.annotationsOf('p2').marks, [])
})

test('读面：backlinksOf 认原子里的入向边（p2 被 p1 引用）', () => {
  const { kb } = fixture([ref('a1', 'p1', 'p2')])
  const links = kb.backlinksOf('p2')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.pageId, 'p1')
  assert.equal(links[0]?.count, 1)
})

test('夹具上的读面：seedWorkspace 里每一页都能 get 到、别名能解析回自己', () => {
  const ws = seedWorkspace()
  const kb = new MemoryKb(new BlockStore(ws.blocks))
  for (const e of kb.allPaths()) {
    assert.equal(kb.get(e.block.id), e.block, 'allPaths 给的块必须是库里那一块')
    assert.equal(kb.resolveAlias(e.name)?.id, e.block.id)
  }
  assert.ok(kb.allPaths().length > 0)
})

/* ------------------------------------------------------------ 写面：patch */

test('patch 改正文 ⇒ 恰好一条 block.upsert{text} ＋ 一条 blocks change', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      x.text = '改过'
    })
  })
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { text: '改过' } }])
  assert.deepEqual(r.changes, [{ kind: 'blocks', id: 'c1' }])
  assert.equal(kb.get('c1')?.text, '改过')
  assert.equal((r.ops[0] as { at: number }).at, 1000, 'op 带 at')
})

test('patch 改属性 ⇒ prop.set；删属性 ⇒ prop.delete（值不变不动）', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      x.props = { ...(x.props ?? {}), 'prop-a': 1, 'prop-b': 2 }
    })
  })
  assert.deepEqual(bare(r.ops), [
    { e: 'prop', block: 'c1', name: 'prop-a', op: 'set', value: 1 },
    { e: 'prop', block: 'c1', name: 'prop-b', op: 'set', value: 2 },
  ])

  const r2 = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      const next = { ...(x.props ?? {}) }
      delete next['prop-b']
      x.props = next
    })
  })
  assert.deepEqual(bare(r2.ops), [{ e: 'prop', block: 'c1', name: 'prop-b', op: 'delete' }])
})

test('patch 就地改属性数组也算改动（快照要深拷贝）', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.setProp('c1', 'arr', ['a']))
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      ;(x.props!.arr as string[]).push('b')
    })
  })
  assert.deepEqual(bare(r.ops), [{ e: 'prop', block: 'c1', name: 'arr', op: 'set', value: ['a', 'b'] }])
})

test('patch 改 children ⇒ 抛错（结构必须走 insert/move/remove）', () => {
  const { kb, store } = fixture()
  const before = JSON.stringify(store.blocks)
  assert.throws(
    () =>
      kb.tx((tx) => {
        tx.patch('c1', (x) => {
          x.children.push(mkBlock('偷偷塞进去'))
        })
      }),
    /changed children/,
  )
  assert.equal(JSON.stringify(store.blocks), before, '抛错 ⇒ 整批恢复')
})

/* ------------------------------------------------------------ 写面：结构 */

test('insert ⇒ block.upsert{parent,index}（子树里每一块都有落点）', () => {
  const { kb } = fixture()
  const n1 = b('n1', '新', { children: [b('n1a', '新·一')] })
  const r = kb.tx((tx) => tx.insert(n1, 'c1', 0))
  assert.deepEqual(bare(r.ops), [
    { e: 'block', id: 'n1', op: 'upsert', value: { parent: 'c1', index: 0 } },
    { e: 'block', id: 'n1a', op: 'upsert', value: { parent: 'n1', index: 0 } },
  ])
  assert.deepEqual(kb.children('c1').map((x) => x.id), ['n1', 'g1'])
})

test('insert 到根 ⇒ parent 为 null 且落在根数组里', () => {
  const { kb } = fixture()
  const n1 = b('n1', '新的页')
  const r = kb.tx((tx) => tx.insert(n1, null, kb.roots().length))
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'n1', op: 'upsert', value: { parent: null, index: 3 } }])
  assert.equal(kb.roots().at(-1)?.id, 'n1')
})

test('move ⇒ 一条 block.upsert{parent,index}；不能移进自己的子树', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.move('c2', 'c1', 0))
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c2', op: 'upsert', value: { parent: 'c1', index: 0 } }])
  assert.deepEqual(kb.children('c1').map((x) => x.id), ['c2', 'g1'])

  assert.throws(() => kb.tx((tx) => tx.move('c1', 'g1', 0)), /own subtree/)
  assert.deepEqual(kb.children('p1').map((x) => x.id), ['c1'], '失败 ⇒ 位置没动')
})

test('remove ⇒ 子树逐个 block.delete；之后 get 不到、回收站里有整棵', () => {
  const { kb, store } = fixture()
  const r = kb.tx((tx) => tx.remove('c1'))
  assert.deepEqual(bare(r.ops), [
    { e: 'block', id: 'c1', op: 'delete' },
    { e: 'block', id: 'g1', op: 'delete' },
  ])
  assert.deepEqual(
    r.changes.map((c) => c.id),
    ['c1', 'g1'],
  )
  assert.equal(kb.get('c1'), undefined)
  assert.equal(kb.get('g1'), undefined)
  assert.equal(store.trash.length, 1, '删掉的是一整棵子树（内容不丢）')
  assert.ok(store.trash[0]?.props?._deletedAt, '回收站成员带 _deletedAt（与 removeBlock 同形）')
  assert.deepEqual(store.trash[0]?.children.map((x) => x.id), ['g1'])
})

/* ------------------------------------------------------------ 写面：语义列表 */

test('setAliases 的 diff：新增按新序带 pos、删掉的报 delete', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.setAliases('p1', ['页面一', '首页']))
  assert.deepEqual(bare(r.ops), [{ e: 'alias', block: 'p1', name: '首页', op: 'set', pos: 1 }])

  const r2 = kb.tx((tx) => tx.setAliases('p1', ['首页']))
  assert.deepEqual(bare(r2.ops), [
    { e: 'alias', block: 'p1', name: '页面一', op: 'delete' },
    { e: 'alias', block: 'p1', name: '首页', op: 'set', pos: 0 },
  ])
  assert.deepEqual(kb.get('p1')?.props?._aliases, ['首页'])
  assert.equal(kb.resolveAlias('页面一'), undefined, '旧地址不再解析得到')
  assert.equal(kb.resolveAlias('首页')?.id, 'p1')
})

test('setAliases 只换序也报改动（首个是主名），并把新 pos 写出来', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.setAliases('p1', ['页面一', '首页']))
  const r = kb.tx((tx) => tx.setAliases('p1', ['首页', '页面一']))
  assert.equal(r.changes.length, 1, '顺序变化也是改动')
  assert.deepEqual(bare(r.ops), [
    { e: 'alias', block: 'p1', name: '首页', op: 'set', pos: 0 },
    { e: 'alias', block: 'p1', name: '页面一', op: 'set', pos: 1 },
  ])
  assert.deepEqual(kb.get('p1')?.props?._aliases, ['首页', '页面一'])
})

test('setLists 的 diff ⇒ list.set / list.delete（兼位就是两条 set）', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.setLists('p1', ['page', 'tag']))
  assert.deepEqual(bare(r.ops), [{ e: 'list', block: 'p1', list: 'tag', op: 'set' }])

  const r2 = kb.tx((tx) => tx.setLists('p1', ['tag']))
  assert.deepEqual(bare(r2.ops), [{ e: 'list', block: 'p1', list: 'page', op: 'delete' }])
  assert.deepEqual(kb.get('p1')?.props?._lists, ['tag'])
})

test('setTags 的 diff ⇒ 一条 prop.set(_tags)；摘干净时属性槽不留空壳', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.setTags('c1', ['t1']))
  assert.deepEqual(bare(r.ops), [{ e: 'prop', block: 'c1', name: '_tags', op: 'set', value: ['t1'] }])

  const r2 = kb.tx((tx) => tx.setTags('c1', []))
  assert.deepEqual(bare(r2.ops), [{ e: 'prop', block: 'c1', name: '_tags', op: 'set', value: [] }])
  assert.equal(kb.get('c1')?.props?._tags, undefined, '空数组不留：空与没有不能有两份答案')
})

test('setTags 没变化 ⇒ 零 op、零 change', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.setTags('c2', ['t1']))
  assert.deepEqual(r.ops, [])
  assert.deepEqual(r.changes, [])
})

/* ------------------------------------------------------------ 写面：锚点 */

test('setAnnotations 按 id diff：新增 set、删掉 delete、不变的静默', () => {
  const a1 = ref('a1', 'p1', 'p2')
  const a2 = ref('a2', 'p1', 'p2')
  const { kb } = fixture([a1], [{ id: 'm1', type: 'bold', blockId: 'p1', start: 0, end: 1 }])

  const r = kb.tx((tx) => tx.setAnnotations('p1', [], [a1, a2]))
  assert.deepEqual(bare(r.ops), [
    { e: 'anno', block: 'p1', id: 'm1', op: 'delete', value: { id: 'm1', type: 'bold', blockId: 'p1', start: 0, end: 1 } },
    { e: 'anno', block: 'p1', id: 'a2', op: 'set', value: a2 },
  ])
  assert.deepEqual(r.changes, [
    { kind: 'marks', id: 'p1' },
    { kind: 'atoms', id: 'p1' },
  ])
  assert.deepEqual(kb.annotationsOf('p1').atoms.map((a) => a.id), ['a1', 'a2'])
})

test('setAnnotations 只动这一块：别的块的锚点原样在库里', () => {
  const other = ref('a9', 'p2', 'p1')
  const { kb } = fixture([other])
  kb.tx((tx) => tx.setAnnotations('p1', [], [ref('a1', 'p1', 'p2')]))
  assert.deepEqual(kb.annotationsOf('p2').atoms.map((a) => a.id), ['a9'])
})

/* ------------------------------------------------------------ 事务 */

test('tx 抛错 ⇒ 内存恢复、索引可用、不返回半批', () => {
  const { kb, store } = fixture([ref('a1', 'p1', 'p2')])
  const before = JSON.stringify({ blocks: store.blocks, atoms: store.atoms, trash: store.trash })
  let delivered = false
  assert.throws(
    () =>
      kb.tx((tx) => {
        tx.patch('c1', (x) => {
          x.text = '改了一半'
        })
        tx.setTags('c1', ['t1'])
        tx.remove('p2')
        throw new Error('校验没通过')
      }),
    /校验没通过/,
  )
  assert.equal(delivered, false, '抛错时根本拿不到返回值')
  assert.equal(
    JSON.stringify({ blocks: store.blocks, atoms: store.atoms, trash: store.trash }),
    before,
    '正文/标签/删除全部回滚',
  )
  // 恢复之后索引必须重建过：反链还查得到（回滚不能把索引留在坏状态上）
  assert.equal(kb.backlinksOf('p2')[0]?.pageId, 'p1')
  assert.equal(kb.get('c1')?.text, '一')
})

test('tx 里改两次同一块 ⇒ change 去重，op 各自成条', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      x.text = '甲'
    })
    tx.patch('c1', (x) => {
      x.text = '乙'
    })
  })
  assert.equal(r.ops.length, 2)
  assert.deepEqual(r.changes, [{ kind: 'blocks', id: 'c1' }])
})

test('tx 只改锚点也把块 id 推给订阅者', () => {
  const { kb, store } = fixture()
  const seen: (readonly string[] | undefined)[] = []
  store.subscribe((_s, ids) => seen.push(ids))
  kb.tx((tx) => tx.setAnnotations('c1', [], [ref('a1', 'c1', 'p2')]))
  assert.deepEqual(seen, [['c1']], '只有 marks/atoms change 时也不能把 ids 传成空数组')
})

test('tx 成功会 touch 订阅者并带上动过的块 id', () => {
  const { kb, store } = fixture()
  const seen: (readonly string[] | undefined)[] = []
  store.subscribe((_s, ids) => seen.push(ids))
  kb.tx((tx) => tx.setTags('c1', ['t1']))
  assert.deepEqual(seen, [['c1']])
})
