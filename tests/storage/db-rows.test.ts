/**
 * 库的行编码（`src/core/storage/db-rows.ts`）—— 纯函数，跑真模型。
 *
 * 四条判据，每一条都能单独证伪：
 *   ① **往返**：模型 → 行 → 模型，逐格相同（不然「读回来少一格」只会到用户发现时才显形）；
 *   ② **成本**：一次编辑落盘的行数**不随库里块数增长**（这是整个改造的验收口径）；
 *   ③ **`parent`／`left` 是单向投影**：装载建 `children`、写入从 `children` 生成，两层不各存一份；
 *   ④ **兄弟链断了也不丢块**：悬空 `left`／分叉／成环都当链头处理，宁可顺序错也不许少一块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, type Block } from '../../src/core/model.ts'
import { WORKSPACE_VERSION, type Workspace } from '../../src/core/workspace.ts'
import {
  positionsOf,
  probeOf,
  rowWritesFor,
  rowsToWorkspace,
  workspaceToRowWrites,
  type RawLibraryRows,
  type RowWrite,
} from '../../src/core/storage/db-rows.ts'
import { applyRowWrites, openLibraryDb, readContentRows, replaceContentRows } from '../../electron/library/sqlite.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
function tmpDb(): ReturnType<typeof openLibraryDb> {
  const d = mkdtempSync(join(tmpdir(), 'qua-rows-'))
  dirs.push(d)
  return openLibraryDb(join(d, 'qua.db'))
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function ws(blocks: Block[], patch: Partial<Workspace> = {}): Workspace {
  return { version: WORKSPACE_VERSION, blocks, activeId: blocks[0]?.id ?? '', savedAt: 42, ...patch }
}

/** 把行写进真库再读回来（**往返**的唯一可信做法：中间隔着 SQLite 的列类型） */
function roundTrip(w: Workspace): Workspace {
  const r = tmpDb()
  assert.equal(r.status, 'created')
  const db = r.db!
  replaceContentRows(db, workspaceToRowWrites(w))
  const back = rowsToWorkspace(readContentRows(db))
  db.close()
  return { ...back, version: WORKSPACE_VERSION }
}

/** 用户字段的两个键：一个是多值、一个是单值（形状用 32-hex，与字段定义块的 id 同形） */
const MULTI_ID = 'f'.repeat(32)
const SINGLE_ID = 'g'.repeat(32)

/** 一块带齐全家的块：正文、子块、属性（含数组与非字符串数组）、地址、露面 */
function richBlock(id: string): Block {
  return {
    id,
    content: [
      { t: 'text', v: 'hello ' },
      { id: 'r1', t: 'ref', to: 'target', label: '目标' },
    ],
    children: [],
    created: 100,
    modified: 200,
    annos: [{ id: 'a1', range: { start: 0, end: 5 } }],
    props: {
      _aliases: ['A/B', '别名二'],
      _lists: ['page', 'tag'],
      _display: 'text',
      _icon: 'lucide:file',
      _type: 'outline',
      _date: '2026-10-28',
      _tags: ['t1', 't2'],
      _belongsTo: ['p1'],
      _fieldDefs: ['d1', 'd2'],
      _ownProps: ['d3'],
      _mounts: [{ label: '待办', spec: { where: { todo: 'todo' } } }],
      _query: { where: { todo: 'todo' } },
      _queryResult: [{ blockId: 'x', path: [] }],
      [MULTI_ID]: ['值一', '值二'],
      [SINGLE_ID]: '单值',
    },
  }
}

/* ------------------------------------------------------------ ① 往返 */

