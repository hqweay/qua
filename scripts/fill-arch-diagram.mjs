#!/usr/bin/env node
/**
 * `node scripts/fill-arch-diagram.mjs` —— 把架构图 HTML 里的 `{{占位符}}` 换成**这一刻的真值**。
 *
 * 为什么要有这个脚本：那张图是**设计快照**，但抬头上有几处会随代码变的数字
 * （`WORKSPACE_VERSION`、core 模块数、命令条数、门禁基线）。手写进 HTML 的那一刻就开始过期，
 * 而过期的图比没有图更坏 —— 它看上去是权威的。所以：
 *
 *   ① 这几处在 HTML 里写成 `{{占位符}}`，数字由本脚本**从代码里现读 / 现跑**；
 *   ② 结构性的内容（有哪些层、Block 有哪些字段）人工维护 —— 判断不了就留空，
 *      不要为了自动化去猜（猜出来的字段名比空着更糟）。
 *
 * ⚠️ **读不到就大声失败**（退出码非 0），绝不静默填一个旧值：
 *    静默填旧值是这类「自动同步」脚本最坏的行为 —— 图看起来是新的，数字是去年的。
 *
 * 用法：
 *   node scripts/fill-arch-diagram.mjs                     # public/arch.html → dist/arch.html
 *   node scripts/fill-arch-diagram.mjs --in X --out Y       # 指定进出（原地填就两边写同一个）
 *   node scripts/fill-arch-diagram.mjs --json               # 不写文件，只把值打成 JSON 给别的脚本用
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}
const IN = flag('--in') ?? join(ROOT, 'public', 'arch.html')
const OUT = flag('--out') ?? join(ROOT, 'dist', 'arch.html')
const JSON_ONLY = argv.includes('--json')

/** 门禁那两条命令的输出带颜色；解析前先剥掉，别让转义序列钻进正则 */
const strip = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  return { out: strip(`${r.stdout ?? ''}${r.stderr ?? ''}`), err: r.error?.message }
}

/* ------------------------------------------------------------ 现读 / 现跑那几个易变数字 */

function collect() {
  const vals = {}
  const problems = []
  const read = (p) => readFileSync(join(ROOT, p), 'utf8')

  // WORKSPACE_VERSION
  const mVer = /export const WORKSPACE_VERSION = (\d+)/.exec(read('src/core/storage/shape.ts'))
  if (mVer) vals.WORKSPACE_VERSION = mVer[1]
  else problems.push('读不到 WORKSPACE_VERSION（src/core/storage/shape.ts）')

  // core 模块数（只算 .ts 与 .tsx，不看测试）
  try {
    const files = readdirSync(join(ROOT, 'src/core'), { recursive: true })
    vals.CORE_MODULES = String(files.filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)).length)
  } catch (e) {
    problems.push(`数不出 core 模块数：${e.message}`)
  }

  // 命令条数
  try {
    vals.COMMANDS = String((read('src/core/commands/decls.ts').match(/^\s*\{ name: '/gm) ?? []).length)
  } catch (e) {
    problems.push(`数不出命令条数：${e.message}`)
  }

  /**
   * 门禁基线：**现跑** `arch-check` 与 `test:core`，从它们的输出里取数。
   *
   * 为什么不转录一份「上次门禁的结果」：转录物会过期，而过期之后它仍然写在图上、
   * 仍然像权威 —— 那比不写更糟。两条加起来两秒左右（arch-check 0.5s ＋ test:core 1.1s），
   * 这个代价换「图上的数字就是这一刻的真值」是值得的。
   *
   * ⚠️ **跑红了不算读不到**：`arch 18/19` 是一个确定的值，而且它诚实 ——
   *    把它如实印出来，比为了让流水线绿而改写它好。只有输出里**压根没有那个数**才是读不到。
   */
  const arch = run(process.execPath, ['scripts/arch-check.mjs'])
  const mArch = /硬断言\s+(\d+\/\d+)\s+过/.exec(arch.out)
  const core = run(process.execPath, ['--test', ...readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => `tests/${f}`)])
  const mPass = /ℹ\s+pass\s+(\d+)/.exec(core.out)
  const mTests = /ℹ\s+tests\s+(\d+)/.exec(core.out)

  if (mArch) {
    if (mPass && mTests) vals.GATE = `arch ${mArch[1]} · core ${mPass[1]}/${mTests[1]}（本次现算）`
    else problems.push(`读不到单测条数（test:core 输出里没有 pass/tests）${core.err ? `：${core.err}` : ''}`)
  } else {
    problems.push(`读不到架构断言数（arch-check 输出里没有「硬断言 N/M 过」）${arch.err ? `：${arch.err}` : ''}`)
  }

  return { vals, problems }
}

/* ------------------------------------------------------------ 填充 */

const { vals, problems } = collect()
const missing = []
const html = readFileSync(IN, 'utf8').replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => {
  const v = vals[key]
  if (v === undefined || v === '') {
    missing.push(key)
    // 渲染成显式破折号，而不是空白（空白像「本来就没有这一项」）
    return '—'
  }
  return v
})

const uniqMissing = [...new Set(missing)]
for (const p of problems) console.error(`⚠ ${p}`)

if (JSON_ONLY) {
  // stdout 只给 JSON，便于别的脚本 `JSON.parse`；警告一律走 stderr
  console.log(JSON.stringify({ ...vals, missing: uniqMissing, problems }, null, 1))
} else {
  if (!existsSync(dirname(OUT))) console.error(`⚠ 输出目录不存在：${dirname(OUT)}`)
  writeFileSync(OUT, html, 'utf8')
  console.log(`✔ ${OUT.replace(`${ROOT}/`, '')}（占位符 ${uniqMissing.length ? `缺 ${uniqMissing.length} 处` : '已全部填上'}）`)
  console.log(`  version ${vals.WORKSPACE_VERSION ?? '—'} · core ${vals.CORE_MODULES ?? '—'} 模块 · 命令 ${vals.COMMANDS ?? '—'} 条`)
  console.log(`  ${vals.GATE ?? '（门禁基线读不到）'}`)
}

/* 有占位符没填上 ⇒ 红。这是它挂在部署流水线里的全部理由：
   「数字读不到了」必须让发布停下来，而不是打一行警告继续出一张看起来权威的图。 */
if (uniqMissing.length) {
  console.error(`✘ 未填占位符：${uniqMissing.join(', ')}（图上渲染为 —）`)
  process.exit(1)
}
