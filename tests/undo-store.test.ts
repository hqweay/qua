/**
 * **条目式撤销的端到端**：`MemoryKb.tx` 的捕获 → `store.record` → `store.undo/redo`。
 *
 * 这条链是 S3 的验收面：撤销不再取整库快照、不再 diff 整片森林，
 * 但用户可见语义一条都不许变 —— 一步回到那一刻、合并窗口仍是一步、
 * 新块撤销是 purge、重做用同一个 id、软删回原位、未动块不受影响。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { mkBlock, writeBlockContent, type Block } from '../src/core/model/model.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { forestFingerprint } from '../src/core/kb/diff.ts'

function fixture() {
  const a1 = mkBlock('甲的子块')
  const a = mkBlock('甲')
  a.children = [a1]
  const b = mkBlock('乙')
  const c = mkBlock('丙')
  const store = new BlockStore([a, b, c])
  const kb = new MemoryKb(store, { now: () => 5000 })
  return { a, a1, b, c, store, kb }
}

/** 一次「写 + 记」：真实链路的形状（捕获由事务出口给） */
function edit(
  kb: MemoryKb,
  store: BlockStore,
  kind: 'insert' | 'delete' | 'structural' | 'mark' | 'other',
  fn: Parameters<MemoryKb['tx']>[0],
  at = Date.now(),
): void {
  const r = kb.tx(fn)
  store.record(r.undo, null, kind, at)
}

test('正文：撤销回到改写前，重做回到改写后', () => {
  const { a, store, kb } = fixture()
  const fp0 = forestFingerprint(store.blocks)
  edit(kb, store, 'insert', (tx) =>
    tx.patch(a.id, (x) => {
      writeBlockContent(x, textRuns('改过'))
      x.modified = 900
    }),
  )
  const fp1 = forestFingerprint(store.blocks)

  const u = store.undo('me', null)!
  assert.equal(forestFingerprint(store.blocks), fp0)
  assert.equal(plainText(a.content), '甲')
  const r = store.redo('me', null)!
  assert.equal(forestFingerprint(store.blocks), fp1)
  assert.equal(plainText(a.content), '改过')
  assert.ok(u.ops.length > 0 && r.ops.length > 0, '两个方向都要交出落盘 op')
})

test('合并窗口：连续两笔打字是一步；撤销回到第一笔之前，重做回到停手那刻', () => {
  const { a, store, kb } = fixture()
  const t = 1_000_000
  edit(kb, store, 'insert', (tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('一'))), t)
  edit(kb, store, 'insert', (tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('一二'))), t + 10)
  assert.equal(store.undoStack.depth(), 1, '窗口内是一格')

  store.undo('me', null)
  assert.equal(plainText(a.content), '甲')
  store.redo('me', null)
  assert.equal(plainText(a.content), '一二')
})

test('插入：撤销是 purge（块真的不在树上了），重做用同一个 id 复活', () => {
  const { a, store, kb } = fixture()
  const fresh = mkBlock('新块')
  const child = mkBlock('新子块')
  fresh.children = [child]
  edit(kb, store, 'structural', (tx) => tx.insert(fresh, a.id, 0))
  const fp1 = forestFingerprint(store.blocks)

  const u = store.undo('me', null)!
  assert.ok(
    u.ops.some((o) => o.e === 'block' && o.op === 'exist' && o.state === 'purged' && o.id === fresh.id),
    '撤销插入必须发 purged（不是软删）',
  )
  assert.equal(store.undoLookup().get(fresh.id), undefined, 'purge 后连「全部块」表里都没有')
  assert.equal(store.find(child.id), undefined)

  store.redo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp1)
  assert.equal(store.find(fresh.id)?.id, fresh.id, '重做用同一个 id')
  assert.equal(store.find(child.id)?.id, child.id, '子块同一棵子树一起回来')
})

test('软删：撤销摘标记回原位，重做用同一个删除时刻', () => {
  const { b, store, kb } = fixture()
  const fp0 = forestFingerprint(store.blocks)
  edit(kb, store, 'structural', (tx) => tx.remove(b.id))
  const fp1 = forestFingerprint(store.blocks)

  store.undo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp0)
  assert.equal(store.find(b.id)?.props?._deletedAt, undefined)

  store.redo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp1)
  assert.equal(store.find(b.id), undefined, '重做后被软删的块从可见索引退场')
  assert.equal(store.undoLookup().get(b.id)?.props?._deletedAt, 5000, '删除时刻是条目里那份，不是重新取时钟')
})

test('移动：撤销回到原父/原前兄弟，重做回到新位', () => {
  const { a1, store, kb } = fixture()
  const fp0 = forestFingerprint(store.blocks)
  edit(kb, store, 'structural', (tx) => tx.move(a1.id, null, 2))
  const fp1 = forestFingerprint(store.blocks)

  store.undo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp0)
  store.redo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp1)
})

