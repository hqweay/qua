/**
 * **条件草稿 ⇄ `QuerySpec`**，以及属性条件的九个算子。
 *
 * 三件在界面上看不出对错的事：
 *   ① 构建器拼出来的条件与手写 JSON **逐字节相等**（否则「界面上一行改完、结果没变」）；
 *   ② 拆不动的形状**原样保留**（不猜、不拆一半 —— 一次无关的编辑不该丢掉剩下的条件）；
 *   ③ 九个算子各是各的意思，尤其 `empty` 与 `exists` 必须分得开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_OPS,
  canonicalSpec,
  draftOfSpec,
  literalOf,
  nodeOfRow,
  runQuery,
  specOfDraft,
  type Block,
  type QuerySpec,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/runs.ts'

const b = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

const bytes = (s: QuerySpec): string => JSON.stringify(specOfDraft(draftOfSpec(s)))

/* ------------------------------------------------------------ 往返 */

test('草稿往返：拼回来的条件与手写 JSON 逐字节相等', () => {
  const cases: QuerySpec[] = [
    { where: { todo: 'todo' } },
    { where: { tag: '任务' } },
    { where: { text: '提到' } },
    { where: { all: [{ todo: 'todo' }, { tag: '任务' }] }, scope: 'all' },
    { where: { any: [{ tag: '甲' }, { text: '乙' }] } },
    { where: { prop: { id: 'p-1', eq: 'x' } } },
    { where: { prop: { id: 'p-1', neq: 'x' } } },
    { where: { prop: { id: 'p-1', contains: 'x' } } },
    { where: { prop: { id: 'p-1', gt: 3 } } },
    { where: { prop: { id: 'p-1', gte: 3 } } },
    { where: { prop: { id: 'p-1', lt: 3 } } },
    { where: { prop: { id: 'p-1', lte: 3 } } },
    { where: { prop: { id: 'p-1', exists: false } } },
    { where: { prop: { id: 'p-1', empty: true } } },
    { where: { tag: '任务' }, sort: [{ by: '_date', dir: 'desc' }], limit: 5 },
    { where: { todo: 'done' }, scope: 'all', limit: 1 },
  ]
  for (const s of cases) {
    assert.equal(bytes(s), JSON.stringify(canonicalSpec(s)), `往返不该改一个字节：${JSON.stringify(s)}`)
  }
})

test('草稿往返：单条件不包一层 all（`all:[x]` 与 `x` 不是同一个形状）', () => {
  const one: QuerySpec = { where: { todo: 'todo' } }
  assert.equal(bytes(one), '{"where":{"todo":"todo"}}')
  const two: QuerySpec = { where: { all: [{ todo: 'todo' }, { tag: '任务' }] } }
  assert.equal(bytes(two), '{"where":{"all":[{"todo":"todo"},{"tag":"任务"}]}}')
})

test('拆不动就整份走 JSON：`not`、嵌套组合、`ref`／`journal`／`role`、多键排序', () => {
  const hard: QuerySpec[] = [
    { where: { not: { tag: '任务' } } },
    { where: { all: [{ any: [{ tag: 'a' }, { tag: 'b' }] }] } },
    { where: { ref: 'x' } },
    { where: { journal: '2026-10-26' } },
    { where: { role: 'journal' } },
    { where: { tag: '任务' }, sort: [{ by: 'a', dir: 'asc' }, { by: 'b', dir: 'desc' }] },
  ]
  for (const s of hard) {
    const draft = draftOfSpec(s)
    assert.ok(draft.verbatim !== undefined, `这份条件拆不成条件行：${JSON.stringify(s)}`)
    assert.equal(bytes(s), JSON.stringify(canonicalSpec(s)), '拆不动也要原样回来')
  }
})

test('空组合：`all:[]` 恒真拆不得（零行会把它翻成恒假）；`any:[]` ＝ 零行草稿（往返无损）', () => {
  const allEmpty: QuerySpec = { where: { all: [] } }
  assert.ok(draftOfSpec(allEmpty).verbatim !== undefined, '`all:[]` 不该被拆成零行（零行拼回来是恒假）')
  assert.equal(JSON.stringify(specOfDraft(draftOfSpec(allEmpty))), JSON.stringify(canonicalSpec(allEmpty)))
  // `any:[]` 就是「还没有条件」：拆成零行草稿，拼回来逐字节相等 —— 新建栏的空条件才能从条件行配起
  const anyEmpty: QuerySpec = { where: { any: [] } }
  const draft = draftOfSpec(anyEmpty)
  assert.equal(draft.verbatim, undefined, '`any:[]` 要拆成零行草稿（否则条件行的修改被吞掉）')
  assert.equal(draft.mode, 'any')
  assert.deepEqual(draft.rows, [])
  assert.equal(JSON.stringify(specOfDraft(draft)), JSON.stringify(canonicalSpec(anyEmpty)))
  // 真的零行 ⇒ `{any:[]}`（**不匹配任何块**）：空条件等于「没有结果」，不是「整个库」
  assert.equal(JSON.stringify(specOfDraft({ mode: 'all', rows: [], scope: 'subtree' })), '{"where":{"any":[]}}')
})

