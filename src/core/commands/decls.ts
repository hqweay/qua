/**
 * 命令表—— **纯语义**：`name` / `title` / `args` / `capability` / `undoable` / `version`。
 *
 * ⚠️ 命令**完全不知道 UI**：这里没有 `key`、没有 `context`、没有 `host`。
 * 键位／菜单／斜杠／工具栏／命令面板全都是**绑定表**（`core/bindings.ts`）的渲染结果（59 ）。
 * 命令面板列的是**本表的全部命令**，与有没有键位无关（59 ）。
 */
import type { CommandDecl } from '../ports.ts'
// ⚠️ 三个收敛点之一：命令表的 `title` / `category` / `keywords` **一律走 t**
import { t } from '../msg.ts'


/* ---------------------------------------------------------- 命令表本体 */

export const COMMANDS: CommandDecl[] = [
  /* ---- 编辑器 · 结构 ---- */
  { name: 'core.editor/split-block', title: t('cmd.editor.split-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true, keywords: ['enter', t('menu.kw.enter')] },
  { name: 'core.editor/backspace', title: t('cmd.editor.backspace'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/select-all', title: t('cmd.editor.select-all'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), keywords: ['select all', 'cmd+a'] },
  { name: 'core.editor/indent-block', title: t('cmd.editor.indent-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['tab', t('menu.kw.indent')] },
  { name: 'core.editor/outdent-block', title: t('cmd.editor.outdent-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['shift tab', t('menu.kw.outdent')] },
  { name: 'core.editor/move-block-up', title: t('cmd.editor.move-block-up'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor') },
  { name: 'core.editor/move-block-down', title: t('cmd.editor.move-block-down'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor') },
  { name: 'core.editor/toggle-collapse', title: t('cmd.editor.toggle-collapse'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['fold', 'collapse'] },
  // 点导轨段走这条（点线 ≠ 点三角——线折**直接子块**，三角折**自己**）
  { name: 'core.editor/toggle-children-collapse', title: t('cmd.editor.toggle-children-collapse'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['fold', 'collapse', 'children'] },
  { name: 'core.editor/duplicate-block', title: t('cmd.editor.duplicate-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['duplicate', 'clone'] },
  { name: 'core.editor/delete-block', title: t('cmd.editor.delete-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['delete', 'remove'] },
  { name: 'core.editor/toggle-todo', title: t('cmd.editor.toggle-todo'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['todo', 'check', 'checkbox'] },
  { name: 'core.editor/insert-block', title: t('cmd.editor.insert-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { type: { type: 'string' }, text: { type: 'string' } }, keywords: ['insert', 'new block'] },
  { name: 'core.editor/clear-block', title: t('cmd.editor.clear-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor') },
  { name: 'core.editor/insert-tag', title: t('cmd.editor.insert-tag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { tag: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag')] },
  { name: 'core.editor/pick-tag', title: t('cmd.editor.pick-tag'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.inline'), keywords: ['tag', 'autocomplete', t('menu.kw.tag')] },
  { name: 'core.editor/copy-ref', title: t('cmd.editor.copy-ref'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), keywords: ['ref', 'quote', t('menu.kw.ref')] },
  { name: 'core.editor/delete-selected-blocks', title: t('cmd.editor.delete-selected-blocks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/copy-selected-blocks', title: t('cmd.editor.copy-selected-blocks'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/copy-selected-block-refs', title: t('cmd.editor.copy-selected-block-refs'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.selection/clear', title: t('cmd.selection.clear'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/select-all-blocks', title: t('cmd.selection.select-all-blocks'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/focus-first', title: t('cmd.selection.focus-first'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/extend-up', title: t('cmd.selection.extend-up'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/extend-down', title: t('cmd.selection.extend-down'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },

  /* ---- 行内原子 ---- */
  { name: 'core.editor/insert-page-ref', title: t('cmd.editor.insert-page-ref'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { pageId: { type: 'string' } }, keywords: ['ref', 'link', t('menu.kw.ref'), 'chip'], expose: { http: { description: t('menu.expose.insertPageRef') } } },
  { name: 'core.editor/insert-image', title: t('cmd.editor.insert-image'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { preset: { type: 'string', enum: ['ready', 'missing'] } }, keywords: ['image', 'asset', t('menu.kw.image')] },
  { name: 'core.editor/remove-atom', title: t('cmd.editor.remove-atom'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' } }, keywords: ['remove atom'], hidden: true },

  /* ---- 区间格式（锚点，不是 run 属性） ---- */
  { name: 'core.anno/toggle-bold', title: t('cmd.anno.toggle-bold'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['bold', 'strong', 'b'] },
  { name: 'core.anno/toggle-italic', title: t('cmd.anno.toggle-italic'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['italic', 'em', 'i'] },
  { name: 'core.anno/toggle-highlight', title: t('cmd.anno.toggle-highlight'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['highlight', 'mark', t('menu.kw.background')] },
  { name: 'core.anno/toggle-code', title: t('cmd.anno.toggle-code'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['code', 'mono'] },
  { name: 'core.anno/clear-marks', title: t('cmd.anno.clear-marks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['clear', 'plain'] },

  /* ---- 标签层级（属于 / 包含：一条边，两个读法） ---- */
  { name: 'core.tags/add', title: t('cmd.tags.add'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, name: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag')] },
  { name: 'core.tags/remove', title: t('cmd.tags.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, tagId: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag'), 'remove'] },
  { name: 'core.tags/add-parent', title: t('cmd.tags.add-parent'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' }, parentId: { type: 'string' } } },
  { name: 'core.tags/remove-parent', title: t('cmd.tags.remove-parent'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' }, parentId: { type: 'string' } } },
  { name: 'core.tags/prune-parents', title: t('cmd.tags.prune-parents'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' } } },

  /* ---- 属性（属性是块第一公民；值在块上 props[propId]） ---- */
  { name: 'core.props/set-value', title: t('cmd.props.set-value'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' }, value: {} } },
  { name: 'core.props/clear-value', title: t('cmd.props.clear-value'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } } },
  { name: 'core.props/create-def', title: t('cmd.props.create-def'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' } } },
  { name: 'core.props/add-field', title: t('cmd.props.add-field'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } } },
  { name: 'core.props/undeclare', title: t('cmd.props.undeclare'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } } },

  /* ---- 历史 ---- */
  { name: 'core.history/undo', title: t('cmd.history.undo'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.history') },
  { name: 'core.history/redo', title: t('cmd.history.redo'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.history') },
  // 导航历史（中心槽走到哪）；与上面的模型快照栈是两件事
  { name: 'core.history/back', title: t('cmd.history.back'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.history'), keywords: ['back', 'history', 'navigate'] },
  { name: 'core.history/forward', title: t('cmd.history.forward'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.history'), keywords: ['forward', 'history', 'navigate'] },

  /* ---- 页面 ---- */
  { name: 'core.page/new', title: t('cmd.page.new'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/open', title: t('cmd.page.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page'), args: { pageId: { type: 'string' } } },
  { name: 'core.page/next', title: t('cmd.page.next'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/prev', title: t('cmd.page.prev'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/rename', title: t('cmd.page.rename'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/delete', title: t('cmd.page.delete'), capability: 'admin', undoable: false, version: '1.0', category: t('menu.cat.page'), keywords: ['delete page'] },

  /* ---- 日记（今日是落点，不是特例；：日期只读、一天一个） ---- */
  { name: 'core.journal/today', title: t('cmd.journal.today'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), args: { date: { type: 'string' } }, keywords: ['journal', 'today', 'daily'] },
  { name: 'core.journal/prev', title: t('cmd.journal.prev'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), keywords: ['journal', 'prev', 'yesterday'] },
  { name: 'core.journal/next', title: t('cmd.journal.next'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), keywords: ['journal', 'next', 'tomorrow'] },

  /* ---- zoom（zoom 是视图配置，不是新对象，也不引入焦点栈） ---- */
  { name: 'core.block/focus-block', title: t('cmd.block.focus-block'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' } }, keywords: ['zoom', 'focus', t('menu.kw.zoom')] },
  { name: 'core.block/zoom-out', title: t('cmd.block.zoom-out'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['zoom', 'out', 'back'] },

  /* ---- 角色（加/减一个机制位，不是破坏性转换） ---- */
  { name: 'core.block/as-page', title: t('cmd.block.as-page'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.page'), args: { blockId: { type: 'string' } }, keywords: ['page', 'role'] },
  { name: 'core.block/unpage', title: t('cmd.block.unpage'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.page'), args: { blockId: { type: 'string' } }, keywords: ['page', 'role', 'remove'] },
  { name: 'core.block/as-tag', title: t('cmd.block.as-tag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['tag', 'role'] },
  { name: 'core.block/untag', title: t('cmd.block.untag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['tag', 'role', 'remove'] },
  { name: 'core.block/edit-aliases', title: t('cmd.block.edit-aliases'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['alias', 'name', 'list'] },
  { name: 'core.block/edit-fields', title: t('cmd.block.edit-fields'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['field', 'schema', 'declared'] },
  { name: 'core.block/set-type', title: t('cmd.block.set-type'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, type: { type: 'string' } }, keywords: ['type', 'convert'] },

  /* ---- 视图 ---- */
  { name: 'core.view/toggle-theme', title: t('cmd.view.toggle-theme'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dark', 'light', 'theme'] },
  { name: 'core.view/set-theme', title: t('cmd.view.set-theme'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { mode: { type: 'string', enum: ['system', 'light', 'dark'] } }, keywords: ['dark', 'light', 'theme'] },
  { name: 'core.view/toggle-rail', title: t('cmd.view.toggle-rail'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'left'] },
  { name: 'core.dock/toggle-left', title: t('cmd.dock.toggle-left'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'left', 'panel'] },
  { name: 'core.dock/toggle-right', title: t('cmd.dock.toggle-right'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'right', 'panel'] },
  { name: 'core.view/toggle-virtualize', title: t('cmd.view.toggle-virtualize'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { on: { type: 'boolean' }, radius: { type: 'integer' } }, keywords: ['virtual', 'window', 'DOM'] },

  /* ---- 浮层 ---- */
  { name: 'core.command-palette/show', title: t('cmd.command-palette.show'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), keywords: ['palette', 'command', t('menu.kw.command')] },
  { name: 'core.menu/block', title: t('cmd.menu.block'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), args: { blockId: { type: 'string' } } },
  { name: 'core.menu/slash', title: t('cmd.menu.slash'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer') },
  { name: 'core.layer/close', title: t('cmd.layer.close'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), hidden: true },

  /* ---- 诊断（59  / ） ---- */
  { name: 'core/context-keys/inspect', title: t('cmd.context-keys.inspect'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag'), expose: { cli: { aliases: ['ctx'] } } },
  { name: 'core/bindings/list', title: t('cmd.bindings.list'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag'), expose: { cli: { aliases: ['kb help'] } } },
  { name: 'core/help/shortcuts', title: t('cmd.help.shortcuts'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag') },
  { name: 'core/debug/dump-model', title: t('cmd.debug.dump-model'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag') },

  /* ---- 演示（demo 专用，不在真实产品里） ---- */
  { name: 'core.demo/load-state', title: t('cmd.demo.load-state'), capability: 'admin', undoable: false, version: '0.1', category: t('menu.cat.demo'), args: { state: { type: 'string', enum: ['seed', 'empty', 'sparse', 'degraded'] } } },
  { name: 'core.demo/simulate-ime', title: t('cmd.demo.simulate-ime'), capability: 'read', undoable: false, version: '0.1', category: t('menu.cat.demo') },
  { name: 'core.demo/reset-all', title: t('cmd.demo.reset-all'), capability: 'admin', undoable: false, version: '0.1', category: t('menu.cat.demo') },
]

export const DECL_BY_NAME: Map<string, CommandDecl> = new Map(COMMANDS.map((c) => [c.name, c]))
