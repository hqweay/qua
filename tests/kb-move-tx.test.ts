/**
 * **同一笔事务里多次移动同一块**（多块拖拽的底座）。
 *
 * `Tx.move` 用 `parentOf(id)` 找「从哪儿摘」。那个索引是**事务出口**才更新的快照；
 * 同一笔里第二次搬同一块时，旧实现会按旧父去摘 —— 实测把目标父自己从树上摘掉，
 * 整棵子树凭空消失。`MemoryKb.tx` 现在带一层本事务内的父指针覆盖
 * （`parentOverride`），这里用**可判定的树形状**把它钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock } from '../src/core/model/model.ts'
import { forestFingerprint } from '../src/core/kb/diff.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

function fixture(): { kb: MemoryKb; store: BlockStore; a: ReturnType<typeof mkBlock>; b: ReturnType<typeof mkBlock>; d: ReturnType<typeof mkBlock> } {
  const a = mkBlock('甲')
  const b = mkBlock('乙')
  const d = { ...mkBlock('丁'), children: [mkBlock('戊')] }
  const store = new BlockStore([a, b, d])
  const kb = new MemoryKb(store)
  return { kb, store, a, b, d }
}

const text = (b: { content: readonly { t: string; v?: string }[] }): string => b.content.map((r) => (r.t === 'text' ? (r.v ?? '') : '')).join('')

test('同一笔里搬同一块两次：目标父不能被摘掉，块留在目标父下', () => {
  const { kb, store, a, d } = fixture()
  kb.tx((tx) => {
    // 先追加到丁末尾，再在同一笔里把它插到丁的第 0 位
    tx.move(a.id, d.id, Number.MAX_SAFE_INTEGER)
    tx.move(a.id, d.id, 0)
  })
  assert.ok(store.blocks.some((b) => b.id === d.id), '目标父丁必须还在森林顶层')
  assert.deepEqual(
    d.children.map((b) => text(b)),
    ['甲', '戊'],
    `甲应插到丁的第 0 位、戊还在：${JSON.stringify(d.children.map(text))}`,
  )
})

test('同一笔里跨两次父：第二次按第一次的新父摘，不留下幽灵', () => {
  const { kb, store, a, b, d } = fixture()
  kb.tx((tx) => {
    tx.move(a.id, d.id, 0)
    tx.move(a.id, b.id, 0)
  })
  assert.deepEqual(d.children.map(text), ['戊'], '甲离开丁后丁只剩戊')
  assert.deepEqual(b.children.map(text), ['甲'], '甲应落到乙下面')
  assert.ok(store.blocks.some((x) => x.id === a.id) === false, '甲已是别人的孩子，不再在顶层')
})

test('同一笔里 insert 之后再 move：新块的 parentOf 也要能答对', () => {
  const { kb, a, b } = fixture()
  const fresh = mkBlock('新')
  kb.tx((tx) => {
    tx.insert(fresh, a.id, 0)
    tx.move(fresh.id, b.id, 0)
  })
  assert.deepEqual(a.children.map(text), [], '新块应离开甲')
  assert.deepEqual(b.children.map(text), ['新'], '新块应落到乙下面')
})

test('多次 move 之后抛错：整笔回滚，森林逐字节等于进门时', () => {
  const { kb, store, a, d } = fixture()
  const before = forestFingerprint(store.blocks)
  assert.throws(
    () =>
      kb.tx((tx) => {
        tx.move(a.id, d.id, 0)
        // 甲已在丁下面 ⇒ 把丁搬进甲是自己的子树，必须抛错；第一笔移动要一起退回
        tx.move(d.id, a.id, 0)
      }),
    /own subtree/,
  )
  assert.equal(forestFingerprint(store.blocks), before, '抛错之后整片森林必须逐字节等于进门时')
})
