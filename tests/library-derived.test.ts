/**
 * 派生层：`BlockIndex`／`BlockRelation` 的重建与增量等式。
 *
 * 判据四条，每条都能单独证伪：
 *   ① **迁移保内容**：v11 → v12 只加表/索引，内容与库级 meta 原样；派生状态先 `pending`。
 *   ② **语义与内存 `Index` 同源**：root／先序／可见性／关系边逐项等（关系按 `(from,to,kind)` 去重）。
 *   ③ **路径格式可查**：父路径是子路径前缀（子树＝前缀查询）、路径唯一、字典序＝先序。
 *   ④ **重建 == 增量**：改内容／插块／移动／软删／恢复／改定义 kind 之后，
 *      用 `derivedRowsOfBlocks(affected)` 替换受影响行，与全量重建逐字节一致；
 *      再在真 SQLite 上走一遍 prune＋upsert，与同一库上的全量重建一致。
 *
 * 为什么用「保守 affected 集」：这里的增量函数与重建共用同一套段值（兄弟下标 × 步长），
 * 所以兄弟增删会让**后面所有兄弟的段值**变化 —— 测试的 affected 集按这条口径给全。
 * 写路径换成中点插入后，段值可以不同而先序不变：那时**逐字节断言**要换成
 * `derivedFingerprint`（按先序/深度/root/hidden，不比原始段值），其余语义断言不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DB_SCHEMA_VERSION, DB_TABLES, META_KEYS } from '../src/core/identity/library.ts'
import { mkBlock, type Block } from '../src/core/model/model.ts'
import { walkForest } from '../src/core/model/walk.ts'
import type { Run } from '../src/core/model/runs.ts'
import { WORKSPACE_VERSION, type Workspace } from '../src/core/infra/workspace.ts'
import { rebuild as rebuildIndex } from '../src/core/infra/index-port.ts'
import { readContentRows, applyRowWrites, openLibraryDb, readMeta, replaceContentRows, writeMeta } from '../electron/library/sqlite.ts'
import {
  derivedFingerprint,
  derivedPruneWrites,
  derivedRowWrites,
  derivedRowsOf,
  derivedRowsOfBlocks,
  rebuildDerivedWrites,
  type DerivedRows,
} from '../src/core/storage/derived-rows.ts'
import {
  rowsToWorkspace,
  workspaceToRowWrites,
  type RowWrite,
} from '../src/core/storage/db-rows.ts'

const dirs: string[] = []
function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'qua-derived-'))
  dirs.push(d)
  return join(d, 'qua.db')
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function ws(forest: Block[]): Workspace {
  return { version: WORKSPACE_VERSION, blocks: forest, activeId: '', savedAt: 1 }
}

function mk(id: string, init: string | readonly Run[] = '', props: Record<string, unknown> = {}): Block {
  const b = mkBlock(init, Object.keys(props).length > 0 ? { props } : {})
  b.id = id
  return b
}

const ref = (id: string, to: string, flavor?: '#'): Run => ({ id, t: 'ref', to, ...(flavor === undefined ? {} : { flavor }) })

/**
 * 一棵把所有关系来源都放进去的树：
 *
 *   P（页）─ A ─ A1
 *   │      └ B（属性引用／嵌入／归属／标签）
 *   S（顶层兄弟，引用 P）
 *   W（anno 宿主）  X（软删根）─ X1
 *   DEF（kind:'ref' 定义）  TAG  J（日记）  NOTE（备注）  V（引用 anno）  U（两次引用同一目标）
 */
