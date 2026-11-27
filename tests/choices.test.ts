/**
 * **选项（`select` 的值域）＝ 定义块上的一组记录**，不是块。
 *
 * 验收口径（为什么这些断言长这样）：
 *   · 身份是**记录 id**，不是选项名 —— 改名不改值，两个同名选项是两个值；
 *   · 顺序是**数组序** —— 没有第二份 order 字段，也没有兄弟序这回事；
 *   · 可见性是**一个三态表达式**（记录的 `scope`），多标签取并集；
 *   · 当前值不被隐藏：值指向的选项不可见/已删（墓碑）时，控件仍能拿到它的名字；
 *   · 旧形状遗留（桌面真机库的选项子块）**读得出、但不参与候选**——不写迁移。
 *
 * 这些性质都不在 UI 里判：属性面板与表格都吃同一份派生（`FieldRow.choices`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, ViewRecord } from '../src/core/index.ts'
import {
  allChoicesOf,
  choiceById,
  choiceDisplayLabel,
  ChoiceLookupIndex,
  choiceLookupOf,
  choiceScopeOf,
  choiceVisible,
  choicesFor,
  choicesOf,
  fieldRows,
  formatOf,
  isAssetRef,
  isChoicesValue,
  isMultiValueKey,
  legacyChoiceOf,
  mkPropDef,
  propDisplayLabels,
  propKindOf,
  runQuery,
  setChoices,
  sortRecords,
  textFormatOk,
  type ChoiceScope,
  type PropChoice,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/model/store.ts'
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

/** 一条选项记录 */
const choice = (id: string, name: string, scope?: ChoiceScope): PropChoice => ({
  id,
  label: name,
  ...(scope ? { scope } : {}),
})

/** 一个 select 定义 + 它的选项记录（数组序就是选项序） */
const selectDef = (id: string, choices: PropChoice[]): Block => {
  const def = blk(id, '状态', { _kind: 'select' })
  setChoices(def, choices)
  return def
}

const tagName = (id: string): string => ({ tagA: '任务', tagB: '书' })[id] ?? id.slice(-6)

/* ------------------------------------------------------------ 1. 记录域 */

test('choicesOf：只返回活记录，顺序＝数组序（墓碑不提供选择，但仍在原位）', () => {
  const def = selectDef('def', [
    choice('c1', '一'),
    choice('c2', '二', { mode: 'only', tags: ['tagA'] }),
    { ...choice('c3', '三'), deleted: true },
  ])
  assert.deepEqual(
    choicesOf(def).map((c) => c.id),
    ['c1', 'c2'],
    '活记录按 `_choices` 的数组序',
  )
  assert.equal(allChoicesOf(def).length, 3, '墓碑没有被摘掉：恢复走同一格（值指向它时也要能解析到）')
})

test('isChoicesValue：记录形状 ＋ id 唯一；空数组合法', () => {
  assert.equal(isChoicesValue([]), true, '没有选项是合法状态')
  assert.equal(isChoicesValue([{ id: 'a', label: '甲' }]), true)
  assert.equal(isChoicesValue([{ id: 'a', label: '甲', icon: 'lucide:circle', scope: { mode: 'all' } }]), true)
  assert.equal(isChoicesValue([{ id: 'a', label: '' }]), false, 'label 是显示名，不能空')
  assert.equal(isChoicesValue([{ id: '', label: '甲' }]), false)
  assert.equal(
    isChoicesValue([
      { id: 'a', label: '甲' },
      { id: 'a', label: '乙' },
    ]),
    false,
    'id 重复 ⇒ 值显示哪个名字没有答案，是坏形状',
  )
  assert.equal(isChoicesValue([{ id: 'a', label: '甲', scope: { mode: 'bad' } }]), false)
  assert.equal(isChoicesValue([{ id: 'a', label: '甲', deleted: false }]), false, '墓碑只有 true 这一种写法')
})

