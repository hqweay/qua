/**
 * 一条命中怎么说：⌘F 浮层与中心搜索面共用 describeHit——
 * 高亮片段、住哪（祖先链兜底）、来路透传，两处各拼一遍迟早分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../../src/core/index.ts'
import { mkBlock } from '../../src/core/index.ts'
import { describeHit } from '../../src/app/search/hits.ts'
import type { KbClient } from '../../src/core/kb/types.ts'

/** describeHit 只用 KbClient 的两格：按 id 取、问祖先链 */
function client(blocks: Block[]): KbClient {
  const all: Block[] = []
  const collect = (list: readonly Block[]): void => {
    for (const b of list) {
      all.push(b)
      collect(b.children)
    }
  }
  collect(blocks)
  const byId = new Map(all.map((b) => [b.id, b]))
  const pathOf = (id: string): Block[] => {
    const out: Block[] = []
    const walk = (list: Block[], chain: Block[]): boolean => {
      for (const b of list) {
        if (b.id === id) {
          out.push(...chain, b)
          return true
        }
        if (walk(b.children, [...chain, b])) return true
      }
      return false
    }
    walk(blocks, [])
    return out
  }
  return { get: (id) => byId.get(id), pathOf } as unknown as KbClient
}

function seed(): { kb: KbClient; page: Block; child: Block } {
  const page = mkBlock('产品')
  page.props = { ...page.props, _aliases: ['产品'] }
  const child = mkBlock('搜索面探针正文')
  page.children.push(child)
  return { kb: client([page]), page, child }
}

test('命中行：正文命中给高亮片段，祖先链当「住哪」', () => {
  const { kb, child } = seed()
  const view = describeHit(kb, { blockId: child.id, score: 0 }, '探针')
  assert.ok(view)
  assert.equal(view.blockId, child.id)
  const marked = view.parts.filter((p) => p.mark).map((p) => p.text)
  assert.deepEqual(marked, ['探针'], `命中的字要打标：${JSON.stringify(view.parts)}`)
  assert.equal(view.hint, '产品', `子块的「住哪」是祖先链：${view.hint}`)
})

test('正文为空的块整行用块名（顶层块的「住哪」是它自己的名字）', () => {
  const { kb, page } = seed()
  const view = describeHit(kb, { blockId: page.id, score: 0 }, '')
  assert.ok(view)
  assert.deepEqual(view.parts, [{ text: '产品' }])
  assert.equal(view.hint, '产品')
})

test('来路透传（经由标注由渲染分支决定）；块不在森林里 ⇒ null', () => {
  const { kb, child } = seed()
  const withSource = describeHit(kb, { blockId: child.id, score: 0, source: 'alias' }, '')
  assert.equal(withSource?.source, 'alias')
  assert.equal(describeHit(kb, { blockId: 'nope', score: 0 }, ''), null)
})

test('正文投影与行说法同源：片段拼回是正文投影的一段（窗口外用省略号裁）', () => {
  const { kb, child } = seed()
  const view = describeHit(kb, { blockId: child.id, score: 0 }, '探针')
  assert.ok(view)
  const joined = view.parts.map((p) => p.text).join('')
  const plain = child.content.filter((r) => r.t === 'text').map((r) => r.v).join('')
  assert.ok(plain.includes(joined.replace('…', '')) || joined.includes('…'))
})
