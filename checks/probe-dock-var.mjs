/**
 * 探针：**拖槽宽时每帧写在 `#app` 上的那个 CSS 变量，代价有多大？**
 *
 * 背景（AGENTS.md §1.12 最后一条）：`ui/dock.ts:497` 的 `applyDockWidth` 把 `--dock-left-w` /
 * `--dock-right-w` 写在 **`#app`** 上，因为 `#app` 自己的 `grid-template-columns` 在读它
 * （`styles/shell.css:93`）——变量**必须**住在那里，搬不到槽自己身上。
 * 而 CSS 变量是**继承**的：写在祖先上，等于给整棵子树打脏 ⇒ 每帧重算样式。
 * 这是别人的库踩过的坑（抽屉里超过 ~20 项就开始掉帧），但**我们从未量过**。
 *
 * ⚠️ 难处：**改槽宽本身就要重排页面**，这笔钱换任何写法都得付，混进来这条结论就没用了。
 *    ⇒ 所以本探针量**四个写法**做逐层对照，把「继承带来的样式重算」单独抠出来：
 *
 *   A 在 `#app` 上写 `--dock-left-w`（现状）      —— 继承 ⇒ 整棵子树重算样式
 *   D 直接写 `#app` 的 `grid-template-columns`    —— 同样的几何变化，但只脏 `#app` 自己
 *   E 用一个**注册成「不继承」**的长度属性做同样的事 —— 候选改法：`@property --dock-*-w { inherits: false }`
 *      （成立的前提：`shell.css:97/99` 是全仓唯一在消费这两个变量的地方，都在 `#app` 自己身上，
 *        没有后代在继承它们 —— 已 grep 确认）
 *   B 在叶子节点上写同一个变量                    —— 隔离「写变量」本身的成本
 *   C 什么都不写，只强行 flush                     —— 隔离「读数」这个动作本身的成本
 *
 *   因为读 `color` **不会**强制 layout，A/D/E 都把重排推迟到真正绘制那一帧 ⟹
 *   三栏口径一致，**A − E ＝ 继承变量给整棵子树带来的样式重算**（那才是可以谈要不要优化的部分）。
 *
 * 再往 `#app` 里灌一批纯 DOM 填充节点重测 ⇒ 得到「每 1000 个节点贵多少」这条斜率，
 * 用它外推到真库（几千～几万节点）时的一帧成本，跟 16.7ms / 8ms（120Hz）比。
 *
 * 用法：node checks/probe-dock-var.mjs            # 填充 4000 行
 *      FILL=12000 node checks/probe-dock-var.mjs
 * 前提：先 `pnpm build:electron`（与 `check:electron` 同一前提，跑的是构建产物）
 * ⚠️ 诊断探针，不进 gate。结论要写「实测」，不写「感觉」。
 */
import { _electron } from 'playwright-core'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const CACHE = join(ROOT, '.cache', 'dock-var')
rmSync(CACHE, { recursive: true, force: true })
mkdirSync(CACHE, { recursive: true })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)
const FILL = Number(process.env.FILL ?? 4000)
const ROUNDS = 60
/**
 * 一轮 benchmark。
 *
 * ⚠️ flush 用 `getComputedStyle(deep).color` 而不是 `offsetWidth`：我们要的是**样式重算**，
 *    `offsetWidth` 会把 layout 再算一遍 —— 而 layout 属于「改宽度本来就要付」的那一笔，
 *    两边都混进去就分不出 A 与 D 的差别了。
 * ⚠️ 每个写法先 warmup：第一次写会连带初始化 inline style 结构与第一遍重排，那次不属于稳态。
 */
const BENCH = ({ rounds, deepSel }) => {
  /** 与 `styles/shell.css` 的三列轨道同源；这里只需要「写一个会触发同样重排的值」。
   *  ⚠️ 必须定义在页面进程里：`page.evaluate` 把函数序列化过去，Node 这边的闭包它拿不到。 */
  const cols = (w) =>
    `minmax(var(--dock-left-min), ${w}px) var(--ui-center-w, 1fr) minmax(var(--dock-right-min), var(--dock-right-w))`
  const appEl = document.getElementById('app')
  if (!appEl) return { error: 'no #app' }
  const deep = () => document.querySelector(deepSel)
  const leaf = document.createElement('div')
  document.body.appendChild(leaf)

  const run = (fn) => {
    for (let i = 0; i < 8; i++) fn(i) // warmup
    const t0 = performance.now()
    for (let i = 0; i < rounds; i++) {
      fn(i)
      void getComputedStyle(deep()).color // 强行 flush：把这一帧的重算包进计时
    }
    return (performance.now() - t0) / rounds
  }

  const out = {
    // A 现状：写在 #app 上的继承变量
    onApp: run((i) => appEl.style.setProperty('--dock-left-w', `${220 + (i % 40)}px`)),
    // D 对照：同样的重排，但不动继承变量
    onGrid: run((i) => {
      appEl.style.gridTemplateColumns = cols(220 + (i % 40))
    }),
    // B 叶子
    onLeaf: run((i) => leaf.style.setProperty('--dock-left-w', `${220 + (i % 40)}px`)),
    // C 只读
    noop: run(() => {}),
    nodesInApp: appEl.querySelectorAll('*').length,
  }

  /**
   * E 候选改法：把槽宽变量注册成**不继承**的长度属性（`CSS.registerProperty` 是 `@property` 的运行时版本）。
   * ⚠️ 第二次跑会撞「已经注册过」，那次抛错吞掉即可；每个渲染进程注册一次是幂等的。
   * ⚠️ 语法必须是 `<length>` 且给 `initialValue` —— 不继承的注册属性这两项都是必需的。
   */
  const regName = '--probe-dock-w'
  try {
    CSS.registerProperty({ name: regName, syntax: '<length>', inherits: false, initialValue: '240px' })
  } catch {
    /* 已注册 */
  }
  const restore = appEl.style.gridTemplateColumns
  appEl.style.gridTemplateColumns =
    `minmax(var(--dock-left-min), var(${regName})) var(--ui-center-w, 1fr) minmax(var(--dock-right-min), var(--dock-right-w))`
  out.onRegistered = run((i) => appEl.style.setProperty(regName, `${220 + (i % 40)}px`))
  appEl.style.gridTemplateColumns = restore

  leaf.remove()
  appEl.style.removeProperty('--dock-left-w')
  appEl.style.removeProperty(regName)
  appEl.style.removeProperty('grid-template-columns')
  return out
}

