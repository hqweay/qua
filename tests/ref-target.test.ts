/**
 * **`ref` 的候选域（`_refTags`）**：值层不变，候选面按标签成员收窄。
 *
 * 验收口径（为什么这些断言长这样）：
 *   · **软约束** —— 只过滤候选，不校验存量值。约束改了／标签删了／块换了标签，
 *     已引用的块照常显示；写路径一条都不许拿 `_refTags` 拒写。
 *   · **闭包** —— 「`#演员` 也是 `#人物`」只有 `membersOf` 一份实现，候选跟着它走。
 *   · **三种答案分开** —— 无约束（`null`）／有候选（非空集）／有约束但没人（空集）。
 *     把前两者合成一个布尔真值判断，会在「约束存在但没成员」时静默退回全部候选。
 *   · **新建并引用** —— 建页与写值**同一笔**（拆开就有「页建了、值没写」的半批），
 *     同名地址复用而不是建第二个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  appendEdge,
  cardinalityOf,
  fieldRows,
  isRefTagIds,
  isRefViewValue,
  mkPropDef,
  mkTagBlock,
  prop,
  propKindOf,
  refTagIds,
  refTagNames,
  refTargetScope,
  refViewOf,
  valueOf,
} from '../src/core/index.ts'
import { createNameChoice } from '../src/app/retrieval/name-choice.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { propsCommands } from '../src/app/commands/props.ts'
import type { PropsDeps } from '../src/app/commands/types.ts'

/* ------------------------------------------------------------ 夹具 */

/** 带名字的身份块（测试自己定 id，便于断言） */
function named(id: string, name: string, lists: ('page' | 'tag')[] = []): Block {
  const b = mkTagBlock(name)
  b.id = id
  b.props = lists.length > 0 ? { _aliases: [name], _lists: lists } : { _aliases: [name] }
  return b
}
const tag = (id: string, name: string): Block => named(id, name, ['tag'])
const page = (id: string, name: string): Block => named(id, name, ['page'])
const plain = (id: string, name: string): Block => named(id, name)

/** 给块打一个标签（归属在块上） */
function wear(block: Block, tagId: string): void {
  block.props = { ...(block.props ?? {}), _tags: [tagId] }
}

function commandHarness(): { cmds: ReturnType<typeof propsCommands>; kb: MemoryKb; toasts: string[] } {
  const store = new BlockStore([])
  const kb = new MemoryKb(store)
  const toasts: string[] = []
  const deps: PropsDeps = {
    kb,
    write: (_blockId, mutate) => mutate(),
    repaintBlocks: () => {},
    run: (fn) => {
      const r = kb.tx(fn)
      return { ops: r.ops, result: r.result }
    },
    toast: (text) => void toasts.push(text),
  }
  return { cmds: propsCommands(deps), kb, toasts }
}

/**
 * 森林：`#人物`（people）下挂 `#演员`（actor）；成员甲打 `#演员`、乙直接打 `#人物`、
 * 丙谁都没打。定义块 `def`（引用）在顶层。
 */
function scene(): {
  forest: Block[]
  def: Block
  people: Block
  actor: Block
  a: Block
  b: Block
  c: Block
} {
  const people = tag('people', '人物')
  const actor = tag('actor', '演员')
  const def = mkPropDef('作者', 'ref')
  def.id = 'def'
  const a = plain('a', '演员甲')
  const b = plain('b', '人物乙')
  const c = plain('c', '无关丙')
  wear(a, 'actor')
  wear(b, 'people')
  appendEdge(actor, people)
  return { forest: [def, people, actor, a, b, c], def, people, actor, a, b, c }
}

const withTags = (def: Block, ids: string[]): Block => {
  def.props = { ...(def.props ?? {}), _refTags: ids }
  return def
}

/* ------------------------------------------------------------ 1. 形状判据 */

