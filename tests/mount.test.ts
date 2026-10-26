/**
 * **挂载区**（块底的查询 tab）的模型测试。
 *
 * 这里钉的是四件在界面上看不出对错的事：
 *   ① 内置三栏是**派生**的：给宿主打一个标签，「同类」当场出现（不是缓存、不是落盘）；
 *   ② 用户 tab **不是块**：它只是宿主上的一格 `_mounts`，所以复制子树时被剔除，
 *      摘掉一栏也不会带走任何块；
 *   ③ 形状坏掉时**读路径不抛**（落盘那一侧判 corrupt，读只当没有）；
 *   ④ 日记的用户 tab **住一份共享配置、只渲染在今天**（过去的天连加号都不出现）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '../src/core/index.ts'
import {
  canEditMounts,
  cloneSubtree,
  isMountsValue,
  journalMountsBlock,
  journalMountsId,
  mkJournalMountsBlock,
  mkTagBlock,
  MOUNTS_PROP,
  mountTabsOf,
  readMounts,
  userMountsOf,
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
const KINDS = (tabs: { kind: string }[]): string[] => tabs.map((t) => t.kind)

/** 一天的日记 ＋ 一个带标签的宿主（宿主不是日记，走「自己那一格」） */
function fixture() {
  const tag = mkTagBlock('项目')
  const journal = b('j-today', '', { props: { _date: '2026-10-26' } })
  const old = b('j-old', '', { props: { _date: '2026-10-25' } })
  const host = b('h', '宿主块', { props: { _tags: [tag.id] } })
  return { tag, journal, old, host, blocks: [journal, old, host, tag] }
}

const NOW = new Date(2026, 9, 26, 9, 0, 0)

test('U7 「同类」是派生的：给宿主打上标签，tab 当场出现（不是缓存、不落盘）', () => {
  const { host, blocks, tag } = fixture()
  host.props = { ...(host.props ?? {}), _tags: [] }
  assert.deepEqual(KINDS(mountTabsOf(host, blocks, NOW)), ['refs', 'mentions'], '没有标签就没有「同类」')
  host.props = { ...(host.props ?? {}), _tags: [tag.id] }
  assert.equal(KINDS(mountTabsOf(host, blocks, NOW)).includes('same'), true, '打完标签同一份数据立刻有「同类」')
  // 派生 ⇒ 块上一个字节都没多出来
  assert.equal(Object.keys(host.props ?? {}).includes(MOUNTS_PROP), false)
})

test('U8 复制子树不带 `_mounts`：看板配置属于原件', () => {
  const { host } = fixture()
  host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: [{ label: '我的', spec }] }
  const { block } = cloneSubtree(host)
  assert.equal(readMounts(block).length, 0)
  assert.equal(readMounts(host).length, 1, '原件不动')
})

test('U9 `_mounts` 形状坏 ⇒ 读作「没有」且不抛；判据与落盘校验是同一份', () => {
  const { host } = fixture()
  const cases: unknown[] = [
    'not-an-array',
    [{ label: '', spec }],
    [{ label: '甲' }],
    [{ label: '甲', spec: 'nope' }],
    [{ label: '甲' }, { label: '甲', spec }],
    [null],
  ]
  for (const raw of cases) {
    host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: raw }
    assert.deepEqual(readMounts(host), [], `坏形状应读作没有：${JSON.stringify(raw)}`)
    assert.equal(isMountsValue(raw), false)
  }
  host.props = { ...(host.props ?? {}), [MOUNTS_PROP]: [{ label: '甲', spec }] }
  assert.equal(isMountsValue(host.props[MOUNTS_PROP]), true)
})

test('U9b 用户 tab 的 label 与 spec 原样读出（顺序＝数组位）', () => {
  const { host } = fixture()
  host.props = {
    ...(host.props ?? {}),
    [MOUNTS_PROP]: [
      { label: '先', spec },
      { label: '后', spec: { where: { tag: '项目' } } },
    ],
  }
  const tabs = mountTabsOf(host, [host], NOW).filter((t) => t.kind === 'user')
  assert.deepEqual(
    tabs.map((t) => t.label),
    ['先', '后'],
    '顺序只用数组位（挂载项不是子块，没有「真实子序」可用）',
  )
})

test('U10 日记的用户 tab 住共享配置、**只渲染在今天**：过去的天一个都不出现', () => {
  const { journal, old, blocks } = fixture()
  const shared = mkJournalMountsBlock([{ label: '我的日报', spec }])
  const forest = [...blocks, shared]
  assert.equal(journalMountsBlock(forest)?.id, journalMountsId())
  assert.deepEqual(
    userMountsOf(old, forest, NOW).map((t) => t.label),
    [],
    '过去的天只有内置项（也不给加号）',
  )
  assert.deepEqual(
    userMountsOf(journal, forest, NOW).map((t) => t.label),
    ['我的日报'],
    '今天读的是共享配置',
  )
  assert.equal(canEditMounts(old, NOW), false)
  assert.equal(canEditMounts(journal, NOW), true)
})

test('U11 日记的 kind 序列 ＝ 引用 ＋ 提及（它有日期投影、没有标签）', () => {
  const { journal, blocks } = fixture()
  assert.deepEqual(KINDS(mountTabsOf(journal, blocks, NOW)), ['refs', 'mentions'])
})

test('普通块：三栏齐全的条件是「有标签 ＋ 有可读文本」', () => {
  const { host, blocks } = fixture()
  assert.deepEqual(KINDS(mountTabsOf(host, blocks, NOW)), ['refs', 'same', 'mentions'])
  const bare = b('bare', '   ')
  assert.deepEqual(KINDS(mountTabsOf(bare, blocks, NOW)), ['refs'], '既没标签也没可读文本 ⇒ 只剩引用')
})

test('共享配置块：不占地址、不进任何列表，只有一格 `_mounts`', () => {
  const block = mkJournalMountsBlock([{ label: '甲', spec }])
  assert.equal(block.props?._aliases, undefined)
  assert.equal(block.props?._lists, undefined)
  assert.deepEqual(Object.keys(block.props ?? {}), [MOUNTS_PROP])
  assert.equal(readMounts(block)[0]?.label, '甲')
  assert.deepEqual(readMounts(mkJournalMountsBlock()), [], '空配置＝没有用户栏（不留空数组）')
})

test('日记共享配置只有一份：同一天读到的永远是那个派生 id 的块', () => {
  const a = mkJournalMountsBlock([{ label: '甲', spec }])
  const b2 = mkJournalMountsBlock()
  assert.equal(a.id, b2.id)
  assert.equal(a.id, journalMountsId())
})
