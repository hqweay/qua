/**
 * **自动化块：形状、身份、执行与投影。**
 *
 * 这里钉的是四件事：
 *   · **不新增实体**：`_automation` 是派生身份——`isAutomationBlock`／`hasIdentity`／
 *     `identityTags`／`canWriteText`／复制剔除全部跟上（漏一条就会出现
 *     「复制自动化造出第二条同规则」这类静默回归）；
 *   · **真原子**：一笔 tx 包住全部步骤，任一步失败整组回滚（森林逐字节等于进门时）；
 *   · **步骤引用命令**：闭集之外的自然拒绝；参数引用（target／now）按 run 开始定格；
 *   · **投影规则**：禁用不列、事件-only 不列、不适用灰掉并说明——面板与 runner
 *     共用同一份 guards，两个答案不许分叉。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canDirectEditText,
  canWriteText,
  cloneSubtree,
  hasIdentity,
  identityTags,
  isAutomationBlock,
  mkBlock,
  mkPropDef,
  type Block,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { forestFingerprint } from '../src/core/kb/diff.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { hasTag } from '../src/core/identity/tags.ts'
import { dateOfMs } from '../src/core/identity/journal.ts'
import {
  canonicalAutomation,
  isAutomationDef,
  mkAutomationBlock,
  readAutomation,
  type AutomationDef,
} from '../src/core/automation/automation.ts'
import { manualRunGuards, runAutomationSteps, STEP_COMMANDS } from '../src/core/automation/run.ts'
import { projectManualAutomations } from '../src/core/automation/projection.ts'
import { automationCommands } from '../src/app/commands/automation.ts'

/* ------------------------------------------------------------ 夹具 */

const MANUAL_DEF: AutomationDef = {
  enabled: true,
  triggers: ['manual'],
  steps: [{ cmd: 'core.props/set-value', args: {} }],
}

function fixture(blocks: Block[] = []): { kb: MemoryKb; store: BlockStore } {
  const store = new BlockStore(blocks)
  const kb = new MemoryKb(store, { now: () => 1000 })
  return { kb, store }
}

/* ------------------------------------------------------------ 形状与身份 */

test('isAutomationDef：触发器与步骤的形状判据（写侧唯一一份）', () => {
  assert.equal(isAutomationDef(MANUAL_DEF), true)
  assert.equal(
    isAutomationDef({ enabled: false, triggers: ['manual'], steps: [] }),
    true,
    '空步骤是合法态（还没写完的规则）',
  )
  assert.equal(isAutomationDef({ enabled: false, triggers: [], steps: [] }), false, '没有触发器不成定义')
  assert.equal(isAutomationDef({ triggers: ['manual'], steps: [] }), false, 'enabled 必须显式')
  assert.equal(isAutomationDef({ enabled: true, triggers: ['timer'], steps: [] }), false, '未知触发器拒绝')
  assert.equal(isAutomationDef({ enabled: true, triggers: [{ kind: 'prop' }], steps: [] }), false, 'prop 触发器必须带 prop')
  assert.equal(
    isAutomationDef({ enabled: true, triggers: [{ kind: 'tag', tag: 't1' }], steps: [] }),
    false,
    'tag 触发器必须带 on',
  )
  assert.equal(
    isAutomationDef({ enabled: true, triggers: ['manual'], steps: [{ args: {} }] }),
    false,
    '步骤必须带 cmd',
  )
  assert.equal(
    isAutomationDef({ enabled: true, triggers: ['manual'], steps: [{ cmd: 'x', args: { a: { ref: 'step' } } }] }),
    false,
    '引用值域只有 target／now（step 留槽不实现）',
  )
})

