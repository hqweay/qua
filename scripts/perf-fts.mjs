#!/usr/bin/env node
/**
 * 100k 全文索引的**可复算读数**：建库耗时、索引体积、几类查询的 p50/p95。
 *
 * 为什么不用现成的测试语料库：`scripts/**` 要能在任意检出上跑，不能依赖本机缓存。
 * 这里用固定种子合成一篇「像笔记的中文」——它不是相关性评测语料，只回答
 * 「机制与延迟在 100k 量级还成不成立」。
 *
 * 指标口径：
 *   · 建库 = 分词 ＋ 写 BlockFTS/BlockFTSMap 的时间（不含 UI 与资产）；
 *   · 查询 = 渲染层会发的同一条 SQL（bm25 排序、LIMIT 20），不含 IPC 往返；
 *   · 体积 = 建索引前后 `qua.db` 的字节差（先 checkpoint，避免 WAL 虚胖）。
 *
 * 用法：`node scripts/perf-fts.mjs`；`QUA_FTS_N=2000` 可先跑小样。
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cut } from 'jieba-wasm'
import { pinyin } from 'pinyin-pro'
import { applyRowWrites, openLibraryDb, searchFts } from '../electron/library/sqlite.ts'
import { tokenizeText } from '../src/core/search/tokenizer.ts'
import { compileMatch } from '../src/core/search/query.ts'

const N = Math.max(1, Math.trunc(Number(process.env.QUA_FTS_N ?? 100_000)) || 100_000)
const BATCH = 2000

/** 固定种子的线性同余：同一条命令永远同一份语料 */
function rng(seed) {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 2 ** 32
  }
}

const FRAGMENTS = [
  '笔记应用是本地优先的双链笔记工具',
  '市镇人口密度很大城市与乡村之间差别明显',
  '这一页记录会议纪要与下一步安排',
  '索引把正文拆成词与单字两条召回路径',
  '行内图片是内容寻址的字节只存一份',
  '查询冻结成员与顺序内容按块 id 现读',
  '今天的日记从早上开始写到现在',
  '属性与露面是两套语义不要混在一起',
  '拖动块会把整棵子树一起搬走',
  '搜索面板里上下键选择回车打开',
  '重建索引时不阻塞输入路径',
  '引用一段文字会留下原文快照',
  '标签是归属不是正文里的几个字',
  '视图只是对同一棵树的一次渲染',
  '删除是原位软删可以恢复',
  '收藏与置顶属于视图状态不挂在块上',
  '拼音首字母也能找到常用词',
  '英文词 CodeMirror 在正文里整段保留',
  '窗口外的块不挂 DOM 滚动时再挂上',
  '模型里的选区住在块与偏移上',
]

function textOf(i, rand) {
  const a = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
  const b = FRAGMENTS[Math.floor(rand() * FRAGMENTS.length)]
  // 加一个不参与查询的编号，避免 100k 块字节级完全相同（索引体积会更接近真实笔记）
  return `${a}，${b}。第${i}条。`
}

function fileSize(file) {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

const dir = mkdtempSync(join(tmpdir(), 'qua-perf-fts-'))
const file = join(dir, 'qua.db')
const opened = openLibraryDb(file)
if (opened.status !== 'created') throw new Error(`openLibraryDb: ${opened.status}`)
const db = opened.db

// 建库期不背崩溃安全成本：库可重建
db.exec('pragma journal_mode=off')
db.exec('pragma synchronous=off')
db.exec('pragma temp_store=memory')
db.exec('pragma cache_size=-262144') // 256MB
db.exec('pragma wal_checkpoint(truncate)')
const baseBytes = fileSize(file)

const rand = rng(46)
const t0 = performance.now()
let rowid = 0
let inserted = 0
while (inserted < N) {
  const n = Math.min(BATCH, N - inserted)
  const writes = []
  for (let k = 0; k < n; k++) {
    const id = `b${inserted + k}`
    const token = tokenizeText(textOf(inserted + k, rand), cut, pinyin)
    rowid += 1
    writes.push({
      table: 'BlockFTS',
      op: 'insert',
      key: { rowid },
      values: { seg: token.seg, chars: token.chars, pinyin: token.pinyin },
    })
    writes.push({ table: 'BlockFTSMap', op: 'upsert', key: { block_id: id }, values: { fts_rowid: rowid } })
  }
  applyRowWrites(db, writes)
  inserted += n
}
const buildMs = performance.now() - t0
db.exec('pragma wal_checkpoint(truncate)')
const indexBytes = fileSize(file) - baseBytes

const queries = ['市镇', '市镇 人口', '笔记', '笔记 应用', 'bi ji', '的']
console.log(`blocks=${N} build_ms=${Math.round(buildMs)} index_mb=${(indexBytes / 1024 / 1024).toFixed(1)}`)
console.log('query                                hits     p50      p95')
for (const q of queries) {
  const match = compileMatch(q)
  if (!match) continue
  const count = searchFts(db, match, 200).length
  // warm 稳态：先跑 8 次预热，再采样 40 次（与报告口径一致）
  for (let i = 0; i < 8; i++) searchFts(db, match, 20)
  const samples = []
  for (let i = 0; i < 40; i++) {
    const s = performance.now()
    searchFts(db, match, 20)
    samples.push(performance.now() - s)
  }
  samples.sort((a, b) => a - b)
  console.log(
    `${q.padEnd(30)} ${String(count).padStart(6)}  ${pct(samples, 50).toFixed(2).padStart(6)}ms  ${pct(samples, 95)
      .toFixed(2)
      .padStart(6)}ms`,
  )
}

db.close()
rmSync(dir, { recursive: true, force: true })
