/**
 * **地址**（别名）：页名 / 标签名共用同一个名字空间。
 *
 * 口径（方案：别名 ＝ 唯一地址）：
 *   · 地址住在 `props._aliases`，0..N，**首个是主名**；正文只是描述、不在地址空间；
 *   · 每个别名**规范化后全局唯一**；`/` 是名字里的路径分隔符，不产生父子关系；
 *   · 显示走 `aliasLeaf`（主名叶子 > 正文），比较走 `normalizeAlias`（唯一实现）。
 *
 * 这里钉住：读（任一名命中 / 叶子显示）、写（加删／设主名／改名保留位置）、
 * 冲突（同别名、大小写、多别名）、以及兼容包装没有第二套语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { plainText, textRuns } from '../src/core/runs.ts'
import {
  addAlias,
  addList,
  addressOf,
  aliasConflict,
  aliasLeaf,
  aliasesOf,
  canRemoveAlias,
  claimAlias,
  claimAliases,
  displayNameOf,
  ensureTag,
  findByAlias,
  findTagByName,
  hasList,
  isAddressable,
  normalizeAlias,
  primaryAliasOf,
  removeAlias,
  removeList,
  renameAlias,
  setPrimaryAlias,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, content: textRuns(text), children: [], ...extra })
const withAliases = (id: string, aliases: string[], text = ''): Block =>
  b(id, text, { props: { _aliases: aliases } })
const page = (id: string, aliases: string[], text = ''): Block =>
  b(id, text, { props: { _aliases: aliases, _lists: ['page'], _display: 'alias' } })

/* ------------------------------------------------------------ 规范化 / 显示 */

test('normalizeAlias：分段 trim、丢空段、大小写折叠 —— 只用于比较，不改写名字', () => {
  assert.equal(normalizeAlias('  设计 '), '设计')
  assert.equal(normalizeAlias('Design'), 'design')
  assert.equal(normalizeAlias(' A / B '), 'a/b')
  assert.equal(normalizeAlias('a//b/'), 'a/b')
  const x = withAliases('x', [' Design '])
  assert.equal(addressOf(x), 'design')
  assert.equal(aliasesOf(x)[0], ' Design ', '规范化不写回存储')
})

test('aliasLeaf：显示取最后一个 / 后的段；没有叶子时退回原串', () => {
  assert.equal(aliasLeaf('A / B'), 'B')
  assert.equal(aliasLeaf('A/B'), 'B')
  assert.equal(aliasLeaf('设计'), '设计')
  assert.equal(aliasLeaf('A/'), 'A/', '空叶子不吞掉全名')
  assert.equal(aliasLeaf('  '), '')
})

test('addressesOf / addressOf / primaryAliasOf：首个主名，全部别名都算地址', () => {
  const x = withAliases('x', [' A/B ', 'C'], '描述')
  assert.equal(primaryAliasOf(x), ' A/B ')
  assert.equal(addressOf(x), 'a/b')
  assert.equal(displayNameOf(x), 'B', '主名叶子 > 正文')
})

test('displayNameOf：主名叶子 > 正文；正文不在地址空间（只是描述）', () => {
  const nameless = b('n', '一段描述')
  assert.equal(displayNameOf(nameless), '一段描述', '没有名字时退回正文')
  assert.equal(isAddressable(nameless), false, '正文不是地址')
  assert.equal(findByAlias([nameless], '一段描述'), undefined)
})

/* ------------------------------------------------------------ 读 */

test('findByAlias：命中块的**任一**别名；只认 _aliases，不认正文', () => {
  const forest = [withAliases('p', ['设计', 'design'])]
  assert.equal(findByAlias(forest, '设计')?.id, 'p')
  assert.equal(findByAlias(forest, ' DESIGN ')?.id, 'p', '第二个别名也能找到')
  assert.equal(findByAlias(forest, '别的')?.id, undefined)

  const plain = b('q', '设计')
  assert.equal(findByAlias([plain], '设计'), undefined, '正文恰好同名不构成地址')
})

