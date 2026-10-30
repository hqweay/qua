/**
 * **露面（镜像）的模型层**：指针的形状、源解析的三种状态、「源换成指针目标」这一行，
 * 以及本次重构的核心：**看法住在源块上，露面只存一次选择**。
 *
 * 为什么单测只钉这一层：渲染（岛／表格）由真浏览器冒烟验；这一层的错法都是**静默**的——
 *   · 指针形状读错 ⇒ 一块普通空块（看起来像「这里本来就空」）；
 *   · 源没换 ⇒ 镜像画的是自己的空子块（永远空，且不报错）；
 *   · 自己指自己 ⇒ 递归渲染（构造函数都拦不住，只能在判据里给一个状态）；
 *   · 看法存在露面块上 ⇒ 同一批块在两处各有一份配置，改一处另一处不动（也不报错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EMBED_PROP,
  EMBED_TYPE,
  FOLLOW_VIEW,
  OUTLINE_VIEW,
  bindingOfEmbed,
  isEmbedBlock,
  isViewRoot,
  mkBlock,
  readEmbed,
  resolveBoundView,
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

const embed = (id: string, target: string, view = '', props?: Record<string, unknown>): Block =>
  mk(id, '', [], { _type: EMBED_TYPE, [EMBED_PROP]: { block: target, view }, ...(props ?? {}) })

/* ------------------------------------------------------------ 指针 */

test('readEmbed：只认「非空字符串的 block」；`view` 缺席按「跟随源」——不是坏形状', () => {
  assert.deepEqual(readEmbed(embed('e', 'a')), { block: 'a', view: FOLLOW_VIEW })
  // `view` 缺席：老老实实退回「跟随源块的默认看法」，而不是把用户塞进某一张视图
  assert.deepEqual(readEmbed(mk('x', '', [], { [EMBED_PROP]: { block: 'a' } })), { block: 'a', view: FOLLOW_VIEW })
  // 显式选了「强制大纲」/某张视图 id 都原样带走
  assert.deepEqual(readEmbed(embed('e', 'a', OUTLINE_VIEW)), { block: 'a', view: OUTLINE_VIEW })
  assert.deepEqual(readEmbed(embed('e', 'a', 'v-1')), { block: 'a', view: 'v-1' })
  for (const bad of [
    undefined,
    mk('x', ''),
    mk('x', '', [], { [EMBED_PROP]: null }),
    mk('x', '', [], { [EMBED_PROP]: 'a' }),
    mk('x', '', [], { [EMBED_PROP]: { block: '' } }),
    mk('x', '', [], { [EMBED_PROP]: { block: '   ' } }),
    mk('x', '', [], { [EMBED_PROP]: { block: 7 } }),
    mk('x', '', [], { [EMBED_PROP]: ['a'] }),
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
  const target = mk('a', '源', [mk('k', '子')])
  const find = (id: string): Block | undefined => (id === 'a' ? target : undefined)
  assert.deepEqual(sourceOf(embed('e', 'a'), find), { kind: 'children', blockId: 'a' })
  // 普通块一个字不差
  assert.deepEqual(sourceOf(mk('p', 'x')), { kind: 'children', blockId: 'p' })
  // 目标不存在 ⇒ children 落回露面块自己（一片空），由渲染层说一句实话
  assert.deepEqual(sourceOf(embed('e', 'gone'), find), { kind: 'children', blockId: 'e' })
})

test('sourceOf：深度 1 构造性截断——露面指向露面时不再往下钻', () => {
  const inner = embed('i', 'a')
  const outer = embed('o', 'i')
  const find = (id: string): Block | undefined => (id === 'i' ? inner : id === 'a' ? mk('a', '源') : undefined)
  // 目标自己又是露面 ⇒ 停在 `o`（露面体里不再展开露面）
  assert.deepEqual(sourceOf(outer, find), { kind: 'children', blockId: 'o' })
})

/* ------------------------------------------------------------ 解析 */

test('resolveEmbed：ok／dangling／self／broken 四态分开（每种都要能说一句人话）', () => {
  const target = mk('a', '源')
  const find = (id: string): Block | undefined => (id === 'a' ? target : undefined)

  assert.deepEqual(resolveEmbed(embed('e', 'a'), find), { status: 'ok', target, view: FOLLOW_VIEW })
  assert.deepEqual(resolveEmbed(embed('e', 'a', 'v-9'), find), { status: 'ok', target, view: 'v-9' })
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

/* ------------------------------------------------------------ 看法 */

test('露面块自己**不存**看法：`_views` 在它身上读不出来（配置住在源块）', () => {
  const b = embed('e', 'a', 'v-1', { _views: [{ id: 'v1', kind: 'list-table' }], _activeView: 'v1' })
  // 露面的源是 children，而它指向的块不在这张"库里" ⇒ 自己的 `_views` 也不该被当成它的看法
  const binding = bindingOfEmbed(b)
  assert.deepEqual(binding, { owner: { kind: 'block', blockId: 'a' }, view: 'v-1' })
})

test('resolveBoundView：`outline` 强制大纲／`""` 跟随源／id 解析不到 ⇒ 退回默认并报降级', () => {
  const data = { views: [{ id: 'v-2', kind: 'table' as const }], activeView: 'v-2' }
  assert.deepEqual(resolveBoundView({ owner: { kind: 'block', blockId: 'a' }, view: OUTLINE_VIEW }, data), {
    view: null,
    degraded: false,
  })
  assert.equal(resolveBoundView({ owner: { kind: 'block', blockId: 'a' }, view: FOLLOW_VIEW }, data).view?.id, 'v-2')
  assert.equal(resolveBoundView({ owner: { kind: 'block', blockId: 'a' }, view: 'v-2' }, data).view?.id, 'v-2')
  const gone = resolveBoundView({ owner: { kind: 'block', blockId: 'a' }, view: 'v-gone' }, data)
  assert.equal(gone.degraded, true, '视图没了要报降级（不猜、也不偷偷改指针）')
  assert.equal(gone.view?.id, 'v-2', '退回源块自己的默认看法')
})

/* ------------------------------------------------------------ 类型 */

test('类型声明：露面块没有子块、正文只读（否则「它的孩子是谁」有两个答案）', () => {
  const decl = typeDeclOf(embed('e', 'a'))
  assert.equal(decl.id, EMBED_TYPE)
  assert.equal(decl.children, 'none')
  assert.equal(decl.text, 'readonly')
})

test('isViewRoot：露面块**不算**视图宿主（它自己不拥有配置）', () => {
  const b = embed('e', 'a', 'v-1', { _views: [{ id: 'v1', kind: 'list-table' }], _activeView: 'v1' })
  // `_views` 出现在露面块上是坏数据（v29 起不该有）；这里钉的是「它不算视图宿主」
  assert.equal(isViewRoot(b), false)
})

test('mkBlock 造一块：默认没有指针（露面是显式动作，不是默认形状）', () => {
  assert.equal(readEmbed(mkBlock('普通')), null)
})
