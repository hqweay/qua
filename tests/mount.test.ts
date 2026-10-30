/**
 * **挂载区**（块底的 tab 条）的模型测试。
 *
 * 这里钉的是五件在界面上看不出对错的事：
 *   ① 内置三栏是**派生**的：给宿主打一个标签，「同类」当场出现（不是缓存、不是落盘）；
 *   ② **local tab 不是块**：它只是宿主那组条目里的一条（块宿主写 `_mounts`），
 *      摘掉一栏不会带走任何块；
 *   ③ 形状坏掉时**读路径不抛**（落盘那一侧判 corrupt，读只当没有）；
 *   ④ 日记的用户栏住**设备状态**（`Prefs.journalMounts`），且只渲染在今天；
 *   ⑤ **每个 entry 有稳定 id**：数组位只表示顺序，激活项/展开栈按 id 记。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  canEditMounts,
  canonicalMountEntries,
  cloneMountEntries,
  cloneSubtree,
  derivedEntriesOf,
  derivedSpecOf,
  derivedTabId,
  isMountsValue,
  mkTagBlock,
  mkTabId,
  MOUNTS_PROP,
  mountEntriesOf,
  readMounts,
  storedEntriesOf,
  type MountEntry,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'
import type { QuerySpec } from '../src/core/query.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

const spec: QuerySpec = { where: { todo: 'todo' } }
const local = (id: string, label: string, s: QuerySpec = spec): MountEntry => ({
  id,
  kind: 'local',
  label,
  spec: s,
  views: [],
})
/** 内置栏的 `source`（`derived` 栏没有配置，只有它是哪一种） */
const SOURCES = (entries: MountEntry[]): string[] => entries.map((e) => (e.kind === 'derived' ? e.source : e.kind))

/** 一天的日记 ＋ 一个带标签的宿主（宿主不是日记，走「自己那一格」） */
function fixture() {
  const tag = mkTagBlock('项目')
  const journal = b('j-today', '', { props: { _date: '2026-10-26' } })
  const old = b('j-old', '', { props: { _date: '2026-10-25' } })
  const host = b('h', '宿主块', { props: { _tags: [tag.id] } })
  return { tag, journal, old, host, blocks: [journal, old, host, tag] }
}

const NOW = new Date(2026, 9, 26, 9, 0, 0)

test('U7 「同类」是派生的：给宿主打上标签，栏当场出现（不是缓存、不落盘）', () => {
  const { host, blocks, tag } = fixture()
  host.props = { ...(host.props ?? {}), _tags: [] }
  assert.deepEqual(SOURCES(derivedEntriesOf(host, blocks)), ['refs', 'mentions'], '没有标签就没有「同类」')
  host.props = { ...(host.props ?? {}), _tags: [tag.id] }
  assert.equal(
    SOURCES(derivedEntriesOf(host, blocks)).includes('same'),
    true,
    '打完标签同一份数据立刻有「同类」',
  )
  // 派生 ⇒ 块上一个字节都没多出来
  assert.equal(Object.keys(host.props ?? {}).includes(MOUNTS_PROP), false)
})

test('U8 复制子树**带着** `_mounts`（它是内容），但 local 栏的 spec 深拷成独立副本', () => {
  const { host } = fixture()
  host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: [local('t-1', '我的')] }
  const { block } = cloneSubtree(host)
  assert.equal(readMounts(block).length, 1, '复制这一块就该带着它配的那几栏')
  assert.equal(readMounts(host).length, 1, '原件不动')
  const copied = readMounts(block)[0] as Extract<MountEntry, { kind: 'local' }>
  const origin = readMounts(host)[0] as Extract<MountEntry, { kind: 'local' }>
  assert.notEqual(copied.spec, origin.spec, '两份各自演化：改副本不该动到原件')
  assert.deepEqual(copied.spec, origin.spec, '内容一样')
})