test('自动化块是身份块：hasIdentity 认它、外观标记带 automation、正文受保护但可直接改名', () => {
  const b = mkAutomationBlock({ name: '收尾归档', def: MANUAL_DEF })
  assert.equal(isAutomationBlock(b), true)
  assert.equal(hasIdentity(b), true)
  assert.ok(identityTags(b).includes('automation'), '外观按身份标记（样式表按 data-role 挑行）')
  assert.equal(canWriteText(b), false, '正文是名字——内容写路径不许改写它')
  assert.equal(canDirectEditText(b), true, '但这一行打字是它唯一的改名路径')
})

test('复制自动化块：定义不带走（副本不能是第二条同规则）', () => {
  const src = mkAutomationBlock({ name: '收尾归档', def: MANUAL_DEF })
  const copy = cloneSubtree(src).block
  assert.equal(copy.props?._automation, undefined, '副本不带定义：定义指向的是「这一个」')
  assert.equal(isAutomationBlock(copy), false)
  assert.equal(hasIdentity(copy), false)
})

test('canonicalAutomation：键序固定（定义变没变的比较不受字面量写法影响）', () => {
  const a = canonicalAutomation({
    steps: [{ cmd: 'c', args: {} }],
    triggers: ['manual'],
    enabled: true,
  })
  const b = canonicalAutomation({ enabled: true, triggers: ['manual'], steps: [{ cmd: 'c', args: {} }] })
  assert.equal(JSON.stringify(a), JSON.stringify(b), '两个写入顺序不同的同一定义 ⇒ canonical 后逐字节相等')
  assert.equal(JSON.stringify(canonicalAutomation(a)), JSON.stringify(a), 'canonical 幂等')
})

test('readAutomation：坏形状给 null（降级显示），不猜不修', () => {
  const bad = mkBlock('坏规则')
  bad.props = { _automation: { enabled: 'yes', triggers: ['manual'], steps: [] } }
  assert.equal(readAutomation(bad), null)
})

/* ------------------------------------------------------------ 派生列表 */

test('automations()：先序枚举、软删退场、`_automation` 写后立即可见', () => {
  const r1 = mkAutomationBlock({ name: '规则一', def: MANUAL_DEF })
  const r2 = mkAutomationBlock({ name: '规则二', def: { ...MANUAL_DEF, enabled: false } })
  const plain = mkBlock('普通块')
  const { kb, store } = fixture([r1, r2, plain])

  assert.deepEqual(kb.automations().map((b) => b.id), [r1.id, r2.id], '停用的也列（它还在库里）')

  // 写路径经 tx（op 出口会失效缓存）：新建的规则立刻进清单
  const r3 = mkAutomationBlock({ name: '规则三', def: MANUAL_DEF })
  kb.tx((tx) => tx.insert(r3, null, store.blocks.length))
  assert.ok(kb.automations().some((b) => b.id === r3.id), 'tx 出口后派生列表已重建')

  // 软删退场
  kb.tx((tx) => tx.remove(r1.id))
  assert.equal(kb.automations().some((b) => b.id === r1.id), false, '删掉的规则不再列')
})

/* ------------------------------------------------------------ runner：guards 与真原子 */

test('guards：禁用／事件-only／没有步骤／没有目标／自改／条件不满足，各有各的拒绝理由', () => {
  const aid = 'auto-1'
  const tid = 'target-1'
  assert.equal(manualRunGuards(null, aid, tid, true).reason, 'noManual')
  assert.equal(
    manualRunGuards({ ...MANUAL_DEF, enabled: false }, aid, tid, true).reason,
    'disabled',
    '停用的先于一切（面板根本不列它，这是运行前的最后闸）',
  )
  assert.equal(
    manualRunGuards({ ...MANUAL_DEF, triggers: [{ kind: 'prop', prop: 'p1' }] }, aid, tid, true).reason,
    'noManual',
  )
  assert.equal(manualRunGuards({ ...MANUAL_DEF, steps: [] }, aid, tid, true).reason, 'noSteps')
  assert.equal(manualRunGuards(MANUAL_DEF, aid, undefined, true).reason, 'noTarget')
  assert.equal(manualRunGuards(MANUAL_DEF, aid, aid, true).reason, 'selfTarget', '规则不能以自己为目标')
  assert.equal(manualRunGuards(MANUAL_DEF, aid, tid, false).reason, 'whenFailed')
  assert.deepEqual(manualRunGuards(MANUAL_DEF, aid, tid, true), { ok: true })
})

