/**
 * 落库映射**不许静默漏列**：库里的每一个系统属性，都要在映射表里有一个落点。
 *
 * 为什么这条值得留（哪怕现在建表可以随意改）：
 *   `props` 是**自由袋**——往 `props` 上写一格新东西，类型系统不会拦、门禁也不会拦。
 *   于是「这个属性落哪」只有写映射表的人知道。漏一个的后果不是报错，是**那个属性在库里消失**
 *   （装载回来读不到），而且要到用户发现「我的收藏卡空了」时才知道。
 *
 * 判据：`src/core/**` 里导出的 `*_PROP` 常量（＝代码真的会写的键）**必须全部**出现在
 * `落库蓝本.md` 的 §5 映射表里；少一个就红，多一个（映射表里有、代码里没有）也红——
 * 后者说明映射表在描述一个已经不存在的东西。
 *
 * ⚠️ 这条**不是**「schema 现在就冻结」：表结构可以随改随动。它拦的是「映射表与代码分叉」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', '..')
const BLUEPRINT = join(ROOT, '..', '落库蓝本.md')

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

/** 蓝本 §5 映射表里**左列**（当前模型里的系统属性名） */
function blueprintMappedProps(): Set<string> {
  const md = readFileSync(BLUEPRINT, 'utf8')
  const start = md.indexOf('## 5. 当前模型映射 v2')
  assert.ok(start >= 0, '找不到 `## 5. 当前模型映射 v2`：映射表的位置变了，这条断言要跟着改')
  const rest = md.slice(start)
  const next = rest.indexOf('\n## ', 3)
  const section = next < 0 ? rest : rest.slice(0, next)
  const out = new Set<string>()
  /**
   * 只取**表格第一列**（`| \`_xxx\` | 落点 | 说明 |` 里的第一格）。
   * 整节扫会把右列（落点）也当成「代码里的属性名」，于是反向检查全是误报
   * （右列本来就写着 `Block.deleted` 这种不在代码里的东西）。
   */
  for (const line of section.split('\n')) {
    const m = /^\|\s*`(_[A-Za-z]+)`/.exec(line)
    if (m) out.add(m[1]!)
  }
  return out
}

/**
 * 已退场的系统键：它们还会在代码里出现，但**只在「拒绝它」的那一侧**
 * （`shape.ts` 把 `_roles` 判成 corrupt、`alias.ts` 读 `_alias` 的旧形状）。
 * 它们不该有落点——要求有落点反而会诱导人建一个只为兼容而存在的列。
 */
const HISTORICAL = new Set(['_parentTags', '_roles', '_hide', '_page', '_template', '_label', '_refcount', '_alias'])

test('落库映射：代码里会写的每一个系统属性，都在蓝本 §5 有落点', () => {
  const code = codeSystemProps()
  const mapped = blueprintMappedProps()
  assert.ok(code.size >= 8, `应当扫到至少 8 个系统属性常量，实际 ${code.size}：${[...code.keys()].join(',')}`)

  const missing = [...code.entries()]
    .filter(([key]) => !mapped.has(key) && !HISTORICAL.has(key))
    .map(([key, file]) => `${key}（${file}）`)
  assert.deepEqual(
    missing,
    [],
    `这些系统属性在代码里会被写入，但蓝本 §5 没给落点（漏了＝装载回来这一格消失）：\n  ${missing.join('\n  ')}`,
  )
})

test('落库映射：映射表里列的系统属性，代码里都还在（不留已死的键）', () => {
  const code = codeSystemProps()
  const mapped = blueprintMappedProps()
  /**
   * 反向也要查：映射表描述一个已经不存在的属性，会让下一个读它的人以为那一格还在用。
   * 已知豁免：`_parentTags` 是**改名前的旧键**（蓝本正文里明写「已改名」），
   * 它出现在映射表里是留痕，不是漏。
   */
  // 豁免集合在文件上方（正向与反向共用同一份）
  const dead = [...mapped].filter((k) => !code.has(k) && !HISTORICAL.has(k))
  assert.deepEqual(dead, [], `映射表里这些键代码已经不写了（要么删掉那一行，要么它本该还在）：${dead.join(', ')}`)
})

test('落库映射：`_items` 与 `_mounts` 必须有落点（它们曾被漏掉）', () => {
  /**
   * 这两格是**审查抓出来的真实漏项**，单独钉一条：它们都不是「普通属性」——
   * `_items` 是有序引用（要 `pos` ＋ 指向边），`_mounts` 是非 ref 的结构化值（只能进 `value` 列当 JSON）。
   * 当成普通属性写进 `BlockProperty` 也不会报错，只是装载回来时顺序/结构会不对。
   */
  const mapped = blueprintMappedProps()
  for (const key of ['_items', '_mounts']) {
    assert.ok(mapped.has(key), `${key} 在蓝本 §5 里没有落点`)
  }
})
