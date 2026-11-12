/**
 * 落盘 round-trip：**模型 → 行 → SQLite → 行 → 模型** 必须回到逐字段相同的一份。
 *
 * ## 这条断言为什么比它看起来更重要
 *
 * 它不测「导出功能」，它测的是**迁移有没有把内容写坏**。原型纪律是升版即作废旧库
 * （`AGENTS.md` 的迁移一节），所以「迁移」在本仓只有两种：丢内容、或者只加表。
 * 一旦出现第三种（真的搬数据），判断它对不对的唯一硬办法就是：
 *
 *     模型 → 写成行 → 真落一次盘 → 读回来 → 与原来的模型逐字段相同
 *
 * 这条断言现在就该在，因为**它成立与否与数据形状无关**：形状怎么变，这对编解码
 * 都得互逆。等到真写迁移时才补，等于在最需要它的那一刻才开始写它。
 *
 * ## 为什么走真 SQLite 而不是在内存里模拟
 *
 * 只在内存里配对 `workspaceToRowWrites` / `rowsToWorkspace` 会漏掉整整一层：
 * 主进程的 DDL（NOT NULL、主键、外键、`relink` 的兄弟链修复）才是「行真的能落地」
 * 的地方。四张表里任何一张的约束与编码假设不一致，都只会在真落盘时暴露
 * （例如「只改一列」走 upsert 会撞 NOT NULL —— 那是实测过的坑）。
 *
 * ## 覆盖的形状（这些是「会丢东西」的高危处）
 *
 * ① 森林多层 ＋ 兄弟序；② 行内四种 run；③ 属性袋里的系统键；
 * ④ 注释（`annos`）；⑤ 软删；⑥ 空库；⑦ 编码确定性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rowsToWorkspace, workspaceToRowWrites, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import type { Block } from '../src/core/model/model.ts'
import { applyRowWrites, openLibraryDb, readContentRows } from '../electron/library/sqlite.ts'

const dirs: string[] = []
function freshDb() {
  const d = mkdtempSync(join(tmpdir(), 'qua-rt-'))
  dirs.push(d)
  const opened = openLibraryDb(join(d, 'qua.db'))
  assert.ok(opened.status === 'created' || opened.status === 'ok', `开库失败：${opened.status}`)
  return opened.db
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

/* ------------------------------------------------------------ 夹具 */

function block(id: string, text: string, children: Block[] = [], props?: Record<string, unknown>): Block {
  return {
    id,
    content: text.length > 0 ? [{ t: 'text', text }] : [],
    children,
    created: 1_700_000_000_000,
    modified: 1_700_000_000_001,
    ...(props ? { props } : {}),
  }
}

/** 一份「尽量把各种形状都用上」的库 */
function richForest(): Block[] {
  return [
    block('a'.repeat(32), '第一块', [
      block('b'.repeat(32), '子块一'),
      block('c'.repeat(32), '子块二', [block('d'.repeat(32), '孙块')]),
    ]),
    block('e'.repeat(32), '', [], {
      _aliases: ['页名'],
      _lists: ['page'],
      _icon: 'lucide:book',
      _date: '2026-11-12',
    }),
    block('f'.repeat(32), '带标签的块', [], {
      _tags: ['e'.repeat(32)],
      _belongsTo: ['e'.repeat(32)],
    }),
  ]
}

function ws(blocks: Block[]): StoredWorkspace {
  return { blocks, activeId: blocks[0]?.id ?? '', savedAt: 1_700_000_000_002 }
}

/** 模型 → 真落盘 → 读回 → 模型 */
function roundTrip(before: StoredWorkspace): StoredWorkspace {
  const db = freshDb()
  try {
    const writes = workspaceToRowWrites(before)
    applyRowWrites(db, writes)
    return rowsToWorkspace(readContentRows(db))
  } finally {
    db.close()
  }
}

/** 比较用的投影：去掉 `savedAt`（它不是内容） */
function shapeOf(w: StoredWorkspace) {
  return { blocks: w.blocks, activeId: w.activeId }
}

/* ------------------------------------------------------------ ① 基本互逆 */

test('round-trip：模型 → 行 → SQLite → 模型 逐字段相同（多层森林 ＋ 兄弟序）', () => {
  const before = ws(richForest())
  const after = roundTrip(before)
  assert.deepEqual(shapeOf(after), shapeOf(before), '整片森林必须原样回来（层、兄弟序、正文、属性）')
})

test('round-trip：**同一份模型编两次，行写入必须一样**（编码是确定的）', () => {
  const a = JSON.stringify(workspaceToRowWrites(ws(richForest())))
  const b = JSON.stringify(workspaceToRowWrites(ws(richForest())))
  assert.equal(a, b, '同一份模型两次编码结果不同 ⇒ 落盘不可比对（快照/差分都会抖）')
})

test('round-trip：**空库**也能互逆（不是「有内容才对」）', () => {
  const after = roundTrip(ws([]))
  assert.deepEqual(after.blocks, [])
})

