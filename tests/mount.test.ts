/**
 * **挂载区**（块底的 tab 条）的模型测试。
 *
 * 这里钉的是五件在界面上看不出对错的事：
 *   ① 内置栏是**派生**的：给宿主打一个标签，「同类」当场出现（不是缓存、不是落盘）；
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
  derivedRecordsOf,
  derivedSpecOf,
  derivedTemplateOf,
  groupChoicesOf,
  fieldTextOf,
  REF_COUNT_COLUMN,
  MATCHED_COLUMN,
  SHARED_TAGS_COLUMN,
  PATH_COLUMN,
  derivedTabId,
  isMountsValue,
  mkTagBlock,
  mkTabId,
  MOUNTS_PROP,
  mountEntriesOf,
  moveMountEntry,
  readMounts,
  storedEntriesOf,
  type MountEntry,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import type { QuerySpec } from '../src/core/query/query.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

const spec: QuerySpec = { where: { text: '待办' } }
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

test('U7 派生栏按宿主类型常驻：打不打标签，tab 条都不变（数据缺了是空态）', () => {
  const { host, tag } = fixture()
  host.props = { ...(host.props ?? {}), _tags: [] }
  const before = SOURCES(derivedEntriesOf(host))
  assert.deepEqual(before, ['refs', 'notes', 'same', 'mentions'], '没有标签时「同类」也在——空态说明原因')
  host.props = { ...(host.props ?? {}), _tags: [tag.id] }
  assert.deepEqual(SOURCES(derivedEntriesOf(host)), before, '打完标签 tab 条一项都不变')
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

test('备注栏的位置标记是合法形状：新增派生来源漏了落盘闭集 ⇒ 整条 `_mounts` 被判没，用户栏跟着静默消失', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    [MOUNTS_PROP]: [local('t-1', '我的'), { id: 'notes', kind: 'derived', source: 'notes' }],
  }
  assert.equal(isMountsValue(host.props[MOUNTS_PROP]), true, '备注标记不能让整格被判非法')
  assert.deepEqual(SOURCES(readMounts(host)), ['local', 'notes'], '标记与用户栏都原样读回')
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
    mountEntriesOf(old, { journalMounts: prefs, now: NOW }).filter((e) => e.kind !== 'derived'),
    [],
    '过去的天只有内置项（也不给加号）',
  )
  assert.deepEqual(
    mountEntriesOf(journal, { journalMounts: prefs, now: NOW })
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
  const entries = mountEntriesOf(journal, { journalMounts: prefs, now: NOW })
  assert.equal(
    entries.filter((e) => e.kind === 'local').length,
    1,
    '栏读到了',
  )
  // 块上没有那一格：日记的配置根本不是内容
  assert.equal(Object.keys(journal.props ?? {}).includes(MOUNTS_PROP), false, '日记块上不该有 `_mounts`')
})

test('U19 过去的日记天没有用户栏，但顺序跟着那条共享 tab 条（只留位置标记）', () => {
  const { old, journal } = fixture()
  const prefs: MountEntry[] = [
    { id: 'mentions', kind: 'derived', source: 'mentions' },
    { id: 'refs', kind: 'derived', source: 'refs' },
  ]
  // 用户栏只钉了两条位置标记；没标记的派生来源（备注）插在标记之后
  assert.deepEqual(SOURCES(mountEntriesOf(old, { journalMounts: prefs, now: NOW })), ['mentions', 'refs', 'notes'])
  assert.deepEqual(SOURCES(mountEntriesOf(journal, { journalMounts: prefs, now: NOW })), ['mentions', 'refs', 'notes'])
})

test('U11 日记的栏序列 ＝ 引用 ＋ 备注 ＋ 提及（它有日期投影、没有标签）', () => {
  const { journal, blocks } = fixture()
  assert.deepEqual(SOURCES(mountEntriesOf(journal, { now: NOW })), ['refs', 'notes', 'mentions'])
})

test('普通块：四栏常驻（有标签、有可读文本都不再决定 tab 出不出）', () => {
  const { host, blocks } = fixture()
  assert.deepEqual(SOURCES(mountEntriesOf(host, { now: NOW })), ['refs', 'notes', 'same', 'mentions'])
  const bare = b('bare', '   ')
  assert.deepEqual(
    SOURCES(mountEntriesOf(bare, { now: NOW })),
    ['refs', 'notes', 'same', 'mentions'],
    '既没标签也没可读文本 ⇒ 四栏仍在，由空态说原因',
  )
})

test('空态的前置：没有标签／没有可读文本时，那一栏的条件是 `null`（维度不存在）', () => {
  const bare = b('bare', '   ')
  assert.equal(derivedSpecOf(bare, [bare], 'same'), null, '没有 `_tags` ⇒ 同类没有维度')
  assert.equal(derivedSpecOf(bare, [bare], 'mentions'), null, '没有可读文本 ⇒ 提及没有可搜的串')
  const { host, blocks } = fixture()
  assert.notEqual(derivedSpecOf(host, blocks, 'same'), null, '有标签 ⇒ 同类有维度')
  assert.notEqual(derivedSpecOf(host, blocks, 'mentions'), null, '有名字 ⇒ 提及有维度')
})

test('物化模板：条件＝内置 spec，视图带本源默认列；维度不存在 ⇒ null', () => {
  const { host, blocks, tag } = fixture()
  // 引用：条件就是 `{ref:'$self'}`，视图带「次数/类型」列
  const refs = derivedTemplateOf(host, blocks, 'refs')
  assert.deepEqual(refs?.spec, { where: { ref: '$self' } })
  assert.equal(refs?.views.length, 1)
  assert.ok(refs?.views[0]!.table?.columns.some((c) => c.key === REF_COUNT_COLUMN), '引用模板带次数列')
  // 提及：物化的是组合条件（文本 ∧ 非引用），带命中列
  const mentions = derivedTemplateOf(host, blocks, 'mentions')
  assert.deepEqual(mentions?.spec, {
    where: { all: [{ text: '$self' }, { not: { ref: '$self' } }] },
  })
  assert.ok(mentions?.views[0]!.table?.columns.some((c) => c.key === MATCHED_COLUMN), '提及模板带命中列')
  // 成员：条件按标签名现算（物化是快照，改名不追——代价在注释里）
  const members = derivedTemplateOf(tag, blocks, 'members')
  assert.notEqual(members, null, '标签块有成员模板')
  // 维度不存在 ⇒ 没有可物化的东西（调用方不给按钮）
  const bare = b('bare', '   ')
  assert.equal(derivedTemplateOf(bare, [bare], 'same'), null)
  assert.equal(derivedTemplateOf(bare, [bare], 'mentions'), null)
})

test('内置栏的 id 是派生的：同一个宿主、同一个来源 ⇒ 同一个 id（刷新不漂）', () => {
  const { host, blocks } = fixture()
  const a = derivedEntriesOf(host).map((e) => e.id)
  const b2 = derivedEntriesOf(host).map((e) => e.id)
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

test('cloneMountEntries：local 深拷、id 保持；linked 栏已退场（不是合法形状）', () => {
  const src = [local('t-1', '甲')]
  const copy = cloneMountEntries(src)
  assert.deepEqual(copy.map((e) => e.id), ['t-1'], 'id 是「这一栏」的身份：复制内容不该换掉它')
  assert.notEqual((copy[0] as Extract<MountEntry, { kind: 'local' }>).spec, spec, 'local 的 spec 深拷')
  assert.equal(
    isMountsValue([{ id: 't-2', kind: 'linked', block: 'q-1', view: '' }]),
    false,
    '面板查询不指向查询块：linked 栏不再是合法形状',
  )
})

/**
 * **标签块的「成员」＝ 它的成员**，与普通块的「同类」是两个问题。
 *
 * 打开一个标签要看的是「这一支下面有哪些块」；它自己不是「和谁同标签」。
 * 标签页因此先落「成员」，不再先落一个通常为空的「引用」。
 */