test('U9 `_mounts` 形状坏 ⇒ 读作「没有」且不抛；判据与落盘校验是同一份', () => {
  const { host } = fixture()
  const cases: unknown[] = [
    'not-an-array',
    [{ id: 't', kind: 'local', label: '', spec }],
    [{ id: 't', kind: 'local', label: '甲' }],
    [{ id: 't', kind: 'local', label: '甲', spec: 'nope' }],
    [{ id: 't', kind: 'linked' }],
    [{ id: 't', kind: 'telepathy' }],
    [null],
    // 旧的 `{label, spec}`（v28 及以前）不再是合法形状
    [{ label: '甲', spec }],
  ]
  for (const raw of cases) {
    host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: raw }
    assert.deepEqual(readMounts(host), [], `坏形状应读作没有：${JSON.stringify(raw)}`)
    assert.equal(isMountsValue(raw), false)
  }
  host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: [local('t-1', '甲')] }
  assert.equal(isMountsValue(host.props[MOUNTS_PROP]), true)
})

test('U9b 顺序＝数组位；每栏的 label/spec 原样读出', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    [MOUNTS_PROP]: [local('t-1', '先'), local('t-2', '后', { where: { tag: '项目' } })],
  }
  const entries = storedEntriesOf(host)
  assert.deepEqual(
    entries.map((e) => (e.kind === 'local' ? e.label : e.kind)),
    ['先', '后'],
    '顺序只用数组位（挂载项不是子块，没有「真实子序」可用）',
  )
})

test('U9c 稳定 id：缺 id 的项补一个，重复 id 的项丢掉（否则激活态会落到别一栏）', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    [MOUNTS_PROP]: [
      { kind: 'local', label: '没写 id', spec, views: [] },
      local('t-1', '甲'),
      local('t-1', '重复 id 的第二条'),
    ],
  }
  const entries = readMounts(host)
  assert.equal(entries.length, 2, '重复 id 的那条丢掉（两条同 id 的栏会让状态互相覆盖）')
  assert.notEqual(entries[0]!.id, '', '缺 id 的补一个：丢掉会让用户配的那栏整个消失')
  assert.equal(entries[1]!.id, 't-1')
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'id 两两不同')
})

test('U10 日记的用户栏住**设备状态**、只渲染在今天：过去的天一个都不出现', () => {
  const { journal, old } = fixture()
  const prefs: MountEntry[] = [local('t-1', '我的日报')]
  assert.deepEqual(
    mountEntriesOf(old, [old], { journalMounts: prefs, now: NOW }).filter((e) => e.kind !== 'derived'),
    [],
    '过去的天只有内置项（也不给加号）',
  )
  assert.deepEqual(
    mountEntriesOf(journal, [journal], { journalMounts: prefs, now: NOW })
      .filter((e) => e.kind === 'local')
      .map((e) => (e.kind === 'local' ? e.label : '')),
    ['我的日报'],
    '今天读的是设备状态里的那一组',
  )
  assert.equal(canEditMounts(old, NOW), false)
  assert.equal(canEditMounts(journal, NOW), true)
})

test('U10b 日记的栏住在设备状态里 ⇒ **库里一块都不多**（曾经有一个隐藏配置块）', () => {
  const { journal } = fixture()
  const prefs: MountEntry[] = [local('t-1', '我的日报')]
  const entries = mountEntriesOf(journal, [journal], { journalMounts: prefs, now: NOW })
  assert.equal(
    entries.filter((e) => e.kind === 'local').length,
    1,
    '栏读到了',
  )
  // 块上没有那一格：日记的配置根本不是内容
  assert.equal(Object.keys(journal.props ?? {}).includes(MOUNTS_PROP), false, '日记块上不该有 `_mounts`')
})

test('U11 日记的栏序列 ＝ 引用 ＋ 提及（它有日期投影、没有标签）', () => {
  const { journal, blocks } = fixture()
  assert.deepEqual(SOURCES(mountEntriesOf(journal, blocks, { now: NOW })), ['refs', 'mentions'])
})

