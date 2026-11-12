/**
 * 备注块的契约测试。
 *
 * 备注＝块内容＋区间锚＋一条边，三样都是既有机制；这组测试钉的是接缝处会静默坏的地方：
 *   · `_annotates` 槽的形状判据（空数组＝块级退化态，不合法；对不重复）；
 *   · 备注块进事务（宿主加锚与备注块落顶层是同一批，不落半批）；
 *   · 备注边一对一条，同宿主多区间靠 propId＝anno id 消歧；
 *   · `annotates` **不进** `REFERENCE_KINDS` ⇒ `{ref}` 不命中备注（反链里不冒「3 条备注」），
 *     备注栏走 `incomingIds(idx, target, ['annotates'])` 自己的一栏；
 *   · 增量与全量两条索引路径逐字节一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOps,
  fingerprint,
  incomingIds,
  rebuild,
  runQuery,
  BlockStore,
  type Block,
  type Index,
} from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { mkAnno, textRuns, type Run } from '../src/core/model/runs.ts'
import { mkBlock } from '../src/core/model/model.ts'
import { queryByIndex } from '../src/core/infra/index-port.ts'
import { ANNOTATES_PROP, NOTE_TYPE, annotatesPairsOf, isAnnotatesPairs } from '../src/core/relations/annotates.ts'
import { relationEdgesOfBlock } from '../src/core/relations/relations.ts'
import { ensureNoteInTx, mkNoteBlock } from '../src/core/kb/ensure-note.ts'
import { systemPropViolation } from '../src/core/props/system-props.ts'
import type { Tx } from '../src/core/kb/types.ts'

const annoAt = (content: Run[], start: number, end: number) => {
  const a = mkAnno(content, start, end)
  assert.ok(a, '有文本的区间才能物化 anno')
  return a
}

/** 两个宿主块各带一枚区间锚——跨块备注的最小样本 */
function fixture() {
  const hostA = mkBlock(textRuns('甲块的第一句'))
  const aA = annoAt(hostA.content, 0, 3)
  hostA.annos = [aA]
  const hostB = mkBlock(textRuns('乙块的第二句'))
  const aB = annoAt(hostB.content, 3, 5)
  hostB.annos = [aB]
  return { hostA, hostB, aA, aB }
}

/** 与 index-port 同一条范式：每批 op 走增量后必须与全量重建逐字节一致 */
function txStep(kb: MemoryKb, store: BlockStore, idx: Index, fn: (tx: Tx) => void): Index {
  const r = kb.tx(fn, {})
  const next = applyOps(idx, r.ops, store.blocks)
  assert.equal(fingerprint(next), fingerprint(rebuild(store.blocks)), '备注边表的增量必须与全量重建逐字节一致')
  return next
}

/* ------------------------------------------------------- 槽的形状判据 */

test('isAnnotatesPairs：非空列表、每对两个非空键、对不重复', () => {
  assert.equal(isAnnotatesPairs([{ block: 'h1', anno: 'a1' }]), true)
  assert.equal(isAnnotatesPairs([{ block: 'h1', anno: 'a1' }, { block: 'h2', anno: 'a2' }]), true)
  assert.equal(isAnnotatesPairs([]), false, '空数组＝零锚的退化态，不合法')
  assert.equal(isAnnotatesPairs('x'), false)
  assert.equal(isAnnotatesPairs([{ block: '', anno: 'a1' }]), false)
  assert.equal(isAnnotatesPairs([{ block: 'h1' }]), false)
  assert.equal(isAnnotatesPairs([{ block: 'h1', anno: 'a1' }, { block: 'h1', anno: 'a1' }]), false, '重复对没有第二个答案')
})

