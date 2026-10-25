/**
 * **身份块的正文是名字或投影；名字不在正文里。**
 *
 * 这里钉的是「内容写路径不许改身份块正文」与「复制必须带走身份」两件事，
 * 失败方式都是静默的：不报错、不崩，只是用户按了一次退格，标签的描述被拼上了一行内容
 * （日记更糟：往只读的日期投影里塞了字），或者复制出来的块悄悄少了图标、日期、属性与身份。
 *
 * 规则：
 *   · 合并（块首退格）的目标是字段定义／日记／查询 ⇒ **不成立**（返回 null，两边都不动）；
 *   · 目标是普通内容块、页或标签 ⇒ 照旧合并：它们的正文是**描述**（名字在 `_aliases`）；
 *   · 复制子树 ⇒ **属性值带走、身份不带走**（`_aliases`／`_lists`／`_display` 与派生载体），
 *     且每一块都发新 id。
 *
 * ⚠️ 「属性值带走、身份不带走」不是两件事，是一条判据的两半：身份（地址／列表／派生载体）
 *    指向的是「这一个」，副本只能是内容。只看地址会漏掉派生身份 —— 那正是本文件最后一条
 *    测试钉的（复制日记造出第二个「同一天」，而它引用不到）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  addList,
  canWriteText,
  cloneSubtree,
  hasIdentity,
  isJournalBlock,
  isPropDefBlock,
  isQueryBlock,
  mergeIntoPrev,
  mkBlock,
  type Block,
  type Doc,
} from '../src/core/index.ts'
import { plainText } from '../src/core/runs.ts'

const j = (date: string, children: Block[] = []): Block => ({
  id: `j-${date}`,
  content: [],
  children,
  props: { _date: date },
})

test('canWriteText：字段定义／日记／查询的正文只读；页、标签、普通块的正文是描述', () => {
  const tag = mkBlock('设计')
  addList(tag, 'tag')
  const schema = mkBlock('截止日')
  schema.props = { _kind: 'date' }
  const page = mkBlock('某一页')
  addList(page, 'page')
  const query = mkBlock('我的查询')
  query.props = { _query: { where: { todo: 'todo' } } }

  assert.equal(canWriteText(tag), true, '标签的正文是描述，名字在 `_aliases`')
  assert.equal(canWriteText(schema), false)
  assert.equal(canWriteText(j('2026-10-22')), false)
  assert.equal(canWriteText(query), false, '查询的条件是它的身份，正文只是名字')
  assert.equal(canWriteText(page), true)
  assert.equal(canWriteText(mkBlock('一行内容')), true)
})

test('合并：前一块是字段定义 ⇒ 不成立，名字与两边正文都不动', () => {
  const schema = mkBlock('截止日')
  schema.props = { _kind: 'date' }
  const child = mkBlock('一行内容')
  const doc: Doc = { roots: [schema, child] }

  assert.equal(mergeIntoPrev(doc, child.id), null)
  assert.equal(plainText(schema.content), '截止日', '定义的名字是身份，不该被并进来的正文改写')
  assert.equal(plainText(child.content), '一行内容', '合并不成立 ⇒ 被并的块也不能丢正文')
  assert.equal(doc.roots.length, 2, '两个块都还在')
})

test('合并：前一块是日记 ⇒ 不成立，日期投影恒空', () => {
  const child = mkBlock('今天写的第一行')
  const day = j('2026-10-22', [child])
  const doc: Doc = { roots: [day] }

  assert.equal(mergeIntoPrev(doc, child.id), null)
  assert.equal(plainText(day.content), '', '日期行的正文是 `_date` 的只读投影，恒空')
  assert.equal(day.children.length, 1, '子块没被摘走')
})

test('合并：前一块是标签 ⇒ 照旧合并；名字（别名）不受影响（回归）', () => {
  const tag = mkBlock('设计')
  tag.props = { _aliases: ['设计'], _lists: ['tag'], _display: 'alias' }
  const child = mkBlock('后面那段')
  const doc: Doc = { roots: [tag, child] }

  const r = mergeIntoPrev(doc, child.id)
  assert.ok(r, '标签正文是描述 ⇒ 内容写路径不再拦它')
  assert.equal(plainText(tag.content), '设计后面那段', '描述拼接')
  assert.deepEqual(tag.props?._aliases, ['设计'], '地址一个字节不动')
})

test('合并：前一块是普通内容块 ⇒ 照旧合并（回归）', () => {
  const prev = mkBlock('前半')
  const cur = mkBlock('后半')
  const doc: Doc = { roots: [prev, cur] }

  const r = mergeIntoPrev(doc, cur.id)
  assert.ok(r, '普通内容块之间必须还能合并')
  assert.equal(r.kept, prev.id, '前一块保留 id')
  assert.equal(plainText(prev.content), '前半后半')
  // 合并是**原位标记**：被并块留在树上的原位（不可见），不再从树里摘掉
  assert.deepEqual(doc.roots.map((b) => b.id), [prev.id, cur.id])
  assert.equal(plainText(cur.content), '', '空壳应清空（正文已搬进前一块）')
  assert.ok(cur.props?._deletedAt, '带删除标记')
})

test('复制子树：属性值带走、身份不带走，且每一块都发新 id', () => {
  const kid = mkBlock('子块')
  kid.props = { _icon: 'lucide:star' }
  const page = mkBlock('某页')
  page.props = {
    _aliases: ['某页', '另一个名字'],
    _lists: ['page', 'tag'],
    _display: 'alias',
    _icon: 'lucide:file',
  }
  page.children = [kid]

  const { block, idMap } = cloneSubtree(page)

  assert.notEqual(block.id, page.id)
  assert.equal(block.props?._aliases, undefined, '副本不带地址：地址属于原件')
  assert.equal(block.props?._lists, undefined, '副本不带列表：副本只是内容，不是页/标签')
  assert.equal(block.props?._display, undefined, '副本不带显示模式：那是身份的一部分')
  assert.equal(block.props?._icon, 'lucide:file', '属性值要一起带走（图标、日期、字段值）')
  assert.notEqual(block.props, page.props, '属性袋是副本，不是同一个对象')
  assert.equal(plainText(block.content), '某页')

  const kidCopy = block.children[0]!
  assert.notEqual(kidCopy.id, kid.id, '子树里每一块都发新 id')
  assert.equal(kidCopy.props?._icon, 'lucide:star', '子块的属性也要带走（这一层最容易漏）')
  assert.equal(idMap.get(page.id), block.id)
  assert.equal(idMap.get(kid.id), kidCopy.id)
})

test('复制子树：副本是**新块** ⇒ 时刻取此刻，不是原件的那一份', () => {
  /**
   * 判据：副本不是「同一份内容换了个位置」，而是一块新内容 —— 它此后独立演化。
   * 沿用原件的时间戳，会让「这块何时诞生」指向原件的那一天（甚至早于它的父块）。
   */
  const old = 1000
  const src = mkBlock('原块', { created: old, modified: old })
  src.children = [mkBlock('子块', { created: old, modified: old })]
  const before = Date.now()
  const { block } = cloneSubtree(src)

  assert(block.created >= before, `副本的出生时刻该是此刻：${block.created}（≥ ${before}）`)
  assert.notEqual(block.created, old, '绝不能沿用原件的出生时刻')
  assert.equal(block.modified, block.created, '一次复制就是一次诞生：两个时刻同值')
  for (const kid of block.children) {
    assert(kid.created >= before, `子树里每一块也都要新时刻：${kid.created}`)
  }
  assert.equal(src.created, old, '原件的时间戳不受影响')
})

