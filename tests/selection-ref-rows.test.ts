/**
 * 「关联到…」候选行源：默认项顺序、命中高亮、住哪、宿主排除。
 *
 * 钉住的一件事是**首项恒等于一键默认**：有精确同名 ⇒ 它是复用；没有 ⇒ 新建行
 * 提到最前。这样浮层预选 ＋ ↵ 与气泡那颗按钮等价，逃逸口不额外收决策的税。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BlockStore, textRuns, type Block } from '../src/core/index.ts'
import { t } from '../src/core/infra/msg.ts'
import { MemoryKb } from '../src/core/kb/memory.ts'
import { selectionRefRows } from '../src/app/retrieval/selection-ref-rows.ts'

const b = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  id,
  content: textRuns(text),
  children: [],
  created: 1,
  modified: 1,
  ...extra,
})

function fixture(): ReturnType<typeof selectionRefRows> {
  const forest: Block[] = [
    b('page-root', '宿主页', {
      props: { _aliases: ['宿主页'], _lists: ['page'] },
      children: [b('host', '我选了 现在 这两个字'), b('sibling', '时间管理 的另一块')],
    }),
    b('page-exact', '现在', { props: { _aliases: ['现在'], _lists: ['page'] } }),
    b('standalone', '现在也出现在这一段正文里'),
  ]
  const kb = new MemoryKb(new BlockStore(forest))
  return selectionRefRows({ kb, selfId: 'host' })
}

test('有精确同名：它排首项且不重复出现在别的组', () => {
  const rows = fixture()('现在')
  assert.equal(rows[0]?.id, 'selref/exact/page-exact')
  assert.equal(rows[0]?.group, 'selref/1-exact')
  assert.equal(rows[0]?.hint, t('ui.selRef.exactHint'))
  const same = rows.filter((r) => r.pick?.kind === 'block' && r.pick.id === 'page-exact')
  assert.equal(same.length, 1, `同一个目标只该有一行：${JSON.stringify(same)}`)
})

test('没有精确同名：新建行提到最前（↵ 与一键默认等价）', () => {
  const rows = fixture()('没听过的词')
  assert.equal(rows[0]?.id, 'selref/new')
  assert.deepEqual(rows[0]?.pick, { kind: 'newPage', name: '没听过的词' })
  assert.equal(rows[0]?.keyHint, t('ui.selRef.newKey'))
})

test('正文命中：结构化高亮 ＋ 面包屑；名字命中的页按身份列', () => {
  const rows = fixture()('现在')
  const hit = rows.find((r) => r.id === 'selref/block/standalone')
  assert.ok(hit, '正文含「现在」的普通块要进候选')
  assert.ok(hit.parts?.some((p) => p.mark === true && p.text === '现在'), `命中段要标 mark：${JSON.stringify(hit.parts)}`)
  assert.ok(hit.hint, '顶层块没有祖先时用自己的名字兜底，不能是空 hint')

  const named = fixture()('宿主')
  const page = named.find((r) => r.id === 'selref/page/page-root')
  assert.ok(page, '名字含查询词的页要能被挑中')
  assert.equal(page.group, 'retrieval/1-page')

  const child = fixture()('时间管理').find((r) => r.id === 'selref/block/sibling')
  assert.ok(child?.hint?.includes('宿主页'), `子块的「住哪」要有祖先链：${JSON.stringify(child?.hint)}`)
})

test('宿主自己不进候选；空查询词不给新建行', () => {
  const rows = fixture()('现在')
  assert.ok(!rows.some((r) => r.id.endsWith('/host')), '引用自己没有意义')
  const blank = fixture()('')
  assert.ok(!blank.some((r) => r.id === 'selref/new'), '没有名字的新建没有身份')
  assert.ok(blank.length > 0, '空查询仍能浏览块（改打字就从这里挑）')
})