test('_refTags 形状：缺席＝无约束、坏形状读成空、合法是 id 数组', () => {
  const { def } = scene()
  assert.deepEqual(refTagIds(def), [], '没写过这一格')
  assert.deepEqual(refTagIds(undefined), [], '定义都没有')

  def.props = { ...(def.props ?? {}), _refTags: 'nope' }
  assert.deepEqual(refTagIds(def), [], '标量不是合法形状 ⇒ 读成无约束（不崩、不猜）')

  def.props = { ...(def.props ?? {}), _refTags: [''] }
  assert.deepEqual(refTagIds(def), [], '空串 id 不算')

  withTags(def, ['people', 'actor'])
  assert.deepEqual(refTagIds(def), ['people', 'actor'], '合法形状原样读出（不清洗、不去重）')
  assert.equal(isRefTagIds(['x']), true)
  assert.equal(isRefTagIds([1]), false)
})

test('_refTags 是登记过的系统键：写坏形状在 op 产出点就被拒（不进内存、不进日志）', () => {
  const { kb, cmds } = (() => {
    const h = commandHarness()
    return { kb: h.kb, cmds: h.cmds }
  })()
  const defId = cmds.createPropDef('', '作者', 'ref', 'own')
  assert.throws(() => kb.tx((tx) => tx.setProp(defId, '_refTags', 'oops')), '标量不是合法形状')
  kb.tx((tx) => tx.setProp(defId, '_refTags', ['t1']))
  assert.deepEqual(refTagIds(kb.get(defId)), ['t1'], '合法形状照写')
})

/* ------------------------------------------------------------ 2. 候选集 */

test('候选集：直接成员 ＋ 下级标签闭包（#人物 的候选含只打 #演员 的块）', () => {
  const { forest, def, a, b, c } = scene()
  withTags(def, ['people'])
  const scope = refTargetScope(def, forest)
  assert.ok(scope !== null)
  assert.ok(scope.has(a.id), '闭包：只打了下级标签 #演员 的块也是候选')
  assert.ok(scope.has(b.id), '直接打 #人物 的块是候选')
  assert.ok(!scope.has(c.id), '没打标签的块不是候选')
  assert.ok(!scope.has('people'), '标签块自己不是「打了这个标签的块」')
})

test('候选集：多个标签取并集；约束里部分悬空时只算在世的那几个', () => {
  const { forest, def, a, b } = scene()
  withTags(def, ['actor', 'gone'])
  const onlyActor = refTargetScope(def, forest)
  assert.deepEqual([...(onlyActor ?? [])].sort(), [a.id], '演员甲在，#人物 的成员不因 actor 混进来')

  withTags(def, ['actor', 'people'])
  const both = refTargetScope(def, forest)
  assert.deepEqual([...(both ?? [])].sort(), [a.id, b.id].sort(), '两个标签并集')
})

test('候选集三态：无约束=null、有候选=非空、有约束但没人=空集（不是 null）', () => {
  const { forest, def } = scene()
  assert.equal(refTargetScope(def, forest), null, '没写 _refTags ⇒ 不限制')

  const empty = tag('empty', '空标签')
  forest.push(empty)
  withTags(def, ['empty'])
  const scope = refTargetScope(def, forest)
  assert.ok(scope !== null && scope.size === 0, '在世标签但没有成员 ⇒ 空集（诚实的「没有候选」）')

  withTags(def, ['gone'])
  assert.equal(refTargetScope(def, forest), null, '标签全没了 ⇒ 退回无约束（软约束：别让旧定义把值控件变死按钮）')

  withTags(def, ['page1'])
  forest.push(page('page1', '一个页'))
  assert.equal(refTargetScope(def, forest), null, '_refTags 指向的不是标签块 ⇒ 不构成约束')
})

test('候选集只读不写：算一遍候选不改任何块（约束是配置，不是派生缓存）', () => {
  const { forest, def } = scene()
  withTags(def, ['people'])
  const before = JSON.stringify(forest)
  refTargetScope(def, forest)
  assert.equal(JSON.stringify(forest), before)
})

