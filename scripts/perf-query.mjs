#!/usr/bin/env node
/**
 * 查询与全局列表的**可复算读数**（索引缓存第一刀）。
 *
 * 口径：
 *   · 固定种子的合成森林：每块一段中文，固定 5,000 个标签成员；页/标签/定义/回收站各占少数；
 *   · 查询取中位数（7 次，缓存已热）；首轮（建索引＋建缓存）单独报；
 *   · `trashAfterEdit` 是「打字之后读回收站」——本轮的核心判据：纯正文写不许重建列表；
 *   · 数字是量级，不是门禁阈值。
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
    id: 'tag1',
    content: textRuns('tag1'),
    children: [],
    created: 1,
    modified: 1,
    props: { _lists: ['tag'], _aliases: ['tag1'] },
  }
  const roots = [tag]
  for (let i = 0; i < n; i++) {
    const id = `b${String(i).padStart(8, '0')}`
    const b = {
      id,
      content: textRuns(`${FRAGMENTS[i % FRAGMENTS.length]}。第${i}条。`),
      children: [],
      created: 1_700_000_000_000 + i,
      modified: 1_700_000_000_000 + i,
    }
    const props = {}
    if (i % 10_000 === 0) props._deletedAt = 1
    if (i % 100 === 0) {
      props._lists = ['page']
      props._aliases = [`页-${i}`]
    }
    if (i % 1_000 === 0) props._kind = 'text'
    if (i % 997 === 0) props._date = `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
    if (i < HITS) props._tags = ['tag1']
    if (Object.keys(props).length > 0) b.props = props
    roots.push(b)
  }
  return roots
}

function median(fn, runs = 7) {
  const xs = []
  for (let i = 0; i < runs; i++) {
    const s = performance.now()
    fn()
    xs.push(performance.now() - s)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

function one(fn) {
  const s = performance.now()
  fn()
  return performance.now() - s
}

const store = new BlockStore(forest(N))
const kb = new MemoryKb(store)

// 首轮：建索引 ＋ 建字段表缓存 ＋ 建列表缓存（冷启动的一次性成本）
const coldQuery = one(() => kb.query({ where: { tag: 'tag1' } }))
const coldLists = one(() => {
  kb.pages()
  kb.tags()
  kb.propDefs()
  kb.trash()
})
const probeAfterCold = { ...store.index.cacheProbe }

const query = median(() => kb.query({ where: { tag: 'tag1' } }))
const feed = median(() => kb.query(FEED_SPEC))
const pages = median(() => kb.pages())
const tags = median(() => kb.tags())
const propDefs = median(() => kb.propDefs())
const trash = median(() => kb.trash())

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
      coldQueryMs: +coldQuery.toFixed(1),
      coldListsMs: +coldLists.toFixed(1),
      queryMs: +query.toFixed(1),
      feedMs: +feed.toFixed(1),
      pagesMs: +pages.toFixed(1),
      tagsMs: +tags.toFixed(1),
      propDefsMs: +propDefs.toFixed(1),
      trashMs: +trash.toFixed(1),
      trashAfterEditMs: +trashAfterEdit.toFixed(2),
      cacheProbe: {
        cold: probeAfterCold,
        afterEdit: probeAfterEdit,
        listsBuildsDelta: probeAfterEdit.listsBuilds - probeAfterCold.listsBuilds,
        fieldBuildsDelta: probeAfterEdit.fieldBuilds - probeAfterCold.fieldBuilds,
      },
      heapMB: gc ? (() => { gc(); return +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) })() : undefined,
    },
    null,
    2,
  ),
)
