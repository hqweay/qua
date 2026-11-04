/**
 * **跨块删除**（`⌘A` 之后按删除、或在选中处打字）。
 *
 * 为什么值得单测：这是「选区能选中，但删不掉」那个缺口的模型侧。
 * 失败方式很讨厌——不报错、不崩，只是**删掉的块又回来了**：
 * 浏览器把 DOM 里的字删了，模型里那些块一块都没少，重渲染一画就全回来。
 *
 * 规则：
 *   · 首块前半 ＋ 末块后半拼成一块，**保首块的 id**；
 *   · 中间与末块连子树一起退场（**经事务**，软删口径，可撤销）；
 *   · 同一块、跨父块、首块是段根 ⇒ 不做跨块删除（返回 null，交给别处）。
 *
 * ⚠️ 计划是纯函数；落地必须走 `Tx` —— 直写会让撤销（只记 touched）当场丢掉这一次收拢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockSpanPlan, flatten, type BlockSpanPlan } from '../src/core/model/tree.ts'
import type { Block, Doc } from '../src/core/model/model.ts'
import { writeBlockContent } from '../src/core/model/model.ts'
import { canWriteText } from '../src/core/model/types.ts'
import { plainText, textRuns } from '../src/core/model/runs.ts'
import { BlockStore } from '../src/core/model/store.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'

const mk = (id: string, text = '', children: Block[] = []): Block => ({ id, content: textRuns(text), children })

function fixture(): Doc {
  const b = mk('b', 'BBBB', [mk('b1', '乙的子块')])
  return {
    roots: [mk('a', 'AAAA'), b, mk('c', 'CCCC'), mk('d', 'DDDD')],
  }
}

const texts = (doc: Doc): string[] => flatten(doc).map((b) => plainText(b.content))

/** 用真实事务落地计划（与编辑器同一形状；删除是原位软删） */
function applyPlan(doc: Doc, plan: BlockSpanPlan): void {
  const store = new BlockStore(JSON.parse(JSON.stringify(doc.roots)) as Block[])
  const kb = new MemoryKb(store)
  kb.tx((tx) => {
    tx.patch(plan.headId, (b) => writeBlockContent(b, plan.content))
    for (const id of plan.removeIds) {
      const b = store.find(id)
      if (b && canWriteText(b)) tx.patch(id, (x) => writeBlockContent(x, []))
      tx.remove(id)
    }
  })
  doc.roots = store.blocks
}

test('blockSpanPlan：首块前半 ＋ 末块后半拼成一块，中间的连子树一起退场', () => {
  const doc = fixture()
  // 从 a 的第 2 个字选到 c 的第 2 个字：删掉「AA|AA…CC|CC」中间的一切
  const plan = blockSpanPlan(doc, 'a', 2, 'c', 2)
  assert.ok(plan)
  assert.equal(plan.headId, 'a', '光标落在首块（保它的 id）')
  assert.deepEqual(plan.removeIds, ['b', 'c'], '从前往后：中间块与末块')
  assert.equal(plainText(plan.content), 'AACC')

  applyPlan(doc, plan)
  assert.deepEqual(texts(doc), ['AACC', 'DDDD'], '首尾拼接；b 连子树消失')
})

test('blockSpanPlan：选到下一块开头 ⇒ 下一块整块没掉，它的文字接管首块', () => {
  const doc = fixture()
  // 从 a 的开头选到 b 的开头：首块前半（空）＋ 末块后半（b 从头切 ⇒ 整段 BBBB）
  const plan = blockSpanPlan(doc, 'a', 0, 'b', 0)
  assert.ok(plan)
  assert.equal(plan.headId, 'a')
  assert.deepEqual(plan.removeIds, ['b'])
  assert.equal(plainText(plan.content), 'BBBB')

  applyPlan(doc, plan)
  assert.deepEqual(texts(doc), ['BBBB', 'CCCC', 'DDDD'], 'b 的文字接管 a；b 的子块随 b 隐去')
  assert.equal(doc.roots[0]!.id, 'a', '保首块 id（撤销与锚点都靠它）')
})

test('blockSpanPlan：选到末块行尾 ⇒ 中间与末块都没了，首块保留（含子树）', () => {
  const doc = fixture()
  // 从 b 的开头选到 d 的行尾：b 前半空 ＋ d 后半（空）⇒ 空块
  const plan = blockSpanPlan(doc, 'b', 0, 'd', 4)
  assert.ok(plan)
  assert.equal(plan.headId, 'b')
  assert.deepEqual(plan.removeIds, ['c', 'd'])
  assert.equal(plainText(plan.content), '')

  applyPlan(doc, plan)
  assert.deepEqual(texts(doc), ['AAAA', '', '乙的子块'], 'c/d 消失；b 保留（含它的子块）')
})

test('blockSpanPlan：同一块 ⇒ null（那是块内删除，不该走这里）', () => {
  const doc = fixture()
  assert.equal(blockSpanPlan(doc, 'a', 1, 'a', 3), null)
  assert.deepEqual(texts(doc), ['AAAA', 'BBBB', '乙的子块', 'CCCC', 'DDDD'], '什么都没动')
})

/**
 * 跨父块的范围**不做拼接**：拼给谁、拼完挂在哪都说不清。
 * 那种情况交给「块选区删除」，它不动兄弟结构。
 */
test('blockSpanPlan：范围跨到不同父块 ⇒ null（不猜拼接语义）', () => {
  const doc = { roots: [mk('a', 'AAAA', [mk('a1', '子块')]), mk('b', 'BBBB')] }
  assert.equal(blockSpanPlan(doc, 'a1', 0, 'b', 2), null)
  assert.deepEqual(texts(doc), ['AAAA', '子块', 'BBBB'], '什么都没动')
})

/**
 * 段根不删：它是视图的装载单位，删掉只是让视图看不见（库里还在、刷新就回来）。
 * 这里首块就是段根 ⇒ 拒绝；调用方据此回落到别的删除路径。
 */
test('blockSpanPlan：首块是**有身份的段根** ⇒ null（不删装载单位）', () => {
  // 段根判据是「有身份」，不是「排在第一个」：无身份的普通首块照删
  const doc = {
    roots: [
      { ...mk('p', '页名'), props: { _aliases: ['页名'], _lists: ['page'] } } as Block,
      mk('b', 'BBBB'),
      mk('c', 'CCCC'),
    ],
  }
  assert.equal(blockSpanPlan(doc, 'p', 0, 'c', 2), null)
  assert.deepEqual(texts(doc), ['页名', 'BBBB', 'CCCC'], '什么都没动')
})

test('blockSpanPlan：末块在首块左边（反向选区）⇒ null，由调用方先归一', () => {
  const doc = fixture()
  assert.equal(blockSpanPlan(doc, 'c', 2, 'a', 2), null)
  assert.equal(texts(doc).length, 5, '什么都没动')
})
