/**
 * **视图配置与记录层**（`core/view.ts`）＋「非大纲视图让位」的两条结构判据。
 *
 * 断言口径尽量贴用户能看见的性质：
 *   · 配置坏了 ⇒ 退回大纲（不是「块打不开」）；
 *   · 视图只回答「怎么看」：删它/换它**一个字节的记录都不碰**；
 *   · children 源的行＝直接子块，容器自己不是行；
 *   · 表头排序只改**显示序**，`children` 顺序不变；
 *   · number 按数值排（不退化成字典序），空值永远最后。
 *
 * ⚠️ 这里刻意不测 UI：`ui/view-table.ts` 的形状由真浏览器冒烟（T151+）验，
 *    单测只钉模型与纯函数——那才是「换个渲染器也不会错」的那一半。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVE_VIEW_PROP,
  VIEWS_PROP,
  activeView,
  activeViewId,
  canonicalViews,
  childrenRecords,
  cloneSubtree,
  defaultColumns,
  isViewRoot,
  isViewsValue,
  listTableOf,
  mkBlock,
  mkPropDef,
  ownFieldIds,
  readViews,
  resolveRows,
  sortListRows,
  sortRecords,
  sourceOf,
  viewNameOf,
  visibleRows,
  withListSort,
  withSort,
  type Block,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'
import { parseWorkspace, WORKSPACE_VERSION } from '../src/core/storage/shape.ts'

/* ------------------------------------------------------------ 夹具 */

const mk = (id: string, text: string, children: Block[] = [], props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children,
  created: 1000,
  modified: 1000,
  ...(props ? { props } : {}),
})

/** 一棵「页 + 5 个子块」的小树，子块带属性定义 id 的值 */
function pageWith5(): { root: Block; defs: Block[] } {
  // `select` 的值是**选项块 id**（选项＝定义块的子块），不是选项名
  const todo = mk('c-todo', '待办')
  const done = mk('c-done', '完成')
  const status = mkPropDef('状态', 'select')
  status.children = [todo, done]
  const score = mkPropDef('评分', 'number')
  const rows = [
    mk('r1', '一', [], { [status.id]: todo.id, [score.id]: 3 }),
    mk('r2', '二', [], { [status.id]: done.id, [score.id]: 10 }),
    mk('r3', '三', [], {}),
    mk('r4', '四', [], { [score.id]: 2 }),
    mk('r5', '五', [], { [score.id]: 9 }),
  ]
  const root = mk('root', '路线图', rows)
  return { root, defs: [status, score] }
}

function kbOf(blocks: Block[]): { kb: MemoryKb; store: BlockStore } {
  const store = new BlockStore(blocks)
  const kb = new MemoryKb(store)
  return { kb, store }
}

/* ------------------------------------------------------------ 读：配置 */

test('readViews：逐项校验，坏项只丢这一项（不抛、不连坐）', () => {
  const b = mk('b', '', [], {
    [VIEWS_PROP]: [
      { id: 'v1', kind: 'table', table: { columns: [{ key: 'title', width: 260 }] } },
      { id: 'v2', kind: 'telepathy' }, // 未知 kind
      { id: 'v1', kind: 'table' }, // 重复 id：丢后者
      { kind: 'table' }, // 没有 id
      'nope', // 不是对象
    ],
  })
  const views = readViews(b)
  assert.deepEqual(
    views.map((v) => v.id),
    ['v1'],
    `只保留能读的那一项：${JSON.stringify(views)}`,
  )
  assert.deepEqual(views[0]!.table?.columns, [{ key: 'title', width: 260 }], '列配置原样留下')
})

test('canonicalViews：只保留 kind 对应的那份子配置（table 不把 board 配置带走）', () => {
  const views = canonicalViews([
    { id: 'v', kind: 'table', table: { columns: [{ key: 'title' }] }, board: { groupBy: 'x' }, name: '表' },
  ])
  assert.equal(views.length, 1)
  assert.equal(views[0]!.board, undefined, 'table 视图不该带着 board 配置')
  assert.deepEqual(views[0]!.table?.columns, [{ key: 'title' }])
  assert.equal(views[0]!.name, '表')
})

