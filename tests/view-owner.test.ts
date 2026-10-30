/**
 * **拥有者模型**（`core/view-owner.ts`）：谁拥有配置、绑定只存指针、缺省看法按源给。
 *
 * 这一层是「同一批块在两处各有一份配置」的**唯一解**。四条断言对应四种曾经真实发生过的错法：
 *   ① 读回来的配置不是写进去的那个（拥有者解析错）；
 *   ② 写一格把别的字段一起抹掉（`applyOwnerPatch` 整份替换）；
 *   ③ linked tab / 露面自己拥有配置（于是改一处另一处不动）；
 *   ④ 缺省看法按 kind 猜（items 源画出「大纲」——一批引用被当成一棵树）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyOwnerPatch,
  bindingOfEmbed,
  bindingOfLinked,
  canonicalMountEntries,
  defaultKindFor,
  ownerDataOfBlock,
  ownerDataOfTab,
  readViewSet,
  resolveBoundView,
  sourceOfOwner,
  storedKindsFor,
  withBlockOwnerData,
  withLinkedView,
  withTabOwnerData,
  type Block,
  type MountEntry,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'

const mk = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const QUERY = { where: { todo: 'todo' as const } }
const localTab = (over: Partial<Extract<MountEntry, { kind: 'local' }>> = {}): Extract<MountEntry, { kind: 'local' }> => ({
  id: 't-1',
  kind: 'local',
  label: '我的',
  spec: QUERY,
  views: [],
  ...over,
})

/* ------------------------------------------------------------ 缺省看法 */

test('defaultKindFor：children/query 的缺省是**大纲**，items 的是**列表**（它不是树）', () => {
  assert.equal(defaultKindFor({ kind: 'children', blockId: 'a' }), 'outline')
  assert.equal(defaultKindFor({ kind: 'query', spec: QUERY }), 'outline')
  assert.equal(defaultKindFor({ kind: 'items', blockId: 'f' }), 'list', '一批手选的引用画成大纲＝凭空造父子')
})

test('storedKindsFor：结构映射表与导图只接 children（命中集合没有「第 k 个孩子」）', () => {
  assert.ok(storedKindsFor({ kind: 'children', blockId: 'a' }).includes('list-table'))
  assert.ok(storedKindsFor({ kind: 'children', blockId: 'a' }).includes('mindmap'))
  for (const src of [{ kind: 'query' as const, spec: QUERY }, { kind: 'items' as const, blockId: 'f' }]) {
    assert.ok(!storedKindsFor(src).includes('list-table'), `${src.kind} 不该有结构映射表`)
    assert.ok(!storedKindsFor(src).includes('mindmap'), `${src.kind} 不该有导图`)
    assert.ok(storedKindsFor(src).includes('list'), `${src.kind} 有记录列表`)
  }
})

/* ------------------------------------------------------------ 读：拥有者 */

test('ownerDataOfBlock：读 `_query`／`_views`／`_activeView`；查询块的名字不在数据里', () => {
  const q = mk('q', '本页的待办', {
    _query: QUERY,
    _views: [{ id: 'v-1', kind: 'table', table: { columns: [{ key: 'title' }] } }],
    _activeView: 'v-1',
  })
  const data = ownerDataOfBlock(q)
  assert.deepEqual(data.query, QUERY, '查询块的条件就是它的源')
  assert.equal(data.views.length, 1)
  assert.equal(data.activeView, 'v-1')
  assert.equal(data.label, undefined, '块的名字是它的地址，不在这一份数据里')
  assert.equal(readViewSet(data).active?.kind, 'table')
})

test('ownerDataOfTab：只有 local 有配置；linked／derived 返回 null（它们不拥有）', () => {
  const data = ownerDataOfTab(localTab())
  assert.ok(data)
  assert.equal(data!.query?.where !== undefined, true)
  assert.equal(
    ownerDataOfTab({ id: 't-2', kind: 'linked', block: 'q', view: '' }),
    null,
    'linked tab 只有指针，没有配置',
  )
  assert.equal(ownerDataOfTab({ id: 'd-refs', kind: 'derived', source: 'refs' }), null, '内置栏没有配置')
})

test('sourceOfOwner：有 query 就是查询源；否则看块自己的源（收藏／children）', () => {
  const tab = localTab()
  assert.deepEqual(sourceOfOwner({ kind: 'tab', host: { kind: 'block', blockId: 'h' }, tabId: 't-1' }, ownerDataOfTab(tab)!), {
    kind: 'query',
    spec: QUERY,
  })
  const plain = mk('p', '普通块')
  assert.deepEqual(sourceOfOwner({ kind: 'block', blockId: 'p' }, ownerDataOfBlock(plain), plain), {
    kind: 'children',
    blockId: 'p',
  })
})

/* ------------------------------------------------------------ 写：只写给出的字段 */

test('applyOwnerPatch：不传的字段保持原值（改排序不该把条件抹掉）', () => {
  const before = {
    query: QUERY,
    views: [{ id: 'v-1', kind: 'table' as const }],
    activeView: 'v-1',
    label: '我的',
  }
  const after = applyOwnerPatch(before, { views: [{ id: 'v-1', kind: 'table' as const, name: '表' }] })
  assert.deepEqual(after.query, QUERY, '没传 query ⇒ 条件不动')
  assert.equal(after.activeView, 'v-1', '没传 activeView ⇒ 不动')
  assert.equal(after.label, '我的')
  assert.equal(after.views[0]!.name, '表')
})

