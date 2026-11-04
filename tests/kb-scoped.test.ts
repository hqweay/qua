/**
 * **scoped before-state（撤销只记 touched 的块）**：六类边界 ＋ 一条「与库体量无关」。
 *
 * 每条断言都按「撤销一步到位」写：撤销后整片森林的 `forestFingerprint` 与那一刻**逐字节相等**，
 * 而不是「撤销后这块的正文对上了」——后者会让「位置错了」「属性少了一格」静默通过。
 *
 * 覆盖：新块／软删／清除（三态存在）、移动、正文、属性、annos、子树、多块、
 * 缺父／缺块、未动块的对象身份、`directEdit`（查询块正文）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { writeBlockContent, type Block } from '../src/core/model/model.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { applyOps, forestFingerprint, newBlockOps } from '../src/core/kb/diff.ts'
import { lookupOf, scopedOps, type TouchedState } from '../src/core/kb/scoped.ts'
import type { Op } from '../src/core/kb/types.ts'

/** 显式 id 的块：断言里要按 id 点名，不用 uuid */
function mk(id: string, text = '', extra: Partial<Block> = {}): Block {
  return { id, content: textRuns(text), children: [], created: 100, modified: 100, ...extra }
}

/** 三块森林：`a`（有子块 `a1`）、`b`、`c` */
function fixture() {
  const a1 = mk('a1', '甲的子块')
  const a = mk('a', '甲', { children: [a1] })
  const b = mk('b', '乙')
  const c = mk('c', '丙')
  return [a, b, c]
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

/** 一次「撤销/重做」的完整落地：generator ＋ applyOps（与 `store.restore` 同一条路，跳过索引修补） */
function walk(forest: Block[], states: readonly TouchedState[], opts: { directEdit?: boolean } = {}): Op[] {
  const ops = scopedOps(lookupOf(forest), states, opts)
  applyOps(forest, ops)
  return ops
}

/**
 * **生产路径**：读面用索引的「全部块」表（O(1)），op 应用后按同一批 op 修补索引。
 * 与 `store.restore` 是同一对动作（先改森林、再 `store.apply`）。
 */
function walkIndexed(store: BlockStore, states: readonly TouchedState[], opts: { directEdit?: boolean } = {}): Op[] {
  const lookup = store.undoLookup()
  const ops = scopedOps(lookup, states, opts)
  applyOps(store.blocks, ops, lookup)
  store.apply(ops)
  return ops
}

function setup(forest: Block[] = fixture()) {
  const store = new BlockStore(forest)
  const kb = new MemoryKb(store, { now: () => 5000 })
  return { store, kb }
}

/* ------------------------------------------------------------ 三个存在态 */

test('撤销一次插入：整棵子树 purge（子先于父），重做 genesis 用同一批 id', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)

  const sub = mk('n', '新块', { children: [mk('n1', '新的子块')] })
  const r = kb.tx((tx) => tx.insert(sub, 'a', 0))
  const afterFp = forestFingerprint(store.blocks)

  // 撤销 ⇒ 清除。purge 子先于父（父先消失时子块的落点已在树外，日志补不回来）
  const undoOps = walk(store.blocks, r.undo.before)
  assert.deepEqual(
    undoOps.filter((o) => o.e === 'block' && o.op === 'exist').map((o) => (o as { id: string }).id),
    ['n1', 'n'],
    '清除按树深从深到浅：子块先于父块',
  )
  assert.equal(forestFingerprint(store.blocks), beforeFp, '撤销后整片森林逐字节回到插入前')

  // 重做 ⇒ genesis 用同一批 id，父先于子
  const redoOps = walk(store.blocks, r.undo.after)
  const genesis = redoOps.filter((o) => o.e === 'block' && o.op === 'upsert' && o.value.parent !== undefined)
  assert.deepEqual(genesis.map((o) => (o as { id: string }).id), ['n', 'n1'], 'genesis 父先于子')
  assert.equal(forestFingerprint(store.blocks), afterFp, '重做后整片森林逐字节回到插入后')
})

test('撤销一次软删：块一直在树上（三个存在态里的 deleted → present）', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) => tx.remove('b'))
  assert.ok(store.blocks.find((b) => b.id === 'b')?.props?._deletedAt, '软删是原位打标记，块还在树上')
  const afterFp = forestFingerprint(store.blocks)

  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp, '撤销删除 ⇒ 摘掉标记，块回原位')

  walk(store.blocks, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp, '重做删除 ⇒ 同一个标记值（不是重新取时钟）')
})

