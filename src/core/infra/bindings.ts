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
import type { ColorAxis, CtxKeys } from '../index.ts'
import type { ActsOn } from './ports.ts'

export type BindingKind = 'keymap' | 'menu' | 'slash' | 'selection'
export type Layer = 'core' | 'plugin' | 'user'

export interface Binding {
  /**
   * 命令名；**子菜单行没有命令**（它开下一层，见 `submenu`）。
   * 两者恰有一个——浮层只认行，命令与子菜单是同一层的两种行。
   */
  command?: string
  /** 这一行开下一层菜单：值是下一层的分组前缀（与 `command` 互斥） */
  submenu?: string
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
  /**
   * 这一行的作用域覆盖（只有**子菜单行**需要：它没有命令可读 `actsOn`）。
   * 命令行缺省读命令声明的 `actsOn`；两者缺省都是 `editor`。
   */
  actsOn?: ActsOn
  /**
   * **这一行代表哪个颜色值轴**（只用于划选气泡的呈现）。
   *
   * 它不是命令、也不是参数：绑定表照旧声明「有这一颗按钮、什么时候在、排第几」，
   * 渲染层据此画当前值色标与二级值域。把值轴收进表里，是为了不再靠渲染层
   * 「格式组画完了就插一排色板」这种分组顺序的猜测来摆控件。
   */
  axis?: ColorAxis
}

/* ------------------------------------------------------------ 绑定表 */

