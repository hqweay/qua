/**
 * **一个浮面 ＝ 五个正交维度**，不是一个组件族。
 *
 * 菜单 / popover / 抽屉 / 划选条之所以看起来是四种东西，是因为过去每一族
 * 各自实现了这五维。拆开之后，「族」退化成一张**预设表**（五维上的一组默认值），
 * 不再需要继承体系，也不需要一个叫 `Dialog` 的基类。
 *
 * 五维：内容（借，不拥有）· 存活（意图持有者）· 位置（约束求解）
 *      · 焦点（交互面栈）· 外观（驻留时长数轴）。
 *
 * ⚠️ 本文件只定义形状，不含任何 DOM 与全局状态；`solve` 与 `Holders` 都是纯的，
 *    因此整个模型可以脱离浏览器单测。
 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type Side = 'above' | 'below' | 'start' | 'end'

/**
 * 位置约束。优先级由 `kind` 决定，**不由数组顺序决定**：
 * `at`（用户拖过）> `avoid`（环境）> `anchor`（锚点）。
 * 锚定与自由因此不是两种生命周期，只是同一组约束里有没有那一条更强的。
 */
export type Constraint =
  | { kind: 'anchor'; rect: Rect; prefer: Side; gap?: number; flip?: boolean }
  | { kind: 'avoid'; rects: readonly Rect[]; padding?: number }
  | { kind: 'at'; x: number; y: number }

/** 「它为什么还在」的来源。任何一个在，浮面就存活；全释放才退场 */
export type HolderKind = 'pointer' | 'focus' | 'gesture' | 'pin' | 'anchor'
/** 会话级随浮面消失；工作区级跨会话（pin 过的面板位置与存在都跟它走） */
export type HolderScope = 'session' | 'workspace'

export type FocusMode = 'none' | 'stack' | 'modal'

/**
 * 外观是**一个数轴**，不是几套皮肤：影／圆角／边框／动效全部由它派生。
 * 0 ＝ 一瞬（几乎无影、无框）；1 ＝ 一次交互（浮影）；2 ＝ 常驻（结构线，归入纸）。
 */
export type Elevation = number

export interface Holders {
  /** 拿一枚持有者，返回它的释放函数 */
  acquire(key: string, kind: HolderKind, scope?: HolderScope): () => void
  /** 幂等地设置（指针在 chip 与浮层之间往返时不重复通知） */
  set(key: string, kind: HolderKind, scope?: HolderScope): void
  release(key: string): void
  readonly alive: boolean
  readonly kinds: readonly HolderKind[]
  onChange(cb: () => void): () => void
  clear(): void
}

export interface SurfaceSpec {
  /** **借来的**内容：运行时 append 它，退场时原样摘下还回去，不克隆不销毁 */
  content: HTMLElement
  /** 每次求解时现取快照（锚点会动、会消失）；空集 ⇒ 约束集空了 ⇒ 退场 */
  constraints: () => readonly Constraint[]
  /** 可用矩形（视口或父容器）；省略 ＝ 当前视口 */
  bounds?: () => Rect
  elevation?: Elevation
  focus?: FocusMode
  /** 抬头给不给拖动把手 */
  draggable?: boolean
  title?: string
  /** 脚注：给眼睛看的一句说明（读屏那份走 aria-label，别叠两层） */
  foot?: string
  /** 用户拖过之后回调落点：装配层可以把它记成工作区级的位置（pin 的那一档） */
  onMoved?: (x: number, y: number) => void
  /** 全释放、或约束集空了之后 */
  onDismiss?: () => void
}

export interface Surface {
  readonly el: HTMLElement
  readonly holders: Holders
  /** 用户拖过：加一条 `at` 强约束，存在期间覆盖锚点 */
  moveTo(x: number, y: number): void
  /** 重新求解（滚动 / 窗口变化 / 约束变了） */
  reflow(): void
  dismiss(): void
}
