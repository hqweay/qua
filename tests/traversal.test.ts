/**
 * **块树遍历只有一个入口**（`core/walk.ts` 的 `walkForest`）。
 *
 * 为什么值得单独钉：全仓十几条读路径都要「把块走一遍」—— 找一个块、列全部块、算路径、
 * 算层级、算可见行、找子树、建索引、按角色筛块……各自写一遍递归时，
 * 「哪些块算活着、按什么顺序走」就有了十几份答案，漏一处就是静默的
 * 「有的地方找得到、有的地方找不到」（日记流与索引对同一天给出两个答案就是这么来的）。
 *
 * 这里钉三件事：
 *   ① 派生出来的读路径**互相一致**（同一片森林、同一个先序）；
 *   ② 早退真的立刻停（「找到就收工」）；
 *   ③ 折叠只改 `hidden`，**不改「走不走得到」**（文档序与可见行是两件事）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allTags,
  descendants,
  depthOf,
  findInForest,
  findJournalDay,
  findPath,
  flatten,
  journalDays,
  locate,
  pathTo,
  visibleRows,
  walkForest,
  type Block,
  type Doc,
} from '../src/core/index.ts'

const mk = (id: string, text = '', children: Block[] = [], extra: Partial<Block> = {}): Block => ({
  id,
  text,
  children,
  ...extra,
})

/**
 * ```
 *  a ── a1 ── a11
 *    └─ a2（折叠）── a21
 *  b ── b1（journal，嵌在子树里）· t1（标签，嵌在子树里）
 * ```
 */
function fixture(): Block[] {
  const a11 = mk('a11', 'a11')
  const a1 = mk('a1', 'a1', [a11])
  const a2 = mk('a2', 'a2', [mk('a21', 'a21')])
  const a = mk('a', 'a', [a1, a2])
  const b1 = mk('b1', '', [], { props: { _date: '2026-10-22' } })
  const t1 = mk('t1', '设计', [], { props: { _roles: ['tag'] } })
  const b = mk('b', 'b', [b1, t1])
  return [a, b]
}

const ids = (bs: readonly Block[]): string[] => bs.map((b) => b.id)

test('一个入口：flatten／locate／pathTo／findPath／findInForest／descendants 互相一致', () => {
  const forest = fixture()
  // a2 收起（折叠态在文档上，不在块上）
  const doc: Doc = { roots: forest, folded: { a2: true } }

  // 文档序就是先序
  assert.deepEqual(ids(flatten(doc)), ['a', 'a1', 'a11', 'a2', 'a21', 'b', 'b1', 't1'])

  for (const id of ids(flatten(doc))) {
    const loc = locate(doc, id)
    assert.ok(loc, `${id} 应找得到`)
    assert.equal(loc.block.id, id)
    assert.equal(findInForest(forest, id)?.id, id, '同一个 id，两个入口同一个答案')
    assert.deepEqual(ids(pathTo(doc, id) ?? []), ids(findPath(forest, id) ?? []), '路径两条路同口径')
  }

  // 住哪：parent / index 与文档序自洽
  assert.equal(locate(doc, 'a11')?.parent?.id, 'a1')
  assert.equal(locate(doc, 'a11')?.index, 0)
  assert.equal(locate(doc, 'a2')?.index, 1, 'a2 是 a 的第二个孩子')
  assert.equal(locate(doc, 'a')?.parent, null, '顶层块的 parent 是 null')
  assert.equal(depthOf(doc, 'a11'), 2)

  assert.deepEqual(ids(pathTo(doc, 'a11') ?? []), ['a', 'a1', 'a11'])
  assert.deepEqual(ids(descendants(forest[0]!)), ['a1', 'a11', 'a2', 'a21'], '后代不含自己')
  assert.equal(findInForest(forest, 'nope'), undefined)
  assert.equal(locate(doc, 'nope'), null)
})

test('早退：visit 返回 false ⇒ 整次遍历立刻停（找到就收工）', () => {
  const seen: string[] = []
  walkForest(fixture(), (b) => {
    seen.push(b.id)
    if (b.id === 'a1') return false
  })
  assert.deepEqual(seen, ['a', 'a1'], 'a1 命中后连它的子树都不该再走')
})

test('path 是活数组：要留用必须自己拷一份', () => {
  const kept: string[][] = []
  walkForest(fixture(), (b, ctx) => {
    if (b.id === 'a11' || b.id === 'b1') kept.push(ids(ctx.path))
  })
  assert.deepEqual(kept, [
    ['a', 'a1', 'a11'],
    ['b', 'b1'],
  ])
})

test('折叠只改 hidden，不改「走不走得到」', () => {
  const doc: Doc = { roots: fixture(), folded: { a2: true } }
  const rows = visibleRows(doc)
  const by = new Map(rows.map((r) => [r.block.id, r]))

  assert.equal(by.get('a2')?.hidden, false, '折叠块自己仍可见')
  assert.equal(by.get('a21')?.hidden, true, '折叠子树里的块标记 hidden')
  assert.equal(by.get('a11')?.depth, 2)
  assert.equal(by.get('a11')?.hidden, false)
  // ⚠️ 折叠**不**让块从文档序里消失：`flatten` 与可见行是两件事
  assert.ok(ids(flatten(doc)).includes('a21'))
  assert.equal(rows.length, flatten(doc).length)
})

test('整片森林口径：嵌在子树里的标签／journal 也走得到', () => {
  const forest = fixture()
  assert.deepEqual(ids(allTags(forest)), ['t1'], '标签不只在顶层')
  assert.deepEqual(
    journalDays(forest).map((b) => b.props?._date),
    ['2026-10-22'],
  )
  assert.equal(findJournalDay(forest, '2026-10-22')?.id, 'b1')
})
