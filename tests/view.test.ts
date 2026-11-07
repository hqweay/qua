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
  cardLayoutOf,
  childrenRecords,
  cloneSubtree,
  defaultColumnsForSource,
  defaultWidthOf,
  fieldTextOf,
  hasTabsBody,
  isMultiValueKey,
  MATCHED_COLUMN,
  PATH_COLUMN,
  REF_COUNT_COLUMN,
  SHARED_TAGS_COLUMN,
  sortValueOf,
  isViewRoot,
  isViewsValue,
  listTableOf,
  mkBlock,
  mkPropDef,
  ownFieldIds,
  readViews,
  removeView,
  renameView,
  resolveRows,
  slicedSpec,
  sortListRows,
  sortRecords,
  sourceOf,
  sourceConflicts,
  structureGroupsOf,
  upsertView,
  viewNameOf,
  visibleRows,
  withCover,
  withFilter,
  withGroup,
  withTabsDirection,
  withListSort,
  withSort,
  withStructureGroup,
  type Block,
  type ViewConfig,
  type ViewRecord,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/model/store.ts'
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

test('canonicalViews：只保留 kind 对应的那份子配置（table 不把卡片配置带走）', () => {
  const views = canonicalViews(
    [{ id: 'v', kind: 'table', table: { columns: [{ key: 'title' }] }, cards: { cover: 'none' }, name: '表' }],
    { kind: 'children', blockId: 'n' },
  )
  assert.equal(views.length, 1)
  assert.equal(views[0]!.cards, undefined, 'table 视图不该带着卡片配置')
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

test('sourceOf：`_query` ⇒ 查询源；否则 children 源', () => {
  const q = mk('q', '', [], { _query: { where: { all: [] } } })
  assert.deepEqual(sourceOf(q), { kind: 'query', spec: { where: { all: [] } } })
  assert.deepEqual(sourceOf(mk('n', '普通')), { kind: 'children', blockId: 'n' })
})

test('sourceOf：两种源声明互斥（`_query`／`_embed` 只许有一个）', () => {
  const q = mk('q', '', [], { _query: { where: { all: [] } } })
  assert.equal(sourceConflicts(q), false, '只有一个源 ⇒ 不冲突')
  // 露面指针 ＋ 查询 并存 ⇒ 冲突：`sourceOf` 会悄悄选一个，另一个「改了却不生效」
  assert.equal(sourceConflicts({ ...q, props: { ...q.props, _embed: { block: 'x', view: '' } } }), true)
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

test('defaultColumnsForSource：children 源看子块实际拥有的属性（只取一次），一个都没有才给四列默认', () => {
  const { root, defs } = pageWith5()
  const { kb } = kbOf([root, ...defs])
  const cols = defaultColumnsForSource({ kind: 'children', blockId: 'root' }, kb)
  assert.equal(cols[0]!.key, 'title', '第一列永远是标题')
  const keys = cols.map((c) => c.key)
  assert.ok(keys.includes(defs[0]!.id), `子块的属性要进列：${JSON.stringify(keys)}`)
  assert.ok(keys.includes(defs[1]!.id))

  const empty = mk('e', '空容器', [mk('x', '没有属性')])
  const { kb: kb2 } = kbOf([empty])
  const fallback = defaultColumnsForSource({ kind: 'children', blockId: 'e' }, kb2).map((c) => c.key)
  assert.deepEqual(fallback, ['title', 'tags', 'children', 'modified'], '没有属性 ⇒ title/tags/children/modified')
})

test('保留列 path／refCount／matched／sharedTags：文本与排序值都认它们', () => {
  const page = mk('p', '路线图')
  const mid = mk('m', '第一季')
  const rec: ViewRecord = {
    block: mk('r', '做一件事', [], { created: 1000, modified: 2_000 }),
    path: [page, mid],
    title: '做一件事',
    tags: [],
    values: {},
    derived: { [REF_COUNT_COLUMN]: 3, [MATCHED_COLUMN]: '做这件事', [SHARED_TAGS_COLUMN]: ['甲', '乙'] },
  }
  assert.equal(fieldTextOf(rec, PATH_COLUMN), '路线图 / 第一季', '路径＝祖先显示名拼接（不含自己）')
  assert.equal(fieldTextOf(rec, REF_COUNT_COLUMN), '3', '引用次数按数转文本')
  assert.equal(fieldTextOf(rec, MATCHED_COLUMN), '做这件事', '命中词原样')
  assert.equal(fieldTextOf(rec, SHARED_TAGS_COLUMN), '甲 乙', '共同标签按空格连接')
  assert.deepEqual(sortValueOf(rec, REF_COUNT_COLUMN), 3, '引用次数排序值是数字（不是串）')

  // 没有派生值时给空串而不是 0：0 次引用与「这个源不提供这一列」是两件事
  const bare: ViewRecord = { ...rec, derived: undefined }
  assert.equal(fieldTextOf(bare, REF_COUNT_COLUMN), '')
  assert.equal(fieldTextOf(bare, MATCHED_COLUMN), '')
  assert.equal(fieldTextOf(bare, SHARED_TAGS_COLUMN), '')

  // 引用次数按数值排（9 < 10；按串排会得到 10 < 9）
  const nine = { ...bare, block: mk('n', '九'), derived: { [REF_COUNT_COLUMN]: 9 } }
  const ten = { ...bare, block: mk('t', '十'), derived: { [REF_COUNT_COLUMN]: 10 } }
  assert.deepEqual(
    sortRecords([ten, nine], [{ by: REF_COUNT_COLUMN, dir: 'asc' }]).map((r) => r.block.id),
    ['n', 't'],
  )
  assert.ok(defaultWidthOf(PATH_COLUMN) >= 140 && defaultWidthOf(REF_COUNT_COLUMN) >= 60, '保留列要有能看的默认宽度')
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

test('bodyHosts：容器型（页签）的身体替换子块行——判据给了才让位', () => {
  const { root } = pageWith5()
  root.props = { ...root.props, [VIEWS_PROP]: [{ id: 'v', kind: 'tabs' }], [ACTIVE_VIEW_PROP]: 'v' }
  const doc = { roots: [root], folded: {} }
  // 没有画身体的编辑器（不给判据）：子块照常画——不画身体的里层编辑器靠这条不丢内容
  assert.equal(visibleRows(doc).length, 6, '不给判据：子块照常画')
  // 给了判据（这一屏真会画页签身体）：只画根行，子块行让位
  const rows = visibleRows(doc, { bodyHosts: hasTabsBody })
  assert.equal(rows.length, 1, '页签身体替换子块行')
  assert.equal(rows[0]!.block.id, 'root')
  assert.equal(rows[0]!.hasChildren, false, '子块在身体里 ⇒ 不给子块折叠三角')
  // 记录型的激活视图（表格）不算：身体不替换，子块照常画
  root.props![ACTIVE_VIEW_PROP] = ''
  root.props![VIEWS_PROP] = [{ id: 'v2', kind: 'table' }, { id: 'v', kind: 'tabs' }]
  root.props![ACTIVE_VIEW_PROP] = 'v2'
  assert.equal(visibleRows(doc, { bodyHosts: hasTabsBody }).length, 6, '记录型视图不替换子块行')
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

test('structureGroupsOf：组＝一级子块（有身份）、记录＝它的孩子、空组保留、软删两边都跳过', () => {
  const root = listTree()
  const { kb } = kbOf([root])
  const groups = structureGroupsOf('root', kb)
  assert.deepEqual(
    groups.map((g) => g.block.id),
    ['r1', 'r2', 'r3'],
    '组就是容器的直接子块，顺序＝children 顺序（没有第二份组序）',
  )
  assert.deepEqual(
    groups[0]!.records.map((r) => r.block.id),
    ['c11', 'c12'],
    '记录＝组里的直接子块',
  )
  assert.deepEqual(
    groups[0]!.records[0]!.path.map((b) => b.id),
    ['root', 'r1'],
    '记录的路径到组块为止（它属于那一组，不是容器的直接子块）',
  )
  assert.deepEqual(
    groups.map((g) => g.block.id),
    listTableOf('root', kb).columns.map((c) => c.id),
    '结构映射表与结构分组共用同一份派生（两处各取一次树必漂）',
  )

  // 空组保留：它就是一个真实子块（还能拖卡进去），不像按值分组那样「合成空列」
  const emptyRoot = mk('root', '空组', [mk('g1', '一组')])
  const { kb: kb2 } = kbOf([emptyRoot])
  const empty = structureGroupsOf('root', kb2)
  assert.equal(empty.length, 1)
  assert.deepEqual(empty[0]!.records, [], '有子块但没内容 ⇒ 组还在')

  // 软删：组与记录都跳过（否则组里出现打不开的块）
  const deleted = listTree()
  deleted.children[1] = { ...deleted.children[1]!, props: { _deletedAt: 5 } }
  deleted.children[0] = {
    ...deleted.children[0]!,
    children: [deleted.children[0]!.children[0]!, { ...deleted.children[0]!.children[1]!, props: { _deletedAt: 5 } }],
  }
  const { kb: kb3 } = kbOf([deleted])
  const live = structureGroupsOf('root', kb3)
  assert.deepEqual(live.map((g) => g.block.id), ['r1', 'r3'], '被删的组不出列')
  assert.deepEqual(live[0]!.records.map((r) => r.block.id), ['c11'], '被删的卡不占位')
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
  const views = canonicalViews(
    [{ id: 'v', kind: 'list-table', listTable: { sort: { col: 2, dir: 'desc' } }, table: { columns: [{ key: 'title' }] } }],
    { kind: 'children', blockId: 'n' },
  )
  assert.equal(views.length, 1)
  assert.deepEqual(views[0]!.listTable?.sort, { col: 2, dir: 'desc' })
  assert.equal(views[0]!.table, undefined, '结构映射表不该带着平表的列配置')
  assert.equal(
    canonicalViews([{ id: 'v', kind: 'list-table' }], { kind: 'query', spec: { where: { any: [] } } }).length,
    0,
    '查询源没有层级可映射',
  )
  assert.deepEqual(withListSort({ id: 'v', kind: 'list-table' }, undefined).listTable, undefined, '取消排序＝删掉那一格')
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

/* ------------------------------------------------------------ 切片（视图级条件） */

/** 小库：评分 3/10/—/2/9；基础条件与切片各取一半，交集只剩 r1 与 r5 */
function slicedKb(): { kb: MemoryKb; score: string } {
  const { root, defs } = pageWith5()
  const score = defs[1]!.id
  const { kb } = kbOf([root, ...defs])
  return { kb, score }
}

const ids = (hits: readonly { blockId: string }[]): string[] => hits.map((h) => h.blockId).sort()

test('slicedSpec：无切片 ⇒ 原样返回（空 filter 与「没有 filter」逐字相同）', () => {
  const spec = { where: { tag: 'x' } }
  assert.deepEqual(slicedSpec(spec, undefined), spec, 'undefined ＝ 没有切片')
  assert.deepEqual(slicedSpec(spec, null), spec, 'null ＝ 清掉切片')
  assert.equal(slicedSpec(spec, undefined).where, spec.where, '不叠加时连引用都不该换')
})

test('切片是 AND 叠加（∩），不是替换：结果 = 基础结果 ∩ 切片结果', () => {
  const { kb, score } = slicedKb()
  const base = { where: { prop: { id: score, gte: 3 } } }
  const filter = { prop: { id: score, lt: 10 } }
  const baseHits = ids(kb.query(base, {}))
  const filterHits = ids(kb.query({ where: filter }, {}))
  const sliced = ids(kb.query(slicedSpec(base, filter), {}))
  assert.deepEqual(baseHits, ['r1', 'r2', 'r5'], `基础条件：${baseHits}`)
  assert.deepEqual(filterHits, ['r1', 'r4', 'r5'], `切片：${filterHits}`)
  assert.deepEqual(sliced, ['r1', 'r5'], `交集：${sliced}`)
  assert.deepEqual(
    sliced,
    baseHits.filter((id) => filterHits.includes(id)),
    '判据是集合交集本身，不是某个固定名单',
  )
  assert.deepEqual(ids(kb.query(base, {})), baseHits, '没有切片时结果与基础条件逐条相同')
})

test('canonicalViews：filter 只对 query 源保留；query 上原样深拷并 canonical 化', () => {
  const q = mk('q', '查询', [], { _query: { where: { any: [] } } })
  const raw = [{ id: 'v', kind: 'table', filter: { ref: { to: 'x', kind: ['embed', 'inline', 'inline'] } } }]
  const kept = canonicalViews(raw, sourceOf(q))
  assert.deepEqual(kept[0]!.filter, { ref: { to: 'x', kind: ['embed', 'inline'] } }, 'kind 去重并排序')
  assert.notEqual(kept[0]!.filter, raw[0]!.filter, '不许共享同一棵条件树')
  const dropped = canonicalViews(raw, sourceOf(mk('n', '普通')))
  assert.equal(dropped[0]!.filter, undefined, 'children 源没有可叠加的条件 ⇒ 丢掉（免得「写了却不生效」）')
  const invalid = canonicalViews([{ id: 'v', kind: 'table', filter: 'nope' }], sourceOf(q))
  assert.equal(invalid[0]!.filter, undefined, '不是 QueryNode ⇒ 丢掉，不猜')
})

test('withFilter：写一格／清掉删键；不改原视图', () => {
  const view = { id: 'v', kind: 'table', name: '本周' } as const
  const set = withFilter(view, { tag: 'today' })
  assert.deepEqual(set.filter, { tag: 'today' })
  assert.equal(view.name, '本周', '原视图不被改')
  assert.equal((set as { filter?: unknown }).filter !== undefined, true)
  const cleared = withFilter(set, null)
  assert.equal('filter' in cleared, false, '清掉是删键，不是留 undefined')
})

test('命名／删除：多切片各自带 filter，改名不丢切片，删一张不影响另一张', () => {
  let views = canonicalViews(
    [
      { id: 'a', kind: 'table', name: '全部', filter: { prop: { id: 'p', eq: true } } },
      { id: 'b', kind: 'table', name: '未完成', filter: { prop: { id: 'p', eq: false } } },
    ],
    { kind: 'query', spec: { where: { tag: 'x' } } },
  )
  views = renameView(views, 'b', ' 待办 ')
  assert.deepEqual(views.map((v) => v.name), ['全部', '待办'], '改名只动那一张')
  assert.deepEqual(views[1]!.filter, { prop: { id: 'p', eq: false } }, '改名不丢切片')
  views = removeView(views, 'a')
  assert.deepEqual(views.map((v) => v.id), ['b'], '删一张不连坐')
  const again = upsertView(views, { id: 'b', kind: 'table', name: '待办' })
  assert.equal('filter' in again[0]!, false, '整张替换时可按新配置清掉切片')
})

test('分组键是记录视图共用的顶层位：canonical 往返、清掉删键、多值判据只有一份', () => {
  // 卡片的布局从分组键派生（不存 layout），cards 子配置只剩卡片自己的东西；
  // 不分组也合法（＝网格）
  const views = canonicalViews(
    [
      { id: 'a', kind: 'cards', groupBy: '_tags', groupOrder: ['t2', 't1'], cards: { cover: 'none', showEmpty: true } },
      { id: 'b', kind: 'cards' },
      { id: 'c', kind: 'table', groupBy: 'p1' },
    ],
    { kind: 'children', blockId: 'x' },
  )
  const card = views.find((v) => v.id === 'a')!
  assert.equal(card.groupBy, '_tags', '分组键收顶层位')
  assert.deepEqual(card.groupOrder, ['t2', 't1'])
  assert.deepEqual(card.cards, { cover: 'none', showEmpty: true }, 'cards 子配置不再带 groupBy')
  const bare = views.find((v) => v.id === 'b')!
  assert.equal(bare.groupBy, undefined, '没有分组的卡片合法（＝网格，不再是「丢掉整张」）')
  assert.equal(cardLayoutOf(card), 'columns', '有分组键 ⇒ 列（看板）')
  assert.equal(cardLayoutOf(bare), 'grid', '没有分组键 ⇒ 网格（画廊）')
  const table = views.find((v) => v.id === 'c')!
  assert.equal(table.groupBy, 'p1', '表格同样能带分组键（分节呈现待做，配置位先行）')

  // withGroup：写一格／清掉删键（空配置不留「曾经分过」的痕迹）
  const v0: ViewConfig = { id: 'v', kind: 'cards' }
  const grouped = withGroup(v0, 'p1', ['a', ''])
  assert.equal(grouped.groupBy, 'p1')
  assert.deepEqual(grouped.groupOrder, ['a'], '组序里的空串滤掉')
  const cleared = withGroup(grouped, '')
  assert.equal('groupBy' in cleared, false)
  assert.equal('groupOrder' in cleared, false)

  // 多值键判据：现阶段只有标签归属；同一份判据喂候选标注／分桶／拖拽三处
  assert.equal(isMultiValueKey('_tags'), true)
  assert.equal(isMultiValueKey('p1'), false)
})

test('结构分组：只接 children 源的卡片、与按值分组互斥、清掉删键', () => {
  const child = { kind: 'children', blockId: 'x' } as const
  const query = { kind: 'query', spec: { where: { any: [] } } } as const

  const [kept] = canonicalViews(
    [{ id: 'a', kind: 'cards', groupByStructure: true, groupBy: 'p1', groupOrder: ['a'] }],
    child,
  )
  assert.equal(kept!.groupByStructure, true, 'children 源的卡片认结构分组')
  assert.equal(kept!.groupBy, undefined, '两种来源互斥：结构分组不吃按值分组的键')
  assert.equal(kept!.groupOrder, undefined, '组顺序＝children 顺序，没有第二份 order')
  assert.equal(cardLayoutOf(kept), 'columns', '结构分组 ⇒ 列布局（与看板同一个容器）')

  assert.equal(
    canonicalViews([{ id: 'b', kind: 'table', groupByStructure: true }], child)[0]!.groupByStructure,
    undefined,
    '别的 kind 写进来也丢掉（没有第二个消费者）',
  )
  assert.equal(
    canonicalViews([{ id: 'c', kind: 'cards', groupByStructure: true }], query)[0]!.groupByStructure,
    undefined,
    'query 源没有「一级子块」可分组 ⇒ 丢掉（写进去就是死配置）',
  )

  const v: ViewConfig = { id: 'v', kind: 'cards', groupBy: 'p1', groupOrder: ['a'] }
  const structure = withStructureGroup(v, true)
  assert.equal(structure.groupByStructure, true)
  assert.equal('groupBy' in structure, false, '写结构分组清掉按值分组')
  assert.equal('groupOrder' in structure, false)
  assert.equal('groupByStructure' in withStructureGroup(structure, false), false, '清掉删键')
  assert.equal('groupByStructure' in withGroup(structure, 'p1'), false, '按值分组接管时结构分组退场')
})

test('页签：children 源才接；方向存配置、横排回缺省；卡片不残留摆法位', () => {
  const child = { kind: 'children', blockId: 'x' } as const
  const query = { kind: 'query', spec: { from: { kind: 'tag', id: 't' } } } as const

  const [tabs] = canonicalViews([{ id: 'v', kind: 'tabs', tabs: { direction: 'vertical' } }], child)
  assert.equal(tabs?.kind, 'tabs', '页签是独立 kind（children 源）')
  assert.equal(tabs!.tabs?.direction, 'vertical')

  const [tabsH] = canonicalViews([{ id: 'v', kind: 'tabs', tabs: { direction: 'horizontal' } }], child)
  assert.equal(tabsH!.tabs?.direction, undefined, '横排是缺省：不存它（默认与显式默认只有一种写法）')

  const [noDir] = canonicalViews([{ id: 'v', kind: 'tabs', tabs: { direction: 'diagonal' as never } }], child)
  assert.equal(noDir!.tabs?.direction, undefined, '只认两个方向，别的丢掉')

  const [dropped] = canonicalViews([{ id: 'v', kind: 'tabs' }], query)
  assert.equal(dropped, undefined, '查询源命中是平的，没有「页」⇒ 页签不接')

  // 卡片退回两副面孔：旧的摆法位被 canonical 丢掉（原型不迁移，读不进来就作废）
  const [stale] = canonicalViews(
    [{ id: 'v', kind: 'cards', groupBy: 'p1', cards: { layout: 'tabs-h' } as never }],
    child,
  )
  assert.equal(cardLayoutOf(stale), 'columns', '卡片长成什么由分组键派生')
  assert.equal(stale!.cards && 'layout' in stale.cards, false, '摆法位不再是卡片的配置')

  const base: ViewConfig = { id: 'v', kind: 'tabs' }
  const vertical = withTabsDirection(base, 'vertical')
  assert.equal(vertical.tabs?.direction, 'vertical')
  assert.equal('direction' in (withTabsDirection(vertical, 'horizontal').tabs ?? {}), false, '选横排＝回到缺省（删键）')
  assert.equal(base.tabs?.direction, undefined, '不改原视图')
})

test('卡片配置一份：cover／size／showEmpty 原样往返；布局是派生的，切布局不搬配置', () => {
  const [v] = canonicalViews(
    [{ id: 'c', kind: 'cards', cards: { cover: 'none', size: 'l', showEmpty: true } }],
    { kind: 'children', blockId: 'x' },
  )
  assert.deepEqual(
    v!.cards,
    { cover: 'none', size: 'l', showEmpty: true },
    '写进去的必须能原样读回来（否则就是「设了没生效」）',
  )

  // 同一份配置，换个分组键就换容器：卡片配置不搬家
  const columns = withGroup(v!, 'p1')
  assert.equal(cardLayoutOf(v), 'grid')
  assert.equal(cardLayoutOf(columns), 'columns')
  assert.deepEqual(columns.cards, v!.cards, '换布局不动卡片配置（一份配置两副面孔）')

  // 坏档位／空字段：丢掉，不抛（一个错键不该让整个块打不开）
  const [bad] = canonicalViews(
    [{ id: 'c', kind: 'cards', cards: { size: 'xl' } }],
    { kind: 'children', blockId: 'x' },
  )
  assert.equal(bad!.cards?.size, undefined, '不在三档里的尺寸丢掉')
  assert.equal(bad!.cards?.size, undefined, '不在三档里的尺寸丢掉')
})

test('withCover：只动 cards.cover，其余配置原样（封面是配置，不是新视图）', () => {
  const v: ViewConfig = { id: 'c', kind: 'cards', groupBy: 'p1', cards: { cover: 'first-asset', size: 'l' } }
  const none = withCover(v, 'none')
  assert.equal(none.cards?.cover, 'none')
  assert.equal(none.cards?.size, 'l', '尺寸与其余配置不丢')
  assert.equal(none.groupBy, 'p1', '布局键不动')
  assert.equal(v.cards?.cover, 'first-asset', '不改原视图')
  assert.equal(withCover(none, 'first-asset').cards?.cover, 'first-asset', '往返')
})