test('canonicalViews：查询源 ＋ 思维导图 ⇒ 丢弃（v1 导图只接子树）', () => {
  const q = mk('q', '查询', [], { _query: { where: { all: [] } } })
  const raw = [{ id: 'v-map', kind: 'mindmap' }, { id: 'v-t', kind: 'table' }]
  assert.deepEqual(
    canonicalViews(raw, sourceOf(q)).map((v) => v.id),
    ['v-t'],
    '查询源里不该出现导图（它没有整棵子树可画）',
  )
  const normal = mk('n', '普通块')
  assert.deepEqual(
    canonicalViews(raw, sourceOf(normal)).map((v) => v.id),
    ['v-map', 'v-t'],
    'children 源两种都留',
  )
})

test('activeView：缺失 / 指向不存在的 id ⇒ 大纲（null），不猜第一项', () => {
  const none = mk('a', '')
  assert.equal(activeView(none), null, '没有 _views ⇒ 大纲')
  const dangling = mk('b', '', [], { [VIEWS_PROP]: [{ id: 'v1', kind: 'table' }], [ACTIVE_VIEW_PROP]: 'gone' })
  assert.equal(activeView(dangling), null, '指向不存在的 id ⇒ 大纲')
  assert.equal(activeViewId(dangling), '')
  const ok = mk('c', '', [], { [VIEWS_PROP]: [{ id: 'v1', kind: 'table' }], [ACTIVE_VIEW_PROP]: 'v1' })
  assert.equal(activeView(ok)?.id, 'v1')
  assert.equal(isViewRoot(ok), true, '有激活视图 ⇒ 是视图宿主')
  assert.equal(isViewRoot(none), false, '没有 ⇒ 不是')
  const q = mk('q', '查询', [], { _query: { where: { all: [] } } })
  assert.equal(isViewRoot(q), true, '查询块无论有没有激活视图都是视图宿主')
})

test('viewsBroken 与 isViewsValue：形状判据只有一份（落盘校验与读路径共用）', () => {
  assert.equal(isViewsValue([{ id: 'a' }]), true)
  assert.equal(isViewsValue('x'), false)
  assert.equal(isViewsValue([1]), false, '元素不是对象 ⇒ 不是一份视图列表')
})

test('落盘形状：接受 `_views` / `_activeView`；容器形状坏了判 corrupt', () => {
  const base = (props: Record<string, unknown>) => ({
    version: WORKSPACE_VERSION,
    activeId: 'r',
    savedAt: 1,
    blocks: [{ id: 'r', content: [], children: [], created: 1, modified: 1, props }],
  })
  const ok = parseWorkspace(JSON.stringify(base({ [VIEWS_PROP]: [{ id: 'v', kind: 'table' }], [ACTIVE_VIEW_PROP]: 'v' })))
  assert.equal(ok.status, 'ok', '带视图配置的库要能读')
  const bad = parseWorkspace(JSON.stringify(base({ [VIEWS_PROP]: 'not-a-list' })))
  assert.equal(bad.status, 'corrupt', '`_views` 不是列表 ⇒ 这份字节读不了')
  const badActive = parseWorkspace(JSON.stringify(base({ [ACTIVE_VIEW_PROP]: 42 })))
  assert.equal(badActive.status, 'corrupt', '`_activeView` 不是字符串 ⇒ 同上')
  // 逐项坏（kind 不认识）**不**判 corrupt：读作大纲，块照样打得开
  const softBad = parseWorkspace(JSON.stringify(base({ [VIEWS_PROP]: [{ id: 'v', kind: 'telepathy' }] })))
  assert.equal(softBad.status, 'ok', '一项坏了不该让整个库打不开')
})

test('viewNameOf：用户改过名用他的，没有就按 kind 给默认名', () => {
  assert.equal(viewNameOf({ id: 'a', kind: 'table' }, (k) => `kind:${k}`), 'kind:table')
  assert.equal(viewNameOf({ id: 'a', kind: 'table', name: '  本周  ' }, () => 'x'), '本周')
})

/* ------------------------------------------------------------ 源与记录 */

test('sourceOf：有 `_query` 就是查询源，否则是 children 源', () => {
  const q = mk('q', '', [], { _query: { where: { all: [] } } })
  assert.deepEqual(sourceOf(q), { kind: 'query', blockId: 'q' })
  assert.deepEqual(sourceOf(mk('n', '普通')), { kind: 'children', blockId: 'n' })
})

