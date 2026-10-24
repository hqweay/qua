/**
 * 门禁编排 —— `pnpm gate`（全量）／`pnpm gate:web`（不含 Electron）／`pnpm gate:fast`（只跑碰得到的）。
 *
 * **为什么不是 package.json 里那条 `&&` 链**：那条链把彼此独立的检查全串着跑，
 *   而门禁的墙钟时间几乎全花在「真 Chrome／真 Electron 各起一次、每条用例冷启一个文档」上
 *   —— 串行等于多核里只用一个核。这里快的原因是**并发**，不是少跑：断言口径一条没改。
 *
 * 只按**产物依赖**分三段，段内互相独立：
 *   ① typecheck · arch:check · test:core   静态／纯内存，零依赖，也最便宜 ⇒ 先跑，红了就别构建
 *   ② build:test · build:electron          ③ 的两个输入
 *   ③ 浏览器冒烟（用例切片并发）· check:dock · check:electron
 *
 * 每一步都是 **package.json 里已有的那条命令** —— 编排只决定「跑哪些、怎么并发」，
 *   不自己拼命令行（另拼一份就等于有第二个真相，改了一边忘了另一边）。
 *
 * `--fast` 的口径见 `fastPlan()`：按 git 改动判「这次碰得到哪几支」，跳过碰不到的，
 *   并**逐条列出跳过了什么**。它**不是**收工门禁 —— 收工／提交／CI 跑全量。
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, availableParallelism, loadavg } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CPUS = availableParallelism()

const argv = process.argv.slice(2)
const FAST = argv.includes('--fast')
const NO_ELECTRON = argv.includes('--no-electron')
const VERBOSE = process.env.QUA_GATE_VERBOSE === '1'
/** 只打「这次会跑哪些」不真跑：分类表是手工映射，得能一眼核它 */
const PLAN_ONLY = argv.includes('--plan')
/**
 * 冒烟切片数。
 *
 * 按**核数**定（8 核 ⇒ 4 片），不按当时的负载让路：做过的两组对照里，
 *   串行整组与分片整组**红的是同一批用例**——并发没有制造过失败。
 *   机器忙时分片依然比串行快 1.5–2.5 倍（同一条红在负载下本来就会红，那不是并发的锅）。
 *   `--shards=N` 覆盖。
 */
function shardBudget() {
  return Math.max(1, Math.min(4, Math.floor(CPUS / 2)))
}

const shardArg = argv.find((a) => a.startsWith('--shards='))
/** 显式路径（`pnpm gate:fast -- src/core/x.ts`）：明知改了什么时省一次 git 调用 */
const givenPaths = argv.filter((a) => !a.startsWith('--') && a !== '--')
const SHARDS = shardArg ? Math.max(1, Number(shardArg.slice('--shards='.length)) || 1) : shardBudget()

/* ------------------------------------------------------------------ 输出小工具 */

const C = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
}
/** 中日韩字符占两列；标签里有中文，直接 `padEnd` 会错位 */
const width = (s) => [...s].reduce((w, c) => w + (/[\u1100-\uFFFD]/.test(c) ? 2 : 1), 0)
const pad = (s, n) => s + ' '.repeat(Math.max(1, n - width(s)))
const secs = (ms) => `${(ms / 1000).toFixed(1)}s`

/** 从各步输出里抠出那条**可粘贴的结论**（门禁的验收口径就是这一行） */
function evidenceOf(label, out) {
  if (label === 'arch:check') {
    const m = /硬断言 (\d+)\/(\d+) 过/.exec(out)
    if (m) return `硬断言 ${m[1]}/${m[2]}`
  }
  if (label === 'test:core') {
    // node 的 spec reporter 打的是 `ℹ pass 270`（旧版是 `# pass`），两种都认
    const p = /^[ℹ#]\s*pass (\d+)/m.exec(out)
    if (p) return `${p[1]}/${Number(p[1]) + Number(/^[ℹ#]\s*fail (\d+)/m.exec(out)?.[1] ?? 0)}`
  }
  const m = /(\d+)\/(\d+) 通过/.exec(out)
  return m ? `${m[1]}/${m[2]}` : ''
}

/* ------------------------------------------------------------------ 跑一个子进程 */

function spawnStep(cmd, args, env) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let settled = false
    const done = (code) => {
      if (settled) return
      settled = true
      resolve({ code, ms: Date.now() - t0, out })
    }
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('error', (e) => {
      out += `\n${e.message}`
      done(127)
    })
    child.on('close', (code) => done(code ?? 1))
  })
}