function fixture(): {
  forest: Block[]
  p: Block
  a: Block
  a1: Block
  b: Block
  s: Block
  w: Block
  x: Block
  x1: Block
  def: Block
  tag: Block
  j: Block
  note: Block
  v: Block
  u: Block
} {
  const p = mk('p', '页', { _lists: ['page'], _aliases: ['P页'] })
  const a = mk(
    'a',
    [{ t: 'text', v: '看 ' }, ref('ref-a-1', 'w'), ref('ref-a-2', 'tag', '#')],
    { _tags: ['tag'] },
  )
  a.annos = [{ id: 'annoA', range: { start: 0, end: 1 } }]
  const a1 = mk('a1', [ref('ref-a1', 'p')])
  const b = mk('b', 'B', { def: 'w', _embed: { block: 'p' }, _belongsTo: ['j'], _tags: ['tag'] })
  const s = mk('s', [ref('ref-s', 'p')])
  const w = mk('w', 'W')
  w.annos = [{ id: 'annoW', range: { start: 0, end: 1 } }]
  const x = mk('x', [ref('ref-x', 'p')], { _deletedAt: 7 })
  const x1 = mk('x1', [ref('ref-x1', 'w')])
  const def = mk('def', '', { _kind: 'ref', _aliases: ['Author'] })
  const tag = mk('tag', '', { _lists: ['tag'], _aliases: ['Tag'] })
  const j = mk('j', '', { _date: '2026-11-18' })
  const note = mk('note', '', { _annotates: [{ block: 'a', anno: 'annoA' }] })
  const v = mk('v', [ref('ref-v', 'annoA')])
  const u = mk('u', [ref('ref-u-1', 'w'), ref('ref-u-2', 'w')])

  p.children = [a, b]
  a.children = [a1]
  x.children = [x1]
  return { forest: [p, s, w, x, def, tag, j, note, v, u], p, a, a1, b, s, w, x, x1, def, tag, j, note, v, u }
}

const byPath = (x: { path: string }, y: { path: string }): number => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0)

/** 真库里的派生行 → 纯函数的形状（node:sqlite 的行是 null-prototype） */
function readDerived(db: NonNullable<ReturnType<typeof openLibraryDb>['db']>): DerivedRows {
  const index = (db.prepare(`select block, root, path, hidden from ${DB_TABLES.blockIndex}`).all() as Record<string, unknown>[]).map((r) => ({
    block: String(r.block),
    root: String(r.root),
    path: String(r.path),
    hidden: r.hidden === 1 ? (1 as const) : null,
  }))
  const relations = (
    db.prepare(`select from_id, to_id, kind, from_root from ${DB_TABLES.blockRelation}`).all() as Record<string, unknown>[]
  ).map((r) => ({
    from_id: String(r.from_id),
    to_id: String(r.to_id),
    kind: String(r.kind) as DerivedRows['relations'][number]['kind'],
    from_root: String(r.from_root),
  }))
  return { index, relations }
}

/** 精确行比较（含原始段值）：只在「同一套段值口径」的两条路径之间用 */
function exactRows(rows: DerivedRows): unknown {
  return {
    index: [...rows.index].map((r) => [r.block, r.root, r.path, r.hidden]).sort(),
    relations: [...rows.relations].map((r) => [r.from_id, r.to_id, r.kind, r.from_root]).sort(),
  }
}

const edgeKey = (e: { from: string; to: string; kind: string }): string => `${e.from}\u0000${e.to}\u0000${e.kind}`

/* ------------------------------------------------------------ ① 迁移 */

test('v11 → v12：只加派生表/索引，内容与库级 meta 原样；状态先 pending，重建后 ready', () => {
  const file = tmpDb()
  const first = openLibraryDb(file, { target: 11 })
  assert.equal(first.status, 'created', '先造一个 v11 的库')
  applyRowWrites(first.db!, [
    { table: 'Block', op: 'upsert', key: { id: 'keep-me' }, values: { content: '[]', created: 1, modified: 1, parent: null, left: null } },
  ])
  writeMeta(first.db!, META_KEYS.name, '我的库')
  first.db!.close()

  const r = openLibraryDb(file)
  assert.equal(r.status, 'migrated', `v11 应当被迁移到当前版本，实际 ${r.status}`)
  assert.equal(r.version, DB_SCHEMA_VERSION)
  const db = r.db!
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name)
  assert.ok(tables.includes(DB_TABLES.blockIndex), `迁移后应当建出 BlockIndex：${tables.join(',')}`)
  assert.ok(tables.includes(DB_TABLES.blockRelation), `迁移后应当建出 BlockRelation：${tables.join(',')}`)

  const blocks = db.prepare(`select id from ${DB_TABLES.block}`).all() as { id: string }[]
  assert.deepEqual(blocks.map((b) => b.id), ['keep-me'], '迁移不许动内容')
  assert.equal(readMeta(db, META_KEYS.name), '我的库', '库级 meta 不许动')
  assert.equal(readMeta(db, META_KEYS.derivedState), 'pending', '派生表还没建：状态必须是 pending')
  assert.equal((db.prepare(`select count(*) as n from ${DB_TABLES.blockIndex}`).all() as { n: number }[])[0]!.n, 0)

  // 重建：一行块 ⇒ 自己是根、路径是单段、可见
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  assert.equal(readMeta(db, META_KEYS.derivedState), 'ready')
  const row = db.prepare(`select block, root, path, hidden from ${DB_TABLES.blockIndex}`).all() as Record<string, unknown>[]
  assert.equal(row.length, 1)
  assert.equal(row[0]!.block, 'keep-me')
  assert.equal(row[0]!.root, 'keep-me')
  assert.match(String(row[0]!.path), /^\/\d{13}\/$/, '单段路径：/定宽段/')
  assert.equal(row[0]!.hidden, null)
  db.close()
})

