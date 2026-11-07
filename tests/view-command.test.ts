/**
 * **视图命令的拒绝路径**（`app/commands/views.ts`）。
 *
 * 这里只钉「写不进去的时候有没有说实话」这一类事：命令面能写、读回来被丢掉，
 * 用户看到的就是「点了没生效」——那是静默失败，只有断言能抓住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, mkPropDef, readViews, type Block } from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { viewConfigCommands } from '../src/app/commands/views.ts'
import { VIEW_CONFIG_HANDLERS } from '../src/app/handlers/views.ts'
import type { ViewConfigDeps } from '../src/app/commands/types.ts'
import type { ViewConfig } from '../src/core/index.ts'
import type { OwnerStore } from '../src/app/wiring/owners.ts'
import type { Tx } from '../src/core/kb/types.ts'
import type { ViewOwnerData } from '../src/core/views/view-owner.ts'

const kbOf = (blocks: Block[]): { kb: MemoryKb; store: BlockStore } => {
  const store = new BlockStore(blocks)
  return { kb: new MemoryKb(store), store }
}

/** 只记录写入了什么；命令面只经它写配置 */
function fakeOwners(): { owners: OwnerStore; writes: { owner: unknown; patch: Partial<ViewOwnerData> }[] } {
  const writes: { owner: unknown; patch: Partial<ViewOwnerData> }[] = []
  const owners: OwnerStore = {
    read: () => ({ views: [] }),
    write: (owner, patch) => writes.push({ owner, patch }),
    readBinding: () => null,
    setBindingView: () => {},
    entriesOf: () => [],
    writeEntries: () => {},
    entryOf: () => undefined,
  }
  return { owners, writes }
}

function depsOf(blocks: Block[]): {
  d: ViewConfigDeps
  writes: { owner: unknown; patch: Partial<ViewOwnerData> }[]
  toasts: string[]
} {
  const { kb } = kbOf(blocks)
  const { owners, writes } = fakeOwners()
  const toasts: string[] = []
  const d: ViewConfigDeps = {
    kb,
    owners,
    // 命令层的 TxRun：这里直接跑一遍拿结果，不关心 op 数
    run: <R,>(fn: (tx: Tx) => R) => kb.tx(fn),
    reloadPage: () => {},
    rootIds: () => [],
    // 没有表面在画它（这一层不碰 DOM）⇒ 切视图之后按「打开它」那条路走，这里是空操作
    viewShown: () => false,
    activeId: () => 'root',
    openBlock: () => {},
    refreshList: () => {},
    toast: (text) => toasts.push(text),
  }
  return { d, writes, toasts }
}

test('addView(看板预设)：没有 select/checkbox 属性 ⇒ 拒绝并提示，不写 `_views`（不是静默消失）', () => {
  const root = mkBlock('')
  root.id = 'root'
  const { d, writes, toasts } = depsOf([root])
  const app = viewConfigCommands(d)

  const id = app.addView({ kind: 'block', blockId: 'root' }, 'board')
  assert.equal(id, '', '建不出来就该返回空串（调用方据此判失败）')
  assert.equal(writes.length, 0, '一个字节都不许写：写了也会被 canonicalViews 丢掉')
  assert.equal(toasts.length, 1, '要说一句话，而不是让用户以为点了没反应')
  assert.match(toasts[0]!, /按一个属性分组/, `提示要指到「缺什么」：${toasts[0]}`)
})

test('addView(看板预设)：有分组属性时照常建，落成 `cards` ＋ 顶层分组键（布局从分组键派生）', () => {
  const root = mkBlock('')
  root.id = 'root'
  const status = mkPropDef('状态', 'select')
  const { d, writes } = depsOf([root, status])
  const app = viewConfigCommands(d)

  const id = app.addView({ kind: 'block', blockId: 'root' }, 'board')
  assert.notEqual(id, '', '有 select 字段就该能建')
  assert.equal(writes.length, 1)
  const views = writes[0]!.patch.views ?? []
  assert.equal(views.length, 1)
  assert.equal(views[0]!.kind, 'cards', '看板不是独立的 kind：它是卡片的分组布局')
  assert.equal(views[0]!.groupBy, status.id, '分组列＝那个 select 定义（顶层共用位）')
  assert.deepEqual(views[0]!.cards, { cover: 'none' }, '看板预设默认不画封面位（任务卡上放图是噪声）')
  assert.equal(views[0]!.name, '看板', '默认名按布局取，用户找的还是这个词')
  // 写进去的那一份必须能被读路径读回来（否则又是「点了没生效」）
  assert.equal(
    readViews({ ...root, props: { _views: views } }).length,
    1,
    'canonicalViews 认它',
  )
})

