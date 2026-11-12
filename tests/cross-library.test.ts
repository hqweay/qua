/**
 * 切库污染：**A 库的块 id 不许出现在 B 库里**。
 *
 * ## 为什么这条单独成组
 *
 * 多库落地之后（一库一窗、每库一份 `qua.db`），最容易出的形状是**静默的**：
 * 一份「跟着这台机器」的状态里存了块 id，切到另一个库之后那些 id 指向**不存在的块**
 * （或更糟：B 库里恰好存在同 id 的块，于是 A 的折叠态/卡片落到了 B 的块上）。
 * 两种都不报错——第一种表现为「折叠态全丢」，第二种表现为「某个块莫名其妙被收起」。
 *
 * ## 判据的落点（本仓已按这条切过一次）
 *
 * `core/storage/device.ts` 的归属判据：
 *   · **跟库走**：dock 整格、折叠表、露面视图 `mountViews`、日记栏 `journalMounts`
 *     —— 它们的值全是块 id 或「这个库的槽里摆了什么」⇒ 住库的 `settings` 表；
 *   · **留设备**：主题、虚拟化、badge、段排列 —— 这台机器怎么看，与哪个库无关。
 *
 * 代码已经这么写了（`mergeLibraryState` 明确不捡设备键里的孤儿）。**但没有断言
 * 钉住「两个真库之间」的那一格**——现有测试都是「设备键里有孤儿，库侧读不到它」，
 * 那是同一个库的两份存储，不是两个库。
 *
 * ## 本文件测什么
 *
 * 用**真 SQLite**（不是内存 map）建两个库，各写各的库侧状态，断言：
 *   ① B 库读不到 A 库的块 id；
 *   ② A 库的状态写进 B 之后**A 库一个字节没变**（不是「共享一份」）；
 *   ③ 设备键里的主题跨库保留（设备格该跟机器走）；
 *   ④ 两个库同时开着时，各自 `load()` 拿到的是自己那份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeviceStore, createLocalStorageAdapter, DEFAULT_DOCK, DEFAULT_PREFS, DEVICE_KEY, LIBRARY_STATE_KEY, type LibrarySettingsPort } from '../src/core/infra/workspace.ts'
import { openLibraryDb, readSetting, writeSetting } from '../electron/library/sqlite.ts'
import { installMemoryLocalStorage, resetMemoryLocalStorage } from './storage/test-local-storage.ts'

installMemoryLocalStorage()

const dirs: string[] = []
function freshLibrary(): { port: LibrarySettingsPort; close: () => void } {
  const d = mkdtempSync(join(tmpdir(), 'qua-xlib-'))
  dirs.push(d)
  const opened = openLibraryDb(join(d, 'qua.db'))
  assert.ok(opened.status === 'created' || opened.status === 'ok', `开库失败：${opened.status}`)
  const db = opened.db
  return {
    // 真 SQLite：库侧状态就是 settings 表里的一行（与生产同一条路径）
    port: {
      get: async (key: string) => readSetting(db, key) ?? null,
      set: async (key: string, value: string) => {
        try {
          writeSetting(db, key, value)
          return { ok: true as const }
        } catch (e) {
          return { ok: false as const, error: e }
        }
      },
    },
    close: () => db.close(),
  }
}
process.on('exit', () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

let seq = 0
const freshDeviceKey = (): string => `${DEVICE_KEY}-xlib-${++seq}`

/** 一个「A 库专属」的块 id —— 两库之间绝不该出现 */
const A_BLOCK = 'a'.repeat(32)
const B_BLOCK = 'b'.repeat(32)

/* ═══════════════════════════════════════════════════════
   ① B 库读不到 A 库的块 id
   ═══════════════════════════════════════════════════════ */

test('切库：A 库写进去的折叠表，**B 库读不到**（两库各一份，不共享）', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  const a = freshLibrary()
  const b = freshLibrary()
  try {
    // A 库：收起 A_BLOCK
    const sa = createDeviceStore(createLocalStorageAdapter(key), a.port)
    await sa.save({ prefs: DEFAULT_PREFS, folded: { [A_BLOCK]: true } })

    // B 库：同一个设备键、不同的库面
    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    const loadedB = await sb.load()

    assert.deepEqual(loadedB.folded, {}, `B 库不该看到 A 库的块 id，实际：${JSON.stringify(loadedB.folded)}`)
    assert.equal(A_BLOCK in loadedB.folded, false)
  } finally {
    a.close()
    b.close()
  }
})

