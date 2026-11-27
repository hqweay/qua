/**
 * 引述类型表的纯判据：内置七种、记录表的解析/回落、墓碑、写入形状、单例物化。
 *
 * 为什么值得钉：类型是「这一条引述是什么」的唯一判据，徽章取色/图标、菜单、
 * 面包屑、引用 chip、静态卡片、查询/分组都读同一张表。三条最容易悄悄坏的事：
 *   · 值域开放之后**未知 id** 会不会被误当成缺省写回盘；
 *   · 类型被删（墓碑）之后旧引述还读不读得出名字；
 *   · 内置图标有没有 `lucide:` 前缀（静态卡片曾把裸名渲染成字面文本）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CALLOUT_TYPES_BLOCK_ID,
  DEFAULT_CALLOUT,
  builtinCalloutTypes,
  calloutGroupChoices,
  calloutLabel,
  calloutLabelTaken,
  calloutTypeOf,
  calloutTypesOf,
  canonicalCallout,
  liveCalloutTypes,
  type CalloutType,
} from '../src/core/infra/callout.ts'
import {
  calloutTypesIn,
  findCalloutTypesBlock,
  mkCalloutTypesBlock,
  writeCalloutTypesInTx,
} from '../src/core/kb/ensure-callout-types.ts'
import { systemPropViolation } from '../src/core/props/system-props.ts'
import { CALLOUT_PROP, QUOTE_TYPE, CODE_TYPE, blockLabel, childrenRecords, mkBlock, walkForest, type Block } from '../src/core/index.ts'
import { blankWorkspace } from '../src/core/fixtures/states.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { t } from '../src/core/infra/msg.ts'

const BUILTIN_IDS = ['quote', 'info', 'warning', 'error', 'tip', 'important', 'note']

/** 一张「库里有注册表」的最小查找器（读路径只按固定 id 取一块） */
const lookupOf = (block: Block) => (id: string): Block | undefined =>
  id === CALLOUT_TYPES_BLOCK_ID ? block : undefined

test('内置七种齐全、顺序固定、图标带协议头（静态卡片不再渲染成字）', () => {
  const types = builtinCalloutTypes()
  assert.deepEqual(
    types.map((x) => x.id),
    BUILTIN_IDS,
  )
  for (const v of types) {
    assert.ok(v.label.length > 0, `${v.id} 必须有文案`)
    assert.ok(v.icon.startsWith('lucide:'), `${v.id} 的图标要带 lucide: 前缀：${v.icon}`)
  }
  // 颜色走身份色板：缺省是青、`important` 是紫、`note` 是中性（没有强调色）
  assert.equal(types[0]?.color, 'cyan')
  assert.equal(types[5]?.color, 'purple')
  assert.equal(types[6]?.color, undefined)
})

test('缺省是普通引述；未知值按缺省画，但值本身仍可写进盘（值域开放）', () => {
  assert.equal(canonicalCallout(undefined), DEFAULT_CALLOUT)
  assert.equal(canonicalCallout(''), DEFAULT_CALLOUT)
  assert.equal(canonicalCallout('bogus'), DEFAULT_CALLOUT)
  assert.equal(calloutTypeOf('bogus').id, DEFAULT_CALLOUT)
  // 收端只挡空值：拼错的 id 由命令层的「存在且未删」闸拦，读侧不把旧值判死
  assert.equal(systemPropViolation('_callout', 'warning'), null)
  assert.equal(systemPropViolation('_callout', 'my-type'), null)
  assert.ok(systemPropViolation('_callout', '') !== null)
})

test('记录表优先：自定义名字/图标/颜色覆盖内置，旧短 id 原地命中', () => {
  const custom: CalloutType = { id: 'my-type', label: '要点', icon: 'lucide:star', color: 'red' }
  const registry = mkCalloutTypesBlock([...builtinCalloutTypes(), custom])
  const find = lookupOf(registry)
  const types = calloutTypesOf(find)
  assert.equal(calloutLabel('my-type', types), '要点')
  assert.equal(calloutTypeOf('my-type', types).icon, 'lucide:star')
  assert.equal(calloutTypeOf('my-type', types).color, 'red')
  // 旧值不受影响
  assert.equal(calloutLabel('info', types), t('ui.callout.info'))
})

