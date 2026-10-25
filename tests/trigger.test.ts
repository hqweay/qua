/**
 * **触发字符检测**：`/`／`#`／`@` 三个引导符号的边界规则。
 *
 * 这组测试守的是「**该弹**」与「**不该弹**」两半：真浏览器冒烟只能验前半
 * （敲进去弹了没），而误弹（URL fragment、email）恰好是更难察觉的一半——
 * 它们不报错，只是在一段普通正文里多出一个浮层，用户敲空格才发现字没了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectTrigger } from '../src/core/index.ts'

test('detectTrigger：`/` 沿用斜杠菜单的边界（行首或空白之后；查询词里不能有空白或斜杠）', () => {
  assert.deepEqual(detectTrigger('/'), { ch: '/', from: 0, query: '' })
  assert.deepEqual(detectTrigger('打一行 /'), { ch: '/', from: 4, query: '' }, '空白之后算数')
  assert.deepEqual(detectTrigger('/bold'), { ch: '/', from: 0, query: 'bold' })
  assert.equal(detectTrigger('a/b'), null, '前面是字 ⇒ 这是正文里的斜杠')
  assert.equal(detectTrigger('https://x.dev'), null, '链接里的 `/` 不算')
  assert.equal(detectTrigger('/bo ld'), null, '查询词遇空白 ⇒ 这段语法结束')
})

test('detectTrigger：敲下 `#` 就弹（名字还没开始敲时查询词是空的）', () => {
  assert.deepEqual(detectTrigger('#'), { ch: '#', from: 0, query: '' })
  assert.deepEqual(detectTrigger('前面 #'), { ch: '#', from: 3, query: '' })
  assert.deepEqual(detectTrigger('#设计'), { ch: '#', from: 0, query: '设计' })
  assert.deepEqual(detectTrigger('（#设计'), { ch: '#', from: 1, query: '设计' }, '中文括号之后不空一格也算')
})

test('detectTrigger：`#` 前面是**字**也弹（不再要求先空格；`C#` 靠 Esc 退出）', () => {
  assert.deepEqual(detectTrigger('C#'), { ch: '#', from: 1, query: '' })
  assert.deepEqual(detectTrigger('C#语言'), { ch: '#', from: 1, query: '语言' })
  assert.deepEqual(detectTrigger('a#b'), { ch: '#', from: 1, query: 'b' })
  assert.deepEqual(detectTrigger('设计#稿'), { ch: '#', from: 2, query: '稿' })
  assert.deepEqual(detectTrigger('snake_#tag'), { ch: '#', from: 6, query: 'tag' })
})

test('detectTrigger：URL 的 `#fragment` 不是标签语法（前面是链接）', () => {
  assert.equal(detectTrigger('https://x.dev/'), null)
  assert.equal(detectTrigger('https://x.dev/#anchor'), null)
  assert.equal(detectTrigger('看这个 https://x.dev/page#段'), null)
  assert.deepEqual(detectTrigger('看这个页面 '), null, '没有触发字符')
})

test('detectTrigger：`#` 后面落了分隔符 ⇒ 这段语法结束（浮层该关，字留着）', () => {
  // 敲到分隔符就不再是「正在输入的查询词」：`#名` 从此是正文里的几个字（Esc 兜底的那一支）
  assert.equal(detectTrigger('#设计 '), null)
  assert.equal(detectTrigger('#设计，后面'), null)
  assert.equal(detectTrigger('# 设计'), null, '`#` 之后先空格 ⇒ 不是标签语法')
  assert.equal(detectTrigger('##'), null, '`#` 之后又一个 `#` ⇒ 不认')
})

test('detectTrigger：`@` 前面是字母/数字就不弹（挡掉 email）', () => {
  assert.deepEqual(detectTrigger('@'), { ch: '@', from: 0, query: '' })
  assert.deepEqual(detectTrigger('提到 @页面'), { ch: '@', from: 3, query: '页面' })
  assert.equal(detectTrigger('a@b.c'), null, 'email 里的 @ 不是触发')
  assert.equal(detectTrigger('user1@'), null)
  assert.equal(detectTrigger('@页面 后面'), null, '查询词遇空白 ⇒ 结束')
})

test('detectTrigger：**最近的触发字符**说了算（不会把后敲的符号并进前一段查询词）', () => {
  // `@a` 之后又空一格敲 `#`：判的是 `#` 那一段（这里是空查询），
  // 不能把 `#` 也算成 @ 的查询词。
  assert.deepEqual(detectTrigger('@a #'), { ch: '#', from: 3, query: '' })
  // `#` 紧贴字母也成立（触发不再要求空格）；最近的那个字符说了算，不回头看 `@`
  assert.deepEqual(detectTrigger('@a#'), { ch: '#', from: 2, query: '' })
  assert.deepEqual(detectTrigger('@a#b'), { ch: '#', from: 2, query: 'b' })
  assert.equal(detectTrigger('@a#b '), null, '`#b ` 的分隔符已经落下：这段语法结束，也不回头启用更早的 @')
})

test('detectTrigger：查询词上限 20 字（超了就当作这段已经结束）', () => {
  const twenty = '字'.repeat(20)
  assert.deepEqual(detectTrigger(`#${twenty}`), { ch: '#', from: 0, query: twenty })
  assert.equal(detectTrigger(`#${'字'.repeat(21)}`), null)
  assert.equal(detectTrigger(`@${'a'.repeat(21)}`), null)
  assert.equal(detectTrigger(`/${'a'.repeat(21)}`), null)
})

test('detectTrigger：组合期（输入法中间态）一律不触发', () => {
  assert.deepEqual(detectTrigger('#设计', { composing: true }), null)
  assert.deepEqual(detectTrigger('@', { composing: true }), null)
  assert.deepEqual(detectTrigger('/', { composing: true }), null)
  assert.deepEqual(detectTrigger('#设计'), { ch: '#', from: 0, query: '设计' }, '不在组合期时同一条文本是触发的')
})
