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
import {
  createDeviceStore,
  createLocalStorageAdapter,
  DEFAULT_DOCK,
  DEFAULT_PREFS,
  DEVICE_KEY,
  LIBRARY_STATE_KEY,
  normalizePrefs,
  type LibrarySettingsPort,
  type Prefs,
} from '../src/core/infra/workspace.ts'
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
        { kind: 'cmd', command: 'core.journal/today' },
        { kind: 'cmd', command: 'core.page/new' },
        { kind: 'cmd', command: 'core.command-palette/show' },
        { kind: 'cmd', command: 'core.journal/prev' },
        // 日历卡：默认就在左槽（它是「去某一天」的入口，与上面四颗快捷同一档）
        { kind: 'derived', card: 'calendar' },
        { kind: 'derived', card: 'belongs' },
      ],
    },
    right: {
      open: true,
      width: null,
      cards: [
        { kind: 'derived', card: 'inspect' },
        { kind: 'derived', card: 'mount' },
        { kind: 'derived', card: 'trash' },
      ],
    },
    collapsedCards: {},
    pinnedCards: {},
    solo: { left: null, right: null },
  })
}

test('device: 从没存过 ⇒ 默认偏好与空折叠表（调用方不必再兜底）', async () => {
  resetMemoryLocalStorage()
  const loaded = await store(freshKey()).load()
  assertDefaults(loaded.prefs)
  assert.deepEqual(loaded.folded, {}, '没有折叠记录 ＝ 全展开')
})

test('device: 派生栏的看法是设备状态：坏键/坏值丢掉，允许的两档留下', () => {
  const p = normalizePrefs({
    mountViews: {
      'block:b1:refs': 'table',
      'block:b1:mentions': 'table',
      'block:b1:same': 'outline',
      'journal:refs': 'table',
      // 坏值/坏键：丢掉（不是回退成某个值 —— 「没选过」是另一件事）
      'block:b2:refs': 'list',
      'block:b3:refs': 42,
      '': 'table',
    } as unknown as Prefs['mountViews'],
  })
  assert.deepEqual(p.mountViews, {
    'block:b1:refs': 'table',
    'block:b1:mentions': 'table',
    'block:b1:same': 'outline',
    'journal:refs': 'table',
  })
  assert.deepEqual(normalizePrefs({ mountViews: ['nope'] as unknown as Prefs['mountViews'] }).mountViews, {}, '不是对象 ⇒ 空')
  assert.deepEqual(normalizePrefs(undefined).mountViews, {}, '缺字段 ⇒ 空')
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
        left: {
          open: false,
          width: 312,
          cards: [{ kind: 'derived', card: 'belongs' }, { kind: 'block', block: 'b1' }, { kind: 'block', block: 'b2' }],
        },
        right: { open: true, width: null, cards: [{ kind: 'derived', card: 'inspect' }] },
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
  assert.deepEqual(loaded.prefs.dock.left, {
    open: false,
    width: 312,
    cards: [{ kind: 'derived', card: 'belongs' }, { kind: 'block', block: 'b1' }, { kind: 'block', block: 'b2' }],
  })
  assert.deepEqual(loaded.prefs.dock.right, { open: true, width: null, cards: [{ kind: 'derived', card: 'inspect' }] })
  assert.deepEqual(loaded.prefs.dock.collapsedCards, { belongs: true })
  assert.deepEqual(loaded.prefs.dock.solo, { left: 'b1', right: null })
  assert.deepEqual(loaded.folded, { b1: true, b2: true })
})

test('device: 用户键位覆盖存了再读原样回来；坏形状（空身份 / 非键位值）丢掉', () => {
  const p = normalizePrefs({
    keys: {
      'core.history/undo|null': 'mod+u',
      'core.history/redo|null': null,
      '': 'mod+x',
      bad: 42,
    },
  })
  assert.deepEqual(p.keys, { 'core.history/undo|null': 'mod+u', 'core.history/redo|null': null }, '空身份与非键位值不进偏好')
  const roundTrip = normalizePrefs({ ...p, railOpen: undefined })
  assert.deepEqual(roundTrip.keys, p.keys)
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
  assert.deepEqual((await store(legacy).load()).prefs.dock.left.cards, [
    ...DEFAULT_DOCK.left.cards,
    { kind: 'block', block: 'a' },
    { kind: 'block', block: 'b' },
  ])

  // `cards` 一旦存在就只认它：旧 `pins` 里剩下的 id 不回来
  const next = freshKey()
  await createLocalStorageAdapter(next).commit({
    changes: [],
    payload: JSON.stringify({
      prefs: {
        dock: {
          left: { open: true, pins: ['a', 'b'], cards: ['belongs', 'calendar', 'a'] },
        },
      },
    }),
    savedAt: 1,
  })
  assert.deepEqual((await store(next).load()).prefs.dock.left.cards, [
    { kind: 'derived', card: 'belongs' },
    { kind: 'derived', card: 'calendar' },
    { kind: 'block', block: 'a' },
  ])
})