export const BINDINGS: Binding[] = [
  /* ================= 键位（打字键不绑：未绑定 ⇒ 文本输入） ================= */
  { command: 'core.editor/split-block', kind: 'keymap', key: 'enter', when: 'editorTextFocus', layer: 'core' },
  // v1 不做软换行。⇧↵ 原刻意等同 Enter——怕的是**解绑**（浏览器会插 <br>，DOM 文本与模型偏移错位）；
  // 现改绑「新建子块」，仍是绑定，派发层照常 preventDefault，默认动作不会漏出来。
  // 与 ⇧⌘↵（上方插入）成对：⇧ 系在 Enter 上＝结构插入，方向由剩下的修饰键区分。
  { command: 'core.editor/insert-child', kind: 'keymap', key: 'shift+enter', when: 'editorTextFocus', layer: 'core' },
  // ⌥↵：向上跳一层建块。Enter 家族第五键——先前特意留空是因为 ⌥ 用于检查/字段卡的
  // 修饰身份，但那个身份从不占 ⌥↵；而「在父块那一层直接出生」是自动化创作的真实缺口。
  { command: 'core.editor/insert-parent-sibling', kind: 'keymap', key: 'alt+enter', when: 'editorTextFocus', layer: 'core' },
  // ⌘⌥↵：在父块中打开并定位——与 ⌥↵ 同族（父层动作），加 ⌘ 表示「不是建块，是去父层看」。
  // 不占浏览器/系统常见快捷键（⌘⇧O 在 Chrome 是书签管理器，网页端会被截走）。
  { command: 'core.block/open-parent', kind: 'keymap', key: 'mod+alt+enter', when: 'editorTextFocus', layer: 'core' },
  // ⌘A **必须接管**：Chrome 在「编辑区含 contenteditable=false 子树」时
  // 原生全选会退化成空选区（把 journal 行标成只读后实测到）⇒ 自己拼跨块 Range
  { command: 'core.editor/select-all', kind: 'keymap', key: 'mod+a', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/backspace', kind: 'keymap', key: 'backspace', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/indent-block', kind: 'keymap', key: 'tab', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/outdent-block', kind: 'keymap', key: 'shift+tab', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/move-block-up', kind: 'keymap', key: 'mod+shift+up', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/move-block-down', kind: 'keymap', key: 'mod+shift+down', when: 'editorTextFocus', layer: 'core' },
  // 删除块只有 ⌘⇧D 一键（复制块不占键位，走块菜单/斜杠）：块选区态的同键绑定在下面盖过它
  { command: 'core.block/delete', kind: 'keymap', key: 'mod+shift+d', when: 'editorTextFocus && blockCanDelete', layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'keymap', key: 'mod+.', when: 'editorTextFocus', layer: 'core' },
  { command: 'core.editor/toggle-closure', kind: 'keymap', key: 'mod+enter', when: 'editorTextFocus', layer: 'core' },
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
  // 全文检索：`⌘K`（同为行业默认）；菜单没有原生 Find／Print role，不会抢。
  // `when` 为空 ⇒ 编辑器里也让路给搜索：⌘K 必须是「任何时刻都开搜索」的一个键，一键两义
  // 会让打字路径上的 ⌘K 变成「有时插链接有时搜索」，没法形成肌肉记忆。
  // 插入外链不占键位：斜杠菜单（`slash/2-inline`）与块菜单（`blockInsert/1`）是它的入口。
  { command: 'core.search/open', kind: 'keymap', key: 'mod+k', when: '', layer: 'core' },
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
  { command: 'core.editor/toggle-closure-selected-blocks', kind: 'keymap', key: 'mod+enter', when: 'blockSelection', layer: 'core' },
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
  // 上方插入：⇧⌘↵。Enter 家族四键各归其位——↵ 拆块（下方续）、⇧↵ 新建子块（下方进一层）、
  // ⌘↵ 切换待办、⇧⌘↵ 上方插入；⇧ 系都是结构插入，方向由剩余修饰键区分。原占用者档位轴进档退到命令面板
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

  /* ---- 基本：两个子菜单入口（子菜单是行数据，不是命令） ---- */
  { kind: 'menu', submenu: 'blockCopy/', actsOn: 'block', when: 'blockMenuTarget', group: 'block/1-basic', order: 10, layer: 'core', label: t('menu.group.copy') },
  { kind: 'menu', submenu: 'blockInsert/', actsOn: 'editor', when: 'blockMenuTarget', group: 'block/1-basic', order: 20, layer: 'core', label: t('menu.group.insert') },
  /**
   * 「我的自动化…」：用户动作 hub（该块能跑哪些手动自动化）。
   * 动态行由命令打开——绑定表是静态的，装不下「每个块不一样」的项；与「视图…」同一条缝。
   * 放 basic 组：它是任务入口，不是新的语义分类。
   */
  { command: 'core.automation/menu', kind: 'menu', when: 'blockMenuTarget', group: 'block/1-basic', order: 30, layer: 'core', icon: 'lucide:zap', keywords: ['automation', 'action', 'run', t('menu.kw.automation')] },
  /* 复制（子菜单）：前四条是「同一块的几种味」，复制块是落进文档的副本 */
  { command: 'core.editor/copy-block', kind: 'menu', when: 'blockMenuTarget', group: 'blockCopy/1', order: 10, layer: 'core' },
  { command: 'core.editor/copy-block-text', kind: 'menu', when: 'blockMenuTarget', group: 'blockCopy/1', order: 20, layer: 'core' },
  { command: 'core.editor/copy-block-ref', kind: 'menu', when: 'blockMenuTarget', group: 'blockCopy/1', order: 40, layer: 'core' },
  { command: 'core.editor/duplicate-block', kind: 'menu', when: 'blockMenuTarget', group: 'blockCopy/1', order: 50, layer: 'core' },
  /* 插入（子菜单）：行内原子与归属，落点都是这一块的正文 */
  { command: 'core.editor/pick-tag', kind: 'menu', when: 'blockMenuTarget', group: 'blockInsert/1', order: 10, layer: 'core' },
  { command: 'core.editor/insert-page-ref', kind: 'menu', when: 'blockMenuTarget', group: 'blockInsert/1', order: 20, layer: 'core' },
  { command: 'core.editor/insert-image', kind: 'menu', when: 'blockMenuTarget', group: 'blockInsert/1', order: 30, layer: 'core' },
  { command: 'core.editor/insert-link', kind: 'menu', when: 'blockMenuTarget', group: 'blockInsert/1', order: 40, layer: 'core' },

  /* ---- 结构：把这一块摆成什么样（顺序/深度/状态） ---- */
  { command: 'core.editor/toggle-closure', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 10, layer: 'core' },
  /**
   * 与上面那条**成对**出现：`toggle-closure` 在「有这一栏」时只翻值，翻不出「没有这一栏」这一态
   * （见 `editor.clearClosure`），所以「变回去」必须是独立一条。
   *
   * 判据用 `blockType`（`core/view/editor.ts` 的 `ctxKeys`，只取 `closure`／`paragraph` 两值）：
   * 不是任务的块上不显示 —— 一条「点了什么都不会发生」的菜单项比没有更糟。
   */
  { command: 'core.editor/clear-closure', kind: 'menu', when: 'blockMenuTarget && blockType == "closure"', group: 'block/2-structure', order: 15, layer: 'core' },
  { command: 'core.editor/toggle-collapse', kind: 'menu', when: 'blockMenuTarget && blockFoldable', group: 'block/2-structure', order: 20, layer: 'core', label: t('menu.label.toggleCollapse') },
  // 「在父块中打开」是上下文导航：顶层块没有父块，隐藏这一行；默认左键仍是打开它自己
  { command: 'core.block/open-parent', kind: 'menu', when: 'blockMenuTarget && !blockIsRoot', group: 'block/2-structure', order: 25, layer: 'core', icon: 'lucide:corner-up-left' },
  { command: 'core.editor/move-block-up', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 30, layer: 'core' },
  { command: 'core.editor/move-block-down', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 40, layer: 'core' },
  // 「新建子块」与缩进相邻：两者是「让这块有子块」仅有的两条路径，菜单里也放一起
  { command: 'core.editor/insert-child', kind: 'menu', when: 'blockMenuTarget && blockCanTakeChildren', group: 'block/2-structure', order: 45, layer: 'core' },
  { command: 'core.editor/insert-parent-sibling', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 47, layer: 'core' },
  { command: 'core.editor/indent-block', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 50, layer: 'core' },
  { command: 'core.editor/outdent-block', kind: 'menu', when: 'blockMenuTarget', group: 'block/2-structure', order: 60, layer: 'core' },
  /**
   * 移动到…：**显式点名**的重排。与「块上移/下移」不同——那两个只换同级顺序，
   * 这个跨容器。身份块不给入口：它们不参与组织，搬它们没有意义（位置不承载信息）。
   */
  { command: 'core.block/move-to', kind: 'menu', when: 'blockMenuTarget && !blockIsRoot', group: 'block/2-structure', order: 70, layer: 'core' },

  /* ---- 身份与露面：加/减一格标记（页/标签各自独立、可兼位；顺序无语义） ---- */
  { command: 'core.block/as-page', kind: 'menu', when: 'blockMenuTarget && !blockHasPageRole', group: 'block/3-role', order: 10, layer: 'core' },
  { command: 'core.block/unpage', kind: 'menu', when: 'blockMenuTarget && blockHasPageRole', group: 'block/3-role', order: 11, layer: 'core' },
  // 删除页/删除标签在「删除」组（危险动作同位）；这一组只留身份的加减与配置
  { command: 'core.block/extract-to-page', kind: 'menu', when: 'blockMenuTarget && blockCanExtractPage', group: 'block/3-role', order: 12, layer: 'core' },
  { command: 'core.block/as-tag', kind: 'menu', when: 'blockMenuTarget && !blockHasTagRole', group: 'block/3-role', order: 20, layer: 'core' },
  { command: 'core.block/untag', kind: 'menu', when: 'blockMenuTarget && blockHasTagRole', group: 'block/3-role', order: 21, layer: 'core' },
  // 块配置（名字／露面／显示模式／脸）：一个块只有一个配置面，任何聚焦块都能打开
  { command: 'core.block/configure', kind: 'menu', when: 'blockMenuTarget', group: 'block/3-role', order: 30, layer: 'core' },
  // 显式入口：把「看这一块的属性」做成一次点击。落点是属性抽屉——不换中心、
  // 不动槽（侧槽开关只归 core.dock/*），能力不依赖任何面板是否在场。
  { command: 'core.block/inspect', kind: 'menu', when: 'blockMenuTarget', group: 'block/3-role', order: 31, layer: 'core' },

  /* ---- 行内：光标正停在什么上，就给什么（都带 `when`，平时不占行） ---- */
  /**
   * **提及命中 → 引用**：只有光标正停在命中区间上时才出现。
   *
   * 判据与 ⌥ 单击同一份（`mentionHit` 由编辑器按 `spanAt` 现算），这里不放参数——
   * 具体是哪一段由命令向编辑器要，免得菜单行与手势各带一份区间。
   */
  { command: 'core.block/convert-mention', kind: 'menu', when: 'mentionHit', group: 'block/4-inline', order: 10, layer: 'core' },
  { command: 'core.anno/clear-marks', kind: 'menu', when: 'blockMenuTarget && !selectionEmpty', group: 'block/4-inline', order: 20, layer: 'core' },

  /* ---- 视图与导航：换个看法、去别的位置看 ---- */
  { command: 'core.query/insert', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 5, layer: 'core', label: t('cmd.query.insert'), keywords: ['query', 'filter', 'where'], icon: 'lucide:list-filter' },
  /**
   * **视图**（一个块换个看法）：入口只在「有东西可摊开」的块上（查询块 / 有子块 / 已有视图）。
   * 菜单里是**动态**的一份清单（大纲 ＋ 已有视图 ＋ 新建表格），所以只挂一条命令、
   * 由装配层按当前的 `_views` 现画 —— 绑定表是静态的，装不下「每个块不一样」的项。
   */
  { command: 'core.view/menu', kind: 'menu', when: 'blockMenuTarget && blockCanHaveView', group: 'block/5-view', order: 10, layer: 'core', label: t('menu.label.views'), keywords: ['view', 'table', 'grid', t('menu.kw.views')] },
  { command: 'core.embed/insert', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 20, layer: 'core', label: t('ui.embed.insert') },
  // 视图选项：四轴（筛选/排序/分组/显示）一个面。声明层（子块行内属性）是显示节的
  // 「编辑默认」入口——不再有独立菜单行，声明与覆写在同一个面里对得上
  { command: 'core.view/options', kind: 'menu', when: 'blockMenuTarget && blockCanHaveView', group: 'block/5-view', order: 25, layer: 'core', label: t('ui.view.options'), keywords: ['filter', 'sort', 'group', 'display', t('menu.kw.views')] },
  { command: 'core.embed/paste-menu', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 30, layer: 'core', label: t('cmd.embed.paste-menu') },
  // zoom：进子树的入口挂在块菜单。**叶子块也给**（修订：
  // 块标左键＝聚焦是一贯行为：若叶子不给，点击结果会时 zoom 时不 zoom）
  { command: 'core.block/focus-block', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 40, layer: 'core', keywords: ['zoom', t('menu.kw.zoom')] },
  /**
   * 退回上一级：**最外层时不给入口**（`when` 挡住），不是点了没反应。
   *
   * ⚠️ 早先它没有绑定，只在命令面板里裸着一条——面板是「兜底可达性」，
   *    一条永远点不动的命令放在那里，用户只会以为是坏的。
   * ⚠️ 标题也从「退回顶层」改掉了：那个词把**系统架**露给了用户
   *    （用户世界里不该有「顶层」这个概念，根是系统自己的事）。
   */
  { command: 'core.block/zoom-out', kind: 'menu', when: 'blockMenuTarget && !blockIsRoot', group: 'block/5-view', order: 45, layer: 'core', keywords: ['zoom', 'out', 'back'] },
  // 「在别处打开」的第二种落点：与 ⌘/Ctrl+点同一条路（`focus-block` 的 `newTab`）。
  // 菜单补的是**可发现性**——手势在，但没人知道它，等于没有。
  { command: 'core.block/focus-block', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 50, layer: 'core', args: { newTab: true }, label: t('cmd.block.open-new-tab'), keywords: ['tab', 'page', 'open'] },
  { command: 'core.dock/open-block', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 55, layer: 'core' },
  // 「加到快捷」与「在右槽打开」是两条独立露面：前者只留一颗 44px 入口，后者摊一张窗口卡
  { command: 'core.dock/add-shortcut', kind: 'menu', when: 'blockMenuTarget', group: 'block/5-view', order: 56, layer: 'core' },

  /* ---- 删除：危险动作**同位** ---- */
  /**
   * **删除是一件事，一个入口**。页／标签／日记／字段定义／内容块都长在这里：
   * 它们差别只在「怎么删」（摘行还是库级软删＋换落点），那是机制，不是准入 ——
   * 准入只有一个变量（今天不删，见 `blockCanDelete`）。按身份分四行会让兼位的块
   * （页＋标签）出现两行做同一件事，且两行对同一个动作给出不同的守卫答案。
   *
   * 确认不在绑定层：它按**这次删的连带代价**算，没代价就不问 —— 见命令 handler。
   */
  { command: 'core.block/delete', kind: 'menu', when: 'blockMenuTarget && blockCanDelete', group: 'block/6-delete', order: 10, layer: 'core', keywords: [t('menu.kw.delete'), 'page', 'tag', 'journal'] },
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
  { command: 'core.editor/toggle-closure-selected-blocks', kind: 'menu', when: 'blockSelection', group: 'blockSel/1-basic', order: 17, layer: 'core', keywords: ['todo', 'task'] },
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
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 10, layer: 'core', label: t('menu.label.todo'), args: { type: 'closure' }, keywords: ['todo', 'task'], icon: 'lucide:square' },
  /**
   * 「取消待办」：`/待办` 把这一行变成任务之后，同一个入口能把它变回去 ——
   * 只在这一块真是任务时出现（同菜单那条判据），否则斜杠列表里永远挂着一个空动作。
   * 图标复用「虚线方框」：它是「这个方框可以被拿掉」的现成说法，不新增图标数据。
   */
  { command: 'core.editor/clear-closure', kind: 'slash', when: 'editorTextFocus && blockType == "closure"', group: 'slash/1-structure', order: 15, layer: 'core', icon: 'lucide:square-dashed' },
  // 分割线：没有正文的块，插完光标要落到它下面那一行（见 insertDividerAfter）
  { command: 'core.editor/insert-block', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 20, layer: 'core', label: t('menu.label.divider'), args: { type: 'divider' }, keywords: ['divider', 'hr', 'line', t('menu.kw.divider')], icon: 'lucide:minus' },
  { command: 'core.query/insert', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 30, layer: 'core', label: t('cmd.query.insert'), keywords: ['query', 'filter', 'where'], icon: 'lucide:list-filter' },
  // 自动化：身份块物化顶层（创建后跳过去写定义）；与查询块同一条「结构」段
  { command: 'core.automation/create', kind: 'slash', when: 'editorTextFocus', group: 'slash/1-structure', order: 32, layer: 'core', label: t('cmd.automation.create'), keywords: ['automation', 'rule', t('menu.kw.automation')], icon: 'lucide:zap' },
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
  /**
   * 两个**值轴入口**：0 元决定（toggle）已经排完，这里才轮到 1 元决定。
   * 主条只放「轴」（带当前值色标），7 个槽进二级 —— 值域在任何时刻只回答
   * 一个问题，不该占 14 个常驻位置。`pick-bg` 紧挨高亮一键，是它的逃逸口。
   */
  { command: 'core.anno/pick-ink', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 80, layer: 'core', icon: 'lucide:baseline', label: t('menu.label.ink'), axis: 'ink' },
  { command: 'core.anno/pick-bg', kind: 'selection', when: 'editorTextFocus && !selectionEmpty', group: 'sel/1-mark', order: 82, layer: 'core', icon: 'lucide:highlighter', label: t('menu.label.pickBg'), axis: 'bg' },
  // 写备注：与「转为引用」同组（都是「这一段的去处」）。判据同宽：单块纯文本选区才有锚
  { command: 'core.notes/create', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 25, layer: 'core', icon: 'lucide:message-circle', label: t('menu.label.writeNote') },
  /**
   * 选区 → 引用：与「复制为引文」同组（都是「这一段的去处」，不是格式）。
   * 只在单块纯文本选区上出现——跨块或夹着原子时「换成一枚引用」没有定义。
   */
  { command: 'core.editor/selection-to-ref', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 20, layer: 'core', icon: 'lucide:arrow-up-right', label: t('menu.label.selectionToRef') },
  /**
   * 逃逸口：一键直达仍是主路径（同名地址／建页，零决策），只有「想关联别的页或块」
   * 才展开搜索窗。两颗同组相邻 ⇒ 视觉上是「转为引用」和它的展开箭头，不是第三个动作。
   */
  { command: 'core.editor/pick-selection-ref', kind: 'selection', when: 'editorTextFocus && selectionRef', group: 'sel/2-ref', order: 22, layer: 'core', icon: 'lucide:chevron-down', label: t('menu.label.pickSelectionRef') },
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
  return `${b.command ?? b.submenu ?? ''}|${JSON.stringify(b.args ?? null)}`
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
  const keyOf = (b: Binding): string =>
    `${b.command ?? b.submenu ?? ''}|${b.group ?? ''}|${JSON.stringify(b.args ?? null)}`
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
      const hay = [b.label ?? '', b.command ?? b.submenu ?? '', ...(b.keywords ?? [])].join(' ').toLowerCase()
      return hay.includes(q)
    })
  }
  out.sort(
    (a, b) =>
      (a.group ?? '').localeCompare(b.group ?? '') ||
      (a.order ?? 100) - (b.order ?? 100) ||
      (a.command ?? a.submenu ?? '').localeCompare(b.command ?? b.submenu ?? ''),
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
    if (b.kind !== 'keymap' || !b.command) continue
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
    if (b.kind !== 'keymap' || !b.command) continue
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
