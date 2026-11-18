/**
 * **派生表流式重建的编排**：逐根成功才置 ready；失败/取消都不置（半表比空表危险）。
 * 派生行本身的正确性由 `library-derived`（重建==增量）钉住；这里只钉编排的三条出口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildDerivedTables, type DerivedRebuildDeps } from '../src/app/boot/derived-rebuild.ts'
import type { LibraryClient, LibraryReadResult } from '../src/core/storage/library-client.ts'
import type { RawLibraryRows } from '../src/core/storage/db-rows.ts'
import type { RowWrite } from '../src/core/storage/db-rows.ts'

type Row = Record<string, unknown>

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

test('全部根成功 ⇒ 逐根落盘并置 ready', async () => {
  const client = fakeClient(['r1', 'r2'], new Map([
    ['r1', rows([blockRow('r1'), blockRow('c1', 'r1')])],
    ['r2', rows([blockRow('r2')])],
  ]))
  const store = fakeStore()
  const r = await rebuildDerivedTables(deps(client, store))
  assert.equal(r.ok, true)
  assert.deepEqual(client.calls, ['roots', 'doc:r1', 'doc:r2'])
  // ready 是最后一笔
  const ready = store.writes.find(
    (w) => w.table === 'meta' && (w.key as Record<string, unknown>).key === 'derived_state',
  )
  assert.ok(ready, '置 ready 的 meta 行在场')
  // 每根的派生行都进了
  const indexWrites = store.writes.filter((w) => w.table === 'BlockIndex' && w.op === 'upsert')
  assert.ok(indexWrites.length >= 3, 'r1/c1/r2 的 index 行都落了')
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
