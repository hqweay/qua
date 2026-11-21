/**
 * **触发器统一的等式测试**：触发器从三种硬编码 kind 换成「查询 × 迁移」统一形状时，
 * 行为契约逐条钉在这里——统一引擎落地后同一批断言改用统一形状表达，
 * 除有记号的「有意变更」外必须逐字节等价。改动语义而不改这里的断言＝白改。
 *
 * ## 断言清单（spec→test 追溯；「v1」＝三种 kind 的现行引擎）
 *
 * 1. `prop(P,to=v)`：已有块 P→v 开火；P→其他值不开火；同值写不开火；创建即 P=v——
 *    v1 不开火，统一后开火【有意变更①，显式断言】
 * 2. `prop(P)`（任意变化）≡ `changed({has P})`：值变开火（含置空）；同值写不开火；创建不开火（等价点）
 * 3. `tag(T,added/removed)` ≡ `entered/left({tag T})`：边沿开火；创建即带标签——v1 不开火，
 *    统一后开火【有意变更①】；块删除不触发（原子没变）
 * 4. `child.added(父条件)` ≡ `entered({up:父条件}, birth)`：仅诞生开火；移动已有块进匹配父级不开火；
 *    `followRefs=true` 的传递引用父匹配必须等价；无父条件的 `child.added()`＝任意父块诞生开火
 * 5. when 时态：一律对 after 求值（统一形状的 `left`＋`when` 永不开火边界随 left 落地时补断言）
 * 6. 去重与序：同 tx 同规则同目标一次（两支触发器同时命中也只跑一次）；规则按森林先序——
 *    两条规则写同一格，后写的赢、结果确定
 * 7. 事务语义：规则写入并入触发事务（同一批 op、一次撤销全退）；预检失败跳过该反应、用户写照常提交
 * 8. 重放／撤销不触发：撤销走 `store.undo`→`applyOps`，重放与同步同样不经过 reactor
 * 9. 形状闸（v1：`isAutomationDef` 拒未知 kind → 读不出定义 → 投影 broken）；
 *    统一形状的 TriggerQuery 校验器（叶子白名单／up 位置约束／含 up 强制诞生／≥1 原子／
 *    birth 仅限 entered）随校验器落地补进本文件
 * 10. 生命周期：纯删除／纯恢复静默（exist 不是查询原子，原子没变即静默）；恢复＋同笔修改按
 *     真实原子判定；**删除＋同笔修改：v1 开火并把反应写进死目标【有意变更②：统一后预检跳过】**
 * 11. present 守卫：写入对象（显式目标／insert 父／move 源与目的地父／add-tag 的标签）必须 present、
 *     remove-tag 允许已删标签（有意清理路径）。v1 实测（本文件钉住）：**跨笔**已删一律已拒
 *     （索引在删除时把块摘出可见表，`kb.get` 天然滤掉）；**同笔窗口**放行（索引在事务出口才修补，
 *     反应期间查得到刚删的块）——同笔窗口由统一 present 守卫翻转（显式判删除标记）【有意变更③】
 * 12. 规则块边界：set/clear 拒 `_automation` 与一切 `_` 槽；insert-child 造普通块；
 *     move 拒搬规则块；规则块的普通属性与标签可写（它仍是普通用户块）
 *
 * ## v1 行为账（探针实测过的事实，勿凭印象改断言）
 *
 * - 「删除＋同笔修改」v1 **不是**失败路径：reactor 跑在索引修补之前，反应里的读检查全部通过，
 *   写入成功落进死目标。统一引擎的「after 已删 ⇒ 跳过」改掉的是这个。
 * - 「add-tag 已删标签」跨笔已被拒——「kb.get 不滤软删」的旧说法与现状不符：过滤发生在
 *   索引可见性（删除时摘表），不在 get 的字面代码里；真缺口只剩同笔窗口。
 * - 撤销把规则写入一并退掉且不重触发：撤销条目含 touched 全部块（含规则写的）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAutomationBlock, mkBlock, mkPropDef, type Block } from '../src/core/index.ts'
import { walkForest } from '../src/core/model/walk.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { hasTag } from '../src/core/identity/tags.ts'
import {
  mkAutomationBlock,
  readAutomation,
  type AutomationDef,
} from '../src/core/automation/automation.ts'
import { createAutomationEngine } from '../src/core/automation/engine.ts'
import { runAutomationSteps } from '../src/core/automation/run.ts'
import { projectManualAutomations } from '../src/core/automation/projection.ts'

/* ------------------------------------------------------------ 夹具 */

