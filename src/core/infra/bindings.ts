/**
 * 绑定表—— **一个机制四处复用**：
 * 键位（keymap）／块菜单（menu）／斜杠（slash）／**划选气泡（selection）**。
 * 命令面板**不在这张表里**：它枚举命令表本身（必须列出不带任何绑定的命令），
 * 键位提示从 keymap 绑定取——所以这里没有 `palette` 这一档。
 *
 * ⚠️ 菜单/气泡**不是手写组件**，它们只是 `resolveBindings(kind, ctx)` 的渲染结果。
 * ⚠️ 绑定表**不进 HTTP／MCP／CLI 面**——机器接口只认命令与 `expose`。
 *
 * 关于 `selection`：撤掉顶部工具栏（chrome 极弱＝中性现代的口径）后，
 * 「加粗/斜体/高亮/代码」这类**作用于选区**的命令改由**划选文本时浮出的气泡**承载——
 * 它们的 `when` 一律带 `!selectionEmpty`，所以光标状态下气泡根本不会出现。
 */
import { evalWhen, evalWhenSafe } from './when.ts'
// ⚠️ 三个收敛点之二：绑定表的 `label` / `keywords` 一律走 t
import { t, type MsgId } from './msg.ts'
import type { CtxKeys } from '../index.ts'

export type BindingKind = 'keymap' | 'menu' | 'slash' | 'selection'
export type Layer = 'core' | 'plugin' | 'user'

