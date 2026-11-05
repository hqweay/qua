/**
 * **一块为什么能匹配这个词**：从「块 + 词」现算来路。
 *
 * 为什么值得单测：`SearchHit.source` 只有 FTS 路径有，扫描降级永远是 `undefined`。
 * 若来源说明只信它，同一个词在 web 与桌面端会得到两种答案（一处有「经由」、一处空白），
 * 而那种不一致不报错——它只表现为「这里为什么命中，说不出来」。
 *
 * ⚠️ 还有一条**性能**判据（见最后两条）：这条路径在扫描降级时是**每条命中**都走一次的，
 *    所以它必须按 id 查表，不许遍历森林。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, type Block } from '../../src/core/index.ts'
import { matchSourcesOf, type FindBlock } from '../../src/core/search/match-source.ts'

/** 一棵小树 + 按 id 查表（模拟读门面的 `kb.get`） */
function forestOf(blocks: Block[]): FindBlock {
  const all: Block[] = []
  const walk = (list: readonly Block[]): void => {
    for (const b of list) {
      all.push(b)
      walk(b.children)
    }
  }
  walk(blocks)
  const byId = new Map(all.map((b) => [b.id, b]))
  return (id) => byId.get(id)
}

function withAlias(text: string, aliases: string[]): Block {
  const b = mkBlock(text)
  b.props = { ...b.props, _aliases: aliases }
  return b
}

test('正文命中 ⇒ 来路是 content（默认来路）', () => {
  const b = mkBlock('这一句里有探针词')
  const found = matchSourcesOf(forestOf([b]), b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['content'])
})

test('词只在别名里 ⇒ 来路是 alias（正文里没有那个词）', () => {
  const b = withAlias('正文没有那个词', ['探针词-别名'])
  const found = matchSourcesOf(forestOf([b]), b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['alias'])
})

test('词在正文与别名里都有 ⇒ 两个来源各一条（正文在最前）', () => {
  const b = withAlias('正文有探针词', ['探针词-别名'])
  const found = matchSourcesOf(forestOf([b]), b.id, '探针词')
  assert.deepEqual(found.map((x) => x.source), ['content', 'alias'])
})

test('多个词要求全部出现（与查询的 AND 语义一致）：只含半个词的来源不算命中', () => {
  const b = mkBlock('这里只有甲词')
  const found = matchSourcesOf(forestOf([b]), b.id, '甲词 乙词')
  assert.deepEqual(found, [], '只含甲词的来源不该被说成「命中」')
})

test('空词 ⇒ 没有来路可言（最近更新不是一次查询）', () => {
  const b = mkBlock('随便什么')
  assert.deepEqual(matchSourcesOf(forestOf([b]), b.id, '  '), [])
})

test('块查不到 ⇒ 没有来路（不抛错）', () => {
  assert.deepEqual(matchSourcesOf(() => undefined, 'nope', '甲'), [])
})

/**
 * **性能判据：不许遍历森林。**
 *
 * 做法是把「按 id 查块」换成一个**记次数的桩**：森林里放 100k 块、被查的那一块放在**末尾**，
 * 然后断言查表次数是 O(这一块)，不是 O(整库)。
 *
 * 为什么必须钉这一条：这条路径在扫描降级时**每条命中**走一次（`describeHit` 逐行调），
 * 而「索引未就绪」在桌面端也会发生（首次启动、重建期间）。用遍历实现的话
 * 100k 库一条命中 17.8ms、50 条 ≈ 900ms 主线程卡顿，且只在「没有索引」的那几秒出现
 * ——最难归因的那一类。实测旧实现（`probeOf(整片森林)`）正是这个数。
 */
test('按 id 查表：100k 库、命中在末尾时，查表次数不随库规模增长', () => {
  const filler = Array.from({ length: 100000 }, (_, i) => mkBlock(`填充块 ${i}`))
  const hit = withAlias('命中词在末尾', ['末尾别名'])
  const blocks = [...filler, hit]
  const byId = new Map(blocks.map((b) => [b.id, b]))

  let lookups = 0
  const counting: FindBlock = (id) => {
    lookups += 1
    return byId.get(id)
  }
  const found = matchSourcesOf(counting, hit.id, '命中词')
  assert.deepEqual(found.map((x) => x.source), ['content'], '结果要与森林遍历那条一致')

  // O(这一块)：正文 + 别名各判一次，外加少量辅助查表；与 100k 无关
  assert.ok(lookups <= 10, `查表次数应是常数级（这一块自己的来源），实际 ${lookups} 次（≈ 库规模 ⇒ 退化成遍历）`)
})