test('setChoices：空数组连槽一起摘掉（「没有选项」与「空壳」是同一个答案）', () => {
  const def = blk('def', '状态', { _kind: 'select' })
  setChoices(def, [choice('c1', '一')])
  assert.equal(isChoicesValue(def.props?._choices), true)
  setChoices(def, [])
  assert.equal('_choices' in (def.props ?? {}), false, '删到零条不留空数组')
})

test('选项不是块：定义块的 children 里有块也不算选项（旧形状不再被读）', () => {
  const legacyChild = blk('c-old', '旧选项')
  const def = blk('def', '状态', { _kind: 'select' })
  def.children = [legacyChild]
  assert.deepEqual(choicesOf(def), [], '`_choices` 为空 ⇒ 候选为空，不读 children')
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

test('choiceScopeOf：缺省 all；only/except 去重，空集合保留（编辑中间态）', () => {
  assert.deepEqual(choiceScopeOf(choice('c', 'x')), { mode: 'all' }, '缺省 = 全局')
  assert.deepEqual(
    choiceScopeOf(choice('c', 'x', { mode: 'only', tags: ['tagA', 'tagA'] })),
    { mode: 'only', tags: ['tagA'] },
    '标签去重',
  )
  assert.deepEqual(
    choiceScopeOf(choice('c', 'x', { mode: 'except', tags: [] })),
    { mode: 'except', tags: [] },
    '空集合不被归一成 all：否则「刚切到 only」的中间态永远勾不上标签',
  )
})

/* ------------------------------------------------------------ 3. 适用性 */

test('choicesFor：保持记录序；定义缺失／不是 select ⇒ 空数组', () => {
  const def = selectDef('def', [choice('c1', '一'), choice('c2', '仅 A', { mode: 'only', tags: ['tagA'] }), choice('c3', '三')])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _fieldDefs: ['def'] }
  const withA = blk('b1', '一块', { _tags: ['tagA'] })
  const plain = blk('b2', '没标签')
  const forest = [def, tagA, withA, plain]

  assert.deepEqual(
    choicesFor(withA, 'def', forest).map((c) => c.id),
    ['c1', 'c2', 'c3'],
    '#A 的块看到三条（含 only #A），顺序＝记录序',
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

test('fieldRows：值指向已删（墓碑）的选项 ⇒ 旧名 ＋ 「已删除」标记，值仍在', () => {
  const def = selectDef('def', [choice('c1', '待办'), { ...choice('c-gone', '已删'), deleted: true }])
  const block = blk('b', '一块', { def: 'c-gone' })
  const row = fieldRows(block, [def]).find((r) => r.propId === 'def')!
  assert.deepEqual(row.choices?.map((c) => c.id), ['c1'], '墓碑不进候选')
  assert.equal(row.currentChoiceLabel, '已删', '旧名要留着：用户才知道该恢复哪一条')
  assert.equal(row.currentChoiceDeleted, true, '控件据此标「已删除」')
  assert.equal(row.value, 'c-gone', '值一个字节都没动')
})

test('查询不把选项当内容行：选项记录没有正文，也进不了求值', () => {
  const def = selectDef('def', [choice('c1', '待办')])
  const host = blk('host', '正文里提到 待办 的一块')
  const hits = runQuery({ where: { text: '待办' } }, { blocks: [def, host] })
  assert.deepEqual(
    hits.map((h) => h.blockId),
    ['host'],
    `选项名不是内容：${JSON.stringify(hits)}`,
  )
})

test('choicesFor 与 FieldRow.choices 是同一份读法（属性面板与表格不会各算一套）', () => {
  const def = selectDef('def', [choice('c1', '全局'), choice('c2', '仅 A', { mode: 'only', tags: ['tagA'] })])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _fieldDefs: ['def'] }
  const block = blk('b', '一块', { _tags: ['tagA'] })
  const forest = [def, tagA, block]
  assert.deepEqual(
    fieldRows(block, forest).find((r) => r.propId === 'def')?.choices?.map((c) => c.id),
    choicesFor(block, 'def', forest).map((c) => c.id),
    '同一条属性、同一个块：两条读路径给出同一组选项',
  )
})

test('软删的标签不提供作用域：only [已删标签] 不可见；except 也失效；恢复后回来', () => {
  const cOnly = choice('c-only', '仅 A', { mode: 'only', tags: ['tagA'] })
  const cExcept = choice('c-except', '除 A', { mode: 'except', tags: ['tagA'] })
  const def = selectDef('def', [cOnly, cExcept])
  const tagA = tagBlock('tagA', '任务')
  tagA.props = { ...tagA.props, _deletedAt: 5 }
  // 块上仍留着标签 id（摘标签不自动清值）；`_ownProps` 保证这一行还在
  const block = blk('b', '一块', { _tags: ['tagA'], _ownProps: ['def'] })
  const forest = [def, tagA, block]

  const rowOf = (): PropChoice[] => fieldRows(block, forest).find((r) => r.propId === 'def')!.choices ?? []
  assert.deepEqual(
    rowOf().map((c) => c.id),
    ['c-except'],
    '软删的标签不算作用域：only 不可见，except 也不再排除',
  )

  delete tagA.props!._deletedAt
  assert.deepEqual(
    rowOf().map((c) => c.id),
    ['c-only'],
    '标签恢复后：only 可见、except 重新排除',
  )
})

/* ------------------------------------------------------------ 7. 查找表（含旧形状遗留） */

test('choiceById：新记录与旧形状遗留块都能找到（含墓碑/软删）', () => {
  const def = selectDef('def', [choice('c1', '一'), { ...choice('c-gone', '已删'), deleted: true }])
  const legacy = blk('c-legacy', '旧选项', { _choiceScope: { mode: 'only', tags: ['tagA'] } })
  const legacyGone = blk('c-legacy-gone', '旧已删', { _deletedAt: 7 })
  const forest = [def, legacy, legacyGone]

  assert.equal(choiceById(forest, 'c1')?.label, '一')
  assert.equal(choiceById(forest, 'c-gone')?.label, '已删', '墓碑也要找得到')
  assert.equal(choiceById(forest, 'nope'), undefined)

  // 旧形状遗留：块在森林里 ⇒ 投影成记录，名字读得出来（不写迁移）
  const old = choiceById(forest, 'c-legacy')
  assert.equal(old?.label, '旧选项')
  assert.deepEqual(old?.scope, { mode: 'only', tags: ['tagA'] }, '旧 `_choiceScope` 仍读得出')
  assert.equal(choiceById(forest, 'c-legacy-gone')?.deleted, true, '软删的旧块投成墓碑')
})

test('legacyChoiceOf：遗留块投影只读（正文/图标/作用域/软删），不进森林', () => {
  const b = blk('old', '旧选项', {
    _icon: 'lucide:circle',
    _color: 'red',
    _choiceScope: { mode: 'except', tags: ['tagB'] },
  })
  const c = legacyChoiceOf(b)
  assert.equal(c.id, 'old')
  assert.equal(c.label, '旧选项')
  assert.equal(c.icon, 'lucide:circle')
  assert.equal(c.color, 'red')
  assert.deepEqual(c.scope, { mode: 'except', tags: ['tagB'] })
  assert.equal(c.deleted, undefined)
})

test('choiceLookupOf：记录表与块兜底共用一份；软删标签的名字仍解析得到', () => {
  const def = selectDef('def', [choice('c1', '记录选项')])
  const legacy = blk('c-old', '旧选项')
  const goneTag = tagBlock('tagA', '任务')
  goneTag.props = { ...goneTag.props, _deletedAt: 1 }
  const look = choiceLookupOf([def, legacy, goneTag])

  assert.equal(look.find('c1')?.label, '记录选项')
  assert.equal(look.find('c-old')?.label, '旧选项', '旧形状遗留走块兜底')
  assert.equal(look.find('nope'), undefined)
  assert.equal(look.tagName('tagA'), '任务', '软删标签的旧名要能显示')
})

test('ChoiceLookupIndex：purge 后不返回旧块；软删留下的块仍是「在场」的遗留', () => {
  const live = blk('c1', '旧选项')
  const idx = new ChoiceLookupIndex()
  idx.rebuild([live])
  assert.equal(idx.lookup().find('c1')?.label, '旧选项')

  // purge：树里没有、`store.find` 也找不到 ⇒ 必须摘掉
  idx.remember('c1', () => undefined)
  assert.equal(
    idx.lookup().find('c1'),
    undefined,
    'purged 之后不能拿旧对象当「还在」（否则当前值显示旧名而不是「选项已删除」）',
  )

  // 软删：索引看不见它（`store.find` 返回 undefined），但旧对象带着删除标记 ⇒ 留着
  const soft = { ...blk('c2', '软删'), props: { _deletedAt: 1 } }
  const idx2 = new ChoiceLookupIndex()
  idx2.rebuild([soft])
  idx2.remember('c2', () => undefined)
  assert.equal(idx2.lookup().find('c2')?.id, 'c2', '软删的旧对象要留着（当前值显示旧名 ＋「已删除」）')
})

/* ------------------------------------------------------------ 8. 命令 */

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

test('createPropDef：格式一等入口——建时落 _format；同名不同格式不复用；坏格式忽略', () => {
  const { cmds, kb } = commandHarness()
  // 新建时就定格式（「链接」入口）：落 `_format`，不用建完再进配置页
  const link = cmds.createPropDef('', '主页', 'text', 'own', undefined, 'url')
  assert.equal(formatOf(kb.propDefs().find((d) => d.id === link)!), 'url')

  // 同名不同格式 ⇒ 不复用（复用会静默丢格式），另建一条纯文本
  const plain = cmds.createPropDef('', '主页', 'text', 'own')
  assert.notEqual(plain, link, '链接 ≠ 同名纯文本')
  assert.equal(formatOf(kb.propDefs().find((d) => d.id === plain)!), undefined)

  // 同名同格式 ⇒ 复用同一条
  assert.equal(cmds.createPropDef('', '主页', 'text', 'own', undefined, 'url'), link)

  // 坏格式（number 没有格式轴）⇒ 忽略，按普通定义建，不拒整笔
  const n = cmds.createPropDef('', '数量', 'number', 'own', undefined, 'url')
  assert.ok(n !== '')
  assert.equal(formatOf(kb.propDefs().find((d) => d.id === n)!), undefined)
})

test('选项命令：加/改名/移动/作用域/删除都写定义块（值不清、不插子块）', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '状态', 'select', 'own')
  const c1 = cmds.addChoice(defId, '待办')
  const c2 = cmds.addChoice(defId, '完成', { mode: 'only', tags: ['tagA'] })
  assert.ok(c1 !== '' && c2 !== '', '两条选项都建出来了')

  const def = () => kb.propDefs().find((d) => d.id === defId)!
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c1, c2], '顺序＝插入顺序')
  assert.deepEqual(choiceScopeOf(choicesOf(def())[1]!), { mode: 'only', tags: ['tagA'] })
  assert.equal(def().children.length, 0, '选项不再插成子块')

  // 值存的是选项 id：改名不动值
  const host = { id: 'host', content: textRuns('一块'), children: [], created: 1, modified: 1, props: { [defId]: c2 } }
  kb.tx((tx) => tx.insert(host, null, 0))
  cmds.setChoiceLabel(c2, '已做完')
  assert.equal(host.props?.[defId], c2, '改名不改值')
  assert.equal(choicesOf(def())[1]!.label, '已做完', '改名写的是记录 label')

  // 往下/往上移动：`beforeId` 之前的最终位置
  cmds.moveChoice(defId, c2, c1)
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c2, c1], '移到 c1 之前')
  cmds.moveChoice(defId, c2, '')
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c1, c2], '空 beforeId ⇒ 末尾')

  // 作用域改回全局：字段一起摘掉（不留空壳）
  cmds.setChoiceScope(c2, { mode: 'all' })
  assert.equal('scope' in choicesOf(def())[1]!, false, '改回全局不留 `{mode:"all"}`')

  // 删除＝墓碑：记录仍在数组原位、值还在、名字读得出
  cmds.deleteChoice(c1)
  assert.deepEqual(choicesOf(def()).map((c) => c.id), [c2], '墓碑不提供选择')
  assert.equal(allChoicesOf(def()).length, 2, '记录没被摘掉')
  assert.equal(host.props?.[defId], c2, '值不动')
  assert.equal(choiceById(kb.roots(), c1)?.label, '待办', '墓碑仍能被解析（显示「已删除」）')
})

