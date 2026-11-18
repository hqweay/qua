#!/usr/bin/env node
/**
 * 装载路径的可复算读数：**行 → 模型直出**（新）vs **JSON 字符串往返**（旧）。
 *
 * 判据：
 *   · 新路径不再构造整库字符串 —— 1–2M 块处旧路径会撞 V8 字符串长度上限（不是慢，是打不开）；
 *   · 峰值堆应少掉「字符串 ＋ 再 parse 出来的第二份模型」；
 *   · 两条路的 `judge` 结果必须同解（版本/形状校验同一份，由单测钉）。
 *
 * 用法：
 *   node --expose-gc scripts/perf-load.mjs
 *   QUA_LOAD_N=1000000 node --expose-gc scripts/perf-load.mjs
 */
import { rowsToWorkspace } from '../src/core/storage/db-rows.ts'
import { withVersion } from '../src/core/storage/ipc-adapter.ts'
import { judge } from '../src/core/storage/index.ts'
import { textRuns } from '../src/core/model/runs.ts'

const N = Math.max(1_000, Math.trunc(Number(process.env.QUA_LOAD_N ?? 200_000)) || 200_000)
const LONG = process.env.QUA_LOAD_LONG === '1'
const gc = globalThis.gc
const mb = (x) => +(x / 1024 / 1024).toFixed(1)
const FRAG = ['笔记应用是本地优先的双链笔记工具', '这一页记录会议纪要与下一步安排']
const longText =
  '索引把正文拆成词与单字两条召回路径，行内图片是内容寻址的字节只存一份，查询冻结成员与顺序内容按块 id 现读。'.repeat(3)

function rawRows(n) {
  const blocks = []
  const props = []
  const aliases = []
  const lists = []
  for (let i = 0; i < n; i++) {
    const id = `b${String(i).padStart(8, '0')}`
    const text = LONG && i % 5 === 0 ? longText : `${FRAG[i % 2]}。第${i}条。`
    const parent = i > 0 && i % 10 !== 0 ? `b${String(Math.floor(i / 10) * 10).padStart(8, '0')}` : null
    const left = i % 10 === 0 ? (i > 0 ? `b${String(i - 10).padStart(8, '0')}` : null) : `b${String(i - 1).padStart(8, '0')}`
    blocks.push({ id, content: JSON.stringify(textRuns(text)), created: 1_700_000_000_000 + i, modified: 1_700_000_000_000 + i, parent, left })
    if (i % 10 === 0) {
      props.push({ block: id, name: '_tags', value: JSON.stringify(['tag1']), multi: 0, pos: 0 })
      aliases.push({ block: id, name: `名字-${i}`, pos: 0 })
      aliases.push({ block: id, name: `别名-${i}`, pos: 1 })
      lists.push({ block: id, list: 'page' })
    }
    if (i % 7 === 0) props.push({ block: id, name: 'p1', value: JSON.stringify(i), multi: 0, pos: 0 })
  }
  return { blocks, props, aliases, lists, meta: { savedAt: '1700000000000', activeId: 'b00000000' } }
}

const heap = () => (gc ? (gc(), process.memoryUsage().heapUsed) : undefined)
const time = (fn) => {
  const s = performance.now()
  const v = fn()
  return [performance.now() - s, v]
}

const rows = rawRows(N)
const base = heap()

const [toModelMs, stored] = time(() => rowsToWorkspace(rows))
const model = withVersion(stored)
const afterModel = heap()

const [modelJudgeMs, modelJudged] = time(() => judge({ status: 'ok', model }))
const afterModelJudge = heap()

const [stringifyMs, raw] = time(() => JSON.stringify(model))
const afterString = heap()

const [rawJudgeMs, rawJudged] = time(() => judge({ status: 'ok', raw }))
const afterRawJudge = heap()

const result = {
  n: N,
  longContent: LONG,
  rawJsonMB: +(raw.length / 1024 / 1024).toFixed(1),
  toModelMs: +toModelMs.toFixed(1),
  modelJudgeMs: +modelJudgeMs.toFixed(1),
  stringifyMs: +stringifyMs.toFixed(1),
  rawJudgeMs: +rawJudgeMs.toFixed(1),
  e2eModelMs: +(toModelMs + modelJudgeMs).toFixed(1),
  e2eRawMs: +(toModelMs + stringifyMs + rawJudgeMs).toFixed(1),
  modelOk: modelJudged.status,
  rawOk: rawJudged.status,
  heapMB:
    base === undefined
      ? undefined
      : {
          base: mb(base),
          model: mb(afterModel - base),
          modelJudged: mb(afterModelJudge - base),
          string: mb(afterString - base),
          rawJudged: mb(afterRawJudge - base),
          peakSaving: mb(afterRawJudge - afterModelJudge),
        },
}
console.log(JSON.stringify(result, null, 2))