test('新建库：派生表存在且状态 pending（空表 ≠ 已建好）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  assert.equal(r.status, 'created')
  assert.equal(r.version, DB_SCHEMA_VERSION)
  const db = r.db!
  assert.equal(readMeta(db, META_KEYS.derivedState), 'pending')
  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name)
  assert.ok(tables.includes(DB_TABLES.blockIndex))
  assert.ok(tables.includes(DB_TABLES.blockRelation))
  db.close()
})

/* ------------------------------------------------------------ ② 语义 */

test('重建：root／hidden／先序与内存 Index 同源；关系边按 (from,to,kind) 与 Index 一致', () => {
  const f = fixture()
  const rows = derivedRowsOf(f.forest)

  // root：顶层是自���；子块取顶层祖先
  const rowOf = new Map(rows.index.map((r) => [r.block, r]))
  assert.equal(rowOf.get('p')!.root, 'p')
  assert.equal(rowOf.get('a1')!.root, 'p')
  assert.equal(rowOf.get('b')!.root, 'p')
  assert.equal(rowOf.get('x')!.root, 'x')
  assert.equal(rowOf.get('x1')!.root, 'x')

  // hidden：自己或祖先被软删；块本身仍留在 index 里（回收站/恢复要用）
  assert.equal(rowOf.get('x')!.hidden, 1)
  assert.equal(rowOf.get('x1')!.hidden, 1)
  assert.equal(rowOf.get('a')!.hidden, null)

  // 父路径是子路径前缀；路径唯一
  walkForest(
    f.forest,
    (b, ctx) => {
      if (ctx.parent) assert.ok(rowOf.get(b.id)!.path.startsWith(rowOf.get(ctx.parent.id)!.path), `${b.id} 的路径必须落在父路径下`)
    },
    { includeDeleted: true },
  )
  assert.equal(new Set(rows.index.map((r) => r.path)).size, rows.index.length, '路径必须唯一')

  // 字典序 = 先序
  assert.deepEqual(
    [...rows.index].sort(byPath).map((r) => r.block),
    ['p', 'a', 'a1', 'b', 's', 'w', 'x', 'x1', 'def', 'tag', 'j', 'note', 'v', 'u'],
  )

  // 与内存 Index 对账：可见集、root、关系边
  const idx = rebuildIndex(f.forest)
  assert.equal(idx.all.size, rows.index.length, 'index 覆盖树上全部块（含软删）')
  for (const row of rows.index) {
    assert.equal(idx.blocks.has(row.block), row.hidden === null, `${row.block} 的可见性与 Index 一致`)
    if (row.hidden === null) assert.equal(idx.rootOf.get(row.block), row.root, `${row.block} 的根与 Index 一致`)
  }
  const idxEdges = new Set([...idx.relations.values()].flat().map(edgeKey))
  const ourEdges = new Set(rows.relations.map((r) => edgeKey({ from: r.from_id, to: r.to_id, kind: r.kind })))
  assert.deepEqual([...ourEdges].sort(), [...idxEdges].sort(), '关系边与 Index 同源（按 from/to/kind 去重）')
  for (const e of rows.relations) assert.equal(e.from_root, idx.rootOf.get(e.from_id), 'from_root 就是源的顶层根')

  // 软删块不贡献边（与 Index 的可见性口径一致）
  assert.ok(!rows.relations.some((r) => r.from_id === 'x' || r.from_id === 'x1'))
})

test('重建：关系种类逐个对（引用／标签提及／标签／属性／嵌入／归属／备注；anno 归一化到宿主）', () => {
  const rows = derivedRowsOf(fixture().forest)
  const got = rows.relations.map((r) => `${r.from_id}→${r.to_id}:${r.kind}`).sort()
  assert.deepEqual(got, [
    'a1→p:inline',
    'a→tag:tag',
    'a→tag:tagMention',
    'a→w:inline',
    'b→j:belongsTo',
    'b→p:embed',
    'b→tag:tag',
    'b→w:property',
    'note→a:annotates',
    's→p:inline',
    'u→w:inline',
    'v→a:inline',
  ])
})