test('图标/勾选框映射/快捷入口：图标写记录、状态唯一、空图标摘格', () => {
  const { cmds, kb, toasts } = commandHarness()
  const defId = cmds.createPropDef('', '状态', 'select', 'own')
  const c1 = cmds.addChoice(defId, '待办')
  const c2 = cmds.addChoice(defId, '完成')
  cmds.addChoice(defId, '进行中')
  const rec = (id: string) => allChoicesOf(kb.get(defId)!).find((c) => c.id === id)

  cmds.setChoiceIcon(c1, 'lucide:square')
  assert.equal(rec(c1)?.icon, 'lucide:square', '图标写在记录上')

  cmds.setChoiceCheck(defId, { on: c2, off: c1, closure: true })
  assert.deepEqual(kb.get(defId)?.props?._check, { on: c2, off: c1 })
  assert.equal(kb.get(defId)?.props?._use, 'closure')

  // 任务状态库级唯一：第二个定义再标 status ⇒ 拒绝，不静默换主
  const def2 = cmds.createPropDef('', '另一个状态', 'select', 'own', 'new')
  const d1 = cmds.addChoice(def2, '未完成')
  const d2 = cmds.addChoice(def2, '完成')
  cmds.setChoiceCheck(def2, { on: d2, off: d1, closure: true })
  assert.equal(kb.get(def2)?.props?._use, undefined, '第二条 status 被拒绝')
  assert.ok(toasts.some((x) => x.includes('任务状态')), `应有提示：${JSON.stringify(toasts)}`)

  // 摘掉映射：`_check` 与 `_use` 一起走
  cmds.setChoiceCheck(defId, null)
  assert.equal('_check' in (kb.get(defId)?.props ?? {}), false)
  assert.equal('_use' in (kb.get(defId)?.props ?? {}), false)

  // 普通勾选框：有 `_check`、没有 `_use`
  cmds.setChoiceCheck(defId, { on: c2, off: c1, closure: false })
  assert.deepEqual(kb.get(defId)?.props?._check, { on: c2, off: c1 })
  assert.equal(kb.get(defId)?.props?._use, undefined)

  // 有勾选框时不能切多值（单值才能「勾一个」）
  cmds.setChoiceCardinality(defId, 'many')
  assert.equal(kb.get(defId)?.props?._cardinality, undefined, '多值被拒绝')
  cmds.setChoiceCheck(defId, null)
  cmds.setChoiceCardinality(defId, 'many')
  assert.equal(kb.get(defId)?.props?._cardinality, 'many', '摘掉勾选框后可以切多值')

  cmds.setUiPosition(defId, 'block-left')
  assert.equal(kb.get(defId)?.props?._uiPosition, 'block-left')
  cmds.setUiPosition(defId, 'panel')
  assert.equal('_uiPosition' in (kb.get(defId)?.props ?? {}), false, 'panel 是缺省 ⇒ 摘键')

  cmds.setChoiceIcon(c1, '')
  assert.equal('icon' in (rec(c1) ?? {}), false, '空图标摘格，不留空串')
})