test('真原子：第二步失败 ⇒ 森林逐字节等于进门时（第一步的写入也退回）', () => {
  const def = mkPropDef('数量', 'number')
  const target = mkBlock('目标块')
  const { kb, store } = fixture([def, target])

  const badDef: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [
      { cmd: 'core.props/set-value', args: { propId: def.id, value: 42 } },
      { cmd: 'core.props/set-value', args: { propId: def.id, value: '不是数字' } },
    ],
  }
  const before = forestFingerprint(store.blocks)
  assert.throws(
    () => runAutomationSteps(kb, target.id, badDef),
    /not valid for kind/,
    '形状校验在原语内部抛——tx 回滚日志接住',
  )
  assert.equal(forestFingerprint(store.blocks), before, '整批回滚：第一步的 42 也不许留下')
})

test('手动全链路：设值＋打标签一步跑完，撤销捕获返回给调用方', () => {
  const def = mkPropDef('数量', 'number')
  const target = mkBlock('目标块')
  const { kb } = fixture([def, target])

  const run: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [
      { cmd: 'core.props/set-value', args: { propId: def.id, value: 7 } },
      { cmd: 'core.tags/add', args: { name: '已复核' } },
    ],
  }
  const r = runAutomationSteps(kb, target.id, run, { lookup: kb })
  assert.ok(r)
  assert.equal(r.stepsRun, 2)
  const after = kb.get(target.id)
  assert.equal(after?.props?.[def.id], 7)
  assert.equal(hasTag(after!, kb.findTag('已复核')!.id), true, '同名标签找到或创建，归属写上')
})

test('参数引用：{ref:target} 解析成手动链目标；{ref:now} 按 date 格折算成本地 ISO 并整条定格一次', () => {
  const refDef = mkPropDef('指向', 'ref')
  const dateDef = mkPropDef('完成时间', 'date')
  const target = mkBlock('目标块')
  const other = mkBlock('别的块')
  const { kb } = fixture([refDef, dateDef, target, other])

  const NOW = Date.UTC(2026, 10, 20, 12) // 2026-11-20（本地折算由 dateOfMs 定）
  const run: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [
      { cmd: 'core.props/set-value', args: { propId: refDef.id, value: { ref: 'target' } } },
      { cmd: 'core.props/set-value', args: { propId: dateDef.id, value: { ref: 'now' } } },
    ],
  }
  runAutomationSteps(kb, target.id, run, { now: NOW })
  const after = kb.get(target.id)
  assert.equal(after?.props?.[refDef.id], target.id, 'target 引用解析成目标块 id')
  assert.equal(after?.props?.[dateDef.id], dateOfMs(NOW), 'now 定格一次、按值格 kind 折算')
})

test('闭集：投影命令（automation/<id>）与未知命令都不是可引用的步骤', () => {
  assert.ok(STEP_COMMANDS.includes('core.tree/insert-child'))
  assert.ok(!STEP_COMMANDS.some((c) => c.startsWith('automation/')), '投影命令不打准入标记，天然防递归')
  const target = mkBlock('目标块')
  const { kb } = fixture([target])
  const recursive: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [{ cmd: 'automation/some-rule', args: {} }],
  }
  assert.throws(() => runAutomationSteps(kb, target.id, recursive), /not a step-capable command/)
})

