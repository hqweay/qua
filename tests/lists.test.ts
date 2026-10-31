/**
 * **列表是「露面」，不是角色，也不是转换**。
 *
 * 页与标签可以兼位：同一个块同时进 `page` 与 `tag` 两个列表，顺序不承载语义。
 * 这里钉住五条：幂等、顺序无关、只动一个列表、去掉最后一个列表后槽位消失，
 * 以及**身份不等于列表**——日记／字段定义／查询视图的身份由数据推出；
 * 名字（`_aliases`）也是身份，但它不进 `identityTags`（那是外观要认的种类）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  addList,
  canWriteText,
  hasIdentity,
  hasList,
  identityTags,
  isJournalBlock,
  isPropDefBlock,
  isQueryBlock,
  listsOf,
  mkBlock,
  removeList,
  whereOf,
} from '../src/core/index.ts'
import { t } from '../src/core/msg.ts'

const b = (): Block => mkBlock('一块')

test('加/减列表是幂等的', () => {
  const x = b()
  assert.equal(addList(x, 'page'), true)
  assert.equal(addList(x, 'page'), false, '重复加不产生第二个条目')
  assert.deepEqual(x.props?._lists, ['page'])
  assert.equal(removeList(x, 'page'), true)
  assert.equal(removeList(x, 'page'), false)
  assert.equal(x.props, undefined, '去掉最后一个列表后不留空数组、也不留空属性袋')
})

test('顺序不承载语义：先页后标签与先标签后页等价', () => {
  const a = b()
  const c = b()
  addList(a, 'page')
  addList(a, 'tag')
  addList(c, 'tag')
  addList(c, 'page')
  assert.ok(hasList(a, 'page') && hasList(a, 'tag'))
  assert.ok(hasList(c, 'page') && hasList(c, 'tag'))
  assert.deepEqual(listsOf(a).sort(), listsOf(c).sort())
})

test('减一个列表不动别的列表', () => {
  const x = b()
  addList(x, 'page')
  addList(x, 'tag')
  assert.equal(removeList(x, 'tag'), true)
  assert.ok(hasList(x, 'page'))
  assert.ok(!hasList(x, 'tag'))
  assert.deepEqual(x.props?._lists, ['page'])
})

test('兼位：page + tag 同时进两个列表；空列表合法', () => {
  const both: Block = { id: 'both', text: '一块', children: [] }
  addList(both, 'page')
  addList(both, 'tag')
  assert.deepEqual(listsOf(both), ['page', 'tag'])
  assert.deepEqual(linesFor(both, 'page'), ['both'], '页列表按 hasList 过滤，兼位块不会因为也是标签就消失')
  assert.deepEqual(linesFor(both, 'tag'), ['both'])

  const none: Block = { id: 'none', text: '一块', children: [] }
  assert.deepEqual(listsOf(none), [], '一个列表都不进是合法状态')
  assert.deepEqual(linesFor(none, 'page'), [])
})

/** 「某个列表里有哪些块」＝页面/标签列表的过滤口径 */
function linesFor(block: Block, list: 'page' | 'tag'): string[] {
  return [block].filter((x) => hasList(x, list)).map((x) => x.id)
}

test('日记／字段定义／查询视图的身份由数据推出，不存列表值', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  const def: Block = { id: 'd', text: '截止日', children: [], props: { _kind: 'date' } }
  const query: Block = { id: 'q', text: '待办', children: [], props: { _query: { where: { text: '待办' } } } }

  assert.ok(isJournalBlock(day))
  assert.ok(isPropDefBlock(def))
  assert.ok(isQueryBlock(query))
  assert.deepEqual(listsOf(day), [], '日记没有列表值：日期就是全部答案')
  assert.deepEqual(listsOf(def), [])
  assert.deepEqual(listsOf(query), [])

  for (const x of [day, def, query]) assert.ok(hasIdentity(x), '这三个都是身份块：正文是名字或投影')
  assert.ok(hasIdentity(undefined) === false)
})

test('身份判据看数据而不看列表值：有列表但没日期不算日记', () => {
  const empty: Block = { id: 'x', text: '', children: [], props: { _date: '' } }
  assert.equal(isJournalBlock(empty), false, '空日期不是一天')
  assert.equal(hasIdentity(empty), false)

  // 形状歪掉的 `_query` 也不是查询块（判据与读条件同源）
  const badQuery: Block = { id: 'y', text: 'x', children: [], props: { _query: { scope: 'all' } } }
  assert.equal(isQueryBlock(badQuery), false)
})

test('canWriteText：只拦日记／定义／查询／只读类型；页与标签的正文是描述，可写', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  const def: Block = { id: 'd', text: '截止日', children: [], props: { _kind: 'date' } }
  const query: Block = { id: 'q', text: '待办', children: [], props: { _query: { where: { text: '待办' } } } }
  const tag = b()
  addList(tag, 'tag')
  const page = b()
  addList(page, 'page')
  const divider: Block = { id: 'v', text: '', children: [], props: { _type: 'core/divider' } }

  for (const x of [day, def, query, divider]) assert.equal(canWriteText(x), false)
  for (const x of [tag, page, b()]) assert.equal(canWriteText(x), true)
})

test('identityTags：给外观与诊断面的名字集合是现算的，不落盘；别名不进这里', () => {
  const day: Block = { id: 'j', text: '', children: [], props: { _date: '2026-10-22' } }
  assert.deepEqual(identityTags(day), ['journal'])
  assert.equal(day.props?._lists, undefined, '标记不许写回块')

  const both = b()
  addList(both, 'page')
  addList(both, 'tag')
  both.props = { ...both.props, _date: '2026-10-22' }
  assert.deepEqual(identityTags(both), ['page', 'tag', 'journal'], '列表与派生身份并存')

  const named = b()
  named.props = { ...(named.props ?? {}), _aliases: ['一个名字'] }
  assert.deepEqual(identityTags(named), [], '别名是地址，不是外观要认的身份种类')
})

test('whereOf：兼位按集合说 —— 「页、标签」不能只说成「页」', () => {
  const none = b()
  assert.equal(whereOf(none), t('ui.where.block'), '不进任何列表 ⇒ 就是「块」')

  const page = b()
  addList(page, 'page')
  assert.equal(whereOf(page), t('ui.where.page'))

  const tag = b()
  addList(tag, 'tag')
  assert.equal(whereOf(tag), t('ui.where.tag'))

  const both = b()
  addList(both, 'page')
  addList(both, 'tag')
  assert.equal(
    whereOf(both),
    `${t('ui.where.page')}${t('ui.where.sep')}${t('ui.where.tag')}`,
    '只说「页」会让人以为去掉页标记就能腾出这个名字，而名字属于块本身',
  )
})