test('标签块的「成员」用的是它自己的 id：条件＝{tag: 标签块 id}', () => {
  const tag = mkTagBlock('人物')
  const members = derivedSpecOf(tag, [tag], 'members')
  assert.deepEqual(members, { where: { tag: tag.id } }, '只有一个标签时就是它自己那一条')
  assert.deepEqual(SOURCES(derivedEntriesOf(tag)), ['members', 'refs', 'notes', 'same', 'mentions'], '成员第一')
})

test('兼位块（既带标签又是标签）：成员与同类各答各的', () => {
  const a = mkTagBlock('甲')
  const both = { ...mkTagBlock('丙'), props: { _aliases: ['丙'], _lists: ['tag'], _tags: [a.id] } }
  assert.deepEqual(derivedSpecOf(both, [a, both], 'members'), { where: { tag: both.id } })
  assert.deepEqual(derivedSpecOf(both, [a, both], 'same'), { where: { tag: '$self' } })
})

test('「成员」沿下级标签展开（算作）：#人物 的成员含只打 #演员 的块', () => {
  const 人物 = mkTagBlock('人物')
  const 演员 = mkTagBlock('演员')
  // 归属边：演员 归在 人物 下（任何块都能配，这条边住在子块上）
  const 演员WithEdge = { ...演员, props: { ...(演员.props ?? {}), _belongsTo: [人物.id] } }
  const members = derivedSpecOf(人物, [人物, 演员WithEdge], 'members')
  assert.deepEqual(members, { where: { any: [{ tag: 人物.id }, { tag: 演员.id }] } })
})