test('选项配色：写色/摘色只改记录，坏值被拒且不落库', () => {
  const { cmds, kb, toasts } = commandHarness()
  const defId = cmds.createPropDef('', '状态', 'select', 'own')
  const c1 = cmds.addChoice(defId, '甲')
  const rec = () => allChoicesOf(kb.get(defId)!).find((c) => c.id === c1)

  cmds.setChoiceColor(c1, 'red')
  assert.equal(rec()?.color, 'red', '色写在选项记录上')
  cmds.setChoiceColor(c1, '#aabbcc')
  assert.equal(rec()?.color, '#aabbcc', 'hex 合法（渲染端的对比度代价另记）')
  cmds.setChoiceColor(c1, 'not-a-color')
  assert.equal(rec()?.color, '#aabbcc', '坏值被拒，旧色保留')
  assert.ok(toasts.some((x) => x.includes('颜色值不合法')), `应有提示：${JSON.stringify(toasts)}`)
  cmds.setChoiceColor(c1, '')
  assert.equal('color' in (rec() ?? {}), false, '空串摘色，不留空槽')
})
test('多值：setChoiceCardinality 写/摘 `_cardinality`；切回单值挡住仍有 >1 值的库', () => {
  const { cmds, kb, toasts } = commandHarness()
  const defId = cmds.createPropDef('', '标签集', 'select', 'own')
  const c1 = cmds.addChoice(defId, '甲')
  const c2 = cmds.addChoice(defId, '乙')
  const host: Block = {
    id: 'host',
    content: textRuns('一块'),
    children: [],
    created: 1,
    modified: 1,
    props: { [defId]: [c1, c2] },
  }
  kb.tx((tx) => tx.insert(host, null, 0))

  cmds.setChoiceCardinality(defId, 'many')
  assert.equal(kb.get(defId)?.props?._cardinality, 'many')
  cmds.setChoiceCardinality(defId, 'one')
  assert.equal(kb.get(defId)?.props?._cardinality, 'many', '还有块选了两个值 ⇒ 不切，且不静默丢值')
  assert.ok(toasts.some((x) => x.includes('多个值')), `应有提示：${JSON.stringify(toasts)}`)

  cmds.setPropValue('host', defId, [c1])
  cmds.setChoiceCardinality(defId, 'one')
  assert.equal('_cardinality' in (kb.get(defId)?.props ?? {}), false, '只剩一个值 ⇒ 可切回单值，槽摘掉')
})