test('childrenRecords：行＝直接子块，顺序＝children 顺序，容器自己不是一行', () => {
  const { root } = pageWith5()
  const { kb } = kbOf([root])
  const rows = childrenRecords('root', kb)
  assert.deepEqual(
    rows.map((r) => r.block.id),
    ['r1', 'r2', 'r3', 'r4', 'r5'],
    '5 个直接子块＝5 行',
  )
  assert.ok(
    rows.every((r) => r.block.id !== 'root'),
    '容器是表标题，不是一行',
  )
  assert.equal(rows[0]!.path.length, 1, 'children 源的面包屑是 [容器]')
  assert.equal(rows[0]!.path[0]!.id, 'root')
  assert.equal(rows[0]!.title, '一', '标题是正文的纯文本投影')
})

test('childrenRecords：软删的子块不出行（不是显示一片空行）', () => {
  const { root } = pageWith5()
  root.children[2] = { ...root.children[2]!, props: { _deletedAt: 5 } }
  const { kb } = kbOf([root])
  assert.deepEqual(
    childrenRecords('root', kb).map((r) => r.block.id),
    ['r1', 'r2', 'r4', 'r5'],
    '被删的块跳过',
  )
})

test('resolveRows：每条命中都是一行（父子同时命中不折叠）；排除查询块自己', () => {
  const parent = mk('p', '父')
  const child = mk('c', '子')
  const q = mk('q', '查询块')
  const { kb } = kbOf([{ ...parent, children: [child] }, q])
  const rows = resolveRows([{ blockId: 'p' }, { blockId: 'c' }, { blockId: 'q' }, { blockId: 'ghost' }], kb, { excludeId: 'q' })
  assert.deepEqual(
    rows.map((r) => r.block.id),
    ['p', 'c'],
    '父子各一行；查询块自己与找不到的 id 都不出',
  )
  assert.equal(rows[1]!.path[0]!.id, 'p', '命中的面包屑是祖先链（根→父）')
})

/* ------------------------------------------------------------ 列 */

test('defaultColumns：看子块实际拥有的属性（只取一次），一个都没有才给四列默认', () => {
  const { root, defs } = pageWith5()
  const { kb } = kbOf([root, ...defs])
  const cols = defaultColumns('root', kb)
  assert.equal(cols[0]!.key, 'title', '第一列永远是标题')
  const keys = cols.map((c) => c.key)
  assert.ok(keys.includes(defs[0]!.id), `子块的属性要进列：${JSON.stringify(keys)}`)
  assert.ok(keys.includes(defs[1]!.id))

  const empty = mk('e', '空容器', [mk('x', '没有属性')])
  const { kb: kb2 } = kbOf([empty])
  const fallback = defaultColumns('e', kb2).map((c) => c.key)
  assert.deepEqual(fallback, ['title', 'tags', 'children', 'modified'], '没有属性 ⇒ title/tags/children/modified')
})

/* ------------------------------------------------------------ 排序 */

test('sortRecords：number 按数值排（10 在 9 后面），空值永远最后', () => {
  const { root, defs } = pageWith5()
  const { kb } = kbOf([root, ...defs])
  const score = defs[1]!.id
  const asc = sortRecords(childrenRecords('root', kb), [{ by: score, dir: 'asc' }])
  assert.deepEqual(
    asc.map((r) => r.block.id),
    ['r4', 'r1', 'r5', 'r2', 'r3'],
    `2 < 3 < 9 < 10，未填的最后：${asc.map((r) => r.block.id)}`,
  )
  const desc = sortRecords(childrenRecords('root', kb), [{ by: score, dir: 'desc' }])
  assert.deepEqual(
    desc.map((r) => r.block.id),
    ['r2', 'r5', 'r1', 'r4', 'r3'],
    '降序时空值仍在最后（它不是「最大的值」，是「还没有」）',
  )
})

test('sortRecords：相等元素保持来源顺序（稳定），且不产新数组元素', () => {
  const { root, defs } = pageWith5()
  const { kb } = kbOf([root, ...defs])
  const rows = childrenRecords('root', kb)
  const before = rows.map((r) => r.block.id)
  const sorted = sortRecords(rows, [{ by: 'children', dir: 'asc' }])
  assert.deepEqual(
    sorted.map((r) => r.block.id),
    ['r1', 'r2', 'r3', 'r4', 'r5'],
    '全部相等（都没有子块）⇒ 原序',
  )
  assert.deepEqual(rows.map((r) => r.block.id), before, '排序不改入参')
})

