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
import { BlockStore } from '../src/core/model/store.ts'
import { mkBlock, isDeleted, type Block } from '../src/core/model/model.ts'
import { isBlankTrashEntry, trashOf } from '../src/core/model/tree.ts'
import { diff, forestFingerprint, replay } from '../src/core/kb/diff.ts'
import type { Op } from '../src/core/kb/types.ts'

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

/* ------------------------------------------------------------ 清空（永久清除） */

const purgeIds = (ops: readonly Op[]): string[] =>
  ops.filter((o) => o.e === 'block' && o.op === 'exist').map((o) => (o as { id: string }).id)

test('清空一条 ⇒ 整棵子树退场，每块一条 op（子先于父），兄弟位不动', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  const ops = kb.purgeTrash(['c1'])
  // `c1` 的子树是 [c1, g1] ⇒ 两条，`g1` 在前（清除子先于父）
  assert.deepEqual(purgeIds(ops), ['g1', 'c1'], `op 应覆盖整棵子树、子先于父：${purgeIds(ops).join(',')}`)
  assert.equal(kb.trash().length, 0, '清空之后回收站空')
  assert.equal(kb.get('c1'), undefined)
  const p1 = kb.get('p1')!
  assert.deepEqual(p1.children.map((x) => x.id), ['c2'], '子树从树上整棵摘掉，兄弟位不动')
})

test('清空可重放：genesis ＋ 编辑流 ＋ 清空 ⇒ replay 与当前森林逐字节相等', () => {
  const store = new BlockStore([b('p1', [b('c1', [b('g1')]), b('c2')]), b('p2')])
  const kb = new MemoryKb(store, { now: () => NOW })
  const ops: Op[] = [...diff([], store.blocks)]
  ops.push(...kb.tx((tx) => tx.remove('c1')).ops)
  ops.push(...kb.tx((tx) => tx.remove('p2')).ops)
  ops.push(...kb.purgeTrash(['c1', 'p2']))
  assert.equal(
    forestFingerprint(replay(ops) as never),
    forestFingerprint(store.blocks as never),
    '清空的 op 进日志后，重放必须回到同一个状态（purge 不是绕过日志的旁路）',
  )
})

test('清空是幂等的：同一批再清一次 ⇒ 零 op', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('c1'))
  kb.purgeTrash(['c1'])
  assert.deepEqual(kb.purgeTrash(['c1']), [], '块已经不在了 ⇒ 不再发 op')
})

test('嵌套条目（子树里另有带标记的后代）一起清 ⇒ 每块恰好一条 op，不重复', () => {
  const { kb } = fixture()
  kb.tx((tx) => tx.remove('g1'))
  kb.tx((tx) => tx.remove('c1'))
  const ops = kb.purgeTrash(['c1', 'g1'])
  const ids = purgeIds(ops)
  assert.equal(new Set(ids).size, ids.length, `不应有重复的 op：${ids.join(',')}`)
  assert.deepEqual([...ids].sort(), ['c1', 'g1'], '两条都要有账（谁先谁后都行，但不能丢也不能重）')
  assert.equal(kb.trash().length, 0)
})

test('清空只认带删除标记的根：活动块与未知 id 不动、返回零 op', () => {
  const { kb } = fixture()
  assert.deepEqual(kb.purgeTrash(['c1', 'nope']), [], '活动块与不存在的 id 都不该产生 op')
  assert.deepEqual(kb.roots().map((x) => x.id), ['p1', 'p2'], '森林原样')
})

/* ------------------------------------------------------------ 空块口径 */

test('空块判据：正文投影为空 ∧ 无子块；带正文或带子树都不算', () => {
  assert.ok(isBlankTrashEntry(b('blank')), '空正文空子树 ⇒ 空块')
  assert.ok(!isBlankTrashEntry(b('withKids', [b('kid')])), '带子树的条目不算空块（子树里可能有要保留的东西）')
  assert.ok(!isBlankTrashEntry(mkBlock('有字', { created: NOW, modified: NOW })), '有正文的条目不算空块')
})

