/**
 * 设备状态（`qua.device`）的契约测试：跑**真实现**（`createDeviceStore` ＋ localStorage 适配器 ＋ 内存后端）。
 *
 * 这里钉的是三件上层要依赖的事：
 *   1. 从没存过 ⇒ 默认值（不是 `undefined`，调用方不必到处 `??`）；
 *   2. 存了再读 ⇒ 原样回来（主题／槽宽／钉住的块／折叠表）；
 *   3. 字节坏了 / 是别的后端留下的 ⇒ **回落默认**，不抛、不崩、不进只读态——
 *      设备状态不是内容，没有「打不开」这种状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceStore, createLocalStorageAdapter, DEFAULT_DOCK, DEFAULT_PREFS, DEVICE_KEY, type Prefs } from '../src/core/workspace.ts'
import { installMemoryLocalStorage, peekMemoryLocalStorage, resetMemoryLocalStorage } from './storage/test-local-storage.ts'

installMemoryLocalStorage()

/** 每个用例换一个键，避免互相看到对方存的偏好 */
let seq = 0
const freshKey = (): string => `${DEVICE_KEY}-test-${++seq}`

const store = (key: string) => createDeviceStore(createLocalStorageAdapter(key))

/** 默认值逐格比（`normalizePrefs` 会带上 `railOpen: undefined`，整对象 deepEqual 会差一个键） */
function assertDefaults(p: Prefs): void {
  assert.equal(p.theme, 'system')
  assert.equal(p.virtualize, false)
  assert.equal(p.radius, 12)
  assert.equal(p.badgeOpen, false)
  assert.deepEqual(p.dock, {
    left: {
      open: true,
      width: null,
      cards: [
        'cmd:core.journal/today',
        'cmd:core.page/new',
        'cmd:core.command-palette/show',
        'cmd:core.journal/prev',
        // 日历卡：默认就在左槽（它是「去某一天」的入口，与上面四颗快捷同一档）
        'calendar',
        'belongs',
        'journal',
      ],
    },
    right: { open: true, width: null, cards: ['inspect', 'backrefs', 'trash'] },
    collapsedCards: {},
    solo: { left: null, right: null },
  })
}

test('device: 从没存过 ⇒ 默认偏好与空折叠表（调用方不必再兜底）', async () => {
  resetMemoryLocalStorage()
  const loaded = await store(freshKey()).load()
  assertDefaults(loaded.prefs)
  assert.deepEqual(loaded.folded, {}, '没有折叠记录 ＝ 全展开')
})

test('device: 存了再读 ⇒ 主题／槽宽／钉住都原样回来', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  const s = store(key)
  const saved = await s.save({
    prefs: {
      ...DEFAULT_PREFS,
      theme: 'dark',
      virtualize: true,
      radius: 28,
      dock: {
        left: { open: false, width: 312, cards: ['belongs', 'b1', 'b2'] },
        right: { open: true, width: null, cards: ['inspect'] },
        collapsedCards: { belongs: true },
        solo: { left: 'b1', right: null },
      },
    },
    folded: { b1: true, b2: true },
  })
  assert.equal(saved.ok, true)

  const loaded = await s.load()
  assert.equal(loaded.prefs.theme, 'dark')
  assert.equal(loaded.prefs.virtualize, true)
  assert.equal(loaded.prefs.radius, 28)
  assert.deepEqual(loaded.prefs.dock.left, { open: false, width: 312, cards: ['belongs', 'b1', 'b2'] })
  assert.deepEqual(loaded.prefs.dock.right, { open: true, width: null, cards: ['inspect'] })
  assert.deepEqual(loaded.prefs.dock.collapsedCards, { belongs: true })
  assert.deepEqual(loaded.prefs.dock.solo, { left: 'b1', right: null })
  assert.deepEqual(loaded.folded, { b1: true, b2: true })
})

test('device: 缺字段只补默认（与库无关：旧字节里没有的键不崩）', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  const port = createLocalStorageAdapter(key)
  await port.commit({
    changes: [],
    payload: JSON.stringify({ prefs: { theme: 'light' } }),
    savedAt: 1,
  })
  const loaded = await store(key).load()
  assert.equal(loaded.prefs.theme, 'light')
  assert.deepEqual(loaded.prefs.dock, DEFAULT_PREFS.dock)
  assert.equal(loaded.prefs.radius, DEFAULT_PREFS.radius)
  assert.deepEqual(loaded.folded, {}, '缺这一格 ⇒ 空表，不是 `undefined`')
})