test('withSort：写排序列不碰列本身（换序只改一个字段）', () => {
  const view = { id: 'v', kind: 'table' as const, table: { columns: [{ key: 'title', width: 260 }] } }
  const next = withSort(view, [{ by: 'title', dir: 'desc' }])
  assert.deepEqual(next.table?.sort, [{ by: 'title', dir: 'desc' }])
  assert.deepEqual(next.table?.columns, [{ key: 'title', width: 260 }], '列配置原样')
  assert.deepEqual(withSort(next, []).table?.sort, undefined, '取消排序＝删掉那一格，不留空数组')
})

/* ------------------------------------------------------------ 复制与「让位」 */

test('复制：普通块保留 `_views`/`_activeView`（副本的子块也一起复制）；查询块副本一并剔除', () => {
  const normal = mk('n', '容器', [], {
    [VIEWS_PROP]: [{ id: 'v', kind: 'table' }],
    [ACTIVE_VIEW_PROP]: 'v',
  })
  const copy = cloneSubtree(normal).block
  assert.equal(readViews(copy).length, 1, '普通块副本的视图仍然成立')
  assert.equal(activeView(copy)?.id, 'v')

  const q = mk('q', '查询', [], { _query: { where: { all: [] } }, [VIEWS_PROP]: [{ id: 'v', kind: 'table' }], [ACTIVE_VIEW_PROP]: 'v' })
  const qCopy = cloneSubtree(q).block
  assert.equal(qCopy.props?._query, undefined, '副本没有查询源')
  assert.equal(qCopy.props?.[VIEWS_PROP], undefined, '没有源的视图配置也一起剔除')
  assert.equal(qCopy.props?.[ACTIVE_VIEW_PROP], undefined)
})

test('viewRootId：那一行的子块不画（由视图宿主画），且折叠三角不撒谎', () => {
  const { root } = pageWith5()
  const doc = { roots: [root], folded: {} }
  assert.equal(visibleRows(doc).length, 6, '默认：根 ＋ 5 个子块')
  const withView = visibleRows({ ...doc, viewRootId: 'root' })
  assert.equal(withView.length, 1, '有激活视图：正文只画根行')
  assert.equal(withView[0]!.block.id, 'root')
  assert.equal(withView[0]!.hasChildren, false, '此刻子块在别处展开着 ⇒ 不给折叠三角')
  assert.equal(withView[0]!.hidden, false, '根行本身必须可见')
})

test('ownFieldIds 是 defaultColumns 的输入：只认块自己的槽（不扫全库）', () => {
  const { root } = pageWith5()
  const ids = ownFieldIds(root.children[0]!)
  assert.equal(ids.length, 2, `第一行有两个属性：${JSON.stringify(ids)}`)
})

/* ------------------------------------------------------------ 大纲 → 表格（结构映射） */

/** 一棵两层样例树：容器 ＋ 3 个直接子块（表头），它们的孩子就是各列的项 */
function listTree(): Block {
  return mk('root', '产品', [
    mk('r1', '名称', [mk('c11', '键盘'), mk('c12', '鼠标')]),
    mk('r2', '价格', [mk('c21', '399')]),
    mk('r3', '库存', [mk('c31', '12'), mk('c32', '40', [mk('d321', '备注')])]),
  ])
}

test('listTableOf：表头＝一级子块、一列＝它的孩子、行数＝max(每列项数)', () => {
  const root = listTree()
  const { kb } = kbOf([root])
  const table = listTableOf('root', kb)
  assert.equal(table.root?.id, 'root', '表标题＝容器自己（它不是一列）')
  assert.deepEqual(
    table.columns.map((c) => c.id),
    ['r1', 'r2', 'r3'],
    '表头就是直接子块，顺序＝children 顺序',
  )
  assert.equal(table.rows.length, 2, '行数＝最长的那一列（名称 2 项 / 库存 2 项）')
  assert.deepEqual(
    table.rows[0]!.cells.map((c) => c?.block.id ?? null),
    ['c11', 'c21', 'c31'],
    '第 j 行＝每列各取第 j 项（按位置对齐，不按名字）',
  )
  assert.deepEqual(
    table.rows[1]!.cells.map((c) => c?.block.id ?? null),
    ['c12', null, 'c32'],
    '某一列少一项 ⇒ 那一格空着，别的列不错位',
  )
  assert.equal(table.rows[1]!.cells[2]!.children.length, 1, '三级起只做「可展开」，不进主表列')
})

