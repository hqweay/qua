/**
 * 槽的渲染：**每个槽的内容是一列卡片**。
 *
 * 这一层只做「把一组卡片放进槽里」和「卡片自己的 chrome」，
 * **不认识页面、不认识命令、不认识状态**——那些由调用方（装配层）准备好再传进来。
 *
 * 三条纪律：
 *   1. **槽内只许纵向**。这里不提供任何横向排列的入口。
 *   2. **卡片外壳只有一个产地**：窗口、派生卡、检视卡共用同一套头／收起／单卡／拖拽。
 *      否则「所有卡片都支持 X」一定会漏掉某一张（真踩过：窗口卡手写的头没有折叠按钮）。
 *   3. **三个状态分开表达**：
 *      · `hidden`        ＝ 这张卡没有内容（可用性，归卡片内容的主人）；
 *      · `data-collapsed`＝ 用户把这张卡收起了（只隐藏 body，不销毁编辑器）；
 *      · `stack[data-solo]` ＋ `card[data-solo-card]` ＝ 只看这一张。
 *      不要用同一个 `hidden` 表达两件事——那会让「没有主体」和「收起了」变成同一个值。
 */

import { t } from '../core/msg.ts'
import { renderIcon } from '../view/icons.ts'
import { cardNote } from './card-parts.ts'

/** 一块卡：标题条 + 内容；`hidden` 只表示「没有内容」，不表示「用户收起了」 */
export interface DockCard {
  /** 稳定 key（`dockKey`）：块 id／派生卡 id／`cmd:<命令>`——身份，不是种类 */
  id: string
  /** 块卡标题；空串 ＝ 不画标题文字（仍保留头，因为动作住在这里） */
  title: string
  /**
   * 关闭入口：**每一张卡都有**（窗口／组件／派生）——关掉只是从 `cards` 里摘掉这一次露面，
   * 回程是槽头的「添加组件」。
   */
  close?: { title?: string; onClick: () => void }
  /**
   * 卡头**没有**「本卡专属动作」这个通道。
   *
   * 卡头是**跨卡扫视**的一块区域：多一颗按钮，那一列的图标就会错开，而用户扫的是一列卡，
   * 不是一张卡。所以作用于**内容**的动作（回到本月、清空回收站…）长在 body 里、
   * 贴着它作用的那件东西；卡头只留「这张卡」的三个控件（收起／单卡／关闭），每张卡同构。
   */
  body: HTMLElement
  /** 是否可拖（缺省 true） */
  draggable?: boolean
  /** 没有内容：保留位置但隐藏 */
  hidden?: boolean
}

export interface DockCardAction {
  /** 图标名（`lucide:<name>`）；与图标槽同一套解析 */
  label: string
  title?: string
  onClick: () => void
}

/**
 * 小卡：一个 44px 的动作格。
 *
 * 它**不是卡片**：没有卡头、没有折叠/单卡。把它硬塞进卡壳，会长出
 * 「没有折叠按钮的卡」那种半成品；44px 也放不下卡头。
 * 宿主只画这个格子，动作归调用方（通常是一条命令）。
 */
export interface DockTile {
  /** 稳定 key（`dockKey`）：`cmd:<命令名>` */
  id: string
  title: string
  /** 图标名（`lucide:<name>`）；未知名字由 renderIcon 降级成占位 */
  icon: string
  /** 命令已经不可用（插件卸载/产品构建裁掉）：置灰、保留位置 */
  missing?: boolean
  /** 移出入口；小卡只有这一个 chrome 动作 */
  close?: { title?: string; onClick: () => void }
  onClick: () => void
  onDragStart?: (e: DragEvent) => void
}

/** 小卡的唯一产地：44px 格 + 主按钮 + hover 出现的移除入口 */
export function buildDockTile(tile: DockTile): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dock-tile'
  el.dataset.cardId = tile.id
  if (tile.missing) el.dataset.missing = '1'
  el.draggable = true
  el.addEventListener('dragstart', (e) => {
    // 移除按钮不是拖源：从它起拖会把「点 ×」变成一次拖拽
    if ((e.target as HTMLElement).closest('.dock-tile-x')) {
      e.preventDefault()
      return
    }
    tile.onDragStart?.(e)
  })

  const main = document.createElement('button')
  main.type = 'button'
  main.className = 'dock-tile-main'
  main.title = tile.title
  main.setAttribute('aria-label', tile.title)
  if (tile.missing) main.setAttribute('aria-disabled', 'true')
  renderIcon(main, tile.missing ? 'lucide:circle-help' : tile.icon, 'square', 'md')
  main.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!tile.missing) tile.onClick()
  })
  el.appendChild(main)

  if (tile.close) {
    const x = document.createElement('button')
    x.type = 'button'
    x.className = 'dock-tile-x'
    x.title = tile.close.title ?? ''
    if (tile.close.title) x.setAttribute('aria-label', tile.close.title)
    renderIcon(x, 'lucide:x', 'x', 'sm')
    x.addEventListener('click', (e) => {
      e.stopPropagation()
      tile.close?.onClick()
    })
    el.appendChild(x)
  }
  return el
}