function fixture(blocks: Block[]): { kb: MemoryKb; store: BlockStore } {
  const store = new BlockStore(blocks)
  const kb = new MemoryKb(store, { now: () => 1000 })
  return { kb, store }
}

function engineFixture(blocks: Block[]): {
  kb: MemoryKb
  store: BlockStore
  events: { ruleId: string; targetId: string; error: unknown }[]
} {
  const { kb, store } = fixture(blocks)
  const events: { ruleId: string; targetId: string; error: unknown }[] = []
  const engine = createAutomationEngine({ kb, lookup: kb, onError: (info) => events.push(info) })
  kb.setReactor((ctx) => engine.react(ctx))
  return { kb, store, events }
}

function mkTag(name: string): Block {
  const t = mkBlock(name)
  t.props = { _aliases: [name], _lists: ['tag'] }
  return t
}

function selectDefWithChoices(): Block {
  const state = mkPropDef('状态', 'select')
  state.props = { ...state.props, _choices: [{ id: 'c-done', label: '完成' }, { id: 'c-doing', label: '进行中' }] }
  return state
}

/** 含被删块的遍历找块（`kb.get` 看不见软删的块——恢复路径与断言用） */
function findIncludingDeleted(kb: MemoryKb, id: string): Block | undefined {
  let hit: Block | undefined
  walkForest(
    kb.roots(),
    (b) => {
      if (b.id === id) {
        hit = b
        return false
      }
    },
    { includeDeleted: true },
  )
  return hit
}

/** 事件链规则的最小形状：一支触发器 ＋ 一个 insert-child（跑没跑数子块） */
function birthRule(trigger: AutomationDef['triggers'][number]): AutomationDef {
  return {
    enabled: true,
    triggers: [trigger],
    steps: [{ cmd: 'core.tree/insert-child', args: { text: '反应' } }],
  }
}

/** 目标块的反应子块数（insert-child 每跑一次多一个；吃块对象——软删的块 `kb.get` 看不见） */
function reactionCount(target: Block): number {
  return target.children.filter((c) => c.children.length === 0 && c.content.some((r) => 'v' in r && r.v === '反应')).length
}

/* ------------------------------------------------------------ 等式①：prop(P, to=v) */

test('等式①：已有块 P→v 开火；P→其他值不开火；同值写不开火', () => {
  const state = selectDefWithChoices()
  const target = mkBlock('一块任务')
  const rule = mkAutomationBlock({
    name: '状态变完成就数一次',
    def: birthRule({ kind: 'prop', prop: state.id, to: 'c-done' }),
  })
  const { kb } = engineFixture([state, target, rule])

  kb.tx((tx) => tx.setProp(target.id, state.id, 'c-doing'))
  assert.equal(reactionCount(target), 0, 'to 之外的值不开火')

  kb.tx((tx) => tx.setProp(target.id, state.id, 'c-doing'))
  assert.equal(reactionCount(target), 0, '同值写：值没真变不算变化')

  kb.tx((tx) => tx.setProp(target.id, state.id, 'c-done'))
  assert.equal(reactionCount(target), 1, 'P→v 开火一次')
})

