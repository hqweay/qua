/**
 * 各域命令工厂共用的宿主能力（`PageDeps` 及其它 deps 接口）。
 *
 * **为什么单独一份**：这些接口描述的是「门面能用什么」，不是「某一域怎么实现」。
 * 放进任何一域都会让别的域为了拿到接口去 import 那一域的实现——拆开之后，
 * 域与域之间只通过这张契约互相认识。
 *
 * ⚠️ 纪律：这里**不碰 `document`**（59 ：命令不知道 UI）。要聚焦、要滚动、要弹菜单，
 *   一律走注入的能力。
 * ⚠️ 读一律走**读门面**（`KbClient` 的窄方法：按 id、按名字、按清单取数）——
 *   命令层写不出「遍历全库」：整库在内存是门面实现的事，不是调用方的假设。
 */
import type { Block, DerivedCardId, SecLayout, ShellCol, ViewOwnerRef } from '../../core/index.ts'
import type { KbClient, Op, Tx } from '../../core/kb/types.ts'
import type { OwnerStore } from '../wiring/owners.ts'
import type { CheckEdgeResult, Dangling } from '../../core/relations/hierarchy.ts'
import type { ThemeMode, Workspace } from '../../core/infra/workspace.ts'
import type { Row } from '../../ui/overlay/layers.ts'

/** 与编辑器同一个事务入口形状（`Run`）：一次用户动作 ＝ 一笔 */
export type Run = <R>(fn: (tx: Tx) => R) => R

/** 命令层的事务入口：多带回 op 数，装配层好判「零 op 不记撤销步」 */
export type TxRun = <R>(fn: (tx: Tx) => R) => { ops: readonly Op[]; result: R }

