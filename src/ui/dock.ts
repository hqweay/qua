/**
 * 槽的渲染：**每个槽的内容是一列块**。
 *
 * 这一层只做「把一组块卡放进槽里」，**不认识页面、不认识命令、不认识状态**——
 * 那些由调用方（装配层）准备好再传进来。这样做的原因：
 *   · 槽的 DOM 形状（抬头 + 堆叠 + 块卡）是**对外契约**，主题与插件都依赖它；
 *   · 它必须能脱离应用状态单独成型，否则将来「往槽里加一块」（插件注册面板的方式）的入口
 * 会退化成在装配层里手写 DOM（已明确：插件是往槽里加块，不是塞 DOM）。
 *
 * ⚠️ 纪律：**槽内只许纵向**。这里不提供任何横向排列的入口。
 * ⚠️ 纪律：槽开关用 `chevron-left`／`chevron-right` 图标，**没有入口条**（2026-10-19 晚作废）。
 */

import { renderIcon } from '../view/icons.ts'

/** 一块卡：标题条 + 内容 */
export interface DockCard {
  /** 稳定 id（拖序与折叠状态将来按它键控，承） */
  id: string
  /** 块卡标题；空串 ＝ 不画标题条 */
  title: string
  /** 标题条右侧的额外动作（如「＋」）；由调用方决定要不要 */
  actions?: { label: string; title?: string; onClick: () => void }[]
  /** 内容区；由调用方负责填充（页面列表、检索结果、插件界面…） */
  body: HTMLElement
}

export interface DockSlotEls {
  root: HTMLElement
  head: HTMLElement
  titleEl: HTMLElement
  stack: HTMLElement
}

/** 取一个槽的三块 DOM（抬头／标题／堆叠），并做一次存在性断言 */
export function dockSlotEls(root: HTMLElement): DockSlotEls {
  const head = root.querySelector<HTMLElement>(':scope > .dock-head')
  const titleEl = head?.querySelector<HTMLElement>('.dock-title')
  const stack = root.querySelector<HTMLElement>(':scope > .dock-stack')
  if (!head || !titleEl || !stack) // 开发者可见的骨架断言（不是用户文案）：与 console.* 同一口径，用英文
  throw new Error('dock: incomplete slot skeleton (need .dock-head / .dock-title / .dock-stack)')
  return { root, head, titleEl, stack }
}

/**
 * 渲染一个槽的内容：清空堆叠、按顺序放块卡。
 *
 * 每次整槽重画（第 1 期）。将来接入事务流后改为**按卡片局部更新**，
 * 但入口形状不变——调用方仍然只给它「这一槽现在有哪几块」。
 *
 * ⚠️ **常驻节点（`persistent`）必须先摘出文档再清空**：`stack.textContent = ''` 会把子节点
 * 一并从文档里摘掉，之后再往该节点里 append，写的是一棵**游离树**（DOM 里看着是空的）。
 * 这是真踩过的 bug —— 页面列表就是这样整槽消失的。
 */
export function renderDockStack(
  stack: HTMLElement,
  cards: DockCard[],
  emptyText: string,
  persistent: HTMLElement[] = [],
): void {
  const keep = new Set<Node>(persistent)
  for (const n of keep) n.parentNode?.removeChild(n)
  stack.textContent = ''
  if (cards.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dock-empty'
    empty.textContent = emptyText
    stack.appendChild(empty)
    return
  }
  for (const card of cards) stack.appendChild(buildCard(card))
}

function buildCard(card: DockCard): HTMLElement {
  const el = document.createElement('div')
  el.className = 'dock-card'
  el.dataset.cardId = card.id

  if (card.title !== '' || card.actions?.length) {
    const head = document.createElement('div')
    head.className = 'dock-card-head'
    const title = document.createElement('span')
    title.className = 'dock-card-title'
    title.textContent = card.title
    head.appendChild(title)
    for (const a of card.actions ?? []) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'dock-btn'
      renderIcon(btn, a.label, 'plus')
      if (a.title) btn.title = a.title
      btn.addEventListener('click', a.onClick)
      head.appendChild(btn)
    }
    el.appendChild(head)
  }

  const body = document.createElement('div')
  body.className = 'dock-card-body'
  body.appendChild(card.body)
  el.appendChild(body)
  return el
}

/**
 * 装一个槽：取它的 DOM、写抬头文案、绑收起按钮。
 *
 * **组件自持 DOM**：抬头里的标题与收起按钮只有这里知道，装配层不再 `getElementById`。
 */
export function mountDockSlot(
  root: HTMLElement,
  opts: { title: string; collapseLabel: string; icon: string; onCollapse: () => void },
): DockSlotEls {
  const els = dockSlotEls(root)
  els.titleEl.textContent = opts.title
  const btn = els.head.querySelector<HTMLButtonElement>('.dock-btn')
  if (btn) {
    renderIcon(btn, opts.icon, 'chevron-left')
    btn.setAttribute('aria-label', opts.collapseLabel)
    btn.addEventListener('click', opts.onCollapse)
  }
  return els
}

/** 槽的开关：把状态写到 `body[data-dock-*]`（样式按它取值，JS 不碰宽度数值） */
export function applyDockVisibility(open: { left: boolean; right: boolean }): void {
  document.body.dataset.dockLeft = open.left ? 'open' : 'closed'
  document.body.dataset.dockRight = open.right ? 'open' : 'closed'
}
