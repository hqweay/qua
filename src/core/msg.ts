/**
 * 文案字典（§2）—— **id → 文案的扁平映射**。
 *
 * 三条纪律（由 `scripts/arch-check.mjs` 的断言 11 兜住）：
 *   1. **一切用户可见文案走 `t()`**：命令 `title`／绑定表 `label`＋`keywords`／UI 组件／错误提示；
 *   2. **应用名也是文案**（`app.name` ＝ 中文「相」），不得硬编码 —— renderer 与 Electron 主进程共用这一份；
 *   3. 源码里**不许再有裸中文字面量**（白名单：注释、本文件、`seed.ts` 假数据、`console.*` 日志）。
 *
 * 为什么是「id 索引的扁平表」而不是 `t('中文原文')`：将来加语言＝加一份字典，不是全库翻（承 59 ）。
 * v1 只有 zh ——但 id 从第一天就在。
 *
 * 参数用 `{name}` 占位：`t('ui.atom.pageTitle', { label: '产品设计' })`。
 * 本文件是**零依赖叶子**（不 import 任何东西）⇒ 任何层都可以 import 它（含 Electron 主进程）。
 */

export const MSG = {
  /* ---------------------------------------------------------------- 应用名 */
  'app.name': '相',
  'app.title': '相 · 块级大纲笔记',

  /* -------------------------------------------------------- 命令 title（cmd.*） */
  'cmd.editor.split-block': '拆分块',
  'cmd.editor.backspace': '退格：合并到上一块',
  'cmd.editor.select-all': '全选（这一屏的块）',
  'cmd.editor.indent-block': '缩进',
  'cmd.editor.outdent-block': '取消缩进',
  'cmd.editor.move-block-up': '块上移',
  'cmd.editor.move-block-down': '块下移',
  'cmd.editor.toggle-collapse': '折叠 / 展开',
  'cmd.editor.duplicate-block': '复制块',
  'cmd.editor.delete-block': '删除块',
  'cmd.editor.toggle-todo': '切换待办',
  'cmd.editor.insert-block': '在下方插入块',
  'cmd.editor.clear-block': '清空本块',
  'cmd.editor.insert-tag': '插入标签 #',
  'cmd.editor.copy-ref': '复制本块的引用（引文快照）',
  'cmd.editor.delete-selected-blocks': '删除选中的块',
  'cmd.editor.copy-selected-blocks': '复制选中的块（大纲文本）',
  'cmd.editor.copy-selected-block-refs': '复制选中块的引用',
  'cmd.selection.clear': '取消块选择',
  'cmd.selection.select-all-blocks': '全选块',
  'cmd.selection.focus-first': '取消块选择并定位到首个选中块',
  'cmd.selection.extend-up': '向上扩展块选择',
  'cmd.selection.extend-down': '向下扩展块选择',
  'cmd.editor.insert-page-ref': '插入引用 [[页面]]',
  'cmd.editor.insert-image': '插入图片（资产占位）',
  'cmd.editor.remove-atom': '删除行内原子',
  'cmd.anno.toggle-bold': '加粗',
  'cmd.anno.toggle-italic': '斜体',
  'cmd.anno.toggle-highlight': '高亮',
  'cmd.anno.toggle-code': '行内代码',
  'cmd.anno.clear-marks': '清除格式',
  'cmd.history.undo': '撤销',
  'cmd.history.redo': '重做',
  'cmd.page.new': '新建页面',
  'cmd.page.open': '打开页面',
  'cmd.page.next': '下一页',
  'cmd.page.prev': '上一页',
  'cmd.page.rename': '重命名当前页面',
  'cmd.page.delete': '删除当前页面',

  /* ---- 日记 ---- */
  'cmd.journal.today': '回到今日',
  'cmd.journal.prev': '前一天',
  'cmd.journal.next': '后一天',
  'cmd.view.toggle-theme': '亮 / 暗切换',
  'cmd.view.set-theme': '设定主题档位（跟随系统 / 亮 / 暗）',
  'cmd.view.toggle-rail': '收起 / 展开左栏',
  'cmd.dock.toggle-left': '收起 / 展开左槽',
  'cmd.dock.toggle-right': '收起 / 展开右槽',
  'ui.dock.leftTitle': '左槽',
  'ui.dock.rightTitle': '右槽',
  'ui.dock.collapseLeft': '收起左槽',
  'ui.dock.collapseRight': '收起右槽',
  'ui.dock.empty': '这个槽里还没有块',
  'ui.dock.favorites': '收藏',
  'ui.dock.noFavorites': '还没有收藏。在块的菜单里选「加入收藏」。',
  'ui.dock.containerEmpty': '这个收藏夹还是空的',
  'ui.backlinks.title': '反向链接',
  'ui.backlinks.count': '{count} 条',
  'ui.backlinks.refresh': '刷新',
  'ui.query.untitled': '未命名查询',
  'ui.query.count': '{count} 条结果',
  'ui.query.refresh': '刷新',
  'ui.query.refreshed': '已刷新：{count} 条',
  'ui.query.refreshFailed': '刷新失败：{message}（已保留上次结果）',
  'ui.query.stale': '结果可能已过期',
  'ui.query.dropped': '有 {count} 条已不再匹配，已从结果中移除',
  'ui.query.noSpec': '这个查询还没有条件',
  'ui.query.empty': '没有匹配的块',
  'ui.dock.untitledContainer': '未命名收藏夹',
  'ui.dock.removeFavorite': '移出收藏',
  'ui.favorites.defaultName': '收藏',
  'ui.dock.today': '今日',
  'ui.dock.backRefs': '反链',
  'ui.dock.noBackRefs': '还没有块指向这里',
  'cmd.view.toggle-virtualize': '虚拟化窗口开关',
  'cmd.command-palette.show': '命令面板',
  'cmd.menu.block': '块菜单',
  'cmd.menu.slash': '斜杠菜单',
  'cmd.layer.close': '关闭浮层',
  'cmd.context-keys.inspect': '检查上下文键',
  'cmd.bindings.list': '列出绑定表',
  'cmd.help.shortcuts': '键盘速查',
  'cmd.debug.dump-model': '导出当前页模型 JSON',
  'cmd.demo.load-state': '载入演示状态',
  'cmd.demo.simulate-ime': '模拟 IME 组合期按键（守卫自检）',
  'cmd.demo.reset-all': '清空 localStorage 并还原假数据',

  /* -------------------------------------------------- 命令分组 category（menu.*） */
  'menu.cat.editor': '编辑器',
  'menu.cat.inline': '行内原子',
  'menu.cat.format': '格式',
  'menu.cat.history': '历史',
  'menu.cat.page': '页面',
  'menu.cat.journal': '日记',
  'menu.cat.view': '视图',
  'menu.cat.layer': '浮层',
  'menu.cat.diag': '诊断',
  'menu.cat.demo': '演示',

  /* --------------------------------------- 菜单 / 斜杠 / 划选气泡 分组标题 */
  'menu.group.basic': '基础',
  'menu.group.structure': '结构',
  'menu.group.blockKind': '块类型',
  'menu.group.inline': '行内',
  'menu.group.mark': '格式',
  'menu.group.inlineAtom': '行内原子',
  'menu.group.block': '块',
  'menu.group.ref': '引用',

  /* ------------------------------------------------- 绑定表 label（menu.label.*） */
  'menu.label.toggleCollapse': '折叠 / 展开',
  'menu.label.paragraph': '正文块',
  'menu.label.todo': '待办',
  'menu.label.pageRef': '引用页面（行内原子）',
  'menu.label.image': '图片（资产占位）',
  'menu.label.tag': '标签',
  'menu.label.duplicate': '复制块',
  'menu.label.delete': '删除块',
  'menu.label.bold': '加粗',
  'menu.label.italic': '斜体',
  'menu.label.highlight': '高亮',
  'menu.label.code': '行内代码',
  'menu.label.clearMarks': '清除格式',
  'menu.label.insertRef': '插入引用',
  'menu.label.insertImage': '插入图片',
  'menu.label.fold': '折叠',
  'menu.label.copyRef': '复制带引文的引用',

  /* -------------------------------------------- 绑定表 keywords（搜索别名） */
  'menu.kw.enter': '回车',
  'menu.kw.indent': '缩进',
  'menu.kw.outdent': '反缩进',
  'menu.kw.delete': '删除',
  'menu.kw.tag': '标签',
  'menu.kw.ref': '引用',
  'menu.kw.image': '图片',
  'menu.kw.background': '背景',
  'menu.kw.command': '命令',
  'menu.kw.paragraph': '正文',

  /* ---------------------------------------------------------------- 浮层标题 */
  'menu.title.palette': '命令面板 · 一切命令可搜、可无绑定执行',
  'menu.title.palettePlain': '命令面板',
  'menu.title.block': '块菜单',
  'menu.title.blockSel': '块选择',
  'menu.title.slash': '斜杠命令',
  'menu.title.slashFilter': '斜杠命令 · 继续打字可过滤',
  'menu.title.refPicker': '选择要引用的页面',
  'menu.title.stateMenu': '演示状态（同一份代码的四个形态）',
  'menu.title.debugMenu': '调试（正式软件不暴露）',
  'menu.group.debugLook': '外观',
  'menu.group.debugTheme': '主题',
  'menu.group.debugState': '演示状态',

  /* ------------------------------------------------------------ 命令 expose 描述 */
  'menu.expose.insertPageRef': '在光标处插入一条指向页面的行内引用',

  /* --------------------------------------------------------------- 错误（err.*） */
  'err.when.unclosedString': 'when: 未闭合的字符串 @{i}',
  'err.when.unclosedRegex': 'when: 未闭合的正则 @{i}',
  'err.when.badChar': 'when: 无法识别的字符 {ch} @{i}',
  'err.when.trailing': 'when: 表达式尾部有多余内容',
  'err.when.missingParen': 'when: 缺少 )',
  'err.when.missingBracket': 'when: 缺少 ]',
  'err.when.unexpectedToken': 'when: 意外的记号 {token}',
  'err.when.false': 'when 为假',
  'err.cmd.notRegistered': '未注册的命令：{name}',
  'err.cmd.failed': '命令失败：{name}｜{message}',
  'err.clipboardFailed': '复制失败（浏览器未授权剪贴板）',

  /* ------------------------------------------------------------ 通用小词 */
  'ui.common.none': '（无）',
  'ui.common.nothing': '无',
  'ui.common.always': '（总是）',
  'ui.page.untitled': '无标题',

  /* ---------------------------------------------------------------- 左栏 / 顶栏 */
  'ui.rail.title': '我的库',
  'ui.rail.newPageTitle': '新建页面',
  'ui.state.title': '演示状态：空态 / 稀疏态 / 降级态',
  'ui.debug.title': '调试：主题 / 演示状态（正式软件不暴露）',
  'ui.debug.button': '调试',
  'ui.theme.toggle': '亮/暗切换',
  'ui.theme.title': '{toggle}（当前：{mode}）',
  'ui.state.button': '演示状态',
  'ui.theme.mode.system': '跟随系统',
  'ui.theme.mode.light': '亮',
  'ui.theme.mode.dark': '暗',

  /* ---------------------------------------------------------------- 空态提示 */
  'ui.emptyHint': '按 <kbd>/</kbd> 呼出斜杠命令 · <kbd>⌘P</kbd> 打开命令面板 · <kbd>⌘B</kbd> 给选区加粗',

  /* ---------------------------------------------------------------- 角标 */
  'ui.badge.blocks': '块 <b>{blocks}</b>',
  'ui.badge.dom': '· DOM <b>{dom}</b>',
  'ui.badge.theme': '· 主题 <b>{theme}</b>',
  'ui.badge.composing': '· composing <b>{composing}</b>',
  'ui.badge.title': '块数 {blocks}｜DOM 块 {domBlocks}｜DOM 节点 {domNodes}｜挂载窗口 {mounted}｜虚拟化 {virtualize}（点击看上下文键与按键命中）',

  /* ------------------------------------------------------------ 角标：诊断面板 */
  'ui.panel.sectionState': '<h5>状态</h5><div class="kv">{rows}</div>',
  'ui.panel.sectionCtx': '<h5>上下文键（when 求值用的那套键）</h5><div class="kv">{rows}</div>',
  'ui.panel.sectionTrace': '<h5>按键命中追踪（最近 6 次）</h5>',
  'ui.panel.traceEmpty': '<div class="hit">按几个键试试（追踪是默认开着的）</div>',
  'ui.panel.traceMiss': '未命中',
  'ui.panel.blocks': '块数（模型）',
  'ui.panel.dom': 'DOM 块 / DOM 节点',
  'ui.panel.virtualize': '虚拟化',
  'ui.panel.virtualizeOn': 'on（r={radius}）',
  'ui.panel.virtualizeOff': 'off',
  'ui.panel.mountedSuffix': '｜挂载窗口 {mounted}',
  'ui.panel.theme': '主题',
  'ui.panel.composing': 'composing（IME 组合中）',
  'ui.panel.compositionSeq': '组合序列',
  'ui.panel.selection': '选区（模型持有）',
  'ui.panel.marks': '区间锚点 marks',
  'ui.panel.atomsSuffix': '｜原子 atoms {atoms}',
  'ui.panel.undoDepth': 'undo / redo 栈深',
  'ui.panel.lastCommand': '最近命令',
  'ui.panel.lastCommandValue': '{name}（{via}）',
  'ui.panel.page': '页面',
  'ui.panel.pageValue': '{title}（{count} 页）',

  /* ---------------------------------------------------------------- 搜索框 */
  'ui.search.placeholder': '搜索…',
  'ui.search.empty': '没有匹配项',
  'ui.palette.placeholder': '输入命令名、中文标题或别名…',
  'ui.palette.empty': '没有匹配的命令',
  'ui.slash.empty': '没有匹配的斜杠命令',
  'ui.refPicker.empty': '没有页面',
  'ui.refPicker.blocks': '{count} 块',

  /* ---------------------------------------------------------------- 块（view） */
  'ui.block.foldExpand': '展开（点击）',
  'ui.block.foldCollapse': '折叠（点击）',
  'ui.block.foldLine': '折叠 / 展开子块（点击）',
  'cmd.editor.toggle-children-collapse': '折叠 / 展开子块',
  'ui.block.focusHint': '点击聚焦到此块 · 拖动移动 · 右键打开菜单',
  'ui.block.menuHint': '右键打开块菜单',
  'ui.block.handleHint': '拖拽重排 · 右键打开块菜单',
  'ui.block.placeholderFirst': '写点什么…（按 / 呼出命令）',
  'ui.block.placeholderEmpty': '空块',
  'ui.todo.toggle': '点击切换完成',
  'ui.atom.unknown': '未知原子',
  'ui.atom.pageTitle': '引用：{label}（点击看信息）',
  'ui.atom.tagTitle': '标签：#{label}（点击看信息）',
  'ui.atom.imageTitle': '图片：{label}（点击看资产信息）',
  'ui.virt.placeholder': '⋯ 窗口外 {count} 行（虚拟化，未挂 DOM）',

  /* ---------------------------------------------------------------- 信息气泡 */
  'ui.popover.refTitle': '行内引用 · {label}',
  'ui.popover.imageTitle': '图片原子 · {label}',
  'ui.popover.atomId': '原子 id',
  'ui.popover.target': '目标实体',
  'ui.popover.targetMissing': '（不存在）',
  'ui.popover.state': '状态',
  'ui.popover.position': '位置',
  'ui.popover.quote': '引文快照',
  'ui.popover.danglingNote': '目标不存在：状态是 dangling，不是静默错指。',
  'ui.popover.refNote': '引用指向实体 id，编辑只改锚点区间。',
  'ui.popover.openPage': '打开页面',
  'ui.popover.deleteRef': '删除这个引用',
  'ui.popover.assetHash': '资产 hash（内容寻址）',
  'ui.popover.size': '尺寸',
  'ui.popover.mimeBytes': 'mime / 字节',
  'ui.popover.assetMissingNote': '资产不可用是状态不是错误：占位 ＋ 明确报告，等本地 BlobStore / 其它设备拉取。',
  'ui.popover.assetNote': '行内图片 ＝ 行内原子 ＋ 资产引用；字节不入 SQLite，走内容寻址。',
  'ui.popover.deleteImage': '删除这个图片原子',

  /* ------------------------------------------------------------------ 抽屉 */
  'ui.drawer.contextTitle': '检查上下文键 · Inspect Context Keys',
  'ui.drawer.contextIntro':
    '`when` 只读这套键。带 ◆ 的是被绑定表引用到的键；插件可用 acme.* 前缀扩展（core.* 保留）。',
  'ui.drawer.contextTableHead': '<tr><th>键</th><th>值</th><th>被哪些绑定引用</th></tr>',
  'ui.drawer.contextSnapshot': '当前求值快照（共 {commands} 条命令 / {bindings} 条绑定）',
  'ui.drawer.bindingsTitle': '绑定表 · 一个机制五处复用',
  'ui.drawer.bindingsIntro1': '命令表 {commands} 条（不知道 UI）；绑定表 {bindings} 条（挂载点）。',
  'ui.drawer.bindingsIntro2':
    '菜单 / 斜杠 / 工具栏 / 命令面板都是下面这张表的渲染结果，不是手写组件。绑定表不进 HTTP/MCP/CLI 面。',
  'ui.drawer.bindingsTableHead': '<tr><th>键/分组</th><th>命令</th><th>when</th><th>层</th></tr>',
  'ui.drawer.shortcutsTitle': '键盘速查（键位只是加速器；命令面板才是兜底）',
  'ui.drawer.shortcutsTableHead': '<tr><th>键</th><th>命令</th><th>when</th></tr>',
  'ui.drawer.shortcutsNote1': '打字键一个都没绑',
  'ui.drawer.shortcutsNote2': '未绑定的键 ⇒ 文本输入。组合期（composing=true）所有键位绑定自动不命中。',
  'ui.drawer.modelTitle': '当前页模型 JSON（块树 ＋ 区间锚点 ＋ 行内原子）',
  'ui.drawer.modelNote':
    '这一坨就是唯一事实源：DOM 只是它的表现。命令面板里搜「导出」可以看它，搜「上下文键」看 when 的键空间。',

  /* ---------------------------------------------------------------- 演示状态 */
  'ui.state.seed': '假数据库',
  'ui.state.empty': '空态',
  'ui.state.sparse': '稀疏态',
  'ui.state.degraded': '降级态',
  'ui.stateMenu.seed': '假数据库（还原）',
  'ui.stateMenu.seedHint': '5 页 · 嵌套 4 层',
  'ui.stateMenu.degradedHint': '超长块 / 全英文 / 超长标题 / 无标题',
  'ui.stateMenu.sparseHint': '只有 1 个块',
  'ui.stateMenu.emptyHint': '什么都没写',

  /* ------------------------------------------------------------ 启动 / 持久化告警 */
  'ui.boot.tooNew': '本地库版本（v{version}）比当前应用新，已进入只读演示模式：不会写入或覆盖你的数据。请升级应用后再打开。',
  'ui.boot.corrupt': '本地库无法读取（数据损坏），已进入只读演示模式：不会写入或覆盖你的数据。请先用开发者工具备份 localStorage。',
  'ui.boot.storageError': '无法访问本地存储，已进入只读演示模式：本次改动不会保存。',
  'ui.boot.expired': '本地库是旧版本（v{version}），已载入新的演示数据。',
  'ui.boot.saveFailed': '保存失败：{message}。本次改动没有写入本地存储。',

  /* ---------------------------------------------------------------- toast */
  'ui.toast.blockDuplicated': '已复制块（含子树，**新 id**）',
  'ui.toast.blockDeleted': '已删除块',
  'ui.toast.pageDeleted': '已删除页面',
  'ui.toast.keepOnePage': '至少留一页',
  'ui.toast.journalReadonly': '日记的日期是只读的（要改只能删了重建）',
  'ui.toast.refCopied': '已复制引用（实体 id ＋ 引文快照 exact/prefix/suffix）',
  'ui.toast.blocksCopied': '已复制选中的块（大纲文本）',
  'ui.toast.blockRefsCopied': '已复制选中块的引用',
  'ui.toast.imeProbe': '组合期触发命令 {fired} 次（应为 0）｜序列 {seq}',
  'ui.toast.resetAll': '已清空本地存储并还原假数据',
  'ui.toast.copied': '已复制',
  'ui.toast.stateLoaded': '已载入：{state}',
  'ui.toast.virtOn': '虚拟化 on（窗口半径 {radius} 行）：DOM 节点数会小于块数',
  'ui.toast.virtOff': '虚拟化 off：全部块都挂 DOM',
  'ui.toast.atomsLost': '行内原子失效：{labels}（引用目标被删掉了）',
  'ui.toast.tagAdded': '已打标签 #{tag}',
  'ui.toast.tagCreated': '新建标签 #{tag} 并打上',
  'ui.toast.tagEmpty': '标签名是空的',

  /* ------------------------------------------------------ 演示数据的小文案（假数据） */
  'ui.arg.defaultTag': '标签',
  'ui.arg.demoTag': '灵感',
  'ui.demo.assetMissingName': '丢失的截图.png',
  'ui.demo.assetReadyName': '架构草图.png',

  /* ---------------------------------------------------------------- Electron 菜单（menu.*） */
  'menu.bar.file': '文件',
  'menu.bar.edit': '编辑',
  'menu.bar.view': '视图',
  'menu.bar.window': '窗口',
  'menu.item.about': '关于 {app}',
  'menu.item.services': '服务',
  'menu.item.hide': '隐藏 {app}',
  'menu.item.hideOthers': '隐藏其他',
  'menu.item.showAll': '全部显示',
  'menu.item.quit': '退出 {app}',
  'menu.item.closeWindow': '关闭窗口',
  'menu.item.undo': '撤销',
  'menu.item.redo': '重做',
  'menu.item.cut': '剪切',
  'menu.item.copy': '拷贝',
  'menu.item.paste': '粘贴',
  'menu.item.pasteAndMatchStyle': '粘贴并匹配样式',
  'menu.item.delete': '删除',
  'menu.item.selectAll': '全选',
  'menu.item.reload': '重新加载',
  'menu.item.forceReload': '强制重新加载',
  'menu.item.devTools': '开发者工具',
  'menu.item.actualSize': '实际大小',
  'cmd.block.focus-block': '聚焦到此块（zoom in）',
  'cmd.block.zoom-out': '退回顶层',
  'ui.toast.favorited': '已加入收藏',
  'ui.toast.alreadyFavorited': '已经在收藏里了',
  'menu.kw.zoom': '聚焦',
  'menu.kw.favorite': '收藏',
  'cmd.favorites.add': '加入收藏',
  'cmd.favorites.remove': '移出收藏',
  'cmd.favorites.move': '调整收藏顺序',
  'cmd.favorites.new-container': '新建收藏夹',
  'menu.item.zoomIn': '放大',
  'menu.item.zoomOut': '缩小',
  'menu.item.fullscreen': '进入全屏幕',
  'menu.item.minimize': '最小化',
  'menu.item.zoom': '缩放',
  'menu.item.front': '前置全部窗口',
} as const

/** 回调 id 就是 MSG 的键 —— 写错一个 id 会在 `pnpm typecheck` 阶段就红 */
export type MsgId = keyof typeof MSG

export type MsgParams = Record<string, string | number>

/**
 * 取文案。`{name}` 占位按 `params` 替换（没给到的占位原样留着，便于当场看出漏参数）。
 * 找不到 id 时返回 id 本身：兜底不抛（`MsgId` 联合类型已经挡在最前面）。
 */
export function t(id: MsgId, params?: MsgParams): string {
  const s = (MSG as Record<string, string>)[id] ?? id
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m))
}