test('往返：正文／annos／时刻／属性／地址／露面／树形，逐格相同', () => {
  const child = mkBlock('子块')
  const rich = richBlock('rich')
  rich.children = [child]
  const back = roundTrip(ws([rich, mkBlock('第二个根')]))

  assert.equal(back.blocks.length, 2, '两个顶层根')
  const b = back.blocks[0]!
  assert.equal(b.id, 'rich')
  assert.deepEqual(b.content, rich.content, '正文（run 序列）必须逐字节回来')
  assert.deepEqual(b.annos, rich.annos, 'annos 是一整列 JSON，回来要一样')
  assert.equal(b.created, 100)
  assert.equal(b.modified, 200)
  assert.deepEqual(b.children.map((c) => c.id), [child.id], '子树按 `left` 重建')

  // 有序数组与单值必须分得开（`multi` 位就是为这件事存的）
  assert.deepEqual(b.props?._aliases, ['A/B', '别名二'], '地址有序，首个是主名')
  assert.deepEqual([...(b.props?._lists ?? [])].sort(), ['page', 'tag'], '露面是集合')
  assert.deepEqual(b.props?._tags, ['t1', 't2'], '有序字符串列表拆行后要按 pos 拼回来')
  assert.deepEqual(b.props?._belongsTo, ['p1'])
  assert.deepEqual(b.props?._fieldDefs, ['d1', 'd2'])
  assert.deepEqual(b.props?._ownProps, ['d3'])
  assert.equal(b.props?._display, 'text', '`_display` 升成列，读回属性袋')
  assert.equal(b.props?._icon, 'lucide:file')
  assert.equal(b.props?._type, 'outline')
  assert.equal(b.props?._date, '2026-10-28')
  assert.deepEqual(b.props?._query, { where: { todo: 'todo' } }, '`_query` 升成列（JSON）')
  assert.deepEqual(b.props?._mounts, [{ label: '待办', spec: { where: { todo: 'todo' } } }], '非字符串数组整份当一格 JSON')
  assert.deepEqual(b.props?.['f'.repeat(32)], ['值一', '值二'], '用户字段的多值也要拆行、按 pos 回来')
  assert.equal(b.props?.['g'.repeat(32)], '单值', '一元数组与单值不能混')
})

test('往返：`_queryResult` 不进库（派生值落盘会在条件变了之后说谎）', () => {
  const back = roundTrip(ws([richBlock('rich')]))
  assert.equal(back.blocks[0]!.props?._queryResult, undefined, '冻结的结果集是派生值，不该落盘')
})

test('往返：软删标记是块上的时刻，不是独立记录', () => {
  const deleted: Block = { ...mkBlock('删了'), props: { _deletedAt: 12345 } }
  const back = roundTrip(ws([deleted]))
  assert.equal(back.blocks[0]!.props?._deletedAt, 12345)
  assert.equal(back.blocks[0]!.id, deleted.id, '软删不摘树：块还在原位')
})

test('往返：空数组 ＝ 没有这一格（两边的答案必须一致）', () => {
  const b = mkBlock('空集合')
  b.props = { _tags: [], _fieldDefs: [] }
  const back = roundTrip(ws([b]))
  assert.equal(back.blocks[0]!.props, undefined, '空集合落成 0 行，读回来就是「没有属性袋」')
})

test('往返：库级两格（当前对象／落盘时刻）走 meta', () => {
  const first = mkBlock('一')
  const back = roundTrip(ws([first], { activeId: first.id, savedAt: 777 }))
  assert.equal(back.activeId, first.id)
  assert.equal(back.savedAt, 777)
})

/* ------------------------------------------------------------ ② 成本 */

/**
 * **验收口径**：一次编辑落盘的行数**不随库里块数增长**。
 *
 * 度量用「行写入的条数」而不是时间：时间在 CI 上不稳，而条数正是成本的来源。
 * 判据写成「小库与大库的行数相同」，而不是「小于某个魔数」——前者是性质，后者是快照。
 */
