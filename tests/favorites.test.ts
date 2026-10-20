/**
 * 收藏模型的纯函数单测 ——可脱离浏览器跑。
 *
 * 判据逐条对应决策原文：不是新实体 / 不依赖被收藏块的状态 / 删容器不影响数据 /
 * 同一块可被多个容器收藏且顺序独立 / 悬空不静默丢弃。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  FAVORITES_PROP,
  addFavorite,
  containersHolding,
  favoriteIds,
  liveFavorites,
  moveFavorite,
  pruneFavorites,
  removeFavorite,
} from '../src/core/favorites.ts'
import { findInForest } from '../src/core/tree.ts'
import type { Block } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

/** 一片小森林：页 A（含子块 a1）＋ 页 B ＋ 一个收藏容器（命名容器块） */
function fixture() {
  const a1 = mk('a1', '子块一')
  const pageA = mk('pa', '页 A', [a1])
  const pageB = mk('pb', '页 B')
  const container = mk('c1', '我的收藏')
  return { forest: [pageA, pageB, container], pageA, pageB, container, a1 }
}

test('收藏 ＝ 有序的块 id 列表，不是一个新实体', () => {
  const { forest, container, pageA, pageB } = fixture()
  assert.deepEqual(favoriteIds(container), [], '新容器应为空')
  assert.equal(addFavorite(container, pageA.id), true)
  assert.equal(addFavorite(container, pageB.id), true)
  assert.deepEqual(favoriteIds(container), ['pa', 'pb'], '顺序应等于加入顺序')
  // 它就是个普通块的 props，没有新类型、没有新数组挂在 workspace 上
  assert.equal(container.props?.[FAVORITES_PROP] instanceof Array, true)
  assert.equal(findInForest(forest, 'c1')?.text, '我的收藏', '容器自身仍是普通块')
})

test('不依赖被收藏块的状态：被收藏的块上没有任何标记', () => {
  const { pageA, container } = fixture()
  addFavorite(container, pageA.id)
  assert.equal(pageA.props, undefined, '被收藏的块不该被写 prop')
  assert.equal(JSON.stringify(pageA).includes('favorite'), false, '块里不该出现 favorite 字样')
})

test('删掉容器块，被收藏的数据不受影响（解耦）', () => {
  const { forest, container, pageA } = fixture()
  addFavorite(container, pageA.id)
  const i = forest.findIndex((b) => b.id === container.id)
  forest.splice(i, 1) // 删容器
  assert.ok(findInForest(forest, 'pa'), '被收藏的页必须还在')
  assert.equal(forest.some((b) => b.id === 'c1'), false, '容器已删')
})

test('同一块可被多个容器收藏，顺序各自独立', () => {
  const { forest, pageA, pageB } = fixture()
  const c2 = mk('c2', '另一个容器')
  forest.push(c2)
  const c1 = forest.find((b) => b.id === 'c1')!
  addFavorite(c1, pageA.id)
  addFavorite(c1, pageB.id)
  addFavorite(c2, pageB.id)
  addFavorite(c2, pageA.id)
  assert.deepEqual(favoriteIds(c1), ['pa', 'pb'])
  assert.deepEqual(favoriteIds(c2), ['pb', 'pa'], '两个容器的顺序互不影响')
  assert.deepEqual(
    containersHolding(forest, 'pa').map((b) => b.id),
    ['c1', 'c2'],
    '「被收藏在哪」只能查引用边（代价登记）',
  )
})

test('幂等与去重：重复收藏不产生两条', () => {
  const { container, pageA } = fixture()
  assert.equal(addFavorite(container, pageA.id), true)
  assert.equal(addFavorite(container, pageA.id), false)
  assert.deepEqual(favoriteIds(container), ['pa'])
})

test('不能收藏容器自己', () => {
  const { container } = fixture()
  assert.equal(addFavorite(container, container.id), false)
  assert.deepEqual(favoriteIds(container), [])
})

test('移除与移动顺序位', () => {
  const { container, pageA, pageB, a1 } = fixture()
  for (const id of [pageA.id, pageB.id, a1.id]) addFavorite(container, id)
  assert.deepEqual(favoriteIds(container), ['pa', 'pb', 'a1'])
  assert.equal(moveFavorite(container, 'a1', -1), true)
  assert.deepEqual(favoriteIds(container), ['pa', 'a1', 'pb'], '上移一位')
  assert.equal(moveFavorite(container, 'pa', -1), false, '已在首位，移不动')
  assert.equal(moveFavorite(container, 'pa', 1), true)
  assert.deepEqual(favoriteIds(container), ['a1', 'pa', 'pb'])
  assert.equal(removeFavorite(container, 'pa'), true)
  assert.deepEqual(favoriteIds(container), ['a1', 'pb'])
  assert.equal(removeFavorite(container, 'pa'), false, '移除不存在的项应是 false')
})

test('悬空引用不静默丢弃：读时过滤，prune 时显式清掉并报数', () => {
  const { forest, container, pageA, pageB } = fixture()
  addFavorite(container, pageA.id)
  addFavorite(container, pageB.id)
  // 页 B 被删掉（模拟用户删页）
  forest.splice(
    forest.findIndex((b) => b.id === 'pb'),
    1,
  )
  assert.deepEqual(favoriteIds(container), ['pa', 'pb'], '容器里的记录还在（不静默改写）')
  assert.deepEqual(
    liveFavorites(forest, container).map((b) => b.id),
    ['pa'],
    '渲染时只给还活着的',
  )
  assert.equal(pruneFavorites(forest, container), 1, '显式清理应报出清掉 1 条')
  assert.deepEqual(favoriteIds(container), ['pa'])
})

test('清空后不留空属性（落盘形状干净）', () => {
  const { container, pageA } = fixture()
  addFavorite(container, pageA.id)
  removeFavorite(container, pageA.id)
  assert.equal(container.props, undefined, '空收藏应把 props 整个删掉，而不是留一个 []')
})

test('收藏子块也成立（不只是页）', () => {
  const { forest, container, a1 } = fixture()
  addFavorite(container, a1.id)
  assert.deepEqual(
    liveFavorites(forest, container).map((b) => b.text),
    ['子块一'],
    '任意块都可被收藏（容器存一列块引用）',
  )
})
