/**
 * **地址归属的三态与创建路径的闸**。
 *
 * 这张表以前是「启动读全量地址表 → 在 JS 里建一张归一化 Map」。现在归属是**按名点查**，
 * 于是答案多了一种状态：**还没问过**。这三种状态各自对应一个必须做对的动作——
 *
 * | 状态 | 含义 | 创建路径该做什么 | 做错会怎样 |
 * |---|---|---|---|
 * | `owned` + 未装载 | 名字属于一个还没进的块 | 先装载／拒建 | 同一个名字出现两个身份 |
 * | `absent` | **问过了**，库里没有 | 新建 | 无（这是正常路径） |
 * | `unchecked` | 内存里没有、也没问过 | **先去问，再重放** | 把「还没问」当「没有」→ 重复身份 |
 *
 * 这三条分别能被独立推翻：整库模式把 `absent` 判成 `unchecked`（①）、问过不记账（②）、
 * 闸把未核定当放行（③④）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock } from '../src/core/model/model.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { ensureTagInTx } from '../src/core/kb/ensure-tag.ts'
import { ensurePageInTx } from '../src/core/identity/pages.ts'
import { deferAliasGate } from '../src/core/kb/alias-gate.ts'
import { AliasUncheckedError, UnloadedAliasError } from '../src/core/kb/unsupported.ts'
import type { Block } from '../src/core/model/model.ts'
import type { Tx } from '../src/core/kb/types.ts'

/** 一个只在内存里的工作集：`loaded` 有值 ⇒ `partial === true` */
function worksetStore(): { store: BlockStore; local: Block } {
  const local = mkBlock('本地块')
  local.props = { _aliases: ['本地名'] }
  const store = new BlockStore([local])
  store.setWorkset([local], new Set([local.id]))
  return { store, local }
}

/** 只记「建了什么」的假事务：拒建那几条根本走不到写，写路径只验 abscent 这一支 */
function fakeTx(): { tx: Tx; inserted: unknown[] } {
  const inserted: unknown[] = []
  const tx = {
    insert: (b: unknown) => void inserted.push(b),
    setLists: () => undefined,
    setProp: () => undefined,
    patch: () => undefined,
    setTags: () => undefined,
    restore: () => undefined,
  } as unknown as Tx
  return { tx, inserted }
}

test('① 整库模式：查不到就是 absent（索引覆盖全库，不存在「还没问」）', () => {
  const { store } = worksetStore()
  store.reset([mkBlock('甲')])
  assert.equal(store.partial, false)
  assert.deepEqual(store.aliasState('随便什么'), { kind: 'absent' })
})

test('② 工作集模式：没问过是 unchecked，问过就成定论（只问一次）', async () => {
  const { store } = worksetStore()
  const asked: string[][] = []
  store.setAliasResolver(async (norms) => {
    asked.push([...norms])
    return new Map([['远端名', 'remote-block']])
  })

  assert.deepEqual(store.aliasState('远端名'), { kind: 'unchecked' })
  await store.prepareAlias(['远端名', '真没有'])
  assert.deepEqual(asked, [['远端名', '真没有']], '一次问一批')
  assert.deepEqual(store.aliasState('远端名'), { kind: 'owned', id: 'remote-block', loaded: false })
  assert.deepEqual(store.aliasState('真没有'), { kind: 'absent' })
  assert.equal(store.aliasTargetId('远端名'), 'remote-block')

  await store.prepareAlias(['远端名'])
  assert.equal(asked.length, 1, '问过的名字不再问（会话内定论）')
})

test('② 索引优先：已装载块的地址当场回答，不看远端答案', async () => {
  const { store, local } = worksetStore()
  store.setAliasResolver(async () => new Map([['本地名', 'someone-else']]))
  assert.deepEqual(store.aliasState('本地名'), { kind: 'owned', id: local.id, loaded: true })
})

