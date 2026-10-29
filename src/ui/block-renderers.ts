/**
 * 块渲染器注册表（一源多视：类型决定渲染）。
 *
 * **判据**：一个块长什么样，由它的**类型**决定，不由「它被放在哪个容器里」决定，
 * 也**不由角色决定**（角色只换机制位；外观归类型）。
 * 所以左槽里的页块、中心槽里的页块、以后面板里的页块，用的是**同一个渲染器**。
 * 槽只负责「排一列」，不负责「画什么」——这条分工是本次把 `#pages` 手写列表
 * 拆掉之后立起来的（2026-10-19）。
 *
 * 第 1 期只有两种渲染：
 *   · 默认类型 `outline` → 一行：图标 ＋ 正文/名字（页也是它）
 *   · 其余任意块 → 一行纯文本（兜底，保证「什么块都能显示」）
 *
 * ⚠️ 页曾经按 `page` 角色匹配。角色可兼位后（一个块既可以是页、又可以是标签），
 *   「哪个角色的渲染器画它」会退化成按数组顺序裁决的隐式规则。
 *   ⇒ 外观一律走**类型**；角色只在下面的 chrome 渲染器里决定「标题显示什么」。
 *
 * ⚠️ 这不是「视图类型系统」（29 那套要独立布局状态才升格）。它只是**最小的渲染分派**，
 * 目的是让「槽里是块、块由渲染器画」这个形状现在就在，而不是等视图系统落地才做。
 */
import { blockTypeOf, DEFAULT_BLOCK_TYPE, DIVIDER_TYPE, displayNameOf, isJournal, journalDate, journalDateLabel, prop, type Block } from '../core/index.ts'
import { renderIcon } from '../view/icons.ts'

/** 渲染一个块时能拿到的东西（后续会加：上下文键、命令执行、订阅） */
export interface BlockRenderCtx {
  /** 块是否处于「当前对象」状态（中心槽持有） */
  isActive: (id: string) => boolean
  /** 点一下这个块：页块 ＝ 打开它；其余 ＝ 聚焦它的子树 */
  onActivate: (block: Block) => void
  /** Shift+点：同一个「打开」，换到右槽（打开一张窗口） */
  onOpenInDock: (block: Block) => void
  /** 空页名时的兜底文案 */
  untitledLabel: string
}

/**
 * 行点击的**唯一口径**：Shift ＝ 换目的地，不换动作。
 *
 * 放在这里而不是每个渲染器各写一次：四种行渲染器（大纲／日记／分割线／兜底）
 * 只要有一个漏了 Shift，用户看到的就是「这一行能开窗口、那一行不能」。
 */
function bindRowClick(row: HTMLElement, b: Block, ctx: BlockRenderCtx): void {
  row.addEventListener('click', (e) => {
    if (e.shiftKey) ctx.onOpenInDock(b)
    else ctx.onActivate(b)
  })
}

export interface BlockRenderer {
  /** 能画哪些块：**类型**（不是角色）*/
  match: (b: Block) => boolean
  render: (b: Block, ctx: BlockRenderCtx) => HTMLElement
}

/**
 * 大纲行：图标 ＋ 正文/名字。页名 = 块的正文，不是某个 title 字段。
 *
 * **按类型匹配**（`outline`）：页与普通块只要外观是大纲行，都走这里。
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
    title.className = 'p-title ui-ellipsis ui-ellipsis-grow'
    const name = displayNameOf(b).trim()
    title.textContent = name === '' ? ctx.untitledLabel : name
    title.title = name

    row.append(icon, title)
    bindRowClick(row, b, ctx)
    return row
  },
}

/**
 * 日记块：**日期只读**——它来自 `_date` 属性，不是块的正文，
 * 所以这一行没有输入框、也改不了日期；点它＝打开今天。
 *
 * ⚠️ 这里只叠**chrome**（标题换成日期、图标换成日历）：「块长什么样」仍归类型（`outline`）。
 * ⚠️ 反链项**没有**这样的渲染器。它是每次渲染时现造、从不落盘的合成行，没有库身份，
 *    也就没有「担任什么机制位」可言 —— 箭头只是那一行的 `props._icon`，不是一个角色。
 */
const journalRenderer: BlockRenderer = {
  match: (b) => isJournal(b),
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item journal-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const icon = document.createElement('span')
    icon.className = 'p-ico'
    renderIcon(icon, prop<string>(b, '_icon'), 'calendar')
    const title = document.createElement('span')
    title.className = 'p-title ui-ellipsis ui-ellipsis-grow'
    title.textContent = journalDateLabel(journalDate(b))
    row.append(icon, title)
    bindRowClick(row, b, ctx)
    return row
  },
}

/**
 * 分割线：一条横线，没有图标也没有正文。
 *
 * 仍返回 `.page-item` 这层壳（槽里一行的对外契约），只是里面只放线 —— 换掉壳
 * 会让主题与冒烟按 `.page-item` 找这一行时落空。
 */
const dividerRenderer: BlockRenderer = {
  match: (b) => blockTypeOf(b) === DIVIDER_TYPE,
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const rule = document.createElement('span')
    rule.className = 'divider-rule'
    rule.setAttribute('aria-hidden', 'true')
    row.appendChild(rule)
    bindRowClick(row, b, ctx)
    return row
  },
}

/** 兜底：任何块都能画一行纯文本（保证「不认识的块」不会消失） */
const fallbackRenderer: BlockRenderer = {
  match: () => true,
  render: (b, ctx) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'page-item'
    if (ctx.isActive(b.id)) row.dataset.active = '1'
    const title = document.createElement('span')
    title.className = 'p-title ui-ellipsis ui-ellipsis-grow'
    const name = displayNameOf(b).trim()
    title.textContent = name === '' ? ctx.untitledLabel : name
    row.append(title)
    bindRowClick(row, b, ctx)
    return row
  },
}

/**
 * **chrome 渲染器**（按角色匹配）：它们只改这一行「头上那一小块」——
 * 目前只有日记行（标题换成日期、图标换成日历）。角色的职责到此为止。
 */
const CHROME_RENDERERS: BlockRenderer[] = [journalRenderer]

/**
 * **类型 → 渲染器**：声明在 core（纯数据），绑定在这里（函数）。
 *
 * 用查表而不是让每个渲染器自己 `match`：类型是一张**封闭注册表**，
 * 「哪个类型由谁画」应该是一个可枚举的对照关系，而不是一列靠顺序裁决的谓词 ——
 * 谓词串里每加一个类型都要重新推一遍顺序，而表里加一行不需要。
 */
const TYPE_RENDERERS: Record<string, BlockRenderer> = {
  [DEFAULT_BLOCK_TYPE]: outlineRenderer,
  [DIVIDER_TYPE]: dividerRenderer,
}

/**
 * 挑渲染器：**先 chrome，再类型，最后兜底**。
 *
 * 顺序的判据不是角色优先级：chrome 是「在这一行的骨架上叠一件」（日记把标题换成日期），
 * 类型是「画骨架本身」。反过来先问类型，chrome 就永远轮不到 —— 默认类型对所有块
 * 都成立，它会把整张表变成「只有一条」。
 */
export function rendererFor(b: Block): BlockRenderer {
  const chrome = CHROME_RENDERERS.find((r) => r.match(b))
  if (chrome) return chrome
  return TYPE_RENDERERS[blockTypeOf(b)] ?? fallbackRenderer
}

/** 画一个块 */
export function renderBlock(b: Block, ctx: BlockRenderCtx): HTMLElement {
  return rendererFor(b).render(b, ctx)
}
