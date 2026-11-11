/**
 * 端口声明（**只有类型，零运行时代码**）。
 *
 * 为什么单独一个文件：`App` 是「命令 ↔ 装配层」之间的**唯一契约**，但它原先住在 `commands.ts` 里，
 * 于是 `commands.ts` 必须 `import type { BlockEditor } from '../../view/editor/editor.ts'` —— 一条 **core → view** 的
 * 层级反向边，只能靠 `arch-check [13]` 的白名单放行。
 *
 * 把契约提到这里之后：
 *   · `commands.ts` 只依赖本文件（core 层）
 *   · `main.ts`（装配层）实现它
 *   · **那条白名单可以删掉**，层级断言回到「不设例外」
 *
 * 本体能用什么，命令就能用什么；命令**只经这里**改状态。
 * 命令不知道 UI ——这里不许出现任何 DOM 类型（`HTMLElement`／`KeyboardEvent` …）；
 * 唯一放行的是 `DOMRect`，因为「菜单挂在哪个矩形旁边」是**命令参数的形状**，不是 DOM 操作。
 */
import type { BlockEditor } from '../../view/editor/editor.ts'
import type { CtxKeys } from '../index.ts'
import type { UndoKind } from '../model/undo.ts'
import type { QueryNode, QuerySpec } from '../query/query.ts'
import type { Cardinality, ChoiceScope, UiPosition } from '../props/props.ts'
import type { SecLayout } from '../query/feed.ts'
import type { MountHost } from '../views/mount.ts'
import type { TabsDirection, ViewConfig } from '../views/view.ts'
import type { ViewOwnerRef } from '../views/view-owner.ts'
import type { OpenOpts, OpenAction } from '../views/open.ts'

export type Capability = 'read' | 'write' | 'admin' | 'plugin'
export type FixtureName = 'seed' | 'empty' | 'sparse' | 'degraded' | 'boot'
export type PanelKind = 'context' | 'bindings' | 'shortcuts' | 'model'

/**
 * **一条属性挂到块上的两种去处**（不是「按块类型推断」，是调用方声明）。
 *
 *   · `own`      —— 写进这一块自己的值槽（`props._ownProps`）：**我**有这条属性；
 *   · `declared` —— 写进这一块的成员声明清单（`props._fieldDefs`）：**我的成员**有这一格。
 *
 * ⚠️ 为什么必须显式：页/标签**两个都要**（它既可以是成员、又有成员），
 *    用「有没有 page/tag 露面」去猜会让标签块永远加不了自己的属性（真踩过）。
 */
export type PropTarget = 'own' | 'declared'

/**
 * 新建属性时对「已有同名同 kind 的定义」怎么办。
 *
 * · `reuse`（缺省）——复用那条定义（误复用可以无损改回，误分槽要迁数据）；
 * · `new`——跳过同名检查，新建**第二个 `propId`**（同名不同义是合法的：
 *   身份是 id，不是名字）。
 *
 * kind 不同时永远不复用：类型住在定义块上、全库一份，复用等于把别人的类型改掉。
 */
export type PropCreateMode = 'reuse' | 'new'

/** 命令声明（纯语义）：**没有 `key`／`context`／`host`**——落点归绑定表 */
export interface CommandDecl {
  /** 命名空间名（`core/*` 保留给系统命令） */
  name: string
  /** 人话标签（菜单 / 命令面板默认显示名） */
  title: string
  capability: Capability
  undoable: boolean
  version: string
  /** 命令面板里的分组（纯展示） */
  category: string
  /** 搜索别名（让「加粗 / bold」都能搜到） */
  keywords?: string[]
  /** `args` 的单一来源（最小 JSONSchema 形状） */
  args?: Record<string, unknown>
  /** 不进命令面板（编辑器内部键位） */
  hidden?: boolean
  /**
   * 这个命令可以作为一个「小卡」摆在槽里。
   *
   * 只有带它的命令才进「添加快捷」画廊——这是一份**策展过的**集合，
   * 不是「所有命令」。危险命令（删页/删块）和依赖光标的命令（加粗/缩进）
   * 不写它，就不会被摆成一个一键入口。
   *
   * 图标是宿主的词汇（`lucide:<name>`），插件不能自带 path：未知名字由
   * `view/icons.ts` 降级成占位，不会静默消失。
   */
  tile?: { icon: string }
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
  /** 打开哪一种浮层——**不是绑定种类**（面板枚举命令表，不经绑定表） */
  kind: 'palette' | 'menu' | 'slash'
  anchor: DOMRect | null
  title?: string
  prefix?: string
  query?: string
  ctx?: CtxKeys
  /**
   * **调用方现算的追加项**（排在绑定解析出的行之后）。菜单的主体来自绑定表
   * （静态声明 ＋ `when` 过滤）；少数入口的**参数**只有打开那一刻才知道
   * （例如「移除这次露面」的露面块 id）——它们不是声明，不该为了传一个 id
   * 去发明一条假的 ctx 键。
   */
  extraRows?: MenuRow[]
  /** 每一项点击前先跑（例如斜杠菜单要先抹掉 `/查询词`） */
  before?: () => void
  /** 覆盖默认行为（演示状态菜单等） */
  onPick?: (row: MenuRow, decl: CommandDecl | undefined) => void
  /** 关掉时回调（斜杠菜单用来复位内部状态） */
  onClose?: () => void
  /** 这次打开的触发元素（点/右键的那个节点）；给了它，同一处再触发一次＝收起（toggle） */
  trigger?: HTMLElement
}

