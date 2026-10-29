/**
 * 库存储适配器（渲染层，经 IPC）—— 与 localStorage 适配器同一个端口。
 *
 * 判据：
 *   ① **装载补回当前版本**：库里不存 `version`（唯一判据是 `user_version`），
 *      上层拿到的永远是一份 `version === WORKSPACE_VERSION` 的库；
 *   ② **提交送的是行写入**，不是整份字节 —— 这是「写成本不随库体量增长」的落地面；
 *   ③ 失败**如实返回**（不许假装存上）；
 *   ④ 单写者：后一次提交永远排在前一次之后。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE_VERSION } from '../../src/core/workspace.ts'
import { createIpcAdapter, IPC_BACKEND, withVersion, type LibraryBridge } from '../../src/core/storage/ipc-adapter.ts'
import type { RawLibraryRows } from '../../src/core/storage/db-rows.ts'

/** 一片最小的行集：一个块 ＋ 库级两格（不带 version，库本来就不存它） */
const rows = (patch: Partial<RawLibraryRows> = {}): RawLibraryRows => ({
  blocks: [{ id: 'b1', content: '[]', created: 1, modified: 2, parent: null, left: null }],
  props: [],
  aliases: [],
  lists: [],
  meta: { active_id: 'b1', saved_at: '3' },
  ...patch,
})

/** 桥的资产面：本文件不测它（在 storage/asset-ipc.test.ts），但 `LibraryBridge` 的形状要求它在 */
const assetFace = {
  assetKeys: async () => ({ status: 'ok', keys: [] }),
  assetGet: async () => ({ status: 'missing' }),
  assetStat: async () => ({ status: 'missing' }),
  assetPut: async () => ({ status: 'bad-args' }),
}

/** 一个记下「收到了什么」的假桥 */
function fakeBridge(reply: { status: string; rows?: RawLibraryRows } = { status: 'empty' }): {
  bridge: LibraryBridge
  saves: { writes: unknown[]; opts?: { replace?: boolean } }[]
} {
  const saves: { writes: unknown[]; opts?: { replace?: boolean } }[] = []
  return {
    saves,
    bridge: {
      libraryInfo: async () => ({ status: 'ok' }),
      load: async () => reply,
      save: async (writes, opts) => {
        saves.push({ writes, opts })
        return { ok: true }
      },
      ...assetFace,
    },
  }
}

test('withVersion：装载时补回当前版本（库里不存它）', () => {
  const back = withVersion({ blocks: [], activeId: '', savedAt: 0 })
  assert.equal(back.version, WORKSPACE_VERSION)
  assert.deepEqual(back.blocks, [])
})

test('load：行 → 模型（行里有 `parent`／`left`，读出来是 `children`）', () => {
  const { bridge } = fakeBridge({
    status: 'ok',
    rows: rows({
      blocks: [
        { id: 'root', content: '[]', created: 1, modified: 1, parent: null, left: null },
        { id: 'a', content: '[]', created: 1, modified: 1, parent: 'root', left: null },
        { id: 'b', content: '[]', created: 1, modified: 1, parent: 'root', left: 'a' },
      ],
    }),
  })
  return createIpcAdapter(bridge)
    .load()
    .then((r) => {
      assert.equal(r.status, 'ok')
      if (r.status !== 'ok') return
      const ws = JSON.parse(r.raw)
      assert.equal(ws.version, WORKSPACE_VERSION, '装载时补回当前版本')
      assert.equal(ws.blocks.length, 1, '只有一个顶层根')
      assert.deepEqual(ws.blocks[0].children.map((x: { id: string }) => x.id), ['a', 'b'], '`left` 是源，`children` 是投影')
      assert.equal(ws.activeId, 'b1')
      assert.equal(ws.savedAt, 3)
    })
})

test('load：库里没有内容 ⇒ empty（不是 corrupt，也不是「库坏了」）', async () => {
  const { bridge } = fakeBridge({ status: 'empty' })
  assert.deepEqual(await createIpcAdapter(bridge).load(), { status: 'empty' })
})

test('load：没有库 ⇒ incompatible（不是 corrupt：这是「这个窗口没有库」）', async () => {
  const { bridge } = fakeBridge({ status: 'no-library' })
  const r = await createIpcAdapter(bridge).load()
  assert.equal(r.status, 'incompatible')
})

test('load：桥抛错 ⇒ storage-error（读不到 ≠ 库坏了）', async () => {
  const bridge: LibraryBridge = {
    libraryInfo: async () => ({}),
    load: async () => {
      throw new Error('ipc broke')
    },
    save: async () => ({ ok: true }),
    ...assetFace,
  }
  const r = await createIpcAdapter(bridge).load()
  assert.equal(r.status, 'storage-error')
})

test('commit：送的是**行写入**（不是整份字节），`replace` 一起带过去', async () => {
  const { bridge, saves } = fakeBridge()
  const port = createIpcAdapter(bridge)
  assert.equal(port.kind, IPC_BACKEND)
  assert.equal(port.consumes, 'rows', '接库的适配器要行写入，不要整份字节')
  const writes = [{ table: 'Block' as const, op: 'upsert' as const, key: { id: 'b1' }, values: { content: '[]' } }]
  const r = await port.commit({
    ops: [],
    changes: [{ kind: 'blocks', id: '*' }],
    writes,
    replace: true,
    savedAt: 99,
  })
  assert.deepEqual(r, { ok: true, savedAt: 99 })
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0]!.writes, writes)
  assert.equal(saves[0]!.opts?.replace, true, '整份替换必须如实转过去（否则增量写会漏掉模型里没被 op 说到的那部分）')
})

test('commit：主进程说失败 ⇒ 如实返回失败（不许假装存上）', async () => {
  const bridge: LibraryBridge = {
    libraryInfo: async () => ({}),
    load: async () => ({ status: 'empty' }),
    save: async () => ({ ok: false, error: 'disk full' }),
    ...assetFace,
  }
  const r = await createIpcAdapter(bridge).commit({
    ops: [],
    changes: [{ kind: 'blocks', id: '*' }],
    writes: [],
    savedAt: 1,
  })
  assert.equal(r.ok, false)
})

test('commit：单写者 —— 后一次提交永远排在前一次之后', async () => {
  const order: number[] = []
  const bridge: LibraryBridge = {
    libraryInfo: async () => ({}),
    load: async () => ({ status: 'empty' }),
    save: async (_writes, opts) => {
      // 第一次故意慢：串行的话第二次仍排在它后面
      await new Promise((r) => setTimeout(r, opts?.replace ? 30 : 0))
      order.push(opts?.replace ? 1 : 2)
      return { ok: true }
    },
    ...assetFace,
  }
  const port = createIpcAdapter(bridge)
  const batch = (savedAt: number, replace: boolean) => ({
    ops: [],
    changes: [{ kind: 'blocks' as const, id: '*' }],
    writes: [],
    replace,
    savedAt,
  })
  await Promise.all([port.commit(batch(1, true)), port.commit(batch(2, false))])
  assert.deepEqual(order, [1, 2], `提交必须串行，实际顺序：${order.join(',')}`)
})

test('clear：在库上**故意是空操作**（一条 reset 就是一次数据事故）', async () => {
  const { bridge } = fakeBridge()
  // 不应抛错，也不应删任何东西（假桥没有 clear 面 ⇒ 能通过就说明没调用）
  await createIpcAdapter(bridge).clear()
})