test('findByAlias：accept 只收窄参与比较的块，规范化仍是同一处', () => {
  const forest = [withAliases('p', ['设计']), withAliases('t', ['设计'])]
  assert.equal(findByAlias(forest, '设计')?.id, 'p', '默认先序第一个')
  assert.equal(findByAlias(forest, '设计', (x) => x.id === 't')?.id, 't')
})

test('findByAlias 看不见被删的块：删除标记让地址空出来（遍历默认不进被删子树）', () => {
  const dead = withAliases('d', ['设计'])
  dead.props = { ...dead.props, _deletedAt: 1 }
  assert.equal(findByAlias([dead], ' 设计 '), undefined, '被删的块不再占地址')
  assert.equal(findByAlias([dead], ' 设计 ', () => true), undefined, 'accept 也收窄不回来——跳过发生在遍历层')
})

/* ------------------------------------------------------------ 冲突 */

test('aliasConflict：对每一块的**每个**别名比较；排除自己', () => {
  const a = withAliases('a', ['甲', '乙'])
  const c = withAliases('c', ['丙'])
  const forest = [a, c]
  assert.equal(aliasConflict(forest, c, '乙')?.id, 'a', '第二别名也参与查重')
  assert.equal(aliasConflict(forest, c, ' 乙 ')?.id, 'a', '比较走规范化')
  assert.equal(aliasConflict(forest, a, '甲'), undefined, '自己不算冲突')
  assert.equal(aliasConflict(forest, c, '丁'), undefined)
})

test('全局唯一：A/B 与 C/B 可共存，A/B 与 a/b 冲突', () => {
  const ab = withAliases('ab', ['A/B'])
  const cb = withAliases('cb', ['C/B'])
  assert.equal(aliasConflict([ab, cb], cb, 'a/b')?.id, 'ab')
  assert.equal(aliasConflict([ab], ab, 'c/b'), undefined, '叶子相同但全名不同 ⇒ 不冲突')
  assert.equal(aliasConflict([ab], ab, 'A / B'), undefined, '规范化后是同一地址 ⇒ 是自己的')
})

test('claimAlias：不占地址的块直接 ok（加列表前的提问）；占地址才查重', () => {
  const owner = withAliases('o', ['甲'])
  const forest = [owner]
  const fresh = b('n', '新块')
  assert.deepEqual(claimAlias(forest, fresh, '甲', false), { ok: true })
  assert.equal(claimAlias(forest, fresh, '甲', true).ok, false, '告知「加完之后要占地址」⇒ 查重')
  assert.deepEqual(claimAlias(forest, fresh, ''), { ok: true }, '空名字没有可占的地址')
})

test('claimAliases：返回第一个冲突', () => {
  const a = withAliases('a', ['甲'])
  const b2 = withAliases('b', ['乙'])
  const fresh = b('n', '新')
  const r = claimAliases([a, b2], fresh, ['丙', '乙', '甲'])
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.conflict.id, 'b')
})

/* ------------------------------------------------------------ 写：增删 / 主名 / 改名 */

test('addAlias：追加（末尾）；规范化去重；空串拒绝', () => {
  const x = withAliases('x', ['甲'])
  assert.equal(addAlias(x, ' 乙 '), true)
  assert.deepEqual(aliasesOf(x), ['甲', '乙'], '存 trim 后的原文，追加到末尾')
  assert.equal(addAlias(x, ' 乙 '), false, '规范化后同名 ⇒ 不重复')
  assert.equal(addAlias(x, '   '), false, '空串不是地址')
  assert.equal(primaryAliasOf(x), '甲', '首个仍是主名')
})

test('removeAlias / canRemoveAlias：主名也能删；但在列表里时最后一个名字不许删', () => {
  const tagged = withAliases('p', ['甲', '乙'])
  addList(tagged, 'tag')
  assert.equal(canRemoveAlias(tagged), true)
  assert.equal(removeAlias(tagged, '甲'), true, '主名也能删，第二个顶上')
  assert.deepEqual(aliasesOf(tagged), ['乙'])
  assert.equal(canRemoveAlias(tagged), false, '在列表里且只剩一个名字')
  assert.equal(removeAlias(tagged, '乙'), false, '拒绝删到 0 个')

  assert.equal(removeList(tagged, 'tag'), true)
  assert.equal(canRemoveAlias(tagged), true, '不在任何列表里 ⇒ 可以删到没有名字')
  assert.equal(removeAlias(tagged, '乙'), true)
  assert.equal(isAddressable(tagged), false)
  assert.equal(tagged.props?._aliases, undefined, '不留空数组')
})

