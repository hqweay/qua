/**
 * **落盘状态机**：成功才推进、失败保留批次、在途串行、换库不串状态。
 *
 * 这里不测存储实现（那是 `storage.test.ts`／`swap-workspace.test.ts` 的事），
 * 只测装配层的**状态推进时机**——它是「用户以为存上了、下次打开又没了」的唯一来源。
 *
 * 四条判据：
 *   ① 失败的非 genesis 批次放回队首：下一次保存送出的是**同一批**，不是空批；
 *   ② genesis 失败后仍是 genesis：下一次保存仍用 `replace`，不把「盘上还没有这份模型」忘掉；
 *   ③ 在途期间的 `saveNow()` 只记一次「再落一批」，不许两批并发拿走同一份队列；
 *   ④ 换库（`clearPendingOps`）后的在途旧批次：成功不推进新库状态，
 *      失败不回填新库队列。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setupPersistence } from '../src/app/wiring/persistence.ts'
import type { Op } from '../src/core/kb/types.ts'

type CommitResult = { ok: true } | { ok: false; error: unknown }
type Call = { ops: Op[]; replace: boolean }

/** 一个最小装配：真 `setupPersistence`，假 store／DOM／提示链路 */
function harness(
  commit: (ops: readonly Op[], replace: boolean) => Promise<CommitResult>,
  opts: { loadedFromDisk?: boolean } = {},
) {
  const calls: Call[] = []
  const g = globalThis as unknown as {
    window: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; addEventListener: () => void }
    document: { addEventListener: () => void }
  }
  g.window = { setTimeout, clearTimeout, addEventListener: () => {} }
  g.document = { addEventListener: () => {} }

  const ws = { blocks: [], activeId: '', savedAt: 0 }
  const deps = {
    store: {
      commit: (_ws: unknown, ops: readonly Op[], o?: { replace?: boolean }) => {
        calls.push({ ops: [...ops], replace: o?.replace === true })
        return commit(ops, o?.replace === true)
      },
    },
    deviceStore: { save: async () => ({ ok: true as const }), settle: async () => {} },
    device: { folded: {} },
    blocks: { blocks: [], swapCount: 0 },
    kb: {},
    bootState: { readOnly: false, notice: null as string | null },
    loadedFromDisk: opts.loadedFromDisk !== false,
    bootOps: [],
    errText: (e: unknown) => String(e),
    layers: { toast: () => {} },
    getChrome: () => ({ showNotice: () => {} }),
    getWs: () => ws,
    getMainEd: () => undefined,
    isQuiet: () => true,
  }
  // setupPersistence 的依赖面比这里列的多；测试只碰落盘路径，其余保持空实现
  const p = setupPersistence(deps as never)
  return { p, calls }
}

const op = (id: string): Op => ({ e: 'block', id, op: 'exist', state: 'deleted', at: 1 })

/** 让「then/finally/定时器 0」都跑完 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  await Promise.resolve()
}

test('失败的非 genesis 批次放回队首：下一次保存送出同一批，不是空批', async () => {
  let fail = true
  const { p, calls } = harness(async () => (fail ? { ok: false, error: new Error('disk') } : { ok: true }))
  const batch = op('a')
  p.addOps([batch])
  p.saveNow()
  await flush()
  assert.equal(calls.length, 1, '第一次应发出')
  assert.deepEqual(calls[0]!.ops, [batch])
  assert.equal(calls[0]!.replace, false)

  fail = false
  p.saveNow()
  await flush()
  assert.equal(calls.length, 2, '失败后下一次应重发')
  assert.deepEqual(calls[1]!.ops, [batch], '失败批次不许被清掉')
  p.clearPendingOps()
})

test('genesis 失败后仍按 genesis 重发；成功后才转增量', async () => {
  let fail = true
  const { p, calls } = harness(async () => (fail ? { ok: false, error: new Error('disk') } : { ok: true }), {
    loadedFromDisk: false,
  })
  p.saveNow()
  await flush()
  assert.equal(calls[0]!.replace, true, '第一笔是 genesis')

  fail = false
  p.saveNow()
  await flush()
  assert.equal(calls[1]!.replace, true, '失败后仍是 genesis，不能把「盘上还没这份模型」忘掉')

  p.saveNow()
  await flush()
  assert.equal(calls[2]!.replace, false, 'genesis 成功后下一笔才是增量')
  p.clearPendingOps()
})

test('在途期间的 saveNow 只记一次跟随批次：不许两批并发', async () => {
  let release: (() => void) | null = null
  const gate = new Promise<void>((r) => {
    release = r
  })
  let n = 0
  const { p, calls } = harness(async () => {
    n++
    if (n === 1) await gate
    return { ok: true }
  })
  p.addOps([op('a')])
  p.saveNow()
  await flush()
  assert.equal(calls.length, 1)

  p.addOps([op('b')])
  p.saveNow()
  p.saveNow()
  await flush()
  assert.equal(calls.length, 1, '在途时不许再发一批')

  release!()
  await flush()
  await flush()
  assert.equal(calls.length, 2, '在途落完后只跟随一批')
  assert.deepEqual(calls[1]!.ops, [op('b')], '跟随批只含在途期间新产生的 op')
  p.clearPendingOps()
})

for (const oldFailed of [false, true]) {
  test(`换库后的在途旧批次（${oldFailed ? '失败' : '成功'}）：不推进新库状态、不回填新库队列`, async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => {
      release = r
    })
    let n = 0
    const { p, calls } = harness(async () => {
      n++
      if (n === 1) {
        await gate
        return oldFailed ? { ok: false, error: new Error('old') } : { ok: true }
      }
      return { ok: true }
    })

    p.addOps([op('old')])
    p.saveNow()
    await flush()
    assert.equal(calls.length, 1)

    // 换库：清队列 + 代数加一；新库的保存被排到在途之后
    p.clearPendingOps()
    p.addOps([op('new')])
    p.saveNow()
    await flush()
    assert.equal(calls.length, 1, '旧批在途时新库也排队')

    release!()
    await flush()
    await flush()
    assert.equal(calls.length, 2, '旧批落完后应发新库那一批')
    assert.deepEqual(calls[1]!.ops, [op('new')], '旧批不许回填／混进新库')
    p.clearPendingOps()
  })
}
