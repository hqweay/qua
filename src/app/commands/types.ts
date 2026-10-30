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
import type { Block, SecLayout, ShellCol } from '../../core/index.ts'
import type { KbClient, Op, Tx } from '../../core/kb/types.ts'
import type { CheckEdgeResult, Dangling } from '../../core/hierarchy.ts'
import type { ThemeMode, Workspace } from '../../core/workspace.ts'
import type { Row } from '../../ui/layers.ts'

/** 与编辑器同一个事务入口形状（`Run`）：一次用户动作 ＝ 一笔 */
export type Run = <R>(fn: (tx: Tx) => R) => R

/** 命令层的事务入口：多带回 op 数，装配层好判「零 op 不记撤销步」 */
export type TxRun = <R>(fn: (tx: Tx) => R) => { ops: readonly Op[]; result: R }

export interface PageDeps {
  /** 读门面：块按 id/按名取数，页/标签/日记流是命名的清单 */
  kb: KbClient
  /**
   * 开一笔事务（装配层负责撤销快照与攒 op）：结构写与「找 ＋ 写」的复合动作都经它。
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
   * 一次块写入（属性）：装配层负责撤销快照、索引修补、重画当前行与落盘。
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
  setActiveId: (id: string, view?: { feed?: boolean }) => void
  /**
   * 中心编辑器**此刻装载的根 id**。
   * 单块聚焦时恰好是一个、且等于当前对象；日记流时是多段。
   * 用于「同一块再点一次块标 ⇒ 不重装」的判据。
   */
  rootIds: () => readonly string[]
  /** 把某页的子树装进编辑器（行内内容住块上，没有第二份要传） */
  loadPage: (roots: Block[]) => void
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
  ensureDockCard: (side: 'left' | 'right', id: 'inspect' | 'belongs' | 'backrefs' | 'trash' | 'calendar') => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /**
   * 打开一个**目标选择器**：装配层负责把它渲染成菜单。
   *
   * `onPick` 省略 ＝ 插入引用（默认语义）。「移动到…」复用它，只是把
   * 「选中之后做什么」换掉——**选择器本身只有一份**，两处各写一份就会出现
   * 两种候选集合（同一件事两个答案）。
   */
  openRefPicker: (rows: Row[], onPick?: (row: Row) => void, title?: string) => void
  pageTitle: (b: Block) => string
  pageIcon: (b: Block) => string
}

export interface ViewDeps {
  /** 可直接改的偏好（装配层持有；设备状态，不进库） */
  prefs: () => { theme: ThemeMode; feedLayout: SecLayout; dock: { left: { open: boolean }; right: { open: boolean } } }
  applyChrome: () => void
  /** 主题变了要重画的东西（顶栏开关撤掉后＝重画调试菜单的勾选） */
  renderDebugState: () => void
  /** 偏好变了要落**设备**（`qua.device`），与库的落盘是两条路 */
  scheduleDeviceSave: () => void
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

/** 集合组件的宿主能力：写一格 `_items`，或新建一个集合块 */
export interface CollectionDeps {
  kb: KbClient
  write: (blockId: string, mutate: () => void) => void
  run: TxRun
}

/** 挂载区的宿主能力：写一格 `_mounts`（必要时先物化日记那份共享配置块） */
export interface MountsDeps {
  kb: KbClient
  /** 一次属性写入（撤销快照、落盘、重画都在装配层） */
  write: (blockId: string, mutate: () => void) => void
  /** 开一笔事务：给「物化配置块 ＋ 挂上第一栏」这种复合动作用（同一笔才不留半截） */
  run: TxRun
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 属性写入的宿主能力（装配层负责 undo 快照、落盘、重画；这里只做模型判断） */
export interface PropsDeps {
  kb: KbClient
  /** 一次写入（属性）：写哪个块是确定的 */
  write: (blockId: string, mutate: () => void) => void
  /**
   * 开一笔事务：给「新建定义 ＋ 声明到块上」这种复合动作用（同一笔才不会有半批）。
   * 带回 op 数——零 op 的事务不该记撤销步。
   */
  run: TxRun
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
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
  /** 开一笔事务：改配置／插行／软删行各是一次写，装配层负责撤销快照与落盘 */
  run: TxRun
  /** 重装当前这一屏（切视图、增删行之后要让屏幕跟上） */
  reloadPage: () => void
  /** 这一屏现在装的是哪些根（判断「要不要换屏」：一屏多根时视图宿主根本不存在） */
  rootIds: () => readonly string[]
  /** 把某一块打开成**这一屏唯一的根**（给「在日记流里给某一天建表」这种跨屏的入口用） */
  openBlock: (blockId: string) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}
