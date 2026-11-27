/**
 * **字段声明表的完整性**（`core/props/fields.ts`）。
 *
 * 一张表喂五个面（字段下拉、值控件、人话 chip、记录投影、候选计划），所以「声明自己
 * 是否自洽」必须独立可测——某一面漏判不会在别的面上显形，只会表现为「下拉里有、
 * 求值不认」「分组落未设置」这类错位。
 *
 * 六条判据：id 唯一 · `exposed ⊆ queryable` · 类型拥有就必须给缺省 · 恒声明就必须恒 declared ·
 * `select` 有选项域或标开放 · `_` 键都进写侧判据表。前五条是**声明级**的（加一行就可能违反），
 * 最后一条钉住「读写两侧认识同一批键」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SYSTEM_FIELDS, readSystemField, type Block } from '../src/core/index.ts'
import { SYSTEM_PROP_CHECKS } from '../src/core/props/system-props.ts'
import { textRuns } from '../src/core/model/runs.ts'

const b = (id: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(''),
  children: [],
  created: 1_700_000_000_000,
  modified: 1_700_000_000_001,
  ...(props ? { props } : {}),
})

const EMPTY_TAGS: ReadonlySet<string> = new Set()

test('声明完整性：id 唯一，`exposed` 一定是 `queryable`（下拉里有的，求值必须认）', () => {
  const ids = SYSTEM_FIELDS.map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, `声明 id 有重复：${ids.join('／')}`)
  for (const decl of SYSTEM_FIELDS) {
    if (decl.exposed !== true) continue
    assert.equal(decl.queryable, true, `${decl.id} 进了字段下拉却不求值认：用户会看到一个填了没用的条件`)
  }
})

test('类型拥有的槽必须给缺省：缺键要有语义，否则「有这一栏但没值」是空的', () => {
  for (const decl of SYSTEM_FIELDS) {
    if (decl.ownerType === undefined) continue
    assert.notEqual(decl.default, undefined, `${decl.id} 由类型拥有（ownerType）但没写 default`)
  }
})

test('恒声明的槽：任何块读出来都 declared（`exists:false` 因此可精确到空集）', () => {
  const samples = [b('plain'), b('with-props', { _type: 'core/code' })]
  for (const decl of SYSTEM_FIELDS) {
    if (decl.mandatory !== true) continue
    for (const block of samples) {
      const read = readSystemField(block, decl.id, { liveTags: EMPTY_TAGS })
      assert.equal(read?.declared, true, `${decl.id} 声明为恒有，但读 ${block.id} 说没这一栏`)
    }
  }
})

test('下拉里的 select 槽要么有选项域，要么标了开放：值控件不能给出一个空下拉', () => {
  for (const decl of SYSTEM_FIELDS) {
    // 只管 `exposed`：不进下拉的槽没有值控件（由 JSON 写成，条件树如实显示）
    if (decl.exposed !== true || decl.kind !== 'select') continue
    const hasChoices = decl.choices !== undefined && decl.choices(undefined).length > 0
    assert.ok(hasChoices || decl.open === true, `${decl.id} 是 select，但既没有选项也没有标 open`)
  }
})

test('`_` 开头的声明键都在系统属性判据表里（`core/*` 是块列，不在此列）', () => {
  for (const decl of SYSTEM_FIELDS) {
    if (!decl.id.startsWith('_')) continue
    assert.ok(
      Object.hasOwn(SYSTEM_PROP_CHECKS, decl.id),
      `${decl.id} 能读能查，但写侧判据表里没登记：同一个键两套严格度`,
    )
  }
})

test('声明覆盖了求值白名单与下拉的全部系统槽（两张投影各自只差一滤）', () => {
  // 反向卫生：白名单／下拉都不是独立清单，改动声明即改动它们；这里只是把「有人又加了一份」变红
  const queryable = SYSTEM_FIELDS.filter((d) => d.queryable === true).map((d) => d.id)
  const exposed = SYSTEM_FIELDS.filter((d) => d.exposed === true).map((d) => d.id)
  assert.ok(queryable.length >= exposed.length)
  assert.deepEqual(exposed, ['_date', '_aliases', '_type', '_callout', '_lang'], '下拉顺序＝声明顺序（固定殿后）')
})