test('remove-tag：归属连正文里的 `#名` 露面一起收（同一笔 tx）', () => {
  const tag = mkBlock('待办')
  tag.props = { _aliases: ['待办'], _lists: ['tag'] }
  const target = mkBlock('被标块的正文')
  target.content = [...textRuns('做完这件事 '), { id: 'ref-1', t: 'ref', to: tag.id, flavor: '#' }]
  target.props = { _tags: [tag.id] }
  const { kb } = fixture([tag, target])

  const run: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [{ cmd: 'core.tags/remove', args: { tagId: tag.id } }],
  }
  const r = runAutomationSteps(kb, target.id, run)
  assert.ok(r)
  const after = kb.get(target.id)!
  assert.equal(after.props?._tags, undefined, '归属摘掉（属性袋不留空壳）')
  assert.equal(after.content.some((x) => 'to' in x && x.to === tag.id), false, '正文里的 `#名` 一并收掉')
})

test('insert-child 与 move：建子块纯文本、移动受「不能进自己子树」约束', () => {
  const parent = mkBlock('收集箱')
  const stray = mkBlock('走失的块')
  const { kb } = fixture([parent, stray])

  const run: AutomationDef = {
    enabled: true,
    triggers: ['manual'],
    steps: [
      { cmd: 'core.tree/insert-child', args: { text: '按模板建的一行' } },
      { cmd: 'core.tree/move', args: { blockId: stray.id, parentId: parent.id, position: 0 } },
    ],
  }
  const r = runAutomationSteps(kb, parent.id, run)
  assert.ok(r)
  const after = kb.get(parent.id)!
  assert.equal(after.children.length, 2, '建了一个子块，stray 也搬了进来')
  assert.equal(after.children[0]!.id, stray.id, 'position 0：stray 在最前')
  assert.deepEqual(after.children[1]!.content.map((x) => ('v' in x ? x.v : '')), ['按模板建的一行'], '建子块是纯文本')
})

/* ------------------------------------------------------------ 投影 */

function projFixture(): { kb: MemoryKb; target: Block; rules: Record<string, Block> } {
  const target = mkBlock('目标块')
  const ok = mkAutomationBlock({ name: '可运行', def: MANUAL_DEF })
  const disabled = mkAutomationBlock({
    name: '停用',
    def: { ...MANUAL_DEF, enabled: false },
  })
  const eventOnly = mkAutomationBlock({
    name: '事件规则',
    def: { ...MANUAL_DEF, triggers: [{ kind: 'prop', prop: 'p1', to: 'x' }] },
  })
  const noSteps = mkAutomationBlock({ name: '空步骤', def: { ...MANUAL_DEF, steps: [] } })
  const broken = mkBlock('坏规则')
  broken.props = { _automation: { enabled: true, triggers: ['manual'], steps: [{ args: {} }] } }
  const { kb } = fixture([target, ok, disabled, eventOnly, noSteps, broken])
  return { kb, target, rules: { ok, disabled, eventOnly, noSteps, broken } }
}

test('投影：禁用与事件-only 不列；可运行的标记 runnable；空步骤与坏形状灰掉并给原因', () => {
  const { kb, target } = projFixture()
  const rows = projectManualAutomations(kb, target.id)
  const byTitle = new Map(rows.map((r) => [r.title, r]))
  assert.equal(rows.some((r) => r.title === '停用'), false, '禁用的不列')
  assert.equal(rows.some((r) => r.title === '事件规则'), false, '事件-only 不列（在「自动化」库视图里）')
  assert.equal(byTitle.get('可运行')?.runnable, true)
  assert.equal(byTitle.get('空步骤')?.runnable, false)
  assert.equal(byTitle.get('空步骤')?.reason, 'noSteps')
  assert.equal(byTitle.get('坏规则')?.runnable, false, '坏形状不静默消失——灰掉并可跳转')
  assert.equal(byTitle.get('坏规则')?.reason, 'broken')
  assert.ok(rows.every((r) => r.id.startsWith('automation/')), '投影命令 id 统一前缀')
})