/**
 * 一步 = 一条 package.json 脚本。给浏览器那几步加 `QUA_NO_DEV=1`：
 *   门禁验的是**构建产物**，不该跟 5180 上可能属于**另一棵树**的 dev server 通话。
 */
const step = (label, script, env = {}) => ({
  label,
  run: () => spawnStep('pnpm', ['-s', 'run', script], env),
})

const BROWSER = { QUA_NO_DEV: '1' }
const STEPS = {
  typecheck: step('typecheck', 'typecheck'),
  'arch:check': step('arch:check', 'arch:check'),
  'test:core': step('test:core', 'test:core'),
  'build:test': step('build:test', 'build:test'),
  'build:electron': step('build:electron', 'build:electron'),
  'check:dock': step('check:dock', 'check:dock', BROWSER),
  'check:electron': step('check:electron', 'check:electron'),
  smoke: { label: `冒烟（${SHARDS} 片）`, run: () => runSmoke() },
}

/* ------------------------------------------------------------------ 冒烟（切片并发） */

/**
 * 起 N 个进程切片跑同一份用例集，各自把结果写成 JSON，这里合并成**一份**报告。
 *
 * ⚠️ 合并端必须验「切片有没有漏东西」：每条用例只归一片，漏掉的那条**不报错**、
 *    只是不见了 —— 静默少测是分片唯一能悄悄失效的地方。两条判据：
 *    ① 每片报告的 `total` 必须一致（各片看到的是同一份用例集）；
 *    ② 合并后的条数必须**等于** `total`。
 */
async function runSmoke() {
  const dir = await mkdtemp(join(tmpdir(), 'qua-gate-'))
  const t0 = Date.now()
  const rs = await Promise.all(
    Array.from({ length: SHARDS }, async (_, i) => {
      const r = await spawnStep('pnpm', ['-s', 'run', 'check:smoke'], {
        ...BROWSER,
        QUA_SMOKE_SHARD: `${i}/${SHARDS}`,
        QUA_SMOKE_REPORT: join(dir, `s${i}.json`),
      })
      console.log(`    ${r.code === 0 ? C.green('✓') : C.red('✗')} 冒烟${SHARDS > 1 ? ` ${i + 1}/${SHARDS}` : ''} ${secs(r.ms)}`)
      return r
    }),
  )

  let total = null
  const cases = []
  const problems = []
  for (const [i, r] of rs.entries()) {
    if (r.code !== 0) problems.push(`冒烟 ${i + 1}/${SHARDS} 退出码 ${r.code}`)
    let rep = null
    try {
      rep = JSON.parse(await readFile(join(dir, `s${i}.json`), 'utf8'))
    } catch {
      problems.push(`冒烟 ${i + 1}/${SHARDS} 没留下报告（进程异常退出？）`)
      continue
    }
    if (total === null) total = rep.total
    else if (rep.total !== total) problems.push(`冒烟 ${i + 1}/${SHARDS} 看到的用例数 ${rep.total} ≠ ${total}`)
    cases.push(...rep.cases)
  }
  if (total !== null && cases.length !== total) {
    problems.push(`切片漏了用例：合并后 ${cases.length} 条，应有 ${total} 条`)
  }
  cases.sort((a, b) => a.idx - b.idx)
  await rm(dir, { recursive: true, force: true })

  const failures = cases.filter((c) => !c.ok)
  return {
    code: problems.length || failures.length ? 1 : 0,
    ms: Date.now() - t0,
    out: rs.map((r, i) => `--- 冒烟 ${i + 1}/${SHARDS} ---\n${r.out}`).join('\n'),
    problems,
    failures,
    evidence: `${cases.length - failures.length}/${cases.length}`,
  }
}

/* ------------------------------------------------------------------ 跑一组（组内并发） */

