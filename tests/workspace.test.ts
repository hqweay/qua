/**
 * 落盘形状的校验（纯函数，无 I/O）：**这七个分支每一条都是一次真数据安全事故**。
 *
 * 来历：旧实现把所有读失败压成 `null`，调用方只能 `?? seedWorkspace()`，
 * 随后立刻写回 ——过新/损坏的库被**静默覆盖**。
 * 所以这里断言的每条状态，都是「用户数据会不会丢」的判据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorkspace, WORKSPACE_VERSION, type Workspace } from '../src/core/workspace.ts'
import { mkBlock, type Block } from '../src/core/index.ts'
import { seedWorkspace } from '../src/core/seed.ts'
import { bootWorkspace } from '../src/core/bootstrap.ts'
import { degradedWorkspace, emptyWorkspace, sparseWorkspace } from '../src/core/fixtures/states.ts'

const valid = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: WORKSPACE_VERSION,
    blocks: [blk()],
    activeId: 'b1',
    savedAt: 0,
    ...patch,
  })

/**
 * 一个合法块（时间戳必填，所以每个手写块都要带）。
 *
 * 下面那些「形状不对」的用例只该让**被测的那一格**不对：少写时间戳会被判 corrupt，
 * 于是用例会在错误的理由上变绿（整条链都红，看不出是哪一格拦下来的）。
 */
const blk = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'b1',
  content: [{ t: 'text', v: 'x' }],
  children: [],
  created: 1,
  modified: 1,
  ...patch,
})

test('parseWorkspace: 从没存过 ⇒ empty（不是错误）', () => {
  assert.deepEqual(parseWorkspace(null), { status: 'empty' })
})

test('parseWorkspace: 合法库 ⇒ ok（库不含设备状态：偏好与折叠表）', () => {
  const r = parseWorkspace(valid())
  assert.equal(r.status, 'ok')
  if (r.status !== 'ok') return
  assert.equal(r.ws.blocks.length, 1)
  // 偏好与折叠表都是设备状态（`qua.device`），库的形状里**没有**这两格，也不会被补出一份默认值
  assert.equal((r.ws as { prefs?: unknown }).prefs, undefined)
  assert.equal((r.ws as { folded?: unknown }).folded, undefined)
})

test('parseWorkspace: 比当前新的版本 ⇒ too-new（绝不 seed 覆盖）', () => {
  assert.deepEqual(parseWorkspace(valid({ version: WORKSPACE_VERSION + 1 })), {
    status: 'too-new',
    version: WORKSPACE_VERSION + 1,
  })
})

test('parseWorkspace: 旧版本 ⇒ expired（显式作废分支）', () => {
  assert.deepEqual(parseWorkspace(valid({ version: WORKSPACE_VERSION - 1 })), {
    status: 'expired',
    version: WORKSPACE_VERSION - 1,
  })
})

test('parseWorkspace: JSON 坏了 ⇒ corrupt(parse)', () => {
  assert.deepEqual(parseWorkspace('{oops'), { status: 'corrupt', reason: 'parse' })
})

test('parseWorkspace: 形状不对（空 blocks / 坏 children）⇒ corrupt(shape)', () => {
  assert.deepEqual(parseWorkspace(valid({ blocks: [] })), { status: 'corrupt', reason: 'shape' })
  const badChild = valid({ blocks: [blk({ children: [blk({ id: 'b2', content: [], created: undefined, modified: undefined })] })] })
  assert.deepEqual(parseWorkspace(badChild), { status: 'corrupt', reason: 'shape' })
})

test('parseWorkspace: 缺 created / modified ⇒ corrupt(shape)（时间戳不可能缺席）', () => {
  // 这两个字段是**必填**的：每块都必然诞生过一次、也必然有个「最后一次改动」。
  // 允许它们缺席，就等于给一件不可能缺席的事开一个合法状态，然后每处读代码都要处理它。
  const noCreated = valid({ blocks: [blk({ created: undefined })] })
  assert.deepEqual(parseWorkspace(noCreated), { status: 'corrupt', reason: 'shape' })
  const noModified = valid({ blocks: [blk({ modified: undefined })] })
  assert.deepEqual(parseWorkspace(noModified), { status: 'corrupt', reason: 'shape' })
  // 还得是数字：`null` / 字符串不是「有值」，读出来做减法会得到 NaN，而 NaN 不报错
  assert.equal(parseWorkspace(valid({ blocks: [blk({ created: null })] })).status, 'corrupt')
  assert.equal(parseWorkspace(valid({ blocks: [blk({ modified: '1' })] })).status, 'corrupt')
})

test('parseWorkspace: 缺 version ⇒ corrupt(shape)，不当作旧库', () => {
  assert.deepEqual(parseWorkspace(JSON.stringify({ blocks: [] })), { status: 'corrupt', reason: 'shape' })
})

test('parseWorkspace: `_lists` 形状不对（非数组 / 坏值 / 重复）⇒ corrupt(shape)', () => {
  const bad = (lists: unknown): unknown =>
    valid({ blocks: [blk({ props: { _lists: lists } })] })
  assert.equal(parseWorkspace(bad('page')).status, 'corrupt')
  assert.equal(parseWorkspace(bad(['page', 'other'])).status, 'corrupt')
  assert.equal(parseWorkspace(bad(['page', 'page'])).status, 'corrupt', '无序集合：重复没有第二种语义')
  assert.equal(parseWorkspace(bad([])).status, 'ok', '空列表合法（不在任何列表里）')
})

