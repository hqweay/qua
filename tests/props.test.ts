/**
 * **字段定义（prop-def）与属性区派生**。
 *
 * 验收口径：
 *   ③ 定义是**独立块**（住森林顶层，`role:'schema'`，`propId` ＝ 块 id），
 *      可被两个标签同时声明；删掉其中一个标签，定义仍在、另一个声明仍有效。
 *   ⑥ `fieldsOf` 只算**直接标签**：只打 `#演员` 不会冒出 `#人物` 的字段。
 *   ④ 同一 `propId` 只显示一次、来源完整；块自有字段（无标签声明）也在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import { hasRole } from '../src/core/index.ts'
import { seedWorkspace } from '../src/core/seed.ts'
import {
  cleanableValues,
  declareField,
  declaredFieldIds,
  declaredFields,
  ensureTag,
  fieldIdsOf,
  fieldRows,
  gutterFieldsFor,
  gutterFieldsOf,
  hasTagEdge,
  hasValue,
  isPropDef,
  mkPropDef,
  mkTagBlock,
  TASK_STATUS_PROP_ID,
  todoOf,
  undeclareField,
  UI_POSITION_PROP,
  uiPositionOf,
} from '../src/core/index.ts'

const tagEdge = (id: string, blockId: string, tagId: string): Atom =>
  ({
    id,
    kind: 'tag',
    blockId,
    start: 0,
    end: 1,
    label: 'x',
    target: { kind: 'page', id: tagId },
  }) as Atom

test('③ 定义是独立块：森林顶层、schema 角色、正文＝label、propId＝块 id', () => {
  const def = mkPropDef('评分', 'number')
  const forest: Block[] = [def]
  assert.equal(forest[0], def, '直接住森林顶层 —— 不是任何标签的子块')
  assert.ok(isPropDef(def))
  assert.equal(def.text, '评分')
  assert.equal(def.props?._kind, 'number')
  assert.equal(def.children.length, 0)
  assert.ok(def.id.length > 0, 'propId 就是它自己的 id')
})

test('③ 定义可被两个标签同时声明；删其一，定义仍在、另一声明仍有效', () => {
  const def = mkPropDef('评分', 'number')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  const forest: Block[] = [def, book, film]

  assert.equal(declareField(book, def.id), true)
  assert.equal(declareField(film, def.id), true)
  assert.deepEqual(declaredFieldIds(book), [def.id])
  assert.deepEqual(declaredFieldIds(film), [def.id])
  assert.equal(declareField(book, def.id), false, '幂等：同一标签不重复声明')

  // 删掉 #书（整个标签块）
  forest.splice(forest.indexOf(book), 1)
  assert.equal(forest.includes(def), true, '定义不随使用者消失')
  assert.deepEqual(declaredFields(film, forest).map((d) => d.id), [def.id], '#电影 的声明仍有效')
})

test('只有页/标签能声明字段（D4）；普通块只能有值', () => {
  const def = mkPropDef('评分')
  const plain: Block = { id: 'p', text: '普通块', children: [] }
  assert.equal(declareField(plain, def.id), false)
  const page: Block = { id: 'pg', text: '页', children: [], props: { _roles: ['page'] } }
  assert.equal(declareField(page, def.id), true)
})

test('④ 同一 propId 被两标签声明 ⇒ 只出现一行、来源完整', () => {
  const def = mkPropDef('评分', 'number')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  declareField(book, def.id)
  declareField(film, def.id)
  const target: Block = { id: 'b', text: '西游记', children: [], props: { [def.id]: 9 } }
  const forest: Block[] = [def, book, film, target]
  const atoms = [tagEdge('e1', 'b', book.id), tagEdge('e2', 'b', film.id)]

  const rows = fieldRows(target, forest, atoms)
  const scored = rows.filter((r) => r.propId === def.id)
  assert.equal(scored.length, 1, '同一个字段只显示一次')
  assert.deepEqual(scored[0]!.sources.map((s) => s.text), ['书', '电影'], '来源按正文里标签的先后')
  assert.equal(scored[0]!.value, 9)
  assert.equal(scored[0]!.filled, true)
})

test('④ 块自有属性是正常来源：没有标签声明时标「本块自有」（sources 为空）', () => {
  const def = mkPropDef('状态')
  const target: Block = { id: 'b', text: '一块', children: [], props: { [def.id]: '已完成' } }
  const forest: Block[] = [def, target]
  const rows = fieldRows(target, forest, [])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.sources, [])
  assert.equal(rows[0]!.label, '状态')
  assert.equal(rows[0]!.value, '已完成')
})

test('声明了但没填 ⇒ 行还在（「待填」），filled=false', () => {
  const def = mkPropDef('评分')
  const task = mkTagBlock('任务')
  declareField(task, def.id)
  const target: Block = { id: 'b', text: '一块', children: [] }
  const rows = fieldRows(target, [def, task, target], [tagEdge('e', 'b', task.id)])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.filled, false)
  assert.equal(hasValue(target, def.id), false)
})

test('⑥ fieldsOf 只算直接标签：只打 #演员 不含 #人物 的字段', () => {
  const name = mkPropDef('姓名')
  const people = mkTagBlock('人物')
  const actor = mkTagBlock('演员') // 包含关系（_parentTags）在 tag-tree 里；这里只证明「字段不跟祖先走」
  declareField(people, name.id)
  const target: Block = { id: 'b', text: '某人', children: [] }
  const forest: Block[] = [name, people, actor, target]
  const atoms = [tagEdge('e', 'b', actor.id)]
  assert.deepEqual(fieldIdsOf(target, forest, atoms), [], '#演员 没声明字段 ⇒ 属性区没有它')
})

test('摘标签清理：只算「有值 ∩ 被摘标签声明 ∩ 剩余标签都不声明」', () => {
  const shared = mkPropDef('评分')
  const onlyBook = mkPropDef('页数')
  const book = mkTagBlock('书')
  const film = mkTagBlock('电影')
  declareField(book, shared.id)
  declareField(book, onlyBook.id)
  declareField(film, shared.id)
  const target: Block = {
    id: 'b',
    text: '一块',
    children: [],
    props: { [shared.id]: 9, [onlyBook.id]: 300 },
  }
  const forest: Block[] = [shared, onlyBook, book, film, target]
  const atoms = [tagEdge('e1', 'b', book.id), tagEdge('e2', 'b', film.id)]
  assert.deepEqual(cleanableValues(target, book, forest, atoms), [onlyBook.id], '评分还被 #电影 声明 ⇒ 不清')
})

test('解除声明只动这一条，值留在块上（值留存）', () => {
  const def = mkPropDef('评分')
  const book = mkTagBlock('书')
  declareField(book, def.id)
  const target: Block = { id: 'b', text: '一块', children: [], props: { [def.id]: 5 } }
  const forest: Block[] = [def, book, target]
  assert.equal(undeclareField(book, def.id), true)
  assert.equal(target.props![def.id], 5)
  assert.deepEqual(fieldRows(target, forest, []).map((r) => r.propId), [def.id], '值落到「本块自有」')
})

test('ensureTag 返回的块可以立刻声明字段（标签是普通块）', () => {
  const forest: Block[] = []
  const { block } = ensureTag(forest, '任务')
  const def = mkPropDef('状态')
  forest.push(def)
  assert.ok(block)
  assert.equal(declareField(block!, def.id), true)
})

test('④ 顺序只影响呈现：字段集合与标签先后无关；行序按正文里标签出现顺序', () => {
  const a1 = mkPropDef('甲一')
  const a2 = mkPropDef('甲二')
  const b1 = mkPropDef('乙一')
  const A = mkTagBlock('A')
  const B = mkTagBlock('B')
  declareField(A, a1.id)
  declareField(A, a2.id)
  declareField(B, b1.id)
  const target: Block = { id: 'b', text: '一块', children: [] }
  const forest = [a1, a2, b1, A, B, target]
  const ab = fieldRows(target, forest, [tagEdge('e1', 'b', A.id), tagEdge('e2', 'b', B.id)]).map((r) => r.label)
  const ba = fieldRows(target, forest, [tagEdge('e1', 'b', B.id), tagEdge('e2', 'b', A.id)]).map((r) => r.label)
  assert.deepEqual(ab, ['甲一', '甲二', '乙一'])
  assert.deepEqual(ba, ['乙一', '甲一', '甲二'])
  assert.deepEqual([...ab].sort(), [...ba].sort(), '集合相同：顺序只影响行序')
})

test('_uiPosition：缺省是 panel；只有声明 block-left 的定义归 gutter', () => {
  const task = mkPropDef('任务状态', 'checkbox', { [UI_POSITION_PROP]: 'block-left' })
  const score = mkPropDef('评分', 'number')
  assert.equal(uiPositionOf(task), 'block-left')
  assert.equal(uiPositionOf(score), 'panel', '没写就是 panel')
  assert.equal(uiPositionOf(undefined), 'panel', '定义缺失也不得让面板整段消失')
})

test('gutterFieldsOf：收「定义归 gutter」的那些，**有没有值都收**', () => {
  const task = mkPropDef('任务状态', 'checkbox', { [UI_POSITION_PROP]: 'block-left' })
  const score = mkPropDef('评分', 'number')
  const host: Block = { id: 'b', text: '一块', children: [], props: { [task.id]: true, [score.id]: 9 } }
  const forest = [task, score, host]
  const rows = gutterFieldsOf(host, forest, [])
  assert.deepEqual(rows.map((r) => r.propId), [task.id], '评分在面板里，不归 gutter')
  assert.equal(rows[0]!.value, true)
  assert.equal(rows[0]!.filled, true)
  assert.equal(rows[0]!.def, task)

  // 打了标签但**还没填值** ⇒ 入口照样在（这才是 gutter 存在的意义）
  //
  // ⚠️ 必须是「打了标签」而不是「任何块」：字段来自「声明 ∪ 自有」，
  //    一个既没有标签、也没有属性值的块本来就没有任何字段。若这里断言
  //    「任意空块也显示该字段」，等于说「所有块都显示所有字段」—— 那是另一套设计。
  const tag = mkTagBlock('任务')
  declareField(tag, task.id)
  const empty: Block = { id: 'c', text: '空', children: [] }
  const edge = { id: 'e1', kind: 'tag' as const, blockId: empty.id, start: 0, end: 1, label: '任务', target: { kind: 'page' as const, id: tag.id } }
  const emptyRows = gutterFieldsOf(empty, [task, score, tag, empty], [edge])
  assert.deepEqual(emptyRows.map((r) => r.propId), [task.id], '声明来的字段没有值，入口照样在')
  assert.equal(emptyRows[0]!.filled, false)
  assert.equal(emptyRows[0]!.value, undefined)
})

test('种子库自带核心词汇：任务状态定义（顶层、归 gutter）＋ #任务 声明它', () => {
  const ws = seedWorkspace()
  const def = ws.blocks.find((b) => b.id === TASK_STATUS_PROP_ID)
  assert.ok(def, '定义块应在森林顶层（不在任何页的子树里）')
  assert.equal(def!.text, '任务状态')
  assert.equal(def!.props?._kind, 'checkbox')
  assert.equal(uiPositionOf(def), 'block-left')

  const task = ws.blocks.find((b) => hasRole(b, 'tag') && b.text === '任务')
  assert.ok(task, '标签块应在森林顶层')
  assert.deepEqual(declaredFieldIds(task!), [TASK_STATUS_PROP_ID])

  // 样本块必须**真的打上 #任务**（边）并写了值，否则 gutter 上什么都看不到：
  // 「有标签」与「有值」是两件事，缺一个就只剩一个看不见的开关。
  const hosts = ws.blocks.flatMap(function flat(b) {
    return [b, ...b.children.flatMap(flat)]
  })
  const withValue = hosts.filter((b) => b.props?.[TASK_STATUS_PROP_ID] !== undefined)
  assert.equal(withValue.length, 4, '假数据里应有 4 个带任务状态的块')
  for (const b of withValue) {
    assert.equal(hasTagEdge(b.id, task!.id, ws.atoms), true, `样本块应带 #任务 边：${b.text}`)
  }
  assert.equal(withValue.filter((b) => todoOf(b) === 'done').length, 2, '完成与未完成各两条')
})

test('todoOf：true ⇒ done，false ⇒ todo（有值），缺失 ⇒ undefined', () => {
  const done: Block = { id: 'd', text: '', children: [], props: { [TASK_STATUS_PROP_ID]: true } }
  const open: Block = { id: 'o', text: '', children: [], props: { [TASK_STATUS_PROP_ID]: false } }
  const none: Block = { id: 'n', text: '', children: [] }
  assert.equal(todoOf(done), 'done')
  assert.equal(todoOf(open), 'todo', '「是任务、没做完」是**有值**的，不能并进缺失')
  assert.equal(todoOf(none), undefined)
})

test('批量 gutter 与逐行算**逐块等价**：批级只扫一次库，结果不许和单块路径分叉', () => {
  const ws = seedWorkspace()
  const hosts = ws.blocks.flatMap(function flat(b) {
    return [b, ...b.children.flatMap(flat)]
  })
  const batch = gutterFieldsFor(hosts, ws.blocks, ws.atoms)
  for (const b of hosts) {
    assert.deepEqual(
      batch.get(b.id) ?? [],
      gutterFieldsOf(b, ws.blocks, ws.atoms),
      `批量与逐行对不上：${b.text}`,
    )
  }
  // 没有 gutter 字段的块**不出现在 map 里**（空数组与缺席同义）
  const none = hosts.find((b) => gutterFieldsOf(b, ws.blocks, ws.atoms).length === 0)
  assert.ok(none, '种子库里应有不带 gutter 字段的块')
  assert.equal(batch.has(none!.id), false)
})

test('批量 gutter 的**行序与去重**与逐行一致：两个标签声明同一字段、自有字段排在后', () => {
  const shown = mkPropDef('开关', 'checkbox', { [UI_POSITION_PROP]: 'block-left' })
  const other = mkPropDef('评分', 'number')
  const a = mkTagBlock('甲')
  const z = mkTagBlock('乙')
  declareField(a, other.id)
  declareField(a, shown.id)
  declareField(z, shown.id)
  const target: Block = { id: 't', text: '块', children: [], props: { [shown.id]: true } }
  const forest = [shown, other, a, z, target]
  // 同一个标签打两次（重复边）不该让它出现两遍
  const atoms = [tagEdge('e1', 't', a.id), tagEdge('e2', 't', z.id), tagEdge('e3', 't', a.id)]

  const batch = gutterFieldsFor([target], forest, atoms).get('t') ?? []
  assert.deepEqual(batch, gutterFieldsOf(target, forest, atoms))
  assert.deepEqual(batch.map((f) => f.propId), [shown.id], '只有归 gutter 的那个字段；同一字段只一行')
})