test('等式①【有意变更①】：创建即 P=v——v1 不开火（统一后 entered 对出生即满足开火）', () => {
  const state = selectDefWithChoices()
  const rule = mkAutomationBlock({ name: '规则', def: birthRule({ kind: 'prop', prop: state.id, to: 'c-done' }) })
  const { kb } = engineFixture([state, rule])

  const fresh = mkBlock('出生即完成')
  fresh.props = { [state.id]: 'c-done' }
  kb.tx((tx) => tx.insert(fresh, null, 0))
  assert.equal(reactionCount(fresh), 0, 'v1：before===null 跳过；统一后此断言翻转为 1（已拍板）')
})

/* ------------------------------------------------------------ 等式②：prop(P) ≡ changed({has P}) */

test('等式②：值变开火（含置空）；同值写不开火；创建不开火（与 changed({has P}) 的等价点）', () => {
  const numDef = mkPropDef('数量', 'number')
  const fresh = mkBlock('目标')
  const rule = mkAutomationBlock({ name: '数量动一次数一次', def: birthRule({ kind: 'prop', prop: numDef.id }) })
  const { kb } = engineFixture([numDef, fresh, rule])

  // 创建即带值：不开火（changed 在诞生侧天然不满足——before 侧查不为真）
  fresh.props = { [numDef.id]: 1 }
  kb.tx((tx) => tx.insert(fresh, null, 0))
  assert.equal(reactionCount(fresh), 0, '创建不开火')

  kb.tx((tx) => tx.setProp(fresh.id, numDef.id, 2))
  assert.equal(reactionCount(fresh), 1, '值变开火')

  kb.tx((tx) => tx.setProp(fresh.id, numDef.id, 2))
  assert.equal(reactionCount(fresh), 1, '同值写不开火')

  kb.tx((tx) => tx.clearProp(fresh.id, numDef.id))
  assert.equal(reactionCount(fresh), 2, '置空也是值变（统一后由 left({has P}) 这条腿开火，去重后同 tx 一次）')
})

/* ------------------------------------------------------------ 等式③：tag(T, added/removed) */

test('等式③：added／removed 各自的边沿开火', () => {
  const t = mkTag('归档')
  const target = mkBlock('任务')
  const rule = mkAutomationBlock({ name: '打上归档数一次', def: birthRule({ kind: 'tag', tag: t.id, on: 'added' }) })
  const { kb } = engineFixture([t, target, rule])

  kb.tx((tx) => tx.setTags(target.id, [t.id]))
  assert.equal(reactionCount(target), 1, 'added 边沿：没有→有')
  kb.tx((tx) => tx.setTags(target.id, []))
  assert.equal(reactionCount(target), 1, '摘掉不触发 added')
  kb.tx((tx) => tx.setTags(target.id, [t.id]))
  assert.equal(reactionCount(target), 2, '再次打上再开火（边沿，不是电平）')

  const target2 = mkBlock('另一块')
  const rule2 = mkAutomationBlock({ name: '摘掉归档数一次', def: birthRule({ kind: 'tag', tag: t.id, on: 'removed' }) })
  const { kb: kb2 } = engineFixture([t, target2, rule2])
  kb2.tx((tx) => tx.setTags(target2.id, [t.id]))
  assert.equal(reactionCount(target2), 0, '打上不触发 removed')
  kb2.tx((tx) => tx.setTags(target2.id, []))
  assert.equal(reactionCount(target2), 1, 'removed 边沿：有→没有')
})

