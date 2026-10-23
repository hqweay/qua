/**
 * **引用解析**的纯逻辑测试。
 *
 * 这里钉的是四件在界面上难复现、但又正是「改名传播」全部内容的事：
 *   ① 显示名来自目标的**主名叶子 > 正文**，`label` 只在解析不到时兜底；
 *   ② 目标改名（改 `_aliases`）⇒ 解析结果跟着变（**不需要回头改原子**）；
 *   ③ 目标被删 ⇒ `dangling` ＋ 沿用 `label`（错指要看得见，不假装解析成功）；
 *   ④ journal 的正文是空的 ⇒ 显示**日期投影**，不是「无标题」。
 *
 * ⚠️ 写正文（描述）**不该**改引用显示名：地址只有 `_aliases` 一份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Atom, Block } from '../src/core/index.ts'
import { renameAlias, refTitle, resolveRef, resolveRefs, danglingView } from '../src/core/index.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({ id, text, children: [], ...extra })
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

const atom = (extra: Partial<Atom> = {}): Atom => ({
  id: 'a1',
  kind: 'page',
  blockId: 'src',
  start: 0,
  end: 1,
  label: '旧名字',
  ...extra,
})

test('① 目标存在 ⇒ 显示主名叶子，不是插入时的 label 快照', () => {
  const forest = [named('p1', '真正的名字', '一段描述')]
  const a = atom({ label: '旧名字', target: { kind: 'page', id: 'p1' } })
  const v = resolveRef(finder(forest), a)
  assert.equal(v.label, '真正的名字', '主名优先于正文')
  assert.equal(v.state, 'resolved')
})

test('①b 名字带 / ⇒ 引用显示**叶子**（全名仍用于解析）', () => {
  const forest = [named('p1', '项目/设计/规范', '描述')]
  const v = resolveRef(finder(forest), atom({ target: { kind: 'page', id: 'p1' } }))
  assert.equal(v.label, '规范')
})

test('①c 没有名字时才回落到正文', () => {
  const forest = [b('p1', '  正文做名字  ')]
  const v = resolveRef(finder(forest), atom({ target: { kind: 'page', id: 'p1' } }))
  assert.equal(v.label, '正文做名字')
})

test('② 改名传播：改主名 ⇒ 解析结果跟着变，原子本身一个字节都没动', () => {
  const target = named('p1', '甲', '描述')
  const forest = [target]
  const a = atom({ label: '甲', target: { kind: 'page', id: 'p1' } })
  const before = JSON.stringify(a)

  assert.equal(resolveRef(finder(forest), a).label, '甲')
  renameAlias(forest, target, '甲', '乙')
  assert.equal(resolveRef(finder(forest), a).label, '乙')

  // 这条是「靠解析传播，不靠批量改原子」的判据：原子没被回写过
  assert.equal(JSON.stringify(a), before, '改名不该回头改原子')
})

test('②b 写正文（描述）不改引用显示名：地址只有 `_aliases` 一份', () => {
  const target = named('p1', '甲', '旧描述')
  const forest = [target]
  target.text = '新描述'
  assert.equal(
    resolveRef(finder(forest), atom({ target: { kind: 'page', id: 'p1' } })).label,
    '甲',
    '正文是描述，不是名字',
  )
})

test('③ 目标被删 ⇒ dangling ＋ 沿用 label（错指要看得见，不假装解析成功）', () => {
  const forest = [named('p1', '甲')]
  const a = atom({ label: '甲', target: { kind: 'page', id: 'p1' } })
  assert.equal(resolveRef(finder(forest), a).state, 'resolved')

  forest.length = 0
  const v = resolveRef(finder(forest), a)
  assert.equal(v.state, 'dangling')
  assert.equal(v.label, '甲', 'dangling 时显示用户最后见过的名字（fallback）')
})

test('③b 没有 target 的原子 ⇒ dangling（seed 的悬空样本就是这条）', () => {
  const v = resolveRef(finder([]), atom({ label: '这份页面还没写' }))
  assert.equal(v.state, 'dangling')
  assert.equal(v.label, '这份页面还没写')
})

test('④ journal 的正文是空的 ⇒ 显示日期投影，不是「无标题」', () => {
  const forest = [b('j1', '', { props: { _date: '2026-10-20' } })]
  const v = resolveRef(finder(forest), atom({ label: '某天', target: { kind: 'page', id: 'j1' } }))
  assert.equal(v.state, 'resolved')
  assert.ok(/\d{4}/.test(v.label), `应显示日期投影：${v.label}`)
  assert.notEqual(v.label, '无标题')
})

test('④b 没有名字、正文空白的页 ⇒ 兜底「无标题」（不是空字符串）', () => {
  const forest = [b('p1', '   ')]
  const v = resolveRef(finder(forest), atom({ label: 'x', target: { kind: 'page', id: 'p1' } }))
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
  const atoms: Atom[] = [
    { id: 'x', kind: 'page', blockId: 's', start: 0, end: 1, label: '旧甲', target: { kind: 'page', id: 'p1' } },
    { id: 'y', kind: 'page', blockId: 's', start: 2, end: 3, label: '旧乙', target: { kind: 'page', id: 'p2' } },
    { id: 'z', kind: 'page', blockId: 's', start: 4, end: 5, label: '孤的', target: { kind: 'page', id: 'nope' } },
  ]
  const m = resolveRefs(find, atoms)
  assert.equal(m.get('x')?.label, '甲')
  assert.equal(m.get('y')?.label, '乙')
  assert.equal(m.get('z')?.state, 'dangling')
  // 反序取一遍：结果与顺序无关
  assert.equal(resolveRefs(find, [...atoms].reverse()).get('x')?.label, '甲')
})

test('danglingView：占位符还在但原子记录没了时的兜底', () => {
  const v = danglingView('未知原子')
  assert.deepEqual(v, { label: '未知原子', state: 'dangling' })
})