export interface Binding {
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
  // 删除块只有 ⌘⇧D 一键（复制块不占键位，走块菜单/斜杠）：块选区态的同键绑定在下面盖过它
  { command: 'core.editor/delete-block', kind: 'keymap', key: 'mod+shift+d', when: 'editorTextFocus && blockCanDelete', layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'keymap', key: 'mod+.', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/toggle-todo', kind: 'keymap', key: 'mod+enter', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/insert-page-ref', kind: 'keymap', key: 'mod+shift+k', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.anno/toggle-bold', kind: 'keymap', key: 'mod+b', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-italic', kind: 'keymap', key: 'mod+i', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-highlight', kind: 'keymap', key: 'mod+e', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/toggle-code', kind: 'keymap', key: 'mod+`', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.anno/clear-marks', kind: 'keymap', key: 'mod+shift+m', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.history/undo', kind: 'keymap', key: 'mod+z', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.history/redo', kind: 'keymap', key: 'mod+shift+z', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.history/redo', kind: 'keymap', key: 'mod+y', when: 'editorTextFocus', layer: 'core' },
  // 导航前进/后退（中心槽走到哪）：与 undo/redo 的撤销栈是两套，键也不同
  { command: 'core.history/back', kind: 'keymap', key: 'mod+[', when: 'canGoBack', layer: 'core' },
  { command: 'core.history/forward', kind: 'keymap', key: 'mod+]', when: 'canGoForward', layer: 'core' },
  // tab：一个 tab 一份保存的视图。⇧⌘[/] 前后切换；⇧⌘W 关闭（⌘W 是关窗口）；⌘T 归「回今日」
  { command: 'core.tab/prev', kind: 'keymap', key: 'mod+shift+[', when: '', layer: 'core' },
  { command: 'core.tab/next', kind: 'keymap', key: 'mod+shift+]', when: '', layer: 'core' },
  { command: 'core.tab/close', kind: 'keymap', key: 'mod+shift+w', when: '', layer: 'core' },
  // `when` 为空 ⇒ 总是可用：命令面板是键盘可达性的兜底。`⌘P` 是命令面板的行业默认键位。
  { command: 'core.command-palette/show', kind: 'keymap', key: 'mod+p', when: '', layer: 'core' },
  // 全文检索：`⌘K`（同为行业默认）；菜单没有原生 Find／Print role，不会抢
  { command: 'core.search/open', kind: 'keymap', key: 'mod+k', when: '', layer: 'core' },
  // 外链：⌘K（与「引用 ⌘⇧K」同族，差一个修饰键）；开了输入框之后由浮层接手，不在这里绑第二下。
  // ⚠️ 必须**排在搜索那条之后**：一键两义靠反向求值「后出现者优先」分离（⌘⇧D 同款手法）——
  // 排在前面，编辑器态的这条永远轮不到（键位表序就是裁决序，不是装饰）。
  { command: 'core.editor/insert-link', kind: 'keymap', key: 'mod+k', when: 'editorTextFocus', layer: 'core' },
  // 设置：⌘,（macOS 同一条直觉）。设置是中心工具面，按 kind 去重（再按＝切过去）
  { command: 'core.settings/open', kind: 'keymap', key: 'mod+,', when: '', layer: 'core' },
  // `⌘F` 预留给就地查找（块内查找/替换）：**故意不绑定**，别把这条还给全局搜索——
  // 全局搜索已经住在 `⌘K`，两个入口会各搜一份、结果口径再分叉。
  { command: 'core.layer/close', kind: 'keymap', key: 'escape', when: '', layer: 'core' },
  /* ================= 块选区 =================
     ⚠️ 这些必须放在文本绑定**之后**：按键解析是**反向遍历、后出现者优先**。
     块选区激活时（`blockSelection`）它们盖过 Enter/Backspace/Delete/Escape 的文本语义。 */
  { command: 'core.selection/clear', kind: 'keymap', key: 'escape', when: 'blockSelection && !paletteOpen', layer: 'core' },
  { command: 'core.selection/focus-first', kind: 'keymap', key: 'enter', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/delete-selected-blocks', kind: 'keymap', key: 'backspace', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/delete-selected-blocks', kind: 'keymap', key: 'delete', when: 'blockSelection', layer: 'core' },
  // 与单块删除同键（⌘⇧D）：选区态盖过文本态——一个键按状态删一块或删所选
  { command: 'core.editor/delete-selected-blocks', kind: 'keymap', key: 'mod+shift+d', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/indent-selected-blocks', kind: 'keymap', key: 'tab', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/outdent-selected-blocks', kind: 'keymap', key: 'shift+tab', when: 'blockSelection', layer: 'core' },
  { command: 'core.editor/toggle-todo-selected-blocks', kind: 'keymap', key: 'mod+enter', when: 'blockSelection', layer: 'core' },
  { command: 'core.selection/select-all-blocks', kind: 'keymap', key: 'mod+shift+a', when: 'editorTextFocus || blockSelection', layer: 'core' },
  { command: 'core.selection/extend-up', kind: 'keymap', key: 'shift+up', when: 'editorTextFocus || blockSelection', layer: 'core', args: { dir: -1 } },
  { command: 'core.selection/extend-down', kind: 'keymap', key: 'shift+down', when: 'editorTextFocus || blockSelection', layer: 'core', args: { dir: 1 } },
  { command: 'core.menu/slash', kind: 'keymap', key: 'mod+/', when: 'editorTextFocus', layer: 'core' },
  // 复制端定身份（粘贴端零打断）：块上 ⌘C＝多味复制（软内 ⌘V 贴成引用、软外贴出正文），
  // 划选 ⌘C 不在此列（键位不命中 ⇒ 原生复制文本）。⌘⇧C 两个身份档：划选＝块引＋静态锚文本，无划选＝只贴正文（复制份）。
  { command: 'core.editor/copy-block', kind: 'keymap', key: 'mod+c', when: 'editorTextFocus && selectionEmpty', layer: 'core' },
  { command: 'core.editor/copy-ref-anchor', kind: 'keymap', key: 'mod+shift+c', when: 'editorTextFocus && !selectionEmpty', layer: 'core' },
  { command: 'core.editor/copy-block-text', kind: 'keymap', key: 'mod+shift+c', when: 'editorTextFocus && selectionEmpty', layer: 'core' },
  // 剪切与块选区粘贴：⌘X 本身不动文档，移动发生在 ⌘V 那一刻（一笔事务，id 不变、可反复贴）。
  // 光标态 ⌘X 与 ⌘C 同判据（剪整块）；划选态键位不命中 ⇒ 原生文本剪切照旧；
  // 光标态的 ⌘V 仍归 paste 事件。
  { command: 'core.editor/cut-blocks', kind: 'keymap', key: 'mod+x', when: 'blockSelection || (editorTextFocus && selectionEmpty)', layer: 'core' },
  { command: 'core.editor/paste-into-selection', kind: 'keymap', key: 'mod+v', when: 'blockSelection', layer: 'core' },
  { command: 'core.page/new', kind: 'keymap', key: 'mod+shift+n', when: '', layer: 'core' },
  { command: 'core.view/toggle-theme', kind: 'keymap', key: 'mod+shift+l', when: '', layer: 'core' },
  // 三槽开关：`⌘⌥1` / `⌘⌥2` ——中心槽没有独立快捷键
  { command: 'core.dock/toggle-left', kind: 'keymap', key: 'mod+alt+1', when: '', layer: 'core' },
  { command: 'core.dock/toggle-right', kind: 'keymap', key: 'mod+alt+2', when: '', layer: 'core' },
  // 上方插入：⇧⌘↵。Enter 家族三键各归其位——↵/⇧↵ 是拆块（下方语义），⌘↵ 是切换待办，
  // 「上方」这个方向落在剩下的 ⇧⌘↵ 上。原占用者档位轴进档退到命令面板
  // （键位只是加速器，面板照常可达）；退档不受影响（Esc 的绑定在键位段末尾——
  // 它要让位给块选区清空（选区在场先清选区）；浮层在场时派发层不派发，浮层自己收，浮层天然优先）。
  { command: 'core.editor/insert-block-before', kind: 'keymap', key: 'mod+shift+enter', when: 'editorTextFocus', layer: 'core' },
  // 回今日：`⌘T`（新开 tab 撤了键——两者落同一处，差别只在多不多一张 tab）
  { command: 'core.journal/today', kind: 'keymap', key: 'mod+t', when: '', layer: 'core' },
  // 前后翻日：**仅在 journal 视图且编辑器失焦时**生效的原文口径）
  { command: 'core.journal/prev', kind: 'keymap', key: 'mod+alt+left', when: 'journalView && !editorTextFocus', layer: 'core' },
  { command: 'core.journal/next', kind: 'keymap', key: 'mod+alt+right', when: 'journalView && !editorTextFocus', layer: 'core' },
  // 复盘＝带参的日记流（同 spec 换 days＋排列）：三天 / 本周
  { command: 'core.journal/review', kind: 'keymap', key: 'mod+shift+r', args: { days: 3 }, when: '!editorTextFocus', layer: 'core' },
  { command: 'core.journal/review', kind: 'keymap', key: 'mod+alt+shift+r', args: { days: 7 }, when: '!editorTextFocus', layer: 'core' },
  { command: 'core/bindings/list', kind: 'keymap', key: 'mod+shift+?', when: '', layer: 'core' },
  // 粘贴为镜像：看法轴的键位（同一块贴成块位置的露面）。原占用者虚拟化开关退到命令面板
  // （键位只是加速器，面板照常可达）；调试开关不占 ⌘⇧V 这样的黄金位。
  { command: 'core.embed/paste', kind: 'keymap', key: 'mod+shift+v', when: 'blockFocused', args: { view: 'mirror' }, layer: 'core' },
  // Esc 的最后一层语义：档位轴退一档（常规时 `axisActive` 为假 ⇒ 不命中，Esc 落到关浮层那条）。
  // 放在键位段末尾：解析自下而上，块选区清空（表内更早）先于它命中。
  { command: 'core.view/axis-down', kind: 'keymap', key: 'escape', when: 'axisActive && !blockSelection', layer: 'core' },

