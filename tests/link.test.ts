/**
 * **外链协议白名单**的契约测试。
 *
 * 为什么它值得单测：`shell.openExternal`／`window.open` 吃**任意协议的 URL**，
 * `file:` 能读本地文件、`javascript:` 会在宿主上下文里求值。这里钉的是三件事：
 *   ① 白名单是**枚举**（不在名单里的一律拒，不靠「危险清单」列得全）；
 *   ② 拒绝要**带得出一句话**（种类 → 文案的映射只有一份，两处调用者说话才一致）；
 *   ③ 通过的 url 是**规范化后**的那一个（同一个地址只有一种写法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTERNAL_URL_SCHEMES,
  URL_REJECT_MSG,
  checkExternalUrl,
  rejectText,
  schemeLabelOf,
} from '../src/core/link.ts'
import { MSG } from '../src/core/msg.ts'

test('① 白名单只有 http / https 两个协议', () => {
  assert.deepEqual([...EXTERNAL_URL_SCHEMES], ['http:', 'https:'])
  assert.ok(checkExternalUrl('https://qua.leay.net/arch.html').ok)
  assert.ok(checkExternalUrl('http://example.com/a?b=1#c').ok)
  // 大小写不同的协议写法：规范化之后一样放行
  assert.ok(checkExternalUrl('HTTPS://EXAMPLE.COM').ok)
})

test('①b 非 http(s) 一律拒（file / javascript / data / mailto …）', () => {
  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'mailto:a@b.c',
    'qua://something',
    'about:blank',
  ]) {
    const r = checkExternalUrl(url)
    assert.equal(r.ok, false, `${url} 不该被放行`)
    assert.equal(r.ok === false && r.kind, 'scheme')
  }
})

test('①c 空串与「没有协议的裸域名」是两种拒绝（都要有话说）', () => {
  const empty = checkExternalUrl('   ')
  assert.equal(empty.ok, false)
  assert.equal(empty.ok === false && empty.kind, 'empty')

  const bare = checkExternalUrl('qua.leay.net')
  assert.equal(bare.ok, false, '裸域名不是「协议不允许」，是输入不完整')
  assert.equal(bare.ok === false && bare.kind, 'malformed')
  assert.equal(bare.ok === false && bare.scheme, '', '取不出协议 ⇒ 协议名为空串')
})

test('② 拒绝种类 → 文案：映射只有一份，且每种都能取到真文案（不是把 id 念出来）', () => {
  for (const kind of ['empty', 'malformed', 'scheme'] as const) {
    const id = URL_REJECT_MSG[kind]
    const text = rejectText({ kind, scheme: 'file' })
    assert.notEqual(text, id, `${kind} 应取到字典里的文案`)
    assert.ok(text.length > 0)
  }
  // `scheme` 那一句要把协议名说出来：否则用户不知道自己写的是哪一种
  const msg = rejectText({ kind: 'scheme', scheme: 'javascript' })
  assert.ok(msg.includes('javascript'), `应点名被拒的协议：${msg}`)
  assert.ok((MSG[URL_REJECT_MSG.scheme] as string).includes('{scheme}'), '字典里带占位符')
})

test('②b schemeLabelOf：`https:` ⇒ `https`（给用户看的那个词）', () => {
  assert.equal(schemeLabelOf('https:'), 'https')
  assert.equal(schemeLabelOf('javascript:'), 'javascript')
  assert.equal(schemeLabelOf('nonsense'), '')
})

test('③ 放行时给的是规范化之后的 url（同一个地址只有一种写法）', () => {
  const r = checkExternalUrl('HTTPS://Example.com:443/a/./b?x=1#y')
  assert.equal(r.ok, true)
  assert.ok(r.ok && r.url.startsWith('https://'), `应带规范化后的地址：${r.ok ? r.url : ''}`)
  assert.ok(r.ok && r.url.includes('example.com'), '主机名按规范小写')
})