test('等式③【有意变更①】＋删除不触发：创建即带标签——v1 不开火；块软删（原子没变）不触发', () => {
  const t = mkTag('归档')
  const rule = mkAutomationBlock({ name: '规则', def: birthRule({ kind: 'tag', tag: t.id, on: 'added' }) })
  const { kb } = engineFixture([t, rule])

  const fresh = mkBlock('出生即带标签')
  fresh.props = { _tags: [t.id] }
  kb.tx((tx) => tx.insert(fresh, null, 0))
  assert.equal(reactionCount(fresh), 0, 'v1：创建不开火；统一后此断言翻转为 1（已拍板）')

  // 软删：_tags 原子没变 ⇒ removed 边沿不成立、added 也不成立
  const holder = mkBlock('带标签的块')
  holder.props = { _tags: [t.id] }
  const ruleRemoved = mkAutomationBlock({ name: '摘掉规则', def: birthRule({ kind: 'tag', tag: t.id, on: 'removed' }) })
  const { kb: kb2 } = engineFixture([t, holder, ruleRemoved])
  kb2.tx((tx) => tx.remove(holder.id))
  assert.equal(reactionCount(holder), 0, '块删除不触发（exist 不是查询原子）')
})

/* ------------------------------------------------------------ 等式④：child.added ≡ entered({up:父条件}, birth) */

test('等式④：仅诞生开火——匹配父块下新建开火；移动已有块进匹配父级不开火', () => {
  const parentA = mkBlock('块A')
  const other = mkBlock('别的页')
  other.props = { _lists: ['page'] }
  const aiTag = mkTag('AI')
  const rule = mkAutomationBlock({
    name: 'A 下新建就打 AI',
    def: {
      enabled: true,
      triggers: [{ kind: 'child.added', parent: { is: parentA.id } }],
      steps: [{ cmd: 'core.tags/add', args: { tagId: aiTag.id } }],
    },
  })
  const { kb } = engineFixture([parentA, other, aiTag, rule])

  const fresh = mkBlock('新子块')
  kb.tx((tx) => tx.insert(fresh, parentA.id, Number.MAX_SAFE_INTEGER))
  assert.equal(hasTag(kb.get(fresh.id)!, aiTag.id), true, '匹配父块下诞生：开火')

  const stray = mkBlock('别处的新块')
  kb.tx((tx) => tx.insert(stray, other.id, Number.MAX_SAFE_INTEGER))
  assert.equal(hasTag(kb.get(stray.id)!, aiTag.id), false, '不匹配父块下诞生：不开火')

  kb.tx((tx) => tx.move(stray.id, parentA.id, Number.MAX_SAFE_INTEGER))
  assert.equal(hasTag(kb.get(stray.id)!, aiTag.id), false, '移动已有块进匹配父级：不开火（移入不立项，统一后 birth 语义严格对齐）')
})

test('等式④补：followRefs=true 沿传递型引用展开（等价点）；无父条件＝任意父块诞生开火', () => {
  const aiTag = mkTag('AI')
  const realParent = mkBlock('真父块')
  const passThrough = mkBlock('')
  passThrough.content = [{ id: 'ref-1', t: 'ref', to: realParent.id }] as typeof passThrough.content
  const rule = mkAutomationBlock({
    name: '沿引用打标',
    def: {
      enabled: true,
      triggers: [{ kind: 'child.added', parent: { is: realParent.id }, followRefs: true }],
      steps: [{ cmd: 'core.tags/add', args: { tagId: aiTag.id } }],
    },
  })
  const { kb } = engineFixture([aiTag, realParent, passThrough, rule])
  const fresh = mkBlock('透过引用进来的子块')
  kb.tx((tx) => tx.insert(fresh, passThrough.id, Number.MAX_SAFE_INTEGER))
  assert.equal(hasTag(kb.get(fresh.id)!, aiTag.id), true, 'followRefs=true：传递型引用的父匹配等价')

  const anyParent = mkBlock('任意父块')
  const rule2 = mkAutomationBlock({ name: '任意诞生打标', def: { enabled: true, triggers: [{ kind: 'child.added' }], steps: [{ cmd: 'core.tags/add', args: { tagId: aiTag.id } }] } })
  const { kb: kb2 } = engineFixture([anyParent, aiTag, rule2])
  const fresh2 = mkBlock('任意父块的子块')
  kb2.tx((tx) => tx.insert(fresh2, anyParent.id, Number.MAX_SAFE_INTEGER))
  assert.equal(hasTag(kb2.get(fresh2.id)!, aiTag.id), true, '无父条件：任意父块诞生开火（统一形状＝entered(Q, birth)，Q 由「如果」承载）')
})

