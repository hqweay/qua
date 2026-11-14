/**
 * **视觉判据机检**：把「一个面只用一种（满强度的）分离手段」与「悬停与选中必须分家」
 * 这几条可判定的判据变成能跑的东西。
 *
 * 为什么要有它：`设计-界面分层.md` 里的判据如果不跑，就只是形容词。这轮改动里
 * 同一个判据被实测修正过三次（「不许有边框」→「大面积留浅边」、「所有 hover 都中性」
 * →「只有和选中态冲突时才中性」），说明**判据本身会漂**；漂的时候得有人能立刻看见。
 *
 * 用法：
 *   node scripts/check-visual-invariants.mjs            # 只报告，不拦门（默认）
 *   node scripts/check-visual-invariants.mjs --strict   # 有命中就 exit 1
 *
 * 口径：
 *   · 只看 `src/styles/*.css`，注释先剥掉（注释里讨论判据不算违规）。
 *   · **不是「有边框就错」**：满强度边框（`--ui-border`）与中等以上影（mid/pop）同时出现才算双框。
 *     极淡边框（`--ui-border-subtle`）+ 三层影是**正解**，不报。
 *   · 分隔线（`border-top/bottom/left/right`）是「语义断开」，不算外壳分离，不报。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../src/styles/', import.meta.url).pathname
const STRICT = process.argv.includes('--strict')

/**
 * 明确豁免的命中：**每条都要写为什么**，否则这张表会长成「反正加上就不报了」。
 * 豁免不许改判据，只说明「这一处不是那个问题」。
 */
const EXEMPT = [
  { file: 'shell.css', sel: '.boot-notice', why: '启动期的常驻提示，不是浮层；边框是它的边，影只是压住身后的内容' },
  { file: 'badge.css', sel: '#state-menu-btn', why: '是控件不是浮层：它固定在角落、不会自己消失' },
  { file: 'overlays.css', sel: '.toast', why: '边框在传语义（--ui-ok / --ui-danger），不是分离手段' },
  {
    file: 'overlays.css',
    sel: '.dnd-hint',
    why: '跟随光标、面积很小、pointer-events:none —— 它没有「被谁压住」的关系要表达，硬边比影可靠',
  },
]

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

/** 把一份 css 切成 `{sel, body, at}`；`at` 是规则在当前文件里的序号（给排序用） */
const rulesOf = (src) => {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(src))) {
    const sel = m[1]
      .trim()
      .split('\n')
      .pop()
      .trim()
    if (!sel || sel.startsWith('@')) continue
    out.push({ sel, body: m[2], at: m.index })
  }
  return out
}

const files = readdirSync(ROOT).filter((f) => f.endsWith('.css'))
const hits = []

for (const file of files) {
  const src = stripComments(readFileSync(join(ROOT, file), 'utf8'))
  const rules = rulesOf(src)

  /* ---- 判据 2：满强度边框 ＋ 中等以上影 = 双框 ---- */
  for (const r of rules) {
    const fullBorder = /border:\s*[^;]*solid\s*var\(--ui-border\)/.test(r.body)
    const strongShadow = /box-shadow:\s*var\(--ui-shadow-(mid|pop)\)/.test(r.body)
    if (fullBorder && strongShadow) {
      hits.push({ file, sel: r.sel, kind: '双框', note: '满强度边框与中等以上影同时上' })
    }
  }

  /* ---- 判据 3：同一元素的 hover 与选中态同色 ---- */
  const accented = rules.filter((r) => /background:\s*var\(--ui-accent-soft\)/.test(r.body))
  for (const h of accented.filter((r) => /:hover/.test(r.sel))) {
    const base = h.sel.replace(/:hover/g, '')
    const twin = accented.find((r) => r !== h && !/:hover/.test(r.sel) && r.sel.startsWith(base))
    if (twin) hits.push({ file, sel: h.sel, kind: '悬停同色', note: `与 ${twin.sel} 同底色，指针位置与「已选中」分不清` })
  }
}

const kept = hits.filter((h) => !EXEMPT.some((e) => e.file === h.file && e.sel === h.sel))

const group = (list) => {
  const by = new Map()
  for (const h of list) {
    const k = `${h.file} :: ${h.kind}`
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(h)
  }
  return by
}

const report = (title, list) => {
  if (list.length === 0) return
  console.log(`\n${title}`)
  for (const [k, rows] of group(list)) {
    console.log(`  ${k}`)
    for (const r of rows) console.log(`    · ${r.sel}  —— ${r.note}`)
  }
}

if (kept.length > 0) {
  report('✘ 判据命中（新组件不该添新的，老的等轮到再改）', kept)
}
const exemptUsed = hits.filter((h) => !kept.includes(h))
if (exemptUsed.length > 0) {
  report('· 已豁免（表在脚本顶部，每条都写了为什么）', exemptUsed)
}

if (kept.length === 0) {
  console.log('✔ 视觉判据：无新增命中')
} else {
  console.log(`\n共 ${kept.length} 处。默认只报告、不拦门；\`--strict\` 时有命中即 exit 1。`)
}

process.exit(STRICT && kept.length > 0 ? 1 : 0)
