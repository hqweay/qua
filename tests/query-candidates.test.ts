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
import { normalizeAlias } from '../src/core/identity/address-key.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLibraryDb, applyRowWrites, readContentRows, type RowWrite } from '../electron/library/sqlite.ts'
import { readCandidatePage, readBlockTreeRows, readIdentityRows } from '../electron/library/reads.ts'
import { rowsToWorkspace } from '../src/core/storage/db-rows.ts'
import { rebuildDerivedWrites } from '../src/core/storage/derived-rows.ts'
import { candidateBuildOf } from '../src/core/storage/query-candidates.ts'
import { candidatePlanSql, isCandidatePlan } from '../src/core/storage/library-reads.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset } from '../src/core/storage/workset.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { ROLE_KINDS, type RoleKind } from '../src/core/index.ts'
import { QUERYABLE_SYSTEM_PROPS } from '../src/core/props/props.ts'
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
  // 归一化键是写入契约的一部分：漏写在这里就该炸（`sqlOf` 有闸）
  values: { block: b, pos, norm: normalizeAlias(name) },
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

/** 原样 run 序列：格式（marks）与外链要逐键写，不走上面那个「文本/引用」简写 */
const raw = (...rs: Record<string, unknown>[]): string => JSON.stringify(rs)
const bold = (v: string): Record<string, unknown> => ({ t: 'text', v, marks: { bold: true } })
const ink = (v: string, slot = 'red'): Record<string, unknown> => ({ t: 'text', v, marks: { ink: slot } })
const link = (url: string, id: string): Record<string, unknown> => ({ t: 'link', id, v: '链接', url })

/**
 * 库形状（覆盖计划器的每一条 SQL）：
 *
 *   TAG_A（标签，成员 a1/a2）── TAG_B（A 的子标签，成员 b1）
 *   PAGE_DAY（_date=今天）── d1（引用 PAGE_X、带 _status）── d2
 *   PAGE_X（页）── x1（引用 TAG_A 的行内标签）
 *   PAGE_Y（页，空正文）── y1（有子级）
 *   J Yesterday（_date=昨天）── j1（正文跨 run：「黑」＋「体」两个 run）
 *   gone（软删，带 _tags）── g1
 *   DEF（字段定义 text；status 由 d1 的 _tags 声明）
 *   E_*（格式与外链：粗／红／同一 run 的粗红／两段分开的粗＋红／两个外链／空正文／软删子树）
 */
