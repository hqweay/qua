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
import type { ViewConfigDeps } from '../src/app/commands/types.ts'
import type { OwnerStore } from '../src/app/wiring/owners.ts'
import type { Tx } from '../src/core/kb/types.ts'
import type { ViewOwnerData } from '../src/core/view-owner.ts'

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
