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
import type { Block } from '../src/core/index.ts'
import type { Op } from '../src/core/kb/types.ts'
import { BlockStore, fingerprint, mkBlock, mkPropDef, mkTagBlock, rebuild, setValue, TASK_STATUS_PROP_ID, writeBlockContent } from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { seedWorkspace } from '../src/core/seed.ts'
import { plainText, textRuns, type Anno, type RefRun } from '../src/core/runs.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, content: textRuns(text), children: [], ...extra })

/**
 * 一份小而全的库，手造（不依赖 DOM，也不依赖夹具的规模）：
 *   p1 页 ── c1 ── g1
 *        └─ c2
 *   t1 标签块
 *
 * `p1RefTo` 给定 ⇒ p1 的内容里带一枚指向它的引用 run（指向边住在源块内容里）。
 */
function fixture(p1RefTo?: string) {
  const t1 = mkTagBlock('todo')
  t1.id = 't1'
  const p1 = b('p1', '页面一', {
    props: { _aliases: ['页面一'], _lists: ['page'] },
    children: [b('c1', '一', { children: [b('g1', '一·一')] }), b('c2', '二', { props: { _tags: ['t1'] } })],
  })
  if (p1RefTo) p1.content.push(refRun('a1', p1RefTo))
  const p2 = b('p2', '页面二', { props: { _aliases: ['页面二'], _lists: ['page'] } })
  const store = new BlockStore([p1, p2, t1])
  // 固定的时钟：`at` 可断言，也不会让「同一毫秒内两次写」变成抖动源
  const kb = new MemoryKb(store, { now: () => 1000 })
  return { store, kb, p1, p2, t1 }
}

/** 一枚引用 run（挂在源块内容里） */
const refRun = (id: string, to: string): RefRun => ({ id, t: 'ref', to, label: '旧名' })

/** 一条可引用区间（按需物化；range 用 plain 坐标） */
const anno = (id: string): Anno => ({ id, range: { start: 0, end: 2 }, quote: { exact: '页面', prefix: '', suffix: '' } })

/** 只取 op 的「语义面」（去掉 `at`），断言才是关于形状而不是关于时钟 */
const bare = (ops: readonly Op[]): unknown[] =>
  ops.map((o) => {
    const { at: _at, ...rest } = o as Op & { at?: number }
    return rest
  })

/* ------------------------------------------------------------ 读面 */

test('读面：get/children/roots/parentOf 按 id 取，不暴露整库', () => {
  const { kb } = fixture()
  assert.equal(plainText(kb.get('c1')!.content), '一')
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

test('读面：propDefs 给全库定义（含嵌在子树里的），顺序是先序', () => {
  const def1 = mkPropDef('评分', 'number')
  const def2 = mkPropDef('作者', 'text')
  // 定义块嵌在页的子块里：它仍然是全库定义（先序），不能因为位置而漏掉
  const page = b('pg', '页', { props: { _aliases: ['页'], _lists: ['page'] }, children: [def1] })
  const store = new BlockStore([page, def2])
  const kb = new MemoryKb(store)
  assert.deepEqual(kb.propDefs().map((d) => d.id), [def1.id, def2.id])
  assert.equal(kb.propDefs()[0], def1, '给的是库里那一块本身，不是拷贝')
})

test('读面：declaredFieldsOf 按声明顺序解析、悬空 ref 跳过、没声明就是空', () => {
  const def1 = mkPropDef('评分', 'number')
  const def2 = mkPropDef('作者', 'text')
  const page = b('pg', '页', { props: { _aliases: ['页'], _lists: ['page'], _fieldDefs: [def2.id, 'dangling', def1.id] } })
  const store = new BlockStore([page, def1, def2])
  const kb = new MemoryKb(store)
  // 解析不到的定义**跳过**而不是占位：悬空 ref 是状态，面板不该画一行空定义
  assert.deepEqual(kb.declaredFieldsOf('pg').map((d) => d.id), [def2.id, def1.id])
  assert.deepEqual(kb.declaredFieldsOf(def1.id), [], '自己没声明就是空，不是「全库定义」')
  assert.deepEqual(kb.declaredFieldsOf('不存在'), [], '未知块不是「全库定义」，也不该抛')
})

test('读面：annosOf 只给这一块的 annos；没有就是空（按需物化）', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.setAnnos('p1', [anno('q1')]))
  assert.deepEqual(kb.annosOf('p1').map((a) => a.id), ['q1'])
  assert.deepEqual(kb.annosOf('p2'), [])
  // 摘干净 ⇒ 回到「没有这一格」，不是空数组常驻
  kb.tx((tx) => tx.setAnnos('p1', []))
  assert.deepEqual(kb.annosOf('p1'), [])
})

