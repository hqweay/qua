/**
 * 回收站：**模型早就有，缺的是「看得见 + 能找回」**。
 *
 * 现状（本轮之前）：删掉一块是单向的——只有 `⌘Z` 能回去，而 `⌘Z` 只在**同一次会话**里有效
 * （撤销栈是内存快照）。关掉应用再打开，被删的子树就再也找不回来了，尽管它还在库里。
 *
 * 四条判据：
 *   ① **看得见**：`kb.trash()` 里的每一块都能在回收站卡里看到一行；
 *   ② **能找回**：点「恢复」⇒ 块回原位（`Tx.restore`），且**一次撤销**能回滚这次恢复；
 *   ③ **删的是操作根**：删一棵子树只进回收站一条（子块的不可见是继承来的），
 *      所以回收站里**不列**「已经随祖先一起被删」的后代——否则同一个东西出现 N 次；
 *   ④ **空态有话说**：没有东西时给一句明确文案，不是一张空白卡。
 *
 * ⚠️ 这一组是**模型层**断言（纯 core）。UI 那一面由浏览器冒烟钉（`checks/smoke.mjs`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/store.ts'
import { mkBlock, isDeleted, type Block } from '../src/core/model.ts'
import { trashOf } from '../src/core/tree.ts'

const NOW = 1_700_000_000_000
const b = (id: string, children: Block[] = []): Block => ({
  ...mkBlock('', { created: NOW, modified: NOW }),
  id,
  children,
})

function fixture(): { kb: MemoryKb; store: BlockStore } {
  const store = new BlockStore([
    b('p1', [b('c1', [b('g1')]), b('c2')]),
    b('p2'),
  ])
  const kb = new MemoryKb(store, { now: () => NOW })
  return { kb, store }
}

/* ------------------------------------------------------------ ① 看得见 */

test('① 删一块 ⇒ 它出现在回收站里（带它自己的正文，不是空行）', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  const trash = kb.trash()
  assert.deepEqual(trash.map((x) => x.id), ['c1'], `回收站应列出被删的那一块：${trash.map((x) => x.id).join(',')}`)
  assert.ok(isDeleted(trash[0]!), '列出来的块应当带删除标记（它是「被删的」，不是「存在的」）')
})

/* ------------------------------------------------------------ ③ 只列操作根 */

test('③ 删一棵子树只进回收站**一条**（后代的不可见是继承来的）', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  /**
   * `c1` 带着 `g1` 一起不可见，但 `g1` 自己**没有**删除标记。
   * 若回收站把「所有带标记的块」与「所有看不见的块」混为一谈，同一棵子树就会出现多次。
   */
  const ids = kb.trash().map((x) => x.id)
  assert.deepEqual(ids, ['c1'], `只该列操作根：${ids.join(',')}`)
  assert.ok(!ids.includes('g1'), '`g1` 是随祖先一起不可见的，不该单独列一条')
})

test('③ 删两次（先删子、再删父）⇒ 两条都在（两个独立的删除动作）', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('g1'))
  kb.tx((tx) => tx.remove('c1'))
  const ids = kb.trash().map((x) => x.id).sort()
  assert.deepEqual(ids, ['c1', 'g1'], `两次删除各进一条：${ids.join(',')}`)
})

/* ------------------------------------------------------------ ② 能找回 */

test('② 恢复 ⇒ 块回原位（同一个父、同一个位置），子树一起回来', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  assert.equal(kb.get('c1'), undefined, '前置：删掉之后按可见读找不到它')

  kb.tx((tx) => tx.restore('c1'))
  assert.equal(kb.trash().length, 0, '恢复之后回收站清空')
  const back = kb.get('c1')
  assert.ok(back, '恢复之后应当又能读到它')
  assert.equal(back!.children.map((x) => x.id).join(','), 'g1', '子树随它一起回来')
  const roots = kb.roots().map((x) => x.id)
  assert.deepEqual(roots, ['p1', 'p2'], '森林根没变（它本来就不是根）')
  const p1 = kb.get('p1')!
  assert.deepEqual(p1.children.map((x) => x.id), ['c1', 'c2'], '回到原来的位置（不是追加到末尾）')
})

test('② 恢复之后再删、再恢复也成立（不是一次性的状态机）', () => {
  const { kb } = fixture()
  for (let i = 0; i < 3; i++) {
    kb.tx((tx) => tx.remove('c2'))
    assert.deepEqual(kb.trash().map((x) => x.id), ['c2'], `第 ${i + 1} 轮：删除后应在回收站`)
    kb.tx((tx) => tx.restore('c2'))
    assert.deepEqual(kb.trash(), [], `第 ${i + 1} 轮：恢复后回收站应空`)
  }
})

test('② 恢复一个不存在的块 ⇒ 明确抛错（不静默成功）', () => {
  const { kb } = fixture()
  assert.throws(() => kb.tx((tx) => tx.restore('nope')), /no deleted block/, '恢复不存在的块必须报错')
})

/* ------------------------------------------------------------ 派生（每次现算） */

test('回收站是**派生**的：没有第二个存放处，改动之后清单立刻跟着变', () => {
  const { kb, store } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  assert.equal(kb.trash().length, 1)
  // 直接从森林算一遍，与 kb.trash() 一致（证明它没有缓存第二份）
  assert.deepEqual(
    trashOf(store.blocks).map((x) => x.id),
    kb.trash().map((x) => x.id),
    'kb.trash() 必须等于「从森林现算」，不许有第二份缓存',
  )
})
