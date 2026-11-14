/**
 * **脸与信号的回落闭集**（`core/identity/faces.ts` 的三条链）。
 *
 * 三函数是全部图标位/身份色的唯一判据源：链上每一档在这里钉住，
 * 回落集的「闭」才有人保证——多一个角色、少一档回落，测试先红。
 *
 * 钉的三件事：
 *   · 显式值（脸）永远赢过回落（信号）——用户给的识别符不吃角色默认的亏；
 *   · 自位回落集比指位小一档：页/日记在自位不借角色图标（圆点是「无脸默认」），
 *     普通块在指位是「空白但占位」；
 *   · 色只认色板封闭集内的显式值：借色一层、不递归；未知值按没配色处理（合法态不是错误态）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { colorOf, faceOf, iconOf, mkTagBlock, tagsById, type Block } from '../src/core/index.ts'
import { IDENTITY_COLORS, isColorValue } from '../src/core/model/model.ts'

const block = (props: Block['props'], children: Block[] = []): Block => ({
  id: `b-${Math.random().toString(36).slice(2, 8)}`,
  content: [],
  children,
  created: 0,
  modified: 0,
  ...(props ? { props } : {}),
})

test('faceOf：显式 _icon 是脸，永远赢过结构旗', () => {
  const tag = mkTagBlock('设计')
  tag.props = { ...(tag.props ?? {}), _icon: 'lucide:target' }
  assert.equal(faceOf(tag), 'lucide:target')
})

test('faceOf：结构旗回落——标签→hash／查询→漏斗／定义→滑杆', () => {
  assert.equal(faceOf(mkTagBlock('设计')), 'lucide:hash')
  assert.equal(faceOf(block({ _query: { where: { all: [] } } })), 'lucide:list-filter')
  assert.equal(faceOf(block({ _kind: 'select' })), 'lucide:sliders-horizontal')
})

test('faceOf：自位回落集比指位小一档——页/日记/普通块没有结构旗（圆点兜底）', () => {
  assert.equal(faceOf(block({ _aliases: ['a'], _lists: ['page'] })), undefined)
  assert.equal(faceOf(block({ _date: '2026-11-14' })), undefined)
  assert.equal(faceOf(block(undefined)), undefined)
})

test('iconOf：全角色默认——标签/日记/页/查询/定义各有一档', () => {
  assert.equal(iconOf(mkTagBlock('设计')), 'lucide:hash')
  assert.equal(iconOf(block({ _date: '2026-11-14' })), 'lucide:calendar')
  assert.equal(iconOf(block({ _aliases: ['a'], _lists: ['page'] })), 'lucide:file')
  assert.equal(iconOf(block({ _query: { where: { all: [] } } })), 'lucide:list-filter')
  assert.equal(iconOf(block({ _kind: 'select' })), 'lucide:sliders-horizontal')
})

test('iconOf：显式 _icon 优先；普通块＝无（空白但占位）', () => {
  assert.equal(iconOf(block({ _aliases: ['a'], _lists: ['page'], _icon: 'lucide:book-open' })), 'lucide:book-open')
  assert.equal(iconOf(block(undefined)), undefined)
})

test('iconOf：兼位按「越本质越靠前」——页＋标签读作标签', () => {
  assert.equal(iconOf(block({ _aliases: ['a'], _lists: ['page', 'tag'] })), 'lucide:hash')
})

test('colorOf：显式 _color 上自己的脸；色板外的值按没配色处理', () => {
  const byId = new Map<string, Block>()
  assert.deepEqual(colorOf(block({ _color: 'red' }), byId), { kind: 'solid', color: 'red' })
  // 未知值渲染中性——「无颜色」是合法态不是错误态
  assert.deepEqual(colorOf(block({ _color: '#ff0000' as string }), byId), { kind: 'none' })
})

test('colorOf：恰一个有色标签→借色；标签自己没配色不借', () => {
  const tag = mkTagBlock('重要')
  tag.props = { ...(tag.props ?? {}), _color: 'red' }
  const plain = mkTagBlock('普通')
  const byId = tagsById([tag, plain])
  const member = block({ _tags: [plain.id] })
  assert.deepEqual(colorOf(member, byId), { kind: 'none' })
  assert.deepEqual(colorOf(block({ _tags: [tag.id] }), byId), { kind: 'solid', color: 'red' })
})

test('colorOf：≥2 个有色标签→色环，顺序＝归属顺序（_tags 序）', () => {
  const t1 = mkTagBlock('甲')
  t1.props = { ...(t1.props ?? {}), _color: 'red' }
  const t2 = mkTagBlock('乙')
  t2.props = { ...(t2.props ?? {}), _color: 'blue' }
  const byId = tagsById([t1, t2])
  assert.deepEqual(colorOf(block({ _tags: [t1.id, t2.id] }), byId), {
    kind: 'ring',
    colors: ['red', 'blue'],
  })
  // 反向归属：环的顺序跟着用户打的先后，不是标签建的名字序
  assert.deepEqual(colorOf(block({ _tags: [t2.id, t1.id] }), byId), {
    kind: 'ring',
    colors: ['blue', 'red'],
  })
})

test('colorOf：显式 _color 赢过借色；借色只一层（有色标签被再归属不外传）', () => {
  const t1 = mkTagBlock('甲')
  t1.props = { ...(t1.props ?? {}), _color: 'red' }
  const t2 = mkTagBlock('乙')
  t2.props = { ...(t2.props ?? {}), _color: 'blue', _tags: [t1.id] }
  const byId = tagsById([t1, t2])
  // 标签乙自己显式配了 blue：它的脸是 blue，不叠加甲的 red
  assert.deepEqual(colorOf(t2, byId), { kind: 'solid', color: 'blue' })
})

test('色板是封闭集：8 色，判据与 model.ts 的 isColorValue 同一份', () => {
  assert.deepEqual([...IDENTITY_COLORS].sort(), ['blue', 'cyan', 'green', 'orange', 'pink', 'purple', 'red', 'yellow'])
  for (const c of IDENTITY_COLORS) assert.ok(isColorValue(c))
  assert.ok(!isColorValue('mauve'))
})

test('色板每个 key 在 tokens.css 都有一对身份 token（solid＋soft）——漏一个就是悬空引用', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8')
  for (const c of IDENTITY_COLORS) {
    assert.ok(css.includes(`--ui-identity-${c}:`), `缺 --ui-identity-${c}`)
    assert.ok(css.includes(`--ui-identity-${c}-soft:`), `缺 --ui-identity-${c}-soft`)
  }
})
