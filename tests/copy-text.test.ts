/**
 * 块复制的投影按块类型说话：正文、代码身体、露面指针各读各的。
 * 这些分叉一旦collapse回「正文即一切」，用户会看到代码丢身体、镜像复制空串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TEXT_PROP,
  CODE_TYPE,
  EMBED_PROP,
  mkBlock,
  setBlockType,
  textRuns,
} from '../src/core/index.ts'
import { copySourceIdOf, copyTextOfBlock } from '../src/view/editor/copy-text.ts'

test('代码块复制得到标题与代码，不再二选一', () => {
  const b = mkBlock('代码题')
  setBlockType(b, CODE_TYPE)
  b.props = { ...b.props, [CODE_TEXT_PROP]: 'const x = 1' }
  assert.equal(copyTextOfBlock(b, () => undefined), '代码题\nconst x = 1')
})

test('露面复制指向源 id，文本不冒充源正文', () => {
  const src = mkBlock('')
  src.content = textRuns('源标题')
  const host = mkBlock('')
  host.props = { ...host.props, [EMBED_PROP]: { block: src.id, view: '' } }
  const find = (id: string) => (id === src.id ? src : undefined)
  assert.equal(copySourceIdOf(host), src.id)
  assert.match(copyTextOfBlock(host, find), /露面引用.*源标题/)
  assert.notEqual(copyTextOfBlock(host, find), '源标题')
})

test('普通块仍复制正文', () => {
  const b = mkBlock('')
  b.content = textRuns('一行字')
  assert.equal(copyTextOfBlock(b, () => undefined), '一行字')
})
