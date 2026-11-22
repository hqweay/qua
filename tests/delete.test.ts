/**
 * 删除的代价与落点：确认框问什么、删完去哪。
 *
 * 这两件事都不该由「这块是页还是标签」回答——按身份分档会让同一次删除有两个答案，
 * 兼位的块（页＋标签）连听哪一个都不确定。这里钉住的是：
 *   · 代价只由「这一下带走什么」算（子树块数／成员／声明／值）；
 *   · 落点只由「还有没有可落的东西」算（邻页 → 任一页 → 今日日记流）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { deletionCostOf, journalId, mkBlock, needsConfirm, todayISO, type Block } from '../src/core/index.ts'
import { deleteCommands } from '../src/app/commands/delete.ts'
import type { PageDeps } from '../src/app/commands/types.ts'

const page = (name: string): Block => mkBlock('', { props: { _lists: ['page'], _aliases: [name] } })
const tag = (name: string): Block => mkBlock('', { props: { _lists: ['tag'], _aliases: [name] } })
const def = (label: string): Block => mkBlock(label, { props: { _kind: 'text' } })

/** 一块 ＋ 两个子块 */
const withKids = (b: Block, n: number): Block => {
  for (let i = 0; i < n; i++) b.children.push(mkBlock(`子 ${i}`))
  return b
}

test('deletionCostOf：子树按块数、标签按成员与声明、字段定义按声明与值', () => {
  const p = withKids(page('某页'), 2)
  assert.deepEqual(deletionCostOf(p, [p]), { blocks: 3, members: 0, declarations: 0, values: 0 })
  assert.equal(needsConfirm(p, deletionCostOf(p, [p])), true, '命名对象还带着内容 ⇒ 要问')

  const leaf = mkBlock('叶子')
  assert.equal(needsConfirm(leaf, deletionCostOf(leaf, [leaf])), false, '叶子没连带 ⇒ 不问')

  // 正文里带子块的普通块：删掉什么就在眼前，不问（大纲里的日常动作）
  const para = withKids(mkBlock('段落'), 3)
  assert.equal(
    needsConfirm(para, deletionCostOf(para, [para])),
    false,
    '带子块的内容块也是「看得见的范围」，不该停下问一次',
  )

  // 标签：两个成员 ＋ 声明一个字段
  const d = def('状态')
  const t = tag('某标签')
  t.props = { ...t.props, _fieldDefs: [d.id] }
  const m1 = mkBlock('成员 1', { props: { _tags: [t.id] } })
  const m2 = mkBlock('成员 2', { props: { _tags: [t.id] } })
  const forest = [t, d, m1, m2]
  const tc = deletionCostOf(t, forest)
  assert.equal(tc.members, 2, '两个块打着它')
  assert.equal(tc.declarations, 1, '它声明了一个字段')

  // 字段定义：一个标签声明它 ＋ 一块带着它的值
  const dtag = tag('用到它的标签')
  dtag.props = { ...dtag.props, _fieldDefs: [d.id] }
  const valued = mkBlock('有值', { props: { [d.id]: '完成' } })
  const dc = deletionCostOf(d, [d, dtag, valued])
  assert.equal(dc.declarations, 1, '一个标签声明了这份定义')
  assert.equal(dc.values, 1, '一块带着这一格值')
})

interface Stub {
  deps: PageDeps
  log: string[]
}

/**
 * 最小 PageDeps：只装删除用得到的那几个读函数与写入口。
 * 删不掉的路径（spliceOut）默认返回 false —— 删除那一份就该走库级软删。
 */
function stub(forest: Block[], opts: { pages?: Block[]; activeId?: string; roots?: string[] } = {}): Stub {
  const log: string[] = []
  /** 活的森林与页清单：删掉就从两个清单里退场（读门面就是这么回答的，软删的块不算页） */
  let live = [...forest]
  let pages = opts.pages ?? forest.filter((b) => b.props?._lists?.includes('page'))
  const deps = {
    kb: {
      isLoaded: () => true,
      get: (id: string) => live.find((b) => b.id === id),
      roots: () => live,
      pages: () => pages,
    },
    spliceOut: () => false,
    removeBlock: (id: string) => {
      log.push(`remove:${id}`)
      live = live.filter((b) => b.id !== id)
      pages = pages.filter((b) => b.id !== id)
    },
    activeId: () => opts.activeId ?? '',
    rootIds: () => opts.roots ?? [],
    setActiveId: (id: string) => log.push(`active:${id}`),
    loadPage: (roots: Block[]) => log.push(`load:${roots.map((b) => b.id).join(',')}`),
    loadDocThen: (_ids: readonly string[], then: () => void) => then(),
    refreshList: () => log.push('refreshList'),
    refreshTitle: () => log.push('refreshTitle'),
    saveNow: () => log.push('saveNow'),
    toast: (text: string) => log.push(`toast:${text}`),
    confirm: (o: { onConfirm: () => void }) => {
      log.push('confirm')
      o.onConfirm()
    },
  } as unknown as PageDeps
  return { deps, log }
}

