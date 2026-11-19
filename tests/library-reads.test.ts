/**
 * `LibraryClient` 的第一片：**doc / catalog 只读查询**。
 *
 * 判据不是「SQL 跑通」，是「工作集只包含该视图的闭包」：
 *   · 一个页的 Doc = 该页子树，**不含**顶层兄弟、不含别页；
 *   · 嵌套页的 Doc = 子树，祖先链**单独**返回（不是第二条子树）；
 *   · 多 root（日记流窗口）保留请求顺序；
 *   · catalog 只回槽要显示的全局身份（日记/标签/定义/回收站根），**不含页列表**。
 *
 * 这些断言是「首帧不读全库」的第一道机检：查询面一旦退化成全表，行数先红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, type RowWrite } from '../electron/library/sqlite.ts'
import { readAliasTargets, readBlockRows, readCatalogRows, readDocRows, readIdentityRows } from '../electron/library/reads.ts'
import { rowsToWorkspace } from '../src/core/storage/db-rows.ts'
import { normalizeAlias } from '../src/core/identity/address-key.ts'

function block(
  id: string,
  parent: string | null = null,
  left: string | null = null,
  extra: Record<string, string | number | null> = {},
): RowWrite {
  return {
    table: 'Block',
    op: 'upsert',
    key: { id },
    values: { content: '[]', created: 1, modified: 1, parent, left, ...extra },
  }
}

const alias = (name: string, block: string, pos: number): RowWrite => ({
  table: 'BlockAlias',
  op: 'upsert',
  key: { name },
  // 归一化键与写入侧同一个派生（`readAliasTargets` 就按它查）
  values: { block, pos, norm: normalizeAlias(name) },
})

const list = (block: string, name: 'page' | 'tag'): RowWrite => ({
  table: 'BlockList',
  op: 'upsert',
  key: { block, list: name },
})

const prop = (block: string, name: string, pos: number, multi: number, value: string): RowWrite => ({
  table: 'BlockProperty',
  op: 'upsert',
  key: { block, name, pos },
  values: { multi, value },
})

/**
 * 小库：
 *
 *   P（页）── A ── A1
 *   │        └ B
 *   S（顶层兄弟，不属于 P 的 Doc）
 *   J（日记日）──────── J1
 *   TAG（标签露面）／DEF（字段定义）／X（软删根）
 */
function seed(): RowWrite[] {
  return [
    block('p'),
    block('a', 'p'),
    block('b', 'p', 'a'),
    block('a1', 'a'),
    block('s', null, 'p'),
    block('j', null, null, { date: '2026-11-18' }),
    block('j1', 'j'),
    block('tag'),
    block('def', null, null, { kind: 'text' }),
    block('x', null, null, { deleted: 1 }),
    alias('Page', 'p', 0),
    alias('Child', 'a', 0),
    alias('Tag', 'tag', 0),
    alias('Def', 'def', 0),
    list('p', 'page'),
    list('tag', 'tag'),
    prop('a', '_tags', 0, 1, JSON.stringify('tag')),
  ]
}