/* ------------------------------------------------------------ ② 系统属性不许丢 */

test('round-trip：属性袋里的系统键**一个都不丢**（别名/露面/图标/日期/标签/归属）', () => {
  const after = roundTrip(ws(richForest()))

  const target = after.blocks.find((b) => b.id === 'e'.repeat(32))
  assert.ok(target, '带身份的块应还在')
  assert.deepEqual(target!.props?._aliases, ['页名'])
  assert.deepEqual(target!.props?._lists, ['page'])
  assert.equal(target!.props?._icon, 'lucide:book')
  assert.equal(target!.props?._date, '2026-11-12')

  const tagged = after.blocks.find((b) => b.id === 'f'.repeat(32))
  assert.deepEqual(tagged!.props?._tags, ['e'.repeat(32)])
  assert.deepEqual(tagged!.props?._belongsTo, ['e'.repeat(32)])
})

test('round-trip：**行内四种 run** 都要回来（文本/引用/外链/资产）', () => {
  const mixed: Block = {
    id: 'g'.repeat(32),
    content: [
      { t: 'text', text: '前面' },
      { t: 'ref', block: 'e'.repeat(32), anchor: '锚文本' },
      { t: 'link', url: 'https://example.com/x', label: '外链' },
      { t: 'asset', asset: 'deadbeef'.repeat(8), alt: '图' },
    ],
    children: [],
    created: 1,
    modified: 2,
  }
  const after = roundTrip(ws([mixed]))
  assert.deepEqual(after.blocks[0]!.content, mixed.content, 'run 序列必须原样回来')
})

/* ------------------------------------------------------------ ③ 软删与注释 */

test('round-trip：**软删的块**也要回来（删除时刻是内容的一部分，不是过滤条件）', () => {
  // ⚠️ 软删在模型里是 `props._deletedAt`（一格属性），落盘升成 `Block.deleted` 列。
  //    写成 `{...block, deleted: n}` 是**错的形状**：那一格不在 Block 的顶层字段上。
  const dead: Block = { ...block('h'.repeat(32), '被删掉的块'), props: { _deletedAt: 1_700_000_000_003 } }
  const after = roundTrip(ws([dead]))
  assert.equal(
    after.blocks[0]!.props?._deletedAt,
    1_700_000_000_003,
    '软删时刻不许丢（丢了就复活了）',
  )
})

test('round-trip：**注释（annos）** 要回来', () => {
  const annotated: Block = {
    ...block('i'.repeat(32), '带注释的块'),
    annos: [{ start: 0, end: 2, kind: 'bold' } as never],
  }
  const after = roundTrip(ws([annotated]))
  assert.deepEqual(after.blocks[0]!.annos, annotated.annos)
})

/* ------------------------------------------------------------ ④ 深层与空正文 */

test('round-trip：**深层嵌套 ＋ 空正文** 也不变形（这是迁移的安全网）', () => {
  const weird: Block[] = [
    block('j'.repeat(32), '', [
      block('k'.repeat(32), '', [block('l'.repeat(32), '', [block('m'.repeat(32), '最深')])], {
        _uiPosition: 'block-below',
      }),
    ]),
  ]
  const after = roundTrip(ws(weird))
  const deepest = after.blocks[0]!.children[0]!.children[0]!.children[0]!
  assert.deepEqual(deepest.content, [{ t: 'text', text: '最深' }])
  assert.deepEqual(after.blocks[0]!.children[0]!.props?._uiPosition, 'block-below')
})

test('round-trip：**兄弟序是真的被落盘了**（打乱顺序必须读得出来不同）', () => {
  // 判据不是「顺序对」——而是**顺序能变**。若 `left` 没被写进去，任何顺序都会
  // 退化成一堆链头，读回来的次序就与写入无关了（那种编码在断言里看起来照样「对」）。
  const a = block('a'.repeat(32), '甲')
  const b = block('b'.repeat(32), '乙')
  const c = block('c'.repeat(32), '丙')

  const order1 = roundTrip(ws([a, b, c])).blocks.map((x) => x.content[0])
  const order2 = roundTrip(ws([c, b, a])).blocks.map((x) => x.content[0])

  assert.deepEqual(order1, [{ t: 'text', text: '甲' }, { t: 'text', text: '乙' }, { t: 'text', text: '丙' }])
  assert.deepEqual(order2, [{ t: 'text', text: '丙' }, { t: 'text', text: '乙' }, { t: 'text', text: '甲' }])
  assert.notDeepEqual(order1, order2, '兄弟序必须真的落盘——两种顺序读出同一种就说明 left 没写')
})

/* ------------------------------------------------------------ ⑤ 二次 round-trip 稳定 */

test('round-trip：**做两次**结果不变（幂等——这是「反复迁移不出事」的判据）', () => {
  const once = roundTrip(ws(richForest()))
  const twice = roundTrip(once)
  assert.deepEqual(shapeOf(twice), shapeOf(once), '第二次 round-trip 不该再改任何东西')
})
