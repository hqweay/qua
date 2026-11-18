#!/usr/bin/env node
/**
 * 查询与全局列表的**可复算读数**（候选集＋先序 rank 这一刀）。
 *
 * 口径：
 *   · 固定种子的合成森林：每块一段中文；前 5,000 块打同一个标签、带一个布尔属性、
 *     各发一枚指向同一目标的引用；页/标签/定义/回收站/日记各占少数；
 *   · 每个形状先热一轮，再取 21 次的 p50 / p95；首轮（建索引＋建字段表＋建列表）单独报；
 *   · 每个形状同时报 `candidate` / `fallback` 计数器增量——可枚举形状不许回退；
 *   · `trashAfterEdit` 是「打字之后读回收站」：纯正文写不许重建列表；
 *   · 数字是量级，不是门禁阈值；**不是真机测试**（Node core，不含 DOM/Electron）。
 *
 * 用法：
 *   node --expose-gc scripts/perf-query.mjs
 *   QUA_QUERY_N=1000000 node --expose-gc scripts/perf-query.mjs
 */
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { textRuns } from '../src/core/model/runs.ts'
import { writeBlockContent } from '../src/core/model/model.ts'
import { FEED_SPEC } from '../src/core/query/feed.ts'

const N = Math.max(1_000, Math.trunc(Number(process.env.QUA_QUERY_N ?? 100_000)) || 100_000)
const HITS = Math.min(5_000, Math.floor(N / 2))
const RUNS = 21
const TAG = 'tag1'
const DEF = 'flag-def'
const TARGET = 'ref-target'
const gc = globalThis.gc

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

function forest(n) {
  const tag = {
    id: TAG,
    content: textRuns('tag1'),
    children: [],
    created: 1,
    modified: 1,
    props: { _lists: ['tag'], _aliases: ['tag1'] },
  }
  // 一个布尔字段定义：`all:[tag, prop]` 的第二个条件要有可查的字段
  const def = { id: DEF, content: textRuns('flag'), children: [], created: 1, modified: 1, props: { _kind: 'checkbox' } }
  // 被引用的目标
  const target = { id: TARGET, content: textRuns('被引用的块'), children: [], created: 1, modified: 1 }
  const roots = [tag, def, target]
  for (let i = 0; i < n; i++) {
    const id = `b${String(i).padStart(8, '0')}`
    const content = textRuns(`${FRAGMENTS[i % FRAGMENTS.length]}。第${i}条。`)
    const props = {}
    if (i % 10_000 === 0) props._deletedAt = 1
    if (i % 100 === 0) {
      props._lists = ['page']
      props._aliases = [`页-${i}`]
    }
    if (i % 1_000 === 0) props._kind = 'text'
    if (i % 997 === 0) props._date = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
    if (i < HITS) {
      props._tags = [TAG]
      props[DEF] = i % 2 === 0
      content.push({ id: `r${i}`, t: 'ref', to: TARGET })
    }
    const b = { id, content, children: [], created: 1_700_000_000_000 + i, modified: 1_700_000_000_000 + i }
    if (Object.keys(props).length > 0) b.props = props
    roots.push(b)
  }
  return roots
}

/** 一次计时的分位：p50 / p95（样本已排序） */
function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

function one(fn) {
  const s = performance.now()
  fn()
  return performance.now() - s
}

/** 热一轮 → N 次计时 → 再跑一次取计数器增量与命中数 */
function measure(kb, store, spec) {
  kb.query(spec)
  const xs = []
  let hits = 0
  for (let i = 0; i < RUNS; i++) {
    const s = performance.now()
    hits = kb.query(spec).length
    xs.push(performance.now() - s)
  }
  xs.sort((a, b) => a - b)
  const before = { ...store.index.cacheProbe }
  kb.query(spec)
  const after = store.index.cacheProbe
  return {
    hits,
    p50: +percentile(xs, 0.5).toFixed(1),
    p95: +percentile(xs, 0.95).toFixed(1),
    candidate: after.candidateQueries - before.candidateQueries,
    fallback: after.fallbackQueries - before.fallbackQueries,
  }
}

const store = new BlockStore(forest(N))
const kb = new MemoryKb(store)

const SHAPES = {
  tag: { where: { tag: TAG } },
  'all-tag-prop': { where: { all: [{ tag: TAG }, { prop: { id: DEF, eq: true } }] } },
  ref: { where: { ref: TARGET } },
  journal: { where: { role: 'journal' }, sort: [{ by: '_date', dir: 'desc' }] },
  feed: FEED_SPEC,
  'fallback-text': { where: { text: '索引' } },
  'fallback-not': { where: { not: { tag: TAG } } },
}

// 首轮：建索引 ＋ 建字段表缓存 ＋ 建候选用的列表缓存（一次性成本）
const coldQuery = one(() => kb.query(SHAPES.tag))
const coldLists = one(() => {
  kb.pages()
  kb.tags()
  kb.propDefs()
  kb.trash()
})
const probeAfterCold = { ...store.index.cacheProbe }

const shapes = {}
for (const [name, spec] of Object.entries(SHAPES)) shapes[name] = measure(kb, store, spec)

const pages = one(() => kb.pages())
const tags = one(() => kb.tags())
const propDefs = one(() => kb.propDefs())
const trash = one(() => kb.trash())

// 打字路径：纯正文写之后读回收站，缓存必须仍然命中
kb.tx((tx) =>
  tx.patch('b00000001', (b) => {
    writeBlockContent(b, textRuns('只改正文'))
  }),
)
const trashAfterEdit = one(() => kb.trash())
const probeAfterEdit = { ...store.index.cacheProbe }

console.log(
  JSON.stringify(
    {
      n: N,
      hits: HITS,
      runs: RUNS,
      coldQueryMs: +coldQuery.toFixed(1),
      coldListsMs: +coldLists.toFixed(1),
      shapes,
      pagesMs: +pages.toFixed(2),
      tagsMs: +tags.toFixed(2),
      propDefsMs: +propDefs.toFixed(2),
      trashMs: +trash.toFixed(2),
      trashAfterEditMs: +trashAfterEdit.toFixed(2),
      cacheProbe: {
        cold: probeAfterCold,
        afterEdit: probeAfterEdit,
        listsBuildsDelta: probeAfterEdit.listsBuilds - probeAfterCold.listsBuilds,
        fieldBuildsDelta: probeAfterEdit.fieldBuilds - probeAfterCold.fieldBuilds,
      },
      heapMB: gc ? (() => { gc(); return +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) })() : undefined,
      // 先序 rank 的保留大小（清掉整张表再 GC）：它是派生索引里最大的一张新表
      heapWithoutOrderMB: gc
        ? (() => {
            store.index.order.clear()
            gc()
            return +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)
          })()
        : undefined,
    },
    null,
    2,
  ),
)
