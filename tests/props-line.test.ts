/**
 * **块下属性行**的派生：一条属性只在一个地方画。
 *
 * 验收口径：
 *   · 有值才进这一行（空值只记数，交给面板与 `+N`）；
 *   · 已经画成块标后图标的不重复（`select`／`checkbox` ＋ `_uiPosition: block-left`）；
 *   · `block-left` 手写在**画不出图标**的类型上时，仍要落在块下行 —— 不能两头都没有；
 *   · 批级派生与单块 `fieldRows` 过滤的结论**逐行一致**（同一份行派生，两个画法）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  belowFieldsFor,
  CHILD_PROPS_FOLLOW_PROP,
  CHILD_PROPS_FOR_REFS_PROP,
  CHILD_PROPS_PROP,
  constrainBelowFields,
  ENGINE_CREATED,
  ENGINE_MODIFIED,
  enginePropText,
  fieldRows,
  fieldRowsWithParent,
  mkPropDef,
  planManageFields,
  type FieldRow,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { PROP_VALUE_CHIPS_SHOWN, valueChipItemsOf } from '../src/ui/block-ui/props-line.ts'

/* ------------------------------------------------------------ 夹具 */

const blk = (id: string, text = '', props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const tag = (id: string, name: string, fields: string[]): Block =>
  blk(id, name, { _aliases: [name], _lists: ['tag'], _fieldDefs: fields })

/** 一个块 + 一个声明了四类属性的标签：文本／块标图标／空文本／`block-left` 的文本 */
function fixture(): { forest: Block[]; block: Block } {
  const defAuthor = mkPropDef('作者', 'text', {}, 'def-author')
  const defStatus = mkPropDef('状态', 'select', { _uiPosition: 'block-left' }, 'def-status')
  const defNote = mkPropDef('备注', 'text', {}, 'def-note')
  // `block-left` 手写在 text 上：gutter 不画图标（只有 select/checkbox 会画）⇒ 必须落在块下行
  const defPinned = mkPropDef('钉住', 'text', { _uiPosition: 'block-left' }, 'def-pinned')
  const t = tag('tag-book', '书', [defAuthor.id, defStatus.id, defNote.id, defPinned.id])
  const b = blk('b1', '一本书', {
    _tags: [t.id],
    'def-author': '张三',
    'def-status': 'choice-1',
    'def-pinned': '在块下',
  })
  return { forest: [t, defAuthor, defStatus, defNote, defPinned, b], block: b }
}

const labels = (rows: readonly FieldRow[]): string[] => rows.map((r) => r.label)

/* ------------------------------------------------------------ 断言 */

test('块下属性行：有值才画；块标图标上的不重复；空值只记数', () => {
  const { forest, block } = fixture()
  const got = belowFieldsFor([block], forest).get(block.id)
  assert.ok(got, '有值 ⇒ 这一行存在')
  assert.deepEqual(labels(got.rows), ['作者', '钉住'], '作者（文本）与钉住（block-left 但画不出图标）都在；状态有图标、备注没值')
  assert.equal(got.pending, 1, '备注声明了但没填 ⇒ 记 1 条待填，不占这一行的额度')
})

test('块下属性行：一个值都没有 ⇒ 不出这一行（不靠空行表达 schema）', () => {
  const defAuthor = mkPropDef('作者', 'text', {}, 'def-author')
  const t = tag('tag-book', '书', [defAuthor.id])
  const b = blk('b1', '一本书', { _tags: [t.id] })
  assert.equal(belowFieldsFor([b], [t, defAuthor, b]).get(b.id), undefined)
})

test('块下属性行：白名单要的栏即使没有值也留一条待填（勾了不能看不见）', () => {
  const { forest, block } = fixture()
  const got = belowFieldsFor([block], forest, undefined, undefined, { wanted: ['def-note'] }).get(block.id)!
  assert.deepEqual(got.rows.map((r) => r.propId), ['def-author', 'def-pinned'], '没值的不进有值行')
  assert.deepEqual(got.pendingRows.map((r) => r.propId), ['def-note'], '显式要了它 ⇒ 待填里有它（+N 仍然数得到）')
})

test('块下属性行：卡片没有 gutter ⇒ includeGutter 把归块标的 select 并进属性行', () => {
  const { forest, block } = fixture()
  const plain = belowFieldsFor([block], forest).get(block.id)!
  assert.ok(!plain.rows.some((r) => r.propId === 'def-status'), '大纲面：有块标图标 ⇒ 不重复进块下行')
  const card = belowFieldsFor([block], forest, undefined, undefined, { includeGutter: true }).get(block.id)!
  assert.ok(card.rows.some((r) => r.propId === 'def-status'), '卡片面：没有 gutter，块下行是它唯一的露面')
})

test('块下属性行：wanted 能补引擎属性（创建时间读块字段，不进 `props` 袋）', () => {
  const b = blk('b1', '一个块')
  b.created = 1234
  const got = belowFieldsFor([b], [], undefined, undefined, { wanted: [ENGINE_CREATED] }).get('b1')!
  assert.deepEqual(got.rows.map((r) => [r.propId, r.value]), [[ENGINE_CREATED, 1234]])
})

test('constrainBelowFields：白名单收窄行与待填计数；空数组＝只标题', () => {
  const { forest, block } = fixture()
  const below = belowFieldsFor([block], forest)
  const onlyAuthor = constrainBelowFields(below, ['def-author']).get(block.id)!
  assert.deepEqual(onlyAuthor.rows.map((r) => r.propId), ['def-author'])
  assert.equal(onlyAuthor.pending, 0, '备注不在白名单 ⇒ 待填计数也不带上（否则屏幕上一条都没有、+1 却还在）')
  assert.equal(constrainBelowFields(below, []).get(block.id), undefined, '空数组是合法白名单（只标题）')
  assert.equal(constrainBelowFields(below, undefined).get(block.id)?.rows.length, 2, 'undefined ＝ 不覆写')
})

test('块下属性行：批级派生与单块 fieldRows 过滤逐行一致', () => {
  const { forest, block } = fixture()
  const batch = belowFieldsFor([block], forest).get(block.id)!
  const single = fieldRows(block, forest).filter((row) => {
    if (!row.filled) return false
    if (!row.def) return true
    if (row.def.props?.['_uiPosition'] !== 'block-left') return true
    return row.kind !== 'select' && row.kind !== 'checkbox'
  })
  assert.deepEqual(
    batch.rows.map((r) => [r.propId, r.label, r.value]),
    single.map((r) => [r.propId, r.label, r.value]),
  )
  assert.equal(
    batch.pending,
    fieldRows(block, forest).filter((r) => {
      if (r.filled || !r.def) return false
      if (r.def.props?.['_uiPosition'] !== 'block-left') return true
      return r.kind !== 'select' && r.kind !== 'checkbox'
    }).length,
  )
})

/* ------------------------------------------------------------ 主体行下的管理档 */

/**
 * 管理档与块下行吃同一份行派生，只差两件事：**不画 gutter 字段**（块标旁那一格
 * 已经在了，30px 内不要两个可编辑控件）、**只剩待填也留下**（「N 项待填」是入口）。
 * `planManageFields` 同时供渲染与虚拟化估高，所以两边不会再各算一遍。
 *
 * ⚠️ 它**只管值段**：字段声明由正文里的定义身体画（那一格本来就在，可折、带添加入口），
 *    两处都画就是同一段在一行下出现两次。
 */
test('管理档：值全显、gutter 字段不重复（整组都是 gutter 的标签一条不剩）', () => {
  const { forest, block } = fixture()
  const plan = planManageFields(fieldRows(block, forest), false)!
  assert.ok(plan)
  assert.deepEqual(labels(plan.rows), ['作者', '钉住'], '状态归块标（gutter）⇒ 行下不重复；备注没值')
  assert.equal(plan.pendingTotal, 1, '备注的待填要数出来（渲染成一行 `+1 项待填`）')
  assert.equal(plan.open, false)
  assert.equal(plan.slots, 4, '段头 ＋ 两行有值 ＋ 一行待填')

  // 只有 gutter 字段的标签：管理档整格不出现（不是被筛成空壳）
  const defStatus = mkPropDef('状态', 'select', { _uiPosition: 'block-left' }, 'def-status')
  const t = tag('tag-status', '状态组', [defStatus.id])
  const b = blk('b2', '一条任务', { _tags: [t.id], 'def-status': 'choice-1' })
  assert.equal(planManageFields(fieldRows(b, [t, defStatus, b]), false), null)
})

test('管理档：全空的块也留下「N 项待填」；展开后逐行并进来（再点收起）', () => {
  const defAuthor = mkPropDef('作者', 'text', {}, 'def-author')
  const t = tag('tag-book', '书', [defAuthor.id])
  const b = blk('b1', '一本书', { _tags: [t.id] })
  const rows = fieldRows(b, [t, defAuthor, b])
  const shut = planManageFields(rows, false)!
  assert.deepEqual(shut.rows, [], '一条值都没有 ⇒ 不铺空行')
  assert.equal(shut.pendingTotal, 1)
  assert.equal(shut.slots, 1, '只剩那一行 `+N`（不套空段头）')

  const open = planManageFields(rows, true)!
  assert.deepEqual(labels(open.rows), ['作者'], '展开＝待填就地变成可编辑的行')
  assert.equal(open.pendingTotal, 1, '展开后总数仍要它来画「收起」')
  assert.equal(open.slots, 3, '段头 ＋ 一行待填 ＋ 一行「收起待填」')

  assert.equal(planManageFields([], false), null, '没有值、没有待填 ⇒ 整格不出现')
})

/* ------------------------------------------------------------ _childProps 与引擎属性 */

test('子块行内属性：父块 _childProps 并入直接子块的行；孙块不沾光', () => {
  const parent = blk('p1', 'Life Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const child = blk('c1', '今天的一条')
  const grand = blk('g1', '细节')
  const forest = [parent, { ...child, children: [grand] } as Block]
  const withParent = (blocks: readonly Block[]) =>
    belowFieldsFor(blocks, forest, (id) => (id === 'c1' ? parent : id === 'g1' ? child : null))
  const rows = withParent([child]).get('c1')?.rows ?? []
  assert.deepEqual(rows.map((r) => r.propId), [ENGINE_CREATED], '子块并入「创建于」')
  assert.equal((withParent([grand]).get('g1')?.rows ?? []).length, 0, '孙块不显示（只直接子块）')
})

test('子块行内属性：有值才显示（普通属性子块没填 ⇒ pending）；子块自己的行优先去重', () => {
  const defMood = mkPropDef('心情', 'text', {}, 'def-mood')
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [defMood.id, ENGINE_CREATED] })
  const empty = blk('c1', '没填心情')
  const own = blk('c2', '自己有这栏', { _ownProps: [defMood.id], 'def-mood': '平静' })
  const forest = [parent, empty, own, defMood]
  const call = (blocks: readonly Block[]) =>
    belowFieldsFor(blocks, forest, (id) => (id === 'c1' || id === 'c2' ? parent : null))
  const e1 = call([empty]).get('c1')
  assert.deepEqual(e1?.rows.map((r) => r.propId), [ENGINE_CREATED], '没填的行不出，引擎行恒有值')
  assert.equal(e1?.pending, 1, '空值记进 pending')
  const e2 = call([own]).get('c2')
  assert.equal(e2?.rows.filter((r) => r.propId === defMood.id).length, 1, '同一 propId 只出一行')
})

