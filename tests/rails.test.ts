/**
 * 可点导轨的祖先表（①）纯函数单测 ——可脱离浏览器跑。
 *
 * 判据逐条对应几个已知的易错处：**祖先栈必须对全量可见行算**。
 * 虚拟化窗口从中间开始时，若对 slice 重建栈，窗口第一行的祖先会**全丢**——
 * 这条单测就是把那个坑钉住（用「只喂前 N 行」模拟 slice）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ancestorsByBlockId, visibleRows } from '../src/core/tree.ts'
import type { Block, Doc } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

/**
 * 一棵三层树（文档序）：
 * ```
 * a                 depth 0
 * ├─ a1              depth 1
 * │  ├─ a11           depth 2
 * │  └─ a12           depth 2
 * └─ a2              depth 1
 * b                 depth 0（另一个根）
 * ```
 */
function fixture(): Doc {
  const a11 = mk('a11', 'a11')
  const a12 = mk('a12', 'a12')
  const a1 = mk('a1', 'a1', [a11, a12])
  const a2 = mk('a2', 'a2')
  const a = mk('a', 'a', [a1, a2])
  const b = mk('b', 'b')
  return { roots: [a, b] }
}

const rowsOf = (doc: Doc) => visibleRows(doc).filter((r) => !r.hidden)

test('ancestorsByBlockId: 深度 d 的行恰好有 d 个祖先，且 index = 层级 k', () => {
  const doc = fixture()
  const anc = ancestorsByBlockId(rowsOf(doc))
  assert.deepEqual(anc.get('a'), [])
  assert.deepEqual(anc.get('a1'), ['a'])
  assert.deepEqual(anc.get('a11'), ['a', 'a1'])
  assert.deepEqual(anc.get('a12'), ['a', 'a1'])
  assert.deepEqual(anc.get('a2'), ['a'])
  // 换根 ⇒ 栈要弹干净（b 不是 a 的后代，不能把 a 当祖先）
  assert.deepEqual(anc.get('b'), [])
})

test('ancestorsByBlockId: 折叠后子树不产生可见行 ⇒ 段天然消失', () => {
  const doc = fixture()
  doc.folded = { a1: true } // 折叠 a1
  const anc = ancestorsByBlockId(rowsOf(doc))
  assert.deepEqual(anc.get('a11'), undefined)
  assert.deepEqual(anc.get('a12'), undefined)
  assert.deepEqual(anc.get('a1'), ['a'])
  assert.deepEqual(anc.get('a2'), ['a'])
})

test('ancestorsByBlockId: 只喂 slice（虚拟化窗口）会丢祖先 —— 所以必须喂全量', () => {
  const doc = fixture()
  const rows = rowsOf(doc)
  // 全量：第 4 行（a12，depth 2）有两个祖先
  assert.deepEqual(ancestorsByBlockId(rows).get('a12'), ['a', 'a1'])
  // slice 从第 3 行开始（a11，depth 2）：栈按 depth 截断，a/a1 不在栈里 ⇒ 祖先全丢
  const slice = rows.slice(2)
  assert.equal(slice[0]!.block.id, 'a11')
  assert.equal(slice[0]!.depth, 2)
  // `stack.length = 2` 在空栈上是空操作 ⇒ 得到两个空位（不是 ['a','a1']）
  assert.equal(ancestorsByBlockId(slice).get('a11')?.length, 2)
  assert.ok(
    ancestorsByBlockId(slice).get('a11')!.every((x) => x === undefined),
    'slice 重建栈只会得到空洞，不是真祖先',
  )
  // ⇒ 这正是「applyWindow 不许对 slice 重建栈」的判据（editor.ts 的 rebuildAncestors 吃全量）
})

test('ancestorsByBlockId: 空表 ⇒ 空 map（空库 / 全折叠）', () => {
  assert.equal(ancestorsByBlockId([]).size, 0)
})