export interface PageDeps {
  /** 读门面：块按 id/按名取数，页/标签/日记流是命名的清单 */
  kb: KbClient
  /**
   * 开一笔事务（装配层负责撤销条目与攒 op）：结构写与「找 ＋ 写」的复合动作都经它。
   * 带回 op 数——零 op 的事务不该记撤销步（没写东西就没有可撤销的）。
   */
  run: TxRun
  /**
   * 删一块（含子树）——**结构写路径必须走事务**，否则换库之后这条删除没有行可落。
   *
   * 删除是**原位软删**（块带子树留在原位、打标记）；标记与 op 都由事务那一份
   * 实现负责，命令层只声明「删这块」——两条路径各写一半就会有两种删除。
   */
  removeBlock: (id: string) => void
  /**
   * **把这一块从当前正文里摘掉**（行级删除）。摘不到就 `false`：
   * 有身份的装载根，或者它根本不在这一屏。
   *
   * 为什么不直接把编辑器交给命令层：摘行要管光标、空位、装载根收尾（都是视图的事），
   * 而库级软删要管落点与清单（都是命令的事）。两个机制分开，入口只问「摘得到吗」。
   */
  spliceOut: (id: string) => boolean
  /**
   * 这一块是**派生面**（`structuralScope === 'roots'`：搜索预览、查询结果、页签身体
   * 这类「根＝结果集」的编辑器）此刻装载的**唯一根**吗。
   *
   * 删除判据用它：那一面没有「可写落点」要补——摘行会补出来的那块空根是**真落进库**的
   * （`structural.remove` 的 rootRemoveFill），删一块变两块；而面自己会换下一条
   * （预览的 `onDrop`、视图的回落），所以这种删除走库级软删，不摘行、不换根。
   *
   * ⚠️ 与 `rootIds`（中心编辑器）不是一回事：删的是**哪一台编辑器里**的那一行，
   * 就按**那一台**的根算。
   */
  derivedRoot: (id: string) => boolean
  /**
   * 这一块是不是**「一天」的最后一块**（删了这一天就没有可写的行了）。
   *
   * 判据在活动编辑器上（`BlockEditor.daySoleBlock`）：日期行只读，一天没有子块就没有
   * 落点，写入漏斗会在同一笔里补一块空块——删除入口必须先拒绝并说清原因，
   * 不能让用户看到「删了又回来」。
   */
  daySoleBlock: (id: string) => boolean
  /**
   * 插一棵子树（`block` 自带 children）——与 `removeBlock` 对称的**结构写入口**。
   *
   * 命令层不许自己 `blocks().push`：结构写必须走事务产 op，否则「这块在库里」
   * 没有行可落，换库/重开就丢了。落点（`parent`＋`index`）由调用方声明，
   * 越界夹取与「每个后代报自己的落点」由事务那一份实现负责。
   */
  insertBlock: (block: Block, parentId: string | null, index: number) => void
  /**
   * 搬一个块（连子树）到另一个容器下——`index` 是**最终**位置（越界夹取）。
   *
   * 与 `insertBlock` 分开：插入是「新东西进来」，移动是「同一个东西换个地方」。
   * 两者的 op 形状也不同（插入报 `parent,index`；移动同样报，但语义是「它现在在哪」）。
   * ⚠️ 一条移动 = **一条** `block.upsert{parent,index}`，不许拆成「先删后插」——
   *    那会让一次 ⌘Z 只回一半。
   */
  moveBlock: (blockId: string, parentId: string, index: number) => void
  /**
   * 打标签的落点：**当前光标所在的块**（没有活动块时回退到首行）。
   *
   * ⚠️ 为什么注入的是**一个函数**而不是 `editor` 对象本身：活动编辑器是会变的
   *    （正文 vs 反链 footer），注入对象会在切换后指向旧实例；注入函数每次取当前的。
   */
  caretBlockId: () => string | null
  /**
   * 一次块写入（属性）：装配层负责撤销条目、索引修补、重画当前行与落盘。
   *
   * ⚠️ 必须落到**共享 store**，否则别的视图（反链/查询）看不到这次改动。
   */
  write: (blockId: string, mutate: () => void) => void
  activeId: () => string
  /**
   * 换「当前对象」。
   *
   * `view.feed` 说的是**这次要装的形态**（日记流入口 / 单块），不是数据属性：
   * 同一个 journal id 既可以从「回到今日」以「今日日记流」打开，也可以从块标以「只看这一天」聚焦。
   * 历史回放要记住的是「当时是哪一种」，所以它得跟着落点一起入栈。
   */
  setActiveId: (
    id: string,
    view?: {
      feed?: boolean
      /**
       * 这次是不是**返回**：
       *   · `'saved'` ＝ 用这个视图最后一次的位置；`'none'` ＝ 从顶部；
       *   · 省略 ＝ 不改恢复意图（历史回放已经放好了快照）。
       */
      restore?: 'saved' | 'none'
      /** 恢复位置时是否把焦点交回正文（左槽打开页＝false；历史/面包屑＝true） */
      focusRestore?: boolean
      /** 没有保存选区时，把光标放到锚点块首（翻日/回今日这类「要能立刻打字」的入口） */
      fallbackCaret?: boolean
    },
  ) => void
  /**
   * 中心编辑器**此刻装载的根 id**。
   * 单块聚焦时恰好是一个、且等于当前对象；日记流时是多段。
   * 用于「同一块再点一次块标 ⇒ 不重装」的判据。
   */
  rootIds: () => readonly string[]
  /** 把某页的子树装进编辑器（行内内容住块上，没有第二份要传） */
  loadPage: (roots: Block[]) => void
  /**
   * **按 id 装一批块进工作集**（子树＋祖先链），装完再继续。
   *
   * 工作集装载下 `kb.get(id)` 可能只是「没装」而不是「不存在」；打开/聚焦一个
   * 未装载的目标必须先装再打开——**绝不能把未加载当不存在**（新建/静默丢弃都是事故）。
   * 整库模式下它就是同步的 `then()`（所有块都在内存里）。
   */
  loadDocThen: (ids: readonly string[], then: () => void) => void
  /**
   * **重装当前这一屏**（根集合不变）。
   *
   * 用途：切视图／增删行之后，装载形状变了（正文只画根行 ⇄ 恢复子树），
   * 而「当前装的是谁」只有装配层知道。与 `loadPage(同样一批根)` 的区别：
   * 调用方不必自己把 id 翻回块，也不会因为「同根再点一次不重装」的短路而什么都不发生。
   */
  reloadPage: () => void
  /**
   * 日记流的段排列（设备偏好）。命令层只读它——复盘带参、单列流随偏好，
   * 「偏好怎么写」是 `core.journal/feed-layout` 那一份的事。
   */
  feedLayoutPref: () => SecLayout
  /** 把段排列应用到中心编辑器（渲染差异全在 CSS，不需要重装内容） */
  applyLayout: (mode: SecLayout) => void
  /** 复盘的空天格子（纯视图兜底不进库）；空数组＝清掉 */
  setShells: (cols: readonly ShellCol[]) => void
  /** 光标落到某一天的首个可编辑行（复盘在空天落笔、重装载之后要用） */
  focusDay: (date: string) => void
  /** 切页前把编辑器里的内容写回当前页 + 立即持久化 */
  flush: () => void
  saveNow: () => void
  scheduleSave: () => void
  /** 刷新左槽（页块列表）与顶栏页名——由装配层决定用哪个组件 */
  refreshList: () => void
  refreshTitle: () => void
  /** 把光标放到当前页首块 */
  focusFirstBlock: () => void
  /**
   * 在侧槽打开一个块（不换中心、不入历史）。
   *
   * 日记「Shift+点日期」要用它：跳转与打开是两件事，`openJournal` 只负责先物化再分流。
   */
  openInDock: (id: string) => void
  /** 在新 tab 打开一个块/页（⌘+点的落点；同一个视图已开着就切过去） */
  openInNewTab: (id: string, feed?: boolean) => boolean
  /**
   * 看这一块自己的属性（属性面板，钉在打开时那一块）。
   *
   * 日记「⌥+点日期」要用它：先物化那一天，再把面板钉上去——不改中心。
   */
  openPropertiesDrawer: (id: string) => void
  /**
   * 把光标放到指定的块（`focusFirstBlock` 的精确版）。
   *
   * 提取为页后要落到原位置留下的那枚引用上；块不在当前视图时 `placeCaret` 是空操作，
   * 调用方自己先判「它在不在这一屏」。
   */
  focusBlock: (blockId: string, offset?: number) => void
  /**
   * 确保某个侧槽**开着**（已经开着就是 no-op）。
   *
   * 只给「显式视图命令」用（如「看属性」）：导航动作（zoom / 打开页 / 点链接）
   * 不该动它 —— 关掉侧栏是用户明确表态，导航把它拉开等于不认这个表态。
   */
  openDock: (side: 'left' | 'right') => void
  /**
   * 确保某张**派生卡**在某个槽里（已经在就是 no-op；被关掉就放回来）。
   *
   * 与 `openDock` 分开：开槽是「看这一列」，放卡是「看这张」。给「看属性」这种
   * 承诺了**具体内容**的命令用——卡被关掉之后只开槽，会得到一个「打开了一个空列」
   * 的假成功。
   */
  ensureDockCard: (side: 'left' | 'right', id: DerivedCardId) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /**
   * **后果性操作的确认框**（会话层 `Layers.confirm` 的接口子集）。
   *
   * 删除页／删除一天这类**爆炸半径大**的动作在动手前问一句：它与删除小块的差别
   * 不在可撤销性（都走撤销＋回收站），而在「这一下带走一整棵命名子树」。判据与
   * 删除标签（有成员/声明时确认）同源，所以这里共用同一个原语，而不是各写一套。
   */
  confirm: (o: {
    title: string
    body?: string
    confirmLabel: string
    cancelLabel?: string
    danger?: boolean
    onConfirm: () => void
  }) => void
  /**
   * 打开一个**目标选择器**：装配层负责把它渲染成菜单。
   *
   * `onPick` 省略 ＝ 插入引用（默认语义）。「移动到…」复用它，只是把
   * 「选中之后做什么」换掉——**选择器本身只有一份**，两处各写一份就会出现
   * 两种候选集合（同一件事两个答案）。
   */
  openRefPicker: (rows: Row[], onPick?: (row: Row) => void, title?: string) => void
  /**
   * 打开**日期选择器**（浮层；锚在当前光标）。`onPick` 省略 ＝ 选完回命令面
   * （分发 `core.editor/insert-date-ref` 带日期）——选择器只回答日期，
   * 与 `openRefPicker` 同一条分工。
   */
  openDatePicker: (onPick?: (date: string) => void) => void
  pageTitle: (b: Block) => string
  pageIcon: (b: Block) => string
}