test('引擎属性：定义合成注入、值桥到块顶层字段；显示文本今天给时刻、往日带日期', () => {
  // 「今天」必须按跑测试那天的日历日构造——硬编码日期跨过零点就不再是今天（11-08 那份真炸过）
  const now = new Date()
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14, 32, 0)
  const b = blk('b1', 'x', {})
  b.created = t.getTime()
  // 行只有被声明（如父块 _childProps）才出现——引擎注入的是**定义**（可查、有 label），不是「每块都显示」
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const row = fieldRowsWithParent(b, [b, parent], parent).find((r) => r.propId === ENGINE_CREATED)
  assert.ok(row, '声明后引擎行出现')
  assert.equal(row?.label, '创建于')
  assert.equal(row?.value, b.created, '值桥：来自 block.created，不是 props 袋')
  assert.ok(row?.filled, '引擎行恒有值')
  assert.equal(enginePropText(ENGINE_CREATED, b.created), '14:32', '今天只给时刻')
  const otherDay = new Date('2026-11-01T09:05:00').getTime()
  assert.equal(enginePropText(ENGINE_CREATED, otherDay), '11-01 09:05', '往日带日期')
  // 旧签名（不传 parentOf）行为不变：引擎行不凭空出现
  assert.equal(belowFieldsFor([b], []).get('b1'), undefined)
})

