/**
 * **选项（`select` 的 choice）**：选项是属性定义块的**直接子块**。
 *
 * 验收口径（为什么这些断言长这样）：
 *   · 身份是**块 id**，不是选项名 —— 改名不改值，两个同名选项是两个值；
 *   · 顺序是**兄弟顺序** —— 没有第二份 order 字段；
 *   · 可见性是**一个三态表达式**（`_choiceScope`），多标签取并集；
 *   · 当前值不被隐藏：值指向的选项不可见/已软删时，控件仍能拿到它的名字。
 *
 * 这些性质都不在 UI 里判：属性面板与表格都吃同一份派生（`FieldRow.choices`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, ViewRecord } from '../src/core/index.ts'
import {
  choiceById,
  choiceDisplayLabel,
  choiceScopeOf,
  choiceVisible,
  choicesFor,
  choicesOf,
  fieldRows,
  mkPropDef,
  propDisplayLabels,
  sortRecords,
} from '../src/core/index.ts'
import { plainText, textRuns } from '../src/core/runs.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'
import { propsCommands } from '../src/app/commands/props.ts'
import type { PropsDeps } from '../src/app/commands/types.ts'

/* ------------------------------------------------------------ 夹具 */

const blk = (id: string, text = '', props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

/** 标签块（身份只靠 `_lists`／`_aliases`，与模型口径一致） */
const tagBlock = (id: string, name: string): Block =>
  blk(id, name, { _aliases: [name], _lists: ['tag'] })

/** 一个 select 定义 + 它给的选项（子块顺序就是选项顺序） */
const selectDef = (id: string, children: Block[]): Block => {
  const def = blk(id, '状态', { _kind: 'select' })
  def.children = children
  return def
}

const choice = (id: string, name: string, scope?: unknown): Block =>
  blk(id, name, scope === undefined ? undefined : { _choiceScope: scope })

const tagName = (id: string): string => ({ tagA: '任务', tagB: '书' })[id] ?? id.slice(-6)

/* ------------------------------------------------------------ 1. 目录 */

test('choicesOf：只返回活子块，顺序＝兄弟顺序（软删的不算，但仍在原位）', () => {
  const def = selectDef('def', [
    choice('c1', '一'),
    choice('c2', '二', { _choiceScope: { mode: 'only', tags: ['tagA'] } }),
    { ...choice('c3', '三'), props: { _deletedAt: 5 } },
  ])
  assert.deepEqual(
    choicesOf(def).map((c) => c.id),
    ['c1', 'c2'],
    '活块按 def.children 的顺序',
  )
  // 软删的块没有被摘掉：恢复走同一格（值指向它时也要能解析到）
  assert.equal(def.children.length, 3)
})

test('choiceById：能找到软删的选项（显示「选项已删除」靠它）', () => {
  const gone = { ...choice('c-gone', '已删'), props: { _deletedAt: 7 } }
  const def = selectDef('def', [choice('c1', '一'), gone])
  const forest = [def]
  assert.equal(choiceById(forest, 'c-gone')?.id, 'c-gone', '软删的选项也要找得到')
  assert.equal(choiceById(forest, 'c1')?.id, 'c1')
  assert.equal(choiceById(forest, 'nope'), undefined)
})

/* ------------------------------------------------------------ 2. 可见性 */

test('choiceVisible：all 处处可见；only 要命中；except 命中即隐藏', () => {
  const all = choice('a', '全局')
  const onlyA = choice('o', '仅 A', { mode: 'only', tags: ['tagA'] })
  const exceptA = choice('e', '除 A', { mode: 'except', tags: ['tagA'] })
  const none = new Set<string>()
  const a = new Set(['tagA'])
  const b = new Set(['tagB'])
  const ab = new Set(['tagA', 'tagB'])

  assert.equal(choiceVisible(all, none), true, 'all 对空标签也可见')
  assert.equal(choiceVisible(all, b), true)

  assert.equal(choiceVisible(onlyA, a), true)
  assert.equal(choiceVisible(onlyA, b), false)
  assert.equal(choiceVisible(onlyA, none), false, 'only 对空标签不可见（不静默升全局）')
  assert.equal(choiceVisible(onlyA, ab), true, '多标签取并集：任一命中即可见')

  assert.equal(choiceVisible(exceptA, a), false)
  assert.equal(choiceVisible(exceptA, b), true)
  assert.equal(choiceVisible(exceptA, none), true)
  assert.equal(choiceVisible(exceptA, ab), false, '多标签取并集：任一命中即隐藏')
})

test('choiceScopeOf：坏值回落 all；only/except 去重，空集合保留（编辑中间态）', () => {
  assert.deepEqual(choiceScopeOf(choice('c', 'x')), { mode: 'all' }, '缺省 = 全局')
  assert.deepEqual(choiceScopeOf(choice('c', 'x', 'nope')), { mode: 'all' }, '形状不认识 ⇒ 全局')
  assert.deepEqual(choiceScopeOf(choice('c', 'x', { mode: 'only' })), { mode: 'all' })
  assert.deepEqual(
    choiceScopeOf(choice('c', 'x', { mode: 'only', tags: ['tagA', 'tagA'] })),
    { mode: 'only', tags: ['tagA'] },
  )
  assert.deepEqual(choiceScopeOf(choice('c', 'x', { mode: 'except', tags: [] })), { mode: 'except', tags: [] },
    '空集合不被归一成 all：否则「刚切到 only」的中间态永远勾不上标签')
  assert.deepEqual(choiceScopeOf(choice('c', 'x', { mode: 'except', tags: ['gone'] })), {
    mode: 'except',
    tags: ['gone'],
  }, '悬空标签 id 原样保留：删标签不等于改作用域')
})

/* ------------------------------------------------------------ 3. 适用性 */

test('choicesFor：保持兄弟顺序；定义缺失／不是 select ⇒ 空数组', () => {
  const def = selectDef('def', [choice('c1', '一'), choice('c2', '仅 A', { mode: 'only', tags: ['tagA'] }), choice('c3', '三')])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _fieldDefs: ['def'] }
  const withA = blk('b1', '一块', { _tags: ['tagA'] })
  const plain = blk('b2', '没标签')
  const forest = [def, tagA, withA, plain]

  assert.deepEqual(
    choicesFor(withA, 'def', forest).map((c) => c.id),
    ['c1', 'c2', 'c3'],
    '#A 的块看到三条（含 only #A），顺序＝兄弟顺序',
  )
  assert.deepEqual(
    choicesFor(plain, 'def', forest).map((c) => c.id),
    ['c1', 'c3'],
    '没有标签的块只看到全局选项',
  )

  const text = mkPropDef('备注', 'text')
  const textForest = [text, ...forest]
  assert.deepEqual(choicesFor(plain, text.id, textForest), [], '非 select 的定义没有选项')
  assert.deepEqual(choicesFor(plain, 'missing', textForest), [], '悬空定义 ⇒ 空数组，不崩')
})