/**
 * 组内并发，谁先完成先打状态行（有进度感）；红了的那步把**完整输出**打出来
 *   —— 证据原文，别让人去猜。
 */
async function runGroup(title, items, env = {}) {
  console.log(`\n${C.bold(title)}`)
  for (const it of items) console.log(`  ${C.dim(`▶ ${it.label}`)}`)
  const red = []
  await Promise.all(
    items.map(async (it) => {
      const r = await it.run(env)
      const ok = r.code === 0
      const ev = r.evidence ?? (ok ? evidenceOf(it.label, r.out) : '')
      if (!ok) red.push({ it, r })
      console.log(`  ${ok ? C.green('✓') : C.red('✗')} ${pad(it.label, 18)} ${secs(r.ms).padStart(6)}${ev ? `   ${C.dim(`（${ev}）`)}` : ''}`)
      if (ok && VERBOSE) console.log(r.out.replace(/^/gm, '      '))
    }),
  )
  for (const { it, r } of red) {
    console.log(`\n${C.red(`✗ ${it.label} 输出`)}\n${r.out.replace(/^/gm, '      ')}`)
    for (const p of r.problems ?? []) console.log(`      ${C.red(p)}`)
    for (const c of r.failures ?? []) {
      console.log(`      ${C.red('FAIL')}  ${c.name}\n            ${String(c.msg).replace(/\n/g, '\n            ')}`)
    }
  }
  return red.length === 0
}

/* ------------------------------------------------------------------ 范围选择（--fast） */

/**
 * 「这次改动碰得到哪几支」。
 *
 * 判据只有两条：① 路径落在哪个目录 ⇒ 哪一支；② **认不出来的一律按「全量」**。
 * ⚠️ 这是一份**手工映射**：它一旦错，就会跳掉本该跑的用例，而跳掉的用例不会报错。
 *    所以它只服务 `--fast`，且 `--fast` 的输出里必须写明「跳过了什么、收工请跑 pnpm gate」。
 */
const AREA = {
  core: '核心与单测',
  web: '浏览器可见（view／ui／app／main／样式）',
  electron: 'Electron 壳',
  meta: '门禁与构建自身',
  docs: '文档',
}

/** 全量的组成 —— 也是 `--fast` 算「跳过了什么」的参照 */
const FULL = {
  base: ['typecheck', 'arch:check', 'test:core'],
  build: ['build:test', 'build:electron'],
  after: ['smoke', 'check:dock', 'check:electron'],
}
const NAME = { smoke: '浏览器冒烟' }

function fastPlan(paths) {
  const hit = new Set()
  const unknown = []
  for (const p of paths) {
    if (/^(docs\/|\.github\/)/.test(p) || /\.md$/.test(p) || /^(LICENSE|\.gitattributes|\.gitignore)$/.test(p)) hit.add('docs')
    else if (p.startsWith('electron/')) hit.add('electron')
    else if (p.startsWith('tests/') || p.startsWith('src/core/')) hit.add('core')
    else if (p.startsWith('src/') || p === 'index.html') hit.add('web')
    else if (p.startsWith('checks/') || p.startsWith('scripts/')) hit.add('meta')
    else if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|vite\.config\.ts|tsconfig[\w.]*\.json|\.node-version|\.npmrc)$/.test(p)) hit.add('meta')
    else unknown.push(p)
  }
  // 认不出来 / 改的是门禁与构建自身 ⇒ 这套映射没有发言权，全量
  const full = unknown.length > 0 || hit.has('meta')
  const why = unknown.length ? `认不出的路径：${unknown.join('、')}` : hit.has('meta') ? '改动落在门禁／构建自身' : ''
  const areas = [...hit].map((a) => AREA[a] ?? a)
  if (full) return assemble({ paths, areas, full, why, ...FULL })

  const web = hit.has('web')
  const electron = hit.has('electron')
  return assemble({
    paths,
    areas,
    full: false,
    why,
    base: hit.has('core') || web || electron ? FULL.base : [],
    // Electron 冒烟读的是 dist/index.html ⇒ 也要 build:test；但它不在 Chrome 里跑，与 view 改动互不相干
    build: [...(web || electron ? ['build:test'] : []), ...(electron ? ['build:electron'] : [])],
    after: [...(web ? ['smoke', 'check:dock'] : []), ...(electron ? ['check:electron'] : [])],
  })
}