test('选择器接着用：onlyIds 收窄候选，空集合真的给出空清单', () => {
  const { forest } = scene()
  const all = createNameChoice(forest, { kind: 'ref' })
  assert.ok(all.rows('').length >= 4, '无约束时全森林都在候选里')

  const narrowed = createNameChoice(forest, { kind: 'ref', onlyIds: new Set(['a']) })
  const ids = narrowed.rows('').map((r) => String(r.id).slice('ref/'.length))
  assert.deepEqual(ids, ['a'], '白名单只有 a')

  const none = createNameChoice(forest, { kind: 'ref', onlyIds: new Set<string>() })
  assert.deepEqual(none.rows(''), [], '空集合 ≠ 不限制：这里必须一行都没有')
})

test('候选标签名：给的是名字不是 id；悬空标签不念名字（念了也查不到）', () => {
  const { def } = scene()
  withTags(def, ['people', 'gone'])
  const names = refTagNames(def, (id) => (id === 'people' ? '人物' : ''))
  assert.deepEqual(names, ['人物'], '标题要念名字；悬空标签跳过')
})

/* ------------------------------------------------------------ 3. 写路径 */

test('setPropRefTags：写清单、去重、空数组摘键、非 ref 定义拒绝', () => {
  const { cmds, kb } = commandHarness()
  const refDef = cmds.createPropDef('', '作者', 'ref', 'own')
  const textDef = cmds.createPropDef('', '备注', 'text', 'own')

  cmds.setPropRefTags(refDef, ['people', 'actor', 'people'])
  assert.deepEqual(refTagIds(kb.get(refDef)), ['people', 'actor'], '重复的 id 只留一个')

  cmds.setPropRefTags(refDef, [])
  assert.equal('_refTags' in (kb.get(refDef)?.props ?? {}), false, '空清单＝摘键：「没有约束」与「约束是空集」是两件事')

  cmds.setPropRefTags(textDef, ['people'])
  assert.equal('_refTags' in (kb.get(textDef)?.props ?? {}), false, '非 ref 定义不写（写了也没人读）')
})

/* ------------------------------------------------------------ 4. 新建并引用 */

test('createPropRefTarget：建页落顶层 ＋ 写值同一笔；同名地址复用不建第二个', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '作者', 'ref', 'own')
  const host = plain('host', '一块')
  kb.tx((tx) => tx.insert(host, null, 1))

  const made = cmds.createPropRefTarget('host', defId, '张三')
  assert.notEqual(made, '', '建出来了')
  assert.equal(valueOf(kb.get('host')!, defId), made, '值指向新块')
  const created = kb.get(made)
  assert.ok(created, '新块在库里')
  assert.equal(kb.roots().at(-1)?.id, made, '落森林顶层末尾（页块的落点）')
  assert.ok((created?.props?._lists as string[]).includes('page'), '物化的是页块（`@` 建页的转世）')

  const again = cmds.createPropRefTarget('host', defId, '张三')
  assert.equal(again, made, '同名地址已有 ⇒ 复用，不建第二个同名块')
  assert.equal(kb.roots().filter((b) => b.id === made).length, 1)
})

test('createPropRefTarget：many 追加不覆盖，重复引用同一目标不堆两条', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '作者', 'ref', 'own')
  cmds.setChoiceCardinality(defId, 'many')
  assert.equal(cardinalityOf(kb.get(defId)!), 'many')
  const host = plain('host', '一块')
  kb.tx((tx) => tx.insert(host, null, 0))

  const one = cmds.createPropRefTarget('host', defId, '甲')
  const two = cmds.createPropRefTarget('host', defId, '乙')
  assert.deepEqual(valueOf(kb.get('host')!, defId), [one, two], '多值：追加')

  cmds.createPropRefTarget('host', defId, '甲')
  assert.deepEqual(valueOf(kb.get('host')!, defId), [one, two], '同一目标不重复堆（追加语义不是「加一条边」）')
})

test('createPropRefTarget：空名 / 非 ref 定义 / 块不在 ⇒ 一个字节都不写', () => {
  const { cmds, kb } = commandHarness()
  const refDef = cmds.createPropDef('', '作者', 'ref', 'own')
  const textDef = cmds.createPropDef('', '备注', 'text', 'own')
  const host = plain('host', '一块')
  kb.tx((tx) => tx.insert(host, null, 0))
  const rootsBefore = kb.roots().length

  assert.equal(cmds.createPropRefTarget('host', refDef, '  '), '', '空名不建页')
  assert.equal(cmds.createPropRefTarget('host', textDef, '张三'), '', '非 ref 属性没有「引用目标」')
  assert.equal(cmds.createPropRefTarget('nope', refDef, '张三'), '', '块不在')
  assert.equal(kb.roots().length, rootsBefore, '没有建出任何块')
})

