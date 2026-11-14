/**
 * `asset` 属性值的两态分派与多值读法。
 *
 * 这里钉住的是「值形状 → 显示地址」的那一条边界：写侧（`isAssetRef`）与读侧
 * （`assetRefView`）必须共用同一份协议白名单，且多值不许被压成单值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetRefKindOf, assetRefsOf, isAssetRef } from '../src/core/index.ts'
import { assetRefView } from '../src/view/asset-views.ts'

const hash = 'a'.repeat(64)
const url = 'https://example.com/cover.png'

test('两态：≥16 位 hex 是资产库 hash，http(s) 是外态链接，白名单与打开外链共用', () => {
  assert.equal(assetRefKindOf(hash), 'internal')
  assert.equal(assetRefKindOf(url), 'external')
  assert.equal(assetRefKindOf('http://example.com/cover.png'), 'external')
  assert.equal(isAssetRef(hash), true)
  assert.equal(isAssetRef(url), true)
})

test('坏形状与其它协议都不算 asset 值：写入会被挡，显示面也不画', () => {
  for (const bad of ['', '   ', 42, null, undefined, {}, 'javascript:alert(1)', 'data:image/png;base64,AA', '/local/path.png', 'abc']) {
    assert.equal(assetRefKindOf(bad), null, String(bad))
    assert.equal(isAssetRef(bad), false, String(bad))
  }
})

test('外态链接本身就是地址，不查资产索引；内态在库没装载时是 unavailable', () => {
  assert.deepEqual(assetRefView(url), { state: 'ready', url })
  assert.equal(assetRefView(hash).state, 'unavailable')
})

test('一格值读成引用列表：单值、多值、坏形状都不改原值，也不把数组压成字符串', () => {
  assert.deepEqual(assetRefsOf(url), [url])
  assert.deepEqual(assetRefsOf([hash, url]), [hash, url])
  assert.deepEqual(assetRefsOf([hash, 'javascript:alert(1)', '', url]), [hash, url])
  assert.deepEqual(assetRefsOf(undefined), [])
  assert.deepEqual(assetRefsOf([]), [])
})
