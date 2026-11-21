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
import { canonicalAutomation, isAutomationDef, type AutomationDef } from '../src/core/automation/automation.ts'
import { triggerDeps, validateTriggerQuery } from '../src/core/automation/trigger-query.ts'
import { createAutomationEngine } from '../src/core/automation/engine.ts'
import { mkAutomationBlock } from '../src/core/automation/automation.ts'
import { mkBlock, mkPropDef, type Block } from '../src/core/index.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

/* ------------------------------------------------------------ 形状 */

test('形状：{on, query, birth?} 是合法触发器——birth 可省、birth 只许 true、query 必须是 QueryNode', () => {
  const def = (triggers: unknown[]): AutomationDef => ({ enabled: true, triggers: triggers as AutomationDef['triggers'], steps: [] })
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { prop: { id: 'p1', exists: true } } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { prop: { id: 'p1', exists: true } }, birth: true }])), true)
  assert.equal(isAutomationDef(def([{ on: 'left', query: { tag: 't1' } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'changed', query: { prop: { id: 'p1', exists: true } } }])), true)
  assert.equal(isAutomationDef(def([{ on: 'frobnicate', query: { tag: 't1' } }])), false, '未知事件轴拒绝')
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { nonsense: true } }])), false, 'query 必须是 QueryNode')
  assert.equal(isAutomationDef(def([{ on: 'entered', query: { tag: 't1' }, birth: false }])), false, 'birth 缺省＝不带；显式 false 是第二种形状，拒')
  // 过渡期：三种 kind 仍被判合法（引擎切换那笔转 broken）
  assert.equal(isAutomationDef(def([{ kind: 'prop', prop: 'p1' }])), true)
  assert.equal(isAutomationDef(def([{ kind: 'child.added', parent: { is: 'a1' } }])), true)
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

/* ------------------------------------------------------------ 过渡期守卫 */

test('过渡期：统一形状触发器在引擎切换前不被执行——新块诞生不误落 child.added 分支', () => {
  // 三 kind 分派靠 `kind` 认路；没有 kind 的形状若无守卫会误落 child.added 分支，
  // 把每笔诞生都当成命中。切换前保守忽略，本用例在引擎切换后由等式测试接替。
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
  kb.tx((tx) => tx.setProp(target.id, numDef.id, 7))
  assert.equal(kb.get(target.id)?.props?._tags, undefined, '切换前：统一形状规则不执行（引擎切换那笔翻面）')
})
