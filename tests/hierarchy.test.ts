/**
 * **归属边（`props._belongsTo`）**：一条边、六个读法。
 *
 * 这一份钉住模型层的四条判据（每一条都对应一个写错过的版本）：
 *   · 一条边、不分 kind：父的身份（页/标签露面）是可变的，不能拿来分类；
 *   · **不设端点约束**：内容块也能当上级；露面不当前置条件（`removeList` 不会追溯失效）；
 *   · **悬空两态**：上级在回收站 ≠ 上级真没了——前者清不掉（复活要自愈）；
 *   · **归属树的根要重算**：父被露出面筛掉时，子升级为根（否则节点从树里消失）。
 *
 * 另钉住「算作做、字段继承不做」：只打 `#演员` 的块出现在 `#人物` 的成员里，
 * 但它的属性区**没有** `#人物` 的字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  ancestorIds,
  appendEdge,
  belongsToTree,
  buildAdjacency,
  checkEdge,
  childrenIn,
  danglingOf,
  descendantIds,
  declareField,
  fieldIdsOf,
  mkPropDef,
  mkTagBlock,
  parentIdsOf,
  parentsOf,
  pruneGone,
  removeEdge,
  type ForestWalker,
} from '../src/core/index.ts'
import { membersOf } from '../src/core/tag-tree.ts'
import { walkForest } from '../src/core/walk.ts'
import { DELETED_AT_PROP } from '../src/core/model.ts'

/** 给块打一个标签（归属在块上：`props._tags`） */
const tagBlock = (block: Block, tagId: string): void => {
  block.props = { ...(block.props ?? {}), _tags: [tagId] }
}

/** 带名字的块（名字只是地址，测试里用它认人） */
function named(id: string, name: string, lists: ('page' | 'tag')[] = []): Block {
  const b = mkTagBlock(name)
  b.id = id
  b.props = lists.length > 0 ? { _aliases: [name], _lists: lists } : { _aliases: [name] }
  return b
}

const tag = (id: string, name: string): Block => named(id, name, ['tag'])
const page = (id: string, name: string): Block => named(id, name, ['page'])
const plain = (id: string, name: string): Block => named(id, name)

/** 加一条边（测试里直接写模型，不经命令层） */
function edge(child: Block, parent: Block): void {
  appendEdge(child, parent)
}

function tree(): { forest: Block[]; people: Block; actor: Block; artist: Block; director: Block } {
  const people = tag('people', '人物')
  const actor = tag('actor', '演员')
  const artist = tag('artist', '艺术家')
  const director = tag('director', '导演')
  const forest: Block[] = [people, actor, artist, director]
  edge(actor, people)
  edge(actor, artist)
  edge(director, people)
  return { forest, people, actor, artist, director }
}

/* ------------------------------------------------------------ 建表（第 0 步的退出判据） */

test('buildAdjacency 对森林只走一遍（注入的 walker 计数 = 1）', () => {
  const { forest } = tree()
  let calls = 0
  const counting: ForestWalker = (...args) => {
    calls++
    walkForest(...args)
  }
  buildAdjacency(forest, counting)
  assert.equal(calls, 1, '两张表必须一遍建完：走两遍就是两倍 O(n)，且两遍之间可以不一致')
})

test('建表：活块表、反向索引、以及「解析得到」的集合（含被删的）', () => {
  const { forest, people, actor, director } = tree()
  const adj = buildAdjacency(forest)
  assert.equal(adj.blocks.length, 4)
  assert.equal(adj.byId.get('actor'), actor)
  assert.deepEqual([...(adj.kids.get(people.id) ?? [])], ['actor', 'director'], '反向索引按森林先序')
  assert.ok(adj.present.has('actor'), '活块也在 present 里')

  // 软删一个父：它从活块表消失，但仍「解析得到」——悬空两态就差这一格
  people.props = { ...(people.props ?? {}), [DELETED_AT_PROP]: Date.now() }
  const after = buildAdjacency(forest)
  assert.equal(after.byId.has(people.id), false, '被软删的块不进活块表（它的子树也一起不可见）')
  assert.ok(after.present.has(people.id), '但它还在森林里（回收站）')
  assert.equal(after.blocks.length, 3, '整棵被删子树不进活块表')
})

/* ------------------------------------------------------------ 一条边、两个方向 */

test('① 多父：成员按每个父都能查到；兄弟方向不串味', () => {
  const { forest, people, actor, artist, director } = tree()
  const x = plain('x', '演员甲')
  const y = plain('y', '只属于艺术家')
  const z = plain('z', '直接打人物')
  forest.push(x, y, z)
  tagBlock(x, actor.id)
  tagBlock(y, artist.id)
  tagBlock(z, people.id)
  assert.ok(membersOf(people.id, forest).has('x'), '#人物 含 #演员 的成员（算作）')
  assert.ok(membersOf(artist.id, forest).has('x'), '#艺术家 也含它（多父）')
  assert.ok(membersOf(people.id, forest).has('z'), '直接打父标签的块也在')
  assert.ok(!membersOf(people.id, forest).has('y'), '不串味：只属于 #艺术家（兄弟）的块不进 #人物')
  assert.ok(!membersOf(director.id, forest).has('x'), '不串味：只属于 #演员 的块不该进 #导演')
})

