/**
 * **统一触发器形状＋TriggerQuery 校验器＋依赖提取。**
 *
 * 这里钉三件事：
 *   · **形状**：`{on, query, birth?}` 是合法触发器（与三种过渡期 kind 并存，翻转在引擎切换
 *     那一笔——旧形状届时转 broken，本文件相应翻面）；
 *   · **校验器**（写侧）：作用域白名单两份＋up 位置约束＋`containsUp⇒birth` 强制＋
 *     birth 仅限 entered＋≥1 引用原子——每条拒形都对着它防的那个错；
 *   · **依赖提取**：self 层的 prop/tag 进静态依赖；up 子层是一次性判定，不进依赖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalAutomation, isAutomationDef, mkAutomationBlock, type AutomationDef } from '../src/core/automation/automation.ts'
import { triggerDeps, validateTriggerQuery } from '../src/core/automation/trigger-query.ts'
import { createAutomationEngine } from '../src/core/automation/engine.ts'
import { mkBlock, mkPropDef } from '../src/core/index.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { hasTag } from '../src/core/identity/tags.ts'

/* ------------------------------------------------------------ 形状 */

test('形状：{on, query, birth?} 是合法触发器——birth 可省、birth 只许 true、query 必须是 QueryNode', () => {
  const def = (triggers: unknown[]): AutomationDef => ({ enabled: true, triggers: triggers as AutomationDef['triggers'], steps: [] })
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { prop: { id: 'p1', exists: true } } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { prop: { id: 'p1', exists: true } }, birth: true }])), true)
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { up: { is: 'a1' } }, birth: true, followRefs: true }])), true, 'followRefs 只在打开了才算合法值')
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { up: { is: 'a1' } }, birth: true, followRefs: false }])), false, '显式 false 是第二种形状，拒（关＝删键）')
  assert.equal(isAutomationDef(def([{ on: 'left', query: { tag: 't1' } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'changed', query: { prop: { id: 'p1', exists: true } } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'frobnicate', query: { tag: 't1' } }])), false, '未知事件轴拒绝')
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { nonsense: true } }])), false, 'query 必须是 QueryNode')
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { tag: 't1' }, birth: false }])), false, 'birth 缺省＝不带；显式 false 是第二种形状，拒')
  // 旧三种 kind 不是合法形状：读不出定义 ⇒ broken 灰态（无兼容分支）
  assert.equal(isAutomationDef(def([{ kind: 'prop', prop: 'p1' }])), false)
  assert.equal(isAutomationDef(def([{ kind: 'tag', tag: 't1', on: 'added' }])), false)
  assert.equal(isAutomationDef(def([{ kind: 'child.added', parent: { is: 'a1' } }])), false)
})

test('canonicalAutomation：统一形状键序固定（on/query/birth）、query 走 canonicalNode、birth 缺省不落键', () => {
  const a = canonicalAutomation({
    enabled: true,
    steps: [],
    triggers: [{ query: { tag: 't1' }, on: 'entered', birth: true }],
  } as AutomationDef)
  const b = canonicalAutomation({
    enabled: true,
    triggers: [{ on: 'entered', query: { tag: 't1' }, birth: true }],
    steps: [],
  })
  assert.equal(JSON.stringify(a), JSON.stringify(b), '写入顺序不同 ⇒ canonical 后逐字节相等')
  assert.equal(JSON.stringify(a), JSON.stringify({ enabled: true, triggers: [{ on: 'entered', query: { tag: 't1' }, birth: true }], steps: [] }))
  const noBirth = canonicalAutomation({ enabled: true, triggers: [{ on: 'changed', query: { prop: { id: 'p1', exists: true } } }], steps: [] })
  assert.equal('birth' in noBirth.triggers[0], false, 'birth 缺省不落键（一个语义不许两种形状）')
  // followRefs 跟着 canonical 一起活：开了要活下来，关了不能凭空多出来
  const withFollow = canonicalAutomation({ enabled: true, triggers: [{ on: 'entered', query: { up: { is: 'a1' } }, birth: true, followRefs: true }], steps: [] })
  assert.equal((withFollow.triggers[0] as { followRefs?: unknown }).followRefs, true)
  assert.equal('followRefs' in noBirth.triggers[0], false)
})

/* ------------------------------------------------------------ 校验器 */