test('成本：一次打字（1 条 `block.upsert{content}`）落盘的行数与库体量无关', () => {
  const one: Block = mkBlock('x')
  const small = ws([one])
  const bigRoot = mkBlock('大库根')
  bigRoot.children = Array.from({ length: 500 }, (_, i) => mkBlock(`c${i}`))
  const big = ws([bigRoot, one])

  const op = { e: 'block' as const, id: one.id, op: 'upsert' as const, value: { content: [{ t: 'text' as const, v: 'x!' }], modified: 999 }, at: 999 }
  const a = rowWritesFor(small, [op])
  const b = rowWritesFor(big, [op])
  assert.equal(a.length, b.length, `行数必须与库体量无关（小库 ${a.length}，大库 ${b.length}）`)
  // 一条内容写入 ＝ 1 行块 ＋ 2 行 meta（当前对象与落盘时刻）
  assert.equal(a.length, 3, `一次打字应当只写 3 行，实际 ${a.length}：${a.map((w) => `${w.table}.${w.op}`).join(',')}`)
  // 而且它**不碰**别的块
  assert.deepEqual(a.filter((w) => w.table === 'Block').map((w) => w.key.id), [one.id])
})

test('成本：真库上落一次打字，`changes` 数也只有常数行（不是全库重写）', () => {
  const one: Block = mkBlock('x')
  const bigRoot = mkBlock('大库根')
  bigRoot.children = Array.from({ length: 300 }, (_, i) => mkBlock(`c${i}`))
  const big = ws([bigRoot, one])

  const r = tmpDb()
  const db = r.db!
  replaceContentRows(db, workspaceToRowWrites(big))
  const before = (db.prepare('select total_changes() as n').all() as { n: number }[])[0]!.n

  const changed = applyRowWrites(
    db,
    rowWritesFor(big, [
      { e: 'block', id: one.id, op: 'upsert', value: { content: [{ t: 'text', v: 'x!' }], modified: 999 }, at: 999 },
    ]),
  )
  const after = (db.prepare('select total_changes() as n').all() as { n: number }[])[0]!.n
  assert.ok(changed <= 3, `一次打字最多写 3 行，实际 ${changed}`)
  assert.ok(after - before <= 3, `SQLite 侧的变更行数也必须 <= 3，实际 ${after - before}（301 块的库）`)
  db.close()
})

test('成本：打一个字**不碰**其它块的行（内容一字不动）', () => {
  const one: Block = mkBlock('x')
  const other = mkBlock('别的块')
  other.props = { _aliases: ['别的页'], _lists: ['page'] }
  const w = ws([one, other])
  const writes = rowWritesFor(w, [
    { e: 'block', id: one.id, op: 'upsert', value: { content: [{ t: 'text', v: 'y' }], modified: 2 }, at: 2 },
  ])
  const touched = new Set(writes.filter((x) => x.table !== 'meta').map((x) => String(x.key.block ?? x.key.id ?? '')))
  assert.deepEqual([...touched], [one.id], `只该碰正在打字的那一块，实际：${[...touched].join(',')}`)
})

/* ------------------------------------------------------------ ③ 单向投影 */

test('投影：`positionsOf` 给的 parent／left 与 `children` 一致（同一棵树的两张脸）', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const b = mkBlock('b')
  root.children = [a, b]
  const at = positionsOf([root])
  assert.deepEqual(at.get(a.id), { parent: root.id, left: null })
  assert.deepEqual(at.get(b.id), { parent: root.id, left: a.id })
  assert.deepEqual(at.get(root.id), { parent: null, left: null })
})

test('投影：结构写入按 op 的 `prev` 落 `left`（不重新算一遍，位置只有一份来源）', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const c = mkBlock('c')
  root.children = [a, c]
  const writes = rowWritesFor(ws([root]), [{ e: 'block', id: c.id, op: 'upsert', value: { parent: root.id, prev: a.id }, at: 1 }])
  const row = writes.find((w) => w.table === 'Block' && w.key.id === c.id)
  assert.ok(row)
  assert.equal(row!.values?.parent, root.id)
  assert.equal(row!.values?.left, a.id, '`prev` 直接就是 `left`')
})

/* ------------------------------------------------------------ ④ 兄弟链维护（真库往返） */

