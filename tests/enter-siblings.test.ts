/**
 * **Enter 的落点规则**。
 *
 * 为什么值得单测：这条规则**翻过几次**——最初定成「块尾一律同级」，但实机试下来不对：
 * 「子块展开时在块尾 Enter，新块跨过整棵树不合适，应该是子块」。⇒ 改成「有子块⇒子块」。
 * 随后又定「块中拆」：从「右半成子块」改成**同级拆**；再补「空块 + 深层 ⇒ 反缩进」。
 * 这种「改了又改」的规则必须有断言钉住，否则下次又被悄悄改掉而门禁全绿。
 *
 * 规则：
 *   · 折叠 ⇒ 同级；无子块 ⇒ 同级；有子块且展开 ⇒ **子块**（插成首个）。
 *   · 块中 ⇒ **同级拆**：左半进上方新块，原块保 id／右半／子树。
 *   · 块尾 + 展开有子块 ⇒ 首个子块；块尾 + 无子块 ⇒ 同级。
 *
 * 隐式不变量：**子块永远留在原 id**。旧实现把子树搬给右半（新 id），已纠正。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enterKind, flatten, insertFirstChild, insertSiblingAfter, locate, outdentBlock, splitBlockBefore, splitBlockIntoFirstChild } from '../src/core/tree.ts'
import type { Block, Doc } from '../src/core/model.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, text, children })

/** `a` → `a1` → `a11`；`b` 是 `a` 的兄弟 */
function fixture(): Doc {
  const a11 = mk('a11', 'a11')
  const a1 = mk('a1', 'a1', [a11])
  const a = mk('a', 'abc', [a1])
  const b = mk('b', 'b')
  return { roots: [a, b] }
}

test('Enter 块中 Enter ⇒ split（同级拆，不再是建子块）', () => {
  const doc = fixture()
  assert.equal(enterKind(doc, 'a', 1), 'split')
  assert.equal(enterKind(doc, 'a', 2), 'split')
})

test('Enter 块尾 + 有子块且展开 ⇒ child（插首个子块）', () => {
  const doc = fixture()
  assert.equal(enterKind(doc, 'a', 3), 'child', '有子块且展开时，块尾 Enter 应建子块')
})

test('Enter 块尾 + 无子块 ⇒ sibling（同级）', () => {
  const doc = fixture()
  assert.equal(enterKind(doc, 'b', 1), 'sibling')
  assert.equal(enterKind(doc, 'a11', 3), 'sibling')
})

test('Enter 块尾 + **折叠** ⇒ sibling（子树看不见时不许往里塞）', () => {
  const doc = fixture()
  doc.folded = { a: true }
  assert.equal(enterKind(doc, 'a', 3), 'sibling', '折叠态必须建同级，否则新块插进不可见的层')
})

test('Enter child 分支：新块是**第一个**子块，既有子块顺次后移且不丢', () => {
  const doc = fixture()
  const c = insertFirstChild(doc, 'a')
  assert.ok(c)
  assert.equal(doc.roots[0]!.children.length, 2)
  assert.equal(doc.roots[0]!.children[0]!.id, c.id, '新块应排在最前')
  assert.equal(doc.roots[0]!.children[1]!.id, 'a1', '既有子块应完整保留')
  assert.equal(c.text, '')
})

test('Enter sibling 分支：新块是同级，子树原地不动', () => {
  const doc = fixture()
  const b = insertSiblingAfter(doc, 'a')
  assert.ok(b)
  assert.equal(doc.roots.length, 3)
  assert.equal(doc.roots[1]!.id, b.id, '应紧跟在 a 之后')
  // 子树没被搬走
  assert.equal(doc.roots[0]!.children.length, 1)
  assert.equal(doc.roots[0]!.children[0]!.id, 'a1')
  assert.equal(doc.roots[0]!.children[0]!.children[0]!.id, 'a11')
})

test('Enter sibling 分支：深层块也建同级（不跳到顶层）', () => {
  const doc = fixture()
  const b = insertSiblingAfter(doc, 'a11')
  assert.ok(b)
  const loc = locate(doc, b.id)!
  assert.equal(loc.parent!.id, 'a1')
  assert.equal(loc.index, 1)
})

test('Enter（第三次修订）split：左半进**上方同级新块**，原块保 id/右半/子树', () => {
  const doc = fixture()
  const r = splitBlockBefore(doc, 'a', 1)!
  assert.equal(r.kept, 'a', '原块保留 id')

  const inserted = locate(doc, r.inserted)!
  assert.equal(inserted.block.text, 'a', '左半进新块')
  assert.equal(inserted.parent, null, '新块与 a 同级（同在 roots）')
  assert.equal(inserted.index, 0, '新块排在 a 之前（视觉上的上一行）')

  const kept = locate(doc, 'a')!
  assert.equal(kept.block.text, 'bc', '原块保留右半')
  assert.equal(kept.index, 1, '原块下移一行')
  assert.equal(kept.block.children[0]!.id, 'a1', '子树留在原块（隐式不变量）')
})

test('Enter（第三次修订）split：叶子块也拆成同级，不加深', () => {
  const doc = fixture()
  const r = splitBlockBefore(doc, 'b', 0)!
  assert.equal(r.kept, 'b')
  const inserted = locate(doc, r.inserted)!
  assert.equal(inserted.parent, null)
  assert.equal(inserted.block.text, '', 'offset=0 ⇒ 上方插空块')
  assert.equal(inserted.index, 1, 'b 前面、a 后面')
  assert.equal(locate(doc, 'b')!.block.text, 'b', '原块文本原样')
})

