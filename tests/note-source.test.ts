/**
 * 备注来源投影（`core/views/note-source.ts`）的契约测试。
 *
 * 钉的是三件会静默坏的事：
 *   · 槽里的 id 是**事实**——宿主或锚没了就报 dangling，不许把整条备注读成空白；
 *   · 位置取宿主所在**页**的名字（宿主是子块时不许把那一句的正文当页名）；
 *   · 不是备注 ⇒ 空数组（行首不该为任何普通块多出一条头）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuild } from '../src/core/index.ts'
import { mkBlock } from '../src/core/model/model.ts'
import { mkAnno, textRuns } from '../src/core/model/runs.ts'
import { ANNOTATES_PROP } from '../src/core/relations/annotates.ts'
import { noteSourceCellsOf } from '../src/core/views/note-source.ts'

function hostWithAnno(text: string, start: number, end: number) {
  const host = mkBlock(textRuns(text))
  const anno = mkAnno(host.content, start, end)
  assert.ok(anno, '有文本的区间才能物化 anno')
  host.annos = [anno]
  return { host, anno }
}

test('noteSourceCellsOf：宿主是子块时，位置取页名；引文取快照', () => {
  const page = mkBlock('', { props: { _aliases: ['写作示范'], _lists: ['page'] } })
  const { host, anno } = hostWithAnno('第一次见面就能在字上写批注。', 0, 5)
  page.children = [host]
  const note = mkBlock('', { props: { [ANNOTATES_PROP]: [{ block: host.id, anno: anno.id }] } })

  const cells = noteSourceCellsOf(note, rebuild([page, note]))
  assert.deepEqual(cells, [
    { hostId: host.id, label: '写作示范', quote: '第一次见面', dangling: false },
  ])
})

test('noteSourceCellsOf：宿主是顶层块时，它自己就是那一页', () => {
  const { host, anno } = hostWithAnno('甲块的第一句', 0, 3)
  const note = mkBlock('', { props: { [ANNOTATES_PROP]: [{ block: host.id, anno: anno.id }] } })

  const cells = noteSourceCellsOf(note, rebuild([host, note]))
  assert.deepEqual(cells, [
    { hostId: host.id, label: '甲块的第一句', quote: '甲块的', dangling: false },
  ])
})

test('noteSourceCellsOf：宿主没了／锚没了 ⇒ dangling，不丢这一格', () => {
  const { host, anno } = hostWithAnno('还在的一句', 0, 2)
  const note = mkBlock('', {
    props: {
      [ANNOTATES_PROP]: [
        { block: host.id, anno: anno.id },
        { block: 'deleted-host', anno: 'gone-anno' },
        { block: host.id, anno: 'gone-anno' },
      ],
    },
  })

  const cells = noteSourceCellsOf(note, rebuild([host, note]))
  assert.equal(cells.length, 3, '每一对都出一格：删除是事实，不是静默丢弃')
  assert.deepEqual(
    cells.map((c) => c.dangling),
    [false, true, true],
  )
  assert.equal(cells[0]?.label, '还在的一句')
  assert.equal(cells[0]?.quote, '还在')
  assert.equal(cells[1]?.label, '')
})

test('noteSourceCellsOf：不是备注 ⇒ 空数组（普通块行首不多一条头）', () => {
  const plain = mkBlock('普通块')
  assert.deepEqual(noteSourceCellsOf(plain, rebuild([plain])), [])
  // 坏形状同样读成空：形状判据在写侧拦，读侧不抛（与 annotatesPairsOf 同口径）
  const broken = mkBlock('', { props: { [ANNOTATES_PROP]: [] } })
  assert.deepEqual(noteSourceCellsOf(broken, rebuild([broken])), [])
})
