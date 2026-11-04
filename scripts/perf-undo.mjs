#!/usr/bin/env node
/**
 * 撤销快照的**改前读数**：100k 块下 `snap`／`restore`／`undo` 的耗时、
 * 序列化字节、以及撤销栈在不同深度上真正占住的内存。
 *
 * 为什么要一个可复算的脚本：撤销是**唯一**还跟着库体量走的交互路径，
 * 而它的成本分布在三处（快照序列化、整片森林 diff、op 应用），
 * 只测其中一处会得出「优化没生效」的错觉。
 *
 * 口径：
 *   · 库 ＝ 固定种子的合成森林（10k 个顶层块 × 9 个子块），每块一段中文、
 *     10% 有地址、20% 带标签 —— 只回答量级，不做内容评测；
 *   · 耗时取中位数（并发门禁下瞬时值会抖）；**字节数**才是与体量无关的判据；
 *   · 内存用 `--expose-gc` 强制回收后量 `heapUsed`；深度 100 在 100k 块上会占
 *     数 GB，所以那一条在小库上量、再按线性外推（脚本会同时打实测与估算）。
 *
 * 用法：
 *   node --expose-gc scripts/perf-undo.mjs
 *   QUA_UNDO_N=10000 node scripts/perf-undo.mjs
 */
import { BlockStore } from '../src/core/model/store.ts'
import { writeBlockContent } from '../src/core/model/model.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { diff } from '../src/core/kb/diff.ts'

const N = Math.max(10, Math.trunc(Number(process.env.QUA_UNDO_N ?? 100_000)) || 100_000)
const SMALL_N = Math.max(10, Math.trunc(Number(process.env.QUA_UNDO_SMALL_N ?? 10_000)) || 10_000)
const ROOTS = Math.max(1, Math.floor(N / 10))

const FRAGMENTS = [
  '笔记应用是本地优先的双链笔记工具',
  '这一页记录会议纪要与下一步安排',
  '索引把正文拆成词与单字两条召回路径',
  '行内图片是内容寻址的字节只存一份',
  '查询冻结成员与顺序内容按块 id 现读',
  '今天的日记从早上开始写到现在',
  '属性与露面是两套语义不要混在一起',
  '拖动块会把整棵子树一起搬走',
  '标签是归属不是正文里的几个字',
  '删除是原位软删可以恢复',
]

