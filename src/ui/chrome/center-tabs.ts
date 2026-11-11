/**
 * 顶栏的页签：**能放得下就平铺，放不下的收进集合**。
 *
 * 顶栏中段有确定的宽度，tab 集合却没有上限：全平铺 ⇒ 名字一长／数量一多就挤到
 * 要横向滚；全收成一个数字 ⇒ 明明放得下的几屏也不让人直接点，白白空着一大段。
 * ⇒ 按可用宽度自然平铺，溢出部分交给「全部页签」集合入口（`Layers`，qua 里
 * 「从集合里选一项」的统一组件），两端用渐隐说明还有内容。
 *
 * ⚠️ **同一个块不会有多张 tab**：状态层按视图去重（`openInNewTab`／`newTab`），
 *    所以这里不需要合并同名、编号「第 N 屏」之类的显示层补丁。
 *
 * 它是**纯 UI**：tab 的状态全在装配层。所有 tab 都留在 DOM 里（可聚焦、可数），
 * 裁切只改渐隐与滚动位置，不删节点。
 */
import { t } from '../../core/infra/msg.ts'
import { renderIcon } from '../../view/icons.ts'

export interface CenterTabInfo {
  id: string
  title: string
  active: boolean
}

export interface CenterTabsHandlers {
  activate: (id: string) => void
  close: (id: string) => void
  create: () => void
  /** 打开「全部页签」集合（装配层用 Layers 列出，回调回来 activate） */
  openList: (trigger: HTMLElement) => void
}

/** 每个 tab 条只装一次监听：`renderCenterTabs` 每次重画都会被调用，不能累积 */
const wired = new WeakSet<HTMLElement>()

/** 哪一侧还有没露出来的 tab：渐隐代替滚动条，不占高度 */
function paintFade(root: HTMLElement): void {
  const overflow = root.scrollWidth > root.clientWidth + 1
  if (!overflow) {
    delete root.dataset.fade
    return
  }
  const atStart = root.scrollLeft <= 1
  const atEnd = root.scrollLeft + root.clientWidth >= root.scrollWidth - 1
  root.dataset.fade = atStart && atEnd ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both'
}

/** 当前屏永远要完整露出来；窗口变窄后被裁到边上就把它滚回来 */
function fitToActive(root: HTMLElement): void {
  const active = root.querySelector<HTMLElement>('.center-tab[data-active="1"]')
  if (active) {
    const a = active.getBoundingClientRect()
    const s = root.getBoundingClientRect()
    if (a.left < s.left) root.scrollLeft -= s.left - a.left
    else if (a.right > s.right) root.scrollLeft += a.right - s.right
  }
  paintFade(root)
}

function ensureWired(root: HTMLElement): void {
  if (wired.has(root)) return
  wired.add(root)
  root.onscroll = () => paintFade(root)
  // 窗口变窄／侧槽宽度变化都会改这条的可用宽度；只观察元素自身
  new ResizeObserver(() => fitToActive(root)).observe(root)
}

export function renderCenterTabs(
  root: HTMLElement,
  tabs: readonly CenterTabInfo[],
  handlers: CenterTabsHandlers,
  addEl: HTMLButtonElement,
  listEl: HTMLButtonElement,
): void {
  root.replaceChildren()
  for (const tab of tabs) {
    const el = document.createElement('div')
    el.className = 'center-tab'
    el.dataset.tabId = tab.id
    el.dataset.active = tab.active ? '1' : '0'
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(tab.active))
    el.tabIndex = tab.active ? 0 : -1
    el.dataset.tip = tab.title
    el.addEventListener('click', () => {
      // 已经是当前屏就别再切一次（重复 activate 会白写一次历史）
      if (!tab.active) handlers.activate(tab.id)
    })

    const label = document.createElement('span')
    label.className = 'center-tab-title ui-ellipsis'
    label.textContent = tab.title

    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'center-tab-close'
    close.dataset.tip = t('ui.tabs.close')
    close.setAttribute('aria-label', t('ui.tabs.close'))
    renderIcon(close, 'lucide:x', 'x')
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      handlers.close(tab.id)
    })

    el.append(label, close)
    root.appendChild(el)
  }

  // 两颗条外按钮都是静态节点：每次重画只覆盖图标/文案/回调，不累积监听
  renderIcon(addEl, 'lucide:plus', 'plus')
  addEl.dataset.tip = t('ui.tabs.new')
  addEl.setAttribute('aria-label', t('ui.tabs.new'))
  addEl.onclick = () => handlers.create()

  listEl.textContent = String(tabs.length)
  listEl.dataset.tip = t('ui.tabs.all', { n: tabs.length })
  listEl.setAttribute('aria-label', t('ui.tabs.all', { n: tabs.length }))
  // 只有一屏时不需要集合入口（不为一屏加一颗没用的按钮）
  listEl.hidden = tabs.length <= 1
  listEl.onclick = () => handlers.openList(listEl)

  ensureWired(root)
  fitToActive(root)
}