test('listTableOf：软删的表头不出列、软删的项不占行（位置按活着的树对齐）', () => {
  const root = listTree()
  root.children[1] = { ...root.children[1]!, props: { _deletedAt: 5 } }
  const { kb } = kbOf([root])
  const table = listTableOf('root', kb)
  assert.deepEqual(
    table.columns.map((c) => c.id),
    ['r1', 'r3'],
    '被删的表头不出列',
  )
  assert.deepEqual(
    table.rows.map((r) => r.cells.map((c) => c?.block.id ?? null)),
    [
      ['c11', 'c31'],
      ['c12', 'c32'],
    ],
    '剩下的列按活着的树重新对齐',
  )

  const grand = listTree()
  grand.children[0] = {
    ...grand.children[0]!,
    children: [grand.children[0]!.children[0]!, { ...grand.children[0]!.children[1]!, props: { _deletedAt: 5 } }],
  }
  const { kb: kb2 } = kbOf([grand])
  const t2 = listTableOf('root', kb2)
  assert.equal(t2.rows[0]!.cells[0]!.block.id, 'c11', '被删的项跳过（剩下的按位置重新排）')
  assert.equal(t2.rows[1]!.cells[0], null, '名称那一列只剩一项 ⇒ 第 2 行左侧空着')
})

test('sortListRows：按第 k 列只改显示序、空值最后、相等保持 children 顺序；children 顺序一个字节不动', () => {
  const root = listTree()
  const { kb } = kbOf([root])
  const before = root.children.map((c) => c.id)
  const rows = listTableOf('root', kb).rows
  const sorted = sortListRows(rows, { col: 0, dir: 'desc' })
  assert.equal(sorted.length, rows.length, '排序不增不减行')
  assert.deepEqual(
    sorted.map((r) => r.cells[0]!.block.id),
    ['c12', 'c11'],
    '按第 1 列（名称）降序：鼠标 在 键盘 前面（整行跟着走，别的列不错位）',
  )
  assert.equal(sorted[0]!.cells[1], null, '整行一起搬：鼠标那一行在价格列本来就是空的')
  assert.equal(sorted[0]!.cells[2]!.block.id, 'c32', '整行一起搬：同一行的库存仍是 40')
  const byPrice = sortListRows(rows, { col: 1, dir: 'desc' })
  assert.equal(byPrice[0]!.cells[1]!.block.id, 'c21', '有值的行在前')
  assert.equal(byPrice[1]!.cells[1], null, '空值永远最后（降序也一样：它不是「最大值」）')
  assert.deepEqual(root.children.map((c) => c.id), before, '排序不改 children 顺序')
})

test('canonicalViews：结构映射表只留排序（列是位置，不是配置）；查询源里丢弃', () => {
  const views = canonicalViews([
    { id: 'v', kind: 'list-table', list: { sort: { col: 2, dir: 'desc' } }, table: { columns: [{ key: 'title' }] } },
  ])
  assert.equal(views.length, 1)
  assert.deepEqual(views[0]!.list?.sort, { col: 2, dir: 'desc' })
  assert.equal(views[0]!.table, undefined, '结构映射表不该带着平表的列配置')
  assert.equal(canonicalViews([{ id: 'v', kind: 'list-table' }], { kind: 'query', blockId: 'q' }).length, 0, '查询源没有层级可映射')
  assert.deepEqual(withListSort({ id: 'v', kind: 'list-table' }, undefined).list, undefined, '取消排序＝删掉那一格')
})

test('visibleRows：结构映射表激活时整棵子树都不进正文（行与格都在表里）', () => {
  const root = listTree()
  const doc = { roots: [root], folded: {}, viewRootId: 'root' }
  const rows = visibleRows(doc)
  assert.deepEqual(
    rows.map((r) => r.block.id),
    ['root'],
    '只画根行：一级子块（行）与二级子块（格）都不在正文里再画一遍',
  )
  assert.equal(rows[0]!.hasChildren, false, '子块在表里展开着 ⇒ 不给折叠三角')
})
