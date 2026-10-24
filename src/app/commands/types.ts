/**
 * 各域命令工厂共用的宿主能力（`PageDeps` 及其它 deps 接口）。
 *
 * **为什么单独一份**：这些接口描述的是「门面能用什么」，不是「某一域怎么实现」。
 * 放进任何一域都会让别的域为了拿到接口去 import 那一域的实现——拆开之后，
 * 域与域之间只通过这张契约互相认识。
 *
 * ⚠️ 纪律：这里**不碰 `document`**（59 ：命令不知道 UI）。要聚焦、要滚动、要弹菜单，
 *   一律走注入的能力。
 */
import type { Block } from '../../core/index.ts'
import type { ThemeMode, Workspace } from '../../core/workspace.ts'
import type { Row } from '../../ui/layers.ts'

export interface PageDeps {
  /** 读块森林（**返回的是活引用**，push/splice 直接生效） */
  blocks: () => Block[]
  /**
   * 删一块（含子树）——**结构写路径必须走事务**，否则换库之后这条删除没有行可落。
   *
   * 为什么不是 `trash()` 那种「让命令自己摘」：回收站是删除的**结果**，
   * 让调用方同时负责「改树」与「进回收站」，就会有两条路径各写一半。
   */
  removeBlock: (id: string) => void
  /**
   * 打标签的落点：**当前光标所在的块**（没有活动块时回退到首行）。
   *
   * ⚠️ 为什么注入的是**一个函数**而不是 `editor` 对象本身：活动编辑器是会变的
   *    （正文 vs 反链 footer），注入对象会在切换后指向旧实例；注入函数每次取当前的。
   */
  caretBlockId: () => string | null
  /**
   * 一次块写入（属性）：装配层负责撤销快照、索引失效、重画当前行与落盘。
   *
   * ⚠️ 必须落到**共享 store**，否则别的视图（反链/查询）看不到这次改动。
   */
  write: (blockId: string, mutate: () => void) => void
  activeId: () => string
  /**
   * 换「当前对象」。
   *
   * `view.feed` 说的是**这次要装的形态**（日记流入口 / 单块），不是数据属性：
   * 同一个 journal id 既可以从左槽以「今日日记流」打开，也可以从块标以「只看这一天」聚焦。
   * 历史回放要记住的是「当时是哪一种」，所以它得跟着落点一起入栈。
   */
  setActiveId: (id: string, view?: { feed?: boolean }) => void
  /**
   * 中心编辑器**此刻装载的根 id**。
   * 单块聚焦时恰好是一个、且等于当前对象；日记流时是多段。
   * 用于「同一块再点一次块标 ⇒ 不重装」的判据。
   */
  rootIds: () => readonly string[]
  /** 把某页的子树装进编辑器（marks/atoms 是库级平铺） */
  loadPage: (roots: Block[], marks: unknown[], atoms: unknown[]) => void
  marks: () => unknown[]
  atoms: () => unknown[]
  /** 切页前把编辑器里的内容写回当前页 + 立即持久化 */
  flush: () => void
  saveNow: () => void
  scheduleSave: () => void
  /** 刷新左槽（页块列表）与顶栏页名——由装配层决定用哪个组件 */
  refreshList: () => void
  refreshTitle: () => void
  /** 把光标放到当前页首块 */
  focusFirstBlock: () => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  /** 打开引用选择器：装配层负责把它渲染成菜单 */
  openRefPicker: (rows: Row[]) => void
  pageTitle: (b: Block) => string
  pageIcon: (b: Block) => string
}

export interface ViewDeps {
  /** 可直接改的偏好（装配层持有；设备状态，不进库） */
  prefs: () => { theme: ThemeMode; dock: { left: { open: boolean }; right: { open: boolean } } }
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

/** 属性写入的宿主能力（装配层负责 undo 快照、落盘、重画；这里只做模型判断） */
export interface PropsDeps {
  blocks: () => Block[]
  /** 一次写入：`blockId` 省略＝改了森林结构（例如新建定义块） */
  write: (blockId: string | undefined, mutate: () => void) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
}

/** 标签归属写入的宿主能力 */
export interface TagTreeDeps {
  blocks: () => Block[]
  write: (blockId: string | undefined, mutate: () => void) => void
  toast: (text: string, kind?: 'ok' | 'warn' | 'info') => void
  shortId: (id: string) => string
}
