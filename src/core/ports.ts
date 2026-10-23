/**
 * 端口声明（**只有类型，零运行时代码**）。
 *
 * 为什么单独一个文件：`App` 是「命令 ↔ 装配层」之间的**唯一契约**，但它原先住在 `commands.ts` 里，
 * 于是 `commands.ts` 必须 `import type { BlockEditor } from '../view/editor.ts'` —— 一条 **core → view** 的
 * 层级反向边，只能靠 `arch-check [13]` 的白名单放行。
 *
 * 把契约提到这里之后：
 *   · `commands.ts` 只依赖本文件（core 层）
 *   · `main.ts`（装配层）实现它
 *   · **那条白名单可以删掉**，层级断言回到「不设例外」
 *
 * 本体能用什么，命令就能用什么；命令**只经这里**改状态。
 * 承 59 ：命令不知道 UI ——这里不许出现任何 DOM 类型（`HTMLElement`／`KeyboardEvent` …）；
 * 唯一放行的是 `DOMRect`，因为「菜单挂在哪个矩形旁边」是**命令参数的形状**，不是 DOM 操作。
 */
import type { BlockEditor } from '../view/editor.ts'
import type { BindingKind } from './bindings.ts'
import type { CtxKeys } from './index.ts'

export type Capability = 'read' | 'write' | 'admin' | 'plugin'
export type DemoState = 'seed' | 'empty' | 'sparse' | 'degraded' | 'boot'
export type PanelKind = 'context' | 'bindings' | 'shortcuts' | 'model'

/** 命令声明（纯语义）：**没有 `key`／`context`／`host`**（59 ） */
export interface CommandDecl {
  /** 命名空间名（`core/*` 保留，承 13／20 R2） */
  name: string
  /** 人话标签（菜单 / 命令面板默认显示名） */
  title: string
  capability: Capability
  undoable: boolean
  version: string
  /** 命令面板里的分组（纯展示） */
  category: string
  /** 搜索别名（demo：让「加粗 / bold」都能搜到） */
  keywords?: string[]
  /** `args` 的单一来源（demo 里写成最小 JSONSchema 形状） */
  args?: Record<string, unknown>
  /** 不进命令面板（编辑器内部键位） */
  hidden?: boolean
  expose?: { http?: { description: string }; cli?: { aliases: string[] } }
}

/** 菜单行（结构上与 `ui/layers.ts` 的 `Row` 一致；这里只声明命令侧需要的字段） */
export interface MenuRow {
  id: string
  label: string
  hint?: string
  icon?: string
  group?: string
  command?: string
  args?: unknown
  keyHint?: string
  disabled?: boolean
}

export interface MenuRequest {
  kind: BindingKind
  anchor: DOMRect | null
  title?: string
  prefix?: string
  query?: string
  ctx?: CtxKeys
  /** 每一项点击前先跑（例如斜杠菜单要先抹掉 `/查询词`） */
  before?: () => void
  /** 覆盖默认行为（演示状态菜单等） */
  onPick?: (row: MenuRow, decl: CommandDecl | undefined) => void
  /** 关掉时回调（斜杠菜单用来复位内部状态） */
  onClose?: () => void
}

