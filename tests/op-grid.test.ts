/**
 * **格网**：每一个可变的格，只有**一个地址**。
 *
 * 判据（这条不是风格，是全域性的前提）：
 *
 * > 只有「绝对的、按格寻址的 set」才能满足 **应用两次等于一次**。
 *
 * 撤销（回到某格旧值）、同步重发（同一条应用两次）、崩溃恢复（重放日志）都建立在这条上。
 * 一旦同一个格有两种地址（例：`_aliases` 既能由 `prop.set` 整袋写、又能由 `alias.set`
 * 按项写），日志里同一个格就有两条账 —— 重放顺序不同结果不同，幂等性也破
 * （`prop.set([a,b])` 之后再一条 `alias.set(a, pos 0)` 会把它覆盖一遍）。
 *
 * ⚠️ 这条断言**故意是静态的**：它拦的是「有人顺手把两种地址又加回来」，
 *    而那件事在运行时看起来只是「多写了几行」，不会报错。
 *
 * 反证方式：在 `kb/types.ts` 的 `Op` 联合里加回 `| { e: 'alias'; … }`，本条即红。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mkBlock } from '../src/core/model.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'
import type { Op } from '../src/core/kb/types.ts'

const ROOT = join(import.meta.dirname, '..')

function readAllSources(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.ts')) out.set(p.slice(ROOT.length + 1), readFileSync(p, 'utf8'))
    }
  }
  walk(join(ROOT, 'src'))
  return out
}

/* ------------------------------------------------------------ 地址唯一 */

test('格网：`Op` 只有 block／prop／anno 三种（`alias`／`list` 不许复活）', () => {
  const types = readFileSync(join(ROOT, 'src/core/kb/types.ts'), 'utf8')
  assert.match(types, /export type Op =/, 'Op 联合还在（下面三条断言依赖它的形状）')
  for (const dead of ['alias', 'list']) {
    assert.equal(
      new RegExp(`e:\\s*'${dead}'`).test(types),
      false,
      `\`Op\` 里不该再有 \`e: '${dead}'\`：同一个格两种地址 ⇒ 重放顺序决定结果，而 op_log 是不可逆历史`,
    )
  }
})

test('格网：生产代码里没有第二套「按项写地址/露面」的 op 生成点', () => {
  const hits: string[] = []
  for (const [file, body] of readAllSources()) {
    // `{ e: 'alias' … }` / `{ e: 'list' … }` 的字面构造（注释里的说明不算，故要求前面有 `e:`）
    if (/\be:\s*'(alias|list)'/.test(body)) hits.push(`${file} 仍在构造 alias/list op`)
  }
  assert.deepEqual(hits, [], `地址与露面只许经 prop.set 整袋写：${hits.join('；')}`)
})

/* ------------------------------------------------------------ 幂等（全域性的最小检验） */

/** 只把「格写入」应用到一份模型上（测试用的最小解释器，不是生产 replay） */
function applyGrid(forest: ReturnType<typeof mkBlock>[], ops: readonly Op[]): void {
  const byId = new Map<string, ReturnType<typeof mkBlock>>()
  const walk = (list: typeof forest): void => {
    for (const b of list) {
      byId.set(b.id, b)
      walk(b.children)
    }
  }
  walk(forest)
  for (const op of ops) {
    if (op.e === 'prop') {
      const b = byId.get(op.block)
      if (!b) continue
      const props = { ...(b.props ?? {}) }
      if (op.op === 'delete') delete props[op.name]
      else props[op.name] = op.value
      b.props = Object.keys(props).length === 0 ? undefined : props
      continue
    }
    if (op.e === 'block' && op.op === 'upsert') {
      const b = byId.get(op.id)
      if (!b) continue
      if (op.value.content !== undefined) b.content = op.value.content
      if (op.value.modified !== undefined) b.modified = op.value.modified
    }
  }
}

function snapshot(forest: readonly ReturnType<typeof mkBlock>[]): string {
  return JSON.stringify(forest)
}

test('格网：同一批 op 应用两次 ＝ 应用一次（幂等是撤销与同步的共同前提）', () => {
  const kb = new MemoryKb(new BlockStore([mkBlock('a'), mkBlock('b')]))
  const root = kb.roots()[0]!
  const ops: Op[] = [
    { e: 'prop', block: root.id, name: '_aliases', op: 'set', value: ['甲', '乙'], at: 1 },
    { e: 'prop', block: root.id, name: '_lists', op: 'set', value: ['page', 'tag'], at: 1 },
    { e: 'prop', block: root.id, name: '_icon', op: 'set', value: 'lucide:x', at: 1 },
  ]

  const once = JSON.parse(JSON.stringify([root])) as ReturnType<typeof mkBlock>[]
  applyGrid(once, ops)
  const twice = JSON.parse(JSON.stringify(once)) as ReturnType<typeof mkBlock>[]
  applyGrid(twice, ops)

  assert.equal(snapshot(twice), snapshot(once), '第二次应用必须一个字节都不改（整袋值 ⇒ 天然幂等）')
  assert.deepEqual(once[0]!.props?._aliases, ['甲', '乙'])
  assert.deepEqual(once[0]!.props?._lists, ['page', 'tag'])
})
