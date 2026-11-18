/**
 * `@` 候选行源：**精确地址置顶** ＋ 页 / 块两组，以及行上的**多词 AND + 命中高亮**。
 *
 * 钉住的一件事：查询词逐字等于一个地址时，那个目标排首项且只出现一次；
 * 它排首项不是靠文档序碰巧，而是「最匹配」这一组的存在。名字的读法与页行共用
 * `matchedNameOf`——同一个状态只有一种说法。
 *
 * 第二件：空格是**词分隔**，不是字面字符；行里的 `parts` 必须标出每一个命中，
 * 且命中在长块尾部时片段要以它为中心开窗（否则行看起来「没有这个词」）。
 *
 * 第三件：名字是**地址**的属性——带地址的普通块按别名命中，行显名字、落在块组，
 * 且排在正文命中之前（比「正文碰巧含这几个字」精确）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textRuns, type Block } from '../src/core/index.ts'
import { t } from '../src/core/infra/msg.ts'
import { mentionRows, type MentionDeps } from '../src/app/retrieval/mention-rows.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

function rowsOf(forest: Block[], query: string, selfId: string | null = null) {
  const deps: MentionDeps = {
    forest: () => forest,
    selfBlockId: () => selfId,
    refCount: () => 0,
    newPageAltHint: '',
  }
  return mentionRows(query, deps)
}

/** 页面在前、同名的短页在后：文档序不帮精确命中，置顶只能来自判据本身 */
function forestWithExactPage(): Block[] {
  return [
    b('page-contains', '张三丰的描述', { props: { _aliases: ['张三丰'], _lists: ['page'] } }),
    b('page-exact', '张三的描述', { props: { _aliases: ['张三'], _lists: ['page'] } }),
    b('block-text', '正文里出现张三这两个字'),
  ]
}

test('精确同名页：排首项、单独一组、不再重复出现在页组', () => {
  const rows = rowsOf(forestWithExactPage(), '张三')
  assert.equal(rows[0]?.id, 'retrieval/exact/page-exact')
  assert.equal(rows[0]?.group, 'retrieval/1-exact')
  assert.equal(rows[0]?.label, '张三')
  assert.equal(rows[0]?.hint, t('ui.selRef.exactHint'))
  assert.deepEqual(rows[0]?.pick, { kind: 'page', id: 'page-exact', name: '张三' })
  assert.equal(
    rows.filter((r) => r.pick?.kind === 'page' && r.pick.id === 'page-exact').length,
    1,
    '同一个目标只该有一行',
  )
  assert.deepEqual(
    rows.map((r) => r.group),
    ['retrieval/1-exact', 'retrieval/1-page', 'retrieval/2-block'],
  )
})

test('没有精确地址：不出现「最匹配」组，页仍在块前', () => {
  const rows = rowsOf(forestWithExactPage(), '张')
  assert.ok(rows.every((r) => r.group !== 'retrieval/1-exact'))
  assert.equal(rows[0]?.group, 'retrieval/1-page')
})

test('精确命中别名：行显别名，插入写 anchor（与页行同一口径）', () => {
  const forest = [b('page-alias', '描述', { props: { _aliases: ['主名', '副名'], _lists: ['page'] } })]
  const rows = rowsOf(forest, '副名')
  assert.equal(rows[0]?.label, '副名')
  assert.deepEqual(rows[0]?.pick, { kind: 'page', id: 'page-alias', name: '副名', anchor: '副名' })
})

test('主名也含这个词时：行仍显主名（名字读法只有 matchedNameOf 一份）', () => {
  const forest = [b('page-x', '描述', { props: { _aliases: ['张三丰', '张三'], _lists: ['page'] } })]
  const rows = rowsOf(forest, '张三')
  assert.equal(rows[0]?.label, '张三丰')
  assert.deepEqual(rows[0]?.pick, { kind: 'page', id: 'page-x', name: '张三丰' })
})

test('精确命中普通块：按块落点，不冒充页', () => {
  const forest = [b('block-addr', '正文内容', { props: { _aliases: ['词'] } })]
  const rows = rowsOf(forest, '词')
  assert.equal(rows[0]?.group, 'retrieval/1-exact')
  assert.equal(rows[0]?.label, '词')
  assert.deepEqual(rows[0]?.pick, { kind: 'block', id: 'block-addr', name: '词' })
})

test('标签不置顶：引用标签有它自己的入口（#）', () => {
  const forest = [b('tag-1', '词', { props: { _aliases: ['词'], _lists: ['tag'] } })]
  const rows = rowsOf(forest, '词')
  assert.ok(rows.every((r) => r.group !== 'retrieval/1-exact'))
})

test('软删块不置顶：回收站里的地址不是这次的候选', () => {
  const forest = [b('dead', '描述', { props: { _aliases: ['旧页'], _lists: ['page'], _deletedAt: 1 } })]
  const rows = rowsOf(forest, '旧页')
  assert.ok(rows.every((r) => r.group !== 'retrieval/1-exact'))
})

test('正在打字的自己：既不在页组，也不会被置顶', () => {
  const forest = [b('me', '描述', { props: { _aliases: ['词'], _lists: ['page'] } })]
  const rows = rowsOf(forest, '词', 'me')
  assert.equal(rows.length, 0)
})

test('空查询：没有「最匹配」组（精确命中要有一个词）', () => {
  const rows = rowsOf(forestWithExactPage(), '')
  assert.ok(rows.every((r) => r.group !== 'retrieval/1-exact'))
})

