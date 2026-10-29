/**
 * 绑定表—— **一个机制五处复用**：
 * 键位（keymap）／块菜单（menu）／斜杠（slash）／**划选气泡（selection）**／命令面板（palette）。
 *
 * ⚠️ 菜单/气泡**不是手写组件**，它们只是 `resolveBindings(kind, ctx)` 的渲染结果。
 * ⚠️ 绑定表**不进 HTTP／MCP／CLI 面**——机器接口只认命令与 `expose`。
 *
 * 关于 `selection`：2026-10-19 撤掉顶部工具栏（chrome 极弱＝中性现代的口径），
 * 「加粗/斜体/高亮/代码」这类**作用于选区**的命令改由**划选文本时浮出的气泡**承载——
 * 它们的 `when` 一律带 `!selectionEmpty`，所以光标状态下气泡根本不会出现。
 */
import { evalWhen, evalWhenSafe } from './when.ts'
// ⚠️ 三个收敛点之二：绑定表的 `label` / `keywords` 一律走 t
import { t } from './msg.ts'
import type { CtxKeys } from './index.ts'

export type BindingKind = 'keymap' | 'menu' | 'slash' | 'selection' | 'palette'
export type Layer = 'core' | 'plugin' | 'user'

export interface Binding {
  /** 命令名（`*` 只用于 palette 的「全部命令」） */
  command: string
  kind: BindingKind
  /** 抽象修饰键：`mod` ＝ Cmd(mac) / Ctrl(其它)，渲染按平台 */
  key?: string
  /** 上下文键表达式；空 ＝ 总是匹配 */
  when?: string
  args?: unknown
  /** 菜单/工具栏分组，如 `block/1-basic` */
  group?: string
  order?: number
  layer: Layer
  /** 菜单/斜杠/工具栏的显示名（省略则用命令 title） */
  label?: string
  icon?: string
  keywords?: string[]
}

/* ------------------------------------------------------------ 绑定表 */

