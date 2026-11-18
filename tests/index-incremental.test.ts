/**
 * **`BlockIndex` 的增量维护：重建 == 增量**。
 *
 * 判据（与 `library-derived.test.ts` 的关系行同一条，加了位置行的四格）：
 *
 *   ① 一次结构写（插块／移动／软删／恢复／清除）之后，库里的 `BlockIndex` 与
 *      「用当前森林整份重建」**同解**——按先序 / 深度 / root / hidden 比指纹，
 *      不比原始段值（中点插入本来就不该与重建逐字节相同）。
 *   ② 路径的三条性质仍成立：覆盖树上每一块、路径唯一、父路径是子路径的前缀。
 *   ③ 段耗尽（同层连续往同一个缝里插 1024 次）之后整层重铺，先序仍与内存 `Index.order` 一致。
 *   ④ 前缀改写 / hidden 重算**不依赖模型**：库里有一棵渲染器没装载的子树，计划照样整片改。
 *
 * 落盘走的是真实那一条路：`rowWritesFor`（内容行）＋ `indexWritesOf`（派生行/计划）
 * 同一个 `applyRowWrites`（一个事务）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DB_TABLES, META_KEYS } from '../src/core/identity/library.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { writeBlockContent, type Block } from '../src/core/model/model.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { applyOps } from '../src/core/kb/diff.ts'
import { scopedOps } from '../src/core/kb/scoped.ts'
import type { Op } from '../src/core/kb/types.ts'
import {
  applyDerivedPlans,
  applyRowWrites,
  openLibraryDb,
  readContentRows,
  replaceContentRows,
} from '../electron/library/sqlite.ts'
import { readIndexChildren, readIndexFollowing, readIndexRows } from '../electron/library/reads.ts'
import { rowWritesFor, workspaceToRowWrites, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import {
  derivedFingerprint,
  derivedRowsOf,
  rebuildDerivedWrites,
  type BlockIndexRow,
} from '../src/core/storage/derived-rows.ts'
import { indexWritesOf, type IndexReads } from '../src/core/storage/index-rows.ts'
import { createWorkspaceStore } from '../src/core/storage/index.ts'
import type { CommitBatch, StoragePort } from '../src/core/storage/port.ts'

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function mk(id: string, text = '', extra: Partial<Block> = {}): Block {
  return { id, content: textRuns(text), children: [], created: 100, modified: 100, ...extra }
}

/**
 * 一棵覆盖各种位置的树：
 *
 *   P（页）─ A ─ A1
 *   │      └ B ─ B1
 *   S（顶层兄弟）   X（软删根）─ X1
 */
function fixture(): Block[] {
  const a1 = mk('a1', 'A 的子块')
  const b1 = mk('b1', 'B 的子块')
  const a = mk('a', 'A', { children: [a1] })
  const b = mk('b', 'B', { children: [b1] })
  const p = mk('p', 'P', { children: [a, b] })
  const s = mk('s', 'S')
  const x1 = mk('x1', 'X 的子块')
  const x = mk('x', 'X', { children: [x1], props: { _deletedAt: 7 } })
  return [p, s, x]
}

interface Lib {
  db: NonNullable<ReturnType<typeof openLibraryDb>['db']>
  store: BlockStore
  kb: MemoryKb
  reads: IndexReads
}

/** 一个新库：内容行铺底 → 派生表全量重建（ready）→ 内存森林同源 */
function library(forest: Block[]): Lib {
  const dir = mkdtempSync(join(tmpdir(), 'qua-index-'))
  dirs.push(dir)
  const db = openLibraryDb(join(dir, 'qua.db')).db!
  replaceContentRows(db, workspaceToRowWrites({ blocks: forest, activeId: '', savedAt: 1 }))
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  assert.equal(readMetaState(db), 'ready')
  const store = new BlockStore(forest)
  const kb = new MemoryKb(store, { now: () => 1000 })
  const reads: IndexReads = {
    async byBlock(ids) {
      return new Map(readIndexRows(db, ids).map((r) => [r.block, r] as const))
    },
    async following(parent, prev) {
      return readIndexFollowing(db, parent, prev)
    },
    async children(parent) {
      return readIndexChildren(db, parent)
    },
  }
  return { db, store, kb, reads }
}