test('parseWorkspace: 在列表里 ⇒ 必须有至少一个别名', () => {
  const withPageNoName = valid({ blocks: [blk({ props: { _lists: ['page'] } })] })
  assert.deepEqual(parseWorkspace(withPageNoName), { status: 'corrupt', reason: 'shape' })
  const withPageName = valid({ blocks: [blk({ props: { _lists: ['page'], _aliases: ['页名'] } })] })
  assert.equal(parseWorkspace(withPageName).status, 'ok')
})

test('parseWorkspace: `_aliases` 形状不对（空数组 / 空串 / 规范化重复）⇒ corrupt(shape)', () => {
  const bad = (aliases: unknown): unknown =>
    valid({ blocks: [blk({ props: { _aliases: aliases } })] })
  assert.equal(parseWorkspace(bad('名字')).status, 'corrupt')
  assert.equal(parseWorkspace(bad([])).status, 'corrupt', '空数组与「没有这一格」是两种写法')
  assert.equal(parseWorkspace(bad(['  '])).status, 'corrupt', '空串不是地址')
  assert.equal(parseWorkspace(bad([1 as unknown as string])).status, 'corrupt')
  assert.equal(parseWorkspace(bad(['A/B', 'a/b'])).status, 'corrupt', '块内别名规范后必须不相交')
  assert.equal(parseWorkspace(bad(['A/B', 'C/B'])).status, 'ok', '不同全名可共存（叶子相同不算冲突）')
})

test('parseWorkspace: `_display` 只认 `alias` / `text` ⇒ 别的值判 corrupt', () => {
  const bad = (display: unknown): unknown =>
    valid({ blocks: [blk({ props: { _aliases: ['x'], _display: display } })] })
  assert.equal(parseWorkspace(bad('alias')).status, 'ok')
  assert.equal(parseWorkspace(bad('text')).status, 'ok')
  assert.equal(parseWorkspace(bad('both')).status, 'corrupt')
  assert.equal(parseWorkspace(bad(1)).status, 'corrupt')
})

test('parseWorkspace: 旧键 `_roles` / `_alias` 一律判 corrupt（不静默读旧形状）', () => {
  const roles = valid({ blocks: [blk({ props: { _roles: ['page'] } })] })
  assert.deepEqual(parseWorkspace(roles), { status: 'corrupt', reason: 'shape' })
  const alias = valid({ blocks: [blk({ props: { _alias: '名字' } })] })
  assert.deepEqual(parseWorkspace(alias), { status: 'corrupt', reason: 'shape' })
})

test('parseWorkspace: v3 的裸 JSON（写信封之前）⇒ expired，不会被当成当前版本打开', () => {
  // 2026-10-20：v3 → v4（落盘套信封）。旧库必须走**显式作废**，不能静默当成 v4 读进来。
  assert.deepEqual(parseWorkspace(valid({ version: 3 })), { status: 'expired', version: 3 })
})

test('每一处创建路径产出的块都带真时刻（不是 undefined、也不是 0）', () => {
  /**
   * 「必然有」这一条的落地形态：**遍历**四处造块的来源（种子库／冷启动／三个演示态
   * ＋ 手造块），而不是逐个断言某一块 —— 逐个断言只会钉住这一次举的例子。
   *
   * ⚠️ 反链伪行（`ui/dock-content.ts`）不在库森林里，是渲染时现造的查询结果，
   *    它不属于「创建路径」；判据因此只走森林。
   */
  const forests: [string, Workspace][] = [
    ['seed', seedWorkspace()],
    ['boot', bootWorkspace()],
    ['empty', emptyWorkspace()],
    ['sparse', sparseWorkspace()],
    ['degraded', degradedWorkspace()],
  ]
  for (const [name, ws] of forests) {
    let n = 0
    const walk = (list: readonly Block[]): void => {
      for (const b of list) {
        n++
        assert.equal(typeof b.created, 'number', `${name}: 块 ${b.id} 缺 created`)
        assert.equal(typeof b.modified, 'number', `${name}: 块 ${b.id} 缺 modified`)
        assert(b.created > 0, `${name}: 块 ${b.id} 的 created 不是真时刻（${b.created}）`)
        assert(b.modified >= b.created, `${name}: 块 ${b.id} 的 modified 早于 created`)
        walk(b.children)
      }
    }
    walk(ws.blocks)
    assert(n > 0, `${name}: 该有块（否则这条断言什么也没验）`)
  }
  // 手造块的默认落点：`mkBlock` 必须当场给出时刻
  const fresh = mkBlock('新块')
  assert(fresh.created > 0 && fresh.modified === fresh.created, `mkBlock 该给出同一时刻的两格：${JSON.stringify(fresh)}`)
  // 种子的时刻是**固定值**（否则每次 seed 不同、断言钉不住）
  const a = seedWorkspace()
  const b2 = seedWorkspace()
  const stampOf = (ws: Workspace): number[] => {
    const out: number[] = []
    const walk = (list: readonly Block[]): void => {
      for (const x of list) {
        out.push(x.created)
        walk(x.children)
      }
    }
    walk(ws.blocks)
    return out
  }
  assert.equal(stampOf(a).join(','), stampOf(b2).join(','), '种子的时刻必须可重放（不能是「现在」）')
})