test('投影：目标不满足条件 ⇒ 灰掉并说明；目标缺位 ⇒ 灰掉而不是隐藏', () => {
  const target = mkBlock('有正文的块')
  const tagged = mkAutomationBlock({
    name: '只对提到「foo」的块',
    def: { ...MANUAL_DEF, when: { text: 'foo' } },
  })
  const { kb } = fixture([target, tagged])
  const noTarget = projectManualAutomations(kb, undefined)
  assert.equal(noTarget[0]?.runnable, false, '没有当前块 ⇒ noTarget（记录面）')
  assert.equal(noTarget[0]?.reason, 'noTarget')
  const greyed = projectManualAutomations(kb, target.id)
  assert.equal(greyed[0]?.runnable, false)
  assert.equal(greyed[0]?.reason, 'whenFailed', '条件不满足：灰掉并说明，不是隐藏')
})

/* ------------------------------------------------------------ 批量运行（补收存量） */

test('批量运行：目标集由「如果」圈定；每块独立失败、互不牵连', () => {
  // 目标两个：U 在页 Pg 之下（搬到 Pg 是合法落点）；T2 是 Pg 的父（把 T2 搬进 Pg＝进自己子树 ⇒ 这块失败）
  const pg = mkBlock('目标页')
  pg.props = { _aliases: ['目标页'], _lists: ['page'] }
  const u = mkBlock('普通子块')
  const t2 = mkBlock('T2 容器')
  t2.children = [pg]
  const numDef = mkPropDef('数量', 'number')
  const rule = mkAutomationBlock({
    name: '批量规则',
    def: {
      enabled: true,
      triggers: ['manual'],
      when: { any: [{ is: u.id }, { is: t2.id }] },
      steps: [
        { cmd: 'core.props/set-value', args: { propId: numDef.id, value: 42 } },
        { cmd: 'core.tree/move', args: { blockId: { ref: 'target' }, parentId: pg.id } },
      ],
    },
  })
  const { kb } = fixture([pg, u, t2, numDef, rule])

  const toasts: string[] = []
  const cmd = automationCommands({
    kb,
    tx: (fn) => kb.tx(fn),
    runGroup: (fn) => fn(),
    repaintBlocks: () => {},
    openBlock: () => {},
    toast: (text) => toasts.push(text),
  })
  const r = cmd.runAutomationBatch(rule.id)
  assert.ok(r)
  assert.deepEqual(r, { ok: 1, failed: 1 }, 'U 成功；T2 搬进自己的子树 ⇒ 这块独立失败')
  assert.equal(kb.get(u.id)?.props?.[numDef.id], 42, '成功那块的值落上了')
  assert.equal(kb.parentOf(u.id)?.id, pg.id, '成功那块搬到了 Pg 下')
  assert.equal(kb.parentOf(pg.id)?.id, t2.id, '失败那块的结构一个字节没动')
  assert.ok(toasts.some((x) => x.includes('失败')), '汇总说清几块成功几块失败')
})

test('批量运行：没有「如果」就拒跑（没有选择器就是全库）', () => {
  const rule = mkAutomationBlock({
    name: '无条件规则',
    def: { enabled: true, triggers: ['manual'], steps: [{ cmd: 'core.tree/insert-child', args: { text: 'x' } }] },
  })
  const plain = mkBlock('随便一块')
  const { kb } = fixture([rule, plain])
  const toasts: string[] = []
  const cmd = automationCommands({
    kb,
    tx: (fn) => kb.tx(fn),
    runGroup: (fn) => fn(),
    repaintBlocks: () => {},
    openBlock: () => {},
    toast: (text) => toasts.push(text),
  })
  const r = cmd.runAutomationBatch(rule.id)
  assert.equal(r, null, '无条件 ⇒ 拒跑')
  assert.equal(kb.children(plain.id).length, 0, '什么都没写')
  assert.ok(toasts.some((x) => x.includes('条件')), '拒绝说清为什么')
})
