/**
 * **巨大 Doc 的分段装载**（`docWindow`）：一窗一窗读，拼起来必须与整棵读**同解**。
 *
 * 判据（每条都能单独证伪）：
 *   ① 窗口序列拼起来 == `readDocRows` 的子树（按先序、无重无漏）；
 *   ② 区间只覆盖这一棵：后面的兄弟根不进窗；
 *   ③ 祖先链只在第一窗给；没有派生路径 ⇒ 返回 `null`（调用方回退整棵）；
 *   ④ 用窗口装进工作集 == 整棵装进去（同一棵树的形状与兄弟序）；
 *   ⑤ 内存读面（web）与桌面同一契约：拼起来 == `doc`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, type Db, type RowWrite } from '../electron/library/sqlite.ts'
import { readDocRows, readDocWindow } from '../electron/library/reads.ts'
import { DOC_WINDOW, finishDocWindows, pendingOf, readFirstWindows, withAncestors } from '../src/app/boot/doc-windows.ts'
import { loadWorksetBoot } from '../src/app/boot/workset-boot.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset } from '../src/core/storage/workset.ts'
import { createMemoryLibraryClient } from '../src/core/storage/memory-client.ts'
import { mkBlock, type Block } from '../src/core/model/model.ts'
import { fingerprint } from '../src/core/infra/index-port.ts'
import type { LibraryDocRows } from '../src/core/storage/library-reads.ts'

const dirs: string[] = []
function db(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-docwin-'))
  dirs.push(d)
  const r = openLibraryDb(join(d, 'qua.db'))
  assert.equal(r.status, 'created')
  return r.db!
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const text = (v: string): string => JSON.stringify([{ t: 'text', v }])
const seg = (n: number): string => String(n).padStart(6, '0')
const idOfRow = (row: unknown): string => String((row as { id: unknown }).id)

/**
 * 库形状（先序）：root — a — g1..g5，后面跟一个兄弟根 next。
 * 窗口限制 2 条时，边界会落在一棵子树的中间（这才是要验的形状）。
 */
function seeded(): Db {
  const d = db()
  const rows: RowWrite[] = []
  const mk = (id: string, parent: string | null, left: string | null, path: string, root: string): void => {
    rows.push({ table: 'Block', op: 'upsert', key: { id }, values: { content: text(id), created: 1, modified: 1, parent, left } })
    rows.push({ table: 'BlockIndex', op: 'upsert', key: { block: id }, values: { root, path, hidden: null } })
  }
  mk('root', null, null, seg(1), 'root')
  mk('a', 'root', null, `${seg(1)}/${seg(1)}`, 'root')
  let prev: string | null = null
  for (let i = 1; i <= 5; i++) {
    mk(`g${i}`, 'a', prev, `${seg(1)}/${seg(1)}/${seg(i)}`, 'root')
    prev = `g${i}`
  }
  mk('next', null, 'root', seg(2), 'next')
  applyRowWrites(d, rows)
  return d
}

/** 一页页读完（返回拼接的 id 与窗数） */
function readAll(d: Db, rootId: string, limit: number): { ids: string[]; windows: number; ancestorsOnlyFirst: boolean } {
  const ids: string[] = []
  let after: string | null = null
  let windows = 0
  let ancestorsOnlyFirst = true
  for (let i = 0; i < 100; i++) {
    const w = readDocWindow(d, rootId, after, limit)
    assert.ok(w, '这条 root 应当有派生路径')
    windows++
    if (windows > 1 && w.ancestors.length > 0) ancestorsOnlyFirst = false
    ids.push(...w.rows.blocks.map(idOfRow))
    after = w.next
    if (after === null) break
  }
  return { ids, windows, ancestorsOnlyFirst }
}

test('窗口拼接 == 整棵读（按先序、无重无漏）', () => {
  const d = seeded()
  const whole = readDocRows(d, ['root']).rows.blocks.map(idOfRow)
  for (const limit of [1, 2, 3, 4, 7, 100]) {
    const got = readAll(d, 'root', limit)
    assert.deepEqual(got.ids, whole, `limit=${limit}`)
    assert.ok(got.ancestorsOnlyFirst, '祖先链只在第一窗给')
  }
})

test('区间只覆盖这一棵：后面的兄弟根不进窗', () => {
  const d = seeded()
  const got = readAll(d, 'root', 2).ids
  assert.ok(!got.includes('next'), '兄弟根不在子树的 path 区间里')
  assert.equal(got[0], 'root', '第一窗从 root 自己开始')
})

test('没有派生路径 ⇒ null（调用方回退整棵，不猜）', () => {
  const d = seeded()
  assert.equal(readDocWindow(d, 'no-such-block', null, 2), null)
})

test('下一窗不重复上一窗给过的块', () => {
  const d = seeded()
  const w = readDocWindow(d, 'root', null, 3)
  assert.ok(w && w.next !== null)
  const second = readDocWindow(d, 'root', w.next, 3)
  assert.ok(second)
  const first = new Set(w.rows.blocks.map(idOfRow))
  for (const row of second.rows.blocks) assert.ok(!first.has(idOfRow(row)))
})