  /* ================= 块菜单（悬停左侧拖动把手 / 圆点或右键） =================
     顶层只留「对这一块做什么」的骨架动作；「复制有几种味」「插进正文有几种原子」
     这两件多选项收进**子菜单**（锚点＝一条命令＋绑定行上的分组前缀，与动态的
     「视图…」同一机制）——顶层短了，语义轴不变。删除类**同住一组**：
     危险动作的位置恒定，`when` 只决定那一行写的是删块还是删页。 */

  /* ---- 基本：两个子菜单锚点 ---- */
  { command: 'core.menu/sub', kind: 'menu', when: 'blockFocused', group: 'block/1-basic', order: 10, layer: 'core', args: { prefix: 'blockCopy/' }, label: t('menu.group.copy') },
  { command: 'core.menu/sub', kind: 'menu', when: 'blockFocused', group: 'block/1-basic', order: 20, layer: 'core', args: { prefix: 'blockInsert/' }, label: t('menu.group.insert') },
  /* 复制（子菜单）：前四条是「同一块的几种味」，复制块是落进文档的副本 */
  { command: 'core.editor/copy-block', kind: 'menu', when: 'blockFocused', group: 'blockCopy/1', order: 10, layer: 'core' },
  { command: 'core.editor/copy-block-text', kind: 'menu', when: 'blockFocused', group: 'blockCopy/1', order: 20, layer: 'core' },
  { command: 'core.editor/copy-ref', kind: 'menu', when: 'blockFocused', group: 'blockCopy/1', order: 30, layer: 'core' },
  { command: 'core.editor/copy-block-ref', kind: 'menu', when: 'blockFocused', group: 'blockCopy/1', order: 40, layer: 'core' },
  { command: 'core.editor/duplicate-block', kind: 'menu', when: 'blockFocused', group: 'blockCopy/1', order: 50, layer: 'core' },
  /* 插入（子菜单）：行内原子与归属，落点都是这一块的正文 */
  { command: 'core.editor/pick-tag', kind: 'menu', when: 'blockFocused', group: 'blockInsert/1', order: 10, layer: 'core' },
  { command: 'core.editor/insert-page-ref', kind: 'menu', when: 'blockFocused', group: 'blockInsert/1', order: 20, layer: 'core' },
  { command: 'core.editor/insert-image', kind: 'menu', when: 'blockFocused', group: 'blockInsert/1', order: 30, layer: 'core' },
  { command: 'core.editor/insert-link', kind: 'menu', when: 'blockFocused', group: 'blockInsert/1', order: 40, layer: 'core' },