test('普通块：三栏齐全的条件是「有标签 ＋ 有可读文本」', () => {
  const { host, blocks } = fixture()
  assert.deepEqual(SOURCES(mountEntriesOf(host, blocks, { now: NOW })), ['refs', 'same', 'mentions'])
  const bare = b('bare', '   ')
  assert.deepEqual(SOURCES(mountEntriesOf(bare, blocks, { now: NOW })), ['refs'], '既没标签也没可读文本 ⇒ 只剩引用')
})

test('内置栏的 id 是派生的：同一个宿主、同一个来源 ⇒ 同一个 id（刷新不漂）', () => {
  const { host, blocks } = fixture()
  const a = derivedEntriesOf(host, blocks).map((e) => e.id)
  const b2 = derivedEntriesOf(host, blocks).map((e) => e.id)
  assert.deepEqual(a, b2, '内置栏的 id 不能每次现造')
  assert.equal(a[0], derivedTabId('refs'))
  // 用户栏的 id 每次新发（那是「这一条」的身份）
  assert.notEqual(mkTabId(), mkTabId())
})

test('canonicalMountEntries：`local` 的 views 按 **query 源**校验（面板局部没有树）', () => {
  const entries = canonicalMountEntries([
    { id: 't-1', kind: 'local', label: '甲', spec, views: [{ id: 'v1', kind: 'list-table' }] },
  ])
  assert.equal(entries.length, 1)
  const e = entries[0] as Extract<MountEntry, { kind: 'local' }>
  assert.deepEqual(e.views, [], '结构映射表要一棵树，而 local 栏只有命中集合')
})

test('cloneMountEntries：local 深拷、linked 只拷指针、id 保持（栏的身份不变）', () => {
  const linked: MountEntry = { id: 't-2', kind: 'linked', block: 'q-1', view: '' }
  const src = [local('t-1', '甲'), linked]
  const copy = cloneMountEntries(src)
  assert.deepEqual(
    copy.map((e) => e.id),
    ['t-1', 't-2'],
    'id 是「这一栏」的身份：复制内容不该换掉它',
  )
  assert.notEqual((copy[0] as Extract<MountEntry, { kind: 'local' }>).spec, spec, 'local 的 spec 深拷')
  assert.equal((copy[1] as Extract<MountEntry, { kind: 'linked' }>).block, 'q-1', 'linked 只拷指针')
})

/**
 * **标签块的「同类」＝ 它的成员**。
 *
 * 打开一个标签要看的是「这一支下面有哪些块」——那正是标签页 footer 原来的成员列表。
 * 标签块自己没有 `_tags`（它就是那条轴），所以这条口径必须显式并进去，否则
 * 「成员」这个读法会随着 footer 一起消失（不报错，只是没地方看）。
 */
test('标签块的「同类」用的是它自己的名字：条件＝{tag: 主名}', () => {
  const tag = mkTagBlock('人物')
  const same = derivedSpecOf(tag, [tag], 'same')
  assert.deepEqual(same, { where: { tag: '人物' } }, '只有一个标签时就是它自己那一条')
})

test('兼位块（既带标签又是标签）：两条轴并进同一个条件（any）', () => {
  const a = mkTagBlock('甲')
  const both = { ...mkTagBlock('丙'), props: { _aliases: ['丙'], _lists: ['tag'], _tags: [a.id] } }
  const same = derivedSpecOf(both, [a, both], 'same')
  assert.deepEqual(same, { where: { any: [{ tag: '$self' }, { tag: '丙' }] } }, '两个来源都在：一个条件两半')
})

test('「同类」沿下级标签展开（算作）：#人物 的成员含只打 #演员 的块', () => {
  const 人物 = mkTagBlock('人物')
  const 演员 = mkTagBlock('演员')
  // 归属边：演员 归在 人物 下（任何块都能配，这条边住在子块上）
  const 演员WithEdge = { ...演员, props: { ...(演员.props ?? {}), _belongsTo: [人物.id] } }
  const same = derivedSpecOf(人物, [人物, 演员WithEdge], 'same')
  assert.deepEqual(same, { where: { any: [{ tag: '人物' }, { tag: '演员' }] } })
})
