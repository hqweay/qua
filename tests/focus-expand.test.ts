/**
 * **聚焦即展开**：这一屏只剩一个根时，那个根自己的折叠不生效。
 *
 * 三条要钉住的事：
 *   1. 折叠表**一个字节不动**（退出聚焦自动恢复，不需要「进来之前收没收」的快照）；
 *   2. 只在「这一屏真的只有它」时生效（多段日记流里收起某一天照旧）；
 *   3. 用户显式折它 ⇒ 以这次为准（不会既写了折叠表又被豁免掉 = 点了没反应）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  foldStateOf,
  focusRootOf,
  isFolded,
  mkBlock,
  toggleCollapsed,
  visibleRows,
  type Block,
  type Doc,
} from '../src/core/index.ts'

/** 折起来的父块 ＋ 两个子块（内容块，无身份） */
function fixture(): { doc: Doc; parent: Block } {
  const parent = mkBlock('父块', { props: {} })
  parent.children.push(mkBlock('子一'), mkBlock('子二'))
  const doc: Doc = { roots: [parent], folded: { [parent.id]: true }, focusRootId: parent.id, focusRootOpen: true }
  return { doc, parent }
}

test('聚焦即展开：折叠表原样留着，但这一屏的生效表里没有它', () => {
  const { doc, parent } = fixture()
  assert.equal(doc.folded?.[parent.id], true, '落盘那份还在（退出聚焦要能回来）')
  assert.equal(isFolded(doc, parent.id), false, '这一屏里它是展开的')
  assert.equal(foldStateOf(doc)[parent.id], undefined, '生效表里摘掉它')
  const rows = visibleRows(doc).filter((r) => !r.hidden)
  assert.equal(rows.length, 3, `整屏应是父块 ＋ 两个子块：${rows.length}`)
})

test('退出聚焦（换成多根装载）⇒ 那一块回到原来的折叠态（不需要记快照）', () => {
  const { doc, parent } = fixture()
  const other = mkBlock('另一段')
  // 装载换成多段：聚焦位按形状消失（装配层会清这两位）
  const out: Doc = { roots: [parent, other], folded: doc.folded }
  assert.equal(isFolded(out, parent.id), true, '多段装载里它照旧收着 —— 折叠表一个字节没动')
  assert.equal(foldStateOf(out)[parent.id], true)
  assert.equal(focusRootOf(out.roots), undefined, '多根不是聚焦装载')
})

test('聚焦豁免只在「这一屏真的只有它」时生效：多根装载里同一个 id 不豁免', () => {
  const { doc, parent } = fixture()
  const other = mkBlock('另一段')
  // 极端情形：有人把 focusRootId 留下来了（不该发生，但判据要能自证）
  const stale: Doc = { roots: [parent, other], folded: doc.folded, focusRootId: parent.id, focusRootOpen: true }
  assert.equal(isFolded(stale, parent.id), true, '根集合变多了 ⇒ 它不再是整屏的内容，折叠照旧生效')
})

test('用户显式折聚焦根 ⇒ 以这次为准（写了折叠表，并撤掉豁免）', () => {
  const { doc, parent } = fixture()
  assert.equal(toggleCollapsed(doc, parent.id), true, '聚焦期间仍然折得起来')
  assert.equal(doc.focusRootOpen, undefined, '显式折过 ⇒ 撤掉豁免，否则点了没反应')
  assert.equal(isFolded(doc, parent.id), true, '这次折叠当场生效')
  const rows = visibleRows(doc).filter((r) => !r.hidden)
  assert.equal(rows.length, 1, '折起来之后子行不挂载')
})

test('聚焦期间折过之后，同一屏重装（根不变）也保持收起', () => {
  const { doc, parent } = fixture()
  toggleCollapsed(doc, parent.id)
  // 装配层同一屏重装时按「根不变」保留用户的选择 ⇒ 重新给上聚焦位但不给豁免
  doc.focusRootId = parent.id
  assert.equal(isFolded(doc, parent.id), true, '根不变的重装不许把用户刚折的又弹开')
})

test('重新聚焦这一块 ⇒ 又是一次新的「只看这一块」，按聚焦即展开给上', () => {
  const { doc, parent } = fixture()
  toggleCollapsed(doc, parent.id)
  doc.focusRootId = parent.id
  doc.focusRootOpen = true
  assert.equal(isFolded(doc, parent.id), false, '新的聚焦装载 ⇒ 展开（这次是用户重新点进来的）')
})

test('focusRootOf：单根才给，多根/空都不给', () => {
  const a = mkBlock('a')
  const b = mkBlock('b')
  assert.equal(focusRootOf([a]), a.id)
  assert.equal(focusRootOf([a, b]), undefined)
  assert.equal(focusRootOf([]), undefined)
})

test('没有聚焦位的老形状（缺这两位）⇒ 一切照旧', () => {
  const parent = mkBlock('父块')
  parent.children.push(mkBlock('子'))
  const doc: Doc = { roots: [parent], folded: { [parent.id]: true } }
  assert.equal(isFolded(doc, parent.id), true, '缺字段 ⇒ 不做豁免')
  assert.equal(visibleRows(doc).filter((r) => !r.hidden).length, 1)
})