export interface DockCardState {
  /** 用户把这张卡收起了 */
  collapsed: boolean
  /** 这张卡就是当前单卡目标 */
  solo: boolean
  onToggleCollapse: () => void
  onToggleSolo: () => void
  onDragStart?: (e: DragEvent) => void
}

export interface DockSlotEls {
  root: HTMLElement
  head: HTMLElement
  titleEl: HTMLElement
  stack: HTMLElement
  /**
   * 内侧边缘的宽度手柄（左槽在右缘、右槽在左缘）。
   *
   * 它是槽的**骨架**的一部分：由 `mountDockSlot` 与抬头/堆叠一起建，
   * 于是左右两槽的 DOM 形状天然对称（布局断言按直接子元素比对）。
   * 拖动行为由 `ui/dock-resize` 接线，槽在这里只负责「有这个节点」。
   */
  resizeEl: HTMLElement
}

/** 取一个槽的三块 DOM（抬头／标题／堆叠），并做一次存在性断言 */
export function dockSlotEls(root: HTMLElement): DockSlotEls {
  const head = root.querySelector<HTMLElement>(':scope > .dock-head')
  const titleEl = head?.querySelector<HTMLElement>('.dock-title')
  const stack = root.querySelector<HTMLElement>(':scope > .dock-stack')
  const resizeEl = root.querySelector<HTMLElement>(':scope > .dock-resize')
  if (!head || !titleEl || !stack || !resizeEl) // 开发者可见的骨架断言（不是用户文案）：与 console.* 同一口径，用英文
  throw new Error('dock: incomplete slot skeleton (need .dock-head / .dock-title / .dock-stack / .dock-resize)')
  return { root, head, titleEl, stack, resizeEl }
}

const ACTION_ATTR = 'data-dock-action'

/**
 * 卡片 DOM → 当前状态。按钮在创建时只绑一次，所以不能把回调捕获在闭包里
 * （下一帧状态就换了）；点击时按卡片的当前状态派发。
 */
const cardStates = new WeakMap<HTMLElement, DockCardState>()

/** 卡片外壳的唯一产地：窗口、派生卡都从这里建 */
export function buildDockCard(card: DockCard, state: DockCardState): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dock-card'
  el.dataset.cardId = card.id
  el.hidden = card.hidden === true

  const head = document.createElement('div')
  head.className = 'dock-card-head'
  head.draggable = card.draggable !== false
  head.addEventListener('dragstart', (e) => {
    // 头上的按钮各有各的动作；从按钮上起拖不算「拖这张卡」
    if ((e.target as HTMLElement).closest('button')) {
      e.preventDefault()
      return
    }
    cardStates.get(el)?.onDragStart?.(e)
  })

  head.appendChild(collapseButton())
  const title = document.createElement('span')
  title.className = 'dock-card-title ui-ellipsis ui-ellipsis-grow'
  title.textContent = card.title
  head.appendChild(title)
  head.appendChild(soloButton())
  if (card.close) head.appendChild(actionButton({ label: 'lucide:x', ...card.close }))

  const body = document.createElement('div')
  body.className = 'dock-card-body'
  body.appendChild(card.body)

  el.append(head, body)
  applyDockCardState(el, state)
  return el
}

/**
 * 给一张**已在文档里的**卡补 chrome（检视卡是静态 HTML，窗口卡由管理器自己建）。
 *
 * 幂等：重复调用不会加第二颗按钮；标题由它的主人写，这里不碰。
 */