/* ------------------------------------------------------------ ③ 真库重建 */

test('指纹不比原始段值：段值整体平移（先序不变）⇒ 指纹相等、精确行不同', () => {
  const rows = derivedRowsOf(fixture().forest)
  const shift = (path: string): string =>
    path
      .split('/')
      .map((seg) => (seg === '' ? '' : String(Number(seg) + 1024).padStart(13, '0')))
      .join('/')
  const shifted: DerivedRows = { index: rows.index.map((r) => ({ ...r, path: shift(r.path) })), relations: rows.relations }
  assert.notDeepEqual(exactRows(shifted), exactRows(rows), '原始行确实不同')
  assert.equal(derivedFingerprint(shifted), derivedFingerprint(rows), '契约是同一棵有序树，不是同一串段值')
})

test('真库重建：行往返后可查；子树＝path 前缀查询', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  assert.equal(r.status, 'created')
  const db = r.db!
  const f = fixture()
  replaceContentRows(db, workspaceToRowWrites(ws(f.forest)))
  assert.equal(readMeta(db, META_KEYS.derivedState), 'pending', '整份替换必须作废派生层')
  assert.equal((db.prepare(`select count(*) as n from ${DB_TABLES.blockIndex}`).all() as { n: number }[])[0]!.n, 0)

  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  assert.equal(readMeta(db, META_KEYS.derivedState), 'ready')

  const expected = derivedRowsOf(f.forest)
  assert.deepEqual(exactRows(readDerived(db)), exactRows(expected), '真库重建的行与纯函数逐行一致')

  const pPath = expected.index.find((x) => x.block === 'p')!.path
  const subtree = (
    db.prepare(`select block from ${DB_TABLES.blockIndex} where path like ? order by path`).all(`${pPath}%`) as { block: string }[]
  ).map((x) => x.block)
  assert.deepEqual(subtree, ['p', 'a', 'a1', 'b'], '前缀查询只回 P 的子树')
  db.close()
})

/* ------------------------------------------------------------ ④ 重建 == 增量（纯函数） */

test('重建 == 增量：改内容／插块／软删／移动／恢复／改定义 kind 后，替换受影响行即等于全量重建', () => {
  const f = fixture()
  /** 当前增量维护后的派生行（从全量重建起步） */
  let rows = derivedRowsOf(f.forest)

  const check = (): void => {
    const full = derivedRowsOf(f.forest)
    assert.deepEqual(exactRows(rows), exactRows(full), '增量维护后的行必须与全量重建逐字节一致')
    assert.equal(derivedFingerprint(rows), derivedFingerprint(full), '语义指纹也必须一致')
  }

  const maintain = (indexScope: Iterable<string>, relationScope: Iterable<string>): void => {
    const indexSet = new Set(indexScope)
    const relSet = new Set(relationScope)
    const patch = derivedRowsOfBlocks(f.forest, new Set([...indexSet, ...relSet]))
    rows = {
      index: [...rows.index.filter((r) => !indexSet.has(r.block)), ...patch.index.filter((r) => indexSet.has(r.block))],
      relations: [...rows.relations.filter((r) => !relSet.has(r.from_id)), ...patch.relations.filter((r) => relSet.has(r.from_id))],
    }
  }
  check()

  // ① 改内容：A 多一条正文引用（index 不变，关系变）
  f.a.content = [...f.a.content, ref('ref-a-3', 's')]
  maintain([], ['a'])
  check()

  // ② 插块：A 末尾加一个引用 P 的子块（只新增自己）
  const a2 = mk('a2', [ref('ref-a2', 'p')])
  f.a.children = [...f.a.children, a2]
  maintain(['a2'], ['a2'])
  check()

  // ③ 软删：B 进回收站（hidden=1，它的边退场）
  f.b.props = { ...(f.b.props ?? {}), _deletedAt: 9 }
  maintain(['b'], ['b'])
  check()

  // ④ 移动：S 从顶层移到 A 的第一个孩子。
  //    重建的段值按兄弟下标铺 ⇒ A 的原有孩子全体重编号；S 离开顶层 ⇒ 后面的顶层兄弟全体重编号。
  f.forest = f.forest.filter((b) => b !== f.s)
  f.a.children = [f.s, ...f.a.children]
  maintain(['s', 'a1', 'a2', 'w', 'x', 'x1', 'def', 'tag', 'j', 'note', 'v', 'u'], ['s'])
  check()

  // ⑤ 恢复：X 出回收站（自己与子树 hidden 清掉，边回来）
  f.x.props = {}
  maintain(['x', 'x1'], ['x', 'x1'])
  check()

  // ⑥ 改定义 kind：DEF 从 ref 变 text ⇒ 属性引用边退场（边在 B 上，不在定义块上）
  f.def.props = { ...(f.def.props ?? {}), _kind: 'text' }
  maintain([], ['b'])
  check()
})