test('基数允许集按 kind 收：date 不能多值、text/asset 可以', () => {
  const { cmds, kb, toasts } = commandHarness()
  const date = cmds.createPropDef('', '截止', 'date', 'own')
  cmds.setChoiceCardinality(date, 'many')
  assert.equal('_cardinality' in (kb.get(date)?.props ?? {}), false, 'date 先只 one')
  assert.ok(toasts.some((x) => x.includes('多值')), `应有提示：${JSON.stringify(toasts)}`)

  const text = cmds.createPropDef('', '多链接', 'text', 'own', 'new')
  cmds.setChoiceCardinality(text, 'many')
  assert.equal(kb.get(text)?.props?._cardinality, 'many', 'text（含 url 格式）可多值')
})

test('多值字段的查询：eq/neq 按包含判，empty 判空数组', () => {
  // `{prop}` 只认定义块 id ⇒ 定义要放进森林；定义块自己命中「没有这一栏」，断言里滤掉
  const def = mkPropDef('多值', 'select', {}, 'p-multi')
  const a = { ...blk('a', 'A'), props: { 'p-multi': ['x', 'y'] } }
  const b = { ...blk('b', 'B'), props: { 'p-multi': ['y'] } }
  const c = { ...blk('c', 'C'), props: { 'p-multi': [] } }
  const blocks = [def, a, b, c]
  const hits = (where: Parameters<typeof runQuery>[0]['where']): string[] =>
    runQuery({ where }, { blocks })
      .map((h) => h.blockId)
      .filter((id) => id !== def.id)
      .sort()
  assert.deepEqual(hits({ prop: { id: 'p-multi', eq: 'y' } }), ['a', 'b'], 'eq = 包含')
  assert.deepEqual(hits({ prop: { id: 'p-multi', neq: 'y' } }), ['c'], 'neq = 不包含')
  assert.deepEqual(hits({ prop: { id: 'p-multi', empty: true } }), ['c'], 'empty = 空数组')
})