test('墓碑仍解析名字：类型删了，旧引述不该变成「引述」', () => {
  const gone: CalloutType = { id: 'old', label: '旧类型', icon: 'lucide:flag', deleted: true }
  const registry = mkCalloutTypesBlock([...builtinCalloutTypes(), gone])
  const types = calloutTypesOf(lookupOf(registry))
  assert.equal(calloutLabel('old', types), '旧类型')
  // 但候选/菜单不提供它
  assert.ok(!liveCalloutTypes(types).some((x) => x.id === 'old'))
  // 分组/条件面含墓碑：旧条件要读得出名字
  assert.ok(calloutGroupChoices(types).some((c) => c.id === 'old' && c.label === '旧类型'))
})

test('表还没物化的旧库：读路径回退内置表（不因为缺块而丢名字）', () => {
  const types = calloutTypesOf(() => undefined)
  assert.deepEqual(
    types.map((x) => x.id),
    BUILTIN_IDS,
  )
  // 形状坏了也回退
  const broken = { ...mkCalloutTypesBlock(builtinCalloutTypes()), props: { _calloutTypes: 'nope' } }
  assert.deepEqual(
    calloutTypesOf(lookupOf(broken)).map((x) => x.id),
    BUILTIN_IDS,
  )
})

test('`_calloutTypes` 的形状判据与 `_choices` 同一份：id 唯一、label 非空', () => {
  assert.equal(systemPropViolation('_calloutTypes', [{ id: 'a', label: '甲', icon: '' }]), null)
  assert.ok(systemPropViolation('_calloutTypes', [{ id: 'a', label: '', icon: '' }]) !== null)
  assert.ok(
    systemPropViolation('_calloutTypes', [
      { id: 'a', label: '甲' },
      { id: 'a', label: '乙' },
    ]) !== null,
    '两个同 id 的记录会让「这个值显示哪个名字」没有答案',
  )
})

test('引述容器的名字＝类型名（面包屑/引用 chip 读同一份，含自定义类型）', () => {
  const custom: CalloutType = { id: 'my-type', label: '要点', icon: 'lucide:star' }
  const registry = mkCalloutTypesBlock([...builtinCalloutTypes(), custom])
  const find = lookupOf(registry)
  const q = mkBlock('', { props: { _type: QUOTE_TYPE } })
  assert.equal(blockLabel(q, find), t('ui.callout.quote'))
  const info = mkBlock('', { props: { _type: QUOTE_TYPE, [CALLOUT_PROP]: 'info' } })
  assert.equal(blockLabel(info, find), t('ui.callout.info'))
  const mine = mkBlock('', { props: { _type: QUOTE_TYPE, [CALLOUT_PROP]: 'my-type' } })
  assert.equal(blockLabel(mine, find), '要点')
})

test('重名判据按规范化后的名字比（去空白、折叠、小写），改名时排除自己', () => {
  const types: CalloutType[] = [
    { id: 'a', label: 'Info', icon: '' },
    { id: 'b', label: '警告', icon: '' },
  ]
  assert.equal(calloutLabelTaken(types, '  info '), true)
  assert.equal(calloutLabelTaken(types, 'INFO', 'a'), false, '改自己的大小写不算撞名')
  assert.equal(calloutLabelTaken(types, '  警告 '), true)
  assert.equal(calloutLabelTaken(types, 'warn  ing'), false, '只折叠空白，不把空格当不存在')
  assert.equal(calloutLabelTaken(types, '新名字'), false)
})

/* ------------------------------------------------------------ 单例物化 */

function blankForest() {
  const ws = blankWorkspace()
  const store = new BlockStore(ws.blocks)
  const kb = new MemoryKb(store)
  return { ws, store, kb }
}

