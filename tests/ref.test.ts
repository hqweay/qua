/**
 * **引用解析**的纯逻辑测试。
 *
 * 这里钉的是四件在界面上难复现、但又正是「改名传播」全部内容的事：
 *   ① 显示名来自目标的**主名叶子 > 正文**，`label` 只在解析不到时兜底；
 *   ② 目标改名（改 `_aliases`）⇒ 解析结果跟着变（**不需要回头改 run**）；
 *   ③ 目标被删 ⇒ `dangling` ＋ 沿用 `label`（错指要看得见，不假装解析成功）；
 *   ④ journal 的正文是空的 ⇒ 显示**日期投影**，不是「无标题」。
 *
 * ⚠️ 写正文（描述）**不该**改引用显示名：地址只有 `_aliases` 一份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import { writeBlockContent } from '../src/core/model.ts'
import { renameAlias, refTitle, resolveRef, resolveRefs, danglingView } from '../src/core/index.ts'
import { displayTextOf } from '../src/core/alias.ts'
import { journalDateLabel } from '../src/core/journal.ts'
import { textRuns, type RefRun } from '../src/core/runs.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, content: textRuns(text), children: [], ...extra })
const named = (id: string, alias: string, text = '', extra: Partial<Block> = {}): Block =>
  b(id, text, { ...extra, props: { ...(extra.props ?? {}), _aliases: [alias] } })

/** 森林 → `find`（与 `BlockStore.find` 同一语义：整片森林里按 id 找） */
const finder = (forest: readonly Block[]) => (id: string): Block | undefined => {
  const walk = (list: readonly Block[]): Block | undefined => {
    for (const x of list) {
      if (x.id === id) return x
      const inner = walk(x.children)
      if (inner) return inner
    }
    return undefined
  }
  return walk(forest)
}

/** 一枚引用 run（解析只看 `label` 与 `to`） */
const ref = (extra: Partial<RefRun> = {}): RefRun => ({
  id: 'a1',
  t: 'ref',
  label: '旧名字',
  ...extra,
})

test('① 目标存在 ⇒ 显示主名叶子，不是插入时的 label 快照', () => {
  const forest = [named('p1', '真正的名字', '一段描述')]
  const a = ref({ label: '旧名字', to: 'p1' })
  const v = resolveRef(finder(forest), a)
  assert.equal(v.label, '真正的名字', '主名优先于正文')
  assert.equal(v.state, 'resolved')
})

test('①b 名字带 / ⇒ 引用显示**叶子**（全名仍用于解析）', () => {
  const forest = [named('p1', '项目/设计/规范', '描述')]
  const v = resolveRef(finder(forest), ref({ to: 'p1' }))
  assert.equal(v.label, '规范')
})

test('①c 没有名字时才回落到正文', () => {
  const forest = [b('p1', '  正文做名字  ')]
  const v = resolveRef(finder(forest), ref({ to: 'p1' }))
  assert.equal(v.label, '正文做名字')
})

test('② 改名传播：改主名 ⇒ 解析结果跟着变，原子本身一个字节都没动', () => {
  const target = named('p1', '甲', '描述')
  const forest = [target]
  const a = ref({ label: '甲', to: 'p1' })
  const before = JSON.stringify(a)

  assert.equal(resolveRef(finder(forest), a).label, '甲')
  renameAlias(forest, target, '甲', '乙')
  assert.equal(resolveRef(finder(forest), a).label, '乙')

  // 这条是「靠解析传播，不靠批量改 run」的判据：run 没被回写过
  assert.equal(JSON.stringify(a), before, '改名不该回头改 run')
})

test('②b 写正文（描述）不改引用显示名：地址只有 `_aliases` 一份', () => {
  const target = named('p1', '甲', '旧描述')
  const forest = [target]
  writeBlockContent(target, textRuns('新描述'))
  assert.equal(
    resolveRef(finder(forest), ref({ to: 'p1' })).label,
    '甲',
    '正文是描述，不是名字',
  )
})

test('③ 目标被删 ⇒ dangling ＋ 沿用 label（错指要看得见，不假装解析成功）', () => {
  const forest = [named('p1', '甲')]
  const a = ref({ label: '甲', to: 'p1' })
  assert.equal(resolveRef(finder(forest), a).state, 'resolved')

  forest.length = 0
  const v = resolveRef(finder(forest), a)
  assert.equal(v.state, 'dangling')
  assert.equal(v.label, '甲', 'dangling 时显示用户最后见过的名字（fallback）')
})