test('一次事务动多块：一次撤销全部退回', () => {
  const { a, b, store, kb } = fixture()
  const fp0 = forestFingerprint(store.blocks)
  edit(kb, store, 'other', (tx) => {
    tx.patch(a.id, (x) => writeBlockContent(x, textRuns('甲改')))
    tx.setProp(b.id, 'p', 1)
  })
  const fp1 = forestFingerprint(store.blocks)
  store.undo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp0)
  store.redo('me', null)
  assert.equal(forestFingerprint(store.blocks), fp1)
})

test('撤销后不能重做一条被新编辑清掉的未来（future 清空）', () => {
  const { a, store, kb } = fixture()
  edit(kb, store, 'insert', (tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('一'))), 1)
  store.undo('me', null)
  assert.equal(store.undoStack.redoDepth(), 1)
  edit(kb, store, 'insert', (tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('二'))), 2)
  assert.equal(store.undoStack.redoDepth(), 0, '新编辑之后旧的重做路径必须作废')
})

test('选区：撤销回到改动前，重做回到撤销那一刻', () => {
  const { a, store, kb } = fixture()
  const beforeSel = { aBlock: a.id, aOff: 0, hBlock: a.id, hOff: 0 }
  const atUndo = { aBlock: a.id, aOff: 1, hBlock: a.id, hOff: 1 }
  const r = kb.tx((tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('改过'))))
  store.record(r.undo, beforeSel, 'other', 1)

  assert.deepEqual(store.undo('me', atUndo)!.sel, beforeSel, '撤销回到改动前')
  assert.deepEqual(store.redo('me', null)!.sel, atUndo, '重做回到按 ⌘Z 那一刻的位置')
})

test('未动的块对象身份不变（撤销只写 touched 那几块）', () => {
  const { a, b, c, store, kb } = fixture()
  edit(kb, store, 'insert', (tx) => tx.patch(a.id, (x) => writeBlockContent(x, textRuns('只动甲'))))
  store.undo('me', null)
  assert.equal(store.blocks[1], b)
  assert.equal(store.blocks[2], c)
})

test('撤销条目：序列化字节与库体量无关（100 与 10,000 块相同）', () => {
  const bytesAt = (n: number): number => {
    const mid = Math.floor(n / 2)
    const blocks: Block[] = Array.from({ length: n }, (_, i) => mkBlock(i === mid ? '目标块' : `块${i}`))
    const store = new BlockStore(blocks)
    const kb = new MemoryKb(store)
    store.index
    const target = blocks[mid]!
    const r = kb.tx((tx) => tx.patch(target.id, (b) => writeBlockContent(b, textRuns('改过'))))
    return JSON.stringify(r.undo).length
  }
  assert.equal(bytesAt(10_000), bytesAt(100))
})

/* ------------------------------------------------------------ 设备步 */

test('设备步：undo/redo 各调各的闭包；块森林零 op、指纹不动', () => {
  const { a, store, kb } = fixture()
  const fp = forestFingerprint(store.blocks)
  const log: string[] = []
  store.recordDevice({
    undo: () => log.push('undo'),
    redo: () => log.push('redo'),
  })
  const u = store.undo('me', null)
  assert.ok(u)
  assert.equal(u.ops.length, 0, '设备步块侧零 op')
  assert.deepEqual(log, ['undo'], '撤销调 undo 闭包')
  const r = store.redo('me', null)
  assert.ok(r)
  assert.equal(r.ops.length, 0)
  assert.deepEqual(log, ['undo', 'redo'], '重做调 redo 闭包')
  assert.equal(forestFingerprint(store.blocks), fp, '森林一字未动')
  // 重做之后条目回到栈顶：再撤一次仍走 undo 闭包（条目在两侧搬运，不取「现在」）
  store.undo('me', null)
  assert.deepEqual(log, ['undo', 'redo', 'undo'])
  void a
  void kb
})

test('设备步不与块条目合并：记完设备步，⌘Z 一次只撤设备步', () => {
  const { a, store, kb } = fixture()
  edit(kb, store, 'insert', (tx) =>
    tx.patch(a.id, (x) => {
      writeBlockContent(x, textRuns('改过'))
      x.modified = 900
    }),
  )
  const log: string[] = []
  store.recordDevice({ undo: () => log.push('device'), redo: () => {} })
  store.undo('me', null)
  assert.deepEqual(log, ['device'], '先撤的是设备步（栈顶），不是块编辑')
  assert.equal(plainText(a.content), '改过', '块内容没被动')
  store.undo('me', null)
  assert.equal(plainText(a.content), '甲', '再一次才撤到块编辑')
})
