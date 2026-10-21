/**
 * **字段定义（prop-def）与属性区派生**。
 *
 * 验收口径：
 *   ③ 定义是**独立块**（住森林顶层，`role:'schema'`，`propId` ＝ 块 id），
 *      可被两个标签同时声明；删掉其中一个标签，定义仍在、另一个声明仍有效。
 *   ⑥ `fieldsOf` 只算**直接标签**：只打 `#演员` 不会冒出 `#人物` 的字段。
 *   ④ 同一 `propId` 只显示一次、来源完整；块自有字段（无标签声明）也在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import {
  cleanableValues,
  declareField,
  declaredFieldIds,
  declaredFields,
  ensureTag,
  fieldIdsOf,
  fieldRows,
  hasValue,
  isPropDef,
  mkPropDef,
  mkTagBlock,
  undeclareField,
} from '../src/core/index.ts'

const tagEdge = (id: string, blockId: string, tagId: string): Atom =>
  ({
    id,
    kind: 'tag',
    blockId,
    start: 0,
    end: 1,
    label: 'x',
    target: { kind: 'page', id: tagId },
  }) as Atom

test('③ 定义是独立块：森林顶层、schema 角色、正文＝label、propId＝块 id', () => {
  const def = mkPropDef('评分', 'number')
  const forest: Block[] = [def]
  assert.equal(forest[0], def, '直接住森林顶层 —— 不是任何标签的子块')
  assert.ok(isPropDef(def))
  assert.equal(def.text, '评分')
  assert.equal(def.props?._kind, 'number')
  assert.equal(def.children.length, 0)
  assert.ok(def.id.length > 0, 'propId 就是它自己的 id')
})

test('③ 定义可被两个标签同时声明；删其一，定义仍在、另一声明仍有效', () => {
  const def = mkPropDef('评分', 'number')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  const forest: Block[] = [def, book, film]

  assert.equal(declareField(book, def.id), true)
  assert.equal(declareField(film, def.id), true)
  assert.deepEqual(declaredFieldIds(book), [def.id])
  assert.deepEqual(declaredFieldIds(film), [def.id])
  assert.equal(declareField(book, def.id), false, '幂等：同一标签不重复声明')

  // 删掉 #书（整个标签块）
  forest.splice(forest.indexOf(book), 1)
  assert.equal(forest.includes(def), true, '定义不随使用者消失')
  assert.deepEqual(declaredFields(film, forest).map((d) => d.id), [def.id], '#电影 的声明仍有效')
})

test('只有页/标签能声明字段（D4）；普通块只能有值', () => {
  const def = mkPropDef('评分')
  const plain: Block = { id: 'p', text: '普通块', children: [] }
  assert.equal(declareField(plain, def.id), false)
  const page: Block = { id: 'pg', text: '页', children: [], roles: ['page'] }
  assert.equal(declareField(page, def.id), true)
})

test('④ 同一 propId 被两标签声明 ⇒ 只出现一行、来源完整', () => {
  const def = mkPropDef('评分', 'number')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  declareField(book, def.id)
  declareField(film, def.id)
  const target: Block = { id: 'b', text: '西游记', children: [], props: { [def.id]: 9 } }
  const forest: Block[] = [def, book, film, target]
  const atoms = [tagEdge('e1', 'b', book.id), tagEdge('e2', 'b', film.id)]

  const rows = fieldRows(target, forest, atoms)
  const scored = rows.filter((r) => r.propId === def.id)
  assert.equal(scored.length, 1, '同一个字段只显示一次')
  assert.deepEqual(scored[0]!.sources.map((s) => s.text), ['书', '电影'], '来源按正文里标签的先后')
  assert.equal(scored[0]!.value, 9)
  assert.equal(scored[0]!.filled, true)
})

test('④ 块自有属性是正常来源：没有标签声明时标「本块自有」（sources 为空）', () => {
  const def = mkPropDef('状态')
  const target: Block = { id: 'b', text: '一块', children: [], props: { [def.id]: '已完成' } }
  const forest: Block[] = [def, target]
  const rows = fieldRows(target, forest, [])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.sources, [])
  assert.equal(rows[0]!.label, '状态')
  assert.equal(rows[0]!.value, '已完成')
})

test('声明了但没填 ⇒ 行还在（「待填」），filled=false', () => {
  const def = mkPropDef('评分')
  const task = mkTagBlock('任务')
  declareField(task, def.id)
  const target: Block = { id: 'b', text: '一块', children: [] }
  const rows = fieldRows(target, [def, task, target], [tagEdge('e', 'b', task.id)])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.filled, false)
  assert.equal(hasValue(target, def.id), false)
})

test('⑥ fieldsOf 只算直接标签：只打 #演员 不含 #人物 的字段', () => {
  const name = mkPropDef('姓名')
  const people = mkTagBlock('人物')
  const actor = mkTagBlock('演员') // 包含关系（_parentTags）在 tag-tree 里；这里只证明「字段不跟祖先走」
  declareField(people, name.id)
  const target: Block = { id: 'b', text: '某人', children: [] }
  const forest: Block[] = [name, people, actor, target]
  const atoms = [tagEdge('e', 'b', actor.id)]
  assert.deepEqual(fieldIdsOf(target, forest, atoms), [], '#演员 没声明字段 ⇒ 属性区没有它')
})

test('摘标签清理：只算「有值 ∩ 被摘标签声明 ∩ 剩余标签都不声明」', () => {
  const shared = mkPropDef('评分')
  const onlyBook = mkPropDef('页数')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  declareField(book, shared.id)
  declareField(book, onlyBook.id)
  declareField(film, shared.id)
  const target: Block = {
    id: 'b',
    text: '一块',
    children: [],
    props: { [shared.id]: 9, [onlyBook.id]: 300 },
  }
  const forest: Block[] = [shared, onlyBook, book, film, target]
  const atoms = [tagEdge('e1', 'b', book.id), tagEdge('e2', 'b', film.id)]
  assert.deepEqual(cleanableValues(target, book, forest, atoms), [onlyBook.id], '评分还被 #电影 声明 ⇒ 不清')
})

test('解除声明只动这一条，值留在块上（值留存）', () => {
  const def = mkPropDef('评分')
  const book = mkTagBlock('书')
  declareField(book, def.id)
  const target: Block = { id: 'b', text: '一块', children: [], props: { [def.id]: 5 } }
  const forest: Block[] = [def, book, target]
  assert.equal(undeclareField(book, def.id), true)
  assert.equal(target.props![def.id], 5)
  assert.deepEqual(fieldRows(target, forest, []).map((r) => r.propId), [def.id], '值落到「本块自有」')
})

test('ensureTag 返回的块可以立刻声明字段（标签是普通块）', () => {
  const forest: Block[] = []
  const { block } = ensureTag(forest, '任务')
  const def = mkPropDef('状态')
  forest.push(def)
  assert.ok(block)
  assert.equal(declareField(block!, def.id), true)
})
