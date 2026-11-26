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

test('⌘K 唯一归属全局搜索：编辑器态也不让路，插链接没有键位', () => {
  // ⌘K 必须是「任何时刻都开搜索」：一键两义（编辑器态让给插链接）会让打字路径上的
  // ⌘K 读作「有时搜索有时插链接」，肌肉记忆立不住——插链接的入口在斜杠菜单与块菜单。
  const onK = BINDINGS.filter((b) => b.kind === 'keymap' && b.key === 'mod+k')
  assert.deepEqual(onK.map((b) => b.command), ['core.search/open'], '⌘K 上只能有全局搜索这一条键位')
  assert.equal(onK[0].when, '', '全局搜索的 ⌘K 必须无条件可用（编辑器态不让路）')
  const linkKeys = BINDINGS.filter((b) => b.command === 'core.editor/insert-link' && b.kind === 'keymap')
  assert.deepEqual(linkKeys, [], '插链接不占键位：入口是斜杠菜单与块菜单')
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
  assert.ok(!cmds.includes('core.block/delete'), '删除是块骨架操作（⌘⇧D/⌫ 在），不回答「这里有什么」')
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
  // 删除只有一条：页/标签/日记/字段定义/内容块共用它。按身份分四行会让兼位块
  // （页＋标签）出现两行做同一件事，而两行守卫答案还不一样
  assert.deepEqual(deleteGroup, ['core.block/delete'], '删除组只有一行：准入按「此刻能不能删」，不按身份')
  const anchors = BINDINGS.filter((b) => b.kind === 'menu' && b.submenu !== undefined)
    .map((b) => `${b.submenu}:${b.actsOn ?? 'editor'}`)
  assert.deepEqual(
    [...anchors].sort(),
    ['blockCopy/:block', 'blockInsert/:editor', 'blockKind/:block', 'codeLang/:block'],
    '子菜单行只从锚点进来（子菜单是行数据，不是命令）',
  )
  // 「我的自动化…」是 basic 组的任务 hub：动态行由命令打开（菜单 opener 需要目标，面板不裸列）
  const hub = menu.find((b) => b.command === 'core.automation/menu')
  assert.ok(hub, '块菜单要有「我的自动化…」入口')
  assert.equal(hub!.group, 'block/1-basic', '它是 basic 组的任务 hub，不是新语义组')
  assert.equal(hub!.when, 'blockMenuTarget')
  assert.ok(COMMANDS.find((c) => c.name === 'core.automation/menu')?.hidden, '菜单 opener 需要目标，面板不裸列')
  assert.ok(COMMANDS.find((c) => c.name === 'core.automation/pin')?.hidden, '固定命令由身体调用，面板不裸列')
  // 「有目标块」不是「编辑器有焦点」：块菜单行只读 blockMenuTarget，记录面才借得到同一张表
  for (const b of menu) {
    assert.ok(!(b.when ?? '').includes('blockFocused'), `${b.submenu ?? b.command} 仍读 blockFocused`)
  }
  // 组标题必须人人有份：裸 id 露给用户就是「打不开的引用」（视图组曾整个组没有标题）
  for (const b of menu) {
    const g = b.group ?? ''
    assert.ok(g === '' || groupTitle(g) !== g, `分组 ${g} 缺标题，裸 id 不该露给用户`)
  }
})