/* ------------------------------------------------------------ 等式⑤：when 一律对 after 求值 */

test('等式⑤：when 对 after 求值——触发器命中但条件看的是刚写完的状态', () => {
  const flag = mkPropDef('开关', 'checkbox')
  const state = selectDefWithChoices()
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '开关翻转且状态是进行中才跑',
    def: {
      enabled: true,
      triggers: [{ kind: 'prop', prop: flag.id }],
      when: { prop: { id: state.id, eq: 'c-doing' } },
      steps: [{ cmd: 'core.tree/insert-child', args: { text: '反应' } }],
    },
  })
  const { kb } = engineFixture([flag, state, target, rule])

  kb.tx((tx) => {
    tx.setProp(target.id, flag.id, true)
    tx.setProp(target.id, state.id, 'c-doing')
  })
  assert.equal(reactionCount(target), 1, 'after 满足条件：开火')

  kb.tx((tx) => {
    tx.setProp(target.id, flag.id, false)
    tx.setProp(target.id, state.id, 'c-done')
  })
  assert.equal(reactionCount(target), 1, '触发器命中但 after 的条件不满足：不开火（若 when 看 before，这里会误开火）')
})

/* ------------------------------------------------------------ 等式⑥：去重与序 */

test('等式⑥：同 tx 同规则同目标一次——两支触发器同时命中也只跑一次', () => {
  const state = selectDefWithChoices()
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '双触发器规则',
    def: {
      enabled: true,
      // v1 的 to 槽只收 string/boolean（数字档的「等于某值」统一形状才表达得了）
      triggers: [{ kind: 'prop', prop: state.id }, { kind: 'prop', prop: state.id, to: 'c-done' }],
      steps: [{ cmd: 'core.tree/insert-child', args: { text: '反应' } }],
    },
  })
  const { kb } = engineFixture([state, target, rule])
  kb.tx((tx) => tx.setProp(target.id, state.id, 'c-done'))
  assert.equal(reactionCount(target), 1, '两支触发器都命中同一目标：去重后一次')
})

test('等式⑥补：规则按森林先序——两条规则写同一格，后写的赢、结果确定', () => {
  const numDef = mkPropDef('数量', 'number')
  const outDef = mkPropDef('出口', 'text')
  const target = mkBlock('目标')
  const first = mkAutomationBlock({
    name: '先写的规则',
    def: { enabled: true, triggers: [{ kind: 'prop', prop: numDef.id }], steps: [{ cmd: 'core.props/set-value', args: { propId: outDef.id, value: '先' } }] },
  })
  const second = mkAutomationBlock({
    name: '后写的规则',
    def: { enabled: true, triggers: [{ kind: 'prop', prop: numDef.id }], steps: [{ cmd: 'core.props/set-value', args: { propId: outDef.id, value: '后' } }] },
  })
  const { kb } = engineFixture([numDef, outDef, target, first, second])
  kb.tx((tx) => tx.setProp(target.id, numDef.id, 7))
  assert.equal(kb.get(target.id)?.props?.[outDef.id], '后', '森林先序：first 先写、second 后写 ⇒ 最终值确定（顺序换过来值就会反过来）')
})

/* ------------------------------------------------------------ 等式⑦：事务语义 */