export function decorateDockCard(el: HTMLElement, card: DockCard, state: DockCardState): void {
  el.dataset.cardId = card.id
  let head = el.querySelector<HTMLElement>(':scope > .dock-card-head')
  if (!head) {
    head = document.createElement('div')
    head.className = 'dock-card-head'
    el.prepend(head)
  }
  if (!head.querySelector(`[${ACTION_ATTR}="collapse"]`)) head.prepend(collapseButton())
  if (!head.querySelector(`[${ACTION_ATTR}="solo"]`)) head.appendChild(soloButton())
  if (!head.querySelector(`[${ACTION_ATTR}="close"]`) && card.close) head.appendChild(actionButton({ label: 'lucide:x', ...card.close }))
  head.draggable = card.draggable !== false
  if (head.dataset.dragBound !== '1') {
    head.dataset.dragBound = '1'
    head.addEventListener('dragstart', (e) => {
      if ((e.target as HTMLElement).closest('button')) {
        e.preventDefault()
        return
      }
      cardStates.get(el)?.onDragStart?.(e)
    })
  }
  applyDockCardState(el, state)
}

/* ------------------------------------------------------------ 卡片内部 */

function collapseButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dock-btn dock-card-btn'
  btn.dataset.dockAction = 'collapse'
  btn.setAttribute('aria-expanded', 'true')
  btn.title = t('ui.dock.collapseCard')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const card = btn.closest<HTMLElement>('.dock-card')
    if (card) cardStates.get(card)?.onToggleCollapse()
  })
  return btn
}

function soloButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dock-btn dock-card-btn'
  btn.dataset.dockAction = 'solo'
  btn.setAttribute('aria-pressed', 'false')
  btn.title = t('ui.dock.soloCard')
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    const card = btn.closest<HTMLElement>('.dock-card')
    if (card) cardStates.get(card)?.onToggleSolo()
  })
  return btn
}

function actionButton(a: DockCardAction): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'dock-btn dock-card-btn'
  if (a.label === 'lucide:x') btn.dataset.dockAction = 'close'
  renderIcon(btn, a.label, 'square')
  if (a.title) {
    btn.title = a.title
    btn.setAttribute('aria-label', a.title)
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    a.onClick()
  })
  return btn
}

/**
 * 把状态画到卡上。**只改属性，不搬 DOM**（搬 contenteditable 会丢光标）。
 *
 * 收起与单卡是两件事：收起隐藏 body，单卡由槽层用 `data-solo` 过滤其它卡。
 */
export function applyDockCardState(el: HTMLElement, state: DockCardState): void {
  cardStates.set(el, state)
  if (state.collapsed) el.dataset.collapsed = '1'
  else delete el.dataset.collapsed

  const collapse = el.querySelector<HTMLButtonElement>(`:scope > .dock-card-head [${ACTION_ATTR}="collapse"]`)
  if (collapse) {
    collapse.setAttribute('aria-expanded', state.collapsed ? 'false' : 'true')
    collapse.title = state.collapsed ? t('ui.dock.expandCard') : t('ui.dock.collapseCard')
    const icon = state.collapsed ? 'lucide:chevron-right' : 'lucide:chevron-down'
    if (collapse.dataset.icon !== icon) renderIcon(collapse, icon, 'chevron-down')
  }
  const solo = el.querySelector<HTMLButtonElement>(`:scope > .dock-card-head [${ACTION_ATTR}="solo"]`)
  if (solo) {
    solo.setAttribute('aria-pressed', state.solo ? 'true' : 'false')
    solo.title = state.solo ? t('ui.dock.unsoloCard') : t('ui.dock.soloCard')
    const icon = state.solo ? 'lucide:minimize-2' : 'lucide:maximize-2'
    if (solo.dataset.icon !== icon) renderIcon(solo, icon, 'maximize-2')
  }
}

/* ------------------------------------------------------------ 槽的排布 */

export interface DockCardEntry {
  id: string
  el: HTMLElement
  /** 小卡不参与折叠/单卡；缺省按大卡处理 */
  size?: 'small' | 'large'
}

/**
 * 按 entries 的顺序排一个槽。
 *
 * ⚠️ **只移动顺序真的变了的节点**：`appendChild` 对已在文档里的节点是移动，
 *    移动一个正在编辑的 contenteditable 会丢焦点与光标（每敲一个字跳一次）。
 *    这里按位置逐个比对，原位不动。
 * ⚠️ **隐藏的卡仍是 entry**：位置是布局，可用性是内容。从 DOM 里摘掉它，
 *    后面所有卡都会往上跳；导航时「今天/检视卡」一会出现一会消失，卡就会闪。
 */