/* ------------------------------------------------------------ 派生栏的记录 */

const { MemoryKb } = await import('../src/core/kb/memory.ts')
const { BlockStore } = await import('../src/core/model/store.ts')
const { mountCommands } = await import('../src/app/commands/mounts.ts')

test('派生栏记录：引用按**块**计次数（同一块引两处也只一行）；路径是祖先链', async () => {
  const tag = mkTagBlock('项目')
  const host = b('h', '被引用的块', { props: { _tags: [tag.id] } })
  const page = b('page', '页面', { children: [host] })
  const src = b('src', '引用它', { children: [] })
  src.content.push({ id: 'r1', t: 'ref', to: 'h', label: '被引用的块' })
  src.content.push({ id: 'r2', t: 'ref', to: 'h', label: '被引用的块' })
  const store = new BlockStore([page, src, tag] as Block[])
  const kb = new MemoryKb(store)

  const refs = derivedRecordsOf(kb.get('h')!, kb, 'refs')
  assert.equal(refs.length, 1, `一块引用两处也只一行（引用是块粒度）：${JSON.stringify(refs.map((r) => r.block.id))}`)
  assert.equal(refs[0]!.block.id, 'src')
  assert.equal(fieldTextOf(refs[0]!, REF_COUNT_COLUMN), '2', '同一块里的两处算**次数**')
  assert.equal(fieldTextOf(refs[0]!, PATH_COLUMN), '', '顶层块没有可写的祖先路径')
  // 不把宿主自己算进「谁引用了我」
  assert.equal(refs.every((r) => r.block.id !== 'h'), true)

  void derivedSpecOf
})

test('派生栏记录：提及填命中词、同类填共同标签；两者都不改块（零落盘）', async () => {
  const tagA = mkTagBlock('项目')
  const tagB = mkTagBlock('人物')
  const host = b('h', '共同词', { props: { _tags: [tagA.id] } })
  const mention = b('m', '这句里提到共同词', { props: { _tags: [tagA.id, tagB.id] } })
  const store = new BlockStore([host, mention, tagA, tagB] as Block[])
  const kb = new MemoryKb(store)

  const mentions = derivedRecordsOf(kb.get('h')!, kb, 'mentions')
  assert.deepEqual(mentions.map((r) => r.block.id), ['m'])
  assert.equal(fieldTextOf(mentions[0]!, MATCHED_COLUMN), '共同词')

  const same = derivedRecordsOf(kb.get('h')!, kb, 'same')
  assert.equal(same.length, 1)
  assert.equal(fieldTextOf(same[0]!, SHARED_TAGS_COLUMN), '项目', '只列交集（人物只有对面有）')

  // 派生值不写回块：同一个 kb 再读，块上没有任何新属性
  assert.deepEqual(Object.keys(kb.get('m')!.props ?? {}), ['_tags'])
})

/* ------------------------------------------------------------ 改名（`core.mount/rename`）*/

/** 只记账的拥有者：条目住在内存里，写入被记下来（模型：块宿主 `_mounts`／日记宿主设备状态） */
function renameFixture(entries: MountEntry[]) {
  let list = [...entries]
  const writes: MountEntry[][] = []
  /**
   * 这一格是**内容**：命令的「整条 tab 条」从块上读（`mountEntriesOf`），
   * 所以夹具必须把 `entries` 同步到块上、每次写入再写回去——只改 `owners` 的那份
   * 会让「跨组换序」读到一条没有用户栏的列表。
   */
  const hostBlock = b('h', '宿主', { props: { [MOUNTS_PROP]: [...entries] } })
  const owners = {
    read: () => ({ views: [] }),
    write: () => {},
    readBinding: () => null,
    setBindingView: () => {},
    entriesOf: () => list,
    writeEntries: (_host: unknown, next: readonly MountEntry[]) => {
      list = [...next]
      writes.push(list)
      hostBlock.props = { ...(hostBlock.props ?? {}), [MOUNTS_PROP]: [...next] }
    },
    entryOf: (_host: unknown, id: string) => list.find((e) => e.id === id),
  }
  const store = new BlockStore([hostBlock])
  const kb = new MemoryKb(store)
  const commands = mountCommands({
    kb,
    owners: owners as never,
    run: (<R,>(fn: (tx: never) => R) => ({ ops: [], result: fn(undefined as never) })) as never,
    activeId: () => 'h',
    toast: () => {},
  })
  return { commands, writes, list: () => list }
}

