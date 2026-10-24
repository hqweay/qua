/**
 * `StoragePort` 的契约测试（跑**真实现** `createLocalStorageAdapter` + 内存版 localStorage）。
 *
 * 这些不是「适配器内部怎么实现」的测试，而是**上层可以依赖的承诺**：
 *   1. 读盘结果分型：没有库 ≠ 打不开的库 ≠ 读不到存储；
 *   2. 提交失败**如实返回**（配额满不许假装存上）；
 *   3. 提交**串行**（单写者）：后提交的一定在后，不会被前一次覆盖；
 *   4. 信封自描述：换了后端留下的字节要能被说清（`incompatible`）；
 *   5. 门面（`createWorkspaceStore`）能把字节判定成上层直接能分支的结果。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLocalStorageAdapter,
  createWorkspaceStore,
  WORKSPACE_VERSION,
  type Workspace,
} from '../src/core/workspace.ts'
import { installMemoryLocalStorage, peekMemoryLocalStorage, resetMemoryLocalStorage } from './storage/test-local-storage.ts'

const KEY = 'qua-test'

installMemoryLocalStorage()

function lib(patch: Partial<Workspace> = {}): Workspace {
  return {
    version: WORKSPACE_VERSION,
    blocks: [{ id: 'b1', text: 'hello', children: [] }],
    activeId: 'b1',
    savedAt: 0,
    marks: [],
    atoms: [],
    trash: [],
    ...patch,
  }
}

const batch = (data: Workspace) => ({ ops: [], changes: [{ kind: 'blocks' as const, id: '*' }], payload: JSON.stringify(data), savedAt: data.savedAt })

test('load: 从没存过 ⇒ empty', async () => {
  resetMemoryLocalStorage()
  assert.deepEqual(await createLocalStorageAdapter(KEY).load(), { status: 'empty' })
})

test('commit → load 往返：写进去的是信封，读出来的是库本体', async () => {
  resetMemoryLocalStorage()
  const port = createLocalStorageAdapter(KEY)
  const r = await port.commit(batch(lib({ savedAt: 42 })))
  assert.deepEqual(r, { ok: true, savedAt: 42 })

  // 落盘的是信封（带 backend），不是裸库
  const onDisk = JSON.parse(peekMemoryLocalStorage(KEY)!)
  assert.equal(onDisk.backend, 'local-storage')

  const loaded = await port.load()
  assert.equal(loaded.status, 'ok')
  if (loaded.status !== 'ok') return
  assert.equal(JSON.parse(loaded.raw).savedAt, 42)
})

test('commit 失败 ⇒ ok:false（不许假装存上了）', async () => {
  resetMemoryLocalStorage()
  installMemoryLocalStorage({ failSet: true })
  const r = await createLocalStorageAdapter(KEY).commit(batch(lib()))
  assert.equal(r.ok, false)
  // 恢复到可写，免得污染后面的用例
  installMemoryLocalStorage()
})

test('串行：同一 tick 连发三次提交，最终落盘的是最后一次', async () => {
  resetMemoryLocalStorage()
  const port = createLocalStorageAdapter(KEY)
  const p1 = port.commit(batch(lib({ savedAt: 1 })))
  const p2 = port.commit(batch(lib({ savedAt: 2 })))
  const p3 = port.commit(batch(lib({ savedAt: 3 })))
  const rs = await Promise.all([p1, p2, p3])
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true])
  await port.settle()
  const loaded = await port.load()
  assert.equal(loaded.status, 'ok')
  if (loaded.status !== 'ok') return
  assert.equal(JSON.parse(loaded.raw).savedAt, 3)
})

test('load: 别的后端留下的字节 ⇒ incompatible（不是 corrupt：数据没坏，是走错门了）', async () => {
  resetMemoryLocalStorage()
  globalThis.localStorage.setItem(KEY, JSON.stringify({ something: 'else' }))
  const r = await createLocalStorageAdapter(KEY).load()
  assert.equal(r.status, 'incompatible')
})

test('load: 升级前的裸库 JSON ⇒ 原样交给上层判版本（不能当成信封吞掉）', async () => {
  resetMemoryLocalStorage()
  globalThis.localStorage.setItem(KEY, JSON.stringify({ version: 3, blocks: [] }))
  const r = await createLocalStorageAdapter(KEY).load()
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.equal(JSON.parse(r.raw).version, 3)
})

test('load: 版本号高于当前 ⇒ too-new（拒绝打开，不是 corrupt，且不写回）', async () => {
  resetMemoryLocalStorage()
  const raw = JSON.stringify({ ...lib(), version: WORKSPACE_VERSION + 1 } as unknown as Workspace)
  globalThis.localStorage.setItem(KEY, raw)
  const store = createWorkspaceStore(createLocalStorageAdapter(KEY))
  const r = await store.load()
  assert.deepEqual(r, { status: 'too-new', version: WORKSPACE_VERSION + 1 })
  assert.equal(globalThis.localStorage.getItem(KEY), raw, 'too-new 时不许改写字节')
})

test('门面：empty / 旧库 / 坏字节 各有自己的分支', async () => {
  resetMemoryLocalStorage()
  const store = createWorkspaceStore(createLocalStorageAdapter(KEY))
  assert.deepEqual(await store.load(), { status: 'empty' })

  await store.commit(lib(), [])
  const ok = await store.load()
  assert.equal(ok.status, 'ok')

  globalThis.localStorage.setItem(KEY, '{oops')
  assert.deepEqual(await store.load(), { status: 'corrupt', reason: 'parse' })
})

test('clear: 清掉之后回到 empty（清的是存储，不是内存库）', async () => {
  resetMemoryLocalStorage()
  const store = createWorkspaceStore(createLocalStorageAdapter(KEY))
  await store.commit(lib(), [])
  await store.clear()
  assert.equal(peekMemoryLocalStorage(KEY), null)
  assert.deepEqual(await store.load(), { status: 'empty' })
})


test('一批 op ＝ 一个事务：门面把 op 原样带进 batch，changes 是它的最小投影', async () => {
  let captured: { ops: unknown[]; changes: unknown[]; payload: string } | null = null
  const stubPort = {
    kind: 'test',
    load: async () => ({ status: 'empty' as const }),
    commit: async (b: { ops: unknown[]; changes: unknown[]; payload: string }) => {
      captured = b
      return { ok: true as const, savedAt: 0 }
    },
    clear: async () => {},
    settle: async () => {},
  }
  const store = createWorkspaceStore(stubPort)

  const ops = [
    { e: 'block', id: 'b1', op: 'upsert', value: { text: 'x' }, at: 1 },
    { e: 'prop', block: 'b1', name: '_tags', op: 'set', value: ['t1'], at: 2 },
    { e: 'anno', block: 'b1', id: 'a1', op: 'set', value: { id: 'a1', kind: 'tag', blockId: 'b1', start: 0, end: 1 }, at: 3 },
    { e: 'anno', block: 'b2', id: 'm1', op: 'delete', at: 4 },
  ] as const
  await store.commit(lib({ savedAt: 7 }), ops)

  assert.ok(captured)
  // op 原样进 batch（一批 op ＝ 一个事务——写适配器按这个契约落行）
  assert.deepEqual(captured.ops, ops)
  // changes 是最小投影：块类合并、原子/标记分开
  assert.deepEqual(captured.changes, [
    { kind: 'blocks', id: 'b1' },
    { kind: 'atoms', id: 'b1' },
    { kind: 'marks', id: 'b2' },
    { kind: 'atoms', id: 'b2' },
  ])
  // 落盘字节仍是整份库（demo 适配器实现细节，SQLite 适配器不收这个）
  assert.ok((captured as { payload: string }).payload.includes('"b1"'))
})

test('op 为空 ⇒ 这批不是事务产的：按整类提交（迁移期真相）', async () => {
  let captured: { changes: unknown[] } | null = null
  const stubPort = {
    kind: 'test',
    load: async () => ({ status: 'empty' as const }),
    commit: async (b: { ops: unknown[]; changes: unknown[]; payload: string }) => {
      captured = b
      return { ok: true as const, savedAt: 0 }
    },
    clear: async () => {},
    settle: async () => {},
  }
  const store = createWorkspaceStore(stubPort)
  await store.commit(lib(), [])
  assert.ok(captured)
  assert.deepEqual(captured.changes, [
    { kind: 'blocks', id: '*' },
    { kind: 'marks', id: '*' },
    { kind: 'atoms', id: '*' },
  ])
})