test('等式⑦：规则写入并入触发事务——同一批 op、一次撤销全退', () => {
  const numDef = mkPropDef('数量', 'number')
  const doneTag = mkTag('已归档')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '数量变了就归档',
    def: { enabled: true, triggers: [{ kind: 'prop', prop: numDef.id }], steps: [{ cmd: 'core.tags/add', args: { tagId: doneTag.id } }] },
  })
  const { kb, store } = engineFixture([numDef, doneTag, target, rule])

  const r = kb.tx((tx) => tx.setProp(target.id, numDef.id, 7))
  assert.equal(hasTag(kb.get(target.id)!, doneTag.id), true, '规则写入生效')
  const ruleOps = r.ops.filter((o) => o.e === 'prop' && (o as { name?: string }).name === '_tags')
  assert.equal(ruleOps.length, 1, '规则的写与用户的写在同一批 op 里（同一次撤销）')

  store.record(r.undo, null, 'command', 2000)
  const undone = store.undo('test', null)
  assert.ok(undone)
  assert.equal(kb.get(target.id)?.props?.[numDef.id], undefined, '撤销：用户的写退掉')
  assert.equal(hasTag(kb.get(target.id)!, doneTag.id), false, '撤销：规则的写一并退掉（一次撤销全退）')
})

test('等式⑦补：预检失败跳过该反应，用户的写照常提交', () => {
  const numDef = mkPropDef('数量', 'number')
  const doneTag = mkTag('已归档')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '会失败的规则',
    def: {
      enabled: true,
      triggers: [{ kind: 'prop', prop: numDef.id }],
      steps: [{ cmd: 'core.props/set-value', args: { propId: numDef.id, value: '不是数字' } }, { cmd: 'core.tags/add', args: { tagId: doneTag.id } }],
    },
  })
  const { kb, events } = engineFixture([numDef, doneTag, target, rule])

  const r = kb.tx((tx) => tx.setProp(target.id, numDef.id, 7))
  assert.equal(kb.get(target.id)?.props?.[numDef.id], 7, '用户的写提交了')
  assert.equal(hasTag(kb.get(target.id)!, doneTag.id), false, '预检不过：整条反应跳过（第二步也不跑）')
  const ruleOps = r.ops.filter((o) => o.e === 'prop' && (o as { name?: string }).name === '_tags')
  assert.equal(ruleOps.length, 0, 'op 批里没有规则的写')
  assert.equal(events.length, 1, '失败落 onError')
})

/* ------------------------------------------------------------ 等式⑧：重放／撤销不触发 */

test('等式⑧：撤销不触发——撤销写入不经过 reactor（若触发，规则会把刚摘掉的标签再打上）', () => {
  const numDef = mkPropDef('数量', 'number')
  const doneTag = mkTag('已归档')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '数量变了就归档',
    def: { enabled: true, triggers: [{ kind: 'prop', prop: numDef.id }], steps: [{ cmd: 'core.tags/add', args: { tagId: doneTag.id } }] },
  })
  const { kb, store } = engineFixture([numDef, doneTag, target, rule])

  const r = kb.tx((tx) => tx.setProp(target.id, numDef.id, 7))
  assert.equal(hasTag(kb.get(target.id)!, doneTag.id), true)
  store.record(r.undo, null, 'command', 2000)
  store.undo('test', null)
  assert.equal(kb.get(target.id)?.props?.[numDef.id], undefined)
  assert.equal(hasTag(kb.get(target.id)!, doneTag.id), false, '撤销的反向原子变化（7→没有）没有再开火：重放／撤销路径不经过 reactor')
})

/* ------------------------------------------------------------ 等式⑨：形状闸（TriggerQuery 校验器随统一形状落地补进本文件） */

test('等式⑨：v1 形状闸——未知触发器 kind 拒形 → 读不出定义 → 投影 broken（灰态＋可跳转）', () => {
  const bad = mkBlock('坏规则')
  bad.props = { _automation: { enabled: true, triggers: [{ kind: 'timer' }], steps: [] } }
  assert.equal(readAutomation(bad), null, '未知 kind：读不出定义')

  const target = mkBlock('随便一块')
  const { kb } = fixture([target, bad])
  const rows = projectManualAutomations(kb, target.id)
  const row = rows.find((r) => r.id === `automation/${bad.id}`)
  assert.ok(row, '坏规则不静默消失')
  assert.equal(row!.runnable, false)
  assert.equal(row!.reason, 'broken', '灰态说明 broken')
})