  /* ---- 结构：把这一块摆成什么样（顺序/深度/状态） ---- */
  { command: 'core.editor/toggle-todo', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 10, layer: 'core' },
  /**
   * 与上面那条**成对**出现：`toggle-todo` 在「是任务」时只翻值，翻不出「不是任务」这一态
   * （见 `editor.clearTodo`），所以「变回去」必须是独立一条。
   *
   * 判据用 `blockType`（`core/view/editor.ts` 的 `ctxKeys`，只取 `todo`／`paragraph` 两值）：
   * 不是任务的块上不显示 —— 一条「点了什么都不会发生」的菜单项比没有更糟。
   */
  { command: 'core.editor/clear-todo', kind: 'menu', when: 'blockFocused && blockType == "todo"', group: 'block/2-structure', order: 15, layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'menu', when: 'blockFocused && blockFoldable', group: 'block/2-structure', order: 20, layer: 'core', label: t('menu.label.toggleCollapse') },
  { command: 'core.editor/move-block-up', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 30, layer: 'core' },
  { command: 'core.editor/move-block-down', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 40, layer: 'core' },
  { command: 'core.editor/indent-block', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 50, layer: 'core' },
  { command: 'core.editor/outdent-block', kind: 'menu', when: 'blockFocused', group: 'block/2-structure', order: 60, layer: 'core' },
  /**
   * 移动到…：**显式点名**的重排。与「块上移/下移」不同——那两个只换同级顺序，
   * 这个跨容器。身份块不给入口：它们不参与组织，搬它们没有意义（位置不承载信息）。
   */
  { command: 'core.block/move-to', kind: 'menu', when: 'blockFocused && !blockIsRoot', group: 'block/2-structure', order: 70, layer: 'core' },

  /* ---- 身份与露面：加/减一格标记（页/标签各自独立、可兼位；顺序无语义） ---- */
  { command: 'core.block/as-page', kind: 'menu', when: 'blockFocused && !blockHasPageRole', group: 'block/3-role', order: 10, layer: 'core' },
  { command: 'core.block/unpage', kind: 'menu', when: 'blockFocused && blockHasPageRole', group: 'block/3-role', order: 11, layer: 'core' },
  // 删除页/删除标签在「删除」组（危险动作同位）；这一组只留身份的加减与配置
  { command: 'core.block/extract-to-page', kind: 'menu', when: 'blockFocused && blockCanExtractPage', group: 'block/3-role', order: 12, layer: 'core' },
  { command: 'core.block/as-tag', kind: 'menu', when: 'blockFocused && !blockHasTagRole', group: 'block/3-role', order: 20, layer: 'core' },
  { command: 'core.block/untag', kind: 'menu', when: 'blockFocused && blockHasTagRole', group: 'block/3-role', order: 21, layer: 'core' },
  // 别名是「名字层」的配置，不属于任何具体列表：任何聚焦块都能打开
  { command: 'core.block/edit-aliases', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 30, layer: 'core' },
  // 显式入口：把「看这一块的属性」做成一次点击。落点是属性抽屉——不换中心、
  // 不动槽（侧槽开关只归 core.dock/*），能力不依赖任何面板是否在场。
  { command: 'core.block/inspect', kind: 'menu', when: 'blockFocused', group: 'block/3-role', order: 31, layer: 'core' },

  /* ---- 行内：光标正停在什么上，就给什么（都带 `when`，平时不占行） ---- */
  /**
   * **提及命中 → 引用**：只有光标正停在命中区间上时才出现。
   *
   * 判据与 ⌥ 单击同一份（`mentionHit` 由编辑器按 `spanAt` 现算），这里不放参数——
   * 具体是哪一段由命令向编辑器要，免得菜单行与手势各带一份区间。
   */
  { command: 'core.block/convert-mention', kind: 'menu', when: 'mentionHit', group: 'block/4-inline', order: 10, layer: 'core' },
  { command: 'core.anno/clear-marks', kind: 'menu', when: 'blockFocused && !selectionEmpty', group: 'block/4-inline', order: 20, layer: 'core' },

