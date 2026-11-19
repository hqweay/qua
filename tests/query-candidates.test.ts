/**
 * **候选计划的三路等式**（SQL 候选 ＋ matcher ⇄ 纯函数全量求值）。
 *
 * 判据：候选是**超集**（⊇ 真命中），matcher 仍是判定的唯一来源——
 * 所以「候选装载后的求值结果」必须与「整库求值」逐条相等。
 * 哪一种条件少给一行（候选漏了）、多判一行（matcher 环境缺块），这条等式都会红。
 *
 * 覆盖的形状：role／tag（含并集语义）／is／ref（指名与不限目标）／prop（系统槽与
 * 定义槽）／up／down／near／today／text（含跨 run 拼接）／children／not／all／any／
 * `$self`（有宿主与无宿主）。
 *
 * 每条形状在**两种数据源**上各跑一遍（派生不可信 / 可信）：可见性与 `{ref}` 的取数在这两种
 * 模式下不同源，只测一种会漏掉另一半——旧夹具只有行内引用，就漏掉了「属性指向／嵌入」的候选。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, readContentRows, type RowWrite } from '../electron/library/sqlite.ts'
import { readCandidatePage, readBlockTreeRows, readIdentityRows } from '../electron/library/reads.ts'
import { rowsToWorkspace } from '../src/core/storage/db-rows.ts'
import { rebuildDerivedWrites } from '../src/core/storage/derived-rows.ts'
import { candidateBuildOf } from '../src/core/storage/query-candidates.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset } from '../src/core/storage/workset.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { QuerySpec, QueryContext, Block } from '../src/core/index.ts'

const TODAY = '2026-11-19'

function block(id: string, parent: string | null, left: string | null, extra: Record<string, string | number | null> = {}): RowWrite {
  return { table: 'Block', op: 'upsert', key: { id }, values: { content: '[]', created: 1, modified: 1, parent, left, ...extra } }
}
const prop = (b: string, name: string, pos: number, value: unknown, multi = 0): RowWrite => ({
  table: 'BlockProperty',
  op: 'upsert',
  key: { block: b, name, pos },
  values: { multi, value: JSON.stringify(value) },
})
const alias = (name: string, b: string, pos = 0): RowWrite => ({
  table: 'BlockAlias',
  op: 'upsert',
  key: { name },
  values: { block: b, pos },
})
const list = (b: string, name: 'page' | 'tag'): RowWrite => ({ table: 'BlockList', op: 'upsert', key: { block: b, list: name } })

/** 正文 JSON：文本 run 与引用 run（列出的形状是 run 编码的最小面） */
const runs = (...rs: (string | { to: string; flavor?: string })[]): string =>
  JSON.stringify(
    rs.map((r) =>
      typeof r === 'string'
        ? { t: 'text', v: r }
        : { t: 'ref', to: r.to, ...(r.flavor ? { flavor: r.flavor } : {}), id: `run-${Math.random().toString(36).slice(2, 8)}` },
    ),
  )

/**
 * 库形状（覆盖计划器的每一条 SQL）：
 *
 *   TAG_A（标签，成员 a1/a2）── TAG_B（A 的子标签，成员 b1）
 *   PAGE_DAY（_date=今天）── d1（引用 PAGE_X、带 _status）── d2
 *   PAGE_X（页）── x1（引用 TAG_A 的行内标签、加粗文本）
 *   PAGE_Y（页，空正文）── y1（有子级）
 *   J Yesterday（_date=昨天）── j1（正文跨 run：「黑」＋「体」两个 run）
 *   gone（软删，带 _tags）── g1
 *   DEF（字段定义 text；status 由 d1 的 _tags 声明）
 */
