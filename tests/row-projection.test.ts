/**
 * **可见行投影的失效边界**（`RowProjection` 的纯单测）。
 *
 * 这块逻辑原来住在编辑器里，只能靠探针间验；抽出来之后把四个失效轴逐条钉住：
 *   ① 内容（`revision`）**不**换行数组，只让筛选结果重算；
 *   ② 结构（`structureRevision`）换行集合；
 *   ③ 折叠态（`folded` 换对象）改变可见行但**不**改活块数；
 *   ④ 画不画身体（`withBody`）也参与失效；
 * 外加行索引/行位置/光标链 force 三条读法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, plainText, type Block, type Doc } from '../src/core/index.ts'
import { RowProjection, type RowFilter } from '../src/view/editor/row-projection.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => {
  const b = mkBlock(text)
  b.id = id
  b.children = children
  return b
}

function harness(roots: Block[]) {
  let doc: Doc = { roots }
  let structureRevision = 0
  let revision = 0
  let propsRevision = 0
  let filter: RowFilter | null = null
  let caret: string | null = null
  let withBody = false
  const probe = { rowsCalls: 0, rowsAllCalls: 0 }
  const projection = new RowProjection({
    doc: () => doc,
    revisions: () => ({ structureRevision, revision, propsRevision }),
    filter: () => filter,
    caret: () => caret,
    withBody: () => withBody,
    probe,
  })
  return {
    projection,
    probe,
    setDoc(next: Doc) {
      doc = next
    },
    currentDoc: () => doc,
    contentChanged() {
      revision++
    },
    structureChanged() {
      structureRevision++
    },
    propsChanged() {
      propsRevision++
    },
    setFilter(next: RowFilter | null) {
      filter = next
    },
    setCaret(next: string | null) {
      caret = next
    },
    setWithBody(next: boolean) {
      withBody = next
    },
  }
}

test('① 内容改动不换行数组（行里是活引用），筛选结果才按 revision 重算', () => {
  const root = mk('p', '页面', [mk('c1', '普通'), mk('c2', '含 hit')])
  const h = harness([root])
  const before = h.projection.rows()
  assert.equal(before.length, 3)

  h.contentChanged()
  const after = h.projection.rows()
  assert.equal(after, before, '内容改动复用同一份行数组')
  assert.equal(h.projection.blockCount, 3)

  let calls = 0
  h.setFilter((b) => {
    calls++
    // 不命中给 neutral（当上下文候选），不是 drop——drop 是「连整棵子树排除」的语义
    return plainText(b.content).includes('hit') ? 'keep' : 'neutral'
  })
  const first = h.projection.rows()
  assert.deepEqual(first.map((r) => r.block.id), ['p', 'c2'], '命中行 + 祖先链上下文')
  const callsAfterFirst = calls
  assert.ok(callsAfterFirst > 0)

  assert.equal(h.projection.rows(), first, '无改动时筛选结果按代复用')
  assert.equal(calls, callsAfterFirst, '复用时不重新调判据')

  h.contentChanged()
  h.projection.rows()
  assert.ok(calls > callsAfterFirst, '内容改动让筛选重算')
})

test('② 结构修订换行集合；活块数跟着换代', () => {
  const root = mk('p', '页面', [mk('c1')])
  const h = harness([root])
  assert.equal(h.projection.rows().length, 2)
  assert.equal(h.projection.blockCount, 2)

  root.children.push(mk('c2'))
  h.structureChanged()
  const rows = h.projection.rows()
  assert.deepEqual(rows.map((r) => r.block.id), ['p', 'c1', 'c2'])
  assert.equal(h.projection.blockCount, 3)
})

test('③ 折叠态换对象：可见行减少，但活块数不变', () => {
  const root = mk('p', '页面', [mk('c1'), mk('c2')])
  const h = harness([root])
  assert.equal(h.projection.rows().length, 3)

  h.setDoc({ ...h.currentDoc(), folded: { p: true } })
  assert.deepEqual(h.projection.rows().map((r) => r.block.id), ['p'], '折叠子树不产出可见行')
  assert.equal(h.projection.blockCount, 3, 'flatten 口径含折叠隐藏的块')

  h.setDoc({ ...h.currentDoc(), folded: {} })
  assert.equal(h.projection.rows().length, 3, '展开回来')
})

test('④ 画不画身体参与失效（同一份 Doc 换 withBody 也要重投影）', () => {
  const root = mk('p', '页面', [mk('c1')])
  const h = harness([root])
  const a = h.projection.rows()
  h.setWithBody(true)
  const b = h.projection.rows()
  assert.notEqual(b, a, 'withBody 变 ⇒ 投影换代')
})
test('⑤ 属性改动换行集合：给行内的块激活视图，子块行当场让位（不画两遍）', () => {
  const owner = mk('owner', '容器', [mk('c1'), mk('c2')])
  const h = harness([mk('p', '页面', [owner])])
  h.setWithBody(true)
  assert.deepEqual(h.projection.rows().map((r) => r.block.id), ['p', 'owner', 'c1', 'c2'])

  // 写 _views/_activeView 是 prop op：只推 propsRevision，不推结构与内容修订号
  owner.props = { _views: [{ id: 'v1', kind: 'cards' }], _activeView: 'v1' }
  h.propsChanged()
  assert.deepEqual(
    h.projection.rows().map((r) => r.block.id),
    ['p', 'owner'],
    '子块行让位给视图身体；刷新前后必须是同一批行',
  )
})

test('行索引/行位置/光标链 force', () => {
  const root = mk('p', '页面', [mk('c1', '甲'), mk('c2', '乙')])
  const h = harness([root])
  h.projection.rows()

  assert.equal(h.projection.rowOf('c2')?.depth, 1)
  assert.equal(h.projection.rowPosition('p'), 0)
  assert.equal(h.projection.rowPosition('c1'), 1)
  assert.equal(h.projection.rowPosition('nope'), undefined)

  // 判据全 drop，但光标所在块的祖先链永远算命中
  h.setFilter(() => 'drop')
  h.setCaret('c2')
  const kept = h.projection.rows().map((r) => r.block.id)
  assert.ok(kept.includes('c2'), '正在编辑的块不能被自己的镜头藏掉')
  assert.ok(kept.includes('p'), '它的祖先链一起保留')
})

test('返回的行数组只读复用：rowsAll 与 rows 同一代共享同一份原始数组', () => {
  const root = mk('p', '页面', [mk('c1')])
  const h = harness([root])
  const all = h.projection.rowsAll()
  const visible = h.projection.rows()
  assert.equal(visible, all, '无筛选时两者是同一份数组')
  assert.equal(h.probe.rowsAllCalls, 1)
  assert.equal(h.probe.rowsCalls, 1)
})