function readMetaState(db: Lib['db']): string {
  const row = db.prepare(`select value from meta where key = ?`).all(META_KEYS.derivedState) as { value: string }[]
  return row[0]?.value ?? ''
}

function allIndex(db: Lib['db']): BlockIndexRow[] {
  return (
    db.prepare(`select block, root, path, hidden from ${DB_TABLES.blockIndex}`).all() as Record<string, unknown>[]
  ).map((r) => ({
    block: String(r.block),
    root: String(r.root),
    path: String(r.path),
    hidden: r.hidden === 1 ? (1 as const) : null,
  }))
}

/** 「同解」的判据：先序 ＋ 深度 ＋ root ＋ hidden 的指纹（原始段值不进契约） */
const fingerprint = (rows: readonly BlockIndexRow[]): string => derivedFingerprint({ index: [...rows], relations: [] })

/**
 * 把一批 op 落盘：内容行 ＋ 位置行，同一个事务（与生产的写入路径逐字同构）。
 *
 * `indexWritesOf` 必须在**写之前**跑：它读的是库里上一批的状态（邻居的存量段）。
 */
async function commit(lib: Lib, ops: readonly Op[]): Promise<void> {
  if (ops.length === 0) return
  const ws: StoredWorkspace = { blocks: lib.store.blocks, activeId: '', savedAt: 1 }
  const content = rowWritesFor(ws, ops)
  const derived = await indexWritesOf(lib.store.index, ops, lib.reads)
  applyRowWrites(lib.db, [...content, ...derived.writes], { plans: derived.plans })
}

/** 增量维护后的库 vs 用当前森林重建：逐行同解 ＋ 路径三条性质 */
function assertMatchesModel(lib: Lib, label: string): void {
  const rows = allIndex(lib.db)
  const expected = derivedRowsOf(lib.store.blocks).index
  assert.equal(fingerprint(rows), fingerprint(expected), `${label}：先序/深度/root/hidden 必须与重建同解`)

  const byBlock = new Map(rows.map((r) => [r.block, r] as const))
  assert.equal(rows.length, expected.length, `${label}：行数必须覆盖树上每一块`)
  for (const row of expected) {
    const got = byBlock.get(row.block)
    assert.ok(got, `${label}：缺 ${row.block} 的位置行`)
    assert.equal(got.root, row.root, `${label}：${row.block} 的 root`)
    assert.equal(got.hidden, row.hidden, `${label}：${row.block} 的 hidden`)
  }
  assert.equal(new Set(rows.map((r) => r.path)).size, rows.length, `${label}：路径必须唯一`)
  for (const row of rows) {
    const parent = parentOfModel(lib.store, row.block)
    if (parent === null) {
      assert.equal(depthOfPath(row.path), 1, `${label}：${row.block} 是顶层，路径只该有一段`)
      continue
    }
    assert.ok(row.path.startsWith(byBlock.get(parent)!.path), `${label}：${row.block} 的路径必须在父路径之下`)
  }
}

/** 同一库里再跑一次整份重建：增量维护的结果必须与它逐行一致 */
function assertMatchesFullRebuild(lib: Lib, label: string): void {
  const before = fingerprint(allIndex(lib.db))
  applyRowWrites(lib.db, rebuildDerivedWrites(readContentRows(lib.db)))
  assert.equal(fingerprint(allIndex(lib.db)), before, `${label}：同一库上的全量重建必须等于增量结果`)
}

function parentOfModel(store: BlockStore, id: string): string | null {
  return store.index.parentOfAll.get(id) ?? null
}

function depthOfPath(path: string): number {
  let slashes = 0
  for (const ch of path) if (ch === '/') slashes++
  return slashes - 1
}

/* ------------------------------------------------------------ ① 纯内容写 */

