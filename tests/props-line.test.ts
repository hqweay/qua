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
import {
  belowFieldsFor,
  CHILD_PROPS_PROP,
  ENGINE_CREATED,
  enginePropText,
  fieldRows,
  fieldRowsWithParent,
  mkPropDef,
  type FieldRow,
} from '../src/core/index.ts'
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

/* ------------------------------------------------------------ _childProps 与引擎属性 */

test('子块行内属性：父块 _childProps 并入直接子块的行；孙块不沾光', () => {
  const parent = blk('p1', 'Life Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const child = blk('c1', '今天的一条')
  const grand = blk('g1', '细节')
  const forest = [parent, { ...child, children: [grand] } as Block]
  const withParent = (blocks: readonly Block[]) =>
    belowFieldsFor(blocks, forest, (id) => (id === 'c1' ? parent : id === 'g1' ? child : null))
  const rows = withParent([child]).get('c1')?.rows ?? []
  assert.deepEqual(rows.map((r) => r.propId), [ENGINE_CREATED], '子块并入「创建于」')
  assert.equal((withParent([grand]).get('g1')?.rows ?? []).length, 0, '孙块不显示（只直接子块）')
})

test('子块行内属性：有值才显示（普通属性子块没填 ⇒ pending）；子块自己的行优先去重', () => {
  const defMood = mkPropDef('心情', 'text', {}, 'def-mood')
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [defMood.id, ENGINE_CREATED] })
  const empty = blk('c1', '没填心情')
  const own = blk('c2', '自己有这栏', { _ownProps: [defMood.id], 'def-mood': '平静' })
  const forest = [parent, empty, own, defMood]
  const call = (blocks: readonly Block[]) =>
    belowFieldsFor(blocks, forest, (id) => (id === 'c1' || id === 'c2' ? parent : null))
  const e1 = call([empty]).get('c1')
  assert.deepEqual(e1?.rows.map((r) => r.propId), [ENGINE_CREATED], '没填的行不出，引擎行恒有值')
  assert.equal(e1?.pending, 1, '空值记进 pending')
  const e2 = call([own]).get('c2')
  assert.equal(e2?.rows.filter((r) => r.propId === defMood.id).length, 1, '同一 propId 只出一行')
})

test('引擎属性：定义合成注入、值桥到块顶层字段；显示文本今天给时刻、往日带日期', () => {
  const t = new Date('2026-11-08T14:32:00')
  const b = blk('b1', 'x', {})
  b.created = t.getTime()
  // 行只有被声明（如父块 _childProps）才出现——引擎注入的是**定义**（可查、有 label），不是「每块都显示」
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const row = fieldRowsWithParent(b, [b, parent], parent).find((r) => r.propId === ENGINE_CREATED)
  assert.ok(row, '声明后引擎行出现')
  assert.equal(row?.label, '创建于')
  assert.equal(row?.value, b.created, '值桥：来自 block.created，不是 props 袋')
  assert.ok(row?.filled, '引擎行恒有值')
  assert.equal(enginePropText(ENGINE_CREATED, b.created), '14:32', '今天只给时刻')
  const otherDay = new Date('2026-11-01T09:05:00').getTime()
  assert.equal(enginePropText(ENGINE_CREATED, otherDay), '11-01 09:05', '往日带日期')
  // 旧签名（不传 parentOf）行为不变：引擎行不凭空出现
  assert.equal(belowFieldsFor([b], []).get('b1'), undefined)
})

test('fieldRowsWithParent：面板口径与批级一致（父声明排在子块自己的行之后）', () => {
  const defMood = mkPropDef('心情', 'text', {}, 'def-mood2')
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED, defMood.id] })
  const child = blk('c1', '记录', { _ownProps: [defMood.id], 'def-mood2': '平静' })
  const forest = [parent, child, defMood]
  const rows = fieldRowsWithParent(child, forest, parent)
  assert.deepEqual(rows.map((r) => r.propId), [defMood.id, ENGINE_CREATED], '自有行在前、父声明补在后、去重')
  // 单块（无父）等于旧 fieldRows
  assert.deepEqual(fieldRowsWithParent(child, forest, null).map((r) => r.propId), [defMood.id])
})