test('② 问不到 ≠ 没有：解析器失败留成 unchecked（调用方据此拒建）', async () => {
  const { store } = worksetStore()
  store.setAliasResolver(async () => {
    throw new Error('library down')
  })
  await store.prepareAlias(['某个名'])
  assert.deepEqual(store.aliasState('某个名'), { kind: 'unchecked' })
})

test('② 事实只对未装载的块有发言权：目标装载后被改名 ⇒ 旧事实弃掉、重新问', async () => {
  const { store, local } = worksetStore()
  store.setAliasResolver(async () => new Map([['远端名', 'remote-block']]))
  await store.prepareAlias(['远端名'])
  assert.equal(store.aliasState('远端名').kind, 'owned')

  // 「加载」那块并给它改个名：索引是活的，它已经不再认领旧名字
  const remote = mkBlock('远端块')
  remote.id = 'remote-block'
  remote.props = { _aliases: ['改过的名'] }
  store.setWorkset([local, remote], new Set([local.id, remote.id]))
  assert.deepEqual(
    store.aliasState('远端名'),
    { kind: 'unchecked' },
    '装载过的块由索引回答；旧事实弃掉（不拿过期答案拒建，也不假装它没有）',
  )
  assert.deepEqual(store.aliasState('改过的名'), { kind: 'owned', id: 'remote-block', loaded: true })
})

test('② 换库：名字事实随旧库一起清掉', async () => {
  const { store } = worksetStore()
  store.setAliasResolver(async () => new Map([['旧库名', 'old-block']]))
  await store.prepareAlias(['旧库名'])
  assert.equal(store.aliasState('旧库名').kind, 'owned')
  store.reset([mkBlock('新库的块')])
  assert.equal(store.partial, false)
  assert.deepEqual(store.aliasState('旧库名'), { kind: 'absent' }, '整库模式下旧事实不再参与判断')
})

test('③ 创建路径：未核定 ⇒ 抛；未装载 ⇒ 抛；确认没有 ⇒ 建块', async () => {
  const { store } = worksetStore()
  const lookup = { aliasState: (n: string) => store.aliasState(n) }
  const { tx, inserted } = fakeTx()

  assert.throws(() => ensureTagInTx({ ...lookup, findTag: () => undefined, resolveAlias: () => undefined, roots: () => store.blocks }, '新名', tx), AliasUncheckedError)

  store.setAliasResolver(async () => new Map([['占着', 'somewhere-else']]))
  await store.prepareAlias(['占着', '真没有'])
  const base = { ...lookup, findTag: () => undefined, resolveAlias: () => undefined, roots: () => store.blocks }
  assert.throws(() => ensureTagInTx(base, '占着', tx), UnloadedAliasError, '名字归一个未装载的块 ⇒ 不新建')
  assert.equal(ensureTagInTx(base, '真没有', tx) !== null, true)
  assert.equal(inserted.length, 1)

  assert.throws(() => ensurePageInTx({ ...lookup, resolveAlias: () => undefined, roots: () => store.blocks }, '未核定的页', tx), AliasUncheckedError)
})

test('④ 闸：未核定 ⇒ 先问再重放；问不到 ⇒ 不重放（别在原地打转）', async () => {
  const { store } = worksetStore()
  let replays = 0
  let fail = false
  store.setAliasResolver(async () => {
    if (fail) throw new Error('library down')
    return new Map()
  })

  assert.equal(
    deferAliasGate(store, '待问', () => void (replays += 1)),
    true,
    '接住了这次动作',
  )
  assert.equal(replays, 0, '异步回来之前不重放')
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(replays, 1, '问到了（absent）⇒ 重放')
  assert.equal(deferAliasGate(store, '待问', () => undefined), false, '已核定 ⇒ 放行')

  fail = true
  assert.equal(deferAliasGate(store, '又问一次', () => void (replays += 1)), true)
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(replays, 1, '问不到 ⇒ 不重放')
  assert.deepEqual(store.aliasState('又问一次'), { kind: 'unchecked' })
})