export function renderDockStack(
  stack: HTMLElement,
  entries: DockCardEntry[],
  emptyText: string,
  soloId: string | null,
): void {
  const keep = new Set<Node>(entries.map((e) => e.el))
  for (const n of Array.from(stack.childNodes)) if (!keep.has(n)) stack.removeChild(n)

  entries.forEach((entry, i) => {
    const at = stack.children[i] ?? null
    if (at !== entry.el) stack.insertBefore(entry.el, at)
  })

  const empty = stack.querySelector<HTMLElement>(':scope > .dock-empty')
  if (entries.every((e) => e.el.hidden)) {
    if (empty) empty.textContent = emptyText
    else stack.appendChild(cardNote(emptyText))
  } else empty?.remove()

  // 单卡：目标必须**可见的大卡**才生效；小卡没有单卡，目标不可见时照常显示其它卡（不留空槽）
  const target = soloId
    ? entries.find((e) => e.id === soloId && !e.el.hidden && (e.size ?? 'large') === 'large')
    : undefined
  if (target) stack.dataset.solo = '1'
  else delete stack.dataset.solo
  for (const e of entries) {
    if (target && e === target) e.el.dataset.soloCard = '1'
    else delete e.el.dataset.soloCard
  }
}

/**
 * 装一个槽：取它的 DOM、写抬头文案、绑收起按钮。
 *
 * **组件自持 DOM**：抬头里的标题与收起按钮只有这里知道，装配层不再 `getElementById`。
 */
export function mountDockSlot(
  root: HTMLElement,
  opts: {
    side: 'left' | 'right'
    title: string
    addLabel: string
    collapseLabel: string
    resizeLabel: string
    icon: string
    onAdd: () => void
    onCollapse: () => void
  },
): DockSlotEls {
  const els = dockSlotEls(root)
  els.titleEl.textContent = opts.title
  const add = els.head.querySelector<HTMLButtonElement>('.dock-add')
  if (add) {
    renderIcon(add, 'lucide:plus', 'plus')
    add.setAttribute('aria-label', opts.addLabel)
    add.title = opts.addLabel
    add.addEventListener('click', opts.onAdd)
  }
  const btn = els.head.querySelector<HTMLButtonElement>('.dock-collapse')
  if (btn) {
    renderIcon(btn, opts.icon, 'chevron-left')
    btn.setAttribute('aria-label', opts.collapseLabel)
    btn.addEventListener('click', opts.onCollapse)
  }
  // 手柄的**位置**（哪条边）由 side 决定，不在装配层写内联样式
  els.resizeEl.dataset.resizeSide = opts.side
  els.resizeEl.setAttribute('role', 'separator')
  els.resizeEl.setAttribute('aria-orientation', 'vertical')
  els.resizeEl.title = opts.resizeLabel
  return els
}

/** 槽的开关：把状态写到 `body[data-dock-*]`（样式按它取值，JS 不碰宽度数值） */
export function applyDockVisibility(open: { left: boolean; right: boolean }): void {
  document.body.dataset.dockLeft = open.left ? 'open' : 'closed'
  document.body.dataset.dockRight = open.right ? 'open' : 'closed'
}

/** 压缩区间起点：CSS 的 `@media (max-width: 839px)` 必须与它一致 */
export const DOCK_COMPACT_WIDTH = 840

/**
 * 把用户拖过的宽度写进 `#app` 的 inline 变量。
 *
 * 为什么不是无条件写：CSS 里槽宽已经有三个来源（token 默认 / 关闭归零 / 压缩区间锁下限）。
 * inline 变量的优先级高于全部三条，一旦常驻就会让「关槽不塌列」和「窄窗压缩」失效。
 * ⇒ 只在**开着且不在压缩区间**时写，其余情况 `removeProperty` 把决定权交回 CSS。
 *
 * ⚠️ 宽度数值走 `CSS.px()` 转字符串：TS 里直接拼 `'px'` 字面量会被门禁拦下。
 */
export function applyDockWidth(
  root: HTMLElement,
  side: 'left' | 'right',
  width: number | null,
  open: boolean,
): void {
  const prop = `--dock-${side}-w`
  if (!open || width === null || window.innerWidth < DOCK_COMPACT_WIDTH) {
    root.style.removeProperty(prop)
    return
  }
  root.style.setProperty(prop, CSS.px(width).toString())
}