/** 补齐 `skipped`：**跳过什么必须逐条列出来**，不能只报跑了什么 */
function assemble(p) {
  const ran = new Set([...p.base, ...p.build, ...p.after])
  const skipped = [...FULL.base, ...FULL.build, ...FULL.after].filter((k) => !ran.has(k)).map((k) => NAME[k] ?? k)
  return { ...p, skipped }
}

function gitChangedPaths() {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
  const list = [...git(['diff', '--name-only', 'HEAD']).split('\n'), ...git(['ls-files', '--others', '--exclude-standard']).split('\n')]
  return [...new Set(list.filter(Boolean))]
}

/* ------------------------------------------------------------------ 主流程 */

const t0 = Date.now()

let plan
if (FAST) {
  let paths = givenPaths
  if (!paths.length) {
    try {
      paths = gitChangedPaths()
    } catch {
      paths = null
    }
  }
  if (paths === null) {
    plan = assemble({ paths: [], areas: [], full: true, why: '取不到 git 改动（不是 git 仓库？）', ...FULL })
  } else {
    plan = fastPlan(paths)
  }
  const label = plan.full ? C.yellow('全量（--fast 判不出范围）') : 'fast'
  console.log(`\n${C.bold(`门禁 · ${label}`)}${plan.why ? C.dim(` —— ${plan.why}`) : ''}`)
  console.log(`  改动：${plan.paths.length ? plan.paths.join('  ') : '（无）'}`)
  console.log(`  沾到的面：${plan.areas.length ? plan.areas.join(' ／ ') : '（无）'}`)
  if (plan.skipped.length) console.log(`  跳过：${plan.skipped.join(' · ')}`)
  if (!plan.full) console.log(`  ${C.yellow('⚠ fast 不是收工门禁 —— 跳过的那几步都可能被这次改动弄红；收工前跑 pnpm gate')}`)
} else {
  console.log(`\n${C.bold('门禁 · 全量')}${C.dim(`（${CPUS} 核 · load ${loadavg()[0].toFixed(1)} ⇒ 冒烟切 ${SHARDS} 片）`)}`)
}

const baseKeys = plan ? plan.base : ['typecheck', 'arch:check', 'test:core']
let buildKeys = plan ? plan.build : ['build:test', 'build:electron']
let afterKeys = plan ? plan.after : ['smoke', 'check:dock', 'check:electron']
// `--no-electron`：`build:electron` 的唯一读者是 `check:electron`，不跑它就不必构建壳
if (NO_ELECTRON) {
  afterKeys = afterKeys.filter((k) => k !== 'check:electron')
  buildKeys = buildKeys.filter((k) => k !== 'build:electron')
}

if (PLAN_ONLY) {
  const show = (K) => (K.length ? K.join(' · ') : '（跳过）')
  console.log(`  ① 静态与单测：${show(baseKeys)}`)
  console.log(`  ② 构建：${show(buildKeys)}`)
  console.log(`  ③ 冒烟 · 布局 · Electron：${show(afterKeys)}\n`)
  process.exit(0)
}

function finish(failWhy) {
  console.log(`\n${C.red('门禁没过')} —— ${failWhy}\n`)
  process.exit(1)
}

if (baseKeys.length) {
  const ok = await runGroup('① 静态与单测（并发）', baseKeys.map((k) => ({ ...STEPS[k] })))
  if (!ok) finish('① 红了，构建与冒烟都没跑（省下的是几十秒，不是几十条断言）')
}

if (buildKeys.length) {
  const ok = await runGroup('② 构建（并发）', buildKeys.map((k) => ({ ...STEPS[k] })))
  if (!ok) finish('② 红了，没有可信产物，冒烟不跑')
}

if (afterKeys.length) {
  const ok = await runGroup('③ 冒烟 · 布局 · Electron（并发）', afterKeys.map((k) => ({ ...STEPS[k] })), BROWSER)
  if (!ok) finish('见上面的 ✗')
}

console.log(`\n${C.green('门禁全绿')} · ${secs(Date.now() - t0)}\n`)