/* ------------------------------------------------------------ 5. 软约束（判据） */

test('软约束：约束之外的块仍可写值，已有值照常显示（不校验存量值）', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '作者', 'ref', 'own')
  const host = plain('host', '一块')
  const outsider = plain('outsider', '约束外的人')
  const other = tag('other', '别的标签')
  kb.tx((tx) => {
    tx.insert(host, null, 0)
    tx.insert(outsider, null, 1)
    tx.insert(other, null, 2)
  })

  // 先有值，再收紧约束（顺序反过来也要成立）
  cmds.setPropValue('host', defId, outsider.id)
  cmds.setPropRefTags(defId, [other.id])

  assert.equal(valueOf(kb.get('host')!, defId), outsider.id, '约束变了，存量值一个字节不动')
  const row = fieldRows(kb.get('host')!, kb.roots()).find((r) => r.propId === defId)
  assert.equal(row?.value, outsider.id, '行派生照常给出值（显示层不按约束过滤）')

  // 约束在时写一个约束外的值：值层不拒（软约束的落点就是「不硬校验」）
  cmds.setPropValue('host', defId, 'another-outsider')
  assert.equal(valueOf(kb.get('host')!, defId), 'another-outsider')
  assert.equal(propKindOf(kb.get(defId)!), 'ref', 'kind 没被这条约束改过')
})

/* ------------------------------------------------------------ 6. 默认看法（_refView） */

test('看法：缺省 chip、非 ref 定义一律按缺省读、def 不在场不炸、坏值回落', () => {
  const { cmds, kb } = commandHarness()
  const refDef = cmds.createPropDef('', '作者', 'ref', 'own')
  const textDef = cmds.createPropDef('', '备注', 'text', 'own')

  assert.equal(refViewOf(kb.get(refDef)!), 'chip', '没写过就是 chip（缺省不落盘）')
  assert.equal(refViewOf(kb.get(textDef)!), 'chip', '非 ref 定义没有看法槽，一律 chip')
  assert.equal(refViewOf(undefined), 'chip', 'def 不在场也按缺省（读路径不炸）')

  // 手写坏值：tx 发看点会拒（「invalid value for system prop」），所以坏值只能
  // 从冷启动读盘/遗留库来 —— 读判据直接对对象断言，不走 tx。
  const broken = mkPropDef('坏数据', 'ref')
  broken.id = 'broken'
  broken.props = { _refView: 'sidebar' }
  assert.equal(refViewOf(broken), 'chip', '坏值回落 chip')
})

test('看法：命令写 inline、切回 chip 摘键（缺省态不落空壳）、非法值与非 ref 定义拒绝', () => {
  const { cmds, kb } = commandHarness()
  const refDef = cmds.createPropDef('', '作者', 'ref', 'own')
  const textDef = cmds.createPropDef('', '备注', 'text', 'own')

  cmds.setPropRefView(refDef, 'inline')
  assert.equal(refViewOf(kb.get(refDef)!), 'inline', '显式打开才付岛的账')

  cmds.setPropRefView(refDef, 'chip')
  assert.equal(refViewOf(kb.get(refDef)!), 'chip', '显式回落')
  assert.equal(prop(kb.get(refDef)!, '_refView'), undefined, '缺省态不落盘（属性袋不留空壳）')

  cmds.setPropRefView(textDef, 'inline')
  assert.equal(refViewOf(kb.get(textDef)!), 'chip', '非 ref 定义拒绝写入')

  cmds.setPropRefView(refDef, 'diagonal')
  assert.equal(refViewOf(kb.get(refDef)!), 'chip', '非法值拒绝写入')

  assert.equal(isRefViewValue('inline'), true)
  assert.equal(isRefViewValue('diagonal'), false)
})