test('③b 没有 to 的引用 ⇒ dangling（seed 的悬空样本就是这条）', () => {
  const v = resolveRef(finder([]), ref({ label: '这份页面还没写' }))
  assert.equal(v.state, 'dangling')
  assert.equal(v.label, '这份页面还没写')
})

test('④ journal 的正文是空的 ⇒ 显示日期投影，不是「无标题」', () => {
  const forest = [b('j1', '', { props: { _date: '2026-10-20' } })]
  const v = resolveRef(finder(forest), ref({ label: '某天', to: 'j1' }))
  assert.equal(v.state, 'resolved')
  assert.ok(/\d{4}/.test(v.label), `应显示日期投影：${v.label}`)
  assert.notEqual(v.label, '无标题')
})

test('④b 没有名字、正文空白的页 ⇒ 兜底「无标题」（不是空字符串）', () => {
  const forest = [b('p1', '   ')]
  const v = resolveRef(finder(forest), ref({ label: 'x', to: 'p1' }))
  assert.equal(v.label, '无标题')
})

test('refTitle：主名叶子 > 正文；`_display` 不影响引用；journal 空日期退回名字/正文', () => {
  assert.equal(refTitle(named('p', 'A/B', '描述')), 'B')
  assert.equal(refTitle(b('p', '  甲  ')), '甲')
  // `_display` 只决定「这一行自己的头」怎么显示，不参与引用解析
  assert.equal(refTitle({ ...named('p', '甲', '描述'), props: { _aliases: ['甲'], _display: 'text' } }), '甲')
  // `_date` 为空时没有可显示的投影 ⇒ 退回正文（此时为空 ⇒ 兜底文案）
  assert.equal(refTitle(b('j', '', { props: { _date: '' } })), '无标题')
})

test('resolveRefs：按 atomId 返回（不是按位置，顺序变了也不会张冠李戴）', () => {
  const forest = [named('p1', '甲'), named('p2', '乙')]
  const find = finder(forest)
  const runs: RefRun[] = [
    { id: 'x', t: 'ref', label: '旧甲', to: 'p1' },
    { id: 'y', t: 'ref', label: '旧乙', to: 'p2' },
    { id: 'z', t: 'ref', label: '孤的', to: 'nope' },
  ]
  const m = resolveRefs(find, runs)
  assert.equal(m.get('x')?.label, '甲')
  assert.equal(m.get('y')?.label, '乙')
  assert.equal(m.get('z')?.state, 'dangling')
  // 反序取一遍：结果与顺序无关
  assert.equal(resolveRefs(find, [...runs].reverse()).get('x')?.label, '甲')
})

test('danglingView：占位符还在但原子记录没了时的兜底', () => {
  const v = danglingView('未知原子')
  assert.deepEqual(v, { label: '未知原子', state: 'dangling', kind: 'page' })
})

/**
 * **锚文本叠在现算名之上**：显示链只有一条，
 * resolved ＝ `anchor ?? 现算名`，dangling ＝ `anchor ?? label ?? ''`。
 */
test('A1 resolved：anchor 压过目标现算出来的名字；目标改名只影响没有 anchor 的那些引用', () => {
  const target = named('p1', '甲', '描述')
  const forest = [target]
  const find = finder(forest)
  const anchored = ref({ to: 'p1', anchor: '合同第三版' })
  const plain = ref({ to: 'p1' })
  assert.equal(resolveRef(find, anchored).label, '合同第三版', 'anchor 是用户显式写的显示名')
  assert.equal(resolveRef(find, plain).label, '甲')

  // 改名：anchor 那一处**不动**（这正是它存在的理由），没有 anchor 的那一处跟着变
  renameAlias(forest, target, '甲', '乙')
  assert.equal(resolveRef(find, anchored).label, '合同第三版')
  assert.equal(resolveRef(find, plain).label, '乙')
})

test('A1b anchor 是空串 ⇒ 不当作「用户写了空名字」，照样按现算名显示', () => {
  const forest = [named('p1', '甲')]
  // 空串与「没写」在库里是同一个形状（写空＝删键），所以判据只看非空
  assert.equal(resolveRef(finder(forest), ref({ to: 'p1', anchor: '' })).label, '甲')
})

test('A2 dangling：anchor ?? label；两者皆无 ⇒ 空串占位（现状不变）', () => {
  const forest = [named('p1', '甲')]
  const find = finder(forest)
  // 目标还在：label 不参与（它是快照，不是显示名）
  assert.equal(resolveRef(find, ref({ to: 'p1', label: '旧名字', anchor: '锚' })).label, '锚')

  forest.length = 0
  const dangling = finder(forest)
  assert.equal(resolveRef(dangling, ref({ to: 'p1', label: '旧名字', anchor: '锚' })).label, '锚', 'anchor 优先')
  assert.equal(resolveRef(dangling, ref({ to: 'p1', label: '旧名字' })).label, '旧名字', '没有 anchor ⇒ 快照兜底')
  assert.equal(resolveRef(dangling, ref({ to: 'p1', label: undefined })).label, '', '两者皆无 ⇒ 空串')
  // 状态始终是 dangling：anchor 不给「解析成功」的错觉
  assert.equal(resolveRef(dangling, ref({ to: 'p1', anchor: '锚' })).state, 'dangling')
})