test('纯打字（正文/属性/anno）不产生位置行写：一批里一条 op 都不碰 BlockIndex', async () => {
  const lib = library(fixture())
  const r = lib.kb.tx((tx) => {
    tx.patch('a1', (b) => writeBlockContent(b, textRuns('改了正文')))
    tx.setProp('a', 'note', 'x')
  })
  const derived = await indexWritesOf(lib.store.index, r.ops, lib.reads)
  assert.equal(derived.writes.length, 0, '正文/属性与 root/path/hidden 无关')
  assert.equal(derived.plans.length, 0)
  await commit(lib, r.ops)
  assertMatchesModel(lib, '纯打字')
})

/* ------------------------------------------------------------ ② 插块 */

test('插块：层内落点夹在存量兄弟之间；顶层落点夹在这一根与它的库后继之间', async () => {
  const lib = library(fixture())

  const inner = mk('n1', '新子块')
  const r1 = lib.kb.tx((tx) => tx.insert(inner, 'a', 1))
  await commit(lib, r1.ops)
  assertMatchesModel(lib, '层内插块')

  // 顶层：内存里只装了三棵树，库里也是——新根落在「内存最后一个根」的右边
  const root = mk('n2', '新页')
  const r2 = lib.kb.tx((tx) => tx.insert(root, null, lib.store.blocks.length))
  await commit(lib, r2.ops)
  assertMatchesModel(lib, '顶层插块')
  assertMatchesFullRebuild(lib, '插块')
})

test('插块：前插（prev=null）与空父块下的首个子块都能落对', async () => {
  const lib = library(fixture())
  const first = mk('n3', '插到最前')
  const r = lib.kb.tx((tx) => tx.insert(first, null, 0))
  await commit(lib, r.ops)
  assert.deepEqual(
    allIndex(lib.db)
      .sort((x, y) => (x.path < y.path ? -1 : 1))
      .filter((r) => r.root === 'n3')
      .map((r) => r.block),
    ['n3'],
  )

  const only = mk('n4', '空父块的独子')
  const r2 = lib.kb.tx((tx) => {
    const host = mk('n5', '新父')
    tx.insert(host, 's', 0)
    tx.insert(only, host.id, 0)
  })
  await commit(lib, r2.ops)
  assertMatchesModel(lib, '同一批里父先子后')
})

/* ------------------------------------------------------------ ③ 软删 / 恢复 */

test('软删与恢复：hidden 按子树逐行重算（子树内部各自被删过的块保持 1）', async () => {
  const lib = library(fixture())

  const r1 = lib.kb.tx((tx) => tx.remove('b'))
  await commit(lib, r1.ops)
  assertMatchesModel(lib, '软删 B')
  assert.equal(allIndex(lib.db).find((r) => r.block === 'b1')!.hidden, 1, '子孙跟着 hidden=1')

  const r2 = lib.kb.tx((tx) => tx.restore('b'))
  await commit(lib, r2.ops)
  assertMatchesModel(lib, '恢复 B')

  // 子树内部自己先被删过一块：恢复父块时它必须保持 hidden=1（不是整片翻转）
  const lib2 = library(fixture())
  const r3 = lib2.kb.tx((tx) => tx.remove('b1'))
  await commit(lib2, r3.ops)
  const r4 = lib2.kb.tx((tx) => tx.remove('b'))
  await commit(lib2, r4.ops)
  const r5 = lib2.kb.tx((tx) => tx.restore('b'))
  await commit(lib2, r5.ops)
  assertMatchesModel(lib2, '恢复一棵内部还有被删块的子树')
  assert.equal(allIndex(lib2.db).find((r) => r.block === 'b1')!.hidden, 1, '子块自己删过 ⇒ 恢复父块后仍 hidden')
  assert.equal(allIndex(lib2.db).find((r) => r.block === 'b')!.hidden, null)
})

/* ------------------------------------------------------------ ④ 移动 */