test('生产读面：索引的「全部块」表能找到被软删的块，撤销删除不必摊平整库', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) => tx.remove('b'))
  const afterFp = forestFingerprint(store.blocks)

  assert.equal(store.find('b'), undefined, '可见索引里找不到它')
  assert.equal(store.undoLookup().get('b')?.id, 'b', '撤销读面找得到（否则会误判成 genesis）')
  assert.equal(store.undoLookup().parentOf('b'), null, 'b 是顶层块')

  walkIndexed(store, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp)
  assert.equal(store.find('b')?.id, 'b', '撤销后索引重新看得见它')

  walkIndexed(store, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

test('生产读面：撤销插入时 purge 会从「全部块」表里消失，重做再长回来（同一个 id）', () => {
  const { store, kb } = setup()
  const sub = mk('n', '新块', { children: [mk('n1', '新的子块')] })
  const r = kb.tx((tx) => tx.insert(sub, 'a', 0))
  const afterFp = forestFingerprint(store.blocks)

  walkIndexed(store, r.undo.before)
  assert.equal(store.undoLookup().get('n'), undefined, 'purge 过的块不能留在全部块表里')
  assert.equal(store.undoLookup().get('n1'), undefined)
  walkIndexed(store, r.undo.after)
  assert.equal(store.undoLookup().get('n')?.id, 'n', '重做用同一个 id 复活')
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

/* ------------------------------------------------------------ 位置 · 正文 · 属性 · annos */

test('撤销一次移动：落点回到原来的父与前兄弟', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) => tx.move('a1', null, 2))
  assert.equal(store.blocks.map((b) => b.id).join(','), 'a,b,a1,c')
  const afterFp = forestFingerprint(store.blocks)

  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp, '撤销移动 ⇒ 回到 `a` 的第一个子块位')

  walk(store.blocks, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

test('撤销一次正文改写：content ＋ modified 一起回来（不是只回正文）', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) =>
    tx.patch('a', (b) => {
      writeBlockContent(b, textRuns('改过的正文'))
      b.modified = 250
    }),
  )
  const afterFp = forestFingerprint(store.blocks)

  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp)
  walk(store.blocks, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

test('撤销属性与 annos：逐字节回来，删掉的格重新出现', () => {
  const anchored = mk('a', '甲', { annos: [{ id: 'an0', range: { start: 0, end: 1 } }] })
  const forest = [anchored, mk('b', '乙')]
  const { store, kb } = setup(forest)
  const beforeFp = forestFingerprint(store.blocks)

  const r = kb.tx((tx) => {
    tx.setProp('a', 'p1', '值')
    tx.setProp('a', 'p2', ['x', 'y'])
    tx.clearProp('a', 'p0')
    tx.setAnnos('a', [
      { id: 'an1', range: { start: 0, end: 2 }, quote: { exact: '甲', prefix: '', suffix: '' } },
    ])
    tx.patch('a', (b) => {
      b.modified = 300
    })
  })
  const afterFp = forestFingerprint(store.blocks)

  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp, '属性袋与 annos 的旧值（含被删的 p0）都要回来')
  walk(store.blocks, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

/* ------------------------------------------------------------ 多块 · 身份 */

test('一次事务动多块：撤销把每一块都退回去（不是只退最后一块）', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) => {
    tx.patch('a', (b) => writeBlockContent(b, textRuns('甲改')))
    tx.patch('c', (b) => writeBlockContent(b, textRuns('丙改')))
    tx.setProp('b', 'x', 1)
  })
  const afterFp = forestFingerprint(store.blocks)

  assert.equal(r.undo.before.length, 3)
  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), beforeFp)
  walk(store.blocks, r.undo.after)
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

test('未动的块对象身份不变（applyOps 原地写格，索引手里的活引用不会过期）', () => {
  const { store, kb } = setup()
  const b = store.blocks[1]!
  const c = store.blocks[2]!
  const r = kb.tx((tx) =>
    tx.patch('a', (x) => {
      writeBlockContent(x, textRuns('只动 a'))
      x.modified = 400
    }),
  )
  walk(store.blocks, r.undo.before)
  assert.equal(store.blocks[1], b, '未动块还是同一个对象')
  assert.equal(store.blocks[2], c, '未动块还是同一个对象')
})

/* ------------------------------------------------------------ 边界 */

test('缺父：要复活的块挂在一个不存在的父下 ⇒ 明确抛错，不静默落顶层', () => {
  const forest: Block[] = []
  const states: TouchedState[] = [
    {
      id: 'x',
      present: true,
      cells: { content: textRuns('孤儿'), created: 1, modified: 1 },
      placement: { parent: 'ghost', prev: null },
    },
  ]
  assert.throws(() => scopedOps(lookupOf(forest), states), /missing parent "ghost"/)
})

