/**
 * **标签＝块级分类字段**的纯逻辑测试。
 *
 * 这里钉的是「标签没有位点」这件事的六个后果：
 *   ① 打标签写的是块上的 `props._tags`，正文一个字节不动；
 *   ② 摘掉归属 ⇒ 成员列表随之变空，不留孤儿；
 *   ③ 标签是一个 `tag` 角色的**块**，同名页块不会因为同名就变成标签；
 *   ④ 标签改名 ⇒ 显示名跟着变（复用 ref 解析），且**不改变归属的判定**；
 *   ⑤ 规范化只有一处（`#设计` 与 `#设计 ` 是同一个标签）；
 *   ⑥ 「谁带这个标签」是派生扫描（`tagMemberIds`），顺序＝用户打的先后。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  addTagId,
  allTags,
  edgeSourceIds,
  ensureTag,
  findTagByName,
  hasRole,
  hasTag,
  mkTagBlock,
  normalizeTag,
  removeTagId,
  tagIdsOf,
  tagMemberIds,
  tagsOf,
  trailingHashTag,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })

test('① ensureTag：找到或创建，幂等（第二次不新建）', () => {
  const forest: Block[] = []
  const first = ensureTag(forest, '设计')
  assert.equal(first.created, true)
  assert.equal(forest.length, 1)
  assert.deepEqual(forest[0]!.props?._roles, ['tag'], '标签是一个带 tag 角色的块')

  const second = ensureTag(forest, '设计')
  assert.equal(second.created, false)
  assert.equal(second.block?.id, first.block?.id, '同一个标签不该建出第二块')
  assert.equal(forest.length, 1)
})

test('①b addTagId / removeTagId：写块上的归属，正文不动，幂等，顺序就是打的先后', () => {
  const forest: Block[] = []
  const design = ensureTag(forest, '设计').block!
  const todo = ensureTag(forest, 'todo').block!
  const block = b('a', '正文里一个字都不该变')

  assert.equal(addTagId(block, design.id), true)
  assert.equal(addTagId(block, todo.id), true)
  assert.deepEqual(tagIdsOf(block), [design.id, todo.id], '追加到末尾 ⇒ 顺序＝用户打的先后')
  assert.equal(block.text, '正文里一个字都不该变', '归属是块级字段，不占正文')
  assert.equal(addTagId(block, design.id), false, '同一标签打两次只算一条')

  assert.equal(removeTagId(block, design.id), true)
  assert.deepEqual(tagIdsOf(block), [todo.id])
  assert.equal(removeTagId(block, design.id), false, '幂等')

  assert.equal(removeTagId(block, todo.id), true)
  assert.equal(tagIdsOf(block).length, 0)
  assert.equal(block.props?._tags, undefined, '最后一个摘掉时不留空壳')
})

test('② 摘掉归属 ⇒ 成员列表空出来（不留悬空记录）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const a = b('a', '一块')
  forest.push(a)
  addTagId(a, todo.id)
  assert.equal(hasTag(a, todo.id), true)
  assert.deepEqual([...tagMemberIds(todo.id, forest)], ['a'])

  removeTagId(a, todo.id)
  assert.equal(hasTag(a, todo.id), false)
  assert.equal(tagMemberIds(todo.id, forest).size, 0, '成员列表也要跟着空，不留悬空记录')
})

test('③ 同名页块 ⇒ 复用它并加 tag 角色（名字空间合并，同名必同一块）', () => {
  const forest: Block[] = [b('p', '设计', { props: { _roles: ['page'] } })]
  const found = ensureTag(forest, '设计')
  assert.equal(found.created, false, '已有同名块 ⇒ 不建第二个块')
  assert.equal(found.reused, true, '这一种是「复用并加角色」，要给用户可见反馈')
  assert.equal(found.block?.id, 'p')
  assert.equal(forest.length, 1)
  assert.ok(hasRole(found.block!, 'tag'), '复用后它真的成了标签')
  assert.deepEqual(
    allTags(forest).map((t) => t.id),
    ['p'],
    'allTags 按角色判定，不看名字',
  )
})

test('④ 标签改名 ⇒ 显示名跟着变，但归属的判定不变（认 id 不认名字）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const a = b('a', '一块')
  forest.push(a)
  addTagId(a, todo.id)

  const before = findTagByName(forest, 'todo')?.id
  todo.text = '待办' // 改名
  const after = findTagByName(forest, '待办')?.id

  assert.equal(after, before, '改名后同一块仍在（id 没变）')
  assert.equal(hasTag(a, todo.id), true, '**归属不受改名影响** —— 这正是认 id 的意义')
  assert.equal(findTagByName(forest, 'todo'), undefined, '旧名字不再解析到它')
})

test('⑤ 规范化只有一处：大小写与空白不产生第二个标签', () => {
  const forest: Block[] = []
  const a = ensureTag(forest, '设计')
  const b2 = ensureTag(forest, ' 设计 ')
  const c = ensureTag(forest, 'TODO')
  const d = ensureTag(forest, 'todo')
  assert.equal(b2.block?.id, a.block?.id)
  assert.equal(d.block?.id, c.block?.id)
  assert.equal(forest.length, 2)
  assert.equal(normalizeTag('  TODO '), 'todo')
})

test('⑤b 空名字不建标签（没有身份的标签是孤儿）', () => {
  const forest: Block[] = []
  const r = ensureTag(forest, '   ')
  assert.equal(r.block, null)
  assert.equal(r.created, false)
  assert.equal(forest.length, 0)
})

test('⑥ 标签成员 ＝ 打这个标签的块（派生扫描，同一块多次只算一条）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const done = ensureTag(forest, 'done').block!
  const a = b('a', '')
  const c = b('c', '')
  const bb = b('b', '')
  forest.push(a, bb, c)
  addTagId(a, todo.id)
  addTagId(bb, todo.id)
  addTagId(a, todo.id) // 幂等：同一块打两次仍是一个成员
  addTagId(c, done.id)

  assert.deepEqual([...tagMemberIds(todo.id, forest)].sort(), ['a', 'b'])
  assert.deepEqual([...tagMemberIds(done.id, forest)], ['c'])
})

test('⑥b tagsOf：返回标签块本身（活引用），顺序＝打的先后', () => {
  const forest: Block[] = []
  const x = ensureTag(forest, 'x').block!
  const y = ensureTag(forest, 'y').block!
  const a = b('a', '')
  forest.push(a)
  addTagId(a, y.id)
  addTagId(a, x.id)
  addTagId(a, x.id) // 重复 id 不该出现两遍
  const got = tagsOf(a, forest)
  assert.deepEqual(
    got.map((t) => t.id),
    [y.id, x.id],
    '按打的先后；同一标签不重复',
  )
  assert.equal(got[0], y, '返回的是块本身，不是名字的拷贝')
})

test('⑥c tagsOf：归属指向的块不在了 ⇒ 那一格跳过（不造假目标）', () => {
  const a = b('a', '', { props: { _tags: ['gone'] } })
  assert.deepEqual(tagsOf(a, [a]), [])
})

test('⑥d edgeSourceIds：只剩引用（标签不再是正文里的边）', () => {
  const atoms = [
    { id: 'e1', kind: 'page' as const, blockId: 'a', start: 0, end: 1, label: 'x', target: { kind: 'page' as const, id: 't1' } },
    { id: 'e2', kind: 'image' as const, blockId: 'b', start: 0, end: 1, label: 'p.png' },
  ]
  assert.deepEqual([...edgeSourceIds(atoms, 't1')], ['a'])
  assert.deepEqual([...edgeSourceIds(atoms, 'p.png')], [], '图片不指块，天然不是指向边')
})

test('mkTagBlock：名字就是正文，不带 #（# 是呈现时加的装饰）', () => {
  const t = mkTagBlock('设计')
  assert.equal(t.text, '设计')
  assert.deepEqual(t.props?._roles, ['tag'])
  assert.equal(t.props?._icon, 'lucide:hash')
})

/* ------------------------------------------------------------ 正文里敲 # */

