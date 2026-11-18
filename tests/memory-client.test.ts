/**
 * 内存读面（web 单库的 `LibraryClient`）——与桌面 SQL 读面的**等式**。
 *
 * ## 这条等式为什么必须钉住
 *
 * 两套实现、一条契约：桌面走 `library-reads.ts` 的具名 SQL，web 从模型现场编码。
 * 消费面只认契约 ⇒ 任何一次回复的形状分歧都会变成「web 上少装一块／目录少一行」
 * 的静默错。最硬的钉法不是对各自实现写快照，而是**同一份模型过两条路，答案逐行相同**：
 *
 *     模型 → 写成行 → SQLite → 具名读  ┐
 *                                      ├─ 深比较
 *     模型 → 内存读面现场编码          ┘
 *
 * 覆盖：doc（子树＋祖先链＋附属行）、blocks（不带子树）、tree（祖先链＋一层子级）、
 * identity、catalog 四表、dependents 三路分类、roots、candidates 超集。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workspaceToRowWrites, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import { rowsToWorkspace } from '../src/core/storage/db-rows.ts'
import { BlockStore } from '../src/core/model/store.ts'
import type { Block } from '../src/core/model/model.ts'
import { createMemoryLibraryClient } from '../src/core/storage/memory-client.ts'
import { applyRowWrites, openLibraryDb } from '../electron/library/sqlite.ts'
import { readBlockRows, readBlockTreeRows, readCatalogRows, readDependents, readDocRows, readIdentityRows, readRootIds } from '../electron/library/reads.ts'

const dirs: string[] = []
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const id = (c: string) => c.repeat(32)

function block(idStr: string, text: string, children: Block[] = [], props?: Record<string, unknown>): Block {
  return {
    id: idStr,
    content: text.length > 0 ? [{ t: 'text', text }] : [],
    children,
    created: 1_700_000_000_000,
    modified: 1_700_000_000_001,
    ...(props ? { props } : {}),
  }
}

/** 一份尽量把形状用上的库：嵌套页、标签、字段定义、软删子树、日记天、属性值 */
function richWorkspace(): StoredWorkspace {
  const deletedChild = block(id('g'), '被删的子块')
  deletedChild.props = { ...deletedChild.props, _deletedAt: 1_700_000_000_100 }
  const blocks: Block[] = [
    block(id('p'), '页的描述', [block(id('x'), '页里的块')], {
      _aliases: ['页名', '页别名'],
      _lists: ['page'],
    }),
    block(id('t'), '', [], {
      _aliases: ['标签'],
      _lists: ['tag'],
    }),
    block(id('k'), '', [], { _aliases: ['定义'], _kind: 'text' }),
    block(id('d'), '日记内容', [], { _date: '2026-11-12' }),
    block(id('a'), '引用 [[页名]] 与 #标签', [], { _tags: [id('t')], custom: 'v1' }),
    block(id('r'), '被删的根', [deletedChild], { _deletedAt: 1_700_000_000_090 }),
  ]
  return { blocks, activeId: id('p'), savedAt: 1_700_000_000_002 }
}

function sqlSide(ws: StoredWorkspace) {
  const d = mkdtempSync(join(tmpdir(), 'qua-mem-'))
  dirs.push(d)
  const opened = openLibraryDb(join(d, 'qua.db'))
  assert.ok(opened.status === 'created' || opened.status === 'ok', `开库失败：${opened.status}`)
  applyRowWrites(opened.db, workspaceToRowWrites(ws))
  return opened.db
}

function memSide(ws: StoredWorkspace) {
  const store = new BlockStore(ws.blocks as Block[])
  return createMemoryLibraryClient({ ws: () => ws, store })
}

/** SQL 侧行的原型不是 `Object.prototype`：过一遍 JSON 归一成可深比较的普通对象 */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const byId = (rows: Record<string, unknown>[]) =>
  [...rows]
    .map((r) => plain(r))
    .sort((a, b) =>
      String(a.id ?? a.block ?? a.name).localeCompare(String(b.id ?? b.block ?? b.name)),
    )

const modelOf = (rows: Awaited<ReturnType<typeof readDocRows>>['rows']) => rowsToWorkspace(rows)

test('doc：内存读面与桌面 SQL 同解（子树＋祖先链＋附属行）', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readDocRows(db, [id('x')])
  db.close()
  const mem = await memSide(ws).doc([id('x')])
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  // 装出来的模型逐块相同（行序不进契约，树形才进）
  const sqlModel = modelOf(sql.rows)
  const memModel = modelOf(mem.value.rows)
  assert.deepEqual(memModel.blocks, sqlModel.blocks)
  // 祖先链同一批（面包屑要的正是它）
  assert.deepEqual(
    mem.value.ancestors.map((r) => r.id),
    sql.ancestors.map((r) => r.id),
  )
  assert.deepEqual(mem.value.rootIds, sql.rootIds)
})