test('choicesFor：标签页把自身算进 tag 集（「只对本标签可见」在自己的页里看得见）', () => {
  const def = selectDef('def', [choice('c1', '全局'), choice('c2', '仅 #任务', { mode: 'only', tags: ['tagA'] })])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _fieldDefs: ['def'] }
  assert.deepEqual(
    choicesFor(tagA, 'def', [def, tagA]).map((c) => c.id),
    ['c1', 'c2'],
    '标签页自己的 tag 集含自身',
  )
})

/* ------------------------------------------------------------ 4/5. 显示名 */

test('choiceDisplayLabel：不同名不带后缀；同名带作用域；仍重名再加短 id', () => {
  const def = selectDef('def', [
    choice('c1', '唯一'),
    choice('c2', '同名'),
    choice('c3', '同名', { mode: 'only', tags: ['tagA'] }),
    choice('c4', '同名', { mode: 'except', tags: ['tagB'] }),
    choice('c5', '同名', { mode: 'only', tags: ['tagA'] }),
    choice('c6', '同名', { mode: 'only', tags: ['tagB'] }),
  ])
  const one = choicesOf(def)[0]!
  assert.equal(choiceDisplayLabel(one, def, tagName), '唯一', '没有同名时不加后缀')

  assert.equal(choiceDisplayLabel(choicesOf(def)[1]!, def, tagName), '同名 · 全局', '全局作用域也要说清')
  assert.equal(choiceDisplayLabel(choicesOf(def)[3]!, def, tagName), '同名 · 除 #书')
  const onlyA = choicesOf(def)[2]!
  const onlyA2 = choicesOf(def)[4]!
  assert.ok(choiceDisplayLabel(onlyA, def, tagName).startsWith('同名 · #任务（'), '同作用域仍重名 ⇒ 追加短 id')
  assert.notEqual(
    choiceDisplayLabel(onlyA, def, tagName),
    choiceDisplayLabel(onlyA2, def, tagName),
    '两条同名同作用域的选项也要能区分',
  )
})