test('addView(画廊预设)：同一张看法、不分组（网格＋封面），与看板是同一 kind', () => {
  const root = mkBlock('')
  root.id = 'root'
  const status = mkPropDef('状态', 'select')
  const { d, writes } = depsOf([root, status])
  const app = viewConfigCommands(d)

  const id = app.addView({ kind: 'block', blockId: 'root' }, 'gallery')
  assert.notEqual(id, '', '画廊不要求任何属性：它只是不分组的卡片')
  const views = writes[0]!.patch.views ?? []
  assert.equal(views[0]!.kind, 'cards')
  assert.equal(views[0]!.groupBy, undefined, '不分组 ⇒ 网格布局')
  assert.deepEqual(views[0]!.cards, { cover: 'first-asset' }, '画廊尝试取正文第一张图做封面')
  assert.equal(views[0]!.name, '画廊')

  // 两个预设落在同一种 kind 上：名字不同，模型只有一种卡片
  app.addView({ kind: 'block', blockId: 'root' }, 'board')
  const boardView = writes.at(-1)!.patch.views?.[0]
  assert.equal(boardView?.kind, 'cards', '看板／画廊是两副面孔，不是两个 kind')
})

test('addView：建视图就给默认名（kind 显示名，撞名加序号）——同 kind 多张从此分得开', () => {
  const root = mkBlock('')
  root.id = 'root'
  const kb = kbOf([root]).kb
  const writes: { owner: unknown; patch: Partial<ViewOwnerData> }[] = []
  const held: ViewConfig[] = []
  // 这条要**有状态**的假拥有者：默认名要撞得上「上一次建的」，read 必须回放写过的 views
  const owners: OwnerStore = {
    read: () => ({ views: held }),
    write: (_owner, patch) => {
      if (patch.views) held.splice(0, held.length, ...patch.views)
      writes.push({ owner: _owner, patch })
    },
    readBinding: () => null,
    setBindingView: () => {},
    entriesOf: () => [],
    writeEntries: () => {},
    entryOf: () => undefined,
  }
  const d: ViewConfigDeps = {
    kb,
    owners,
    run: <R,>(fn: (tx: Tx) => R) => kb.tx(fn),
    reloadPage: () => {},
    rootIds: () => [],
    viewShown: () => false,
    activeId: () => 'root',
    openBlock: () => {},
    refreshList: () => {},
    toast: () => {},
  }
  const app = viewConfigCommands(d)

  app.addView({ kind: 'block', blockId: 'root' }, 'table')
  app.addView({ kind: 'block', blockId: 'root' }, 'table')
  const views = writes.at(-1)!.patch.views ?? []
  assert.equal(views.length, 2)
  assert.deepEqual(
    views.map((v) => v.name),
    ['表格', '表格 2'],
    '名字撞了就加序号，菜单里不再全叫一个名字',
  )
})

/* ------------------------------------------------------------ 切看法之后「要不要换屏」 */

/**
 * 切完看法「屏幕怎么跟上」的判据（`reveal`）。
 *
 * 这条判据两头都能静默失效：一头是把用户正在读的那一屏换成「整屏只有这一块」
 * （还顺手把光标放进那一块）；另一头是什么都不做（点了没生效）。两条都不报错，
 * 所以用注入的两个空操作把「它到底走了哪条路」钉住。
 */
function revealDeps(opts: { roots: readonly string[]; shown: boolean }): { d: ViewConfigDeps; calls: string[] } {
  const page = mkBlock('页')
  page.id = 'page'
  const q = mkBlock('')
  q.id = 'q'
  q.props = { _query: { where: { any: [] } } }
  page.children = [q]
  const { kb } = kbOf([page])
  const { owners } = fakeOwners()
  const calls: string[] = []
  const d: ViewConfigDeps = {
    kb,
    owners,
    run: <R,>(fn: (tx: Tx) => R) => kb.tx(fn),
    reloadPage: () => calls.push('reload'),
    rootIds: () => opts.roots,
    viewShown: () => opts.shown,
    activeId: () => 'page',
    openBlock: (id) => calls.push(`open:${id}`),
    refreshList: () => {},
    toast: () => {},
  }
  return { d, calls }
}

test('setActiveView：身体已经被某个表面画着 ⇒ 就地重画，不换屏、不动光标', () => {
  const { d, calls } = revealDeps({ roots: ['page'], shown: true })
  const app = viewConfigCommands(d)
  assert.equal(app.setActiveView({ kind: 'block', blockId: 'q' }, ''), true)
  assert.deepEqual(calls, [], `有表面在画它就不该换屏／打开：${JSON.stringify(calls)}`)
})

test('setActiveView：没有表面在画它 ⇒ 打开它（不打开就永远看不到结果）', () => {
  const { d, calls } = revealDeps({ roots: ['page'], shown: false })
  const app = viewConfigCommands(d)
  assert.equal(app.setActiveView({ kind: 'block', blockId: 'q' }, ''), true)
  assert.deepEqual(calls, ['open:q'], `没有表面在画它 ⇒ 打开它：${JSON.stringify(calls)}`)
})

test('setActiveView：它是整屏唯一的根 ⇒ 重装这一屏（正文只画根行 ⇄ 恢复子树）', () => {
  const { d, calls } = revealDeps({ roots: ['q'], shown: true })
  const app = viewConfigCommands(d)
  assert.equal(app.setActiveView({ kind: 'block', blockId: 'q' }, ''), true)
  assert.deepEqual(calls, ['reload'], `单根 ⇒ 重装（装载形状变了）：${JSON.stringify(calls)}`)
})

