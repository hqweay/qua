/**
 * **派生表流式重建的编排**：逐根成功才置 ready；失败/取消都不置（半表比空表危险）。
 * 派生行本身的正确性由 `library-derived`（重建==增量）钉住；这里只钉编排的三条出口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildDerivedTables, type DerivedRebuildDeps } from '../src/app/boot/derived-rebuild.ts'
import { DERIVED_PATH_VERSION } from '../src/core/identity/library.ts'
import { pathSegmentOf } from '../src/core/storage/derived-rows.ts'
import type { LibraryClient, LibraryReadResult } from '../src/core/storage/library-client.ts'
import type { RawLibraryRows } from '../src/core/storage/db-rows.ts'
import type { RowWrite } from '../src/core/storage/db-rows.ts'

type Row = Record<string, unknown>

const segPath = (rank: number): string => `/${pathSegmentOf(rank)}`

const indexUpserts = (writes: readonly RowWrite[]): RowWrite[] =>
  writes.filter((w) => w.table === 'BlockIndex' && w.op === 'upsert')

/** 顶层根 r1..rN 铺出来的路径（写入序＝逐根的文档序） */
const topPaths = (writes: readonly RowWrite[]): string[] =>
  indexUpserts(writes)
    .filter((w) => /^r\d+$/.test(String((w.key as Row).block)))
    .map((w) => String((w.values as Row).path))

const pathOf = (writes: readonly RowWrite[], id: string): string =>
  String((indexUpserts(writes).find((w) => (w.key as Row).block === id)!.values as Row).path)

const blockRow = (id: string, parent: string | null = null): Row => ({
  id,
  parent,
  left: null,
  content: '[]',
  created: 1,
  modified: 1,
})

function rows(blocks: Row[]): RawLibraryRows {
  return { blocks, props: [], aliases: [], lists: [], meta: {} }
}

/** 假客户端：roots ＋ 每根的子树行；失败表按 id 让 doc 返回 error */
function fakeClient(
  rootIds: string[],
  subtrees: Map<string, RawLibraryRows>,
  failDocs: ReadonlySet<string> = new Set(),
  top: { block: string; path: string }[] = [],
): LibraryClient & { calls: string[] } {
  const calls: string[] = []
  const okIds = <T>(value: T): LibraryReadResult<T> => ({ status: 'ok', value })
  return {
    calls,
    doc: async (ids) => {
      calls.push(`doc:${ids.join(',')}`)
      if (ids.some((id) => failDocs.has(id))) return { status: 'error', error: 'boom' }
      return okIds({
        rows: subtrees.get(ids[0]!) ?? rows([]),
        ancestors: [],
        rootIds: [...ids],
      })
    },
    blocks: async () => okIds({ blocks: [], props: [], aliases: [], lists: [], meta: {} }),
    candidates: async () => okIds([]),
    tree: async () => okIds({ blocks: [], props: [], aliases: [], lists: [], meta: {} }),
    identity: async () => okIds({ blocks: [], props: [], aliases: [], lists: [], meta: {} }),
    ftsMap: async () => okIds([]),
    dependents: async () => okIds({ content: [], tag: [], prop: [] }),
    roots: async () => {
      calls.push('roots')
      return okIds(rootIds)
    },
    catalog: async () => okIds({} as never),
    indexChildren:
      top.length === 0
        ? undefined
        : async (parent: string | null) => {
            calls.push(`indexChildren:${String(parent)}`)
            return okIds(
              parent === null
                ? top.map((r) => ({ block: r.block, root: r.block, path: r.path, hidden: null as null }))
                : [],
            )
          },
  }
}

function fakeStore(): WorkspaceStoreStub {
  const writes: RowWrite[] = []
  return {
    writes,
    commitRaw: async (w) => {
      writes.push(...w)
      return { ok: true as const }
    },
  } as WorkspaceStoreStub
}

interface WorkspaceStoreStub {
  writes: RowWrite[]
  commitRaw: (w: readonly RowWrite[]) => Promise<{ ok: true } | { ok: false; error: unknown }>
}

function deps(client: LibraryClient, store: WorkspaceStoreStub, opts: Partial<DerivedRebuildDeps> = {}): DerivedRebuildDeps {
  return { client, store: store as never, ...opts }
}

