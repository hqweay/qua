/**
 * 中心表面目录与 tab 去重的纯判据：
 * · 表面目录唯一一份（工具面目录空集也是闭集——守卫拒绝一切 id）；
 * · 派生/工具 tab 按 kind 去重（同一张面全局一张）；
 * · 中心接得住的派生卡 ⊆ 派生卡目录（子集关系钉死，加卡漏接守卫先红）；
 * · 表面 tab 的固定名取自目录（字典 id，UI 调 t() 取字）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isDerivedCardId } from '../src/core/views/dock.ts'
import {
  CENTER_DERIVED_CARDS,
  UTILITY_FACES,
  centerDerivedOpenable,
  isUtilityFaceId,
  surfaceRefKey,
  surfaceTitleOf,
  validSurfaceRef,
} from '../src/core/views/surface.ts'

test('中心接得住的派生卡是派生卡目录的子集（目录唯一一份，子清单不另立门户）', () => {
  for (const id of CENTER_DERIVED_CARDS) {
    assert.ok(isDerivedCardId(id), `${id} 必须在派生卡目录里`)
  }
})

test('中心派生卡守卫：接得住的放行，槽绑定的持久卡与未知 id 拒绝', () => {
  assert.equal(centerDerivedOpenable('trash'), true, '回收站的身体是纯派生 DOM ⇒ 中心接得住')
  assert.equal(centerDerivedOpenable('inspect'), false, '检视卡的身体绑在右槽（持久实例）')
  assert.equal(centerDerivedOpenable('backrefs'), false, '反链卡是每槽一台的编辑器')
  assert.equal(centerDerivedOpenable('nope'), false)
})

test('工具面目录是闭集：搜索与设置两行；清单外的 id 一律不认', () => {
  assert.deepEqual(UTILITY_FACES.map((d) => d.id), ['search', 'settings'])
  // 槽卡身是逐面声明的：搜索能钉进槽；设置只有中心
  assert.deepEqual(UTILITY_FACES.filter((d) => d.slot === true).map((d) => d.id), ['search'])
  assert.equal(isUtilityFaceId('search'), true)
  assert.equal(isUtilityFaceId('settings'), true)
  assert.equal(isUtilityFaceId('widgets'), false)
  assert.equal(isUtilityFaceId(42), false)
})

test('表面守卫返回规范形态：派生＝card、工具＝face；不过与坏形状给 null', () => {
  assert.deepEqual(validSurfaceRef({ kind: 'derived', id: 'trash' }), { kind: 'derived', card: 'trash' })
  assert.equal(validSurfaceRef({ kind: 'derived', id: 'calendar' }), null, '中心接不住的卡不放行')
  assert.deepEqual(validSurfaceRef({ kind: 'utility', id: 'search' }), { kind: 'utility', face: 'search' })
  assert.equal(validSurfaceRef({ kind: 'utility', id: 'widgets' }), null, '目录外的工具面不放行')
  assert.equal(validSurfaceRef({ kind: 'widget', id: 'x' }), null)
  assert.equal(validSurfaceRef(null), null)
  assert.equal(validSurfaceRef({ kind: 'derived' }), null, '缺 id 不放行')
})

test('派生/工具按 kind 去重：同 kind 同 id 是同一张，kind 不同不互撞', () => {
  assert.equal(surfaceRefKey({ kind: 'derived', card: 'trash' }), 'derived:trash')
  assert.equal(surfaceRefKey({ kind: 'utility', face: 'search' }), 'utility:search')
  const a = surfaceRefKey({ kind: 'derived', card: 'trash' })
  const b = surfaceRefKey({ kind: 'derived', card: 'calendar' })
  assert.notEqual(a, b, '不同卡是不同张')
})

test('表面 tab 的固定名取自目录（字典 id）；不在目录里的给 null', () => {
  assert.equal(surfaceTitleOf({ kind: 'derived', card: 'trash' }), 'ui.dock.trash')
  assert.equal(surfaceTitleOf({ kind: 'derived', card: 'calendar' }), 'ui.cal.title')
  assert.equal(surfaceTitleOf({ kind: 'utility', face: 'search' }), 'ui.surface.search')
  assert.equal(surfaceTitleOf({ kind: 'utility', face: 'widgets' }), null, '目录外 ⇒ 没有名字可取')
})
