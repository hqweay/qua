/**
 * **标签＝指向边**的纯逻辑测试。
 *
 * 这里钉的是「不再有第二套解析」这件事的六个后果：
 *   ① 打标签产出的是**边**（tag 原子），不是文本；
 *   ② 删掉那个原子 ⇒ 边随之消失，不留孤儿（这是选「边在正文里」的代价与收益）；
 *   ③ 标签是一个 `tag` 角色的**块**，同名页块不会因为同名就变成标签；
 *   ④ 标签改名 ⇒ 显示名跟着变（复用 ref 解析），且**不改变边的判定**；
 *   ⑤ 规范化只有一处（`#设计` 与 `#设计 ` 是同一个标签）；
 *   ⑥ 标签成员＝指向它的 tag 边 ⇒ 与「反链」在数据上是同一件事。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import {
  allTags,
  edgeSourceIds,
  ensureTag,
  findTagByName,
  hasTagEdge,
  mkTagBlock,
  normalizeTag,
  tagMemberIds,
  tagsOf,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

/** 一条标签边（正文里占 1 格 ⇒ 删那一格，边就没了） */
const tagEdge = (id: string, blockId: string, tagId: string, start = 0): Atom =>
  ({ id, kind: 'tag', blockId, start, end: start + 1, label: 'todo', target: { kind: 'page', id: tagId } }) as Atom

test('① ensureTag：找到或创建，幂等（第二次不新建）', () => {
  const forest: Block[] = []
  const first = ensureTag(forest, '设计')
  assert.equal(first.created, true)
  assert.equal(forest.length, 1)
  assert.deepEqual(forest[0]!.roles, ['tag'], '标签是一个带 tag 角色的块')

  const second = ensureTag(forest, '设计')
  assert.equal(second.created, false)
  assert.equal(second.block?.id, first.block?.id, '同一个标签不该建出第二块')
  assert.equal(forest.length, 1)
})

test('② 边在正文里 ⇒ 删掉那个原子，边随之消失（不留孤儿）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  let atoms: Atom[] = [tagEdge('t1', 'a', todo.id)]
  assert.equal(hasTagEdge('a', todo.id, atoms), true)

  // 删掉正文里那一格 ⇒ 原子没了 ⇒ 边没了
  atoms = atoms.filter((a) => a.id !== 't1')
  assert.equal(hasTagEdge('a', todo.id, atoms), false)
  assert.equal(tagMemberIds(todo.id, atoms).size, 0, '成员列表也要跟着空，不留悬空记录')
})

test('③ 只认 tag 角色：同名页块不会因为同名就变成标签', () => {
  const forest: Block[] = [b('p', '设计', { roles: ['page'] })]
  const found = ensureTag(forest, '设计')
  assert.equal(found.created, true, '页块不是标签 ⇒ 应当新建一个标签块')
  assert.notEqual(found.block?.id, 'p')
  assert.equal(forest.length, 2)
  assert.deepEqual(
    allTags(forest).map((t) => t.id),
    [found.block!.id],
    'allTags 只列 tag 角色',
  )
})

test('④ 标签改名 ⇒ 显示名跟着变，但边的判定不变（认 id 不认名字）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const atoms = [tagEdge('t1', 'a', todo.id)]

  const before = findTagByName(forest, 'todo')?.id
  todo.text = '待办' // 改名
  const after = findTagByName(forest, '待办')?.id

  assert.equal(after, before, '改名后同一块仍在（id 没变）')
  assert.equal(hasTagEdge('a', todo.id, atoms), true, '**边不受改名影响** —— 这正是认 id 的意义')
  assert.equal(findTagByName(forest, 'todo'), undefined, '旧名字不再解析到它')
})

test('⑤ 规范化只有一处：大小写与空白不产生第二个标签', () => {
  const forest: Block[] = []
  const a = ensureTag(forest, '设计')
  const b2 = ensureTag(forest, ' 设计 ')
  const c = ensureTag(forest, 'TODO')
  const d = ensureTag(forest, 'todo')
  assert.equal(b2.block?.id, a.block?.id)
  assert.equal(d.block?.id, c.block?.id)
  assert.equal(forest.length, 2)
  assert.equal(normalizeTag('  TODO '), 'todo')
})

test('⑤b 空名字不建标签（没有身份的标签是孤儿）', () => {
  const forest: Block[] = []
  const r = ensureTag(forest, '   ')
  assert.equal(r.block, null)
  assert.equal(r.created, false)
  assert.equal(forest.length, 0)
})

test('⑥ 标签成员＝指向它的 tag 边 ⇒ 与反链是同一件事', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const done = ensureTag(forest, 'done').block!
  const atoms = [
    tagEdge('t1', 'a', todo.id, 0),
    tagEdge('t2', 'b', todo.id, 0),
    tagEdge('t3', 'c', done.id, 0),
    // 同一块打两次同一标签 ⇒ 只算一条成员
    tagEdge('t4', 'a', todo.id, 3),
  ]
  assert.deepEqual([...tagMemberIds(todo.id, atoms)].sort(), ['a', 'b'])
  assert.deepEqual([...tagMemberIds(done.id, atoms)], ['c'])

  // 与反链同构：`edgeSourceIds` 同时算引用与标签
  assert.deepEqual([...edgeSourceIds(atoms, todo.id)].sort(), ['a', 'b'])
})

test('⑥b tagsOf：返回标签块本身（活引用），顺序按正文里出现的先后', () => {
  const forest: Block[] = []
  const x = ensureTag(forest, 'x').block!
  const y = ensureTag(forest, 'y').block!
  const atoms = [tagEdge('t1', 'a', y.id, 0), tagEdge('t2', 'a', x.id, 2), tagEdge('t3', 'a', x.id, 5)]
  const got = tagsOf('a', forest, atoms)
  assert.deepEqual(
    got.map((t) => t.id),
    [y.id, x.id],
    '按正文先后；同一标签不重复',
  )
  assert.equal(got[0], y, '返回的是块本身，不是名字的拷贝')
})

test('mkTagBlock：名字就是正文，不带 #（# 是呈现时加的装饰）', () => {
  const t = mkTagBlock('设计')
  assert.equal(t.text, '设计')
  assert.deepEqual(t.roles, ['tag'])
  assert.equal(t.props?._icon, 'lucide:hash')
})
