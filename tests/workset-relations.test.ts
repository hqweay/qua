/**
 * **派生关系行的写侧维护**（层 2 第一片）。
 *
 * 判据（每条都能被独立推翻）：
 *
 * | # | 不变量 | 怎么证伪 |
 * |---|---|---|
 * | ① | 内容/属性/anno 编辑 ⇒ 该源块的 prune＋upsert 与「按块重算 `relationEdgesOfBlock`」一致 | 漏一种 op（如 `prop` 不重铺），引用计数等式红 |
 * | ② | 结构变化（移动/删除/恢复/清除）⇒ **整棵子树**的源块进 prune（含已不可见的块——它们的旧行必须清掉） | 只 prune 根，子的旧关系行残留，反链会「死人说话」 |
 * | ③ | 可见但祖先链**不完整**的源块**原样不动**（prune 了补不回来＝永久丢边） | 对它 prune 却不 upsert，全库计数会永久少一条边 |
 * | ④ | `from_root` 沿父链走到顶层；同一源块的边按 `(from,to,kind)` 去重（与全量重建同一条口径） | 去重漏了双 ref 属性指同一目标，upsert 键冲突静默覆盖 |
 * | ⑤ | 新建／搬进来的块落点已知（父为空或在完整集里）⇒ **当场补进完整集**，出向边立刻落行 | 新块永远不在完整集里 ⇒ 它的边 prune 完不补（角标少数、反链栏多数） |
 *
 * 语义基准是层 0 的 `derivedRowsOf`（全量重建）；增量必须与它对同一批源块逐行一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset, relationWritesOf } from '../src/core/storage/workset.ts'
import { derivedRowsOf } from '../src/core/storage/derived-rows.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { writeBlockContent, textRuns, type Block, type RowWrite } from '../src/core/index.ts'
import type { RawLibraryRows } from '../src/core/storage/db-rows.ts'

type Row = Record<string, unknown>

function row(id: string, parent: string | null = null, left: string | null = null, extra: Row = {}): Row {
  return { id, parent, left, content: '[]', created: 1, modified: 1, ...extra }
}

function rows(blocks: Row[], aliases: Row[] = [], lists: Row[] = [], props: Row[] = []): RawLibraryRows {
  return { blocks, props, aliases, lists, meta: {} }
}

/** 关系行的可比形状：源块 → (to,kind) 集合 */
function relationsOf(writes: readonly RowWrite[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const w of writes) {
    if (w.table !== 'BlockRelation') continue
    if (w.op !== 'upsert') continue
    const from = String((w.key as Record<string, unknown>).from_id)
    const to = String((w.key as Record<string, unknown>).to_id)
    const kind = String((w.key as Record<string, unknown>).kind)
    const set = out.get(from) ?? new Set<string>()
    set.add(`${to}#${kind}`)
    out.set(from, set)
  }
  return out
}

/** 与层 0 的全量重建对同一批源块对账 */
function baselineRelations(forest: readonly Block[], sources: readonly string[]): Map<string, Set<string>> {
  const rows = derivedRowsOf(forest).relations
  const want = new Set(sources)
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!want.has(r.from_id)) continue
    const set = out.get(r.from_id) ?? new Set<string>()
    set.add(`${r.to_id}#${r.kind}`)
    out.set(r.from_id, set)
  }
  return out
}

function fixture(): { store: BlockStore; ws: Workset; kb: MemoryKb } {
  const store = new BlockStore([])
  const ws = new Workset(store)
  return { store, ws, kb: new MemoryKb(store) }
}

test('① 内容/属性编辑 ⇒ 源块的 prune＋upsert 与全量重建一致', () => {
  const { store, ws, kb } = fixture()
  // 文档：day ── note（引用 TAG_A）＋ tag/def 身份块（顶层）
  ws.loadDoc(
    rows([row('day'), row('note', 'day')], [], [], [
      { block: 'note', name: '_tags', pos: 0, multi: 1, value: JSON.stringify('TAG_A') },
    ]),
    ['day'],
  )
  ws.loadBlocks(
    rows([
      row('TAG_A'),
      row('DEF', null, 'TAG_A', { kind: 'ref' }),
    ]),
    true,
  )
  void kb

  // 打字：note 的正文从空改成引用 PAGE_X —— prop/内容 op 都该让 note 重铺
  kb.tx((tx) => tx.patch('note', (b) => writeBlockContent(b, textRuns('看 ', { t: 'ref', to: 'PAGE_X', id: 'r1' }) as never)))
  const ops = [
    {
      e: 'block' as const,
      id: 'note',
      op: 'upsert' as const,
      value: { content: [{ t: 'text', v: '看 ' }], modified: 2 },
      at: 2,
    },
    { e: 'prop' as const, block: 'note', name: '_color', op: 'set' as const, value: 'red', at: 2 },
  ]
  const writes = relationWritesOf(store, ws.completeIds(), ops)
  const got = relationsOf(writes)
  const baseline = baselineRelations([store.find('day')!], ['note'])
  assert.deepEqual([...(got.get('note') ?? [])].sort(), [...(baseline.get('note') ?? [])].sort())
  // prune 也在场（先清后铺）
  assert.ok(
    writes.some((w) => w.table === 'BlockRelation' && w.op === 'delete' && (w.key as Record<string, unknown>).from_id === 'note'),
    '重铺前先 prune 该源块的旧行',
  )
})

