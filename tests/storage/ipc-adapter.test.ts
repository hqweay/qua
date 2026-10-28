/**
 * 库存储适配器（渲染层，经 IPC）—— 与 localStorage 适配器同一个端口。
 *
 * 判据（A1 的落地面）：
 *   ① **写库的字节里不带 `version`**：库的 schema 版本只有一个判据（`user_version`），
 *      payload 再带一份就制造「装载成功但按旧口径解释」的中间态；
 *   ② **读回来补回当前版本**：上层拿到的永远是一份 `version === WORKSPACE_VERSION` 的库；
 *   ③ 失败**如实返回**（不许假装存上）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WORKSPACE_VERSION } from '../../src/core/workspace.ts'
import { createIpcAdapter, IPC_BACKEND, stripVersion, withVersion, type LibraryBridge } from '../../src/core/storage/ipc-adapter.ts'

const lib = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: WORKSPACE_VERSION,
    blocks: [{ id: 'b1', content: [], children: [], created: 1, modified: 1 }],
    activeId: 'b1',
    savedAt: 3,
    ...patch,
  })

/** 一个记下「收到了什么」的假桥 */
function fakeBridge(reply: { status: string; json?: string } = { status: 'empty' }): {
  bridge: LibraryBridge
  saves: { json: string; savedAt: number }[]
} {
  const saves: { json: string; savedAt: number }[] = []
  return {
    saves,
    bridge: {
      libraryInfo: async () => ({ status: 'ok' }),
      load: async () => reply,
      save: async (json, savedAt) => {
        saves.push({ json, savedAt })
        return { ok: true, savedAt }
      },
    },
  }
}

test('stripVersion：写库的字节里**没有** version（唯一真相是 user_version）', () => {
  const stripped = stripVersion(lib())
  assert.equal('version' in JSON.parse(stripped), false, 'payload 不许自带版本：两份版本并存会产生「装载成功但按旧口径解释」')
  assert.equal(JSON.parse(stripped).activeId, 'b1', '其余字段一个都不许丢')
})

test('withVersion：读回来补成当前版本（上层永远拿到同一份形状）', () => {
  const back = JSON.parse(withVersion(stripVersion(lib())))
  assert.equal(back.version, WORKSPACE_VERSION)
})

test('stripVersion / withVersion：坏 JSON 原样返回（不吞错、不假装成功）', () => {
  assert.equal(stripVersion('{ not json'), '{ not json')
  assert.equal(withVersion('{ not json'), '{ not json')
})

test('commit：写进库的 payload 不带 version，但 savedAt 一起带上', async () => {
  const { bridge, saves } = fakeBridge()
  const port = createIpcAdapter(bridge)
  assert.equal(port.kind, IPC_BACKEND)
  const r = await port.commit({
    ops: [],
    changes: [{ kind: 'blocks', id: '*' }],
    payload: lib({ savedAt: 99 }),
    savedAt: 99,
  })
  assert.deepEqual(r, { ok: true, savedAt: 99 })
  assert.equal(saves.length, 1)
  assert.equal('version' in JSON.parse(saves[0]!.json), false, '落进库的字节不许带 version')
  assert.equal(JSON.parse(saves[0]!.json).savedAt, 99)
})

test('load：从库里读出来的内容补回当前版本（装载前不需要看 payload 的版本）', async () => {
  const { bridge } = fakeBridge({ status: 'ok', json: stripVersion(lib()) })
  const port = createIpcAdapter(bridge)
  const r = await port.load()
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.equal(JSON.parse(r.raw).version, WORKSPACE_VERSION)
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
  }
  const r = await createIpcAdapter(bridge).load()
  assert.equal(r.status, 'storage-error')
})

test('commit：主进程说失败 ⇒ 如实返回失败（不许假装存上）', async () => {
  const bridge: LibraryBridge = {
    libraryInfo: async () => ({}),
    load: async () => ({ status: 'empty' }),
    save: async () => ({ ok: false, error: 'disk full' }),
  }
  const r = await createIpcAdapter(bridge).commit({
    ops: [],
    changes: [{ kind: 'blocks', id: '*' }],
    payload: lib(),
    savedAt: 1,
  })
  assert.equal(r.ok, false)
})

test('commit：单写者 —— 后一次提交永远排在前一次之后', async () => {
  const order: number[] = []
  const bridge: LibraryBridge = {
    libraryInfo: async () => ({}),
    load: async () => ({ status: 'empty' }),
    save: async (_json, savedAt) => {
      // 第一次故意慢：串行的话第二次仍排在它后面
      await new Promise((r) => setTimeout(r, savedAt === 1 ? 30 : 0))
      order.push(savedAt)
      return { ok: true, savedAt }
    },
  }
  const port = createIpcAdapter(bridge)
  const batch = (savedAt: number) => ({ ops: [], changes: [{ kind: 'blocks' as const, id: '*' }], payload: lib(), savedAt })
  await Promise.all([port.commit(batch(1)), port.commit(batch(2))])
  assert.deepEqual(order, [1, 2], `提交必须串行，实际顺序：${order.join(',')}`)
})

test('clear：在库上**故意是空操作**（一条 reset 就是一次数据事故）', async () => {
  const { bridge } = fakeBridge()
  // 不应抛错，也不应删任何东西（假桥没有 clear 面 ⇒ 能通过就说明没调用）
  await createIpcAdapter(bridge).clear()
})