test('setActiveView：它是这一屏的多个根之一 ⇒ 照旧打开它（「给这一天建张表」要看那一屏）', () => {
  const { d, calls } = revealDeps({ roots: ['q', 'other'], shown: true })
  const app = viewConfigCommands(d)
  assert.equal(app.setActiveView({ kind: 'block', blockId: 'q' }, ''), true)
  assert.deepEqual(calls, ['open:q'], `多根之一 ⇒ 打开它：${JSON.stringify(calls)}`)
})

test('setViewFilter：一次动作只写一次（一步撤销）；清掉删键；非查询源当场拒绝', () => {
  const q = mkBlock('查询')
  q.id = 'q'
  q.props = {
    _query: { where: { tag: 'x' } },
    _views: [
      { id: 'v1', kind: 'table', name: '全部' },
      { id: 'v2', kind: 'table', name: '未完成' },
    ],
    _activeView: 'v1',
  }
  const kb = kbOf([q]).kb
  const writes: { owner: unknown; patch: Partial<ViewOwnerData> }[] = []
  const held = readViews(q)
  const toasts: string[] = []
  const owners: OwnerStore = {
    read: () => ({ query: { where: { tag: 'x' } }, views: held, active: 'v1' }),
    write: (_owner, patch) => {
      if (patch.views) held.splice(0, held.length, ...patch.views)
      writes.push({ owner: _owner, patch })
    },
    readBinding: () => null,
    setBindingView: () => {},
    entriesOf: () => [],
    writeEntries: () => {},
    entryOf: () => undefined,
  }
  const d: ViewConfigDeps = {
    kb,
    owners,
    run: <R,>(fn: (tx: Tx) => R) => kb.tx(fn),
    reloadPage: () => {},
    rootIds: () => [],
    viewShown: () => true,
    activeId: () => 'q',
    openBlock: () => {},
    refreshList: () => {},
    toast: (text) => toasts.push(text),
  }
  const app = viewConfigCommands(d)
  const owner = { kind: 'block', blockId: 'q' } as const

  assert.equal(app.setViewFilter(owner, 'v2', { prop: { id: 'p', eq: false } }), true)
  assert.equal(writes.length, 1, '一条命令＝一次写（撤销只回一步）')
  assert.deepEqual(writes[0]!.patch.views?.find((v) => v.id === 'v2')?.filter, {
    prop: { id: 'p', eq: false },
  })
  assert.deepEqual(writes[0]!.patch.views?.find((v) => v.id === 'v1')?.filter, undefined, '只动那一张')

  assert.equal(app.setViewFilter(owner, 'v2', null), true)
  assert.equal(writes.length, 2, '清切片也是同一类一格写入')
  assert.equal(
    'filter' in (writes[1]!.patch.views?.find((v) => v.id === 'v2') ?? {}),
    false,
    '清掉是删键，不留空值',
  )

  // children 源：没有可叠加的条件 ⇒ 拒绝并提示（写进去也会被 canonicalViews 丢掉）
  const plain = mkBlock('普通')
  plain.id = 'n'
  const plainWrites: unknown[] = []
  const plainOwners: OwnerStore = {
    ...owners,
    read: () => ({ views: [] }),
    write: (_owner, patch) => plainWrites.push(patch),
  }
  const app2 = viewConfigCommands({ ...d, owners: plainOwners })
  assert.equal(app2.setViewFilter({ kind: 'block', blockId: 'n' }, 'v', { tag: 'y' }), false)
  assert.equal(plainWrites.length, 0, '拒绝时一个字节都不写')
  assert.equal(toasts.length, 1, '要说一句话')
  assert.match(toasts[0]!, /切片/, `提示要指到切片：${toasts[0]}`)
})

test('set-filter 缺 filter 参数 ⇒ 拒绝且不产生写（不会静默清空切片）', () => {
  const calls: unknown[][] = []
  // handler 只做参数归一；这里用最小门面，只钉「缺参不往下走」这一条
  const gate = {
    setViewFilter: (...args: unknown[]) => {
      calls.push(args)
      return true
    },
  } as unknown as Parameters<(typeof VIEW_CONFIG_HANDLERS)[string]>[1]
  const h = VIEW_CONFIG_HANDLERS['core.view/set-filter']!
  const owner = { kind: 'block', blockId: 'q' } as const

  assert.equal(h({ owner, viewId: 'v2' }, gate), false, '缺 filter 必须拒绝')
  assert.equal(calls.length, 0, '拒绝时不调门面 ⇒ 不产生写')
  assert.equal(h({ owner, viewId: 'v2', filter: undefined }, gate), false, '显式 undefined 也按缺参处理')
  assert.equal(calls.length, 0)

  // 只有显式 null 才是「清掉」，与「没传」分家
  assert.equal(h({ owner, viewId: 'v2', filter: null }, gate), true)
  assert.deepEqual(calls.at(-1), [owner, 'v2', null])
  assert.equal(h({ owner, viewId: 'v2', filter: { tag: 'y' } }, gate), true)
})