test('propDisplayLabels：同名属性带声明来源；仍重名再追加短 id（同一张表没有两个相同名字）', () => {
  const book = tagBlock('tagBook', '书')
  const movie = tagBlock('tagMovie', '电影')
  const a = mkPropDef('评分', 'number')
  const b = mkPropDef('评分', 'number')
  const c = mkPropDef('评分', 'number')
  const d = mkPropDef('评分', 'number')
  book.props = { ...book.props, _fieldDefs: [a.id] }
  movie.props = { ...movie.props, _fieldDefs: [b.id] }
  const plain = mkPropDef('备注', 'text')
  const labels = propDisplayLabels([book, movie, a, b, c, d, plain])

  assert.equal(labels.get(plain.id), '备注', '不同名保持原名')
  assert.equal(labels.get(a.id), '评分 · #书')
  assert.equal(labels.get(b.id), '评分 · #电影')
  const undeclared = [labels.get(c.id), labels.get(d.id)]
  for (const label of undeclared) assert.ok(label?.includes('未声明'), `未声明的同名属性要标出来：${label}`)
  assert.notEqual(undeclared[0], undeclared[1], '追加来源后仍重名 ⇒ 再追加短 id')
  assert.equal(new Set(labels.values()).size, labels.size, '同一张 map 里没有两个相同的显示名')
})

/* ------------------------------------------------------------ 6. 行派生 */

test('fieldRows：select 行带 choices / currentChoiceLabel；当前值不可见时仍能拿到 label', () => {
  const def = selectDef('def', [choice('c1', '待办'), choice('c2', '完成', { mode: 'only', tags: ['tagA'] })])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _fieldDefs: ['def'] }
  const visible = blk('b1', '带标签', { _tags: ['tagA'], def: 'c2' })
  const hidden = blk('b2', '没标签', { def: 'c2' })

  const rowOf = (b: Block) => fieldRows(b, [def, tagA]).find((r) => r.propId === 'def')!
  const r1 = rowOf(visible)
  assert.deepEqual(r1.choices?.map((c) => c.id), ['c1', 'c2'])
  assert.equal(r1.currentChoiceLabel, '完成', '可见时报选项名')

  const r2 = rowOf(hidden)
  assert.deepEqual(r2.choices?.map((c) => c.id), ['c1'], '不可见的选项不进候选')
  assert.equal(r2.currentChoiceLabel, '完成', '当前值不被隐藏：名字仍要拿得到')
  assert.equal(r2.value, 'c2', '值一个字节都没动')
})

test('fieldRows：值指向已软删的选项 ⇒ 不给名字（UI 显示「选项已删除」），值仍在', () => {
  const gone = choice('c-gone', '已删')
  gone.props = { ...gone.props, _deletedAt: 9 }
  const def = selectDef('def', [choice('c1', '待办'), gone])
  const block = blk('b', '一块', { def: 'c-gone' })
  const row = fieldRows(block, [def]).find((r) => r.propId === 'def')!
  assert.deepEqual(row.choices?.map((c) => c.id), ['c1'], '软删的选项不进候选')
  assert.equal(row.currentChoiceLabel, undefined, '没有名字 ⇒ 控件说「选项已删除」')
  assert.equal(row.value, 'c-gone', '值一个字节都没动')
})

/* ------------------------------------------------------------ 7. 新建定义 */

function commandHarness(): { cmds: ReturnType<typeof propsCommands>; kb: MemoryKb; toasts: string[] } {
  const store = new BlockStore([])
  const kb = new MemoryKb(store)
  const toasts: string[] = []
  const deps: PropsDeps = {
    kb,
    write: (_blockId, mutate) => mutate(),
    run: (fn) => {
      const r = kb.tx(fn)
      return { ops: r.ops, result: r.result }
    },
    toast: (text) => void toasts.push(text),
  }
  return { cmds: propsCommands(deps), kb, toasts }
}

