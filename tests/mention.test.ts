/**
 * **候选引用**：把提及栏里的一处纯文本换成一枚引用。
 *
 * 钉四件事：
 *   ① 出现处跑在**投影**上（`{text}` 怎么收它就怎么找），被原子隔开的不算「一处纯文本」；
 *   ② 转换 ＝ 原位一枚 `RefRun`（`label` 快照、不写 `anchor`），写前复核区间；
 *   ③ 转换后**同一关系索引换边**：该条从提及消失、同时在引用出现；
 *   ④ 一次撤销回到转换前（捕获只装 touched 的那一块）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  convertSpotToRef,
  derivedRecordsOf,
  mentionSnippet,
  mentionSpotsOf,
  BlockStore,
  type Block,
} from '../src/core/index.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { plainText, textRuns, type RefRun, type Run } from '../src/core/model/runs.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

test('出现处：投影上找词，映射回 plain 区间；多处升序不重叠', () => {
  const content = textRuns('设计在 设计里，也在设计。')
  const spots = mentionSpotsOf(content, '设计')
  assert.deepEqual(
    spots.map((s) => [s.start, s.end]),
    [
      [0, 2],
      [4, 6],
      [10, 12],
    ],
  )
  for (const s of spots) assert.equal(s.text, '设计')
  for (const s of spots) assert.equal(plainText(content).slice(s.start, s.end), '设计')
})

test('出现处：词为空 ⇒ 空表；没命中 ⇒ 空表', () => {
  assert.deepEqual(mentionSpotsOf(textRuns('正文'), ''), [])
  assert.deepEqual(mentionSpotsOf(textRuns('正文'), '  '), [])
  assert.deepEqual(mentionSpotsOf(textRuns('正文'), '设计'), [])
})

test('出现处：名字被原子隔开（投影相邻、plain 不连续）不收——转换它得吞掉原子', () => {
  const atom: RefRun = { id: 'a1', t: 'ref', to: 'x', label: 'x' }
  const content: Run[] = [...textRuns('ab'), atom, ...textRuns('cd')]
  // 投影是 "abcd"：整串命中，但中间隔着原子
  assert.deepEqual(mentionSpotsOf(content, 'abcd'), [])
  // 原子两侧的片段仍是「一处纯文本」
  assert.deepEqual(mentionSpotsOf(content, 'ab').map((s) => [s.start, s.end]), [[0, 2]])
  assert.deepEqual(mentionSpotsOf(content, 'cd').map((s) => [s.start, s.end]), [[3, 5]])
})

test('出现处：格式拆开的两段（无原子）照收；原子后面的词起点对得上', () => {
  const atom: RefRun = { id: 'a1', t: 'ref', to: 'x', label: 'x' }
  const content: Run[] = [...textRuns('设', { bold: true }), ...textRuns('计'), atom, ...textRuns('计')]
  // 投影 "设计计"：[0,2) 跨两个 run 但无原子 ⇒ 可转换
  assert.deepEqual(mentionSpotsOf(content, '设计').map((s) => [s.start, s.end]), [[0, 2]])
  // [2,3) 是原子 ⇒ 不可；[3,4)... 投影里 "设计" 也可以是第 0..2 与 2..3+1? 投影是 设+计+计
  assert.deepEqual(mentionSpotsOf(content, '计').map((s) => [s.start, s.end]), [
    [1, 2],
    [3, 4],
  ])
})

test('转换：原位一枚引用 run（label 快照、无 anchor），前后 run 原样', () => {
  const content = textRuns('和 设计 讨论一下')
  const next = convertSpotToRef(content, { start: 2, end: 4, text: '设计' }, 'host', '设计')
  assert.ok(next, '应产出新内容')
  const at = next.findIndex((r) => r.t === 'ref')
  assert.ok(at > 0, '引用在原位（前有「和 」）')
  const run = next[at] as RefRun
  assert.equal(run.to, 'host')
  assert.equal(run.label, '设计')
  assert.equal(run.anchor, undefined, '插入路径不写锚文本')
  assert.deepEqual(next.slice(0, at), textRuns('和 '))
  assert.deepEqual(next.slice(at + 1), textRuns(' 讨论一下'))
  // 投影口径：原子不进投影，纯文本只剩前后的字
  assert.equal(plainText(next), '和  讨论一下')
})

test('转换：区间已不是那个词 ⇒ 拒写；区间里有原子 ⇒ 拒写', () => {
  const content = textRuns('和 设计 讨论一下')
  assert.equal(convertSpotToRef(content, { start: 2, end: 4, text: '设色' }, 'host', '设色'), null)
  const atom: RefRun = { id: 'a1', t: 'ref', to: 'x', label: 'x' }
  const mixed: Run[] = [...textRuns('ab'), atom]
  assert.equal(convertSpotToRef(mixed, { start: 0, end: 3, text: 'ab' }, 'host', 'ab'), null)
})

test('片段：第 k 个 mark 恰是第 k 处；窗口不切在命中中间', () => {
  const text = '一句开场白，设计在中间，设计还在后面，结尾还有设计。'
  const content = textRuns(text)
  const spots = mentionSpotsOf(content, '设计')
  const parts = mentionSnippet(content, spots, 40)
  const marks = parts.filter((p) => p.mark === true)
  assert.ok(marks.length >= 1, '窗口里要有高亮段')
  marks.forEach((m, i) => {
    assert.equal(m.text, spots[i]!.text, `第 ${i} 个 mark 对应第 ${i} 处`)
    assert.ok(spots[i]!.start >= 0 && spots[i]!.end <= text.length)
  })
  // 窗口内的 mark 都完整（不出现被切一半的命中）
  const joined = parts.map((p) => p.text).join('')
  assert.ok(joined.includes('设计'), '命中词要出现在片段里')
  assert.ok(parts[0]!.text === '…' || spots[0]!.start < 24, '开头要么省略号要么从近处起')
})

test('片段：命中前有原子时 mark 仍对得上——展示串与 spots 同一坐标系（plain）', () => {
  const atom: RefRun = { id: 'a1', t: 'ref', to: 'x', label: 'x' }
  const content: Run[] = [...textRuns('ab'), atom, ...textRuns('cd设计ef')]
  const spots = mentionSpotsOf(content, '设计')
  assert.deepEqual(spots.map((s) => [s.start, s.end]), [[5, 7]])
  const parts = mentionSnippet(content, spots, 96)
  const marks = parts.filter((p) => p.mark === true)
  assert.deepEqual(marks.map((m) => m.text), ['设计'], 'mark 文本应是命中词本身')
  // 原子在窗口里占一格占位符，不把 mark 推到别的字上
  const joined = parts.map((p) => p.text).join('')
  assert.ok(joined.includes('□') && joined.includes('设计'), `片段里原子占位、命中完整：${joined}`)
})

test('片段：全部命中都在窗口里时没有省略号', () => {
  const content = textRuns('设计和设计')
  const spots = mentionSpotsOf(content, '设计')
  const parts = mentionSnippet(content, spots, 96)
  assert.deepEqual(
    parts.map((p) => [p.text, p.mark === true]),
    [
      ['设计', true],
      ['和', false],
      ['设计', true],
    ],
  )
})

test('等式：一处转换后，该条从提及消失、同时在引用出现；一次撤销换回来', () => {
  const host = b('host', '设计说明页', { props: { _aliases: ['设计'], _lists: ['page'] } })
  const src = b('src', '和 设计 讨论一下')
  const store = new BlockStore([host, src])
  const kb = new MemoryKb(store, { now: () => 5000 })

  const inMentions = (): string[] => derivedRecordsOf(host, kb, 'mentions').map((r) => r.block.id)
  const inRefs = (): string[] => derivedRecordsOf(host, kb, 'refs').map((r) => r.block.id)
  assert.deepEqual(inMentions(), ['src'], '前置：纯文本命中是提及')
  assert.deepEqual(inRefs(), [], '前置：还没有引用')

  const word = '设计'
  const spot = mentionSpotsOf(src.content, word)[0]!
  const next = convertSpotToRef(src.content, spot, host.id, word)
  assert.ok(next)
  const r = kb.tx((tx) =>
    tx.patch(src.id, (x) => {
      x.content = next
      x.modified = 6000
    }),
  )
  store.record(r.undo, null, 'other', 6000)
  assert.equal(r.ops.length, 1, '一次转换＝一条内容写')
  assert.deepEqual(inMentions(), [], '转换后提及栏空了')
  assert.deepEqual(inRefs(), ['src'], '同一关系索引里它换到引用')

  const u = store.undo('me', null)!
  assert.ok(u.ops.length > 0, '撤销要交出落盘 op')
  assert.deepEqual(inMentions(), ['src'], '一次撤销回到提及')
  assert.deepEqual(inRefs(), [], '一次撤销后引用栏空了')
  assert.equal(plainText(src.content), '和 设计 讨论一下')
})