/**
 * 这一组是**唯一**能证明「`left` 这个编码写对了」的断言：它必须经过真 SQLite 往返。
 *
 * 为什么单独一组：`left` 是**前兄弟指针**，一个块换位置时有两个邻居要跟着改
 * （旧位置的后继、新位置的后继）。只写自己那一格，链就断了 ——
 * 而断链**不报错**，只在下次装载时把顺序排错。这四条是照着实测失败写的。
 */
function freshDb(w: Workspace) {
  const r = tmpDb()
  assert.equal(r.status, 'created')
  const db = r.db!
  replaceContentRows(db, workspaceToRowWrites(w))
  return db
}

test('兄弟链：首位插入一块之后重载，顺序还是插入后的顺序', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const b = mkBlock('b')
  root.children = [a, b]
  const w = ws([root])
  const db = freshDb(w)

  const x = mkBlock('x')
  root.children = [x, a, b]
  applyRowWrites(db, rowWritesFor(w, [{ e: 'block', id: x.id, op: 'upsert', value: { parent: root.id, prev: null }, at: 2 }]))
  const back = rowsToWorkspace(readContentRows(db))
  db.close()
  assert.deepEqual(
    back.blocks[0]!.children.map((c) => (c.id === x.id ? 'x' : c.id === a.id ? 'a' : 'b')),
    ['x', 'a', 'b'],
    '新块插到首位之后，原来那个「首块」的前驱必须改指它（否则重载会排成 a,b,x）',
  )
})

test('兄弟链：中间块移走之后重载，原位置的顺序也必须对', () => {
  const root = mkBlock('根')
  // id 故意取成会让「悬空链头按 id 排序」暴露问题的形状
  const a = mkBlock('m')
  const b = mkBlock('b')
  const c = mkBlock('a')
  const d = mkBlock('z')
  root.children = [a, b, c, d]
  const other = mkBlock('另一棵')
  const w = ws([root, other])
  const db = freshDb(w)

  root.children = [a, c, d]
  other.children = [b]
  applyRowWrites(db, rowWritesFor(w, [{ e: 'block', id: b.id, op: 'upsert', value: { parent: other.id, prev: null }, at: 2 }]))
  const back = rowsToWorkspace(readContentRows(db))
  const name = (x: Block): string => (x.id === a.id ? 'm' : x.id === b.id ? 'b' : x.id === c.id ? 'a' : 'z')
  const rootKids = back.blocks[0]!.children.map(name)
  const otherKids = back.blocks[1]!.children.map(name)
  db.close()
  assert.deepEqual(rootKids, ['m', 'a', 'z'], `原位置的后继必须改指被移走那一块的旧前驱，实际：${rootKids.join(',')}`)
  assert.deepEqual(otherKids, ['b'])
})

test('兄弟链：移到末尾之后重载，顺序也对', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const b = mkBlock('b')
  const c = mkBlock('c')
  root.children = [a, b, c]
  const w = ws([root])
  const db = freshDb(w)

  root.children = [b, c, a]
  applyRowWrites(db, rowWritesFor(w, [{ e: 'block', id: a.id, op: 'upsert', value: { parent: root.id, prev: c.id }, at: 2 }]))
  const back = rowsToWorkspace(readContentRows(db))
  db.close()
  assert.deepEqual(
    back.blocks[0]!.children.map((x) => (x.id === a.id ? 'a' : x.id === b.id ? 'b' : 'c')),
    ['b', 'c', 'a'],
  )
})

test('兄弟链：`relink` 必须排在「写我自己那一行」之前（它要读改之前的前驱）', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const b = mkBlock('b')
  root.children = [a, b]
  const w = ws([root])
  const writes = rowWritesFor(w, [{ e: 'block', id: b.id, op: 'upsert', value: { parent: root.id, prev: null }, at: 2 }])
  const at = writes.findIndex((x) => x.op === 'relink' && x.key.id === b.id)
  const row = writes.findIndex((x) => x.table === 'Block' && x.op === 'upsert' && x.key.id === b.id)
  assert.ok(at >= 0 && row >= 0)
  assert.ok(at < row, `relink 必须先于整块写（实际 ${at} vs ${row}）`)
})

