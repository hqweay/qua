/**
 * 引述变体的纯判据：封闭七值、缺省回落、系统键收端。
 *
 * 为什么值得钉：变体是「这一条引述是什么」的唯一判据，徽章取色、菜单勾选、
 * 查询条件都读它；落进一个不在表里的值，屏幕与查询会各说一套。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { CALLOUT_IDS, CALLOUT_VARIANTS, canonicalCallout, calloutDecl } from '../src/core/infra/callout.ts'
import { systemPropViolation } from '../src/core/props/system-props.ts'

test('七种变体齐全且顺序固定（菜单顺序＝表顺序）', () => {
  assert.deepEqual([...CALLOUT_IDS], ['quote', 'info', 'warning', 'error', 'tip', 'important', 'note'])
  assert.equal(CALLOUT_VARIANTS.length, 7)
  for (const v of CALLOUT_VARIANTS) {
    assert.ok(v.label.length > 0, `${v.id} 必须有文案`)
    assert.ok(v.icon.length > 0, `${v.id} 必须有图标`)
  }
})

test('缺省是普通引述，未知值按缺省画但不写进盘', () => {
  assert.equal(canonicalCallout(undefined), 'quote')
  assert.equal(canonicalCallout(''), 'quote')
  assert.equal(canonicalCallout('bogus'), 'quote')
  assert.equal(calloutDecl('bogus').id, 'quote')
  // 收端只认封闭集：脏值进不了系统键
  assert.equal(systemPropViolation('_callout', 'warning'), null)
  assert.ok(systemPropViolation('_callout', 'bogus') !== null)
})
