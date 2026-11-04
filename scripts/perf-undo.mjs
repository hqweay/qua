#!/usr/bin/env node
/**
 * 撤销的**可复算读数**（条目式撤销）：首键、⌘Z、条目字节、栈内存随深度的变化。
 *
 * 口径：
 *   · 库 ＝ 固定种子的合成森林（10k 个顶层块 × 9 个子块），每块一段中文、
 *     10% 有地址、20% 带标签 —— 只回答量级，不做内容评测；
 *   · 首键 ＝ `kb.tx(单块改写)` ＋ `store.record(捕获)`（真实按键的后半段；
 *     前半段「取快照」已经不存在了）；
 *   · ⌘Z ＝ `store.undo`（scoped op ＋ 索引修补）；
 *   · 耗时取中位数；**字节数**才是「与库体量无关」的判据；
 *   · 内存用 `--expose-gc` 强制回收后量 `heapUsed`。
 *
 * 历史对照（条目式撤销落地前的同一份 fixture）：
 *   100k 块 · snap 41ms / 13.6MB · restore 237ms · 真实 ⌘Z 277ms · 栈 26MB/层。
 *
 * 用法：
 *   node --expose-gc scripts/perf-undo.mjs
 *   QUA_UNDO_N=10000 node scripts/perf-undo.mjs
 */
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { writeBlockContent } from '../src/core/model/model.ts'
import { textRuns } from '../src/core/model/runs.ts'

const N = Math.max(10, Math.trunc(Number(process.env.QUA_UNDO_N ?? 100_000)) || 100_000)

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
    const root = make(made++)
    for (let c = 0; c < 9 && made < n; c++) root.children.push(make(made++))
    forest.push(root)
  }
  return forest

  function make(i) {
    const text = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
    const block = {
      id: `b${String(i).padStart(7, '0')}`,
      content: textRuns(`${text}。第${String(i).padStart(7, '0')}条。`),
      children: [],
      created: 1_700_000_000_000 + i,
      modified: 1_700_000_000_000 + i,
    }
    if (i % 10 === 0) block.props = { _aliases: [`名字-${String(i).padStart(7, '0')}`, `别名-${String(i).padStart(7, '0')}`] }
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
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`
}

const gc = globalThis.gc ?? (() => {})

function measure(n, label) {
  const store = new BlockStore(buildForest(n))
  const kb = new MemoryKb(store)
  const target = store.blocks[Math.floor(store.blocks.length / 2)]
  // 目标块的初始正文固定：条目字节只该反映「动过的那一块」，不该随库大小换一段语料
  writeBlockContent(target, textRuns('目标块'))
  const sel = { aBlock: target.id, aOff: 0, hBlock: target.id, hOff: 0 }
  // 索引是懒建的：先叫醒它（真实路径里它早建好了）
  store.index

  const keySamples = []
  const undoMs = []
  let entryBytes = 0
  for (let i = 0; i < 20; i++) {
    let t = performance.now()
    const r = kb.tx((tx) =>
      tx.patch(target.id, (b) => {
        writeBlockContent(b, textRuns(`改过的正文 ${i}`))
        b.modified += 1
      }),
    )
    store.record(r.undo, sel, 'other', 1_000_000 + i * 10)
    keySamples.push(performance.now() - t)
    entryBytes = JSON.stringify(r.undo).length

    t = performance.now()
    const u = store.undo(undefined, sel)
    undoMs.push(performance.now() - t)
    if (!u) throw new Error('undo produced no entry')
  }

  const key = stats(keySamples)
  const undo = stats(undoMs)
  console.log(
    `${label.padEnd(7)} blocks=${String(n).padStart(7)}  entry=${String(entryBytes).padStart(5)}B  ` +
      `首键 p50=${key.p50.toFixed(3)}ms p95=${key.p95.toFixed(3)}ms  ⌘Z p50=${undo.p50.toFixed(3)}ms p95=${undo.p95.toFixed(3)}ms`,
  )
}

/** 栈深度：每条目改一块不同的块；gc 后量真正留住的内存 */
function measureDepth(n, depth) {
  const store = new BlockStore(buildForest(n))
  const kb = new MemoryKb(store)
  const sel = null
  store.index
  const roots = store.blocks
  gc()
  const base = process.memoryUsage().heapUsed
  for (let i = 0; i < depth; i++) {
    const b = roots[i % roots.length]
    const r = kb.tx((tx) => tx.patch(b.id, (x) => void (x.modified += 1)))
    store.record(r.undo, sel, 'other', 1_000_000 + i)
  }
  gc()
  return { used: process.memoryUsage().heapUsed - base, depth }
}

console.log(`node ${process.version}  gc=${globalThis.gc ? 'on' : 'off'}  N=${N}`)
console.log('')
console.log('── 体量对照（同一份代码，三档库） ──')
measure(100, 'small')
measure(10_000, 'mid')
measure(N, 'big')

console.log('')
console.log('── 撤销栈内存（条目只含 touched，与库体量无关） ──')
if (!globalThis.gc) {
  console.log('skipped (run with --expose-gc)')
} else {
  for (const depth of [1, 10, 100, 400]) {
    const r = measureDepth(N, depth)
    console.log(`depth=${String(depth).padEnd(3)}  实测 ${mb(r.used)}（${mb(r.used / r.depth)}/层）`)
  }
}
