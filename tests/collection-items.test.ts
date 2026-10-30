/**
 * **收藏的 items 源**：一批手选的引用，不是子块、也不是查询命中。
 *
 * 四条在界面上看不出对错的事：
 *   ① 顺序＝`_items` 顺序（拖动改序只写这一格）；
 *   ② 悬空引用**保留**（删块不摘引用，块恢复后自己回来），只是不出行；
 *   ③ 加/删一行**不删块**（零级联）；
 *   ④ 默认列看的是那几条引用自己带着的属性，不是容器的。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COLLECTION_PROP,
  collectionItems,
  collectionSummary,
  defaultColumnsForSource,
  itemsRecords,
  mkBlock,
  moveCollectionItem,
  setCollectionItems,
  sourceOf,
  type Block,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'

const mk = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const fav = (items: string[], props?: Record<string, unknown>): Block =>
  mk('f', '收藏', { _type: 'core/collection-widget', ...(items.length > 0 ? { _items: items } : {}), ...(props ?? {}) })

function kbOf(blocks: Block[]): MemoryKb {
  return new MemoryKb(new BlockStore(blocks))
}

test('sourceOf：收藏块的源是 **items**（手选的一批），不是它的子块', () => {
  const b = fav(['a'])
  assert.deepEqual(sourceOf(b), { kind: 'items', blockId: 'f' })
})

test('itemsRecords：顺序＝`_items` 顺序；每条带 `itemIndex`（拖动要用）', () => {
  const blocks = [mk('a', '一'), mk('b', '二'), mk('c', '三'), fav(['c', 'a', 'b'])]
  const rows = itemsRecords('f', kbOf(blocks))
  assert.deepEqual(
    rows.map((r) => r.block.id),
    ['c', 'a', 'b'],
    '顺序是手选的，不是库里的先序',
  )
  assert.deepEqual(
    rows.map((r) => r.itemIndex),
    [0, 1, 2],
    '位置要一起给（拖动改序写的是「第几项」）',
  )
  assert.equal(rows[0]!.path[0]!.id, 'f', '面包屑是收藏块自己（它是一次「看这批引用」）')
})

test('itemsRecords：悬空引用**不出行**但不被摘掉（块恢复后自己回来）', () => {
  const blocks = [mk('a', '一'), fav(['a', 'gone'])]
  const kb = kbOf(blocks)
  assert.deepEqual(itemsRecords('f', kb).map((r) => r.block.id), ['a'], '解析不到的那条不出行')
  assert.deepEqual(collectionItems(kb.get('f')), ['a', 'gone'], '引用本身留着：删块不摘引用')
  assert.deepEqual(collectionSummary(kb.get('f')!, (id) => kb.get(id)), { total: 2, alive: 1 }, '摘要要说清「2 条（1 条已删）」')
})

test('itemsRecords：软删的块也不出行（同一份「看不见」口径）', () => {
  const blocks = [mk('a', '一', { _deletedAt: 5 }), fav(['a'])]
  assert.deepEqual(itemsRecords('f', kbOf(blocks)), [])
})

test('加/删一行**不删块**：`_items` 只动引用，块原样留在库里', () => {
  const b = fav([])
  setCollectionItems(b, ['a'])
  assert.deepEqual(collectionItems(b), ['a'])
  assert.equal(b.children.length, 0, '收藏不是「把块搬进来」——引用的块仍在自己原来的位置')
  setCollectionItems(b, [])
  assert.equal(b.props?.[COLLECTION_PROP], undefined, '空集合＝删掉那一格（不留空数组）')
})

test('setCollectionItems：去重、丢空串、保序', () => {
  const b = fav([])
  setCollectionItems(b, ['b', 'a', 'b', '', 'a'])
  assert.deepEqual(collectionItems(b), ['b', 'a'], '同一条引用加两次没有意义')
})

test('moveCollectionItem：往后拖时目标下标要减一（与侧槽卡片同一套口径）', () => {
  assert.deepEqual(moveCollectionItem(['a', 'b', 'c'], 'a', 3), ['b', 'c', 'a'], '拖到末尾')
  assert.deepEqual(moveCollectionItem(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b'], '拖到最前')
  assert.equal(moveCollectionItem(['a', 'b', 'c'], 'b', 2), null, '原位 ⇒ 不记一次撤销')
  assert.equal(moveCollectionItem(['a'], 'gone', 0), null, '找不到 ⇒ null')
})

test('defaultColumnsForSource：items 源看**那几条引用**自己的属性', () => {
  const score = mk('d-score', '评分', { _kind: 'number' })
  const blocks = [score, mk('a', '一', { [score.id]: 3 }), mk('b', '二', { [score.id]: 9 }), fav(['a', 'b'])]
  const cols = defaultColumnsForSource({ kind: 'items', blockId: 'f' }, kbOf(blocks))
  assert.equal(cols[0]!.key, 'title', '第一列永远是标题')
  assert.ok(
    cols.some((c) => c.key === score.id),
    `引用自己带的属性要进列：${JSON.stringify(cols.map((c) => c.key))}`,
  )
})

test('defaultColumnsForSource：一条引用都没有 ⇒ 四列兜底（空表也要有列头）', () => {
  const cols = defaultColumnsForSource({ kind: 'items', blockId: 'f' }, kbOf([fav([])]))
  assert.deepEqual(
    cols.map((c) => c.key),
    ['title', 'tags', 'children', 'modified'],
  )
})
