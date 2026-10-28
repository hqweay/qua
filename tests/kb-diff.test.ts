/**
 * **`diff` 的四条性质**（每一条都能被独立推翻）。
 *
 * | # | 性质 | 为什么它必须成立 |
 * |---|---|---|
 * | ① | `apply(a, diff(a,b))` 与 `b` **逐字节相等** | 撤销的全部正确性挂在这条上：它是「撤销＝一次普通写入」的充要条件 |
 * | ② | `diff(x,x) == []` | 未变的不发 op（否则撤销一次「什么都没改」会写满整库） |
 * | ③ | 发射序 ＝ 目标森林**先序** | 子树 op 隐含「父先于子」，应用侧按 seq 单调 |
 * | ④ | 同一次 diff 跑两次 ⇒ **逐字节相同** | `at` 必须从目标森林派生（取 `Date.now()` 会让第 ① 条当场失效） |
 *
 * 加两条「结构」的（撤销真正要用的那部分）：
 * ⑤ 撤销一次「插入」⇒ 块**从树上消失**（不是进回收站）
 * ⑥ 撤销一次「删除」⇒ 块**回到原位**（父与前兄弟都对）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, writeBlockContent } from '../src/core/model.ts'
import { textRuns } from '../src/core/runs.ts'
import { diff, forestFingerprint, applyOps } from '../src/core/kb/diff.ts'
import { BlockStore } from '../src/core/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { Op } from '../src/core/kb/types.ts'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 三块森林：`a`（有子块 `a1`）、`b`、`c` */
function fixture() {
  const a1 = mkBlock('甲的子块')
  const a = { ...mkBlock('甲'), children: [a1] }
  const b = mkBlock('乙')
  const c = mkBlock('丙')
  return { a, a1, b, c, forest: [a, b, c] }
}

/** 只比「格」那部分（结构 op 由 MemoryKb 的 Tx 负责，见 `applyGrid` 的注释） */
function gridEqual(x: readonly unknown[], y: readonly unknown[]): void {
  assert.equal(JSON.stringify(x), JSON.stringify(y))
}

/* ------------------------------------------------------------ ① 等式 */

test('① 等式：apply(a, diff(a,b)) 与 b 逐字节相等（含属性与 annos）', () => {
  const { forest } = fixture()
  const target = clone(forest)
  // 改正文、改属性、加属性、删属性、加 anno
  writeBlockContent(target[0]!, textRuns('改过的正文'))
  target[0]!.modified = 9999
  target[0]!.props = { _aliases: ['甲'], _icon: 'lucide:x' }
  target[1]!.props = { _tags: ['t1'] }
  target[2]!.annos = [{ id: 'an1', range: { start: 0, end: 1 } }]

  const cur = clone(forest)
  applyOps(cur, diff(cur, target), target)
  gridEqual(cur, target)
})

test('① 等式：块被软删（`_deletedAt` 出现／消失）也是格写入', () => {
  const { forest } = fixture()
  const target = clone(forest)
  target[1]!.props = { _deletedAt: 12345 }

  const cur = clone(forest)
  applyOps(cur, diff(cur, target), target)
  gridEqual(cur, target)

  // 反向：摘掉删除标记
  const back = clone(target)
  applyOps(back, diff(back, clone(forest)), forest)
  gridEqual(back, forest)
})

/* ------------------------------------------------------------ ② 完备 */

test('② 完备：diff(x, x) == []（未变的不发 op）', () => {
  const { forest } = fixture()
  assert.deepEqual(diff(forest, clone(forest)), [], '什么都没变 ⇒ 零 op')
})

test('② 完备：只改一个字 ⇒ 恰好一条 content op（不是整库）', () => {
  const { forest } = fixture()
  const target = clone(forest)
  writeBlockContent(target[0]!, textRuns('改了'))
  target[0]!.modified = 777

  const ops = diff(forest, target)
  assert.equal(ops.length, 1, `只改一块的正文 ⇒ 一条 op，实际：${JSON.stringify(ops)}`)
  assert.equal(ops[0]!.e, 'block')
})

