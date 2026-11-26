/**
 * **相邻两行接成一行**（`⌫` 在下一行行首／`Delete` 在上一行行尾）：谁活下来、谁被并掉。
 *
 * 钉的是身体那一格：`_code`／`_query`／`_automation` 没有别处可放，所以让哪一行活下来
 * 不是风格问题——错的那一半会把整格身体一起送进回收站，而用户只按了一次删除键。
 *
 * 判据：`pairMergePlan`（`mergeIntoPrevPlan` 与 `mergeIntoNextPlan` 共用）。两条边缘：
 *   · 身体块**可行写的行**（代码／查询／自动化／看法）⇒ 它活下来，邻块的字接进它的标题；
 *   · 露面行（`.tx` 是 `display:none` 的空槽）⇒ 不合并：写进去＝写进一个看不见的格子。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TYPE,
  DELETED_AT_PROP,
  EMBED_TYPE,
  mergeIntoNextPlan,
  mergeIntoPrev,
  mergeIntoPrevPlan,
  mkBlock,
  type Block,
  type Doc,
} from '../src/core/index.ts'
import { plainText } from '../src/core/model/runs.ts'

const code = (title = '', body = 'console.log(1)'): Block => {
  const b = mkBlock(title)
  b.props = { _type: CODE_TYPE, _code: body }
  return b
}

const query = (name = ''): Block => {
  const b = mkBlock(name)
  b.props = { _query: { where: { text: 'x' } } }
  return b
}

const embed = (target: string): Block => {
  const b = mkBlock('')
  b.props = { _type: EMBED_TYPE, _embed: { block: target, view: '' } }
  return b
}

const doc = (...roots: Block[]): Doc => ({ roots })

/** 同一屏里的一列同级行（挂在根块下面 —— `doc.roots` 是装载单位，跨根不接行） */
const under = (...children: Block[]): Doc => {
  const root = mkBlock('根')
  root.children.push(...children)
  return doc(root)
}

test('普通两块：⌫ 让**上一块**活下来（回归）', () => {
  const a = mkBlock('前半')
  const b = mkBlock('后半')
  const plan = mergeIntoPrevPlan(doc(a, b), b.id)
  assert.ok(plan)
  assert.equal(plan.kept, a.id)
  assert.equal(plan.removed, b.id)
  assert.equal(plan.at, 2)
  assert.equal(plainText(plan.content), '前半后半')
})

test('下一块带身体：**身体块活下来**，上一块的字接到它标题前面', () => {
  const a = mkBlock('上一行')
  const c = code('标题')
  const plan = mergeIntoPrevPlan(doc(a, c), c.id)
  assert.ok(plan, '身体有可写的标题行 ⇒ 可以接')
  assert.equal(plan.kept, c.id, '身体块不能被并掉')
  assert.equal(plan.removed, a.id)
  assert.equal(plainText(plan.content), '上一行标题')
  assert.equal(plan.at, 3, '光标落在粘接点（上一块的字之后）')
})

test('上一块带身体：字接在身体块标题后面（既有行为）', () => {
  const c = code('标题')
  const b = mkBlock('下一行')
  const plan = mergeIntoPrevPlan(doc(c, b), b.id)
  assert.ok(plan)
  assert.equal(plan.kept, c.id)
  assert.equal(plan.removed, b.id)
  assert.equal(plainText(plan.content), '标题下一行')
})

test('查询块同样接得住：上一块的字进名字（名字就是那一行）', () => {
  const a = mkBlock('前一格')
  const q = query('查询名')
  const plan = mergeIntoPrevPlan(doc(a, q), q.id)
  assert.ok(plan)
  assert.equal(plan.kept, q.id)
  assert.equal(plainText(plan.content), '前一格查询名')
})

test('露面块两边都不合并：行是隐藏空槽，写进去＝看不见', () => {
  const a = mkBlock('上一行')
  const e = embed('target-1')
  assert.equal(mergeIntoPrevPlan(doc(a, e), e.id), null, '上一块的字不能并进露面的隐藏行')
  const b = mkBlock('下一行')
  assert.equal(mergeIntoPrevPlan(doc(embed('target-2'), b), b.id), null, '露面的正文只读 ⇒ 下一块并不上来')
})

test('两个身体、身份块、只读行：都不合并', () => {
  const c1 = code('一')
  const c2 = code('二')
  assert.equal(mergeIntoPrevPlan(doc(c1, c2), c2.id), null, '一份标题装不下两个身体')

  const page = mkBlock('某页')
  page.props = { _aliases: ['某页'], _lists: ['page'] }
  const plain = mkBlock('下一行')
  assert.equal(mergeIntoPrevPlan(doc(plain, page), page.id), null, '页不能被并掉')

  const day = mkBlock('')
  day.props = { _date: '2026-11-26' }
  assert.equal(mergeIntoPrevPlan(doc(day, plain), plain.id), null, '日期行的正文是投影，不接字')

  const tagged = mkBlock('标签')
  tagged.props = { _aliases: ['标签'], _lists: ['tag'] }
  assert.ok(mergeIntoPrevPlan(doc(tagged, plain), plain.id), '页/标签的正文是描述 ⇒ 当**接收方**照旧成立')
})