  /* ---- 视图与导航：换个看法、去别的位置看 ---- */
  { command: 'core.query/insert', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 5, layer: 'core', label: t('cmd.query.insert'), keywords: ['query', 'filter', 'where'], icon: 'lucide:list-filter' },
  /**
   * **视图**（一个块换个看法）：入口只在「有东西可摊开」的块上（查询块 / 有子块 / 已有视图）。
   * 菜单里是**动态**的一份清单（大纲 ＋ 已有视图 ＋ 新建表格），所以只挂一条命令、
   * 由装配层按当前的 `_views` 现画 —— 绑定表是静态的，装不下「每个块不一样」的项。
   */
  { command: 'core.view/menu', kind: 'menu', when: 'blockFocused && blockCanHaveView', group: 'block/5-view', order: 10, layer: 'core', label: t('menu.label.views'), keywords: ['view', 'table', 'grid', t('menu.kw.views')] },
  { command: 'core.embed/insert', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 20, layer: 'core', label: t('ui.embed.insert') },
  // 子块行内属性：父块上的显示声明（`_childProps`）——菜单是动态清单（引擎两项＋全部定义），
  // 只挂一条命令、由装配层现画（与 core.view/menu 同一机制）
  { command: 'core.props/child-props-menu', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 25, layer: 'core', label: t('menu.label.childProps'), keywords: ['property', 'child', 'created', t('menu.kw.date')] },
  { command: 'core.embed/paste-menu', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 30, layer: 'core', label: t('cmd.embed.paste-menu') },
  // zoom：进子树的入口挂在块菜单。**叶子块也给**（修订：
  // 块标左键＝聚焦是一贯行为：若叶子不给，点击结果会时 zoom 时不 zoom）
  { command: 'core.block/focus-block', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 40, layer: 'core', keywords: ['zoom', t('menu.kw.zoom')] },
  /**
   * 退回上一级：**最外层时不给入口**（`when` 挡住），不是点了没反应。
   *
   * ⚠️ 早先它没有绑定，只在命令面板里裸着一条——面板是「兜底可达性」，
   *    一条永远点不动的命令放在那里，用户只会以为是坏的。
   * ⚠️ 标题也从「退回顶层」改掉了：那个词把**系统架**露给了用户
   *    （用户世界里不该有「顶层」这个概念，根是系统自己的事）。
   */
  { command: 'core.block/zoom-out', kind: 'menu', when: 'blockFocused && !blockIsRoot', group: 'block/5-view', order: 45, layer: 'core', keywords: ['zoom', 'out', 'back'] },
  // 「在别处打开」的第二种落点：与 ⌘/Ctrl+点同一条路（`focus-block` 的 `newTab`）。
  // 菜单补的是**可发现性**——手势在，但没人知道它，等于没有。
  { command: 'core.block/focus-block', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 50, layer: 'core', args: { newTab: true }, label: t('cmd.block.open-new-tab'), keywords: ['tab', 'page', 'open'] },
  { command: 'core.dock/open-block', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 55, layer: 'core' },
  // 「加到快捷」与「在右槽打开」是两条独立露面：前者只留一颗 44px 入口，后者摊一张窗口卡
  { command: 'core.dock/add-shortcut', kind: 'menu', when: 'blockFocused', group: 'block/5-view', order: 56, layer: 'core' },

  /* ---- 删除：危险动作**同位**——位置恒定，`when` 决定那一行删的是什么 ---- */
  { command: 'core.editor/delete-block', kind: 'menu', when: 'blockFocused && blockCanDelete', group: 'block/6-delete', order: 10, layer: 'core', keywords: [t('menu.kw.delete')] },
  // 日记天也是装载根（编辑器里的 delete-block 删不到）⇒ 删除走命令面；今天不出现（见 ctx 键）
  { command: 'core.journal/delete', kind: 'menu', when: 'blockFocused && blockCanDeleteJournal', group: 'block/6-delete', order: 20, layer: 'core', keywords: [t('menu.kw.delete')] },
  // 与「取消页」是两条轴：取消只摘露面位（块和内容都还在），删除连子树一起软删（回收站可恢复）
  { command: 'core.page/delete', kind: 'menu', when: 'blockFocused && blockHasPageRole', group: 'block/6-delete', order: 30, layer: 'core' },
  { command: 'core.tag/delete', kind: 'menu', when: 'blockFocused && blockHasTagRole', group: 'block/6-delete', order: 40, layer: 'core' },
  /* 「粘贴为…」的两档：同一个命令，只差一个看法（菜单动态项由装配层现画，绑定点只给选项） */
  /**
   * ⚠️ 判据用 `blockFocused`（编辑器上下文里**有**这个键），不要用 `editorFocus`：
   * 那个键根本不存在 ⇒ `when` 恒假 ⇒ 菜单弹出来是空的，而且不报错。
   * 这两条只从块菜单的「粘贴为…」进来，那一刻块一定聚焦。
   */
  { command: 'core.embed/paste', kind: 'menu', when: 'blockFocused', group: 'embedPaste/1', order: 10, args: { view: 'mirror' }, layer: 'core', label: t('ui.embed.asMirror') },
  { command: 'core.embed/paste', kind: 'menu', when: 'blockFocused', group: 'embedPaste/1', order: 20, args: { view: 'table' }, layer: 'core', label: t('ui.embed.asTable') },