test('**逐窗**装进工作集 == 整棵装进去（形状／兄弟序／索引逐条一致）', () => {
  const d = seeded()
  const whole = readDocRows(d, ['root'])

  const wholeStore = new BlockStore([])
  new Workset(wholeStore).loadDoc(withAncestors(whole), whole.rootIds)

  /**
   * 每一个窗口都**真的装一次**（不是攒起来最后装一次）：装载是增量路径，
   * 「装到第 N 窗时的索引」与「整棵装完重建的索引」必须逐条相同——`fingerprint`
   * 比的是先序 id 序列，不是 rank 数值，所以中点/整步长的差别不会假红。
   */
  for (const limit of [1, 2, 7]) {
    const winStore = new BlockStore([])
    const win = new Workset(winStore)
    let after: string | null = null
    for (let i = 0; i < 1000; i++) {
      const w = readDocWindow(d, 'root', after, limit)
      assert.ok(w)
      win.loadDoc(withAncestors(w), w.rootIds)
      after = w.next
      if (after === null) break
    }
    assert.deepEqual(shapeOf(winStore), shapeOf(wholeStore), `两棵树的形状相同（limit=${limit}）`)
    assert.equal(
      fingerprint(winStore.index),
      fingerprint(wholeStore.index),
      `装载出来的索引与整棵装载逐条一致（limit=${limit}）`,
    )
  }
})

test('启动/导航共用的窗口装载：首窗 ＋ pendingOf ＋ finishDocWindows == 整棵（跨窗的大 Doc）', async () => {
  /** 比一窗多一点：2100 块 ⇒ 首窗 2000 ＋ 余下 100，正好走到 `pending` 那一支 */
  const bigTree = (): Block => {
    const root = { ...mkBlock('大页'), id: 'big-root', children: [] as Block[] }
    for (let i = 0; i < 2100; i++) root.children.push({ ...mkBlock(`第${i}块`), id: `big-${i}`, children: [] })
    return root
  }
  // 读面建在一棵树上；两个工作集各自从行重建（对象互不共享）
  const source = new BlockStore([bigTree()])
  const client = createMemoryLibraryClient({ ws: () => ({ blocks: source.blocks, activeId: '', savedAt: 1 }), store: source })

  const whole = await client.doc(['big-root'])
  assert.equal(whole.status, 'ok')
  if (whole.status !== 'ok') return
  const wholeStore = new BlockStore([])
  new Workset(wholeStore).loadDoc(withAncestors(whole.value), whole.value.rootIds)

  const store = new BlockStore([])
  const workset = new Workset(store)
  const windows = await readFirstWindows(client, ['big-root'])
  assert.ok(windows, '内存读面提供窗口读')
  assert.equal(windows.length, 1)
  assert.equal(windows[0]!.rows.blocks.length, DOC_WINDOW, '首窗装满')
  for (const w of windows) workset.loadDoc(withAncestors(w), w.rootIds)
  const pending = pendingOf(windows)
  assert.equal(pending.length, 1, '还有余下的窗口')

  assert.equal(await finishDocWindows(client, workset, pending), true, '续装长过')
  assert.deepEqual(shapeOf(store), shapeOf(wholeStore))
})

test('启动：active 是跨窗大页 ⇒ 首窗就返回、余下交 pending，续装后装齐', async () => {
  const bigTree = (): Block => {
    const root = { ...mkBlock('大页'), id: 'big-page', children: [] as Block[] }
    for (let i = 0; i < 2100; i++) root.children.push({ ...mkBlock(`第${i}块`), id: `big-${i}`, children: [] })
    return root
  }
  const source = new BlockStore([bigTree()])
  const client = createMemoryLibraryClient({
    ws: () => ({ blocks: source.blocks, activeId: 'big-page', savedAt: 1 }),
    store: source,
  })
  const store = new BlockStore([])
  const workset = new Workset(store)
  const boot = await loadWorksetBoot({ client, workset })
  assert.equal(boot.status, 'ok')
  if (boot.status !== 'ok') return
  assert.equal(boot.mode, 'page')
  assert.deepEqual(boot.roots.map((b) => b.id), ['big-page'])
  assert.equal(boot.counts.docBlocks, DOC_WINDOW, '启动只装了首窗')
  assert.equal(boot.pending.length, 1, '余下的交给首帧后续装')
  assert.equal(workset.isLoaded('big-2099'), false)

  assert.equal(await finishDocWindows(client, workset, boot.pending), true)
  assert.equal(workset.isLoaded('big-2099'), true, '续装把余下的装齐')
  assert.equal(workset.size, 2101)
})

/** 一片森林的形状：先序 id ＋ 每个块的子块 id 列表（顺序也算） */
function shapeOf(store: BlockStore): string[] {
  const out: string[] = []
  const walk = (b: Block, depth: number): void => {
    out.push(`${'  '.repeat(depth)}${b.id}[${b.children.map((c) => c.id).join(',')}]`)
    for (const c of b.children) walk(c, depth + 1)
  }
  for (const r of store.blocks) walk(r, 0)
  return out
}

test('内存读面（web）同一契约：窗口拼接 == doc', async () => {
  const root = mkBlock('根')
  const a = mkBlock('A')
  const g1 = mkBlock('G1')
  const g2 = mkBlock('G2')
  a.children = [g1, g2]
  root.children = [a]
  const store = new BlockStore([root])
  const client = createMemoryLibraryClient({ ws: () => ({ blocks: store.blocks, activeId: '', savedAt: 1 }), store })
  const whole = await client.doc([root.id])
  assert.equal(whole.status, 'ok')
  if (whole.status !== 'ok') return
  const ids: string[] = []
  let after: string | null = null
  for (let i = 0; i < 50; i++) {
    const r = await client.docWindow!(root.id, after, 1)
    assert.equal(r.status, 'ok')
    if (r.status !== 'ok') return
    ids.push(...r.value.rows.blocks.map(idOfRow))
    after = r.value.next
    if (after === null) break
  }
  assert.deepEqual(ids, (whole.value as LibraryDocRows).rows.blocks.map(idOfRow))
})