function seed(): RowWrite[] {
  const rows: RowWrite[] = [
    block('TAG_A', null, null),
    block('TAG_B', 'TAG_A', null),
    block('PAGE_DAY', null, 'TAG_A', { date: TODAY }),
    block('PAGE_X', null, 'PAGE_DAY'),
    block('PAGE_Y', null, 'PAGE_X'),
    block('J_YESTERDAY', null, 'PAGE_Y', { date: '2026-11-18' }),
    block('a1', null, 'J_YESTERDAY'),
    block('a2', null, 'a1'),
    block('b1', null, 'a2'),
    block('d1', 'PAGE_DAY', null),
    block('d2', 'PAGE_DAY', 'd1'),
    block('x1', 'PAGE_X', null),
    block('y1', 'PAGE_Y', null),
    block('y1c', 'y1', null),
    block('j1', 'J_YESTERDAY', null),
    block('gone', null, null, { deleted: 7 }),
    block('g1', 'gone', null),
    block('DEF', null, null, { kind: 'text' }),
    alias('标签A', 'TAG_A'),
    alias('标签B', 'TAG_B'),
    alias('X页', 'PAGE_X'),
    alias('Y页', 'PAGE_Y'),
    alias('定义', 'DEF'),
    list('TAG_A', 'tag'),
    list('TAG_B', 'tag'),
    list('PAGE_X', 'page'),
    list('PAGE_Y', 'page'),
    // 成员：a1/a2 ∈ A；b1 ∈ B（B 是 A 的子标签 ⇒ A 的并集候选要含 b1）
    prop('a1', '_tags', 0, 'TAG_A', 1),
    prop('a2', '_tags', 0, 'TAG_A', 1),
    prop('b1', '_tags', 0, 'TAG_B', 1),
    prop('gone', '_tags', 0, 'TAG_A', 1),
    // d1 引用 PAGE_X（行内）＋ 带 status 值；x1 行内标签指向 TAG_A ＋ 加粗
    // j1 正文跨 run：「黑」「体」两个文本 run —— 单 run instr 找不到「黑体」
    { table: 'Block', op: 'update', key: { id: 'd1' }, values: { content: runs('一天的开始 ', { to: 'PAGE_X' }) } },
    { table: 'Block', op: 'update', key: { id: 'x1' }, values: { content: runs({ to: 'TAG_A', flavor: '#' }, { to: 'PAGE_Y' }) } },
    { table: 'Block', op: 'update', key: { id: 'j1' }, values: { content: runs('黑', '体') } },
    { table: 'Block', op: 'update', key: { id: 'y1' }, values: { content: runs('有子级的一行') } },
    prop('d1', 'DEF', 0, '状态值'),
    /**
     * 引用的**另外两种来源**（夹具原先只有行内 run，抓不到这一条）：`{ref: X}` 的 matcher
     * 认 inline／property／embed 三类边，候选若只扫正文，属性指向与嵌入会**静默丢行**。
     * `REF_DEF` 是 kind:'ref' 的定义块。
     */
    block('REF_DEF', null, null, { kind: 'ref' }),
    block('d3', 'PAGE_DAY', 'd2'),
    block('d4', 'PAGE_DAY', 'd3'),
    prop('d3', 'REF_DEF', 0, 'PAGE_X'),
    prop('d4', '_embed', 0, { block: 'PAGE_X' }),
    prop('TAG_A', '_fieldDefs', 0, 'DEF', 1),
    prop('x1', '_color', 0, 'red'),
  ]
  return rows
}

function withDb(fn: (db: NonNullable<ReturnType<typeof openLibraryDb>['db']>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'qua-candidates-'))
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

/** 整库求值的基线（纯函数路径） */
function baseline(db: NonNullable<ReturnType<typeof openLibraryDb>['db']>): { forest: Block[]; kb: MemoryKb } {
  const ws = rowsToWorkspace(readContentRows(db))
  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)
  return { forest: ws.blocks, kb }
}