test('校验器：self 层白名单——每条拒形对着它防的错', () => {
  const p = { prop: { id: 'p1', exists: true as const } }
  // 合法基线
  assert.equal(validateTriggerQuery('entered', { prop: { id: 'p1', eq: 'x' } }, false), null)
  assert.equal(validateTriggerQuery('left', { tag: 't1' }, false), null)
  assert.equal(validateTriggerQuery('changed', p, false), null)
  assert.equal(validateTriggerQuery('entered', { all: [{ tag: 't1' }, p] }, false), null, '组合器在 self 层合法')
  assert.equal(validateTriggerQuery('entered', { not: p }, false), null, '{not} 引用其子树，合法')
  // 正文原子：逐键挥发且无原子索引
  assert.match(String(validateTriggerQuery('entered', { text: '呵呵' }, false)), /content atoms/)
  assert.match(String(validateTriggerQuery('entered', { mark: { bg: 'red' } }, false)), /content atoms/)
  assert.match(String(validateTriggerQuery('entered', { link: {} }, false)), /content atoms/)
  assert.match(String(validateTriggerQuery('entered', { ref: 'x1' }, false)), /content atoms/)
  // is：恒惰——id 在可见事件里不变
  assert.match(String(validateTriggerQuery('entered', { is: 'a1' }, false)), /inert/)
  // 结构原子：变化 touch 的是别的块，self 层观测不到
  assert.match(String(validateTriggerQuery('entered', { children: true }, false)), /structural/)
  assert.match(String(validateTriggerQuery('entered', { down: { tag: 't1' } }, false)), /structural/)
  assert.match(String(validateTriggerQuery('entered', { near: { tag: 't1' } }, false)), /structural/)
  // today：时间依赖＝每日重算的后门
  assert.match(String(validateTriggerQuery('entered', { today: { offset: 0 } }, false)), /time-dependent/)
  // role：prop 的第二种拼法
  assert.match(String(validateTriggerQuery('entered', { role: 'journal' }, false)), /prop condition/)
})

test('校验器：up 位置与诞生约束——birth 强制、仅限 entered、至多一层、不入 not/any', () => {
  // 合法位：顶层、顶层 all 直接成员
  assert.equal(validateTriggerQuery('entered', { up: { is: 'a1' } }, true), null)
  assert.equal(validateTriggerQuery('entered', { all: [{ up: { is: 'a1' } }, { prop: { id: 'p1', exists: true } }] }, true), null)
  // containsUp ⇒ birth 强制（推断不让用户选）
  assert.match(String(validateTriggerQuery('entered', { up: { is: 'a1' } }, false)), /must set birth/)
  // up 仅限 entered
  assert.match(String(validateTriggerQuery('left', { up: { is: 'a1' } }, true)), /only allowed on entered/)
  assert.match(String(validateTriggerQuery('changed', { up: { is: 'a1' } }, true)), /only allowed on entered/)
  // birth 仅限 entered
  assert.match(String(validateTriggerQuery('left', { tag: 't1' }, true)), /birth only applies/)
  // 嵌套 up
  assert.match(String(validateTriggerQuery('entered', { up: { up: { is: 'a1' } } }, true)), /cannot nest/)
  // 位置：not/any 内、嵌套 all 内
  assert.match(String(validateTriggerQuery('entered', { not: { up: { is: 'a1' } } }, true)), /top level/)
  assert.match(String(validateTriggerQuery('entered', { any: [{ up: { is: 'a1' } }] }, true)), /top level/)
  assert.match(
    String(validateTriggerQuery('entered', { all: [{ all: [{ up: { is: 'a1' } }] }] }, true)),
    /top level/,
    '顶层 all 的**直接**成员位才合法（嵌套 all 里的 up 不行）',
  )
})

test('校验器：up 子层除嵌套 up 全开放——一次性判定，观测约束不适用', () => {
  const up = (inner: unknown) => validateTriggerQuery('entered', { up: inner } as never, true)
  assert.equal(up({ is: 'a1' }), null, '「父块是块A」＝picker 核心写法')
  assert.equal(up({ tag: 't1' }), null)
  assert.equal(up({ prop: { id: 'p1', eq: 'x' } }), null)
  assert.equal(up({ text: '会议' }), null, '父块正文条件：诞生时求值一次，无逐键路径')
  assert.equal(up({ today: { offset: 0 } }), null, '「今天的日记页下新建」：诞生时求值，无每日重算问题')
  assert.equal(up({ down: { tag: 't1' } }), null)
  assert.equal(up({ role: 'journal' }), null)
  assert.equal(up({ all: [{ is: 'a1' }, { text: '会议' }] }), null)
  assert.equal(up({ not: { tag: 't1' } }), null)
})

