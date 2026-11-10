/**
 * **演示库的槽布局**（`seedDock()`，设备侧种子）。
 *
 * 为什么值得钉：演示盘是「第一次打开看到什么」的一部分——盘不在，收纳盘这个能力
 * 在演示里就等于不存在；快捷卡指错，访客点进去是悬空。这里同时钉**有**（盘在默认布局
 * 的正确位置上）、**指得到**（确定性 id 的目标块真的在种子里）与**不污染**
 * （追加只进演示 dock，共享的 `DEFAULT_DOCK` 一根汗毛不动）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { seedDock, seedWorkspace } from '../src/core/infra/seed.ts'
import { SEED_FEATURE_BOARD_ID, SEED_INPUT_NOTES_ID, SEED_TRAY_ID } from '../src/core/fixtures/seed.ts'
import { DEFAULT_DOCK, type DockEntry } from '../src/core/storage/prefs.ts'
import { dockKey } from '../src/core/views/dock.ts'

test('演示 dock：默认布局追加一只收纳盘，位置在快捷排与日历之间', () => {
  const dock = seedDock()
  const tray = dock.left.cards.find((e): e is Extract<DockEntry, { kind: 'tray' }> => e.kind === 'tray')
  assert.ok(tray, `左槽应有一只演示盘：${JSON.stringify(dock.left.cards)}`)
  // 位置：插在快捷排（cmd）之后、第一张大卡之前——盘显眼，但不挤掉快捷与日历
  const at = dock.left.cards.findIndex((e) => e.kind === 'tray')
  assert.ok(dock.left.cards.slice(0, at).every((e) => e.kind === 'cmd'), '盘应紧跟快捷排')
  assert.equal(dock.left.cards[at + 1]?.kind, 'derived', '盘后第一张应是派生大卡（日历）')
  assert.equal(tray.id, SEED_TRAY_ID)
  assert.ok(tray.title !== undefined && tray.title !== '', '演示盘应有名字（卡头留守的是上下文）')
  // 右槽照默认（检视卡＋反链）
  assert.deepEqual(
    dock.right.cards.map(dockKey),
    DEFAULT_DOCK.right.cards.map(dockKey),
    '右槽不该被演示盘牵连',
  )
})

test('演示盘成员：只收叶子快捷卡，目标块按确定性 id 真的在种子里', () => {
  const tray = seedDock().left.cards.find((e) => e.kind === 'tray') as Extract<DockEntry, { kind: 'tray' }>
  for (const m of tray.cards) {
    assert.ok(m.kind === 'shortcut', `演示盘只收快捷卡：${JSON.stringify(m)}`)
  }
  const targets = tray.cards.map((m) => (m.kind === 'shortcut' ? m.block : ''))
  assert.deepEqual(targets.sort(), [SEED_FEATURE_BOARD_ID, SEED_INPUT_NOTES_ID].sort())
  // 建库与设备状态分开调用，id 必须两边一致——目标不在种子里就是一颗悬空的快捷卡
  const blocks = seedWorkspace().blocks
  for (const target of targets) {
    assert.ok(blocks.some((b) => b.id === target), `快捷卡的目标块应在种子里：${target}`)
  }
})

test('演示盘是追加，不是改写：共享的 `DEFAULT_DOCK` 不被污染', () => {
  seedDock()
  assert.equal(DEFAULT_DOCK.left.cards.some((e) => e.kind === 'tray'), false, '默认布局不该长出演示盘')
  assert.equal(
    DEFAULT_DOCK.left.cards.length,
    6,
    `默认左槽仍是四颗快捷＋日历＋归属树：${JSON.stringify(DEFAULT_DOCK.left.cards)}`,
  )
})