/** 工作集求值：计划 → 候选 id → 树装载 → 门面求值 */
function worksetEval(
  db: NonNullable<ReturnType<typeof openLibraryDb>['db']>,
  spec: QuerySpec,
  forest: Block[],
  opts: { selfId?: string; today?: string } = {},
): { hits: string[]; candidates: string[] } {
  const ctx: QueryContext = {
    ...(opts.selfId ? { selfId: opts.selfId } : {}),
    ...(opts.today ? { today: opts.today } : {}),
  }
  const host = opts.selfId ? forest.find((b) => b.id === opts.selfId) : undefined
  const build = candidateBuildOf(spec, host, forest, ctx)
  const store = new BlockStore([])
  const ws = new Workset(store)
  /**
   * **全局身份块先装**（产品里这一步在启动的 identity 读面）：matcher 判 `{ref}` 要看
   * 属性定义块的 kind（`propKinds` 决定属性值是算一条引用边还是不）。少了定义块，
   * 「属性指向」的命中在**求值**这一侧就丢了——那不是候选的错，但会让等式红在与候选无关的地方。
   */
  ws.loadBlocks(readIdentityRows(db), true)
  // 条件点名的块先装（标签/定义）
  if (build.loadIds.length > 0) ws.loadBlocks(readBlockTreeRows(db, build.loadIds, false))
  const candidates = allCandidateIds(db, build.plan, 3)
  if (candidates.length > 0) ws.loadBlocks(readBlockTreeRows(db, candidates, build.children))
  // matcher 环境的第二跳：候选身上的标签/定义/引用目标
  const loaded = candidates.map((id) => store.find(id)).filter((b): b is Block => b !== undefined)
  const closureIds = candidateClosure(loaded, forest, build.loadIds)
  if (closureIds.length > 0) ws.loadBlocks(readBlockTreeRows(db, closureIds, false))
  const kb = new MemoryKb(store)
  const hits = kb
    .query(spec, { ...(opts.selfId ? { selfId: opts.selfId } : {}), ...(opts.today ? { today: opts.today } : {}) })
    .map((h) => h.blockId)
  return { hits, candidates }
}

/** 与 main.ts 的第二跳同一判据：候选块身上的引用/标签/属性值指向的块 */
function candidateClosure(loaded: readonly Block[], forest: readonly Block[], extra: readonly string[]): string[] {
  const out = new Set<string>(extra)
  for (const b of loaded) {
    for (const r of b.content) if (r.t === 'ref' && r.to) out.add(r.to)
    if (b.props) {
      for (const v of Object.values(b.props)) collectIds(v, out)
    }
  }
  const known = new Set<string>()
  const walk = (blocks: readonly Block[]): void => {
    for (const b of blocks) {
      known.add(b.id)
      walk(b.children)
    }
  }
  walk(forest)
  return [...out].filter((id) => !known.has(id))
}

function collectIds(v: unknown, out: Set<string>): void {
  if (typeof v === 'string') {
    if (/^[0-9a-f]{32}$/.test(v)) out.add(v)
    // 测试夹具用短 id：名字形状的值也收（_tags/归属边都是字符串值）
    else if (/^(TAG|PAGE|J|DEF)_?[A-Z0-9_]*$/.test(v)) out.add(v)
    return
  }
  if (Array.isArray(v)) for (const x of v) collectIds(x, out)
  if (v !== null && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) collectIds(x, out)
}

/** 一页页取到到底（页大小 3：既取全，又把分页本身跑一遍） */
function allCandidateIds(
  db: NonNullable<ReturnType<typeof openLibraryDb>['db']>,
  plan: Parameters<typeof readCandidatePage>[1],
  pageSize: number,
): string[] {
  const out: string[] = []
  let after: string | null = null
  for (let i = 0; i < 10000; i++) {
    const page = readCandidatePage(db, plan, { after, limit: pageSize })
    out.push(...page.ids)
    after = page.next
    if (after === null) break
  }
  return out
}

const hitSet = (kb: MemoryKb, spec: QuerySpec, opts: { selfId?: string; today?: string }): Set<string> =>
  new Set(
    kb
      .query(spec, { ...(opts.selfId ? { selfId: opts.selfId } : {}), ...(opts.today ? { today: opts.today } : {}) })
      .map((h) => h.blockId),
  )