test('移动：层内换位、跨层、移到顶层，root 与整条路径前缀一起改', async () => {
  const lib = library(fixture())

  const r1 = lib.kb.tx((tx) => tx.move('a1', 'b', 0))
  await commit(lib, r1.ops)
  assertMatchesModel(lib, '层内跨父移动')
  assert.equal(allIndex(lib.db).find((r) => r.block === 'a1')!.root, 'p')

  const r2 = lib.kb.tx((tx) => tx.move('p', null, 0))
  await commit(lib, r2.ops)
  assertMatchesModel(lib, '本来就在顶层 ⇒ 不动')
  assert.equal(allIndex(lib.db).find((r) => r.block === 'b1')!.root, 'p')

  const r3 = lib.kb.tx((tx) => tx.move('b', null, lib.store.blocks.length))
  await commit(lib, r3.ops)
  assertMatchesModel(lib, '移到顶层：root 变成自己，子块跟着换前缀')
  assert.equal(allIndex(lib.db).find((r) => r.block === 'b')!.root, 'b')
  assert.equal(allIndex(lib.db).find((r) => r.block === 'b1')!.root, 'b')
  assertMatchesFullRebuild(lib, '移动')
})

/* ------------------------------------------------------------ ⑤ 改定义 kind */

test('改定义 kind：与位置行无关（不写一行、不发一条计划）', async () => {
  const lib = library([...fixture(), mk('def', '', { props: { _kind: 'ref', _aliases: ['Author'] } })])
  const r = lib.kb.tx((tx) => tx.setProp('def', '_kind', 'text'))
  const derived = await indexWritesOf(lib.store.index, r.ops, lib.reads)
  assert.equal(derived.writes.length, 0)
  assert.equal(derived.plans.length, 0)
  await commit(lib, r.ops)
  assertMatchesModel(lib, '改定义 kind')
})

/* ------------------------------------------------------------ ⑥ 清除 */

test('清除（撤销一次插入）：整片删行，包括撤销前那一批刚写进去的子孙行', async () => {
  const lib = library(fixture())
  const sub = mk('n6', '新块', { children: [mk('n7', '新的子块')] })
  const inserted = lib.kb.tx((tx) => tx.insert(sub, 'a', 0))
  await commit(lib, inserted.ops)
  assertMatchesModel(lib, '插入待撤销的子树')

  // 撤销一次插入 ＝ 清除（与生产同一条路：scopedOps + 索引修补）
  const lookup = lib.store.undoLookup()
  const purgeOps = scopedOps(lookup, inserted.undo.before)
  applyOps(lib.store.blocks, purgeOps, lookup)
  lib.store.apply(purgeOps)
  await commit(lib, purgeOps)
  assertMatchesModel(lib, '清除整棵子树')
  assert.equal(allIndex(lib.db).filter((r) => r.block === 'n6' || r.block === 'n7').length, 0)
})

/* ------------------------------------------------------------ ⑦ 段耗尽 */

test('同层连插 1024 次：中点耗尽后整层重铺，先序仍与内存 Index 一致', async () => {
  const lib = library(fixture())
  const host = lib.store.find('p')!
  for (let i = 0; i < 1024; i++) {
    const block = mk(`i${i}`, `插 ${i}`)
    // 每一次都挤在 P 的前两个子块之间：段值每次减半，迟早耗尽
    const r = lib.kb.tx((tx) => tx.insert(block, host.id, 1))
    await commit(lib, r.ops)
  }
  assertMatchesModel(lib, '1024 次中点插入')
  assertMatchesFullRebuild(lib, '1024 次中点插入')

  // 内存里的兄弟序就是界面顺序；库里的先序必须逐块对上
  const order = (id: string): string[] => {
    const out: string[] = []
    const walk = (b: Block): void => {
      out.push(b.id)
      for (const c of b.children) walk(c)
    }
    walk(lib.store.find(id)!)
    return out
  }
  const dbOrder = allIndex(lib.db)
    .filter((r) => r.root === 'p')
    .sort((x, y) => (x.path < y.path ? -1 : 1))
    .map((r) => r.block)
  assert.deepEqual(dbOrder, order('p'), '库里先序 == 内存先序')
})

/* ------------------------------------------------------------ ⑧ 换位（新段撞旧段） */

