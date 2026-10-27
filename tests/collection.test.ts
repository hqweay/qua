import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLECTION_PROP,
  COLLECTION_TYPE,
  collectionItems,
  collectionSummary,
  isCollectionBlock,
  isWidgetBlock,
  mkCollectionBlock,
  moveCollectionItem,
  setCollectionItems,
  typeDeclOf,
  widgetSlotSize,
  widgetBodyOf,
  cloneSubtree,
  blockTypeOf,
  mkBlock,
  DEFAULT_BLOCK_TYPE,
} from '../src/core/index.ts'

test('collection: 空集合块是 collection 类型、有标题、没有 _items 空壳', () => {
  const b = mkCollectionBlock('收藏')
  assert.equal(blockTypeOf(b), COLLECTION_TYPE)
  assert.equal(isCollectionBlock(b), true)
  assert.equal(isWidgetBlock(b), true)
  assert.equal(widgetSlotSize(b), 'large')
  assert.deepEqual(collectionItems(b), [])
  assert.equal(b.props?.[COLLECTION_PROP], undefined, '空集合不该留一个 [] 的第二答案')
  assert.deepEqual(b.props?._aliases, ['收藏'])
  assert.equal(typeDeclOf(b).children, 'none')
  assert.equal(typeDeclOf(b).text, 'readonly')
})

test('collection: 写 _items 去重保序；清空时删掉那一格', () => {
  const b = mkCollectionBlock('收藏')
  setCollectionItems(b, ['a', 'b', 'a', '', 'c'])
  assert.deepEqual(collectionItems(b), ['a', 'b', 'c'])
  setCollectionItems(b, ['b', 'c'])
  assert.deepEqual(collectionItems(b), ['b', 'c'])
  setCollectionItems(b, [])
  assert.equal(b.props?.[COLLECTION_PROP], undefined)
})

test('collection: _items 形状坏 ⇒ 读作空，不抛也不修', () => {
  const b = mkCollectionBlock('收藏')
  b.props = { ...(b.props ?? {}), [COLLECTION_PROP]: 'not-an-array' }
  assert.deepEqual(collectionItems(b), [])
  b.props = { ...(b.props ?? {}), [COLLECTION_PROP]: ['a', 3, '', null, 'b'] }
  assert.deepEqual(collectionItems(b), ['a', 'b'])
})

test('collection: 拖序「先摘再插」；同一位置返回 null，不记撤销', () => {
  assert.deepEqual(moveCollectionItem(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'])
  assert.deepEqual(moveCollectionItem(['a', 'b', 'c'], 'a', 3), ['b', 'c', 'a'])
  assert.deepEqual(moveCollectionItem(['a', 'b', 'c'], 'b', 3), ['a', 'c', 'b'])
  assert.equal(moveCollectionItem(['a', 'b', 'c'], 'b', 1), null, '拖到自己身上不算移动')
  assert.equal(moveCollectionItem(['a', 'b', 'c'], 'b', 2), null, '落到自己后半格还是原位')
  assert.equal(moveCollectionItem(['a', 'b', 'c'], 'zzz', 0), null)
})

test('collection: 复制集合带走引用与类型，但不带走被引用的块', () => {
  const b = mkCollectionBlock('收藏')
  setCollectionItems(b, ['a', 'b'])
  const { block: copy, idMap } = cloneSubtree(b)
  assert.notEqual(copy.id, b.id)
  assert.equal(idMap.get(b.id), copy.id)
  assert.equal(blockTypeOf(copy), COLLECTION_TYPE)
  assert.deepEqual(collectionItems(copy), ['a', 'b'], '引用是集合自己的配置，复制要跟着走')
  assert.equal(copy.children.length, 0, '集合里的项不是 children')
})

/* ---------------------------------------------- 正文露面（body: 'row'） */

test("body: 普通块没有正文露面；集合有，且是 'row'", () => {
  const plain = mkBlock('一句话')
  assert.equal(blockTypeOf(plain), DEFAULT_BLOCK_TYPE)
  assert.equal(widgetBodyOf(plain), null, '普通块不是 widget，没有正文露面')
  assert.equal(widgetBodyOf(undefined), null, '没有块 ⇒ 没有露面，不报错')
  assert.equal(widgetBodyOf(mkCollectionBlock('收藏')), 'row')
})

test("body: 露面由**类型声明**给，不由位置给（同一块在正文与槽里是同一件事）", () => {
  const b = mkCollectionBlock('收藏')
  // 判据：声明里两格都有 ⇒ 它既能在槽里、也能在正文里；两处读的是同一格配置
  assert.equal(widgetSlotSize(b), 'large')
  assert.equal(widgetBodyOf(b), 'row')
  assert.equal(typeDeclOf(b).text, 'readonly', '组件块的正文不是可写内容')
})

test('body: 摘要同时报总数与活着的条数（悬空引用不被藏掉）', () => {
  const b = mkCollectionBlock('收藏')
  const alive = new Set(['a', 'c'])
  const find = (id: string) => (alive.has(id) ? mkBlock(id) : undefined)

  assert.deepEqual(collectionSummary(b, find), { total: 0, alive: 0 })
  setCollectionItems(b, ['a', 'b', 'c'])
  assert.deepEqual(collectionSummary(b, find), { total: 3, alive: 2 }, '删掉的块留着引用 ⇒ 摘要要说得出来')
  // 块恢复后自动回来：判据是「按 id 查活块」，不是把引用删掉
  alive.add('b')
  assert.deepEqual(collectionSummary(b, find), { total: 3, alive: 3 })
})