/* ------------------------------------------------------------ ⑤ 断链兜底 */

test('断链：`left` 指向不存在的块 ⇒ 当链头（宁可顺序错，不许少一块）', () => {
  const back = rowsToWorkspace({
    blocks: [
      { id: 'r', content: '[]', created: 1, modified: 1, parent: null, left: null },
      { id: 'a', content: '[]', created: 1, modified: 1, parent: 'r', left: 'gone' },
      { id: 'b', content: '[]', created: 1, modified: 1, parent: 'r', left: 'a' },
    ],
    props: [],
    aliases: [],
    lists: [],
    meta: {},
  })
  assert.deepEqual(back.blocks[0]!.children.map((x) => x.id), ['a', 'b'], '悬空的前兄弟当链头，链继续往下接')
})

test('断链：父 id 指向不存在的块 ⇒ 那块当顶层（否则它和整棵子树都消失）', () => {
  const back = rowsToWorkspace({
    blocks: [{ id: 'orphan', content: '[]', created: 1, modified: 1, parent: 'nope', left: null }],
    props: [],
    aliases: [],
    lists: [],
    meta: {},
  })
  assert.deepEqual(back.blocks.map((x) => x.id), ['orphan'])
})

test('断链：两条都声称接在同一个人后面（分叉）⇒ 后来的当链头，两块都在', () => {
  const back = rowsToWorkspace({
    blocks: [
      { id: 'r', content: '[]', created: 1, modified: 1, parent: null, left: null },
      { id: 'a', content: '[]', created: 1, modified: 1, parent: 'r', left: null },
      { id: 'b', content: '[]', created: 1, modified: 1, parent: 'r', left: 'a' },
      { id: 'c', content: '[]', created: 1, modified: 1, parent: 'r', left: 'a' },
    ],
    props: [],
    aliases: [],
    lists: [],
    meta: {},
  })
  const kids = back.blocks[0]!.children.map((x) => x.id)
  assert.equal(kids.length, 3, `分叉不许丢块，实际：${kids.join(',')}`)
  assert.ok(kids.includes('b') && kids.includes('c'))
})

test('断链：成环 ⇒ 走不到的块按 id 补在末尾（一块都不少）', () => {
  const back = rowsToWorkspace({
    blocks: [
      { id: 'r', content: '[]', created: 1, modified: 1, parent: null, left: null },
      { id: 'a', content: '[]', created: 1, modified: 1, parent: 'r', left: 'b' },
      { id: 'b', content: '[]', created: 1, modified: 1, parent: 'r', left: 'a' },
    ],
    props: [],
    aliases: [],
    lists: [],
    meta: {},
  })
  const kids = back.blocks[0]!.children.map((x) => x.id)
  assert.deepEqual(kids.sort(), ['a', 'b'], `成环也要两块都在，实际：${kids.join(',')}`)
})

/* ------------------------------------------------------------ 增量写：逐 op 覆盖 */

test('增量写：属性／地址／露面／annos 各自的 op 都落到对的那张表', () => {
  const b = mkBlock('x')
  b.props = { _aliases: ['新名'], _lists: ['page'], _icon: 'lucide:x' }
  b.annos = [{ id: 'a1', range: { start: 0, end: 1 } }]
  const writes = rowWritesFor(ws([b]), [
    { e: 'prop', block: b.id, name: '_icon', op: 'set', value: 'lucide:y', at: 1 },
    { e: 'prop', block: b.id, name: '_aliases', op: 'set', value: ['新名'], at: 1 },
    { e: 'prop', block: b.id, name: '_lists', op: 'set', value: ['page'], at: 1 },
    { e: 'anno', block: b.id, id: 'a1', op: 'set', value: { id: 'a1', range: { start: 0, end: 2 } }, at: 1 },
  ])
  const tables = writes.map((w) => w.table)
  assert.ok(tables.includes('BlockProperty'), '属性走属性表')
  assert.ok(tables.includes('BlockAlias'), '地址走地址表')
  assert.ok(tables.includes('BlockList'), '露面走露面表')
  assert.ok(writes.some((w) => w.table === 'Block' && w.values?.annos !== undefined), 'annos 是块上的一整列')
})