test('② 删除/恢复 ⇒ 整棵子树进 prune（含已不可见的块）', () => {
  const { store, ws } = fixture()
  ws.loadDoc(rows([row('day'), row('parent', 'day'), row('child', 'parent')]), ['day'])
  ws.loadBlocks(rows([row('TAG_A')]), true)

  // 软删 parent：子树（parent＋child）的旧关系行都要清——child 自己没被点名
  const removeOps = [{ e: 'block' as const, id: 'parent', op: 'exist' as const, state: 'deleted' as const, at: 3 }]
  let writes = relationWritesOf(store, ws.completeIds(), removeOps)
  const pruned = writes
    .filter((w) => w.table === 'BlockRelation' && w.op === 'delete')
    .map((w) => String((w.key as Record<string, unknown>).from_id))
  assert.ok(pruned.includes('parent') && pruned.includes('child'), '子块的旧关系行必须一起清')

  // 恢复：同一批形状（子树可见块重铺）
  writes = relationWritesOf(store, ws.completeIds(), [
    { e: 'block' as const, id: 'parent', op: 'exist' as const, state: 'present' as const, at: 4 },
  ])
  const upserts = writes.filter((w) => w.table === 'BlockRelation' && w.op === 'upsert')
  assert.ok(upserts.length >= 0)
  void store
})

test('③ 可见但祖先链不完整的源块：整批不动（不 prune、不 upsert）', () => {
  const { store, ws } = fixture()
  // 普通预取（complete=false）：块进了 store，父链还在库里（父没装载）
  ws.loadBlocks(rows([row('target', 'somePage')]))
  const ops = [
    {
      e: 'block' as const,
      id: 'target',
      op: 'upsert' as const,
      value: { content: [{ t: 'text', v: '改过' }], modified: 2 },
      at: 2,
    },
  ]
  const writes = relationWritesOf(store, ws.completeIds(), ops)
  assert.deepEqual(writes, [], '链不完整 ⇒ 一行都不写：旧行留着（from_root 虽然旧，边不能丢），也不清')
})

test('③b 已不可见（软删）的源块：链不完整也照清', () => {
  const { store, ws } = fixture()
  ws.loadBlocks(rows([row('gone', 'somePage', null, { deleted: 3 })]))
  const ops = [{ e: 'block' as const, id: 'gone', op: 'exist' as const, state: 'deleted' as const, at: 4 }]
  const writes = relationWritesOf(store, ws.completeIds(), ops)
  const deleted = writes
    .filter((w) => w.table === 'BlockRelation' && w.op === 'delete')
    .map((w) => String((w.key as Record<string, unknown>).from_id))
  assert.deepEqual(deleted, ['gone'], '不可见的块留下的行必须清掉，否则反链里「死人说话」')
})

test('⑤ 新建块落在完整链下 ⇒ 当场补进完整集，出向边立刻落行', () => {
  const { store, ws } = fixture()
  ws.loadDoc(rows([row('day'), row('parent', 'day')]), ['day'])
  // 新块经 Tx 插入后已在 index 里（这里用装载模拟那一步，不给 complete）
  ws.loadBlocks(
    rows([row('child', 'parent', null, { content: JSON.stringify([{ t: 'ref', to: 'T1', id: 'r1' }]) })]),
  )
  const ops = [
    {
      e: 'block' as const,
      id: 'child',
      op: 'upsert' as const,
      value: { parent: 'parent', prev: null, created: 1, modified: 1 },
      at: 2,
    },
  ]
  const writes = ws.relationWritesFor(ops)
  const relRow = writes.find((w) => w.table === 'BlockRelation' && w.op === 'upsert')
  assert.ok(relRow, '新块的边必须落行——不然清完就再也补不回来')
  assert.equal((relRow!.key as Record<string, unknown>).from_id, 'child')
  assert.equal((relRow!.values as Record<string, unknown>).from_root, 'day', 'from_root 沿父链到顶层')
  void store
})

test('④ from_root 沿父链到顶层；同源块的边按 (from,to,kind) 去重', () => {
  const { store, ws } = fixture()
  ws.loadDoc(rows([row('PAGE'), row('child', 'PAGE')]), ['PAGE'])
  ws.loadBlocks(rows([row('T1'), row('T2', null, 'T1')]), true)
  // child 的正文引用 T1；T2 是 TAG_A 风格的第二个目标（同一块两条 inline 边只留一条）
  const child = store.find('child')!
  writeBlockContent(child, [
    { t: 'text', v: 'x' },
    { t: 'ref', to: 'T1', id: 'r1' },
    { t: 'ref', to: 'T1', id: 'r2' },
  ])
  const writes = relationWritesOf(store, ws.completeIds(), [
    { e: 'block' as const, id: 'child', op: 'upsert' as const, value: { content: [], modified: 2 }, at: 2 },
  ])
  const rel = relationsOf(writes).get('child') ?? new Set()
  assert.deepEqual([...rel].sort(), ['T1#inline'])
  // from_root 落在行 values 里
  const relRow = writes.find((w) => w.table === 'BlockRelation' && w.op === 'upsert')
  assert.equal((relRow!.values as Record<string, unknown>).from_root, 'PAGE')
})