/** 命令处理器拿到的「受管门面」 */
export interface App {
  ed: BlockEditor
  /* 页面 */
  listPages(): { id: string; title: string; icon: string; blocks: number }[]
  activePageId(): string
  newPage(): void
  openPage(id: string): void
  deletePage(id: string): void
  renamePage(id: string, title: string): void
  /** 把焦点交给页名（**UI 归装配层**：命令只说「要改名」，不碰 `document` — 59 ） */
  focusTitle(): void
  showRefPicker(): void
  /**
   * **打标签**＝给当前块加一格分类（`props._tags`；`ensureTag` 找不到标签块就先建）。
   *
   * ⚠️ 为什么整个动作要一门面方法、而不是 handler 里「建块 ＋ 写属性」两步：
   *    「找到或创建标签块」要**写森林**，而森林由装配层持有；handler 拿它不到。
   *    拆成两步又会让「建了标签但没写上归属」这种半截状态成为可能。
   */
  insertTag(tag: string): void
  /* 属性（属性是块第一公民；值在块上 `props[propId]`，一块一槽） */
  setPropValue(blockId: string, propId: string, value: unknown): void
  clearPropValue(blockId: string, propId: string): void
  /** 新建字段定义（可同时声明到该块）；返回 `propId`（空串＝没建） */
  createPropDef(blockId: string, label: string, kind: string): string
  /** 把已有定义加到块上：页/标签＝声明，普通块＝加一个空值槽 */
  addProp(blockId: string, propId: string): void
  /** 解除声明（**定义块与成员块上的值都不动**） */
  undeclareProp(blockId: string, propId: string): void
  /* 标签层级（属于 / 包含；一条边存在子标签的 `_parentTags`） */
  addTagParent(childId: string, parentId: string): boolean
  removeTagParent(childId: string, parentId: string): void
  /** 清理失效归属（父标签已被删） */
  pruneTagParents(childId: string): void
  /** 打开标签选择器（显示层级；选中＝在当前块插一条 tag 边） */
  showTagPicker(): void
  /* 角色：加/减一个机制位（非破坏性；页/标签可兼位） */
  addBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  /** 打开别名编辑器（名字、露面、显示模式）——纯 UI，落在装配层 */
  openAliasEditor(blockId: string): void
  /** 打开字段声明（页/标签能声明哪些属性）——纯 UI，落在装配层 */
  openFieldsEditor(blockId: string): void
  /**
   * 写块的类型（`_type`）。
   *
   * ⚠️ 类型 id **不由这里校验**：不认识的值照写，降级是读侧的事 ——
   *    否则插件或更新版本写的类型会在这一层被抹掉。
   */
  setBlockType(blockId: string, typeId: string): boolean
  /**
   * 删一个行内原子（引用 / 标签）。
   *
   * ⚠️ 摘标签可能触发「要不要清理它带来的值」的提示 —— 所以删除入口在门面，
   *    不是组件直接调编辑器（编辑器不知道属性与提示）。
   */
  removeAtom(atomId: string): void
  /* 日记（日期只读、一天一个、物化幂等） */
  /** 回到今日（`date` 省略＝本地今天）；没有就**幂等物化**一个 */
  journalToday(date?: string): void
  /** 相对当前日期前后翻（`days` 可正可负）；同样幂等物化 */
  journalShift(days: number): void
  /* zoom（块可任意 zoom in；zoom 是视图配置，不是新对象） */
  /**
   * 聚焦到此块：中心槽以 `source=block-ref` ＋ `scope:"subtree"` 渲染它。
   *
   * `feed` 只由历史回放使用：还原「当时看的是日记流」这一形态；
   * 普通聚焦永远只装目标块自己。
   */
  zoomTo(id: string, feed?: boolean): void
  /** 退回该容器所在的顶层块（面包屑的「根」） */
  zoomOut(): void
  /**
   * **导航历史**：中心槽「当前对象」的先后（不是 undo/redo 的模型快照栈）。
   *
   * 链接点击、页/日记打开、zoom、面包屑都会记一条；左右槽显式钉住、不跟随导航。
   * 历史里指向的块可能已被删除 ⇒ 跳过继续找，不把用户卡在一个不存在的落点。
   */
  historyBack(): boolean
  historyForward(): boolean
  /* 视图 */
  /** 三档直选（菜单用；`toggleTheme` 是给键位/常驻按钮的循环） */
  setTheme(mode: string): void
  toggleTheme(): void
  /** 开/关一个槽（槽的开关归槽自己；`side` 只有左右，中心槽常驻） */
  toggleDock(side: 'left' | 'right'): void
  /* 浮层 / 提示 */
  toast(text: string, kind?: 'ok' | 'warn' | 'info'): void
  showMenu(req: MenuRequest): void
  showPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null): void
  closeLayers(): void
  showPanel(kind: PanelKind): void
  copy(text: string, label?: string): void
  /* 演示与诊断 */
  loadState(state: DemoState): void
  setVirtualize(on: boolean, radius?: number): void
  runImeProbe(): { fired: number; seq: string[] }
}

export type Handler = (args: Record<string, unknown>, app: App) => boolean | void
