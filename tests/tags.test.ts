/**
 * **标签＝块级分类字段**的纯逻辑测试。
 *
 * 归属只有一份（`props._tags`），但可以有**两种露面**：块级 chip 与正文里的 `#名`（原子）。
 * 这里钉的是这件事的七个后果：
 *   ① 打标签写的是块上的 `props._tags`；块级入口**正文一个字节不动**；
 *   ② 摘掉归属 ⇒ 成员列表随之变空，不留孤儿；
 *   ③ 标签是一个 `tag` 角色的**块**，同名页块不会因为同名就变成标签；
 *   ④ 标签改名 ⇒ 显示名跟着变（复用 ref 解析），且**不改变归属的判定**；
 *   ⑤ 规范化只有一处（`#设计` 与 `#设计 ` 是同一个标签）；
 *   ⑥ 「谁带这个标签」是派生扫描（`tagMemberIds`），顺序＝用户打的先后；
 *   ⑦ 行内露面是「位置」，归属仍是「分类」：识别只在分隔符/编辑边界发生。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { plainText, textRuns } from '../src/core/runs.ts'
import { writeBlockContent } from '../src/core/model.ts'
import {
  addTagId,
  allTags,
  edgeSourceIds,
  ensureTag,
  findTagByName,
  hasList,
  hasTag,
  inlineTagIdsOf,
  mkTagBlock,
  normalizeTag,
  removeTagId,
  renameAlias,
  tagIdsOf,
  tagMemberIds,
  tagsOf,
  trailingHashTag,
} from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, content: textRuns(text), children: [], ...extra })

test('① ensureTag：找到或创建，幂等（第二次不新建）', () => {
  const forest: Block[] = []
  const first = ensureTag(forest, '设计')
  assert.equal(first.created, true)
  assert.equal(forest.length, 1)
  assert.deepEqual(forest[0]!.props?._aliases, ['设计'], '标签的名字进 `_aliases`')
  assert.deepEqual(forest[0]!.props?._lists, ['tag'], '标签是 `_lists` 里的一个露面')
  assert.equal(forest[0]!.props?._display, 'alias')

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
  assert.equal(plainText(block.content), '正文里一个字都不该变', '归属是块级字段，不占正文')
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

test('③ 同名页块 ⇒ 复用它并加 tag 露面（名字空间合并，同名必同一块）', () => {
  const forest: Block[] = [b('p', '设计', { props: { _aliases: ['设计'], _lists: ['page'], _display: 'alias' } })]
  const found = ensureTag(forest, '设计')
  assert.equal(found.created, false, '已有同名块 ⇒ 不建第二个块')
  assert.equal(found.reused, true, '这一种是「复用并加角色」，要给用户可见反馈')
  assert.equal(found.block?.id, 'p')
  assert.equal(forest.length, 1)
  assert.ok(hasList(found.block!, 'tag'), '复用后它真的成了标签')
  assert.ok(hasList(found.block!, 'page'), '原来的页露面不丢（兼位）')
  assert.deepEqual(
    allTags(forest).map((t) => t.id),
    ['p'],
    'allTags 按 _lists 判定，不看正文',
  )
})

test('④ 标签改名 ⇒ 显示名跟着变，但归属的判定不变（认 id 不认名字）', () => {
  const forest: Block[] = []
  const todo = ensureTag(forest, 'todo').block!
  const a = b('a', '一块')
  forest.push(a)
  addTagId(a, todo.id)

  const before = findTagByName(forest, 'todo')?.id
  // 名字在 `_aliases` 里；写正文（描述）**不该**改地址
  writeBlockContent(todo, textRuns('待办'))
  assert.equal(findTagByName(forest, '待办'), undefined, '正文不是地址 ⇒ 改正文不改名字')
  assert.equal(findTagByName(forest, 'todo')?.id, before, '地址仍是 todo')

  renameAlias(forest, todo, 'todo', '待办')
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

test('⑥d edgeSourceIds：引用与**行内标签**都算指向边（改名要重画它们）', () => {
  // a 引用 t1；b 带一张图片；c 有一枚行内标签露面（指向 t2）
  const blocks = [
    { id: 'a', content: [ { id: 'e1', t: 'ref' as const, to: 't1', label: 'x' } ], children: [] },
    { id: 'b', content: [ { id: 'e2', t: 'asset' as const, asset: 'h' } ], children: [] },
    { id: 'c', content: [ ...textRuns('前'), { id: 'e3', t: 'ref' as const, to: 't2', flavor: '#' as const, label: '设计' } ], children: [] },
  ] as unknown as import('../src/core/model.ts').Block[]
  assert.deepEqual([...edgeSourceIds(blocks, 't1')], ['a'])
  assert.deepEqual([...edgeSourceIds(blocks, 't2')], ['c'], '行内标签的显示名也是解析出来的 ⇒ 改名要重画')
  assert.deepEqual([...edgeSourceIds(blocks, 'p.png')], [], '图片不指块，天然不是指向边')
})

test('⑥e inlineTagIdsOf：按出现位置排序、同块去重、只认带 # 风味的引用', () => {
  // b 的内容：普通引用 p ＋ 露面甲 ＋ 露面乙 ＋ 第二枚甲；other 是别的块
  const b = {
    id: 'b',
    content: [
      { id: 't4', t: 'ref' as const, to: 'p', label: '页' },
      { id: 't2', t: 'ref' as const, to: 'tag-a', flavor: '#' as const, label: '甲' },
      { id: 't1', t: 'ref' as const, to: 'tag-b', flavor: '#' as const, label: '乙' },
      { id: 't3', t: 'ref' as const, to: 'tag-a', flavor: '#' as const, label: '甲' },
    ],
    children: [],
  } as unknown as import('../src/core/model.ts').Block
  assert.deepEqual(inlineTagIdsOf(b), ['tag-a', 'tag-b'], '按位置排；同名的第二枚不重复；普通引用不算露面')
})

test('mkTagBlock：名字进 `_aliases`（不带 #），正文是描述，露面是 tag', () => {
  const t = mkTagBlock(' 设计 ')
  assert.equal(plainText(t.content), '设计', '描述的初值可以等于名字')
  assert.deepEqual(t.props?._aliases, ['设计'])
  assert.deepEqual(t.props?._lists, ['tag'])
  assert.equal(t.props?._display, 'alias')
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
 *    删字、插原子、写 `_tags` 由编辑器在同一笔撤销里做完。
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

/**
 * `#` 前面挨着字也算标签语法（触发不再要求先敲空格）；只有 URL 的 `#fragment` 不算。
 *
 * 判据从「前面是不是字」改成「整串是不是链接」：`C#` 这类正文由 `Esc` 退出，
 * 不靠边界猜用户想不想弹（`C#` 这类正文由 `Esc` 退出）。
 */
test('trailingHashTag：`#` 紧跟字后面也算（触发不再要求空格）；URL fragment 仍不算', () => {
  assert.deepEqual(trailingHashTag('a#b '), { name: 'b', from: 1, to: 3 })
  assert.deepEqual(trailingHashTag('中文#设计 '), { name: '设计', from: 2, to: 5 })
  assert.equal(trailingHashTag('https://x.dev/#anchor '), null, 'URL 的 fragment 不是标签')
  assert.deepEqual(trailingHashTag('（#设计）').name, '设计', '标点之后算数：中文里不空一格也常见')
})

test('trailingHashTag：编辑边界（`allowEnd`）⇒ 行尾也算敲完', () => {
  assert.equal(trailingHashTag('#设计'), null, '输入途中：继续等分隔符')
  assert.deepEqual(trailingHashTag('#设计', { allowEnd: true }), { name: '设计', from: 0, to: 3 })
  assert.deepEqual(trailingHashTag('前面 #设计', { allowEnd: true }), { name: '设计', from: 3, to: 6 })
})