test('落点三档：邻页 → 任一页 → 今日日记流（删掉最后一页落在今日，不是空白）', () => {
  const a = page('A')
  const b = page('B')
  const gone = page('X')

  // 邻页：删 X（装载中）⇒ 换到邻位那一页
  {
    const s = stub([a, b, gone], { pages: [a, gone, b], activeId: gone.id, roots: [gone.id] })
    const { openTodayFeed } = { openTodayFeed: () => void s.log.push('today') }
    deleteCommands(s.deps, { openTodayFeed }).deleteBlock(gone.id)
    assert.ok(s.log.includes(`active:${b.id}`), `应换到邻位页：${JSON.stringify(s.log)}`)
    assert.ok(!s.log.includes('today'), '还有页就不回今日')
  }

  // 零页：删掉最后一个页 ⇒ 回今日日记流
  {
    const only = page('唯一')
    const s = stub([only], { pages: [only], activeId: only.id, roots: [only.id] })
    deleteCommands(s.deps, { openTodayFeed: () => void s.log.push('today') }).deleteBlock(only.id)
    assert.ok(s.log.includes('today'), `没有页可落 ⇒ 回今日日记流：${JSON.stringify(s.log)}`)
  }
})

test('准入：今天删不掉（说得出口地拒绝），过去的日记天可以删', () => {
  const today = mkBlock('', { props: { _date: todayISO() } })
  const past = mkBlock('', { props: { _date: '2020-01-02' } })
  const s = stub([today, past])
  const cmds = deleteCommands(s.deps, { openTodayFeed: () => void s.log.push('today') })

  assert.equal(cmds.deleteBlock(today.id), false)
  assert.ok(s.log.some((x) => x.startsWith('toast:')), '拒绝要给一句实话，不是静默什么都没发生')
  assert.ok(!s.log.includes(`remove:${today.id}`), '拒绝就不许真删')

  // 过去的日记天：删完回今日日记流（它的邻位就是流）
  s.log.length = 0
  assert.equal(cmds.deleteBlock(past.id), true)
  assert.ok(s.log.includes(`remove:${past.id}`))
  assert.ok(!s.log.includes('confirm'), '一天没子块、没连带 ⇒ 不问')

  // 装载中的那一天：删完**回日记流**，不是甩到某一页（落点跟着这块的家走）
  {
    const today2 = mkBlock('', { props: { _date: '2020-01-03' } })
    const a = page('A')
    const s2 = stub([a, today2], { activeId: today2.id, roots: [today2.id] })
    deleteCommands(s2.deps, { openTodayFeed: () => void s2.log.push('today') }).deleteBlock(today2.id)
    assert.ok(s2.log.includes('today'), `删掉正在看的一天 ⇒ 回日记流：${JSON.stringify(s2.log)}`)
  }
})

test('确认按代价：有连带就问一次，问完才删', () => {
  const p = withKids(page('大页'), 3)
  const s = stub([p])
  const cmds = deleteCommands(s.deps, { openTodayFeed: () => void s.log.push('today') })
  assert.equal(cmds.deleteBlock(p.id), true)
  const iConfirm = s.log.indexOf('confirm')
  const iRemove = s.log.indexOf(`remove:${p.id}`)
  assert.ok(iConfirm >= 0, '有子块 ⇒ 要问')
  assert.ok(iRemove > iConfirm, `问完才删：${JSON.stringify(s.log)}`)
})

test('journalId 是确定性派生的：删除后复活靠它认同一块（这里只钉住「同一天同一个 id」）', () => {
  assert.equal(journalId('2020-01-02'), journalId('2020-01-02'))
})
