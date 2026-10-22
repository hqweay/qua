/**
 * **标签层级（算作 / 包含）**：一条边、两个读法。
 *
 * 验收对应 86.10.8.9 的 ①–⑥，另钉住 D21 的「算作做、字段继承不做」：
 * 只打 `#演员` 的块出现在 `#人物` 的成员里，但它的属性区**没有** `#人物` 的字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  addParentTag,
  ancestorIds,
  childTags,
  danglingParentIds,
  declareField,
  fieldIdsOf,
  membersOf,
  mkPropDef,
  mkTagBlock,
  parentTagIds,
  parentTags,
  pruneParentTags,
  removeParentTag,
} from '../src/core/index.ts'

/** 给块打一个标签（归属在块上：`props._tags`） */
const tagBlock = (block: Block, tagId: string): void => {
  block.props = { ...(block.props ?? {}), _tags: [tagId] }
}

function tag(id: string, text: string): Block {
  const t = mkTagBlock(text)
  t.id = id
  return t
}

function tree(): { forest: Block[]; people: Block; actor: Block; artist: Block; director: Block } {
  const people = tag('people', '人物')
  const actor = tag('actor', '演员')
  const artist = tag('artist', '艺术家')
  const director = tag('director', '导演')
  const forest: Block[] = [people, actor, artist, director]
  addParentTag(actor, people, forest)
  addParentTag(actor, artist, forest)
  addParentTag(director, people, forest)
  return { forest, people, actor, artist, director }
}

test('① 多父：成员按每个父都能查到；兄弟方向不串味', () => {
  const { forest, people, actor, artist, director } = tree()
  const x: Block = { id: 'x', text: '演员甲', children: [] }
  const y: Block = { id: 'y', text: '只属于艺术家', children: [] }
  const z: Block = { id: 'z', text: '直接打人物', children: [] }
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
  const a: Block = { id: 'a', text: '演员甲', children: [] }
  const d: Block = { id: 'd', text: '导演甲', children: [] }
  forest.push(a, d)
  tagBlock(a, actor.id)
  tagBlock(d, director.id)
  const members = membersOf(people.id, forest)
  assert.ok(members.has('a') && members.has('d'))
})

test('③ 菱形去重：ancestorsOf(#A) = {B, C, D}，D 只一次', () => {
  const A = tag('A', 'A')
  const B = tag('B', 'B')
  const C = tag('C', 'C')
  const D = tag('D', 'D')
  const forest = [A, B, C, D]
  addParentTag(A, B, forest)
  addParentTag(A, C, forest)
  addParentTag(B, D, forest)
  addParentTag(C, D, forest)
  assert.deepEqual([...ancestorIds(A.id, forest)].sort(), ['B', 'C', 'D'])
  assert.equal(ancestorIds(A.id, forest).size, 3)
})

test('④ 禁环：写入时拒绝，并给出循环路径（不靠读时兜底）', () => {
  const A = tag('A', 'A')
  const B = tag('B', 'B')
  const forest = [A, B]
  assert.equal(addParentTag(A, B, forest).ok, true) // A 属于 B
  const r = addParentTag(B, A, forest) // 再把 B 属于 A ⇒ 环
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'cycle')
  assert.ok(r.path && r.path.includes('A') && r.path.includes('B'), JSON.stringify(r))
  assert.deepEqual(parentTagIds(B), [], '被拒绝的写入不能留下半截状态')
})

test('④b 自己属于自己也被拒绝', () => {
  const A = tag('A', 'A')
  assert.equal(addParentTag(A, A, [A]).reason, 'self')
})

test('⑤ 边存在子标签上：「包含多个」是反向读法，不设第二条边', () => {
  const { forest, people, actor } = tree()
  assert.deepEqual(parentTagIds(actor), [people.id, 'artist'], '多父：子标签上两条 ref（按添加顺序）')
  assert.equal(parentTagIds(people).length, 0, '父侧不存子列表')
  assert.ok(!('_childTags' in (people.props ?? {})), '没有第二条边')
  assert.deepEqual(childTags(people, forest).map((t) => t.id).sort(), ['actor', 'director'])
})

test('⑥ 删父留悬空：ref 不被自动摘；可见、可清理；恢复后自动正常', () => {
  const memo = tag('memo', '备忘')
  const secret = tag('secret', '密码')
  const forest: Block[] = [memo, secret]
  addParentTag(secret, memo, forest)
  assert.deepEqual(parentTags(secret, forest).map((t) => t.id), ['memo'])

  forest.splice(forest.indexOf(memo), 1) // 删父
  assert.deepEqual(parentTagIds(secret), ['memo'], '不自动摘边')
  assert.deepEqual(parentTags(secret, forest), [], '解析不到活引用')
  assert.deepEqual(danglingParentIds(secret, forest), ['memo'], '悬空可见')

  // 撤销（把父放回来）⇒ 边一个字节没动，状态自动变正常
  forest.unshift(memo)
  assert.deepEqual(parentTags(secret, forest).map((t) => t.id), ['memo'])

  // 显式清理只清悬空那条
  forest.splice(forest.indexOf(memo), 1)
  assert.equal(pruneParentTags(secret, forest), 1)
  assert.deepEqual(parentTagIds(secret), [])
})

test('手工删一条归属：只动子侧，别处不受影响', () => {
  const { forest, people, artist, actor } = tree()
  assert.equal(removeParentTag(actor, people.id), true)
  assert.deepEqual(parentTagIds(actor), [artist.id])
  assert.equal(removeParentTag(actor, people.id), false, '幂等')
  assert.equal(forest.length, 4)
})

test('D21：算作做、字段继承不做 —— 成员进去，字段不跟', () => {
  const name = mkPropDef('姓名')
  const people = tag('people', '人物')
  const actor = tag('actor', '演员')
  declareField(people, name.id)
  const forest = [name, people, actor]
  addParentTag(actor, people, forest)
  const x: Block = { id: 'x', text: '某人', children: [] }
  forest.push(x)
  tagBlock(x, actor.id)

  assert.ok(membersOf(people.id, forest).has('x'), '算作：查 #人物 能看到只打 #演员 的块')
  assert.deepEqual(fieldIdsOf(x, forest), [], '继承不做：它的属性区不出现 #人物 的字段')
})