test('isMultiValueKey：`_tags` 永远多值；字段按 `_cardinality` 解析', () => {
  assert.equal(isMultiValueKey('_tags'), true)
  assert.equal(isMultiValueKey('p-multi'), false, '没有解析器时不猜')
  assert.equal(
    isMultiValueKey('p-multi', (id) => (id === 'p-multi' ? 'many' : 'one')),
    true,
    '定义声明多值 ⇒ 同一个判据',
  )
})

/* ------------------------------------------------------------ 9. 类型系统 */

test('propKindOf：七 kind；旧形状 `_kind:"url"` 读成 text（值不变、format 给 url）', () => {
  const text = mkPropDef('备注', 'text')
  assert.equal(propKindOf(text), 'text')
  assert.equal(formatOf(text), undefined, '缺省没有格式')

  const url = blk('url-def', '链接', { _kind: 'url' })
  assert.equal(propKindOf(url), 'text', 'url 降格为 text（不写迁移、读路径归一）')
  assert.equal(formatOf(url), 'url', '旧定义没写 `_format` ⇒ 按 url 解释')

  const email = mkPropDef('邮箱', 'text', { _format: 'email' })
  assert.equal(formatOf(email), 'email')

  const asset = mkPropDef('封面', 'asset', { _format: 'image' })
  assert.equal(propKindOf(asset), 'asset')
  assert.equal(formatOf(asset), 'image')

  // 格式名不在允许集 ⇒ 回落缺省（不崩、不静默把坏值当格式）
  const bad = mkPropDef('坏格式', 'text', { _format: 'sparkles' })
  assert.equal(formatOf(bad), undefined)
  // 没有格式轴的 kind：写了也不认
  const cb = mkPropDef('勾', 'checkbox', { _format: 'plain' })
  assert.equal(formatOf(cb), undefined)
})

