/**
 * **页候选的行**（「新建页」那个键打开的面）。
 *
 * 钉住三条：① 名字先于页——没有同名页时第一行是「新建页面」，同名页已在场时第一行是那一页；
 * ② 空查询按最近改过排序（这里要能一跳就走）；③ 没有插入点，所以行里不该混进块行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, mkPageBlock } from '../src/core/index.ts'
import { pagePickerRows } from '../src/app/retrieval/mention-rows.ts'

function page(name: string, modified: number) {
  const p = mkPageBlock(name)
  p.modified = modified
  return p
}

const A = page('项目A', 300)
const B = page('项目B', 100)
const C = page('杂记', 200)
const forest = [A, B, mkBlock('一段正文里提到 项目 的普通块'), C]
const deps = { forest: () => forest }

test('pagePickerRows：空查询＝全部页，按最近改过排序', () => {
  const rows = pagePickerRows('', deps)
  assert.deepEqual(
    rows.map((r) => r.label),
    ['项目A', '杂记', '项目B'],
  )
  // 空查询没有名字可建 ⇒ 不产「新建页面」行
  assert.ok(rows.every((r) => r.pick?.kind === 'page'))
})

test('pagePickerRows：没有同名页 ⇒ 第一行是「新建页面」', () => {
  const rows = pagePickerRows('新页', deps)
  assert.equal(rows[0]?.pick?.kind, 'newPage')
  assert.deepEqual(rows[0]?.pick, { kind: 'newPage', name: '新页' })
  assert.ok(rows[0]?.label.includes('新页'), `行要说出要建的名字：${rows[0]?.label}`)
  // 没有插入点：不画第二落点（⌥↵ 建普通块那个键在 @ 里才有意义）
  assert.equal(rows[0]?.keyHint, undefined)
})

test('pagePickerRows：同名页已经在场 ⇒ 没有「新建页面」行，第一行就是那一页', () => {
  const rows = pagePickerRows('项目A', deps)
  assert.deepEqual(
    rows.map((r) => r.pick?.kind),
    ['page'],
  )
  assert.deepEqual(rows[0]?.pick, { kind: 'page', id: A.id, name: '项目A' })
})

test('pagePickerRows：部分命中时「新建页面」压在第一行，命中页按最近改过排在后面', () => {
  const rows = pagePickerRows('项目', deps)
  assert.deepEqual(
    rows.map((r) => r.pick?.kind),
    ['newPage', 'page', 'page'],
  )
  assert.deepEqual(
    rows.slice(1).map((r) => r.label),
    ['项目A', '项目B'],
  )
})

test('pagePickerRows：只有页进候选（普通块、标签、日记不走这一面）', () => {
  const rows = pagePickerRows('项目', deps)
  assert.ok(rows.every((r) => r.pick?.kind !== 'block'))
  assert.ok(!rows.some((r) => r.label.includes('普通块')))
})