test('多选菜单：删除压轴分节，不占首行（与单块菜单同一条判据）', () => {
  const sel = BINDINGS.filter((b) => b.kind === 'menu' && (b.group ?? '').startsWith('blockSel/'))
  const del = sel.filter((b) => b.command === 'core.editor/delete-selected-blocks')
  assert.equal(del.length, 1, '删除选中的块应恰有一行')
  assert.equal(del[0]!.group, 'blockSel/2-delete', '删除应住压轴删除组：危险动作位置恒定（单块菜单同判据）')
  assert.equal(groupTitle('blockSel/2-delete'), '删除', '删除组要带标题分节，裸 id 不该露给用户')
  // 首行给高频无害动作：删除不许悄悄挪回最前（误触概率最高的位置留给它自己）
  const sorted = [...sel].sort(
    (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (a.order ?? 100) - (b.order ?? 100),
  )
  assert.notEqual(sorted[0]!.command, 'core.editor/delete-selected-blocks', '删除不许占多选菜单首行')
  // 取消选择无害，必须留在删除上方（组序 2-clear < 2-delete 兜住）
  const clearIdx = sorted.findIndex((b) => b.command === 'core.selection/clear')
  assert.ok(clearIdx >= 0 && clearIdx < sorted.length - 1, '取消选择应在删除之上')
})

/**
 * **同一个键的多条绑定：谁赢由声明顺序决定，而顺序是反的。**
 *
 * `resolveKey` 排完层序后**反向遍历**，第一条 `when` 成立的胜出 ⇒ **后声明者优先**。
 * 这个方向反直觉（读代码从上往下看，会以为先声明先赢），本仓为此真红过一次：
 * `select-block` 声明在 `axis-down` 之前，注释还写着「放在退档之前 ⇒ 宽屏里 Esc 第一义
 * 仍是退一档」——而反向遍历让**后**声明的 `axis-down` 才优先，注释说的顺序是反的。
 * 后果不是「顺序不对」，是**宽屏里退一个档位要按三次 Esc**。
 *
 * 所以：同一键上多于一條时，顺序是**承重的**，不能靠读代码时的心算。
 */
test('同键多绑定的优先级＝声明顺序的倒序：恒真那条最前（兜底），Esc 四层按外层意图排列', () => {
  const km = BINDINGS.filter((b) => b.kind === 'keymap' && b.key)
  const byKey = new Map<string, typeof km>()
  for (const b of km) {
    const list = byKey.get(b.key!) ?? []
    list.push(b)
    byKey.set(b.key!, list)
  }
  /**
   * ① **恒真（`when: ''`）的那条必须在本键的最前声明**——它是**兜底**。
   *
   *    反向遍历 ⇒ 最先声明的最后被求值。恒真那条排在最后声明的位置，就等于
   *    抢在所有更具体的绑定之前：它后面那些 `when` 写得再准也没机会求值，
   *    表现为「某个键在某些状态下失灵」，而失灵的那条永远查不到（它根本没被求值）。
   *    反过来，它排在最前 ⇒ 只在没有任何更具体的绑定命中时才轮到它，正是兜底该有的位置。
   */
  for (const [key, list] of byKey) {
    const always = list.findIndex((b) => (b.when ?? '') === '')
    assert.ok(
      always === -1 || always === 0,
      `键 ${key} 上恒真（when: ''）的绑定必须最前声明（它是兜底；排在后面会抢在更具体的绑定之前）：${JSON.stringify(list.map((b) => ({ cmd: b.command, when: b.when })))}`,
    )
  }

  /**
   * ② **Esc 的四层语义按这个顺序**（后声明者优先 ⇒ 从下往上读）：
   *    退档 ＞ 选中当前块 ＞ 清块选区 ＞ 关浮层。
   *
   *    判据是**意图的外层程度**：离开一个档位是比「取消一次选区」更外层的动作，
   *    所以 `axis-down` 必须压轴、且它的 `when` **不许**再挂 `!blockSelection`
   *    （挂了就等于让清选区反过来压过退档，用户要按两次才离开一个档位）。
   *    这条断言钉的是**顺序与 when 的组合**，不是某一条绑定长什么样——
   *    想改 Esc 的语义，改完这里必须跟着改，改不动就说明你在无意中改语义。
   */
  const esc = (byKey.get('escape') ?? []).map((b) => b.command)
  assert.deepEqual(
    esc,
    ['core.layer/close', 'core.selection/clear', 'core.selection/select-block', 'core.view/axis-down'],
    `Esc 的四层按「外层意图优先」排列（反向遍历 ⇒ 数组末尾最优先）：${JSON.stringify(esc)}`,
  )
  const axisDown = (byKey.get('escape') ?? []).find((b) => b.command === 'core.view/axis-down')
  assert.ok(
    !(axisDown?.when ?? '').includes('blockSelection'),
    `退档的 when 不许挂 blockSelection：挂了就等于让「清选区」压过「退档」，宽屏里要按两次才出去`,
  )
})
