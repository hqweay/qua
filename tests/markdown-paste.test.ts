/**
 * 粘贴解析的判据：结构进树、字面不丢、不支持的整行原文。
 * 标题只建父子关系——块上没有层级字段，字号也不是数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMarkdown, type ParsedBlock, type ParsedInline } from '../src/core/markdown/parse.ts'

const body = (b: ParsedBlock): string =>
  b.inline.map((it: ParsedInline) => (it.t === 'text' ? it.v : it.t === 'link' ? it.v : `((${it.id}))`)).join('')

test('行内：粗/斜/删/代码、外链白名单、非 http(s) 留原文、引用记号', () => {
  const r = parseMarkdown('**粗** _斜_ ~~删~~ `码` [名](https://a.b/x) [内](/p) ((0123456789abcdef))')
  const b = r.blocks[0]!
  assert.deepEqual(b.inline, [
    { t: 'text', v: '粗', marks: { bold: true } },
    { t: 'text', v: ' ' },
    { t: 'text', v: '斜', marks: { italic: true } },
    { t: 'text', v: ' ' },
    { t: 'text', v: '删', marks: { strike: true } },
    { t: 'text', v: ' ' },
    { t: 'text', v: '码', marks: { code: true } },
    { t: 'text', v: ' ' },
    { t: 'link', v: '名', url: 'https://a.b/x' },
    { t: 'text', v: ' [内](/p) ' },
    { t: 'ref', id: '0123456789abcdef' },
  ])
})

test('节树：标题正文与后续内容同级为子块，子标题再下一层', () => {
  const r = parseMarkdown('# A\n正文\n## B\n子\n# C')
  assert.equal(r.blocks.length, 2, '两个一级标题是两个根')
  const a = r.blocks[0]!
  assert.equal(body(a), 'A')
  assert.deepEqual(a.children.map(body), ['正文', 'B'])
  assert.deepEqual(a.children[1]!.children.map(body), ['子'])
  assert.equal(body(r.blocks[1]!), 'C')
})

test('节树：跳级归一，空节是叶子父块，正文空的标题也留着', () => {
  const r = parseMarkdown('# A\n### C\n## B')
  const a = r.blocks[0]!
  assert.deepEqual(a.children.map(body), ['C', 'B'])
  assert.deepEqual(a.children[0]!.children, [], 'C 没有正文就是叶子父块')
  assert.deepEqual(a.children[1]!.children, [])
})

test('列表：缩进成子块，有序编号留在正文里', () => {
  const r = parseMarkdown('- 一\n  - 二\n    - 三\n- 四\n\n1. 第一\n2. 第二')
  assert.equal(r.blocks.length, 4, '空行分出两段，同级列表项是并列块')
  assert.equal(body(r.blocks[0]!), '一')
  assert.equal(body(r.blocks[0]!.children[0]!), '二')
  assert.equal(body(r.blocks[0]!.children[0]!.children[0]!), '三')
  assert.equal(body(r.blocks[1]!), '四')
  assert.equal(body(r.blocks[2]!), '1. 第一')
  assert.equal(body(r.blocks[3]!), '2. 第二')
})

test('引文、分割线与围栏：引文有类型，围栏整段原文并给一句提示', () => {
  const r = parseMarkdown('> 一句\n\n---\n\n```ts\nconst x = 1\n```')
  assert.equal(r.blocks[0]!.kind, 'quote')
  assert.equal(body(r.blocks[0]!), '一句')
  assert.equal(r.blocks[1]!.kind, 'divider')
  assert.equal(r.blocks[2]!.kind, 'fence')
  assert.equal(r.blocks[2]!.lang, 'ts')
  assert.equal(r.blocks[2]!.raw, '```ts\nconst x = 1\n```')
  assert.deepEqual(r.unsupported, [], '围栏已有代码编辑面，不再当不支持语法')
  assert.equal(r.blocks[2]!.code, 'const x = 1')
})

test('不支持的块整行原文，行内语法不转换', () => {
  const r = parseMarkdown('- [ ] 待办 **不转**\n| a | b |\n![图](/x.png)\n<div>html</div>\n[^1]: 脚注')
  assert.deepEqual(r.unsupported, ['task', 'table', 'image', 'html', 'footnote'])
  assert.deepEqual(r.blocks.map(body), ['- [ ] 待办 **不转**', '| a | b |', '![图](/x.png)', '<div>html</div>', '[^1]: 脚注'])
  assert.ok(r.blocks.every((b) => b.inline.every((it) => it.t === 'text')))
})