test('device: 旧设备状态的 `pins` 只在 `cards` 缺失时并入一次（不复活已删的窗口）', async () => {
  resetMemoryLocalStorage()
  const legacy = freshKey()
  await createLocalStorageAdapter(legacy).commit({
    changes: [],
    payload: JSON.stringify({ prefs: { dock: { left: { open: true, pins: ['a', 'b'] } } } }),
    savedAt: 1,
  })
  assert.deepEqual((await store(legacy).load()).prefs.dock.left.cards, [...DEFAULT_DOCK.left.cards, 'a', 'b'])

  // `cards` 一旦存在就只认它：旧 `pins` 里剩下的 id 不回来
  const next = freshKey()
  await createLocalStorageAdapter(next).commit({
    changes: [],
    payload: JSON.stringify({
      prefs: {
        dock: {
          left: { open: true, pins: ['a', 'b'], cards: ['belongs', 'journal', 'a'] },
        },
      },
    }),
    savedAt: 1,
  })
  assert.deepEqual((await store(next).load()).prefs.dock.left.cards, ['belongs', 'journal', 'a'])
})

test('device: 一个 id 不留在两个槽（左先到先得）；solo 指向不在本槽的 id ⇒ 清空', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  await createLocalStorageAdapter(key).commit({
    changes: [],
    payload: JSON.stringify({
      prefs: {
        dock: {
          left: { open: true, cards: ['belongs', 'a'] },
          right: { open: true, cards: ['a', 'inspect'] },
          solo: { left: 'zzz', right: 'a' },
        },
      },
    }),
    savedAt: 1,
  })
  const dock = (await store(key).load()).prefs.dock
  assert.deepEqual(dock.left.cards, ['belongs', 'a'])
  assert.deepEqual(dock.right.cards, ['inspect'], '同一个 id 不同时留在两边')
  assert.deepEqual(dock.solo, { left: null, right: null }, 'solo 目标必须在自己槽的清单里')
})

test('device: 折叠表只留 `true`（坏键 / false / 空 key 一律丢），整格坏 ⇒ 空表', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  const port = createLocalStorageAdapter(key)
  await port.commit({
    changes: [],
    // `false` 与「不在表里」是同一件事；留着它就会出现「表里有这行、但它是展开的」第三态
    payload: JSON.stringify({ prefs: {}, folded: { b1: true, b2: false, '': true, b3: 1, b4: 'true' } }),
    savedAt: 1,
  })
  assert.deepEqual((await store(key).load()).folded, { b1: true }, '一个坏键不该连累整张表')

  // 整格不是对象：设备状态没有「打不开」分支，只是当作全展开
  for (const bad of [[], 'x', 0, null, true]) {
    const k = freshKey()
    await createLocalStorageAdapter(k).commit({
      changes: [],
      payload: JSON.stringify({ prefs: {}, folded: bad }),
      savedAt: 1,
    })
    assert.deepEqual((await store(k).load()).folded, {}, `folded=${JSON.stringify(bad)} 应回空表`)
  }
})

test('device: 偏好与折叠表互不连累：一格坏了只回落那一格', async () => {
  resetMemoryLocalStorage()
  const save = async (payload: unknown): Promise<string> => {
    const k = freshKey()
    await createLocalStorageAdapter(k).commit({ changes: [], payload: JSON.stringify(payload), savedAt: 1 })
    return k
  }

  // 偏好坏、折叠表好 ⇒ 偏好回默认，折叠记录还在
  const a = await store(await save({ prefs: 'x', folded: { b1: true } })).load()
  assertDefaults(a.prefs)
  assert.deepEqual(a.folded, { b1: true })

  // 折叠表坏、偏好好 ⇒ 全展开，主题仍是用户选的那一档
  const b = await store(await save({ prefs: { theme: 'dark' }, folded: { b1: false } })).load()
  assert.equal(b.prefs.theme, 'dark')
  assert.deepEqual(b.folded, {})
})

test('device: `cmd:` 不是块，同一个命令可以同时出现在两槽', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  await store(key).save({
    prefs: {
      ...DEFAULT_PREFS,
      dock: {
        left: { open: true, width: null, cards: ['cmd:core.journal/today', 'belongs'] },
        right: { open: true, width: null, cards: ['cmd:core.journal/today', 'inspect'] },
        collapsedCards: {},
        solo: { left: null, right: null },
      },
    },
    folded: {},
  })
  const dock = (await store(key).load()).prefs.dock
  assert.deepEqual(dock.left.cards, ['cmd:core.journal/today', 'belongs'])
  assert.deepEqual(dock.right.cards, ['cmd:core.journal/today', 'inspect'], 'cmd: 不是块，不参与「一个块最多一张窗口」的去重')
})

test('device: 坏字节 / 别的后端的字节 ⇒ 回默认，不抛也不改写原字节', async () => {
  resetMemoryLocalStorage()
  const brokenKey = freshKey()
  globalThis.localStorage.setItem(brokenKey, '{oops')
  assertDefaults((await store(brokenKey).load()).prefs)
  assert.equal(peekMemoryLocalStorage(brokenKey), '{oops', '读坏时不许顺手覆盖（留给用户自己救）')

  const foreignKey = freshKey()
  globalThis.localStorage.setItem(foreignKey, JSON.stringify({ some: 'other-backend' }))
  const foreign = await store(foreignKey).load()
  assertDefaults(foreign.prefs)
  assert.deepEqual(foreign.folded, {})
})