test('A2b anchor 不是身份：它不进 `_aliases`，也不影响任何一次「按名字取块」', () => {
  const target = named('p1', '甲')
  const forest = [target]
  const a = ref({ to: 'p1', anchor: '合同第三版' })
  resolveRef(finder(forest), a)
  assert.deepEqual(target.props?._aliases, ['甲'], '解析是纯读：不回写 run，也不回写目标')
  assert.equal(JSON.stringify(a), JSON.stringify({ id: 'a1', t: 'ref', label: '旧名字', to: 'p1', anchor: '合同第三版' }))
})

/**
 * 引用目标的**呈现身份**只看归属：`props._tags` 非空 ⇒ `obj`。
 *
 * 这条看起来像漏判（一个页被打了块标签就显示成「实例」），其实是口径：
 * 归属即实例 —— 打上标签的块同时也是那个标签的一条记录。
 * 钉住它，是为了下次有人觉得「页不该算实例」时先撞到断言，而不是先改代码。
 */
test('kind 只看归属：带 `_tags` 的页也算实例，标签类优先，其余是页', () => {
  const forest: Block[] = [
    // 标签类：`_lists` 里有 tag ⇒ 判 tag（先于归属）
    b('t', '咖啡', { props: { _aliases: ['咖啡'], _lists: ['tag'], _tags: ['t'] } }),
    // 页 + 块标签：地址在了，但归属非空 ⇒ obj（口径如此）
    named('p', '星巴克', '一家店', { props: { _aliases: ['星巴克'], _lists: ['page'], _tags: ['t'] } }),
    // 普通内容块 + 块标签 ⇒ obj
    b('r', '一杯拿铁', { props: { _tags: ['t'] } }),
    // 只有正文里那枚行内提及（`_tags` 为空）⇒ 还是 page
    b('m', '提到咖啡', { props: {} }),
    named('q', '干净页'),
  ]
  const find = finder(forest)
  assert.equal(resolveRef(find, { to: 't' }).kind, 'tag', '露面为 tag 的块先判标签类')
  assert.equal(resolveRef(find, { to: 'p' }).kind, 'obj', '带归属的页也是那个标签的实例')
  assert.equal(resolveRef(find, { to: 'r' }).kind, 'obj', '归属非空即实例（不看正文）')
  assert.equal(resolveRef(find, { to: 'm' }).kind, 'page', '没有归属 ⇒ 不是实例')
  assert.equal(resolveRef(find, { to: 'q' }).kind, 'page')
})

/**
 * **可读文本只有一个来源**（`displayTextOf`）。
 *
 * 它此前藏在 `refTitle` 的日记特判里；一旦「按文本匹配」的查询也用得上它，
 * 第二份实现就会出现——于是把投影上移成函数，`refTitle` 只负责兜底文案。
 * 这里钉的是「上移没有改变任何一句话」：投影本身逐字相等，兜底仍旧只发生在 `refTitle`。
 */
test('U1 displayTextOf：日记 ⇒ 日期投影（不是空串、不是「无标题」）', () => {
  const j = b('j', '', { props: { _date: '2026-10-26' } })
  assert.equal(displayTextOf(j), journalDateLabel('2026-10-26'))
  assert.notEqual(displayTextOf(j), '')
  assert.notEqual(displayTextOf(j), '无标题')
})

test('U1b displayTextOf：主名叶子 > 正文；都空 ⇒ 空串（不兜「无标题」）', () => {
  assert.equal(displayTextOf(named('p', 'A/B', '描述')), 'B')
  assert.equal(displayTextOf(b('p', '  正文  ')), '正文')
  assert.equal(displayTextOf(b('p', '   ')), '', '空就是空：查询拿「无标题」去匹配会命中一批怪东西')
})

test('U2 refTitle 与 displayTextOf 对日记是同一个串（收成一个入口，不是两份答案）', () => {
  for (const date of ['2026-10-26', '2026-01-01', '2026-12-31']) {
    const j = b(`j-${date}`, '', { props: { _date: date } })
    assert.equal(refTitle(j), displayTextOf(j))
  }
})