/* ------------------------------------------------------------ 10. 排序 */

test('sortRecords：select 列按记录顺序（resolver），不在列表的值排最后', () => {
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

/* ------------------------------------------------------------ 11. 写路径的格式校验 */

test('textFormatOk：url 只收 http(s)（与打开端同一白名单）、email/phone 形状、空串恒合法', () => {
  assert.equal(textFormatOk('url', 'https://qua.leay.net/a?b=1'), true)
  assert.equal(textFormatOk('url', 'http://x.y'), true)
  assert.equal(textFormatOk('url', 'qua.leay.net'), false, '没写协议 ⇒ 拒（与插入端同一口径）')
  assert.equal(textFormatOk('url', 'file:///etc/passwd'), false, '非 http(s) 协议一律拒')
  assert.equal(textFormatOk('url', ''), true, '空是「没填」，不是格式错')
  assert.equal(textFormatOk('email', 'a@b.co'), true)
  assert.equal(textFormatOk('email', 'a@b'), false, '没有点号的域名不收')
  assert.equal(textFormatOk('phone', '+86 138-0000-0000'), true)
  assert.equal(textFormatOk('phone', 'abc'), false)
  assert.equal(textFormatOk('plain', '随便什么'), true, 'plain 不校验')
  assert.equal(textFormatOk(undefined, '随便什么'), true)
})

test('setPropValue 按 kind／format 校验：坏值不写并提示；合法值照写', () => {
  const { cmds, kb, toasts } = commandHarness()
  const url = cmds.createPropDef('', '主页', 'text', 'own')
  cmds.setPropFormat(url, 'url')
  const host = blk('host', '一块')
  kb.tx((tx) => tx.insert(host, null, 0))

  cmds.setPropValue('host', url, 'qua.leay.net')
  assert.equal(kb.get('host')?.props?.[url], undefined, '不合格式 ⇒ 一个字节都没写')
  assert.ok(toasts.some((x) => x.includes('链接')), `应有格式提示：${JSON.stringify(toasts)}`)

  cmds.setPropValue('host', url, 'https://qua.leay.net')
  assert.equal(kb.get('host')?.props?.[url], 'https://qua.leay.net', '合法值照写')

  // 形状不对（number 收到字符串）⇒ 拒
  const num = cmds.createPropDef('', '评分', 'number', 'own', 'new')
  cmds.setPropValue('host', num, '五星')
  assert.equal(kb.get('host')?.props?.[num], undefined)
})

test('setPropFormat：写槽／plain 摘键／无格式轴的 kind 拒绝', () => {
  const { cmds, kb, toasts } = commandHarness()
  const text = cmds.createPropDef('', '备注', 'text', 'own')
  cmds.setPropFormat(text, 'email')
  assert.equal(kb.get(text)?.props?._format, 'email')
  cmds.setPropFormat(text, 'plain')
  assert.equal('_format' in (kb.get(text)?.props ?? {}), false, 'plain 是缺省 ⇒ 摘键')

  cmds.setPropFormat(text, 'sparkles')
  assert.equal('_format' in (kb.get(text)?.props ?? {}), false, '未知格式不写')

  const box = cmds.createPropDef('', '勾', 'checkbox', 'own', 'new')
  cmds.setPropFormat(box, 'plain')
  assert.ok(toasts.some((x) => x.includes('没有格式轴')), `应有提示：${JSON.stringify(toasts)}`)
})

test('asset：值只收资产 id 或 http(s) 链接（两态同一个 kind）', () => {
  assert.equal(isAssetRef('0123456789abcdef0123'), true, '内态：资产库 hash')
  assert.equal(isAssetRef('https://example.com/a.png'), true, '外态：外链')
  assert.equal(isAssetRef('随便一段字'), false)
  assert.equal(isAssetRef(''), false)
})

/* ------------------------------------------------------------ 12. 删掉这一栏 */

test('属性行的删除键：自有行摘栏（连槽），声明来的行只清值（声明在标签上）', () => {
  const def = mkPropDef('任务状态', 'select', { _default: 'c-todo' }, 'p-status')
  const tag = blk('tag', '任务', { _aliases: ['任务'], _lists: ['tag'], _fieldDefs: ['p-status'] })
  const own: Block = {
    id: 'own',
    content: textRuns('本块自有'),
    children: [],
    created: 1,
    modified: 1,
    props: { _ownProps: ['p-status'], 'p-status': 'c-done' },
  }
  const declared: Block = {
    id: 'declared',
    content: textRuns('靠标签声明'),
    children: [],
    created: 1,
    modified: 1,
    props: { _tags: ['tag'], 'p-status': 'c-done' },
  }
  const plain: Block = {
    id: 'plain',
    content: textRuns('只登记了槽'),
    children: [],
    created: 1,
    modified: 1,
    props: { _ownProps: ['p-status'] },
  }
  const store = new BlockStore([def, tag, own, declared, plain])
  const kb = new MemoryKb(store)
  const deps: PropsDeps = {
    kb,
    write: (_blockId, mutate) => mutate(),
    run: (fn) => {
      const r = kb.tx(fn)
      return { ops: r.ops, result: r.result }
    },
    toast: () => {},
  }
  const cmds = propsCommands(deps)
  const rowsOf = (id: string): string[] => fieldRows(kb.get(id)!, kb.roots()).map((r) => r.propId)

  // 自有行：× ＝ 摘掉这一栏（值连同槽），行消失
  cmds.clearPropValue('own', 'p-status', { drop: true })
  assert.equal('p-status' in (kb.get('own')?.props ?? {}), false, '值走了')
  assert.deepEqual(kb.get('own')?.props?._ownProps ?? [], [], '自有槽也摘掉')
  assert.deepEqual(rowsOf('own'), [], '行不再出现（不是停在「待填」）')

  // 声明来的行：drop 只清值，声明不动 ⇒ 行仍是「待填」
  cmds.clearPropValue('declared', 'p-status', { drop: true })
  assert.equal('p-status' in (kb.get('declared')?.props ?? {}), false, '值走了')
  assert.deepEqual(rowsOf('declared'), ['p-status'], '声明在标签上，这里删不掉它')

  // 已验证的坑：只登记了槽、没有值 —— 不传 drop 时是**零改动**（点了没反应）
  const before = JSON.stringify(kb.get('plain')?.props)
  cmds.clearPropValue('plain', 'p-status')
  assert.equal(JSON.stringify(kb.get('plain')?.props), before, '缺省语义：有缺省值的定义留栏，这一格本来就没值 ⇒ 不动')
  cmds.clearPropValue('plain', 'p-status', { drop: true })
  assert.deepEqual(kb.get('plain')?.props?._ownProps ?? [], [], 'drop 才真摘掉那个空槽')
})