test('createPropDef：默认复用同名同 kind；mode:new 建第二个 propId', () => {
  const { cmds, kb } = commandHarness()
  const first = cmds.createPropDef('', '评分', 'number', 'own')
  const again = cmds.createPropDef('', '评分', 'number', 'own')
  assert.equal(again, first, '默认路径复用同一个 propId')
  assert.equal(kb.propDefs().length, 1)

  const second = cmds.createPropDef('', '评分', 'number', 'own', 'new')
  assert.notEqual(second, first, '同名两义：显式新建给第二个 propId')
  assert.equal(kb.propDefs().length, 2, '两条定义各自一块')
  assert.deepEqual(
    kb.propDefs().map((d) => d.id).sort(),
    [first, second].sort(),
  )

  const text = cmds.createPropDef('', '评分', 'text', 'own')
  assert.notEqual(text, first, 'kind 不同仍不得复用')
  assert.equal(kb.propDefs().length, 3)
})

test('选项命令：插入/改名/移动/作用域/软删都走一笔事务（值不清）', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '状态', 'select', 'own')
  const c1 = cmds.addChoice(defId, '待办')
  const c2 = cmds.addChoice(defId, '完成', { mode: 'only', tags: ['tagA'] })
  assert.ok(c1 !== '' && c2 !== '', '两条选项都建出来了')

  const def = () => kb.propDefs().find((d) => d.id === defId)!
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c1, c2], '顺序＝插入顺序')
  assert.deepEqual(choiceScopeOf(def().children[1]!), { mode: 'only', tags: ['tagA'] })

  // 值存的是选项 id：改名不动值
  const host = { id: 'host', content: textRuns('一块'), children: [], created: 1, modified: 1, props: { [defId]: c2 } }
  kb.tx((tx) => tx.insert(host, null, 0))
  cmds.setChoiceLabel(c2, '已做完')
  assert.equal(host.props?.[defId], c2, '改名不改值')
  assert.equal(plainText(choicesOf(def())[1]!.content), '已做完', '改名写的是正文')

  // 往下/往上移动：`beforeId` 之前的最终位置
  cmds.moveChoice(defId, c2, c1)
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c2, c1], '移到 c1 之前')
  cmds.moveChoice(defId, c2, '')
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c1, c2], '空 beforeId ⇒ 末尾')

  // 作用域改回全局：槽位一起摘掉（不留空壳）
  cmds.setChoiceScope(c2, { mode: 'all' })
  assert.equal('_choiceScope' in (def().children[1]!.props ?? {}), false)

  // 软删：选项不在候选里，但值还在；恢复后回来
  cmds.deleteChoice(c1)
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c2], '软删的选项不提供选择')
  assert.equal(host.props?.[defId], c2, '值不动（这条值是 c2，不是被删的 c1）')
  assert.equal(choiceById(kb.roots(), c1)?.id, c1, '软删的选项仍能被解析（显示「选项已删除」）')
})

/* ------------------------------------------------------------ 8. 排序 */

test('sortRecords：select 列按选项兄弟顺序（resolver），不在列表的值排最后', () => {
  const def = selectDef('def', [choice('c1', '一'), choice('c2', '二'), choice('c3', '三')])
  const rec = (id: string, value: string | undefined): ViewRecord => ({
    block: blk(id, id),
    path: [],
    title: id,
    tags: [],
    values: value === undefined ? {} : { def: value },
  })
  const records = [rec('r1', 'c3'), rec('r2', undefined), rec('r3', 'gone'), rec('r4', 'c1')]
  const ranks = new Map(choicesOf(def).map((c, i) => [c.id, i]))
  const sorted = sortRecords(records, [{ by: 'def', dir: 'asc' }], (r, key) => {
    if (key !== 'def') return undefined
    const v = r.values.def
    if (typeof v !== 'string' || v === '') return null
    return ranks.get(v) ?? null
  })
  assert.deepEqual(
    sorted.map((r) => r.block.id),
    ['r4', 'r1', 'r2', 'r3'],
    `c1 < c3，空值与未知值排最后且保持稳定：${sorted.map((r) => r.block.id)}`,
  )
  // 不传 resolver 时行为不变（按值本身比较）——这条确保默认语义没被改掉
  const byDefault = sortRecords(records, [{ by: 'def', dir: 'asc' }]).map((r) => r.block.id)
  assert.deepEqual(byDefault, ['r4', 'r1', 'r3', 'r2'], `默认按字符串、空值最后：${byDefault}`)
})