/* ------------------------------------------------------------ 多词与高亮 */

test('多词正文：空格是 AND，命中都标出', () => {
  const forest = [b('block-plan', '项目计划表：这一行的正文')]
  const rows = rowsOf(forest, '计划 项目')
  const hit = rows.find((r) => r.id === 'retrieval/block/block-plan')
  assert.ok(hit, `两个词都出现的块要进候选：${JSON.stringify(rows.map((r) => r.id))}`)
  assert.deepEqual(
    hit!.parts?.filter((p) => p.mark).map((p) => p.text),
    ['项目', '计划'],
  )
  assert.equal(rowsOf(forest, '项目 预算').some((r) => r.id === 'retrieval/block/block-plan'), false)
})

test('多词页名：同一个名字里全含才命中，行显命中的名字并标词', () => {
  const forest = [b('page-plan', '描述', { props: { _aliases: ['Project Plan'], _lists: ['page'] } })]
  const rows = rowsOf(forest, 'plan project')
  assert.equal(rows[0]?.id, 'retrieval/page/page-plan')
  assert.equal(rows[0]?.label, 'Project Plan')
  assert.deepEqual(
    rows[0]?.parts?.filter((p) => p.mark).map((p) => p.text),
    ['Project', 'Plan'],
  )
})

test('多词只在一处别名里全含 ⇒ 页行显那条别名并写 anchor', () => {
  const forest = [
    b('page-alias', '描述', { props: { _aliases: ['主名', 'Project Plan'], _lists: ['page'] } }),
  ]
  const rows = rowsOf(forest, 'plan project')
  const row = rows.find((r) => r.id === 'retrieval/page/page-alias')
  assert.ok(row)
  assert.equal(row!.label, 'Project Plan')
  assert.deepEqual(row!.pick, { kind: 'page', id: 'page-alias', name: 'Project Plan', anchor: 'Project Plan' })
})

test('长块命中在头部之外：片段以命中为中心开窗（行里看得到那个词）', () => {
  const head = '开头'.repeat(60)
  const forest = [b('long', `${head}命中词在这里`)]
  const row = rowsOf(forest, '命中词').find((r) => r.id === 'retrieval/block/long')
  assert.ok(row?.parts?.some((p) => p.mark && p.text === '命中词'), JSON.stringify(row?.parts))
  assert.equal(row?.parts?.[0]?.text, '…', '窗口起点不在开头')
})

test('精确地址带空格：逐字相等仍置顶，并按词标出', () => {
  const forest = [b('page-plan', '描述', { props: { _aliases: ['Project Plan'], _lists: ['page'] } })]
  const rows = rowsOf(forest, 'Project Plan')
  assert.equal(rows[0]?.id, 'retrieval/exact/page-plan')
  assert.deepEqual(
    rows[0]?.parts?.filter((p) => p.mark).map((p) => p.text),
    ['Project', 'Plan'],
  )
})

/* ------------------------------------------------------------ 名字是地址的属性 */

test('普通块的别名可搜：行显名字、落点是块、标出命中', () => {
  const forest = [b('block-alias', '与查询无关的正文', { props: { _aliases: ['术语卡'] } })]
  const rows = rowsOf(forest, '术语')
  const row = rows.find((r) => r.id === 'retrieval/block/block-alias')
  assert.ok(row, `别名命中要进块组：${JSON.stringify(rows.map((r) => r.id))}`)
  assert.equal(row!.group, 'retrieval/2-block')
  assert.equal(row!.label, '术语卡')
  assert.deepEqual(row!.pick, { kind: 'block', id: 'block-alias', name: '术语卡' })
  assert.deepEqual(
    row!.parts?.filter((p) => p.mark).map((p) => p.text),
    ['术语'],
  )
})

test('名字命中排在正文命中之前（同组上限不能把它挤掉）', () => {
  const forest = [
    b('block-text', '术语 出现在这里的正文'),
    b('block-alias', '无关正文', { props: { _aliases: ['术语卡'] } }),
  ]
  const ids = rowsOf(forest, '术语')
    .filter((r) => r.group === 'retrieval/2-block')
    .map((r) => r.id)
  assert.deepEqual(ids, ['retrieval/block/block-alias', 'retrieval/block/block-text'])
})

test('同一块别名与正文都命中 ⇒ 只出一行（名字命中优先）', () => {
  const forest = [b('block-both', '术语 也在正文里', { props: { _aliases: ['术语卡'] } })]
  const rows = rowsOf(forest, '术语')
  assert.equal(rows.filter((r) => r.id === 'retrieval/block/block-both').length, 1)
  assert.equal(rows.find((r) => r.id === 'retrieval/block/block-both')?.label, '术语卡')
})

test('页仍进页面组；带地址的普通块进块组（名字不改变身份分组）', () => {
  const forest = [
    b('page-x', '页描述', { props: { _aliases: ['术语页'], _lists: ['page'] } }),
    b('block-x', '无关', { props: { _aliases: ['术语块'] } }),
  ]
  const rows = rowsOf(forest, '术语')
  assert.equal(rows.find((r) => r.id === 'retrieval/page/page-x')?.group, 'retrieval/1-page')
  assert.equal(rows.find((r) => r.id === 'retrieval/block/block-x')?.group, 'retrieval/2-block')
})