/**
 * **敲 `#名字` 的识别规则**（纯函数，零 DOM）。
 *
 * 判据是「只认**已闭合**的那个」：一边敲一边成边会让手感崩掉，
 * 而扫全行又会让「想写字面量 #1」变成一次不可撤销的模型改动。
 *
 * ⚠️ 识别与「落成归属」是两件事：这个函数只回答「这段正文里有没有一个刚闭合的名字」，
 *    写成 `_tags` 的路径在装配层（输入路径还没接）。
 */
test('trailingHashTag：`#名字` **后面跟了分隔符**才成边（行尾不算）', () => {
  // 空格：区间**不含**那个空格
  assert.deepEqual(trailingHashTag('#设计 后面'), { name: '设计', from: 0, to: 3 })
  assert.deepEqual(trailingHashTag('前面 #设计 '), { name: '设计', from: 3, to: 6 })
  assert.deepEqual(trailingHashTag('#设计，后面'), { name: '设计', from: 0, to: 3 }, '中文标点也是分隔符')
  assert.deepEqual(trailingHashTag('a #b,c'), { name: 'b', from: 2, to: 4 }, '英文逗号同样分隔')
})

/**
 * **行尾不算闭合**——这条是踩出来的，不是想出来的。
 *
 * 每敲一个字符都会同步一次，若把行尾当闭合，`#自` 就会在最边缘那一刻成边：
 * 标签被建成「自」，接着敲的「动边」留在正文里。
 * ⇒ 必须等用户敲下那个分隔符。
 */
test('trailingHashTag：还在敲（行尾没有分隔符）⇒ 不成边', () => {
  assert.equal(trailingHashTag('#设计'), null, '刚敲完名字、还没打分隔符 ⇒ 继续等')
  assert.equal(trailingHashTag('价格 #1'), null, '同上')
})

test('trailingHashTag：没闭合 / 空名字 / 没有 # ⇒ 不认', () => {
  assert.equal(trailingHashTag('没有井号'), null)
  assert.equal(trailingHashTag('#'), null, '光一个 # 不成边（否则打井号要先打空格）')
  assert.equal(trailingHashTag('# 设计'), null, '# 之后直接空白 ⇒ 没有名字')
  // 数字也是合法的标签名：`价格 #1 `（后面有空格）就成边。
  // 要不要允许由产品决定，但**识别层不该替它猜**——「是不是数字」是另一层的事。
  assert.deepEqual(trailingHashTag('价格 #1 '), { name: '1', from: 3, to: 5 })
})

test('trailingHashTag：只取**最后一个**（刚写完的那个）', () => {
  const got = trailingHashTag('#甲 #乙 ')
  assert.deepEqual(got, { name: '乙', from: 3, to: 5 }, '先写的那个不该被重复处理')
})
