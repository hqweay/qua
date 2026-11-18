/**
 * **行缓存 → 工作集**：只接新增的块，已加载对象的身份不变。
 *
 * 判据：
 *   · 一个 Doc 的闭包装进来之后，`store` 的块数 = 子树行数（不是库大小）；
 *   · 再装一块**不会**换掉已加载块的对象（本地编辑/选区不会指向旧副本）；
 *   · 先当根装进来、后来父块也装进来 ⇒ 同一对象挂回父下，根集合不剩孤儿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStore } from '../src/core/model/store.ts'
import { Workset } from '../src/core/storage/workset.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import type { RawLibraryRows } from '../src/core/storage/db-rows.ts'

type Row = Record<string, unknown>

function row(id: string, parent: string | null = null, left: string | null = null): Row {
  return { id, parent, left, content: '[]', created: 1, modified: 1 }
}

function rows(blocks: Row[], aliases: Row[] = [], lists: Row[] = []): RawLibraryRows {
  return { blocks, props: [], aliases, lists, meta: {} }
}

function fixture(): { store: BlockStore; ws: Workset } {
  const store = new BlockStore([])
  const ws = new Workset(store)
  return { store, ws }
}

const ids = (blocks: readonly { id: string }[]): string[] => blocks.map((b) => b.id)

test('装一个 Doc：store 只含该子树，别的块不存在', () => {
  const { store, ws } = fixture()
  const roots = ws.loadDoc(
    rows([row('p'), row('a', 'p'), row('b', 'p', 'a'), row('a1', 'a')]),
    ['p'],
  )
  assert.deepEqual(ids(roots), ['p'])
  assert.equal(store.partial, true)
  assert.deepEqual(ids(store.blocks), ['p'])
  assert.deepEqual(ids(store.find('p')!.children), ['a', 'b'])
  assert.deepEqual(ids(store.find('a')!.children), ['a1'])
  assert.equal(store.loadedCount, 4, '闭包 = 子树行数（s 是兄弟，不该进来）')
  assert.equal(store.find('s'), undefined)
  assert.equal(store.isLoaded('s'), false)
})

test('再装一块：已加载块的对象身份不变，新块按行接进工作集', () => {
  const { store, ws } = fixture()
  ws.loadDoc(rows([row('p'), row('a', 'p'), row('b', 'p', 'a')]), ['p'])
  const before = store.find('a')
  assert.ok(before)
  ws.loadBlocks(rows([row('a', 'p'), row('b', 'p', 'a')], [{ block: 'a', name: 'A', pos: 0 }]))
  assert.equal(store.find('a'), before, '同一个 id 不许换成第二个对象')
  assert.equal(store.isLoaded('b'), true)
})

test('先当根装、后装父块：同一对象挂回父下，不留两个副本', () => {
  const { store, ws } = fixture()
  // 一次只装 a：父 p 不在行里 ⇒ a 暂时是根（rowsToWorkspace 的显式兜底）
  ws.loadDoc(rows([row('a', 'p')]), ['a'])
  const a = store.find('a')
  assert.ok(a)
  assert.deepEqual(ids(store.blocks), ['a'])

  ws.loadDoc(rows([row('p'), row('a', 'p'), row('b', 'p', 'a')]), ['p'])
  assert.equal(store.find('a'), a, '父块后到不许换对象')
  assert.deepEqual(ids(store.blocks), ['p'], 'a 不再是根')
  assert.deepEqual(ids(store.find('p')!.children), ['a', 'b'])
  assert.equal(store.loadedCount, 3)
})

test('顶层兄弟按 left 链保持顺序；已加载块重排时按前兄弟插入', () => {
  const { store, ws } = fixture()
  ws.loadDoc(rows([row('p'), row('s', null, 'p')]), ['p', 's'])
  assert.deepEqual(ids(store.blocks), ['p', 's'])
  // p 的子树里先装 b、再装 a（a 排在 b 前）
  ws.loadBlocks(rows([row('b', 'p')]))
  ws.loadBlocks(rows([row('a', 'p'), row('b', 'p', 'a')]))
  assert.deepEqual(ids(store.find('p')!.children), ['a', 'b'])
})


test('全局身份块装载后，同步全局读（pages/tags/propDefs/trash）在工作集模式下正确', () => {
  const { store, ws } = fixture()
  const kb = new MemoryKb(store)
  // 今日文档里的一块（引用了 TAG_A）＋ 全局身份块（页/标签/定义/回收站根）
  ws.loadDoc(
    rows(
      [row('day'), row('note', 'day')],
      [],
    ),
    ['day'],
  )
  ws.loadBlocks(
    rows(
      [
        { id: 'PAGE_X', parent: null, left: null, content: '[]', created: 1, modified: 1 },
        { id: 'TAG_A', parent: null, left: 'PAGE_X', content: '[]', created: 1, modified: 1 },
        { id: 'DEF', parent: null, left: 'TAG_A', content: '[]', created: 1, modified: 1, kind: 'text' },
        { id: 'gone', parent: null, left: 'DEF', content: '[]', created: 1, modified: 1, deleted: 5 },
      ],
      [],
      [
        { block: 'PAGE_X', list: 'page' },
        { block: 'TAG_A', list: 'tag' },
      ],
    ),
  )
  assert.deepEqual(kb.pages().map((b) => b.id), ['PAGE_X'])
  assert.deepEqual(kb.tags().map((b) => b.id), ['TAG_A'])
  assert.deepEqual(kb.propDefs().map((b) => b.id), ['DEF'])
  assert.deepEqual(kb.trash().map((b) => b.id), ['gone'])
  // 成员解析（tagsOf）也吃这份身份块：文档里的块带 _tags ⇒ chip 有名字
  store.find('note')!.props = { _tags: ['TAG_A'] }
  assert.deepEqual(kb.tagsOf('note').map((b) => b.id), ['TAG_A'])
})
