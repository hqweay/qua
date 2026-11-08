/**
 * **「新块落在哪」的唯一判据**（`insertSiteOf`）。
 *
 * 三个入口共用这一条口径（`/待办`、`/分割线`、`/查询`、露面）：空块原地改、
 * section 根的首个子块、其余插在下一个兄弟位。它被抄成三份时，每一份都能单独漂移，
 * 而漂移的形态是「同一个斜杠动作在不同的行里落到不同的地方」——只有断言抓得住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { insertSiteOf, locate, mkBlock, type Block } from '../src/core/index.ts'

const docOf = (roots: Block[]) => ({ roots, folded: {} })

test('空块 ⇒ 原地改（不新建）', () => {
  const child = mkBlock('')
  const page = mkBlock('页', {})
  child.id = 'child'
  page.id = 'page'
  page.children = [child]
  const loc = locate(docOf([page]), 'child')!
  assert.deepEqual(insertSiteOf(loc, { blank: true }), { kind: 'replace' })
})

test('普通块有正文 ⇒ 下一个兄弟位（不是子块）', () => {
  const a = mkBlock('甲')
  const b = mkBlock('乙')
  a.id = 'a'
  b.id = 'b'
  const page = mkBlock('页')
  page.id = 'page'
  page.children = [a, b]
  const loc = locate(docOf([page]), 'a')!
  assert.deepEqual(insertSiteOf(loc, { blank: false }), { kind: 'after', parentId: 'page', index: 1 })
})

test('section 根（没有兄弟位）⇒ 首个子块', () => {
  const page = mkBlock('页')
  page.id = 'page'
  const loc = locate(docOf([page]), 'page')!
  assert.deepEqual(insertSiteOf(loc, { blank: false }), { kind: 'first-child', parentId: 'page' })
})

test('声明容不下子块的根 ⇒ null（插不进去，不静默挪到别处）', () => {
  const divider = mkBlock('')
  divider.id = 'divider'
  divider.props = { _type: 'core/divider' }
  const loc = locate(docOf([divider]), 'divider')!
  assert.equal(insertSiteOf(loc, { blank: false }), null)
})

test('同一层里的下标跟着真实位置走（不总是 0）', () => {
  const kids = ['k1', 'k2', 'k3'].map((id) => {
    const b = mkBlock(id)
    b.id = id
    return b
  })
  const page = mkBlock('页')
  page.id = 'page'
  page.children = kids
  const loc = locate(docOf([page]), 'k2')!
  assert.deepEqual(insertSiteOf(loc, { blank: false }), { kind: 'after', parentId: 'page', index: 2 })
})

/* ---- dir: 'before'（上方插入，⌘⇧↵）---- */

test('before：普通块 ⇒ 上一个兄弟位（同父、自己的下标）', () => {
  const a = mkBlock('甲')
  const b = mkBlock('乙')
  a.id = 'a'
  b.id = 'b'
  const page = mkBlock('页')
  page.id = 'page'
  page.children = [a, b]
  const loc = locate(docOf([page]), 'b')!
  assert.deepEqual(insertSiteOf(loc, { blank: false, dir: 'before' }), { kind: 'before', parentId: 'page', index: 1 })
})

test('before：空块 ⇒ 仍是原地改（上方插落在空白行上，意图已满足）', () => {
  const child = mkBlock('')
  child.id = 'child'
  const page = mkBlock('页')
  page.id = 'page'
  page.children = [child]
  const loc = locate(docOf([page]), 'child')!
  assert.deepEqual(insertSiteOf(loc, { blank: true, dir: 'before' }), { kind: 'replace' })
})

test('before：section 根没有上方兄弟位 ⇒ 退化为首个子块', () => {
  const page = mkBlock('页')
  page.id = 'page'
  const loc = locate(docOf([page]), 'page')!
  assert.deepEqual(insertSiteOf(loc, { blank: false, dir: 'before' }), { kind: 'first-child', parentId: 'page' })
})

test('before：声明容不下子块的根 ⇒ null（与 after 同一口径，不静默挪到别处）', () => {
  const divider = mkBlock('')
  divider.id = 'divider'
  divider.props = { _type: 'core/divider' }
  const loc = locate(docOf([divider]), 'divider')!
  assert.equal(insertSiteOf(loc, { blank: false, dir: 'before' }), null)
})