test('首建：表不在 ⇒ 一次 insert 把内置七种＋本笔改动一起长进顶层（无正文/别名）', () => {
  const { store, kb } = blankForest()
  assert.equal(findCalloutTypesBlock(store.blocks), undefined, '空库本来没有这张表')
  const mine: CalloutType = { id: 'mine', label: '要点', icon: 'lucide:star' }
  kb.tx((tx) =>
    writeCalloutTypesInTx(store.blocks, tx, (records) => [...records, mine]),
  )
  const block = findCalloutTypesBlock(store.blocks)
  assert.ok(block, '笔后表必须在顶层')
  assert.equal(block!.id, CALLOUT_TYPES_BLOCK_ID)
  assert.equal(block!.content.length, 0, '表不写正文：它不参与组织')
  assert.equal(block!.children.length, 0, '记录不进森林')
  assert.equal(block!.props?._aliases, undefined, '类型表不占地址')
  assert.deepEqual(
    calloutTypesIn(block).map((x) => x.id),
    [...BUILTIN_IDS, 'mine'],
    '内置七种＋新建的那条（数组序＝菜单序）',
  )
})

test('幂等：表已在 ⇒ 只改那一格，不插第二份（同一笔改两次也只有一块）', () => {
  const { store, kb } = blankForest()
  kb.tx((tx) => writeCalloutTypesInTx(store.blocks, tx, (records) => records))
  const first = findCalloutTypesBlock(store.blocks)
  assert.ok(first)
  kb.tx((tx) =>
    writeCalloutTypesInTx(store.blocks, tx, (records) =>
      records.map((x) => (x.id === 'info' ? { ...x, label: '信息!' } : x)),
    ),
  )
  let count = 0
  walkForest(store.blocks, (b) => {
    if (b.id === CALLOUT_TYPES_BLOCK_ID) count++
  }, { includeDeleted: true })
  assert.equal(count, 1, '确定性 id 只能有一块')
  assert.equal(calloutTypesIn(findCalloutTypesBlock(store.blocks)).find((x) => x.id === 'info')?.label, '信息!')
})

test('表被软删：不写、不复活（恢复是回收站的事），返回 deleted 且零 op', () => {
  const { store, kb } = blankForest()
  kb.tx((tx) => writeCalloutTypesInTx(store.blocks, tx, (records) => records))
  const block = findCalloutTypesBlock(store.blocks)!
  kb.tx((tx) => {
    tx.patch(block.id, (b) => {
      b.props = { ...(b.props ?? {}), _deletedAt: Date.now() }
    })
  })
  let outcome = 'ok'
  const r = kb.tx((tx) => {
    outcome = writeCalloutTypesInTx(store.blocks, tx, (records) =>
      records.map((x) => (x.id === 'info' ? { ...x, label: '不该写进去' } : x)),
    )
  })
  assert.equal(outcome, 'deleted')
  assert.equal(r.ops.length, 0)
})

test('记录投影补上缺省类型：默认引述分到「引述」，不落「未设置」', () => {
  const page = mkBlock('', { props: { _lists: ['page'], _aliases: ['页'] } })
  const quote = mkBlock('', { props: { _type: QUOTE_TYPE } })
  quote.children.push(mkBlock('正文'))
  page.children.push(quote)
  const kb = new MemoryKb(new BlockStore([page]))
  const [record] = childrenRecords(page.id, kb)
  assert.ok(record && record.block.id === quote.id)
  // 盘上仍没有这一格（投影不是数据）：写入路径保持一致
  assert.equal(quote.props?._callout, undefined)
  assert.equal(record!.values._callout, DEFAULT_CALLOUT)
})

test('记录投影补代码语言：缺键＝纯文本，别名归一；盘上原值不动', () => {
  const page = mkBlock('', { props: { _lists: ['page'], _aliases: ['页'] } })
  const ts = mkBlock('', { props: { _type: CODE_TYPE, _lang: 'ts' } })
  const plain = mkBlock('', { props: { _type: CODE_TYPE } })
  page.children.push(ts, plain)
  const kb = new MemoryKb(new BlockStore([page]))
  const records = childrenRecords(page.id, kb)
  const valueOf = (id: string) => records.find((r) => r.block.id === id)?.values._lang
  assert.equal(valueOf(ts.id), 'typescript', '分组键与选项 id 同源：别名要归一')
  assert.equal(valueOf(plain.id), 'plain', '缺键＝纯文本，不落「未设置」')
  assert.equal(ts.props?._lang, 'ts', '投影不改盘')
})
