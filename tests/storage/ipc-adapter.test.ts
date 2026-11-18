/**
 * 库存储适配器（渲染层，经 IPC）—— 与 localStorage 适配器同一个端口。
 *
 * 判据：
 *   ① **提交送的是行写入**，不是整份字节 —— 这是「写成本不随库体量增长」的落地面；
 *   ② 失败**如实返回**（不许假装存上）；
 *   ③ 单写者：后一次提交永远排在前一次之后。
 *
 * 读不走这里：桌面读面是 `LibraryClient` 的具名查询（`library-client.test.ts`），
 * 没有一条能一次读走整库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE_VERSION } from '../../src/core/infra/workspace.ts'
import { createIpcAdapter, IPC_BACKEND, type LibraryBridge } from '../../src/core/storage/ipc-adapter.ts'
import { judge } from '../../src/core/storage/index.ts'

/** 桥的资产面：本文件不测它（在 storage/asset-ipc.test.ts），但 `LibraryBridge` 的形状要求它在 */
const assetFace = {
  assetIndex: async () => ({ status: 'ok', rows: [] }),
  assetPut: async () => ({ status: 'bad-args' }),
}

/** 一个记下「收到了什么」的假桥 */
function fakeBridge(): {
  bridge: LibraryBridge
  saves: { writes: unknown[]; opts?: { replace?: boolean } }[]
} {
  const saves: { writes: unknown[]; opts?: { replace?: boolean } }[] = []
  return {
    saves,
    bridge: {
      libraryInfo: async () => ({ status: 'ok' }),
      save: async (writes, opts) => {
        saves.push({ writes, opts })
        return { ok: true }
      },
      ...assetFace,
    },
  }
}

test('judge：字节装载的版本门禁与形状校验', () => {
  const ws = {
    version: WORKSPACE_VERSION,
    activeId: 'root',
    savedAt: 3,
    blocks: [
      {
        id: 'root',
        content: [],
        created: 1,
        modified: 1,
        children: [
          { id: 'a', content: [], created: 1, modified: 1, children: [] },
          { id: 'b', content: [], created: 1, modified: 1, children: [] },
        ],
      },
    ],
  }
  const r = judge({ status: 'ok', raw: JSON.stringify(ws) })
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.equal(r.ws.blocks.length, 1, '只有一个顶层根')
  assert.deepEqual(r.ws.blocks[0]!.children.map((x) => x.id), ['a', 'b'])
  assert.deepEqual(judge({ status: 'ok', raw: JSON.stringify({ ...ws, version: WORKSPACE_VERSION + 1 }) }), {
    status: 'too-new',
    version: WORKSPACE_VERSION + 1,
  })
  assert.deepEqual(judge({ status: 'ok', raw: JSON.stringify({ ...ws, blocks: [] }) }), {
    status: 'corrupt',
    reason: 'shape',
  })
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