function withDb(fn: (db: NonNullable<ReturnType<typeof openLibraryDb>['db']>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qua-library-reads-'))
  const opened = openLibraryDb(join(dir, 'qua.db'))
  assert.ok(opened.db, `open failed: ${opened.status}`)
  try {
    applyRowWrites(opened.db, seed())
    fn(opened.db)
  } finally {
    opened.db?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('doc：一个页只取自己的子树，不含顶层兄弟与别页', () => {
  withDb((db) => {
    const doc = readDocRows(db, ['p'])
    const ids = doc.rows.blocks.map((b) => String(b.id)).sort()
    assert.deepEqual(ids, ['a', 'a1', 'b', 'p'], '只取 P 的子树')
    assert.ok(!ids.includes('s'), '顶层兄弟 S 不属于 P 的 Doc')
    assert.ok(!ids.includes('j'), '日记 J 不属于 P 的 Doc')
    assert.deepEqual(doc.rootIds, ['p'])
    assert.deepEqual(doc.ancestors, [], '顶层页没有祖先')

    // 子树行可直接建模型：P 是根，A/B 是子，A1 在 A 下
    const ws = rowsToWorkspace(doc.rows)
    assert.equal(ws.blocks.length, 1)
    assert.equal(ws.blocks[0]!.id, 'p')
    assert.deepEqual(ws.blocks[0]!.children.map((b) => b.id), ['a', 'b'])
    assert.deepEqual(ws.blocks[0]!.children[0]!.children.map((b) => b.id), ['a1'])
    // 附属行也只在 Doc 内
    assert.deepEqual(ws.blocks[0]!.props?._aliases, ['Page'])
    assert.deepEqual(ws.blocks[0]!.children[0]!.props?._tags, ['tag'])
  })
})

test('doc：嵌套页的祖先链单独返回，不是第二条子树', () => {
  withDb((db) => {
    const doc = readDocRows(db, ['a1'])
    assert.deepEqual(doc.rows.blocks.map((b) => String(b.id)), ['a1'], '只有自己的子树')
    assert.deepEqual(doc.ancestors.map((b) => String(b.id)).sort(), ['a', 'p'], '祖先链是 A → P')
    for (const row of doc.ancestors) {
      assert.ok(!('content' in row) || typeof row.content === 'string', '祖先行保持原始行形状')
    }
  })
})

test('doc：多 root（日记流窗口）保留请求顺序', () => {
  withDb((db) => {
    const doc = readDocRows(db, ['j', 'p'])
    assert.deepEqual(doc.rootIds, ['j', 'p'], '请求顺序由调用方给，查询不按 id 重排')
    const ids = doc.rows.blocks.map((b) => String(b.id)).sort()
    assert.deepEqual(ids, ['a', 'a1', 'b', 'j', 'j1', 'p'], '两棵子树都在')
  })
})

test('catalog：只回槽要显示的全局身份，不含页列表', () => {
  withDb((db) => {
    const catalog = readCatalogRows(db)
    // node:sqlite 的行是 null-prototype 对象；比较前摊平成普通对象（只比较值，不比较原型）
    const plain = <T extends object>(rows: readonly T[]): T[] => rows.map((r) => ({ ...r }))
    assert.deepEqual(catalog.meta, { activeId: '', savedAt: 0, ftsState: 'pending', ftsTokenizer: '', ftsRowidSeq: 0, derivedState: 'pending' })
    assert.deepEqual(plain(catalog.journals), [{ id: 'j', date: '2026-11-18', deleted: null }], '日记含 deleted：打开软删天要能认出「这一天存在过」')
    assert.deepEqual(plain(catalog.tags), [{ id: 'tag', name: 'Tag' }])
    assert.deepEqual(plain(catalog.propDefs), [{ id: 'def', kind: 'text', name: 'Def' }])
    // 地址表**不在** catalog 里：归属是按名点查的（见下面 `aliasTargets` 那条）
    assert.ok(!('aliases' in catalog), '全量地址表不再随启动装载')
    assert.deepEqual(plain(catalog.trash), [{ id: 'x', deleted: 1 }])
    assert.ok(!('pages' in catalog), '页列表是查询视图，不在首帧目录')
  })
})

test('aliasTargets：按归一化键点查归属（不过滤软删；撞键先序取首）', () => {
  withDb((db) => {
    const rows = readAliasTargets(db, ['page', 'child', 'nope', 'def'])
    const got = rows.map((r) => ({ ...r })).sort((a, b) => a.norm.localeCompare(b.norm))
    assert.deepEqual(got, [
      { norm: 'child', block: 'a' },
      { norm: 'def', block: 'def' },
      { norm: 'page', block: 'p' },
    ])
    assert.deepEqual(readAliasTargets(db, []), [])
  })
})

test('blocks：一批块自己的行，不带子树', () => {
  withDb((db) => {
    const rows = readBlockRows(db, ['p', 'tag'])
    assert.deepEqual(
      rows.blocks.map((b) => String(b.id)).sort(),
      ['p', 'tag'],
      '按 id 装：只回块自己，不含它的子树与祖先',
    )
    const aliases = rows.aliases.map((r) => String(r.name)).sort()
    assert.deepEqual(aliases, ['Page', 'Tag'])
    const props = rows.props.map((r) => String(r.block))
    assert.ok(!props.includes('tag'), 'tag 块的 _tags 属性行属于别的块，不在这里')
  })
})


test('identity：全局身份块＝页/标签露面、字段定义、回收站根（不含普通内容块）', () => {
  withDb((db) => {
    const rows = readIdentityRows(db)
    const ids = rows.blocks.map((b) => String(b.id)).sort()
    assert.deepEqual(
      ids,
      ['def', 'p', 'tag', 'x'],
      '页 p（page 露面）、标签 tag、定义 def（kind）、回收站根 x（软删）；日记 j 的身份由 _date 推出、靠 catalog 日期表答，不在这批里',
    )
    // p 有 page 露面 ⇒ 带 _aliases；tag 有 tag 露面 ⇒ 名字在这份行里
    const names = rows.aliases.map((r) => String(r.name)).sort()
    assert.ok(names.includes('Page'), '页名随身份块一起装（选择器要显示名字）')
    assert.ok(!ids.includes('a') && !ids.includes('a1'), '普通内容块不是身份块')
    assert.ok(ids.includes('x'), '回收站根（软删）也是身份块——回收站卡要列它')
  })
})
