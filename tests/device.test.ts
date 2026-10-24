/**
 * 设备偏好（`qua.device`）的契约测试：跑**真实现**（`createDeviceStore` ＋ localStorage 适配器 ＋ 内存后端）。
 *
 * 这里钉的是三件上层要依赖的事：
 *   1. 从没存过 ⇒ 默认偏好（不是 `undefined`，调用方不必到处 `??`）；
 *   2. 存了再读 ⇒ 原样回来（主题／槽宽／钉住的块）；
 *   3. 字节坏了 / 是别的后端留下的 ⇒ **回落默认**，不抛、不崩、不进只读态——
 *      偏好不是内容，没有「打不开」这种状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeviceStore, createLocalStorageAdapter, DEFAULT_PREFS, DEVICE_KEY, type Prefs } from '../src/core/workspace.ts'
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
    left: { open: true, width: null, pins: [] },
    right: { open: true, width: null, pins: [] },
  })
}

test('device: 从没存过 ⇒ 默认偏好（调用方不必再兜底）', async () => {
  resetMemoryLocalStorage()
  assertDefaults((await store(freshKey()).load()).prefs)
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
        left: { open: false, width: 312, pins: ['b1', 'b2'] },
        right: { open: true, width: null, pins: [] },
      },
    },
  })
  assert.equal(saved.ok, true)

  const loaded = await s.load()
  assert.equal(loaded.prefs.theme, 'dark')
  assert.equal(loaded.prefs.virtualize, true)
  assert.equal(loaded.prefs.radius, 28)
  assert.deepEqual(loaded.prefs.dock.left, { open: false, width: 312, pins: ['b1', 'b2'] })
  assert.deepEqual(loaded.prefs.dock.right, { open: true, width: null, pins: [] })
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
})

test('device: 坏字节 / 别的后端的字节 ⇒ 回默认，不抛也不改写原字节', async () => {
  resetMemoryLocalStorage()
  const brokenKey = freshKey()
  globalThis.localStorage.setItem(brokenKey, '{oops')
  assertDefaults((await store(brokenKey).load()).prefs)
  assert.equal(peekMemoryLocalStorage(brokenKey), '{oops', '读坏时不许顺手覆盖（留给用户自己救）')

  const foreignKey = freshKey()
  globalThis.localStorage.setItem(foreignKey, JSON.stringify({ some: 'other-backend' }))
  assertDefaults((await store(foreignKey).load()).prefs)
})