export interface ViewDeps {
  /** 可直接改的偏好（装配层持有；设备状态，不进库） */
  prefs: () => {
    theme: ThemeMode
    /** 界面语言（设备态）；null = 跟系统 */
    locale: 'zh' | 'en' | null
    feedLayout: SecLayout
    dock: { left: { open: boolean }; right: { open: boolean } }
    /** 块下属性的**默认**密度（设备态）：`summary` 一行／`list` 一栏一行 */
    propsDensity: 'summary' | 'list'
    /** 单块显式覆盖（设备态；没有键＝跟随默认），双向 */
    propsLineMode: Record<string, 'summary' | 'list'>
  }
  applyChrome: () => void
  /**
   * 这一侧槽**此刻**看得见吗（档位轴的 overlay 判据）。
   * 开关槽取反的是屏幕上的样子，不是落盘那一位——两者在档位期间会分叉。
   */
  axisSlotOpen: (side: 'left' | 'right') => boolean
  /** 用户在档位期间手动动了某侧槽 ⇒ 以他为准（这一侧脱离档位的强制收起） */
  noteSlotChanged: (side: 'left' | 'right') => void
  /** 主题变了要重画的东西（顶栏开关撤掉后＝重画调试菜单的勾选） */
  renderDebugState: () => void
  /** 偏好变了要落**设备**（`qua.device`），与库的落盘是两条路 */
  scheduleDeviceSave: () => void
  /**
   * **块下属性区改了排布之后要重排这一屏**：行高变了，虚拟化的占位是按行高累加的，
   * 不重排就会「可见区对了、滚动条不对」。与主题那种只换 token 的偏好不同。
   */
  refreshLayout: () => void
  /** 换语言后整页重载——命令表在 import 时就取走了文案，就地换档只会换一半 */
  reloadWindow: () => void
  /** 切换语言这类「立刻重载」的动作：在重载前把防抖的设备写入发出去 */
  flushDevice: () => void
  scheduleBadge: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

export interface DevDeps {
  /**
   * 换掉整个库。⚠️ 这里是**整体替换**（demo 专用）：新库由装配层接管，
   * 所以用回调而不是返回对象——库的唯一持有者仍是装配层（门禁 17）。
   */
  replaceWorkspace: (next: Workspace) => void
  prefs: () => { theme: ThemeMode }
  setVirtualize: (on: boolean, radius: number) => void
  /** 偏好变了要落**设备**（`qua.device`）；换库不碰它 */
  scheduleDeviceSave: () => void
  scheduleBadge: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 「组合期命令零触发」自检：派发一次合成按键，返回触发了几个命令 */
  probeComposing: () => number
  compositionSeq: () => string[]
}

/** 挂载区的宿主能力：写一格 `_mounts`（必要时先物化日记那份共享配置块） */
export interface MountsDeps {
  kb: KbClient
  /**
   * **视图配置的唯一接缝**（含「这一组条目住哪」：`_mounts` 还是设备状态）。
   *
   * 命令层因此不必自己判「是不是日记」—— 判两次就等于「这一栏写哪」有两个答案。
   */
  owners: OwnerStore
  /** 开一笔事务（建查询块等结构写走这里） */
  run: TxRun
  /** 当前中心槽的对象（「页内查询块」的落点） */
  activeId: () => string
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 属性写入的宿主能力（装配层负责 undo 快照、落盘、重画；这里只做模型判断） */
export interface PropsDeps {
  kb: KbClient
  /** 一次写入（属性）：写哪个块是确定的 */
  write: (blockId: string, mutate: () => void) => void
  /**
   * 重画**一批块所在的行**（写入回调只保证重画写入的那一块；`_childProps` 这类
   * 「写在父块、显示在子块」的声明要自己把受影响的行列出来）。
   */
  repaintBlocks: (ids: readonly string[]) => void
  /**
   * 开一笔事务：给「新建定义 ＋ 声明到块上」这种复合动作用（同一笔才不会有半批）。
   * 带回 op 数——零 op 的事务不该记撤销步。
   */
  run: TxRun
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 引述类型表的宿主能力：记录住在隐藏单例块上，每次编辑都要一次**词汇级**重画 */
export interface CalloutTypeDeps {
  kb: KbClient
  /** 一笔事务（首建那张表也要走它：零 op 的编辑不该记撤销步） */
  run: TxRun
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /**
   * 类型改名/换色之后重画用到它的屏幕。
   *
   * 为什么必须单独一格：这些编辑**不产生引述块的 op**，块级订阅看不见——
   * 只写记录的话，徽章、面包屑、引用 chip、卡片会一起停在旧名字/旧颜色。
   */
  vocabularyChanged: () => void
  /**
   * 把类型表那块**钉在工作集里**（缺省实现可不给）。
   *
   * 为什么需要：工作集按预算淘汰未钉的块。这张表一旦被淘汰，读路径会静默回退内置七种
   * （用户的自定义类型看起来「没了」），而下一次编辑会以为「表不存在」再插一份同 id。
   * 启动时装载的身份块原本就被钉住；运行中**新建**的那一份要在这里补钉。
   */
  pin?: (id: string) => void
}

/** 提及转引用的宿主能力（判据在 relations 的 mention 一份；这里只读门面 ＋ 落一笔事务） */
export interface MentionDeps {
  kb: KbClient
  /** 开一笔事务：一条内容写、一次撤销；撤销条目与落盘由装配层收 */
  run: TxRun
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 活动编辑器上的选区（单块纯文本）；不能转 ⇒ `null`。与气泡准入同一份判据 */
  selection: () => { blockId: string; start: number; end: number; text: string } | null
  /** 新建页块之后刷新左槽的页清单（页数变了，清单不能停在旧数） */
  refreshList: () => void
  /** 新建**普通块**之后重画这一屏（它落在宿主的下一个兄弟，不重画就看不见） */
  refreshEditor: () => void
  /** 转完把光标落到引用之后（重画会摘掉原选区；不落光标等于让用户重新点一次） */
  placeCaret: (blockId: string, offset: number) => void
}

/** 归属边写入的宿主能力；森林扫描的派生由装配层按窄口注入（成环检查要全库） */
export interface BelongsToDeps {
  kb: KbClient
  /** 能不能加这条「child 归在 parent 下」（成环检查要祖先闭包 ⇒ 全库读，装配层注入） */
  checkAdd: (child: Block, parent: Block) => CheckEdgeResult
  /** 环路径的显示文本（装配层注入，判据只有 core 那一份） */
  cycleLabels: (path: readonly string[]) => string[]
  /** 悬空上级的两态（装配层注入） */
  danglingOf: (child: Block) => Dangling
  /** 清掉「真没了」的上级引用，返回清了几条（写路径；装配层注入） */
  pruneGone: (child: Block) => number
  write: (blockId: string, mutate: () => void) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  shortId: (id: string) => string
}

/**
 * 视图配置的宿主能力。
 *
 * `reloadPage` 是**必须**的：切视图要换中心槽的装载形状（正文只画根行 / 恢复子树），
 * 而「怎么重装一屏」只有装配层知道（段、视图宿主、挂载区的生命周期都在那里）。
 */
export interface ViewConfigDeps {
  kb: KbClient
  /**
   * **视图配置的唯一接缝**：`owner` 可以是块，也可以是 local tab。
   *
   * 命令层因此不必自己判「配置住在 `props._views` 还是 `_mounts` 里」——
   * 判两次就会长出两份写路径，而两份不会一起更新。
   */
  owners: OwnerStore
  /** 开一笔事务：改配置／插行／软删行各是一次写，装配层负责撤销条目与落盘 */
  run: TxRun
  /** 重装当前这一屏（切视图、增删行之后要让屏幕跟上） */
  reloadPage: () => void
  /**
   * **轻重画**：只重读主编辑器的 roots 并重画行（编辑器自己的 `reloadFromStore`），
   * 不走装配层的整页装载。用于「块就在当前屏上、身体要就地挂出来」的切看法——
   * 整页装载会清掉光标，违背「切看法不动光标」；编辑器路径自带选区恢复。
   */
  rerenderEditor: () => void
  /** 这一屏现在装的是哪些根（判断「要不要换屏」：一屏多根时视图宿主根本不存在） */
  rootIds: () => readonly string[]
  /**
   * **这个拥有者的视图身体此刻有没有被某个表面画着**（正文里的内联体 / 段尾宿主 /
   * 侧槽窗口的卡 / 挂载区的栏与 local tab）。
   *
   * 切视图/改配置只写配置，屏幕跟上靠每台视图宿主自己订阅 ⇒ 有表面在画它时就地重画即可；
   * 没有（收藏块、children 源的激活视图只在打开时才画）才必须把这一块打开，
   * 否则就是「点了没生效」。块与 local tab 都要认（tab 的配置在宿主 `_mounts` 里）。
   */
  viewShown: (owner: ViewOwnerRef) => boolean
  /** 当前中心槽的对象（「页内查询块」的落点） */
  activeId: () => string
  /** 把某一块打开成**这一屏唯一的根**（给「在日记流里给某一天建表」这种跨屏的入口用） */
  openBlock: (blockId: string) => void
  /** 刷左槽的列表（新建内容对象之后要看得见它） */
  refreshList: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}
