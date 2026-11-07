/**
 * 命令表—— **纯语义**：`name` / `title` / `args` / `capability` / `undoable` / `version`。
 *
 * ⚠️ 命令**完全不知道 UI**：这里没有 `key`、没有 `context`、没有 `host`。
 * 键位／菜单／斜杠／工具栏／命令面板全都是**绑定表**（`core/bindings.ts`）的渲染结果。
 * 命令面板列的是**本表的全部命令**，与有没有键位无关。
 */
import type { CommandDecl } from '../infra/ports.ts'
// ⚠️ 三个收敛点之一：命令表的 `title` / `category` / `keywords` **一律走 t**
import { t } from '../infra/msg.ts'


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
  { name: 'core.editor/toggle-children-collapse', title: t('cmd.editor.toggle-children-collapse'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { blockId: { type: 'string' } }, keywords: ['fold', 'collapse', 'children'] },
  { name: 'core.editor/duplicate-block', title: t('cmd.editor.duplicate-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['duplicate', 'clone'] },
  { name: 'core.editor/delete-block', title: t('cmd.editor.delete-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['delete', 'remove'] },
  { name: 'core.editor/toggle-todo', title: t('cmd.editor.toggle-todo'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['todo', 'check', 'checkbox'] },
  /**
   * 「切换待办」的**反向**：那个只在 `true`／`false` 之间翻，永远摘不掉这一栏。
   *
   * 这一条摘的是**这一块自己的那一栏**（值 ＋ 自有槽，见 `core/props.ts` 的 `clearValue`），
   * 所以它才是「斜杠菜单转成待办」的真正逆操作 —— 不加这条，用户把一个块变成任务之后
   * 就没有任何入口把它变回去（属性面板里的 × 藏得太深，且要先知道去哪找）。
   *
   * ⚠️ 打了「声明这一栏」的标签的块，摘完仍会显示成未完成 —— 那是标签给的，不是这一块的。
   *    调用方（handler）据此给一句解释，而不是静默。
   */
  { name: 'core.editor/clear-todo', title: t('cmd.editor.clear-todo'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), keywords: ['todo', 'untodo', t('menu.kw.untodo')] },
  { name: 'core.editor/insert-block', title: t('cmd.editor.insert-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { type: { type: 'string', enum: ['paragraph', 'todo', 'divider'] }, text: { type: 'string' } }, keywords: ['insert', 'new block'] },
  { name: 'core.editor/clear-block', title: t('cmd.editor.clear-block'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor') },
  { name: 'core.editor/insert-tag', title: t('cmd.editor.insert-tag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { tag: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag')] },
  { name: 'core.editor/pick-tag', title: t('cmd.editor.pick-tag'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.inline'), keywords: ['tag', 'autocomplete', t('menu.kw.tag')] },
  { name: 'core.editor/copy-ref', title: t('cmd.editor.copy-ref'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), keywords: ['ref', 'quote', t('menu.kw.ref')] },
  { name: 'core.editor/copy-block-ref', title: t('cmd.editor.copy-block-ref'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), args: { blockId: { type: 'string' } }, keywords: ['ref', 'copy', 'embed'] },
  { name: 'core.editor/delete-selected-blocks', title: t('cmd.editor.delete-selected-blocks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/indent-selected-blocks', title: t('cmd.editor.indent-selected-blocks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/outdent-selected-blocks', title: t('cmd.editor.outdent-selected-blocks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/toggle-todo-selected-blocks', title: t('cmd.editor.toggle-todo-selected-blocks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/copy-selected-blocks', title: t('cmd.editor.copy-selected-blocks'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.editor/copy-selected-block-refs', title: t('cmd.editor.copy-selected-block-refs'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.editor'), hidden: true },
  { name: 'core.selection/clear', title: t('cmd.selection.clear'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/select-all-blocks', title: t('cmd.selection.select-all-blocks'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/focus-first', title: t('cmd.selection.focus-first'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/extend-up', title: t('cmd.selection.extend-up'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.selection/extend-down', title: t('cmd.selection.extend-down'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },

  /* ---- 行内原子 ---- */
  { name: 'core.editor/insert-page-ref', title: t('cmd.editor.insert-page-ref'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { pageId: { type: 'string' } }, keywords: ['ref', 'link', t('menu.kw.ref'), 'chip'], expose: { http: { description: t('menu.expose.insertPageRef') } } },
  // `preset` 只是验收/演示用的旁路（`ready` / `missing`）；不传 ⇒ 选一张真图入库
  { name: 'core.editor/insert-image', title: t('cmd.editor.insert-image'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { preset: { type: 'string', enum: ['ready', 'missing'] } }, keywords: ['image', 'asset', t('menu.kw.image')] },
  // 外链：`url` 必填（协议白名单在 `core/link.ts`）、`text` 是这个链接显示的字（省略 ⇒ 显示地址）
  { name: 'core.editor/insert-link', title: t('cmd.editor.insert-link'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { url: { type: 'string' }, text: { type: 'string' } }, keywords: ['link', 'url', t('menu.kw.link')], expose: { http: { description: t('menu.expose.insertLink') } } },
  // 打开一枚外链：点与 ⌥ 浮层的「打开」共用这一条（`atomId` ⇒ 去正文里读它此刻的 url）
  { name: 'core.link/open', title: t('cmd.link.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' } }, keywords: ['link', 'open', t('menu.kw.link')], hidden: true },
  { name: 'core.editor/remove-atom', title: t('cmd.editor.remove-atom'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' } }, keywords: ['remove atom'], hidden: true },
  { name: 'core.editor/repair-ref', title: t('cmd.editor.repair-ref'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' } }, keywords: ['repair', 'dangling', t('menu.kw.ref')], hidden: true },
  /**
   * 锚文本（这一处引用显示什么）：写空串 ＝ 删掉这个键 ⇒ 回到「跟随目标现算」。
   * 入口只有 ⌥ 浮层那一个输入框，所以不进命令面板（与 `remove-atom` 同一条口径）。
   */
  { name: 'core.editor/set-anchor', title: t('cmd.editor.set-anchor'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' }, text: { type: 'string' } }, keywords: ['anchor', 'alias', t('menu.kw.ref')], hidden: true },
  { name: 'core.editor/set-link', title: t('cmd.editor.set-link'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' } }, keywords: ['link', 'url', 'edit', t('menu.kw.link')], hidden: true },
  { name: 'core.editor/atom-to-text', title: t('cmd.editor.atom-to-text'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { atomId: { type: 'string' } }, keywords: ['unlink', 'text', t('menu.kw.ref')], hidden: true },

  /* ---- 行内格式（run 上的属性） ---- */
  { name: 'core.anno/toggle-bold', title: t('cmd.anno.toggle-bold'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['bold', 'strong', 'b'] },
  { name: 'core.anno/toggle-italic', title: t('cmd.anno.toggle-italic'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['italic', 'em', 'i'] },
  { name: 'core.anno/toggle-highlight', title: t('cmd.anno.toggle-highlight'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['highlight', 'mark', t('menu.kw.background')] },
  { name: 'core.anno/toggle-code', title: t('cmd.anno.toggle-code'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['code', 'mono'] },
  { name: 'core.anno/clear-marks', title: t('cmd.anno.clear-marks'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.format'), keywords: ['clear', 'plain'] },

  /* ---- 标签层级（属于 / 包含：一条边，两个读法） ---- */
  { name: 'core.tags/add', title: t('cmd.tags.add'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, name: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag')] },
  { name: 'core.tags/remove', title: t('cmd.tags.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, tagId: { type: 'string' } }, keywords: ['tag', t('menu.kw.tag'), 'remove'] },
  { name: 'core.belongs-to/add', title: t('cmd.belongs.add'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' }, parentId: { type: 'string' } } },
  { name: 'core.belongs-to/remove', title: t('cmd.belongs.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' }, parentId: { type: 'string' } } },
  { name: 'core.belongs-to/prune', title: t('cmd.belongs.prune'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { childId: { type: 'string' } } },

  /* ---- 属性（属性是块第一公民；值在块上 props[propId]） ---- */
  { name: 'core.props/set-value', title: t('cmd.props.set-value'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' }, value: {} } },
  { name: 'core.props/clear-value', title: t('cmd.props.clear-value'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } } },
  { name: 'core.props/create-def', title: t('cmd.props.create-def'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' }, target: { type: 'string', description: 'own = this block\u2019s own value slot; declared = declared to members' }, mode: { type: 'string', enum: ['reuse', 'new'], description: 'reuse an existing same-name definition, or create a second one' } } },
  { name: 'core.props/add-field', title: t('cmd.props.add-field'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' }, target: { type: 'string', description: 'own = this block\u2019s own value slot; declared = declared to members' } } },
  /* ---- 选项（select）：选项是定义块的直接子块，值存选项块 id ---- */
  { name: 'core.props/add-choice', title: t('cmd.props.add-choice'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { defId: { type: 'string' }, label: { type: 'string' }, scope: {} }, keywords: ['choice', 'option', 'select'] },
  { name: 'core.props/set-choice-label', title: t('cmd.props.set-choice-label'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { choiceId: { type: 'string' }, label: { type: 'string' } }, keywords: ['choice', 'option', 'rename'] },
  { name: 'core.props/move-choice', title: t('cmd.props.move-choice'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { defId: { type: 'string' }, choiceId: { type: 'string' }, beforeId: { type: 'string' } }, keywords: ['choice', 'option', 'reorder', 'move'] },
  { name: 'core.props/set-choice-scope', title: t('cmd.props.set-choice-scope'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { choiceId: { type: 'string' }, scope: {} }, keywords: ['choice', 'option', 'scope', 'tag'] },
  { name: 'core.props/set-choice-icon', title: t('cmd.props.set-choice-icon'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { choiceId: { type: 'string' }, icon: { type: 'string' } }, keywords: ['choice', 'option', 'icon'] },
  { name: 'core.props/set-choice-check', title: t('cmd.props.set-choice-check'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { defId: { type: 'string' }, on: { type: 'string' }, off: { type: 'string' }, status: { type: 'boolean' } }, keywords: ['choice', 'option', 'checkbox', 'done', 'task'] },
  { name: 'core.props/set-choice-cardinality', title: t('cmd.props.set-choice-cardinality'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { defId: { type: 'string' }, cardinality: { type: 'string' } }, keywords: ['choice', 'option', 'multi', 'cardinality'] },
  { name: 'core.props/set-ui-position', title: t('cmd.props.set-ui-position'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { defId: { type: 'string' }, position: { type: 'string' } }, keywords: ['property', 'gutter', 'position'] },
  { name: 'core.props/delete-choice', title: t('cmd.props.delete-choice'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { choiceId: { type: 'string' } }, keywords: ['choice', 'option', 'delete'] },
  /* ---- 块底的挂载区（tab 是一格数据，不是块）；自成一档类别，标题不再靠前缀说明自己 ---- */
  { name: 'core.mount/add-local', title: t('cmd.mount.add-local'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.mount'), args: { host: {}, label: { type: 'string' }, spec: {}, view: { type: 'string' }, views: {}, id: { type: 'string' } }, keywords: ['mount', t('menu.cat.mount'), 'query', 'tab', 'panel', 'local'] },
  { name: 'core.mount/remove', title: t('cmd.mount.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.mount'), args: { host: {}, tabId: { type: 'string' } }, keywords: ['mount', t('menu.cat.mount'), 'query', 'tab', 'remove'] },
  { name: 'core.mount/rename', title: t('cmd.mount.rename'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.mount'), args: { host: {}, tabId: { type: 'string' }, label: { type: 'string' } }, keywords: ['mount', t('menu.cat.mount'), 'tab', 'rename'] },
  { name: 'core.mount/move', title: t('cmd.mount.move'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.mount'), args: { host: {}, tabId: { type: 'string' }, targetId: { type: 'string' }, place: { type: 'string' } }, keywords: ['mount', t('menu.cat.mount'), 'tab', 'order', 'move', 'drag'] },
  { name: 'core.mount/set-view', title: t('cmd.mount.set-view'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.mount'), args: { host: {}, tabId: { type: 'string' }, view: { type: 'string' } }, keywords: ['mount', t('menu.cat.mount'), 'tab', 'view'] },
  { name: 'core.props/undeclare', title: t('cmd.props.undeclare'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } } },

  /* ---- 历史 ---- */
  { name: 'core.history/undo', title: t('cmd.history.undo'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.history') },
  { name: 'core.history/redo', title: t('cmd.history.redo'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.history') },
  // 导航历史（中心槽走到哪）；与上面的撤销栈是两件事
  { name: 'core.history/back', title: t('cmd.history.back'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.history'), keywords: ['back', 'history', 'navigate'] },
  { name: 'core.history/forward', title: t('cmd.history.forward'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.history'), keywords: ['forward', 'history', 'navigate'] },

  /* ---- tab（一个 tab 一份保存的视图） ---- */
  { name: 'core.tab/new', title: t('cmd.tab.new'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['tab', 'new'] },
  { name: 'core.tab/close', title: t('cmd.tab.close'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['tab', 'close'] },
  { name: 'core.tab/next', title: t('cmd.tab.next'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['tab', 'next'] },
  { name: 'core.tab/prev', title: t('cmd.tab.prev'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['tab', 'prev'] },
  // 表面 tab：把一张派生面/工具面放进中心（按 kind 去重；终点面，关闭即回）
  { name: 'core.surface/open', title: t('cmd.surface.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { kind: { type: 'string', enum: ['derived', 'utility'] }, id: { type: 'string' } }, keywords: ['surface', 'panel', 'trash', t('menu.kw.surface')] },

  /* ---- 页面 ---- */
  { name: 'core.page/new', title: t('cmd.page.new'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.page'), tile: { icon: 'lucide:plus' } },
  { name: 'core.page/open', title: t('cmd.page.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page'), args: { pageId: { type: 'string' } } },
  { name: 'core.page/next', title: t('cmd.page.next'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/prev', title: t('cmd.page.prev'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/rename', title: t('cmd.page.rename'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.page') },
  { name: 'core.page/delete', title: t('cmd.page.delete'), capability: 'admin', undoable: false, version: '1.0', category: t('menu.cat.page'), keywords: ['delete page'] },

  /* ---- 日记（今日是落点，不是特例；：日期只读、一天一个） ---- */
  { name: 'core.journal/today', title: t('cmd.journal.today'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), args: { date: { type: 'string' } }, keywords: ['journal', 'today', 'daily'], tile: { icon: 'lucide:calendar' } },
  { name: 'core.journal/open', title: t('cmd.journal.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), hidden: true, args: { date: { type: 'string' }, place: { type: 'string', enum: ['center', 'dock', 'tab', 'inspect'] } }, keywords: ['journal', 'date', 'open', 'dock', 'tab'] },
  { name: 'core.journal/prev', title: t('cmd.journal.prev'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), keywords: ['journal', 'prev', 'yesterday'], tile: { icon: 'lucide:chevron-left' } },
  { name: 'core.journal/next', title: t('cmd.journal.next'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), keywords: ['journal', 'next', 'tomorrow'] },
  { name: 'core.journal/review', title: t('cmd.journal.review'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.journal'), args: { days: { type: 'number' } }, keywords: ['review', 'retro', 'days'] },
  { name: 'core.journal/feed-layout', title: t('cmd.journal.feed-layout'), capability: 'write', undoable: false, version: '1.0', category: t('menu.cat.journal'), args: { layout: { type: 'string' } }, keywords: ['layout', 'feed', 'column', 'row'] },
  { name: 'core.journal/delete', title: t('cmd.journal.delete'), capability: 'admin', undoable: false, version: '1.0', category: t('menu.cat.journal'), args: { blockId: { type: 'string' } }, keywords: ['journal', 'delete', 'day'] },

  /* ---- zoom（zoom 是视图配置，不是新对象，也不引入焦点栈） ---- */
  { name: 'core.block/focus-block', title: t('cmd.block.focus-block'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' }, feed: { type: 'boolean' }, restore: { type: 'boolean' }, newTab: { type: 'boolean' } }, keywords: ['zoom', 'focus', t('menu.kw.zoom')] },
  { name: 'core.block/inspect', title: t('cmd.block.inspect'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, propId: { type: 'string' } }, keywords: ['props', 'property', 'inspect'] },
  { name: 'core.block/zoom-out', title: t('cmd.block.zoom-out'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['zoom', 'out', 'back'] },
  { name: 'core.block/move-to', title: t('cmd.block.move-to'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { blockId: { type: 'string' }, targetId: { type: 'string' } }, keywords: ['move', 'move to', t('menu.kw.move')] },
  { name: 'core.block/restore', title: t('cmd.block.restore'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.editor'), args: { blockId: { type: 'string' } }, keywords: ['restore', 'undelete', 'trash', t('menu.kw.trash')] },

  /* ---- 角色（加/减一个机制位，不是破坏性转换） ---- */
  { name: 'core.block/as-page', title: t('cmd.block.as-page'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.page'), args: { blockId: { type: 'string' } }, keywords: ['page', 'role'] },
  { name: 'core.block/unpage', title: t('cmd.block.unpage'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.page'), args: { blockId: { type: 'string' } }, keywords: ['page', 'role', 'remove'] },
  { name: 'core.block/extract-to-page', title: t('cmd.block.extract-to-page'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.page'), args: { blockId: { type: 'string' } }, keywords: ['extract', 'page', 'root'] },
  { name: 'core.block/as-tag', title: t('cmd.block.as-tag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['tag', 'role'] },
  { name: 'core.block/untag', title: t('cmd.block.untag'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['tag', 'role', 'remove'] },
  { name: 'core.tag/delete', title: t('cmd.tag.delete'), capability: 'admin', undoable: false, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['tag', 'delete', 'remove'] },
  { name: 'core.block/edit-aliases', title: t('cmd.block.edit-aliases'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' } }, keywords: ['alias', 'name', 'list'] },
  { name: 'core.block/set-type', title: t('cmd.block.set-type'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.props'), args: { blockId: { type: 'string' }, type: { type: 'string' } }, keywords: ['type', 'convert'] },
  /**
   * 把一处纯文本提及换成一枚指向目标块的引用（`start`/`end` 是 plain 偏移区间）。
   * 入口只有提及栏片段行上的高亮按钮（与 `set-anchor` 同一条口径：不进命令面板）。
   */
  { name: 'core.block/convert-mention', title: t('cmd.block.convert-mention'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), args: { blockId: { type: 'string' }, to: { type: 'string' }, start: { type: 'integer' }, end: { type: 'integer' } }, keywords: ['mention', 'ref', t('menu.kw.ref')], hidden: true },
  /**
   * 划选气泡的「转为引用」：选中一段文本，换成指向同名块的引用。
   * 同名地址不存在 ⇒ 顺手建一个页块（与 `@` 的「新建页」同一条创建路径）。
   * 只在单块纯文本选区上有定义 ⇒ 不进命令面板（面板没有选区可给）。
   */
  { name: 'core.editor/selection-to-ref', title: t('cmd.editor.selection-to-ref'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.inline'), keywords: ['ref', 'convert', t('menu.kw.ref')], hidden: true },

  /* ---- 视图 ---- */
  { name: 'core.view/toggle-theme', title: t('cmd.view.toggle-theme'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dark', 'light', 'theme'] },
  { name: 'core.view/set-theme', title: t('cmd.view.set-theme'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { mode: { type: 'string', enum: ['system', 'light', 'dark'] } }, keywords: ['dark', 'light', 'theme'] },
  { name: 'core.dock/toggle-left', title: t('cmd.dock.toggle-left'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'left', 'panel'] },
  { name: 'core.dock/toggle-right', title: t('cmd.dock.toggle-right'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'right', 'panel'] },
  // 档位轴：进/退一档（宽屏＝双槽收起＋阅读宽度放开；全屏＝再藏抬头与 tab 条）。
  // 档位只住窗口：不写偏好、不跨会话。进/退是键盘的两条；「全屏打开」这类
  // 一步到位的入口还要一条直选（进/退两条走不到的语义）。
  { name: 'core.view/axis-up', title: t('cmd.view.axisUp'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['wide', 'fullscreen', 'focus', t('menu.kw.wide'), t('menu.kw.fullscreen')] },
  { name: 'core.view/axis-down', title: t('cmd.view.axisDown'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true },
  { name: 'core.view/axis-to', title: t('cmd.view.axisTo'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), hidden: true, args: { mode: { type: 'string', enum: ['wide', 'full'] } } },
  { name: 'core.dock/open-block', title: t('cmd.dock.open-block'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' }, side: { type: 'string' } }, keywords: ['dock', 'open', 'window', 'sidebar'] },
  { name: 'core.dock/top-window', title: t('cmd.dock.topWindow'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['dock', 'pin', 'top', 'window', 'sidebar'] },
  { name: 'core.view/toggle-virtualize', title: t('cmd.view.toggle-virtualize'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { on: { type: 'boolean' }, radius: { type: 'integer' } }, keywords: ['virtual', 'window', 'DOM'] },

  /* ---- 视图配置（块怎么看：表格/看板/…；大纲 ＝ 没有激活视图） ---- */
  { name: 'core.view/add', title: t('cmd.view.add'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, kind: { type: 'string' } }, keywords: ['view', t('menu.kw.views'), 'table', 'cards', 'board', 'gallery', 'calendar'] },
  { name: 'core.view/set-active', title: t('cmd.view.set-active'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' } }, keywords: ['view', t('menu.kw.views'), 'outline', 'switch'] },
  { name: 'core.view/remove', title: t('cmd.view.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' } }, keywords: ['view', t('menu.kw.views'), 'remove', 'delete'] },
  { name: 'core.view/rename', title: t('cmd.view.rename'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, name: { type: 'string' } }, keywords: ['view', t('menu.kw.views'), 'rename'] },
  { name: 'core.view/set-sort', title: t('cmd.view.set-sort'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' }, by: { type: 'string' }, dir: { type: 'string' } }, keywords: ['sort', 'order', 'column'] },
  { name: 'core.view/set-cover', title: t('cmd.view.set-cover'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' }, cover: { type: 'string' } }, keywords: ['cover', 'image', 'card'] },
  { name: 'core.view/set-group', title: t('cmd.view.set-group'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' }, groupBy: { type: 'string' }, groupOrder: {} }, keywords: ['group', 'board', 'column'] },
  { name: 'core.view/set-filter', title: t('cmd.view.set-filter'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, viewId: { type: 'string' }, filter: {} }, keywords: ['view', 'filter', 'slice', 'condition', 'where'] },
  { name: 'core.view/new-row', title: t('cmd.view.new-row'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, blockId: { type: 'string' } }, keywords: ['row', 'insert', 'new'] },
  { name: 'core.view/delete-row', title: t('cmd.view.delete-row'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { rowId: { type: 'string' } }, keywords: ['row', 'delete', 'trash'] },
  { name: 'core.view/menu', title: t('cmd.view.menu'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { owner: {} }, keywords: ['view', 'menu', 'table'] },
  { name: 'core.query/set-spec', title: t('cmd.query.set-spec'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { owner: {}, spec: {} }, keywords: ['query', t('menu.kw.query'), 'condition', 'where', 'filter'] },
  { name: 'core.query/open-builder', title: t('cmd.query.open-builder'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), args: { owner: {} }, keywords: ['query', t('menu.kw.query'), 'builder', 'condition', 'filter'] },
  { name: 'core.query/create', title: t('cmd.query.create'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { name: { type: 'string' }, spec: {}, parentId: { type: 'string' } }, keywords: ['query', t('menu.kw.query'), 'block', 'new'] },
  { name: 'core.query/insert', title: t('cmd.query.insert'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' } }, keywords: ['query', t('menu.kw.query'), 'filter', 'insert', 'where'] },

  /* ---- 露面（镜像／投影：同一块在别处再出现一次） ---- */
  { name: 'core.embed/insert', title: t('cmd.embed.insert'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' }, targetId: { type: 'string' }, view: { type: 'string', enum: ['mirror', 'table'] } }, keywords: ['embed', t('menu.kw.embed'), 'mirror', 'reference', 'view'] },
  { name: 'core.embed/from-atom', title: t('cmd.embed.from-atom'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { atomId: { type: 'string' }, view: { type: 'string', enum: ['mirror', 'table'] } }, keywords: ['expand', 'embed', t('menu.kw.embed'), 'mirror'] },
  { name: 'core.embed/remove', title: t('cmd.embed.remove'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' } }, keywords: ['embed', t('menu.kw.embed'), 'remove', 'unlink'] },
  /** 「粘贴为」的两档是菜单里的预设参数档，不是用户直达动作 ⇒ 面板不列；面板只列子菜单锚点 */
  { name: 'core.embed/paste', title: t('cmd.embed.paste'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), hidden: true, args: { blockId: { type: 'string' }, targetId: { type: 'string' }, view: { type: 'string', enum: ['mirror', 'table'] } }, keywords: ['paste', 'embed', t('menu.kw.embed'), 'mirror'] },
  { name: 'core.embed/paste-menu', title: t('cmd.embed.paste-menu'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['paste', 'embed', t('menu.kw.embed'), 'mirror'] },
  { name: 'core.embed/set-view', title: t('cmd.embed.set-view'), capability: 'write', undoable: true, version: '1.0', category: t('menu.cat.view'), args: { blockId: { type: 'string' }, view: { type: 'string' } }, keywords: ['embed', 'view', 'mirror', 'table'] },

  /* ---- 浮层 ---- */
  { name: 'core.command-palette/show', title: t('cmd.command-palette.show'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), keywords: ['palette', 'command', t('menu.kw.command')], tile: { icon: 'lucide:compass' } },
  { name: 'core.search/open', title: t('cmd.search.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), keywords: ['search', 'find', 'ctrlp'], tile: { icon: 'lucide:search' } },
  // 设置是工具面：打开入口就是这一条命令（⌘,），可钉成 cmd 卡——不另造第四种入口
  { name: 'core.settings/open', title: t('cmd.settings.open'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.view'), keywords: ['settings', 'preferences', 'keys', 'theme'], tile: { icon: 'lucide:settings' } },
  { name: 'core.menu/block', title: t('cmd.menu.block'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), args: { blockId: { type: 'string' } } },
  { name: 'core.menu/slash', title: t('cmd.menu.slash'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer') },
  { name: 'core.layer/close', title: t('cmd.layer.close'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.layer'), hidden: true },

  /* ---- 诊断（59  / ） ---- */
  { name: 'core/context-keys/inspect', title: t('cmd.context-keys.inspect'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag'), expose: { cli: { aliases: ['ctx'] } } },
  { name: 'core/bindings/list', title: t('cmd.bindings.list'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag'), expose: { cli: { aliases: ['kb help'] } } },
  { name: 'core/help/shortcuts', title: t('cmd.help.shortcuts'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag') },
  { name: 'core/debug/dump-model', title: t('cmd.debug.dump-model'), capability: 'read', undoable: false, version: '1.0', category: t('menu.cat.diag') },

  /* ---- 演示（demo 专用，不在真实产品里） ---- */
  { name: 'dev.fixture/load', title: t('cmd.dev.load-state'), capability: 'admin', undoable: false, version: '0.1', category: t('menu.cat.dev'), args: { state: { type: 'string', enum: ['seed', 'empty', 'sparse', 'degraded'] } } },
  { name: 'dev.ime/simulate', title: t('cmd.dev.simulate-ime'), capability: 'read', undoable: false, version: '0.1', category: t('menu.cat.dev') },
  { name: 'dev.workspace/reset', title: t('cmd.dev.reset-all'), capability: 'admin', undoable: false, version: '0.1', category: t('menu.cat.dev') },
  { name: 'dev.workspace/blank', title: t('cmd.dev.blank'), capability: 'admin', undoable: false, version: '0.1', category: t('menu.cat.dev') },
]

export const DECL_BY_NAME: Map<string, CommandDecl> = new Map(COMMANDS.map((c) => [c.name, c]))