test('读面：backlinksOf 认内容里的引用 run（p2 被 p1 引用）', () => {
  const { kb } = fixture('p2')
  const links = kb.backlinksOf('p2')
  assert.equal(links.length, 1)
  assert.equal(links[0]?.rootId, 'p1')
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

test('patch 改内容 ⇒ 恰好一条 block.upsert{content} ＋ 一条 blocks change', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      writeBlockContent(x, textRuns('改过'))
    })
  })
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { content: textRuns('改过') } }])
  assert.deepEqual(r.changes, [{ kind: 'blocks', id: 'c1' }])
  assert.equal(plainText(kb.get('c1')!.content), '改过')
  assert.equal((r.ops[0] as { at: number }).at, 1000, 'op 带 at')
})

test('patch 改内容 ＋ 时刻 ⇒ **仍然一条** upsert{content, modified}（时刻并进去，不发第二条）', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      writeBlockContent(x, textRuns('改过'))
      x.modified = 2000
    })
  })
  // 一条账：时刻是这次改动的属性，不是第二件事
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { content: textRuns('改过'), modified: 2000 } }])
  assert.deepEqual(r.changes, [{ kind: 'blocks', id: 'c1' }])
  assert.equal(kb.get('c1')!.modified, 2000)
})

test('patch 只改时刻（换位置/缩进）⇒ 一条 upsert{content, modified}，不带属性', () => {
  // 写路径按设计总是带上正文（它就是这一块的正文槽），所以这里断言的是
  // 「**只有一条**、且属性袋没被牵进来」，而不是「正文那一格不出现」。
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.patch('c1', (x) => (x.modified = 3000)))
  assert.equal(r.ops.length, 1)
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { content: textRuns('一'), modified: 3000 } }])
})

test('patch 什么都没变 ⇒ 零 op（幂等的边界不该产账）', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => tx.patch('c1', (x) => (x.modified = x.modified)))
  assert.deepEqual(bare(r.ops), [])
})

test('patch 改属性 ⇒ prop.set 照旧；写属性值顺带记时刻 ⇒ 一条 upsert{modified} ＋ 一条 prop.set', () => {
  const { kb } = fixture()
  // 先取一个**早于这次写**的时刻当基准（事务是就地改活块的，事后再读会读到同一个对象）
  kb.tx((tx) => tx.patch('c1', (x) => (x.modified = 1)))
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => setValue(x, TASK_STATUS_PROP_ID, true))
  })
  const now = kb.get('c1')!.modified
  assert(now > 1, `写值必须刷新时刻：1 → ${now}`)
  assert.deepEqual(bare(r.ops), [
    { e: 'block', id: 'c1', op: 'upsert', value: { content: textRuns('一'), modified: now } },
    { e: 'prop', block: 'c1', name: TASK_STATUS_PROP_ID, op: 'set', value: true },
  ])
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

test('move 报的 index 是**最终位置**（先摘再夹）：越界时不会报一个落不下去的下标', () => {
  const { kb } = fixture()
  // p1.children = [c1, c2]；把 c1 挪到越界下标 ⇒ 最终在末尾（1），op 也必须报 1
  const r = kb.tx((tx) => tx.move('c1', 'p1', 9))
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { parent: 'p1', index: 1 } }])
  assert.deepEqual(kb.children('p1').map((x) => x.id), ['c2', 'c1'])

  const back = kb.tx((tx) => tx.move('c1', 'p1', 0))
  assert.deepEqual(bare(back.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { parent: 'p1', index: 0 } }])
  assert.deepEqual(kb.children('p1').map((x) => x.id), ['c1', 'c2'])
})