test('device: 旧 `pins` 并进来的块窗口就是已 pin（重启清理不碰它们）；缺字段 ⇒ 空 pin 表', async () => {
  resetMemoryLocalStorage()
  const legacy = freshKey()
  await createLocalStorageAdapter(legacy).commit({
    changes: [],
    payload: JSON.stringify({ prefs: { dock: { left: { open: true, pins: ['a'] } } } }),
    savedAt: 1,
  })
  const loaded = await store(legacy).load()
  assert.deepEqual(loaded.prefs.dock.pinnedCards, { a: true })

  // 没有 `pins` 也没有 `pinnedCards` 的旧字节 ⇒ 空 pin 表（非 pin 窗口交给启动清理）
  const bare = freshKey()
  await createLocalStorageAdapter(bare).commit({
    changes: [],
    payload: JSON.stringify({ prefs: { theme: 'light' } }),
    savedAt: 1,
  })
  assert.deepEqual((await store(bare).load()).prefs.dock.pinnedCards, {})
})

test('device: `pinnedCards` 存了再读原样回来；坏形状（非 true 值／非对象）丢掉', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  const s = store(key)
  const saved = await s.save({
    prefs: { ...DEFAULT_PREFS, dock: { ...DEFAULT_PREFS.dock, pinnedCards: { b1: true } } },
    folded: {},
  })
  assert.equal(saved.ok, true)
  assert.deepEqual((await s.load()).prefs.dock.pinnedCards, { b1: true })

  const bad = freshKey()
  await createLocalStorageAdapter(bad).commit({
    changes: [],
    payload: JSON.stringify({ prefs: { dock: { pinnedCards: { b1: false, b2: 'yes', '': true } } } }),
    savedAt: 1,
  })
  assert.deepEqual((await store(bad).load()).prefs.dock.pinnedCards, {})
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
  assert.deepEqual(dock.left.cards, [{ kind: 'derived', card: 'belongs' }, { kind: 'block', block: 'a' }])
  assert.deepEqual(dock.right.cards, [{ kind: 'derived', card: 'inspect' }], '同一个块/派生卡不同时留在两边')
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
        left: { open: true, width: null, cards: [{ kind: 'cmd', command: 'core.journal/today' }, { kind: 'derived', card: 'belongs' }] },
        right: { open: true, width: null, cards: [{ kind: 'cmd', command: 'core.journal/today' }, { kind: 'derived', card: 'inspect' }] },
        collapsedCards: {},
        solo: { left: null, right: null },
      },
    },
    folded: {},
  })
  const dock = (await store(key).load()).prefs.dock
  assert.deepEqual(dock.left.cards, [
    { kind: 'cmd', command: 'core.journal/today' },
    { kind: 'derived', card: 'belongs' },
  ])
  assert.deepEqual(
    dock.right.cards,
    [{ kind: 'cmd', command: 'core.journal/today' }, { kind: 'derived', card: 'inspect' }],
    'cmd 不是块，不参与「一个块最多一张窗口」的去重',
  )
})

