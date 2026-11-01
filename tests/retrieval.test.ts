/**
 * **`#` 第二段的成员搜索**（`app/retrieval/member-rows.ts` 的 `memberRows`）。
 *
 * 断言口径贴用户能看见的性质：
 *   · 第二段的查询词匹配**成员文本**（第一段匹配的是标签名，两个方向不同）；
 *   · 「新建实例」行只在**有输入且无同名成员**时出现——空查询与已有同名都不该给；
 *   · 身份块与空正文块不成候选；正在打字的这一块不成候选（引用自己没有意义）。
 *
 * ⚠️ 这里刻意不测浮层：浮层与焦点由真浏览器冒烟（T208）验，单测只钉纯判据。
 * ⚠️ 只 import `member-rows.ts`（纯判据模块）：`triggers.ts` 那份会牵进浮层的 DOM 装配。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkBlock, writeBlockContent, textRuns, type Block } from '../src/core/index.ts'
import { memberRows, type MemberDeps } from '../src/app/retrieval/member-rows.ts'

/** 归属在块上（`props._tags`），与 `tx.setTags` 落的同一格 */
const tagBlock = (block: Block, tagId: string): void => {
  block.props = { ...(block.props ?? {}), _tags: [tagId] }
}

function forest(): Block[] {
  // 标签块的身份在 `_lists`（`hasIdentity` 靠它排除身份块），名字是地址
  const tag = mkBlock('玩具')
  tag.props = { _aliases: ['玩具'], _lists: ['tag'] }
  const record = (text: string): Block => {
    const b = mkBlock('')
    writeBlockContent(b, textRuns(text))
    tagBlock(b, tag.id)
    return b
  }
  const sw = record('switch 主机')
  const zelda = record('塞尔达传说')
  return [tag, sw, zelda, record('')]
}

let blocks: Block[] = []
const deps = (selfId: string | null): MemberDeps => ({
  forest: () => blocks,
  selfBlockId: () => selfId,
})

test('memberRows：查询词匹配成员文本，不匹配的成员不出现', () => {
  blocks = forest()
  const tag = blocks[0]!
  const rows = memberRows({ tagId: tag.id, name: '玩具' }, 'swi', deps(null))
  const labels = rows.filter((r) => r.group === 'retrieval/1-instance').map((r) => r.label)
  assert.equal(labels.length, 1, `只有文本命中的成员：${JSON.stringify(labels)}`)
  assert.ok(labels[0]!.includes('switch'), `命中 switch：${JSON.stringify(labels)}`)
})

test('memberRows：空查询列出全部成员、不给新建行；非空且无同名才给新建行', () => {
  blocks = forest()
  const tag = blocks[0]!
  const empty = memberRows({ tagId: tag.id, name: '玩具' }, '', deps(null))
  assert.equal(empty.filter((r) => r.group === 'retrieval/1-instance').length, 2, '空查询列全部成员')
  assert.equal(empty.filter((r) => r.pick.kind === 'newObj').length, 0, '空查询不给新建行')

  const fresh = memberRows({ tagId: tag.id, name: '玩具' }, 'switch 2', deps(null))
  const create = fresh.find((r) => r.pick.kind === 'newObj')
  assert.ok(create, '无同名成员 ⇒ 给新建行')
  assert.ok(create!.label.includes('switch 2'), `新建行的名字就是输入文本：${create!.label}`)
  assert.ok(create!.hint.includes('玩具'), `新建行说明归到哪个标签：${create!.hint}`)

  const dup = memberRows({ tagId: tag.id, name: '玩具' }, 'Switch 主机', deps(null))
  assert.equal(dup.filter((r) => r.pick.kind === 'newObj').length, 0, '已有同名成员（忽略大小写）⇒ 不给新建行')
})

test('memberRows：成员行带着 tagId；空正文块不成候选；正在打字的块不成候选', () => {
  blocks = forest()
  const tag = blocks[0]!
  const rows = memberRows({ tagId: tag.id, name: '玩具' }, '', deps(null))
  for (const r of rows.filter((x) => x.group === 'retrieval/1-instance')) {
    assert.equal(r.pick.kind, 'instance')
    assert.equal((r.pick as { tagId: string }).tagId, tag.id, `成员行锚定标签：${JSON.stringify(r.pick)}`)
  }
  assert.equal(rows.filter((r) => r.label === '#').length, 0, '空正文不成候选')

  // 正在打字的这一块（自身带标签、正文含查询词）不该出现在候选里
  const self = blocks[1]!
  const withSelf = memberRows({ tagId: tag.id, name: '玩具' }, 'switch', deps(self.id))
  assert.equal(withSelf.filter((r) => r.pick.kind === 'instance').length, 0, '自我引用不成候选')
})

test('memberRows：没有 tagId（标签还没建）⇒ 只有新建行', () => {
  blocks = forest()
  const rows = memberRows({ name: '玩具' }, 'switch', deps(null))
  assert.equal(rows.filter((r) => r.group === 'retrieval/1-instance').length, 0, '没有成员可列')
  assert.equal(rows.filter((r) => r.pick.kind === 'newObj').length, 1, '新建行仍在')
})