test('remove ⇒ 原位软删：操作根恰好 1 条 block.delete；get 不到、块带标记留在森林原位（子树完整）', () => {
  const { kb, store } = fixture()
  const r = kb.tx((tx) => tx.remove('c1'))
  // op 只落操作根：子树的不可见是继承来的，后代不各报一条（落库也是一行的事）
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'delete' }])
  assert.deepEqual(r.changes.map((c) => c.id), ['c1'])
  assert.equal(kb.get('c1'), undefined, '可见遍历看不见它')
  assert.equal(kb.get('g1'), undefined, '整棵子树都看不见')
  // 块仍在森林里（原位），带删除标记、子树完整——回收站是标记的派生视图
  //（store.blocks 是顶层数组，c1 嵌在 p1 下面 ⇒ 递归找）
  let dead: Block | undefined
  const walk = (list: Block[]): void => {
    for (const x of list) {
      if (x.id === 'c1') dead = x
      walk(x.children)
    }
  }
  walk(store.blocks)
  assert.ok(dead, '被删的块应留在森林原位（原位软删，不是摘出去）')
  assert.ok(dead.props?._deletedAt, '删除标记在块上')
  assert.deepEqual(dead.children.map((x) => x.id), ['g1'], '子树完整（恢复时原样接回）')
  assert.deepEqual(kb.trash().map((b) => b.id), ['c1'], '派生回收站里是操作根')
})

test('restore ⇒ 摘掉标记回原位：op 是一条 upsert{parent,index}；整棵子树重新可见', () => {
  const { kb, store } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  const r = kb.tx((tx) => tx.restore('c1'))
  // c1 是 p1 的第 0 个孩子；恢复 = 「它回来了、还在这个位置」
  assert.deepEqual(bare(r.ops), [{ e: 'block', id: 'c1', op: 'upsert', value: { parent: 'p1', index: 0 } }])
  assert.equal(plainText(kb.get('c1')!.content), '一')
  assert.equal(plainText(kb.get('g1')!.content), '一·一', '子树随根一起回来')
  assert.deepEqual(kb.trash(), [], '派生回收站清空')
  assert.ok(!store.blocks.find((b) => b.id === 'c1')?.props?._deletedAt, '标记已摘掉')
  // 再删再恢复也成立（幂等的机制，不是一次性的状态机）
  kb.tx((tx) => tx.remove('c1'))
  assert.deepEqual(kb.trash().map((b) => b.id), ['c1'])
  kb.tx((tx) => tx.restore('c1'))
  assert.equal(plainText(kb.get('c1')!.content), '一')
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

/* ------------------------------------------------------------ 写面：annos */

test('setAnnos 按 id diff：新增 set、删掉 delete、不变的静默', () => {
  const q1 = anno('q1')
  const q2 = anno('q2')
  const { kb } = fixture()
  kb.tx((tx) => tx.setAnnos('p1', [q1]))

  const r = kb.tx((tx) => tx.setAnnos('p1', [q1, q2]))
  assert.deepEqual(bare(r.ops), [{ e: 'anno', block: 'p1', id: 'q2', op: 'set', value: q2 }])
  assert.deepEqual(r.changes, [{ kind: 'annos', id: 'p1' }])

  const r2 = kb.tx((tx) => tx.setAnnos('p1', [q2]))
  assert.deepEqual(bare(r2.ops), [{ e: 'anno', block: 'p1', id: 'q1', op: 'delete', value: q1 }])
  assert.deepEqual(kb.annosOf('p1').map((a) => a.id), ['q2'])
})

test('setAnnos 只动这一块：别的块的 annos 原样在库里', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.setAnnos('p2', [anno('q9')]))
  kb.tx((tx) => tx.setAnnos('p1', [anno('q1')]))
  assert.deepEqual(kb.annosOf('p2').map((a) => a.id), ['q9'])
})

/* ------------------------------------------------------------ 事务 */

test('tx 抛错 ⇒ 内存恢复、索引可用、不返回半批', () => {
  const { kb, store } = fixture('p2')
  const before = JSON.stringify(store.blocks)
  let delivered = false
  assert.throws(
    () =>
      kb.tx((tx) => {
        tx.patch('c1', (x) => {
          writeBlockContent(x, textRuns('改了一半'))
        })
        tx.setTags('c1', ['t1'])
        tx.remove('p2')
        throw new Error('校验没通过')
      }),
    /校验没通过/,
  )
  assert.equal(delivered, false, '抛错时根本拿不到返回值')
  assert.equal(JSON.stringify(store.blocks), before, '内容/标签/删除全部回滚')
  // 恢复之后索引必须重建过：反链还查得到（回滚不能把索引留在坏状态上）
  assert.equal(kb.backlinksOf('p2')[0]?.rootId, 'p1')
  assert.equal(plainText(kb.get('c1')!.content), '一')
})

