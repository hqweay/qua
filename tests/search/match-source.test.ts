/**
 * **一块为什么能匹配这个词**：从「块 + 词」现算来路。
 *
 * 为什么值得单测：`SearchHit.source` 只有 FTS 路径有，扫描降级永远是 `undefined`。
 * 若来源说明只信它，同一个词在 web 与桌面端会得到两种答案（一处有「经由」、一处空白），
 * 而那种不一致不报错——它只表现为「这里为什么命中，说不出来」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, type Block } from '../../src/core/index.ts'
import { matchSourcesOf } from '../../src/core/search/match-source.ts'

function withAlias(text: string, aliases: string[]): Block {
  const b = mkBlock(text)
  b.props = { ...b.props, _aliases: aliases }
  return b
}

test('正文命中 ⇒ 来路是 content（默认来路）', () => {
  const b = mkBlock('这一句里有探针词')
  const found = matchSourcesOf([b], b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['content'])
})

test('词只在别名里 ⇒ 来路是 alias（正文里没有那个词）', () => {
  const b = withAlias('正文没有那个词', ['探针词-别名'])
  const found = matchSourcesOf([b], b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['alias'])
})

test('词在正文与别名里都有 ⇒ 两个来源各一条（正文在最前）', () => {
  const b = withAlias('正文有探针词', ['探针词-别名'])
  const found = matchSourcesOf([b], b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['content', 'alias'])
})

test('多个词要求全部出现（与查询的 AND 语义一致）：只含半个词的来源不算命中', () => {
  const b = mkBlock('这里只有甲词')
  const found = matchSourcesOf([b], b.id, '甲词 乙词')
  assert.deepEqual(found, [], '只含甲词的来源不该被说成「命中」')
})

test('空词 ⇒ 没有来路可言（最近更新不是一次查询）', () => {
  assert.deepEqual(matchSourcesOf([mkBlock('随便什么')], mkBlock('x').id, '  '), [])
})

test('块不在森林里 ⇒ 没有来路（不抛错）', () => {
  assert.deepEqual(matchSourcesOf([mkBlock('甲')], 'nope', '甲'), [])
})