test('复制子树：原件没有的身份/属性，副本也不凭空多出来', () => {
  const plain = mkBlock('光块')
  const { block } = cloneSubtree(plain)
  assert.equal(block.props, undefined, '不留空数组、也不留空属性袋')
})

test('复制子树：派生身份也不带走——副本不能是日记／定义／查询', () => {
  // 判据：凡是 `hasIdentity` 会认的，副本都不能是。
  // 只剔 `_aliases`/`_lists` 会漏掉 `_date`／`_kind`／`_query` 这三条 ⇒
  // 复制日记会造出第二个「同一天」，而它引用不到。
  const journal = mkBlock('')
  journal.props = { _date: '2026-10-23' }
  const jc = cloneSubtree(journal).block
  assert.equal(jc.props?._date, undefined, '副本不带 `_date`：否则库里有两个「同一天」')
  assert.equal(isJournalBlock(jc), false, '副本不是日记')
  assert.equal(hasIdentity(jc), false, '副本没有任何身份')

  const def = mkBlock('截止日')
  def.props = { _kind: 'date' }
  const dc = cloneSubtree(def).block
  assert.equal(dc.props?._kind, undefined, '副本不带 `_kind`：否则它是一个没有声明的字段定义')
  assert.equal(isPropDefBlock(dc), false, '副本不是字段定义')

  const q = mkBlock('我的查询')
  q.props = { _query: { where: { kind: 'tag' } }, _queryResult: [{ blockId: 'x', path: [] }] }
  const qc = cloneSubtree(q).block
  assert.equal(qc.props?._query, undefined, '副本不带 `_query`')
  assert.equal(
    qc.props?._queryResult,
    undefined,
    '副本不带 `_queryResult`：那次冻结的结果属于原件，留着就是指向别处 id 的死列表',
  )
  assert.equal(isQueryBlock(qc), false, '副本不是查询视图')
})