test('增量写：软删只写 `deleted` 列（原位软删，不删行）', () => {
  const b = mkBlock('x')
  const writes = rowWritesFor(ws([b]), [{ e: 'block', id: b.id, op: 'exist', state: 'deleted', at: 4242 }])
  const row = writes.find((w) => w.table === 'Block')
  assert.ok(row)
  assert.equal(row!.op, 'update', '软删是改一列，不是删行（块留在原位）')
  assert.equal(row!.values?.deleted, 4242)
})

test('增量写：恢复把 `deleted` 清空（块从未离开树，行也原样留着）', () => {
  const b = mkBlock('x')
  b.props = { _deletedAt: 4242 }
  const writes = rowWritesFor(ws([b]), [{ e: 'block', id: b.id, op: 'exist', state: 'present', at: 5000 }])
  const row = writes.find((w) => w.table === 'Block')
  assert.equal(row!.op, 'update')
  assert.equal(row!.values?.deleted, null)
})

test('增量写：清除（撤销一次插入）**删掉这块的全部行**，不是写成软删', () => {
  const b = mkBlock('x')
  const writes = rowWritesFor(ws([b]), [{ e: 'block', id: b.id, op: 'exist', state: 'purged', at: 4242 }])
  assert.ok(
    writes.some((w) => w.table === 'Block' && w.op === 'delete' && w.key.id === b.id),
    '清除要删块行：写成 deleted=at 会让撤销后重开时块从回收站冒出来',
  )
  for (const table of ['BlockProperty', 'BlockAlias', 'BlockList'] as const) {
    assert.ok(writes.some((w) => w.table === table && w.op === 'delete'), `${table} 的子表行也要一起清`)
  }
})

test('增量写：改一列走 `update`（匹配不到行要报错，不许静默变成「插入一行空块」）', () => {
  const b = mkBlock('x')
  const writes = rowWritesFor(ws([b]), [{ e: 'block', id: b.id, op: 'upsert', value: { content: [], modified: 5 }, at: 5 }])
  const row = writes.find((w) => w.table === 'Block')
  assert.equal(row!.op, 'update', 'SQLite 的部分列 upsert 会先撞 NOT NULL（实测），所以改一列只能走 update')
})

test('增量写：模型里的块不在树上 ⇒ 连它的子表行一起清掉（不留幽灵块）', () => {
  const writes = rowWritesFor(ws([mkBlock('x')]), [{ e: 'block', id: 'ghost', op: 'upsert', value: { parent: null, prev: null }, at: 1 }])
  assert.ok(
    writes.some((w) => w.table === 'Block' && w.op === 'delete' && w.key.id === 'ghost'),
    '模型里没有它 ⇒ 盘上也不该有（留着会在下次装载时自己冒出来）',
  )
  assert.equal(writes.filter((w) => w.table === 'Block' && w.op === 'upsert').length, 0, '不许插入一个只有落点的空块')
})

/* ------------------------------------------------------------ 探测 */

test('probeOf：只在给定的 id 里找，找到就停（不做全库遍历的拷贝）', () => {
  const root = mkBlock('根')
  const a = mkBlock('a')
  const b = mkBlock('b')
  root.children = [a, b]
  const probe = probeOf([root], [b.id])
  assert.equal(probe.get(b.id)?.id, b.id)
  assert.equal(probe.get(a.id), undefined, '没要求找的不在探测里（省掉一次遍历）')
})
