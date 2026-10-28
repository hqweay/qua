/**
 * `op_log` 的**写入时机**：现在还不许接生产写入。
 *
 * 判据只有一条，但它是数据完整性里最贵的一条：
 *
 * > **半截历史比没有历史更糟。**
 *
 * 现在表已建好、形状已定（前兄弟 id），而且**正文改动已经产出 op**（`tx.patch` 报
 * `block.upsert{content}`）。但还有一类写路径**不产 op**：整份替换——
 * 撤销/重做（`BlockStore.restore`）、换库（`reset`）、冷启动物化今日与空天首子块
 * （发生在事务之外，`persist` 用 `ensure` 补写）。它们让「库变成了另一份」，
 * 而 append-only 日志里只会留下一个**空洞**，与「那段时间什么都没发生」无法区分。
 *
 * ⇒ 什么时候可以接：**所有让库变化的路径都产 op**（整份替换也表达成 op，或日志另有一类
 * 「快照/重置」记录）。在那之前，`op_log` 只承载「形状已定」这一件事。
 *
 * ⚠️ 这条是**负向断言**：它拦的是「有人顺手把 op 写进去」。反证方式：
 * 在 `electron/library/windows.ts` 的 save handler 里加一行 `appendLocalOps(...)`，本条即红。
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

test('op_log：生产路径上**没有**写入者（半截历史比没有历史更糟）', () => {
  const hits: string[] = []
  for (const [file, body] of productionSources()) {
    /**
     * 只查**调用**，不查定义：`electron/library/sqlite.ts` 里那两个函数是给测试用的
     * 实现（表已建、形状已定），它们本身不是「写入路径」。
     */
    if (file === 'electron/library/sqlite.ts') continue
    for (const name of ['appendLocalOps', 'appendOp']) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(body)) hits.push(`${file} 调用了 ${name}`)
    }
    // 直接写表的也算（绕过函数更该拦）
    if (/insert\s+(or\s+ignore\s+)?into\s+op_log/i.test(body)) hits.push(`${file} 直接写 op_log 表`)
  }
  assert.deepEqual(
    hits,
    [],
    `op_log 还不许接生产写入（正文改动尚未产出 op ⇒ 现在写就是半截历史）：${hits.join('；')}`,
  )
})

test('op_log：表在、形状对（前兄弟 id 的 op 才能落进去）', () => {
  const sql = readFileSync(join(ROOT, 'electron/library/sqlite.ts'), 'utf8')
  assert.match(sql, /create table if not exists \$\{DB_TABLES\.opLog\}/, '表要建好：形状定下来是「现在就能定」的全部理由')
  assert.match(sql, /primary key \(device_id, seq\)/, 'PK(device_id, seq) 是幂等的来源')
  assert.match(sql, /op_json text not null/, '整条 op 存 JSON（不拆列：拆列等于把 op 形状再钉一次）')
})