/* ------------------------------------------------------------ 等式⑩：生命周期 */

test('等式⑩：纯删除／纯恢复静默；恢复＋同笔修改按真实原子判定', () => {
  const numDef = mkPropDef('数量', 'number')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({ name: '规则', def: birthRule({ kind: 'prop', prop: numDef.id }) })
  const { kb } = engineFixture([numDef, target, rule])

  kb.tx((tx) => tx.setProp(target.id, numDef.id, 1))
  assert.equal(reactionCount(target), 1, '基线：开火一次')

  kb.tx((tx) => tx.remove(target.id))
  assert.equal(reactionCount(target), 1, '纯删除：原子没变，静默')

  kb.tx((tx) => tx.restore(target.id))
  assert.equal(reactionCount(target), 1, '纯恢复：原子没变，静默（不重复执行非幂等动作）')

  kb.tx((tx) => {
    tx.remove(target.id)
    tx.restore(target.id)
    tx.setProp(target.id, numDef.id, 2)
  })
  assert.equal(reactionCount(target), 2, '恢复＋同笔修改：按真实 before/after 原子判定（快照不把 deleted 映射成不存在）')
})

test('等式⑩【有意变更②】：删除＋同笔修改——v1 开火并把反应写进死目标（统一后预检跳过）', () => {
  const numDef = mkPropDef('数量', 'number')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({ name: '规则', def: birthRule({ kind: 'prop', prop: numDef.id }) })
  const { kb, events } = engineFixture([numDef, target, rule])

  kb.tx((tx) => {
    tx.remove(target.id)
    tx.setProp(target.id, numDef.id, 2)
  })
  const dead = findIncludingDeleted(kb, target.id)!
  assert.equal(reactionCount(dead), 1, 'v1 现状：反应写进了已删的块（reactor 跑在索引修补之前，读检查全部通过）')
  assert.equal(events.length, 0, 'v1 连失败都不报——正是统一引擎「after 已删 ⇒ 跳过」要改掉的；U3 此断言翻转为 0 次反应')
})

/* ------------------------------------------------------------ 等式⑪：present 守卫 */