/* ------------------------------------------------------------ ③ 顺序 */

test('③ 顺序：发射序是目标森林的先序（父 op 先于子 op）', () => {
  const { forest, a, a1, b } = fixture()
  // 目标：a 挪到 b 后面，a1 换父到 b 下面 ⇒ 两块都有位置 op
  const target = [b, { ...a, children: [] }, { ...b, id: b.id, children: [a1] }]
  const ops = diff(forest, target)
  const posOps = ops.filter((o): o is Extract<Op, { e: 'block' }> => o.e === 'block' && o.op === 'upsert' && o.value.parent !== undefined)
  const ids = posOps.map((o) => o.id)
  // 父先于子：b 在 a1 之前
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a1.id), `父块 op 必须在子块之前：${ids.join(',')}`)
})

/* ------------------------------------------------------------ ④ 时刻 */

test('④ 时刻：同一次 diff 跑两次 ⇒ 逐字节相同（`at` 不取 Date.now()）', () => {
  const { forest } = fixture()
  const target = clone(forest)
  writeBlockContent(target[0]!, textRuns('改了'))
  target[0]!.modified = 555

  const first = JSON.stringify(diff(forest, target))
  const second = JSON.stringify(diff(forest, target))
  assert.equal(first, second, '两次 diff 必须逐字节相同；`at` 若取墙钟就会变')
})

test('④ 时刻：`at` 取自目标森林（不是「现在几点」）', () => {
  const { forest } = fixture()
  const target = clone(forest)
  target[0]!.modified = 1234567
  writeBlockContent(target[0]!, textRuns('改了'))
  const ops = diff(forest, target)
  assert.equal(ops[0]!.at, 1234567, '`at` 是目标状态的一部分（可重放），不是这次调用发生的时刻')
})

/* ------------------------------------------------------------ ⑤⑥ 结构（撤销真正要用的） */

test('⑤ 撤销一次插入 ⇒ 块**从树上消失**（不是进回收站）', () => {
  const store = new BlockStore([mkBlock('甲')])
  const kb = new MemoryKb(store)
  const root = kb.roots()[0]!
  const before = forestFingerprint(store.blocks)

  const fresh = mkBlock('新块')
  kb.tx((tx) => tx.insert(fresh, root.id, 0))
  assert.ok(store.find(fresh.id), '插进去了')

  // 撤销：把森林恢复成 before 那份
  const target = JSON.parse(before) as typeof store.blocks
  const ops = diff(store.blocks, target)
  assert.ok(
    ops.some((o) => o.e === 'block' && o.op === 'delete' && o.id === fresh.id),
    `撤销一次插入必须产出「清除这一块」的 op（不是软删）：${JSON.stringify(ops)}`,
  )
})

test('⑥ 撤销一次**软删** ⇒ 一条 `prop.delete(_deletedAt)`，**不需要**位置 op', () => {
  const store = new BlockStore([mkBlock('甲'), mkBlock('乙'), mkBlock('丙')])
  const kb = new MemoryKb(store)
  const ids = kb.roots().map((b) => b.id)
  const before = forestFingerprint(store.blocks)

  kb.tx((tx) => tx.remove(ids[1]!))
  const target = JSON.parse(before) as typeof store.blocks
  const ops = diff(store.blocks, target)

  /**
   * 软删的块**从未离开树**（原位标记，遍历跳过）⇒ 撤销它只是摘掉那个标记。
   * 这比「重新插入到原位」更精确，也更便宜：位置从来没有变过。
   */
  assert.deepEqual(
    ops,
    [{ e: 'prop', block: ids[1], name: '_deletedAt', op: 'delete', at: target[1]!.modified }],
    `撤销软删 = 摘标记一条 op，实际：${JSON.stringify(ops)}`,
  )
  // 且它本来就在原位（父与前兄弟都没变）
  const cur = clone(store.blocks)
  applyOps(cur, ops, target)
  gridEqual(cur, target)
})
