/**
 * **「选一个标签」的候选判据**（`app/retrieval/tag-choice.ts`）。
 *
 * 钉住五件事：
 *   ① 过滤走**全部地址**（第二别名、大小写、空白规范化都能找到自己）；
 *   ② 排序走**主地址**（`A/B` 与 `C/B` 的叶子相同，按叶子排会看着无序）；
 *   ③ 来源＝全部／限定子树／已用优先；已选与排除项不出现在候选里；
 *   ④ 新建行只在「有输入且没有同名标签」时出现；同名页会给「复用它」的文案；
 *   ⑤ **目录只建一次**：标签再多、查询再多次，邻接表也只建一遍（旧写法是每行建一遍）。
 *
 * ⚠️ 这里刻意不测浮层 DOM／按键：菜单的键盘与 IME 组合守卫住在 `ui/overlay/layers.ts`
 *    与 `ui/overlay/query-gate.ts`，前者由真浏览器冒烟验，后者的状态机由 `query-gate` 单测钉。
 * ⚠️ 断言顺序时用 ASCII 名字：`localeCompare` 对中文的次序取决于宿主 ICU，不该由测试来猜。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { textRuns, walkForest, type Block } from '../src/core/index.ts'
import { t } from '../src/core/infra/msg.ts'
import { createTagChoice } from '../src/app/retrieval/tag-choice.ts'

const tag = (id: string, aliases: string[], parents: string[] = []): Block => ({
  id,
  content: textRuns(aliases[0] ?? ''),
  children: [],
  created: 0,
  modified: 0,
  props: {
    _aliases: aliases,
    _lists: ['tag'],
    ...(parents.length > 0 ? { _belongsTo: parents } : {}),
  },
})

const page = (id: string, alias: string): Block => ({
  id,
  content: textRuns(alias),
  children: [],
  created: 0,
  modified: 0,
  props: { _aliases: [alias], _lists: ['page'] },
})

const labels = (rows: { label: string }[]): string[] => rows.map((r) => r.label)
const tagRows = (rows: { group?: string }[]): { label: string; hint?: string }[] =>
  rows.filter((r) => r.group === 'tagpick/1') as { label: string; hint?: string }[]

test('① 过滤：任一地址命中（第二别名、大小写、空白规范化）', () => {
  const forest = [tag('a', ['actors', '演员']), tag('b', ['places'])]
  const choice = createTagChoice(forest)

  assert.deepEqual(labels(tagRows(choice.rows('')),), ['#actors', '#places'], '空查询列全部，按主地址排')
  assert.deepEqual(labels(tagRows(choice.rows('演员'))), ['#actors'], '第二别名也能找到自己')
  assert.deepEqual(labels(tagRows(choice.rows('  ACTORS  '))), ['#actors'], '输入框里的空白由规范化吞掉')
  assert.deepEqual(labels(tagRows(choice.rows('places'))), ['#places'])
})

test('② 排序：按主地址而不是显示叶子（`A/B` 与 `C/B` 的叶子相同）', () => {
  const forest = [tag('z', ['C/B']), tag('a', ['A/B']), tag('m', ['B'])]
  const choice = createTagChoice(forest)
  assert.deepEqual(labels(choice.rows('')), ['#B', '#B', '#B'], '三行都是叶子 B')
  assert.deepEqual(choice.tags.map((b) => b.id), ['a', 'm', 'z'], '主地址序：A/B < B < C/B')
})

test('③ 层级提示来自边的上级；已选／排除不出现；限定子树；已用优先', () => {
  const forest = [tag('root', ['root', '根']), tag('child', ['root/child', '子'], ['root']), tag('other', ['other'])]
  const choice = createTagChoice(forest)

  assert.equal(
    tagRows(choice.rows('child'))[0]!.hint,
    t('ui.tagPicker.hierarchy', { parents: '#root' }),
    '上级显示主名叶子',
  )
  assert.deepEqual(
    labels(tagRows(createTagChoice(forest, { selectedIds: ['root'], excludeIds: ['other'] }).rows(''))),
    ['#child'],
    '已选与排除项都不进候选',
  )
  assert.deepEqual(
    labels(tagRows(createTagChoice(forest, { rootId: 'root' }).rows(''))),
    ['#root', '#child'],
    '限定子树＝根的下级闭包（含根自己）',
  )
  assert.deepEqual(
    labels(tagRows(createTagChoice(forest, { priorityIds: ['other', 'child'] }).rows(''))),
    ['#other', '#child', '#root'],
    '已用优先按调用方给的顺序先出，其余保持地址序',
  )
})

test('④ 新建行：空查询不给；有同名标签不给；同名页说明「复用它」', () => {
  const forest = [tag('a', ['exists']), page('p', 'brandnew')]
  const choice = createTagChoice(forest)

  assert.equal(choice.rows('').length, 1, '空查询只有标签行，不给新建')
  assert.equal(choice.rows('exists').some((r) => r.pick?.kind === 'newTag'), false, '同名标签已存在，不给新建')
  const reuse = choice.rows('brandnew').find((r) => r.pick?.kind === 'newTag')
  assert.ok(reuse, '没有同名标签 ⇒ 给新建行')
  assert.equal(reuse!.label, t('ui.tagPicker.reusePage', { name: 'brandnew' }))
  assert.equal(reuse!.hint, t('ui.tagPicker.reuseHint'))
  assert.equal(reuse!.group, 'tagpick/0', '新建行在最前')
  assert.deepEqual(labels(choice.rows('ex')), ['新建标签「ex」', '#exists'], '部分匹配仍能建新标签，且新建行排第一')
  assert.equal(choice.pageFor('brandnew')?.id, 'p')
})

test('④b `#` 浮层的形状：新建行排在最后，带键位／加号图标／自己的行 id', () => {
  const forest = [tag('a', ['exists'])]
  const choice = createTagChoice(forest, {
    idPrefix: 'retrieval/tag',
    tagGroup: 'retrieval/2-tag',
    createGroup: 'retrieval/3-new',
    createFirst: false,
    keyHint: '⌥↵',
    createIcon: 'lucide:plus',
    createId: (name) => `retrieval/newTag/${name}`,
    createLabel: (name) => t('ui.retrieval.newTag', { name }),
    createHint: () => t('ui.retrieval.newTagHint'),
  })

  const rows = choice.rows('ex')
  assert.deepEqual(rows.map((r) => r.group), ['retrieval/2-tag', 'retrieval/3-new'], '标签在前，新建在后')
  const created = rows.find((r) => r.pick?.kind === 'newTag')!
  assert.equal(created.id, 'retrieval/newTag/ex')
  assert.equal(created.icon, 'lucide:plus')
  assert.equal(created.hint, t('ui.retrieval.newTagHint'))
  for (const r of rows) assert.equal(r.keyHint, '⌥↵', '每一行都画同一枚键位徽标')
  assert.equal((rows[0]!.pick as { kind: string }).kind, 'tag', '已有标签行报「选中了谁」')
})

test('⑤ 成员计数只来自调用方给的函数（组件不为此扫库）', () => {
  const forest = [tag('a', ['people']), tag('b', ['places'])]
  const choice = createTagChoice(forest, { memberCount: (id) => (id === 'a' ? 3 : 0) })
  const rows = tagRows(choice.rows(''))
  assert.equal(rows.find((r) => r.label === '#people')!.hint, t('ui.tagPicker.members', { count: 3 }))
  assert.equal(rows.find((r) => r.label === '#places')!.hint ?? '', '', '计数为 0 时不画')
})

test('⑥ 目录只建一次：标签再多、查询再多次，邻接表也只建一遍', () => {
  const forest: Block[] = []
  for (let i = 0; i < 50; i++) forest.push(tag(`t${i}`, [`tag${i}`]))
  let walks = 0
  const walk = ((f, cb, opts) => {
    walks += 1
    return walkForest(f, cb, opts)
  }) as typeof walkForest

  const choice = createTagChoice(forest, {}, walk)
  assert.equal(walks, 1, '打开这一刻建一次（旧写法是每行一次 = 50 次）')

  for (const q of ['', 'tag', 'tag1', 't', 'tag2']) choice.rows(q)
  assert.equal(walks, 1, '输入只做本地过滤，不再重建邻接表')
})