test('校验器：birth 触发器的 self 半边与 up 子层同宽——一次性判定，观测约束不适用', () => {
  const q = { text: '会议' } as never
  assert.equal(validateTriggerQuery('entered', q, true), null, '诞生触发器的正文条件：诞生时求值一次')
  assert.match(String(validateTriggerQuery('entered', q, false)), /content atoms/, '边沿触发照旧拒（逐键挥发无索引）')
  assert.match(String(validateTriggerQuery('entered', { up: { any: [] } } as never, true)), /at least one atom/, 'birth 也逃不过 ≥1 引用原子')
  assert.match(
    String(validateTriggerQuery('entered', { tag: { id: 't1', desc: true } } as never, true)),
    /direct membership/,
    'desc 标签要闭包，触发器用直读形态',
  )
})

test('校验器：≥1 引用原子——零原子拒（挡「每笔变化都触发」的热路径危害）', () => {
  assert.match(String(validateTriggerQuery('entered', { all: [] }, false)), /at least one atom/)
  assert.match(String(validateTriggerQuery('changed', { not: { all: [] } }, false)), /at least one atom/, 'not 只翻转，救不了零原子')
  // 结构外壳不算原子：{up:{children:true}} 是「任意父块」穿着衣服
  assert.match(String(validateTriggerQuery('entered', { up: { children: true } }, true)), /at least one atom/)
  assert.match(String(validateTriggerQuery('entered', { up: { not: { children: true } } }, true)), /at least one atom/)
  // 引用叶子在 not/up/down 里照样计数
  assert.equal(validateTriggerQuery('entered', { not: { prop: { id: 'p1', exists: true } } }, false), null)
  assert.equal(validateTriggerQuery('entered', { up: { down: { tag: 't1' } } }, true), null)
})

/* ------------------------------------------------------------ 依赖提取 */

test('依赖提取：self 层 prop/tag 进集合；{not} 仍引用其子树；up 子层不进依赖', () => {
  const deps = triggerDeps({ all: [{ prop: { id: 'p1', exists: true } }, { not: { prop: { id: 'p2', exists: true } } }, { tag: { id: 't1', desc: true } }] })
  assert.deepEqual([...deps.props].sort(), ['p1', 'p2'], 'not 的子树仍是引用')
  assert.deepEqual([...deps.tags], ['t1'], 'tag 对象形态取 id')
  const withUp = triggerDeps({ up: { prop: { id: 'p9', exists: true } } } as never)
  assert.equal(withUp.props.size, 0, 'up 子层的 prop 是父块事实（一次性判定），不是依赖')
  const dup = triggerDeps({ all: [{ prop: { id: 'p1', exists: true } }, { prop: { id: 'p1', eq: 'x' } }] })
  assert.equal(dup.props.size, 1, '重复原子只算一次')
})

/* ------------------------------------------------------------ 引擎接线（行为断言在等式测试文件） */

test('引擎已认统一形状：entered 对「出生即满足」开火（数据边沿的诞生半边）', () => {
  const tag = mkBlock('标签')
  tag.props = { _aliases: ['标签'], _lists: ['tag'] }
  const numDef = mkPropDef('数量', 'number')
  const target = mkBlock('目标')
  const rule = mkAutomationBlock({
    name: '统一形状规则',
    def: {
      enabled: true,
      triggers: [{ on: 'entered', query: { prop: { id: numDef.id, exists: true } } }],
      steps: [{ cmd: 'core.tags/add', args: { tagId: tag.id } }],
    },
  })
  const store = new BlockStore([numDef, tag, target, rule])
  const kb = new MemoryKb(store, { now: () => 1000 })
  const engine = createAutomationEngine({ kb, lookup: kb })
  kb.setReactor((ctx) => engine.react(ctx))
  const fresh = mkBlock('出生即带值')
  fresh.props = { [numDef.id]: 7 }
  kb.tx((tx) => tx.insert(fresh, null, 0))
  assert.equal(hasTag(kb.get(fresh.id)!, tag.id), true, 'birth 按「不匹配」参与 entered 判定 ⇒ 出生即满足开火')
})
