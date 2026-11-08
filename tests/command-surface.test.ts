/**
 * **命令面的数据口径**：一个能力一个命令、命名一词一义、面板不放假条目。
 *
 * 命令表与绑定表是纯数据，这些断言钉在**源头**上——不改代码就把重复命令或旧叫法
 * 加回来时，这里先红。标题按用户可见字符串逐字断言：改措辞是合法演进，但必须
 * 连着这里一起改，不能让旧词悄悄回流。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMANDS } from '../src/core/commands/decls.ts'
import { BINDINGS } from '../src/core/infra/bindings.ts'
import { groupTitle } from '../src/ui/overlay/group-titles.ts'

const visible = COMMANDS.filter((c) => !c.hidden)

test('一个能力一个命令：左槽开关只有 core.dock/*，旧别名不回来', () => {
  assert.ok(!COMMANDS.some((c) => c.name === 'core.view/toggle-rail'), '旧别名 toggle-rail 已删，别再加回来')
  const leftToggles = visible.filter((c) => c.title === '收起 / 展开左槽')
  assert.equal(leftToggles.length, 1, `「收起 / 展开左槽」应只有一行：${JSON.stringify(leftToggles.map((c) => c.name))}`)
  assert.ok(!visible.some((c) => c.title.includes('左栏')), '「左栏」一词已退场（槽叫左槽/右槽）')
})

test('面板无重名行：「粘贴为…」只有子菜单锚点可见，两档预设不露面', () => {
  const paste = visible.filter((c) => c.title === '粘贴为…')
  assert.equal(paste.length, 1, `「粘贴为…」应只有一行：${JSON.stringify(paste.map((c) => c.name))}`)
  assert.equal(paste[0]?.name, 'core.embed/paste-menu', '面板可见的应是子菜单锚点')
  assert.ok(COMMANDS.find((c) => c.name === 'core.embed/paste')?.hidden, 'mirror/table 两档是菜单预设，不进面板')
})

test('标题不带类别前缀：类别由面板分组承载，搜索词进 keywords', () => {
  for (const prefix of ['挂载区：', '查询：', '视图：']) {
    assert.ok(!visible.some((c) => c.title.startsWith(prefix)), `不应再有「${prefix}」前缀，类别归分组管`)
  }
  assert.ok(!visible.some((c) => c.title.includes('嵌入')), '「嵌入」统一为「露面」')
  // 去前缀的前提是搜索不丢：mount 族的关键词里必须带着「挂载区」
  for (const c of COMMANDS.filter((c) => c.name.startsWith('core.mount/'))) {
    assert.ok(c.keywords?.includes('挂载区'), `${c.name} 的 keywords 应含「挂载区」`)
  }
})

test('键位：⌘P 只开命令面板，⌘K 只开全局搜索，⌘F 留给就地查找', () => {
  const keysOf = (command: string) =>
    BINDINGS.filter((b) => b.kind === 'keymap' && b.command === command).map((b) => b.key)
  assert.deepEqual(keysOf('core.command-palette/show'), ['mod+p'], '命令面板只住在 ⌘P：多一个入口就多一套键位提示')
  assert.deepEqual(keysOf('core.search/open'), ['mod+k'], '全局搜索只留 ⌘K')
  assert.equal(keysOf('core.search/open').length, 1, '⌘P 上的旧搜索绑定要删掉，不是叠加')
  const onF = BINDINGS.filter((b) => b.kind === 'keymap' && b.key === 'mod+f')
  assert.deepEqual(onF, [], '⌘F 预留给就地查找，全局键位表里不该有人占它')
})

test('一键两义：编辑器态的身份必须排在全局态之后（⌘K＝搜索/插链接）', () => {
  // 同一个键可以按状态做两件事，但解析是**反向遍历、后出现者优先**——
  // 特异的（编辑器态）绑定必须排在一般的（when 空）之后，否则永远轮不到。
  // 表序就是裁决序：这不是风格，是键位能不能用的分界（⌘⇧D 同款手法）。
  const withIndex = BINDINGS.map((b, i) => ({ b, i })).filter((x) => x.b.kind === 'keymap' && x.b.key === 'mod+k')
  const link = withIndex.find((x) => x.b.command === 'core.editor/insert-link')
  const search = withIndex.find((x) => x.b.command === 'core.search/open')
  assert.ok(link && search, '⌘K 的两个身份（插链接/全局搜索）都应在表上')
  assert.ok(link!.b.when === 'editorTextFocus' && search!.b.when === '', '两个身份的 when：编辑器态/全局态')
  assert.ok(link!.i > search!.i, '插链接必须排在搜索之后，否则编辑器里 ⌘K 永远开搜索')
})

test('绑定表只有四个渲染面（keymap/menu/slash/selection），面板枚举命令表不经绑定表', () => {
  for (const b of BINDINGS) {
    assert.ok(b.kind !== 'palette', `绑定表不该再有 palette 档：${b.command}`)
  }
})

test('面板每行可执行：参数只能由别的界面给的命令不进面板（机器接口不受 hidden 影响）', () => {
  // 面板裸按一条带必选参数的命令只会得到「未处理」——一条永远点不动的行比没有更糟。
  // 这些命令的参数由抽屉／选择器／搜索／机器接口提供；它们的 UI 各有自己的入口命令。
  const families = [/^core\.props\//, /^core\.mount\//, /^core\.belongs-to\//, /^core\.query\/(set-spec|create)$/]
  const named = [
    'core.page/open', 'core.surface/open', 'core.block/restore', 'core.block/set-type',
    'core.editor/insert-tag', 'core.tags/add', 'core.tags/remove',
    'core.embed/from-atom', 'core.embed/set-view',
    'core.view/set-active', 'core.view/remove', 'core.view/rename', 'core.view/set-sort',
    'core.view/set-columns', 'core.view/set-cover', 'core.view/set-tabs-direction',
    'core.view/set-group', 'core.view/set-filter', 'core.view/new-row', 'core.view/delete-row',
  ]
  for (const c of visible) {
    assert.ok(!families.some((re) => re.test(c.name)), `${c.name} 属于配置/机器面，面板不该列`)
    assert.ok(!named.includes(c.name), `${c.name} 带必选参数、无收集路径，面板不该列`)
  }
  // 留在面板里的带参命令必须有「无参也有结果」的路径（光标回落／选择器／默认值）
  for (const name of ['core.block/focus-block', 'core.block/move-to', 'core.embed/insert', 'core.view/add', 'core.query/insert', 'core.view/menu']) {
    assert.ok(visible.some((c) => c.name === name), `${name} 无参可执行，应留在面板兜底`)
  }
})

test('斜杠只收「这里有什么」：折叠/删除不进斜杠，露面/复制/选标签在', () => {
  const slash = BINDINGS.filter((b) => b.kind === 'slash')
  const cmds = slash.map((b) => b.command)
  assert.ok(!cmds.includes('core.editor/toggle-collapse'), '折叠是视图状态（⌘. 在），不回答「这里有什么」')
  assert.ok(!cmds.includes('core.editor/delete-block'), '删除是块骨架操作（⌘⇧D/⌫ 在），不回答「这里有什么」')
  assert.ok(
    !slash.some((b) => b.command === 'core.editor/insert-block' && b.args === undefined),
    '正文块档（无参 insert-block）与 ↵ 同果，不许悄悄加回来；待办/分割线两档不受此限',
  )
  for (const need of ['core.embed/insert', 'core.editor/duplicate-block', 'core.editor/pick-tag']) {
    assert.ok(cmds.includes(need), `${need} 应在斜杠`)
  }
  assert.deepEqual(
    [...new Set(slash.map((b) => b.group))].sort(),
    ['slash/1-structure', 'slash/2-inline'],
    '斜杠分组只有「结构/行内」两轴',
  )
})

test('块菜单：删除同位、复制/插入收子菜单、组标题人人有份', () => {
  const menu = BINDINGS.filter((b) => b.kind === 'menu' && (b.group ?? '').startsWith('block/'))
  const deleteGroup = menu.filter((b) => b.group === 'block/6-delete').map((b) => b.command)
  for (const need of ['core.editor/delete-block', 'core.journal/delete', 'core.page/delete', 'core.tag/delete']) {
    assert.ok(deleteGroup.includes(need), `${need} 应住在删除组：危险动作位置恒定`)
  }
  const anchors = BINDINGS.filter((b) => b.command === 'core.menu/sub').map((b) => JSON.stringify(b.args))
  assert.deepEqual(
    [...anchors].sort(),
    [JSON.stringify({ prefix: 'blockCopy/' }), JSON.stringify({ prefix: 'blockInsert/' })],
    '复制/插入两套行只从子菜单锚点进来',
  )
  // 组标题必须人人有份：裸 id 露给用户就是「打不开的引用」（视图组曾整个组没有标题）
  for (const b of menu) {
    const g = b.group ?? ''
    assert.ok(g === '' || groupTitle(g) !== g, `分组 ${g} 缺标题，裸 id 不该露给用户`)
  }
})
