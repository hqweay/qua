/**
 * 块类型声明的判据：引文与代码块是同一棵骨架树上的两个新类型，
 * 层级不落在块上——树的深度已经是层级，再存一个 level 就是第二真相。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CODE_TYPE,
  LANG_PROP,
  QUOTE_TYPE,
  TYPE_DECLS,
  canConvertBlockType,
  mkBlock,
  prop,
  setBlockType,
  typeDeclOf,
} from '../src/core/index.ts'
import { systemPropViolation } from '../src/core/props/system-props.ts'

test('引文与代码块：正文可写，代码块多开一行内换行能力', () => {
  assert.equal(TYPE_DECLS[QUOTE_TYPE]?.children, 'content')
  assert.equal(TYPE_DECLS[QUOTE_TYPE]?.text, 'editable')
  assert.notEqual(TYPE_DECLS[QUOTE_TYPE]?.multiline, true)
  assert.equal(TYPE_DECLS[CODE_TYPE]?.children, 'content')
  assert.equal(TYPE_DECLS[CODE_TYPE]?.text, 'editable')
  assert.equal(TYPE_DECLS[CODE_TYPE]?.multiline, true)

  const b = mkBlock('const x = 1', { props: { _type: CODE_TYPE } })
  assert.equal(typeDeclOf(b).multiline, true)
  assert.equal(canConvertBlockType(b), true)
})

test('没有标题类型，也没有层级参数：结构与字号都不住在块里', () => {
  assert.equal(TYPE_DECLS['core/heading'], undefined)
  for (const decl of Object.values(TYPE_DECLS)) {
    assert.ok(!('_level' in decl), '类型声明里不许有层级参数')
  }
  assert.match(systemPropViolation('_level', 2) ?? '', /unregistered/)
})

test('_lang 是登记过的系统属性：空串和空白不算语言', () => {
  assert.equal(systemPropViolation(LANG_PROP, 'ts'), null)
  assert.equal(systemPropViolation(LANG_PROP, 'python'), null)
  assert.match(systemPropViolation(LANG_PROP, '') ?? '', /invalid value/)
  assert.match(systemPropViolation(LANG_PROP, '   ') ?? '', /invalid value/)
})

test('转回别的骨架会清掉语言，撤销仍是一步', () => {
  const b = mkBlock('x', { props: { _type: CODE_TYPE, [LANG_PROP]: 'ts' } })
  assert.equal(setBlockType(b, QUOTE_TYPE), true)
  assert.equal(prop<string>(b, '_type'), QUOTE_TYPE)
  assert.equal(prop<string>(b, LANG_PROP), undefined, '引文不解释语言提示')

  const code = mkBlock('x')
  code.props = { [LANG_PROP]: 'js' }
  assert.equal(setBlockType(code, CODE_TYPE), true)
  assert.equal(prop<string>(code, LANG_PROP), 'js', '进代码块时保留调用方给的语言')
})

test('换骨架准入：身份与只读正文不给转换', () => {
  assert.equal(canConvertBlockType(mkBlock('正文')), true)
  assert.equal(canConvertBlockType(mkBlock('', { props: { _lists: ['page'], _aliases: ['页'] } })), false)
  assert.equal(canConvertBlockType(mkBlock('', { props: { _lists: ['tag'], _aliases: ['标签'] } })), false)
  assert.equal(canConvertBlockType(mkBlock('', { props: { _date: '2020-01-01' } })), false)
  assert.equal(canConvertBlockType(mkBlock('', { props: { _type: 'core/divider' } })), false)
})
