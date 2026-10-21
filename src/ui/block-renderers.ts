/**
 * 块渲染器注册表（承 29 「一源多视」、13′「类型决定渲染」）。
 *
 * **判据**：一个块长什么样，由它的**类型**决定，不由「它被放在哪个容器里」决定，
 * 也**不由角色决定**（角色只换机制位；外观归类型）。
 * 所以左槽里的页块、中心槽里的页块、以后面板里的页块，用的是**同一个渲染器**。
 * 槽只负责「排一列」，不负责「画什么」——这条分工是本次把 `#pages` 手写列表
 * 拆掉之后立起来的（2026-10-19）。
 *
 * 第 1 期只有两种渲染：
 *   · 默认类型 `outline` → 一行：图标 ＋ 正文/名字（页、收藏项都是它）
 *   · 其余任意块 → 一行纯文本（兜底，保证「什么块都能显示」，承 38 AJ 的占位思路）
 *
 * ⚠️ 页曾经按 `page` 角色匹配。角色可兼位后（一个块既可以是页、又可以是标签），
 *   「哪个角色的渲染器画它」会退化成按数组顺序裁决的隐式规则。
 *   ⇒ 外观一律走**类型**；角色只在下面的 chrome 渲染器里决定「标题显示什么」。
 *
 * ⚠️ 这不是「视图类型系统」（29 那套要独立布局状态才升格）。它只是**最小的渲染分派**，
 * 目的是让「槽里是块、块由渲染器画」这个形状现在就在，而不是等视图系统落地才做。
 */
import { blockTypeOf, DEFAULT_BLOCK_TYPE, hasRole, journalDate, journalDateLabel, prop, type Block, type Role } from '../core/index.ts'
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
  /** 能画哪些块：**类型**（不是角色）*/
  match: (b: Block) => boolean
  render: (b: Block, ctx: BlockRenderCtx) => HTMLElement
}

/**
 * 大纲行：图标 ＋ 正文/名字。页名 = 块的正文，不是某个 title 字段。
 *
 * **按类型匹配**（`outline`）：页、收藏项、普通块只要外观是大纲行，都走这里。
 * 角色不参与 —— 兼位不改变外观。
 */
const outlineRenderer: BlockRenderer = {
  match: (b) => blockTypeOf(b) === DEFAULT_BLOCK_TYPE,
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
 *
 * ⚠️ 这个渲染器只负责**这一行的 chrome**（箭头 ＋ 文本）；它不改变「反链项是块」这件事。
 */
const backRefRenderer: BlockRenderer = {
  match: (b) => hasRole(b, 'backref'),
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
 *
 * ⚠️ 与反链同理：这里只叠**chrome**（标题换成日期、图标换成日历），
 *    「块长什么样」这个决定仍归类型（`outline`）。
 */
const journalRenderer: BlockRenderer = {
  match: (b) => hasRole(b, 'journal'),
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

/**
 * **chrome 渲染器**（按角色匹配）：它们只改这一行「头上那一小块」——
 * 反链项的箭头、日记行的日期标题。角色的职责到此为止。
 */
const CHROME_RENDERERS: BlockRenderer[] = [journalRenderer, backRefRenderer]

/**
 * 注册表：**先匹配先赢**，兜底永远在最后。
 *
 * 顺序的判据不是角色优先级：**chrome 先于类型**。
 * 类型渲染器（`outline`）对默认类型恒匹配，所以必须排在 chrome 之后；
 * 兼位块先叠 chrome，再由类型画那一行的骨架。
 */
const RENDERERS: BlockRenderer[] = [...CHROME_RENDERERS, outlineRenderer, fallbackRenderer]

/** 按类型＋chrome 挑渲染器（导出给测试用） */
export function rendererFor(b: Block): BlockRenderer {
  return RENDERERS.find((r) => r.match(b)) ?? fallbackRenderer
}

/** 这组角色有没有专属 chrome（兜底与默认类型都不算「专属」） */
export function hasDedicatedRenderer(roles: Role[] | undefined): boolean {
  if (!roles?.length) return false
  return CHROME_RENDERERS.some((r) => r.match({ id: '', text: '', children: [], roles }))
}

/** 画一个块 */
export function renderBlock(b: Block, ctx: BlockRenderCtx): HTMLElement {
  return rendererFor(b).render(b, ctx)
}