/* ------------------------------------------------------------ ⑤ 重建 == 增量（真库） */

test('真库增量：内容行改了之后先 prune 再 upsert 受影响派生行；与同库全量重建逐行一致', () => {
  const before = fixture()
  const after = fixture()

  // after 的三处改动：A 的内容多一条引用、DEF 的 kind 改变、NOTE 软删
  after.a.content = [...after.a.content, ref('ref-a-3', 's')]
  after.def.props = { ...(after.def.props ?? {}), _kind: 'text' }
  after.note.props = { ...(after.note.props ?? {}), _deletedAt: 42 }

  const file = tmpDb()
  const r = openLibraryDb(file)
  assert.equal(r.status, 'created')
  const db = r.db!
  replaceContentRows(db, workspaceToRowWrites(ws(before.forest)))
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  assert.equal(readMeta(db, META_KEYS.derivedState), 'ready')

  // 内容行按增量落盘（模拟内容写事务：这里只改内容，不碰派生表）
  const contentWrites: RowWrite[] = [
    { table: 'Block', op: 'update', key: { id: 'a' }, values: { content: JSON.stringify(after.a.content), modified: 2 } },
    { table: 'Block', op: 'update', key: { id: 'def' }, values: { kind: 'text' } },
    { table: 'Block', op: 'update', key: { id: 'note' }, values: { deleted: 42 } },
  ]
  applyRowWrites(db, contentWrites)

  // 派生维护：受影响 index 行 {note}；受影响关系源 {a, b, note}
  //（B 的属性引用边随 DEF 的 kind 退场；A 新引用 S；NOTE 被删 ⇒ 边退场）
  applyRowWrites(db, [
    ...derivedPruneWrites(['note'], ['a', 'b', 'note']),
    ...derivedRowWrites(derivedRowsOfBlocks(after.forest, new Set(['note', 'a', 'b']))),
  ])
  const incremental = readDerived(db)

  // 同一个库上全量重建（内容已是 after）⇒ 与增量结果比
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  const rebuilt = readDerived(db)
  assert.deepEqual(exactRows(incremental), exactRows(rebuilt), '增量维护必须等于全量重建')
  assert.equal(derivedFingerprint(incremental), derivedFingerprint(rebuilt))
  db.close()
})

/* ------------------------------------------------------------ ⑥ 状态与内容同事务的边界 */

test('整份替换：派生表清空且状态回 pending（旧内容的边不许活在新内容上）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const f = fixture()
  replaceContentRows(db, workspaceToRowWrites(ws(f.forest)))
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  assert.equal(readMeta(db, META_KEYS.derivedState), 'ready')
  assert.ok((db.prepare(`select count(*) as n from ${DB_TABLES.blockRelation}`).all() as { n: number }[])[0]!.n > 0)

  const empty = workspaceToRowWrites(ws([]))
  replaceContentRows(db, empty)
  assert.equal(readMeta(db, META_KEYS.derivedState), 'pending')
  assert.equal((db.prepare(`select count(*) as n from ${DB_TABLES.blockIndex}`).all() as { n: number }[])[0]!.n, 0)
  assert.equal((db.prepare(`select count(*) as n from ${DB_TABLES.blockRelation}`).all() as { n: number }[])[0]!.n, 0)
  db.close()
})

test('派生列的一致性：BlockIndex 行数 = 树上的块数（重建后不丢块）', () => {
  const file = tmpDb()
  const r = openLibraryDb(file)
  const db = r.db!
  const f = fixture()
  replaceContentRows(db, workspaceToRowWrites(ws(f.forest)))
  applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
  const n = (db.prepare(`select count(*) as n from ${DB_TABLES.blockIndex}`).all() as { n: number }[])[0]!.n
  assert.equal(n, countBlocks(rowsToWorkspace(readContentRows(db)).blocks))
  db.close()
})

/** 森林里的总块数（含软删） */
function countBlocks(blocks: readonly Block[]): number {
  let n = 0
  walkForest(blocks, () => void n++, { includeDeleted: true })
  return n
}