test('Enter（第三次修订）split：offset=0 退化成「在上方插空块」', () => {
  const doc = fixture()
  const r = splitBlockBefore(doc, 'a', 0)!
  const inserted = locate(doc, r.inserted)!
  assert.equal(inserted.block.text, '')
  assert.equal(locate(doc, 'a')!.block.text, 'abc')
  assert.equal(locate(doc, 'a')!.block.children[0]!.id, 'a1')
  assert.equal(inserted.index, 0)
})

test('Enter（第三次修订）split：只给新块发 id，原块 id/props 不变', () => {
  const doc = fixture()
  doc.roots[0]!.todo = 'todo'
  const before = new Set(flatten(doc).map((b) => b.id))
  const r = splitBlockBefore(doc, 'a', 2)!
  const after = flatten(doc).map((b) => b.id)
  assert.equal(after.length, before.size + 1)
  assert.deepEqual(
    after.filter((x) => !before.has(x)),
    [r.inserted],
  )
  assert.equal(locate(doc, 'a')!.block.todo, 'todo', 'todo 跟着原块')
})

test('Enter（第四次修订）空块 + 缩进 ≥ 2 层 ⇒ outdent（Enter 反缩进，不建块）', () => {
  const doc = fixture()
  doc.roots[0]!.children[0]!.children[0]!.text = '' // a11（深度 2）
  assert.equal(enterKind(doc, 'a11', 0), 'outdent')
})

test('Enter（第四次修订）顶层内容块 / 根块不反缩进；非空块仍走 split', () => {
  const doc = fixture()
  doc.roots[0]!.text = '' // a 是根块
  assert.notEqual(enterKind(doc, 'a', 0), 'outdent')
  doc.roots[0]!.children[0]!.text = '' // a1 深度 1（父是根）
  assert.notEqual(enterKind(doc, 'a1', 0), 'outdent', '顶层内容块反缩进会离开 section')
  doc.roots[0]!.children[0]!.children[0]!.text = 'x' // a11 非空
  assert.equal(enterKind(doc, 'a11', 0), 'split')
})

test('Enter（第四次修订）outdent 只搬自己（含子树），不做文本交换', () => {
  const doc = fixture()
  const a11 = doc.roots[0]!.children[0]!.children[0]!
  a11.text = ''
  assert.equal(outdentBlock(doc, 'a11'), true)
  const loc = locate(doc, 'a11')!
  assert.equal(loc.parent!.id, 'a', 'a11 应从 a1 下升到 a 下')
  assert.equal(loc.index, 1, '应插在 a1 之后')
  assert.equal(loc.block.text, '')
  assert.equal(a11.id, 'a11', 'id 不变')
})

test('Enter split 分支只改两处：左半新块 + 原块右半，子树留在原块', () => {
  const doc = fixture()
  const before = flatten(doc).map((b) => `${b.id}:${b.text}`).sort()
  splitBlockBefore(doc, 'a', 1)
  const after = flatten(doc).map((b) => `${b.id}:${b.text}`).sort()
  const changed = after.filter((x) => !before.includes(x))
  assert.equal(changed.length, 2, `应只改两处：${JSON.stringify(changed)}`)
  assert.ok(changed.includes('a:bc'), '原块应变右半')
  assert.equal(changed.filter((x) => x.endsWith(':a')).length, 1, '多出来的应是左半新块')
  assert.equal(locate(doc, 'a')!.block.children[0]!.id, 'a1', '子树留在原块')
})

test('Enter（第五次修订）section 根块中拆：左半留根，右半成**首个子块**', () => {
  const doc = fixture()
  const nRoots = doc.roots.length
  const r = splitBlockIntoFirstChild(doc, 'a', 1)!
  assert.equal(r.kept, 'a')
  assert.equal(doc.roots[0]!.text, 'a', '左半留在根里')
  const first = doc.roots[0]!.children[0]!
  assert.equal(first.id, r.inserted)
  assert.equal(first.text, 'bc', '右半成为首个子块')
  assert.equal(doc.roots[0]!.children[1]!.id, 'a1', '既有子块保留在第二位')
  assert.equal(doc.roots.length, nRoots, '不新增根')
})

test('Enter（第五次修订）section 根 offset=0 不拆（避免清空根文本）', () => {
  const doc = fixture()
  assert.equal(splitBlockIntoFirstChild(doc, 'a', 0), null)
  assert.equal(doc.roots[0]!.text, 'abc')
  assert.equal(doc.roots[0]!.children[0]!.id, 'a1')
})

test('Enter 判据里 core 不判「是不是首行」——那是视图层的事', () => {
  // 首行强制 child 的分支在 editor.split()；core 只按「有没有展开的子块」判。
  // 这里钉住 core 没有偷偷引入身份判断：根块无子块时，core 说 sibling。
  const doc = fixture()
  assert.equal(enterKind(doc, 'b', 1), 'sibling')
  assert.equal(locate(doc, 'b').parent, null)
})

test('Enter 建块不搬 anchors：只加空块，既有块的 id/文本原样', () => {
  for (const fn of [insertSiblingAfter, insertFirstChild]) {
    const doc = fixture()
    const before = flatten(doc).map((b) => `${b.id}:${b.text}`).sort()
    fn(doc, 'a')
    const after = flatten(doc).map((b) => `${b.id}:${b.text}`).sort()
    const extra = after.filter((x) => !before.includes(x))
    assert.equal(extra.length, 1, `${fn.name} 应只多一条记录：${JSON.stringify(extra)}`)
    assert.match(extra[0]!, /:$/, '多出来的应是空文本块')
  }
})