test('恢复顺序是承重的：条目里子块排在父块前面，输出仍父先于子（否则 applyOps 会拒绝）', () => {
  const child: TouchedState = {
    id: 'c',
    present: true,
    cells: { content: textRuns('子'), created: 1, modified: 1 },
    placement: { parent: 'p', prev: null },
  }
  const parent: TouchedState = {
    id: 'p',
    present: true,
    cells: { content: textRuns('父'), created: 1, modified: 1 },
    placement: { parent: null, prev: null },
  }
  const forest: Block[] = []
  const ops = scopedOps(lookupOf(forest), [child, parent]) // 故意把子放在前面
  assert.deepEqual(
    ops.filter((o) => o.e === 'block' && o.op === 'upsert').map((o) => (o as { id: string }).id),
    ['p', 'c'],
    '按目标树深排序：父先于子',
  )
  applyOps(forest, ops)
  assert.equal(forest[0]?.children[0]?.id, 'c')

  // 反证：把顺序反过来（子先于父）会被 applyOps 当场拒绝 —— 排序不是装饰
  const wrong = [
    ...newBlockOps({ id: 'c', content: textRuns('子'), children: [], created: 1, modified: 1 }, { parent: 'p', prev: null }),
    ...newBlockOps({ id: 'p', content: textRuns('父'), children: [], created: 1, modified: 1 }, { parent: null, prev: null }),
  ]
  assert.throws(() => applyOps([], wrong), /missing parent "p"/)
})

test('缺块：清除一个已经不在了的块 ⇒ 零 op（撤销重放两次仍然收敛）', () => {
  const { store } = setup()
  const ops = scopedOps(lookupOf(store.blocks), [{ id: 'ghost', present: false }])
  assert.deepEqual(ops, [])
})

test('清除父块但子树里有一块没被记录 ⇒ 抛错（不静默丢块）', () => {
  const { store } = setup()
  const states: TouchedState[] = [{ id: 'a', present: false }] // a1 没在条目里
  assert.throws(() => scopedOps(lookupOf(store.blocks), states), /untracked block "a1"/)
})

test('directEdit：查询块正文的直接编辑能用同一个选项撤销；不带选项则被内容闸拦下', () => {
  const q = mk('q', '旧名字', { props: { _query: { where: { kind: 'any' } } } })
  const { store, kb } = setup([q, mk('b', '乙')])
  const beforeFp = forestFingerprint(store.blocks)

  const r = kb.tx(
    (tx) =>
      tx.patch('q', (b) => {
        writeBlockContent(b, textRuns('新名字'))
        b.modified = 600
      }),
    { directEdit: true },
  )
  assert.equal(r.undo.directEdit, true, '条目要记住这次是「一行里的直接编辑」')
  const afterFp = forestFingerprint(store.blocks)

  assert.throws(
    () => scopedOps(lookupOf(store.blocks), r.undo.before),
    /content is protected/,
    '不带 directEdit 的反向写入必须仍被拦（说明这个 flag 不是可选的装饰）',
  )
  walk(store.blocks, r.undo.before, { directEdit: r.undo.directEdit })
  assert.equal(forestFingerprint(store.blocks), beforeFp)
  walk(store.blocks, r.undo.after, { directEdit: r.undo.directEdit })
  assert.equal(forestFingerprint(store.blocks), afterFp)
})

test('applyOps：带 lookup 与不带 lookup 对同一批 op 得到逐字节相同的结果', () => {
  const { store, kb } = setup()
  const r = kb.tx((tx) => {
    tx.patch('a', (b) => {
      writeBlockContent(b, textRuns('改过'))
      b.modified = 700
    })
    tx.move('a1', null, 2)
    tx.setProp('b', 'x', 1)
    tx.remove('c')
  })
  const ops = scopedOps(store.undoLookup(), r.undo.before)
  assert.ok(ops.length > 0)

  const fast = clone(store.blocks)
  const slow = clone(store.blocks)
  applyOps(fast, ops, lookupOf(fast))
  applyOps(slow, ops)
  assert.equal(forestFingerprint(fast), forestFingerprint(slow), '两条路径只是成本不同，结果必须相同')
})

/* ------------------------------------------------------------ 与库体量无关 */

test('撤销条目的字节数与库体量无关：100 块与 10,000 块上做同一次按键，序列化字节相同', () => {
  const bytesAt = (n: number): number => {
    const forest: Block[] = []
    for (let i = 0; i < n; i++) forest.push(mk(`b${i}`, `第 ${i} 块`))
    const { kb } = setup(forest)
    const r = kb.tx((tx) =>
      tx.patch('b0', (b) => {
        writeBlockContent(b, textRuns('改一下'))
        b.modified = 900
      }),
    )
    return JSON.stringify(r.undo).length
  }

  const small = bytesAt(100)
  const big = bytesAt(10_000)
  assert.equal(big, small, '条目里只有 touched 的格与落点；库再大也不该多一个字节')
})

test('撤销一步到位：同一份条目连撤两次仍然收敛（幂等）', () => {
  const { store, kb } = setup()
  const beforeFp = forestFingerprint(store.blocks)
  const r = kb.tx((tx) => tx.insert(mk('n', '新块'), 'a', 0))
  walk(store.blocks, r.undo.before)
  const fp1 = forestFingerprint(store.blocks)
  walk(store.blocks, r.undo.before)
  assert.equal(forestFingerprint(store.blocks), fp1, '第二次撤销是零 op，不改变森林')
  assert.equal(fp1, beforeFp)
})