test('setPrimaryAlias：移到首位；名字不存在 ⇒ false（不偷偷新增）', () => {
  const x = withAliases('x', ['甲', '乙', '丙'])
  assert.equal(setPrimaryAlias(x, '乙'), true)
  assert.deepEqual(aliasesOf(x), ['乙', '甲', '丙'], '只移动，不丢别的名字')
  assert.equal(setPrimaryAlias(x, '乙'), false, '已经是主名')
  assert.equal(setPrimaryAlias(x, '丁'), false)
})

test('renameAlias：保留位置；撞车时一个字节都不写', () => {
  const x = withAliases('x', ['甲', '乙', '丙'], '描述')
  const other = withAliases('o', ['丁'])
  const forest = [x, other]
  assert.deepEqual(renameAlias(forest, x, '乙', '戊'), { ok: true })
  assert.deepEqual(aliasesOf(x), ['甲', '戊', '丙'], '替换在原位置')
  assert.equal(plainText(x.content), '描述', '改名不写正文')

  const before = JSON.stringify(x.props)
  const bad = renameAlias(forest, x, '戊', '丁')
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.conflict.id, 'o')
  assert.equal(JSON.stringify(x.props), before, '撞车 ⇒ 拒绝，不改任何别名')
})

test('renameAlias：旧名不存在 ⇒ 追加新名（不静默丢调用）', () => {
  const x = withAliases('x', ['甲'])
  assert.deepEqual(renameAlias([x], x, '不存在', '乙'), { ok: true })
  assert.deepEqual(aliasesOf(x), ['甲', '乙'])
})

/* ------------------------------------------------------------ 改名 */

test('renameAlias：只改地址、**不写 text**（写回正文不会顺手重命名）', () => {
  const x = page('x', ['旧名'], '一段描述')
  const r = renameAlias([x], x, '旧名', '新名')
  assert.deepEqual(r, { ok: true })
  assert.deepEqual(aliasesOf(x), ['新名'])
  assert.equal(plainText(x.content), '一段描述', '正文是描述，改名一个字都不碰')
})

test('renameAlias：块还没有名字 ⇒ 追加；撞名 ⇒ 拒绝且一个字节都不写', () => {
  const x = b('x', '描述')
  assert.deepEqual(renameAlias([x], x, '', '名字'), { ok: true })
  assert.deepEqual(aliasesOf(x), ['名字'])

  const other = withAliases('o', ['占用了'])
  const r = renameAlias([other, x], x, '名字', '占用了')
  assert.equal(r.ok, false)
  assert.deepEqual(aliasesOf(x), ['名字'], '拒绝时一个字节都不写')
})

test('setPrimaryAlias：在已有的名字里挑一个当主名（不新增、不查重）', () => {
  const x = withAliases('x', ['甲', '乙'], '描述')
  assert.equal(setPrimaryAlias(x, '乙'), true)
  assert.deepEqual(aliasesOf(x), ['乙', '甲'], '移到首位，其余顺序不变')
  assert.equal(plainText(x.content), '描述')
  // 不新增：名单里没有的名字不会被偷偷造出来
  assert.equal(setPrimaryAlias(x, '丙'), false)
  assert.deepEqual(aliasesOf(x), ['乙', '甲'])
})

test('ensureTag / findTagByName：标签名字同样是地址（复用同一个规范化）', () => {
  const forest: Block[] = []
  const first = ensureTag(forest, ' 设计 ')
  assert.ok(first.block)
  const second = ensureTag(forest, '设计')
  assert.equal(second.block!.id, first.block!.id)
  assert.equal(forest.length, 1)
  assert.equal(findTagByName(forest, ' 设计 ')!.id, first.block!.id)
  assert.equal(hasList(first.block!, 'tag'), true)
})
