/**
 * 换库不混流：**两段历史不许拼成一份**。
 *
 * ## 这是切库污染里唯一**不可逆**的一档
 *
 * 折叠态错位、dock 卡死、activeId 跳到今日——那些是体验 bug，用户手动改回去就好。
 * 但 `op_log` 是 append-only 的**不可逆历史**：旧库的 op 若落到新库，重放就会把
 * 「换库前」与「换库后」两份事实拼成一份**从来没存在过的库**。同步立项之后，
 * 它还会变成两台设备对不上的根源——而且那时已经查不出是哪一步写坏的。
 *
 * ## 两条判据（都在落盘层，不靠调用方自觉）
 *
 * ① **整份替换 ＝ 新 genesis**：`replaceContentRows` 必须清 `op_log`、把 `meta.seq`
 *    归零，再把这一批 op 写进去。缺任一步，新库的日志里就会留着旧库的尾巴。
 * ② **同一份日志里只有一个设备线**：`op_log` 的主键是 `(device_id, seq)`，
 *    两段历史的 seq 都从 0 开始 ⇒ 撞主键。所以「混流」在落盘层其实是**写不进去**的，
 *    但那会让写入静默失败或跳号（`insert or ignore` 吞掉），比报错更糟。
 *
 * ## 为什么测落盘层而不是测 `clearPendingOps`
 *
 * `clearPendingOps()` 是**渲染层**的预防动作（把待落盘的 op 丢掉）。它对了，
 * 落盘层仍然可能把旧尾巴留在库里（例如崩溃后重开、或另一个入口走了 replace）。
 * 判据要落在**库里最后是什么**，不是「有没有调用某个函数」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { META_KEYS } from '../src/core/identity/library.ts'
import { workspaceToRowWrites, type StoredWorkspace } from '../src/core/storage/db-rows.ts'
import type { Block } from '../src/core/model/model.ts'
import {
  appendLocalOps,
  openLibraryDb,
  readContentRows,
  readSeq,
  replaceContentRows,
  type Db,
} from '../electron/library/sqlite.ts'

const dirs: string[] = []
function freshDb(): Db {
  const d = mkdtempSync(join(tmpdir(), 'qua-swap-'))
  dirs.push(d)
  const opened = openLibraryDb(join(d, 'qua.db'))
  assert.ok(opened.status === 'created' || opened.status === 'ok', `开库失败：${opened.status}`)
  return opened.db
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function block(id: string, text: string): Block {
  return { id, content: text ? [{ t: 'text', text }] : [], children: [], created: 1, modified: 2 }
}
function ws(blocks: Block[]): StoredWorkspace {
  return { blocks, activeId: blocks[0]?.id ?? '', savedAt: 1 }
}

const DEV = 'd'.repeat(32)

/** 读全部 op_log 的 (seq, op_json)，按 seq 升序 */
function logRows(db: Db): { seq: number; op_json: string }[] {
  return db.prepare('select seq, op_json from op_log order by seq').all() as { seq: number; op_json: string }[]
}

/* ═══════════════════════════════════════════════════════
   ① 整份替换 = 新 genesis（清日志、seq 归零）
   ═══════════════════════════════════════════════════════ */

test('换库：整份替换**清掉旧 op_log**——两段历史不许拼成一份', () => {
  const db = freshDb()
  try {
    // 旧库：写两块，日志里留下 2 条 op
    const oldWs = ws([block('1'.repeat(32), '旧库一'), block('2'.repeat(32), '旧库二')])
    replaceContentRows(db, workspaceToRowWrites(oldWs), {
      deviceId: DEV,
      oplog: [{ at: 1, opJson: '{"old":1}' }, { at: 2, opJson: '{"old":2}' }],
    })
    assert.equal(logRows(db).length, 2, '前置：旧库的日志里有 2 条')

    // 换库：整份替换成新内容，新内容自带 1 条 op
    const newWs = ws([block('3'.repeat(32), '新库')])
    replaceContentRows(db, workspaceToRowWrites(newWs), {
      deviceId: DEV,
      oplog: [{ at: 3, opJson: '{"new":1}' }],
    })

    const rows = logRows(db)
    assert.equal(rows.length, 1, `换库后日志里只该有新库那一条，实际 ${rows.length} 条：${JSON.stringify(rows)}`)
    assert.equal(rows[0]!.op_json, '{"new":1}', '留下的必须是新库那一条，不是旧库的')
  } finally {
    db.close()
  }
})