test('U12 改名：只改 local 栏的 label；一条写入；别的栏原样', () => {
  const entries: MountEntry[] = [local('t1', '新查询'), local('t2', '另一栏'), { id: 'd-refs', kind: 'derived', source: 'refs' }]
  const f = renameFixture(entries)
  assert.equal(f.commands.renameMountTab({ kind: 'block', blockId: 'h' }, 't1', '  只看甲  '), true)
  assert.equal(f.writes.length, 1, '一次动作一笔写入')
  assert.deepEqual(
    f.list().map((e) => (e.kind === 'local' ? e.label : e.id)),
    ['只看甲', '另一栏', 'd-refs'],
    '首尾空格去掉；顺序与别的栏不变',
  )
})

test('U12b 改名拒绝三条：派生栏没有名字可改／空名字／不存在的 id —— 都不写', () => {
  const entries: MountEntry[] = [local('t1', '新查询'), { id: 'd-refs', kind: 'derived', source: 'refs' }]
  const f = renameFixture(entries)
  assert.equal(f.commands.renameMountTab({ kind: 'block', blockId: 'h' }, 'd-refs', '乱改'), false, '派生栏的文案由来源字典给')
  assert.equal(f.commands.renameMountTab({ kind: 'block', blockId: 'h' }, 't1', '   '), false, '空名字')
  assert.equal(f.commands.renameMountTab({ kind: 'block', blockId: 'h' }, 'nope', '有名字'), false, '不存在的 id')
  assert.equal(f.writes.length, 0, '拒绝 = 零写入（不产生可撤销的半截）')
})

/* ------------------------------------------------------------ 换序（`core.mount/move`）*/

test('U13 换序：前/后都落在正确的那一格（含「往后挪」——目标下标要按摘掉之后的数组算）', () => {
  const list: MountEntry[] = [local('a', 'A'), local('b', 'B'), local('c', 'C'), local('d', 'D')]
  const ids = (x: MountEntry[] | null) => (x ?? []).map((e) => e.id)

  assert.deepEqual(ids(moveMountEntry(list, 'd', 'a', 'before')), ['d', 'a', 'b', 'c'], '拖到最前')
  assert.deepEqual(ids(moveMountEntry(list, 'd', 'a', 'after')), ['a', 'd', 'b', 'c'], '落在前一格之后')
  assert.deepEqual(ids(moveMountEntry(list, 'a', 'c', 'after')), ['b', 'c', 'a', 'd'], '往后挪：落在 C 之后')
  assert.deepEqual(ids(moveMountEntry(list, 'b', 'd', 'before')), ['a', 'c', 'b', 'd'], '往后挪：落在 D 之前')
  assert.deepEqual(ids(list), ['a', 'b', 'c', 'd'], '原数组不被改（纯函数）')
})

test('U13b 换序拒绝：同一个 id／不存在的 id ⇒ null（没变化就不该写）', () => {
  const list: MountEntry[] = [local('a', 'A'), local('b', 'B')]
  assert.equal(moveMountEntry(list, 'a', 'a', 'after'), null)
  assert.equal(moveMountEntry(list, 'a', 'nope', 'after'), null)
  assert.equal(moveMountEntry(list, 'nope', 'a', 'before'), null)
})

test('U13c 命令面：一次换序＝一条写入；没变化＝false 且零写入', () => {
  const entries: MountEntry[] = [local('a', 'A'), local('b', 'B'), local('c', 'C')]
  const f = renameFixture(entries)
  assert.equal(f.commands.moveMountTab({ kind: 'block', blockId: 'h' }, 'c', 'a', 'before'), true)
  assert.equal(f.writes.length, 1, '一次换序一笔写入（一次撤销）')
  assert.deepEqual(f.list().map((e) => e.id), ['c', 'a', 'b'])

  assert.equal(f.commands.moveMountTab({ kind: 'block', blockId: 'h' }, 'a', 'a', 'before'), false)
  assert.equal(f.commands.moveMountTab({ kind: 'block', blockId: 'h' }, 'a', 'nope', 'before'), false)
  assert.equal(f.writes.length, 1, '没变化不产生可撤销的空动作')
})