test('没填完的那一行不进条件（`nodeOfRow` 返回 null，而不是一条永远命中的空条件）', () => {
  assert.equal(nodeOfRow({ kind: 'tag', value: '' }), null)
  assert.equal(nodeOfRow({ kind: 'text', value: '' }), null)
  assert.equal(nodeOfRow({ kind: 'prop', field: '', op: 'eq', value: 'x' }), null)
  const spec = specOfDraft({
    mode: 'all',
    rows: [{ kind: 'todo', value: 'todo' }, { kind: 'tag', value: '' }],
    scope: 'subtree',
  })
  assert.equal(JSON.stringify(spec), '{"where":{"todo":"todo"}}')
})

/* ------------------------------------------------------------ 字面量 */

test('literalOf：`true`／数字／带引号的 JSON 按字面读，其余是字符串', () => {
  assert.equal(literalOf('true'), true)
  assert.equal(literalOf('false'), false)
  assert.equal(literalOf('3'), 3)
  assert.equal(literalOf('-2.5'), -2.5)
  assert.equal(literalOf('"带引号"'), '带引号')
  assert.equal(literalOf('[1,2]') instanceof Array, true)
  assert.equal(literalOf('普通文本'), '普通文本')
  // 数字串前面有空格也按数字读（属性值常被粘贴进来）
  assert.equal(literalOf(' 42 '), 42)
})

/* ------------------------------------------------------------ 算子语义 */

test('九个算子各是各的意思（`empty` 与 `exists` 分得开）', () => {
  const blocks: Block[] = [
    b('a', '甲', { p: true }),
    b('b', '乙', { p: false }),
    b('c', '丙'), // 没有这一槽
    b('d', '丁', { p: '' }), // 有槽、值为空
    b('e', '戊', { p: 10 }),
    b('f', '己', { p: 'hello' }),
    b('g', '庚', { p: ['x', 'y'] }),
  ]
  const ids = (where: QuerySpec['where']): string[] =>
    runQuery({ where, scope: 'all' }, { blocks }).map((h) => h.blockId)

  assert.deepEqual(ids({ prop: { id: 'p', eq: true } }), ['a'])
  // `neq` 只对**有槽**的块成立：c 没有这一槽，不是「不等于 true」
  assert.deepEqual(ids({ prop: { id: 'p', neq: true } }), ['b', 'd', 'e', 'f', 'g'])
  assert.deepEqual(ids({ prop: { id: 'p', contains: 'ell' } }), ['f'], '字符串按子串')
  assert.deepEqual(ids({ prop: { id: 'p', contains: 'y' } }), ['g'], '数组按任一元素')
  assert.deepEqual(ids({ prop: { id: 'p', gt: 5 } }), ['e'], '数值按大小，不退化成字典序')
  assert.deepEqual(ids({ prop: { id: 'p', gte: 10 } }), ['e'])
  assert.deepEqual(ids({ prop: { id: 'p', lt: 5 } }), [], '没有别的数字值')
  assert.deepEqual(ids({ prop: { id: 'p', lte: 10 } }), ['e'])

  /**
   * 三态的第一刀：**有这一槽 vs 没有**。
   * `exists:false` ＝ 不是这种块（c），`exists:true` ＝ 有槽（a/b/d/e/f/g）。
   */
  assert.deepEqual(ids({ prop: { id: 'p', exists: false } }), ['c'])
  assert.deepEqual(ids({ prop: { id: 'p', exists: true } }), ['a', 'b', 'd', 'e', 'f', 'g'])

  /**
   * 第二刀：**有没有值**。`empty:true` ＝ 「没填」（c 与 d 都算），
   * 而 `exists:false` 只认 c。合成一个算子就再也问不出「有槽但没填」。
   */
  assert.deepEqual(ids({ prop: { id: 'p', empty: true } }), ['c', 'd'])
  assert.deepEqual(ids({ prop: { id: 'p', empty: false } }), ['a', 'b', 'e', 'f', 'g'])
})

test('算子的每个分支都能被 `canonicalSpec` 带走（漏一支＝存进 _query 就被丢掉）', () => {
  for (const op of DRAFT_OPS) {
    const row = { kind: 'prop' as const, field: 'p-1', op, value: op === 'exists' || op === 'empty' ? 'true' : '7' }
    const node = nodeOfRow(row)
    assert.ok(node !== null, `每一个算子都要能变成条件：${op}`)
    const spec: QuerySpec = { where: node! }
    assert.equal(
      JSON.stringify(canonicalSpec(spec)),
      JSON.stringify(spec),
      `这一支被 canonicalSpec 改写了（＝存库时会丢或变形）：${op}`,
    )
  }
})

test('算子与索引路径等价（同一份条件，两条路给同一结果）', () => {
  const blocks: Block[] = [b('a', '甲', { p: 1 }), b('b', '乙', { p: 9 }), b('c', '丙', {})]
  const where: QuerySpec['where'] = { any: [{ prop: { id: 'p', gt: 5 } }, { prop: { id: 'p', empty: true } }] }
  const pure = runQuery({ where, scope: 'all' }, { blocks }).map((h) => h.blockId)
  assert.deepEqual(pure, ['b', 'c'])
})