test('切库：A 库的 dock 卡片与日记栏**不落到 B 库**', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  const a = freshLibrary()
  const b = freshLibrary()
  try {
    const sa = createDeviceStore(createLocalStorageAdapter(key), a.port)
    await sa.save({
      prefs: {
        ...DEFAULT_PREFS,
        dock: { ...DEFAULT_DOCK, left: { open: false, width: 333, cards: [...DEFAULT_DOCK.left.cards] } },
        journalMounts: [{ id: A_BLOCK, kind: 'derived', source: 'refs' }],
      },
      folded: {},
    })

    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    const loadedB = await sb.load()
    assert.equal(loadedB.prefs.dock.left.width, null, 'B 库的槽宽应是默认（不是 A 库的 333）')
    assert.equal(loadedB.prefs.dock.left.open, true, 'B 库的槽开关应是默认')
    assert.deepEqual(loadedB.prefs.journalMounts, [], 'B 库的日记栏不该有 A 库的块 id')
  } finally {
    a.close()
    b.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ② 写 B 不改 A
   ═══════════════════════════════════════════════════════ */

test('切库：往 B 库写状态，**A 库一个字节没变**（不是共享同一份）', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  const a = freshLibrary()
  const b = freshLibrary()
  try {
    const sa = createDeviceStore(createLocalStorageAdapter(key), a.port)
    await sa.save({ prefs: DEFAULT_PREFS, folded: { [A_BLOCK]: true } })
    const aBytesBefore = await a.port.get(LIBRARY_STATE_KEY)

    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    await sb.save({ prefs: DEFAULT_PREFS, folded: { [B_BLOCK]: true } })

    const aBytesAfter = await a.port.get(LIBRARY_STATE_KEY)
    assert.equal(aBytesAfter, aBytesBefore, 'A 库的库侧状态不许被 B 库的写入改掉')

    // 并且 A 库读回来仍是自己的那份
    const reloadedA = await sa.load()
    assert.deepEqual(reloadedA.folded, { [A_BLOCK]: true }, 'A 库读回自己的折叠表')
  } finally {
    a.close()
    b.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ③ 设备格该跟机器走（反面对照：不是「什么都不跨库」）
   ═══════════════════════════════════════════════════════ */

test('切库：**主题跨库保留**（设备格跟机器走——这条防止把「隔离」做过头）', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  const a = freshLibrary()
  const b = freshLibrary()
  try {
    const sa = createDeviceStore(createLocalStorageAdapter(key), a.port)
    await sa.save({ prefs: { ...DEFAULT_PREFS, theme: 'dark' }, folded: {} })

    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    const loadedB = await sb.load()
    assert.equal(loadedB.prefs.theme, 'dark', '主题是设备格：换库仍是暗色')
  } finally {
    a.close()
    b.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ④ 两个库同时开着
   ═══════════════════════════════════════════════════════ */

test('切库：两个库**同时开着**时，各自 load() 拿到的是自己那份', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  const a = freshLibrary()
  const b = freshLibrary()
  try {
    const sa = createDeviceStore(createLocalStorageAdapter(key), a.port)
    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    await sa.save({ prefs: DEFAULT_PREFS, folded: { [A_BLOCK]: true } })
    await sb.save({ prefs: DEFAULT_PREFS, folded: { [B_BLOCK]: true } })

    // 交错读：两份状态互不影响
    const [la, lb] = await Promise.all([sa.load(), sb.load()])
    assert.deepEqual(la.folded, { [A_BLOCK]: true }, 'A 库拿到 A 的')
    assert.deepEqual(lb.folded, { [B_BLOCK]: true }, 'B 库拿到 B 的')
  } finally {
    a.close()
    b.close()
  }
})

/* ═══════════════════════════════════════════════════════
   ⑤ 设备键里的孤儿不许被捡回来（跨库版的同一条判据）
   ═══════════════════════════════════════════════════════ */

test('切库：设备键里留着**上一个库**的折叠表 ⇒ 新库不捡它', async () => {
  resetMemoryLocalStorage()
  const key = freshDeviceKey()
  // 模拟「旧版本把折叠表写在设备键里」留下的字节
  await createLocalStorageAdapter(key).commit({
    changes: [],
    payload: JSON.stringify({
      prefs: { dock: { left: { open: false, width: 444, cards: [] } } },
      folded: { [A_BLOCK]: true },
    }),
    savedAt: 1,
  })

  const b = freshLibrary()
  try {
    const sb = createDeviceStore(createLocalStorageAdapter(key), b.port)
    const loadedB = await sb.load()
    assert.deepEqual(loadedB.folded, {}, '设备键里的孤儿折叠表不许被捡进新库')
    assert.equal(loadedB.prefs.dock.left.width, null, '设备键里的孤儿 dock 也不许被捡')
  } finally {
    b.close()
  }
})