test('applyOwnerPatch：`activeView: ""` 是**清掉**（回缺省看法），不是「没传」', () => {
  const before = { views: [{ id: 'v-1', kind: 'table' as const }], activeView: 'v-1' }
  assert.equal(applyOwnerPatch(before, { activeView: '' }).activeView, undefined)
  assert.equal(applyOwnerPatch(before, {}).activeView, 'v-1', '`undefined` 才是「没传」')
})

test('withBlockOwnerData：空集合一律删掉那一格（不留空数组）', () => {
  const props = withBlockOwnerData({ _icon: 'lucide:x' }, { views: [], query: QUERY })
  assert.equal(props?._views, undefined, '空视图列表不该留一个 `[]`')
  assert.equal(props?._activeView, undefined)
  assert.deepEqual(props?._query, QUERY)
  assert.equal(props?._icon, 'lucide:x', '别的系统属性原样保留')
  assert.equal(withBlockOwnerData(undefined, { views: [] }), undefined, '什么都不剩 ⇒ 整个属性袋也不要')
})

test('withTabOwnerData：写回 local 条目，id 与名字不丢；views 按 query 源校验', () => {
  const entry = localTab({ views: [{ id: 'v-1', kind: 'table' }] })
  const next = withTabOwnerData(entry, { views: [{ id: 'v-1', kind: 'table' }, { id: 'v-2', kind: 'list-table' }], query: QUERY })
  assert.equal(next.kind, 'local')
  assert.equal((next as Extract<MountEntry, { kind: 'local' }>).id, 't-1', 'id 是这一栏的身份')
  assert.equal((next as Extract<MountEntry, { kind: 'local' }>).label, '我的')
  assert.deepEqual(
    (next as Extract<MountEntry, { kind: 'local' }>).views.map((v) => v.id),
    ['v-1'],
    '结构映射表要一棵树，而 local 栏只有命中集合 ⇒ 丢掉',
  )
})

/* ------------------------------------------------------------ 绑定：只有指针 */

test('bindingOfLinked：解析出「指向哪一块＋哪张视图」；不是 linked ⇒ null', () => {
  const host = { kind: 'block' as const, blockId: 'h' }
  assert.deepEqual(bindingOfLinked({ id: 't-1', kind: 'linked', block: 'q-1', view: 'v-9' }, host), {
    owner: { kind: 'block', blockId: 'q-1' },
    view: 'v-9',
  })
  assert.equal(bindingOfLinked(localTab(), host), null, 'local 栏不是绑定（它自己拥有配置）')
})

test('bindingOfEmbed：`_embed = {block, view}` 就是一次绑定的全部', () => {
  const b = mk('e', '', { _embed: { block: 'a', view: 'outline' } })
  assert.deepEqual(bindingOfEmbed(b), { owner: { kind: 'block', blockId: 'a' }, view: 'outline' })
  assert.equal(bindingOfEmbed(mk('n', '普通')), null)
})

test('withLinkedView：只换指针里的 view，目标与覆盖名不动', () => {
  const entry = { id: 't-1', kind: 'linked' as const, block: 'q-1', view: '', label: '日报' }
  const next = withLinkedView(entry, 'v-2')
  assert.equal(next.block, 'q-1', '目标不动：这是「换这张视图」，不是「换指到谁」')
  assert.equal(next.view, 'v-2')
  assert.equal(next.label, '日报')
})

test('resolveBoundView：`outline`／`""`／具体 id 三种含义分开；id 没了要报降级', () => {
  const data = { views: [{ id: 'v-1', kind: 'table' as const }], activeView: 'v-1' }
  assert.equal(resolveBoundView({ owner: { kind: 'block', blockId: 'q' }, view: 'outline' }, data).view, null)
  assert.equal(resolveBoundView({ owner: { kind: 'block', blockId: 'q' }, view: '' }, data).view?.id, 'v-1')
  const gone = resolveBoundView({ owner: { kind: 'block', blockId: 'q' }, view: 'v-gone' }, data)
  assert.equal(gone.degraded, true, '要能说一句「这张视图已不存在」')
  assert.equal(gone.view?.id, 'v-1', '退回目标自己的默认看法')
})

/* ------------------------------------------------------------ 落盘形状 */

test('canonicalMountEntries：三种 kind 的必填字段各自成立，坏项只丢这一项', () => {
  const entries = canonicalMountEntries([
    { id: 't-1', kind: 'local', label: '甲', spec: QUERY, views: [] },
    { id: 't-2', kind: 'linked', block: 'q-1' },
    { id: 'd-refs', kind: 'derived', source: 'refs' },
    { id: 't-3', kind: 'local', label: '', spec: QUERY }, // 空名字 ⇒ 丢
    { id: 't-4', kind: 'linked', block: '' }, // 没目标 ⇒ 丢
    { id: 'd-x', kind: 'derived', source: 'nope' }, // 未知来源 ⇒ 丢
  ])
  assert.deepEqual(
    entries.map((e) => e.id),
    ['t-1', 't-2', 'd-refs'],
    '坏项不连坐：一栏读不出来不该让整个挂载区消失',
  )
  // `view` 缺席按「跟随目标」（它是「没选」，不是坏形状）
  assert.equal((entries[1] as Extract<MountEntry, { kind: 'linked' }>).view, '')
})
