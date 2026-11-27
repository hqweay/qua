/**
 * **行下身体的种类表**（`core/model/tree.ts` 的 `bodyKindOf`）与它的两条派生。
 *
 * 为什么值得钉：这张表是「有没有身体」「能不能折身体」「身体挂到哪」的共同来源。
 * 曾经清单抄在四处（模型的 `hasBody`／渲染层的 `inlineBodyKind`／编辑器的
 * `bodyFoldable` 各列一遍），漏一处就是「按钮画了却按不动」——定义块的身体就踩过：
 * 行头折叠键画出来了，`hasBody` 不认它，`toggleBodyCollapsed` 直接 return false。
 *
 * 这里钉三件事：① 每种身体都有准入判据（五格各自答「是」）；② 每种身体都可折
 * （`hasFoldable` 与 `toggleBodyCollapsed` 同一份清单）；③ 分派顺序：激活的
 * children 看法优先于属性投影（否则子块行与看法两样都落空）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BODY_KINDS,
  bodyKindOf,
  bodyVisible,
  hasBody,
  hasFoldable,
  isBodyFolded,
  mkBlock,
  toggleBodyCollapsed,
  visibleRows,
  type Block,
  type BodyKind,
  type Doc,
} from '../src/core/index.ts'

const query = (): Block => mkBlock('查询', { props: { _query: { where: { any: [] } } } })
const automation = (): Block => mkBlock('规则', { props: { _automation: { triggers: [{ kind: 'manual' }] } } })
const def = (): Block => mkBlock('状态', { props: { _kind: 'select' } })
const tagged = (props: Record<string, unknown> = {}): Block => mkBlock('任务', { props: { _lists: ['tag'], ...props } })
const embed = (): Block => mkBlock('露面', { props: { _embed: { block: 'somewhere-else', view: '' } } })
const code = (): Block => mkBlock('标题', { props: { _type: 'core/code', _code: 'x = 1' } })
const plain = (): Block => mkBlock('一句话')

/** 每种身体一个准入样本（`def` 有两例：定义块与声明了字段的标签） */
const SAMPLES: Record<BodyKind, () => Block> = {
  view: query,
  automation,
  def,
  embed,
  code,
}

const docOf = (b: Block): Doc => ({ roots: [b], folded: {}, bodyFolded: {} })

test('种类表覆盖五种身体：每一种都答得出自己的 kind，普通块答 null', () => {
  for (const kind of BODY_KINDS) {
    const b = SAMPLES[kind]()
    assert.equal(bodyKindOf(b), kind, `${kind} 的准入判据`)
    assert.equal(hasBody(b), true, `${kind} 有身体`)
  }
  assert.equal(bodyKindOf(plain()), null, '普通块没有身体')
  assert.equal(hasBody(plain()), false)
})

test('典型的第二种 def：声明了字段的标签与定义块同一格', () => {
  assert.equal(bodyKindOf(def()), 'def', '定义块画值配置')
  assert.equal(bodyKindOf(tagged({ _fieldDefs: ['p1'] })), 'def', '声明了字段的标签画字段声明')
  assert.equal(bodyKindOf(tagged()), null, '没有声明的空标签不画（声明非空才画）')
})

test('分派顺序：激活的 children 看法优先于属性投影', () => {
  const b = tagged({ _fieldDefs: ['p1'], _views: [{ id: 'v1', kind: 'table' }], _activeView: 'v1' })
  assert.equal(bodyKindOf(b), 'view', '激活看法时身体必须是视图：def 会把子块行与看法一起落空')
  const q = mkBlock('查询', {
    props: { _query: { where: { any: [] } }, _views: [{ id: 'v1', kind: 'table' }], _activeView: 'v1' },
  })
  assert.equal(bodyKindOf(q), 'view')
})

test('折叠准入：每种身体都能被「只收身体」收起，且没有子块也照样准入', () => {
  for (const kind of BODY_KINDS) {
    const b = SAMPLES[kind]()
    assert.equal(hasFoldable(b), true, `${kind} 可折`)
    const doc = docOf(b)
    assert.equal(toggleBodyCollapsed(doc, b.id), true, `${kind} 的身体可以收`)
    assert.equal(isBodyFolded(doc, b.id), true)
    assert.equal(bodyVisible(doc, b.id), false)
  }
})

test('def 块只收身体不折子块：子块行仍在可见行里', () => {
  const kid = mkBlock('子块')
  const b = def()
  b.children.push(kid)
  const doc = docOf(b)
  assert.equal(toggleBodyCollapsed(doc, b.id), true)
  assert.equal(doc.folded?.[b.id], undefined, '整片折叠位不动：子块不该跟着收')
  const rows = visibleRows(doc)
    .filter((r) => !r.hidden)
    .map((r) => r.block.id)
  assert.deepEqual(rows, [b.id, kid.id], '子块照常在上面')
})

test('声明了字段的标签同理：收身体不收子块', () => {
  const kid = mkBlock('成员')
  const b = tagged({ _fieldDefs: ['p1'] })
  b.children.push(kid)
  const doc = docOf(b)
  assert.equal(toggleBodyCollapsed(doc, b.id), true)
  assert.deepEqual(
    visibleRows(doc)
      .filter((r) => !r.hidden)
      .map((r) => r.block.id),
    [b.id, kid.id],
  )
})

test('没有身体的块仍然拒绝记「只收身体」：不记一个不存在的事实', () => {
  const doc = docOf(plain())
  const b = doc.roots[0]!
  assert.equal(toggleBodyCollapsed(doc, b.id), false)
  assert.deepEqual(doc.bodyFolded, {})
})
