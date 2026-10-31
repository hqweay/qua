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
import { BlockStore } from '../src/core/store.ts'
import { viewConfigCommands } from '../src/app/commands/views.ts'
import { mountCommands } from '../src/app/commands/mounts.ts'
import type { ViewConfigDeps, MountsDeps } from '../src/app/commands/types.ts'
import type { OwnerStore } from '../src/app/wiring/owners.ts'
import type { Tx } from '../src/core/kb/types.ts'
import type { ViewOwnerData } from '../src/core/view-owner.ts'
import type { MountEntry } from '../src/core/mount.ts'

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

test('addView(board)：没有 select/checkbox 字段 ⇒ 拒绝并提示，不写 `_views`（不是静默消失）', () => {
  const root = mkBlock('')
  root.id = 'root'
  const { d, writes, toasts } = depsOf([root])
  const app = viewConfigCommands(d)

  const id = app.addView({ kind: 'block', blockId: 'root' }, 'board')
  assert.equal(id, '', '建不出来就该返回空串（调用方据此判失败）')
  assert.equal(writes.length, 0, '一个字节都不许写：写了也会被 canonicalViews 丢掉')
  assert.equal(toasts.length, 1, '要说一句话，而不是让用户以为点了没反应')
  assert.match(toasts[0]!, /分组字段/, `提示要指到「缺什么」：${toasts[0]}`)
})

test('addView(board)：有分组字段时照常建，并把分组列写进配置', () => {
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
  assert.equal(views[0]!.kind, 'board')
  assert.equal(views[0]!.board?.groupBy, status.id, '分组列＝那个 select 定义')
  // 写进去的那一份必须能被读路径读回来（否则又是「点了没生效」）
  assert.equal(
    readViews({ ...root, props: { _views: views } }).length,
    1,
    'canonicalViews 认它',
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

/* ------------------------------------------------------------ 在当前块里建查询块 */

function pageWithChild(): { kb: MemoryKb; store: BlockStore; page: Block; child: Block } {
  const child = mkBlock('子块')
  const page = mkBlock('页面')
  page.id = 'page'
  child.id = 'child'
  const divider = mkBlock('')
  divider.id = 'divider'
  divider.props = { _type: 'core/divider' }
  page.children = [child, divider]
  const { kb, store } = kbOf([page])
  return { kb, store, page, child: divider }
}

function insertDeps(blocks: { kb: MemoryKb; store: BlockStore }, runCount = { n: 0 }): { d: ViewConfigDeps; runs: () => number } {
  const { kb } = blocks
  const { owners } = fakeOwners()
  const d: ViewConfigDeps = {
    kb,
    owners,
    run: <R,>(fn: (tx: Tx) => R) => {
      runCount.n += 1
      return kb.tx(fn)
    },
    reloadPage: () => {},
    rootIds: () => [],
    viewShown: () => false,
    activeId: () => 'page',
    openBlock: () => {},
    refreshList: () => {},
    toast: () => {},
  }
  return { d, runs: () => runCount.n }
}

test('insertQueryBlock：普通块 ⇒ 查询块是它的**子块**（锚点＝当前块），后面留一个空块落点', () => {
  const fixture = pageWithChild()
  const { runs, d } = insertDeps(fixture)
  const app = viewConfigCommands(d)

  const id = app.insertQueryBlock('child')
  assert.notEqual(id, '', '要建出查询块')
  const q = fixture.kb.get(id)!
  assert.equal(fixture.kb.parentOf(id)?.id, 'child', '父块＝当前块（$self / 范围才指得回来）')
  assert.equal(fixture.kb.get('child')!.children.length, 2, '查询块 ＋ 落点空块')
  const after = fixture.kb.get('child')!.children
  assert.equal(after[0]!.id, id)
  assert.notEqual(after[1]!.id, id, '查询块后面还留了一个可编辑空块')
  assert.equal(after[1]!.children.length, 0)
  assert.equal(q.props?._query ? true : false, true, '新块带着一份空条件')
  assert.equal(runs(), 1, '一次动作一笔事务（一次撤销）')
})

test('insertQueryBlock：容不下子块的块（组件块／查询块自己）⇒ 插到它后面，不钻进去', () => {
  const fixture = pageWithChild()
  const { d } = insertDeps(fixture)
  const app = viewConfigCommands(d)

  const id = app.insertQueryBlock('divider')
  assert.equal(fixture.kb.parentOf(id)?.id, 'page', '组件块没有子块，查询块落在它后面（同一父块）')
  const siblings = fixture.kb.get('page')!.children.map((b) => b.id)
  assert.deepEqual(siblings.slice(0, 3), ['child', 'divider', id], '紧跟其后')
  assert.equal(fixture.kb.get('divider')!.children.length, 0, '组件块仍然没有子块')

  // 查询块自己是叶子：在它里面再建查询 ⇒ 落在它后面，不是它的子块
  const again = app.insertQueryBlock(id)
  assert.equal(fixture.kb.parentOf(again)?.id, 'page')
  assert.equal(fixture.kb.get(id)!.children.length, 0)
})

/* ------------------------------------------------------------ 提升为查询块 */

test('promote：查询块默认挂到**宿主块**下，且插块与改指针是同一笔事务', () => {
  const host = mkBlock('宿主')
  host.id = 'host'
  const page = mkBlock('页')
  page.id = 'page'
  page.children = [host]
  const { kb } = kbOf([page])

  const before: MountEntry = { id: 't1', kind: 'local', label: '本块引用', spec: { where: { text: '$self' } }, views: [] }
  let entries: MountEntry[] = [before]
  const owners: OwnerStore = {
    read: () => ({ views: [] }),
    write: () => {},
    readBinding: () => null,
    setBindingView: () => {},
    entriesOf: () => entries,
    writeEntries: (_h, next) => {
      entries = [...next]
    },
    writeEntriesIn: (_tx, _h, next) => {
      entries = [...next]
    },
    entryOf: (_h, id) => entries.find((e) => e.id === id),
  }
  let runs = 0
  const d: MountsDeps = {
    kb,
    owners,
    run: <R,>(fn: (tx: Tx) => R) => {
      runs += 1
      return kb.tx(fn)
    },
    activeId: () => 'page',
    toast: () => {},
  }
  const app = mountCommands(d)

  const blockId = app.promoteMountTab({ kind: 'block', blockId: 'host' }, 't1', 'block')
  assert.notEqual(blockId, '', '应建出查询块')
  assert.equal(kb.parentOf(blockId)?.id, 'host', '默认落点是宿主块，不是当前打开的那一页')
  assert.equal(runs, 1, '插块 ＋ 改指针合成一笔事务（一次撤销）')
  const linked = entries[0]!
  assert.equal(linked.kind, 'linked')
  assert.equal(linked.kind === 'linked' ? linked.block : '', blockId, '这一栏改成指向新块')
})