test('② 多子：#人物 同时含 #演员、#导演 的成员', () => {
  const { forest, people, actor, director } = tree()
  const a = plain('a', '演员甲')
  const d = plain('d', '导演甲')
  forest.push(a, d)
  tagBlock(a, actor.id)
  tagBlock(d, director.id)
  const members = membersOf(people.id, forest)
  assert.ok(members.has('a') && members.has('d'))
})

test('③ 菱形去重：祖先闭包 = {B, C, D}，D 只一次；后代闭包对称', () => {
  const A = tag('A', 'A')
  const B = tag('B', 'B')
  const C = tag('C', 'C')
  const D = tag('D', 'D')
  const forest = [A, B, C, D]
  edge(A, B)
  edge(A, C)
  edge(B, D)
  edge(C, D)
  const adj = buildAdjacency(forest)
  assert.deepEqual([...ancestorIds('A', adj)].sort(), ['B', 'C', 'D'])
  assert.equal(ancestorIds('A', adj).size, 3)
  assert.deepEqual([...descendantIds('D', adj)].sort(), ['A', 'B', 'C', 'D'], '含自己')
})

test('④ 禁环：写入时拒绝，并给出循环路径（不靠读时兜底）', () => {
  const A = tag('A', 'A')
  const B = tag('B', 'B')
  const forest = [A, B]
  assert.equal(checkEdge(A, B, buildAdjacency(forest)).ok, true)
  edge(A, B) // A 属于 B
  const r = checkEdge(B, A, buildAdjacency(forest)) // 再把 B 属于 A ⇒ 环
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cycle')
  assert.ok(r.path && r.path.includes('A') && r.path.includes('B'), JSON.stringify(r))
  assert.deepEqual(parentIdsOf(B), [], '被拒绝的写入不能留下半截状态')
})

test('④b 自己属于自己也被拒绝', () => {
  const A = tag('A', 'A')
  assert.equal(checkEdge(A, A, buildAdjacency([A])).reason, 'self')
})

test('⑤ 边存在子块上：「包含」是反向读法，不设第二条边', () => {
  const { forest, people, actor } = tree()
  assert.deepEqual(parentIdsOf(actor), [people.id, 'artist'], '多父：子块上两条 ref（按添加顺序）')
  assert.equal(parentIdsOf(people).length, 0, '父侧不存子列表')
  assert.ok(!('_childTags' in (people.props ?? {})), '没有第二条边')
  assert.deepEqual(childrenIn(people.id, buildAdjacency(forest)).map((t) => t.id).sort(), ['actor', 'director'])
})

/* ------------------------------------------------------------ 端点不设约束（判据 1） */

test('内容块也能当上级：模型只问「这条边对不对」，不问「它该不该有」', () => {
  const A = plain('A', '一段普通内容')
  const B = plain('B', '另一段普通内容')
  const forest = [A, B]
  const r = checkEdge(B, A, buildAdjacency(forest))
  assert.equal(r.ok, true, '端点约束不成立：露面可加可减，前置条件会追溯失效')
  edge(B, A)
  assert.deepEqual(parentIdsOf(B), ['A'])
  assert.deepEqual(parentsOf(B, buildAdjacency(forest)).map((b) => b.id), ['A'])
})

test('内容块作父时，成环检测仍覆盖它（顶点集合 = 全部活块）', () => {
  const A = plain('A', 'A')
  const B = tag('B', 'B')
  const forest = [A, B]
  edge(A, B) // 内容块 A 归在标签 B 下
  const r = checkEdge(B, A, buildAdjacency(forest))
  assert.equal(r.ok, false, '若顶点集合只取标签，A 查不到祖先，这个环会漏判')
  assert.equal(r.reason, 'cycle')
})

test('摘掉父的露面：边不动、不报错（露面不是模型判据）', () => {
  const A = page('A', 'A')
  const B = tag('B', 'B')
  const forest = [A, B]
  edge(B, A)
  A.props = { _aliases: ['A'] } // 摘掉 page 露面
  const adj = buildAdjacency(forest)
  assert.deepEqual(parentsOf(B, adj).map((b) => b.id), ['A'], '边还在，读路径照旧按 id 找得到')
  assert.equal(checkEdge(B, A, adj).reason, 'duplicate', '已有这条边，与露面无关')
})

/* ------------------------------------------------------------ 悬空两态 */

