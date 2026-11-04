/**
 * 检索的**纯函数面**：分词三列、查询编译、扫描降级、片段高亮。
 *
 * 两条判据必须先钉住（否则后面所有 FTS 验收都建在流沙上）：
 *   ① CJK 查询**必须**编译出逐字 phrase `chars : "笔 记"`（写成 `chars : 笔记` 是静默 0）；
 *   ② 拼音查询的星号在引号**外**（`"bi ji"*`），且拉丁词仍能前缀命中。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { charsOf, tokenizeText } from '../../src/core/search/tokenizer.ts'
import { compileMatch, highlightSnippet, scanSearch } from '../../src/core/search/query.ts'
import { mkBlock } from '../../src/core/model/model.ts'
import { mkPropDef } from '../../src/core/props/props.ts'
import { plainText, textRuns } from '../../src/core/model/runs.ts'

const tok = (text: string) => tokenizeText(text, cut, pinyin as never)

test('分词三列：CJK 逐字、拉丁整段、拼音每字一个音节', () => {
  const t = tok('人口密度 CodeMirror 笔记')
  assert.match(t.seg, /人口密度/)
  assert.equal(t.chars, '人 口 密 度 CodeMirror 笔 记')
  assert.match(t.pinyin, /^ren kou mi du bi ji$/)
})

test('空文本的三列都是空串（空块不进索引，不该留下空行）', () => {
  assert.deepEqual(tok('   '), { seg: '', chars: '', pinyin: '' })
})

test('charsOf：标点被丢掉，但两侧的字仍在（过匹配的已知代价，靠原文子串收敛）', () => {
  assert.equal(charsOf('笔记，应用。'), '笔 记 应 用')
})

test('compileMatch：CJK 同时产 seg 与 chars phrase（缺一个就漏或静默 0）', () => {
  const m = compileMatch('笔记')
  assert.ok(m, '非空查询必须编译出表达式')
  assert.match(m, /seg : "笔记"/)
  assert.match(m, /chars : "笔 记"/)
  assert.doesNotMatch(m, /chars : "笔记"/, 'chars 不许写成一个整词 token')
})

test('compileMatch：多词之间是 AND，词内部是 OR', () => {
  const m = compileMatch('笔记 应用')!
  assert.match(m, /\) AND \(/)
  assert.match(m, /chars : "笔 记"/)
  assert.match(m, /chars : "应 用"/)
})

test('compileMatch：纯拉丁输入额外走拼音，星号在引号外；与字面是 OR', () => {
  const m = compileMatch('bi ji')!
  assert.match(m, /pinyin : "bi ji"\*/)
  assert.doesNotMatch(m, /"\*"/, '星号不许写进引号里')
  assert.match(m, /\) OR \(pinyin/, '拼音必须与字面 OR（否则正文没有拉丁词时永远不命中）')
})

test('compileMatch：空串/纯标点 ⇒ null（调用方给空结果，不查库）', () => {
  assert.equal(compileMatch('   '), null)
  assert.equal(compileMatch('，。！'), null)
})

test('compileMatch：查询词里的引号被剥掉（不破坏 FTS 语法，也不把标点当词）', () => {
  const m = compileMatch('a"b')!
  assert.doesNotMatch(m, /a"b/, '原样引号不许进表达式')
  assert.match(m, /seg : "a"\*/)
  assert.match(m, /seg : "b"\*/)
})

test('scanSearch：全部词都要出现；属性定义子树不算内容行', () => {
  const def = mkPropDef('字段', 'text')
  const hidden = mkBlock('字段说明 笔记', { created: 1, modified: 1 })
  def.children = [hidden]
  const hit = mkBlock('这是笔记应用', { created: 2, modified: 2 })
  const miss = mkBlock('这是应用', { created: 3, modified: 3 })
  const roots = [def, hit, miss]
  assert.deepEqual(scanSearch(roots, '笔记', 10), [hit.id])
  assert.deepEqual(scanSearch(roots, '笔记 应用', 10), [hit.id])
  assert.deepEqual(scanSearch(roots, '笔记', 0), [])
})

test('highlightSnippet：字面命中打标，窗口外的字用省略号', () => {
  const text = '前面很长很长很长很长很长很长很长很长很长很长的一段话，然后出现笔记这个词。'
  const parts = highlightSnippet(text, '笔记', 20)
  assert.ok(parts.some((p) => p.mark && p.text === '笔记'), JSON.stringify(parts))
  assert.equal(parts[0]?.text, '…', '命中在窗口之外时前面要有省略号')
})

test('highlightSnippet：拼音查询没有字面对应 ⇒ 不打错标', () => {
  const parts = highlightSnippet('虎鲸笔记', 'bi ji')
  assert.equal(parts.some((p) => p.mark), false)
  assert.equal(parts.map((p) => p.text).join(''), '虎鲸笔记')
})

test('高亮与内容投影同一口径：引用原子不进片段（不凭空造字）', () => {
  const b = mkBlock('', { created: 1, modified: 1 })
  b.content = [{ t: 'text', v: '看这个' }, { id: 'r1', t: 'ref', to: 'x' }, ...textRuns('笔记')]
  assert.equal(plainText(b.content), '看这个笔记')
  const parts = highlightSnippet(plainText(b.content), '笔记')
  assert.equal(parts.map((p) => p.text).join(''), '看这个笔记')
})