function seed(): RowWrite[] {
  const rows: RowWrite[] = [
    block('TAG_A', null, null),
    block('TAG_B', 'TAG_A', null),
    prop('TAG_B', '_belongsTo', 0, 'TAG_A', 1),
    block('TAG_D', null, 'J_YESTERDAY'),
    prop('TAG_D', '_belongsTo', 0, 'TAG_A', 1),
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
    /**
     * **块类型与类型声明的缺省夹具**：
     *   · `CODE1` 的 `_type` 升在 `Block.type` 列上（不在属性行）——候选若去
     *     `BlockProperty` 找就是空集；`CODE_PLAIN` 缺 `_lang`（缺省＝纯文本）；
     *   · `QUOTE_DEF` 是**缺键的引述**（缺省类型 `quote`），候选必须靠类型而不是
     *     `_callout` 行命中；`QUOTE_INFO` 才有 `_callout` 行。
     */
    block('CODE1', null, null, { type: 'core/code' }),
    prop('CODE1', '_lang', 0, 'ts'),
    block('CODE_PLAIN', null, null, { type: 'core/code' }),
    block('QUOTE_DEF', null, null, { type: 'core/quote' }),
    block('QUOTE_INFO', null, null, { type: 'core/quote' }),
    prop('QUOTE_INFO', '_callout', 0, 'info'),
    /**
     * 三种**派生身份**各一块（`{role}` 的七值里三格要它们在场）。
     * `BROKEN_Q` 是**合法状态**，不是坏数据：`_query` 的读侧刻意不判 corrupt
     * （旧条件读不出是设计的降级态）⇒ 列非空、但 props 里没有可读的 `where`。
     * 它就是「候选超集 ⊋ matcher」的活样本：`{role:'query'}` 不命中它，但 `query` 列非空。
     */
    block('Q_VIEW', null, null, { query: JSON.stringify({ where: { role: 'note' } }) }),
    block('BROKEN_Q', null, null, { query: JSON.stringify({ oops: 1 }) }),
    block('AUTO', null, null),
    prop('AUTO', '_automation', 0, { enabled: true, triggers: ['manual'], steps: [] }),
    /**
     * **只带死标签**：`_tags` 里是一个不存在的标签块 id。它是**合法状态**，不是坏数据——
     * 归属列表的形状只回答「是不是 id 列表」，悬空 id 明确被允许（删标签不摘引用）。
     * 它没有**活**标签 ⇒ matcher 对 `{_tags exists:true}` 不命中。
     */
    block('Z_DEADTAG', null, null),
    prop('Z_DEADTAG', '_tags', 0, 'TAG_GONE', 1),
    alias('标签A', 'TAG_A'),
    alias('标签B', 'TAG_B'),
    alias('X页', 'PAGE_X'),
    alias('Y页', 'PAGE_Y'),
    alias('定义', 'DEF'),
    list('TAG_A', 'tag'),
    list('TAG_B', 'tag'),
    list('TAG_C', 'tag'),
    list('TAG_D', 'tag'),
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
    { table: 'Block', op: 'update', key: { id: 'a1' }, values: { content: raw(bold('a1 是粗的')) } },
    { table: 'Block', op: 'update', key: { id: 'j1' }, values: { content: runs('黑', '体') } },
    { table: 'Block', op: 'update', key: { id: 'y1' }, values: { content: runs('有子级的一行') } },
    prop('d1', 'DEF', 0, '状态值'),
    /**
     * 引用的**另外两种来源**（夹具原先只有行内 run，抓不到这一条）：`{ref: X}` 的 matcher
     * 认 inline／property／embed 三类边，候选若只扫正文，属性指向与嵌入会**静默丢行**。
     * `REF_DEF` 是 kind:'ref' 的定义块。
     */
    block('TAG_C', 'TAG_B', null),
    block('c1', 'PAGE_Y', 'y1'),
    block('d1', 'PAGE_Y', 'c1'),
    prop('d1', '_tags', 0, 'TAG_D', 1),
    prop('c1', '_tags', 0, 'TAG_C', 1),
    block('REF_DEF', null, null, { kind: 'ref' }),
    block('d3', 'PAGE_DAY', 'd2'),
    block('d4', 'PAGE_DAY', 'd3'),
    prop('d3', 'REF_DEF', 0, 'PAGE_X'),
    prop('d4', '_embed', 0, { block: 'PAGE_X' }),
    prop('TAG_A', '_fieldDefs', 0, 'DEF', 1),
    prop('x1', '_color', 0, 'red'),
    /**
     * 格式与外链的夹具（`mark`／`link` 的候选是**行本地谓词**：逐 run 问同一组键值）。
     * 关键形状是 `E_SPLIT`：粗的 run 与红的 run 分开 ⇒ **不是**「粗红」，跨 run 凑轴会误配。
     * 软删子树各占一份（`E_GONE` 自己／`E_GONE_CHILD` 的子）：可信时都不可见，
     * 不可信时子块会成为候选（`deleted` 只在根上）——两种情况都必须 ⊇ 真命中。
     */
    block('E_BOLD', null, null),
    block('E_INK', null, null),
    block('E_BOTH', null, null),
    block('E_SPLIT', null, null),
    block('E_LINK1', null, null),
    block('E_LINK2', null, null),
    block('E_ASSET', null, null),
    block('E_GONE', null, null, { deleted: 9 }),
    block('E_GONE_CHILD', 'E_GONE', null),
    { table: 'Block', op: 'update', key: { id: 'E_BOLD' }, values: { content: raw(bold('粗')) } },
    { table: 'Block', op: 'update', key: { id: 'E_INK' }, values: { content: raw(ink('红')) } },
    { table: 'Block', op: 'update', key: { id: 'E_BOTH' }, values: { content: raw({ t: 'text', v: '又红又粗', marks: { bold: true, ink: 'red' } }) } },
    { table: 'Block', op: 'update', key: { id: 'E_SPLIT' }, values: { content: raw(bold('粗'), ink('红')) } },
    { table: 'Block', op: 'update', key: { id: 'E_LINK1' }, values: { content: raw({ t: 'text', v: '看' }, link('https://Example.com/Path', 'lk1')) } },
    { table: 'Block', op: 'update', key: { id: 'E_LINK2' }, values: { content: raw({ t: 'text', v: '另' }, link('https://other.example.org/', 'lk2')) } },
    { table: 'Block', op: 'update', key: { id: 'E_ASSET' }, values: { content: raw({ t: 'asset', id: 'as1', asset: 'deadbeef' }) } },
    { table: 'Block', op: 'update', key: { id: 'E_GONE' }, values: { content: raw(bold('删掉的粗')) } },
    { table: 'Block', op: 'update', key: { id: 'E_GONE_CHILD' }, values: { content: raw(ink('删掉的子')) } },
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
  { name: 'role: schema', spec: { where: { role: 'schema' } } },
  { name: 'role: query', spec: { where: { role: 'query' } } },
  { name: 'role: automation', spec: { where: { role: 'automation' } } },
  { name: 'not: role query（列非空但读不出条件的块必须留在结果里）', spec: { where: { not: { role: 'query' } } } },
  { name: 'tag 成员（并集含子标签）', spec: { where: { tag: 'TAG_A' } } },
  { name: 'tag 子标签展开', spec: { where: { tag: { id: 'TAG_A', desc: true } } } },
  { name: 'is', spec: { where: { is: 'PAGE_X' } } },
  { name: 'ref 指名', spec: { where: { ref: 'PAGE_X' } } },
  { name: 'ref 不限目标', spec: { where: { ref: {} } } },
  { name: 'prop 系统槽 _date', spec: { where: { prop: { id: '_date', exists: true } } } },
  { name: 'prop 系统槽 _kind', spec: { where: { prop: { id: '_kind', eq: 'text' } } } },
  { name: 'prop 系统槽 _aliases', spec: { where: { prop: { id: '_aliases', eq: 'X页' } } } },
  { name: 'prop 系统槽 _tags', spec: { where: { prop: { id: '_tags', eq: 'TAG_A' } } } },
  { name: 'prop 系统槽 _belongsTo', spec: { where: { prop: { id: '_belongsTo', eq: 'TAG_A' } } } },
  { name: 'prop 引擎槽 core/created', spec: { where: { prop: { id: 'core/created', eq: 1 } } } },
  { name: 'prop 引擎槽 core/modified', spec: { where: { prop: { id: 'core/modified', eq: 1 } } } },
  { name: 'prop 定义槽 eq', spec: { where: { prop: { id: 'DEF', eq: '状态值' } } } },
  { name: 'prop exists:false', spec: { where: { prop: { id: 'DEF', exists: false } } } },
  /**
   * 升列／缺省值／`empty` 三条候选错配的钉子：
   *   · `_type` 在 `Block.type` 列上；
   *   · `_callout` 缺键＝缺省类型（不靠属性行）；
   *   · `empty:true` 命中「没有这一栏」的块（行存在性的反面）。
   */
  { name: 'prop _type eq 缺省类型（缺键＝默认）', spec: { where: { prop: { id: '_type', eq: 'outline' } } } },
  { name: 'prop _type eq 代码块', spec: { where: { prop: { id: '_type', eq: 'core/code' } } } },
  { name: 'prop _type neq 缺省类型', spec: { where: { prop: { id: '_type', neq: 'outline' } } } },
  { name: 'prop _type exists:true', spec: { where: { prop: { id: '_type', exists: true } } } },
  { name: 'prop _type exists:false（恒不命中）', spec: { where: { prop: { id: '_type', exists: false } } } },
  { name: 'prop _type empty:true', spec: { where: { prop: { id: '_type', empty: true } } } },
  { name: 'prop _callout eq 缺省类型（缺键＝quote）', spec: { where: { prop: { id: '_callout', eq: 'quote' } } } },
  { name: 'prop _callout eq 非缺省', spec: { where: { prop: { id: '_callout', eq: 'info' } } } },
  { name: 'prop _callout neq 非缺省', spec: { where: { prop: { id: '_callout', neq: 'info' } } } },
  { name: 'prop _callout exists:true', spec: { where: { prop: { id: '_callout', exists: true } } } },
  { name: 'prop _callout empty:true', spec: { where: { prop: { id: '_callout', empty: true } } } },
  { name: 'prop _callout empty:false', spec: { where: { prop: { id: '_callout', empty: false } } } },
  { name: 'prop _lang eq 规范名（别名归一）', spec: { where: { prop: { id: '_lang', eq: 'typescript' } } } },
  { name: 'prop _lang eq 缺省（缺键＝plain）', spec: { where: { prop: { id: '_lang', eq: 'plain' } } } },
  { name: 'prop _lang exists:true', spec: { where: { prop: { id: '_lang', exists: true } } } },
  { name: 'prop _lang exists:false', spec: { where: { prop: { id: '_lang', exists: false } } } },
  { name: 'prop _lang empty:true', spec: { where: { prop: { id: '_lang', empty: true } } } },
  { name: 'prop _lang empty:false', spec: { where: { prop: { id: '_lang', empty: false } } } },
  { name: 'not: prop _type eq 代码块（精确子集）', spec: { where: { not: { prop: { id: '_type', eq: 'core/code' } } } } },
  { name: 'up 日记天', spec: { where: { up: { role: 'journal' } } } },
  { name: 'up 指名块之下', spec: { where: { up: { is: 'PAGE_DAY' } } } },
  { name: 'down 引用源', spec: { where: { down: { ref: 'PAGE_X' } } } },
  { name: 'near', spec: { where: { near: { role: 'journal' } } } },
  { name: 'today 偏移', spec: { where: { today: { offset: 0 } }, sort: [] }, opts: { today: TODAY } },
  { name: 'text 单 run', spec: { where: { text: '有子级' } } },
  { name: 'text 跨 run 拼接', spec: { where: { text: '黑体' } } },
  { name: 'text 有正文', spec: { where: { text: { nonempty: true } } } },
  { name: 'children', spec: { where: { children: true } } },
  { name: 'mark: 粗', spec: { where: { mark: { bold: true } } } },
  { name: 'mark: 红字', spec: { where: { mark: { ink: 'red' } } } },
  { name: 'mark: 同一 run 的粗＋红', spec: { where: { mark: { bold: true, ink: 'red' } } } },
  { name: 'mark: 有任何格式', spec: { where: { mark: {} } } },
  { name: 'link: 任意外链', spec: { where: { link: {} } } },
  { name: 'link: url contains（大小写不敏）', spec: { where: { link: { url: 'example.COM/p' } } } },
  { name: 'not: mark 粗（精确子集）', spec: { where: { not: { mark: { bold: true } } } } },
  { name: 'not: link 任意（精确子集）', spec: { where: { not: { link: {} } } } },
  { name: 'not: link 带 url（不精确 ⇒ 可见集）', spec: { where: { not: { link: { url: 'example.com' } } } } },
  // `visible` 既是「判定域」又是「收窄不了的落点」：否定它**不能**当成「否定全域」
  { name: 'not: prop exists:false（收窄不了 ⇒ 候选是全可见集）', spec: { where: { not: { prop: { id: 'DEF', exists: false } } } } },
  { name: 'not', spec: { where: { not: { role: 'journal' } } } },
  { name: 'not 精确子集：tag', spec: { where: { not: { tag: 'TAG_A' } } } },
  { name: 'not 精确子集：is', spec: { where: { not: { is: 'PAGE_X' } } } },
  { name: 'not 精确子集：role page', spec: { where: { not: { role: 'page' } } } },
  { name: 'not 不精确子集：prop 值（该退化成可见集）', spec: { where: { not: { prop: { id: 'DEF', eq: '状态值' } } } } },
  { name: 'all: tag ∩ not(is)', spec: { where: { all: [{ tag: 'TAG_A' }, { not: { is: 'a1' } }] } } },
  { name: 'not 包 up', spec: { where: { not: { up: { is: 'PAGE_DAY' } } } } },
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

/**
 * **候选只能读「与 matcher 同投影」能证明的存储事实**。
 *
 * 这一条不靠手挑的求值用例，而是直接看**计划形状**：`_type` 必须走列、`_callout`
 * 必须并上引述类型、`empty:true` 必须退全域。三处任一落回 `{k:'prop'}`，
 * 桌面分页路径就会静默漏行（web 整库路径看不出来）。
 */
test('_type / _callout 的候选走列与类型，不再下推成属性行', () => {
  withDb((db) => {
    applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
    const { forest } = baseline(db)
    const plan = (spec: QuerySpec) => candidateBuildOf(spec, undefined, forest, {}).plan

    assert.deepEqual(plan({ where: { prop: { id: '_type', eq: 'core/code' } } }), {
      k: 'type',
      type: 'core/code',
      mode: 'eq',
    })
    assert.deepEqual(plan({ where: { prop: { id: '_type', eq: 'outline' } } }), {
      k: 'type',
      type: 'outline',
      mode: 'eq',
      includeDefault: true,
    })
    assert.deepEqual(plan({ where: { prop: { id: '_type', neq: 'outline' } } }), {
      k: 'type',
      type: 'outline',
      mode: 'neqDefault',
    })
    assert.equal(plan({ where: { prop: { id: '_type', exists: true } } }).k, 'visible')
    assert.equal(plan({ where: { prop: { id: '_type', exists: false } } }).k, 'none')
    assert.equal(plan({ where: { prop: { id: '_callout', empty: true } } }).k, 'visible')
    assert.equal(plan({ where: { prop: { id: '_callout', exists: false } } }).k, 'visible')
    assert.equal(plan({ where: { prop: { id: '_callout', exists: true } } }).k, 'any')

    const typeCands = allCandidateIds(db, plan({ where: { prop: { id: '_type', eq: 'core/code' } } }), 4000)
    assert.ok(typeCands.includes('CODE1'), '块类型在列上，候选必须含代码块')
    assert.ok(!typeCands.includes('QUOTE_DEF'), '非代码块不该进候选')

    const outline = allCandidateIds(db, plan({ where: { prop: { id: '_type', eq: 'outline' } } }), 4000)
    assert.ok(outline.includes('PAGE_X'), '缺 _type 键＝默认类型，候选必须含')
    assert.ok(!outline.includes('CODE1'))

    const callout = allCandidateIds(db, plan({ where: { prop: { id: '_callout', eq: 'quote' } } }), 4000)
    assert.ok(callout.includes('QUOTE_DEF'), '缺 _callout 键的引述（缺省 quote）必须在候选里')
    assert.ok(callout.includes('QUOTE_INFO'), '候选是超集：带 _callout 行的引述也可以在里面')

    assert.equal(plan({ where: { prop: { id: '_lang', exists: true } } }).k, 'any')
    const langPlain = allCandidateIds(db, plan({ where: { prop: { id: '_lang', eq: 'plain' } } }), 4000)
    assert.ok(langPlain.includes('CODE_PLAIN'), '缺 _lang 的代码块（缺省 plain）必须在候选里')
    const langTs = allCandidateIds(db, plan({ where: { prop: { id: '_lang', eq: 'typescript' } } }), 4000)
    assert.ok(langTs.includes('CODE1'), '别名 ts 归一后必须命中 typescript 的候选')
  })
})

/** 收集条件树里点名的属性 id（覆盖闸用；不判断方向/组合的语义） */
function collectPropIds(node: QuerySpec['where'], out: Set<string>): void {
  if ('all' in node) {
    for (const n of node.all) collectPropIds(n, out)
    return
  }
  if ('any' in node) {
    for (const n of node.any) collectPropIds(n, out)
    return
  }
  if ('not' in node) return collectPropIds(node.not, out)
  if ('up' in node) return collectPropIds(node.up, out)
  if ('down' in node) return collectPropIds(node.down, out)
  if ('near' in node) return collectPropIds(node.near, out)
  if ('prop' in node) out.add(node.prop.id)
}

/**
 * **加一个可查系统槽，必须补一条候选用例**。
 *
 * 候选的正确性靠「候选 ⊇ 命中」的等式，而等式只跑 `CASES` 里有的形状——
 * 新字段没有用例时，桌面分页路径漏行不会红（`_type`/`_callout` 就这样漏过一次）。
 * 这条把「白名单加了、覆盖没加」变成红。
 */
test('每个可查系统槽都至少有一条候选用例', () => {
  const ids = new Set<string>()
  for (const c of CASES) collectPropIds(c.spec.where, ids)
  for (const id of QUERYABLE_SYSTEM_PROPS) {
    assert.ok(ids.has(id), `系统槽 ${id} 没有候选用例（加字段必须补一条，否则漏行不报红）`)
  }
})

test('候选计划能过 IPC 验形（builder 与 isCandidatePlan 同源）', () => {
  withDb((db) => {
    const { forest } = baseline(db)
    for (const c of CASES) {
      const host = c.opts?.selfId ? forest.find((b) => b.id === c.opts!.selfId) : undefined
      const build = candidateBuildOf(c.spec, host, forest, { ...(c.opts ?? {}) })
      assert.ok(
        isCandidatePlan(build.plan),
        `「${c.name}」的计划过不了 IPC 验形：${JSON.stringify(build.plan)}（桌面会报 bad-args）`,
      )
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

test('候选收窄：否定减去精确子集；直接标签成员不再带上子标签成员', () => {
  withDb((db) => {
    applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
    const { forest } = baseline(db)
    const plan = (spec: Parameters<typeof candidateBuildOf>[0]) => candidateBuildOf(spec, undefined, forest, {}).plan

    const visible = allCandidateIds(db, plan({ where: { not: { is: 'NOPE' } } }), 4000)
    // `not {tag}` 的候选 = 可见块 − 该标签的直接成员（a1／a2 在场、其余照旧）
    const notTag = allCandidateIds(db, plan({ where: { not: { tag: 'TAG_A' } } }), 4000)
    assert.ok(notTag.length < visible.length, '否定必须真的减掉东西')
    for (const id of ['a1', 'a2']) assert.ok(!notTag.includes(id), `${id} 是 TAG_A 的直接成员，必须被减掉`)
    assert.ok(notTag.includes('b1'), 'b1 只是子标签成员，不该被减掉（否定保留它）')

    // 直接成员：不再带子标签成员（旧计划无条件展开 ⇒ 会多给 b1）
    const direct = allCandidateIds(db, plan({ where: { tag: 'TAG_A' } }), 4000)
    assert.ok(!direct.includes('b1'), '不带 desc 的标签条件只认直接成员')
    const desc = allCandidateIds(db, plan({ where: { tag: { id: 'TAG_A', desc: true } } }), 4000)
    assert.ok(desc.includes('b1'), 'desc:true 才连子标签成员')

    // 不精确的子计划：否定必须退化成可见集（宽但真），不能拿会漏行的差集当候选
    const notProp = allCandidateIds(db, plan({ where: { not: { prop: { id: 'DEF', eq: '状态值' } } } }), 4000)
    assert.ok(notProp.length >= visible.length, '不精确的否定不能收窄（至少是可见集）')

    // `mark` 是精确集（逐 run 同解）⇒ 否定可以真的减
    const notMark = allCandidateIds(db, plan({ where: { not: { mark: { bold: true } } } }), 4000)
    for (const id of ['E_BOLD', 'E_BOTH', 'E_SPLIT']) assert.ok(!notMark.includes(id), `${id} 带粗体，必须被减掉`)
    assert.ok(notMark.includes('E_INK'), '只带红字的块不是「粗」，否定要保留它')
    // `{link:{}}` 同解 ⇒ 精确；带 url 时 SQL 不比 url ⇒ 只能当超集
    const notLink = allCandidateIds(db, plan({ where: { not: { link: {} } } }), 4000)
    for (const id of ['E_LINK1', 'E_LINK2']) assert.ok(!notLink.includes(id), `${id} 有外链，必须被减掉`)
    const notLinkUrl = allCandidateIds(db, plan({ where: { not: { link: { url: 'example.com' } } } }), 4000)
    assert.equal(notLinkUrl.length, visible.length, '带 url 的 link 不精确 ⇒ 否定退化成可见集')

    /**
     * **宽度不能传染**：`visible` 是交集的单位元、并集的吸收元。
     * - `all` 里丢掉它（否则分页每页物化全库，窄条件被拖成全库）；
     * - `any` 里保留它就是全域；
     * - 否定它**不是**空集（它的计划是全域，但那个节点的命中不是全域）。
     */
    const wide = { prop: { id: 'DEF', exists: false } } as const
    assert.equal(plan({ where: { all: [wide, { tag: 'TAG_A' }] } }).k, 'tags')
    assert.equal(plan({ where: { any: [wide, { tag: 'TAG_A' }] } }).k, 'visible')
    assert.equal(plan({ where: { not: wide } }).k, 'notIn')
    assert.ok(allCandidateIds(db, plan({ where: { not: wide } }), 4000).length > 0, '否定「收窄不了」的形状仍有候选')
  })
})

test('精确性可证：`{tag desc}` 的展开支与 `{down}`（去掉种子）在可信模式下候选 == 命中', () => {
  withDb((db) => {
    applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
    const { forest, kb } = baseline(db)
    const cands = (spec: Parameters<typeof candidateBuildOf>[0]): Set<string> =>
      new Set(allCandidateIds(db, candidateBuildOf(spec, undefined, forest, {}).plan, 4000))
    const hits = (spec: Parameters<typeof candidateBuildOf>[0]): Set<string> => new Set([...hitSet(kb, spec, {})])

    /**
     * `{tag: desc}`：候选要等于「该标签 + 全部下级标签的成员」。只做 ≥3 层的标签树，
     * 才能证明 SQL 的递归展开与 matcher 的 `membersOf` 同解（否则「精确」只是猜的）。
     */
    for (const spec of [
      { where: { tag: { id: 'TAG_A', desc: true } } },
      { where: { tag: { id: 'TAG_B', desc: true } } },
      { where: { tag: 'TAG_A' } },
      // 行本地谓词（逐 run 同解）：同一 run 覆盖 want 才算，跨 run 凑轴不算
      { where: { mark: { bold: true } } },
      { where: { mark: { ink: 'red' } } },
      { where: { mark: { bold: true, ink: 'red' } } },
      { where: { mark: {} } },
      { where: { link: {} } },
    ] as const) {
      const c = [...cands(spec)].sort()
      const h = [...hits(spec)].sort()
      if (JSON.stringify(c) !== JSON.stringify(h)) console.log('DIFF', JSON.stringify(spec.where), 'cands', c, 'hits', h)
      assert.deepEqual(c, h, `候选与命中必须同集：${JSON.stringify(spec.where)}`)
    }

    /**
     * `{mark:{bold, ink:'red'}}` 的跨 run 反例：`E_SPLIT` 是一段粗、一段红，
     * 两段分开 ⇒ 不是「粗红」。候选若按「任意 run 凑齐各轴」写，这里会多给（丢不掉）。
     */
    assert.ok([...cands({ where: { mark: { bold: true, ink: 'red' } } })].every((id) => id !== 'E_SPLIT'))

    // `{down}` 不再断言「同集」：一个块可以既是命中、又有命中后代 ⇒ 种子不能减，
    // 这一支按设计就不精确（见 `planIsExact`）。它的「候选 ⊇ 命中」由上面那条总等式覆盖。
  })
})

test('mark／link 的「下推进页查询」与计划 SQL 同集（同一份谓词，两条投影不许漂）', () => {
  withDb((db) => {
    applyRowWrites(db, rebuildDerivedWrites(readContentRows(db)))
    const { forest } = baseline(db)
    for (const spec of [
      { where: { mark: { bold: true } } },
      { where: { mark: { ink: 'red' } } },
      { where: { mark: {} } },
      { where: { link: {} } },
      { where: { link: { url: 'example.com' } } },
    ] as const) {
      const plan = candidateBuildOf(spec, undefined, forest, {}).plan
      const paged = [...allCandidateIds(db, plan, 4000)].sort()
      const q = candidatePlanSql(plan, { derived: true })
      const planned = [...new Set((db.prepare(q.sql).all(...q.params) as { id: unknown }[]).map((r) => String(r.id)))].sort()
      assert.deepEqual(paged, planned, `分页 SQL 与计划 SQL 必须同集：${JSON.stringify(spec.where)}`)
    }
  })
})

/* ------------------------------------------------------------ 身份值的候选计划 */

/**
 * **计划形状**测试：`Record<RoleKind, …>` 只保证「有键」，不保证「计划精准」——
 * 把某一支填成 `{k:'visible'}` 照样过编译，等式测试也照样绿（可见集本来就是超集）。
 * 这条把「不许退化成全域」变成断言，并且比的是**完整对象**（`{k:'list', list:'tag'}`
 * 的 `k` 也是 `list`，只比 `.k` 抓不到）。
 */
test('身份七值的候选计划：完整对象相等，且不许退化成 visible', () => {
  const expected: Record<RoleKind, Record<string, unknown>> = {
    journal: { k: 'journal' },
    page: { k: 'list', list: 'page' },
    tag: { k: 'list', list: 'tag' },
    note: { k: 'note' },
    schema: { k: 'kind' },
    query: { k: 'query' },
    automation: { k: 'prop', name: '_automation' },
  }
  for (const role of ROLE_KINDS) {
    const plan = candidateBuildOf({ where: { role } }, undefined, [], {}).plan
    assert.deepEqual(plan, expected[role], `「${role}」的候选计划形状不对（退化会静默变慢，等式测试抓不到）`)
    assert.notEqual(plan.k, 'visible', `「${role}」不许退化成全域候选`)
  }
  // 未知值：候选多取、不崩（读入宽容，守卫在求值侧）
  const unknown = candidateBuildOf({ where: { role: 'bogus' } as unknown as QuerySpec }, undefined, [], {}).plan
  assert.equal(unknown.k, 'visible')
})

/**
 * `{not:{role:'query'}}` 的差集必须**只减真命中**。
 *
 * `{k:'query'}` 的 SQL 是「`query` 列非空」，它是 matcher 的**真超集**（坏形状的旧条件
 * 列非空但读不出）⇒ 一旦被 `planIsExact` 当成精确集，差集就会把 `BROKEN_Q` 从否定
 * 查询的候选里挖掉——而它本该命中（它不是一个查询视图块）。
 */
test('{not:{role:query}} 不挖掉「列非空但条件读不出」的块（候选超集不是等价）', () => {
  withDb((db) => {
    const { forest, kb } = baseline(db)
    const plan = (spec: QuerySpec) => candidateBuildOf(spec, undefined, forest, {}).plan
    const notQuery = { where: { not: { role: 'query' } } } as QuerySpec
    /**
     * 退化发生在 **SQL 层**（`candidatePlanSql` 的 `notIn` 分支），不在计划形状上：
     * 计划仍是 `notIn`，但子计划不精确 ⇒ SQL 退化成 `visible`、不许出现 `except`。
     */
    assert.equal(plan(notQuery).k, 'notIn')
    const sql = candidatePlanSql(plan(notQuery))
    assert.ok(!sql.sql.toLowerCase().includes('except'), '`query` 不精确 ⇒ 差集不许生效（否则会挖掉 BROKEN_Q）')
    const { hits, candidates } = worksetEval(db, notQuery, forest, {})
    assert.ok(new Set(hits).has('BROKEN_Q'), 'matcher 说 BROKEN_Q 不是查询视图块，它必须命中否定条件')
    assert.ok(candidates.includes('BROKEN_Q'), '候选不许把它挖掉（差集减多一个就是漏行）')
    assert.deepEqual(
      [...new Set(hits)].sort(),
      [...hitSet(kb, notQuery, {})].sort(),
      '候选装载求值与整库求值必须一致',
    )
  })
})

/**
 * `tagged` 计划的**精确性是假的**：候选问「有没有 `_tags` 这一行」，matcher 问「有没有**活**标签」。
 *
 * 死标签 id 是合法状态 ⇒ 存在「行在、标签全死」的块：它不命中 `{_tags exists:true}`，
 * 但会被 `tagged` 候选选中。一旦 tagged 被当成精确集用于否定差集，这类块就从
 * 「没有活标签」的查询结果里被挖掉——静默漏行。
 */
test('{not:{_tags exists}} 保留「只带死标签」的块（tagged 计划不精确）', () => {
  withDb((db) => {
    const { forest, kb } = baseline(db)
    const plan = (spec: QuerySpec) => candidateBuildOf(spec, undefined, forest, {}).plan
    const notTags = { where: { not: { prop: { id: '_tags', exists: true } } } } as QuerySpec
    const sql = candidatePlanSql(plan(notTags))
    assert.ok(!sql.sql.toLowerCase().includes('except'), '`tagged` 不精确 ⇒ 差集不许生效')
    const { hits, candidates } = worksetEval(db, notTags, forest, {})
    assert.ok(new Set(hits).has('Z_DEADTAG'), 'matcher 说它没有活标签，它必须命中否定条件')
    assert.ok(candidates.includes('Z_DEADTAG'), '候选不许把它挖掉（差集减多一个就是漏行）')
    assert.deepEqual([...new Set(hits)].sort(), [...hitSet(kb, notTags, {})].sort(), '候选装载求值与整库求值必须一致')
  })
})
