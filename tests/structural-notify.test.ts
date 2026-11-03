/**
 * **store 通知的第三参：这批变化是不是结构变化**（`structuralOf` ＋ 订阅者收到它）。
 *
 * 为什么值得单测：视图靠这一位决定「按 id 换几行」还是「整页重画」。判错的方向
 * 都不报错——把文本改动当结构变化，每个键都整页重排（打字被打断）；把插入当文本
 * 改动，新块挂不上（别的露面停在旧形状）。⇒ 判据必须只有一份、且从 op 形状来，
 * 这里的断言把它逐格钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import type { Op } from '../src/core/kb/types.ts'
import { BlockStore, mkBlock, writeBlockContent, textRuns } from '../src/core/index.ts'
import { structuralOf } from '../src/core/kb/changes.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

const b = (id: string, text: string, children: Block[] = []): Block => ({
  id,
  content: textRuns(text),
  children,
  created: 1000,
  modified: 1000,
})

const upsert = (value: Record<string, unknown>): Op =>
  ({ e: 'block', id: 'x', op: 'upsert', value, at: 1 }) as unknown as Op

test('structuralOf：内容/时刻的 patch ＝ 文本改动，不是结构变化', () => {
  assert.equal(structuralOf([upsert({ content: textRuns('abc') })]), false)
  assert.equal(structuralOf([upsert({ modified: 2000 })]), false)
  assert.equal(structuralOf([upsert({ content: textRuns('abc'), modified: 2000 })]), false)
})

test('structuralOf：插入/移动（parent|prev|created）与存在变化（exist）＝ 结构变化', () => {
  assert.equal(structuralOf([upsert({ parent: 'p', prev: null })]), true)
  assert.equal(structuralOf([upsert({ prev: 'a' })]), true)
  assert.equal(structuralOf([upsert({ created: 1000, parent: 'p', prev: null, content: [] })]), true)
  assert.equal(structuralOf([{ e: 'block', id: 'x', op: 'exist', state: 'deleted', at: 1 }] as Op[]), true)
})

test('structuralOf：prop/anno ＝ 不是结构变化；混批里有一条结构 op 就是 true', () => {
  assert.equal(structuralOf([{ e: 'prop', block: 'x', name: 'k', op: 'set', value: 1, at: 1 }] as Op[]), false)
  assert.equal(
    structuralOf([{ e: 'anno', block: 'x', id: 'a', op: 'set', value: undefined, at: 1 }] as Op[]),
    false,
  )
  assert.equal(
    structuralOf([upsert({ modified: 2 }), upsert({ parent: 'p', prev: null })]),
    true,
    '一次事务里插入＋改时刻：整批算结构变化',
  )
})

/** 一个订阅者，把收到的第三参记下来 */
function collector(store: BlockStore): { structural: (boolean | undefined)[] } {
  const seen: (boolean | undefined)[] = []
  store.subscribe((_s, _ids, structural) => seen.push(structural))
  return {
    structural: seen,
  }
}

test('store.apply 把 structuralOf 的结果带给订阅者；打字路径 false、插入/删除 true', () => {
  const root = b('p', '', [b('c1', '一')])
  const store = new BlockStore([root])
  const kb = new MemoryKb(store, { now: () => 1000 })
  const seen = collector(store)

  // 打字：一次 content 写入（与真实键入同一条 op 形状）
  kb.tx((tx) => tx.patch('c1', (x) => writeBlockContent(x, textRuns('一二'))))
  assert.equal(seen.structural.at(-1), false, 'content patch ＝ 文本改动')

  // 插入：tx.insert 报 {parent, prev}
  kb.tx((tx) => tx.insert(mkBlock('二'), 'p', 1))
  assert.equal(seen.structural.at(-1), true, 'tx.insert ＝ 结构变化')

  // 软删：tx.remove 报 exist
  kb.tx((tx) => tx.remove('c1'))
  assert.equal(seen.structural.at(-1), true, 'tx.remove ＝ 结构变化')
})
