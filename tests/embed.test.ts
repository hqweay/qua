/**
 * **露面（镜像）的模型层**：指针的形状、源解析的三种状态、以及「源换成指针目标」这一行。
 *
 * 为什么单测只钉这一层：渲染（岛／表格）由真浏览器冒烟验；这一层的三条错法都是**静默**的——
 *   · 指针形状读错 ⇒ 一块普通空块（看起来像「这里本来就空」）；
 *   · 源没换 ⇒ 镜像画的是自己的空子块（永远空，且不报错）；
 *   · 自己指自己 ⇒ 递归渲染（构造函数都拦不住，只能在判据里给一个状态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBED_PROP,
  EMBED_TYPE,
  activeView,
  canonicalViews,
  isEmbedBlock,
  isViewRoot,
  mkBlock,
  readEmbed,
  resolveEmbed,
  sourceOf,
  type Block,
  typeDeclOf,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'

const mk = (id: string, text: string, children: Block[] = [], props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children,
  created: 1000,
  modified: 1000,
  ...(props ? { props } : {}),
})

const embed = (id: string, target: string, props?: Record<string, unknown>): Block =>
  mk(id, '', [], { _type: EMBED_TYPE, [EMBED_PROP]: { block: target }, ...(props ?? {}) })

/* ------------------------------------------------------------ 指针 */

test('readEmbed：只认「非空字符串的 block」，坏形状一律 null（不猜、不修）', () => {
  assert.deepEqual(readEmbed(embed('e', 'a')), { block: 'a' })
  for (const bad of [
    undefined,
    mk('x', ''),
    mk('x', '', [], { [EMBED_PROP]: null }),
    mk('x', '', [], { [EMBED_PROP]: 'a' }),
    mk('x', '', [], { [EMBED_PROP]: { block: '' } }),
    mk('x', '', [], { [EMBED_PROP]: { block: '   ' } }),
    mk('x', '', [], { [EMBED_PROP]: { block: 7 } }),
  ]) {
    assert.equal(readEmbed(bad), null, `不该读出一个指针：${JSON.stringify(bad?.props)}`)
  }
})

test('isEmbedBlock：指针在 ⇒ 是露面块；指针坏 ⇒ 不是（按普通块兜底，不静默变成空露面）', () => {
  assert.equal(isEmbedBlock(embed('e', 'a')), true)
  assert.equal(isEmbedBlock(mk('x', '', [], { [EMBED_PROP]: {} })), false)
})

/* ------------------------------------------------------------ 源 */

test('sourceOf：露面的源是**指针指向的那一块**，不是它自己', () => {
  assert.deepEqual(sourceOf(embed('e', 'a')), { kind: 'children', blockId: 'a' })
  // 普通块一个字不差
  assert.deepEqual(sourceOf(mk('p', 'x')), { kind: 'children', blockId: 'p' })
})

test('canonicalViews：露面的看法按「它指向的那一块」校验（大纲表格合法）', () => {
  const b = embed('e', 'a', {
    _views: [{ id: 'v1', kind: 'list-table', list: { sort: { col: 2, dir: 'asc' } } }],
    _activeView: 'v1',
  })
  const views = canonicalViews(b.props?._views, sourceOf(b))
  assert.equal(views.length, 1)
  assert.equal(views[0]!.kind, 'list-table')
  assert.equal(activeView(b)?.id, 'v1')
})

/* ------------------------------------------------------------ 解析 */

test('resolveEmbed：ok／dangling／self／broken 四态分开（每种都要能说一句人话）', () => {
  const target = mk('a', '源')
  const find = (id: string): Block | undefined => (id === 'a' ? target : undefined)

  assert.deepEqual(resolveEmbed(embed('e', 'a'), find), { status: 'ok', target })
  assert.deepEqual(resolveEmbed(embed('e', 'gone'), find), { status: 'dangling' })
  assert.deepEqual(resolveEmbed(embed('e', 'e'), find), { status: 'self' })
  assert.deepEqual(resolveEmbed(mk('x', ''), find), { status: 'broken' })
})

test('resolveEmbed：软删的源仍算「找得到」（回收站里能恢复；不是悬空）', () => {
  const target = mk('a', '源', [], { _deletedAt: 900 })
  const r = resolveEmbed(embed('e', 'a'), () => target)
  // 源是否「活着」由渲染层判（它要显示删除态），解析层只回答「这一块在不在库里」
  assert.equal(r.status, 'ok')
})

/* ------------------------------------------------------------ 类型 */

test('类型声明：露面块没有子块、正文只读（否则「它的孩子是谁」有两个答案）', () => {
  const decl = typeDeclOf(embed('e', 'a'))
  assert.equal(decl.id, EMBED_TYPE)
  assert.equal(decl.children, 'none')
  assert.equal(decl.text, 'readonly')
})

test('isViewRoot：露面带看法也是视图宿主（但装配层不该把它当整屏的视图根）', () => {
  const b = embed('e', 'a', { _views: [{ id: 'v1', kind: 'list-table' }], _activeView: 'v1' })
  assert.equal(isViewRoot(b), true)
})