/** 命令处理器拿到的「受管门面」 */
export interface App {
  ed: BlockEditor
  /**
   * **把一组同步写／命令收进同一个撤销条目**（一次 ⌘Z 全回）。
   *
   * 这是「显式命令分组」在本模型里的对应物：分组的是**历史**，不是事务。
   * 真正「要么全成要么全败」的批量模型写在 `Tx`（`d.run(tx => …)`）那一层；
   * 这里只保证「这一段里发生的所有写入，撤销时算一步」。
   *
   * ⚠️ 嵌套安全：内层 `runGroup` 并入外层，不会重置外层的捕获袋。
   * ⚠️ `fn` 抛错时已经发生的写入仍会收成一个可撤销条目（不做自动回滚）；
   *    要原子性请在 `fn` 里用一笔 `tx`。
   */
  runGroup<T>(fn: () => T, kind?: UndoKind): T
  /* 页面 */
  listPages(): { id: string; title: string; icon: string; blocks: number }[]
  activePageId(): string
  newPage(): void
  openPage(id: string): void
  deletePage(id: string): void
  /**
   * 永久清除回收站条目（整棵子树级联，不可恢复、不进撤销栈）。
   *
   * @returns 实际清除的块数（含级联的后代）；0 ＝ 没有可清的。
   *          op 的落盘与重画都在这条门面里收口，handler 只管说「做了多少」。
   */
  purgeTrash(ids: readonly string[]): number
  /** 删除标签块（整棵子树软删，回收站可恢复）；不是「取消标签」——那是摘露面位 */
  deleteTag(id: string): boolean
  renamePage(id: string, title: string): void
  /** 把焦点交给页名（**UI 归装配层**：命令只说「要改名」，不碰 `document` — 59 ） */
  focusTitle(): void
  showRefPicker(): void
  /**
   * **打开日期选择器**（`core.editor/insert-date-ref` 不带 `date` 时的那条路）。
   *
   * 与 `showRefPicker` 同一条理由：选择日期要一个浮层，而命令 handler 不碰 DOM。
   * 选中之后的插入仍回命令面（带 `date` 那一支）——选择器只回答日期，
   * 「物化那天 ＋ 插引用」不在这里。
   */
  showDatePicker(): void
  /** 选一个块作为露面的源（锚在 `at` 那一行上）；插入位置也在 `at` 后面 */
  showEmbedPicker(at: string): void
  /** 选一种看法来插（`core.view/insert` 不带 `kind` 时）：只列 children 源兼容的非缺省看法 */
  showViewPicker(at: string): void
  /** 读剪贴板文本（粘贴为… 用；命令层不直接碰浏览器全局） */
  readText(): Promise<string>
  /**
   * 写剪贴板的多味载体：`text` 给外部应用，`html` 尾部的注释载荷给本应用
   * （引用/剪切意图），`clip` 同时更新会话账。命令层不直接碰浏览器全局。
   */
  copyFlavors(
    f: { text: string; html?: string; clip?: { ids: readonly string[]; move?: boolean; anchor?: string } },
    label?: string,
  ): void
  /**
   * 读剪贴板的引用味＋正文味（块选区态的粘贴用：那边没有光标，走命令路径）。
   * 解析链与 paste 事件同序：HTML 注释载荷 → 会话对账 →（没有就）纯文本。
   */
  readFlavors(): Promise<{ refs: { ids: string[]; move?: boolean; anchor?: string } | null; text: string }>
  /**
   * **露面块的结构动作**：落在**中心编辑器**上，而不是「此刻焦点所在的那一台」。
   *
   * 为什么：焦点可能在一面镜像的岛里（它的装载只有源那一棵），而要被改的露面块
   * 在正文里。用活动编辑器会「找不到 ⇒ 什么都没发生」，且不报错。
   */
  insertEmbed(at: string, targetId: string, view: 'mirror' | 'table'): string | null
  expandAtomToEmbed(atomId: string, view: 'mirror' | 'table'): string | null
  removeEmbed(blockId: string): boolean
  /**
   * **用系统浏览器打开一个外链**（`core.link/open` 的落点）。
   *
   * 为什么「打开」要成为门面上的一个方法：命令 handler **不许碰 `window`**
   * （`arch-check [18]`：命令面也是机器接口，HTTP／CLI 会走到它），
   * 而打开外部地址这件事只有宿主做得到。
   *
   * 协议白名单（`http:`／`https:`）由 `core/link.ts` 的 `checkExternalUrl` 判——
   * 调用方可以先自己判一遍以便给用户一句人话，但**判据只有那一份**。
   *
   * @returns 真的把请求发出去了才 `true`（空串／写得不完整／协议不在白名单 ⇒ `false`）
   */
  openExternal(url: string): boolean
  /**
   * **打开插入外链的输入框**（`core.editor/insert-link` 不带 `url` 时的那条路）。
   *
   * 与「选图片」同一条理由：这一步要向用户**要一句话**（URL 与显示名），
   * 而命令 handler 不许碰 DOM ⇒ 浮层归装配层。
   */
  showLinkComposer(): void
  /**
   * **选一张图片并插到当前光标处**（`core.editor/insert-image` 的入口）。
   *
   * 为什么落点在门面而不是命令 handler：入库是**异步**的（算 hash、写字节、读尺寸），
   * 而命令 handler 是同步返回 `handled` 的。真正要做的是：
   * 捕获落点 → 等字节落库 → 按捕获点插 run。这段时序只有装配层管得了。
   *
   * 失败（拒绝的类型／超限／解码失败／块被删）都给用户一句明确文案，不静默。
   */
  pickImage(): void
  /**
   * 把一份字节入库并按**捕获到的落点**插一枚资产 run。
   *
   * `point` 是用户按下那一刻的光标位置：入库期间光标会动、块甚至会被删，
   * 所以不能「插到当前光标」——那会把图插到用户后来移到的地方。
   * 省略 `point` ⇒ 现取当前光标（粘贴路径在事件里已经先捕获，正常都会传）。
   *
   * @returns 真的插入了才 `true`；块没了／越界／字节不合法 ⇒ `false`（一个字节都不写）
   */
  insertAssetBlob(blob: Blob, label: string, point?: { blockId: string; offset: number }): Promise<boolean>
  /**
   * **打标签**＝给当前块加一格分类（`props._tags`；`ensureTag` 找不到标签块就先建）。
   *
   * ⚠️ 为什么整个动作要一门面方法、而不是 handler 里「建块 ＋ 写属性」两步：
   *    「找到或创建标签块」要**写森林**，而森林由装配层持有；handler 拿它不到。
   *    拆成两步又会让「建了标签但没写上归属」这种半截状态成为可能。
   */
  insertTag(tag: string): void
  /**
   * **把一处提及转成引用**（提及栏片段行的高亮按钮是唯一入口）。
   *
   * `start`/`end` 是 plain 偏移区间（渲染端从派生值里拿的）。写前复核那一区间
   * 仍是目标**此刻**的名字：渲染与点击之间正文可能已经变了——复核不过就
   * 一句实话，一个字节不写。转换是一条内容写，一次撤销。
   *
   * @returns 真的转换了才 `true`
   */
  convertMention(blockId: string, to: string, start: number, end: number): boolean
  /**
   * **选区转引用**（划选气泡那一颗）。
   *
   * 选中的是一串纯文本：同名地址已经存在 ⇒ 指向它；不存在 ⇒ 建一个页块再指向它。
   * 建目标与替换正文在**同一笔事务**里，一次撤销回到原文（也会撤掉顺手建的页）。
   *
   * @returns 真的转换了才 `true`
   */
  convertSelectionToRef(): boolean
  /* 属性（属性是块第一公民；值在块上 `props[propId]`，一块一槽） */
  setPropValue(blockId: string, propId: string, value: unknown): void
  clearPropValue(blockId: string, propId: string): void
  /**
   * 新建字段定义，并按 `target` 挂到该块上；返回 `propId`（空串＝没建）。
   *
   * `target` 必填、不许猜：写自己的值槽与写「成员的声明清单」是**两件事**，
   * 用「这个块有没有 page/tag 露面」去推断会让页/标签永远走不到「给自己加一条」。
   */
  createPropDef(
    blockId: string,
    label: string,
    kind: string,
    target: PropTarget,
    mode?: PropCreateMode,
  ): string
  /**
   * 把已有定义挂到块上：`own` ＝ 这一块自己的值槽，`declared` ＝ 声明给成员。
   *
   * ⚠️ 两个目标写的是两个不同的槽（`_ownProps` / `_fieldDefs`），不共用一条写路径。
   */
  addProp(blockId: string, propId: string, target: PropTarget): void
  /** 解除声明（**定义块与成员块上的值都不动**） */
  undeclareProp(blockId: string, propId: string): void
  /* 选项（`select`）：选项＝定义块的直接子块，值＝选项块 id */
  /** 给定义加一个选项；返回新选项块的 id（空串＝没写）。`scope` 缺省全局 */
  addChoice(defId: string, label: string, scope?: ChoiceScope): string
  /** 改选项名（**零值迁移**：值存的是 id） */
  setChoiceLabel(choiceId: string, label: string): void
  /** 重排选项：把它移到 `beforeId` 之前（空串＝末尾） */
  moveChoice(defId: string, choiceId: string, beforeId: string): void
  /** 写选项的可见范围（三态；形状不认识则不写） */
  setChoiceScope(choiceId: string, scope: ChoiceScope): void
  /** 写选项的图标（`lucide:<name>` 或字面文本；空串＝无图标） */
  setChoiceIcon(choiceId: string, icon: string): void
  /**
   * 写/摘勾选框映射（`_check {on, off}`），可选标成任务状态（`_use: 'status'`）。
   *
   * `null` ＝ 摘掉；`status: true` 时库级唯一（已有另一条就拒绝）；
   * 多值属性不能有 `_check`。
   */
  setChoiceCheck(defId: string, spec: { on: string; off: string; status: boolean } | null): void
  /**
   * 切换单值/多值（只对 `select`）。
   *
   * 切回 `one` 时若仍有块选了多个值 ⇒ **拒绝**并给一句提示，不静默只显示第一个。
   */
  setChoiceCardinality(defId: string, cardinality: Cardinality): void
  /** 写定义块的快捷入口位置（`block-left` ＝ 块左侧图标；`panel` ＝ 只留属性面板） */
  setUiPosition(defId: string, position: UiPosition): void
  /**
   * 写/摘「子块行内属性显示」声明（`_childProps`）：父块声明「我的直接子块行内
   * 显示这一格」。字段不继承、值不落子块——只是显示声明，撤掉零残留。
   */
  setChildProps(blockId: string, propId: string, on: boolean): void
  /**
   * **打开子块行内属性的选择器**（`core.props/child-props-menu` 的落点）。
   * 多选清单：引擎两项＋全部属性定义；勾选态来自父块的 `_childProps`。
   * 浮层归装配层（命令 handler 不碰 DOM，与 showRefPicker 同一条理由）。
   */
  showChildPropsPicker(blockId: string): void
  /** 删一个选项（**普通软删**：值保留，恢复后自动解析回来） */
  deleteChoice(choiceId: string): void
  /* 归属边（属于／包含；一条边存在子块的 `_belongsTo`，任何块都能配） */
  addBelongsTo(childId: string, parentId: string): boolean
  removeBelongsTo(childId: string, parentId: string): void
  /** 清理失效归属（上级**真的没了**；在回收站里的不清——复活要自愈） */
  pruneBelongs(childId: string): void
  /** 打开标签选择器（显示层级；选中＝在当前块插一条 tag 边） */
  showTagPicker(): void
  /**
   * 「移动到…」：弹目标选择器（页 ＋ 标签块）。
   *
   * 与 `insert-page-ref` 共用同一个选择器组件，只是选中之后做的是**搬块**。
   * ⚠️ 目标集合按**身份**找（页/标签），不按位置——位置不是「可不可搬进去」的判据。
   */
  showMovePicker(blockId: string): void
  /**
   * 把一块（连子树）搬到目标容器末尾。自环/原地不动由命令层先判并给提示，
   * 这条只管「搬」——一条事务一条 op。
   */
  moveBlockTo(blockId: string, targetId: string): void
  /* 露面：加/减一格标记（非破坏性；页/标签各自独立、可兼位） */
  addBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  removeBlockRole(blockId: string, role: 'page' | 'tag'): boolean
  /**
   * **提取为页**：补 `page` 露面 ＋ 搬到森林顶层 ＋ 原位置留一枚引用。
   *
   * 与 `addBlockRole(...,'page')` 的区别只在位置：那条原地不动，这条显式搬家。
   * 一次事务一条撤销；原块 id 不变，引用不受影响。
   */
  extractToPage(blockId: string): boolean
  /** 打开别名编辑器（名字、露面、显示模式）——纯 UI，落在装配层 */
  openAliasEditor(blockId: string, autofocus?: boolean): void
  /**
   * **看这一块的属性**：打开属性抽屉（整高右滑的任务面）。
   *
   * 显式入口的落点：**不换中心、不动侧槽、不入历史**——用户点的是「看属性」，
   * 不是「换个屏」。抽屉钉在这一块上（不跟焦点），做完即走；要常驻是另一件事，
   * 归检视卡与窗口卡。zoom / 打开页 / 点链接是导航，永远不替用户改侧栏的开合。
   */
  openPropertiesDrawer(blockId: string, focusPropId?: string): void
  /* 挂载区（块底面板）：写哪一格由 `MountHost` 判，命令层不自己判「是不是日记」 */
  /**
   * 加一栏 **local tab**：这一栏自己拥有条件与视图。**不建块**（块数一个都不变）。
   *
   * 默认路径就是它：随手加一栏不该在树里多一个对象，也没有「删块 tab 怎么办」。
   * 没给视图时不补命名视图 ⇒ 缺省大纲；要别的看法由调用方显式传 `views`。
   * @returns 新栏的稳定 id（写不进去 ⇒ `''`）
   */
  addLocalTab(
    host: MountHost,
    label: string,
    spec: QuerySpec,
    views?: ViewConfig[],
    activeView?: string,
    /** 指定栏 id（占用内置栏稳定 id ⇒ 原地替换那一栏）；已占用 ⇒ 忽略，回退随机 id */
    id?: string,
  ): string
  /** 摘一栏（`tabId` 是稳定 id，不是数组下标）。**不删任何块** */
  removeMountTab(host: MountHost, tabId: string): boolean
  /** 改栏名（只有 local 有名字） */
  renameMountTab(host: MountHost, tabId: string, label: string): boolean
  /** 挪一栏（拖拽排序）：顺序＝数组位，只动 local 那几栏 */
  moveMountTab(host: MountHost, tabId: string, targetId: string, place: 'before' | 'after'): boolean
  /** 换这一栏选的视图（配置在 local tab 自己身上） */
  setMountTabView(host: MountHost, tabId: string, view: string): boolean
  /** **固定派生栏**（引用/成员/同类/提及 → local）：把现算的条件变成一栏可编辑的查询 */
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
  /**
   * 复盘＝**带参的日记流**（同一个装载路径换 `days`／排列），不是并列的第二种视图。
   * 窗口里没写过的天渲染空壳格子，落笔才物化。
   */
  journalReview(days: number): void
  /** 在复盘的空天格子里落笔：物化那一天、按同一参数重开、光标落进那一天 */
  journalShellWrite(date: string): void
  /**
   * 删除一天（软删，回收站可恢复）。再打开这一天会**复活同一块**；
   * 今天删不掉（冷启动会把它物化回来）。
   */
  deleteJournal(id: string): boolean
  /** 设定日记流的段排列（设备偏好；复盘的排列切换入口将来接这里） */
  journalFeedLayout(layout: SecLayout): void
  /* zoom（块可任意 zoom in；zoom 是视图配置，不是新对象） */
  /**
   * 聚焦到此块：中心槽以 `source=block-ref` 渲染它（以它为根、含它自身）。
   *
   * `feed` 只由历史回放使用：还原「当时看的是日记流」这一形态；
   * 普通聚焦永远只装目标块自己。
   */
  zoomTo(id: string, feed?: boolean, restore?: 'saved' | 'none'): void
  /**
   * **在一个新 tab 打开块/页**（⌘+点击引用/块标、命令面）。
   *
   * 同一个视图已经开着 ⇒ 切到那一张 tab，不重复开（一个视图只开一张 tab）。
   */
  openInNewTab(id: string, feed?: boolean): boolean
  /**
   * **打开一个块的唯一落点路由**（点击/键盘入口共用）。
   *
   * 与 `zoomTo`／`openInDock`／`openInNewTab` 不是四种导航语义，而是把它们组合成
   * 一条策略：`place` 从 `openActionOf(mods)` 来；`tabWide` 是 `tab` 的一次性加强
   * （打开后顺手进宽屏，档位仍住窗口）；`center:'keep'` 给导航面（不抢焦点），
   * 缺省 `'focus'` 给内容面（聚焦到这一块）。命令面仍可直调底层方法，互不替代。
   */
  openBlock(id: string, place?: OpenAction, opts?: OpenOpts): void
  /**
   * **打开某一天的日记**（日历/复盘空天格子的唯一入口）。
   *
   * 与 `openBlock(journalId(date))` 的区别：那一天可能还不存在，而 `openWindow` 对
   * 不存在的块会静默拒绝。这里先按日期**幂等物化**（在回收站则复活），再按 `place`
   * 分流——物化只发生在日记命令这一处，UI 不自己拼 `journalId`。
   */
  openJournal(date: string, place?: OpenAction): void
  /**
   * **按日期拿那天的 journal 块 id**（没有就幂等物化；在回收站则复活）。
   *
   * 「引用日期」要与「打开那天」共用同一份物化口径：两处各写一遍 `journalId` 拼装，
   * 就会出现两个「哪天是哪个块」的答案。给 `core.editor/insert-date-ref` 用——
   * 引用的目标必须真的存在，dangling 日期引用不留给用户修。
   */
  ensureJournal(date: string): string
  /** 新 tab（今日）；今日已经开着就切过去 */
  newTab(): boolean
  /** 关 tab（省略 id ＝ 当前）；关掉最后一张会补一张今日 */
  closeTab(id?: string): boolean
  /**
   * 打开一张**表面 tab**（派生面／工具面）。按 kind 去重：同一张面全局一张，已开 ⇒ 切过去。
   *
   * 表面是**终点面**：没有导航历史、没有位置恢复，关闭即回。id 能不能开由两张
   * 目录（派生卡目录 ∧ 中心接得住的子集／工具面目录）守卫；不认识的 id 返回 `false`。
   */
  openSurface(ref: { kind: 'derived' | 'utility'; id: string }): boolean
  nextTab(): boolean
  prevTab(): boolean
  /** 退回该容器所在的顶层块（面包屑的「根」） */
  zoomOut(): void
  /**
   * **导航历史**：中心槽「当前对象」的先后（不是 undo/redo 的撤销栈）。
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
  /**
   * 档位轴（常规→宽屏→全屏）：沿轴进/退一档；已在端点则原地不动。
   *
   * 档位是**叠在设备偏好上的一层**：进入不写 prefs，退出自动回到进入前的样子；
   * 档位本身只住窗口（任务态，不是偏好），不跨会话恢复。
   * 宽屏＝双槽收起＋阅读/视图宽度上限放开；全屏＝再藏抬头与 tab 条。
   *
   * @returns 真的换了一档才 `true`（到端点 ＝ `false`）
   */
  axisStep(dir: 1 | -1): boolean
  /**
   * 档位轴**直接落到某一档**（「全屏打开」这类一步到位的入口用它）。
   *
   * 与 `axisStep` 同一条 overlay 判据：不写 prefs、退出口照常；已在目标档 ＝ `false`。
   */
  axisTo(mode: 'wide' | 'full'): boolean
  /**
   * **在侧槽打开一个块**（一张窗口）：确保槽开着、把块放进 `cards`、滚到它。
   *
   * 与 `openPropertiesDrawer` 的区别：那个是瞬态任务面（不动侧槽）、这个在侧槽
   * **常驻**一张窗口（确保槽开着、入 `cards`）；
   * 与 `zoomTo` 的区别：zoom 是导航，这个是视图配置。
   * 同一个块全局最多一个窗口（已在另一侧则移过来）。
   */
  openInDock(id: string, side?: 'left' | 'right'): void
  /**
   * **把一个块已打开的窗口置顶**（移到它那一槽窗口组的最前，并滚到它）。
   *
   * 置顶是动作不是状态：位置住 `cards` 的序，常驻（pin）是另一位。目标没开着的窗口 ⇒ false。
   */
  topWindow(id: string): boolean
  /**
   * **在侧槽加一颗指向该块的快捷小卡**（设备状态，不进撤销）。
   *
   * 与 `openInDock` 是两条独立露面：同一块可以同时有窗口卡和快捷卡，
   * 所以这条只加 `{kind:'shortcut'}`，不碰那张窗口卡，也不替用户关掉它。
   */
  addShortcut(id: string, side?: 'left' | 'right'): boolean
  /* 视图配置（`_views` / `_activeView`；视图不是实体，配置住在**拥有者**上） */
  /**
   * 新建一个视图并设为激活，返回它的 id（空串＝没建）。
   *
   * 表格的列在这里算**一次**并写进配置：算完就不随结果漂移（否则列宽/列序会自己动）。
   * `owner` 可以是块，也可以是 local tab —— 「配置住哪」由拥有者回答。
   */
  addView(owner: ViewOwnerRef, kind: string): string
  /** 切换激活视图（`''` ＝ 这一份源的默认看法，删掉 `_activeView` 而不是存一个 outline） */
  setActiveView(owner: ViewOwnerRef, viewId: string): boolean
  /** 删一个视图：只动配置，记录一个字节不碰；删的是激活那个就去相邻项 */
  removeView(owner: ViewOwnerRef, viewId: string): boolean
  /** 给当前激活的视图改名（空名 ⇒ 回到按类型的默认名） */
  renameActiveView(owner: ViewOwnerRef, name: string): boolean
  /** 新建一行＝在容器末尾插一个子块（查询源没有这一行：它的行是命中） */
  viewInsertRow(owner: ViewOwnerRef, blockId?: string): boolean
  /** 删除一行＝软删那个子块（可恢复） */
  viewDeleteRow(rowId: string): boolean
  /**
   * **表头排序＝显示排序**：只写 `view.table.sort`（或结构映射表的 `listTable.sort`）。
   *
   * ⚠️ 不再写查询的成员顺序（`QuerySpec.sort`）：那是「取哪些、按什么序」，
   *    由构建器编辑。点表头不该换一批行。`dir === ''` ＝ 清掉。
   */
  viewSetSort(owner: ViewOwnerRef, viewId: string, by: string, dir: string): boolean
  /**
   * 写**表格的列清单**（整份替换，不逐列改）：`columns` 是原始数组，形状校验在读路径那一份
   * （`columnsOfRaw`）——标题列永远在第一位，其余按 key 去重。只认表格视图。
   */
  viewSetColumns(owner: ViewOwnerRef, viewId: string, columns: unknown): boolean
  /**
   * 写**分组键**（记录视图共用的顶层配置位）：`groupBy === ''` ＝ 清掉。
   *
   * 分组是视图配置，不是查询的一部分：改它不重查、不改成员，只是这批记录换一种摆法。
   *
   * `structure === true` ＝ **按一级子块分组**（组＝容器的直接子块、记录＝它的孩子）；
   * 与按值分组互斥：写一边就清另一边。
   */
  viewSetGroup(
    owner: ViewOwnerRef,
    viewId: string,
    groupBy: string,
    groupOrder?: readonly string[],
    structure?: boolean,
  ): boolean
  /** 卡片的封面：`first-asset`（有图才显示）／`none`（纯文字卡） */
  viewSetCover(owner: ViewOwnerRef, viewId: string, cover: 'first-asset' | 'none'): boolean
  /**
   * 页签的**切换条方向**：`horizontal`（横排，缺省）／`vertical`（纵排）。
   * 只对页签视图有意义；别的 kind 当场拒绝。
   */
  viewSetTabsDirection(owner: ViewOwnerRef, viewId: string, direction: TabsDirection): boolean
  /**
   * 写一张视图的**切片**：与源的基础条件 AND 叠加（不替换），`null` ＝ 清掉。
   *
   * 只对 query 源有效；别的源当场拒绝（写进去也会被读路径丢掉）。
   */
  setViewFilter(owner: ViewOwnerRef, viewId: string, filter: QueryNode | null): boolean
  /** 打开**切片构建器**：与「视图… → 编辑切片…」同一台浮层（点抬头 chip 也走这里） */
  openViewSlice(owner: ViewOwnerRef, viewId: string, anchor?: DOMRect | null): void
  /** 「视图…」菜单：列出默认看法 ＋ 已有视图 ＋ 新建…（**纯 UI**，落在装配层） */
  openViewMenu(owner: ViewOwnerRef, anchor?: DOMRect | null, trigger?: HTMLElement): void
  /** 派生栏（引用／提及）的看法下拉：只有三档（大纲／列表／表格），写设备状态不建视图 */
  openDerivedViewMenu(anchor: DOMRect | null, current: string, onPick: (kind: string) => void): void
  /** 打开**条件构建器**（一个浮层；草稿改在本地，点「应用」才写一次） */
  openQueryBuilder(owner: ViewOwnerRef): void
  /**
   * 写**条件**（构建器／JSON 的落点）。
   *
   * ⚠️ 只写条件，不写结果 —— 结果由每个表面实例自己冻结，
   *    条件变了（⇒ `specKey` 变）那一处会自动重算，不会出现「旧条件 ＋ 新结果」。
   */
  setQuerySpec(owner: ViewOwnerRef, spec: QuerySpec): boolean
  /** 新建查询块（内容对象：能被引用、能进回收站） */
  createQuery(name: string, spec: QuerySpec, parentId?: string): string
  /**
   * **在当前位置建一个查询块**（`core.query/insert` 的落点）。
   *
   * 落点与「插入其他块」同一套：**空块 ⇒ 原地变成查询块**；有正文 ⇒ 建在它**后面**
   * （section 根没有兄弟位 ⇒ 首个子块）。两种落点都在后面留一个可编辑空块做落点，
   * 结构写与落点空块在同一笔事务里 ⇒ 一次撤销。
   */
  insertQueryBlock(blockId?: string): string
  /**
   * **斜杠「插入看法」的落点**：建（或空块原地转）一个预配看法的容器块，返回块 id。
   *
   * 看法配置随新块的初始 props 一次落库（与查询块同形）⇒ 结构与配置同一笔事务、
   * 一次撤销。`kind` 不认识时返回空串（选择器只列兼容的 kind，正常流到不了这里）。
   */
  insertViewBlock(blockId: string, kind: string): string
  /** 改一次露面选的视图（`core.embed/set-view` 的落点） */
  setEmbedView(blockId: string, view: string): boolean
  /* 浮层 / 提示 */
  toast(text: string, kind?: 'ok' | 'warn' | 'info'): void
  /**
   * 打开全文检索（⌘K）。
   *
   * 它不是一个查询块，也不是命令面板：输入的是**正文关键词**，结果是块。
   * 首版独立成一层，不塞进 `_query`（查询求值是同步的，FTS 是异步的）。
   *
   * `place` ＝ 挂载形态（与块打开同一套落点语言）：缺省＝⌘K 浮层；
   * `'dock'` ＝ 搜索卡住进右槽；`'tab'` ＝ 中心 tab。同一份 `SearchFace`。
   */
  openSearch(place?: 'center' | 'dock' | 'tab' | 'tabWide'): void
  showMenu(req: MenuRequest): void
  showPopover(render: (host: HTMLElement) => void, anchor: DOMRect | null): void
  closeLayers(): void
  showPanel(kind: PanelKind): void
  copy(text: string, label?: string): void
  /* 演示与诊断 */
  loadState(state: FixtureName): void
  /**
   * **备份当前字节并重建本地库**（演示数据）。
   *
   * 这是只读态的出路，不是常规清库入口：实现必须先备份，备份失败就放弃覆盖。
   * 异步在实现里收尾（按钮已经退场，不需要等它）。
   */
  resetWorkspace(): void
  /**
   * **清空成真空库**（只有今天一行，没有演示内容）。
   *
   * 同样是「先备份、失败就放弃覆盖」：它与 `resetWorkspace` 的差别只在换成什么内容，
   * 以及要不要把每库的视图状态一起回默认（换的是整份库，旧 id 全作废）。
   */
  blankWorkspace(): void
  setVirtualize(on: boolean, radius?: number): void
  runImeProbe(): { fired: number; seq: string[] }
}

export type Handler = (args: Record<string, unknown>, app: App) => boolean | void
