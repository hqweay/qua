/**
 * **块下属性行**的派生：一条属性只在一个地方画。
 *
 * 验收口径：
 *   · 有值才进这一行（空值只记数，交给面板与 `+N`）；
 *   · 已经画成块标后图标的不重复（`select`／`checkbox` ＋ `_uiPosition: block-left`）；
 *   · `block-left` 手写在**画不出图标**的类型上时，仍要落在块下行 —— 不能两头都没有；
 *   · 批级派生与单块 `fieldRows` 过滤的结论**逐行一致**（同一份行派生，两个画法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { belowFieldsFor, fieldRows, mkPropDef, type FieldRow } from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'

/* ------------------------------------------------------------ 夹具 */

const blk = (id: string, text = '', props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const tag = (id: string, name: string, fields: string[]): Block =>
  blk(id, name, { _aliases: [name], _lists: ['tag'], _fieldDefs: fields })

/** 一个块 + 一个声明了四类属性的标签：文本／块标图标／空文本／`block-left` 的文本 */
function fixture(): { forest: Block[]; block: Block } {
  const defAuthor = mkPropDef('作者', 'text', {}, 'def-author')
  const defStatus = mkPropDef('状态', 'select', { _uiPosition: 'block-left' }, 'def-status')
  const defNote = mkPropDef('备注', 'text', {}, 'def-note')
  // `block-left` 手写在 text 上：gutter 不画图标（只有 select/checkbox 会画）⇒ 必须落在块下行
  const defPinned = mkPropDef('钉住', 'text', { _uiPosition: 'block-left' }, 'def-pinned')
  const t = tag('tag-book', '书', [defAuthor.id, defStatus.id, defNote.id, defPinned.id])
  const b = blk('b1', '一本书', {
    _tags: [t.id],
    'def-author': '张三',
    'def-status': 'choice-1',
    'def-pinned': '在块下',
  })
  return { forest: [t, defAuthor, defStatus, defNote, defPinned, b], block: b }
}

const labels = (rows: readonly FieldRow[]): string[] => rows.map((r) => r.label)

/* ------------------------------------------------------------ 断言 */

test('块下属性行：有值才画；块标图标上的不重复；空值只记数', () => {
  const { forest, block } = fixture()
  const got = belowFieldsFor([block], forest).get(block.id)
  assert.ok(got, '有值 ⇒ 这一行存在')
  assert.deepEqual(labels(got.rows), ['作者', '钉住'], '作者（文本）与钉住（block-left 但画不出图标）都在；状态有图标、备注没值')
  assert.equal(got.pending, 1, '备注声明了但没填 ⇒ 记 1 条待填，不占这一行的额度')
})

test('块下属性行：一个值都没有 ⇒ 不出这一行（不靠空行表达 schema）', () => {
  const defAuthor = mkPropDef('作者', 'text', {}, 'def-author')
  const t = tag('tag-book', '书', [defAuthor.id])
  const b = blk('b1', '一本书', { _tags: [t.id] })
  assert.equal(belowFieldsFor([b], [t, defAuthor, b]).get(b.id), undefined)
})

test('块下属性行：批级派生与单块 fieldRows 过滤逐行一致', () => {
  const { forest, block } = fixture()
  const batch = belowFieldsFor([block], forest).get(block.id)!
  const single = fieldRows(block, forest).filter((row) => {
    if (!row.filled) return false
    if (!row.def) return true
    if (row.def.props?.['_uiPosition'] !== 'block-left') return true
    return row.kind !== 'select' && row.kind !== 'checkbox'
  })
  assert.deepEqual(
    batch.rows.map((r) => [r.propId, r.label, r.value]),
    single.map((r) => [r.propId, r.label, r.value]),
  )
  assert.equal(
    batch.pending,
    fieldRows(block, forest).filter((r) => {
      if (r.filled || !r.def) return false
      if (r.def.props?.['_uiPosition'] !== 'block-left') return true
      return r.kind !== 'select' && r.kind !== 'checkbox'
    }).length,
  )
})