test('annotatesPairsOf：从块上读对；坏形状读成空（不抛——形状判据在写侧拦）', () => {
  const b = mkBlock(textRuns('x'), { props: { _type: NOTE_TYPE, [ANNOTATES_PROP]: [{ block: 'h1', anno: 'a1' }] } })
  assert.deepEqual(annotatesPairsOf(b), [{ block: 'h1', anno: 'a1' }])
  const broken = mkBlock(textRuns('x'), { props: { [ANNOTATES_PROP]: [] } })
  assert.deepEqual(annotatesPairsOf(broken), [])
})

test('systemPropViolation：_annotates 已登记，空数组判非法', () => {
  assert.equal(systemPropViolation(ANNOTATES_PROP, [{ block: 'h1', anno: 'a1' }]), null)
  assert.match(systemPropViolation(ANNOTATES_PROP, []) ?? '', /invalid value/)
  assert.match(systemPropViolation('_not_a_slot', 1) ?? '', /unregistered/)
})

/* ------------------------------------------------------- 建块进事务 */

test('ensureNoteInTx：一笔事务产出备注块（顶层、槽带上），增量==全量', () => {
  const { hostA, hostB, aA, aB } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify([hostA, hostB])))
  const kb = new MemoryKb(store)
  let idx = rebuild(store.blocks)
  let note: Block | undefined
  idx = txStep(kb, store, idx, (tx) => {
    note = ensureNoteInTx(store.blocks, [
      { block: hostA.id, anno: aA.id },
      { block: hostB.id, anno: aB.id },
    ], tx)
  })
  assert.ok(note)
  assert.deepEqual(annotatesPairsOf(note), [
    { block: hostA.id, anno: aA.id },
    { block: hostB.id, anno: aB.id },
  ])
  // 备注块住森林顶层（身份不占位置）
  assert.ok(store.blocks.some((b) => b.id === note!.id), '备注块落在森林顶层')
})

test('ensureNoteInTx：空对当场抛、事务回滚（坏形状进不了内存）', () => {
  const { hostA } = fixture()
  const store = new BlockStore(JSON.parse(JSON.stringify([hostA])))
  const kb = new MemoryKb(store)
  assert.throws(() => kb.tx((tx) => ensureNoteInTx(store.blocks, [], tx), {}))
  assert.equal(store.blocks.some((b) => b.props?._type === NOTE_TYPE), false)
})

/* ------------------------------------------------------- 备注边与 {ref} 的分工 */

test('relationEdgesOfBlock：一对一条边；同宿主多区间靠 propId＝anno id 消歧', () => {
  const { hostA, aA, aB } = fixture()
  const note = mkNoteBlock([
    { block: hostA.id, anno: aA.id },
    { block: hostA.id, anno: aB.id },
  ])
  const edges = relationEdgesOfBlock(note, new Map())
  assert.deepEqual(edges, [
    { from: note.id, to: hostA.id, kind: 'annotates', propId: aA.id },
    { from: note.id, to: hostA.id, kind: 'annotates', propId: aB.id },
  ])
})

test('annotates 不进 REFERENCE_KINDS：{ref} 不命中备注（纯函数路径与索引路径同口径）', () => {
  const { hostA, hostB, aA, aB } = fixture()
  const note = mkNoteBlock([{ block: hostA.id, anno: aA.id }, { block: hostB.id, anno: aB.id }])
  const blocks = [hostA, hostB, note]

  const hits = runQuery({ where: { ref: hostA.id } }, { blocks }).map((h) => h.blockId)
  assert.deepEqual(hits, [], '备注不是引用：{ref} 缺省口径不收 annotates')

  const idx = rebuild(blocks)
  const indexed = queryByIndex(idx, blocks, { where: { ref: hostA.id } }).map((h) => h.blockId)
  assert.deepEqual(indexed, [], '索引路径同口径')

  assert.deepEqual(incomingIds(idx, hostA.id), [], '缺省口径（反链/引用栏）不含备注')
  assert.deepEqual(incomingIds(idx, hostA.id, ['annotates']), [note.id], '备注栏走自己的 kind')
  assert.deepEqual(incomingIds(idx, hostB.id, ['annotates']), [note.id], '跨块备注在每个宿主都露面')
})
