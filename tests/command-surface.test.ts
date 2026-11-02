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

test('绑定表只有四个渲染面（keymap/menu/slash/selection），面板枚举命令表不经绑定表', () => {
  for (const b of BINDINGS) {
    assert.ok(b.kind !== 'palette', `绑定表不该再有 palette 档：${b.command}`)
  }
})