test('全部根成功 ⇒ 逐根落盘并置 ready，顶层段唯一且按根序递增', async () => {
  const client = fakeClient(['r1', 'r2'], new Map([
    ['r1', rows([blockRow('r1'), blockRow('c1', 'r1')])],
    ['r2', rows([blockRow('r2')])],
  ]))
  const store = fakeStore()
  const r = await rebuildDerivedTables(deps(client, store))
  assert.equal(r.ok, true)
  assert.deepEqual(client.calls, ['roots', 'doc:r1', 'doc:r2'])
  // ready ＋ 路径版本是最后一笔（同一批写）
  const last = store.writes.filter((w) => w.table === 'meta')
  assert.deepEqual(
    last.map((w) => w.key),
    [{ key: 'derived_state' }, { key: 'derived_path_version' }],
  )
  assert.deepEqual(last.map((w) => w.values), [{ value: 'ready' }, { value: DERIVED_PATH_VERSION }])
  // 每根的派生行都进了
  const indexWrites = store.writes.filter((w) => w.table === 'BlockIndex' && w.op === 'upsert')
  assert.ok(indexWrites.length >= 3, 'r1/c1/r2 的 index 行都落了')
  /**
   * 逐根算时每棵只有一个顶层根（`ctx.index` 恒 0）——重建必须把整层的段分配好再传进去，
   * 否则 37 个根会全落在 `/1000000001024/`（真实库里就是这样坏的）。
   */
  const paths = topPaths(store.writes)
  assert.equal(new Set(paths).size, 2, `顶层段必须两两不同：${JSON.stringify(paths)}`)
  assert.ok(paths[0]! < paths[1]!, '段序 == roots 的文档序')
  const child = pathOf(store.writes, 'c1')
  assert.ok(child.startsWith(paths[0]!), '子块的路径必须挂在它自己那根的前缀下')
})

test('存量段值可用时保留（不因重建改写已铺好的顶层段）', async () => {
  const client = fakeClient(
    ['r1', 'r2'],
    new Map([
      ['r1', rows([blockRow('r1')])],
      ['r2', rows([blockRow('r2')])],
    ]),
    new Set(),
    [
      { block: 'r1', path: segPath(512) },
      { block: 'r2', path: segPath(1536) },
    ],
  )
  const store = fakeStore()
  const r = await rebuildDerivedTables(deps(client, store))
  assert.equal(r.ok, true)
  assert.equal(client.calls.includes('indexChildren:null'), true, '重建要先读现存的顶层行')
  assert.deepEqual(topPaths(store.writes), [segPath(512), segPath(1536)])
})

test('存量段值撞车/缺失/乱序 ⇒ 整层按文档序重铺', async () => {
  const cases: { name: string; top: { block: string; path: string }[] }[] = [
    { name: '撞车（真实库的形状：多根同段）', top: [{ block: 'r1', path: segPath(1024) }, { block: 'r2', path: segPath(1024) }] },
    { name: '缺失一根', top: [{ block: 'r1', path: segPath(1024) }] },
    { name: '乱序', top: [{ block: 'r1', path: segPath(2048) }, { block: 'r2', path: segPath(1024) }] },
    { name: '路径不是单段', top: [{ block: 'r1', path: `${segPath(1024)}${segPath(1024)}` }, { block: 'r2', path: segPath(2048) }] },
  ]
  for (const c of cases) {
    const client = fakeClient(
      ['r1', 'r2'],
      new Map([
        ['r1', rows([blockRow('r1')])],
        ['r2', rows([blockRow('r2')])],
      ]),
      new Set(),
      c.top,
    )
    const store = fakeStore()
    const r = await rebuildDerivedTables(deps(client, store))
    assert.equal(r.ok, true, c.name)
    assert.deepEqual(topPaths(store.writes), [segPath(1024), segPath(2048)], `${c.name} ⇒ 按文档序整层重铺`)
  }
})

test('任一根失败 ⇒ 不置 ready（半表比空表危险）', async () => {
  const client = fakeClient(['r1', 'r2'], new Map([
    ['r1', rows([blockRow('r1')])],
    ['r2', rows([blockRow('r2')])],
  ]), new Set(['r2']))
  const store = fakeStore()
  const r = await rebuildDerivedTables(deps(client, store))
  assert.equal(r.ok, false)
  assert.equal(r.failed, 1)
  const ready = store.writes.find(
    (w) => w.table === 'meta' && (w.key as Record<string, unknown>).key === 'derived_state',
  )
  assert.equal(ready, undefined, '失败 ⇒ ready 永不出现')
})

test('取消 ⇒ 立刻返回且不置 ready', async () => {
  const client = fakeClient(['r1', 'r2'], new Map([
    ['r1', rows([blockRow('r1')])],
    ['r2', rows([blockRow('r2')])],
  ]))
  const store = fakeStore()
  let seenFirst = false
  const r = await rebuildDerivedTables(deps(client, store, {
    shouldCancel: () => {
      if (seenFirst) return true
      seenFirst = true
      return false
    },
  }))
  assert.equal(r.ok, false)
  assert.equal(client.calls.includes('doc:r2'), false, '取消后不再读下一根')
  assert.equal(store.writes.some((w) => w.table === 'meta'), false)
})