test('⑥ 悬空两态：软删的上级落 revivable、真删的落 gone；清理只清 gone', () => {
  const memo = tag('memo', '备忘')
  const secret = tag('secret', '密码')
  const forest: Block[] = [memo, secret]
  edge(secret, memo)
  assert.deepEqual(parentsOf(secret, buildAdjacency(forest)).map((t) => t.id), ['memo'])

  // 上级被**软删**（回收站）：ref 留着，两态里它是 revivable
  memo.props = { ...(memo.props ?? {}), [DELETED_AT_PROP]: Date.now() }
  const soft = danglingOf(secret, buildAdjacency(forest))
  assert.deepEqual(soft, { revivable: ['memo'], gone: [] })
  assert.equal(pruneGone(secret, buildAdjacency(forest)), 0, '回收站里的上级一条都不该被清掉')
  assert.deepEqual(parentIdsOf(secret), ['memo'], '边一个字节没动')

  // 复活：边自动接回（不需要任何修边动作）
  delete memo.props?.[DELETED_AT_PROP]
  assert.deepEqual(parentsOf(secret, buildAdjacency(forest)).map((t) => t.id), ['memo'])

  // 上级**真的没了**（不在森林里）：gone，可清
  forest.splice(forest.indexOf(memo), 1)
  const gone = danglingOf(secret, buildAdjacency(forest))
  assert.deepEqual(gone, { revivable: [], gone: ['memo'] })
  assert.equal(pruneGone(secret, buildAdjacency(forest)), 1)
  assert.deepEqual(parentIdsOf(secret), [])
})

test('手工删一条归属：只动子侧，别处不受影响', () => {
  const { forest, people, artist, actor } = tree()
  assert.equal(removeEdge(actor, people.id), true)
  assert.deepEqual(parentIdsOf(actor), [artist.id])
  assert.equal(removeEdge(actor, people.id), false, '幂等')
  assert.equal(forest.length, 4)
})

/* ------------------------------------------------------------ 归属树（根重算） */

test('归属树：只含带本树露面的块；根按「本树内没有可见父」重算', () => {
  const A = page('A', '页 A')
  const B = page('B', '页 B')
  const T = tag('T', '标签 T')
  const P = page('P', '页 P')
  const forest = [A, B, T, P]
  edge(B, A) // 页 B 归在页 A 下
  edge(P, T) // 页 P 归在**标签** T 下

  const rows = belongsToTree(buildAdjacency(forest), 'page')
  const shape = rows.map((r) => `${r.block.id}@${r.depth}`)
  assert.deepEqual(shape, ['A@0', 'B@1', 'P@0'], 'P 的父被露面筛掉 ⇒ P 升级为根（否则它从树里消失）')
  assert.ok(!rows.some((r) => r.block.id === 'T'), '标签不进页的归属树')

  // 标签那一侧：T 是根，P 不出现
  const tagRows = belongsToTree(buildAdjacency(forest), 'tag')
  assert.deepEqual(tagRows.map((r) => `${r.block.id}@${r.depth}`), ['T@0'])
})

test('归属树：空边 ⇒ 根；多父 ⇒ 同一块出现两次（DAG 本来就有多个答案）', () => {
  const A = page('A', 'A')
  const B = page('B', 'B')
  const C = page('C', 'C')
  const forest = [A, B, C]
  edge(C, A)
  edge(C, B)
  const rows = belongsToTree(buildAdjacency(forest), 'page')
  assert.deepEqual(rows.map((r) => `${r.block.id}@${r.depth}`), ['A@0', 'C@1', 'B@0', 'C@1'])
})

test('归属树：补上露面之后位置当场就变（根不能缓存成源点集合）', () => {
  const A = page('A', 'A')
  const T = tag('T', 'T')
  const P = page('P', 'P')
  const forest = [A, T, P]
  edge(P, T)
  assert.deepEqual(belongsToTree(buildAdjacency(forest), 'page').map((r) => `${r.block.id}@${r.depth}`), ['A@0', 'P@0'])
  // 给 T 补上 page 露面：P 立刻回到 T 下面（父不再被筛掉）
  T.props = { ...(T.props ?? {}), _lists: ['tag', 'page'] }
  assert.deepEqual(belongsToTree(buildAdjacency(forest), 'page').map((r) => `${r.block.id}@${r.depth}`), ['A@0', 'T@0', 'P@1'])
})

/* ------------------------------------------------------------ 算作 ≠ 继承 */

test('算作做、字段继承不做 —— 成员进去，字段不跟', () => {
  const name = mkPropDef('姓名')
  const people = tag('people', '人物')
  const actor = tag('actor', '演员')
  declareField(people, name.id)
  const forest = [name, people, actor]
  edge(actor, people)
  const x = plain('x', '某人')
  forest.push(x)
  tagBlock(x, actor.id)

  assert.ok(membersOf(people.id, forest).has('x'), '算作：查 #人物 能看到只打 #演员 的块')
  assert.deepEqual(fieldIdsOf(x, forest), [], '继承不做：它的属性区不出现 #人物 的字段')
})