export const BINDINGS: Binding[] = [
  /* ================= 键位（打字键不绑：未绑定 ⇒ 文本输入） ================= */
  { command: 'core.editor/split-block', kind: 'keymap', key: 'enter', when: 'editorTextFocus', layer: 'core' },
  // v1 **不做软换行**：Shift+Enter 刻意等同 Enter。
  // 不要改成"插 \n"或直接解绑（后者会让浏览器插 <br>，DOM 文本与模型偏移错位）。
  { command: 'core.editor/split-block', kind: 'keymap', key: 'shift+enter', when: 'editorTextFocus', layer: 'core' },
  // ⌘A **必须接管**：Chrome 在「编辑区含 contenteditable=false 子树」时
  // 原生全选会退化成空选区（把 journal 行标成只读后实测到）⇒ 自己拼跨块 Range
  { command: 'core.editor/select-all', kind: 'keymap', key: 'mod+a', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/backspace', kind: 'keymap', key: 'backspace', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/indent-block', kind: 'keymap', key: 'tab', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/outdent-block', kind: 'keymap', key: 'shift+tab', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/move-block-up', kind: 'keymap', key: 'mod+shift+up', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/move-block-down', kind: 'keymap', key: 'mod+shift+down', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/duplicate-block', kind: 'keymap', key: 'mod+shift+d', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/delete-block', kind: 'keymap', key: 'mod+shift+backspace', when: 'editorTextFocus && !blockIsRoot', layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'keymap', key: 'mod+.', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/toggle-todo', kind: 'keymap', key: 'mod+enter', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/insert-page-ref', kind: 'keymap', key: 'mod+shift+k', when: 'editorTextFocus', layer: 'core' },
  // 外链：⌘K（与「引用 ⌘⇧K」同族，差一个修饰键）；开了输入框之后由浮层接手，不在这里绑第二下
  { command: 'core.editor/insert-link', kind: 'keymap', key: 'mod+k', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.anno/toggle-bold', kind: 'keymap', key: 'mod+b', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-italic', kind: 'keymap', key: 'mod+i', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-highlight', kind: 'keymap', key: 'mod+e', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-code', kind: 'keymap', key: 'mod+`', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/clear-marks', kind: 'keymap', key: 'mod+shift+m', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.history/undo', kind: 'keymap', key: 'mod+z', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.history/redo', kind: 'keymap', key: 'mod+shift+z', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.history/redo', kind: 'keymap', key: 'mod+y', when: 'editorTextFocus', layer: 'core' },
  // 导航前进/后退（中心槽走到哪）：与 undo/redo 的模型快照栈是两套，键也不同
  { command: 'core.history/back', kind: 'keymap', key: 'mod+[', when: 'canGoBack', layer: 'core' },
  { command: 'core.history/forward', kind: 'keymap', key: 'mod+]', when: 'canGoForward', layer: 'core' },
  // `when` 为空 ⇒ 总是可用：命令面板是键盘可达性的兜底
  { command: 'core.command-palette/show', kind: 'keymap', key: 'mod+p', when: '', layer: 'core' },
  { command: 'core.command-palette/show', kind: 'keymap', key: 'mod+shift+p', when: '', layer: 'core' },
  { command: 'core.layer/close', kind: 'keymap', key: 'escape', when: '', layer: 'core' },
  /* ================= 块选区 =================
     ⚠️ 这些必须放在文本绑定**之后**：按键解析是**反向遍历、后出现者优先**。
     块选区激活时（`blockSelection`）它们盖过 Enter/Backspace/Delete/Escape 的文本语义。 */
  { command: 'core.selection/clear', kind: 'keymap', key: 'escape', when: 'blockSelection && !paletteOpen', layer: 'core' },
  { command: 'core.selection/focus-first', kind: 'keymap', key: 'enter', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/delete-selected-blocks', kind: 'keymap', key: 'backspace', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/delete-selected-blocks', kind: 'keymap', key: 'delete', when: 'blockSelection', layer: 'core' },
  { command: 'core.selection/select-all-blocks', kind: 'keymap', key: 'mod+shift+a', when: 'editorTextFocus || blockSelection', layer: 'core' },
  { command: 'core.selection/extend-up', kind: 'keymap', key: 'shift+up', when: 'editorTextFocus || blockSelection', layer: 'core', args: { dir: -1 } },
  { command: 'core.selection/extend-down', kind: 'keymap', key: 'shift+down', when: 'editorTextFocus || blockSelection', layer: 'core', args: { dir: 1 } },
  { command: 'core.menu/slash', kind: 'keymap', key: 'mod+/', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.page/new', kind: 'keymap', key: 'mod+shift+n', when: '', layer: 'core' },
  { command: 'core.view/toggle-theme', kind: 'keymap', key: 'mod+shift+l', when: '', layer: 'core' },
  // 三槽开关：`⌘⌥1` / `⌘⌥2` ——中心槽没有独立快捷键
  { command: 'core.dock/toggle-left', kind: 'keymap', key: 'mod+alt+1', when: '', layer: 'core' },
  { command: 'core.dock/toggle-right', kind: 'keymap', key: 'mod+alt+2', when: '', layer: 'core' },
  // 今日三件：`⌘⇧D` 回今日（**避开编辑器的复制块**：`⌘⇧D` 在编辑器里归 duplicate）
  { command: 'core.journal/today', kind: 'keymap', key: 'mod+shift+d', when: '!editorTextFocus', layer: 'core' },
  // 前后翻日：**仅在 journal 视图且编辑器失焦时**生效的原文口径）
  { command: 'core.journal/prev', kind: 'keymap', key: 'mod+alt+left', when: 'journalView && !editorTextFocus', layer: 'core' },
  { command: 'core.journal/next', kind: 'keymap', key: 'mod+alt+right', when: 'journalView && !editorTextFocus', layer: 'core' },
  // 复盘＝带参的日记流（同 spec 换 days＋排列）：三天 / 本周
  { command: 'core.journal/review', kind: 'keymap', key: 'mod+shift+r', args: { days: 3 }, when: '!editorTextFocus', layer: 'core' },
  { command: 'core.journal/review', kind: 'keymap', key: 'mod+alt+shift+r', args: { days: 7 }, when: '!editorTextFocus', layer: 'core' },
  { command: 'core/bindings/list', kind: 'keymap', key: 'mod+shift+?', when: '', layer: 'core' },
  // 层次序演示：user 层加一条**额外**键位（不改核心口径，只加不改，「用户永远能盖过」）
  { command: 'core.editor/toggle-todo', kind: 'keymap', key: 'mod+shift+t', when: 'editorTextFocus', layer: 'user' },
  { command: 'core.view/toggle-virtualize', kind: 'keymap', key: 'mod+shift+v', when: '', layer: 'user' },

  /* ================= 块菜单（悬停左侧拖动把手 / 圆点或右键） ================= */
  { command: 'core.editor/duplicate-block', kind: 'menu', when: 'blockFocused', group: 'block/1-basic', order: 20, layer: 'core' },
  { command: 'core.editor/delete-block', kind: 'menu', when: 'blockFocused && !blockIsRoot', group: 'block/1-basic', order: 40, layer: 'core', keywords: [t('menu.kw.delete')] },
  { command: 'core.editor/move-block-up', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 10, layer: 'core' },
  { command: 'core.editor/move-block-down', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 20, layer: 'core' },
  { command: 'core.editor/indent-block', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 30, layer: 'core' },
  { command: 'core.editor/outdent-block', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 40, layer: 'core' },
  { command: 'core.editor/toggle-todo', kind: 'menu', when: 'blockFocused', group: 'block/3-kind', order: 10, layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'menu', when: 'blockFocused && blockHasChildren', group: 'block/3-kind', order: 20, layer: 'core', label: t('menu.label.toggleCollapse') },
  // 露面：加/减一格标记（页/标签各自独立、可兼位；顺序无语义）
  { command: 'core.block/as-page', kind: 'menu', when: 'blockFocused && !blockHasPageRole', group: 'block/3-role', order: 10, layer: 'core' },
  { command: 'core.block/unpage', kind: 'menu', when: 'blockFocused && blockHasPageRole', group: 'block/3-role', order: 11, layer: 'core' },
  { command: 'core.block/extract-to-page', kind: 'menu', when: 'blockFocused && blockCanExtractPage', group: 'block/3-role', order: 12, layer: 'core' },
  { command: 'core.block/extract-to-page', kind: 'palette', when: 'blockCanExtractPage', layer: 'core' },
  { command: 'core.block/as-tag', kind: 'menu', when: 'blockFocused && !blockHasTagRole', group: 'block/3-role', order: 20, layer: 'core' },
  { command: 'core.block/untag', kind: 'menu', when: 'blockFocused && blockHasTagRole', group: 'block/3-role', order: 21, layer: 'core' },
  // 别名/字段是「名字层」的配置，不属于任何具体列表：任何聚焦块都能打开
  { command: 'core.block/edit-aliases', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 30, layer: 'core' },
  { command: 'core.block/edit-fields', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 31, layer: 'core' },
  // zoom：进子树的入口挂在块菜单。**叶子块也给**（修订：
  // 块标左键＝聚焦是一贯行为：若叶子不给，点击结果会时 zoom 时不 zoom）
  { command: 'core.block/focus-block', kind: 'menu', when: 'blockFocused', group: 'block/3-kind', order: 30, layer: 'core', keywords: ['zoom', t('menu.kw.zoom')] },
  // 显式入口：把「看这一块的属性」做成一次点击。它是**视图命令**（可以动槽开关），
  // 与 zoom 这种导航动作分家 —— 导航永远不替用户改侧栏的开关。
  { command: 'core.block/inspect', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 32, layer: 'core' },
  { command: 'core.dock/open-block', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 33, layer: 'core' },
  /**
   * 退回上一级：**最外层时不给入口**（`when` 挡住），不是点了没反应。
   *
   * ⚠️ 早先它没有绑定，只在命令面板里裸着一条——面板是「兜底可达性」，
   *    一条永远点不动的命令放在那里，用户只会以为是坏的。
   * ⚠️ 标题也从「退回顶层」改掉了：那个词把**系统架**露给了用户
   *    （用户世界里不该有「顶层」这个概念，根是系统自己的事）。
   */
  { command: 'core.block/zoom-out', kind: 'menu', when: 'blockFocused && !blockIsRoot', group: 'block/3-kind', order: 20, layer: 'core', keywords: ['zoom', 'out', 'back'] },
  /**
   * 移动到…：**显式点名**的重排。与「块上移/下移」不同——那两个只换同级顺序，
   * 这个跨容器。身份块不给入口：它们不参与组织，搬它们没有意义（位置不承载信息）。
   */
  { command: 'core.block/move-to', kind: 'menu', when: 'blockFocused && !blockIsRoot', group: 'block/2-structure', order: 30, layer: 'core' },
  { command: 'core.block/move-to', kind: 'palette', when: 'blockFocused', layer: 'core' },
  { command: 'core.block/zoom-out', kind: 'palette', when: '!blockIsRoot', layer: 'core' },
  { command: 'core.editor/pick-tag', kind: 'menu', when: 'blockFocused', group: 'block/4-inline', order: 5, layer: 'core' },
  { command: 'core.editor/insert-page-ref', kind: 'menu', when: 'blockFocused', group: 'block/4-inline', order: 10, layer: 'core' },
  { command: 'core.editor/insert-image', kind: 'menu', when: 'blockFocused', group: 'block/4-inline', order: 20, layer: 'core' },
  { command: 'core.editor/insert-link', kind: 'menu', when: 'blockFocused', group: 'block/4-inline', order: 25, layer: 'core' },
  { command: 'core.editor/copy-ref', kind: 'menu', when: 'blockFocused', group: 'block/4-inline', order: 30, layer: 'core' },
  { command: 'core.anno/clear-marks', kind: 'menu', when: 'blockFocused && !selectionEmpty', group: 'block/5-mark', order: 50, layer: 'core' },
  /**
   * **视图**（一个块换个看法）：入口只在「有东西可摊开」的块上（查询块 / 有子块 / 已有视图）。
   * 菜单里是**动态**的一份清单（大纲 ＋ 已有视图 ＋ 新建表格），所以只挂一条命令、
   * 由装配层按当前的 `_views` 现画 —— 绑定表是静态的，装不下「每个块不一样」的项。
   */
  { command: 'core.view/menu', kind: 'menu', when: 'blockFocused && blockCanHaveView', group: 'block/6-view', order: 10, layer: 'core', label: t('menu.label.views'), keywords: ['view', 'table', 'grid', t('menu.kw.views')] },

  /* ================= 块选区菜单 ================= */
  { command: 'core.editor/delete-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 10, layer: 'core', keywords: [t('menu.kw.delete')] },
  { command: 'core.editor/copy-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 20, layer: 'core' },
  { command: 'core.editor/copy-selected-block-refs', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 30, layer: 'core', keywords: ['ref', t('menu.kw.ref')] },
  { command: 'core.selection/clear', kind: 'menu', when: 'blockSelection', group: 'blockSel/2-clear', order: 10, layer: 'core' },

  /* ================= 斜杠菜单（输入 `/`） ================= */
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-basic', order: 10, layer: 'core', label: t('menu.label.paragraph'), args: { type: 'paragraph' }, keywords: ['text', 'paragraph', t('menu.kw.paragraph')], icon: 'lucide:pilcrow' },
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-basic', order: 20, layer: 'core', label: t('menu.label.todo'), args: { type: 'todo' }, keywords: ['todo', 'task'], icon: 'lucide:square' },
  // 分割线：没有正文的块，插完光标要落到它下面那一行（见 insertDividerAfter）
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-basic', order: 30, layer: 'core', label: t('menu.label.divider'), args: { type: 'divider' }, keywords: ['divider', 'hr', 'line', t('menu.kw.divider')], icon: 'lucide:minus' },
  // 收藏：正文里是一行摘要（body:'row'），点摘要打开那张卡
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-basic', order: 40, layer: 'core', label: t('menu.label.collection'), args: { type: 'collection' }, keywords: ['collection', 'widget', t('menu.kw.collection')], icon: 'lucide:list-tree' },
  { command: 'core.editor/insert-page-ref', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 10, layer: 'core', label: t('menu.label.pageRef'), keywords: ['ref', 'link', t('menu.kw.ref')], icon: 'lucide:arrow-up-right' },
  // 斜杠菜单的「图片」是**真入口**（选文件）；不带 preset 才走 `App.pickImage()`
  { command: 'core.editor/insert-image', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 20, layer: 'core', label: t('menu.label.image'), keywords: ['image', 'asset', t('menu.kw.image')], icon: 'lucide:image' },
  // 外链：不带 `url` ⇒ 命令打开输入框（`App.showLinkComposer`）；带了 ⇒ 直接插
  { command: 'core.editor/insert-link', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 25, layer: 'core', label: t('menu.label.link'), keywords: ['link', 'url', t('menu.kw.link')], icon: 'lucide:link' },
  { command: 'core.editor/insert-tag', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 30, layer: 'core', label: t('menu.label.tag'), args: { tag: t('ui.arg.demoTag') }, keywords: ['tag', t('menu.kw.tag')], icon: 'lucide:hash' },
  { command: 'core.editor/toggle-collapse', kind: 'slash', when: 'editorTextFocus && blockHasChildren', group: 'slash/3-structure', order: 10, layer: 'core', label: t('menu.label.toggleCollapse'), icon: 'lucide:chevron-down' },
  { command: 'core.editor/duplicate-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/3-structure', order: 20, layer: 'core', label: t('menu.label.duplicate'), icon: 'lucide:copy' },
  { command: 'core.editor/delete-block', kind: 'slash', when: 'editorTextFocus && !blockIsRoot', group: 'slash/3-structure', order: 30, layer: 'core', label: t('menu.label.delete'), icon: 'lucide:trash-2' },

  /* ================= 划选气泡（选中一段文本才浮出；顶部没有工具栏） ================= */
  { command: 'core.anno/toggle-bold', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 10, layer: 'core', icon: 'lucide:bold', label: t('menu.label.bold') },
  { command: 'core.anno/toggle-italic', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 20, layer: 'core', icon: 'lucide:italic', label: t('menu.label.italic') },
  { command: 'core.anno/toggle-highlight', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 30, layer: 'core', icon: 'lucide:highlighter', label: t('menu.label.highlight') },
  { command: 'core.anno/toggle-code', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 40, layer: 'core', icon: 'lucide:code', label: t('menu.label.code') },
  { command: 'core.anno/clear-marks', kind: 'selection', when: 'editorTextFocus && !selectionEmpty && marking', group: 'sel/1-mark', order: 50, layer: 'core', icon: 'lucide:eraser', label: t('menu.label.clearMarks') },
  { command: 'core.editor/copy-ref', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/2-ref', order: 10, layer: 'core', icon: 'lucide:quote', label: t('menu.label.copyRef') },

  /* ================= 命令面板：`*` ＝ 全部命令 ================= */
  { command: '*', kind: 'palette', when: '', layer: 'core' },
]

/* --------------------------------------------------------- 键位匹配 */

const MOD_ORDER = ['mod', 'ctrl', 'meta', 'alt', 'shift']

/** 归一化绑定键（把修饰键排成固定顺序，便于字符串比较） */
export function canonKey(k: string): string {
  const parts = k.toLowerCase().split('+').filter(Boolean)
  const mods = MOD_ORDER.filter((m) => parts.includes(m))
  const rest = parts.filter((p) => !MOD_ORDER.includes(p))
  return [...mods, ...rest].join('+')
}

const KEY_ALIAS: Record<string, string> = {
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  ' ': 'space',
  esc: 'escape',
  del: 'delete',
  return: 'enter',
}

/** 一次按键 → 归一化键 id */
export function eventKeyId(e: KeyboardEvent, isMac: boolean): string {
  const parts: string[] = []
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('mod')
  if (isMac && e.ctrlKey) parts.push('ctrl')
  if (!isMac && e.metaKey) parts.push('meta')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let k = e.key.toLowerCase()
  k = KEY_ALIAS[k] ?? k
  parts.push(k)
  return canonKey(parts.join('+'))
}

/** 平台化的键位显示（`mod+b` → `⌘B` / `Ctrl+B`） */
export function keyLabel(key: string, isMac = /Mac|iPhone|iPad/.test(navigator.platform)): string {
  const GLYPH: Record<string, string> = {
    enter: '↵',
    tab: '⇥',
    backspace: '⌫',
    delete: '⌦',
    escape: 'Esc',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    space: '␣',
  }
  return key
    .split('+')
    .map((p) => {
      if (p === 'mod') return isMac ? '⌘' : 'Ctrl+'
      if (p === 'shift') return isMac ? '⇧' : 'Shift+'
      if (p === 'alt') return isMac ? '⌥' : 'Alt+'
      if (p === 'ctrl') return '⌃'
      if (p === 'meta') return '⌘'
      return GLYPH[p] ?? (p.length === 1 ? p.toUpperCase() : p)
    })
    .join('')
}

/* --------------------------------------------------------- 解析 */

function layerWeight(l: Layer): number {
  return l === 'user' ? 3 : l === 'plugin' ? 2 : 1
}

/** when 求值：空表达式恒真；语法错误 ⇒ 假（并可由诊断面板看见） */
function whenOk(b: Binding, ctx: CtxKeys): boolean {
  if (!b.when) return true
  return evalWhenSafe(b.when, ctx).ok
}

export interface ResolveOpts {
  prefix?: string
  query?: string
  limit?: number
}

/**
 * 解析某类绑定：只返回 `when` 为真者，按 (group, order) 升序、同命令多层时**高层胜出**。
 * `prefix` 过滤分组（块菜单用 `block/`、工具栏用 `tb/`）；`query` 做菜单内搜索。
 */
export function resolveBindings(kind: BindingKind, ctx: CtxKeys, opts: ResolveOpts = {}): Binding[] {
  const cands = BINDINGS.filter((b) => b.kind === kind)
  /**
   * 层次序 user > plugin > core：同一条绑定只留最高层。
   *
   * ⚠️ **「同一条」要把 `args` 算进去**：一条命令可以有多条绑定，差别全在参数上 ——
   *    `insert-block` 就是「正文块／待办／分割线」三个不同的动作，它们共用同一条命令、
   *    同一个分组。只按 `command|group` 去重会把它们折叠成一条，用户菜单里就只剩第一个。
   *    按 `args` 展开之后，覆盖一条具体动作（而不是覆盖整条命令）才是准确语义。
   */
  const keyOf = (b: Binding): string => `${b.command}|${b.group ?? ''}|${JSON.stringify(b.args ?? null)}`
  const byKey = new Map<string, Binding>()
  for (const b of cands) {
    const k = keyOf(b)
    const cur = byKey.get(k)
    if (!cur || layerWeight(b.layer) > layerWeight(cur.layer)) byKey.set(k, b)
  }
  let out = [...byKey.values()].filter((b) => whenOk(b, ctx))
  if (opts.prefix) out = out.filter((b) => (b.group ?? '').startsWith(opts.prefix!))
  if (opts.query) {
    const q = opts.query.toLowerCase()
    out = out.filter((b) => {
      const hay = [b.label ?? '', b.command, ...(b.keywords ?? [])].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }
  out.sort(
    (a, b) =>
      (a.group ?? '').localeCompare(b.group ?? '') ||
      (a.order ?? 100) - (b.order ?? 100) ||
      a.command.localeCompare(b.command),
  )
  return opts.limit ? out.slice(0, opts.limit) : out
}

export interface KeyAttempt {
  binding: Binding
  keyOk: boolean
  whenOk: boolean
}

export interface KeyResolution {
  hit: Binding | null
  attempts: KeyAttempt[]
  id: string
}

/**
 * 一次按键的解析：**从下往上求值，第一条 `key` ＋ `when` 都匹配的胜出**（VS Code 规则）。
 * `attempts` 供「按键命中追踪」用：没命中也能说清是哪一条的 `when` 拦住的。
 */
export function resolveKey(e: KeyboardEvent, ctx: CtxKeys, isMac: boolean): KeyResolution {
  const id = eventKeyId(e, isMac)
  // ：**所有键位绑定自动派生 `!composing`**（组合期一律不命中；Enter 归 IME 提交）
  if (ctx.composing) return { hit: null, attempts: [], id: `${id} (blocked:composing)` }
  // 排成「自下而上」：core → plugin → user（同层按表序），随后**反向遍历** ⇒ 第一条匹配的胜出
  const ordered = BINDINGS.map((b, i) => ({ b, i }))
    .filter((x) => x.b.kind === 'keymap')
    .sort((x, y) => layerWeight(x.b.layer) - layerWeight(y.b.layer) || x.i - y.i)
    .map((x) => x.b)
  const attempts: KeyAttempt[] = []
  let hit: Binding | null = null
  for (let i = ordered.length - 1; i >= 0; i--) {
    const b = ordered[i]!
    const keyOk = canonKey(b.key ?? '') === id
    if (!keyOk) continue
    const ok = whenOk(b, ctx)
    attempts.push({ binding: b, keyOk, whenOk: ok })
    if (ok && !hit) hit = b
  }
  return { hit, attempts, id }
}

/** 绑定表里出现过的全部键位（速查表用） */
export function keymapRows(): { key: string; command: string; when: string; layer: Layer }[] {
  return BINDINGS.filter((b) => b.kind === 'keymap' && b.key).map((b) => ({
    key: b.key!,
    command: b.command,
    when: b.when ?? '',
    layer: b.layer,
  }))
}

/** 给「Inspect Context Keys」用：把 ctx 里被绑定表引用到的键标出来 */
export function referencedKeys(): string[] {
  const out = new Set<string>()
  for (const b of BINDINGS) {
    if (!b.when) continue
    for (const m of b.when.matchAll(/[A-Za-z_$][A-Za-z0-9_$.]*/g)) {
      const w = m[0]
      if (['true', 'false', 'null', 'undefined', 'in', 'not'].includes(w)) continue
      out.add(w)
    }
  }
  return [...out].sort()
}

/** 诊断用：显式求值一次（给面板展示「这条 why 没过」） */
export function whyNot(b: Binding, ctx: CtxKeys): string {
  if (!b.when) return ''
  const r = evalWhenSafe(b.when, ctx)
  if (r.error) return r.error
  return r.ok ? '' : t('err.when.false')
}

/** 直接求值（给面板/断言的入口） */
export function evalWhenExpr(expr: string, ctx: CtxKeys): boolean {
  return expr ? evalWhen(expr, ctx) : true
}