test('等式⑪：写入对象必须 present（跨笔）——显式目标／insert 父／move 源与目的地／add-tag 标签，已删即拒；remove-tag 允许已删标签', () => {
  const numDef = mkPropDef('数量', 'number')
  const victim = mkBlock('被删块')
  const parent = mkBlock('被删父块')
  const tag = mkTag('旧标签')
  const holder = mkBlock('带着旧标签的块')
  holder.props = { _tags: [tag.id] }
  const mover = mkBlock('要搬的块')
  const { kb } = fixture([numDef, victim, parent, tag, holder, mover])
  kb.tx((tx) => {
    tx.remove(victim.id)
    tx.remove(parent.id)
    tx.remove(tag.id)
  })

  const run = (step: AutomationStep, targetId: string = mover.id): unknown => {
    try {
      runAutomationSteps(kb, targetId, { enabled: true, triggers: ['manual'], steps: [step] })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }
  assert.match(String(run({ cmd: 'core.props/set-value', args: { propId: numDef.id, blockId: victim.id, value: 7 } })), /no such block/, '显式目标已删：拒')
  assert.match(String(run({ cmd: 'core.tree/insert-child', args: { parentId: victim.id, text: 'x' } })), /no such block/, 'insert 父已删：拒')
  assert.match(String(run({ cmd: 'core.tree/move', args: { blockId: mover.id, parentId: parent.id } })), /no such parent/, 'move 目的地父已删：拒')
  assert.match(String(run({ cmd: 'core.tags/add', args: { tagId: tag.id } })), /does not exist/, 'add-tag 标签已删（跨笔）：拒——现状已闭（索引删除即摘出可见表）')
  assert.equal(run({ cmd: 'core.tags/remove', args: { tagId: tag.id } }, holder.id), null, 'remove-tag 允许已删标签：清理旧引用是合法路径')
  assert.equal(kb.get(holder.id)?.props?._tags, undefined, '已删标签从归属里摘掉了')
})

test('等式⑪【有意变更③】：同笔窗口——同一笔 tx 删标签＋触发规则，add-tag 放行（统一 present 守卫翻转）', () => {
  const tag = mkTag('旧标签')
  const numDef = mkPropDef('数量', 'number')
  const victim = mkBlock('干净的块')
  const rule = mkAutomationBlock({
    name: '改属性就加旧标签',
    def: { enabled: true, triggers: [{ kind: 'prop', prop: numDef.id }], steps: [{ cmd: 'core.tags/add', args: { tagId: tag.id } }] },
  })
  const { kb, events } = engineFixture([tag, numDef, victim, rule])

  kb.tx((tx) => {
    tx.remove(tag.id)
    tx.setProp(victim.id, numDef.id, 7)
  })
  assert.deepEqual(kb.get(victim.id)?.props?._tags, [tag.id], 'v1 现状：反应期间索引还没修补，守卫查得到刚删的标签 ⇒ 写入通过')
  assert.equal(events.length, 0, '且不报失败——U6 统一守卫（显式判删除标记）后翻转为拒绝、_tags 不变')
})

/* ------------------------------------------------------------ 等式⑫：规则块边界 */

import type { AutomationStep } from '../src/core/automation/automation.ts'

test('等式⑫：规则块边界——set/clear 拒 _automation 与一切 _ 槽；insert-child 造普通块；move 拒搬规则块；规则块普通属性可写', () => {
  const numDef = mkPropDef('数量', 'number')
  const iconDef = mkPropDef('图标名', 'text')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({ name: '规则', def: { enabled: true, triggers: ['manual'], steps: [] } })
  const { kb } = fixture([numDef, iconDef, target, rule])

  const run = (step: AutomationStep, targetId: string = target.id): unknown => {
    try {
      runAutomationSteps(kb, targetId, { enabled: true, triggers: ['manual'], steps: [step] })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  assert.match(String(run({ cmd: 'core.props/set-value', args: { propId: '_automation', value: 'x' } })), /system slot/, 'set 不许碰 _automation（定义只能由显式编辑写）')
  assert.match(String(run({ cmd: 'core.props/clear-value', args: { propId: '_automation' } })), /system slot/, 'clear 同样过闸')
  assert.match(String(run({ cmd: 'core.props/set-value', args: { propId: '_icon', value: 'x' } })), /system slot/, '一切 _ 槽都不许（不止 _automation）')

  assert.equal(run({ cmd: 'core.tree/insert-child', args: { text: '规则造的子块' } }), null)
  const child = kb.get(target.id)!.children[0]!
  assert.equal(isAutomationBlock(child), false, 'insert-child 造的是普通块')
  assert.equal(child.props?._automation, undefined, '不产出自动化配置')

  assert.match(String(run({ cmd: 'core.tree/move', args: { blockId: rule.id, parentId: target.id } })), /identity block/, 'move 拒搬规则块（身份块住顶层）')

  assert.equal(run({ cmd: 'core.props/set-value', args: { propId: numDef.id, blockId: rule.id, value: 42 } }), null, '规则块的普通属性可写（它仍是普通用户块）')
  assert.equal(kb.get(rule.id)?.props?.[numDef.id], 42)
  assert.equal(run({ cmd: 'core.props/set-value', args: { propId: iconDef.id, blockId: rule.id, value: '名字' } }), null)
})