const app = await _electron.launch({
  args: [ROOT, `--user-data-dir=${CACHE}`, '--no-sandbox', '--disable-gpu'],
  env,
})
const page = await app.firstWindow()
await page.waitForFunction(() => Boolean(window.__qua), null, { timeout: 30000 })
await page.evaluate(() => window.__qua.quiet(true))
await sleep(500)

const base = await page.evaluate(BENCH, { rounds: ROUNDS, deepSel: '.blk' })
if (base.error) {
  log(`✗ ${base.error}`)
  await app.close()
  process.exit(1)
}

const filled = await page.evaluate((n) => {
  /**
   * 纯 DOM 填充：挂在 `#scroll` 下、但在 `#doc` 之外，编辑器不会来重画它。
   * 形状照 `.blk` 抄（一个容器两个子节点），让样式重算的量级接近真实文档。
   */
  const host = document.getElementById('scroll') ?? document.getElementById('app')
  const box = document.createElement('div')
  box.id = 'probe-filler'
  box.style.cssText = 'position:absolute;left:-9999px;top:0;width:100px'
  const frag = document.createDocumentFragment()
  for (let i = 0; i < n; i++) {
    const row = document.createElement('div')
    row.className = 'blk'
    row.setAttribute('data-block-id', `filler-${i}`)
    const a = document.createElement('span')
    a.textContent = `filler ${i}`
    const b = document.createElement('span')
    row.append(a, b)
    frag.appendChild(row)
  }
  box.appendChild(frag)
  host.appendChild(box)
  return document.getElementById('app').querySelectorAll('*').length
}, FILL)

const big = await page.evaluate(BENCH, { rounds: ROUNDS, deepSel: '#probe-filler > .blk:last-child' })

const net = (r, k) => r[k] - r.noop
const us = (v) => `${(v * 1000).toFixed(1)}μs`
const row = (name, r) =>
  `${name.padEnd(14)} 写 #app 变量 ${us(net(r, 'onApp'))} | 改成不继承 ${us(net(r, 'onRegistered'))} | 直接改 grid ${us(net(r, 'onGrid'))} | 写叶子 ${us(net(r, 'onLeaf'))} | 只读 ${us(r.noop)}`

log(`节点数：#app 基线 ${base.nodesInApp} → 灌 ${FILL} 行后 ${filled}`)
log('')
log(row('【基线】', base))
log(row(`【灌 ${FILL} 行】`, big))

/** 继承的那份额外开销 = 写变量 − 同样的几何变化但不走继承。（A − E） */
const inherit0 = net(base, 'onApp') - net(base, 'onRegistered')
const inherit1 = net(big, 'onApp') - net(big, 'onRegistered')
const slopeApp = (net(big, 'onApp') - net(base, 'onApp')) / (filled - base.nodesInApp)
const slopeReg = (net(big, 'onRegistered') - net(base, 'onRegistered')) / (filled - base.nodesInApp)

log('')
log(`继承的额外开销（A−E）：基线 ${us(inherit0)} → 灌满后 ${us(inherit1)}`)
log(`斜率 /1000 节点：写变量 +${(slopeApp * 1e6).toFixed(0)}μs · 不继承 +${(slopeReg * 1e6).toFixed(0)}μs`)
const at = (n, k) => (net(base, k) + ((net(big, k) - net(base, k)) / (filled - base.nodesInApp)) * (n - base.nodesInApp)) * 1000
log(`外推一帧成本：10k 节点 现状 ${at(10000, 'onApp').toFixed(0)}μs／不继承 ${at(10000, 'onRegistered').toFixed(0)}μs · 50k 节点 现状 ${at(50000, 'onApp').toFixed(0)}μs／不继承 ${at(50000, 'onRegistered').toFixed(0)}μs`)

const budgetMs = 8 // 120Hz 的一帧
const verdict = {
  '写叶子几乎不要钱（净 <50μs）': net(big, 'onLeaf') < 0.05, // ⚠️ 下面所有耗时单位统一是 **ms**
  '写 #app 比「同样的几何变化」贵得多（继承确实有代价）': inherit1 > 0.1,
  [`改法有用：${filled} 节点时不继承的一帧在预算内（<${budgetMs}ms）`]: net(big, 'onRegistered') < budgetMs,
  [`50k 节点下现状仍在预算内（<${budgetMs}ms）`]: at(50000, 'onApp') / 1000 < budgetMs,
}
log('')
log('══════ 结论 ══════')
log(JSON.stringify(verdict, null, 2))
const failed = Object.entries(verdict).filter(([, v]) => !v)
if (failed.length) log(`\n⚠ 待办：${failed.map(([k]) => k).join(' / ')}`)
else log('\n✔ 现状可以不改：这笔钱还在预算内，结论留在这里，别过早优化')

await app.close()