test('device: 左右槽去重摊平一层：同一颗快捷卡不该同时躺在两槽的盘里；盘空了解散', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  await store(key).save({
    prefs: {
      ...DEFAULT_PREFS,
      dock: {
        left: {
          open: true,
          width: null,
          cards: [{ kind: 'shortcut', block: 's1' }, { kind: 'shortcut', block: 's2' }, { kind: 'derived', card: 'belongs' }],
        },
        right: {
          open: true,
          width: null,
          cards: [
            {
              kind: 'tray',
              id: 't1',
              title: '收着',
              cards: [{ kind: 'shortcut', block: 's1' }, { kind: 'cmd', command: 'core.page/new' }],
            },
            { kind: 'tray', id: 't2', cards: [{ kind: 'shortcut', block: 's2' }] },
          ],
        },
        collapsedCards: {},
        solo: { left: null, right: null },
      },
    },
    folded: {},
  })
  const dock = (await store(key).load()).prefs.dock
  // s1/s2 都在左槽已有：右槽盘里那几份被摘走；t1 还剩 cmd、t2 全被摘走 ⇒ 空盘解散
  assert.deepEqual(dock.right.cards, [
    {
      kind: 'tray',
      id: 't1',
      title: '收着',
      cards: [{ kind: 'cmd', command: 'core.page/new' }],
    },
  ])
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

/* ------------------------------------------------------------ 库侧状态（库的 settings 表） */

/** 判据：引用块 id 或指涉某个库布局的状态跟着库走（dock／折叠／露面视图／日记栏）；纯外观与设备能力留设备。 */

const fakeLibrary = (): { map: Map<string, string>; port: LibrarySettingsPort } => {
  const map = new Map<string, string>()
  return {
    map,
    port: {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => {
        map.set(k, v)
        return { ok: true as const }
      },
    },
  }
}

test('库侧状态：dock/折叠/露面视图/日记栏**只**从库侧读；qua.device 里的旧值不再被读（孤儿化）', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  // 设备键里留着一份「别库的孤儿」：换库前的旧 dock 与折叠表
  await createLocalStorageAdapter(key).commit({
    changes: [],
    payload: JSON.stringify({
      prefs: { dock: { left: { open: false, width: 99, cards: [{ kind: 'derived', card: 'belongs' }] } } },
      folded: { stale: true },
    }),
    savedAt: 1,
  })
  const lib = fakeLibrary()
  const loaded = await createDeviceStore(createLocalStorageAdapter(key), lib.port).load()
  assert.deepEqual(loaded.folded, {}, '折叠表跟库走：库侧没有 ⇒ 空（不捡设备键里的孤儿）')
  assert.equal(loaded.prefs.dock.left.open, true, 'dock 跟库走：库侧没有 ⇒ 默认（不是孤儿值）')
  assert.equal(loaded.prefs.dock.left.width, null)
})

test('库侧状态：存了再读，四格从库侧回来；主题等设备格仍从设备键回来', async () => {
  resetMemoryLocalStorage()
  const key = freshKey()
  const lib = fakeLibrary()
  const s = createDeviceStore(createLocalStorageAdapter(key), lib.port)
  const saved = await s.save({
    prefs: {
      ...DEFAULT_PREFS,
      theme: 'dark',
      dock: { ...DEFAULT_DOCK, left: { open: false, width: 260, cards: [...DEFAULT_DOCK.left.cards] } },
      mountViews: { 'journal:refs': 'table' },
      journalMounts: [{ id: 'j1', kind: 'derived', source: 'refs' }],
    },
    folded: { b1: true },
  })
  assert.equal(saved.ok, true)

  // 库侧字节确实落在库的 settings（这份键的第一个消费者）
  const raw = lib.map.get(LIBRARY_STATE_KEY)
  assert(typeof raw === 'string', '库侧状态应当写进库的 settings')
  const parsed = JSON.parse(raw!) as { dock?: unknown; folded?: unknown; mountViews?: unknown; journalMounts?: unknown }
  assert.deepEqual(parsed.folded, { b1: true })
  assert.deepEqual(parsed.mountViews, { 'journal:refs': 'table' })
  assert.deepEqual(parsed.journalMounts, [{ id: 'j1', kind: 'derived', source: 'refs' }])
  assert.ok((parsed.dock as { left?: { width?: unknown } }).left?.width === 260, 'dock 整格一起走（不拆形状）')

  // 把设备键换成一份**没有**这四格的字节：四格仍从库侧回来，主题跟着设备键走
  await createLocalStorageAdapter(key).commit({
    changes: [],
    payload: JSON.stringify({ prefs: { theme: 'light' } }),
    savedAt: 2,
  })
  const loaded = await s.load()
  assert.equal(loaded.prefs.theme, 'light', '主题是设备格：从设备键回来')
  assert.equal(loaded.prefs.dock.left.open, false, 'dock 是库格：从库侧回来')
  assert.equal(loaded.prefs.dock.left.width, 260)
  assert.deepEqual(loaded.folded, { b1: true })
  assert.deepEqual(loaded.prefs.mountViews, { 'journal:refs': 'table' })
  assert.deepEqual(loaded.prefs.journalMounts, [{ id: 'j1', kind: 'derived', source: 'refs' }])
})

test('库侧状态：库侧写失败 ⇒ save 如实报失败（不许假装存上了）', async () => {
  resetMemoryLocalStorage()
  const failing: LibrarySettingsPort = {
    get: async () => null,
    set: async () => ({ ok: false as const, error: new Error('settings write failed') }),
  }
  const s = createDeviceStore(createLocalStorageAdapter(freshKey()), failing)
  const r = await s.save({ prefs: DEFAULT_PREFS, folded: {} })
  assert.equal(r.ok, false, '库侧写不进去必须如实报')
})