test('标签声明：打了标签的块，其子块并入标签的显示声明；父块自己的声明在前', () => {
  const defMood = mkPropDef('心情', 'text', {}, 'def-mood3')
  const lifeTag = blk('tag-life', 'LifeLog', { _aliases: ['LifeLog'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const parent = blk('p1', '今天的记录', { _tags: ['tag-life'], [CHILD_PROPS_PROP]: [ENGINE_MODIFIED] })
  const child = blk('c1', '一条', { 'def-mood3': '平静' })
  const forest = [lifeTag, parent, child, defMood]
  const rows = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? parent : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  // 子块写过值的（def-mood3）是它自己的行、永远在前；声明链的补充行（父块自己的→标签的）按序在后
  assert.deepEqual(rows, [defMood.id, ENGINE_MODIFIED, ENGINE_CREATED])
  // 没填值的声明不显示（pending）：child 没填的心情不出现，由 pending 记数
  // 面板口径一致
  const panelRows = fieldRowsWithParent(child, forest, parent).map((r) => r.propId)
  assert.deepEqual(panelRows, rows)
})

test('标签声明：多标签并集去重；标签块自己当容器也生效；标签的标签不传递', () => {
  const defA = mkPropDef('甲', 'text', {}, 'def-a')
  const defB = mkPropDef('乙', 'text', {}, 'def-b')
  const tag1 = blk('tag-1', 'T1', { _aliases: ['T1'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_MODIFIED, ENGINE_CREATED] })
  const tag2 = blk('tag-2', 'T2', { _aliases: ['T2'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED, defB.id] })
  // 标签的标签：tag2 打了 tag1 ⇒ 不传递（不做继承）
  tag2.props = { ...(tag2.props ?? {}), _tags: ['tag-1'] }
  const parent = blk('p1', '两标签', { _tags: ['tag-1', 'tag-2'] })
  const child = blk('c1', '一条', { 'def-b': 'b值' })
  const forest = [tag1, tag2, parent, child, defA, defB]
  const rows = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? parent : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  // 子块自己的行（def-b，写了值）在前；声明链按打标序去重合并（core/created 只出一次）
  assert.deepEqual(rows, [defB.id, ENGINE_MODIFIED, ENGINE_CREATED])
  // 标签块自己当容器：child 直挂 tag1 下 ⇒ 父块自己的声明命中（甲没填值不显示）
  const underTag = blk('c2', '挂在标签下')
  const rows2 = (belowFieldsFor([underTag], forest, (id) => (id === 'c2' ? tag1 : null)).get('c2')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(rows2, [ENGINE_MODIFIED, ENGINE_CREATED])
})

test('fieldRowsWithParent：面板口径与批级一致（父声明排在子块自己的行之后）', () => {
  const defMood = mkPropDef('心情', 'text', {}, 'def-mood2')
  const parent = blk('p1', 'Log', { [CHILD_PROPS_PROP]: [ENGINE_CREATED, defMood.id] })
  const child = blk('c1', '记录', { _ownProps: [defMood.id], 'def-mood2': '平静' })
  const forest = [parent, child, defMood]
  const rows = fieldRowsWithParent(child, forest, parent)
  assert.deepEqual(rows.map((r) => r.propId), [defMood.id, ENGINE_CREATED], '自有行在前、父声明补在后、去重')
  // 单块（无父）等于旧 fieldRows
  assert.deepEqual(fieldRowsWithParent(child, forest, null).map((r) => r.propId), [defMood.id])
})

test('传递型引用：正文只有一枚引用的块，其子块沿目标解析声明；引用带正文不透传；环不死循环', () => {
  const lifeTag = blk('tag-life', 'LifeLog', { _aliases: ['LifeLog'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  // 传递块：正文恰好一枚指向 LifeLog 的引用
  const pass = blk('pass1', '')
  pass.content = [{ id: 'r1', t: 'ref', to: 'tag-life' }]
  const child = blk('c1', '一条')
  const forest = [lifeTag, pass, child]

  const viaPass = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? pass : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(viaPass, [ENGINE_CREATED], '传递块的子块沿目标命中声明')

  // 带正文的引用不透传
  const withText = blk('pass2', '今天看了')
  withText.content = [...textRuns('今天看了'), { id: 'r2', t: 'ref', to: 'tag-life' }]
  const viaText = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? withText : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(viaText, [], '引用只是提及 ⇒ 不透传')

  // 环：A 传 B、B 传 A ⇒ 终止不炸
  const a = blk('loop-a', '')
  a.content = [{ id: 'r3', t: 'ref', to: 'loop-b' }]
  const b = blk('loop-b', '')
  b.content = [{ id: 'r4', t: 'ref', to: 'loop-a' }]
  const viaLoop = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? a : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(viaLoop, [], '环上没有声明 ⇒ 空且终止')

  // 传递链中间带正文即断（A 传 B，B 有正文 + 引用 C）
  const mid = blk('mid', '正文')
  mid.content = [...textRuns('正文'), { id: 'r5', t: 'ref', to: 'tag-c' }]
  const viaBroken = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? mid : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(viaBroken, [], '链上有一环带正文 ⇒ 断')

  /**
   * 显式关掉继承（`_childPropsFollow: false`）：目标那一跳停住，但**本块自己的声明
   * 与标签声明照常**——开关管的是「目标透不透」，不是「这块有没有声明」。
   */
  const defMood = mkPropDef('心情', 'text', {}, 'def-follow')
  const localTag = blk('tag-local', 'Local', {
    _aliases: ['Local'],
    _lists: ['tag'],
    [CHILD_PROPS_PROP]: [defMood.id],
  })
  const off = blk('pass-off', '', {
    [CHILD_PROPS_PROP]: [ENGINE_MODIFIED],
    [CHILD_PROPS_FOLLOW_PROP]: false,
    _tags: ['tag-local'],
  })
  off.content = [{ id: 'r6', t: 'ref', to: 'tag-life' }]
  const record = blk('c-off', '记录')
  const offForest = [...forest, localTag, off, record, defMood]
  // 面板口径（`fieldRowsWithParent`）把声明行原样列出，不要求值已填——这才看得到
  // 「标签声明还在、目标声明没了」两者的差别
  const rowsOff = fieldRowsWithParent(record, offForest, off).map((r) => r.propId)
  assert.ok(rowsOff.includes(ENGINE_MODIFIED), '自己的声明照常生效')
  assert.ok(rowsOff.includes(defMood.id), '标签声明照常生效')
  assert.ok(!rowsOff.includes(ENGINE_CREATED), '目标声明被开关挡住')
})

test('传递型引用的策略链：源块默认管全部引用，引用块可逐跳覆盖', () => {
  const targetOn = blk('src-on', '目标', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const targetOff = blk('src-off', '目标', {
    [CHILD_PROPS_PROP]: [ENGINE_CREATED],
    [CHILD_PROPS_FOR_REFS_PROP]: false,
  })
  const passTo = (id: string, target: Block, props?: Record<string, unknown>): Block => {
    const b = blk(id, '', props)
    b.content = [{ id: `ref-${id}`, t: 'ref', to: target.id }]
    return b
  }
  const has = (target: Block, ref: Block): boolean => {
    const child = blk(`kid-${ref.id}`, '子')
    return fieldRowsWithParent(child, [target, ref, child], ref).some((r) => r.propId === ENGINE_CREATED)
  }

  // 源块开（缺省）＋未覆盖 ⇒ 继承（现状不变）
  assert.equal(has(targetOn, passTo('r1', targetOn)), true)
  // 源块开＋这一跳强制关 ⇒ 不继承
  assert.equal(has(targetOn, passTo('r2', targetOn, { [CHILD_PROPS_FOLLOW_PROP]: false })), false)
  // 源块关＋未覆盖 ⇒ 不继承（源级一次配置管所有引用）
  assert.equal(has(targetOff, passTo('r3', targetOff)), false)
  // 源块关＋这一跳强制开 ⇒ 继承（个别例外）
  assert.equal(has(targetOff, passTo('r4', targetOff, { [CHILD_PROPS_FOLLOW_PROP]: true })), true)

  // 链式引用逐跳求值：每一跳都用自己的「源块默认 / 站点覆盖」
  const midToOff = passTo('mid-open', targetOff, { [CHILD_PROPS_FOLLOW_PROP]: true })
  assert.equal(has(targetOff, midToOff), true, '中间跳强制开 ⇒ 越过源块的关')
  const refToMid = passTo('ref-mid', midToOff)
  const child = blk('kid-chain', '子')
  const chainRows = fieldRowsWithParent(child, [targetOff, midToOff, refToMid, child], refToMid).map((r) => r.propId)
  assert.ok(chainRows.includes(ENGINE_CREATED), '链上每一跳各自求值：R→M 默认跟随，M→T 强制开')
})

test('childPropsLookupOf：复用外部 byId 表（index.blocks）与自建 walk 的结果一致', () => {
  const lifeTag = blk('tag-idx', 'LifeLog', { _aliases: ['LifeLog'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const nested = blk('nested-idx', '念书', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  const page = blk('pg-idx', '页')
  page.children = [nested]
  const pass = blk('pass-i', '')
  pass.content = [{ id: 'r9', t: 'ref', to: 'nested-idx' }]
  const child = blk('c1', '一条')
  const forest = [lifeTag, page, pass, child]
  // 模拟 index.blocks（全库 byId，含嵌套）
  const byId = new Map(forest.map((b) => [b.id, b]))
  for (const b of forest) for (const k of b.children ?? []) byId.set(k.id, k)
  const viaIndex = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? pass : null), byId).get('c1')?.rows ?? []).map((r) => r.propId)
  const viaWalk = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? pass : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(viaIndex, viaWalk, '复用 index 表与自建 walk 等价')
  assert.deepEqual(viaIndex, [ENGINE_CREATED])
})

test('传递型引用：目标嵌在子树里也命中（lookup 必须递归全库，不是顶层一遍）', () => {
  const lifeTag = blk('tag-nested', 'LifeLog', { _aliases: ['LifeLog'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  // 目标块**嵌在页的子树里**（真机形状）：顶层森林数组里没有它
  const page = blk('pg', '页', { props: undefined } as Record<string, unknown>)
  const nested = blk('nested', '念书', { [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  page.children = [nested]
  const pass = blk('pass-n', '')
  pass.content = [{ id: 'r8', t: 'ref', to: 'nested' }]
  const child = blk('c1', '一条')
  const forest = [lifeTag, page, pass, child]
  const rows = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? pass : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(rows, [ENGINE_CREATED], '非顶层的目标块也要被 lookup 找到')
})

test('传递型引用：引用后跟空格（[ref, text(空格)]）仍透传——可见文字为空才算「只有引用」', () => {
  const lifeTag = blk('tag-life2', 'LifeLog', { _aliases: ['LifeLog'], _lists: ['tag'], [CHILD_PROPS_PROP]: [ENGINE_CREATED] })
  // 真机踩到的形状：引用后跟了空格 run，多一枚 run 但没有可见文字
  const pass = blk('pass-sp', '')
  pass.content = [{ id: 'r6', t: 'ref', to: 'tag-life2' }, ...textRuns(' ')]
  const child = blk('c1', '一条')
  const forest = [lifeTag, pass, child]
  const rows = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? pass : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(rows, [ENGINE_CREATED], '空白段不算字 ⇒ 透传')
  // 非空白文字 ⇒ 不透传（提及）
  const withWords = blk('pass-w', '')
  withWords.content = [{ id: 'r7', t: 'ref', to: 'tag-life2' }, ...textRuns(' 今天看了 ')]
  const rows2 = (belowFieldsFor([child], forest, (id) => (id === 'c1' ? withWords : null)).get('c1')?.rows ?? []).map((r) => r.propId)
  assert.deepEqual(rows2, [], '有可见文字 ⇒ 不透传')
})

/* ------------------------------------------------------------ 一条多值的「值内投影」 */

const row = (over: Partial<FieldRow> & Pick<FieldRow, 'kind' | 'value'>): FieldRow => ({
  propId: 'p-multi',
  label: '多选',
  cardinality: 'many',
  filled: true,
  sources: [],
  order: 0,
  ...over,
})

test('值内投影：返回全量（截断是版面的决定，计数才能与宽度无关）', () => {
  const labels = ['甲', '乙', '丙', '丁', '戊']
  const items = valueChipItemsOf(row({ kind: 'select', value: ['a', 'b', 'c', 'd', 'e'], currentChoiceLabels: labels }), (id) => id)
  assert.deepEqual(items.map((i) => i.text), labels, '顺序＝选项兄弟序')
  assert.equal(items.length, 5, '五枚都在投影里——画几枚是渲染层的事')
  assert.ok(PROP_VALUE_CHIPS_SHOWN < items.length, '夹具必须超过一行的额度，否则这条断言没有意义')
})

test('值内投影：ref 各带自己的目标；只有 text 的 url 格式才挂链接', () => {
  const named: Record<string, string> = { r1: '甲', r2: '乙' }
  assert.deepEqual(valueChipItemsOf(row({ kind: 'ref', value: ['r1', 'r2'] }), (id) => named[id] ?? ''), [
    { text: '甲', refId: 'r1' },
    { text: '乙', refId: 'r2' },
  ], '每一枚各带 data-ref-to 的来源，不是整格挂一次')

  const urls = valueChipItemsOf(row({ kind: 'text', format: 'url', value: ['https://a.example', 'https://b.example'] }), (id) => id)
  assert.deepEqual(urls, [
    { text: 'https://a.example', url: 'https://a.example' },
    { text: 'https://b.example', url: 'https://b.example' },
  ], '多链接逐枚可点')

  const plain = valueChipItemsOf(row({ kind: 'text', value: ['甲', '乙'] }), (id) => id)
  assert.equal(plain[0]?.url, undefined, 'plain 文本不挂链接（点了会去开一个不是地址的东西）')
})