  /* ================= 块选区菜单 =================
     与单块菜单同一条判据：**删除压轴、带标题分节**（危险动作位置恒定）。
     菜单项的位置由误触成本与寻得成本一起定——删除的误触成本全菜单最高，
     寻得成本却是低优先（⌫/⌦ 键位在，菜单只是指针路径），所以它不占首行；
     首行留给高频无害的结构动作。组序上 `2-clear` < `2-delete`，
     无害的「取消选择」始终在删除上方。 */
  { command: 'core.editor/indent-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 15, layer: 'core', keywords: ['tab', t('menu.kw.indent')] },
  { command: 'core.editor/outdent-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 16, layer: 'core', keywords: ['shift tab', t('menu.kw.outdent')] },
  { command: 'core.editor/toggle-todo-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 17, layer: 'core', keywords: ['todo', 'task'] },
  // 跨块备注：块选区整段锚，一条备注带走全部（空块锚不出来，自动跳过）
  { command: 'core.notes/create', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 25, layer: 'core', icon: 'lucide:message-circle', label: t('menu.label.writeNote') },
  { command: 'core.editor/copy-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 20, layer: 'core' },
  { command: 'core.editor/copy-selected-block-refs', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 30, layer: 'core', keywords: ['ref', t('menu.kw.ref')] },
  // 剪切：⌘X 有键位，菜单补的是指针用户的路（与复制同处一组；移动发生在粘贴那一刻）
  { command: 'core.editor/cut-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 40, layer: 'core', keywords: ['cut', 'move'] },
  { command: 'core.selection/clear', kind: 'menu', when: 'blockSelection', group: 'blockSel/2-clear', order: 10, layer: 'core' },
  // 删除压轴（单独成组才有「删除」标题分节）；复用单块删除组的同一词典键
  { command: 'core.editor/delete-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/2-delete', order: 10, layer: 'core', keywords: [t('menu.kw.delete')] },

  /* ================= 斜杠菜单（输入 `/`） =================
     成员判据：只收「**这里要有什么、这一行变成什么**」——插入新内容
     （结构块／行内原子／归属）或本行变换，且每条都必须提供 ↵ 之外的能力。
     没有「正文块」：插一个普通块就是按 ↵，斜杠里再列一遍等于把同一个动作说两遍。
     折叠与删除不在斜杠：它们回答的是「对这块做什么」，不回答「这里有什么」——
     折叠是视图状态（⌘. 在），删除是块骨架操作（⌘⇧D／⌫ 在）。 */
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 10, layer: 'core', label: t('menu.label.todo'), args: { type: 'todo' }, keywords: ['todo', 'task'], icon: 'lucide:square' },
  /**
   * 「取消待办」：`/待办` 把这一行变成任务之后，同一个入口能把它变回去 ——
   * 只在这一块真是任务时出现（同菜单那条判据），否则斜杠列表里永远挂着一个空动作。
   * 图标复用「虚线方框」：它是「这个方框可以被拿掉」的现成说法，不新增图标数据。
   */
  { command: 'core.editor/clear-todo', kind: 'slash', when: 'editorTextFocus && blockType == "todo"', group: 'slash/1-structure', order: 15, layer: 'core', icon: 'lucide:square-dashed' },
  // 分割线：没有正文的块，插完光标要落到它下面那一行（见 insertDividerAfter）
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 20, layer: 'core', label: t('menu.label.divider'), args: { type: 'divider' }, keywords: ['divider', 'hr', 'line', t('menu.kw.divider')], icon: 'lucide:minus' },
  { command: 'core.query/insert', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 30, layer: 'core', label: t('cmd.query.insert'), keywords: ['query', 'filter', 'where'], icon: 'lucide:list-filter' },
  // 看法：不带参数 ⇒ 命令开选择器选哪一种（与露面/标签同一条两段式；大纲不列——↵ 已经做了）
  { command: 'core.view/insert', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 35, layer: 'core', label: t('menu.label.insertView'), keywords: ['view', 'tabs', 'table', 'board', 'mindmap', t('menu.kw.view')], icon: 'lucide:layout-grid' },
  // 露面：不带参数 ⇒ 命令开选择器选目标块（与块菜单那条同一条路）
  { command: 'core.embed/insert', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 40, layer: 'core', label: t('ui.embed.insert'), keywords: ['embed', t('menu.kw.embed'), 'mirror'], icon: 'lucide:git-fork' },
  // 「复制块」是键盘用户唯一免鼠标的复制路径（⌘C+⌘V 要两步还得挪光标）
  { command: 'core.editor/duplicate-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 50, layer: 'core', label: t('menu.label.duplicate'), icon: 'lucide:copy' },
  { command: 'core.editor/insert-page-ref', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 10, layer: 'core', label: t('menu.label.pageRef'), keywords: ['ref', 'link', t('menu.kw.ref')], icon: 'lucide:arrow-up-right' },
  // 日期：不带参数 ⇒ 命令开日历选择器（选中那天才回命令面插引用）
  { command: 'core.editor/insert-date-ref', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 15, layer: 'core', label: t('menu.label.dateRef'), keywords: ['date', 'day', 'journal', t('menu.kw.date')], icon: 'lucide:calendar' },
  // 斜杠菜单的「图片」是**真入口**（选文件）；不带 preset 才走 `App.pickImage()`
  { command: 'core.editor/insert-image', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 20, layer: 'core', label: t('menu.label.image'), keywords: ['image', 'asset', t('menu.kw.image')], icon: 'lucide:image' },
  // 外链：不带 `url` ⇒ 命令打开输入框（`App.showLinkComposer`）；带了 ⇒ 直接插
  { command: 'core.editor/insert-link', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 25, layer: 'core', label: t('menu.label.link'), keywords: ['link', 'url', t('menu.kw.link')], icon: 'lucide:link' },
  // 「标签」开选择器现挑，不插固定名字的标签——哪一个是用户的事，不是菜单的事
  { command: 'core.editor/pick-tag', kind: 'slash', when: 'editorTextFocus', group: 'slash/2-inline', order: 30, layer: 'core', label: t('menu.label.tag'), keywords: ['tag', t('menu.kw.tag')], icon: 'lucide:hash' },

  /* ================= 划选气泡（选中一段文本才浮出；顶部没有工具栏） ================= */
  { command: 'core.anno/toggle-bold', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 10, layer: 'core', icon: 'lucide:bold', label: t('menu.label.bold') },
  { command: 'core.anno/toggle-italic', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 20, layer: 'core', icon: 'lucide:italic', label: t('menu.label.italic') },
  { command: 'core.anno/toggle-underline', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 30, layer: 'core', icon: 'lucide:underline', label: t('menu.label.underline') },
  { command: 'core.anno/toggle-strike', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 40, layer: 'core', icon: 'lucide:strikethrough', label: t('menu.label.strike') },
  { command: 'core.anno/toggle-highlight', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 50, layer: 'core', icon: 'lucide:highlighter', label: t('menu.label.highlight') },
  { command: 'core.anno/toggle-code', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 60, layer: 'core', icon: 'lucide:code', label: t('menu.label.code') },
  { command: 'core.anno/clear-marks', kind: 'selection', when: 'editorTextFocus && !selectionEmpty && marking', group: 'sel/1-mark', order: 70, layer: 'core', icon: 'lucide:eraser', label: t('menu.label.clearMarks') },
  { command: 'core.editor/copy-ref', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/2-ref', order: 10, layer: 'core', icon: 'lucide:quote', label: t('menu.label.copyRef') },
  // 入口与能力同宽：quoteSelection 用 selectionSpot（单块纯文本）判据，when 也用它
  { command: 'core.editor/quote-selection', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 15, layer: 'core', icon: 'lucide:text-quote', label: t('menu.label.quoteSelection') },
  // 写备注：与「引用这段」同组（都是「这一段的去处」）。判据同宽：单块纯文本选区才有锚
  { command: 'core.notes/create', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 25, layer: 'core', icon: 'lucide:message-circle', label: t('menu.label.writeNote') },
  /**
   * 选区 → 引用：与「复制为引文」同组（都是「这一段的去处」，不是格式）。
   * 只在单块纯文本选区上出现——跨块或夹着原子时「换成一枚引用」没有定义。
   */
  { command: 'core.editor/selection-to-ref', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 20, layer: 'core', icon: 'lucide:arrow-up-right', label: t('menu.label.selectionToRef') },
]

/* --------------------------------------------------------- 键位匹配 */

/* ---- 用户覆盖（设备态注入） ---- */

/**
 * 用户改过的键位。键＝**绑定身份**（命令＋参数：一条命令可以因参数不同而有多个动作，
 * 覆盖的是「这个动作」而不是「这条命令」）；值＝新键位，`null` ＝ 摘掉。
 *
 * 覆盖是**设备状态**（不进库、不参与同步）：键位回答「这一台机器怎么用」，不是内容。
 * 表本身保持静态；覆盖在**读的时候**生效（`effectiveKey`），启动与每次修改由装配层注入。
 */
const userKeys = new Map<string, string | null>()

/** 键位绑定的身份（keymap 没有 group：命令＋参数就是全部） */
export function bindingIdOf(b: Binding): string {
  return `${b.command}|${JSON.stringify(b.args ?? null)}`
}

/** 整表替换用户覆盖（调用方给的是偏好里那份的现值；坏形状的项丢掉） */
export function setUserKeys(next: Record<string, string | null> | undefined): void {
  userKeys.clear()
  if (!next || typeof next !== 'object') return
  for (const [id, key] of Object.entries(next)) {
    if (typeof id !== 'string' || id === '') continue
    if (key === null || typeof key === 'string') userKeys.set(id, key)
  }
}

/** 这条绑定**此刻生效**的键位；`null` ＝ 用户摘掉了（按键不再命中它） */
export function effectiveKey(b: Binding): string | null {
  const overridden = userKeys.get(bindingIdOf(b))
  if (overridden !== undefined) return overridden
  return b.key ?? null
}

/**
 * 归宿主与窗口的键：退出／关窗／新窗（浏览器与系统壳的同名动作）。覆盖它们
 * 只会造出「按了没反应」的观感——壳先收到，命令永远不来。
 */
export const RESERVED_KEYS: readonly string[] = ['mod+q', 'mod+w', 'mod+n']

/**
 * 设置界面捕获到的键能不能用；合法时给**归一化**的键位。
 *
 * 两条硬判据：
 *   · **必须带 ⌘/Alt 一类修饰键**——裸键归打字，绑走它每个字都进命令；
 *   · **保留键不可覆盖**（见 `RESERVED_KEYS`）。
 */
export function validateUserKey(raw: string): { ok: true; key: string } | { ok: false; reason: MsgId } {
  const key = canonKey(raw)
  if (key === '' || key === 'escape') return { ok: false, reason: 'ui.keys.needModifier' }
  const parts = key.split('+')
  if (!['mod', 'ctrl', 'meta', 'alt'].includes(parts[0] ?? '')) return { ok: false, reason: 'ui.keys.needModifier' }
  if (RESERVED_KEYS.includes(key)) return { ok: false, reason: 'ui.keys.reserved' }
  return { ok: true, key }
}

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
    // 用户覆盖在读的时候生效：摘掉的键位不参与解析，改过的按新键比
    const eff = effectiveKey(b)
    if (eff === null) continue
    const keyOk = canonKey(eff) === id
    if (!keyOk) continue
    const ok = whenOk(b, ctx)
    attempts.push({ binding: b, keyOk, whenOk: ok })
    if (ok && !hit) hit = b
  }
  return { hit, attempts, id }
}

/** 绑定表里出现过的全部键位（速查表用；用户覆盖生效后的样子） */
export function keymapRows(): { key: string; command: string; when: string; layer: Layer }[] {
  const out: { key: string; command: string; when: string; layer: Layer }[] = []
  const seen = new Set<string>()
  for (const b of BINDINGS) {
    if (b.kind !== 'keymap') continue
    const eff = effectiveKey(b)
    if (eff === null) continue
    // 同一身份的多条表项覆盖后共用同一个键：速查表只报一行，不把同一个键念两遍
    const dedupe = `${bindingIdOf(b)}|${eff}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    out.push({ key: eff, command: b.command, when: b.when ?? '', layer: b.layer })
  }
  return out
}

/** 设置界面的键位清单：**一条绑定身份一行**（改键位改的是身份，不是表里的某一行） */
export interface KeymapSettingsRow {
  /** 绑定身份（`bindingIdOf`；写覆盖与重置都按它说话） */
  id: string
  command: string
  /** 生效键位（已归一；「已摘掉」＝ 空数组） */
  keys: string[]
  /** 用户覆盖：`undefined` ＝ 没动过；`null` ＝ 摘掉；字符串 ＝ 新键 */
  override: string | null | undefined
  when: string
}

export function keymapSettingsRows(): KeymapSettingsRow[] {
  const byId = new Map<string, KeymapSettingsRow>()
  for (const b of BINDINGS) {
    if (b.kind !== 'keymap') continue
    const id = bindingIdOf(b)
    let row = byId.get(id)
    if (!row) {
      row = { id, command: b.command, keys: [], override: userKeys.get(id), when: b.when ?? '' }
      byId.set(id, row)
    }
    const eff = effectiveKey(b)
    if (eff !== null && !row.keys.includes(eff)) row.keys.push(eff)
  }
  return [...byId.values()]
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
