/**
 * 块菜单的两半：**目标块的 ctx** 与**行的作用域**。
 *
 * 这两条是「记录面能复用同一张菜单」的全部前提：
 *   · ctx 只读模型 ⇒ 编辑器面与记录面对同一块给同一份答案；
 *   · 每条菜单命令都显式声明 `actsOn` ⇒ 没编辑器的面不会借到需要光标/装载树的行。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { blockMenuCtxOf, mkBlock, todayISO, type Block } from '../src/core/index.ts'
import { BINDINGS, type Binding } from '../src/core/infra/bindings.ts'
import { ALL_COMMANDS } from '../src/core/commands/decls.ts'

const declOf = (name: string | undefined) =>
  name === undefined ? undefined : ALL_COMMANDS.find((d) => d.name === name)

function ctxOf(b: Block, opts: { forest?: Block[]; isForestRoot?: boolean } = {}) {
  const forest = opts.forest ?? [b]
  return blockMenuCtxOf(b, forest, {
    isDocRoot: false,
    isForestRoot: opts.isForestRoot ?? false,
  })
}

const page = (): Block => mkBlock('', { props: { _lists: ['page'], _aliases: ['某页'] } })
const tag = (): Block => mkBlock('', { props: { _lists: ['tag'], _aliases: ['某标签'] } })
const journal = (date = '2020-01-01'): Block => mkBlock('', { props: { _date: date } })
const query = (): Block => mkBlock('', { props: { _query: { where: { any: [] } } } })

test('块级 ctx：准入只有「今天不删」这一条，身份不再决定能不能删', () => {
  const normal = ctxOf(mkBlock('内容'))
  assert.equal(normal.blockMenuTarget, true)
  assert.equal(normal.blockCanDelete, true, '普通块走软删')
  assert.equal(normal.blockHasPageRole, false)
  assert.equal(normal.blockHasTagRole, false)
  assert.equal(normal.blockClosure, 'paragraph')
  assert.equal(normal.blockCanConvertType, true)

  const p = ctxOf(page())
  assert.equal(p.blockCanDelete, true, '页可删：菜单上那唯一一行「删除」就是它')
  assert.equal(p.blockHasPageRole, true)

  const t = ctxOf(tag())
  assert.equal(t.blockCanDelete, true, '标签可删（有成员时确认框会说清连带）')
  assert.equal(t.blockHasTagRole, true)
  assert.equal(t.blockCanExtractPage, false, '纯标签块没有可提取的内容身份')

  const j = ctxOf(journal())
  assert.equal(j.blockCanDelete, true, '不是今天的日记天可以删')
  const today = ctxOf(journal(todayISO()))
  assert.equal(today.blockCanDelete, false, '今天不给删：冷启动会把它物化回来')

  const q = ctxOf(query())
  assert.equal(q.blockCanDelete, true, '查询块是内容：没有替代删除命令，必须可删')
})

test('换骨架准入：身份块和只读正文不给入口，免得菜单里挂着点不动的行', () => {
  assert.equal(ctxOf(page()).blockCanConvertType, false)
  assert.equal(ctxOf(tag()).blockCanConvertType, false)
  assert.equal(ctxOf(journal()).blockCanConvertType, false)
  assert.equal(ctxOf(mkBlock('', { props: { _type: 'core/divider' } })).blockCanConvertType, false)
  assert.equal(ctxOf(mkBlock('', { props: { _type: 'core/quote' } })).blockCanConvertType, true)
})

test('「转为…」是子菜单行，正文/引文共用同一条命令且各带自己的参数', () => {
  const typeArg = (b: Binding): string => {
    const a = b.args
    return a && typeof a === 'object' && 'type' in a && typeof a.type === 'string' ? a.type : ''
  }
  const rows = BINDINGS.filter((b) => b.kind === 'menu' && b.group === 'blockKind/1')
  assert.deepEqual(rows.map(typeArg), ['outline', 'core/quote', 'core/code'])
  const anchor = BINDINGS.find((b) => b.kind === 'menu' && b.submenu === 'blockKind/')
  assert.ok(anchor?.actsOn, '子菜单锚点要自己声明作用域')
  assert.ok(rows.every((b) => b.actsOn === 'block'), '换骨架按 id 执行，记录面也要出现')
})

test('块级 ctx：嵌套的页也只留「删页」——身份决定，不按装载根', () => {
  const parent = mkBlock('parent')
  const childPage = page()
  parent.children.push(childPage)
  const ctx = ctxOf(childPage, { forest: [parent], isForestRoot: false })
  assert.equal(ctx.blockCanDelete, true, '页就是页：能不能删不由「嵌在哪」决定')
  assert.equal(ctx.blockHasPageRole, true)
})

test('块菜单的子菜单是行数据：没有命令、必须自己声明作用域', () => {
  const menu = BINDINGS.filter((b) => b.kind === 'menu' && (b.group ?? '').startsWith('block/'))
  for (const b of menu) {
    if (b.command) {
      assert.ok(declOf(b.command), `块菜单引用了未声明的命令：${b.command}`)
      continue
    }
    assert.ok(b.submenu, `块菜单行既没有 command 也没有 submenu：${b.group ?? ''}`)
    assert.ok(b.actsOn, `子菜单 ${b.submenu} 缺 actsOn`)
  }
})

test('作用域切分：块级动作在记录面可用，位置/选区动作不可用', () => {
  const actsOnOf = (b: Binding): string =>
    b.actsOn ?? (b.command ? (declOf(b.command)?.actsOn ?? 'editor') : 'editor')
  const menuTree = BINDINGS.filter(
    (b) => b.kind === 'menu' && /^block(\/|Copy\/|Insert\/)/.test(b.group ?? ''),
  )
  const blockOnly = menuTree.filter((b) => actsOnOf(b) === 'block').map((b) => b.command)

  for (const need of [
    'core.block/inspect',
    'core.block/configure',
    'core.block/move-to',
    'core.block/delete',
    'core.editor/toggle-closure',
    'core.editor/copy-block',
    'core.editor/duplicate-block',
  ]) {
    assert.ok(blockOnly.includes(need), `${need} 应按 id 执行，记录面要能出现`)
  }

  for (const notBlock of [
    'core.editor/indent-block',
    'core.editor/outdent-block',
    'core.editor/move-block-up',
    'core.editor/move-block-down',
    'core.editor/toggle-collapse',
    'core.block/zoom-out',
    'core.anno/clear-marks',
    'core.query/insert',
  ]) {
    assert.ok(!blockOnly.includes(notBlock), `${notBlock} 需要编辑器/选区，记录面不该出现`)
  }
})