const CASES: { name: string; spec: QuerySpec; opts?: { selfId?: string; today?: string } }[] = [
  { name: 'role: page', spec: { where: { role: 'page' } } },
  { name: 'role: journal', spec: { where: { role: 'journal' } } },
  { name: 'role: tag', spec: { where: { role: 'tag' } } },
  { name: 'tag 成员（并集含子标签）', spec: { where: { tag: 'TAG_A' } } },
  { name: 'tag 子标签展开', spec: { where: { tag: { id: 'TAG_A', desc: true } } } },
  { name: 'is', spec: { where: { is: 'PAGE_X' } } },
  { name: 'ref 指名', spec: { where: { ref: 'PAGE_X' } } },
  { name: 'ref 不限目标', spec: { where: { ref: {} } } },
  { name: 'prop 系统槽 _date', spec: { where: { prop: { id: '_date', exists: true } } } },
  { name: 'prop 定义槽 eq', spec: { where: { prop: { id: 'DEF', eq: '状态值' } } } },
  { name: 'prop exists:false', spec: { where: { prop: { id: 'DEF', exists: false } } } },
  { name: 'up 日记天', spec: { where: { up: { role: 'journal' } } } },
  { name: 'up 指名块之下', spec: { where: { up: { is: 'PAGE_DAY' } } } },
  { name: 'down 引用源', spec: { where: { down: { ref: 'PAGE_X' } } } },
  { name: 'near', spec: { where: { near: { role: 'journal' } } } },
  { name: 'today 偏移', spec: { where: { today: { offset: 0 } }, sort: [] }, opts: { today: TODAY } },
  { name: 'text 单 run', spec: { where: { text: '有子级' } } },
  { name: 'text 跨 run 拼接', spec: { where: { text: '黑体' } } },
  { name: 'text 有正文', spec: { where: { text: { nonempty: true } } } },
  { name: 'children', spec: { where: { children: true } } },
  { name: 'not', spec: { where: { not: { role: 'journal' } } } },
  { name: 'all: tag ∩ prop', spec: { where: { all: [{ tag: 'TAG_A' }, { prop: { id: 'DEF', exists: true } }] } } },
  { name: 'any: journal ∨ page', spec: { where: { any: [{ role: 'journal' }, { role: 'page' }] } } },
  {
    name: '$self 之下（有宿主）',
    spec: { where: { up: { is: '$self' } } },
    opts: { selfId: 'PAGE_DAY' },
  },
]

test('候选计划 ⊇ 真命中，且候选装载后求值 == 整库求值（派生不可信 / 可信 两种源）', () => {
  withDb((db) => {
    const { forest, kb } = baseline(db)
    /**
     * 两种源都要过同一条等式：
     *   · 不可信（`derived_state` 不是 ready）：可见性用根上的 `deleted` 位、`{ref}` 退回
     *     `visible` —— 宽，但必须仍是**超集**；
     *   · 可信（重建过派生两表）：可见性用物化的 `hidden`、`{ref}` 读 `BlockRelation`。
     * 只测一种就会漏掉另一半（旧夹具正是这样漏掉了 property／embed 引用）。
     */
    for (const derived of [false, true]) {
      if (derived) applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
      for (const c of CASES) {
        const expected = hitSet(kb, c.spec, c.opts ?? {})
        const { hits, candidates } = worksetEval(db, c.spec, forest, c.opts ?? {})
        const got = new Set(hits)
        assert.deepEqual(
          [...got].sort(),
          [...expected].sort(),
          `「${c.name}」（派生${derived ? '可信' : '不可信'}）的候选装载求值与整库求值不一致`,
        )
        for (const id of expected) {
          assert.ok(candidates.includes(id), `「${c.name}」（派生${derived ? '可信' : '不可信'}）的候选漏了真命中 ${id}`)
        }
        // 可信时软删页的后代不该耗尽候选面（`g1` 在 `gone` 之下）
        if (derived && c.spec.where && 'role' in c.spec.where && c.spec.where.role === 'page') {
          assert.ok(!candidates.includes('g1'), '可信时软删子树的后代不该进候选')
        }
      }
    }
  })
})

test('$self 无宿主 ⇒ 空结果（不退回全库）', () => {
  withDb((db) => {
    const { forest } = baseline(db)
    const { hits, candidates } = worksetEval(db, { where: { up: { is: '$self' } } }, forest, {})
    assert.equal(hits.length, 0)
    assert.equal(candidates.length, 0)
  })
})

test('候选分页：页大小 1／2／3／400 取到的序列与一次取全相同（keyset 不重不漏、保序）', () => {
  withDb((db) => {
    applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
    const { forest } = baseline(db)
    for (const c of CASES) {
      const host = c.opts?.selfId ? forest.find((b) => b.id === c.opts!.selfId) : undefined
      const build = candidateBuildOf(c.spec, host, forest, { ...(c.opts ?? {}) })
      const full = allCandidateIds(db, build.plan, 4000)
      for (const size of [1, 2, 3, 400]) {
        assert.deepEqual(allCandidateIds(db, build.plan, size), full, `「${c.name}」页大小 ${size} 的候选序列必须与一次取全相同`)
      }
    }
  })
})
