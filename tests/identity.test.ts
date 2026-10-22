/**
 * **身份块的正文是名字，不是内容。**
 *
 * 这里钉的是「内容写路径不许改身份块正文」与「复制必须带走身份」两件事，
 * 失败方式都是静默的：不报错、不崩，只是用户按了一次退格，标签名被拼上了一行正文
 * （日记更糟：往只读的日期投影里塞了字），或者复制出来的块悄悄少了图标、日期、属性与角色。
 *
 * 规则：
 *   · 合并（块首退格）的目标是标签／字段定义／日记 ⇒ **不成立**（返回 null，两边都不动）；
 *     这三个身份有两个来源：显式角色（标签）与数据（`_kind`／`_date`），判据收在 `hasIdentity`；
 *   · 目标是普通内容块（含页，页的行本来就允许直接编辑）⇒ 照旧合并；
 *   · 复制子树 ⇒ 角色与属性一起带走，且每一块都发新 id。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addRole, canWriteText, cloneSubtree, mergeIntoPrev, mkBlock, type Block, type Doc } from '../src/core/index.ts'

const j = (date: string, children: Block[] = []): Block => ({
  id: `j-${date}`,
  text: '',
  children,
  props: { _date: date },
})

test('canWriteText：标签/字段定义/日记的正文是名字；页与普通块是内容', () => {
  const tag = mkBlock('设计')
  addRole(tag, 'tag')
  const schema = mkBlock('截止日')
  schema.props = { _kind: 'date' }
  const page = mkBlock('某一页')
  addRole(page, 'page')

  assert.equal(canWriteText(tag), false)
  assert.equal(canWriteText(schema), false)
  assert.equal(canWriteText(j('2026-10-22')), false)
  // 页是容器，它的行本来就允许直接编辑（在页名上打字就是改名）⇒ 不在这条判据里
  assert.equal(canWriteText(page), true)
  assert.equal(canWriteText(mkBlock('一行内容')), true)
})

test('合并：前一块是标签 ⇒ 不成立，标签名与两边正文都不动', () => {
  const tag = mkBlock('设计')
  addRole(tag, 'tag')
  const child = mkBlock('一行内容')
  const doc: Doc = { roots: [tag, child] }

  assert.equal(mergeIntoPrev(doc, child.id), null)
  assert.equal(tag.text, '设计', '标签名是身份，不该被并进来的正文改写')
  assert.equal(child.text, '一行内容', '合并不成立 ⇒ 被并的块也不能丢正文')
  assert.equal(doc.roots.length, 2, '两个块都还在')
})

test('合并：前一块是日记 ⇒ 不成立，日期投影恒空', () => {
  const child = mkBlock('今天写的第一行')
  const day = j('2026-10-22', [child])
  const doc: Doc = { roots: [day] }

  assert.equal(mergeIntoPrev(doc, child.id), null)
  assert.equal(day.text, '', '日期行的正文是 `_date` 的只读投影，恒空')
  assert.equal(day.children.length, 1, '子块没被摘走')
})

test('合并：前一块是普通内容块 ⇒ 照旧合并（回归）', () => {
  const prev = mkBlock('前半')
  const cur = mkBlock('后半')
  const doc: Doc = { roots: [prev, cur] }

  const r = mergeIntoPrev(doc, cur.id)
  assert.ok(r, '普通内容块之间必须还能合并')
  assert.equal(r.kept, prev.id, '前一块保留 id')
  assert.equal(prev.text, '前半后半')
  assert.deepEqual(doc.roots.map((b) => b.id), [prev.id])
})

test('复制子树：角色与属性一起带走，且每一块都发新 id', () => {
  const kid = mkBlock('子块')
  kid.props = { _icon: 'lucide:star' }
  const page = mkBlock('某页')
  addRole(page, 'page')
  page.props = { ...page.props, _icon: 'lucide:file' }
  page.children = [kid]

  const { block, idMap } = cloneSubtree(page)

  assert.notEqual(block.id, page.id)
  assert.deepEqual(block.props?._roles, ['page'], '角色要一起带走，否则复制出来的页只是「长得像」')
  assert.equal(block.props?._icon, 'lucide:file', '属性要一起带走（图标、日期、字段值）')
  assert.notEqual(block.props, page.props, '属性袋是副本，不是同一个对象')
  assert.equal(block.text, '某页')

  const kidCopy = block.children[0]!
  assert.notEqual(kidCopy.id, kid.id, '子树里每一块都发新 id')
  assert.equal(kidCopy.props?._icon, 'lucide:star', '子块的属性也要带走（这一层最容易漏）')
  assert.equal(idMap.get(page.id), block.id)
  assert.equal(idMap.get(kid.id), kidCopy.id)
})

test('复制子树：原件没有的角色/属性，副本也不凭空多出来', () => {
  const plain = mkBlock('光块')
  const { block } = cloneSubtree(plain)
  assert.equal(block.props, undefined, '不留空数组、也不留空属性袋')
})
