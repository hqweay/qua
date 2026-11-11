/**
 * **属性条件的算子**：哪些算子这一行能问（按字段 kind 收窄）、输入框文本怎么读成字面量，
 * 以及九个算子在求值里的语义。
 *
 * 三件在界面上看不出对错的事：
 *   ① 收窄只决定「新加时不给什么」，**不许**打开一次就改掉用户已存的条件；
 *   ② 字面量长得像 `42`／`true`／`""` 时不能被悄悄读成字符串（反过来也不行）；
 *   ③ 九个算子各是各的意思，尤其 `empty` 与 `exists` 必须分得开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAFT_OPS,
  canonicalSpec,
  literalOf,
  mkPropDef,
  opsFor,
  runQuery,
  type Block,
  type QueryNode,
  type QuerySpec,
} from '../src/core/index.ts'
import { textRuns } from '../src/core/model/runs.ts'

const b = (id: string, text: string, props?: Record<string, unknown>): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...(props ? { props } : {}),
})

/* ------------------------------------------------------------ 算子清单 */

test('算子按字段 kind 收窄：select 不给大小比较，布尔不给「为空」', () => {
  // select 的值是**选项块 id**：比大小、比包含都没有意义（`contains` 等 multi-select 来了再开）
  assert.deepEqual([...opsFor('select', undefined)], ['eq', 'neq', 'exists', 'empty'])
  assert.ok(!opsFor('select', undefined).includes('gt'))
  assert.ok(!opsFor('select', undefined).includes('contains'))
  // 布尔没有「未填」这一态：问「为空」与问「没有这一栏」是同一个答案 ⇒ 两个选项指向同一结果，不给
  const boolOps = opsFor('checkbox', undefined)
  assert.ok(!boolOps.includes('empty'))
  assert.ok(boolOps.includes('exists'))
  // 其余 kind 不受影响
  assert.deepEqual([...opsFor('text', undefined)], [...DRAFT_OPS])
})

test('收窄不许悄悄改掉已存下来的算子（打开一次条件就变了＝静默改写）', () => {
  const ops = opsFor('select', 'contains')
  assert.ok(ops.includes('contains'), '已存的算子必须还在：不许打开一次就悄悄改掉用户的条件')
  assert.equal(ops.indexOf('contains'), ops.length - 1, '补在末尾：前四个仍是这一类的正常问法')
  assert.ok(opsFor('checkbox', 'empty').includes('empty'))
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
  // `{prop}` 只认定义块 id（系统槽白名单见 `core/props.ts`）⇒ 定义要放进森林
  const def = mkPropDef('属性 p', 'text', {}, 'p')
  const blocks: Block[] = [
    def,
    b('a', '甲', { p: true }),
    b('b', '乙', { p: false }),
    b('c', '丙'), // 没有这一槽
    b('d', '丁', { p: '' }), // 有槽、值为空
    b('e', '戊', { p: 10 }),
    b('f', '己', { p: 'hello' }),
    b('g', '庚', { p: ['x', 'y'] }),
  ]
  // 定义块自己也没有这一栏；断言只关心内容块
  const ids = (where: QuerySpec['where']): string[] =>
    runQuery({ where }, { blocks })
      .map((h) => h.blockId)
      .filter((id) => id !== def.id)

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

test('九个算子都能被 `canonicalSpec` 带走（漏一支＝存进 _query 就被丢掉）', () => {
  const ops: QuerySpec[] = [
    { where: { prop: { id: 'p-1', eq: 'x' } } },
    { where: { prop: { id: 'p-1', neq: 'x' } } },
    { where: { prop: { id: 'p-1', contains: 'x' } } },
    { where: { prop: { id: 'p-1', gt: 1 } } },
    { where: { prop: { id: 'p-1', gte: 1 } } },
    { where: { prop: { id: 'p-1', lt: 1 } } },
    { where: { prop: { id: 'p-1', lte: 1 } } },
    { where: { prop: { id: 'p-1', exists: true } } },
    { where: { prop: { id: 'p-1', empty: true } } },
  ]
  for (const spec of ops) {
    assert.equal(
      JSON.stringify(canonicalSpec(spec)),
      JSON.stringify(spec),
      `这一支被 canonicalSpec 改写了（＝存库时会丢或变形）：${JSON.stringify(spec)}`,
    )
  }
})

test('算子与索引路径等价（同一份条件，两条路给同一结果）', () => {
  const def = mkPropDef('属性 p', 'text', {}, 'p')
  const blocks: Block[] = [def, b('a', '甲', { p: 1 }), b('b', '乙', { p: 9 }), b('c', '丙', {})]
  const where: QueryNode = { any: [{ prop: { id: 'p', gt: 5 } }, { prop: { id: 'p', empty: true } }] }
  const pure = runQuery({ where }, { blocks })
    .map((h) => h.blockId)
    .filter((id) => id !== def.id)
  assert.deepEqual(pure, ['b', 'c'])
})