/** 固定种子的线性同余：同一条命令永远同一份库 */
function rng(seed) {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

/** 一棵「像笔记」的森林：顶层块各带 9 个子块，地址与标签只落在少数块上 */
function buildForest(n) {
  const rand = rng(46)
  const roots = Math.max(1, Math.floor(n / 10))
  const forest = []
  let made = 0
  for (let r = 0; r < roots && made < n; r++) {
    const root = make(made++, roots)
    for (let c = 0; c < 9 && made < n; c++) root.children.push(make(made++, roots))
    forest.push(root)
  }
  return forest

  function make(i, rootCount) {
    const text = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
    const block = {
      id: `b${String(i).padStart(7, '0')}`,
      content: textRuns(`${text}。第${i}条。`),
      children: [],
      created: 1_700_000_000_000 + i,
      modified: 1_700_000_000_000 + i,
    }
    if (i % 10 === 0) block.props = { _aliases: [`名字-${i}`, `别名-${i}`], _lists: i % 20 === 0 ? ['page'] : [] }
    else if (i % 20 === 0) block.props = { _tags: ['t1'] }
    return block
  }
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b)
  return { p50: pct(s, 50), p95: pct(s, 95) }
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function selOf(store) {
  const b = store.blocks[Math.floor(store.blocks.length / 2)]
  return { aBlock: b.id, aOff: 0, hBlock: b.id, hOff: 0 }
}

/** 改一块正文（一次按键的形状）：替换数组 ＋ 改时刻 */
function typeOnce(store) {
  const b = store.blocks[Math.floor(store.blocks.length / 2)]
  writeBlockContent(b, textRuns(`改过的正文 ${b.modified}`))
  b.modified += 1
}

const gc = globalThis.gc ?? (() => {})

function measureRun(n, label) {
  const forest = buildForest(n)
  const store = new BlockStore(forest)
  const sel = selOf(store)
  // 索引是懒建的：先叫醒它，否则第一次 restore 会把整库重建算进来（真实路径里它早建好了）
  store.find(sel.aBlock)
  const snap = store.snap(sel)
  const bytes = snap.blocks.length

  const snapSamples = []
  for (let i = 0; i < 24; i++) {
    const t = performance.now()
    store.snap(sel)
    snapSamples.push(performance.now() - t)
  }

  // 撤销一次 ＝ 取当前快照 ＋ 解析目标 ＋ diff ＋ applyOps（＋ 索引修补）
  const undoStoreSamples = []
  const restoreSamples = []
  const parseSamples = []
  const diffSamples = []
  for (let i = 0; i < 20; i++) {
    const target = store.snap(sel)
    typeOnce(store)
    store.record(target, 'other', 0)
    let t = performance.now()
    store.undo(undefined, sel)
    undoStoreSamples.push(performance.now() - t)
    // store.undo 之后状态回到快照；再走一次「只 restore」的拆解（目标另取一份）
    const s2 = store.snap(sel)
    typeOnce(store)
    t = performance.now()
    const parsed = JSON.parse(s2.blocks)
    parseSamples.push(performance.now() - t)
    t = performance.now()
    const ops = diff(store.blocks, parsed)
    diffSamples.push(performance.now() - t)
    t = performance.now()
    store.restore(s2, undefined)
    restoreSamples.push(performance.now() - t)
  }

  const snapStats = stats(snapSamples)
  const undoStats = stats(undoStoreSamples)
  const restoreStats = stats(restoreSamples)
  const parseStats = stats(parseSamples)
  const diffStats = stats(diffSamples)

  console.log(
    `${label.padEnd(7)} blocks=${String(n).padStart(7)}  bytes=${String(bytes).padStart(9)} (${mb(bytes)})  ` +
      `snap p50=${snapStats.p50.toFixed(2)}ms  undo p50=${undoStats.p50.toFixed(2)}ms  ` +
      `restore p50=${restoreStats.p50.toFixed(2)}ms [parse ${parseStats.p50.toFixed(2)} ＋ diff ${diffStats.p50.toFixed(2)}]`,
  )
  return { store, sel, bytes, snapStats, undoStats }
}

/** 栈深度：数「真的被留住」的字节（gc 后 heapUsed 差 ÷ 深度） */
function measureDepth(n, depth) {
  const forest = buildForest(n)
  const store = new BlockStore(forest)
  const sel = selOf(store)
  store.find(sel.aBlock)
  gc()
  const base = process.memoryUsage().heapUsed
  const kept = []
  for (let i = 0; i <= depth; i++) kept.push(store.snap(sel))
  gc()
  const used = process.memoryUsage().heapUsed - base
  const per = used / kept.length
  return { used, per, kept: kept.length }
}

console.log(`node ${process.version}  gc=${globalThis.gc ? 'on' : 'off'}  N=${N}  roots=${ROOTS}`)
console.log('')

console.log('── 体量对照（同一份代码，三档库） ──')
measureRun(100, 'small')
measureRun(10_000, 'mid')
const big = measureRun(N, 'big')

console.log('')
console.log('── 撤销栈内存（每层保留一份整片森林 JSON） ──')
for (const depth of [1, 10]) {
  if (!globalThis.gc) {
    console.log(`depth=${String(depth).padEnd(3)}  skipped (run with --expose-gc)`)
    continue
  }
  const r = measureDepth(N, depth)
  console.log(`depth=${String(depth).padEnd(3)}  实测 ${mb(r.used)}（${mb(r.per)}/层，${N} 块）`)
}
if (globalThis.gc) {
  const r = measureDepth(SMALL_N, 100)
  const scaled = r.per * 100 * (N / SMALL_N)
  console.log(
    `depth=100  实测 ${mb(r.used)}（${SMALL_N} 块）  ⇒ ${N} 块估算 ${mb(scaled)}（${mb(r.per)}/层 × 100 × ${N}/${SMALL_N}）`,
  )
  console.log(`depth=1   ${N} 块的估算下界 ${mb(r.per * (N / SMALL_N))}`)
}
console.log('')
console.log(`一次按键的撤销条目：现在 ${big.bytes} 字节（随库体量线性增长）`)
