/**
 * 落库映射**不许静默漏列**：库里每一格系统属性，都要能被编码器写进某张表。
 *
 * 为什么这条值得留：
 *   `props` 是**自由袋**——往 `props` 上写一格新东西，类型系统不会拦、门禁也不会拦。
 *   漏一个的后果不是报错，是**那个属性在库里消失**（装载回来读不到），
 *   而且要到用户发现「我的收藏卡空了」时才知道。
 *
 * 判据（全部从编码器派生，不读任何仓库外的文档）：
 *   1. `src/core/**` 里出现的每个系统属性键，写一格都能落到某张表
 *      （具名去处在 `STORAGE_PROP_HOMES`，其余默认进 `BlockProperty`）；
 *   2. 具名去处表里列出的键，代码里都还在用（不留已死的条目）；
 *   3. `_mounts` 这类结构化值仍走属性表（它曾被漏掉）。
 *
 * ⚠️ 这条**不是**「schema 现在就冻结」：表结构可以随改随动。它拦的是「编码器漏掉一格」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  STORAGE_PROP_HOMES,
  propRows,
  workspaceToRowWrites,
  type StoredWorkspace,
} from '../../src/core/storage/db-rows.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** 代码里**真的会出现**的系统属性键：`*_PROP` 常量 ＋ 直接写的字面量（`'_kind'` 这类） */
function codeSystemProps(): Map<string, string> {
  /**
   * 两种写法都要收：有的键有常量（`ALIASES_PROP`），有的直接写成字面量（`'_kind'`）。
   * 只收常量会漏掉后者，于是反向检查把六个真在用的键判成「已死」——实测踩到。
   * `LEGACY_*` 是**读旧形状**用的键（`_alias` 是 `_aliases` 改名前的写法），不要求落点。
   */
  const out = new Map<string, string>()
  const legacy = new Set<string>()
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith('.ts')) {
        const relPath = p.slice(ROOT.length + 1)
        const body = readFileSync(p, 'utf8')
        for (const m of body.matchAll(/export const (LEGACY_\w+_PROP)\s*=\s*'(_\w+)'/g)) legacy.add(m[2]!)
        for (const m of body.matchAll(/export const \w+_PROP\s*=\s*'(_\w+)'/g)) out.set(m[1]!, relPath)
        // 直接写字面量的系统属性（`'_kind'` / `'_icon'` / `'_query'` …）
        for (const m of body.matchAll(/'(_{1,2}[a-zA-Z][a-zA-Z0-9]*)'/g)) {
          if (!out.has(m[1]!)) out.set(m[1]!, relPath)
        }
      }
    }
  }
  walk(join(ROOT, 'src/core'))
  for (const k of legacy) out.delete(k)
  return out
}

/**
 * 已退场的系统键：它们还会在代码里出现，但**只在「拒绝它」的那一侧**
 * （`shape.ts` 把 `_roles` 判成 corrupt、`alias.ts` 读 `_alias` 的旧形状）。
 * 它们不该有落点——要求有落点反而会诱导人建一个只为兼容而存在的列。
 */
const HISTORICAL = new Set(['_parentTags', '_roles', '_hide', '_page', '_template', '_label', '_refcount', '_alias', '_items'])

/**
 * 写一格属性的**最小合法样值**。
 *
 * 只回答「编码器认不认这个形状」，不是语义值：地址要字符串数组、露面要是 page／tag、
 * 删除标记要是墙钟毫秒，其余按单值传。
 */
function sampleValue(key: string): unknown {
  if (key === '_aliases') return ['样名']
  if (key === '_lists') return ['page']
  if (key === '_deletedAt') return 1
  return '样值'
}

/** 一块只带这一格的森林（整份写路径：最接近「盘上应当有什么」） */
function oneBlockWith(key: string): StoredWorkspace {
  const block = {
    id: 'b',
    content: [{ t: 'text', text: 'x' }],
    children: [],
    created: 1,
    modified: 1,
    props: { [key]: sampleValue(key) },
  }
  return { blocks: [block], activeId: 'b', savedAt: 1 } as unknown as StoredWorkspace
}

test('落库映射：代码里会写的每个系统属性，编码器都能落到某张表', () => {
  const code = codeSystemProps()
  assert.ok(code.size >= 8, `应当扫到至少 8 个系统属性，实际 ${code.size}：${[...code.keys()].join(',')}`)

  const problems: string[] = []
  for (const [key, file] of code) {
    if (HISTORICAL.has(key)) continue
    const writes = workspaceToRowWrites(oneBlockWith(key))
    const home = STORAGE_PROP_HOMES[key]
    if (home === undefined) {
      // 默认去处：属性表里必须有这一格（被排除却没有具名去处 ⇒ 这一格会静默消失）
      if (!writes.some((w) => w.table === 'BlockProperty' && w.key.name === key)) {
        problems.push(`${key}（${file}）没有落点：既不在具名去处里，也没进属性表`)
      }
      continue
    }
    // 具名去处：声明的那张表必须真的收到行；进 `Block` 列的还要确认那一列被填了
    const [table, column] = home.split('.')
    const landed = writes.some((w) => w.table === table)
    const filled =
      column === undefined ||
      writes.some((w) => w.table === 'Block' && w.values?.[column] !== undefined && w.values[column] !== null)
    if (!landed || !filled) problems.push(`${key}（${file}）声明落在 ${home}，但编码器没写进那张表`)
  }
  assert.deepEqual(problems, [], `这些系统属性会被写入，但编码器漏了它们：\n  ${problems.join('\n  ')}`)
})

test('落库映射：具名去处里列的键，代码里都还在（不留已死的条目）', () => {
  const code = codeSystemProps()
  /**
   * 反向也要查：具名去处描述一个已经不存在的属性，会让下一个读它的人以为那一格还在用。
   * 已知豁免见上方 `HISTORICAL`（正向与反向共用同一份）。
   */
  const dead = Object.keys(STORAGE_PROP_HOMES).filter((k) => !code.has(k) && !HISTORICAL.has(k))
  assert.deepEqual(dead, [], `具名去处里这些键代码已经不写了（要么删掉那一行，要么它本该还在）：${dead.join(', ')}`)
})

test('落库映射：`_mounts` 仍进属性表（结构化值曾被漏掉）', () => {
  /**
   * 这格是**审查抓出来的真实漏项**，单独钉一条：它不是「普通属性」——
   * `_mounts` 是非 ref 的结构化值（只能进 `value` 列当 JSON）。
   * 当成普通属性写进 `BlockProperty` 也不会报错，只是装载回来时结构会不对。
   */
  assert.equal(STORAGE_PROP_HOMES['_mounts'], undefined, '`_mounts` 是普通属性，不该有具名去处')
  const rows = propRows('b', '_mounts', [{ label: '看板', spec: { where: { any: [] } } }])
  assert.equal(rows.length, 1, '`_mounts` 应当整份落成一行属性（不是零行）')
  assert.equal(rows[0]!.table, 'BlockProperty')
})