/* ------------------------------------------------------------ 整条 tab 条的顺序（派生与用户栏可交错）*/

test('U14 合并：没标记＝派生在前；有标记＝数组位就是整条顺序（可交错）', () => {
  const { host } = fixture()
  assert.deepEqual(SOURCES(mountEntriesOf(host, { now: NOW })), ['refs', 'notes', 'same', 'mentions'], '没拖过：内置在前')
  host.props = {
    ...(host.props ?? {}),
    [MOUNTS_PROP]: [
      local('t-1', '我的'),
      { id: 'refs', kind: 'derived', source: 'refs' },
      { id: 'mentions', kind: 'derived', source: 'mentions' },
    ],
  }
  assert.deepEqual(
    SOURCES(mountEntriesOf(host, { now: NOW })),
    ['local', 'refs', 'mentions', 'notes', 'same'],
    '用户栏可以排在内置栏之前；没提到的派生来源按规范序插在最后一个派生标记之后',
  )
})

test('U15 标记指向的来源不存在 ⇒ 跳过但留住；来源回来时回原位', () => {
  const host = b('h2', '块', {
    props: {
      [MOUNTS_PROP]: [
        { id: 'members', kind: 'derived', source: 'members' },
        { id: 'refs', kind: 'derived', source: 'refs' },
      ],
    },
  })
  assert.deepEqual(SOURCES(mountEntriesOf(host, { now: NOW })), ['refs', 'notes', 'same', 'mentions'], '普通块没有成员：跳过')
  host.props = { ...(host.props ?? {}), _lists: ['tag'] }
  assert.deepEqual(
    SOURCES(mountEntriesOf(host, { now: NOW })),
    ['members', 'refs', 'notes', 'same', 'mentions'],
    '变成标签块：成员回第一位（标记一个字节没丢）',
  )
})

test('U16 新出现的派生来源插在最后一个派生标记之后，不抢用户栏钉在最前的位置', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    _tags: [],
    [MOUNTS_PROP]: [local('t-1', '我的'), { id: 'refs', kind: 'derived', source: 'refs' }],
  }
  assert.deepEqual(
    SOURCES(mountEntriesOf(host, { now: NOW })),
    ['local', 'refs', 'notes', 'same', 'mentions'],
    'same 是新出现的（原先没标签）：落在 refs 之后，用户栏仍在最前',
  )
})

test('U17 命令面：把用户栏拖到派生栏之前 ⇒ 整条列表物化进 `_mounts`（一次写入）', () => {
  const f = renameFixture([local('t1', '我的')])
  assert.equal(f.commands.moveMountTab({ kind: 'block', blockId: 'h' }, 't1', 'refs', 'before'), true)
  assert.equal(f.writes.length, 1, '一次换序一笔写入')
  assert.deepEqual(
    SOURCES(f.list()),
    ['local', 'refs', 'notes', 'same', 'mentions'],
    '用户栏排到引用前面（跨组）；顺序写进内容那一格',
  )
  assert.equal(f.commands.moveMountTab({ kind: 'block', blockId: 'h' }, 'mentions', 'refs', 'before'), true)
  assert.deepEqual(
    SOURCES(f.list()),
    ['local', 'mentions', 'refs', 'notes', 'same'],
    '已物化之后，再挪派生栏仍是整条列表（备注栏没标记，随物化一起进位置标记）',
  )
})

test('U18 摘栏只认 local：派生标记不可摘（不是偷偷实现「隐藏内置栏」）', () => {
  const f = renameFixture([local('t1', '我的'), { id: 'refs', kind: 'derived', source: 'refs' }])
  assert.equal(f.commands.removeMountTab({ kind: 'block', blockId: 'h' }, 'refs'), false)
  assert.equal(f.writes.length, 0, '拒绝 = 零写入')
  assert.equal(f.commands.removeMountTab({ kind: 'block', blockId: 'h' }, 't1'), true)
  assert.deepEqual(f.list().map((e) => e.id), ['refs'], '摘 local 只摘那一条，标记留着')
})

/* ------------------------------------------------------------ 原地物化与分组候选 */

