/**
 * **`ref` 的候选域（`_refDomain`）**：值层不变，候选面按域收窄。
 *
 * 验收口径（为什么这些断言长这样）：
 *   · **软约束** —— 只过滤候选，不校验存量值。域改了／标签删了／查询变了，
 *     已引用的块照常显示；写路径一条都不许拿域拒写。
 *   · **一根轴四档** —— 不限（键缺席）／标签成员（含下级标签闭包）／锚块子树／查询结果。
 *   · **三种答案分开** —— 无约束（`null`）／有候选（非空集）／有约束但没人（空集）。
 *   · **悬空退回不限**，并且**说出来**（`dangling`）——同一格换个档位不该变成另一种失败态。
 *   · **锚块档是查询的预设，不是第二份语义**：`{up:{is}}` 由一个求值器算，用相等断言钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block, QuerySpec } from '../src/core/index.ts'
import {
  appendEdge,
  cardinalityOf,
  fieldRows,
  isRefDomainValue,
  mkPropDef,
  mkTagBlock,
  propKindOf,
  refDomainIds,
  refDomainOf,
  refTagIds,
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

/** 一个查询块：`_query` 是合法条件就是查询块（判据与视图读侧同一份） */
function queryBlock(id: string, name: string, spec: QuerySpec): Block {
  const b = plain(id, name)
  b.props = { ...(b.props ?? {}), _query: spec }
  return b
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
 * 丙谁都没打。定义块 `def`（引用）在顶层。页 `p1` 下有子块 `p1a`。
 */
function scene(): {
  forest: Block[]
  def: Block
  people: Block
  actor: Block
  a: Block
  b: Block
  c: Block
  p1: Block
  p1a: Block
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
  const p1 = page('p1', '项目 A')
  const p1a = plain('p1a', '项目 A 的子块')
  p1.children = [p1a]
  return { forest: [def, people, actor, a, b, c, p1], def, people, actor, a, b, c, p1, p1a }
}

/** 一台库（读面：get／roots／query），与装配层交给求解器的那个形状一致 */
const kbOf = (forest: readonly Block[]): MemoryKb => new MemoryKb(new BlockStore([...forest]))

const withDomain = (def: Block, domain: unknown): Block => {
  def.props = { ...(def.props ?? {}), _refDomain: domain }
  return def
}

/* ------------------------------------------------------------ 1. 形状判据 */

test('_refDomain 形状：三成员合法、空 tags 非法、坏形状读成不限', () => {
  assert.equal(isRefDomainValue({ kind: 'tags', ids: ['t'] }), true)
  assert.equal(isRefDomainValue({ kind: 'block', id: 'b1' }), true)
  assert.equal(isRefDomainValue({ kind: 'query', id: 'q1' }), true)
  assert.equal(isRefDomainValue({ kind: 'tags', ids: [] }), false, '空数组≠「限定标签」：写侧摘键表达不限')
  assert.equal(isRefDomainValue({ kind: 'block', id: '' }), false)
  assert.equal(isRefDomainValue({ kind: 'nope', id: 'x' }), false)
  assert.equal(isRefDomainValue(null), false)
  assert.equal(isRefDomainValue(['a']), false)

  const { def } = scene()
  assert.equal(refDomainOf(def), undefined, '没写过这一格')
  withDomain(def, 'oops')
  assert.equal(refDomainOf(def), undefined, '坏形状 ⇒ 不限（不崩、不猜）')
  withDomain(def, { kind: 'block', id: 'p1' })
  assert.deepEqual(refDomainOf(def), { kind: 'block', id: 'p1' })
})

test('旧形状兼容：_refTags 非空数组当标签档；与 _refDomain 同时在场时前者让位', () => {
  const { def } = scene()
  def.props = { ...(def.props ?? {}), _refTags: ['people'] }
  assert.deepEqual(refDomainOf(def), { kind: 'tags', ids: ['people'] }, '旧库读侧翻译成标签档')

  withDomain(def, { kind: 'block', id: 'p1' })
  assert.deepEqual(refDomainOf(def), { kind: 'block', id: 'p1' }, '两个键都在场：_refDomain 赢')

  def.props = { ...(def.props ?? {}), _refTags: [] }
  delete def.props._refDomain
  assert.equal(refDomainOf(def), undefined, '空数组＝没有约束')
})

test('_refDomain 是登记过的系统键：坏形状在 op 产出点就被拒（不进内存、不进日志）', () => {
  const h = commandHarness()
  const defId = h.cmds.createPropDef('', '作者', 'ref', 'own')
  assert.throws(() => h.kb.tx((tx) => tx.setProp(defId, '_refDomain', { kind: 'tags', ids: [] })), '空 tags 非法')
  assert.throws(() => h.kb.tx((tx) => tx.setProp(defId, '_refDomain', 'oops')), '标量非法')
  h.kb.tx((tx) => tx.setProp(defId, '_refDomain', { kind: 'query', id: 'q1' }))
  assert.deepEqual(refDomainOf(h.kb.get(defId)), { kind: 'query', id: 'q1' }, '合法形状照写')
})

/* ------------------------------------------------------------ 2. 标签档 */

test('标签档：直接成员 ＋ 下级标签闭包（#人物 的候选含只打 #演员 的块）', () => {
  const { forest, def, a, b, c } = scene()
  withDomain(def, { kind: 'tags', ids: ['people'] })
  const r = refDomainIds(def, kbOf(forest))
  assert.equal(r.mode, 'tags')
  assert.ok(r.ids !== null)
  assert.ok(r.ids.has(a.id), '闭包：只打了下级标签 #演员 的块也是候选')
  assert.ok(r.ids.has(b.id), '直接打 #人物 的块是候选')
  assert.ok(!r.ids.has(c.id), '没打标签的块不是候选')
  assert.ok(!r.ids.has('people'), '标签块自己不是「打了这个标签的块」')
  assert.equal(r.dangling, null)
})

test('标签档：多个标签取并集；约束里部分悬空时只算在世的那几个', () => {
  const { forest, def, a, b } = scene()
  withDomain(def, { kind: 'tags', ids: ['actor', 'gone'] })
  const onlyActor = refDomainIds(def, kbOf(forest))
  assert.deepEqual([...(onlyActor.ids ?? [])].sort(), [a.id])

  withDomain(def, { kind: 'tags', ids: ['actor', 'people'] })
  const both = refDomainIds(def, kbOf(forest))
  assert.deepEqual([...(both.ids ?? [])].sort(), [a.id, b.id].sort(), '两个标签并集')
})

test('标签档三态：无约束=null、有候选=非空、有约束但没人=空集（不是 null）', () => {
  const { forest, def } = scene()
  assert.equal(refDomainIds(def, kbOf(forest)).ids, null, '没写域 ⇒ 不限制')

  forest.push(tag('empty', '空标签'))
  withDomain(def, { kind: 'tags', ids: ['empty'] })
  const empty = refDomainIds(def, kbOf(forest))
  assert.ok(empty.ids !== null && empty.ids.size === 0, '在世标签但没有成员 ⇒ 空集（诚实的「没有候选」）')

  withDomain(def, { kind: 'tags', ids: ['gone'] })
  assert.equal(refDomainIds(def, kbOf(forest)).ids, null, '标签全没了 ⇒ 退回不限（别让旧定义把值控件变死按钮）')

  forest.push(page('page1', '一个页'))
  withDomain(def, { kind: 'tags', ids: ['page1'] })
  assert.equal(refDomainIds(def, kbOf(forest)).ids, null, '域里的 id 不是标签块 ⇒ 不构成约束')
})

/* ------------------------------------------------------------ 3. 锚块档 */

test('锚块档：候选＝这个块下面的块（不含锚块自己）', () => {
  const { forest, def, p1, p1a } = scene()
  withDomain(def, { kind: 'block', id: p1.id })
  const r = refDomainIds(def, kbOf(forest))
  assert.equal(r.mode, 'block')
  assert.deepEqual([...(r.ids ?? [])], [p1a.id], '子树里的块是候选；锚块自己不是')
  assert.equal(r.dangling, null)
})

test('锚块档 $self：每一处引用按自己的宿主算；没有宿主时是空集（不退回全库）', () => {
  const { forest, def, p1, p1a } = scene()
  withDomain(def, { kind: 'block', id: '$self' })

  const atP1 = refDomainIds(def, kbOf(forest), p1.id)
  assert.deepEqual([...(atP1.ids ?? [])], [p1a.id], '$self＝值所在块：项目 A 下只有 p1a')
  assert.equal(atP1.label?.kind === 'block' && atP1.label.self, true, '抬头要能说「这一块」')

  const noHost = refDomainIds(def, kbOf(forest))
  assert.ok(noHost.ids !== null && noHost.ids.size === 0, '没有宿主 ⇒ 空集（同 runQuery 对 $self 的口径）')
})

test('锚块档悬空：锚块不在世 ⇒ 退回不限，并把失效说出来', () => {
  const { forest, def } = scene()
  withDomain(def, { kind: 'block', id: 'gone' })
  const r = refDomainIds(def, kbOf(forest))
  assert.equal(r.ids, null, '退回不限')
  assert.equal(r.dangling, 'block', '失效必须能被界面念出来')
})

test('锚块档 ≡ 查询档的 {up:{is}}（相等断言：锚块是预设，不是第二份语义）', () => {
  const { forest, def, p1, p1a } = scene()
  const qb = queryBlock('q1', '项目 A 下', { where: { up: { is: p1.id } } })
  const world = [...forest, qb]
  const src = kbOf(world)

  withDomain(def, { kind: 'block', id: p1.id })
  const byAnchor = refDomainIds(def, src)
  withDomain(def, { kind: 'query', id: qb.id })
  const byQuery = refDomainIds(def, src)
  assert.deepEqual([...(byAnchor.ids ?? [])].sort(), [...(byQuery.ids ?? [])].sort(), '两条写法同解')
  assert.deepEqual([...(byAnchor.ids ?? [])], [p1a.id])
})

/* ------------------------------------------------------------ 4. 查询档 */

test('查询档：候选＝查询块此刻的结果；$self 按宿主解析、宿主自己不在结果里', () => {
  const { forest, def, p1, p1a } = scene()
  const qb = queryBlock('q1', '本块下的块', { where: { up: { is: '$self' } } })
  const src = kbOf([...forest, qb])

  withDomain(def, { kind: 'query', id: qb.id })
  const r = refDomainIds(def, src, p1.id)
  assert.equal(r.mode, 'query')
  assert.deepEqual([...(r.ids ?? [])], [p1a.id], '$self＝值所在块')

  const noHost = refDomainIds(def, src)
  assert.ok(noHost.ids !== null && noHost.ids.size === 0, '没有宿主 ⇒ 空集（条件解析不了，不退回全库）')
})

test('查询档悬空：查询块删了 / 那个块不是查询块 ⇒ 退回不限并说出来', () => {
  const { forest, def, a } = scene()
  withDomain(def, { kind: 'query', id: 'gone' })
  const gone = refDomainIds(def, kbOf(forest))
  assert.equal(gone.ids, null)
  assert.equal(gone.dangling, 'query')

  withDomain(def, { kind: 'query', id: a.id })
  const notQuery = refDomainIds(def, kbOf(forest))
  assert.equal(notQuery.ids, null, '不是查询块 ⇒ 不构成约束')
  assert.equal(notQuery.dangling, 'query')
})

/* ------------------------------------------------------------ 5. 只读 ＋ 选择器 */

test('候选集只读不写：算一遍候选不改任何块（域是配置，不是派生缓存）', () => {
  const { forest, def, p1 } = scene()
  withDomain(def, { kind: 'block', id: p1.id })
  const src = kbOf(forest)
  const before = JSON.stringify(src.roots())
  refDomainIds(def, src)
  assert.equal(JSON.stringify(src.roots()), before)
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

/* ------------------------------------------------------------ 6. 写路径 */

test('setPropRefDomain：三档都写进同一个槽；标签去重；null 摘键；非 ref 定义拒绝', () => {
  const { cmds, kb } = commandHarness()
  const refDef = cmds.createPropDef('', '作者', 'ref', 'own')
  const textDef = cmds.createPropDef('', '备注', 'text', 'own')

  cmds.setPropRefDomain(refDef, { kind: 'tags', ids: ['people', 'actor', 'people'] })
  assert.deepEqual(refDomainOf(kb.get(refDef)), { kind: 'tags', ids: ['people', 'actor'] }, '重复的 id 只留一个')

  cmds.setPropRefDomain(refDef, { kind: 'block', id: 'p1' })
  assert.deepEqual(refDomainOf(kb.get(refDef)), { kind: 'block', id: 'p1' }, '换档＝换同一个槽')

  cmds.setPropRefDomain(refDef, { kind: 'query', id: 'q1' })
  assert.deepEqual(refDomainOf(kb.get(refDef)), { kind: 'query', id: 'q1' })

  cmds.setPropRefDomain(refDef, null)
  assert.equal('_refDomain' in (kb.get(refDef)?.props ?? {}), false, 'null＝摘键（不限）')

  cmds.setPropRefDomain(refDef, { kind: 'tags', ids: [] })
  assert.equal('_refDomain' in (kb.get(refDef)?.props ?? {}), false, '空 tags 不落盘')

  cmds.setPropRefDomain(textDef, { kind: 'block', id: 'p1' })
  assert.equal('_refDomain' in (kb.get(textDef)?.props ?? {}), false, '非 ref 定义不写（写了也没人读）')
})

test('setPropRefDomain：首次写域时把旧形状 _refTags 清掉（一槽一真值）', () => {
  const { cmds, kb } = commandHarness()
  const defId = cmds.createPropDef('', '作者', 'ref', 'own')
  kb.tx((tx) => tx.setProp(defId, '_refTags', ['people']))

  cmds.setPropRefDomain(defId, { kind: 'block', id: 'p1' })
  assert.equal('_refTags' in (kb.get(defId)?.props ?? {}), false, '旧键不留在库里（否则摘掉域它会复活）')
  assert.deepEqual(refDomainOf(kb.get(defId)), { kind: 'block', id: 'p1' })

  assert.deepEqual(refTagIds(kb.get(defId)), [], '旧读法读到空')
})

/* ------------------------------------------------------------ 7. 新建并引用 */

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

/* ------------------------------------------------------------ 8. 软约束（判据） */

test('软约束：域之外的块仍可写值，已有值照常显示（不校验存量值）', () => {
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
  cmds.setPropRefDomain(defId, { kind: 'tags', ids: [other.id] })

  assert.equal(valueOf(kb.get('host')!, defId), outsider.id, '域变了，存量值一个字节不动')
  const row = fieldRows(kb.get('host')!, kb.roots()).find((r) => r.propId === defId)
  assert.equal(row?.value, outsider.id, '行派生照常给出值（显示层不按域过滤）')

  // 域在时写一个域外的值：值层不拒（软约束的落点就是「不硬校验」）
  cmds.setPropValue('host', defId, 'another-outsider')
  assert.equal(valueOf(kb.get('host')!, defId), 'another-outsider')
  assert.equal(propKindOf(kb.get(defId)!), 'ref', 'kind 没被这条约束改过')
})