test('相邻兄弟换位：新段不许落在另一笔计划的旧前缀上', async () => {
  const lib = library(fixture())
  const before = lib.store.find('p')!.children.map((b) => b.id)
  const r1 = lib.kb.tx((tx) => {
    const [a, b] = lib.store.find('p')!.children
    tx.move(b!.id, 'p', 0)
    void a
  })
  await commit(lib, r1.ops)
  assertMatchesModel(lib, '交换相邻兄弟')
  assert.deepEqual(lib.store.find('p')!.children.map((b) => b.id), [before[1], before[0]])
  assertMatchesFullRebuild(lib, '交换相邻兄弟')
})

/* ------------------------------------------------------------ ⑨ 计划不依赖模型 */
test('前缀改写与 hidden 重算不依赖模型：未装载的子孙行照样整片改', async () => {
  const lib = library(fixture())
  const p = allIndex(lib.db).find((r) => r.block === 'p')!
  const deep = allIndex(lib.db).find((r) => r.block === 'b1')!

  // 只给计划、不给模型：把 P 的整棵子树搬到顶层新段（渲染器不需要认识任何子孙）
  const moved = `/${'0'.repeat(6)}${'2'.repeat(7)}/`
  applyDerivedPlans(lib.db, [
    { p: 'reindexSubtree', oldPrefix: p.path, newPrefix: moved, parent: null, block: 'p' },
  ])
  const after = allIndex(lib.db)
  assert.equal(after.find((r) => r.block === 'p')!.path, moved, '根换了前缀')
  assert.equal(after.find((r) => r.block === 'p')!.root, 'p', '顶层 ⇒ root 是自己')
  assert.ok(after.find((r) => r.block === 'b1')!.path.startsWith(moved), '两层的孙块也被搬了')
  assert.equal(after.find((r) => r.block === 'b1')!.path.length, deep.path.length, '段的宽度不变（只换前缀）')

  // hidden 重算：B 子树里 b1 自己删过 ⇒ 恢复 b 之后 b1 仍是 1
  const r = lib.kb.tx((tx) => tx.remove('b1'))
  await commit(lib, r.ops)
  applyDerivedPlans(lib.db, [{ p: 'recomputeHidden', block: 'b', hiddenAbove: 1 }])
  assert.equal(allIndex(lib.db).find((r) => r.block === 'b1')!.hidden, 1)
})

/* ------------------------------------------------------------ ⑩ 同一批多笔移动 */

test('同一批里多笔移动：整层重铺，新段不与任何旧段重合（换位也不互相踩）', async () => {
  const lib = library([
    mk('p', 'P', { children: [mk('a', 'A'), mk('b', 'B'), mk('c', 'C'), mk('d', 'D')] }),
  ])
  const r = lib.kb.tx((tx) => {
    // 目标顺序 A C B D：C 向前插一格、B 向后挪一格 —— 两笔落点会分到同一个缝里，
    // 而按等距分配算出来的新段恰好等于对方/自己的旧段（1024/2048/3072/4096 的那口井）
    tx.move('c', 'p', 1)
    tx.move('b', 'p', 2)
  })
  await commit(lib, r.ops)
  assert.deepEqual(
    lib.store.find('p')!.children.map((b) => b.id),
    ['a', 'c', 'b', 'd'],
  )
  assertMatchesModel(lib, '同一批多笔移动')
  assertMatchesFullRebuild(lib, '同一批多笔移动')
})

/* ------------------------------------------------------------ ⑪ 钩子接线 */