test('原地物化：local 栏占用内置栏稳定 id ⇒ 替换那一栏，不是一栏变两栏', () => {
  const { host, blocks } = fixture()
  // 物化「引用」：id 用内置栏的稳定 id
  const localRefs = local(derivedTabId('refs'), '反链')
  host.props = { ...(host.props ?? {}), _mounts: [localRefs] }
  const entries = mountEntriesOf(host, { now: NOW })
  const ids = entries.map((e) => e.id)
  assert.deepEqual(
    ids.filter((x) => x === 'refs'),
    ['refs'],
    '同一 id 只出现一次：内置栏被替换',
  )
  // 顺序：物化的 local 站在它顶替那一栏的原位，不是跳到条末
  assert.deepEqual(ids, ['refs', 'notes', 'same', 'mentions'])
  assert.deepEqual(SOURCES(entries), ['local', 'notes', 'same', 'mentions'])
})

test('原地物化＋已拖过：物化的 local 顶在标记的原位', () => {
  const { host } = fixture()
  // 拖过 ⇒ 每个派生来源都有一条位置标记；物化「引用」时 local 顶进它那条标记的存储位
  host.props = {
    ...(host.props ?? {}),
    _mounts: [
      { id: 'same', kind: 'derived', source: 'same' },
      local(derivedTabId('refs'), '反链'),
      { id: 'mentions', kind: 'derived', source: 'mentions' },
    ],
  }
  const ids = mountEntriesOf(host, { now: NOW }).map((e) => e.id)
  assert.deepEqual(ids, ['same', 'refs', 'mentions', 'notes'], '「引用」顶在标记的位置；没标记的备注在标记段之后')
})

test('原地物化＋部分标记：没标记带位的物化栏与缺失来源一起按规范序插在标记段之后', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    _mounts: [{ id: 'same', kind: 'derived', source: 'same' }, local(derivedTabId('mentions'), '提及')],
  }
  const ids = mountEntriesOf(host, { now: NOW }).map((e) => e.id)
  assert.deepEqual(ids, ['same', 'refs', 'notes', 'mentions'], '没有标记的物化栏与「重排后才出现的来源」同一落点')
})

test('U17.5 命令面：物化撞位置标记 ⇒ 顶进原位（一次写入，不与标记同 id 共存）', () => {
  // 先把「同类」拖到最前：整条列表已物化成标记（U17 的写法）
  const f = renameFixture([
    { id: 'same', kind: 'derived', source: 'same' },
    { id: 'refs', kind: 'derived', source: 'refs' },
    { id: 'mentions', kind: 'derived', source: 'mentions' },
  ])
  const tabId = f.commands.addLocalTab(
    { kind: 'block', blockId: 'h' },
    '反链',
    { where: { ref: '$self' } } as QuerySpec,
    [],
    '',
    derivedTabId('refs'),
  )
  assert.equal(tabId, 'refs', 'id 不被标记挤成随机 id')
  assert.equal(f.writes.length, 1, '一次物化一笔写入')
  // 标记被 local 顶替，存储位不变
  assert.deepEqual(f.list().map((e) => e.id), ['same', 'refs', 'mentions'])
  const hostBlock = b('h', '宿主', { props: { [MOUNTS_PROP]: [...f.list()] } })
  assert.deepEqual(mountEntriesOf(hostBlock, { now: NOW }).map((e) => e.id), ['same', 'refs', 'mentions', 'notes'])
})

test('U17.6 命令面：物化撞另一条 local ⇒ 回退随机 id（不产生同 id 栏）', () => {
  const f = renameFixture([local('t1', '我的')])
  const tabId = f.commands.addLocalTab(
    { kind: 'block', blockId: 'h' },
    '反链',
    { where: { ref: '$self' } } as QuerySpec,
    [],
    '',
    't1',
  )
  assert.notEqual(tabId, 't1')
  assert.equal(f.list().filter((e) => e.id === 't1').length, 1, '旧栏原样')
})

test('分组候选：只认这批结果里出现过的栏，按覆盖率排序，多值带标记', () => {
  const mkRecord = (values: Record<string, unknown>) =>
    ({ block: b('r', 'x'), path: [], values }) as never
  const records = [mkRecord({ p1: 1, _tags: ['t'] }), mkRecord({ p1: 2 }), mkRecord({})]
  const choices = groupChoicesOf(records, {
    fields: [{ id: 'p1', label: '优先级' }],
    cardinalityOf: () => 'one',
  })
  assert.deepEqual(
    choices.map((c) => [c.key, c.count, c.multi]),
    [
      ['p1', 2, false],
      ['_tags', 1, true],
    ],
    '按覆盖率排序；不在 fields 里的属性键不进候选',
  )
})
