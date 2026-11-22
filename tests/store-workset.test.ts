/**
 * **工作集状态**：块对象只有一份，`loaded` 只回答「在不在内存里」。
 *
 * 四条判据（每条都能被独立推翻）：
 *
 * | # | 不变量 | 怎么证伪 |
 * |---|---|---|
 * | ① | 整库模式：读得到的块都算已加载；未知 id 不算 | `isLoaded` 退回 `partial` 或恒真，本条红 |
 * | ② | 工作集模式：未加载的 `find` ⇒ `undefined`、`isLoaded` ⇒ false | 让 `find` 回退全库扫描/造占位块，本条红 |
 * | ③ | pin 住的块不淘汰（含「钉在子树里」） | `trimWorkset` 不看 pin，本条红 |
 * | ④ | 淘汰按 LRU：最近被 `find` 过的先留下 | 淘汰顺序改成数组顺序，LRU 那条红 |
 * | ⑤ | 本笔新建的子树入册（`needsDoc` 假）；失败事务不留假记录 | 去掉 `markCreated` 调用 ⇒「建完就打开」的入口又去打库读回空 |
 *
 * 为什么「未加载」必须显式：部分装载下「读不到」同时表示「未加载」与「不存在」；
 * 任何一条静默回退（全库扫描、占位块）都会让这两件事重新混成一个答案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock } from '../src/core/model/model.ts'
import { mkAutomationBlock } from '../src/core/automation/automation.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { BlockStore } from '../src/core/model/store.ts'
import type { Block } from '../src/core/model/model.ts'

function tree(): { a: Block; a1: Block; c: Block; ids: string[] } {
  const a1 = mkBlock('甲一')
  const a = mkBlock('甲')
  a.children.push(a1)
  const c = mkBlock('丙')
  return { a, a1, c, ids: [a.id, a1.id, c.id] }
}

test('① 整库模式：已知块算已加载，未知 id 不算', () => {
  const { a, a1, c } = tree()
  const store = new BlockStore([a, c])
  assert.equal(store.partial, false)
  assert.equal(store.isLoaded(a.id), true)
  assert.equal(store.isLoaded(a1.id), true, '子树里的块也在内存里')
  assert.equal(store.isLoaded('missing'), false)
})

test('② 工作集模式：未加载的 find 是 undefined，且不造占位块', () => {
  const { a, a1, c, ids } = tree()
  const store = new BlockStore([a, c])
  // 只装甲这一棵子树；丙“在库里”但没有对象
  store.setWorkset([a], new Set([a.id, a1.id]))
  assert.equal(store.partial, true)
  assert.equal(store.find(a.id), a, '已加载块仍是同一个对象')
  assert.equal(store.find(a1.id), a1)
  assert.equal(store.find(c.id), undefined)
  assert.equal(store.isLoaded(c.id), false)
  assert.equal(store.loadedCount, 2)
  assert.equal(ids.length, 3)
})

test('③ pin 住的块不淘汰；钉在子树里的块也算被钉住', () => {
  const { a, a1, c } = tree()
  const store = new BlockStore([a, c])
  store.setWorkset([a, c], new Set([a.id, a1.id, c.id]))
  // 钉住子树里的 a1（不是顶层根）——淘汰 a 会连它一起带走，所以 a 必须留下
  store.pin([a1.id])
  const evicted = store.trimWorkset(2)
  assert.equal(evicted, 1, '只该淘汰丙这一棵')
  assert.equal(store.find(c.id), undefined)
  assert.equal(store.isLoaded(c.id), false)
  assert.equal(store.find(a.id), a)
  assert.equal(store.find(a1.id), a1)
  assert.equal(store.worksetProbe.evictions, 1)
})

test('④ 淘汰按 LRU：最近被读过的先留下', () => {
  const { a, c } = tree()
  const store = new BlockStore([a, c])
  store.setWorkset([a, c], new Set([a.id, c.id]))
  // 装载顺序是 a → c；读一下 a，把它变成最近使用
  assert.equal(store.find(a.id), a)
  store.trimWorkset(1)
  assert.equal(store.find(a.id), a, '最近读过的 a 留下')
  assert.equal(store.isLoaded(c.id), false, '更久没用的 c 被淘汰')
})

test('reset（换库）回到整库模式，旧工作集状态不残留', () => {
  const { a, c } = tree()
  const store = new BlockStore([a])
  store.setWorkset([a], new Set([a.id]))
  store.pin([a.id])
  store.reset([a, c])
  assert.equal(store.partial, false)
  assert.equal(store.isLoaded(c.id), true, '整库模式下另一块也在内存里')
  assert.equal(store.isPinned(a.id), false)
})

test('⑤ 本笔新建的子树入册：needsDoc 为假（建完就打开不再去打库）；失败事务不留假记录', () => {
  const store = new BlockStore([])
  // 切进部分装载（空工作集）：这是桌面启动之后的状态，`needsDoc` 在这里才有意义
  store.adoptLoaded([])
  const kb = new MemoryKb(store)
  assert.equal(store.partial, true)

  const rule = mkAutomationBlock({
    name: '未命名自动化',
    def: { enabled: false, triggers: ['manual'], steps: [] },
  })
  kb.tx((tx) => {
    tx.insert(rule, null, 0)
  })
  assert.equal(store.isLoaded(rule.id), true, '本笔造出来的块就在内存里')
  assert.equal(store.childrenKnown(rule.id), true, '它的 children 就是构造时给的那份')
  assert.equal(
    kb.needsDoc(rule.id),
    false,
    '不用补读——否则「建完就打开」会去库里读（写还在防抖窗口里）而读回空，打开闸中止',
  )

  // 整库模式不因新建被切成部分装载
  const whole = new BlockStore([])
  new MemoryKb(whole).tx((tx) => {
    tx.insert(mkBlock('普通块'), null, 0)
  })
  assert.equal(whole.partial, false)

  // 失败事务整批回滚 ⇒ 不留「已装载」的假记录（块不在树上，也不该在集合里）
  const doomed = mkBlock('会失败的新块')
  assert.throws(() =>
    kb.tx((tx) => {
      tx.insert(doomed, null, 0)
      throw new Error('boom')
    }),
  )
  assert.equal(store.isLoaded(doomed.id), false)
  assert.equal(kb.needsDoc(doomed.id), true, '没建成的块照旧是「要补读」')
})
