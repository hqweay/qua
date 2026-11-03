/**
 * 「在空块行首按退格」只允许删掉**声明了**该能力的占位块。
 *
 * 这条规则原先按形状判（正文空 + 不能写正文），于是露面与查询块也被当成
 * 「插入时补的光标位」——在它们下面的空块里按一次退格，整次露面/整个查询被静默删掉。
 * 这里钉住：形状不是许可，能力要类型自己声明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DIVIDER_TYPE,
  EMBED_TYPE,
  mkBlock,
  prevPlaceholder,
  setBlockType,
  type Block,
  type Doc,
} from '../src/core/index.ts'

const widgetDoc = (widget: Block): Doc => ({ roots: [widget, mkBlock('')] })

test('分割线声明了 deleteOnBackspace ⇒ 后面的空块行首退格删掉它', () => {
  const divider = mkBlock('')
  setBlockType(divider, DIVIDER_TYPE)
  const doc = widgetDoc(divider)

  assert.deepEqual(prevPlaceholder(doc, doc.roots[1]!.id), { removed: divider.id })
})

test('露面块没有声明 deleteOnBackspace ⇒ 不被邻块退格删掉', () => {
  const embed = mkBlock('')
  setBlockType(embed, EMBED_TYPE)
  embed.props = { ...(embed.props ?? {}), _embed: { block: 'target', view: '' } }
  const doc = widgetDoc(embed)

  assert.equal(prevPlaceholder(doc, doc.roots[1]!.id), null, '露面是一次指针，不是光标位')
})

test('查询块没有声明 deleteOnBackspace ⇒ 不被邻块退格删掉', () => {
  const query = mkBlock('')
  query.props = { ...(query.props ?? {}), _query: { where: { any: [] } } }
  const doc = widgetDoc(query)

  assert.equal(prevPlaceholder(doc, doc.roots[1]!.id), null, '删掉查询块不是「删掉一个空行」')
})

test('普通空块可写正文 ⇒ 不是占位块，不删', () => {
  const doc = widgetDoc(mkBlock(''))

  assert.equal(prevPlaceholder(doc, doc.roots[1]!.id), null)
})

test('后面的块有正文 ⇒ 退格是合并/删字，不是删前一块', () => {
  const divider = mkBlock('')
  setBlockType(divider, DIVIDER_TYPE)
  const tail = mkBlock('已经写下的字')
  const doc: Doc = { roots: [divider, tail] }

  assert.equal(prevPlaceholder(doc, tail.id), null)
})
