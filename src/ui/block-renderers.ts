/**
 * 块渲染器注册表（承 29 「一源多视」、13′「类型决定渲染」）。
 *
 * **判据**：一个块长什么样，由它的**类型**决定，不由「它被放在哪个容器里」决定。
 * 所以左槽里的页块、中心槽里的页块、以后面板里的页块，用的是**同一个渲染器**。
 * 槽只负责「排一列」，不负责「画什么」——这条分工是本次把 `#pages` 手写列表
 * 拆掉之后立起来的（2026-10-19）。
 *
 * 第 1 期只有两种渲染：
 *   · `page` 页块 → 一行：图标 ＋ 页名（页名就是块的正文）
 *   · 其余任意块 → 一行纯文本（兜底，保证「什么块都能显示」，承 38 AJ 的占位思路）
 *
 * ⚠️ 这不是「视图类型系统」（29 那套要独立布局状态才升格）。它只是**最小的渲染分派**，
 * 目的是让「槽里是块、块由渲染器画」这个形状现在就在，而不是等视图系统落地才做。
 */
import { journalDate, journalDateLabel, prop, type Block, type Role } from '../core/index.ts'
import { renderIcon } from '../view/icons.ts'

/** 渲染一个块时能拿到的东西（后续会加：上下文键、命令执行、订阅） */
export interface BlockRenderCtx {
  /** 块是否处于「当前对象」状态（中心槽持有） */
  isActive: (id: string) => boolean
  /** 点一下这个块：页块 ＝ 打开它；其余 ＝ 聚焦它的子树 */
  onActivate: (block: Block) => void
  /** 空页名时的兜底文案 */
  untitledLabel: string
}

export interface BlockRenderer {
  /** 能画哪些块：按角色或类型匹配（简单判据，不引入类型 id 的完整注册表） */
  match: (b: Block) => boolean
  render: (b: Block, ctx: BlockRenderCtx) => HTMLElement
}

/** 页块的一行：图标 ＋ 页名。页名 = 块的正文，不是某个 title 字段 */
const pageBlockRenderer: BlockRenderer = {
  match: (b) => b.role === 'page',
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    // ⚠️ 类名 `.page-item` / `.p-ico` / `.p-title` 是**对外契约**（smoke 与主题都按它选）
    row.className = 'page-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'

    const icon = document.createElement('span')
    icon.className = 'p-ico'
    renderIcon(icon, prop<string>(b, '_icon'), 'file')

    const title = document.createElement('span')
    title.className = 'p-title'
    const name = b.text.trim()
    title.textContent = name === '' ? ctx.untitledLabel : name
    title.title = name

    row.append(icon, title)
    row.addEventListener('click', () => ctx.onActivate(b))
    return row
  },
}

/**
 * 反链块（右槽的默认内容）。**渲染的是「谁指向了我」这一列引用**，
 * 不是「一个叫作反链的组件」——这层区分就是说的「槽里是一列块」。
 *
 * 数据从 `backRefs` 来（demo 里由装配层算好传进来；接内核后走指向边索引 G1）。
 */
const backRefRenderer: BlockRenderer = {
  match: (b) => b.role === 'backref',
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item backref-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const arrow = document.createElement('span')
    arrow.className = 'p-ico'
    renderIcon(arrow, 'lucide:corner-up-left', 'corner-up-left')
    const title = document.createElement('span')
    title.className = 'p-title'
    title.textContent = b.text.trim() === '' ? ctx.untitledLabel : b.text
    row.append(arrow, title)
    row.addEventListener('click', () => ctx.onActivate(b))
    return row
  },
}

/**
 * 日记块：**日期只读**——它来自 `_date` 属性，不是块的正文，
 * 所以这一行没有输入框、也改不了日期；点它＝打开今天。
 */
const journalRenderer: BlockRenderer = {
  match: (b) => b.role === 'journal',
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item journal-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const icon = document.createElement('span')
    icon.className = 'p-ico'
    renderIcon(icon, prop<string>(b, '_icon'), 'calendar')
    const title = document.createElement('span')
    title.className = 'p-title'
    title.textContent = journalDateLabel(journalDate(b))
    row.append(icon, title)
    row.addEventListener('click', () => ctx.onActivate(b))
    return row
  },
}

/** 兜底：任何块都能画一行纯文本（保证「不认识的块」不会消失） */const fallbackRenderer: BlockRenderer = {
  match: () => true,
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const title = document.createElement('span')
    title.className = 'p-title'
    title.textContent = b.text.trim() === '' ? ctx.untitledLabel : b.text
    row.append(title)
    row.addEventListener('click', () => ctx.onActivate(b))
    return row
  },
}

/** 注册表：**先匹配先赢**，兜底永远在最后 */
const RENDERERS: BlockRenderer[] = [pageBlockRenderer, journalRenderer, backRefRenderer, fallbackRenderer]

/** 按角色挑渲染器（导出给测试与「这个角色有没有专属渲染」的判断用） */
export function rendererFor(b: Block): BlockRenderer {
  return RENDERERS.find((r) => r.match(b)) ?? fallbackRenderer
}

/** 有没有为该角色专门写过渲染器（兜底不算） */
export function hasDedicatedRenderer(role: Role | undefined): boolean {
  if (!role) return false
  return RENDERERS.slice(0, -1).some((r) => r.match({ id: '', text: '', children: [], role }) )
}

/** 画一个块 */
export function renderBlock(b: Block, ctx: BlockRenderCtx): HTMLElement {
  return rendererFor(b).render(b, ctx)
}
