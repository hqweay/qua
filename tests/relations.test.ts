/**
 * **关系层**：引用／属性引用／标签归属／标签提及是四种不同的事实。
 *
 * 这组测试钉住三件事：
 *   ① `{ref}` 默认收 inline／property／embed，**不收**标签归属与 `#名` 提及；
 *   ② `{ref:{kind}}` 能把这三种引用收窄；
 *   ③ 派生栏的「成员」「提及」与关系索引是同一份口径（不另扫一遍正文）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOps,
  canonicalSpec,
  derivedRecordsOf,
  fingerprint,
  BlockStore,
  rebuild,
  runQuery,
  type Block,
} from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { textRuns, type RefRun } from '../src/core/model/runs.ts'
import { derivedSpecOf } from '../src/core/views/mount.ts'
import { queryByIndex } from '../src/core/infra/index-port.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

const ref = (id: string, to: string, extra: Partial<RefRun> = {}): RefRun => ({ id, t: 'ref', to, ...extra })

function forest() {
  const tag = b('tag', '人物', { props: { _aliases: ['人物'], _lists: ['tag'] } })
  const prop = b('prop', '作者', { props: { _kind: 'ref' } })
  const target = b('target', '目标')
  const src = b('src', '源块', {
    props: { prop: 'target', _tags: [tag.id] },
    content: [...textRuns('正文'), ref('r1', 'target'), ref('r2', 'target')],
  })
  const mention = b('mention', '写 #人物', { content: [...textRuns('写 '), ref('m1', 'tag', { flavor: '#' })] })
  return [tag, prop, target, src, mention]
}

test('{ref} 默认收 inline／property／embed，不收标签归属与 #名 提及', () => {
  const blocks = forest()
  const hits = runQuery({ where: { ref: 'target' } }, { blocks }).map((h) => h.blockId)
  assert.deepEqual(hits, ['src'], '正文引用与属性引用都指向 target')

  const tagHits = runQuery({ where: { ref: 'tag' } }, { blocks }).map((h) => h.blockId)
  assert.deepEqual(tagHits, [], '标签归属不是引用；#名 提及也不是引用')
})

test('{ref:{kind}} 能收窄到某一类引用', () => {
  const blocks = forest()
  const inline = runQuery({ where: { ref: { to: 'target', kind: 'inline' } } }, { blocks })
  assert.deepEqual(inline.map((h) => h.blockId), ['src'], '只有正文引用时仍命中 src')
  const property = runQuery({ where: { ref: { to: 'target', kind: 'property' } } }, { blocks })
  assert.deepEqual(property.map((h) => h.blockId), ['src'], '属性引用也命中 src')
  const none = runQuery({ where: { ref: { to: 'target', kind: 'embed' } } }, { blocks })
  assert.deepEqual(none, [], '没有 embed 边')
})

test('canonicalSpec：ref 的对象形式能存活，kind 规范成数组', () => {
  assert.deepEqual(canonicalSpec({ where: { ref: { to: 'x', kind: 'property' } } }), {
    where: { ref: { to: 'x', kind: ['property'] } },
  })
  assert.deepEqual(canonicalSpec({ where: { ref: 'x' } }), { where: { ref: 'x' } })
})

test('索引路径与纯函数路径：ref 的 kind 口径一致', () => {
  const blocks = forest()
  const idx = rebuild(blocks)
  const spec = { where: { ref: { to: 'target', kind: ['property'] as const } } }
  assert.deepEqual(
    queryByIndex(idx, blocks, spec).map((h) => h.blockId),
    runQuery(spec, { blocks }).map((h) => h.blockId),
  )
})

test('成员：标签块自己的成员不含正文 #名 提及', () => {
  const blocks = forest()
  const tag = blocks.find((b) => b.id === 'tag')!
  const spec = derivedSpecOf(tag, blocks, 'members')
  assert.deepEqual(spec, { where: { tag: '人物' } })
  const kb = new MemoryKb(new BlockStore(blocks))
  const rows = derivedRecordsOf(tag, kb, 'members')
  assert.deepEqual(rows.map((r) => r.block.id), ['src'], '只有 _tags 归属算成员')
})

test('提及：文本命中与 #名 提及合成一行，且不把 #名 当引用', () => {
  const blocks = forest()
  const tag = blocks.find((b) => b.id === 'tag')!
  const kb = new MemoryKb(new BlockStore(blocks))
  const rows = derivedRecordsOf(tag, kb, 'mentions')
  assert.deepEqual(rows.map((r) => r.block.id), ['mention'])
  assert.equal(rows[0]!.derived?.matched, '#人物')
})

test('增量：改属性 ref 值 ⇒ 关系边跟着换，且与全量重建一致', () => {
  const blocks = forest()
  const store = new BlockStore(JSON.parse(JSON.stringify(blocks)))
  const kb = new MemoryKb(store)
  const idx = rebuild(store.blocks)
  const r = kb.tx((tx) => {
    tx.patch('src', (x) => {
      x.props = { ...(x.props ?? {}), prop: 'mention' }
    })
  })
  const next = applyOps(idx, r.ops, store.blocks)
  assert.equal(fingerprint(next), fingerprint(rebuild(store.blocks)))
  assert.deepEqual(
    runQuery({ where: { ref: { to: 'target', kind: 'property' } } }, { blocks: store.blocks }),
    [],
    '旧属性边摘掉',
  )
})