test('store 的钩子：位置行与计划随内容行进同一批（计划的副作用不经过 port）', async () => {
  const batches: CommitBatch[] = []
  const port: StoragePort = {
    kind: 'fake-rows',
    consumes: 'rows',
    async commit(batch) {
      batches.push(batch)
      return { ok: true, savedAt: batch.savedAt }
    },
    async clear() {},
    async settle() {},
  }
  const store = createWorkspaceStore(port, undefined, {
    indexWrites: async () => ({
      writes: [{ table: 'BlockIndex', op: 'upsert', key: { block: 'x' }, values: { root: 'x', path: '/1/', hidden: null } }],
      plans: [{ p: 'dropSubtree', prefix: '/2/' }],
    }),
  })
  const ops: Op[] = [{ e: 'block', id: 'x', op: 'upsert', value: { content: textRuns('x'), parent: null, prev: null }, at: 1 }]
  const r = await store.commit({ blocks: [mk('x', 'x')], activeId: '', savedAt: 1 }, ops)
  assert.equal(r.ok, true)
  const batch = batches[0]!
  assert.ok(
    (batch.writes ?? []).some((w) => w.table === 'BlockIndex' && w.key.block === 'x'),
    '位置行必须与内容行同一批',
  )
  assert.deepEqual(batch.plans, [{ p: 'dropSubtree', prefix: '/2/' }], '计划随批发出')
  assert.equal((batch.oplog ?? []).length, 1, '变更流仍是这一批的 op')
})

/* ------------------------------------------------------------ ⑫ 部分装载（工作集） */

test('部分装载：内存只有两棵根，新根仍落在「库里的前一个根」右边（后继从库里查）', async () => {
  const r1 = mk('r1', 'R1', { children: [mk('r1a', 'r1 的子块')] })
  const r2 = mk('r2', 'R2')
  const r3 = mk('r3', 'R3', { children: [mk('r3a', 'r3 的子块')] })
  const r4 = mk('r4', 'R4')
  const lib = library([r1, r2, r3, r4])

  /**
   * 工作集里只装了两棵根（真实首帧就是这样：今日窗口／active 之外都没装载）。
   * 新页追加在**内存**末尾 ⇒ 库里的位置是 r2 与 r3 之间（内容行的 relink 这么写）。
   */
  const view = new BlockStore([r1, r2])
  const kb = new MemoryKb(view, { now: () => 1000 })
  const fresh = mk('n8', '新页')
  const r = kb.tx((tx) => tx.insert(fresh, null, view.blocks.length))
  const ws: StoredWorkspace = { blocks: view.blocks, activeId: '', savedAt: 1 }
  const content = rowWritesFor(ws, r.ops)
  const derived = await indexWritesOf(view.index, r.ops, lib.reads)
  applyRowWrites(lib.db, [...content, ...derived.writes], { plans: derived.plans })

  const byBlock = new Map(allIndex(lib.db).map((x) => [x.block, x] as const))
  assert.ok(
    byBlock.get('r2')!.path < byBlock.get('n8')!.path && byBlock.get('n8')!.path < byBlock.get('r3')!.path,
    `新根必须夹在库里的 r2 与 r3 之间：${byBlock.get('r2')!.path} / ${byBlock.get('n8')!.path} / ${byBlock.get('r3')!.path}`,
  )
  // 库里整份重建（含渲染器从没装载过的 r3/r4）必须等于增量结果
  const incremental = fingerprint(allIndex(lib.db))
  applyRowWrites(lib.db, rebuildDerivedWrites(readContentRows(lib.db)))
  assert.equal(fingerprint(allIndex(lib.db)), incremental, '部分装载下的增量必须等于整库重建')
})

test('同一批里「多笔落点 ＋ 一块搬走」：搬走的那块只按自己的落点计划写（不按旧层再铺一次）', async () => {
  const lib = library([
    mk('p', 'P', { children: [mk('a', 'A'), mk('b', 'B'), mk('c', 'C'), mk('d', 'D')] }),
    mk('s', 'S'),
  ])
  const r = lib.kb.tx((tx) => {
    tx.move('c', 'p', 1)
    tx.move('b', 'p', 2)
    tx.move('d', 's', 0)
  })
  await commit(lib, r.ops)
  assert.deepEqual(lib.store.find('p')!.children.map((b) => b.id), ['a', 'c', 'b'])
  assert.deepEqual(lib.store.find('s')!.children.map((b) => b.id), ['d'])
  assertMatchesModel(lib, '多笔落点 ＋ 一块搬走')
  assertMatchesFullRebuild(lib, '多笔落点 ＋ 一块搬走')
})