test('tx 里改两次同一块 ⇒ change 去重，op 各自成条', () => {
  const { kb } = fixture()
  const r = kb.tx((tx) => {
    tx.patch('c1', (x) => {
      writeBlockContent(x, textRuns('甲'))
    })
    tx.patch('c1', (x) => {
      writeBlockContent(x, textRuns('乙'))
    })
  })
  assert.equal(r.ops.length, 2)
  assert.deepEqual(r.changes, [{ kind: 'blocks', id: 'c1' }])
})

test('tx 只改 annos 也把块 id 推给订阅者', () => {
  const { kb, store } = fixture()
  const seen: (readonly string[] | undefined)[] = []
  store.subscribe((_s, ids) => seen.push(ids))
  kb.tx((tx) => tx.setAnnos('c1', [anno('q1')]))
  assert.deepEqual(seen, [['c1']], '只有 annos change 时也不能把 ids 传成空数组')
})

test('tx 成功会 touch 订阅者并带上动过的块 id', () => {
  const { kb, store } = fixture()
  const seen: (readonly string[] | undefined)[] = []
  store.subscribe((_s, ids) => seen.push(ids))
  kb.tx((tx) => tx.setTags('c1', ['t1']))
  assert.deepEqual(seen, [['c1']])
})

test('tx 的 opts.source 原样转给订阅者（发起者据此跳过自己的重渲染）', () => {
  const { kb, store } = fixture()
  const me = { name: 'main-editor' }
  const seen: unknown[] = []
  store.subscribe((source) => seen.push(source))
  kb.tx((tx) => tx.setTags('c1', ['t1']), { source: me })
  assert.deepEqual(seen, [me], '不传 source 时是 undefined —— 传了就必须是**同一个**对象')
  // 不传 ≠ 传 undefined：两条路径都要能被订阅者区分出来（默认仍是「没发起者」）
  kb.tx((tx) => tx.setTags('c1', []))
  assert.deepEqual(seen, [me, undefined])
})

test('索引随 tx 增量修补：任意一批写之后，增量结果与全量重建逐字节一致', () => {
  const { kb, store } = fixture()
  const added = mkBlock('新块')
  // 一串覆盖全部 op 形态的写：正文 / 属性 / 别名 / 露面 / 归属 / 日期 / 锚点 / 插入 / 移动 / 删除
  const writes: ((tx: Parameters<Parameters<typeof kb.tx>[0]>[0]) => void)[] = [
    (tx) => tx.patch('c1', (b) => { writeBlockContent(b, textRuns('改过的正文')) }),
    (tx) => tx.setProp('c1', '_date', '2026-10-24'),
    (tx) => tx.setAliases('p2', ['页面二', '别名二']),
    (tx) => tx.setLists('c1', ['page']),
    (tx) => tx.setTags('c2', ['t1', 't1']),
    // 内容里加一枚引用 run：指向边的增量修补必须跟着走（全量重建会重扫内容）
    (tx) => tx.patch('c1', (b) => { writeBlockContent(b, [...b.content, refRun('a9', 'p2')]) }),
    (tx) => tx.setAnnos('c1', [anno('q1')]),
    (tx) => tx.insert(added, 'p1', 1),
    (tx) => tx.move('c2', 'p1', 0),
    (tx) => tx.remove('g1'),
  ]
  for (const [i, write] of writes.entries()) {
    // 修补必须**就地**：tx 之前拿到的那份索引对象，tx 之后还是同一个（作废重建会换对象——
    // 那会让每次写入都退化成全量重建，等式却照样是绿的，所以这里连身份一起断言）
    const before = store.index
    kb.tx(write)
    assert.equal(store.index, before, `第 ${i + 1} 笔写之后：索引应被就地修补，而不是作废重建`)
    const incremental = fingerprint(store.index)
    store.invalidateIndex()
    const full = fingerprint(store.index)
    assert.equal(incremental, full, `第 ${i + 1} 笔写之后：索引增量修补必须与全量重建一致`)
  }
  // tx 之后不作废索引：刚插入的块**不经重建**就在索引里（否则每次写都退化成全量重建）
  assert.equal(store.index.blocks.has(added.id), true)
})