test('换库：整份替换把 `meta.seq` **归零再前进**（不是接着旧库往下数）', () => {
  const db = freshDb()
  try {
    replaceContentRows(db, workspaceToRowWrites(ws([block('1'.repeat(32), '旧')])), {
      deviceId: DEV,
      oplog: [{ at: 1, opJson: '{"a":1}' }, { at: 2, opJson: '{"a":2}' }, { at: 3, opJson: '{"a":3}' }],
    })
    assert.equal(readSeq(db), 3, '前置：旧库水位到 3')

    replaceContentRows(db, workspaceToRowWrites(ws([block('2'.repeat(32), '新')])), {
      deviceId: DEV,
      oplog: [{ at: 4, opJson: '{"b":1}' }],
    })

    // 归零后写这一批 ⇒ 水位是这一批的条数（1），不是 3+1
    assert.equal(readSeq(db), 1, `换库后水位应只算新库那一批，实际 ${readSeq(db)}`)
    const rows = logRows(db)
    assert.deepEqual(rows.map((r) => r.seq), [1], `新库的 seq 从 1 开始：${JSON.stringify(rows)}`)
  } finally {
    db.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ② 增量写入不许混进另一段历史
   ═══════════════════════════════════════════════════════ */

test('换库：替换之后走**增量**，seq 接着新库那条往下数（不回退到旧库水位）', () => {
  const db = freshDb()
  try {
    // 旧库：3 条
    replaceContentRows(db, workspaceToRowWrites(ws([block('1'.repeat(32), '旧')])), {
      deviceId: DEV,
      oplog: [1, 2, 3].map((n) => ({ at: n, opJson: `{"old":${n}}` })),
    })
    // 换库：1 条
    replaceContentRows(db, workspaceToRowWrites(ws([block('2'.repeat(32), '新')])), {
      deviceId: DEV,
      oplog: [{ at: 4, opJson: '{"new":1}' }],
    })
    // 之后正常编辑：增量追加
    appendLocalOps(db, DEV, [{ at: 5, opJson: '{"edit":1}' }])

    const rows = logRows(db)
    assert.deepEqual(rows.map((r) => r.seq), [1, 2], `换库后应是 1、2 两条，实际 ${JSON.stringify(rows)}`)
    assert.equal(rows[1]!.op_json, '{"edit":1}', '第二条是换库之后的编辑，不是旧库的残留')
    assert.equal(readSeq(db), 2)
  } finally {
    db.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ③ 内容也跟着换（不只是日志）
   ═══════════════════════════════════════════════════════ */

test('换库：整份替换之后**内容表里只剩新库的块**（旧块行不残留）', () => {
  const db = freshDb()
  try {
    replaceContentRows(db, workspaceToRowWrites(ws([block('1'.repeat(32), '旧一'), block('2'.repeat(32), '旧二')])), {
      deviceId: DEV,
      oplog: [{ at: 1, opJson: '{}' }],
    })
    replaceContentRows(db, workspaceToRowWrites(ws([block('3'.repeat(32), '新')])), {
      deviceId: DEV,
      oplog: [{ at: 2, opJson: '{}' }],
    })

    const raw = readContentRows(db)
    const ids = raw.blocks.map((b) => b.id as string).sort()
    assert.deepEqual(ids, ['3'.repeat(32)], `内容表里只该剩新库那一块，实际：${JSON.stringify(ids)}`)
  } finally {
    db.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ④ 重放等价：日志与内容说同一件事
   ═══════════════════════════════════════════════════════ */

test('换库：替换之后的日志**只描述新库**（重放得出来的不是两份拼起来的东西）', () => {
  const db = freshDb()
  try {
    replaceContentRows(db, workspaceToRowWrites(ws([block('1'.repeat(32), '旧')])), {
      deviceId: DEV,
      oplog: [{ at: 1, opJson: '{"block":"旧"}' }],
    })
    const newWs = ws([block('3'.repeat(32), '新')])
    const newOps = workspaceToRowWrites(newWs)
    replaceContentRows(db, newOps, {
      deviceId: DEV,
      oplog: [{ at: 2, opJson: '{"block":"新"}' }],
    })

    const rows = logRows(db)
    assert.equal(rows.length, 1, '日志里只剩一条')
    assert.equal(rows[0]!.op_json.includes('旧'), false, `日志里不许出现旧库的内容：${rows[0]!.op_json}`)
    assert.equal(rows[0]!.op_json.includes('新'), true, '日志里应是新库那一条')
  } finally {
    db.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ⑤ 反向对照：不替换的增量路径不许清日志
   ═══════════════════════════════════════════════════════ */

test('换库：**增量写入不清日志**（别把「替换」的纪律漏进常规编辑）', () => {
  const db = freshDb()
  try {
    appendLocalOps(db, DEV, [{ at: 1, opJson: '{"a":1}' }])
    appendLocalOps(db, DEV, [{ at: 2, opJson: '{"b":2}' }])
    const rows = logRows(db)
    assert.equal(rows.length, 2, `常规编辑不该清日志，实际 ${rows.length} 条`)
    assert.equal(readSeq(db), 2)
  } finally {
    db.close()
  }
})