test('身体块是首个子块（上一行是它的父块）：不合并，免得把祖先摘掉', () => {
  const parent = mkBlock('父行')
  const c = code('标题')
  parent.children.push(c)
  assert.equal(mergeIntoPrevPlan(doc(parent), c.id), null)
})

test('⌫：收起的子块不参与（上一块是收起那一块自己，不是它藏起来的子块）', () => {
  const a = mkBlock('上一行')
  const hidden = mkBlock('收起的子块')
  const b = mkBlock('下一行')
  a.children.push(hidden)
  const d = doc(a, b)
  d.folded = { [a.id]: true }
  const plan = mergeIntoPrevPlan(d, b.id)
  assert.ok(plan)
  assert.equal(plan.kept, a.id, '接进看得见的那一行')
  assert.equal(plainText(plan.content), '上一行下一行')
})

test('⌦：普通下一块并进来（保上一块 id）', () => {
  const a = mkBlock('前半')
  const b = mkBlock('后半')
  const plan = mergeIntoNextPlan(under(a, b), a.id)
  assert.ok(plan)
  assert.equal(plan.kept, a.id)
  assert.equal(plan.removed, b.id)
  assert.equal(plainText(plan.content), '前半后半')
})

test('⌦：下一块带身体 ⇒ 身体块活下来（与行首 ⌫ 同一个落点）', () => {
  const a = mkBlock('上一行')
  const c = code('标题')
  const plan = mergeIntoNextPlan(under(a, c), a.id)
  assert.ok(plan)
  assert.equal(plan.kept, c.id)
  assert.equal(plan.removed, a.id)
  assert.equal(plainText(plan.content), '上一行标题')
})

test('⌦：下一块是身份块 / 跨到另一个根 ⇒ 不合并', () => {
  const a = mkBlock('一行')
  const page = mkBlock('某页')
  page.props = { _aliases: ['某页'], _lists: ['page'] }
  assert.equal(mergeIntoNextPlan(under(a, page), a.id), null, '页不能被并掉')

  const r1 = mkBlock('第一段')
  const r2 = mkBlock('第二段')
  assert.equal(mergeIntoNextPlan(doc(r1, r2), r1.id), null, '根是这一屏的装载单位，不跨根接行')
})

test('⌦：折叠起来的子块不参与（下一块是收起子树之后的那一行）', () => {
  const a = mkBlock('上一行')
  const hidden = mkBlock('收起的子块')
  const after = mkBlock('下一行')
  a.children.push(hidden)
  const d = under(a, after)
  d.folded = { [a.id]: true }
  const plan = mergeIntoNextPlan(d, a.id)
  assert.ok(plan)
  assert.equal(plan.removed, after.id, '不并进看不见的子块')
})

test('落一次：身体块留 id、标题接上、邻块软删、身体一个字不动', () => {
  const a = mkBlock('上一行')
  const c = code('代码标题', 'let x = 1')
  const own = mkBlock('代码块自己的子块')
  c.children.push(own)
  const d = doc(a, c)

  const r = mergeIntoPrev(d, c.id)
  assert.ok(r)
  assert.equal(r.kept, c.id)
  assert.equal(plainText(c.content), '上一行代码标题')
  assert.equal(c.props?._code, 'let x = 1', '身体一个字不动')
  assert.deepEqual(c.children.map((b) => plainText(b.content)), ['代码块自己的子块'])
  assert.equal(plainText(a.content), '', '空壳清空')
  assert.ok(a.props?.[DELETED_AT_PROP], '带删除标记（软删，⌘Z 可回）')
  assert.deepEqual(d.roots.map((b) => b.id), [a.id, c.id], '删除是原位标记，不摘树')
})

test('落一次：上一块收着子块时，子块接到身体块那一行的**最前**', () => {
  const a = mkBlock('上一行')
  const kid = mkBlock('上一块的子块')
  a.children.push(kid)
  const c = code('代码标题')
  c.children.push(mkBlock('代码块自己的子块'))
  const d = doc(a, c)
  d.folded = { [a.id]: true }

  const r = mergeIntoPrev(d, c.id)
  assert.ok(r)
  assert.equal(r.kept, c.id)
  assert.deepEqual(
    c.children.map((b) => plainText(b.content)),
    ['上一块的子块', '代码块自己的子块'],
    '上一块在上 ⇒ 它的子块接在最前',
  )
})
