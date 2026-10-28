/**
 * `op_log` 的**写入时机**：现在它接了。
 *
 * ## 判据的历史
 *
 * 这条断言曾经是**负向**的（「生产路径上不许有写入者」），理由是：
 * 撤销/重做与冷启动物化**不产 op** ⇒ 此刻写进去的日志只有结构变更，
 * 而 append-only 日志里的空洞与「那段时间什么都没发生」**无法区分** ——
 * 半截历史比没有历史更糟。
 *
 * ## 现在为什么能接
 *
 * 三个缺口都销了（撤销改走 `diff`+`applyOps`、冷启动物化走事务、换库天然跨库不混流）：
 * **所有让库变化的路径都产 op**。于是这条断言翻面成**正向**的，
 * 但它仍然是一条**静态**断言 —— 它拦的是「有人又加第二条写入路径」。
 *
 * ## 现在钉什么
 *
 * | # | 断言 | 反证方式 |
 * |---|---|---|
 * | ① | 生产代码里**恰好一个**写入者（`applyRowWrites` 内部那一条） | 在 `windows.ts` 的 save handler 里再调一次 `appendLocalOps`，本条红 |
 * | ② | 表在、形状对（PK `(device_id, seq)` 是幂等的来源） | 改 DDL 的 PK，本条红 |
 * | ③ | 变更流与行写入**同一个事务**（分开写会重号或跳号） | 把 `appendLocalOpsInner` 移出 `inTransaction`，本条红 |
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

function readAll(dir: string, ext: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith(ext)) out.set(p.slice(ROOT.length + 1), readFileSync(p, 'utf8'))
    }
  }
  walk(dir)
  return out
}

/** 生产代码：`src/**` ＋ `electron/**`（测试与检查脚本不算） */
function productionSources(): Map<string, string> {
  const out = new Map(readAll(join(ROOT, 'src'), '.ts'))
  for (const [k, v] of readAll(join(ROOT, 'electron'), '.ts')) out.set(k, v)
  return out
}

/** 唯一允许写 `op_log` 的文件（行写入与变更流同事务的那个） */
const ONLY_WRITER = 'electron/library/sqlite.ts'

test('op_log：生产路径上**恰好一个**写入者（多一个就是第二份历史）', () => {
  const hits: string[] = []
  for (const [file, body] of productionSources()) {
    if (file === ONLY_WRITER) continue
    for (const name of ['appendLocalOps', 'appendLocalOpsInner', 'appendOp']) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) hits.push(`${file} 调用了 ${name}`)
    }
    // 直接写表的也算（绕过函数更该拦）
    if (/insert\s+(or\s+ignore\s+)?into\s+op_log/i.test(body)) hits.push(`${file} 直接写 op_log 表`)
  }
  assert.deepEqual(
    hits,
    [],
    `op_log 的写入者只能有一个（${ONLY_WRITER} 的行写入路径）：${hits.join('；')}`,
  )
})

test('op_log：表在、形状对（PK(device_id, seq) 是幂等的来源）', () => {
  const sql = readFileSync(join(ROOT, 'electron/library/sqlite.ts'), 'utf8')
  assert.match(sql, /create table if not exists \$\{DB_TABLES\.opLog\}/, '表要建好：形状定下来是「现在就能定」的全部理由')
  assert.match(sql, /primary key \(device_id, seq\)/, 'PK(device_id, seq) 是幂等的来源')
  assert.match(sql, /op_json text not null/, '整条 op 存 JSON（不拆列：拆列等于把 op 形状再钉一次）')
})

test('op_log：变更流与行写入**同一个事务**（分开写会重号或跳号）', () => {
  const sql = readFileSync(join(ROOT, 'electron/library/sqlite.ts'), 'utf8')
  // `applyRowWrites` 的 inTransaction 里既要写行、也要追加 op
  const fn = sql.slice(sql.indexOf('export function applyRowWrites'))
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3)
  assert.match(body, /inTransaction\(db, \(\) => \{/, '行写入要在一个事务里')
  assert.match(body, /appendLocalOpsInner\(/, '变更流要在**同一个**事务里追加（不是嵌套开事务）')
  assert.ok(
    body.indexOf('inTransaction') < body.indexOf('appendLocalOpsInner'),
    '追加必须在事务内（顺序写反就是「事务外写日志」）',
  )
})