test('doc：多 root 共享祖先去重；缺席的 root 原样回报名', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readDocRows(db, [id('x'), id('does-not-exist')])
  db.close()
  const mem = await memSide(ws).doc([id('x'), id('does-not-exist')])
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  assert.deepEqual(
    mem.value.ancestors.map((r) => r.id),
    sql.ancestors.map((r) => r.id),
  )
  assert.deepEqual(mem.value.rootIds, sql.rootIds)
  assert.deepEqual(memModelBlocks(mem.value), modelOf(sql.rows).blocks)
})

function memModelBlocks(doc: { rows: Awaited<ReturnType<typeof readDocRows>>['rows'] }): Block[] {
  return rowsToWorkspace(doc.rows).blocks
}

test('blocks：只回点名的块自己（不带子树）', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readBlockRows(db, [id('p')])
  db.close()
  const mem = await memSide(ws).blocks([id('p')])
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  assert.deepEqual(mem.value.blocks.map((r) => r.id), sql.blocks.map((r) => r.id))
  assert.deepEqual(byId(mem.value.props), byId(sql.props))
  assert.deepEqual(byId(mem.value.aliases), byId(sql.aliases))
  assert.deepEqual(byId(mem.value.lists), byId(sql.lists))
})

test('tree：候选块＋全部祖先链（可选一层子级）', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readBlockTreeRows(db, [id('x')], true)
  db.close()
  const mem = await memSide(ws).tree([id('x')], true)
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  assert.deepEqual(byId(mem.value.blocks), byId(sql.blocks))
  assert.deepEqual(byId(mem.value.props), byId(sql.props))
  assert.deepEqual(byId(mem.value.aliases), byId(sql.aliases))
  assert.deepEqual(byId(mem.value.lists), byId(sql.lists))
})

test('identity：全局身份块（页/标签/定义/回收站，含被软删的）', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readIdentityRows(db)
  db.close()
  const mem = await memSide(ws).identity()
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  assert.deepEqual(
    mem.value.blocks.map((r) => r.id).sort(),
    sql.blocks.map((r) => r.id).sort(),
  )
  assert.deepEqual(byId(mem.value.props), byId(sql.props))
  assert.deepEqual(byId(mem.value.aliases), byId(sql.aliases))
  assert.deepEqual(byId(mem.value.lists), byId(sql.lists))
})

test('catalog：四表与 meta 同解', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readCatalogRows(db)
  db.close()
  const mem = await memSide(ws).catalog()
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  const c = mem.value
  assert.deepEqual(c.journals, plain(sql.journals))
  assert.deepEqual(c.tags, plain(sql.tags))
  assert.deepEqual(c.propDefs, plain(sql.propDefs))
  assert.deepEqual(
    [...c.aliases].sort((a, b) => a.name.localeCompare(b.name)),
    plain([...sql.aliases].sort((a, b) => a.name.localeCompare(b.name))),
  )
  assert.deepEqual(c.trash, plain(sql.trash))
  assert.equal(c.meta.activeId, sql.meta.activeId)
  assert.equal(c.meta.savedAt, sql.meta.savedAt)
})

test('dependents：正文引用／标签成员／属性值三路分类', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sqlPage = readDependents(db, id('p'))
  const sqlTag = readDependents(db, id('t'))
  db.close()
  const mem = memSide(ws)
  const memPage = await mem.dependents(id('p'))
  const memTag = await mem.dependents(id('t'))
  assert.equal(memPage.status, 'ok')
  assert.equal(memTag.status, 'ok')
  if (memPage.status !== 'ok' || memTag.status !== 'ok') return
  assert.deepEqual(memPage.value, plain(sqlPage))
  assert.deepEqual(memTag.value, plain(sqlTag))
})

test('roots：顶层根清单（含软删根，森林序＝rowid 序）', async () => {
  const ws = richWorkspace()
  const db = sqlSide(ws)
  const sql = readRootIds(db)
  db.close()
  const mem = await memSide(ws).roots()
  assert.equal(mem.status, 'ok')
  if (mem.status !== 'ok') return
  assert.deepEqual(mem.value, sql)
})

test('candidates：宽计划给全部可见块（超集）；ids 直达；none 空', async () => {
  const ws = richWorkspace()
  const mem = memSide(ws)
  const all = await mem.candidates({ k: 'visible' })
  assert.equal(all.status, 'ok')
  if (all.status !== 'ok') return
  assert.ok(all.value.includes(id('x')), '可见块在候选里')
  assert.ok(!all.value.includes(id('g')), '被软删的子块不是候选')
  const ids = await mem.candidates({ k: 'ids', ids: [id('x'), id('missing')] })
  assert.ok(ids.status === 'ok' && ids.value.length === 1 && ids.value[0] === id('x'))
  const none = await mem.candidates({ k: 'none' })
  assert.ok(none.status === 'ok' && none.value.length === 0)
})

test('ftsMap：恒空（web 查询走森林扫描）', async () => {
  const mem = memSide(richWorkspace())
  const r = await mem.ftsMap([id('x')])
  assert.ok(r.status === 'ok' && r.value.length === 0)
})
